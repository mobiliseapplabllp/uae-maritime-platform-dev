import { Prng, DEFAULT_SEED, HIST_START } from './prng';
import { buildPeople, type WorldUser } from './people';
import { buildLookups, type WorldLookup } from './reference';
import { buildCompanies, buildBerths, type WorldCompany, type WorldBerth } from './organisations';
import { buildVessels, type WorldVessel, REAL_LINERS, isRealLiner } from './vessels';
import { buildPortCalls, type WorldPortCall } from './operations';
import { buildSettings, type WorldSetting } from './settings';
import { ROLE_CATALOGUE, DEFAULT_JURISDICTION, type RoleDefinition } from '@maritime/contracts';

export interface World { profile: string; seed: number; now: string; histStart: string; roles: RoleDefinition[]; users: WorldUser[]; lookups: WorldLookup[]; companies: WorldCompany[]; berths: WorldBerth[]; vessels: WorldVessel[]; portCalls: WorldPortCall[]; settings: WorldSetting[] }

/** Builds the whole fictional world deterministically. Every service seeds its own slice from this one object. */
export function buildWorld(opts: { profile?: string; seed?: number; now?: Date } = {}): World {
  const profile = (opts.profile ?? process.env.WORLD_PROFILE ?? DEFAULT_JURISDICTION).toUpperCase();
  const seed = opts.seed ?? DEFAULT_SEED;
  const now = opts.now ?? new Date();
  const rng = new Prng(seed);
  const users = buildPeople(rng, profile, now);
  const lookups = buildLookups(profile);
  const companies = buildCompanies(rng, profile, now);
  const berths = buildBerths();
  const vessels = buildVessels(rng, profile);
  const portCalls = buildPortCalls(rng, vessels, berths, now, profile === 'AE' ? 'MAR' : 'REF');
  const settings = buildSettings(profile);
  return { profile, seed, now: now.toISOString(), histStart: HIST_START.toISOString(), roles: ROLE_CATALOGUE, users, lookups, companies, berths, vessels, portCalls, settings };
}
export const DEMO_PASSWORD = 'Demo@2026';
export * from './prng';
export * from './people';
export * from './reference';
export * from './organisations';
export * from './vessels';
export * from './operations';
export * from './settings';
export { REAL_LINERS, isRealLiner };
