# history.rs: audit log, undo/redo and point-in-time reads for Rust modules

One file. Copy [`history.rs`](history.rs) to `src/history.rs` (the module must be named `history`; the macro refers to
`crate::history`).

```rust
pub mod history;

history_tables! {
    note: Note => id: u64,
    account: Account => identity: Identity [scrub = scrub_account],   // fn(&Account) -> Account
}

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    history::configure(ctx, history::HistorySettings::default());
}
```

For each table, `history_tables!` generates `tracked::<table>::{insert, update, upsert, delete}`. Use those instead
of the raw handle. It also generates the glue undo and point-in-time reads need. A complete module is in
[`demo/rust`](../demo/rust/src/lib.rs).

| Function | |
|---|---|
| `configure(ctx, HistorySettings)` | Retention (global and per table), undo depth, `open_audit`. Schedules the hourly prune |
| `begin(ctx, action, scope) -> u64` | Name and scope this transaction's group |
| `undo(ctx, who, scope)` / `redo(ctx, who, scope)` | What the `history_undo` / `history_redo` reducers call |
| `query(ctx, who, &HistoryQuery)` | The log, newest first (own changes only unless `who` can audit) |
| `row_as_of(ctx, table, row_key, at)` / `table_as_of(ctx, table, at)` | Point-in-time reads (BSATN) |
| `add_auditor(ctx, who)` / `remove_auditor` / `can_audit` | Who may read everything |
| `record(ctx, table, key, before, after)` | Record a change you made some other way |
| `prune(ctx)` | Apply retention now (the hourly job calls it) |
| `encode` / `decode` / `hex` / `unhex` | BSATN and row-key helpers |

Needs the `unstable` feature only if your module uses it elsewhere. History itself needs no row-level security.
