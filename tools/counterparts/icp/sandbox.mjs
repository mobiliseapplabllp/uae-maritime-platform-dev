#!/usr/bin/env node
/* The ICP sandbox: a counterpart that stands in for the federal authority's port-facility review exchange.
 *
 * The real exchange has no public endpoint and no specification we hold, so this process speaks the contract the
 * platform's adapter declares — SOAP over HTTP, a review submitted and a reference returned at once, the outcome
 * polled later or pushed to the platform's signed inbound address — and nothing else. It exists to prove the live
 * path end to end over the network: the envelope the hub builds, the answer parsed back, the callback signed the
 * way the hub verifies. When the authority's own endpoint and credentials arrive, the switch is the address and the
 * secret in Settings → Integrations; this process is simply stopped.
 *
 * Nothing about a facility is hardcoded: every review is what the platform submitted, the decision timing and the
 * mix of outcomes are configuration, and the outcome for a given reference is drawn deterministically from it so a
 * rerun reads the same. No dependencies — plain Node. */
import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => XML_ESCAPES[c]);
const unesc = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** The text of one element in an envelope the hub built: `<facilityId>…</facilityId>` with any namespace prefix. */
const field = (xml, name) => { const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml); return m ? unesc(m[1].trim()) : ''; };
const envelope = (inner) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
const fault = (code, text) => envelope(`<soap:Fault><faultcode>${esc(code)}</faultcode><faultstring>${esc(text)}</faultstring></soap:Fault>`);

/**
 * The outcomes on the wire are the contract's, the same two the recorded contract and the platform's register know: a
 * review is cleared, with or without conditions attached, or rejected. The mix the sandbox is given names the three
 * ways a review can end — cleared, cleared with conditions, rejected — and the conditions are the authority's own.
 */
export const OUTCOMES = ['CLEARED', 'REJECTED'];
const CONDITIONS = [
  'Access control at the landside gate to be operated to the approved facility security plan',
  'CCTV coverage of the restricted area to be restored within 30 days',
  'Security drill records for the last twelve months to be produced on request',
  'The facility security officer to complete the federal refresher course within 90 days',
];

/** A stable draw in [0, 100) from the reference, so the same submission always meets the same authority. */
const draw = (reference) => createHash('sha256').update(reference).digest().readUInt16BE(0) % 100;

export function createIcpSandbox(opts = {}) {
  const decisionMs = Math.max(0, Number(opts.decisionMs ?? 30_000));
  const mix = normaliseMix(opts.mix ?? [70, 20, 10]);
  const callback = opts.callback && opts.callback.url && opts.callback.secret ? { ...opts.callback } : null;
  const log = opts.log ?? ((m) => process.stdout.write(`${new Date().toISOString()} ${m}\n`));
  const reviews = new Map();
  const timers = new Set();
  let year = () => new Date().getUTCFullYear();

  const outcomeOf = (reference) => { const d = draw(reference); if (d < mix[0]) return { status: 'CLEARED', withConditions: false }; if (d < mix[0] + mix[1]) return { status: 'CLEARED', withConditions: true }; return { status: 'REJECTED', withConditions: false }; };
  const conditionsOf = (reference) => { const d = draw(`${reference}:conditions`); return [CONDITIONS[d % CONDITIONS.length], CONDITIONS[(d + 1) % CONDITIONS.length]].filter((c, i, a) => a.indexOf(c) === i); };

  /** The authority decides: recorded on the review, then pushed to the platform when a callback is configured. */
  async function decide(reference) {
    const r = reviews.get(reference); if (!r || r.status !== 'SUBMITTED') return r;
    const o = outcomeOf(reference);
    r.status = o.status; r.decidedAt = new Date().toISOString(); r.conditions = o.withConditions ? conditionsOf(reference) : [];
    log(`review ${reference} for ${r.facilityId}: ${r.status}`);
    if (callback) await push(r);
    return r;
  }
  async function push(r, attempt = 1) {
    const body = JSON.stringify({ reference: r.reference, facilityId: r.facilityId, status: r.status, decidedAt: r.decidedAt, conditions: r.conditions, event: 'icp.review.decided' });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac('sha256', callback.secret).update(`${ts}.`).update(body).digest('hex')}`;
    try {
      const res = await fetch(callback.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-timestamp': ts, 'x-hub-delivery': r.deliveryId, 'x-hub-event': 'icp.review.decided', 'x-hub-signature': signature }, body, signal: AbortSignal.timeout(10_000) });
      r.callback = { at: new Date().toISOString(), status: res.status, attempt };
      log(`callback for ${r.reference} answered ${res.status}`);
      if (res.status >= 500 && attempt < 5) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      r.callback = { at: new Date().toISOString(), error: String(e.message ?? e), attempt };
      if (attempt < 5) { const t = setTimeout(() => { timers.delete(t); push(r, attempt + 1); }, Math.min(30_000, 1000 * 2 ** attempt)); timers.add(t); }
      else log(`callback for ${r.reference} gave up: ${e.message ?? e}`);
    }
  }

  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://sandbox');
      const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
      const json = (status, body) => send(status, 'application/json', JSON.stringify(body));
      const xml = (status, body) => send(status, 'text/xml; charset=utf-8', body);
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ws/health')) return json(200, { ok: true, counterpart: 'ICP sandbox', reviews: reviews.size, decisionMs, callback: !!callback });
      if (req.method === 'GET' && url.pathname === '/') return json(200, { counterpart: 'ICP sandbox', reviews: [...reviews.values()] });
      if (req.method === 'POST' && url.pathname === '/ws/PortFacilityReview') {
        const facilityId = field(raw, 'facilityId'); const reason = field(raw, 'reason');
        if (!facilityId || !reason) return xml(400, fault('soap:Client', 'facilityId and reason are required'));
        const reference = `ICP-REV-${year()}-${createHash('sha256').update(`${facilityId}:${reason}:${randomUUID()}`).digest('hex').slice(0, 6).toUpperCase()}`;
        const submittedAt = new Date();
        const expectedBy = new Date(submittedAt.getTime() + Math.max(86_400_000, decisionMs)).toISOString().slice(0, 10);
        const r = { reference, facilityId, reason, status: 'SUBMITTED', submittedAt: submittedAt.toISOString(), expectedBy, decidedAt: null, conditions: [], deliveryId: randomUUID(), callback: null };
        reviews.set(reference, r);
        log(`review ${reference} submitted for ${facilityId}: ${reason}`);
        const t = setTimeout(() => { timers.delete(t); decide(reference); }, decisionMs); timers.add(t);
        return xml(202, envelope(`<requestReviewResponse><reference>${esc(reference)}</reference><facilityId>${esc(facilityId)}</facilityId><status>SUBMITTED</status><reason>${esc(reason)}</reason><expectedBy>${expectedBy}</expectedBy></requestReviewResponse>`));
      }
      const m = /^\/ws\/PortFacilityReview\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const r = reviews.get(decodeURIComponent(m[1]));
        if (!r) return xml(404, fault('soap:Client', 'no review with that reference'));
        return xml(200, envelope(`<reviewStatusResponse><reference>${esc(r.reference)}</reference><facilityId>${esc(r.facilityId)}</facilityId><status>${r.status}</status><decidedAt>${r.decidedAt ?? ''}</decidedAt><conditions>${r.conditions.map((c) => `<condition>${esc(c)}</condition>`).join('')}</conditions></reviewStatusResponse>`));
      }
      return json(404, { error: 'not found' });
    });
  });

  return {
    server, reviews, decide, outcomeOf,
    listen(port = 0, host = '127.0.0.1') { return new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))); },
    close() { for (const t of timers) clearTimeout(t); timers.clear(); return new Promise((resolve) => server.close(() => resolve())); },
    /** For a test: the year the references carry. */
    setYear(fn) { year = fn; },
  };
}

function normaliseMix(m) {
  const list = (Array.isArray(m) ? m : String(m).split(',')).map((n) => Math.max(0, Number(n) || 0)).slice(0, 3);
  while (list.length < 3) list.push(0);
  const total = list.reduce((s, n) => s + n, 0) || 1;
  const pct = list.map((n) => (n / total) * 100);
  return pct;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const sandbox = createIcpSandbox({
    decisionMs: Number(env.ICP_SANDBOX_DECISION_SECONDS ?? 30) * 1000,
    mix: env.ICP_SANDBOX_MIX ?? '70,20,10',
    callback: env.HUB_INBOUND_URL && env.HUB_INBOUND_SECRET ? { url: env.HUB_INBOUND_URL, secret: env.HUB_INBOUND_SECRET } : null,
  });
  const port = Number(env.ICP_SANDBOX_PORT ?? 5710); const host = env.ICP_SANDBOX_HOST ?? '127.0.0.1';
  sandbox.listen(port, host).then((a) => {
    process.stdout.write(`ICP sandbox listening on http://${host}:${a.port} — reviews decide after ${Number(env.ICP_SANDBOX_DECISION_SECONDS ?? 30)} s, callback ${env.HUB_INBOUND_URL ? `to ${env.HUB_INBOUND_URL}` : 'not configured'}\n`);
  });
  const stop = () => sandbox.close().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
