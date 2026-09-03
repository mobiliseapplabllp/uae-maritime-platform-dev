import { join } from 'node:path';
import { buildWorld } from '@maritime/world';
import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { env } from './env';
import { corpusFromLegalInstrument, corpusFromLookup, corpusFromServiceDefinition, reindex, upsertCorpusDoc, type Row } from './corpus';
import { upsertCertificate, upsertIncident, upsertInspection, upsertInstrument, upsertInvoice, upsertPortCall, upsertVessel } from './subjects';

/* Seeds the assistant from the shared world.
 *
 * Two halves. The records it may read on a user's behalf — the fleet, the schedule, the ledger, the surveys, the
 * incident desk and the instrument register — are projected into the snapshots the tool surface queries. The
 * corpus it retrieves from is built out of the legislation register, the service catalogue and the reference
 * data, and then indexed: document frequencies, inverse document frequencies and one normalised vector per
 * passage, all computed here, offline, from this corpus alone. */

/** Reference categories worth expanding in an answer; the rest are internal plumbing nobody asks about. */
const REFERENCE_CATEGORIES = new Set(['deficiencyCode', 'actionCode', 'incidentType', 'cargoType', 'vesselType', 'certificateType', 'serviceCategory']);

export async function seedAiAssistant(databaseUrl: string, profile = 'AE') {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });

  const counts = await withTx(pool, async (c) => {
    for (const v of world.vessels) await upsertVessel(c, v as unknown as Row);
    for (const cert of world.vesselCertificates) await upsertCertificate(c, cert as unknown as Row);
    for (const call of world.portCalls) await upsertPortCall(c, call as unknown as Row);
    for (const inv of world.invoices) await upsertInvoice(c, inv as unknown as Row);
    for (const i of world.inspections) await upsertInspection(c, i as unknown as Row);
    for (const i of world.incidents) await upsertIncident(c, i as unknown as Row);
    for (const l of world.licences) await upsertInstrument(c, { ...(l as unknown as Row), number: l.licenseNo });

    for (const i of world.legalInstruments) await upsertCorpusDoc(c, corpusFromLegalInstrument(i as unknown as Row));
    for (const s of world.serviceDefinitions) await upsertCorpusDoc(c, corpusFromServiceDefinition(s as unknown as Row));
    const lookups = world.lookups.filter((l) => REFERENCE_CATEGORIES.has(l.category));
    for (const l of lookups) await upsertCorpusDoc(c, corpusFromLookup(l as unknown as Row));
    const index = await reindex(c);

    return {
      profile: world.profile, vessels: world.vessels.length, certificates: world.vesselCertificates.length,
      portCalls: world.portCalls.length, invoices: world.invoices.length, inspections: world.inspections.length,
      incidents: world.incidents.length, instruments: world.licences.length,
      corpusLegislation: world.legalInstruments.length, corpusServices: world.serviceDefinitions.length,
      corpusReference: lookups.length, corpusDocuments: index.documents, corpusTerms: index.terms,
    };
  });
  await pool.end();
  return counts;
}

export type SeedCounts = Awaited<ReturnType<typeof seedAiAssistant>>;

if (require.main === module) {
  const e = env();
  seedAiAssistant(e.DATABASE_URL, e.JURISDICTION).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
