import type { AiGatewayClient, GatewayRun } from '@maritime/service-kit';

/* What an agent's conclusion does to a record, once the ladder allows it — as tool calls through the tool
 * gateway, never as a query of its own. The map is deliberately short and reversible: a note on an application,
 * a request for what is missing. Issuing, approving, cancelling and paying are absent by design; those remain a
 * person's acts, and a person who accepts an agent's "eligible" conclusion carries it through as themselves. */

type Row = Record<string, any>;
export interface PlannedAction { tool: string; args: Record<string, unknown>; label: string }
export interface ExecutionRecord { tool: string; label: string; outcome: 'OK' | 'REFUSED' | 'FAILED' | 'DRY_RUN' | 'SKIPPED'; code?: string; reason?: string; callId?: string; status?: number; at: string; as: 'agent' | 'person' }

const list = (v: unknown, n = 6) => (Array.isArray(v) ? v.map(String).slice(0, n).join(', ') : '');

/** The actions an applied or accepted conclusion carries: none for most, one or two for the agents that touch an application. */
export function actionsFor(agentId: string, decision: { subjectType: string; subjectId: string; subjectLabel: string; output: Row; explanation: string; agentName: string }): PlannedAction[] {
  const out = decision.output ?? {};
  const id = decision.subjectId;
  if (!id) return [];
  switch (agentId) {
    case 'a1_document_intelligence': {
      if (decision.subjectType !== 'ServiceRequest') return [];
      const missing = Array.isArray(out.missing) ? out.missing : []; const failed = Array.isArray(out.failedChecks) ? out.failedChecks : [];
      if (missing.length) return [{ tool: 'services.request_info', args: { id, note: `${decision.agentName}: ${missing.length} mandatory document(s) are missing — ${list(missing)}. Please lodge them so the application can proceed.` }, label: 'Ask the applicant for the missing documents' }];
      if (failed.length) return [{ tool: 'services.add_note', args: { id, body: `${decision.agentName}: ${failed.length} integrity check(s) failed — ${list(failed)}.` }, label: 'Record the failed integrity checks on the file' }];
      return [{ tool: 'services.add_note', args: { id, body: `${decision.agentName}: every required document is on file and every integrity check passed.${Array.isArray(out.unverified) && out.unverified.length ? ` Awaiting verification: ${list(out.unverified)}.` : ''}` }, label: 'Record that the documents were validated' }];
    }
    case 'a3_service_processing': {
      if (decision.subjectType !== 'ServiceRequest') return [];
      const gates = Array.isArray(out.gates) ? out.gates as { gate: string; passed: boolean; detail: string }[] : [];
      const blocking = gates.filter((g) => !g.passed && g.gate !== 'Applicant has prior history');
      if (out.eligible) return [{ tool: 'services.add_note', args: { id, body: `${decision.agentName}: all ${gates.length} eligibility gates pass; recommended for issue. Accepted on review.` }, label: 'Record the eligibility finding for the issuing officer' }];
      const docsMissing = blocking.find((g) => g.gate === 'Mandatory documents on file');
      if (docsMissing) return [{ tool: 'services.request_info', args: { id, note: `${decision.agentName}: held at the documents gate — ${docsMissing.detail}. Please lodge the missing documents.` }, label: 'Ask the applicant for what the gate needs' }];
      return [{ tool: 'services.add_note', args: { id, body: `${decision.agentName}: held at ${blocking.length} gate(s) — ${blocking.map((g) => `${g.gate}: ${g.detail}`).join('; ')}.` }, label: 'Record the hold and its reasons on the file' }];
    }
    case 'a4_customer_guidance': {
      if (decision.subjectType !== 'ServiceRequest' || !out.message) return [];
      return [{ tool: 'services.add_note', args: { id, body: `To the applicant — ${String(out.message)}` }, label: 'Tell the applicant where the application stands' }];
    }
    default:
      return [];
  }
}

/**
 * Carries the planned actions through the gateway. As the agent (no token: the gateway mints one for the agent's own
 * identity) when the ladder applied the conclusion itself; as the person who accepted it, with their token, when a
 * human carried it. Every outcome is kept, a refusal included: the record says what was tried, not only what worked.
 */
export async function executeActions(gateway: AiGatewayClient, actions: PlannedAction[], who: { caller: string; userToken?: string }, ctx: { decisionId: string; cause?: string }): Promise<ExecutionRecord[]> {
  const out: ExecutionRecord[] = [];
  for (const a of actions) {
    const at = new Date().toISOString();
    try {
      const r: GatewayRun = await gateway.run(who.caller, a.tool, a.args, { userToken: who.userToken, decisionId: ctx.decisionId, cause: ctx.cause ?? 'decision' });
      out.push({ tool: a.tool, label: a.label, outcome: r.outcome, code: r.code, reason: r.reason, callId: r.callId, status: r.status, at, as: who.userToken ? 'person' : 'agent' });
    } catch (err) {
      out.push({ tool: a.tool, label: a.label, outcome: 'FAILED', reason: (err as Error).message, at, as: who.userToken ? 'person' : 'agent' });
    }
  }
  return out;
}
