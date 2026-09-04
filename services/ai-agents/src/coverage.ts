/* The national directive states AI adoption as a percentage: half the authority's services delivered
 * agentically now, four fifths inside twenty-four months. A percentage is a claim about a denominator, so
 * the first thing this file does is fix what is being counted.
 *
 *   The denominator is the published service catalogue — every service the authority offers, whether or
 *   not anyone has applied for it this quarter. A service nobody used is still a service the directive
 *   counts, and quietly dropping it would inflate the rate by shrinking the field.
 *
 *   The numerator is services an agent actually touched. Touched means a decision was recorded against
 *   an application for that service. An agent that exists, is enabled, and is configured to watch a
 *   service does not count: capability is not coverage, and the gap between the two is exactly the thing
 *   a percentage is supposed to expose.
 *
 * The window selects applications, and everything else is counted through them. That is one rule rather
 * than two, and it is the rule that keeps the arithmetic honest: counting applications from the window
 * but decisions from all of history produced rows reading "two of one applications touched", because the
 * two sides of the ratio were drawn from different populations. A decision reaches this report only by
 * naming an application inside the window, so a part can never exceed its whole.
 *
 * It also makes the measure harder, which is the right direction. A service last applied for two years
 * ago cannot be covered however well an agent handled it then — the question is whether the authority is
 * delivering agentically now. How much of the uncovered tail is that rather than unautomated work is
 * reported separately, as the count of services with no application in the window at all.
 *
 * One rate can be read two ways, so both are reported. The service rate is the directive's number and it
 * goes wide: one decision on one application covers the service. The request rate is the same population
 * counted by depth — the share of individual applications an agent touched. Wide and shallow is a real
 * state of a programme and the pair of numbers is what makes it visible; the service rate alone would
 * hide it.
 *
 * Everything here is a pure function over rows, for the same reason the rest of the metrics are: the
 * console, the monthly pack and the tests all read the same arithmetic, so they cannot disagree about
 * what coverage means. */

export interface CoverageService { code: string; name: string; nameAr?: string; domain: number; active: boolean }
export interface CoverageRequest { id: string; serviceCode: string; submittedAt: string | Date }
/**
 * A decision as coverage reads it: the application it was taken on, and whether a human had to finish it.
 *
 * The application is what attributes a decision to a service — not a service code carried on the decision
 * itself. Both exist in the record, and joining through the application is the stricter of the two: it
 * cannot attribute work to a service whose application is not in the population being counted, and it
 * discards decisions taken on vessels, instruments and the intelligence panels without needing a rule,
 * because those name no application.
 */
export interface CoverageDecision { agentId: string; requestId?: string | null; disposition: string; at: string | Date }

const D = 86_400_000;
const ms = (v: string | Date) => new Date(v).getTime();
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

/** The agent reached a conclusion and it stood, with no human in the loop. */
export const AUTONOMOUS = (d: CoverageDecision) => d.disposition === 'AUTO_APPLIED';

/**
 * The directive's schedule: the rate in force at the programme's start, and the rate owed twenty-four
 * months later. Between the two the obligation is read as a straight line — the directive names the end
 * points and says nothing about the shape, and a straight line is the reading that cannot be gamed by
 * back-loading the work.
 */
export const DIRECTIVE = { startTarget: 50, endTarget: 80, months: 24 } as const;

export interface CoverageTarget {
  start: string; end: string; monthsElapsed: number;
  /** The rate owed today, interpolated between the two milestones. */
  required: number;
  startTarget: number; endTarget: number;
}

/** What the directive asks for on a given day, given the day the clock started. */
export function requiredRate(now: Date, start: Date, d = DIRECTIVE): CoverageTarget {
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + d.months);
  const span = end.getTime() - start.getTime();
  const elapsed = now.getTime() - start.getTime();
  const frac = span <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / span));
  const months = Math.max(0, Math.round((elapsed / span) * d.months * 10) / 10);
  return {
    start: start.toISOString(), end: end.toISOString(),
    monthsElapsed: Math.min(d.months, months),
    required: Math.round((d.startTarget + (d.endTarget - d.startTarget) * frac) * 10) / 10,
    startTarget: d.startTarget, endTarget: d.endTarget,
  };
}

export interface ServiceCoverageRow {
  code: string; name: string; nameAr?: string; domain: number;
  requests: number; touched: number; decisions: number; autonomous: number;
  agents: string[]; lastAt: string | null; covered: boolean;
}
export interface DomainCoverage { domain: number; services: number; covered: number; rate: number | null; requests: number; touched: number }

export interface Coverage {
  windowDays: number; from: string; to: string;
  services: number; covered: number; serviceRate: number | null;
  autonomousServices: number; autonomousRate: number | null;
  requests: number; requestsTouched: number; requestRate: number | null;
  /** Services with no application at all in the window — the part of the tail that is unused, not unautomated. */
  withoutRequests: number;
  target: CoverageTarget & { meets: boolean | null; servicesToRequired: number; servicesToEndTarget: number };
  byDomain: DomainCoverage[];
  rows: ServiceCoverageRow[];
}

/**
 * The agentic service rate, and everything needed to argue with it.
 *
 * Only decisions that name a service count. Agents also work on vessels, instruments and the intelligence
 * panels, and that work is real, but it is not service delivery — folding it in would answer a question
 * the directive did not ask with a number that happens to be larger.
 */
export function coverage(
  services: CoverageService[],
  requests: CoverageRequest[],
  decisions: CoverageDecision[],
  now: Date,
  opts: { windowDays: number; start: Date },
): Coverage {
  const since = now.getTime() - opts.windowDays * D;
  const active = services.filter((s) => s.active);
  const known = new Set(active.map((s) => s.code));

  const reqInWindow = requests.filter((r) => ms(r.submittedAt) >= since && known.has(r.serviceCode));
  // the one join the whole report rests on: an application inside the window, and the service it was for
  const serviceOfRequest = new Map(reqInWindow.map((r) => [r.id, r.serviceCode]));
  const counted = decisions.filter((d) => d.requestId && serviceOfRequest.has(d.requestId));

  const byService = new Map<string, ServiceCoverageRow>();
  for (const s of active) {
    byService.set(s.code, {
      code: s.code, name: s.name, nameAr: s.nameAr, domain: s.domain,
      requests: 0, touched: 0, decisions: 0, autonomous: 0, agents: [], lastAt: null, covered: false,
    });
  }
  for (const r of reqInWindow) byService.get(r.serviceCode)!.requests += 1;

  // an application counted once however many decisions were taken on it, so depth is applications reached
  const touchedRequests = new Map<string, Set<string>>();
  const agentsSeen = new Map<string, Set<string>>();
  for (const d of counted) {
    const row = byService.get(serviceOfRequest.get(d.requestId as string) as string)!;
    row.decisions += 1;
    if (AUTONOMOUS(d)) row.autonomous += 1;
    if (!agentsSeen.has(row.code)) agentsSeen.set(row.code, new Set());
    agentsSeen.get(row.code)!.add(d.agentId);
    if (!touchedRequests.has(row.code)) touchedRequests.set(row.code, new Set());
    touchedRequests.get(row.code)!.add(d.requestId as string);
    const at = new Date(d.at).toISOString();
    if (!row.lastAt || at > row.lastAt) row.lastAt = at;
  }
  for (const row of byService.values()) {
    row.agents = [...(agentsSeen.get(row.code) ?? [])].sort();
    row.touched = touchedRequests.get(row.code)?.size ?? 0;
    row.covered = row.decisions > 0;
  }

  const rows = [...byService.values()].sort((a, b) => (b.decisions - a.decisions) || a.code.localeCompare(b.code));
  const covered = rows.filter((r) => r.covered).length;
  const autonomousServices = rows.filter((r) => r.autonomous > 0).length;
  const requestsTouched = rows.reduce((n, r) => n + r.touched, 0);
  const serviceRate = pct(covered, active.length);

  const domains = [...new Set(active.map((s) => s.domain))].sort((a, b) => a - b);
  const byDomain: DomainCoverage[] = domains.map((domain) => {
    const inDomain = rows.filter((r) => r.domain === domain);
    return {
      domain, services: inDomain.length, covered: inDomain.filter((r) => r.covered).length,
      rate: pct(inDomain.filter((r) => r.covered).length, inDomain.length),
      requests: inDomain.reduce((n, r) => n + r.requests, 0),
      touched: inDomain.reduce((n, r) => n + r.touched, 0),
    };
  });

  const t = requiredRate(now, opts.start);
  // how many more services must be covered to stand at the rate owed, and at the end of the schedule
  const needed = (target: number) => Math.max(0, Math.ceil((target / 100) * active.length) - covered);

  return {
    windowDays: opts.windowDays, from: new Date(since).toISOString(), to: now.toISOString(),
    services: active.length, covered, serviceRate,
    autonomousServices, autonomousRate: pct(autonomousServices, active.length),
    requests: reqInWindow.length, requestsTouched, requestRate: pct(requestsTouched, reqInWindow.length),
    withoutRequests: rows.filter((r) => r.requests === 0).length,
    target: {
      ...t,
      meets: serviceRate == null ? null : serviceRate >= t.required,
      servicesToRequired: needed(t.required),
      servicesToEndTarget: needed(t.endTarget),
    },
    byDomain, rows,
  };
}
