/**
 * # spacetimedb-history: audit log, point-in-time reads and undo/redo, as a submodule
 *
 * The TypeScript twin of `rust/history.rs` and `csharp/History.cs`. Same BSATN values and the
 * same client-facing names, so the same clients work against all three. A stopgap until
 * SpacetimeDB lets modules read their own commit log.
 *
 * A submodule can't touch its consumer's tables, so the consumer registers each tracked table
 * with `track()` and defines the client-facing reducers, procedures and view as thin wrappers
 * (see README.md). History's own tables live under the consumer's namespace, e.g. `history.change`.
 */
import { schema, table, t, SenderError } from 'spacetimedb/server';
import type { ReducerCtx } from 'spacetimedb/server';
import { AlgebraicType, BinaryReader, BinaryWriter, type Identity, ScheduleAt, Timestamp } from 'spacetimedb';

// ---------------------------------------------------------------------------
// Types (names match the Rust and C# modules, so clients share one schema)
// ---------------------------------------------------------------------------

export const HistoryTableRetention = t.object('HistoryTableRetention', { tableName: t.string(), retentionSecs: t.u64() });

export const HistorySettings = t.object('HistorySettings', {
  /** Keep history this long (seconds). 0 = forever. */
  retentionSecs: t.u64(),
  /** Per-table overrides of retentionSecs. */
  tableRetention: t.array(HistoryTableRetention),
  /** How many of your most recent action groups (per scope) undo can reach back through. */
  maxUndoDepth: t.u32(),
  /** Anyone may query the whole log. Off: you see your own changes; auditors see everything. */
  openAudit: t.bool(),
});
export type Settings = typeof HistorySettings.type;

export const DEFAULT_SETTINGS: Settings = {
  retentionSecs: 30n * 24n * 3600n,
  tableRetention: [],
  maxUndoDepth: 100,
  openAudit: false,
};

/** A change with its group's context, as returned by queries. */
export const HistoryEntry = t.object('HistoryEntry', {
  changeId: t.u64(),
  groupId: t.u64(),
  tableName: t.string(),
  rowKey: t.string(),
  op: t.u8(),
  before: t.option(t.byteArray()),
  after: t.option(t.byteArray()),
  actor: t.identity(),
  at: t.timestamp(),
  action: t.string(),
  scope: t.string(),
  kind: t.u8(),
});
export type Entry = typeof HistoryEntry.type;

export const HistoryQuery = t.object('HistoryQuery', {
  tableName: t.option(t.string()),
  rowKey: t.option(t.string()),
  actor: t.option(t.identity()),
  scope: t.option(t.string()),
  groupId: t.option(t.u64()),
  from: t.option(t.timestamp()),
  to: t.option(t.timestamp()),
  /** Only changes with id < this (paging backwards). */
  beforeId: t.option(t.u64()),
  /** Max entries (capped at 500). 0 = 100. */
  limit: t.u32(),
});
export type Query = typeof HistoryQuery.type;

export const HistoryRow = t.object('HistoryRow', { rowKey: t.string(), value: t.byteArray() });
export type Row = typeof HistoryRow.type;

export const OP_INSERT = 0;
export const OP_UPDATE = 1;
export const OP_DELETE = 2;
/** Group kinds. Only action groups are on the undo stack. */
export const KIND_ACTION = 0;
export const KIND_UNDO = 1;
export const KIND_REDO = 2;
export const STATE_DONE = 0;
export const STATE_UNDONE = 1;
/** Undone, then a new action came along: no longer redoable. */
export const STATE_DROPPED = 2;

// ---------------------------------------------------------------------------
// Tables (private, under the consumer's namespace)
// ---------------------------------------------------------------------------

const config = table({ name: 'config' }, { key: t.u8().primaryKey(), settings: HistorySettings });

/** One per transaction (or per begin() call): an action you can undo as a unit. */
const group = table(
  { name: 'group', indexes: [{ accessor: 'byActorScope', algorithm: 'btree', columns: ['actor', 'scope'] }] },
  {
    id: t.u64().primaryKey().autoInc(),
    actor: t.identity().index('btree'),
    scope: t.string(),
    action: t.string(),
    at: t.timestamp().index('btree'),
    kind: t.u8(),
    state: t.u8(),
    /** For undo/redo groups: the group they undid or redid. For undone groups: the undo group. */
    link: t.u64(),
    changes: t.u32(),
  }
);

const change = table(
  { name: 'change', indexes: [{ accessor: 'byRow', algorithm: 'btree', columns: ['tableName', 'rowKey'] }] },
  {
    id: t.u64().primaryKey().autoInc(),
    groupId: t.u64().index('btree'),
    tableName: t.string().index('btree'),
    /** Hex of the BSATN-encoded primary key. */
    rowKey: t.string(),
    op: t.u8(),
    before: t.option(t.byteArray()),
    after: t.option(t.byteArray()),
    actor: t.identity().index('btree'),
    at: t.timestamp().index('btree'),
  }
);

/** Identities allowed to read the whole log (besides the module itself). */
const auditor = table({ name: 'auditor' }, { identity: t.identity().primaryKey() });

/** The hourly retention job. */
const pruneJob = table({ name: 'prune_job' }, { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() });

const spacetimedb = schema({ config, group, change, auditor, pruneJob });
export default spacetimedb;

/** A context narrowed to this submodule: `ctx.as.history` (or whatever you named it). */
export type HistoryCtx = ReducerCtx<typeof spacetimedb.schemaType>;
type GroupRow = NonNullable<ReturnType<HistoryCtx['db']['group']['id']['find']>>;
type ChangeRow = NonNullable<ReturnType<HistoryCtx['db']['change']['id']['find']>>;

/** The hourly prune job (registered under the namespace, e.g. `history.prune`). */
export const prune = spacetimedb.reducer({ onSchedule: pruneJob }, { arg: pruneJob.rowType }, (ctx) => {
  // Scheduled reducers are callable by clients too; only the scheduler may prune.
  if (!ctx.sender.isEqual(ctx.databaseIdentity)) throw new SenderError('prune is run by the scheduler');
  pruneNow(ctx);
});

// ---------------------------------------------------------------------------
// Tracked tables
// ---------------------------------------------------------------------------

/** Anything with an `algebraicType`: a table's `rowType`, or a type builder like `t.u64()`. */
interface Typed<T> {
  algebraicType: unknown;
  readonly type?: T;
}

/** What `track()` needs to know about one of your tables. `C` is your module's context type. */
export interface TableSpec<C, Row, Key> {
  /** The name history records (use the table's canonical name, e.g. `note`). */
  name: string;
  /** `yourTable.rowType`. */
  row: Typed<Row>;
  /** The primary key's type builder, e.g. `t.u64()`. */
  key: Typed<Key>;
  keyOf: (row: Row) => Key;
  find: (ctx: C, key: Key) => Row | null | undefined;
  insert: (ctx: C, row: Row) => Row;
  update: (ctx: C, row: Row) => Row;
  delete: (ctx: C, key: Key) => unknown;
  iter: (ctx: C) => Iterable<Row>;
  /** Redact rows before they're recorded. Undo is disabled for scrubbed tables. */
  scrub?: (row: Row) => Row;
}

/** Your module's context, as history sees it: the submodule-narrowed ctx is found via `scope`. */
export interface HostCtx {
  sender: Identity;
  timestamp: Timestamp;
}

export interface Tracked<C, Row, Key> {
  insert(ctx: C, row: Row): Row;
  update(ctx: C, row: Row): Row;
  upsert(ctx: C, row: Row): Row;
  delete(ctx: C, key: Key): boolean;
}

interface Registered<C> {
  scrubbed: boolean;
  read(ctx: C, key: Uint8Array): Uint8Array | undefined;
  write(ctx: C, key: Uint8Array, value: Uint8Array | undefined): void;
  scan(ctx: C): [Uint8Array, Uint8Array][];
}

const registry = new Map<string, Registered<any>>();
let scopeOf: (ctx: any) => HistoryCtx = () => {
  throw new Error('call history.setup({ scope: (ctx) => ctx.as.history }) first');
};

/** Tell history how to reach its own tables from your context: `(ctx) => ctx.as.history`. */
export function setup<C>(opts: { scope: (ctx: C) => HistoryCtx }): void {
  scopeOf = opts.scope;
}

// Values are (de)serialized with the `spacetimedb` entry point's AlgebraicType and BinaryReader/
// Writer. Mixing in `spacetimedb/server`'s builders doesn't work for reading: its bound reader
// methods reject a BinaryReader from the other entry point ("Receiver must be an instance of class").
const serializers = new WeakMap<object, (w: BinaryWriter, v: any) => void>();
const deserializers = new WeakMap<object, (r: BinaryReader) => any>();

export function encode<T>(ty: Typed<T>, value: T): Uint8Array {
  let ser = serializers.get(ty);
  if (!ser) serializers.set(ty, (ser = AlgebraicType.makeSerializer(ty.algebraicType as any)));
  const w = new BinaryWriter(64);
  ser(w, value);
  return w.getBuffer();
}

export function decode<T>(ty: Typed<T>, bytes: Uint8Array): T {
  let de = deserializers.get(ty);
  if (!de) deserializers.set(ty, (de = AlgebraicType.makeDeserializer(ty.algebraicType as any)));
  return de(new BinaryReader(bytes));
}

/** Register a tracked table and get history-recording wrappers for it. Call at module load. */
export function track<C extends HostCtx, Row, Key>(spec: TableSpec<C, Row, Key>): Tracked<C, Row, Key> {
  const snapshot = (row: Row) => encode(spec.row, spec.scrub ? spec.scrub(row) : row);
  const keyBytes = (k: Key) => encode(spec.key, k);
  const api: Tracked<C, Row, Key> = {
    insert(ctx, row) {
      row = spec.insert(ctx, row);
      record(ctx, spec.name, keyBytes(spec.keyOf(row)), undefined, snapshot(row));
      return row;
    },
    update(ctx, row) {
      const old = spec.find(ctx, spec.keyOf(row));
      row = spec.update(ctx, row);
      record(ctx, spec.name, keyBytes(spec.keyOf(row)), old ? snapshot(old) : undefined, snapshot(row));
      return row;
    },
    upsert(ctx, row) {
      return spec.find(ctx, spec.keyOf(row)) ? api.update(ctx, row) : api.insert(ctx, row);
    },
    delete(ctx, key) {
      const old = spec.find(ctx, key);
      if (!old) return false;
      spec.delete(ctx, key);
      record(ctx, spec.name, keyBytes(key), snapshot(old), undefined);
      return true;
    },
  };
  registry.set(spec.name, {
    scrubbed: !!spec.scrub,
    read(ctx, key) {
      const row = spec.find(ctx, decode(spec.key, key));
      return row ? snapshot(row) : undefined;
    },
    write(ctx, key, value) {
      const k = decode(spec.key, key);
      const exists = !!spec.find(ctx, k);
      if (!value) {
        if (exists) api.delete(ctx, k);
      } else {
        const row = decode(spec.row, value);
        if (exists) api.update(ctx, row);
        else api.insert(ctx, row);
      }
    },
    scan(ctx) {
      return [...spec.iter(ctx)].map((r) => [keyBytes(spec.keyOf(r)), snapshot(r)]);
    },
  });
  return api;
}

function tableNamed(name: string): Registered<any> {
  const t = registry.get(name);
  if (!t) throw new SenderError(`${name} isn't a tracked table`);
  return t;
}

// ---------------------------------------------------------------------------
// Library API: pass your module's ctx
// ---------------------------------------------------------------------------

/** Store settings (from init, or any time). Also schedules the hourly prune job. */
export function configure(h: HistoryCtx, settings: Settings): void {
  const row = { key: 0, settings };
  if (h.db.config.key.find(0)) h.db.config.key.update(row);
  else h.db.config.insert(row);
  if (h.db.pruneJob.count() === 0n) {
    h.db.pruneJob.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(3600n * 1_000_000n) });
  }
}

export function settings(h: HistoryCtx): Settings {
  return h.db.config.key.find(0)?.settings ?? DEFAULT_SETTINGS;
}

export function addAuditor(h: HistoryCtx, who: Identity): void {
  if (!h.db.auditor.identity.find(who)) h.db.auditor.insert({ identity: who });
}

export function removeAuditor(h: HistoryCtx, who: Identity): void {
  h.db.auditor.identity.delete(who);
}

/** Start a named action group for the rest of this transaction. */
export function begin(ctx: HostCtx, action: string, scope: string): bigint {
  return newGroup(ctx, KIND_ACTION, action, scope, 0n);
}

/** Record one change (the tracked wrappers do this for you). Values are BSATN. */
export function record(ctx: HostCtx, table: string, key: Uint8Array, before: Uint8Array | undefined, after: Uint8Array | undefined): void {
  let op: number;
  if (!before && !after) return;
  else if (!before) op = OP_INSERT;
  else if (!after) op = OP_DELETE;
  else if (sameBytes(before, after)) return; // no-op update
  else op = OP_UPDATE;
  const h = scopeOf(ctx);
  const g = currentGroup(ctx);
  h.db.change.insert({
    id: 0n,
    groupId: g.id,
    tableName: table,
    rowKey: hex(key),
    op,
    before,
    after,
    actor: ctx.sender,
    at: ctx.timestamp,
  });
  h.db.group.id.update({ ...g, changes: g.changes + 1 });
}

/** Undo `who`'s most recent action in `scope`. Throws (and changes nothing) on conflict. */
export function undo(ctx: HostCtx, who: Identity, scope: string): bigint {
  const h = scopeOf(ctx);
  const depth = Math.max(1, settings(h).maxUndoDepth);
  const target = stack(h, who, scope)
    .filter((g) => g.state !== STATE_DROPPED)
    .slice(0, depth)
    .find((g) => g.state === STATE_DONE);
  if (!target) throw new SenderError('nothing to undo');
  const changes = groupChanges(h, target.id);
  check(ctx, changes, true);
  const g = newGroup(ctx, KIND_UNDO, target.action, scope, target.id);
  for (const c of [...changes].reverse()) tableNamed(c.tableName).write(ctx, unhex(c.rowKey), c.before ?? undefined);
  h.db.group.id.update({ ...target, state: STATE_UNDONE, link: g });
  return target.id;
}

/** Redo the action `who` most recently undid in `scope`. */
export function redo(ctx: HostCtx, who: Identity, scope: string): bigint {
  const h = scopeOf(ctx);
  const target = stack(h, who, scope)
    .filter((g) => g.state === STATE_UNDONE)
    .sort((a, b) => (a.link > b.link ? -1 : 1))[0];
  if (!target) throw new SenderError('nothing to redo');
  const changes = groupChanges(h, target.id);
  check(ctx, changes, false);
  const g = newGroup(ctx, KIND_REDO, target.action, scope, target.id);
  for (const c of changes) tableNamed(c.tableName).write(ctx, unhex(c.rowKey), c.after ?? undefined);
  h.db.group.id.update({ ...target, state: STATE_DONE, link: g });
  return target.id;
}

/** The log, newest first. `who` sees only their own changes unless they may audit. */
export function query(ctx: HostCtx, who: Identity, q: Query): Entry[] {
  const h = scopeOf(ctx);
  if (!canAudit(ctx, who)) q = { ...q, actor: who };
  const limit = q.limit === 0 ? 100 : Math.min(q.limit, 500);
  const candidates: Iterable<ChangeRow> =
    q.groupId !== undefined
      ? h.db.change.groupId.filter(q.groupId)
      : q.tableName !== undefined && q.rowKey !== undefined
        ? h.db.change.byRow.filter([q.tableName, q.rowKey])
        : q.actor !== undefined
          ? h.db.change.actor.filter(q.actor)
          : q.tableName !== undefined
            ? h.db.change.tableName.filter(q.tableName)
            : h.db.change.iter();
  const matches = [...candidates]
    .filter((c) => q.tableName === undefined || c.tableName === q.tableName)
    .filter((c) => q.rowKey === undefined || c.rowKey === q.rowKey)
    .filter((c) => q.actor === undefined || c.actor.isEqual(q.actor))
    .filter((c) => q.from === undefined || c.at.microsSinceUnixEpoch >= q.from.microsSinceUnixEpoch)
    .filter((c) => q.to === undefined || c.at.microsSinceUnixEpoch <= q.to.microsSinceUnixEpoch)
    .filter((c) => q.beforeId === undefined || c.id < q.beforeId)
    .sort((a, b) => (a.id > b.id ? -1 : 1));
  const out: Entry[] = [];
  for (const c of matches) {
    const g = h.db.group.id.find(c.groupId);
    if (!g || (q.scope !== undefined && g.scope !== q.scope)) continue;
    out.push({ changeId: c.id, groupId: c.groupId, tableName: c.tableName, rowKey: c.rowKey, op: c.op, before: c.before, after: c.after, actor: c.actor, at: c.at, action: g.action, scope: g.scope, kind: g.kind });
    if (out.length >= limit) break;
  }
  return out;
}

/** A row as it was at `at` (BSATN), or undefined if it didn't exist then. */
export function rowAsOf(ctx: HostCtx, table: string, rowKey: string, at: Timestamp): Uint8Array | undefined {
  const h = scopeOf(ctx);
  const changes = [...h.db.change.byRow.filter([table, rowKey])].sort((a, b) => (a.id < b.id ? -1 : 1));
  const before = changes.filter((c) => c.at.microsSinceUnixEpoch <= at.microsSinceUnixEpoch);
  if (before.length) return before[before.length - 1].after ?? undefined;
  if (changes.length) return changes[0].before ?? undefined;
  return tableNamed(table).read(ctx, unhex(rowKey));
}

/** A whole table as it was at `at`: current rows with every later change rolled back. */
export function tableAsOf(ctx: HostCtx, table: string, at: Timestamp): Row[] {
  const h = scopeOf(ctx);
  const rows = new Map<string, Uint8Array>();
  for (const [k, v] of tableNamed(table).scan(ctx)) rows.set(hex(k), v);
  const later = [...h.db.change.tableName.filter(table)]
    .filter((c) => c.at.microsSinceUnixEpoch > at.microsSinceUnixEpoch)
    .sort((a, b) => (a.id > b.id ? -1 : 1));
  for (const c of later) {
    if (c.before) rows.set(c.rowKey, c.before);
    else rows.delete(c.rowKey);
  }
  return [...rows.keys()].sort().map((rowKey) => ({ rowKey, value: rows.get(rowKey)! }));
}

/** Your own action groups (most recent 200), for a view. */
export function myGroups(h: { db: HistoryCtx['db'] } | { db: any }, who: Identity): GroupRow[] {
  return [...(h.db as HistoryCtx['db']).group.actor.filter(who)].sort((a, b) => (a.id > b.id ? -1 : 1)).slice(0, 200);
}

/** The row type of the `history_my_groups` view (same name and shape as the Rust and C# modules). */
export const HistoryGroup = t.object('HistoryGroup', {
  id: t.u64(),
  actor: t.identity(),
  scope: t.string(),
  action: t.string(),
  at: t.timestamp(),
  kind: t.u8(),
  state: t.u8(),
  link: t.u64(),
  changes: t.u32(),
});

/** Delete history older than the retention settings. The hourly job calls this. */
export function pruneNow(h: HistoryCtx): number {
  const s = settings(h);
  const now = h.timestamp.microsSinceUnixEpoch;
  const limitFor = (table: string) => s.tableRetention.find((r) => r.tableName === table)?.retentionSecs ?? s.retentionSecs;
  let removed = 0;
  const touched = new Set<bigint>();
  for (const c of [...h.db.change.iter()]) {
    const keep = limitFor(c.tableName);
    if (keep > 0n && now - c.at.microsSinceUnixEpoch > keep * 1_000_000n) {
      touched.add(c.groupId);
      h.db.change.id.delete(c.id);
      removed++;
    }
  }
  for (const g of touched) {
    if (h.db.change.groupId.filter(g).next().done) h.db.group.id.delete(g);
  }
  return removed;
}

export function canAudit(ctx: HostCtx, who: Identity): boolean {
  const h = scopeOf(ctx);
  return who.isEqual(h.databaseIdentity) || settings(h).openAudit || !!h.db.auditor.identity.find(who);
}

export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function unhex(s: string): Uint8Array {
  if (s.length % 2) throw new SenderError('bad row key');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function newGroup(ctx: HostCtx, kind: number, action: string, scope: string, link: bigint): bigint {
  const h = scopeOf(ctx);
  if (kind === KIND_ACTION) {
    // A new action ends the redo chain for this person and scope.
    for (const g of stack(h, ctx.sender, scope)) {
      if (g.state === STATE_UNDONE) h.db.group.id.update({ ...g, state: STATE_DROPPED });
    }
  }
  return h.db.group.insert({ id: 0n, actor: ctx.sender, scope, action, at: ctx.timestamp, kind, state: STATE_DONE, link, changes: 0 }).id;
}

/** The newest group by this caller at this transaction's timestamp. */
function currentGroup(ctx: HostCtx): GroupRow {
  const h = scopeOf(ctx);
  let found: GroupRow | undefined;
  for (const g of h.db.group.at.filter(ctx.timestamp)) {
    if (g.actor.isEqual(ctx.sender) && (!found || g.id > found.id)) found = g;
  }
  if (found) return found;
  return h.db.group.id.find(newGroup(ctx, KIND_ACTION, '', '', 0n))!;
}

/** `who`'s action groups in `scope`, newest first. */
function stack(h: HistoryCtx, who: Identity, scope: string): GroupRow[] {
  return [...h.db.group.byActorScope.filter([who, scope])]
    .filter((g) => g.kind === KIND_ACTION && g.changes > 0)
    .sort((a, b) => (a.id > b.id ? -1 : 1));
}

function groupChanges(h: HistoryCtx, groupId: bigint): ChangeRow[] {
  return [...h.db.change.groupId.filter(groupId)].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Undo: each row must still look like the group's last write to it. Redo: like its first read. */
function check(ctx: HostCtx, changes: ChangeRow[], undoing: boolean): void {
  const seen = new Set<string>();
  const conflicts: string[] = [];
  for (const c of undoing ? [...changes].reverse() : changes) {
    const id = `${c.tableName}#${c.rowKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = tableNamed(c.tableName);
    if (t.scrubbed) throw new SenderError(`${c.tableName} is redacted in history, so it can't be undone`);
    const expected = (undoing ? c.after : c.before) ?? undefined;
    if (!sameBytes(t.read(ctx, unhex(c.rowKey)), expected)) conflicts.push(id);
  }
  if (conflicts.length) throw new SenderError(`conflict: changed since by someone else: ${conflicts.join(', ')}`);
}
