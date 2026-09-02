import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type PageQuery } from '@maritime/contracts';

export interface Page { page: number; limit: number; offset: number; sortField: string; sortDir: 'asc' | 'desc'; q: string }
/** page/limit/sort/q convention: `-field` sorts descending; limit capped; q trimmed. */
export function parsePage(query: PageQuery, opts: { defaultSort?: string; maxLimit?: number; sortable?: string[] } = {}): Page {
  const page = Math.max(1, Number.parseInt(String(query.page ?? 1), 10) || 1);
  const limit = Math.min(opts.maxLimit ?? MAX_PAGE_LIMIT, Math.max(1, Number.parseInt(String(query.limit ?? DEFAULT_PAGE_LIMIT), 10) || DEFAULT_PAGE_LIMIT));
  let sort = String(query.sort || opts.defaultSort || '-createdAt');
  const sortDir: 'asc' | 'desc' = sort.startsWith('-') ? 'desc' : 'asc';
  let sortField = sort.replace(/^-/, '');
  if (opts.sortable && !opts.sortable.includes(sortField)) { sortField = (opts.defaultSort || '-createdAt').replace(/^-/, ''); }
  return { page, limit, offset: (page - 1) * limit, sortField, sortDir, q: String(query.q ?? '').trim() };
}
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** Map a camelCase API sort field to a snake_case column, restricted to a whitelist. */
export const columnFor = (field: string, map: Record<string, string>, fallback: string): string => map[field] ?? fallback;
