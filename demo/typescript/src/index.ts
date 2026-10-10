/**
 * Demo: a shared sticky-note board with an audit log, per-person undo/redo and a time slider,
 * in TypeScript with `spacetimedb-history` as a submodule. Same behaviour and client-facing
 * names as demo/rust and demo/csharp; serves the web client at /route/.
 */
import { schema, table, t, Router, SyncResponse, SenderError, type ReducerCtx } from 'spacetimedb/server';
import * as history from '@pogly/spacetimedb-history';
import PAGE from './page.gen';

const BOARD = 'board';

const demoNote = table(
  { name: 'demo_note', public: true },
  { id: t.u64().primaryKey().autoInc(), text: t.string(), x: t.f32(), y: t.f32(), color: t.string() }
);

/** A table with a secret in it, to show redaction: history never stores `apiKey`. */
const demoAccount = table(
  { name: 'demo_account', public: true },
  { identity: t.identity().primaryKey(), name: t.string(), apiKey: t.string() }
);

const spacetimedb = schema({ demoNote, demoAccount, history });
export default spacetimedb;
type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;

// ---------------------------------------------------------------------------
// history wiring: tracked tables, plus the client-facing reducers, procedures and view
// (a submodule can't reach your tables, so these are thin wrappers)
// ---------------------------------------------------------------------------

history.setup<Ctx>({ scope: (ctx) => ctx.as.history });

const notes = history.track<Ctx, typeof demoNote.rowType.type, bigint>({
  name: 'demo_note',
  row: demoNote.rowType,
  key: t.u64(),
  keyOf: (r) => r.id,
  find: (ctx, id) => ctx.db.demoNote.id.find(id),
  insert: (ctx, r) => ctx.db.demoNote.insert(r),
  update: (ctx, r) => ctx.db.demoNote.id.update(r),
  delete: (ctx, id) => ctx.db.demoNote.id.delete(id),
  iter: (ctx) => ctx.db.demoNote.iter(),
});

const accounts = history.track<Ctx, typeof demoAccount.rowType.type, typeof demoAccount.rowType.type['identity']>({
  name: 'demo_account',
  row: demoAccount.rowType,
  key: t.identity(),
  keyOf: (r) => r.identity,
  find: (ctx, id) => ctx.db.demoAccount.identity.find(id),
  insert: (ctx, r) => ctx.db.demoAccount.insert(r),
  update: (ctx, r) => ctx.db.demoAccount.identity.update(r),
  delete: (ctx, id) => ctx.db.demoAccount.identity.delete(id),
  iter: (ctx) => ctx.db.demoAccount.iter(),
  scrub: (r) => ({ ...r, apiKey: '[redacted]' }),
});

export const historyUndo = spacetimedb.reducer({ scope: t.string() }, (ctx, { scope }) => {
  history.undo(ctx, ctx.sender, scope);
});
export const historyRedo = spacetimedb.reducer({ scope: t.string() }, (ctx, { scope }) => {
  history.redo(ctx, ctx.sender, scope);
});
export const historyQuery = spacetimedb.procedure({ q: history.HistoryQuery }, t.array(history.HistoryEntry), (ctx, { q }) =>
  ctx.withTx((tx) => history.query(tx as unknown as Ctx, tx.sender, q))
);
export const historyRowAsOf = spacetimedb.procedure(
  { tableName: t.string(), rowKey: t.string(), at: t.timestamp() },
  t.option(t.byteArray()),
  (ctx, { tableName, rowKey, at }) =>
    ctx.withTx((tx) => (history.canAudit(tx as unknown as Ctx, tx.sender) ? history.rowAsOf(tx as unknown as Ctx, tableName, rowKey, at) : undefined))
);
export const historyTableAsOf = spacetimedb.procedure(
  { tableName: t.string(), at: t.timestamp() },
  t.array(history.HistoryRow),
  (ctx, { tableName, at }) =>
    ctx.withTx((tx) => (history.canAudit(tx as unknown as Ctx, tx.sender) ? history.tableAsOf(tx as unknown as Ctx, tableName, at) : []))
);
export const historyMyGroups = spacetimedb.view({ public: true }, t.array(history.HistoryGroup), (ctx) =>
  history.myGroups({ db: (ctx.db as any).history }, ctx.sender)
);

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

export const init = spacetimedb.init((ctx) => {
  // The demo lets anyone read the whole log and use the time slider.
  history.configure(ctx.as.history, { ...history.DEFAULT_SETTINGS, openAudit: true });
});

const clamp = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 50);
function checkText(text: string) {
  if ([...text].length > 200) throw new SenderError('note too long');
}
function findNote(ctx: Ctx, id: bigint) {
  const n = ctx.db.demoNote.id.find(id);
  if (!n) throw new SenderError('no such note');
  return n;
}

export const demoAddNote = spacetimedb.reducer(
  { text: t.string(), x: t.f32(), y: t.f32(), color: t.string() },
  (ctx, { text, x, y, color }) => {
    checkText(text);
    history.begin(ctx, 'add note', BOARD);
    notes.insert(ctx, { id: 0n, text, x: clamp(x), y: clamp(y), color });
  }
);

export const demoEditNote = spacetimedb.reducer({ id: t.u64(), text: t.string() }, (ctx, { id, text }) => {
  checkText(text);
  const n = findNote(ctx, id);
  history.begin(ctx, 'edit note', BOARD);
  notes.update(ctx, { ...n, text });
});

/** Move several notes at once: one action, one undo step. */
export const demoMoveNotes = spacetimedb.reducer({ ids: t.array(t.u64()), dx: t.f32(), dy: t.f32() }, (ctx, { ids, dx, dy }) => {
  history.begin(ctx, 'move notes', BOARD);
  for (const id of ids) {
    const n = findNote(ctx, id);
    notes.update(ctx, { ...n, x: clamp(n.x + dx), y: clamp(n.y + dy) });
  }
});

export const demoRecolorNotes = spacetimedb.reducer({ ids: t.array(t.u64()), color: t.string() }, (ctx, { ids, color }) => {
  history.begin(ctx, 'recolor notes', BOARD);
  for (const id of ids) notes.update(ctx, { ...findNote(ctx, id), color });
});

export const demoDeleteNotes = spacetimedb.reducer({ ids: t.array(t.u64()) }, (ctx, { ids }) => {
  history.begin(ctx, 'delete notes', BOARD);
  for (const id of ids) notes.delete(ctx, id);
});

export const demoSetAccount = spacetimedb.reducer({ name: t.string(), apiKey: t.string() }, (ctx, { name, apiKey }) => {
  history.begin(ctx, 'set account', 'account');
  accounts.upsert(ctx, { identity: ctx.sender, name, apiKey });
});

/** Test helper: shrink retention and prune right away. */
export const demoPrune = spacetimedb.reducer({ retentionSecs: t.u64() }, (ctx, { retentionSecs }) => {
  const s = history.settings(ctx.as.history);
  history.configure(ctx.as.history, { ...s, retentionSecs });
  history.pruneNow(ctx.as.history);
  history.configure(ctx.as.history, s);
});

/** Benchmark helper: `count` updates to one note in one transaction, tracked or not. */
export const demoBench = spacetimedb.reducer({ id: t.u64(), count: t.u32(), tracked: t.bool() }, (ctx, { id, count, tracked }) => {
  history.begin(ctx, 'bench', 'bench');
  for (let i = 0; i < count; i++) {
    const n = { ...findNote(ctx, id), x: i % 100 };
    if (tracked) notes.update(ctx, n);
    else ctx.db.demoNote.id.update(n);
  }
});

/** Test helper: open or close the audit log. */
export const demoSetOpenAudit = spacetimedb.reducer({ open: t.bool() }, (ctx, { open }) => {
  history.configure(ctx.as.history, { ...history.settings(ctx.as.history), openAudit: open });
});

export const page = spacetimedb.httpHandler(
  () => new SyncResponse(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
);
export const router = spacetimedb.httpRouter(new Router().get('/', page));
