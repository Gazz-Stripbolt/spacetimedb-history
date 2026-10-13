//! # history.rs: audit log, point-in-time reads and undo/redo for SpacetimeDB, one drop-in file
//!
//! A stopgap until SpacetimeDB lets modules read their own commit log ("time travel"). Until then,
//! this records every change you make through it, in the same transaction as the change.
//!
//! Copy this file to `src/history.rs`, add `pub mod history;` to `lib.rs`, and list the tables you
//! want tracked, once, at the crate root:
//!
//! ```ignore
//! pub mod history;
//!
//! history_tables! {
//!     note: Note => id: u64,
//!     account: Account => identity: Identity [scrub = scrub_account],   // redact secrets
//! }
//! ```
//!
//! Then write through the generated wrappers instead of the raw table handles:
//!
//! ```ignore
//! #[spacetimedb::reducer]
//! fn move_notes(ctx: &ReducerContext, ids: Vec<u64>, dx: f32, dy: f32) {
//!     history::begin(ctx, "move notes", "board");          // optional: name and scope the action
//!     for id in ids {
//!         if let Some(n) = ctx.db.note().id().find(id) {
//!             tracked::note::update(ctx, Note { x: n.x + dx, y: n.y + dy, ..n });
//!         }
//!     }
//! }
//! ```
//!
//! What you get:
//!
//! - **Audit log.** Every insert, update and delete through `tracked::*`: table, primary key, the
//!   row before and after (BSATN), who did it, the action name, the scope and when. Changes made in
//!   one transaction form one *group*.
//! - **Undo / redo** of whole groups, per person and per scope (`history_undo("board")`), refused
//!   with a clear conflict error if someone else changed one of the rows since.
//! - **Point-in-time reads:** a row, or a whole table, as it was at any moment you still have
//!   history for.
//! - **Retention:** an hourly job prunes history older than your limits.
//!
//! History tables are private. Clients see their own groups through the `history_my_groups` view
//! and query the log through `history_query` / `history_row_as_of` / `history_table_as_of`
//! (auditors only, unless you turn `open_audit` on). Values are BSATN: decode them on the client
//! with the table's generated row type.

use spacetimedb::sats::bsatn;
use spacetimedb::{
    Identity, ProcedureContext, ReducerContext, ScheduleAt, SpacetimeType, Table, TimeDuration,
    Timestamp, ViewContext,
};
use std::time::Duration;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct HistorySettings {
    /// Keep history this long (seconds). 0 = forever.
    pub retention_secs: u64,
    /// Per-table overrides of `retention_secs`.
    pub table_retention: Vec<HistoryTableRetention>,
    /// How many of your most recent action groups (per scope) undo can reach back through.
    pub max_undo_depth: u32,
    /// Anyone may query the whole log. Off: you see your own changes; auditors see everything.
    pub open_audit: bool,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct HistoryTableRetention {
    pub table_name: String,
    pub retention_secs: u64,
}

impl Default for HistorySettings {
    fn default() -> Self {
        Self {
            retention_secs: 30 * 24 * 3600,
            table_retention: vec![],
            max_undo_depth: 100,
            open_audit: false,
        }
    }
}

pub const OP_INSERT: u8 = 0;
pub const OP_UPDATE: u8 = 1;
pub const OP_DELETE: u8 = 2;

/// Group kinds. Only `KIND_ACTION` groups are on the undo stack.
pub const KIND_ACTION: u8 = 0;
pub const KIND_UNDO: u8 = 1;
pub const KIND_REDO: u8 = 2;

/// Group states (for `KIND_ACTION` groups).
pub const STATE_DONE: u8 = 0;
pub const STATE_UNDONE: u8 = 1;
/// Undone, then a new action came along: no longer redoable.
pub const STATE_DROPPED: u8 = 2;

// ---------------------------------------------------------------------------
// Tables (all private)
// ---------------------------------------------------------------------------

#[spacetimedb::table(accessor = history_config)]
pub struct HistoryConfig {
    #[primary_key]
    pub key: u8,
    pub settings: HistorySettings,
}

/// One per transaction (or per `begin` call): an action you can undo as a unit.
#[spacetimedb::table(
    accessor = history_group,
    index(accessor = by_actor_scope, btree(columns = [actor, scope]))
)]
#[derive(Clone)]
pub struct HistoryGroup {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub actor: Identity,
    pub scope: String,
    pub action: String,
    #[index(btree)]
    pub at: Timestamp,
    pub kind: u8,
    pub state: u8,
    /// For undo/redo groups: the group they undid or redid. For undone groups: the undo group.
    pub link: u64,
    pub changes: u32,
}

#[spacetimedb::table(
    accessor = history_change,
    index(accessor = by_row, btree(columns = [table_name, row_key]))
)]
#[derive(Clone)]
pub struct HistoryChange {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub group_id: u64,
    #[index(btree)]
    pub table_name: String,
    /// Hex of the BSATN-encoded primary key.
    pub row_key: String,
    pub op: u8,
    /// BSATN of the row before / after (None for insert / delete).
    pub before: Option<Vec<u8>>,
    pub after: Option<Vec<u8>>,
    #[index(btree)]
    pub actor: Identity,
    #[index(btree)]
    pub at: Timestamp,
}

/// Identities allowed to read the whole log (besides the module itself).
#[spacetimedb::table(accessor = history_auditor)]
pub struct HistoryAuditor {
    #[primary_key]
    pub identity: Identity,
}

/// The hourly retention job.
#[spacetimedb::table(accessor = history_prune_job, scheduled(history_prune))]
pub struct HistoryPruneJob {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

// ---------------------------------------------------------------------------
// Client-facing types
// ---------------------------------------------------------------------------

/// A change with its group's context, as returned by queries.
#[derive(SpacetimeType, Clone, Debug)]
pub struct HistoryEntry {
    pub change_id: u64,
    pub group_id: u64,
    pub table_name: String,
    pub row_key: String,
    pub op: u8,
    pub before: Option<Vec<u8>>,
    pub after: Option<Vec<u8>>,
    pub actor: Identity,
    pub at: Timestamp,
    pub action: String,
    pub scope: String,
    pub kind: u8,
}

#[derive(SpacetimeType, Clone, Debug, Default)]
pub struct HistoryQuery {
    pub table_name: Option<String>,
    pub row_key: Option<String>,
    pub actor: Option<Identity>,
    pub scope: Option<String>,
    pub group_id: Option<u64>,
    pub from: Option<Timestamp>,
    pub to: Option<Timestamp>,
    /// Only changes with id < this (paging backwards). None = newest.
    pub before_id: Option<u64>,
    /// Max entries (capped at 500). 0 = 100.
    pub limit: u32,
}

#[derive(SpacetimeType, Clone, Debug)]
pub struct HistoryRow {
    pub row_key: String,
    pub value: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Library API
// ---------------------------------------------------------------------------

/// Store settings (call from `init`, or any time). Also schedules the hourly prune job.
pub fn configure(ctx: &ReducerContext, settings: HistorySettings) {
    let row = HistoryConfig { key: 0, settings };
    if ctx.db.history_config().key().find(0).is_some() {
        ctx.db.history_config().key().update(row);
    } else {
        ctx.db.history_config().insert(row);
    }
    if ctx.db.history_prune_job().count() == 0 {
        ctx.db.history_prune_job().insert(HistoryPruneJob {
            scheduled_id: 0,
            scheduled_at: ScheduleAt::Interval(TimeDuration::from_duration(Duration::from_secs(
                3600,
            ))),
        });
    }
}

pub fn settings(ctx: &ReducerContext) -> HistorySettings {
    ctx.db
        .history_config()
        .key()
        .find(0)
        .map(|c| c.settings)
        .unwrap_or_default()
}

/// Let an identity read the whole log.
pub fn add_auditor(ctx: &ReducerContext, who: Identity) {
    if ctx.db.history_auditor().identity().find(who).is_none() {
        ctx.db
            .history_auditor()
            .insert(HistoryAuditor { identity: who });
    }
}

pub fn remove_auditor(ctx: &ReducerContext, who: Identity) {
    ctx.db.history_auditor().identity().delete(who);
}

/// Start a named action group for the rest of this transaction. Changes recorded without a
/// `begin` go into an unnamed group with scope "".
pub fn begin(ctx: &ReducerContext, action: &str, scope: &str) -> u64 {
    new_group(ctx, KIND_ACTION, action, scope, 0)
}

/// Record one change. The `tracked::*` wrappers call this for you; call it directly only for
/// writes you make some other way. Values are BSATN; `key` is the BSATN of the primary key.
pub fn record(
    ctx: &ReducerContext,
    table: &str,
    key: &[u8],
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
) {
    let op = match (&before, &after) {
        (None, Some(_)) => OP_INSERT,
        (Some(_), Some(_)) => OP_UPDATE,
        (Some(_), None) => OP_DELETE,
        (None, None) => return,
    };
    if op == OP_UPDATE && before == after {
        return; // no-op update
    }
    let group = current_group(ctx);
    ctx.db.history_change().insert(HistoryChange {
        id: 0,
        group_id: group.id,
        table_name: table.to_string(),
        row_key: hex(key),
        op,
        before,
        after,
        actor: ctx.sender(),
        at: ctx.timestamp,
    });
    ctx.db.history_group().id().update(HistoryGroup {
        changes: group.changes + 1,
        ..group
    });
}

/// Undo `who`'s most recent action in `scope`. Errors (and changes nothing) if any affected row
/// was changed by someone else since.
pub fn undo(ctx: &ReducerContext, who: Identity, scope: &str) -> Result<u64, String> {
    let depth = settings(ctx).max_undo_depth as usize;
    let target = stack(ctx, who, scope)
        .into_iter()
        .filter(|g| g.state != STATE_DROPPED)
        .take(depth.max(1))
        .find(|g| g.state == STATE_DONE)
        .ok_or("nothing to undo")?;
    let changes = group_changes(ctx, target.id);
    // The row must still be what this group left behind.
    check(ctx, &changes, true)?;
    let g = new_group(ctx, KIND_UNDO, &target.action, scope, target.id);
    for c in changes.iter().rev() {
        apply(ctx, c, c.before.as_deref())?;
    }
    let target_id = target.id;
    ctx.db.history_group().id().update(HistoryGroup {
        state: STATE_UNDONE,
        link: g,
        ..target
    });
    Ok(target_id)
}

/// Redo the action `who` most recently undid in `scope`.
pub fn redo(ctx: &ReducerContext, who: Identity, scope: &str) -> Result<u64, String> {
    let target = stack(ctx, who, scope)
        .into_iter()
        .filter(|g| g.state == STATE_UNDONE)
        .max_by_key(|g| g.link)
        .ok_or("nothing to redo")?;
    let changes = group_changes(ctx, target.id);
    check(ctx, &changes, false)?;
    let g = new_group(ctx, KIND_REDO, &target.action, scope, target.id);
    for c in &changes {
        apply(ctx, c, c.after.as_deref())?;
    }
    let target_id = target.id;
    ctx.db.history_group().id().update(HistoryGroup {
        state: STATE_DONE,
        link: g,
        ..target
    });
    Ok(target_id)
}

/// The log, newest first. `who` sees only their own changes unless they're an auditor (or
/// `open_audit` is on).
pub fn query(ctx: &ReducerContext, who: Identity, q: &HistoryQuery) -> Vec<HistoryEntry> {
    let mut q = q.clone();
    if !can_audit(ctx, who) {
        q.actor = Some(who);
    }
    let limit = match q.limit {
        0 => 100,
        n => n.min(500),
    } as usize;
    // Bound first: since 2.12 a table handle's `iter()` borrows the handle.
    let changes = ctx.db.history_change();
    let candidates: Box<dyn Iterator<Item = HistoryChange>> = if let Some(g) = q.group_id {
        Box::new(changes.group_id().filter(g))
    } else if let (Some(t), Some(k)) = (&q.table_name, &q.row_key) {
        Box::new(changes.by_row().filter((t, k)))
    } else if let Some(a) = q.actor {
        Box::new(changes.actor().filter(a))
    } else if let Some(t) = &q.table_name {
        Box::new(changes.table_name().filter(t))
    } else {
        Box::new(changes.iter())
    };
    let mut out: Vec<HistoryChange> = candidates
        .filter(|c| q.table_name.as_ref().is_none_or(|t| &c.table_name == t))
        .filter(|c| q.row_key.as_ref().is_none_or(|k| &c.row_key == k))
        .filter(|c| q.actor.is_none_or(|a| c.actor == a))
        .filter(|c| q.from.is_none_or(|f| c.at >= f))
        .filter(|c| q.to.is_none_or(|t| c.at <= t))
        .filter(|c| q.before_id.is_none_or(|b| c.id < b))
        .collect();
    out.sort_unstable_by_key(|x| std::cmp::Reverse(x.id));
    let mut entries = Vec::new();
    for c in out {
        let Some(g) = ctx.db.history_group().id().find(c.group_id) else {
            continue;
        };
        if q.scope.as_ref().is_some_and(|s| &g.scope != s) {
            continue;
        }
        entries.push(entry(c, &g));
        if entries.len() >= limit {
            break;
        }
    }
    entries
}

/// A row as it was at `at` (BSATN), or None if it didn't exist then. Rows with no history are
/// assumed unchanged (returns the current value).
pub fn row_as_of(
    ctx: &ReducerContext,
    table: &str,
    row_key: &str,
    at: Timestamp,
) -> Result<Option<Vec<u8>>, String> {
    let mut changes: Vec<HistoryChange> = ctx
        .db
        .history_change()
        .by_row()
        .filter((table, row_key))
        .collect();
    changes.sort_unstable_by_key(|c| c.id);
    if let Some(last) = changes.iter().rev().find(|c| c.at <= at) {
        return Ok(last.after.clone());
    }
    match changes.first() {
        // The first change we know of is after `at`: the row was whatever that change started from.
        Some(first) => Ok(first.before.clone()),
        None => crate::__history_read(ctx, table, &unhex(row_key)?),
    }
}

/// A whole table as it was at `at`: the current rows with every later change rolled back.
pub fn table_as_of(
    ctx: &ReducerContext,
    table: &str,
    at: Timestamp,
) -> Result<Vec<HistoryRow>, String> {
    let mut rows: std::collections::BTreeMap<String, Vec<u8>> = crate::__history_scan(ctx, table)?
        .into_iter()
        .map(|(k, v)| (hex(&k), v))
        .collect();
    let mut later: Vec<HistoryChange> = ctx
        .db
        .history_change()
        .table_name()
        .filter(table)
        .filter(|c| c.at > at)
        .collect();
    later.sort_unstable_by_key(|x| std::cmp::Reverse(x.id));
    for c in later {
        match c.before {
            Some(v) => rows.insert(c.row_key, v),
            None => rows.remove(&c.row_key),
        };
    }
    Ok(rows
        .into_iter()
        .map(|(row_key, value)| HistoryRow { row_key, value })
        .collect())
}

/// Delete history older than the retention settings. The hourly job calls this.
pub fn prune(ctx: &ReducerContext) -> u32 {
    let s = settings(ctx);
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    let limit_for = |table: &str| {
        s.table_retention
            .iter()
            .find(|r| r.table_name == table)
            .map_or(s.retention_secs, |r| r.retention_secs)
    };
    let mut removed = 0;
    let mut touched = std::collections::BTreeSet::new();
    for c in ctx.db.history_change().iter().collect::<Vec<_>>() {
        let keep = limit_for(&c.table_name);
        if keep > 0 && now - c.at.to_micros_since_unix_epoch() > keep as i64 * 1_000_000 {
            touched.insert(c.group_id);
            ctx.db.history_change().id().delete(c.id);
            removed += 1;
        }
    }
    for g in touched {
        if ctx
            .db
            .history_change()
            .group_id()
            .filter(g)
            .next()
            .is_none()
        {
            ctx.db.history_group().id().delete(g);
        }
    }
    removed
}

/// Is this identity allowed to read everyone's history?
pub fn can_audit(ctx: &ReducerContext, who: Identity) -> bool {
    who == ctx.database_identity()
        || settings(ctx).open_audit
        || ctx.db.history_auditor().identity().find(who).is_some()
}

/// BSATN-encode a value (keys and rows). Exposed for host code that records changes by hand.
pub fn encode<T: spacetimedb::Serialize>(v: &T) -> Vec<u8> {
    bsatn::to_vec(v).expect("BSATN encoding failed")
}

pub fn decode<T: spacetimedb::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    bsatn::from_slice(bytes).map_err(|e| format!("BSATN decode failed: {e}"))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err("bad row key".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| "bad row key".to_string()))
        .collect()
}

// ---------------------------------------------------------------------------
// Client reducers, procedures and views
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn history_undo(ctx: &ReducerContext, scope: String) -> Result<(), String> {
    undo(ctx, ctx.sender(), &scope).map(|_| ())
}

#[spacetimedb::reducer]
pub fn history_redo(ctx: &ReducerContext, scope: String) -> Result<(), String> {
    redo(ctx, ctx.sender(), &scope).map(|_| ())
}

/// Search the log (your own changes, or everything if you're an auditor).
#[spacetimedb::procedure]
pub fn history_query(ctx: &mut ProcedureContext, q: HistoryQuery) -> Vec<HistoryEntry> {
    ctx.with_tx(|tx| query(tx, tx.sender(), &q))
}

/// A row as it was at `at` (auditors only). None if it didn't exist or you may not see it.
#[spacetimedb::procedure]
pub fn history_row_as_of(
    ctx: &mut ProcedureContext,
    table_name: String,
    row_key: String,
    at: Timestamp,
) -> Option<Vec<u8>> {
    ctx.with_tx(|tx| {
        if !can_audit(tx, tx.sender()) {
            return None;
        }
        row_as_of(tx, &table_name, &row_key, at).ok().flatten()
    })
}

/// A whole table as it was at `at` (auditors only).
#[spacetimedb::procedure]
pub fn history_table_as_of(
    ctx: &mut ProcedureContext,
    table_name: String,
    at: Timestamp,
) -> Vec<HistoryRow> {
    ctx.with_tx(|tx| {
        if !can_audit(tx, tx.sender()) {
            return vec![];
        }
        table_as_of(tx, &table_name, at).unwrap_or_default()
    })
}

/// Your own action groups (most recent 200): drives undo/redo buttons and "what did I do".
#[spacetimedb::view(accessor = history_my_groups, public)]
pub fn history_my_groups(ctx: &ViewContext) -> Vec<HistoryGroup> {
    let mut groups: Vec<HistoryGroup> = ctx
        .db
        .history_group()
        .actor()
        .filter(ctx.sender())
        .collect();
    groups.sort_unstable_by_key(|x| std::cmp::Reverse(x.id));
    groups.truncate(200);
    groups
}

#[spacetimedb::reducer]
pub fn history_prune(ctx: &ReducerContext, _job: HistoryPruneJob) -> Result<(), String> {
    // Scheduled reducers are callable by clients too; only the scheduler may prune.
    if ctx.sender() != ctx.database_identity() {
        return Err("history_prune is run by the scheduler".into());
    }
    prune(ctx);
    Ok(())
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn new_group(ctx: &ReducerContext, kind: u8, action: &str, scope: &str, link: u64) -> u64 {
    if kind == KIND_ACTION {
        // A new action ends the redo chain for this person and scope.
        for g in stack(ctx, ctx.sender(), scope) {
            if g.state == STATE_UNDONE {
                ctx.db.history_group().id().update(HistoryGroup {
                    state: STATE_DROPPED,
                    ..g
                });
            }
        }
    }
    ctx.db
        .history_group()
        .insert(HistoryGroup {
            id: 0,
            actor: ctx.sender(),
            scope: scope.to_string(),
            action: action.to_string(),
            at: ctx.timestamp,
            kind,
            state: STATE_DONE,
            link,
            changes: 0,
        })
        .id
}

/// The group this transaction is writing into: the newest group by this caller at this timestamp.
fn current_group(ctx: &ReducerContext) -> HistoryGroup {
    let found = ctx
        .db
        .history_group()
        .at()
        .filter(ctx.timestamp)
        .filter(|g| g.actor == ctx.sender())
        .max_by_key(|g| g.id);
    match found {
        Some(g) => g,
        None => {
            let id = new_group(ctx, KIND_ACTION, "", "", 0);
            ctx.db.history_group().id().find(id).expect("just inserted")
        }
    }
}

/// `who`'s action groups in `scope`, newest first.
fn stack(ctx: &ReducerContext, who: Identity, scope: &str) -> Vec<HistoryGroup> {
    let mut groups: Vec<HistoryGroup> = ctx
        .db
        .history_group()
        .by_actor_scope()
        .filter((who, scope))
        .filter(|g| g.kind == KIND_ACTION && g.changes > 0)
        .collect();
    groups.sort_unstable_by_key(|x| std::cmp::Reverse(x.id));
    groups
}

fn group_changes(ctx: &ReducerContext, group: u64) -> Vec<HistoryChange> {
    let mut changes: Vec<HistoryChange> =
        ctx.db.history_change().group_id().filter(group).collect();
    changes.sort_unstable_by_key(|c| c.id);
    changes
}

/// Undo: each row must still look like the group's last write to it. Redo: like its first read.
fn check(ctx: &ReducerContext, changes: &[HistoryChange], undoing: bool) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    let ordered: Box<dyn Iterator<Item = &HistoryChange>> = if undoing {
        Box::new(changes.iter().rev())
    } else {
        Box::new(changes.iter())
    };
    let mut conflicts = Vec::new();
    for c in ordered {
        if !seen.insert((c.table_name.clone(), c.row_key.clone())) {
            continue;
        }
        if crate::__history_scrubbed(&c.table_name) {
            return Err(format!(
                "{} is redacted in history, so it can't be undone",
                c.table_name
            ));
        }
        let expected = if undoing { &c.after } else { &c.before };
        let current = crate::__history_read(ctx, &c.table_name, &unhex(&c.row_key)?)?;
        if &current != expected {
            conflicts.push(format!("{}#{}", c.table_name, c.row_key));
        }
    }
    if conflicts.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "conflict: changed since by someone else: {}",
            conflicts.join(", ")
        ))
    }
}

fn apply(ctx: &ReducerContext, c: &HistoryChange, value: Option<&[u8]>) -> Result<(), String> {
    crate::__history_write(ctx, &c.table_name, &unhex(&c.row_key)?, value)
}

fn entry(c: HistoryChange, g: &HistoryGroup) -> HistoryEntry {
    HistoryEntry {
        change_id: c.id,
        group_id: c.group_id,
        table_name: c.table_name,
        row_key: c.row_key,
        op: c.op,
        before: c.before,
        after: c.after,
        actor: c.actor,
        at: c.at,
        action: g.action.clone(),
        scope: g.scope.clone(),
        kind: g.kind,
    }
}

/// Declare the tracked tables, once, at your crate root. For each `table: Row => pk: Key` this
/// generates `tracked::table::{insert, update, upsert, delete}` (use them instead of the raw table
/// handle) and the glue undo and point-in-time reads need.
///
/// Add `[scrub = some_fn]` after the key type to redact a table's rows before they're recorded
/// (`fn(&Row) -> Row`). Undo is disabled for scrubbed tables.
#[macro_export]
macro_rules! history_tables {
    (@scrubbed) => { false };
    (@scrubbed $scrub:path) => { true };
    ($($table:ident : $row:ty => $pk:ident : $key:ty $([scrub = $scrub:path])?),* $(,)?) => {
        /// History-recording wrappers for each tracked table.
        pub mod tracked {
            $(
                #[allow(non_snake_case, dead_code)]
                pub mod $table {
                    #[allow(unused_imports)]
                    use super::super::*;
                    use spacetimedb::{ReducerContext, Table};

                    pub const NAME: &str = stringify!($table);

                    pub(crate) fn snapshot(row: &$row) -> Vec<u8> {
                        $( let row = &$scrub(row); )?
                        $crate::history::encode(row)
                    }

                    fn key_of(key: &$key) -> Vec<u8> {
                        $crate::history::encode(key)
                    }

                    /// Insert and record. Returns the inserted row (with auto-inc values filled in).
                    pub fn insert(ctx: &ReducerContext, row: $row) -> $row {
                        let row = ctx.db.$table().insert(row);
                        $crate::history::record(ctx, NAME, &key_of(&row.$pk), None, Some(snapshot(&row)));
                        row
                    }

                    /// Update by primary key and record. Panics if the row doesn't exist.
                    pub fn update(ctx: &ReducerContext, row: $row) -> $row {
                        let before = ctx.db.$table().$pk().find(&row.$pk).map(|r| snapshot(&r));
                        let row = ctx.db.$table().$pk().update(row);
                        $crate::history::record(ctx, NAME, &key_of(&row.$pk), before, Some(snapshot(&row)));
                        row
                    }

                    /// Insert or update by primary key, and record.
                    pub fn upsert(ctx: &ReducerContext, row: $row) -> $row {
                        if ctx.db.$table().$pk().find(&row.$pk).is_some() { update(ctx, row) } else { insert(ctx, row) }
                    }

                    /// Delete by primary key and record. Returns whether a row was deleted.
                    pub fn delete(ctx: &ReducerContext, key: &$key) -> bool {
                        let Some(old) = ctx.db.$table().$pk().find(key) else { return false };
                        ctx.db.$table().$pk().delete(key);
                        $crate::history::record(ctx, NAME, &key_of(key), Some(snapshot(&old)), None);
                        true
                    }

                    pub(crate) fn read(ctx: &ReducerContext, key: &[u8]) -> Result<Option<Vec<u8>>, String> {
                        let key: $key = $crate::history::decode(key)?;
                        Ok(ctx.db.$table().$pk().find(&key).map(|r| snapshot(&r)))
                    }

                    pub(crate) fn write(ctx: &ReducerContext, key: &[u8], value: Option<&[u8]>) -> Result<(), String> {
                        let key: $key = $crate::history::decode(key)?;
                        let existing = ctx.db.$table().$pk().find(&key);
                        match value {
                            None => { if existing.is_some() { delete(ctx, &key); } }
                            Some(bytes) => {
                                let row: $row = $crate::history::decode(bytes)?;
                                if existing.is_some() { update(ctx, row); } else { insert(ctx, row); }
                            }
                        }
                        Ok(())
                    }

                    pub(crate) fn scan(ctx: &ReducerContext) -> Vec<(Vec<u8>, Vec<u8>)> {
                        ctx.db.$table().iter().map(|r| (key_of(&r.$pk), snapshot(&r))).collect()
                    }

                    pub(crate) const SCRUBBED: bool = $crate::history_tables!(@scrubbed $($scrub)?);
                }
            )*
        }

        #[doc(hidden)]
        pub fn __history_read(ctx: &spacetimedb::ReducerContext, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, String> {
            match table {
                $( stringify!($table) => tracked::$table::read(ctx, key), )*
                _ => Err(format!("{table} isn't a tracked table")),
            }
        }

        #[doc(hidden)]
        pub fn __history_write(ctx: &spacetimedb::ReducerContext, table: &str, key: &[u8], value: Option<&[u8]>) -> Result<(), String> {
            match table {
                $( stringify!($table) => tracked::$table::write(ctx, key, value), )*
                _ => Err(format!("{table} isn't a tracked table")),
            }
        }

        #[doc(hidden)]
        pub fn __history_scan(ctx: &spacetimedb::ReducerContext, table: &str) -> Result<Vec<(Vec<u8>, Vec<u8>)>, String> {
            match table {
                $( stringify!($table) => Ok(tracked::$table::scan(ctx)), )*
                _ => Err(format!("{table} isn't a tracked table")),
            }
        }

        #[doc(hidden)]
        pub fn __history_scrubbed(table: &str) -> bool {
            match table {
                $( stringify!($table) => tracked::$table::SCRUBBED, )*
                _ => false,
            }
        }
    };
}
