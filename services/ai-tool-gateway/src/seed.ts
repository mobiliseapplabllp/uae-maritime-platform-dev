import { join } from 'node:path';
import { createDb, createLogger, runMigrations } from '@maritime/service-kit';
import { env } from './env';
import { TOOLS } from './registry';
import { syncRegistry } from './gateway.service';
import type { Tier } from './policy';

/* The callers the platform ships with: the assistant, each agent, and the services that act for a person.
 * Every ceiling here is the agent's own latitude as the agentic runtime configures it — a supervised agent
 * proposes, an assisted one may act on the reversible, and nothing here may reach a hosted model but the
 * assistant and the model platform's document reader. An administrator may narrow any of these at any time; a re-seed never widens what was narrowed. */
export interface CallerSeed { callerId: string; label: string; kind: 'ASSISTANT' | 'AGENT' | 'SERVICE'; allowedTools: string[]; maxTier: Tier; hourlyQuota: number; dailyQuota: number; note: string }
const mod = (...modules: string[]) => TOOLS.filter((t) => modules.includes(t.module) && t.tier === 'READ').map((t) => t.name);
export const CALLERS: CallerSeed[] = [
  { callerId: 'assistant', label: 'Operations assistant', kind: 'ASSISTANT', allowedTools: ['*'], maxTier: 'INFER', hourlyQuota: 1200, dailyQuota: 12000, note: 'Reads as the person asking; the only caller that may reach a hosted model' },
  { callerId: 'agent:a1_document_intelligence', label: 'Document Intelligence Agent', kind: 'AGENT', allowedTools: [...mod('services', 'facil'), 'docs.search', 'services.verify_document', 'services.add_note'], maxTier: 'ACT', hourlyQuota: 300, dailyQuota: 3000, note: 'May verify a lodged document and note what is missing' },
  { callerId: 'agent:a2_vessel_compliance', label: 'Vessel Compliance Agent', kind: 'AGENT', allowedTools: mod('ships', 'inspect', 'facil'), maxTier: 'READ', hourlyQuota: 300, dailyQuota: 3000, note: 'Reads the register; its conclusions are decisions for a person' },
  { callerId: 'agent:a3_service_processing', label: 'Service Processing Agent', kind: 'AGENT', allowedTools: [...mod('services', 'facil', 'ships', 'crew', 'finance'), 'services.add_note', 'services.request_info'], maxTier: 'ACT', hourlyQuota: 300, dailyQuota: 3000, note: 'May ask an applicant for what is missing; issuing is a person\'s act' },
  { callerId: 'agent:a4_customer_guidance', label: 'Customer Guidance Agent', kind: 'AGENT', allowedTools: [...mod('services'), 'services.add_note'], maxTier: 'ACT', hourlyQuota: 600, dailyQuota: 6000, note: 'May tell an applicant where the application stands' },
  { callerId: 'agent:a5_smart_inspection', label: 'Smart Inspection Agent', kind: 'AGENT', allowedTools: mod('ships', 'inspect', 'ops', 'nmc'), maxTier: 'READ', hourlyQuota: 300, dailyQuota: 3000, note: 'Selects boarding targets; the boarding is a person\'s decision' },
  { callerId: 'agent:a6_regulatory_intelligence', label: 'Regulatory Intelligence Agent', kind: 'AGENT', allowedTools: mod('legis', 'services'), maxTier: 'READ', hourlyQuota: 120, dailyQuota: 1200, note: 'Reads the register of instruments' },
  { callerId: 'agent:a7_maritime_intelligence', label: 'National Maritime Intelligence Agent', kind: 'AGENT', allowedTools: mod('incidents', 'nmc', 'ships', 'inspect', 'ops'), maxTier: 'READ', hourlyQuota: 600, dailyQuota: 6000, note: 'Publishes the national picture from what it reads' },
  { callerId: 'agent:insights', label: 'Module insights', kind: 'AGENT', allowedTools: TOOLS.filter((t) => t.tier === 'READ').map((t) => t.name), maxTier: 'READ', hourlyQuota: 1200, dailyQuota: 12000, note: 'Reads each module\'s dashboard as the person looking at it' },
  { callerId: 'svc:ai-agents', label: 'Agentic runtime', kind: 'SERVICE', allowedTools: ['*'], maxTier: 'ACT', hourlyQuota: 600, dailyQuota: 6000, note: 'Carries a person\'s approval of an agent\'s conclusion through to the record, as that person' },
  { callerId: 'svc:ai-platform', label: 'Model platform', kind: 'SERVICE', allowedTools: ['infer.complete'], maxTier: 'INFER', hourlyQuota: 300, dailyQuota: 3000, note: 'Refines what its in-country document reader could not read, through the hosted provider Settings → AI names; the image never leaves the platform' },
  { callerId: 'svc:workflow', label: 'Service Desk', kind: 'SERVICE', allowedTools: ['docs.search', 'services.application', 'facil.company', 'ships.vessel', 'crew.seafarer'], maxTier: 'READ', hourlyQuota: 600, dailyQuota: 6000, note: 'Reads a subject for a form, as the applicant' },
];

export async function seedGateway(url: string) {
  const { pool } = createDb(url);
  try {
    await runMigrations(pool, join(__dirname, '..', 'migrations'));
    await syncRegistry(pool);
    for (const c of CALLERS) {
      await pool.query(
        `INSERT INTO callers(caller_id, label, kind, allowed_tools, max_tier, hourly_quota, daily_quota, note, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seed')
         ON CONFLICT (caller_id) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind, note = EXCLUDED.note, updated_at = now()`,
        [c.callerId, c.label, c.kind, c.allowedTools, c.maxTier, c.hourlyQuota, c.dailyQuota, c.note]);
    }
    return { tools: TOOLS.length, callers: CALLERS.length };
  } finally { await pool.end(); }
}

if (require.main === module) {
  const e = env(); const log = createLogger(e.SERVICE_NAME);
  seedGateway(e.DATABASE_URL).then((r) => { log.info(r, 'SEED COMPLETE'); console.log('SEED COMPLETE', r); }).catch((err) => { console.error(err); process.exit(1); });
}
