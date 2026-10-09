// History.cs: audit log, point-in-time reads and undo/redo for SpacetimeDB C# modules, one file.
//
// The C# twin of rust/history.rs and the spacetimedb-history TypeScript submodule: same tables,
// procedures and BSATN values, so the same clients work against all three. A stopgap until
// SpacetimeDB lets modules read their own commit log.
//
// Drop this file into your module and register each table you want tracked, once:
//
//     static readonly HistoryTable<Note, Note.BSATN, ulong, SpacetimeDB.BSATN.U64> NoteHistory = HistoryTrack(
//         new("note", n => n.Id,
//             (db, id) => db.Note.Id.Find(id), (db, r) => db.Note.Insert(r),
//             (db, r) => db.Note.Id.Update(r), (db, id) => db.Note.Id.Delete(id), db => db.Note.Iter()));
//
// then write through it: NoteHistory.Insert(ctx, row), .Update, .Upsert, .Delete. Call
// HistoryBegin(ctx, "move notes", "board") first to name and scope the action.

#pragma warning disable STDB_UNSTABLE
#nullable enable

using SpacetimeDB;
using SpacetimeDB.BSATN;

[SpacetimeDB.Type]
public partial struct HistoryTableRetention
{
    public string TableName;
    public ulong RetentionSecs;
}

[SpacetimeDB.Type]
public partial struct HistorySettings
{
    /// <summary>Keep history this long (seconds). 0 = forever.</summary>
    public ulong RetentionSecs;
    /// <summary>Per-table overrides of RetentionSecs.</summary>
    public List<HistoryTableRetention> TableRetention;
    /// <summary>How many of your most recent action groups (per scope) undo can reach back through.</summary>
    public uint MaxUndoDepth;
    /// <summary>Anyone may query the whole log. Off: you see your own changes; auditors see everything.</summary>
    public bool OpenAudit;

    public static HistorySettings Default => new()
    {
        RetentionSecs = 30UL * 24 * 3600,
        TableRetention = new(),
        MaxUndoDepth = 100,
        OpenAudit = false,
    };
}

/// <summary>A change with its group's context, as returned by queries.</summary>
[SpacetimeDB.Type]
public partial struct HistoryEntry
{
    public ulong ChangeId;
    public ulong GroupId;
    public string TableName;
    public string RowKey;
    public byte Op;
    public byte[]? Before;
    public byte[]? After;
    public Identity Actor;
    public Timestamp At;
    public string Action;
    public string Scope;
    public byte Kind;
}

[SpacetimeDB.Type]
public partial struct HistoryQuery
{
    public string? TableName;
    public string? RowKey;
    public Identity? Actor;
    public string? Scope;
    public ulong? GroupId;
    public Timestamp? From;
    public Timestamp? To;
    /// <summary>Only changes with id &lt; this (paging backwards).</summary>
    public ulong? BeforeId;
    /// <summary>Max entries (capped at 500). 0 = 100.</summary>
    public uint Limit;
}

[SpacetimeDB.Type]
public partial struct HistoryRow
{
    public string RowKey;
    public byte[] Value;
}

/// <summary>A reducer or procedure transaction, as History sees it.</summary>
public readonly record struct HistoryTx(Local Db, Identity Sender, Timestamp Timestamp, Identity Self);

/// <summary>What undo and point-in-time reads need from a tracked table.</summary>
public interface IHistoryTable
{
    string Name { get; }
    bool Scrubbed { get; }
    byte[]? Read(HistoryTx tx, byte[] key);
    void Write(HistoryTx tx, byte[] key, byte[]? value);
    List<(byte[] Key, byte[] Value)> Scan(HistoryTx tx);
}

/// <summary>
/// A tracked table: write through Insert/Update/Upsert/Delete and every change is recorded.
/// Pass a scrub function to redact rows before they're recorded (undo is then disabled for it).
/// </summary>
public sealed class HistoryTable<TRow, TRowRW, TKey, TKeyRW>(
    string name,
    Func<TRow, TKey> key,
    Func<Local, TKey, TRow?> find,
    Func<Local, TRow, TRow> insert,
    Func<Local, TRow, TRow> update,
    Func<Local, TKey, bool> delete,
    Func<Local, IEnumerable<TRow>> iter,
    Func<TRow, TRow>? scrub = null
) : IHistoryTable
    where TRow : struct
    where TRowRW : IReadWrite<TRow>, new()
    where TKeyRW : IReadWrite<TKey>, new()
{
    static readonly TRowRW RowRW = new();
    static readonly TKeyRW KeyRW = new();

    public string Name => name;
    public bool Scrubbed => scrub is not null;

    byte[] Snapshot(TRow row) => IStructuralReadWrite.ToBytes(RowRW, scrub is null ? row : scrub(row));
    static byte[] KeyBytes(TKey k) => IStructuralReadWrite.ToBytes(KeyRW, k);

    public TRow Insert(ReducerContext ctx, TRow row) => Insert(Module.HistoryTxOf(ctx), row);
    public TRow Update(ReducerContext ctx, TRow row) => Update(Module.HistoryTxOf(ctx), row);
    public TRow Upsert(ReducerContext ctx, TRow row) => Upsert(Module.HistoryTxOf(ctx), row);
    public bool Delete(ReducerContext ctx, TKey k) => Delete(Module.HistoryTxOf(ctx), k);

    public TRow Insert(HistoryTx tx, TRow row)
    {
        row = insert(tx.Db, row);
        Module.HistoryRecord(tx, name, KeyBytes(key(row)), null, Snapshot(row));
        return row;
    }

    public TRow Update(HistoryTx tx, TRow row)
    {
        var before = find(tx.Db, key(row)) is { } old ? Snapshot(old) : null;
        row = update(tx.Db, row);
        Module.HistoryRecord(tx, name, KeyBytes(key(row)), before, Snapshot(row));
        return row;
    }

    public TRow Upsert(HistoryTx tx, TRow row) => find(tx.Db, key(row)) is null ? Insert(tx, row) : Update(tx, row);

    public bool Delete(HistoryTx tx, TKey k)
    {
        if (find(tx.Db, k) is not { } old) return false;
        delete(tx.Db, k);
        Module.HistoryRecord(tx, name, KeyBytes(k), Snapshot(old), null);
        return true;
    }

    public byte[]? Read(HistoryTx tx, byte[] k) => find(tx.Db, Decode(KeyRW, k)) is { } row ? Snapshot(row) : null;

    public void Write(HistoryTx tx, byte[] k, byte[]? value)
    {
        var keyValue = Decode(KeyRW, k);
        var exists = find(tx.Db, keyValue) is not null;
        if (value is null)
        {
            if (exists) Delete(tx, keyValue);
        }
        else
        {
            var row = Decode(RowRW, value);
            if (exists) Update(tx, row);
            else Insert(tx, row);
        }
    }

    public List<(byte[] Key, byte[] Value)> Scan(HistoryTx tx) =>
        iter(tx.Db).Select(r => (KeyBytes(key(r)), Snapshot(r))).ToList();

    static T Decode<T, RW>(RW rw, byte[] bytes) where RW : IReadWrite<T>
    {
        using var reader = new BinaryReader(new MemoryStream(bytes));
        return rw.Read(reader);
    }

    static TRow Decode(TRowRW rw, byte[] bytes) => Decode<TRow, TRowRW>(rw, bytes);
    static TKey Decode(TKeyRW rw, byte[] bytes) => Decode<TKey, TKeyRW>(rw, bytes);
}

public static partial class Module
{
    public const byte HISTORY_OP_INSERT = 0;
    public const byte HISTORY_OP_UPDATE = 1;
    public const byte HISTORY_OP_DELETE = 2;
    /// <summary>Group kinds. Only action groups are on the undo stack.</summary>
    public const byte HISTORY_KIND_ACTION = 0;
    public const byte HISTORY_KIND_UNDO = 1;
    public const byte HISTORY_KIND_REDO = 2;
    public const byte HISTORY_STATE_DONE = 0;
    public const byte HISTORY_STATE_UNDONE = 1;
    /// <summary>Undone, then a new action came along: no longer redoable.</summary>
    public const byte HISTORY_STATE_DROPPED = 2;

    // -----------------------------------------------------------------------
    // Tables (all private)
    // -----------------------------------------------------------------------

    [SpacetimeDB.Table(Accessor = "HistoryConfig")]
    public partial struct HistoryConfig
    {
        [SpacetimeDB.PrimaryKey]
        public byte Key;
        public HistorySettings Settings;
    }

    /// <summary>One per transaction (or per HistoryBegin call): an action you can undo as a unit.</summary>
    [SpacetimeDB.Table(Accessor = "HistoryGroup")]
    [SpacetimeDB.Index.BTree(Accessor = "ByActorScope", Columns = new[] { nameof(Actor), nameof(Scope) })]
    public partial struct HistoryGroup
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        [SpacetimeDB.Index.BTree]
        public Identity Actor;
        public string Scope;
        public string Action;
        [SpacetimeDB.Index.BTree]
        public Timestamp At;
        public byte Kind;
        public byte State;
        /// <summary>For undo/redo groups: the group they undid or redid. For undone groups: the undo group.</summary>
        public ulong Link;
        public uint Changes;
    }

    [SpacetimeDB.Table(Accessor = "HistoryChange")]
    [SpacetimeDB.Index.BTree(Accessor = "ByRow", Columns = new[] { nameof(TableName), nameof(RowKey) })]
    public partial struct HistoryChange
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        [SpacetimeDB.Index.BTree]
        public ulong GroupId;
        [SpacetimeDB.Index.BTree]
        public string TableName;
        /// <summary>Hex of the BSATN-encoded primary key.</summary>
        public string RowKey;
        public byte Op;
        public byte[]? Before;
        public byte[]? After;
        [SpacetimeDB.Index.BTree]
        public Identity Actor;
        [SpacetimeDB.Index.BTree]
        public Timestamp At;
    }

    /// <summary>Identities allowed to read the whole log (besides the module itself).</summary>
    [SpacetimeDB.Table(Accessor = "HistoryAuditor")]
    public partial struct HistoryAuditor
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
    }

    /// <summary>The hourly retention job.</summary>
    [SpacetimeDB.Table(Accessor = "HistoryPruneJob", Scheduled = nameof(HistoryPrune), ScheduledAt = nameof(HistoryPruneJob.ScheduledAt))]
    public partial struct HistoryPruneJob
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong ScheduledId;
        public ScheduleAt ScheduledAt;
    }

    // -----------------------------------------------------------------------
    // Registry
    // -----------------------------------------------------------------------

    // No initializer on purpose: host fields register through HistoryTrack during static
    // initialization, in whatever order the partial class parts run.
    static Dictionary<string, IHistoryTable>? historyTables;
    static Dictionary<string, IHistoryTable> HistoryTables => historyTables ??= new();

    /// <summary>Register a tracked table (use as a static field initializer).</summary>
    public static T HistoryTrack<T>(T table) where T : IHistoryTable
    {
        HistoryTables[table.Name] = table;
        return table;
    }

    static IHistoryTable HistoryTableNamed(string name) =>
        HistoryTables.TryGetValue(name, out var t) ? t : throw new Exception($"{name} isn't a tracked table");

    public static HistoryTx HistoryTxOf(ReducerContext ctx) => new(ctx.Db, ctx.Sender, ctx.Timestamp, ctx.DatabaseIdentity);

    // -----------------------------------------------------------------------
    // Library API
    // -----------------------------------------------------------------------

    /// <summary>Store settings (from Init, or any time). Also schedules the hourly prune job.</summary>
    public static void HistoryConfigure(ReducerContext ctx, HistorySettings settings)
    {
        var row = new HistoryConfig { Key = 0, Settings = settings };
        if (ctx.Db.HistoryConfig.Key.Find(0) is not null) ctx.Db.HistoryConfig.Key.Update(row);
        else ctx.Db.HistoryConfig.Insert(row);
        if (ctx.Db.HistoryPruneJob.Count == 0)
        {
            ctx.Db.HistoryPruneJob.Insert(new HistoryPruneJob { ScheduledId = 0, ScheduledAt = new ScheduleAt.Interval(new TimeDuration(3600L * 1_000_000)) });
        }
    }

    public static HistorySettings HistoryGetSettings(Local db) => db.HistoryConfig.Key.Find(0)?.Settings ?? HistorySettings.Default;

    public static void HistoryAddAuditor(ReducerContext ctx, Identity who)
    {
        if (ctx.Db.HistoryAuditor.Identity.Find(who) is null) ctx.Db.HistoryAuditor.Insert(new HistoryAuditor { Identity = who });
    }

    public static void HistoryRemoveAuditor(ReducerContext ctx, Identity who) => ctx.Db.HistoryAuditor.Identity.Delete(who);

    /// <summary>Start a named action group for the rest of this transaction.</summary>
    public static ulong HistoryBegin(ReducerContext ctx, string action, string scope) =>
        HistoryNewGroup(HistoryTxOf(ctx), HISTORY_KIND_ACTION, action, scope, 0);

    /// <summary>Record one change (the HistoryTable wrappers do this for you). Values are BSATN.</summary>
    public static void HistoryRecord(HistoryTx tx, string table, byte[] key, byte[]? before, byte[]? after)
    {
        byte op;
        if (before is null && after is null) return;
        else if (before is null) op = HISTORY_OP_INSERT;
        else if (after is null) op = HISTORY_OP_DELETE;
        else if (before.AsSpan().SequenceEqual(after)) return; // no-op update
        else op = HISTORY_OP_UPDATE;
        var group = HistoryCurrentGroup(tx);
        tx.Db.HistoryChange.Insert(new HistoryChange
        {
            Id = 0,
            GroupId = group.Id,
            TableName = table,
            RowKey = HistoryHex(key),
            Op = op,
            Before = before,
            After = after,
            Actor = tx.Sender,
            At = tx.Timestamp,
        });
        tx.Db.HistoryGroup.Id.Update(group with { Changes = group.Changes + 1 });
    }

    /// <summary>Undo who's most recent action in scope. Throws (and changes nothing) on conflict.</summary>
    public static ulong HistoryUndoFor(HistoryTx tx, Identity who, string scope)
    {
        var depth = (int)Math.Max(1, HistoryGetSettings(tx.Db).MaxUndoDepth);
        var target = HistoryStack(tx, who, scope)
            .Where(g => g.State != HISTORY_STATE_DROPPED)
            .Take(depth)
            .Cast<HistoryGroup?>()
            .FirstOrDefault(g => g!.Value.State == HISTORY_STATE_DONE)
            ?? throw new Exception("nothing to undo");
        var changes = HistoryGroupChanges(tx.Db, target.Id);
        HistoryCheck(tx, changes, undoing: true);
        var g = HistoryNewGroup(tx, HISTORY_KIND_UNDO, target.Action, scope, target.Id);
        for (var i = changes.Count - 1; i >= 0; i--)
        {
            HistoryTableNamed(changes[i].TableName).Write(tx, HistoryUnhex(changes[i].RowKey), changes[i].Before);
        }
        tx.Db.HistoryGroup.Id.Update(target with { State = HISTORY_STATE_UNDONE, Link = g });
        return target.Id;
    }

    /// <summary>Redo the action who most recently undid in scope.</summary>
    public static ulong HistoryRedoFor(HistoryTx tx, Identity who, string scope)
    {
        var target = HistoryStack(tx, who, scope)
            .Where(g => g.State == HISTORY_STATE_UNDONE)
            .OrderByDescending(g => g.Link)
            .Cast<HistoryGroup?>()
            .FirstOrDefault()
            ?? throw new Exception("nothing to redo");
        var changes = HistoryGroupChanges(tx.Db, target.Id);
        HistoryCheck(tx, changes, undoing: false);
        var g = HistoryNewGroup(tx, HISTORY_KIND_REDO, target.Action, scope, target.Id);
        foreach (var c in changes)
        {
            HistoryTableNamed(c.TableName).Write(tx, HistoryUnhex(c.RowKey), c.After);
        }
        tx.Db.HistoryGroup.Id.Update(target with { State = HISTORY_STATE_DONE, Link = g });
        return target.Id;
    }

    /// <summary>The log, newest first. who sees only their own changes unless they may audit.</summary>
    public static List<HistoryEntry> HistorySearch(HistoryTx tx, Identity who, HistoryQuery q)
    {
        if (!HistoryCanAudit(tx, who)) q.Actor = who;
        var limit = q.Limit == 0 ? 100 : (int)Math.Min(q.Limit, 500u);
        IEnumerable<HistoryChange> candidates =
            q.GroupId is { } gid ? tx.Db.HistoryChange.GroupId.Filter(gid)
            : q.TableName is { } t && q.RowKey is { } k ? tx.Db.HistoryChange.ByRow.Filter((t, k))
            : q.Actor is { } a ? tx.Db.HistoryChange.Actor.Filter(a)
            : q.TableName is { } t2 ? tx.Db.HistoryChange.TableName.Filter(t2)
            : tx.Db.HistoryChange.Iter();
        var matches = candidates
            .Where(c => q.TableName is null || c.TableName == q.TableName)
            .Where(c => q.RowKey is null || c.RowKey == q.RowKey)
            .Where(c => q.Actor is null || c.Actor == q.Actor.Value)
            .Where(c => q.From is null || c.At.MicrosecondsSinceUnixEpoch >= q.From.Value.MicrosecondsSinceUnixEpoch)
            .Where(c => q.To is null || c.At.MicrosecondsSinceUnixEpoch <= q.To.Value.MicrosecondsSinceUnixEpoch)
            .Where(c => q.BeforeId is null || c.Id < q.BeforeId.Value)
            .OrderByDescending(c => c.Id);
        var entries = new List<HistoryEntry>();
        foreach (var c in matches)
        {
            if (tx.Db.HistoryGroup.Id.Find(c.GroupId) is not { } g) continue;
            if (q.Scope is not null && g.Scope != q.Scope) continue;
            entries.Add(new HistoryEntry
            {
                ChangeId = c.Id,
                GroupId = c.GroupId,
                TableName = c.TableName,
                RowKey = c.RowKey,
                Op = c.Op,
                Before = c.Before,
                After = c.After,
                Actor = c.Actor,
                At = c.At,
                Action = g.Action,
                Scope = g.Scope,
                Kind = g.Kind,
            });
            if (entries.Count >= limit) break;
        }
        return entries;
    }

    /// <summary>A row as it was at `at` (BSATN), or null if it didn't exist then.</summary>
    public static byte[]? HistoryRowAsOf(HistoryTx tx, string table, string rowKey, Timestamp at)
    {
        var changes = tx.Db.HistoryChange.ByRow.Filter((table, rowKey)).OrderBy(c => c.Id).ToList();
        var last = changes.LastOrDefault(c => c.At.MicrosecondsSinceUnixEpoch <= at.MicrosecondsSinceUnixEpoch);
        if (last.Id != 0) return last.After;
        if (changes.Count > 0) return changes[0].Before;
        return HistoryTableNamed(table).Read(tx, HistoryUnhex(rowKey));
    }

    /// <summary>A whole table as it was at `at`: current rows with every later change rolled back.</summary>
    public static List<HistoryRow> HistoryTableAsOf(HistoryTx tx, string table, Timestamp at)
    {
        var rows = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (var (k, v) in HistoryTableNamed(table).Scan(tx)) rows[HistoryHex(k)] = v;
        var later = tx.Db.HistoryChange.TableName.Filter(table)
            .Where(c => c.At.MicrosecondsSinceUnixEpoch > at.MicrosecondsSinceUnixEpoch)
            .OrderByDescending(c => c.Id);
        foreach (var c in later)
        {
            if (c.Before is null) rows.Remove(c.RowKey);
            else rows[c.RowKey] = c.Before;
        }
        return rows.Select(kv => new HistoryRow { RowKey = kv.Key, Value = kv.Value }).ToList();
    }

    /// <summary>Delete history older than the retention settings. The hourly job calls this.</summary>
    public static uint HistoryPruneNow(ReducerContext ctx)
    {
        var s = HistoryGetSettings(ctx.Db);
        var now = ctx.Timestamp.MicrosecondsSinceUnixEpoch;
        ulong LimitFor(string table) =>
            s.TableRetention.FirstOrDefault(r => r.TableName == table) is { TableName: not null } r ? r.RetentionSecs : s.RetentionSecs;
        uint removed = 0;
        var touched = new HashSet<ulong>();
        foreach (var c in ctx.Db.HistoryChange.Iter().ToList())
        {
            var keep = LimitFor(c.TableName);
            if (keep > 0 && now - c.At.MicrosecondsSinceUnixEpoch > (long)keep * 1_000_000)
            {
                touched.Add(c.GroupId);
                ctx.Db.HistoryChange.Id.Delete(c.Id);
                removed++;
            }
        }
        foreach (var g in touched)
        {
            if (!ctx.Db.HistoryChange.GroupId.Filter(g).Any()) ctx.Db.HistoryGroup.Id.Delete(g);
        }
        return removed;
    }

    public static bool HistoryCanAudit(HistoryTx tx, Identity who) =>
        who == tx.Self || HistoryGetSettings(tx.Db).OpenAudit || tx.Db.HistoryAuditor.Identity.Find(who) is not null;

    public static string HistoryHex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();

    public static byte[] HistoryUnhex(string s) =>
        s.Length % 2 == 0 ? Convert.FromHexString(s) : throw new Exception("bad row key");

    // -----------------------------------------------------------------------
    // Client reducers, procedures and views
    // -----------------------------------------------------------------------

    [SpacetimeDB.Reducer]
    public static void HistoryUndo(ReducerContext ctx, string scope) => HistoryUndoFor(HistoryTxOf(ctx), ctx.Sender, scope);

    [SpacetimeDB.Reducer]
    public static void HistoryRedo(ReducerContext ctx, string scope) => HistoryRedoFor(HistoryTxOf(ctx), ctx.Sender, scope);

    /// <summary>Search the log (your own changes, or everything if you're an auditor).</summary>
    [SpacetimeDB.Procedure(Name = "history_query")]
    public static List<HistoryEntry> HistoryQueryProc(ProcedureContext ctx, HistoryQuery q) =>
        ctx.WithTx(tx => HistorySearch(HistoryTxOf(tx), tx.Sender, q));

    /// <summary>A row as it was at `at` (auditors only).</summary>
    [SpacetimeDB.Procedure(Name = "history_row_as_of")]
    public static byte[]? HistoryRowAsOfProc(ProcedureContext ctx, string tableName, string rowKey, Timestamp at) =>
        ctx.WithTx(tx =>
        {
            var h = HistoryTxOf(tx);
            return HistoryCanAudit(h, h.Sender) ? HistoryRowAsOf(h, tableName, rowKey, at) : null;
        });

    /// <summary>A whole table as it was at `at` (auditors only).</summary>
    [SpacetimeDB.Procedure(Name = "history_table_as_of")]
    public static List<HistoryRow> HistoryTableAsOfProc(ProcedureContext ctx, string tableName, Timestamp at) =>
        ctx.WithTx(tx =>
        {
            var h = HistoryTxOf(tx);
            return HistoryCanAudit(h, h.Sender) ? HistoryTableAsOf(h, tableName, at) : new List<HistoryRow>();
        });

    /// <summary>Your own action groups (most recent 200).</summary>
    [SpacetimeDB.View(Accessor = "HistoryMyGroups", Public = true)]
    public static List<HistoryGroup> HistoryMyGroups(ViewContext ctx) =>
        ctx.Db.HistoryGroup.Actor.Filter(ctx.Sender).OrderByDescending(g => g.Id).Take(200).ToList();

    [SpacetimeDB.Reducer]
    public static void HistoryPrune(ReducerContext ctx, HistoryPruneJob _job)
    {
        // Scheduled reducers are callable by clients too; only the scheduler may prune.
        if (ctx.Sender != ctx.DatabaseIdentity) throw new Exception("history_prune is run by the scheduler");
        HistoryPruneNow(ctx);
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    static HistoryTx HistoryTxOf(ProcedureTxContext tx) => new(tx.Db, tx.Sender, tx.Timestamp, ProcedureContextBase.Identity);

    static ulong HistoryNewGroup(HistoryTx tx, byte kind, string action, string scope, ulong link)
    {
        if (kind == HISTORY_KIND_ACTION)
        {
            // A new action ends the redo chain for this person and scope.
            foreach (var g in HistoryStack(tx, tx.Sender, scope))
            {
                if (g.State == HISTORY_STATE_UNDONE) tx.Db.HistoryGroup.Id.Update(g with { State = HISTORY_STATE_DROPPED });
            }
        }
        return tx.Db.HistoryGroup.Insert(new HistoryGroup
        {
            Id = 0,
            Actor = tx.Sender,
            Scope = scope,
            Action = action,
            At = tx.Timestamp,
            Kind = kind,
            State = HISTORY_STATE_DONE,
            Link = link,
            Changes = 0,
        }).Id;
    }

    /// <summary>The newest group by this caller at this transaction's timestamp.</summary>
    static HistoryGroup HistoryCurrentGroup(HistoryTx tx)
    {
        HistoryGroup? found = null;
        foreach (var g in tx.Db.HistoryGroup.At.Filter(tx.Timestamp))
        {
            if (g.Actor == tx.Sender && (found is null || g.Id > found.Value.Id)) found = g;
        }
        if (found is { } f) return f;
        var id = HistoryNewGroup(tx, HISTORY_KIND_ACTION, "", "", 0);
        return tx.Db.HistoryGroup.Id.Find(id)!.Value;
    }

    /// <summary>who's action groups in scope, newest first.</summary>
    static List<HistoryGroup> HistoryStack(HistoryTx tx, Identity who, string scope) =>
        tx.Db.HistoryGroup.ByActorScope.Filter((who, scope))
            .Where(g => g.Kind == HISTORY_KIND_ACTION && g.Changes > 0)
            .OrderByDescending(g => g.Id)
            .ToList();

    static List<HistoryChange> HistoryGroupChanges(Local db, ulong group) =>
        db.HistoryChange.GroupId.Filter(group).OrderBy(c => c.Id).ToList();

    /// <summary>Undo: each row must still look like the group's last write to it. Redo: like its first read.</summary>
    static void HistoryCheck(HistoryTx tx, List<HistoryChange> changes, bool undoing)
    {
        var seen = new HashSet<(string, string)>();
        var conflicts = new List<string>();
        var ordered = undoing ? Enumerable.Reverse(changes) : changes;
        foreach (var c in ordered)
        {
            if (!seen.Add((c.TableName, c.RowKey))) continue;
            var table = HistoryTableNamed(c.TableName);
            if (table.Scrubbed) throw new Exception($"{c.TableName} is redacted in history, so it can't be undone");
            var expected = undoing ? c.After : c.Before;
            var current = table.Read(tx, HistoryUnhex(c.RowKey));
            var same = current is null ? expected is null : expected is not null && current.AsSpan().SequenceEqual(expected);
            if (!same) conflicts.Add($"{c.TableName}#{c.RowKey}");
        }
        if (conflicts.Count > 0) throw new Exception($"conflict: changed since by someone else: {string.Join(", ", conflicts)}");
    }
}
