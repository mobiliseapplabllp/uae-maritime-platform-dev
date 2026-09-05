import type { PoolClient } from 'pg';
import type { IntegrationClient, Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { NAV_STATUS, recordFix, type FixInput } from './tracking';

/*
 * The AIS/LRIT feed, read through the integration hub on a schedule. Every position the counterpart reports is
 * matched to a ship the platform knows (by IMO first, MMSI second) and recorded as a fix; an unknown target is
 * counted and left, because a track store full of ships nobody can name is noise. In stub mode the recorded
 * contract answers with the same three fixes every time, so the fix is stamped now and, for a ship under way, moved
 * along her course by what she would have covered since her last fix — a stub that never moves would make the
 * traffic screen look broken rather than simulated.
 */
export interface FeedPosition { imo?: string; mmsi?: string; lat: number; lon: number; sog?: number; cog?: number; heading?: number; navStatus?: string; destination?: string; at?: string }
export interface FeedPollRow { source: string; last_polled_at: Date | null; last_since: Date | null; last_status: string; last_error: string; last_mode: string; received: number; matched: number; polls: number; updated_at: Date }
export interface PollOutcome { source: string; status: 'ok' | 'failed' | 'unavailable'; mode: string; since: string; received: number; matched: number; skipped: string[]; error?: string }

export const AIS_SOURCE = 'ais-lrit';
const NAV_MAP: Record<string, (typeof NAV_STATUS)[number]> = { UNDER_WAY: 'UNDERWAY', UNDERWAY: 'UNDERWAY', MOORED: 'MOORED', AT_ANCHOR: 'AT_ANCHOR', ANCHORED: 'AT_ANCHOR', RESTRICTED: 'RESTRICTED', RESTRICTED_MANOEUVRABILITY: 'RESTRICTED' };

export const feedApi = (r: FeedPollRow | null, pollMinutes: number) => ({
  source: AIS_SOURCE, pollMinutes, lastPolledAt: r?.last_polled_at?.toISOString() ?? null, lastSince: r?.last_since?.toISOString() ?? null,
  lastStatus: r?.last_status || 'never', lastError: r?.last_error || null, lastMode: r?.last_mode || null, received: r?.received ?? 0, matched: r?.matched ?? 0, polls: r?.polls ?? 0,
  ageMinutes: r?.last_polled_at ? Math.round((Date.now() - r.last_polled_at.getTime()) / 60000) : null,
});

export async function feedState(c: Queryable): Promise<FeedPollRow | null> {
  return (await c.query<FeedPollRow>('SELECT * FROM feed_polls WHERE source = $1', [AIS_SOURCE])).rows[0] ?? null;
}

/** Dead reckoning from the previous fix: distance made good along the course, in degrees of latitude and longitude. */
export function advance(lat: number, lon: number, sogKn: number, cogDeg: number, minutes: number): { lat: number; lon: number } {
  const nm = sogKn * (minutes / 60); const rad = (cogDeg * Math.PI) / 180;
  const dLat = (nm * Math.cos(rad)) / 60; const dLon = (nm * Math.sin(rad)) / (60 * Math.cos((lat * Math.PI) / 180));
  return { lat: Math.round((lat + dLat) * 1e5) / 1e5, lon: Math.round((lon + dLon) * 1e5) / 1e5 };
}

export async function pollAis(c: PoolClient, deps: { env: Env; hub: IntegrationClient }, opts: { now?: Date; correlationId?: string } = {}): Promise<PollOutcome> {
  const now = opts.now ?? new Date();
  const state = await feedState(c);
  const since = state?.last_since ?? new Date(now.getTime() - 60 * 60_000);
  const res = await deps.hub.tryCall<{ positions?: FeedPosition[]; count?: number }>(AIS_SOURCE, 'positions', { since: since.toISOString() }, { correlationId: opts.correlationId ?? 'feed:ais', timeoutMs: 20_000 });
  const finish = async (out: PollOutcome) => {
    await c.query(
      `INSERT INTO feed_polls(source, last_polled_at, last_since, last_status, last_error, last_mode, received, matched, polls, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,now())
       ON CONFLICT (source) DO UPDATE SET last_polled_at = EXCLUDED.last_polled_at, last_since = EXCLUDED.last_since, last_status = EXCLUDED.last_status, last_error = EXCLUDED.last_error,
         last_mode = EXCLUDED.last_mode, received = EXCLUDED.received, matched = EXCLUDED.matched, polls = feed_polls.polls + 1, updated_at = now()`,
      [AIS_SOURCE, now, out.status === 'ok' ? now : since, out.status, out.error ?? '', out.mode, out.received, out.matched]);
    return out;
  };
  if (res.status === 'unavailable') return finish({ source: AIS_SOURCE, status: 'unavailable', mode: '', since: since.toISOString(), received: 0, matched: 0, skipped: [], error: res.error });
  if (res.status !== 'ok') return finish({ source: AIS_SOURCE, status: 'failed', mode: res.mode, since: since.toISOString(), received: 0, matched: 0, skipped: [], error: res.error ?? `call ${res.status}` });
  const positions = Array.isArray(res.data?.positions) ? res.data.positions : [];
  const skipped: string[] = []; let matched = 0;
  for (const p of positions) {
    if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lon))) { skipped.push(`${p.imo ?? p.mmsi ?? '?'}: no position`); continue; }
    const v = await c.query<{ id: string; name: string; mmsi: string }>('SELECT id, name, mmsi FROM vessels WHERE ($1 <> \'\' AND imo = $1) OR ($2 <> \'\' AND mmsi = $2) ORDER BY imo = $1 DESC LIMIT 1', [String(p.imo ?? ''), String(p.mmsi ?? '')]);
    const vessel = v.rows[0];
    if (!vessel) { skipped.push(`${p.imo ?? p.mmsi ?? '?'}: not on the register`); continue; }
    let lat = Number(p.lat); let lon = Number(p.lon);
    const sog = Number(p.sog ?? 0); const cog = Math.round(Number(p.cog ?? 0)) % 360;
    let receivedAt = p.at ? new Date(p.at) : now;
    if (res.mode === 'stub' || Number.isNaN(receivedAt.getTime())) {
      receivedAt = now;
      const prev = await c.query<{ lat: string; lon: string; received_at: Date; source: string }>('SELECT lat, lon, received_at, source FROM positions WHERE vessel_id = $1', [vessel.id]);
      const last = prev.rows[0];
      if (last && last.source.startsWith('AIS (stub') && sog > 0.5) {
        const minutes = Math.min(180, Math.max(0, (now.getTime() - last.received_at.getTime()) / 60000));
        const moved = advance(Number(last.lat), Number(last.lon), sog, cog, minutes); lat = moved.lat; lon = moved.lon;
      }
    }
    const fix: FixInput = {
      vesselId: vessel.id, vesselName: vessel.name, mmsi: String(p.mmsi ?? vessel.mmsi ?? ''), lat, lon, sog, cog, heading: p.heading == null ? cog : Math.round(Number(p.heading)) % 360,
      navStatus: NAV_MAP[String(p.navStatus ?? '').toUpperCase()] ?? 'UNDERWAY', destination: p.destination ?? '', source: res.mode === 'stub' ? 'AIS (stub contract)' : 'AIS/LRIT feed', receivedAt: receivedAt.toISOString(),
    };
    await recordFix(c, deps.env, fix); matched += 1;
  }
  return finish({ source: AIS_SOURCE, status: 'ok', mode: res.mode, since: since.toISOString(), received: positions.length, matched, skipped });
}
