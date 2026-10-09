// Demo: a shared sticky-note board with an audit log, per-person undo/redo and a time slider.
// Serves the web client at /route/. The C# twin of demo/rust.

#pragma warning disable STDB_UNSTABLE

using SpacetimeDB;

public static partial class Module
{
    const string Board = "board";

    [SpacetimeDB.Table(Accessor = "DemoNote", Public = true)]
    public partial struct DemoNote
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        public string Text;
        public float X;
        public float Y;
        public string Color;
    }

    /// <summary>A table with a secret in it, to show redaction: history never stores ApiKey.</summary>
    [SpacetimeDB.Table(Accessor = "DemoAccount", Public = true)]
    public partial struct DemoAccount
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
        public string Name;
        public string ApiKey;
    }

    static readonly HistoryTable<DemoNote, DemoNote.BSATN, ulong, SpacetimeDB.BSATN.U64> NoteHistory = HistoryTrack(
        new HistoryTable<DemoNote, DemoNote.BSATN, ulong, SpacetimeDB.BSATN.U64>(
            "demo_note", n => n.Id,
            (db, id) => db.DemoNote.Id.Find(id), (db, r) => db.DemoNote.Insert(r),
            (db, r) => db.DemoNote.Id.Update(r), (db, id) => db.DemoNote.Id.Delete(id), db => db.DemoNote.Iter()));

    static readonly HistoryTable<DemoAccount, DemoAccount.BSATN, Identity, Identity.BSATN> AccountHistory = HistoryTrack(
        new HistoryTable<DemoAccount, DemoAccount.BSATN, Identity, Identity.BSATN>(
            "demo_account", a => a.Identity,
            (db, id) => db.DemoAccount.Identity.Find(id), (db, r) => db.DemoAccount.Insert(r),
            (db, r) => db.DemoAccount.Identity.Update(r), (db, id) => db.DemoAccount.Identity.Delete(id), db => db.DemoAccount.Iter(),
            scrub: a => a with { ApiKey = "[redacted]" }));

    [SpacetimeDB.Reducer(ReducerKind.Init)]
    public static void Init(ReducerContext ctx)
    {
        // The demo lets anyone read the whole log and use the time slider.
        HistoryConfigure(ctx, HistorySettings.Default with { OpenAudit = true });
    }

    [SpacetimeDB.Reducer]
    public static void DemoAddNote(ReducerContext ctx, string text, float x, float y, string color)
    {
        CheckText(text);
        HistoryBegin(ctx, "add note", Board);
        NoteHistory.Insert(ctx, new DemoNote { Id = 0, Text = text, X = Clamp(x), Y = Clamp(y), Color = color });
    }

    [SpacetimeDB.Reducer]
    public static void DemoEditNote(ReducerContext ctx, ulong id, string text)
    {
        CheckText(text);
        var n = ctx.Db.DemoNote.Id.Find(id) ?? throw new Exception("no such note");
        HistoryBegin(ctx, "edit note", Board);
        NoteHistory.Update(ctx, n with { Text = text });
    }

    /// <summary>Move several notes at once: one action, one undo step.</summary>
    [SpacetimeDB.Reducer]
    public static void DemoMoveNotes(ReducerContext ctx, List<ulong> ids, float dx, float dy)
    {
        HistoryBegin(ctx, "move notes", Board);
        foreach (var id in ids)
        {
            var n = ctx.Db.DemoNote.Id.Find(id) ?? throw new Exception("no such note");
            NoteHistory.Update(ctx, n with { X = Clamp(n.X + dx), Y = Clamp(n.Y + dy) });
        }
    }

    [SpacetimeDB.Reducer]
    public static void DemoRecolorNotes(ReducerContext ctx, List<ulong> ids, string color)
    {
        HistoryBegin(ctx, "recolor notes", Board);
        foreach (var id in ids)
        {
            var n = ctx.Db.DemoNote.Id.Find(id) ?? throw new Exception("no such note");
            NoteHistory.Update(ctx, n with { Color = color });
        }
    }

    [SpacetimeDB.Reducer]
    public static void DemoDeleteNotes(ReducerContext ctx, List<ulong> ids)
    {
        HistoryBegin(ctx, "delete notes", Board);
        foreach (var id in ids) NoteHistory.Delete(ctx, id);
    }

    [SpacetimeDB.Reducer]
    public static void DemoSetAccount(ReducerContext ctx, string name, string apiKey)
    {
        HistoryBegin(ctx, "set account", "account");
        AccountHistory.Upsert(ctx, new DemoAccount { Identity = ctx.Sender, Name = name, ApiKey = apiKey });
    }

    /// <summary>Test helper: shrink retention and prune right away.</summary>
    [SpacetimeDB.Reducer]
    public static void DemoPrune(ReducerContext ctx, ulong retentionSecs)
    {
        var s = HistoryGetSettings(ctx.Db);
        HistoryConfigure(ctx, s with { RetentionSecs = retentionSecs });
        HistoryPruneNow(ctx);
        HistoryConfigure(ctx, s);
    }

    /// <summary>Benchmark helper: count updates to one note in one transaction, tracked or not.</summary>
    [SpacetimeDB.Reducer]
    public static void DemoBench(ReducerContext ctx, ulong id, uint count, bool tracked)
    {
        HistoryBegin(ctx, "bench", "bench");
        for (uint i = 0; i < count; i++)
        {
            var n = ctx.Db.DemoNote.Id.Find(id) ?? throw new Exception("no such note");
            n = n with { X = i % 100 };
            if (tracked) NoteHistory.Update(ctx, n);
            else ctx.Db.DemoNote.Id.Update(n);
        }
    }

    /// <summary>Test helper: open or close the audit log.</summary>
    [SpacetimeDB.Reducer]
    public static void DemoSetOpenAudit(ReducerContext ctx, bool open) =>
        HistoryConfigure(ctx, HistoryGetSettings(ctx.Db) with { OpenAudit = open });

    static void CheckText(string text)
    {
        if (text.Length > 200) throw new Exception("note too long");
    }

    static float Clamp(float v) => float.IsFinite(v) ? Math.Clamp(v, 0f, 100f) : 50f;

    static readonly Lazy<byte[]> DemoPage = new(() =>
    {
        using var s = typeof(Module).Assembly.GetManifestResourceStream("index.html")!;
        using var m = new MemoryStream();
        s.CopyTo(m);
        return m.ToArray();
    });

    [SpacetimeDB.HttpHandler]
    public static HttpResponse Page(HandlerContext ctx, HttpRequest req) =>
        new(200, HttpVersion.Http11,
            new List<HttpHeader> { new("content-type", "text/html; charset=utf-8"), new("cache-control", "no-cache") },
            new HttpBody(DemoPage.Value));

    [SpacetimeDB.HttpRouter]
    public static Router Routes() => Router.New().Get("/", Handlers.Page);
}
