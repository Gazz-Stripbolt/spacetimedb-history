// Protocol tests: real clients against a published demo module.
//
//   DB=hist-rust HOST=ws://127.0.0.1:3000 npx tsx tests/server.test.mts
//
// Covers capture (insert/update/delete, groups, actions, scopes), undo/redo (multi-row groups,
// per-person stacks, conflicts, redo clearing, deleted rows coming back with their ids),
// point-in-time reads, audit visibility, redaction and retention.
import assert from 'node:assert/strict';
import { connect, decodeRow, noteKey, query, type Conn, type Note, type Account } from '../demo/web/src/api.ts';
import { Timestamp } from 'spacetimedb';

const HOST = process.env.HOST ?? 'ws://127.0.0.1:3000';
const DB = process.env.DB ?? 'hist-rust';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function client() {
  const { conn, identity } = await connect(HOST, DB);
  await new Promise<void>((res, rej) =>
    conn.subscriptionBuilder().onApplied(() => res()).onError((_c, e) => rej(e))
      .subscribe(['SELECT * FROM demo_note', 'SELECT * FROM demo_account', 'SELECT * FROM history_my_groups'])
  );
  const err = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      return String((e as Error)?.message ?? e);
    }
  };
  return { conn, identity, err, r: conn.reducers, p: conn.procedures };
}

const notes = (c: { conn: Conn }) => [...c.conn.db.demoNote.iter()].sort((a, b) => Number(a.id - b.id)) as Note[];
const note = (c: { conn: Conn }, id: bigint) => (c.conn.db.demoNote.id.find(id) ?? undefined) as Note | undefined;
const newest = (c: { conn: Conn }) => notes(c).at(-1)!;

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const a = await client();
const b = await client();
const eve = await client();

await test('capture: insert, update and delete are recorded with before/after, actor, action and scope', async () => {
  await a.r.demoAddNote({ text: 'first', x: 10, y: 10, color: 'yellow' });
  await sleep(100);
  const n = newest(a);
  await a.r.demoEditNote({ id: n.id, text: 'first!' });
  await a.r.demoDeleteNotes({ ids: [n.id] });
  const log = await a.p.historyQuery({ q: query({ tableName: 'demo_note', rowKey: noteKey(n.id) }) });
  assert.deepEqual(log.map((e) => e.op), [2, 1, 0], 'newest first: delete, update, insert');
  assert.deepEqual(log.map((e) => e.action), ['delete notes', 'edit note', 'add note']);
  assert.ok(log.every((e) => e.scope === 'board' && e.actor.isEqual(a.identity)));
  const [del, upd, ins] = log;
  assert.equal(ins.before, undefined);
  assert.equal(decodeRow<Note>('demo_note', ins.after)!.text, 'first');
  assert.equal(decodeRow<Note>('demo_note', upd.before)!.text, 'first');
  assert.equal(decodeRow<Note>('demo_note', upd.after)!.text, 'first!');
  assert.equal(decodeRow<Note>('demo_note', del.before)!.text, 'first!');
  assert.equal(del.after, undefined);
});

await test('groups: a multi-row action is one group, and undo/redo restore every row', async () => {
  for (const [i, color] of ['red', 'green', 'blue'].entries()) await a.r.demoAddNote({ text: `n${i}`, x: 10 * i, y: 20, color });
  await sleep(100);
  const ids = notes(a).slice(-3).map((n) => n.id);
  await a.r.demoMoveNotes({ ids, dx: 5, dy: 7 });
  await sleep(100);
  const moved = await a.p.historyQuery({ q: query({ tableName: 'demo_note', limit: 3 }) });
  assert.equal(new Set(moved.map((e) => e.groupId)).size, 1, 'one group');
  assert.equal(moved[0].action, 'move notes');
  await a.r.historyUndo({ scope: 'board' });
  await sleep(100);
  assert.deepEqual(ids.map((id) => [note(a, id)!.x, note(a, id)!.y]), [[0, 20], [10, 20], [20, 20]]);
  await a.r.historyRedo({ scope: 'board' });
  await sleep(100);
  assert.deepEqual(ids.map((id) => [note(a, id)!.x, note(a, id)!.y]), [[5, 27], [15, 27], [25, 27]]);
  const groups = [...a.conn.db.historyMyGroups.iter()];
  assert.ok(groups.some((g) => g.kind === 1) && groups.some((g) => g.kind === 2), 'undo and redo are themselves in the log');
});

await test('undo of a delete brings the rows back with their ids; undo of an insert removes it', async () => {
  const ids = notes(a).slice(-2).map((n) => n.id);
  await a.r.demoDeleteNotes({ ids });
  await sleep(100);
  assert.ok(ids.every((id) => !note(a, id)));
  await a.r.historyUndo({ scope: 'board' });
  await sleep(100);
  assert.ok(ids.every((id) => note(a, id)), 'same ids back');
  await a.r.demoAddNote({ text: 'temp', x: 1, y: 1, color: 'pink' });
  await sleep(100);
  const temp = newest(a).id;
  await a.r.historyUndo({ scope: 'board' });
  await sleep(100);
  assert.equal(note(a, temp), undefined);
});

await test('per-person stacks: your undo never touches someone else\'s action', async () => {
  await b.r.demoAddNote({ text: 'b-note', x: 50, y: 50, color: 'blue' });
  await sleep(100);
  const bNote = newest(b).id;
  await a.r.demoAddNote({ text: 'a-note', x: 60, y: 60, color: 'yellow' });
  await sleep(100);
  const aNote = newest(a).id;
  await a.r.historyUndo({ scope: 'board' });
  await sleep(100);
  assert.equal(note(a, aNote), undefined, "a's note undone");
  assert.ok(note(a, bNote), "b's note untouched");
});

await test('conflicts: undo is refused if someone else changed the row since', async () => {
  const id = newest(b).id;
  await b.r.demoMoveNotes({ ids: [id], dx: 10, dy: 0 });
  await a.r.demoEditNote({ id, text: 'a was here' });
  await sleep(100);
  const err = await b.err(b.r.historyUndo({ scope: 'board' }));
  assert.match(err ?? '', /conflict/);
  assert.equal(note(b, id)!.text, 'a was here', 'nothing changed');
  assert.equal(note(b, id)!.x, 60);
  await a.r.historyUndo({ scope: 'board' }); // a undoes the edit...
  await b.r.historyUndo({ scope: 'board' }); // ...and now b's move undoes cleanly
  await sleep(100);
  assert.equal(note(b, id)!.x, 50);
});

await test('redo is cleared by a new action; scopes have separate stacks', async () => {
  await a.r.demoAddNote({ text: 'r1', x: 5, y: 5, color: 'green' });
  await a.r.historyUndo({ scope: 'board' });
  await a.r.demoAddNote({ text: 'r2', x: 6, y: 6, color: 'green' });
  assert.match((await a.err(a.r.historyRedo({ scope: 'board' }))) ?? '', /nothing to redo/);
  assert.match((await a.err(a.r.historyUndo({ scope: 'elsewhere' }))) ?? '', /nothing to undo/);
});

await test('point in time: a row and the whole table as they were', async () => {
  await a.r.demoAddNote({ text: 'v1', x: 30, y: 30, color: 'yellow' });
  await sleep(100);
  const id = newest(a).id;
  const t1 = Timestamp.now();
  await sleep(50);
  await a.r.demoEditNote({ id, text: 'v2' });
  // Timestamp.now() has millisecond precision and a local call returns in well under 1 ms, so without this
  // pause t2 can land in the same millisecond as the edit and floor to just before it.
  await sleep(50);
  const t2 = Timestamp.now();
  await sleep(50);
  await a.r.demoDeleteNotes({ ids: [id] });
  await sleep(100);
  const at = async (t: Timestamp) => decodeRow<Note>('demo_note', await a.p.historyRowAsOf({ tableName: 'demo_note', rowKey: noteKey(id), at: t }));
  assert.equal((await at(t1))!.text, 'v1');
  assert.equal((await at(t2))!.text, 'v2');
  assert.equal(await at(Timestamp.now()), undefined, 'deleted now');
  const table = await a.p.historyTableAsOf({ tableName: 'demo_note', at: t1 });
  const rows = table.map((r) => decodeRow<Note>('demo_note', r.value)!);
  assert.ok(rows.some((n) => n.id === id && n.text === 'v1'));
  assert.equal(rows.length, notes(a).length + 1, 'everything now, plus the note deleted since');
});

await test('audit visibility: closed log shows only your own changes; outsiders get nothing', async () => {
  await a.r.demoSetOpenAudit({ open: false });
  const mine = await b.p.historyQuery({ q: query({ limit: 500 }) });
  assert.ok(mine.length > 0 && mine.every((e) => e.actor.isEqual(b.identity)));
  const forged = await b.p.historyQuery({ q: query({ actor: a.identity, limit: 50 }) });
  assert.ok(forged.every((e) => e.actor.isEqual(b.identity)), 'asking for someone else returns your own');
  assert.equal(await eve.p.historyRowAsOf({ tableName: 'demo_note', rowKey: noteKey(1n), at: Timestamp.now() }), undefined);
  assert.equal((await eve.p.historyTableAsOf({ tableName: 'demo_note', at: Timestamp.now() })).length, 0);
  assert.ok([...eve.conn.db.historyMyGroups.iter()].length === 0, 'view shows only your own groups');
  await a.r.demoSetOpenAudit({ open: true });
  const all = await eve.p.historyQuery({ q: query({ limit: 500 }) });
  assert.ok(all.some((e) => e.actor.isEqual(a.identity)) && all.some((e) => e.actor.isEqual(b.identity)));
});

await test('redaction: scrubbed fields never reach history, and undo is refused for that table', async () => {
  await a.r.demoSetAccount({ name: 'ada', apiKey: 'sk_live_SECRET' });
  await sleep(100);
  const [e] = await a.p.historyQuery({ q: query({ tableName: 'demo_account', limit: 1 }) });
  const acct = decodeRow<Account>('demo_account', e.after)!;
  assert.equal(acct.name, 'ada');
  assert.equal(acct.apiKey, '[redacted]');
  assert.match((await a.err(a.r.historyUndo({ scope: 'account' }))) ?? '', /redacted/);
});

await test('retention: pruning removes old history and empty groups', async () => {
  const before = (await eve.p.historyQuery({ q: query({ limit: 500 }) })).length;
  await sleep(1100);
  await a.r.demoAddNote({ text: 'fresh', x: 1, y: 2, color: 'green' });
  await a.r.demoPrune({ retentionSecs: 1n });
  const after = await eve.p.historyQuery({ q: query({ limit: 500 }) });
  assert.ok(before > 1);
  assert.equal(after.length, 1, 'only the fresh change is left');
  assert.equal(after[0].action, 'add note');
});

console.log(`\n${passed} passed`);
for (const c of [a, b, eve]) c.conn.disconnect();
process.exit(0);
