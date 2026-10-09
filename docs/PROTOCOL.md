# Protocol

What a client needs: the client-facing view, reducers and procedures, and how values are encoded. All three
implementations ([`history.rs`](../rust/history.rs), [`History.cs`](../csharp/History.cs) and the
[TypeScript submodule](../typescript/src/index.ts)) expose the same names and types. In the TypeScript demo the
consumer defines them as thin wrappers, because a submodule can't reach your tables.

## Values

- **Rows** (`before`, `after`, `value`) are the row's **BSATN** encoding, exactly what SpacetimeDB sends over the wire. Decode
  them with the row type from your generated bindings, e.g. in TypeScript
  `NoteRow.deserialize(new BinaryReader(bytes))`.
- **`row_key`** is the **lowercase hex of the BSATN of the primary key**. For a `u64` id that's 8 bytes,
  little-endian (`id 1` → `0100000000000000`); for an `Identity` it's 32 bytes; for a `String` it's a u32 length
  followed by UTF-8.
- **`table_name`** is the name the module registered the table under (the demo uses the canonical table names,
  `demo_note` and `demo_account`).

## Constants

| | Values |
|---|---|
| `op` | 0 insert · 1 update · 2 delete |
| group `kind` | 0 action (on the undo stack) · 1 undo · 2 redo |
| group `state` | 0 done · 1 undone (redoable) · 2 dropped (undone, then a new action came along) |

## View: `history_my_groups`

Your own groups, newest first (max 200). `HistoryGroup`:

| Field | Type | |
|---|---|---|
| `id` | u64 | |
| `actor` | Identity | always you |
| `scope` | string | from `begin(action, scope)`; `""` if none |
| `action` | string | e.g. `"move notes"` |
| `at` | Timestamp | |
| `kind`, `state` | u8 | see above |
| `link` | u64 | undo/redo groups: the group they acted on. Undone groups: the undo group (the newest undone has the highest `link`) |
| `changes` | u32 | rows changed |

To drive Undo/Redo buttons for a scope: *undo* is the newest `kind 0, state 0` group, and *redo* is the
`kind 0, state 1` group with the highest `link`.

## Reducers

| Reducer | Args | Errors |
|---|---|---|
| `history_undo` | `scope: string` | `nothing to undo` · `conflict: changed since by someone else: table#key, …` · `<table> is redacted in history, so it can't be undone` |
| `history_redo` | `scope: string` | `nothing to redo` · `conflict: …` |

## Procedures

| Procedure | Args | Returns |
|---|---|---|
| `history_query` | `q: HistoryQuery` | `HistoryEntry[]`, newest first. Non-auditors only ever get their own changes |
| `history_row_as_of` | `table_name, row_key, at: Timestamp` | `Option<bytes>` (None: didn't exist then, or you may not audit) |
| `history_table_as_of` | `table_name, at: Timestamp` | `HistoryRow { row_key, value }[]` (empty if you may not audit) |

`HistoryQuery` (every field is optional except `limit`): `table_name`, `row_key`, `actor`, `scope`, `group_id`,
`from`, `to`, `before_id` (page backwards), `limit` (0 = 100, max 500).

`HistoryEntry`: `change_id, group_id, table_name, row_key, op, before?, after?, actor, at, action, scope, kind`.

## Who may read what

| | Own changes | Everyone's changes, point in time |
|---|---|---|
| Anyone | ✅ (`history_query`, `history_my_groups`) | only with `open_audit` |
| Auditors (`add_auditor`) | ✅ | ✅ |
| The module identity | ✅ | ✅ |
