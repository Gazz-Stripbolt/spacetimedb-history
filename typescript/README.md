# spacetimedb-history for TypeScript (submodule)

Audit log, undo/redo and point-in-time reads as a **SpacetimeDB submodule**. Source: [`src/index.ts`](src/index.ts) ·
Complete example: [`demo/typescript`](../demo/typescript/src/index.ts)

## Install

It isn't on npm yet. Copy this folder into your repo and add it as an npm workspace package, so there's a single
copy of `spacetimedb`:

```jsonc
{ "private": true, "workspaces": ["spacetimedb-history", "my-module"] }       // repo root
{ "dependencies": { "spacetimedb": "2.11.*", "spacetimedb-history": "0.1.0" } } // my-module
```

## Wire it up

A submodule can't reach your tables, so you register them, and you define the client-facing reducers, procedures and
view as one-line wrappers. Their names then match the Rust and C# modules exactly.

```typescript
import { schema, table, t } from 'spacetimedb/server';
import * as history from 'spacetimedb-history';

const note = table({ name: 'note', public: true }, { id: t.u64().primaryKey().autoInc(), text: t.string(), x: t.f32(), y: t.f32() });
const spacetimedb = schema({ note, history });
export default spacetimedb;

history.setup({ scope: (ctx) => ctx.as.history });
const notes = history.track({
  name: 'note', row: note.rowType, key: t.u64(), keyOf: (r) => r.id,
  find: (ctx, id) => ctx.db.note.id.find(id), insert: (ctx, r) => ctx.db.note.insert(r),
  update: (ctx, r) => ctx.db.note.id.update(r), delete: (ctx, id) => ctx.db.note.id.delete(id),
  iter: (ctx) => ctx.db.note.iter(),
});

export const init = spacetimedb.init((ctx) => history.configure(ctx.as.history, history.DEFAULT_SETTINGS));
export const moveNote = spacetimedb.reducer({ id: t.u64(), dx: t.f32() }, (ctx, { id, dx }) => {
  history.begin(ctx, 'move note', 'board');
  const n = ctx.db.note.id.find(id)!;
  notes.update(ctx, { ...n, x: n.x + dx });
});

// Client-facing API (same names as Rust/C#):
export const historyUndo = spacetimedb.reducer({ scope: t.string() }, (ctx, { scope }) => void history.undo(ctx, ctx.sender, scope));
export const historyRedo = spacetimedb.reducer({ scope: t.string() }, (ctx, { scope }) => void history.redo(ctx, ctx.sender, scope));
export const historyQuery = spacetimedb.procedure({ q: history.HistoryQuery }, t.array(history.HistoryEntry),
  (ctx, { q }) => ctx.withTx((tx) => history.query(tx, tx.sender, q)));
// …plus historyRowAsOf, historyTableAsOf and the historyMyGroups view: see the demo.
```

Decode values with the `spacetimedb` entry point's `AlgebraicType`/`BinaryReader` (`history.decode` does), not with
builders from `spacetimedb/server`. See [FINDINGS](../docs/FINDINGS.md#spacetimedb-quirks).
