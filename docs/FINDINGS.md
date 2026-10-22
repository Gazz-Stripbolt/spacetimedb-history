# Findings

What we learned building history on Spacetime 2.11.

## Numbers

[`tests/bench.mts`](../tests/bench.mts) runs 2,000 updates of one 65-byte row inside one transaction, tracked and untracked,
and takes the median of 5 runs on the 2-vCPU dev VM (shared with other builds, so treat it as relative):

| | Rust | C# (NativeAOT) | TypeScript |
|---|---|---|---|
| Plain update | 2.15 µs | 10.5 µs | 2.77 µs |
| Tracked update | 17.99 µs | 47.4 µs | 41.2 µs |
| Overhead per tracked write | +15.8 µs | +36.9 µs | +38.5 µs |

Per tracked write, history does:
- a lookup of the row's current value (for `before`)
- two BSATN encodes
- a lookup of the transaction's group (by the `at` index)
- one `history_change` insert
- one `history_group` update

**Write amplification:** a 65-byte row costs 130 bytes of before/after, plus about 100 bytes of change-row fields and
indexes, per update. Inserts and deletes store one image, updates store two. For big rows that change one field at a
time (overlay elements with large data blobs), storing a diff would be smaller, at the cost of slower point-in-time
reads. Full images keep undo and `row_as_of` simple and exact.

## Design notes

- **No triggers, so wrappers.** Spacetime modules can't observe writes, so history only sees what goes through
  `tracked::*` (Rust), `HistoryTable` (C#) or `track()` (TS). A raw write to a tracked table is invisible to
  history, and later shows up as an undo conflict on that row, which is the safe outcome.
- **Why BSATN and not JSON:**
  - exact round-trips for undo (u64, i128, `Identity`, options, enums)
  - byte-identical across the three languages, so one client decodes all of them
  - no serde in Rust, and no reflection-based JSON on wasi C#, which trimming breaks
  - JSON would make diffs readable in SQL. Clients get that anyway by decoding with their generated row types.
- **Groups are found by (sender, timestamp).** Every write in a transaction shares `ctx.timestamp`, so "the newest
  group by this caller at this timestamp" is the transaction's group, with no global state. Two transactions by the
  same identity at the same microsecond would merge, which is vanishingly unlikely.
- **Restoring deleted rows keeps their ids.** Inserting a row with a non-zero value in an auto-increment column keeps
  that value, so undoing a delete brings `id 42` back as `id 42`. All three languages behave the same.
- **Undo checks every row first, then writes.** A conflict anywhere aborts before any write. Reducer errors also roll
  back, but checking first gives a clean error listing every conflicting row.
- **Point in time without history uses the current value.** If a row has no recorded changes, `row_as_of` assumes it
  hasn't changed: the only correct answer when every write is tracked, and a wrong one when it isn't.

## Spacetime quirks

- **TS: decode with the `spacetimedb` entry point, not `spacetimedb/server`.** The two entry points are separate
  bundles, each with its own `BinaryReader` class. A table's `rowType.deserialize(reader)` (server bundle) calls
  bound methods from its own `BinaryReader.prototype`. Those reject a reader from the main entry point with
  `TypeError: Receiver must be an instance of class anonymous` (`readString` uses a private `#ensure`). The server
  bundle doesn't export its `BinaryReader`. Workaround: `AlgebraicType.makeDeserializer(rowType.algebraicType)` from the
  main `spacetimedb` entry, with that entry's `BinaryReader`. Writing doesn't hit this, because `BinaryWriter` has no
  private fields. The webhooks repo hit the same split with `HttpResponse`.
- **TS submodules can't reach the consumer's tables.** A submodule's reducers run with a context narrowed to its own
  namespace. Undo writes the consumer's tables, so the consumer defines `history_undo`, `history_redo`, the three
  procedures and the view as one-line wrappers, and registers each table with `track()`. It also tells history how
  to reach its own tables: `setup({ scope: (ctx) => ctx.as.history })`. As a bonus, every client-facing name is flat,
  identical to Rust and C#, with no namespace adapter on the client.
- **Consumer views can read submodule tables** (`ctx.db.history.group` in a view), but the typings don't expose the
  namespace on the view context, so it needs a cast.
- **C#: static field initialization order across `partial` files is undefined.** `History.cs` keeps the registry in a
  field without an initializer (`historyTables ??= new()`), so host fields that call `HistoryTrack(...)` work whichever
  part initializes first.
- **C#: procedures run in `ProcedureTxContext`, not `ReducerContext`.** The library works on a small
  `HistoryTx(Db, Sender, Timestamp, Self)` record, built from either.
- **Rust `macro_rules!`: `, scrub = f` after a `$key:ty` is ambiguous** with the next table entry (`local ambiguity …
  built-in NTs ident`), so the syntax is `id: u64 [scrub = f]`.
- **Scheduled reducers are client-callable,** so `history_prune` checks that the caller is the database itself (as in
  the authz repo).
