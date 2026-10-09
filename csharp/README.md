# History.cs: audit log, undo/redo and point-in-time reads for C# modules

One file. Add [`History.cs`](History.cs) to your module project, and register each tracked table once as a static
field:

```csharp
static readonly HistoryTable<Note, Note.BSATN, ulong, SpacetimeDB.BSATN.U64> NoteHistory = HistoryTrack(
    new HistoryTable<Note, Note.BSATN, ulong, SpacetimeDB.BSATN.U64>(
        "note", n => n.Id,
        (db, id) => db.Note.Id.Find(id), (db, r) => db.Note.Insert(r),
        (db, r) => db.Note.Id.Update(r), (db, id) => db.Note.Id.Delete(id), db => db.Note.Iter(),
        scrub: null));   // or: scrub: r => r with { Secret = "[redacted]" }

[SpacetimeDB.Reducer]
public static void MoveNotes(ReducerContext ctx, List<ulong> ids, float dx, float dy)
{
    HistoryBegin(ctx, "move notes", "board");
    foreach (var id in ids)
    {
        var n = ctx.Db.Note.Id.Find(id) ?? throw new Exception("no such note");
        NoteHistory.Update(ctx, n with { X = n.X + dx, Y = n.Y + dy });
    }
}
```

The type arguments are the row, its generated `BSATN` serializer, the key type and the key's serializer
(`SpacetimeDB.BSATN.U64`, `SpacetimeDB.BSATN.String`, `Identity.BSATN`, …). A complete module is in
[`demo/csharp`](../demo/csharp/Lib.cs).

Library functions: `HistoryConfigure`, `HistoryBegin`, `HistoryUndoFor` / `HistoryRedoFor`, `HistorySearch`,
`HistoryRowAsOf` / `HistoryTableAsOf`, `HistoryAddAuditor` / `HistoryRemoveAuditor` / `HistoryCanAudit`,
`HistoryRecord` and `HistoryPruneNow`. The client-facing reducers, procedures and view (`history_undo`,
`history_query`, `history_my_groups`, …) are included, and canonicalise to the same names as Rust.
