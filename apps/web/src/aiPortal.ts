/* Maritime Insights — the AI analytics application that runs alongside this portal.
 * It is a separate application on its own port, reached by URL rather than router navigation. */
const DEFAULT_URL = 'http://localhost:5273';
export const AI_PORTAL = {
  name: 'Maritime Insights', short: 'Insights',
  desc: 'AI analytics — findings, natural-language reports, document Q&A and the 3D port twin',
  color: '#0E7C86',
  url: String(import.meta.env.VITE_AI_PORTAL_URL || DEFAULT_URL).replace(/\/+$/, ''),
};
export const IS_DEMO = import.meta.env.VITE_DEMO === '1';
export const AI_PORTAL_IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(AI_PORTAL.url);
export function openAiPortal() { window.open(AI_PORTAL.url, '_blank', 'noopener,noreferrer'); }
