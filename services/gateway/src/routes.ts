/**
 * Declarative route table — the single source of truth for the API gateway, the Kong renderer
 * (tools/gateway/render-kong.ts) and the nginx renderer (tools/gateway/render-nginx.ts).
 *
 * This module is dependency-free and uses only erasable TypeScript syntax so the renderers can
 * load it directly with Node's type stripping (no build step, no extra dependencies).
 *
 * Public paths live under `/api/<prefix>`; the `/api` segment is stripped when forwarding because
 * every service mounts its controllers at the root (`/auth`, `/users`, ...). The longest matching
 * prefix wins and matching is segment-aware (`/api/auth` matches `/api/auth/login`, never
 * `/api/authority`).
 */

export const API_PREFIX = '/api';
export const DEFAULT_BODY_LIMIT = 5 * 1024 * 1024;
export const UPLOAD_BODY_LIMIT = 50 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 60_000;
export const HEALTH_TIMEOUT_MS = 1_500;

export interface UpstreamService {
  /** Service name (matches `services/<name>` and the SERVICE_NAME each service logs with). */
  name: string;
  /** Environment variable that overrides the upstream URL, e.g. IDENTITY_URL. */
  envKey: string;
  /** Port the service listens on natively; the default URL is http://127.0.0.1:<port>. */
  port: number;
}

export interface RoutePrefix {
  /** Public prefix under /api. */
  prefix: string;
  /** Upstream service name from SERVICES. */
  service: string;
  /** Refused at the edge with a 404 envelope: service-to-service surface only. */
  blocked?: boolean;
  /** Request body limit in bytes when it differs from DEFAULT_BODY_LIMIT. */
  bodyLimit?: number;
}

export interface ResolvedRoute {
  prefix: string;
  service: string;
  url: string;
  /** Path forwarded upstream in place of `prefix` (the prefix without /api). */
  rewritePrefix: string;
  blocked: boolean;
  bodyLimit: number;
}

export interface ResolvedService {
  name: string;
  url: string;
}

export type EnvSource = Record<string, string | undefined>;

/** Every upstream the gateway fronts. Ports follow the platform port plan. */
export const SERVICES: UpstreamService[] = [
  { name: 'identity-access', envKey: 'IDENTITY_URL', port: 5401 },
  { name: 'mdm', envKey: 'MDM_URL', port: 5402 },
  { name: 'audit-ledger', envKey: 'AUDIT_URL', port: 5403 },
  { name: 'notifications', envKey: 'NOTIFICATIONS_URL', port: 5404 },
  { name: 'scheduler', envKey: 'SCHEDULER_URL', port: 5405 },
  { name: 'reporting', envKey: 'REPORTING_URL', port: 5406 },
  { name: 'workflow', envKey: 'WORKFLOW_URL', port: 5407 },
  { name: 'rules', envKey: 'RULES_URL', port: 5408 },
  { name: 'instruments', envKey: 'INSTRUMENTS_URL', port: 5409 },
  { name: 'documents', envKey: 'DOCUMENTS_URL', port: 5410 },
  { name: 'observability', envKey: 'OBSERVABILITY_URL', port: 5411 },
  { name: 'ships', envKey: 'SHIPS_URL', port: 5421 },
  { name: 'seafarers', envKey: 'SEAFARERS_URL', port: 5422 },
  { name: 'legislation', envKey: 'LEGISLATION_URL', port: 5423 },
  { name: 'maritime-centre', envKey: 'MARITIME_CENTRE_URL', port: 5424 },
  { name: 'inspection', envKey: 'INSPECTION_URL', port: 5425 },
  { name: 'ports', envKey: 'PORTS_URL', port: 5426 },
  { name: 'facilities', envKey: 'FACILITIES_URL', port: 5427 },
  { name: 'revenue', envKey: 'REVENUE_URL', port: 5428 },
  { name: 'ai-assistant', envKey: 'AI_ASSISTANT_URL', port: 5501 },
  { name: 'ai-agents', envKey: 'AI_AGENTS_URL', port: 5502 },
];

/** Public prefix → service. Order is irrelevant; resolution sorts longest prefix first. */
export const ROUTES: RoutePrefix[] = [
  // identity-access
  { prefix: '/api/auth', service: 'identity-access' },
  { prefix: '/api/users', service: 'identity-access' },
  { prefix: '/api/roles', service: 'identity-access' },
  { prefix: '/api/meta', service: 'identity-access' },
  { prefix: '/api/internal', service: 'identity-access', blocked: true },
  // mdm
  { prefix: '/api/lookups', service: 'mdm' },
  { prefix: '/api/settings', service: 'mdm' },
  { prefix: '/api/module-settings', service: 'mdm' },
  { prefix: '/api/jurisdiction', service: 'mdm' },
  { prefix: '/api/companies', service: 'mdm' },
  { prefix: '/api/golden', service: 'mdm' },
  // audit-ledger, notifications
  { prefix: '/api/audit', service: 'audit-ledger' },
  { prefix: '/api/notifications', service: 'notifications' },
  // reporting (CQRS read models)
  { prefix: '/api/dashboard', service: 'reporting' },
  { prefix: '/api/stats', service: 'reporting' },
  { prefix: '/api/search', service: 'reporting' },
  { prefix: '/api/cards', service: 'reporting' },
  { prefix: '/api/reports', service: 'reporting' },
  // workflow (service engine)
  { prefix: '/api/services', service: 'workflow' },
  { prefix: '/api/workflow', service: 'workflow' },
  // rules and fees
  { prefix: '/api/rules', service: 'rules' },
  { prefix: '/api/fees', service: 'rules' },
  // instruments (licences, certificates, public verification)
  { prefix: '/api/licenses', service: 'instruments' },
  { prefix: '/api/instruments', service: 'instruments' },
  { prefix: '/api/public', service: 'instruments' },
  // documents (uploads: larger body limit)
  { prefix: '/api/documents', service: 'documents', bodyLimit: UPLOAD_BODY_LIMIT },
  { prefix: '/api/files', service: 'documents', bodyLimit: UPLOAD_BODY_LIMIT },
  // domain services
  { prefix: '/api/vessels', service: 'ships' },
  { prefix: '/api/registrations', service: 'ships' },
  { prefix: '/api/seafarers', service: 'seafarers' },
  { prefix: '/api/legislation', service: 'legislation' },
  { prefix: '/api/notices', service: 'legislation' },
  { prefix: '/api/tracking', service: 'maritime-centre' },
  { prefix: '/api/incidents', service: 'maritime-centre' },
  { prefix: '/api/inspections', service: 'inspection' },
  { prefix: '/api/checklist-templates', service: 'inspection' },
  { prefix: '/api/risk', service: 'ships' },
  { prefix: '/api/port-calls', service: 'ports' },
  { prefix: '/api/berths', service: 'ports' },
  { prefix: '/api/ops', service: 'ports' },
  { prefix: '/api/facilities', service: 'facilities' },
  { prefix: '/api/invoices', service: 'revenue' },
  { prefix: '/api/tariffs', service: 'revenue' },
  { prefix: '/api/jobs', service: 'scheduler' },
  { prefix: '/api/platform', service: 'observability' },
  // AI layer (every agent action goes through ai-tool-gateway behind these services)
  { prefix: '/api/ai', service: 'ai-assistant' },
  { prefix: '/api/agents', service: 'ai-agents' },
];

/** Upstream URL for a service: the env override when set, otherwise the native default. */
export function serviceUrl(service: UpstreamService, env: EnvSource): string {
  const override = env[service.envKey];
  const url = override && override.trim() ? override.trim() : `http://127.0.0.1:${service.port}`;
  return url.replace(/\/+$/, '');
}

/** Unique upstreams referenced by the route table, in declaration order. */
export function resolveServices(env: EnvSource = process.env): ResolvedService[] {
  const used = new Set(ROUTES.map((r) => r.service));
  return SERVICES.filter((s) => used.has(s.name)).map((s) => ({ name: s.name, url: serviceUrl(s, env) }));
}

/** The route table with upstream URLs resolved, longest prefix first. */
export function resolveRoutes(env: EnvSource = process.env): ResolvedRoute[] {
  const byName = new Map(SERVICES.map((s) => [s.name, s] as const));
  return ROUTES.map((r) => {
    const service = byName.get(r.service);
    if (!service) throw new Error(`Route ${r.prefix} references unknown service ${r.service}`);
    return {
      prefix: r.prefix,
      service: r.service,
      url: serviceUrl(service, env),
      rewritePrefix: r.prefix.slice(API_PREFIX.length),
      blocked: r.blocked === true,
      bodyLimit: r.bodyLimit ?? DEFAULT_BODY_LIMIT,
    };
  }).sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
}

/** Segment-aware longest-prefix match on a request path (query string ignored). */
export function matchRoute(routes: ResolvedRoute[], url: string): ResolvedRoute | undefined {
  const q = url.indexOf('?');
  const path = q >= 0 ? url.slice(0, q) : url;
  return routes.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
}
