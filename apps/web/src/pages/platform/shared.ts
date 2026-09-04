/** How long a state has held, in the shortest form that is still exact enough to act on. */
export const duration = (sec: number): string => {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
};

export const mb = (n: number | undefined): string => (n === undefined ? '—' : n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n.toFixed(1)} MB`);

/** Availability is only meaningful to two decimals; anything more is noise from the sample count. */
export const pct = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${n.toFixed(2)}%`);

/** Traffic-light colour for an availability figure, on the thresholds an operator actually uses.
 *  'default' for "not measured yet" — a target with no history is not a failing one. */
export const availabilityTone = (a: number | null): 'success' | 'warning' | 'error' | 'default' => {
  if (a === null) return 'default';
  if (a >= 99.9) return 'success';
  if (a >= 99) return 'warning';
  return 'error';
};

/** The same thresholds as an sx colour. `default` has no `.main`, so it must fall through to the
 *  inherited text colour rather than resolve to a palette key that does not exist. */
export const availabilityColor = (a: number | null): string | undefined => {
  const tone = availabilityTone(a);
  return tone === 'default' ? undefined : `${tone}.main`;
};

/** Outbox backlog is the leading indicator of data drift between services: rows written but never
 *  published. A handful mid-flight is normal; a backlog that persists is not. */
export const outboxTone = (unpublished: number, oldestSec: number | null): 'success' | 'warning' | 'error' => {
  if (unpublished <= 0) return 'success';
  if ((oldestSec ?? 0) > 300 || unpublished > 100) return 'error';
  return 'warning';
};
