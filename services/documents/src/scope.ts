import type { ScopeOptions } from '@maritime/service-kit';

/* What a document belongs to.
 *
 * Both partitions apply, because a document can be either: a port's berth survey is contained by that port
 * and shared above it; an operator's uploaded certificate is owned by that company and by nobody else. An
 * unpartitioned document — the usual case, uploaded by the administration — is shared across ports and
 * owned by no company, so no operator reads it.
 *
 * This composes with the audience permission already on every row. That answers "what must you hold to read
 * this kind of document"; this answers "whose document is it". Both are applied, and because they are ANDed
 * neither can widen the other. */
export const DOCUMENT_SCOPE: ScopeOptions = { columns: ['port', 'company'] };
