//! Demo: a shared sticky-note board with an audit log, per-person undo/redo and a time slider.
//! Serves the web client at `/route/`.

#[path = "../../../rust/history.rs"]
pub mod history;

use http::{StatusCode, header};
use spacetimedb::http::{Body, HandlerContext, Request, Response, Router, handler, router};
use spacetimedb::{Identity, ReducerContext};

const PAGE: &str = include_str!("../../web/dist/index.html");
const BOARD: &str = "board";

#[spacetimedb::table(accessor = demo_note, public)]
#[derive(Clone)]
pub struct DemoNote {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub color: String,
}

/// A table with a secret in it, to show redaction: history never stores `api_key`.
#[spacetimedb::table(accessor = demo_account, public)]
#[derive(Clone)]
pub struct DemoAccount {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub api_key: String,
}

fn scrub_account(a: &DemoAccount) -> DemoAccount {
    DemoAccount {
        api_key: "[redacted]".into(),
        ..a.clone()
    }
}

history_tables! {
    demo_note: DemoNote => id: u64,
    demo_account: DemoAccount => identity: Identity [scrub = scrub_account],
}

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    // The demo lets anyone read the whole log and use the time slider.
    history::configure(
        ctx,
        history::HistorySettings {
            open_audit: true,
            ..Default::default()
        },
    );
}

#[spacetimedb::reducer]
pub fn demo_add_note(
    ctx: &ReducerContext,
    text: String,
    x: f32,
    y: f32,
    color: String,
) -> Result<(), String> {
    check_text(&text)?;
    history::begin(ctx, "add note", BOARD);
    tracked::demo_note::insert(
        ctx,
        DemoNote {
            id: 0,
            text,
            x: clamp(x),
            y: clamp(y),
            color,
        },
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn demo_edit_note(ctx: &ReducerContext, id: u64, text: String) -> Result<(), String> {
    check_text(&text)?;
    let n = ctx.db.demo_note().id().find(id).ok_or("no such note")?;
    history::begin(ctx, "edit note", BOARD);
    tracked::demo_note::update(ctx, DemoNote { text, ..n });
    Ok(())
}

/// Move several notes at once: one action, one undo step.
#[spacetimedb::reducer]
pub fn demo_move_notes(
    ctx: &ReducerContext,
    ids: Vec<u64>,
    dx: f32,
    dy: f32,
) -> Result<(), String> {
    history::begin(ctx, "move notes", BOARD);
    for id in ids {
        let n = ctx.db.demo_note().id().find(id).ok_or("no such note")?;
        tracked::demo_note::update(
            ctx,
            DemoNote {
                x: clamp(n.x + dx),
                y: clamp(n.y + dy),
                ..n
            },
        );
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn demo_recolor_notes(
    ctx: &ReducerContext,
    ids: Vec<u64>,
    color: String,
) -> Result<(), String> {
    history::begin(ctx, "recolor notes", BOARD);
    for id in ids {
        let n = ctx.db.demo_note().id().find(id).ok_or("no such note")?;
        tracked::demo_note::update(
            ctx,
            DemoNote {
                color: color.clone(),
                ..n
            },
        );
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn demo_delete_notes(ctx: &ReducerContext, ids: Vec<u64>) {
    history::begin(ctx, "delete notes", BOARD);
    for id in ids {
        tracked::demo_note::delete(ctx, &id);
    }
}

#[spacetimedb::reducer]
pub fn demo_set_account(ctx: &ReducerContext, name: String, api_key: String) {
    history::begin(ctx, "set account", "account");
    tracked::demo_account::upsert(
        ctx,
        DemoAccount {
            identity: ctx.sender(),
            name,
            api_key,
        },
    );
}

/// Test helper: shrink retention and prune right away.
#[spacetimedb::reducer]
pub fn demo_prune(ctx: &ReducerContext, retention_secs: u64) {
    let s = history::settings(ctx);
    history::configure(
        ctx,
        history::HistorySettings {
            retention_secs,
            ..s.clone()
        },
    );
    history::prune(ctx);
    history::configure(ctx, s);
}

/// Benchmark helper: `count` updates to one note in one transaction, tracked or not.
#[spacetimedb::reducer]
pub fn demo_bench(ctx: &ReducerContext, id: u64, count: u32, tracked: bool) -> Result<(), String> {
    history::begin(ctx, "bench", "bench");
    for i in 0..count {
        let n = ctx.db.demo_note().id().find(id).ok_or("no such note")?;
        let n = DemoNote {
            x: (i % 100) as f32,
            ..n
        };
        if tracked {
            tracked::demo_note::update(ctx, n);
        } else {
            ctx.db.demo_note().id().update(n);
        }
    }
    Ok(())
}

/// Test helper: open or close the audit log.
#[spacetimedb::reducer]
pub fn demo_set_open_audit(ctx: &ReducerContext, open: bool) {
    let s = history::settings(ctx);
    history::configure(
        ctx,
        history::HistorySettings {
            open_audit: open,
            ..s
        },
    );
}

fn check_text(text: &str) -> Result<(), String> {
    if text.chars().count() > 200 {
        Err("note too long".into())
    } else {
        Ok(())
    }
}

fn clamp(v: f32) -> f32 {
    if v.is_finite() {
        v.clamp(0.0, 100.0)
    } else {
        50.0
    }
}

#[handler]
fn page(_ctx: &mut HandlerContext, _req: Request) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_bytes(PAGE))
        .unwrap()
}

#[router]
fn routes() -> Router {
    Router::new().get("/", page)
}
