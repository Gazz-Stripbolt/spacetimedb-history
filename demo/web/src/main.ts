// Demo web client: a shared sticky-note board with undo/redo, an activity log and a time slider.
// Served by the demo modules at /route/, or open dist/index.html with ?host=ws://...&db=...
import { Timestamp, type Identity } from 'spacetimedb';
import { connect, decodeRow, query, type Entry, type Note } from './api';

const params = new URLSearchParams(location.search);
const routed = location.pathname.match(/\/v1\/database\/([^/]+)\/route/);
const HOST = params.get('host') ?? (routed ? location.origin.replace(/^http/, 'ws') : 'ws://127.0.0.1:3000');
const DB = params.get('db') ?? (routed ? decodeURIComponent(routed[1]) : 'hist-rust');
const TOKEN_KEY = `history-demo:${HOST}:${DB}`;
const COLORS = ['yellow', 'pink', 'green', 'blue', 'red'];
const SCOPE = 'board';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

function storedToken(): string | undefined {
  if (params.has('fresh')) return undefined;
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function toast(text: string) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

async function call(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    toast(String((e as Error)?.message ?? e));
  }
}

let session: Awaited<ReturnType<typeof connect>>;
try {
  session = await connect(HOST, DB, storedToken(), () => {
    $('status').textContent = 'disconnected';
    $('status').classList.add('bad');
  });
} catch (e) {
  $('status').textContent = `can't connect: ${e}`;
  $('status').classList.add('bad');
  throw e;
}
const { conn, identity: me } = session;
try {
  localStorage.setItem(TOKEN_KEY, session.token);
} catch {}
$('status').textContent = `connected to ${DB}`;
$('me').textContent = `you are guest-${me.toHexString().slice(-4)}`;
if (params.has('test')) Object.assign(window, { __conn: conn });

function short(id: Identity) {
  return id.isEqual(me) ? 'you' : `guest-${id.toHexString().slice(-4)}`;
}

// -- state ----------------------------------------------------------------------

const selected = new Set<bigint>();
let past: { at: Timestamp; notes: Note[] } | null = null;
let log: Entry[] = [];
let firstAt = Date.now();

const liveNotes = () => [...conn.db.demoNote.iter()].sort((a, b) => Number(a.id - b.id)) as Note[];

// -- board ----------------------------------------------------------------------

const board = $('board');
function renderBoard() {
  board.classList.toggle('past', !!past);
  const notes = past ? past.notes : liveNotes();
  const keep = new Set<string>();
  for (const n of notes) {
    const key = String(n.id);
    keep.add(key);
    let div = board.querySelector<HTMLElement>(`[data-id="${key}"]`);
    if (!div) {
      div = el('div', 'note');
      div.dataset.id = key;
      board.append(div);
    }
    div.style.left = `${Math.min(n.x, 84)}%`;
    div.style.top = `${Math.min(n.y, 85)}%`;
    div.style.background = `var(--n-${COLORS.includes(n.color) ? n.color : 'yellow'})`;
    div.textContent = n.text || '…';
    div.classList.toggle('sel', !past && selected.has(n.id));
  }
  for (const div of [...board.querySelectorAll<HTMLElement>('.note')]) if (!keep.has(div.dataset.id!)) div.remove();
  for (const id of [...selected]) if (!conn.db.demoNote.id.find(id)) selected.delete(id);
  ($('delete') as HTMLButtonElement).disabled = !!past || selected.size === 0;
}

function flash(id: bigint) {
  const div = board.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (!div) return;
  div.classList.remove('flash');
  void div.offsetWidth;
  div.classList.add('flash');
}

// Drag to move (all selected notes move together, as one undoable action).
let drag: { ids: bigint[]; x0: number; y0: number; moved: boolean } | null = null;
board.addEventListener('pointerdown', (e) => {
  if (past) return;
  const div = (e.target as HTMLElement).closest<HTMLElement>('.note');
  if (!div) {
    selected.clear();
    renderBoard();
    return;
  }
  const id = BigInt(div.dataset.id!);
  if (e.shiftKey) selected.has(id) ? selected.delete(id) : selected.add(id);
  else if (!selected.has(id)) {
    selected.clear();
    selected.add(id);
  }
  drag = { ids: [...selected], x0: e.clientX, y0: e.clientY, moved: false };
  board.setPointerCapture(e.pointerId);
  renderBoard();
});
board.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const r = board.getBoundingClientRect();
  const dx = ((e.clientX - drag.x0) / r.width) * 100;
  const dy = ((e.clientY - drag.y0) / r.height) * 100;
  if (Math.abs(dx) + Math.abs(dy) > 0.5) drag.moved = true;
  for (const id of drag.ids) {
    const n = conn.db.demoNote.id.find(id);
    const div = board.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (n && div) {
      div.style.left = `${Math.min(Math.max(0, n.x + dx), 84)}%`;
      div.style.top = `${Math.min(Math.max(0, n.y + dy), 85)}%`;
    }
  }
});
board.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const r = board.getBoundingClientRect();
  const dx = ((e.clientX - drag.x0) / r.width) * 100;
  const dy = ((e.clientY - drag.y0) / r.height) * 100;
  if (drag.moved) call(conn.reducers.demoMoveNotes({ ids: drag.ids, dx, dy }));
  drag = null;
});
board.addEventListener('dblclick', (e) => {
  if (past) return;
  const div = (e.target as HTMLElement).closest<HTMLElement>('.note');
  if (!div) return;
  const n = conn.db.demoNote.id.find(BigInt(div.dataset.id!));
  const text = n && prompt('Note text', n.text);
  if (n && text !== null && text !== undefined) call(conn.reducers.demoEditNote({ id: n.id, text }));
});

// -- toolbar ----------------------------------------------------------------------

for (const c of COLORS) {
  const b = el('button', 'swatch') as HTMLButtonElement;
  b.style.background = `var(--n-${c})`;
  b.title = c;
  b.onclick = () => {
    if (selected.size) call(conn.reducers.demoRecolorNotes({ ids: [...selected], color: c }));
    else nextColor = c;
  };
  $('swatches').append(b);
}
let nextColor = 'yellow';
let addCount = 0;
$('add').onclick = () => {
  const i = addCount++;
  call(conn.reducers.demoAddNote({ text: `Note ${liveNotes().length + 1}`, x: 8 + ((i * 17) % 70), y: 10 + ((i * 23) % 65), color: nextColor }));
};
$('delete').onclick = () => {
  call(conn.reducers.demoDeleteNotes({ ids: [...selected] }));
  selected.clear();
};
$('undo').onclick = () => call(conn.reducers.historyUndo({ scope: SCOPE }));
$('redo').onclick = () => call(conn.reducers.historyRedo({ scope: SCOPE }));
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    (e.shiftKey ? $('redo') : $('undo')).click();
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size && !past) $('delete').click();
});

function renderUndo() {
  const groups = [...conn.db.historyMyGroups.iter()].filter((g) => g.scope === SCOPE && g.kind === 0 && g.changes > 0);
  const nextUndo = groups.filter((g) => g.state === 0).sort((a, b) => Number(b.id - a.id))[0];
  const nextRedo = groups.filter((g) => g.state === 1).sort((a, b) => Number(b.link - a.link))[0];
  ($('undo') as HTMLButtonElement).disabled = !!past || !nextUndo;
  ($('redo') as HTMLButtonElement).disabled = !!past || !nextRedo;
  $('undo').textContent = nextUndo ? `Undo ${nextUndo.action}` : 'Undo';
  $('redo').textContent = nextRedo ? `Redo ${nextRedo.action}` : 'Redo';
}

// -- activity log ------------------------------------------------------------------

function describe(e: Entry): string {
  const before = decodeRow<Note>(e.tableName, e.before);
  const after = decodeRow<Note>(e.tableName, e.after);
  if (e.tableName !== 'demo_note') return e.tableName;
  if (!before && after) return `added “${after.text}”`;
  if (before && !after) return `deleted “${before.text}”`;
  const bits: string[] = [];
  if (before!.text !== after!.text) bits.push(`“${before!.text}” → “${after!.text}”`);
  if (before!.x !== after!.x || before!.y !== after!.y) bits.push(`moved “${after!.text}”`);
  if (before!.color !== after!.color) bits.push(`${before!.color} → ${after!.color}`);
  return bits.join(', ') || 'no visible change';
}

function renderLog() {
  const box = $('log');
  box.replaceChildren();
  for (const e of log) {
    const row = el('div', 'entry');
    const top = el('div', 'top');
    top.append(el('span', 'who', short(e.actor)), el('span', '', e.action || '(unnamed)'));
    if (e.kind === 1) top.append(el('span', 'tag undo', 'undo'));
    if (e.kind === 2) top.append(el('span', 'tag redo', 'redo'));
    top.append(el('span', 'when', e.at.toDate().toLocaleTimeString()));
    row.append(top, el('div', 'what', describe(e)));
    row.onclick = () => {
      const n = decodeRow<Note>(e.tableName, e.after ?? e.before);
      if (n) flash(n.id);
    };
    box.append(row);
  }
}

let refreshQueued = false;
async function refresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  await new Promise((r) => setTimeout(r, 120));
  refreshQueued = false;
  log = await conn.procedures.historyQuery({ q: query({ scope: SCOPE, limit: 40 }) });
  const oldest = log.at(-1);
  if (oldest) firstAt = Math.min(firstAt, oldest.at.toDate().getTime());
  renderLog();
}

// -- time slider ------------------------------------------------------------------

const slider = $<HTMLInputElement>('time');
slider.oninput = async () => {
  const v = Number(slider.value);
  if (v >= 1000) return goLive();
  const ms = firstAt + ((Date.now() - firstAt) * v) / 1000;
  const at = Timestamp.fromDate(new Date(ms));
  const rows = await conn.procedures.historyTableAsOf({ tableName: 'demo_note', at });
  past = { at, notes: rows.map((r) => decodeRow<Note>('demo_note', r.value)!) };
  $('when').textContent = new Date(ms).toLocaleTimeString();
  $('live').hidden = false;
  renderBoard();
  renderUndo();
};
function goLive() {
  past = null;
  slider.value = '1000';
  $('when').textContent = 'Live';
  $('live').hidden = true;
  renderBoard();
  renderUndo();
}
$('live').onclick = goLive;

// -- subscriptions ---------------------------------------------------------------

const onChange = () => {
  if (!past) renderBoard();
  void refresh();
};
conn.db.demoNote.onInsert(onChange);
conn.db.demoNote.onUpdate(onChange);
conn.db.demoNote.onDelete(onChange);
conn.db.historyMyGroups.onInsert(renderUndo);
conn.db.historyMyGroups.onDelete(renderUndo);
conn.subscriptionBuilder()
  .onApplied(() => {
    renderBoard();
    renderUndo();
    void refresh();
  })
  .subscribe(['SELECT * FROM demo_note', 'SELECT * FROM history_my_groups']);
