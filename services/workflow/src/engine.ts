/* The one runtime that interprets every service definition: an action is validated against the current state, the caller's
 * roles and the transition's guard, its effects run in order (fees, checklist, notifications, instrument issue, field
 * patches, rule-set calls), the timeline grows, END states map to the request lifecycle and the events go out. */
import { EVENTS, REQUEST_STATUS, getJurisdiction, hasPerm, instrumentClassOf, type EventEnvelope, type RequestStatus } from '@maritime/contracts';
import { badRequest, conflict, eventFromContext, forbidden, unprocessable } from '@maritime/service-kit';
import type { DefinitionContent, Effect, State, Transition } from './schema';
import type { RulesClient } from './rules/client';
import { truthy } from './rules/expr';

/** `organisationCode` is the tenancy key; `organisation` is only its label. */
export interface Applicant { userId: string | null; name: string; email: string; phone: string; organisation: string; organisationCode: string }
export interface RequestDocument { code: string; documentId: string | null; name: string; uploadedAt: string; verified: boolean; verifiedBy: string | null; verifiedAt: string | null; notes: string }
export interface FeeLine { code: string; description: string; descriptionAr: string | null; unit?: string | null; qty: number; rate: number; amount: number; taxable: boolean }
export interface Fees { lines: FeeLine[]; subtotal: number; taxRatePct: number; taxAmount: number; total: number; currency: string; ruleSetKey: string | null; ruleSetVersion: number | null; computedAt: string }
export interface Payment { status: 'NOT_REQUIRED' | 'DUE' | 'PAID'; amount: number; currency: string; paidAt: string | null; reference: string }
export interface Assignee { userId: string | null; name: string }
export interface TimelineEntry { from: string; to: string; action: string; at: string; by: { id: string | null; name: string }; note: string; effects?: string[]; checks?: unknown[] }
export interface EngineActor { id: string; name: string; email?: string; perms: readonly string[]; kind?: string }
export interface RequestState {
  id: string; number: string; definitionId: string; definitionKey: string; definitionName: string; definitionNameAr: string | null; definitionVersion: number; environment: string; category: string; domain: number;
  subjectKind: string; subjectId: string | null; subjectName: string; subject: Record<string, unknown>; applicant: Applicant; status: RequestStatus; currentState: string;
  formData: Record<string, unknown>; documents: RequestDocument[]; fees: Fees | null; payment: Payment | null; assignee: Assignee | null; checks: unknown[];
  slaDueAt: string | null; slaBreached: boolean; slaBreachedAt: string | null; submittedAt: string | null; decidedAt: string | null; closedAt: string | null;
  issuedInstrument: Record<string, unknown> | null; timeline: TimelineEntry[]; createdBy: string | null; createdAt: string; updatedAt: string;
}
export interface EngineOptions { source: string; jurisdiction?: string; now?: () => Date }
export interface TransitionResult { request: RequestState; entry: TimelineEntry; events: EventEnvelope[]; effects: string[] }
export interface AvailableAction { action: string; label: string; labelAr: string | null; to: string; requireNote: boolean; roles: string[] }

export const D = 86_400_000;
const minor = (n: number) => Math.round(n * 100);
const iso = (t: number | Date) => new Date(t).toISOString();
const isStatus = (s: string): s is RequestStatus => (REQUEST_STATUS as readonly string[]).includes(s);

export class WorkflowEngine {
  constructor(private readonly rules: RulesClient, private readonly opts: EngineOptions) {}
  now() { return this.opts.now?.() ?? new Date(); }
  /** The same client under different options — the simulator pins the clock. */
  withOptions(o: Partial<EngineOptions>) { return new WorkflowEngine(this.rules, { ...this.opts, ...o }); }
  evaluateExpr(expr: unknown, ctx: Record<string, unknown>) { return this.rules.evaluateExpr(expr, ctx, this.now()); }
  private jurisdiction() { return getJurisdiction(this.opts.jurisdiction); }
  stateOf(content: DefinitionContent, key: string): State | undefined { return content.workflow.states.find((s) => s.key === key); }
  startState(content: DefinitionContent): State { const s = content.workflow.states.find((x) => x.kind === 'START'); if (!s) throw conflict('The workflow has no START state'); return s; }
  allowed(t: Transition, actor: EngineActor): boolean { return t.roles.includes('*') || t.roles.some((r) => hasPerm(actor.perms, r)); }
  availableActions(content: DefinitionContent, request: RequestState, actor: EngineActor): AvailableAction[] {
    return content.workflow.transitions.filter((t) => t.from === request.currentState && this.allowed(t, actor)).map((t) => ({ action: t.action, label: t.label, labelAr: t.labelAr ?? null, to: t.to, requireNote: t.requireNote, roles: t.roles }));
  }
  /** What guards, fee lines and checks see: the form, the checklist, the subject, the request itself, the definition and the caller. */
  context(request: RequestState, content: DefinitionContent, actor: EngineActor, payload: Record<string, unknown> = {}): Record<string, unknown> {
    const defs = new Map(content.documents.map((d) => [d.code, d]));
    return {
      form: request.formData, documents: request.documents.map((d) => ({ ...d, required: defs.get(d.code)?.required ?? false, label: defs.get(d.code)?.label ?? d.code })),
      subject: { kind: request.subjectKind, id: request.subjectId, name: request.subjectName, ...request.subject },
      request: { id: request.id, number: request.number, status: request.status, state: request.currentState, applicant: request.applicant, assignee: request.assignee, submittedAt: request.submittedAt, slaDueAt: request.slaDueAt, slaBreached: request.slaBreached, fees: request.fees, payment: request.payment, checks: request.checks, createdAt: request.createdAt, expedited: request.formData.expedited === true },
      definition: { key: request.definitionKey, name: request.definitionName, version: request.definitionVersion, subjectKind: request.subjectKind, slaDays: content.sla.days, category: request.category },
      actor: { id: actor.id, name: actor.name, perms: actor.perms }, payload, now: iso(this.now()),
    };
  }
  /** Fee lines from the definition's FEE rule set (or its inline lines), tax from the jurisdiction profile, totals in exact minor units. */
  async computeFees(content: DefinitionContent, ctx: Record<string, unknown>, ruleSetKey?: string | null): Promise<Fees> {
    const key = ruleSetKey ?? content.fees.ruleSetKey ?? null; const j = this.jurisdiction();
    let lines: FeeLine[] = []; let currency = content.fees.currency ?? j.currency.code; let version: number | null = null;
    if (key) {
      const r = await this.rules.evaluateSet(key, ctx, this.now());
      if (r.kind !== 'FEE') throw unprocessable(`Rule set ${key} is ${r.kind}, not a fee schedule`);
      lines = r.lines.map((l) => ({ code: l.code, description: l.description, descriptionAr: l.descriptionAr, unit: l.unit, qty: l.qty, rate: l.rate, amount: l.amount, taxable: l.taxable })); currency = r.currency ?? currency; version = r.version;
    } else lines = content.fees.lines.filter((l) => l.amount > 0).map((l) => ({ code: l.code, description: l.description, descriptionAr: l.descriptionAr ?? null, unit: 'application', qty: 1, rate: l.amount, amount: l.amount, taxable: l.taxable }));
    const subtotalM = lines.reduce((s, l) => s + minor(l.amount), 0); const taxableM = lines.filter((l) => l.taxable).reduce((s, l) => s + minor(l.amount), 0);
    const taxM = Math.round((taxableM * j.tax.ratePct) / 100);
    return { lines, subtotal: subtotalM / 100, taxRatePct: j.tax.ratePct, taxAmount: taxM / 100, total: (subtotalM + taxM) / 100, currency, ruleSetKey: key, ruleSetVersion: version, computedAt: iso(this.now()) };
  }
  async slaDays(content: DefinitionContent, ctx: Record<string, unknown>): Promise<number> {
    if (!content.sla.ruleSetKey) return content.sla.days;
    const r = await this.rules.evaluateSet(content.sla.ruleSetKey, ctx, this.now());
    if (r.kind !== 'SLA') throw unprocessable(`Rule set ${content.sla.ruleSetKey} is ${r.kind}, not an SLA clock`);
    return r.days;
  }
  private event<T>(type: string, data: T, subject: string): EventEnvelope<T> { return eventFromContext(this.opts.source, type, data, { subject }); }

  /** Runs `action` on the request under the definition version it was lodged against. Throws 409 for an illegal action, 403 for a missing role, 400 for a missing note, 422 when a guard or effect refuses. */
  async transition(request: RequestState, content: DefinitionContent, action: string, actor: EngineActor, note = '', payload: Record<string, unknown> = {}): Promise<TransitionResult> {
    const from = this.stateOf(content, request.currentState);
    if (!from) throw conflict(`State ${request.currentState} is not part of workflow version ${request.definitionVersion}`);
    const t = content.workflow.transitions.find((x) => x.from === request.currentState && x.action === action);
    if (!t) { const open = content.workflow.transitions.filter((x) => x.from === request.currentState).map((x) => x.action); throw conflict(`Action "${action}" is not available from ${request.currentState}${open.length ? ` (available: ${open.join(', ')})` : ''}`); }
    if (!this.allowed(t, actor)) throw forbidden(`Action "${action}" requires ${t.roles.join(' or ')}`);
    if (t.requireNote && !note.trim()) throw badRequest(`A note is required to ${t.label.toLowerCase()}`);
    const to = this.stateOf(content, t.to);
    if (!to) throw conflict(`Target state ${t.to} is not part of the workflow`);
    const now = this.now(); const req: RequestState = structuredClone(request);
    if (payload.formData && typeof payload.formData === 'object') req.formData = { ...req.formData, ...(payload.formData as Record<string, unknown>) };
    const ctx = this.context(req, content, actor, payload);
    if (t.guard !== undefined && !truthy(await this.rules.evaluateExpr(t.guard, ctx, now))) throw unprocessable(`Guard of action "${action}" is not satisfied`, { action, guard: t.guard });
    const targetStatus: RequestStatus = to.kind === 'END' ? (to.outcome ?? req.status) : (to.status ?? (isStatus(to.key) ? to.key : req.status));
    const events: EventEnvelope[] = []; const effects: string[] = []; let checks: unknown[] | undefined;
    const subject = `ServiceRequest:${req.number}`;
    for (const e of t.effects) {
      const r = await this.runEffect(e, req, content, ctx, actor, t, to, targetStatus, note, events, subject);
      if (r) checks = r;
      effects.push(e.type);
    }
    const wasSubmitted = !!req.submittedAt;
    req.currentState = to.key; req.status = targetStatus;
    if (targetStatus === 'SUBMITTED' && !req.submittedAt) { req.submittedAt = iso(now); const days = await this.slaDays(content, ctx); req.slaDueAt = iso(now.getTime() + days * D); req.slaBreached = false; req.slaBreachedAt = null; }
    if ((targetStatus === 'APPROVED' || targetStatus === 'REJECTED') && !req.decidedAt) req.decidedAt = iso(now);
    if (to.kind === 'END') { req.closedAt = iso(now); req.slaBreached = req.slaBreached && !!req.slaBreachedAt; }
    if (to.kind === 'TASK' && to.assignRole && !req.assignee?.userId && hasPerm(actor.perms, to.assignRole)) req.assignee = { userId: actor.id, name: actor.name };
    const entry: TimelineEntry = { from: from.key, to: to.key, action, at: iso(now), by: { id: actor.id, name: actor.name }, note, effects, ...(checks ? { checks } : {}) };
    req.timeline = [...req.timeline, entry]; req.updatedAt = iso(now);
    const base = { requestId: req.id, requestNo: req.number, definitionKey: req.definitionKey, definitionName: req.definitionName, subjectKind: req.subjectKind, subjectId: req.subjectId, applicant: req.applicant };
    events.push(this.event(EVENTS.workflow.requestTransitioned, { ...base, from: from.key, to: to.key, action, status: req.status, actor: { id: actor.id, name: actor.name }, note }, subject));
    if (targetStatus === 'SUBMITTED' && !wasSubmitted) events.push(this.event(EVENTS.workflow.requestSubmitted, { ...base, submittedAt: req.submittedAt, slaDueAt: req.slaDueAt }, subject));
    if (targetStatus === 'APPROVED' || targetStatus === 'REJECTED') events.push(this.event(EVENTS.workflow.requestDecided, { ...base, outcome: targetStatus, decidedAt: req.decidedAt, note }, subject));
    events.push(this.event(EVENTS.readModel.upserted, { kind: 'serviceRequest', entity: req }, subject));
    return { request: req, entry, events, effects };
  }

  private async runEffect(e: Effect, req: RequestState, content: DefinitionContent, ctx: Record<string, unknown>, actor: EngineActor, t: Transition, to: State, targetStatus: RequestStatus, note: string, events: EventEnvelope[], subject: string): Promise<unknown[] | undefined> {
    const p = e.params; const now = this.now();
    switch (e.type) {
      case 'computeFee': {
        const fees = await this.computeFees(content, ctx, typeof p.ruleSetKey === 'string' ? p.ruleSetKey : undefined);
        req.fees = fees;
        req.payment = fees.total > 0 ? (req.payment?.status === 'PAID' ? req.payment : { status: 'DUE', amount: fees.total, currency: fees.currency, paidAt: null, reference: '' }) : { status: 'NOT_REQUIRED', amount: 0, currency: fees.currency, paidAt: null, reference: '' };
        (ctx.request as Record<string, unknown>).fees = fees;
        return undefined;
      }
      case 'requireDocuments': {
        const mode = p.mode === 'attached' ? 'attached' : 'verified'; const missing: string[] = []; const unverified: string[] = [];
        for (const d of content.documents) {
          if (!d.required) continue;
          if (d.whenExpr !== undefined && !truthy(await this.rules.evaluateExpr(d.whenExpr, ctx, now))) continue;
          const attached = req.documents.find((x) => x.code === d.code);
          if (!attached) missing.push(d.label); else if (mode === 'verified' && !attached.verified) unverified.push(d.label);
        }
        if (missing.length || unverified.length) throw unprocessable([missing.length ? `Missing documents: ${missing.join(', ')}` : '', unverified.length ? `Documents not yet verified: ${unverified.join(', ')}` : ''].filter(Boolean).join('; '), { missing, unverified });
        return undefined;
      }
      case 'notify': {
        const audience = p.audience === 'staff' || p.audience === 'assignee' ? p.audience : 'applicant';
        events.push(this.event(EVENTS.workflow.requestNotify, {
          requestId: req.id, requestNo: req.number, definitionKey: req.definitionKey, definitionName: req.definitionName, action: t.action, state: to.key, status: targetStatus, template: typeof p.template === 'string' ? p.template : `request.${t.action}`, audience,
          userId: audience === 'applicant' ? req.applicant.userId : audience === 'assignee' ? req.assignee?.userId ?? null : null, audiencePerm: audience === 'staff' ? (typeof p.perm === 'string' ? p.perm : 'services.assess') : null,
          title: typeof p.title === 'string' ? p.title : `${req.definitionName}: ${t.label}`, titleAr: typeof p.titleAr === 'string' ? p.titleAr : (req.definitionNameAr && t.labelAr ? `${req.definitionNameAr}: ${t.labelAr}` : null),
          body: note || (typeof p.body === 'string' ? p.body : `Application ${req.number} — ${t.label.toLowerCase()} by ${actor.name}`), link: `/services/requests/${req.id}`,
        }, subject));
        return undefined;
      }
      case 'issueInstrument': {
        const type = typeof p.instrumentType === 'string' ? p.instrumentType : content.outputs.instrumentType;
        if (!type) throw unprocessable('This service does not issue an instrument');
        const klass = content.outputs.instrumentClass ?? instrumentClassOf(type);
        req.issuedInstrument = { id: null, number: null, type, class: klass, status: 'REQUESTED', requestedAt: iso(now), validityMonths: content.outputs.validityMonths ?? null };
        events.push(this.event(EVENTS.workflow.requestIssued, { requestId: req.id, requestNo: req.number, definitionKey: req.definitionKey, instrumentType: type, instrumentClass: klass, validityMonths: content.outputs.validityMonths ?? null, subjectKind: req.subjectKind, subjectId: req.subjectId, subjectName: req.subjectName, applicant: req.applicant, formData: req.formData, checks: req.checks, issuedBy: { id: actor.id, name: actor.name } }, subject));
        return undefined;
      }
      case 'setField': {
        if (typeof p.field !== 'string') throw unprocessable('setField effect has no field');
        req.formData = { ...req.formData, [p.field]: p.value === undefined ? null : await this.rules.evaluateExpr(p.value, ctx, now) };
        ctx.form = req.formData;
        return undefined;
      }
      case 'callService': {
        if (typeof p.ruleSetKey !== 'string') throw unprocessable('callService effect has no ruleSetKey');
        const r = await this.rules.evaluateSet(p.ruleSetKey, ctx, now);
        if (r.kind === 'FEE' || r.kind === 'SLA') return [{ ruleSetKey: p.ruleSetKey, version: r.version, kind: r.kind, result: r.kind === 'FEE' ? { subtotal: r.subtotal, lines: r.lines.length } : { days: r.days } }];
        const checks = r.results.map((x) => ({ check: x.code, passed: !x.failed, blocking: x.severity === 'ERROR', detail: x.message, detailAr: x.messageAr, ruleSetKey: p.ruleSetKey, version: r.version }));
        req.checks = [...req.checks.filter((c) => (c as { ruleSetKey?: string }).ruleSetKey !== p.ruleSetKey), ...checks];
        if (!r.passed && p.block !== false) throw unprocessable(`Eligibility not met: ${r.results.filter((x) => x.failed && x.severity === 'ERROR').map((x) => x.message).join('; ')}`, { checks });
        return checks;
      }
      default: return undefined;
    }
  }
}

export const WORKFLOW_ENGINE = Symbol('WORKFLOW_ENGINE');
export const RULES_CLIENT = Symbol('RULES_CLIENT');
