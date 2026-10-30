# spacetimedb-history for TypeScript (submodule)

Audit log, undo/redo and point-in-time reads as a **Spacetime submodule**. Source: [`src/index.ts`](src/index.ts) ·
Complete example: [`demo/typescript`](../demo/typescript/src/index.ts)

## Install

```bash
npm install @pogly/spacetimedb-history spacetimedb
```

Use `spacetimedb` 2.13.x or 2.14.x, and keep only one copy of it in your module's dependency tree. With two copies,
`spacetime publish` fails with *"Local module schema inspection failed"*. The package ships compiled JavaScript plus
its TypeScript source, which is where the types come from.

A module built with the 2.14 library needs a 2.14 or newer host: the library's HTTP handler export changed, and older
hosts reject it ([release notes](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.14.0)). If your host is still on 2.13, stay on `spacetimedb` 2.13.x.

To work on it from a clone instead, add this folder to your npm workspaces next to your module:

```jsonc
// package.json at your repo root
{ "private": true, "workspaces": ["spacetimedb-history/typescript", "my-module"] }
// my-module/package.json
{ "dependencies": { "spacetimedb": "2.14.*", "@pogly/spacetimedb-history": "*" } }
```

## Wire it up

A submodule can't reach your tables, so you register them, and you define the client-facing reducers, procedures and
view as one-line wrappers. Their names then match the Rust and C# modules exactly.

```typescript
import { schema, table, t } from 'spacetimedb/server';
import * as history from '@pogly/spacetimedb-history';

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
