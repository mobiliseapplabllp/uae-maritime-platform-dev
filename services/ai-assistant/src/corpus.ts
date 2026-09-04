import type { Queryable } from '@maritime/service-kit';
import { INDEX_VERSION, buildIndex, type CorpusDoc } from './retrieval';

/* The corpus: the platform's own content, turned into passages an answer can cite.
 *
 * Three sources, each with the permission a reader must hold to be shown it. The legislation register, because
 * "what does the rule say?" is the question the assistant is most often asked. The service catalogue, because
 * "what do I have to lodge?" is the second. And the reference data, because half of the vocabulary in this
 * domain is a code that means nothing until it is expanded. Nothing here is prose someone wrote for the
 * assistant — it is all the register, indexed. */

export type Row = Record<string, any>;

export const CORPUS_KINDS = ['legislation', 'service', 'reference', 'guidance'] as const;

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** A published legal instrument: its reference, its title, what it applies to and when it took effect. */
export function corpusFromLegalInstrument(i: Row): CorpusDoc {
  const body = [
    clean(i.summary ?? i.description),
    i.type ? `Instrument type: ${i.type}.` : '',
    i.category ? `Category: ${i.category}.` : '',
    i.status ? `Status: ${i.status}.` : '',
    i.effectiveDate ? `Effective from ${String(i.effectiveDate).slice(0, 10)}.` : '',
    i.issuedDate ? `Issued ${String(i.issuedDate).slice(0, 10)}.` : '',
    i.supersedes ? `Supersedes ${i.supersedes}.` : '',
    Array.isArray(i.tags) && i.tags.length ? `Applies to: ${i.tags.join(', ')}.` : '',
    i.ackRequired ? 'Acknowledgement is required from the addressees.' : '',
    clean(i.body ?? i.text),
  ].filter(Boolean).join(' ');
  return {
    id: `legislation:${i.id}`, kind: 'legislation', ref: i.refNo ?? '', title: `${i.refNo ?? ''} — ${i.title ?? ''}`.trim().replace(/^—\s*/, ''),
    titleAr: i.titleAr ?? '', body, link: '/legislation', permission: 'legislation.view', entityType: 'LegalInstrument', entityId: String(i.id),
  };
}

/** A service in the catalogue: what it is for, what it costs, what it needs and how long it takes. */
export function corpusFromServiceDefinition(s: Row): CorpusDoc {
  const docs: Row[] = s.requiredDocuments ?? [];
  const stages: Row[] = s.stages ?? [];
  const body = [
    clean(s.description),
    s.category ? `Category: ${s.category}.` : '',
    s.channel ? `Channel: ${s.channel}.` : '',
    s.slaDays ? `Service level: ${s.slaDays} days.` : '',
    s.fee?.amount ? `Fee: ${s.fee.currency ?? 'AED'} ${(Number(s.fee.amount) / 100).toFixed(2)}.` : 'No fee is charged for this service.',
    docs.length ? `Documents required: ${docs.map((d) => `${d.label}${d.mandatory ? '' : ' (optional)'}`).join(', ')}.` : '',
    stages.length ? `Stages: ${stages.map((x) => x.label).join(' → ')}.` : '',
    s.subjectKind ? `Applies to a ${String(s.subjectKind).toLowerCase()}.` : '',
  ].filter(Boolean).join(' ');
  return {
    id: `service:${s.id}`, kind: 'service', ref: s.code ?? '', title: `${s.code ?? ''} — ${s.name ?? ''}`.trim().replace(/^—\s*/, ''),
    titleAr: s.nameAr ?? '', body, link: '/', permission: 'services.view', entityType: 'ServiceDefinition', entityId: String(s.id),
  };
}

/** A reference code and what it means, so an answer can expand the vocabulary the registers are written in. */
export function corpusFromLookup(l: Row): CorpusDoc {
  const meta = l.meta && typeof l.meta === 'object' ? Object.entries(l.meta).map(([k, v]) => `${k}: ${v}`).join('; ') : '';
  return {
    id: `reference:${l.category}:${l.code}`, kind: 'reference', ref: l.code ?? '',
    title: `${l.code ?? ''} — ${l.label ?? l.name ?? ''}`.trim().replace(/^—\s*/, ''), titleAr: l.labelAr ?? '',
    body: [`${l.category} code ${l.code}: ${clean(l.label ?? l.name)}.`, meta].filter(Boolean).join(' '),
    link: `/masters/m/${l.category}`, permission: 'masters.view', entityType: 'Lookup', entityId: `${l.category}:${l.code}`,
  };
}

export async function upsertCorpusDoc(c: Queryable, doc: CorpusDoc) {
  await c.query(`INSERT INTO corpus(id, kind, ref, title, title_ar, body, link, permission, entity_type, entity_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, ref = EXCLUDED.ref, title = EXCLUDED.title, title_ar = EXCLUDED.title_ar,
      body = EXCLUDED.body, link = EXCLUDED.link, permission = EXCLUDED.permission, entity_type = EXCLUDED.entity_type,
      entity_id = EXCLUDED.entity_id, updated_at = now()`,
    [doc.id, doc.kind, doc.ref, doc.title, doc.titleAr ?? '', doc.body, doc.link, doc.permission, doc.entityType ?? '', doc.entityId ?? '']);
}

/**
 * Recomputes the whole index in one pass. Document frequencies are a property of the corpus, so adding one
 * passage changes every vector — which is why this rebuilds rather than patching, and why the corpus is small
 * enough for that to be the right trade.
 */
export async function reindex(c: Queryable): Promise<{ documents: number; terms: number }> {
  const rows = (await c.query<Row>('SELECT id, kind, ref, title, title_ar, body, link, permission, entity_type, entity_id FROM corpus ORDER BY id')).rows;
  const docs: CorpusDoc[] = rows.map((r) => ({
    id: r.id, kind: r.kind, ref: r.ref, title: r.title, titleAr: r.title_ar, body: r.body, link: r.link,
    permission: r.permission, entityType: r.entity_type, entityId: r.entity_id,
  }));
  const index = buildIndex(docs);
  for (const d of index.docs) {
    /* `dense` is the canonical trigram vector and is written here; where the cluster has pgvector, the
     * migration's trigger keeps the indexed copy equal to it, so this statement is the same either way. */
    await c.query(`UPDATE corpus SET terms = $2, token_count = $3, untrusted = $4, injection_markers = $5, dense = $6, updated_at = now()
                    WHERE id = $1`,
      [d.id, JSON.stringify(d.terms), d.tokenCount, d.untrusted, JSON.stringify(d.injectionMarkers), d.dense.length ? d.dense : null]);
  }
  await c.query('DELETE FROM corpus_terms');
  const terms = Object.entries(index.idf);
  for (const [term, idf] of terms) {
    await c.query('INSERT INTO corpus_terms(term, df, idf) VALUES ($1, $2, $3) ON CONFLICT (term) DO UPDATE SET df = EXCLUDED.df, idf = EXCLUDED.idf',
      [term, index.docs.filter((d) => d.terms[term] !== undefined).length, idf]);
  }
  await c.query(`INSERT INTO corpus_index(id, version, documents, terms, built_at) VALUES (true, $1, $2, $3, now())
                 ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, documents = EXCLUDED.documents,
                   terms = EXCLUDED.terms, built_at = EXCLUDED.built_at`,
    [INDEX_VERSION, index.docs.length, terms.length]);
  return { documents: index.docs.length, terms: terms.length };
}
