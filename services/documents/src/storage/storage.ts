import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';

/** The object store behind the document service. Keys are opaque, generated here, and never derived from user input. */
export interface Storage {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}
export class StorageObjectNotFound extends Error { constructor(readonly key: string) { super(`Stored object not found: ${key}`); } }

const KEY = /^[a-f0-9]{32}$/;
/** 32 hex characters: the first two shard the local tree into 256 directories. */
export const newStorageKey = (): string => randomBytes(16).toString('hex');
export function assertKey(key: string): string { if (!KEY.test(key)) throw new Error('Invalid storage key'); return key; }

/** Files under STORAGE_DIR/<first two hex>/<key>; writes land in a temporary file and are renamed into place so readers never see a partial object. */
export class LocalStorage implements Storage {
  constructor(readonly dir: string) {}
  pathFor(key: string): string { assertKey(key); return join(this.dir, key.slice(0, 2), key); }
  async put(key: string, body: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try { await writeFile(tmp, body, { flag: 'wx' }); await rename(tmp, path); }
    catch (e) { await unlink(tmp).catch(() => undefined); throw e; }
  }
  async get(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    try { await stat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageObjectNotFound(key); throw e; }
    return createReadStream(path);
  }
  async delete(key: string): Promise<void> {
    try { await unlink(this.pathFor(key)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}

/** Collects a stream into memory (tests and small internal reads only). */
export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}
