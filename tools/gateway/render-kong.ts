/**
 * Renders the gateway route table (services/gateway/src/routes.ts) as Kong declarative
 * configuration (format 3.0). YAML on stdout by default, JSON with --json.
 *
 *   pnpm gateway:kong > infra/kong/kong.yml
 *   pnpm gateway:kong -- --json --upstream-host=http://{service}.maritime.svc:{port}
 *
 * Upstream URLs come from the same environment variables the Node gateway reads (IDENTITY_URL,
 * MDM_URL, ...); --upstream-host supplies a pattern for every service that has no override.
 * CORS_ORIGIN and RATE_LIMIT_PER_MIN are honoured the same way. No dependencies: runs with Node's
 * type stripping (node --experimental-strip-types tools/gateway/render-kong.ts).
 */
import { API_PREFIX, DEFAULT_BODY_LIMIT, SERVICES, UPSTREAM_TIMEOUT_MS, resolveRoutes, type ResolvedRoute } from '../../services/gateway/src/routes.ts';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const hostPattern = args.find((a) => a.startsWith('--upstream-host='))?.slice('--upstream-host='.length);

const env: Record<string, string | undefined> = { ...process.env };
if (hostPattern) {
  for (const s of SERVICES) if (!env[s.envKey]) env[s.envKey] = hostPattern.replace('{service}', s.name).replace('{port}', String(s.port));
}
const origins = (env.CORS_ORIGIN ?? 'http://localhost:5300,http://127.0.0.1:5300').split(',').map((s) => s.trim()).filter(Boolean);
const perMinute = Number(env.RATE_LIMIT_PER_MIN ?? 600);
const routes = resolveRoutes(env);
const notFound = JSON.stringify({ success: false, message: 'API route not found' });

const routeName = (r: ResolvedRoute) => `${r.service}-${r.prefix.slice(API_PREFIX.length + 1)}`;

function service(r: ResolvedRoute) {
  const name = routeName(r);
  const routePlugins: unknown[] = [];
  if (r.blocked) routePlugins.push({ name: 'request-termination', config: { status_code: 404, content_type: 'application/json', body: notFound } });
  if (r.bodyLimit !== DEFAULT_BODY_LIMIT) routePlugins.push({ name: 'request-size-limiting', config: { allowed_payload_size: Math.ceil(r.bodyLimit / (1024 * 1024)), size_unit: 'megabytes', require_content_length: false } });
  return {
    name,
    url: `${r.url}${r.rewritePrefix}`,
    connect_timeout: 5000,
    read_timeout: UPSTREAM_TIMEOUT_MS,
    write_timeout: UPSTREAM_TIMEOUT_MS,
    retries: 0,
    tags: ['maritime', r.service],
    routes: [
      {
        name: `${name}-route`,
        paths: [`~${r.prefix}$`, `~${r.prefix}/`],
        regex_priority: r.prefix.length,
        strip_path: true,
        preserve_host: false,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        tags: ['maritime', r.service],
        ...(routePlugins.length ? { plugins: routePlugins } : {}),
      },
    ],
  };
}

const config = {
  _format_version: '3.0',
  _transform: true,
  services: routes.map(service),
  plugins: [
    { name: 'correlation-id', config: { header_name: 'x-request-id', generator: 'uuid', echo_downstream: true } },
    { name: 'request-transformer', config: { remove: { headers: ['x-service-token'] } } },
    { name: 'rate-limiting', config: { minute: perMinute, limit_by: 'ip', policy: 'local', hide_client_headers: false, error_code: 429, error_message: 'Rate limit exceeded' } },
    { name: 'request-size-limiting', config: { allowed_payload_size: Math.ceil(DEFAULT_BODY_LIMIT / (1024 * 1024)), size_unit: 'megabytes', require_content_length: false } },
    { name: 'cors', config: { origins, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], headers: ['Accept', 'Accept-Language', 'Authorization', 'Content-Type', 'X-Request-Id', 'X-Correlation-Id'], exposed_headers: ['x-request-id', 'x-correlation-id', 'x-ratelimit-limit-minute', 'x-ratelimit-remaining-minute', 'retry-after'], credentials: false, max_age: 600 } },
  ],
};

/** Minimal YAML emitter for plain JSON values (strings are always double-quoted). */
function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((item) => (isScalar(item) ? `${pad}- ${scalar(item)}` : `${pad}-\n${toYaml(item, indent + 2)}`)).join('\n');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([k, v]) => (isScalar(v) ? `${pad}${k}: ${scalar(v)}` : Array.isArray(v) && v.length === 0 ? `${pad}${k}: []` : `${pad}${k}:\n${toYaml(v, indent + 2)}`))
      .join('\n');
  }
  return `${pad}${scalar(value)}`;
}
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const scalar = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

process.stdout.write(asJson ? `${JSON.stringify(config, null, 2)}\n` : `${toYaml(config)}\n`);
