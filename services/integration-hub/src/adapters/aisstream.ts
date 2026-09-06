/* The AIS stream.
 *
 * aisstream.io hands out the world's AIS traffic over one websocket: the client connects, sends a subscription naming
 * its key and the boxes of sea it wants, and receives a message per report — a position from a ship under way, her
 * static data (name, type, destination, draught) every few minutes. This collector keeps the last report per ship in
 * memory and answers the AIS adapter's `positions` operation from that buffer, so the track store polls the hub the
 * same way in stub and live mode and never holds the credential itself.
 *
 * The connection is the counterpart's to drop; the collector reconnects with backoff and reports what it sees, and a
 * ship not heard from for six hours is forgotten. Nothing here is a vendor secret: the protocol is the public one the
 * counterpart documents, read as strings and numbers with a default for every field it might leave out. */

export interface StreamConfig {
  url: string;
  apiKey: string;
  /** Boxes of sea, each `[[south, west], [north, east]]` in degrees — the counterpart's own order. */
  boundingBoxes: [number, number][][];
  /** How long a ship is remembered after her last report. */
  forgetAfterMs?: number;
  /** Class B is small craft; off by default to keep the buffer to the ships the desk cares about. */
  classB?: boolean;
}
export interface StreamTarget {
  mmsi: string; imo: string; name: string; callSign: string; shipType: number | null;
  lat: number; lon: number; sog: number; cog: number; heading: number | null; navStatusCode: number | null; navStatus: string;
  destination: string; eta: string; draught: number | null; length: number | null; width: number | null;
  /** When the position was reported, and when the static data last arrived. */
  at: string; staticAt: string | null;
}
export interface StreamStats { running: boolean; connected: boolean; connectedAt: string | null; lastMessageAt: string | null; messages: number; positions: number; statics: number; targets: number; reconnects: number; lastError: string; boxes: number }

const NAV_STATUS: Record<number, string> = {
  0: 'UNDER_WAY', 1: 'AT_ANCHOR', 2: 'NOT_UNDER_COMMAND', 3: 'RESTRICTED', 4: 'CONSTRAINED_BY_DRAUGHT', 5: 'MOORED', 6: 'AGROUND', 7: 'FISHING', 8: 'UNDER_WAY_SAILING', 11: 'TOWING_ASTERN', 12: 'PUSHING_AHEAD', 14: 'AIS_SART', 15: 'UNDEFINED',
};
export const navStatusOf = (code: number | null | undefined): string => (code == null ? 'UNDEFINED' : NAV_STATUS[code] ?? 'UNDEFINED');
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v: unknown): string => (v == null ? '' : String(v).replace(/@+$/g, '').trim());

type Row = Record<string, any>;
/** One message from the stream, in the counterpart's shape: a type, the ship's metadata, and the report under its type name. */
export function parseMessage(raw: string): { type: string; meta: Row; body: Row } | null {
  let m: Row;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const type = str(m.MessageType);
  const body = (m.Message && typeof m.Message === 'object' ? m.Message[type] : null) ?? {};
  return { type, meta: m.MetaData && typeof m.MetaData === 'object' ? m.MetaData : {}, body };
}

/** The subscription the counterpart expects, as JSON text. */
export function subscription(cfg: StreamConfig): string {
  const types = ['PositionReport', 'ShipStaticData', ...(cfg.classB ? ['StandardClassBPositionReport', 'StaticDataReport'] : [])];
  return JSON.stringify({ APIKey: cfg.apiKey, BoundingBoxes: cfg.boundingBoxes, FilterMessageTypes: types });
}

export class AisStreamCollector {
  private targets = new Map<string, StreamTarget>();
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private attempt = 0;
  private stats: StreamStats = { running: false, connected: false, connectedAt: null, lastMessageAt: null, messages: 0, positions: 0, statics: 0, targets: 0, reconnects: 0, lastError: '', boxes: 0 };
  constructor(private cfg: StreamConfig, private readonly log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void } = { info() {}, warn() {} }) { this.stats.boxes = cfg.boundingBoxes.length; }

  /** The same stream with a new key or new boxes: reconnect; anything else is a no-op. */
  configure(cfg: StreamConfig) {
    const changed = cfg.url !== this.cfg.url || cfg.apiKey !== this.cfg.apiKey || JSON.stringify(cfg.boundingBoxes) !== JSON.stringify(this.cfg.boundingBoxes) || !!cfg.classB !== !!this.cfg.classB;
    this.cfg = cfg; this.stats.boxes = cfg.boundingBoxes.length;
    if (changed && this.running) { this.closeSocket(); this.connect(); }
  }
  start() {
    if (this.running) return;
    this.running = true; this.stats.running = true; this.attempt = 0;
    this.connect();
    this.sweeper = setInterval(() => this.forget(), 60_000);
  }
  stop() {
    this.running = false; this.stats.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
    this.closeSocket();
  }
  private closeSocket() {
    const s = this.socket; this.socket = null;
    if (s) { try { s.onclose = null; s.onerror = null; s.onmessage = null; s.close(); } catch { /* already gone */ } }
    this.stats.connected = false;
  }
  private connect() {
    if (!this.running) return;
    let s: WebSocket;
    try { s = new WebSocket(this.cfg.url); } catch (e) { this.fail((e as Error).message); return; }
    this.socket = s;
    s.onopen = () => {
      this.attempt = 0; this.stats.connected = true; this.stats.connectedAt = new Date().toISOString();
      try { s.send(subscription(this.cfg)); } catch (e) { this.fail((e as Error).message); }
      this.log.info({ boxes: this.cfg.boundingBoxes.length }, 'AIS stream connected');
    };
    s.onmessage = (ev) => { this.ingest(typeof ev.data === 'string' ? ev.data : String(ev.data)); };
    s.onerror = () => { this.stats.lastError = 'socket error'; };
    s.onclose = (ev) => {
      if (this.socket !== s) return;
      this.socket = null; this.stats.connected = false;
      if (ev.code !== 1000 && ev.reason) { this.stats.lastError = `${ev.code} ${ev.reason}`; if (ev.code === 1008) this.attempt = Math.max(this.attempt, 6); }
      this.reconnect();
    };
  }
  private fail(message: string) { this.stats.lastError = message; this.stats.connected = false; this.socket = null; this.reconnect(); }
  private reconnect() {
    if (!this.running || this.timer) return;
    this.attempt += 1; this.stats.reconnects += 1;
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(6, this.attempt - 1)) + Math.round(Math.random() * 500);
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, wait);
  }

  /** Folds one message into the buffer. Exposed so the protocol can be tested without a socket. */
  ingest(raw: string) {
    const m = parseMessage(raw);
    if (!m) return;
    this.stats.messages += 1;
    if (!m.type) {
      // the counterpart's own complaint — a bad key, a malformed subscription — arrives as a message without a type
      let err: unknown; try { err = (JSON.parse(raw) as Row).error; } catch { err = undefined; }
      if (err) { this.stats.lastError = String(err); if (/key/i.test(String(err))) this.attempt = Math.max(this.attempt, 6); }
      return;
    }
    const mmsi = str(m.meta.MMSI ?? m.body.UserID);
    if (!mmsi) return;
    this.stats.lastMessageAt = new Date().toISOString(); this.stats.lastError = '';
    const cur = this.targets.get(mmsi) ?? { mmsi, imo: '', name: '', callSign: '', shipType: null, lat: NaN, lon: NaN, sog: 0, cog: 0, heading: null, navStatusCode: null, navStatus: 'UNDEFINED', destination: '', eta: '', draught: null, length: null, width: null, at: '', staticAt: null };
    if (m.type === 'PositionReport' || m.type === 'StandardClassBPositionReport') {
      const lat = num(m.body.Latitude ?? m.meta.latitude); const lon = num(m.body.Longitude ?? m.meta.longitude);
      if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      const heading = num(m.body.TrueHeading); const code = num(m.body.NavigationalStatus);
      Object.assign(cur, {
        lat, lon, sog: Math.min(102, Math.max(0, num(m.body.Sog) ?? 0)), cog: Math.round(((num(m.body.Cog) ?? 0) % 360 + 360) % 360),
        heading: heading != null && heading < 360 ? Math.round(heading) : null,
        navStatusCode: code, navStatus: navStatusOf(code), at: this.timeOf(m.meta),
        name: cur.name || str(m.meta.ShipName),
      });
      this.stats.positions += 1;
    } else if (m.type === 'ShipStaticData' || m.type === 'StaticDataReport') {
      const d = m.body.Dimension && typeof m.body.Dimension === 'object' ? m.body.Dimension : {};
      const a = num(d.A) ?? 0, b = num(d.B) ?? 0, c = num(d.C) ?? 0, dd = num(d.D) ?? 0;
      const eta = m.body.Eta && typeof m.body.Eta === 'object' ? m.body.Eta : null;
      Object.assign(cur, {
        name: str(m.body.Name) || cur.name, callSign: str(m.body.CallSign) || cur.callSign, imo: num(m.body.ImoNumber) ? String(m.body.ImoNumber) : cur.imo,
        shipType: num(m.body.Type) ?? cur.shipType, destination: str(m.body.Destination) || cur.destination,
        draught: num(m.body.MaximumStaticDraught) ?? cur.draught, length: a + b > 0 ? a + b : cur.length, width: c + dd > 0 ? c + dd : cur.width,
        eta: eta && num(eta.Month) ? `${String(eta.Month).padStart(2, '0')}-${String(eta.Day ?? 0).padStart(2, '0')} ${String(eta.Hour ?? 0).padStart(2, '0')}:${String(eta.Minute ?? 0).padStart(2, '0')}` : cur.eta,
        staticAt: new Date().toISOString(),
      });
      this.stats.statics += 1;
    } else return;
    this.targets.set(mmsi, cur);
    this.stats.targets = this.targets.size;
  }
  private timeOf(meta: Row): string {
    // "2024-01-01 12:00:00.123456789 +0000 UTC" is what the counterpart writes; anything unreadable is now
    const t = str(meta.time_utc);
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?\d*\s*(?:\+0000|Z|UTC)?/.exec(t);
    if (m) return `${m[1]}T${m[2]}${m[3] ? `.${m[3].padEnd(3, '0')}` : ''}Z`;
    return new Date().toISOString();
  }
  private forget() {
    const cutoff = Date.now() - (this.cfg.forgetAfterMs ?? 6 * 3_600_000);
    for (const [k, t] of this.targets) if (!t.at || new Date(t.at).getTime() < cutoff) this.targets.delete(k);
    this.stats.targets = this.targets.size;
  }

  /** Every ship with a position, or only those reported since a watermark. */
  snapshot(since?: Date | null): StreamTarget[] {
    const floor = since ? since.getTime() : 0;
    const out: StreamTarget[] = [];
    for (const t of this.targets.values()) if (Number.isFinite(t.lat) && (!floor || new Date(t.at).getTime() >= floor)) out.push({ ...t });
    return out;
  }
  status(): StreamStats { return { ...this.stats, targets: this.targets.size }; }
}

/** The `positions` answer the track store already understands, from the buffer. */
export function positionsAnswer(targets: StreamTarget[], since: string) {
  return {
    since, source: 'aisstream', count: targets.length,
    positions: targets.map((t) => ({
      imo: t.imo, mmsi: t.mmsi, name: t.name, callSign: t.callSign, shipType: t.shipType, lat: t.lat, lon: t.lon, sog: t.sog, cog: t.cog, heading: t.heading ?? undefined,
      navStatus: t.navStatus, navStatusCode: t.navStatusCode, destination: t.destination, eta: t.eta, draught: t.draught, length: t.length, width: t.width, at: t.at,
    })),
  };
}

/** The boxes an adapter row carries, or the Gulf, the Gulf of Oman and the Arabian Sea approaches when it carries none. */
export const DEFAULT_BOXES: [number, number][][] = [[[5, 42], [32, 80]]];
export function boxesOf(schedule: Record<string, unknown> | null | undefined): [number, number][][] {
  const raw = schedule?.boundingBoxes;
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_BOXES;
  const boxes: [number, number][][] = [];
  for (const b of raw) {
    if (!Array.isArray(b) || b.length !== 2) continue;
    const sw = b[0], ne = b[1];
    if (!Array.isArray(sw) || !Array.isArray(ne)) continue;
    const s = Number(sw[0]), w = Number(sw[1]), n = Number(ne[0]), e = Number(ne[1]);
    if ([s, w, n, e].some((v) => !Number.isFinite(v)) || s >= n || w >= e || Math.abs(s) > 90 || Math.abs(n) > 90 || Math.abs(w) > 180 || Math.abs(e) > 180) continue;
    boxes.push([[s, w], [n, e]]);
  }
  return boxes.length ? boxes : DEFAULT_BOXES;
}
export const isStreamUrl = (url: string | null | undefined) => /^wss?:\/\//i.test(String(url ?? ''));

/** One short subscription to prove the key and the address: the first message wins, silence or a close loses. */
export function probeStream(cfg: StreamConfig, timeoutMs = 8000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let done = false; let messages = 0; const started = Date.now();
    const finish = (ok: boolean, detail: string) => { if (done) return; done = true; clearTimeout(timer); try { s.close(); } catch { /* closed */ } resolve({ ok, detail }); };
    let s: WebSocket;
    try { s = new WebSocket(cfg.url); } catch (e) { resolve({ ok: false, detail: (e as Error).message }); return; }
    const timer = setTimeout(() => finish(messages > 0, messages > 0 ? `${messages} message(s) in ${timeoutMs} ms` : `no message within ${timeoutMs} ms — the key may be wrong or the boxes empty`), timeoutMs);
    s.onopen = () => { try { s.send(subscription(cfg)); } catch (e) { finish(false, (e as Error).message); } };
    s.onmessage = (ev) => {
      messages += 1;
      const m = parseMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m && (m.type === 'PositionReport' || m.type === 'ShipStaticData' || m.type === 'StandardClassBPositionReport')) finish(true, `first ${m.type} after ${Date.now() - started} ms`);
      else if (m && /error/i.test(m.type)) finish(false, `the stream answered ${m.type}: ${JSON.stringify(m.body).slice(0, 200)}`);
      else if (!m && /error/i.test(String(ev.data))) finish(false, String(ev.data).slice(0, 200));
    };
    s.onerror = () => finish(false, 'the stream refused the connection');
    s.onclose = (ev) => finish(false, ev.reason ? `closed: ${ev.code} ${ev.reason}` : `closed (${ev.code}) before any message`);
  });
}
