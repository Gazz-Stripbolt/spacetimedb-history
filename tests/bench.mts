// Cost of tracking: the same updates with and without history, inside one transaction.
//
//   DB=hist-rust npx tsx tests/bench.mts
import { connect, query } from '../demo/web/src/api.ts';

const HOST = process.env.HOST ?? 'ws://127.0.0.1:3000';
const DB = process.env.DB ?? 'hist-rust';
const N = Number(process.env.N ?? 2000);
const ROUNDS = 5;

const { conn } = await connect(HOST, DB);
await new Promise<void>((res) => conn.subscriptionBuilder().onApplied(() => res()).subscribe(['SELECT * FROM demo_note']));
await conn.reducers.demoAddNote({ text: 'bench note with a little text in it', x: 1, y: 1, color: 'yellow' });
await new Promise((r) => setTimeout(r, 200));
const id = [...conn.db.demoNote.iter()].sort((a, b) => Number(b.id - a.id))[0].id;

async function time(tracked: boolean) {
  const runs: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    await conn.reducers.demoBench({ id, count: N, tracked });
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}
await time(true); // warm up
const plain = await time(false);
const tracked = await time(true);
const [e] = await conn.procedures.historyQuery({ q: query({ tableName: 'demo_note', limit: 1 }) });
const payload = (e.before?.length ?? 0) + (e.after?.length ?? 0);
console.log(`${DB}: ${N} updates per transaction (median of ${ROUNDS})`);
console.log(`  untracked  ${plain.toFixed(1)} ms  (${((plain * 1000) / N).toFixed(2)} µs/update)`);
console.log(`  tracked    ${tracked.toFixed(1)} ms  (${((tracked * 1000) / N).toFixed(2)} µs/update, +${(((tracked - plain) * 1000) / N).toFixed(2)} µs each)`);
console.log(`  history per update: 1 change row (${payload} B of before/after BSATN for a ${e.after?.length} B row) + 1 group row update`);
conn.disconnect();
process.exit(0);
