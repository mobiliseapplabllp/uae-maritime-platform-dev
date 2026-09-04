import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildGateway } from '../src/app';
import { type Env, loadEnv } from '../src/env';
import { ROUTES, SERVICES, matchRoute, resolveRoutes } from '../src/routes';

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
const upstreams: Server[] = [];
const gateways: FastifyInstance[] = [];
const REPO_ROOT = join(__dirname, '..', '..', '..');

/** A tiny upstream that echoes what it received and answers /health like the service kit does. */
function startUpstream(name: string): Promise<{ url: string; last: () => Seen | undefined }> {
  let last: Seen | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      last = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ success: true, data: { status: 'ok', service: name } }));
      if (req.url === '/auth/redirect') { res.statusCode = 302; res.setHeader('location', '/auth/me'); return res.end(); }
      res.statusCode = req.method === 'POST' ? 201 : 200;
      res.end(JSON.stringify({ success: true, data: { upstream: name, method: req.method, url: req.url, body: last.body } }));
    });
  });
  upstreams.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, last: () => last })));
}

async function startGateway(overrides: Record<string, string>): Promise<{ app: FastifyInstance; base: string; env: Env }> {
  const env = loadEnv({ ...process.env, LOG_LEVEL: 'silent', NODE_ENV: 'test', ...overrides } as never);
  const app = await buildGateway(env);
  await app.listen({ port: 0, host: '127.0.0.1' });
  gateways.push(app);
  return { app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, env };
}

let identity: Awaited<ReturnType<typeof startUpstream>>;
let mdm: Awaited<ReturnType<typeof startUpstream>>;
let base: string;

beforeAll(async () => {
  identity = await startUpstream('identity-access');
  mdm = await startUpstream('mdm');
  // Every other service defaults to its native port, which nothing listens on here; documents points at a closed port explicitly.
  ({ base } = await startGateway({ IDENTITY_URL: identity.url, MDM_URL: mdm.url, DOCUMENTS_URL: 'http://127.0.0.1:1', HEALTH_TIMEOUT_MS: '500' }));
});
afterAll(async () => {
  await Promise.all(gateways.map((g) => g.close()));
  await Promise.all(upstreams.map((s) => new Promise((r) => s.close(r))));
});

describe('route table', () => {
  it('covers every documented prefix exactly once and references only known services', () => {
    const prefixes = ROUTES.map((r) => r.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    const names = new Set(SERVICES.map((s) => s.name));
    for (const r of ROUTES) expect(names.has(r.service), r.prefix).toBe(true);
    expect(prefixes).toEqual(expect.arrayContaining(['/api/auth', '/api/internal', '/api/lookups', '/api/audit', '/api/dashboard', '/api/documents', '/api/vessels', '/api/port-calls', '/api/ai', '/api/jobs']));
  });
  /* The route table drifted from reality twice at once: it probed an `insights-api` that no service
   * in this repo provides — pinning /api/health at "degraded" forever — while `scheduler` ran on
   * :5405 unrouted and unmonitored. Both directions are caught here against the filesystem. */
  it('names exactly the services that exist in the repository', () => {
    const onDisk = readdirSync(join(REPO_ROOT, 'services'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'gateway')
      .map((d) => d.name)
      .sort();
    expect(SERVICES.map((s) => s.name).sort()).toEqual(onDisk);
  });
  it('gives every service a distinct port and env key', () => {
    expect(new Set(SERVICES.map((s) => s.port)).size).toBe(SERVICES.length);
    expect(new Set(SERVICES.map((s) => s.envKey)).size).toBe(SERVICES.length);
  });
  it('resolves URLs from env with native defaults and matches the longest prefix segment-wise', () => {
    const routes = resolveRoutes({ MDM_URL: 'http://mdm.internal:9000/' });
    expect(routes.find((r) => r.prefix === '/api/lookups')?.url).toBe('http://mdm.internal:9000');
    expect(routes.find((r) => r.prefix === '/api/auth')?.url).toBe('http://127.0.0.1:5401');
    expect(routes.find((r) => r.prefix === '/api/auth')?.rewritePrefix).toBe('/auth');
    expect(matchRoute(routes, '/api/auth/login?x=1')?.service).toBe('identity-access');
    expect(matchRoute(routes, '/api/authority')).toBeUndefined();
    expect(matchRoute(routes, '/api/module-settings/x')?.prefix).toBe('/api/module-settings');
    expect(matchRoute(routes, '/api/settings')?.prefix).toBe('/api/settings');
    expect(routes[0].prefix.length).toBeGreaterThanOrEqual(routes[routes.length - 1].prefix.length);
  });
});

describe('proxying', () => {
  it('routes by prefix, strips /api and keeps method, path, query and body', async () => {
    const r = await fetch(`${base}/api/auth/login?remember=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@maritime.example' }) });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.data.upstream).toBe('identity-access');
    expect(body.data.url).toBe('/auth/login?remember=1');
    expect(identity.last()?.body).toBe('{"email":"admin@maritime.example"}');
    const l = await fetch(`${base}/api/lookups/ports`);
    expect((await l.json()).data).toMatchObject({ upstream: 'mdm', method: 'GET', url: '/lookups/ports' });
    const bare = await fetch(`${base}/api/users`);
    expect((await bare.json()).data.url).toBe('/users');
  });
  it('propagates x-request-id, authorization and x-forwarded-for and strips x-service-token', async () => {
    const r = await fetch(`${base}/api/users/me`, { headers: { 'x-request-id': 'req-abc-12345', authorization: 'Bearer token-1', 'x-service-token': 'forged', 'x-forwarded-for': '203.0.113.9' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-request-id')).toBe('req-abc-12345');
    const seen = identity.last()!;
    expect(seen.headers['x-request-id']).toBe('req-abc-12345');
    expect(seen.headers['x-correlation-id']).toBe('req-abc-12345');
    expect(seen.headers.authorization).toBe('Bearer token-1');
    expect(seen.headers['x-service-token']).toBeUndefined();
    expect(seen.headers['x-forwarded-for']).toBe('127.0.0.1'); // inbound XFF ignored: no trusted proxy in front
    expect(seen.headers['x-forwarded-proto']).toBe('http');
  });
  it('generates a request id when the client sends none or an invalid one', async () => {
    const r = await fetch(`${base}/api/roles`, { headers: { 'x-request-id': 'bad id!' } });
    const id = r.headers.get('x-request-id')!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.last()?.headers['x-request-id']).toBe(id);
  });
  it('rewrites relative upstream redirects back under /api', async () => {
    const r = await fetch(`${base}/api/auth/redirect`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/api/auth/me');
  });
  it('blocks /api/internal from outside with the 404 envelope', async () => {
    for (const path of ['/api/internal', '/api/internal/principals/abc']) {
      const r = await fetch(`${base}${path}`, { headers: { 'x-service-token': 'development-service-token' } });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ success: false, message: 'API route not found' });
    }
  });
  it('answers unknown API routes and non-API paths with 404 envelopes', async () => {
    const api = await fetch(`${base}/api/nope/thing`);
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ success: false, message: 'API route not found' });
    const other = await fetch(`${base}/nope`);
    expect(other.status).toBe(404);
    expect((await other.json()).success).toBe(false);
  });
  it('returns the 503 envelope with the service name when an upstream is unreachable', async () => {
    const r = await fetch(`${base}/api/documents/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ success: false, message: 'Service unavailable', service: 'documents' });
  });
});

describe('cross-cutting behaviour', () => {
  it('adds security headers, no-store caching and rate-limit headers', async () => {
    const r = await fetch(`${base}/api/meta`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-ratelimit-limit')).toBe('600');
    expect(Number(r.headers.get('x-ratelimit-remaining'))).toBeLessThan(600);
    expect(r.headers.get('x-ratelimit-reset')).toBeTruthy();
  });
  it('allows configured CORS origins only', async () => {
    const ok = await fetch(`${base}/api/meta`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5300', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5300');
    expect(ok.headers.get('access-control-allow-methods')).toContain('POST');
    expect(ok.headers.get('access-control-expose-headers')).toContain('x-request-id');
    const denied = await fetch(`${base}/api/meta`, { headers: { origin: 'http://evil.example' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('rate limits per IP with retry-after and the error envelope', async () => {
    const { base: limited } = await startGateway({ IDENTITY_URL: identity.url, RATE_LIMIT_PER_MIN: '3' });
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 4; i++) { last = await fetch(`${limited}/api/users`); statuses.push(last.status); }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(last!.headers.get('retry-after')).toBeTruthy();
    expect(last!.headers.get('x-ratelimit-remaining')).toBe('0');
    const body = await last!.json();
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/Rate limit exceeded/);
  });
  it('enforces the body limit per route, larger for documents, for declared and chunked bodies', async () => {
    const { base: small } = await startGateway({ IDENTITY_URL: identity.url, DOCUMENTS_URL: identity.url, BODY_LIMIT_BYTES: '1024', UPLOAD_BODY_LIMIT_BYTES: '4096' });
    const payload = 'x'.repeat(2000);
    const post = (path: string, body: string, extra: Record<string, string> = {}) => fetch(`${small}${path}`, { method: 'POST', headers: { 'content-type': 'text/plain', ...extra }, body });
    const tooLarge = await post('/api/users', payload);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ success: false, message: 'Payload too large' });
    const docs = await post('/api/documents', payload);
    expect(docs.status).toBe(201);
    expect((await docs.json()).data.body.length).toBe(2000);
    expect((await post('/api/files', 'x'.repeat(5000))).status).toBe(413);
    const chunked = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(`${small}/api/users`, { method: 'POST', headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' } }, (res) => {
        let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('error', reject);
      req.write('x'.repeat(800)); req.write('x'.repeat(800)); req.end();
    });
    expect(chunked.status).toBe(413);
    expect(JSON.parse(chunked.body)).toEqual({ success: false, message: 'Payload too large' });
  });
  it('aggregates upstream health and exposes its own liveness', async () => {
    const own = await fetch(`${base}/health`);
    expect((await own.json()).data.status).toBe('ok');
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('degraded');
    const byName = Object.fromEntries(body.data.services.map((s: { name: string; status: string; url: string }) => [s.name, s]));
    expect(byName['identity-access']).toEqual({ name: 'identity-access', url: identity.url, status: 'ok' });
    expect(byName.mdm.status).toBe('ok');
    expect(byName.documents.status).toBe('down');
    expect(byName.ships.url).toBe('http://127.0.0.1:5421');
    const all = Object.fromEntries(SERVICES.map((s) => [s.envKey, identity.url]));
    const { base: healthy } = await startGateway(all);
    expect((await (await fetch(`${healthy}/api/health`)).json()).data.status).toBe('ok');
  });
});

describe('openapi aggregation', () => {
  it('merges upstream documents under the public prefixes and drops internal-only paths', async () => {
    const { publicPath, mergeOpenApi, renderDocsPage } = await import('../src/openapi');
    const routes = [{ prefix: '/api/lookups', service: 'mdm', url: 'http://x', rewritePrefix: '/lookups', blocked: false, bodyLimit: 1 }, { prefix: '/api/internal', service: 'mdm', url: 'http://x', rewritePrefix: '/internal', blocked: true, bodyLimit: 1 }] as never;
    expect(publicPath('mdm', '/lookups/categories', routes)).toBe('/api/lookups/categories');
    expect(publicPath('mdm', '/internal/settings/x', routes)).toBeNull();
    expect(publicPath('mdm', '/health', routes)).toBeNull();
    const doc = await mergeOpenApi([], routes, { timeoutMs: 100, ttlMs: 0 });
    expect(doc.openapi).toBe('3.0.3'); expect(doc.servers[0].url).toBe('/api');
    const html = renderDocsPage({ ...doc, paths: { '/lookups': { get: { summary: 'List <b>lookups</b>', tags: ['mdm'] } } } });
    expect(html).toContain('/api/lookups'); expect(html).toContain('&lt;b&gt;'); expect(html).not.toContain('<b>lookups');
  });
});

describe('renderers share the route table', () => {
  const render = (script: string, ...args: string[]) =>
    execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(REPO_ROOT, 'tools', 'gateway', script), ...args], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, MDM_URL: 'http://mdm:5402' } });
  it('renders Kong declarative config with services, routes and plugins', () => {
    const kong = JSON.parse(render('render-kong.ts', '--json'));
    expect(kong._format_version).toBe('3.0');
    const auth = kong.services.find((s: { name: string }) => s.name === 'identity-access-auth');
    expect(auth.url).toBe('http://127.0.0.1:5401/auth');
    expect(auth.routes[0].paths).toEqual(['~/api/auth$', '~/api/auth/']);
    expect(kong.services.find((s: { name: string }) => s.name === 'mdm-lookups').url).toBe('http://mdm:5402/lookups');
    const internal = kong.services.find((s: { name: string }) => s.name === 'identity-access-internal');
    expect(internal.routes[0].plugins.map((p: { name: string }) => p.name)).toContain('request-termination');
    expect(kong.plugins.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['rate-limiting', 'cors', 'correlation-id', 'request-transformer', 'request-size-limiting']));
    expect(kong.services).toHaveLength(ROUTES.length);
    const yaml = render('render-kong.ts');
    expect(yaml.startsWith('_format_version: "3.0"')).toBe(true);
    expect(yaml).toContain('name: "identity-access-auth"');
  });
  it('renders nginx location blocks in longest-prefix order with the same hygiene', () => {
    const nginx = render('render-nginx.ts');
    expect(nginx).toContain('location ~ ^/api/auth(?:/|$)');
    expect(nginx).toContain('rewrite ^/api/auth(/.*)?$ /auth$1 break;');
    expect(nginx).toContain('proxy_pass http://mdm:5402;');
    expect(nginx).toContain('proxy_set_header X-Service-Token "";');
    expect(nginx).toContain('client_max_body_size 50m;');
    expect(nginx.indexOf('^/api/module-settings')).toBeLessThan(nginx.indexOf('^/api/auth('));
    expect(nginx).toMatch(/location ~ \^\/api\/internal\(\?:\/\|\$\) \{[^}]*return 404/);
    expect(nginx.trimEnd().endsWith('}')).toBe(true);
  });
});
