/* The platform's service registry. One list, read by everything that needs to know which services
 * exist and where they listen: the gateway proxies and health-checks from it, observability probes
 * from it, and tooling derives database names from it. Two copies of this list is precisely how the
 * gateway came to front a service that did not exist while missing one that did. */

export type ServiceKind = 'edge' | 'platform' | 'domain' | 'ai';

export interface PlatformService {
  name: string;
  /** Environment variable that overrides the native URL, e.g. SHIPS_URL. */
  envKey: string;
  port: number;
  kind: ServiceKind;
  /** The service's own database. The gateway holds no state and therefore owns none. */
  database: string | null;
}

/** Database name for a service. Most follow `maritime_<name with underscores>`; the exceptions are
 *  historical and are spelled out rather than special-cased at every call site. */
const DB_OVERRIDES: Record<string, string | null> = {
  gateway: null,
  'identity-access': 'maritime_identity',
  'audit-ledger': 'maritime_audit',
};
export const databaseOf = (name: string): string | null =>
  name in DB_OVERRIDES ? DB_OVERRIDES[name] : `maritime_${name.replace(/-/g, '_')}`;

const svc = (name: string, envKey: string, port: number, kind: ServiceKind): PlatformService =>
  ({ name, envKey, port, kind, database: databaseOf(name) });

/** Ports follow the platform plan: 52xx edge, 54xx platform and domain, 55xx AI. */
export const PLATFORM_SERVICES: PlatformService[] = [
  svc('gateway', 'GATEWAY_URL', 5200, 'edge'),
  svc('identity-access', 'IDENTITY_URL', 5401, 'platform'),
  svc('mdm', 'MDM_URL', 5402, 'platform'),
  svc('audit-ledger', 'AUDIT_URL', 5403, 'platform'),
  svc('notifications', 'NOTIFICATIONS_URL', 5404, 'platform'),
  svc('scheduler', 'SCHEDULER_URL', 5405, 'platform'),
  svc('reporting', 'REPORTING_URL', 5406, 'platform'),
  svc('workflow', 'WORKFLOW_URL', 5407, 'platform'),
  svc('rules', 'RULES_URL', 5408, 'platform'),
  svc('instruments', 'INSTRUMENTS_URL', 5409, 'platform'),
  svc('documents', 'DOCUMENTS_URL', 5410, 'platform'),
  svc('observability', 'OBSERVABILITY_URL', 5411, 'platform'),
  svc('ships', 'SHIPS_URL', 5421, 'domain'),
  svc('seafarers', 'SEAFARERS_URL', 5422, 'domain'),
  svc('legislation', 'LEGISLATION_URL', 5423, 'domain'),
  svc('maritime-centre', 'MARITIME_CENTRE_URL', 5424, 'domain'),
  svc('inspection', 'INSPECTION_URL', 5425, 'domain'),
  svc('ports', 'PORTS_URL', 5426, 'domain'),
  svc('facilities', 'FACILITIES_URL', 5427, 'domain'),
  svc('revenue', 'REVENUE_URL', 5428, 'domain'),
  svc('ai-assistant', 'AI_ASSISTANT_URL', 5501, 'ai'),
  svc('ai-agents', 'AI_AGENTS_URL', 5502, 'ai'),
];

/** Everything the gateway fronts: every service but itself. */
export const UPSTREAM_SERVICES = PLATFORM_SERVICES.filter((s) => s.kind !== 'edge');

export const serviceByName = (name: string): PlatformService | undefined =>
  PLATFORM_SERVICES.find((s) => s.name === name);

/** Native URL for a service, unless the environment overrides it. */
export function urlOf(service: PlatformService, env: Record<string, string | undefined>): string {
  const override = env[service.envKey];
  const url = override && override.trim() ? override.trim() : `http://127.0.0.1:${service.port}`;
  return url.replace(/\/+$/, '');
}
