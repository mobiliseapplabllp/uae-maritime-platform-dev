/**
 * Where the application is allowed to send a browser when the destination came from data.
 *
 * Most navigation in the app is written into the code — a button that goes to `/vessels`. A handful of places
 * navigate to a path that arrived in a payload instead: a hover card's `link`, a notification's `link`, a
 * search result's `to`, a source cited by the assistant. Those are server-generated today and internal by
 * construction, but "internal by construction" is a property of this month's server, not of the router.
 *
 * React Router 6 treats a backslash-prefixed path as an absolute URL (GHSA open-redirect), so `\\evil.example`
 * reaching one of those call sites leaves the platform. The version fix is a major upgrade; this check is
 * cheaper, applies whatever the router does next, and also refuses the things a patched router would still
 * accept — `javascript:`, `data:`, and protocol-relative `//host`.
 *
 * A rooted, single-slash path with no scheme is the only thing that passes.
 */
const SAFE = /^\/(?!\/)[^\\]*$/;

/** The path if it is one this application may navigate to, or the fallback when it is not. */
export function internalPath(value: unknown, fallback = '/'): string {
  const path = typeof value === 'string' ? value.trim() : '';
  if (!path || !SAFE.test(path)) return fallback;
  // A rooted path can still hide a scheme once the browser resolves it; resolving it here settles the question.
  try {
    const url = new URL(path, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}

/** True when the value is a destination inside this application. */
export const isInternalPath = (value: unknown): boolean => internalPath(value, '') !== '';
