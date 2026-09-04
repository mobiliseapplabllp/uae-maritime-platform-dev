import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type PageQuery } from '@maritime/contracts';

export interface Page { page: number; limit: number; offset: number; sortField: string; sortDir: 'asc' | 'desc'; q: string }
/** page/limit/sort/q convention: `-field` sorts descending; limit capped; q trimmed. */
export function parsePage(query: PageQuery, opts: { defaultSort?: string; maxLimit?: number; sortable?: string[] } = {}): Page {
  const page = Math.max(1, Number.parseInt(String(query.page ?? 1), 10) || 1);
  const limit = Math.min(opts.maxLimit ?? MAX_PAGE_LIMIT, Math.max(1, Number.parseInt(String(query.limit ?? DEFAULT_PAGE_LIMIT), 10) || DEFAULT_PAGE_LIMIT));
  const sort = String(query.sort || opts.defaultSort || '-createdAt');
  const sortDir: 'asc' | 'desc' = sort.startsWith('-') ? 'desc' : 'asc';
  let sortField = sort.replace(/^-/, '');
  // An unrecognised sort field falls back to the register's default — and so does the direction with it.
  // Honouring `-` from a field that was thrown away answered a different order for `?sort=-anything` than
  // for `?sort=anything`, which let a caller see that the two were being treated differently at all.
  let dir = sortDir;
  if (opts.sortable && !opts.sortable.includes(sortField)) {
    const fallback = opts.defaultSort || '-createdAt';
    sortField = fallback.replace(/^-/, '');
    dir = fallback.startsWith('-') ? 'desc' : 'asc';
  }
  return { page, limit, offset: (page - 1) * limit, sortField, sortDir: dir, q: String(query.q ?? '').trim() };
}
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** Map a camelCase API sort field to a snake_case column, restricted to a whitelist. */
export const columnFor = (field: string, map: Record<string, string>, fallback: string): string => map[field] ?? fallback;
