import type { PoolClient } from 'pg';
import type { IntegrationClient, Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { NAV_STATUS, recordFix, type FixInput } from './tracking';
import type { Thresholds } from './surveillance';
import { appendHistory, upsertTargets, type TargetInput } from './targets';

/*
 * The two feeds, read through the integration hub on their own schedules.
 *
 * AIS is the near picture: terrestrial and satellite reports every couple of minutes for every ship the feed hears.
 * LRIT is the far one: under SOLAS V/19-1 every ship on the register reports her position to the flag's data centre
 * four times a day wherever she is, so it is what the picture has of a ship beyond AIS range — read on the half hour
 * since a watermark. Every position either counterpart reports is matched to a ship the platform knows (by IMO first,
 * MMSI second) and recorded as a fix that names its source; an unknown target is counted and drawn, because the
 * picture shows the sea as it is, while a case file, a record and the derived alerts concern only the register's
 * own ships. In stub mode the recorded contract answers with the same fixes every time, so the fix is stamped now
 * and, for a ship under way, moved along her course by what she would have covered since her last fix — a stub that
 * never moves would make the traffic screen look broken rather than simulated.
 */
export interface FeedPosition { imo?: string; mmsi?: string; name?: string; callSign?: string; shipType?: number | null; lat: number; lon: number; sog?: number; cog?: number; heading?: number; navStatus?: string; navStatusCode?: number | null; destination?: string; eta?: string; draught?: number | null; length?: number | null; width?: number | null; at?: string }
export interface FeedPollRow { source: string; last_polled_at: Date | null; last_since: Date | null; last_status: string; last_error: string; last_mode: string; received: number; matched: number; polls: number; updated_at: Date }
export interface PollOutcome { source: string; status: 'ok' | 'failed' | 'unavailable'; mode: string; since: string; received: number; matched: number; /** Every ship the poll reported, on the register or not, now on the picture. */ targets?: number; skipped: string[]; error?: string }

export const AIS_SOURCE = 'ais-lrit';
export const LRIT_SOURCE = 'lrit';
export type FeedSource = typeof AIS_SOURCE | typeof LRIT_SOURCE;
export const FEED_SOURCES: FeedSource[] = [AIS_SOURCE, LRIT_SOURCE];

type Answer = { positions?: FeedPosition[]; reports?: FeedPosition[]; count?: number; source?: string; dataCentre?: string };
interface FeedKind {
  /** The hub adapter the source is read through. */
  adapter: string;
  /** What the feed is called on the screen and in the ledger. */
  label: string;
  /** The source stamped on a fix and a target in stub mode — the word "stub" stays visible on the picture. */
  stubLabel: string;
  /** The source stamped on a fix from the live counterpart. */
  liveFixLabel: string;
  /** The source stamped on a target from the live counterpart, from what the counterpart says of itself. */
  liveTargetLabel: (d: Answer | undefined) => string;
  rows: (d: Answer | undefined) => FeedPosition[];
  /** How far back the first read looks when there is no watermark yet. */
  watermarkMinutes: number;
  pollMinutes: (e: Env) => number;
}
export const FEEDS: Record<FeedSource, FeedKind> = {
  [AIS_SOURCE]: {
    adapter: 'ais-lrit', label: 'AIS/LRIT feed', stubLabel: 'AIS (stub contract)', liveFixLabel: 'AIS/LRIT feed',
    liveTargetLabel: (d) => String(d?.source ?? 'AIS/LRIT feed'),
    rows: (d) => (Array.isArray(d?.positions) ? d.positions : []), watermarkMinutes: 60, pollMinutes: (e) => e.AIS_POLL_MINUTES,
  },
  [LRIT_SOURCE]: {
    adapter: 'lrit', label: 'LRIT data centre', stubLabel: 'LRIT (stub contract)', liveFixLabel: 'LRIT data centre',
    liveTargetLabel: (d) => `LRIT${d?.dataCentre ? ` · ${String(d.dataCentre)}` : ''}`,
    // a data centre answers "reports"; a counterpart speaking the AIS contract's shape is read the same way
    rows: (d) => (Array.isArray(d?.reports) ? d.reports : Array.isArray(d?.positions) ? d.positions : []), watermarkMinutes: 24 * 60, pollMinutes: (e) => e.LRIT_POLL_MINUTES,
  },
};
export const feedSourceOf = (raw: unknown): FeedSource | null => (FEED_SOURCES.includes(String(raw ?? '') as FeedSource) ? (String(raw) as FeedSource) : null);

const NAV_MAP: Record<string, (typeof NAV_STATUS)[number]> = { UNDER_WAY: 'UNDERWAY', UNDERWAY: 'UNDERWAY', UNDER_WAY_SAILING: 'UNDERWAY', MOORED: 'MOORED', AT_ANCHOR: 'AT_ANCHOR', ANCHORED: 'AT_ANCHOR', RESTRICTED: 'RESTRICTED', RESTRICTED_MANOEUVRABILITY: 'RESTRICTED', NOT_UNDER_COMMAND: 'RESTRICTED', CONSTRAINED_BY_DRAUGHT: 'RESTRICTED', AGROUND: 'RESTRICTED' };

export const feedApi = (r: FeedPollRow | null, pollMinutes: number, source: FeedSource = AIS_SOURCE) => ({
  source, label: FEEDS[source].label, pollMinutes, lastPolledAt: r?.last_polled_at?.toISOString() ?? null, lastSince: r?.last_since?.toISOString() ?? null,
  lastStatus: r?.last_status || 'never', lastError: r?.last_error || null, lastMode: r?.last_mode || null, received: r?.received ?? 0, matched: r?.matched ?? 0, polls: r?.polls ?? 0,
  ageMinutes: r?.last_polled_at ? Math.round((Date.now() - r.last_polled_at.getTime()) / 60000) : null,
});

export async function feedState(c: Queryable, source: FeedSource = AIS_SOURCE): Promise<FeedPollRow | null> {
  return (await c.query<FeedPollRow>('SELECT * FROM feed_polls WHERE source = $1', [source])).rows[0] ?? null;
}

/** Dead reckoning from the previous fix: distance made good along the course, in degrees of latitude and longitude. */
export function advance(lat: number, lon: number, sogKn: number, cogDeg: number, minutes: number): { lat: number; lon: number } {
  const nm = sogKn * (minutes / 60); const rad = (cogDeg * Math.PI) / 180;
  const dLat = (nm * Math.cos(rad)) / 60; const dLon = (nm * Math.sin(rad)) / (60 * Math.cos((lat * Math.PI) / 180));
  return { lat: Math.round((lat + dLat) * 1e5) / 1e5, lon: Math.round((lon + dLon) * 1e5) / 1e5 };
}

export async function pollFeed(c: PoolClient, source: FeedSource, deps: { env: Env; hub: IntegrationClient; thresholds?: Thresholds }, opts: { now?: Date; correlationId?: string } = {}): Promise<PollOutcome> {
  const kind = FEEDS[source];
  const now = opts.now ?? new Date();
  const state = await feedState(c, source);
  const since = state?.last_since ?? new Date(now.getTime() - kind.watermarkMinutes * 60_000);
  const res = await deps.hub.tryCall<Answer>(kind.adapter, 'positions', { since: since.toISOString() }, { correlationId: opts.correlationId ?? `feed:${source}`, timeoutMs: 20_000 });
  const finish = async (out: PollOutcome) => {
    await c.query(
      `INSERT INTO feed_polls(source, last_polled_at, last_since, last_status, last_error, last_mode, received, matched, polls, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,now())
       ON CONFLICT (source) DO UPDATE SET last_polled_at = EXCLUDED.last_polled_at, last_since = EXCLUDED.last_since, last_status = EXCLUDED.last_status, last_error = EXCLUDED.last_error,
         last_mode = EXCLUDED.last_mode, received = EXCLUDED.received, matched = EXCLUDED.matched, polls = feed_polls.polls + 1, updated_at = now()`,
      [source, now, out.status === 'ok' ? now : since, out.status, out.error ?? '', out.mode, out.received, out.matched]);
    (out as PollOutcome & { targets?: number }).targets = out.targets ?? 0;
    return out;
  };
  if (res.status === 'unavailable') return finish({ source, status: 'unavailable', mode: '', since: since.toISOString(), received: 0, matched: 0, skipped: [], error: res.error });
  if (res.status !== 'ok') return finish({ source, status: 'failed', mode: res.mode, since: since.toISOString(), received: 0, matched: 0, skipped: [], error: res.error ?? `call ${res.status}` });
  const positions = kind.rows(res.data);
  const skipped: string[] = []; let matched = 0;
  const targets: TargetInput[] = [];
  const stub = res.mode === 'stub';
  const targetLabel = stub ? kind.stubLabel : kind.liveTargetLabel(res.data);
  const fixLabel = stub ? kind.stubLabel : kind.liveFixLabel;
  // the register is read once per poll: a poll from a live stream can carry thousands of ships
  const register = new Map<string, { id: string; name: string; imo: string; mmsi: string; type: string }>();
  for (const v of (await c.query<{ id: string; name: string; imo: string; mmsi: string; type: string }>('SELECT id, name, imo, mmsi, type FROM vessels')).rows) { if (v.imo) register.set(`imo:${v.imo}`, v); if (v.mmsi) register.set(`mmsi:${v.mmsi}`, v); }
  for (const p of positions) {
    if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lon)) || Math.abs(Number(p.lat)) > 90 || Math.abs(Number(p.lon)) > 180) { if (skipped.length < 50) skipped.push(`${p.imo ?? p.mmsi ?? '?'}: no position`); continue; }
    const vessel = register.get(`imo:${String(p.imo ?? '')}`) ?? register.get(`mmsi:${String(p.mmsi ?? '')}`);
    const mmsi = String(p.mmsi ?? vessel?.mmsi ?? '');
    const reportedAt = p.at ? new Date(p.at) : now;
    const at = Number.isNaN(reportedAt.getTime()) || stub ? now : reportedAt;
    if (mmsi || vessel) targets.push({
      mmsi: mmsi || `vessel:${vessel!.id}`, imo: String(p.imo ?? vessel?.imo ?? ''), name: String(p.name ?? vessel?.name ?? ''), callSign: p.callSign ?? '', shipType: p.shipType ?? null, registerType: vessel?.type ?? null,
      lat: Number(p.lat), lon: Number(p.lon), sog: Number(p.sog ?? 0), cog: Math.round(Number(p.cog ?? 0)) % 360, heading: p.heading == null ? null : Math.round(Number(p.heading)) % 360,
      navStatus: String(p.navStatus ?? 'UNDEFINED').toUpperCase(), navStatusCode: p.navStatusCode ?? null, destination: p.destination ?? '', eta: p.eta ?? '', draught: p.draught ?? null, length: p.length ?? null, width: p.width ?? null,
      source: targetLabel, at, vesselId: vessel?.id ?? null,
    });
    if (!vessel) continue;
    let lat = Number(p.lat); let lon = Number(p.lon);
    const sog = Number(p.sog ?? 0); const cog = Math.round(Number(p.cog ?? 0)) % 360;
    let receivedAt = p.at ? new Date(p.at) : now;
    if (stub || Number.isNaN(receivedAt.getTime())) {
      receivedAt = now;
      const prev = await c.query<{ lat: string; lon: string; received_at: Date; source: string }>('SELECT lat, lon, received_at, source FROM positions WHERE vessel_id = $1', [vessel.id]);
      const last = prev.rows[0];
      if (last && last.source === kind.stubLabel && sog > 0.5) {
        const minutes = Math.min(180, Math.max(0, (now.getTime() - last.received_at.getTime()) / 60000));
        const moved = advance(Number(last.lat), Number(last.lon), sog, cog, minutes); lat = moved.lat; lon = moved.lon;
      }
    }
    const fix: FixInput = {
      vesselId: vessel.id, vesselName: vessel.name, mmsi: String(p.mmsi ?? vessel.mmsi ?? ''), lat, lon, sog, cog, heading: p.heading == null ? cog : Math.round(Number(p.heading)) % 360,
      navStatus: NAV_MAP[String(p.navStatus ?? '').toUpperCase()] ?? 'UNDERWAY', destination: p.destination ?? '', source: fixLabel, receivedAt: receivedAt.toISOString(),
    };
    await recordFix(c, deps.env, fix, { thresholds: deps.thresholds }); matched += 1;
  }
  // the picture: every ship reported, the register's own included so the card can show what the feed says about her
  let stored = 0;
  for (let i = 0; i < targets.length; i += 2000) { const batch = targets.slice(i, i + 2000); stored += await upsertTargets(c, batch); await appendHistory(c, batch.filter((t) => !t.vesselId)); }
  return finish({ source, status: 'ok', mode: res.mode, since: since.toISOString(), received: positions.length, matched, targets: stored, skipped });
}

/** The AIS feed, as the scheduler and the desk have always read it. */
export const pollAis = (c: PoolClient, deps: { env: Env; hub: IntegrationClient; thresholds?: Thresholds }, opts: { now?: Date; correlationId?: string } = {}) => pollFeed(c, AIS_SOURCE, deps, opts);
/** The LRIT data centre: the far picture, four reports a day per ship on the register. */
export const pollLrit = (c: PoolClient, deps: { env: Env; hub: IntegrationClient; thresholds?: Thresholds }, opts: { now?: Date; correlationId?: string } = {}) => pollFeed(c, LRIT_SOURCE, deps, opts);
