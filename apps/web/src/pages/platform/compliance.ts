/* The compliance headline, stated as of the compile date. These are judgements about 70 written
 * commitments, not measurements the platform can take about itself, so they are data here and are
 * revised together with the published matrix rather than derived at runtime. */

export const COMPLIANCE_URL = 'https://claude.ai/code/artifact/632eb64c-3d09-4f5f-a31f-b887a1396d20';
export const PLAN_URL = 'https://claude.ai/code/artifact/75ef9d08-10f9-4e57-b6c3-c6585ed9b280';
export const COMPLIANCE_COMPILED = '04 September 2026';

export type ComplianceStatus = 'built' | 'partial' | 'absent' | 'diverged';

/**
 * The colour a verdict is shown in. `absent` used the disabled grey, which at 26px bold came out at 2.67:1
 * against white — below AA even for large text, and it is the number that says how much is not built, which
 * is the last figure that should be hard to read.
 */
export const statusColor = (s: string): string =>
  ({ built: 'success.main', partial: 'warning.main', absent: 'text.secondary', diverged: 'secondary.main' }[s] ?? 'text.secondary');

export const COMPLIANCE = {
  totals: [
    { key: 'built' as const, count: 24 },
    { key: 'partial' as const, count: 35 },
    { key: 'absent' as const, count: 10 },
    { key: 'diverged' as const, count: 1 },
  ],
  sections: [
    { key: 'arch', label: 'Architecture mandate', built: 4, partial: 5, absent: 0, diverged: 0 },
    { key: 'stack', label: 'Technology stack', built: 6, partial: 3, absent: 0, diverged: 1 },
    { key: 'agentic', label: 'Agentic AI framework', built: 7, partial: 4, absent: 1, diverged: 0 },
    { key: 'lcnc', label: 'Low-code / no-code', built: 2, partial: 2, absent: 2, diverged: 0 },
    { key: 'domains', label: 'The seven RFP domains', built: 0, partial: 7, absent: 0, diverged: 0 },
    { key: 'cross', label: 'Cross-domain and non-functional', built: 5, partial: 5, absent: 2, diverged: 0 },
    { key: 'deliv', label: 'Deliverables and governance', built: 0, partial: 9, absent: 5, diverged: 0 },
  ],
  delta: [
    { key: 'studio', name: 'Service Studio', why: 'The low-code runtime already carries the platform; without the design-time studio the vendor-independence objective is unmet.' },
    { key: 'counterparts', name: 'Live counterpart connections', why: 'The hub and all eight adapters are built and contract-tested; each still answers from a stub until endpoints and credentials are issued.' },
    { key: 'aiplatform', name: 'The modelling half of ai-platform', why: 'The registry, approval, residency gate, latency budget and drift detection are built. Training runs are recorded rather than executed, and vision and speech answer from a stub.' },
    { key: 'mobile', name: 'Mobile apps', why: 'Two Flutter apps; the offline inspector app is the largest single estimate in the TAD.' },
    { key: 'coverage', name: 'Coverage instrumentation', why: 'The agentic service rate is a percentage the directive measures. It cannot be reported today, though every inference is now recorded with its model, version and outcome.' },
    { key: 'assurance', name: 'Remaining assurance', why: 'Static analysis, dynamic probes, the OWASP Top 10 pass and the WCAG 2.2 AA audit are done. Load tests, the DR drill, the migration toolkit and escrow are not.' },
  ],
};
