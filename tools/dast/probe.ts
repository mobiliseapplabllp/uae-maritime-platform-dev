/**
 * Dynamic application security testing — the platform attacked through its own front door.
 *
 * Everything here runs against a *running* platform over HTTP, as an ordinary client would: it holds no
 * database handle and imports nothing from the services, so it can only see what an attacker can see. That
 * is the point. The static pass reads the code and the unit tests exercise a service in isolation; this asks
 * what the assembled system actually answers.
 *
 * Each probe names the OWASP Top 10 (2021) category it serves, states what it expects, and says why. A probe
 * that fails is a finding; a probe that cannot run (a precondition missing from the seeded world) says so
 * rather than passing quietly.
 *
 *   node --experimental-strip-types tools/dast/probe.ts [--base http://127.0.0.1:5200]
 *
 * The default target is the local gateway. Credentials come from the seeded demonstration accounts and are
 * read from the environment so this file carries none.
 */
import { createHmac } from 'node:crypto';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', process.env.DAST_BASE_URL ?? 'http://127.0.0.1:5200');
const API = `${BASE}/api`;
const PASSWORD = process.env.DAST_PASSWORD ?? process.env.DEMO_PASSWORD ?? 'Demo@2026';

type Severity = 'high' | 'medium' | 'low';
interface Finding { probe: string; owasp: string; severity: Severity; detail: string }
const findings: Finding[] = [];
const skipped: string[] = [];
let ran = 0;

interface Res { status: number; headers: Headers; body: any; text: string }
async function http(path: string, init: RequestInit & { token?: string } = {}): Promise<Res> {
  const headers = new Headers(init.headers as HeadersInit);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const r = await fetch(path.startsWith('http') ? path : `${API}${path}`, { ...init, headers, redirect: 'manual' });
  const text = await r.text();
  let body: any = null; try { body = JSON.parse(text); } catch { /* not JSON, keep the text */ }
  return { status: r.status, headers: r.headers, body, text };
}

/** Runs one probe. `check` returns null when the platform behaved, or a sentence describing what it did instead. */
async function probe(name: string, owasp: string, severity: Severity, check: () => Promise<string | null>) {
  ran++;
  try {
    const detail = await check();
    if (detail === null) { console.log(`  \x1b[32mpass\x1b[0m  ${name}`); return; }
    if (detail.startsWith('SKIP:')) { skipped.push(`${name} — ${detail.slice(5).trim()}`); console.log(`  \x1b[33mskip\x1b[0m  ${name}`); return; }
    findings.push({ probe: name, owasp, severity, detail });
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${detail}`);
  } catch (e) {
    findings.push({ probe: name, owasp, severity, detail: `the probe itself failed: ${(e as Error).message}` });
    console.log(`  \x1b[31mERR \x1b[0m  ${name}\n        ${(e as Error).message}`);
  }
}

const login = async (email: string) => {
  const r = await http('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  if (r.status >= 400) throw new Error(`cannot sign in as ${email}: ${r.status} ${r.text.slice(0, 120)}`);
  return r.body.data as { token: string; refreshToken: string; user: { id: string; name: string; scope?: { level: string; companies?: string[] } } };
};
/** A JWT with its payload rewritten and its signature left as it was — the classic forgery attempt. */
const tamper = (token: string, mutate: (claims: Record<string, unknown>) => Record<string, unknown>): string => {
  const [h, p, s] = token.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  return `${h}.${Buffer.from(JSON.stringify(mutate(claims))).toString('base64url')}.${s}`;
};
/** A JWT re-headed as `alg: none` with the signature stripped. */
const unsigned = (token: string): string => {
  const [, p] = token.split('.');
  return `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
};

async function main() {
  console.log(`\nProbing ${BASE}\n`);
  const admin = await login('admin@maritime.example');
  const agent = await login('agent@maritime.example');
  const A = admin.token; const G = agent.token;

  // ---------------------------------------------------------------- A01 Broken access control
  console.log('A01 — broken access control');
  await probe('an anonymous caller cannot read a register', 'A01', 'high', async () => {
    const r = await http('/vessels');
    return r.status === 401 ? null : `GET /vessels without a token answered ${r.status}`;
  });
  await probe('a permission the role lacks is refused', 'A01', 'high', async () => {
    const r = await http('/users', { token: G });
    return r.status === 403 ? null : `a shipping agent reading the staff directory answered ${r.status}`;
  });
  await probe('a register is partitioned by tenant, not merely filtered in the client', 'A01', 'high', async () => {
    const mine = await http('/vessels?limit=200', { token: G });
    const all = await http('/vessels?limit=200', { token: A });
    const m = (mine.body?.data ?? []).length; const a = (all.body?.data ?? []).length;
    if (!a) return 'SKIP: the administration read no vessels, so there is nothing to compare';
    return m < a ? null : `the agent read ${m} of ${a} vessels — the partition is not being applied`;
  });
  await probe('a record outside the tenant reads as absent, not as forbidden', 'A01', 'high', async () => {
    const all = (await http('/vessels?limit=200', { token: A })).body?.data ?? [];
    const mine = new Set(((await http('/vessels?limit=200', { token: G })).body?.data ?? []).map((v: any) => v.id));
    const outside = all.find((v: any) => !mine.has(v.id));
    if (!outside) return 'SKIP: the agent can see every vessel in the seeded world';
    const r = await http(`/vessels/${outside.id}`, { token: G });
    if (r.status === 200) return `the agent read a vessel outside their fleet (${outside.name})`;
    return r.status === 404 ? null : `answered ${r.status}; 404 keeps the existence of the record private`;
  });
  await probe('the service-to-service surface is refused at the edge', 'A01', 'high', async () => {
    const r = await http('/internal/principals/admin', { token: A });
    return r.status === 404 ? null : `GET /api/internal/... answered ${r.status} through the public gateway`;
  });
  await probe('a hover card is not a way around a permission', 'A01', 'high', async () => {
    const incidents = (await http('/incidents?limit=1', { token: A })).body?.data ?? [];
    if (!incidents.length) return 'SKIP: no incident in the seeded world';
    const r = await http(`/cards/incident/${incidents[0].id}`, { token: G });
    return r.status === 404 ? null : `an agent without incidents.view read an incident card: ${r.status}`;
  });
  await probe('search does not return what the register would withhold', 'A01', 'high', async () => {
    const r = await http('/search?q=al', { token: G });
    const groups = r.body?.data?.groups ?? [];
    const mine = new Set(((await http('/vessels?limit=200', { token: G })).body?.data ?? []).map((v: any) => v.name));
    const leaked = (groups.find((g: any) => g.type === 'vessel')?.items ?? []).filter((i: any) => !mine.has(i.label));
    if (leaked.length) return `search returned ${leaked.length} vessels outside the agent's fleet: ${leaked.map((i: any) => i.label).join(', ')}`;
    const notices = (groups.find((g: any) => g.type === 'notice')?.items ?? []);
    const unpublished = notices.filter((n: any) => !['IN_FORCE', 'SUPERSEDED'].includes(n.sub));
    return unpublished.length ? `search returned ${unpublished.length} unpublished instruments to the industry` : null;
  });

  // ---------------------------------------------------------------- A02 / A07 Tokens and secrets
  console.log('\nA02, A07 — cryptography, authentication');
  await probe('a forged claim does not survive signature verification', 'A07', 'high', async () => {
    const forged = tamper(G, (c) => ({ ...c, sub: 'admin' }));
    const r = await http('/users', { token: forged });
    return r.status === 401 ? null : `a token with a rewritten subject answered ${r.status}`;
  });
  await probe('an unsigned token is refused', 'A07', 'high', async () => {
    const r = await http('/vessels', { token: unsigned(A) });
    return r.status === 401 ? null : `alg:none answered ${r.status}`;
  });
  await probe('a refresh token cannot be used as an access token', 'A07', 'high', async () => {
    const r = await http('/vessels', { token: admin.refreshToken });
    return r.status === 401 ? null : `a refresh token was accepted on a resource route: ${r.status}`;
  });
  await probe('a truncated or garbage bearer is refused', 'A07', 'medium', async () => {
    for (const bad of [A.slice(0, -6), 'not-a-token', '', `${A}.extra`]) {
      const r = await http('/vessels', { token: bad });
      if (r.status !== 401) return `a malformed bearer answered ${r.status}`;
    }
    return null;
  });
  await probe('sign-in does not say whether the account exists', 'A07', 'medium', async () => {
    const noUser = await http('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'nobody@maritime.example', password: PASSWORD }) });
    const badPass = await http('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@maritime.example', password: 'not-the-password-x' }) });
    const a = String(noUser.body?.message ?? noUser.text); const b = String(badPass.body?.message ?? badPass.text);
    if (noUser.status !== badPass.status) return `an unknown account answered ${noUser.status} and a wrong password ${badPass.status}`;
    return a === b ? null : `the two answers differ: "${a}" vs "${b}"`;
  });
  await probe('repeated failed sign-ins are throttled', 'A07', 'medium', async () => {
    // Deliberately against an address nobody holds. Hammering a real account would lock out the very
    // identity the rest of this suite signs in with — and, run against a live environment, would lock out
    // a person. The counter is keyed on the address either way, which is what this proves.
    const victim = `probe-${Date.now()}@maritime.example`;
    const attempts: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await http('/auth/login', { method: 'POST', body: JSON.stringify({ email: victim, password: 'wrong-password-probe' }) });
      attempts.push(r.status);
      if (r.status === 429 || r.status === 423) return null;
    }
    return `25 consecutive failures all answered ${attempts[0]}; nothing slowed the attacker down`;
  });
  await probe('a signed download link cannot be edited', 'A02', 'high', async () => {
    const docs = (await http('/documents?limit=1', { token: A })).body?.data ?? [];
    if (!docs.length) return 'SKIP: no document in the seeded world';
    const signed = await http(`/documents/${docs[0].id}/signed-url`, { method: 'POST', token: A, body: '{}' });
    const url: string = signed.body?.data?.url ?? signed.body?.url ?? '';
    if (!url) return 'SKIP: the service returned no signed URL to test';
    const ok = await http(url);
    if (ok.status >= 400) return `the freshly signed link itself answered ${ok.status}`;
    const moved = url.replace(/exp=\d+/, 'exp=99999999999');
    const r = await http(moved);
    return r.status === 403 ? null : `a link with its expiry moved forward answered ${r.status}`;
  });

  // ---------------------------------------------------------------- A03 Injection
  console.log('\nA03 — injection');
  await probe('a quote in a search term does not reach SQL', 'A03', 'high', async () => {
    for (const payload of ["' OR 1=1 --", "'; DROP TABLE vessels; --", "%' UNION SELECT null,null--", "\\'"]) {
      const r = await http(`/vessels?q=${encodeURIComponent(payload)}`, { token: A });
      if (r.status >= 500) return `"${payload}" produced ${r.status}`;
      if (Array.isArray(r.body?.data) && r.body.data.length > 40) return `"${payload}" widened the result set to ${r.body.data.length}`;
    }
    return null;
  });
  await probe('a sort parameter cannot name an arbitrary column', 'A03', 'high', async () => {
    const names = async (q: string) => ((await http(`/vessels?limit=5&${q}`, { token: A })).body?.data ?? []).map((v: any) => v.name).join('|');
    const fallback = await names('sort=this-is-not-a-column');
    for (const payload of ['name; DROP TABLE vessels', '(SELECT 1)', 'password_hash', '-password_hash', 'id::text']) {
      const r = await http(`/vessels?limit=5&sort=${encodeURIComponent(payload)}`, { token: A });
      if (r.status >= 500) return `sort=${payload} produced ${r.status}`;
      // an unknown field must land on the register's default order — including its direction
      const got = ((r.body?.data ?? []) as any[]).map((v) => v.name).join('|');
      if (got !== fallback) return `sort=${payload} changed the order, so the value reached the query`;
    }
    return null;
  });
  await probe('paging bounds are enforced', 'A03', 'low', async () => {
    for (const q of ['limit=100000', 'limit=-1', 'page=-5', 'limit=abc']) {
      const r = await http(`/vessels?${q}`, { token: A });
      if (r.status >= 500) return `${q} produced ${r.status}`;
      if ((r.body?.data ?? []).length > 1000) return `${q} returned ${(r.body?.data ?? []).length} rows`;
    }
    return null;
  });
  await probe('a stored script is returned as data, never as markup', 'A03', 'high', async () => {
    const r = await http('/vessels?q=%3Cscript%3E', { token: A });
    const type = r.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return `a search answered as ${type}`;
    return r.headers.get('x-content-type-options') === 'nosniff' ? null : 'x-content-type-options is not nosniff, so a browser may sniff a JSON body as markup';
  });

  // ---------------------------------------------------------------- A04 / A05 Design and configuration
  console.log('\nA04, A05 — design and configuration');
  await probe('the security headers are set on API responses', 'A05', 'medium', async () => {
    const r = await http('/vessels', { token: A });
    const missing = [['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'no-referrer']]
      .filter(([h, v]) => (r.headers.get(h) ?? '').toLowerCase() !== v.toLowerCase()).map(([h]) => h);
    if (!r.headers.get('content-security-policy')) missing.push('content-security-policy');
    return missing.length ? `missing or wrong: ${missing.join(', ')}` : null;
  });
  await probe('a response does not carry a stack trace or a driver message', 'A05', 'medium', async () => {
    for (const path of ['/vessels/not-a-uuid', '/vessels/00000000-0000-4000-8000-000000000000', '/nope']) {
      const r = await http(path, { token: A });
      const t = r.text.toLowerCase();
      for (const leak of ['at object.', 'node_modules', 'error: syntax error at or near', 'pg_', '/home/', 'stacktrace']) {
        if (t.includes(leak)) return `${path} leaked "${leak}"`;
      }
    }
    return null;
  });
  await probe('an unknown origin is not granted a credentialed cross-origin read', 'A05', 'medium', async () => {
    const r = await fetch(`${API}/vessels`, { headers: { origin: 'https://evil.example', authorization: `Bearer ${A}` } });
    const allow = r.headers.get('access-control-allow-origin');
    if (!allow) return null;
    return allow === 'https://evil.example' || allow === '*' ? `access-control-allow-origin came back as ${allow}` : null;
  });
  await probe('the rate limiter is armed', 'A04', 'medium', async () => {
    const r = await http('/vessels', { token: A });
    return r.headers.get('x-ratelimit-limit') ? null : 'no x-ratelimit-limit header, so nothing bounds a client';
  });
  await probe('TRACE is refused', 'A05', 'low', async () => {
    // fetch() will not send TRACE, so the request goes down a raw socket
    const { hostname, port } = new URL(BASE);
    const net = await import('node:net');
    const status = await new Promise<string>((resolve, reject) => {
      const sock = net.connect({ host: hostname || '127.0.0.1', port: Number(port || 80) }, () => {
        sock.write(`TRACE /api/vessels HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      sock.on('data', (d) => { buf += d.toString('utf8'); });
      sock.on('end', () => resolve(buf.split('\r\n')[0] ?? ''));
      sock.on('error', reject);
      setTimeout(() => { sock.destroy(); resolve(buf.split('\r\n')[0] ?? 'no answer'); }, 4000);
    });
    return /\s(2\d\d)\s/.test(status) ? `TRACE answered ${status}` : null;
  });

  // ---------------------------------------------------------------- A08 Integrity
  console.log('\nA08 — data integrity');
  await probe('a field the caller invented is not written', 'A08', 'medium', async () => {
    const me = await http('/auth/me', { token: G });
    const before = me.body?.data;
    if (!before) return 'SKIP: /auth/me returned nothing';
    const r = await http(`/users/${before.id}`, { method: 'PUT', token: G, body: JSON.stringify({ roleId: '00000000-0000-4000-8000-000000000000', perms: ['*'] }) });
    if (r.status === 200) return 'an agent edited their own user record';
    const after = (await http('/auth/me', { token: G })).body?.data;
    return after?.role?.name === before.role?.name ? null : `the role changed from ${before.role?.name} to ${after?.role?.name}`;
  });
  await probe('a prototype-polluting key is not honoured', 'A08', 'medium', async () => {
    const r = await http('/auth/change-password', { method: 'POST', token: G, body: '{"__proto__":{"admin":true},"currentPassword":"x","newPassword":"y"}' });
    if (r.status >= 500) return `a __proto__ key produced ${r.status}`;
    return ({} as any).admin === undefined ? null : 'the running process was polluted';
  });

  // ---------------------------------------------------------------- A09 Logging
  console.log('\nA09 — logging and monitoring');
  await probe('a security event reaches the audit ledger', 'A09', 'medium', async () => {
    await http('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@maritime.example', password: 'deliberately-wrong-x' }) });
    const r = await http('/audit?limit=25', { token: A });
    const rows = r.body?.data ?? [];
    if (!Array.isArray(rows) || !rows.length) return `the audit trail returned ${r.status} with no entries`;
    return rows.some((e: any) => /LOGIN|SIGN_IN|AUTH/i.test(String(e.action))) ? null : 'no sign-in event in the last 25 audit entries';
  });
  await probe('every response carries a correlation id', 'A09', 'low', async () => {
    const r = await http('/vessels', { token: A });
    return r.headers.get('x-correlation-id') || r.headers.get('x-request-id') ? null : 'no correlation id, so a report cannot be traced to a request';
  });

  // ---------------------------------------------------------------- A10 SSRF
  console.log('\nA10 — server-side request forgery');
  await probe('the outbound call surface is not reachable from outside', 'A10', 'high', async () => {
    // Only a service holding the shared token may ask the hub to call a counterpart. Through the public
    // gateway that route must not exist at all.
    const r = await http('/integrations/internal/call/gisis', { method: 'POST', token: A, body: '{"operation":"lookupShip"}' });
    return r.status === 404 ? null : `the outbound call route answered ${r.status} through the public gateway`;
  });
  await probe('a live adapter cannot be pointed at an internal address', 'A10', 'high', async () => {
    const list = await http('/integrations', { token: A });
    if (list.status !== 200) return `SKIP: the adapter registry answered ${list.status}`;
    const adapters = list.body?.data?.adapters ?? list.body?.data ?? [];
    const key = Array.isArray(adapters) && adapters.length ? (adapters[0].key ?? adapters[0].id) : null;
    if (!key) return 'SKIP: no adapter registered';
    // Whatever happens below, the adapter is put back as it was: a probe suite that leaves the system
    // changed cannot be run where it matters most.
    const before = (Array.isArray(adapters) ? adapters : []).find((a: any) => (a.key ?? a.id) === key) ?? {};
    const restore = async () => {
      const body: Record<string, unknown> = { mode: before.mode ?? 'stub' };
      if (before.baseUrl ?? before.base_url) body.baseUrl = before.baseUrl ?? before.base_url;
      await http(`/integrations/${key}/mode`, { method: 'POST', token: A, body: JSON.stringify(body) });
    };
    try {
      for (const baseUrl of ['http://169.254.169.254/latest/meta-data/', 'https://10.0.0.5/x', 'https://postgres.internal/x', 'http://localhost:5432/x']) {
        const r = await http(`/integrations/${key}/mode`, { method: 'POST', token: A, body: JSON.stringify({ mode: 'live', baseUrl }) });
        if (r.status < 400) return `an adapter was pointed at ${baseUrl} (${r.status})`;
      }
      return null;
    } finally { await restore(); }
  });
  await probe('a caller without settings.manage cannot move an adapter at all', 'A10', 'high', async () => {
    const r = await http('/integrations/gisis/mode', { method: 'POST', token: G, body: '{"mode":"live"}' });
    return r.status === 403 || r.status === 404 ? null : `an agent moving an adapter answered ${r.status}`;
  });

  // ---------------------------------------------------------------- Public portal
  console.log('\nPublic portal — the law as published, and nothing else');
  await probe('the public register answers without a session and carries no governance', 'A01', 'high', async () => {
    const r = await http('/public/legislation?limit=5');
    if (r.status !== 200) return `GET /api/public/legislation answered ${r.status} without a session`;
    const rows: any[] = r.body?.data ?? [];
    if (!rows.length) return 'SKIP: the published register is empty';
    const leak = rows.find((i) => 'draftedBy' in i || 'acknowledgedBy' in i || 'approvedBy' in i || 'sourceNote' in i || 'body' in i);
    if (leak) return `a public list row carries desk-only fields: ${Object.keys(leak).filter((k) => ['draftedBy', 'acknowledgedBy', 'approvedBy', 'sourceNote', 'body'].includes(k)).join(', ')}`;
    if (!/public, max-age=\d+/.test(r.headers.get('cache-control') ?? '')) return `the public answer is not cacheable (Cache-Control: ${r.headers.get('cache-control')})`;
    return null;
  });
  await probe('a draft never appears on the portal, even by its reference', 'A01', 'high', async () => {
    const all = await http('/public/legislation?history=true&limit=200');
    const draft = (all.body?.data ?? []).find((i: any) => i.status === 'DRAFT');
    if (draft) return `the history view listed a draft: ${draft.refNo}`;
    const desk = await http('/legislation/instruments?status=DRAFT&limit=1', { token: A });
    const ref = desk.body?.data?.[0]?.refNo;
    if (!ref) return 'SKIP: no draft on the register to test with';
    const r = await http(`/public/legislation/${encodeURIComponent(ref)}`);
    return r.status === 404 ? null : `the draft ${ref} answered ${r.status} on the public portal`;
  });
  await probe('the public instrument carries the text, the citation and a version, and nothing from the desk', 'A01', 'high', async () => {
    const list = await http('/public/legislation?limit=1');
    const slug = list.body?.data?.[0]?.slug;
    if (!slug) return 'SKIP: the published register is empty';
    const r = await http(`/public/legislation/${slug}`);
    if (r.status !== 200) return `GET /api/public/legislation/${slug} answered ${r.status}`;
    const i = r.body?.data ?? {};
    for (const k of ['draftedBy', 'acknowledgedBy', 'approvedBy', 'sourceNote', 'reviewNote', 'clearanceNote', 'recipients', 'outstanding']) if (k in i) return `the public instrument carries the desk field ${k}`;
    if (!i.citation?.en || !i.citation?.ar) return 'the citation is missing in one language';
    if (!/^"[0-9a-f]{32}"$/.test(r.headers.get('etag') ?? '')) return `no content-version ETag (${r.headers.get('etag')})`;
    const again = await http(`/public/legislation/${slug}`, { headers: { 'if-none-match': r.headers.get('etag')! } });
    return again.status === 304 ? null : `If-None-Match with the current version answered ${again.status}, not 304`;
  });
  await probe('the public prefix is not a way into the desk', 'A01', 'high', async () => {
    for (const path of ['/legislation/instruments', '/legislation/imo/items', '/legislation/meta', '/notices/pending']) {
      const r = await http(path);
      if (r.status !== 401) return `${path} answered ${r.status} without a session`;
    }
    const traversal = await http('/public/legislation/..%2F..%2Flegislation%2Finstruments');
    if (traversal.status === 200 && Array.isArray(traversal.body?.data)) return 'a traversal through the public prefix reached the desk register';
    const poll = await http('/legislation/imo/poll', { method: 'POST', token: G, body: '{"force":true}' });
    return poll.status === 403 ? null : `an agent polling the IMO sources answered ${poll.status}`;
  });
  await probe('a quote in a public search does not reach SQL', 'A03', 'high', async () => {
    for (const q of [`' OR 1=1 --`, `"; DROP TABLE legal_instruments; --`, `%' UNION SELECT 1,2,3 --`, '%\\_%']) {
      const r = await http(`/public/legislation?q=${encodeURIComponent(q)}`);
      if (r.status >= 500) return `q=${JSON.stringify(q)} answered ${r.status}`;
    }
    const unknown = await http('/public/legislation/NO-SUCH-1%2F2099');
    return unknown.status === 404 ? null : `an unknown reference answered ${unknown.status}`;
  });
  // ---------------------------------------------------------------- Access controls (A07 identification and authentication, A01 access control)
  await probe('a half-finished sign-in is not a session: the second-step token opens nothing', 'A07', 'high', async () => {
    // the sign-in of an account past its enrolment deadline stops with an enrolment token; that token must open nothing
    const s = await login('surveyor@maritime.example');
    const claims = JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url').toString('utf8'));
    const forged = tamper(s.token, () => ({ ...claims, typ: 'mfa', purpose: 'enrol' }));
    const me = await http('/auth/me', { token: forged });
    if (me.status !== 401) return `a token retyped as a second-step token answered ${me.status}`;
    const verify = await http('/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ mfaToken: s.token, code: '000000' }) });
    return verify.status === 401 ? null : `an access token was accepted as a second-step token (${verify.status})`;
  });
  await probe('a revoked session cannot refresh, and its access token stops answering', 'A07', 'high', async () => {
    const s = await login('surveyor@maritime.example');
    const ended = await http('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: s.refreshToken }), token: s.token });
    if (ended.status >= 400) return `sign-out answered ${ended.status}`;
    const again = await http('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: s.refreshToken }) });
    if (again.status !== 401) return `a refresh token from an ended session answered ${again.status}`;
    const me = await http('/auth/me', { token: s.token });
    return me.status === 401 ? null : `an access token from an ended session still answered ${me.status}`;
  });
  await probe('a privileged grant is not applied by the administrator who asks for it', 'A01', 'high', async () => {
    const admin = await login('admin@maritime.example');
    const roles = await http('/roles', { token: admin.token });
    const ia = (roles.body?.data ?? []).find((r: any) => r.code === 'IA');
    const pilots = await http('/users?role=Port%20Pilot&active=true&limit=50', { token: admin.token });
    const pilot = (pilots.body?.data ?? [])[0];
    if (!ia || !pilot) return 'SKIP: no Identity Administrator role or no pilot to test with';
    const ask = await http(`/users/${pilot.id}`, { method: 'PUT', body: JSON.stringify({ roleId: ia.id, reason: 'dynamic probe' }), token: admin.token });
    const pending = ask.body?.data?.pendingChange;
    try {
      if (ask.status !== 200 || !pending) return `the grant was applied at once (${ask.status}, role now ${ask.body?.data?.role?.name})`;
      const self = await http(`/users/changes/${pending.id}/approve`, { method: 'POST', body: '{}', token: admin.token });
      if (self.status !== 403) return `the requester could approve their own request (${self.status})`;
      const after = await http(`/users/${pilot.id}`, { token: admin.token });
      return after.body?.data?.role?.name === 'Port Pilot' ? null : `the role changed without approval to ${after.body?.data?.role?.name}`;
    } finally { if (pending) await http(`/users/changes/${pending.id}/cancel`, { method: 'POST', body: '{}', token: admin.token }); }
  });
  await probe('an administrator cannot change their own role or scope, and the last one cannot be switched off', 'A01', 'high', async () => {
    const admin = await login('admin@maritime.example');
    const roles = await http('/roles', { token: admin.token });
    const pp = (roles.body?.data ?? []).find((r: any) => r.code === 'PP');
    const demote = await http(`/users/${admin.user.id}`, { method: 'PUT', body: JSON.stringify({ roleId: pp?.id }), token: admin.token });
    if (demote.status !== 403) return `an administrator could change their own role (${demote.status})`;
    const scope = await http(`/users/${admin.user.id}`, { method: 'PUT', body: JSON.stringify({ scope: { level: 'PORT', ports: ['AEFJR'] } }), token: admin.token });
    if (scope.status !== 403) return `an administrator could change their own scope (${scope.status})`;
    const second = await login('idadmin@maritime.example').catch(() => null);
    if (!second) return 'SKIP: no second administrator to try with';
    const off = await http(`/users/${admin.user.id}`, { method: 'PUT', body: JSON.stringify({ active: false }), token: second.token });
    return off.status === 409 ? null : `the last account holding every permission could be switched off (${off.status})`;
  });
  await probe('a port-scoped account reads its port, not the nation; a facility account is contained to its port', 'A01', 'high', async () => {
    const officer = await login('portofficer@maritime.example').catch(() => null);
    const terminal = await login('terminal@maritime.example').catch(() => null);
    const admin = await login('admin@maritime.example');
    if (!officer || !terminal) return 'SKIP: the port and facility accounts are not seeded';
    const all = await http('/port-calls?limit=1', { token: admin.token });
    const mine = await http('/port-calls?limit=1', { token: officer.token });
    if (mine.status !== 200) return `the port officer cannot read the call register (${mine.status})`;
    const nAll = Number(all.body?.meta?.total ?? 0); const nMine = Number(mine.body?.meta?.total ?? 0);
    if (!(nMine < nAll)) return `the port officer at ${officer.user.scope?.ports?.join(',')} sees ${nMine} of ${nAll} calls — not contained to their port`;
    const contained = await http('/port-calls?limit=1', { token: terminal.token });
    return contained.status === 200 ? null : `the facility account cannot read the call register of its own port (${contained.status})`;
  });

  await probe('an integration cannot be pointed at the platform\'s own infrastructure or a private range', 'A10', 'high', async () => {
    const admin = await login('admin@maritime.example');
    const inside = await http('/integrations/classification', { method: 'PUT', body: JSON.stringify({ baseUrl: 'http://127.0.0.1:5432' }), token: admin.token });
    if (inside.status !== 400) return `the database port was accepted as a counterpart address (${inside.status})`;
    const meta = await http('/integrations', { method: 'POST', body: JSON.stringify({ key: 'dast-probe', name: 'Probe', counterpart: 'Probe', baseUrl: 'https://169.254.169.254/latest/meta-data', operations: [{ key: 'x', summary: 'x', method: 'GET', path: '/' }] }), token: admin.token });
    if (meta.status !== 400) { await http('/integrations/dast-probe', { method: 'DELETE', token: admin.token }); return `the cloud metadata address was accepted for a new adapter (${meta.status})`; }
    const live = await http('/integrations/classification', { method: 'PUT', body: JSON.stringify({ mode: 'live' }), token: admin.token });
    return live.status === 400 ? null : `an adapter went live on its stub address (${live.status})`;
  });
  await probe('a counterpart credential is written once and never read back', 'A02', 'high', async () => {
    const admin = await login('admin@maritime.example');
    const marker = 'dast-secret-9f3a7c';
    const set = await http('/integrations/classification', { method: 'PUT', body: JSON.stringify({ auth: { type: 'bearer' }, secrets: { token: marker } }), token: admin.token });
    try {
      if (set.status !== 200) return `the credential could not be set (${set.status})`;
      if (set.text.includes(marker)) return 'the save answered with the credential in it';
      for (const path of ['/integrations', '/integrations/classification', '/integrations/calls?adapter=classification', '/audit?entity=Adapter&limit=20']) {
        const r = await http(path, { token: admin.token });
        if (r.text.includes(marker)) return `${path} handed the credential back`;
      }
      return null;
    } finally { await http('/integrations/classification', { method: 'PUT', body: JSON.stringify({ auth: { type: 'none' }, secrets: {} }), token: admin.token }); }
  });
  await probe('an inbound delivery is refused unsigned, forged or stale, and accepted once when genuine', 'A08', 'high', async () => {
    const admin = await login('admin@maritime.example');
    const issued = await http('/integrations/payment/inbound/rotate', { method: 'POST', body: '{}', token: admin.token });
    if (issued.status !== 201 || !issued.body?.data?.secret) return `no signing key could be issued (${issued.status})`;
    const secret = issued.body.data.secret as string;
    try {
      const body = JSON.stringify({ type: 'settlement', reference: 'PAY-DAST', status: 'SETTLED' });
      const ts = Math.floor(Date.now() / 1000);
      const sign = (key: string, at: number) => `sha256=${createHmac('sha256', key).update(`${at}.${body}`).digest('hex')}`;
      const send = (headers: Record<string, string>) => http('/integrations/inbound/payment', { method: 'POST', body, headers });
      const bare = await send({}); if (bare.status !== 401) return `an unsigned delivery answered ${bare.status}`;
      const forged = await send({ 'x-hub-timestamp': String(ts), 'x-hub-delivery': 'dast-1', 'x-hub-signature': sign('not-the-key', ts) }); if (forged.status !== 401) return `a forged signature answered ${forged.status}`;
      const stale = await send({ 'x-hub-timestamp': String(ts - 3600), 'x-hub-delivery': 'dast-2', 'x-hub-signature': sign(secret, ts - 3600) }); if (stale.status !== 401) return `a stale delivery answered ${stale.status}`;
      const id = `dast-${ts}`;
      const good = await send({ 'x-hub-timestamp': String(ts), 'x-hub-delivery': id, 'x-hub-signature': sign(secret, ts) }); if (good.status !== 201 || good.body?.data?.duplicate !== false) return `a genuine delivery answered ${good.status}`;
      const again = await send({ 'x-hub-timestamp': String(ts), 'x-hub-delivery': id, 'x-hub-signature': sign(secret, ts) });
      return again.body?.data?.duplicate === true ? null : `a repeated delivery was taken as new (${again.status})`;
    } finally { await http('/integrations/payment', { method: 'PUT', body: JSON.stringify({ inboundEnabled: false }), token: admin.token }); }
  });
  await probe('the integration console is an administrator\'s tool, not every officer\'s', 'A01', 'high', async () => {
    const fin = await login('finance@maritime.example');
    const cfg = await http('/integrations/classification', { method: 'PUT', body: JSON.stringify({ description: 'probe' }), token: fin.token });
    if (cfg.status !== 403) return `a finance officer could configure an adapter (${cfg.status})`;
    const run = await http('/integrations/classification/invoke', { method: 'POST', body: JSON.stringify({ operation: 'vesselStatus', payload: { imo: '1' } }), token: fin.token });
    if (run.status !== 403) return `a finance officer could call a counterpart from the console (${run.status})`;
    const agent = await login('agent@maritime.example');
    const list = await http('/integrations', { token: agent.token });
    return list.status === 403 ? null : `an external agent could read the integration registry (${list.status})`;
  });
  await probe('the traffic picture is the watch\'s to see, and a person\'s fleet is nobody else\'s', 'A01', 'medium', async () => {
    const agent = await login('agent@maritime.example');
    const picture = await http('/tracking/targets?minLat=20&maxLat=30&minLon=50&maxLon=60', { token: agent.token });
    if (picture.status !== 403) return `an external agent could read the traffic picture (${picture.status})`;
    const nmc = await login('nmc@maritime.example');
    const targets: any[] = (await http('/tracking/targets?minLat=20&maxLat=30&minLon=50&maxLon=60&limit=50', { token: nmc.token })).body?.data?.targets ?? [];
    if (!targets.length) return 'SKIP: no target on the picture';
    const key = targets[0].mmsi;
    const follow = await http('/tracking/watch', { method: 'POST', body: JSON.stringify({ key }), token: nmc.token });
    if (follow.status !== 201) return `the watch could not follow a ship (${follow.status})`;
    const admin = await login('admin@maritime.example');
    const theirs: any[] = (await http('/tracking/watch', { token: admin.token })).body?.data ?? [];
    await http(`/tracking/watch/${encodeURIComponent(key)}`, { method: 'DELETE', token: nmc.token });
    if (theirs.some((w) => w.mmsi === key)) return 'one person\'s fleet was listed to another';
    const injected = await http(`/tracking/targets/search?q=${encodeURIComponent("' OR 1=1 --")}`, { token: nmc.token });
    if (injected.status !== 200 || (injected.body?.data ?? []).length) return `a search for an injection string returned ${injected.status} with ${(injected.body?.data ?? []).length} rows`;
    return null;
  });
  await probe('a feed is read on request by the duty officer only, and only the feeds that exist', 'A01', 'medium', async () => {
    const agent = await login('agent@maritime.example');
    const outsider = await http('/tracking/feed/poll?source=lrit', { method: 'POST', token: agent.token });
    if (outsider.status !== 403) return `an external agent could read the LRIT data centre (${outsider.status})`;
    const admin = await login('admin@maritime.example');
    const unknown = await http('/tracking/feed/poll?source=radar%27%20OR%201%3D1', { method: 'POST', token: admin.token });
    if (unknown.status !== 400) return `a feed that does not exist was accepted (${unknown.status})`;
    const feeds = await http('/tracking/feed', { token: admin.token });
    const sources: any[] = feeds.body?.data?.sources ?? [];
    if (sources.map((s) => s.source).join(',') !== 'ais-lrit,lrit') return `the feeds answered are ${sources.map((s) => s.source).join(',') || 'none'}`;
    return null;
  });
  await probe('a model is fitted again by AI governance only, and the model server\'s serving face and the registry\'s service face never answer a person', 'A01', 'high', async () => {
    const agent = await login('agent@maritime.example');
    const fit = await http('/ai-models/inspection-targeting/train', { method: 'POST', token: agent.token, body: JSON.stringify({ note: 'probe' }) });
    if (fit.status !== 403) return `an external agent could fit a model (${fit.status})`;
    const list = await http('/ai-models', { token: agent.token });
    if (list.status !== 403) return `an external agent could read the model server (${list.status})`;
    const admin = await login('admin@maritime.example');
    // the serving contract is reachable only inside the cluster on the service token; through the front door it does not exist
    const serve = await http('/ai-models/v1/models/inspection-targeting/infer', { method: 'POST', token: admin.token, headers: { 'x-service-token': 'development-service-token' }, body: JSON.stringify({ version: 2, features: {} }) });
    if (serve.status !== 404) return `the model server's serving face answered through the gateway (${serve.status})`;
    // the registry's service face takes a fit from the model server, never from a session — even an administrator's
    const trained = await http('/ai-platform/internal/models/inspection-targeting/trained', { method: 'POST', token: admin.token, headers: { 'x-service-token': 'development-service-token' }, body: JSON.stringify({ version: 9, artifactRef: 'probe', metrics: { auc: 1 } }) });
    if (trained.status !== 401) return `a session could report a fit to the registry (${trained.status})`;
    const versions = await http('/ai-platform/models/inspection-targeting/versions', { token: admin.token });
    if ((versions.body?.data ?? []).some((v: any) => v.version === 9)) return 'a probe version reached the registry';
    return null;
  });
  await probe('the federal security review is the security desk\'s to start, and a facility\'s history is not everyone\'s to read', 'A01', 'high', async () => {
    const admin = await login('admin@maritime.example');
    const all: any[] = (await http('/facilities/port-facilities?limit=100&sort=code', { token: admin.token })).body?.data ?? [];
    if (!all.length) return 'SKIP: no port facility on the register';
    // a shipping agent holds facilities.view for the directory, so it reads the register — but not beyond its own company, and it starts no review
    const agent = await login('agent@maritime.example');
    const mine: any[] = (await http('/facilities/port-facilities?limit=100', { token: agent.token })).body?.data ?? [];
    const other = all.find((f) => !mine.some((m) => m.id === f.id));
    if (!other) return 'SKIP: the agent account sees every facility, so containment cannot be probed';
    const start = await http(`/facilities/port-facilities/${other.id}/icp-review`, { method: 'POST', body: JSON.stringify({ reason: 'probe' }), token: agent.token });
    if (start.status !== 403) return `a shipping agent could submit a facility for federal review (${start.status})`;
    const theirs = await http(`/facilities/port-facilities/${other.id}/icp-reviews`, { token: agent.token });
    if (theirs.status !== 404) return `an agent could read the review history of a facility outside its scope (${theirs.status})`;
    if (mine[0]) {
      const own = await http(`/facilities/port-facilities/${mine[0].id}/icp-reviews`, { token: agent.token });
      if (own.status !== 200) return `an agent could not read the review history of a facility in its own scope (${own.status})`;
    }
    // an account without the facilities permission reads no history at all — a terminal supervisor included
    for (const email of ['idadmin@maritime.example', 'terminal@maritime.example']) {
      const closed = await http(`/facilities/port-facilities/${other.id}/icp-reviews`, { token: (await login(email)).token });
      if (closed.status !== 403) return `${email} could read a facility's review history without the facilities permission (${closed.status})`;
    }
    const anon = await http(`/facilities/port-facilities/${other.id}/icp-reviews`);
    return anon.status === 401 ? null : `the review history answered ${anon.status} without a session`;
  });
  await probe('the public feed and sitemap publish addresses, not identifiers', 'A01', 'medium', async () => {
    const feed = await http('/public/legislation/feed?days=3650');
    if (feed.status !== 200) return `the feed answered ${feed.status}`;
    const items: any[] = feed.body?.data?.items ?? [];
    if (items.some((i) => 'id' in i && /^[0-9a-f-]{36}$/.test(String(i.id)))) return 'a feed item is identified by a database id rather than its address';
    const map = await http('/public/legislation/sitemap');
    const urls: any[] = map.body?.data?.urls ?? [];
    return urls.every((u) => /^https?:\/\/.+\/[a-z0-9-]+$/.test(u.url)) ? null : 'a sitemap entry is not a stable address';
  });

  await probe('the tool gateway\'s service face is closed to a person\'s session, even an administrator\'s', 'A01', 'high', async () => {
    const cat = await http('/ai-gateway/tools/catalogue?caller=assistant', { token: A });
    const run = await http('/ai-gateway/tools/ops.dashboard/run', { method: 'POST', token: A, body: JSON.stringify({ caller: 'assistant' }) });
    const done = await http('/ai-gateway/complete', { method: 'POST', token: A, body: JSON.stringify({ caller: 'assistant', question: 'x' }) });
    return cat.status === 401 && run.status === 401 && done.status === 401 ? null : `the service face answered ${cat.status}/${run.status}/${done.status} to a user token`;
  });
  await probe('the tool gateway\'s log and its callers are the AI governor\'s to read, not every officer\'s', 'A01', 'medium', async () => {
    const calls = await http('/ai-gateway/calls', { token: G }); const callers = await http('/ai-gateway/callers', { token: G });
    const edit = await http('/ai-gateway/callers/assistant', { method: 'PUT', token: G, body: JSON.stringify({ enabled: false }) });
    if (calls.status !== 403 || callers.status !== 403 || edit.status !== 403) return `a shipping agent reached the gateway's governance face: ${calls.status}/${callers.status}/${edit.status}`;
    const mine = await http('/ai-gateway/calls?limit=5', { token: A });
    return mine.status === 200 && Array.isArray(mine.body?.data) ? null : `an administrator reading the call log answered ${mine.status}`;
  });
  await probe('what the assistant reads for a person is what that person may read, and no more', 'A01', 'high', async () => {
    const r = await http('/ai/chat', { method: 'POST', token: G, body: JSON.stringify({ message: 'Which user accounts are dormant?' }) });
    if (r.status !== 201) return `the assistant answered ${r.status} to a shipping agent`;
    const refused = (r.body?.data?.refusals ?? []).map((x: { tool: string }) => x.tool);
    const text = String(r.body?.data?.reply ?? '');
    return refused.includes('admin.overview') && !/dormant against the/.test(text) ? null : `a shipping agent asking about dormant accounts got tools ${JSON.stringify(r.body?.data?.tools)} refusals ${JSON.stringify(refused)}`;
  });

  await probe('an explanation is composed from the figures the card sent and nothing else, and refuses what is malformed or oversized', 'A03', 'medium', async () => {
    const ok = await http('/ai/explain', { method: 'POST', token: G, body: JSON.stringify({ kind: 'yardstick', title: 'Anchorage waiting, avg', value: '11.4 h', target: 'target ≤ 4 h', module: 'ops' }) });
    if (ok.status !== 201 || !/11\.4 h/.test(String(ok.body?.data?.text ?? '')) || ok.body?.data?.grounded !== true) return `a shipping agent asking for an explanation got ${ok.status}: ${JSON.stringify(ok.body?.data ?? ok.body).slice(0, 160)}`;
    const bad = await http('/ai/explain', { method: 'POST', token: G, body: JSON.stringify({ kind: 'spreadsheet', title: 'x' }) });
    if (bad.status !== 400) return `an unknown kind of card was accepted with ${bad.status}`;
    const big = await http('/ai/explain', { method: 'POST', token: G, body: JSON.stringify({ kind: 'chart', title: 'x', data: Array.from({ length: 3000 }, (_, i) => ({ month: `m${i}`, note: 'y'.repeat(80), value: i })) }) });
    if (big.status !== 413 && big.status !== 400) return `a payload far larger than any card draws was accepted with ${big.status}`;
    const anon = await http('/ai/explain', { method: 'POST', body: JSON.stringify({ kind: 'stat', title: 'x', value: 1 }) });
    return anon.status === 401 ? null : `an explanation without a session answered ${anon.status}`;
  });

  // ---------------------------------------------------------------- Result
  const bySeverity = (s: Severity) => findings.filter((f) => f.severity === s).length;
  console.log(`\n${'-'.repeat(80)}`);
  console.log(`${ran} probes · ${findings.length} findings (${bySeverity('high')} high, ${bySeverity('medium')} medium, ${bySeverity('low')} low) · ${skipped.length} skipped`);
  for (const s of skipped) console.log(`  skipped: ${s}`);
  for (const f of findings) console.log(`  [${f.owasp} ${f.severity}] ${f.probe}\n      ${f.detail}`);
  process.exit(findings.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
