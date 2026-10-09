// Client API for the demo. All three demo modules (Rust, C#, TypeScript submodule) expose the
// same client-facing names, so one set of bindings covers them.
import { BinaryReader, BinaryWriter, type Identity, Timestamp } from 'spacetimedb';
import { DbConnection } from './bindings/index';
import DemoNoteRow from './bindings/demo_note_table';
import DemoAccountRow from './bindings/demo_account_table';
import { HistoryQuery } from './bindings/types';

export type Conn = DbConnection;
export type Note = { id: bigint; text: string; x: number; y: number; color: string };
export type Account = { identity: Identity; name: string; apiKey: string };
export type Query = Partial<typeof HistoryQuery.type>;
export type Entry = Awaited<ReturnType<Conn['procedures']['historyQuery']>>[number];

/** How to decode each tracked table's BSATN values. */
const ROWS: Record<string, { deserialize(r: BinaryReader): unknown }> = {
  demo_note: DemoNoteRow,
  demo_account: DemoAccountRow,
};

export function decodeRow<T = unknown>(table: string, bytes: Uint8Array | undefined | null): T | undefined {
  if (!bytes) return undefined;
  const ty = ROWS[table];
  if (!ty) throw new Error(`unknown table ${table}`);
  return ty.deserialize(new BinaryReader(bytes)) as T;
}

/** `row_key` for a note id: hex of its BSATN (u64, little-endian). */
export function noteKey(id: bigint): string {
  const w = new BinaryWriter(8);
  w.writeU64(id);
  return [...w.getBuffer()].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function connect(host: string, db: string, token?: string, onDisconnect?: () => void): Promise<{ conn: Conn; identity: Identity; token: string }> {
  return new Promise((resolve, reject) =>
    DbConnection.builder()
      .withUri(host)
      .withDatabaseName(db)
      .withToken(token)
      .onConnect((conn, identity, tok) => resolve({ conn, identity, token: tok }))
      .onDisconnect(() => onDisconnect?.())
      .onConnectError((_c, e) => reject(e))
      .build()
  );
}

/** Fill in a full HistoryQuery (every field is required on the wire). */
export function query(q: Query): typeof HistoryQuery.type {
  return {
    tableName: undefined,
    rowKey: undefined,
    actor: undefined,
    scope: undefined,
    groupId: undefined,
    from: undefined,
    to: undefined,
    beforeId: undefined,
    limit: 0,
    ...q,
  };
}

export const now = () => Timestamp.now();
