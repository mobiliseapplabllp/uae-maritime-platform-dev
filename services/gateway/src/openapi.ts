import type { ResolvedRoute, ResolvedService } from './routes';

/** Merges every upstream's OpenAPI document into one public document under the gateway's /api prefixes. Internal-only paths (no public route) are dropped. */
export interface MergedDoc { openapi: string; info: { title: string; version: string; description: string }; servers: { url: string }[]; tags: { name: string; description?: string }[]; paths: Record<string, unknown>; components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> } }
type Doc = { paths?: Record<string, Record<string, unknown>>; components?: { schemas?: Record<string, unknown> }; info?: { description?: string } };

const cache = new Map<string, { at: number; doc: Doc | null }>();
async function fetchDoc(url: string, timeoutMs: number, ttlMs: number): Promise<Doc | null> {
  const hit = cache.get(url); if (hit && Date.now() - hit.at < ttlMs) return hit.doc;
  let doc: Doc | null = null;
  try { const res = await fetch(`${url}/openapi.json`, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'maritime-gateway/openapi' } }); doc = res.ok ? ((await res.json()) as Doc) : null; } catch { doc = null; }
  cache.set(url, { at: Date.now(), doc });
  return doc;
}
export const resetOpenApiCache = () => cache.clear();

/** Maps an upstream path onto the public path served for it, or null when no route exposes it. */
export function publicPath(service: string, upstreamPath: string, routes: ResolvedRoute[]): string | null {
  const candidates = routes.filter((r) => r.service === service && !r.blocked).sort((a, b) => b.rewritePrefix.length - a.rewritePrefix.length);
  for (const r of candidates) {
    const base = r.rewritePrefix.replace(/\/$/, '');
    if (upstreamPath === base || upstreamPath.startsWith(`${base}/`) || base === '') return `${r.prefix.replace(/\/$/, '')}${upstreamPath.slice(base.length)}`;
  }
  return null;
}

export async function mergeOpenApi(services: ResolvedService[], routes: ResolvedRoute[], opts: { timeoutMs: number; ttlMs: number; version?: string }): Promise<MergedDoc> {
  const merged: MergedDoc = {
    openapi: '3.0.3',
    info: { title: 'Unified Maritime Digital Services Platform API', version: opts.version ?? '0.1.0', description: 'Every service behind the gateway, merged into one document. Bearer tokens come from POST /api/auth/login.' },
    servers: [{ url: '/api' }], tags: [], paths: {}, components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas: {} },
  };
  const docs = await Promise.all(services.map(async (s) => ({ service: s, doc: await fetchDoc(s.url, opts.timeoutMs, opts.ttlMs) })));
  for (const { service, doc } of docs) {
    if (!doc?.paths) continue;
    merged.tags.push({ name: service.name, description: doc.info?.description });
    for (const [path, ops] of Object.entries(doc.paths)) {
      const pub = publicPath(service.name, path, routes); if (!pub) continue;
      const rel = pub.replace(/^\/api/, '') || '/';
      const tagged: Record<string, unknown> = {};
      for (const [method, op] of Object.entries(ops)) tagged[method] = typeof op === 'object' && op ? { ...(op as object), tags: [service.name], security: [{ bearer: [] }] } : op;
      merged.paths[rel] = tagged;
    }
    for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) merged.components.schemas[`${service.name}.${name}`] = schema;
  }
  return merged;
}

/** A dependency-free reference page: every public endpoint grouped by service, rendered without external assets. */
export function renderDocsPage(doc: MergedDoc): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
  const byTag = new Map<string, string[]>();
  for (const [path, ops] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(ops as Record<string, { tags?: string[]; summary?: string }>)) {
    const tag = op.tags?.[0] ?? 'other'; const list = byTag.get(tag) ?? []; list.push(`<tr><td class="m ${method}">${method.toUpperCase()}</td><td><code>/api${esc(path)}</code></td><td>${esc(op.summary ?? '')}</td></tr>`); byTag.set(tag, list);
  }
  const sections = [...byTag.entries()].sort().map(([tag, rows]) => `<h2>${esc(tag)}</h2><table><thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead><tbody>${rows.join('')}</tbody></table>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(doc.info.title)}</title><style>body{font-family:system-ui,sans-serif;margin:32px;color:#0B1F2A;background:#F1F4F3}h1{font-size:22px}h2{font-size:15px;margin-top:28px;text-transform:uppercase;letter-spacing:.08em;color:#4A6070}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #D8E2E2;border-radius:8px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #E4EAE9;font-size:13px}th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#4A6070}td.m{font-family:ui-monospace,monospace;font-weight:700;width:70px}td.get{color:#2C6E52}td.post{color:#0B74B0}td.put,td.patch{color:#8A5810}td.delete{color:#A33229}code{font-family:ui-monospace,monospace}p{color:#3E5561}</style></head><body><h1>${esc(doc.info.title)} <small>v${esc(doc.info.version)}</small></h1><p>${esc(doc.info.description)} The machine-readable document is at <code>/api/openapi.json</code>.</p>${sections}</body></html>`;
}
