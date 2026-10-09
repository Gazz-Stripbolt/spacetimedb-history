# Demo

A shared sticky-note board. Add, drag, edit, recolor and delete notes (shift-click selects several, so a multi-note
move is one action). **Undo/Redo** are yours alone and refuse if someone else changed the same note since. The
**activity** feed shows every change with who made it, and the **time slider** shows the board as it was at any
moment. The same demo exists in all three languages; each module serves the shared page from [`web/`](web) at
`/route/`.

```bash
npm install && npm run build:web          # bundles web/ into web/dist/index.html
spacetime start                           # in another terminal
spacetime publish -s local history -p demo/rust      # or demo/csharp, demo/typescript
open http://127.0.0.1:3000/v1/database/history/route/
```

Open two windows to see per-person undo and conflicts. `scripts/e2e.sh rust|csharp|typescript` publishes a demo and
runs the protocol and browser suites against it.
