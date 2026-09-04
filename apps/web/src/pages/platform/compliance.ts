/* The compliance headline, stated as of the compile date. These are judgements about 70 written
 * commitments, not measurements the platform can take about itself, so they are data here and are
 * revised together with the published matrix rather than derived at runtime. */

export const COMPLIANCE_URL = 'https://claude.ai/code/artifact/632eb64c-3d09-4f5f-a31f-b887a1396d20';
export const PLAN_URL = 'https://claude.ai/code/artifact/75ef9d08-10f9-4e57-b6c3-c6585ed9b280';
export const COMPLIANCE_COMPILED = '04 September 2026';

export type ComplianceStatus = 'built' | 'partial' | 'absent' | 'diverged';

export const statusColor = (s: string): string =>
  ({ built: 'success.main', partial: 'warning.main', absent: 'text.disabled', diverged: 'secondary.main' }[s] ?? 'text.secondary');

export const COMPLIANCE = {
  totals: [
    { key: 'built' as const, count: 17 },
    { key: 'partial' as const, count: 35 },
    { key: 'absent' as const, count: 17 },
    { key: 'diverged' as const, count: 1 },
  ],
  sections: [
    { key: 'arch', label: 'Architecture mandate', built: 3, partial: 6, absent: 0, diverged: 0 },
    { key: 'stack', label: 'Technology stack', built: 3, partial: 3, absent: 3, diverged: 1 },
    { key: 'agentic', label: 'Agentic AI framework', built: 6, partial: 3, absent: 3, diverged: 0 },
    { key: 'lcnc', label: 'Low-code / no-code', built: 2, partial: 2, absent: 2, diverged: 0 },
    { key: 'domains', label: 'The seven RFP domains', built: 0, partial: 7, absent: 0, diverged: 0 },
    { key: 'cross', label: 'Cross-domain and non-functional', built: 3, partial: 5, absent: 4, diverged: 0 },
    { key: 'deliv', label: 'Deliverables and governance', built: 0, partial: 9, absent: 5, diverged: 0 },
  ],
  delta: [
    { key: 'studio', name: 'Service Studio', why: 'The low-code runtime already carries the platform; without the design-time studio the vendor-independence objective is unmet.' },
    { key: 'hub', name: 'integration-hub', why: 'One unbuilt service blocks eight commitments — UAE PASS, GISIS, MOHRE, AIS/LRIT, ICP, payment and the SOAP façade.' },
    { key: 'aiplatform', name: 'ai-platform', why: 'Model registry, drift, vision and speech. Agent governance currently stops at behaviour.' },
    { key: 'mobile', name: 'Mobile apps', why: 'Two Flutter apps; the offline inspector app is the largest single estimate in the TAD.' },
    { key: 'coverage', name: 'Coverage instrumentation', why: 'The agentic service rate is a percentage the directive measures. It cannot be reported today.' },
    { key: 'assurance', name: 'Assurance scaffolding', why: 'Load tests, accessibility audit, DAST, DR drill, migration toolkit and escrow.' },
  ],
};
