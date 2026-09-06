import type { Queryable } from '@maritime/service-kit';
import { iso } from './incidents';

/* Every ship the feed reports, on our register or not.
 *
 * The picture draws all of them; only a ship on our register has a case file, a record and the derived alerts. A
 * target carries what AIS says about her — identity, type, destination, draught, dimensions — and the last fix;
 * a thinned track is kept for two days so a past track can be drawn for any of them. The legend's colour classes
 * follow the ship-type code the AIS static data carries, mapped the way the trade maps them. */

export type Category = 'cargo' | 'tanker' | 'passenger' | 'highspeed' | 'tug' | 'fishing' | 'pleasure' | 'other';
export const CATEGORIES: Category[] = ['cargo', 'tanker', 'passenger', 'highspeed', 'tug', 'fishing', 'pleasure', 'other'];
export const CATEGORY_LABEL: Record<Category, string> = { cargo: 'Cargo', tanker: 'Tanker', passenger: 'Passenger', highspeed: 'High-speed craft', tug: 'Tug & special craft', fishing: 'Fishing', pleasure: 'Pleasure craft & sailing', other: 'Other & unspecified' };

/** ITU-R M.1371 ship-type codes → the legend's class and a label. */
export function categoryOfCode(code: number | null | undefined): { category: Category; label: string } {
  const c = Number(code);
  if (!Number.isFinite(c) || c <= 0) return { category: 'other', label: 'Unspecified' };
  if (c >= 70 && c <= 79) return { category: 'cargo', label: c === 70 ? 'Cargo' : c >= 71 && c <= 74 ? `Cargo, hazardous category ${'ABCD'[c - 71]}` : 'Cargo' };
  if (c >= 80 && c <= 89) return { category: 'tanker', label: c === 80 ? 'Tanker' : c >= 81 && c <= 84 ? `Tanker, hazardous category ${'ABCD'[c - 81]}` : 'Tanker' };
  if (c >= 60 && c <= 69) return { category: 'passenger', label: 'Passenger' };
  if (c >= 40 && c <= 49) return { category: 'highspeed', label: 'High-speed craft' };
  if (c === 30) return { category: 'fishing', label: 'Fishing' };
  if (c === 36 || c === 37) return { category: 'pleasure', label: c === 36 ? 'Sailing' : 'Pleasure craft' };
  if (c === 31 || c === 32) return { category: 'tug', label: 'Towing' };
  if (c === 33) return { category: 'tug', label: 'Dredger / underwater operations' };
  if (c === 34) return { category: 'tug', label: 'Diving operations' };
  if (c === 35) return { category: 'other', label: 'Military' };
  if (c === 50) return { category: 'tug', label: 'Pilot vessel' };
  if (c === 51) return { category: 'tug', label: 'Search and rescue' };
  if (c === 52) return { category: 'tug', label: 'Tug' };
  if (c === 53) return { category: 'tug', label: 'Port tender' };
  if (c === 54) return { category: 'tug', label: 'Anti-pollution' };
  if (c === 55) return { category: 'tug', label: 'Law enforcement' };
  if (c === 58) return { category: 'tug', label: 'Medical transport' };
  if (c === 59) return { category: 'other', label: 'Non-combatant' };
  if (c >= 20 && c <= 29) return { category: 'highspeed', label: 'Wing in ground' };
  if (c >= 90 && c <= 99) return { category: 'other', label: 'Other' };
  return { category: 'other', label: 'Unspecified' };
}
/** Our own register's type codes → the same classes. */
export function categoryOfRegisterType(type: string | null | undefined): Category {
  const t = String(type ?? '').toUpperCase();
  if (/TANK|CRUDE|PROD|LPG|LNG|CHEM/.test(t)) return 'tanker';
  if (/PASS|CRUISE|FERRY|PAX/.test(t)) return 'passenger';
  if (/TUG|PILOT|OSV|SUPPLY|DREDG|WORK|SURVEY|PATROL|SAR/.test(t)) return 'tug';
  if (/FISH/.test(t)) return 'fishing';
  if (/YACHT|SAIL|PLEAS/.test(t)) return 'pleasure';
  if (/HSC|FAST|HIGH/.test(t)) return 'highspeed';
  if (/BULK|CONT|GEN|RORO|CAR|CARGO|REEF|HEAVY|BARGE|LIVE|CEMENT|OFF|OTHER/.test(t)) return 'cargo';
  return t ? 'cargo' : 'other';
}

/** Maritime identification digits → the flag on a card. The common ones; a code outside the table shows no flag. */
const MID: Record<string, string> = {
  201: 'AL', 202: 'AD', 203: 'AT', 204: 'PT', 205: 'BE', 206: 'BY', 207: 'BG', 208: 'VA', 209: 'CY', 210: 'CY', 211: 'DE', 212: 'CY', 213: 'GE', 214: 'MD', 215: 'MT', 216: 'AM', 218: 'DE', 219: 'DK', 220: 'DK', 224: 'ES', 225: 'ES', 226: 'FR', 227: 'FR', 228: 'FR', 229: 'MT', 230: 'FI', 231: 'FO', 232: 'GB', 233: 'GB', 234: 'GB', 235: 'GB', 236: 'GI', 237: 'GR', 238: 'HR', 239: 'GR', 240: 'GR', 241: 'GR', 242: 'MA', 243: 'HU', 244: 'NL', 245: 'NL', 246: 'NL', 247: 'IT', 248: 'MT', 249: 'MT', 250: 'IE', 251: 'IS', 252: 'LI', 253: 'LU', 254: 'MC', 255: 'PT', 256: 'MT', 257: 'NO', 258: 'NO', 259: 'NO', 261: 'PL', 262: 'ME', 263: 'PT', 264: 'RO', 265: 'SE', 266: 'SE', 267: 'SK', 268: 'SM', 269: 'CH', 270: 'CZ', 271: 'TR', 272: 'UA', 273: 'RU', 274: 'MK', 275: 'LV', 276: 'EE', 277: 'LT', 278: 'SI', 279: 'RS',
  301: 'AI', 303: 'US', 304: 'AG', 305: 'AG', 306: 'CW', 307: 'AW', 308: 'BS', 309: 'BS', 310: 'BM', 311: 'BS', 312: 'BZ', 314: 'BB', 316: 'CA', 319: 'KY', 321: 'CR', 323: 'CU', 325: 'DM', 327: 'DO', 329: 'GP', 330: 'GD', 331: 'GL', 332: 'GT', 334: 'HN', 336: 'HT', 338: 'US', 339: 'JM', 341: 'KN', 343: 'LC', 345: 'MX', 347: 'MQ', 348: 'MS', 350: 'NI', 351: 'PA', 352: 'PA', 353: 'PA', 354: 'PA', 355: 'PA', 356: 'PA', 357: 'PA', 358: 'PR', 359: 'SV', 361: 'PM', 362: 'TT', 364: 'TC', 366: 'US', 367: 'US', 368: 'US', 369: 'US', 370: 'PA', 371: 'PA', 372: 'PA', 373: 'PA', 374: 'PA', 375: 'VC', 376: 'VC', 377: 'VC', 378: 'VG', 379: 'VI',
  401: 'AF', 403: 'SA', 405: 'BD', 408: 'BH', 410: 'BT', 412: 'CN', 413: 'CN', 414: 'CN', 416: 'TW', 417: 'LK', 419: 'IN', 422: 'IR', 423: 'AZ', 425: 'IQ', 428: 'IL', 431: 'JP', 432: 'JP', 434: 'TM', 436: 'KZ', 437: 'UZ', 438: 'JO', 440: 'KR', 441: 'KR', 443: 'PS', 445: 'KP', 447: 'KW', 450: 'LB', 451: 'KG', 453: 'MO', 455: 'MV', 457: 'MN', 459: 'NP', 461: 'OM', 463: 'PK', 466: 'QA', 468: 'SY', 470: 'AE', 471: 'AE', 472: 'TJ', 473: 'YE', 475: 'YE', 477: 'HK', 478: 'BA',
  501: 'AQ', 503: 'AU', 506: 'MM', 508: 'BN', 510: 'FM', 511: 'PW', 512: 'NZ', 514: 'KH', 515: 'KH', 516: 'CX', 518: 'CK', 520: 'FJ', 523: 'CC', 525: 'ID', 529: 'KI', 531: 'LA', 533: 'MY', 536: 'MP', 538: 'MH', 540: 'NC', 542: 'NU', 544: 'NR', 546: 'PF', 548: 'PH', 553: 'PG', 555: 'PN', 557: 'SB', 559: 'AS', 561: 'WS', 563: 'SG', 564: 'SG', 565: 'SG', 566: 'SG', 567: 'TH', 570: 'TO', 572: 'TV', 574: 'VN', 576: 'VU', 577: 'VU', 578: 'WF',
  601: 'ZA', 603: 'AO', 605: 'DZ', 607: 'TF', 608: 'IO', 609: 'BI', 610: 'BJ', 611: 'BW', 612: 'CF', 613: 'CM', 615: 'CG', 616: 'KM', 617: 'CV', 618: 'AQ', 619: 'CI', 620: 'KM', 621: 'DJ', 622: 'EG', 624: 'ET', 625: 'ER', 626: 'GA', 627: 'GH', 629: 'GM', 630: 'GW', 631: 'GQ', 632: 'GN', 633: 'BF', 634: 'KE', 635: 'AQ', 636: 'LR', 637: 'LR', 638: 'SS', 642: 'LY', 644: 'LS', 645: 'MU', 647: 'MG', 649: 'ML', 650: 'MZ', 654: 'MR', 655: 'MW', 656: 'NE', 657: 'NG', 659: 'NA', 660: 'RE', 661: 'RW', 662: 'SD', 663: 'SN', 664: 'SC', 665: 'SH', 666: 'SO', 667: 'SL', 668: 'ST', 669: 'SZ', 670: 'TD', 671: 'TG', 672: 'TN', 674: 'TZ', 675: 'UG', 676: 'CD', 677: 'TZ', 678: 'ZM', 679: 'ZW',
  701: 'AR', 710: 'BR', 720: 'BO', 725: 'CL', 730: 'CO', 735: 'EC', 740: 'FK', 745: 'GF', 750: 'GY', 755: 'PY', 760: 'PE', 765: 'SR', 770: 'UY', 775: 'VE',
};
export const flagOfMmsi = (mmsi: string | null | undefined): string | null => { const m = /^(\d{3})\d{6}$/.exec(String(mmsi ?? '')); return m ? MID[m[1]] ?? null : null; };

export interface TargetInput {
  mmsi: string; imo?: string; name?: string; callSign?: string; shipType?: number | null; registerType?: string | null;
  lat: number; lon: number; sog?: number; cog?: number; heading?: number | null; navStatus?: string; navStatusCode?: number | null;
  destination?: string; eta?: string; draught?: number | null; length?: number | null; width?: number | null; source: string; at: Date; vesselId?: string | null;
}
export interface TargetRow {
  mmsi: string; imo: string; name: string; call_sign: string; ship_type: number | null; category: string; type_label: string; lat: string | number; lon: string | number;
  sog: string | number; cog: number; heading: number | null; nav_status: string; nav_status_code: number | null; destination: string; eta: string; draught: string | number | null;
  length: number | null; width: number | null; source: string; vessel_id: string | null; received_at: Date; updated_at: Date;
  /** Joined from the register when she is on it. */
  vessel_name?: string | null; vessel_type?: string | null; vessel_flag?: string | null; vessel_imo?: string | null; vessel_status?: string | null;
}

const classOf = (t: TargetInput) => (t.shipType != null ? categoryOfCode(t.shipType) : t.registerType ? { category: categoryOfRegisterType(t.registerType), label: String(t.registerType) } : { category: 'other' as Category, label: 'Unspecified' });

/** One statement for the whole batch: the feed hands over thousands at a time. New facts replace old ones; a blank never overwrites a fact. */
export async function upsertTargets(c: Queryable, input: TargetInput[]): Promise<number> {
  // one row per ship in the statement: a batch that names her twice keeps her latest report
  const latest = new Map<string, TargetInput>();
  for (const t of input) { const prev = latest.get(t.mmsi); if (!prev || t.at.getTime() >= prev.at.getTime()) latest.set(t.mmsi, t); }
  const rows = [...latest.values()];
  if (!rows.length) return 0;
  const col = <T,>(f: (t: TargetInput) => T) => rows.map(f);
  const cls = rows.map(classOf);
  const r = await c.query(
    `INSERT INTO ais_targets(mmsi, imo, name, call_sign, ship_type, category, type_label, lat, lon, sog, cog, heading, nav_status, nav_status_code, destination, eta, draught, length, width, source, vessel_id, received_at, updated_at)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[], $11::int[], $12::int[], $13::text[], $14::int[], $15::text[], $16::text[], $17::numeric[], $18::int[], $19::int[], $20::text[], $21::text[], $22::timestamptz[], $23::timestamptz[])
     ON CONFLICT (mmsi) DO UPDATE SET
       imo = CASE WHEN EXCLUDED.imo <> '' THEN EXCLUDED.imo ELSE ais_targets.imo END, name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE ais_targets.name END,
       call_sign = CASE WHEN EXCLUDED.call_sign <> '' THEN EXCLUDED.call_sign ELSE ais_targets.call_sign END,
       ship_type = COALESCE(EXCLUDED.ship_type, ais_targets.ship_type), category = CASE WHEN EXCLUDED.ship_type IS NOT NULL OR EXCLUDED.vessel_id IS NOT NULL THEN EXCLUDED.category ELSE ais_targets.category END,
       type_label = CASE WHEN EXCLUDED.type_label <> '' AND EXCLUDED.type_label <> 'Unspecified' THEN EXCLUDED.type_label ELSE ais_targets.type_label END,
       lat = EXCLUDED.lat, lon = EXCLUDED.lon, sog = EXCLUDED.sog, cog = EXCLUDED.cog, heading = COALESCE(EXCLUDED.heading, ais_targets.heading),
       nav_status = EXCLUDED.nav_status, nav_status_code = COALESCE(EXCLUDED.nav_status_code, ais_targets.nav_status_code),
       destination = CASE WHEN EXCLUDED.destination <> '' THEN EXCLUDED.destination ELSE ais_targets.destination END, eta = CASE WHEN EXCLUDED.eta <> '' THEN EXCLUDED.eta ELSE ais_targets.eta END,
       draught = COALESCE(EXCLUDED.draught, ais_targets.draught), length = COALESCE(EXCLUDED.length, ais_targets.length), width = COALESCE(EXCLUDED.width, ais_targets.width),
       source = EXCLUDED.source, vessel_id = COALESCE(EXCLUDED.vessel_id, ais_targets.vessel_id), received_at = GREATEST(EXCLUDED.received_at, ais_targets.received_at), updated_at = now()`,
    [col((t) => t.mmsi), col((t) => t.imo ?? ''), col((t) => t.name ?? ''), col((t) => t.callSign ?? ''), col((t) => t.shipType ?? null), cls.map((x) => x.category), cls.map((x) => x.label),
      col((t) => t.lat), col((t) => t.lon), col((t) => t.sog ?? 0), col((t) => Math.round(t.cog ?? 0)), col((t) => (t.heading == null ? null : Math.round(t.heading))), col((t) => t.navStatus ?? 'UNDEFINED'), col((t) => t.navStatusCode ?? null),
      col((t) => t.destination ?? ''), col((t) => t.eta ?? ''), col((t) => t.draught ?? null), col((t) => t.length ?? null), col((t) => t.width ?? null), col((t) => t.source), col((t) => t.vesselId ?? null), col((t) => t.at), col(() => new Date())]);
  return r.rowCount ?? 0;
}

/** A track point every few minutes: the batch is thinned per ship against its own points and the last one stored. */
export async function appendHistory(c: Queryable, rows: TargetInput[], minGapMinutes = 5): Promise<number> {
  if (!rows.length) return 0;
  const gap = minGapMinutes * 60_000;
  const last = new Map<string, number>();
  const stored = await c.query<{ mmsi: string; at: Date }>('SELECT mmsi, max(received_at) AS at FROM ais_target_history WHERE mmsi = ANY($1) GROUP BY mmsi', [[...new Set(rows.map((r) => r.mmsi))]]);
  for (const r of stored.rows) last.set(r.mmsi, new Date(r.at).getTime());
  const kept: TargetInput[] = [];
  for (const r of [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const prev = last.get(r.mmsi);
    if (prev !== undefined && r.at.getTime() - prev < gap) continue;
    last.set(r.mmsi, r.at.getTime()); kept.push(r);
  }
  if (!kept.length) return 0;
  const r = await c.query(
    `INSERT INTO ais_target_history(mmsi, lat, lon, sog, cog, received_at)
     SELECT * FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::int[], $6::timestamptz[]) ON CONFLICT DO NOTHING`,
    [kept.map((t) => t.mmsi), kept.map((t) => t.lat), kept.map((t) => t.lon), kept.map((t) => t.sog ?? 0), kept.map((t) => Math.round(t.cog ?? 0)), kept.map((t) => t.at)]);
  return r.rowCount ?? 0;
}

/** Two days of track, one day of silence: what the store keeps. */
export async function pruneTargets(c: Queryable, opts: { historyHours?: number; silentHours?: number } = {}): Promise<{ history: number; targets: number }> {
  const h = await c.query(`DELETE FROM ais_target_history WHERE received_at < now() - ($1::text || ' hours')::interval`, [String(opts.historyHours ?? 48)]);
  const t = await c.query(`DELETE FROM ais_targets WHERE vessel_id IS NULL AND received_at < now() - ($1::text || ' hours')::interval`, [String(opts.silentHours ?? 24)]);
  return { history: h.rowCount ?? 0, targets: t.rowCount ?? 0 };
}

export const targetApi = (t: TargetRow, now = Date.now()) => {
  const registered = !!t.vessel_id;
  const category = (registered && t.vessel_type ? categoryOfRegisterType(t.vessel_type) : (t.category as Category)) || 'other';
  return {
    mmsi: t.mmsi, imo: t.imo || t.vessel_imo || '', name: (registered && t.vessel_name) || t.name || (t.mmsi ? `MMSI ${t.mmsi}` : 'Unknown target'), callSign: t.call_sign,
    shipType: t.ship_type, category, typeLabel: registered && t.vessel_type ? t.vessel_type : t.type_label || CATEGORY_LABEL[category],
    flag: (registered && t.vessel_flag) || flagOfMmsi(t.mmsi), lat: Number(t.lat), lon: Number(t.lon), sog: Number(t.sog), cog: t.cog, heading: t.heading,
    navStatus: t.nav_status, navStatusCode: t.nav_status_code, destination: t.destination, eta: t.eta, draught: t.draught == null ? null : Number(t.draught), length: t.length, width: t.width,
    source: t.source, receivedAt: iso(t.received_at)!, ageMinutes: Math.round((now - new Date(t.received_at).getTime()) / 60_000),
    registered, vesselId: t.vessel_id, vesselStatus: t.vessel_status ?? null,
  };
};
export type TargetApi = ReturnType<typeof targetApi>;

export interface Bbox { minLat: number; maxLat: number; minLon: number; maxLon: number }
export interface Cluster { lat: number; lon: number; count: number; categories: Record<string, number> }

/* The picture merges the register's own positions (the truth for our fleet) with every other target the feed reported. */
const UNION = `
  SELECT COALESCE(NULLIF(p.mmsi, ''), 'vessel:' || p.vessel_id) AS mmsi, v.imo, p.vessel_name AS name, '' AS call_sign, NULL::int AS ship_type, '' AS category, '' AS type_label, p.lat, p.lon, p.sog, p.cog, p.heading,
         p.nav_status, NULL::int AS nav_status_code, p.destination, '' AS eta, NULL::numeric AS draught, NULL::int AS length, NULL::int AS width, p.source, p.vessel_id, p.received_at, p.updated_at,
         v.name AS vessel_name, v.type AS vessel_type, v.flag AS vessel_flag, v.imo AS vessel_imo, v.status AS vessel_status
    FROM positions p LEFT JOIN vessels v ON v.id = p.vessel_id
  UNION ALL
  SELECT t.mmsi, t.imo, t.name, t.call_sign, t.ship_type, t.category, t.type_label, t.lat, t.lon, t.sog, t.cog, t.heading, t.nav_status, t.nav_status_code, t.destination, t.eta, t.draught, t.length, t.width, t.source, NULL, t.received_at, t.updated_at,
         NULL, NULL, NULL, NULL, NULL
    FROM ais_targets t WHERE t.vessel_id IS NULL`;

/** The targets in a window, or — when there are more than a screen can show — the clusters they fall into. */
export async function targetsWithin(c: Queryable, bbox: Bbox, opts: { categories?: Category[]; limit?: number; zoom?: number; maxAgeHours?: number } = {}): Promise<{ targets: TargetRow[]; clusters: Cluster[]; total: number; clustered: boolean }> {
  const limit = Math.min(5000, Math.max(50, opts.limit ?? 2000));
  const args: unknown[] = [bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon, String(opts.maxAgeHours ?? 24)];
  let where = `WHERE u.lat BETWEEN $1 AND $2 AND u.lon BETWEEN $3 AND $4 AND u.received_at > now() - ($5::text || ' hours')::interval`;
  if (opts.categories?.length) {
    args.push(opts.categories);
    where += ` AND (CASE WHEN u.vessel_id IS NOT NULL THEN ${REGISTER_CATEGORY_SQL('u.vessel_type')} ELSE u.category END) = ANY($${args.length}::text[])`;
  }
  const total = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM (${UNION}) u ${where}`, args)).rows[0].n);
  if (total <= limit) {
    const rows = await c.query<TargetRow>(`SELECT u.* FROM (${UNION}) u ${where} ORDER BY u.vessel_id IS NULL, u.received_at DESC LIMIT ${limit}`, args);
    return { targets: rows.rows, clusters: [], total, clustered: false };
  }
  // a grid whose cell is about sixty screen pixels at this zoom; the register's own ships still come through as targets
  const zoom = Math.min(18, Math.max(1, opts.zoom ?? 6));
  const cell = (360 / 2 ** zoom) * (60 / 256);
  args.push(cell);
  const clusters = await c.query<{ lat: string; lon: string; n: string; category: string }>(
    `SELECT avg(u.lat) AS lat, avg(u.lon) AS lon, count(*) AS n, (CASE WHEN u.vessel_id IS NOT NULL THEN ${REGISTER_CATEGORY_SQL('u.vessel_type')} ELSE u.category END) AS category
       FROM (${UNION}) u ${where} GROUP BY floor(u.lat / $${args.length}), floor(u.lon / $${args.length}), 4`, args);
  const byCell = new Map<string, Cluster>();
  for (const r of clusters.rows) {
    const key = `${Math.floor(Number(r.lat) / cell)}:${Math.floor(Number(r.lon) / cell)}`;
    const k = byCell.get(key) ?? { lat: 0, lon: 0, count: 0, categories: {} };
    const n = Number(r.n);
    k.lat = (k.lat * k.count + Number(r.lat) * n) / (k.count + n); k.lon = (k.lon * k.count + Number(r.lon) * n) / (k.count + n); k.count += n;
    k.categories[r.category || 'other'] = (k.categories[r.category || 'other'] ?? 0) + n;
    byCell.set(key, k);
  }
  const own = await c.query<TargetRow>(`SELECT u.* FROM (${UNION}) u ${where} AND u.vessel_id IS NOT NULL ORDER BY u.received_at DESC LIMIT 500`, args.slice(0, -1));
  return { targets: own.rows, clusters: [...byCell.values()].map((k) => ({ ...k, lat: Math.round(k.lat * 1e4) / 1e4, lon: Math.round(k.lon * 1e4) / 1e4 })), total, clustered: true };
}
/** The register's type codes classed in SQL, matching categoryOfRegisterType. */
const REGISTER_CATEGORY_SQL = (col: string) => `(CASE WHEN upper(${col}) ~ 'TANK|CRUDE|PROD|LPG|LNG|CHEM' THEN 'tanker' WHEN upper(${col}) ~ 'PASS|CRUISE|FERRY|PAX' THEN 'passenger'
  WHEN upper(${col}) ~ 'TUG|PILOT|OSV|SUPPLY|DREDG|WORK|SURVEY|PATROL|SAR' THEN 'tug' WHEN upper(${col}) ~ 'FISH' THEN 'fishing' WHEN upper(${col}) ~ 'YACHT|SAIL|PLEAS' THEN 'pleasure'
  WHEN upper(${col}) ~ 'HSC|FAST|HIGH' THEN 'highspeed' WHEN coalesce(${col}, '') = '' THEN 'other' ELSE 'cargo' END)`;

/** One target by MMSI, or by the register's vessel id (`vessel:<id>` or the id itself). */
export async function targetByKey(c: Queryable, key: string): Promise<TargetRow | null> {
  const k = key.startsWith('vessel:') ? key.slice(7) : key;
  const r = await c.query<TargetRow>(`SELECT u.* FROM (${UNION}) u WHERE u.mmsi = $1 OR u.vessel_id = $2 ORDER BY u.vessel_id IS NULL LIMIT 1`, [key, k]);
  return r.rows[0] ?? null;
}

/** Her track over the window: the register's own history for a ship on it, the thinned AIS track otherwise. */
export async function trackOf(c: Queryable, t: TargetRow, hours: number): Promise<{ lat: number; lon: number; sog: number; cog: number; receivedAt: string }[]> {
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = t.vessel_id
    ? await c.query<{ lat: string; lon: string; sog: string; cog: number; received_at: Date }>('SELECT lat, lon, sog, cog, received_at FROM position_history WHERE vessel_id = $1 AND received_at >= $2 ORDER BY received_at', [t.vessel_id, since])
    : await c.query<{ lat: string; lon: string; sog: string; cog: number; received_at: Date }>('SELECT lat, lon, sog, cog, received_at FROM ais_target_history WHERE mmsi = $1 AND received_at >= $2 ORDER BY received_at', [t.mmsi, since]);
  return rows.rows.map((h) => ({ lat: Number(h.lat), lon: Number(h.lon), sog: Number(h.sog), cog: h.cog, receivedAt: iso(h.received_at)! }));
}

/** Ports of the region as the map's own layer: public facts, approximate positions, good for a marker and a name. */
export const PORTS_LAYER: { code: string; name: string; country: string; lat: number; lon: number }[] = [
  { code: 'AEKHL', name: 'Khalifa Port', country: 'AE', lat: 24.81, lon: 54.64 }, { code: 'AEJEA', name: 'Jebel Ali', country: 'AE', lat: 25.01, lon: 55.06 },
  { code: 'AEAUH', name: 'Mina Zayed', country: 'AE', lat: 24.52, lon: 54.38 }, { code: 'AEDXB', name: 'Port Rashid', country: 'AE', lat: 25.27, lon: 55.28 },
  { code: 'AESHJ', name: 'Khalid Port, Sharjah', country: 'AE', lat: 25.37, lon: 55.38 }, { code: 'AEHAM', name: 'Hamriyah', country: 'AE', lat: 25.47, lon: 55.50 },
  { code: 'AEKLF', name: 'Khor Fakkan', country: 'AE', lat: 25.35, lon: 56.37 }, { code: 'AEFJR', name: 'Fujairah', country: 'AE', lat: 25.17, lon: 56.36 },
  { code: 'AERKT', name: 'Saqr Port, Ras Al Khaimah', country: 'AE', lat: 25.98, lon: 56.04 }, { code: 'AERUW', name: 'Ruwais', country: 'AE', lat: 24.13, lon: 52.73 },
  { code: 'OMMCT', name: 'Sultan Qaboos, Muscat', country: 'OM', lat: 23.62, lon: 58.57 }, { code: 'OMSOH', name: 'Sohar', country: 'OM', lat: 24.50, lon: 56.63 },
  { code: 'OMSLL', name: 'Salalah', country: 'OM', lat: 16.94, lon: 54.01 }, { code: 'OMDQM', name: 'Duqm', country: 'OM', lat: 19.66, lon: 57.72 },
  { code: 'QAHMD', name: 'Hamad Port', country: 'QA', lat: 25.02, lon: 51.61 }, { code: 'QARLF', name: 'Ras Laffan', country: 'QA', lat: 25.91, lon: 51.57 },
  { code: 'BHKBS', name: 'Khalifa Bin Salman', country: 'BH', lat: 26.16, lon: 50.66 }, { code: 'SADMM', name: 'King Abdulaziz, Dammam', country: 'SA', lat: 26.44, lon: 50.10 },
  { code: 'SAJUB', name: 'Jubail', country: 'SA', lat: 27.03, lon: 49.66 }, { code: 'SARAR', name: 'Ras Tanura', country: 'SA', lat: 26.64, lon: 50.16 },
  { code: 'KWSWK', name: 'Shuwaikh, Kuwait', country: 'KW', lat: 29.35, lon: 47.93 }, { code: 'KWSAA', name: 'Shuaiba', country: 'KW', lat: 29.05, lon: 48.15 },
  { code: 'IQUQR', name: 'Umm Qasr', country: 'IQ', lat: 30.03, lon: 47.94 }, { code: 'IRBND', name: 'Shahid Rajaee, Bandar Abbas', country: 'IR', lat: 27.10, lon: 56.06 },
  { code: 'PKKHI', name: 'Karachi', country: 'PK', lat: 24.84, lon: 66.98 }, { code: 'PKBQM', name: 'Port Qasim', country: 'PK', lat: 24.77, lon: 67.33 },
  { code: 'PKGWD', name: 'Gwadar', country: 'PK', lat: 25.12, lon: 62.33 }, { code: 'INNSA', name: 'Nhava Sheva (JNPT)', country: 'IN', lat: 18.95, lon: 72.95 },
  { code: 'INBOM', name: 'Mumbai', country: 'IN', lat: 18.94, lon: 72.84 }, { code: 'INMRM', name: 'Mormugao', country: 'IN', lat: 15.41, lon: 73.80 },
  { code: 'INNML', name: 'New Mangalore', country: 'IN', lat: 12.93, lon: 74.81 }, { code: 'INCOK', name: 'Cochin', country: 'IN', lat: 9.97, lon: 76.26 },
  { code: 'INTUT', name: 'Tuticorin', country: 'IN', lat: 8.75, lon: 78.20 }, { code: 'INMAA', name: 'Chennai', country: 'IN', lat: 13.10, lon: 80.30 },
  { code: 'INVTZ', name: 'Visakhapatnam', country: 'IN', lat: 17.69, lon: 83.28 }, { code: 'LKCMB', name: 'Colombo', country: 'LK', lat: 6.95, lon: 79.85 },
  { code: 'MVMLE', name: 'Malé', country: 'MV', lat: 4.18, lon: 73.51 }, { code: 'YEADE', name: 'Aden', country: 'YE', lat: 12.79, lon: 44.98 },
  { code: 'DJJIB', name: 'Djibouti', country: 'DJ', lat: 11.60, lon: 43.15 }, { code: 'SOBBO', name: 'Berbera', country: 'SO', lat: 10.44, lon: 45.01 },
  { code: 'SAJED', name: 'Jeddah Islamic Port', country: 'SA', lat: 21.48, lon: 39.17 }, { code: 'EGSUZ', name: 'Suez', country: 'EG', lat: 29.94, lon: 32.55 },
  { code: 'KEMBA', name: 'Mombasa', country: 'KE', lat: -4.06, lon: 39.66 }, { code: 'TZDAR', name: 'Dar es Salaam', country: 'TZ', lat: -6.82, lon: 39.29 },
];

/** Ships on the picture whose name, MMSI, IMO or call sign begins with what was typed — the register's own first. */
export async function searchTargets(c: Queryable, q: string, limit = 10): Promise<TargetRow[]> {
  const needle = q.trim();
  if (!needle) return [];
  const r = await c.query<TargetRow>(
    `SELECT u.* FROM (${UNION}) u
      WHERE u.name ILIKE $1 OR u.vessel_name ILIKE $1 OR u.mmsi LIKE $2 OR u.imo LIKE $2 OR u.vessel_imo LIKE $2 OR u.call_sign ILIKE $2
      ORDER BY u.vessel_id IS NULL, (u.name ILIKE $2 OR u.vessel_name ILIKE $2) DESC, u.received_at DESC LIMIT $3`,
    [`%${needle.replace(/[%_]/g, (m) => `\\${m}`)}%`, `${needle.replace(/[%_]/g, (m) => `\\${m}`)}%`, Math.min(50, Math.max(1, limit))]);
  return r.rows;
}
