import { getJurisdiction, type JurisdictionProfile } from '@maritime/contracts';
import { EVIDENCE } from '@maritime/world';

/* The statutory rules of ship registration, kept apart from the transport that carries them.
 *
 * Nothing here reaches the database or the request. It takes a registration file, the ship it is about and
 * the two facts the controller has to go and fetch — whether the ship already sits on the register, and the
 * money outstanding against her — and returns what the registrar is entitled to conclude. That makes every
 * rule testable on its own, which matters more here than anywhere else: these are the checks that decide
 * whether a ship gets a nationality. */

export type Row = Record<string, any>;
export const REGISTRATION_KINDS_SUPPORTED = ['PERMANENT', 'PROVISIONAL', 'AMENDMENT', 'DELETION'] as const;
export type RegistrationKind = (typeof REGISTRATION_KINDS_SUPPORTED)[number];

/** How long the registry gives itself, and what it charges. A first registration is a longer piece of work than a change of manager. */
export const SLA_DAYS: Record<RegistrationKind, number> = { PERMANENT: 30, PROVISIONAL: 7, AMENDMENT: 15, DELETION: 15 };
export const FEES: Record<string, Record<RegistrationKind, number>> = {
  AE: { PERMANENT: 5000, PROVISIONAL: 1500, AMENDMENT: 1000, DELETION: 500 },
  IN: { PERMANENT: 50000, PROVISIONAL: 15000, AMENDMENT: 10000, DELETION: 5000 },
};
export const CERT_SERIES: Record<RegistrationKind, string> = { PERMANENT: 'CR', PROVISIONAL: 'PCR', AMENDMENT: 'CR', DELETION: 'DEL' };
export const feesFor = (profile: string): Record<RegistrationKind, number> => FEES[getJurisdiction(profile).code] ?? FEES.AE;
export const kindLabel = (k: string) => String(k || '').replace(/_/g, ' ').toLowerCase();

export const portsOfRegistry = (profile: string) => getJurisdiction(profile).registry.portsOfRegistry;
export const defaultPort = (profile: string) => getJurisdiction(profile).registry.defaultPort;
export const portName = (code: string | null | undefined, profile: string) => portsOfRegistry(profile).find((p) => p.code === String(code || '').toUpperCase())?.name ?? '';
export const isKnownPort = (code: string | null | undefined, profile: string) => !!portName(code, profile);

/** The share divisor and the owner ceiling in force, with their provenance. */
export function shareRules(profile: string) {
  const r = getJurisdiction(profile).registry;
  return { denominator: r.shareDenominator.value, maxOwners: r.maxRegisteredOwners.value, confirmed: r.shareDenominator.confirmed && r.maxRegisteredOwners.confirmed, sources: [r.shareDenominator.source, r.maxRegisteredOwners.source] };
}
/** Reduce an ownership list to the facts the registrar checks it against. */
export function shareLedger(owners: Row[] = [], profile: string) {
  const { denominator, maxOwners } = shareRules(profile);
  const held = owners.reduce((s, o) => s + (Number(o.shares) || 0), 0);
  return { denominator, held, balanced: held === denominator, owners: owners.length, maxOwners, withinLimit: owners.length > 0 && owners.length <= maxOwners };
}

/* A ship of this flag must be owned by nationals, or by a body established under its law with its principal
 * place of business there, or by a co-operative society registered there. A body corporate therefore
 * qualifies on its registration number, not on anyone's personal nationality — which is why the two are
 * tested differently. */
export function qualifies(owner: Row | null | undefined, j: JurisdictionProfile): { ok: boolean; why: string } {
  if (!owner) return { ok: false, why: 'No owner recorded' };
  if (owner.kind === 'INDIVIDUAL') {
    const nat = String(owner.nationality || '');
    return nat.toLowerCase() === j.name.toLowerCase()
      ? { ok: true, why: `National of ${j.name}` }
      : { ok: false, why: `${owner.name} is recorded as ${nat || 'of unstated nationality'}` };
  }
  if (owner.registrationNo || owner.cin || owner.companyId) return { ok: true, why: `Body established under the law of ${j.name}` };
  return { ok: false, why: `${owner.name} has no ${j.identity.companyIdLabel.toLowerCase()} on record` };
}

/** Which conditional evidence requirements are live for this particular file. */
export function conditionsFor(doc: Row, j: JurisdictionProfile): Record<string, boolean> {
  const types: string[] = doc.amendment?.types ?? [];
  return {
    previouslyForeign: !!(doc.previousFlag && doc.previousFlag.toLowerCase() !== j.name.toLowerCase() && doc.previousFlag.toUpperCase() !== j.code),
    nameChange: types.includes('NAME'), ownershipChange: types.includes('OWNERSHIP'), tonnageChange: types.includes('TONNAGE'),
    encumbered: (doc.encumbrances ?? []).some((e: Row) => !e.dischargedOn),
    soldForeign: doc.deletion?.reason === 'SOLD_FOREIGN',
  };
}
/** The evidence this file must carry, conditionals resolved. */
export function requiredEvidence(doc: Row, profile: string) {
  const cond = conditionsFor(doc, getJurisdiction(profile));
  return (EVIDENCE[doc.kind] ?? []).filter((e) => !e.when || cond[e.when]);
}

export interface Check { check: string; passed: boolean; blocking: boolean; detail: string }
export const check = (name: string, passed: boolean, blocking: boolean, detail: string): Check => ({ check: name, passed, blocking, detail });
export interface Context { onRegister?: boolean; outstandingDues?: number; currency?: string; bridging?: boolean }

/** Every check the registrar runs, in one place. `context` carries what only the database can answer. */
export function registrationChecks(doc: Row, vessel: Row | null, context: Context, profile: string): Check[] {
  const j = getJurisdiction(profile);
  const out: Check[] = [];
  const { onRegister = false, outstandingDues = 0, currency = j.currency.code, bridging = false } = context;
  const first = doc.kind === 'PERMANENT' || doc.kind === 'PROVISIONAL';

  // 1. the ship's standing on the register
  if (first) {
    out.push(check('Ship is not already on the register', !onRegister, true, onRegister ? `${vessel?.name ?? 'This ship'} already holds a registry entry` : 'No subsisting entry'));
    if (bridging) out.push(check('Supersedes a provisional certificate', true, false, 'The provisional entry closes on grant of the permanent certificate, and the official number carries forward'));
  } else {
    out.push(check('Ship holds a subsisting registry entry', onRegister, true, onRegister ? 'On the register' : 'No granted registration found for this ship'));
  }

  // 2. port of registry
  const known = isKnownPort(doc.portOfRegistry, profile);
  out.push(check('Port of registry is a declared port', known, true, known ? `${portName(doc.portOfRegistry, profile)} (${doc.portOfRegistry})` : `${doc.portOfRegistry || 'None'} is not a declared port of registry`));

  // 3. ownership — only where ownership is in issue
  if (first || (doc.amendment?.types ?? []).includes('OWNERSHIP')) {
    const ledger = shareLedger(doc.owners ?? [], profile);
    out.push(check('Ownership shares account for the whole ship', ledger.balanced, true, `${ledger.held} of ${ledger.denominator} shares allotted across ${ledger.owners} owner(s)`));
    out.push(check('Registered owners within the statutory maximum', ledger.withinLimit, true, ledger.owners === 0 ? 'No owners recorded' : `${ledger.owners} owner(s), maximum ${ledger.maxOwners}`));
    const failed = (doc.owners ?? []).map((o: Row) => qualifies(o, j)).filter((q: { ok: boolean }) => !q.ok);
    out.push(check(`Every owner qualifies to own a ship of ${j.name}`, failed.length === 0, true, failed.length ? failed.map((f: { why: string }) => f.why).join('; ') : `${(doc.owners ?? []).length} owner(s) qualify`));
  }

  // 4. tonnage
  if (first) {
    const t = doc.tonnage ?? {};
    const measured = !!(t.gross && t.net);
    out.push(check('Tonnage measured and certified', measured, doc.kind === 'PERMANENT', measured ? `${t.gross} GT / ${t.net} NT, certificate ${t.certificateNo || 'not referenced'}` : 'Gross and net tonnage not recorded'));
    if (measured && vessel?.grt) {
      const drift = Math.abs(Number(t.gross) - Number(vessel.grt)) / Number(vessel.grt);
      out.push(check('Declared tonnage agrees with the fleet record', drift <= 0.02, false, drift <= 0.02 ? `Within tolerance of the recorded ${vessel.grt} GT` : `Declared ${t.gross} GT against ${vessel.grt} GT on the fleet record`));
    }
  }

  // 5. evidence on file
  const required = requiredEvidence(doc, profile).filter((e) => e.mandatory);
  const held = new Set((doc.evidence ?? []).map((e: Row) => e.key));
  const absent = required.filter((e) => !held.has(e.key));
  out.push(check('Mandatory evidence on file', absent.length === 0, true, absent.length ? `Not lodged: ${absent.map((e) => e.label).join(', ')}` : `${required.length} mandatory document(s) lodged`));
  const unverified = (doc.evidence ?? []).filter((e: Row) => required.some((r) => r.key === e.key) && !e.verified);
  out.push(check('Lodged evidence verified by the registry', unverified.length === 0, false, unverified.length ? `${unverified.length} document(s) awaiting verification` : 'All mandatory evidence verified'));

  // 6. carving and marking — a permanent certificate cannot be granted until the official number is cut into the ship and a surveyor has said so
  if (doc.kind === 'PERMANENT') {
    const cn = doc.carvingNote ?? null;
    const complied = !!cn?.compliedOn;
    out.push(check('Carving and marking note complied with', complied, true, complied ? `Reported by ${cn.surveyor || 'surveyor'} on ${new Date(cn.compliedOn).toISOString().slice(0, 10)}` : cn?.issuedOn ? 'Note issued, compliance not yet reported' : 'Carving and marking note not yet issued'));
  }

  // 7. closure — nothing leaves the register owing money or carrying a mortgage
  if (doc.kind === 'DELETION') {
    const live = (doc.encumbrances ?? []).filter((e: Row) => !e.dischargedOn);
    out.push(check('No subsisting mortgage or charge', live.length === 0, true, live.length ? `${live.length} undischarged: ${live.map((e: Row) => `${String(e.kind).toLowerCase()} in favour of ${e.holder}`).join(', ')}` : 'Encumbrance register clear'));
    out.push(check('Port dues and charges settled', outstandingDues <= 0, true, outstandingDues > 0 ? `${currency} ${outstandingDues.toLocaleString(j.currency.locale)} outstanding against this ship` : 'Nothing outstanding'));
    const reason = doc.deletion?.reason;
    out.push(check('Ground for closure stated', !!reason, true, reason ? kindLabel(reason) : 'No ground recorded'));
    if (reason === 'SOLD_FOREIGN') out.push(check('Receiving flag stated', !!doc.deletion?.newFlag, true, doc.deletion?.newFlag || 'The flag the ship transfers to must be stated on the deletion certificate'));
  }

  // 8. amendment — what is being altered has to be said
  if (doc.kind === 'AMENDMENT') {
    const types: string[] = doc.amendment?.types ?? [];
    out.push(check('Nature of the alteration stated', types.length > 0, true, types.length ? types.map(kindLabel).join(', ') : 'No alteration type selected'));
    if (types.includes('NAME')) {
      const approved = !!doc.amendment?.approvalReference;
      out.push(check('New name approved in advance', approved, true, approved ? `Approval ${doc.amendment.approvalReference}` : 'A ship may not be renamed without prior approval'));
    }
  }

  // 9. the ship itself
  if (vessel) out.push(check('Fleet record is active', vessel.status === 'ACTIVE', false, `Vessel record is ${String(vessel.status || '').toLowerCase()}`));
  return out;
}

export const blocking = (checks: Check[]) => checks.filter((c) => c.blocking && !c.passed);

/** What a registration form needs to render: the registrar, the ports, the share rules, the fees and the evidence per journey. */
export function reference(profile: string) {
  const j = getJurisdiction(profile);
  const fees = feesFor(profile);
  return {
    registrar: j.registry.registrar, statute: j.registry.statute.value, nationalityRule: j.registry.nationalityRule,
    portsOfRegistry: j.registry.portsOfRegistry.map((p) => ({ code: p.code, name: p.name, state: p.region, default: p.code === j.registry.defaultPort })),
    defaultPort: j.registry.defaultPort, shareRules: shareRules(profile),
    kinds: REGISTRATION_KINDS_SUPPORTED.map((k) => ({ kind: k, slaDays: SLA_DAYS[k], fee: fees[k], currency: j.currency.code, evidence: EVIDENCE[k] ?? [] })),
    provisionalValidityMonths: j.registry.provisionalValidityMonths.value,
  };
}
