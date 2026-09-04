import type { SearchIndex } from '@maritime/service-kit';

/**
 * What the platform is searchable by, declared once.
 *
 * Both search drivers read these definitions: the PostgreSQL driver turns them into a WHERE clause over the
 * read model, the OpenSearch driver turns them into an index mapping and a query. Declaring them in one
 * place is what stops the two from answering differently — a field added to the engine but not the fallback
 * would make search results depend on which driver happened to answer.
 *
 * Boosts are relative, not absolute: an identifier someone typed in full should beat a description that
 * merely contains the same letters, so codes and names outrank prose.
 *
 * No definition names a scope column. That is deliberate and it is enforced by `SearchDoc` having nowhere
 * to put one — matching happens here, authorisation happens in the query that follows.
 */
export const INDEXES = {
  vessels: {
    name: 'vessels', table: 'rm_vessels',
    fields: [
      { name: 'name', analysis: 'text', boost: 3 },
      { name: 'imo', analysis: 'keyword', boost: 3 },
      { name: 'call_sign', analysis: 'keyword', boost: 2 },
      { name: 'owner', analysis: 'text' },
      { name: 'operator', analysis: 'text' },
    ],
  },
  portCalls: {
    name: 'port-calls', table: 'rm_port_calls',
    fields: [
      { name: 'vcn', analysis: 'keyword', boost: 3 },
      { name: 'vessel_name', analysis: 'text', boost: 2 },
    ],
  },
  seafarers: {
    name: 'seafarers', table: 'rm_seafarers',
    fields: [
      { name: 'name', analysis: 'text', boost: 3 },
      { name: 'cdc_no', analysis: 'keyword', boost: 3 },
      { name: 'seafarer_id_no', analysis: 'keyword', boost: 2 },
      { name: 'rank', analysis: 'text' },
    ],
  },
  companies: {
    name: 'companies', table: 'rm_companies',
    fields: [
      { name: 'name', analysis: 'text', boost: 3 },
      { name: 'name_ar', analysis: 'arabic', boost: 3 },
      { name: 'code', analysis: 'keyword', boost: 3 },
    ],
  },
  incidents: {
    name: 'incidents', table: 'rm_incidents',
    fields: [
      { name: 'number', analysis: 'keyword', boost: 3 },
      { name: 'title', analysis: 'text', boost: 2 },
    ],
  },
  invoices: {
    name: 'invoices', table: 'rm_invoices',
    fields: [{ name: 'number', analysis: 'keyword', boost: 3 }],
  },
  legalInstruments: {
    name: 'legal-instruments', table: 'rm_legal_instruments',
    fields: [
      { name: 'ref_no', analysis: 'keyword', boost: 3 },
      { name: 'title', analysis: 'text', boost: 2 },
      { name: 'title_ar', analysis: 'arabic', boost: 2 },
    ],
  },
  instruments: {
    name: 'instruments', table: 'rm_instruments',
    fields: [
      { name: 'number', analysis: 'keyword', boost: 3 },
      { name: 'entity_name', analysis: 'text', boost: 2 },
    ],
  },
  users: {
    name: 'users', table: 'rm_users',
    fields: [
      { name: 'name', analysis: 'text', boost: 3 },
      { name: 'email', analysis: 'keyword', boost: 2 },
      { name: 'designation', analysis: 'text' },
    ],
  },
} satisfies Record<string, SearchIndex>;

export const ALL_INDEXES: SearchIndex[] = Object.values(INDEXES);
