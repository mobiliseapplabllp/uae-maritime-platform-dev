import type { Pool, PoolClient } from 'pg';
import { notFound } from '@maritime/service-kit';
import { adapterByKey } from './adapters/registry';
import type { AdapterDefinition, AdapterOperation, AuthConfig, AuthType } from './adapters/types';

/* The catalogue is where code and configuration meet. A system adapter is declared in the registry and configured on
 * its row; a custom adapter — a counterpart the RFP never named, added by an administrator — is entirely its row,
 * operations included. Either way a caller resolves a key and gets one definition plus one row, and never has to
 * know which kind it is. */

export interface AdapterRow {
  key: string; name: string; name_ar: string | null; counterpart: string; kind: 'system' | 'custom'; protocol: 'rest' | 'soap';
  description: string; reference: string; mode: 'stub' | 'live'; base_url: string | null; enabled: boolean; contract_ver: string;
  timeout_ms: number; max_attempts: number; auth: AuthConfig; secrets: Record<string, string>; headers: Record<string, string>;
  operations: AdapterOperation[]; health_path: string; schedule: Record<string, unknown>; inbound_enabled: boolean; inbound_secret: string | null;
  updated_at: Date; updated_by: string;
}
export interface Resolved { row: AdapterRow; def: AdapterDefinition }
type Queryable = Pool | PoolClient;

export const ROW_COLUMNS = 'key, name, name_ar, counterpart, kind, protocol, description, reference, mode, base_url, enabled, contract_ver, timeout_ms, max_attempts, auth, secrets, headers, operations, health_path, schedule, inbound_enabled, inbound_secret, updated_at, updated_by';

/** The credentials each authentication type needs; anything else offered for it is refused. */
export const SECRET_KEYS: Record<AuthType, string[]> = { none: [], apiKey: ['apiKey'], bearer: ['token'], basic: ['username', 'password'] };

export function definitionOf(row: AdapterRow): AdapterDefinition {
  const sys = row.kind === 'system' ? adapterByKey(row.key) : undefined;
  if (sys) return { ...sys, healthPath: row.health_path || sys.healthPath };
  return {
    key: row.key, name: row.name, nameAr: row.name_ar ?? '', counterpart: row.counterpart, reference: row.reference, baseUrlEnv: '',
    defaultBaseUrl: row.base_url ?? '', protocol: row.protocol, operations: Array.isArray(row.operations) ? row.operations : [], healthPath: row.health_path,
  };
}

export async function readAdapter(c: Queryable, key: string): Promise<AdapterRow | null> {
  const r = await c.query<AdapterRow>(`SELECT ${ROW_COLUMNS} FROM adapters WHERE key = $1`, [key]);
  return r.rows[0] ?? null;
}
export async function loadAdapter(c: Queryable, key: string): Promise<Resolved> {
  const row = await readAdapter(c, key);
  if (!row) throw notFound(`unknown adapter ${key}`);
  return { row, def: definitionOf(row) };
}
export async function listAdapters(c: Queryable): Promise<Resolved[]> {
  const r = await c.query<AdapterRow>(`SELECT ${ROW_COLUMNS} FROM adapters ORDER BY kind, key`);
  return r.rows.map((row) => ({ row, def: definitionOf(row) }));
}

/** The shape a screen sees. Credentials come back as presence, never as values. */
export function adapterApi({ row, def }: Resolved) {
  const wanted = SECRET_KEYS[row.auth?.type ?? 'none'] ?? [];
  const secrets = Object.fromEntries(wanted.map((k) => [k, typeof row.secrets?.[k] === 'string' && row.secrets[k].length > 0]));
  return {
    key: row.key, name: row.name, nameAr: row.name_ar, counterpart: row.counterpart, kind: row.kind, protocol: def.protocol,
    description: row.description, reference: row.kind === 'system' ? def.reference : row.reference,
    mode: row.mode, enabled: row.enabled, baseUrl: row.base_url, defaultBaseUrl: def.defaultBaseUrl || null, contractVersion: row.contract_ver,
    timeoutMs: row.timeout_ms, maxAttempts: row.max_attempts, auth: row.auth ?? { type: 'none' }, secrets, headers: row.headers ?? {},
    healthPath: row.health_path || def.healthPath || '', schedule: row.schedule ?? {},
    inbound: { enabled: row.inbound_enabled, secretSet: !!row.inbound_secret },
    operations: def.operations.map((o) => ({ key: o.key, summary: o.summary, method: o.method, path: o.path, required: o.required, idempotent: o.idempotent, recorded: row.kind === 'custom' ? !!o.sample : undefined })),
    updatedAt: row.updated_at?.toISOString?.() ?? null, updatedBy: row.updated_by || null,
  };
}
export type AdapterApi = ReturnType<typeof adapterApi>;
