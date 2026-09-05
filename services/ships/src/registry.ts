import { getJurisdiction, livesOnRegister, type JurisdictionProfile } from '@maritime/contracts';
import { lookupOptions, type LookupOption, type Queryable } from '@maritime/service-kit';

/* The statutory rules of ship registration, kept apart from the transport that carries them.
 *
 * Nothing here reaches the database or the request. It takes a registration file, the ship it is about and
 * the two facts the controller has to go and fetch — whether the ship already sits on the register, and the
 * money outstanding against her — and returns what the registrar is entitled to conclude. That makes every
 * rule testable on its own, which matters more here than anywhere else: these are the checks that decide
 * whether a ship gets a nationality. */

export type Row = Record<string, any>;
export type KindFamily = 'FIRST' | 'ALTER' | 'OUT' | 'CLOSE' | 'DOCUMENT';
export interface EvidenceRule { key: string; label: string; mandatory: boolean; when?: string }
/* Everything the runtime knows about a registration variant, read from the `registrationKind` master: the family it
 * belongs to (opens an entry, alters it, suspends it for a bareboat charter out, closes it, or issues a document
 * against it), its SLA, what it issues and for how long, the certificate series, the state the ship enters on grant,
 * the fee and the evidence the file must carry. A tenth variant is a row in Data Studio, not a release. */
export interface KindRule {
  code: string; label: string; labelAr: string | null; family: KindFamily; slaDays: number; validityMonths: number | null;
  issuesCertificate: boolean; closesRegistry: boolean; registryState: string | null; series: string; transactionType: string | null; carving: boolean; fee: number; evidence: EvidenceRule[]; order: number;
}
const FAMILIES: KindFamily[] = ['FIRST', 'ALTER', 'OUT', 'CLOSE', 'DOCUMENT'];
export function ruleOf(o: LookupOption): KindRule {
  const m = o.meta ?? {};
  const family = FAMILIES.includes(String(m.family) as KindFamily) ? (String(m.family) as KindFamily) : 'FIRST';
  return {
    code: o.code, label: o.label, labelAr: o.labelAr, family, slaDays: Math.max(1, Number(m.slaDays) || 30), validityMonths: m.validityMonths == null || m.validityMonths === '' ? null : Math.max(1, Number(m.validityMonths) || 1),
    issuesCertificate: m.issuesCertificate !== false, closesRegistry: m.closesRegistry === true || family === 'CLOSE', registryState: m.registryState ? String(m.registryState) : null,
    series: String(m.series || 'CR'), transactionType: m.transactionType ? String(m.transactionType) : null, carving: m.carving === true, fee: Number(m.fee) || 0,
    evidence: Array.isArray(m.evidence) ? (m.evidence as EvidenceRule[]).filter((e) => e && e.key) : [], order: Number(m.order) || 99,
  };
}
/** The variants the master declares, keyed by code and in the master's order. */
export async function kindRules(c: Queryable): Promise<Map<string, KindRule>> {
  const rows = (await lookupOptions(c, 'registrationKind')).map(ruleOf).sort((a, b) => a.order - b.order || a.code.localeCompare(b.code));
  return new Map(rows.map((r) => [r.code, r]));
}
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
export function conditionsFor(doc: Row, j: JurisdictionProfile, vessel?: Row | null, liveEncumbrances = 0): Record<string, boolean> {
  const types: string[] = doc.amendment?.types ?? [];
  return {
    previouslyForeign: !!(doc.previousFlag && doc.previousFlag.toLowerCase() !== j.name.toLowerCase() && doc.previousFlag.toUpperCase() !== j.code),
    nameChange: types.includes('NAME'), ownershipChange: types.includes('OWNERSHIP'), tonnageChange: types.includes('TONNAGE'),
    encumbered: liveEncumbrances > 0 || (doc.encumbrances ?? []).some((e: Row) => !e.dischargedOn),
    soldForeign: doc.deletion?.reason === 'SOLD_FOREIGN',
    fromBareboat: vessel?.registry_state === 'BAREBOAT_OUT' || vessel?.registry?.state === 'BAREBOAT_OUT',
  };
}
/** The evidence this file must carry, conditionals resolved. */
export function requiredEvidence(doc: Row, rule: KindRule, profile: string, vessel?: Row | null, liveEncumbrances = 0): EvidenceRule[] {
  const cond = conditionsFor(doc, getJurisdiction(profile), vessel, liveEncumbrances);
  return rule.evidence.filter((e) => !e.when || cond[e.when]);
}

export interface Check { check: string; passed: boolean; blocking: boolean; detail: string }
export const check = (name: string, passed: boolean, blocking: boolean, detail: string): Check => ({ check: name, passed, blocking, detail });
export interface Context { onRegister?: boolean; outstandingDues?: number; currency?: string; bridging?: boolean; caveats?: number; liveEncumbrances?: Row[]; registryState?: string }

/** Every check the registrar runs, in one place. `context` carries what only the database can answer. */
export function registrationChecks(doc: Row, vessel: Row | null, context: Context, profile: string, rule: KindRule): Check[] {
  const j = getJurisdiction(profile);
  const out: Check[] = [];
  const { onRegister = false, outstandingDues = 0, currency = j.currency.code, bridging = false, caveats = 0, liveEncumbrances = [], registryState = vessel?.registry_state ?? 'UNREGISTERED' } = context;
  const first = rule.family === 'FIRST';
  const p: Row = doc.particulars ?? {};
  const today = new Date();

  // 1. the ship's standing on the register
  if (first && rule.code === 'RE_REGISTRATION') {
    const returning = registryState === 'BAREBOAT_OUT' || registryState === 'CLOSED';
    out.push(check('Entry is returning to the register', returning, true, returning ? `Entry is ${kindLabel(registryState)}` : `${vessel?.name ?? 'This ship'} is ${kindLabel(registryState)}; re-registration applies to an entry that was closed or chartered out`));
  } else if (first) {
    out.push(check('Ship is not already on the register', !onRegister, true, onRegister ? `${vessel?.name ?? 'This ship'} already holds a registry entry` : 'No subsisting entry'));
    if (registryState === 'BAREBOAT_OUT') out.push(check('Entry is not chartered out', false, true, 'The entry is suspended for a bareboat charter out; she returns by re-registration'));
    if (bridging) out.push(check('Supersedes a provisional certificate', true, false, 'The provisional entry closes on grant of the permanent certificate, and the official number carries forward'));
  } else if (rule.family === 'DOCUMENT') {
    out.push(check('Entry is not closed', registryState !== 'CLOSED', true, registryState === 'CLOSED' ? 'A closed entry takes no document' : `Entry is ${kindLabel(registryState)}`));
  } else {
    out.push(check('Ship holds a subsisting registry entry', onRegister, true, onRegister ? 'On the register' : 'No granted registration found for this ship'));
  }

  // 2. port of registry
  const known = isKnownPort(doc.portOfRegistry, profile);
  out.push(check('Port of registry is a declared port', known, true, known ? `${portName(doc.portOfRegistry, profile)} (${doc.portOfRegistry})` : `${doc.portOfRegistry || 'None'} is not a declared port of registry`));

  // 3. ownership — only where ownership is in issue; a bareboat charter in is held by its charterer, not its owner
  const bareboatIn = rule.registryState === 'BAREBOAT_IN';
  if ((first && !bareboatIn) || (doc.amendment?.types ?? []).includes('OWNERSHIP')) {
    const ledger = shareLedger(doc.owners ?? [], profile);
    out.push(check('Ownership shares account for the whole ship', ledger.balanced, true, `${ledger.held} of ${ledger.denominator} shares allotted across ${ledger.owners} owner(s)`));
    out.push(check('Registered owners within the statutory maximum', ledger.withinLimit, true, ledger.owners === 0 ? 'No owners recorded' : `${ledger.owners} owner(s), maximum ${ledger.maxOwners}`));
    const failed = (doc.owners ?? []).map((o: Row) => qualifies(o, j)).filter((q: { ok: boolean }) => !q.ok);
    out.push(check(`Every owner qualifies to own a ship of ${j.name}`, failed.length === 0, true, failed.length ? failed.map((f: { why: string }) => f.why).join('; ') : `${(doc.owners ?? []).length} owner(s) qualify`));
  }
  if (bareboatIn) {
    const charterer = p.charterer ? { name: p.charterer, kind: p.chartererKind ?? 'BODY_CORPORATE', nationality: p.chartererNationality ?? '', registrationNo: p.chartererRegistrationNo ?? '' } : null;
    const q = qualifies(charterer, j);
    out.push(check(`Bareboat charterer qualifies to hold a ship of ${j.name}`, q.ok, true, charterer ? q.why : 'No charterer recorded'));
    out.push(check('Underlying registry named', !!p.registry, true, p.registry ? String(p.registry) : 'The registry the ship remains owned under must be named'));
  }
  // a charter, in or out, runs to a date in the future
  if (bareboatIn || rule.family === 'OUT') {
    const ends = p.charterEnds ? new Date(p.charterEnds) : null;
    out.push(check('Charter party ends after today', !!ends && ends.getTime() > today.getTime(), true, ends ? `Charter ends ${ends.toISOString().slice(0, 10)}` : 'Charter end date not recorded'));
    if (rule.family === 'OUT') out.push(check('Bareboat registry named', !!p.registry, true, p.registry ? String(p.registry) : 'The registry the ship is chartered out to must be named'));
  }
  if (rule.family === 'DOCUMENT') {
    out.push(check('Voyage stated', !!(p.voyageFrom && p.voyageTo), true, p.voyageFrom && p.voyageTo ? `${p.voyageFrom} → ${p.voyageTo}` : 'The single voyage the pass covers must be stated'));
    const to = p.validTo ? new Date(p.validTo) : null;
    const limit = rule.validityMonths ? new Date(today.getTime() + rule.validityMonths * 30.44 * 86_400_000) : null;
    out.push(check('Pass validity within the permitted term', !!to && (!limit || to.getTime() <= limit.getTime()), true, to ? `Valid to ${to.toISOString().slice(0, 10)}${limit ? ` (limit ${limit.toISOString().slice(0, 10)})` : ''}` : 'Validity end not recorded'));
  }
  if (rule.code === 'UNDER_CONSTRUCTION') out.push(check('Builder and yard stated', !!(p.yard && p.hullNo), true, p.yard ? `${p.yard}${p.hullNo ? `, hull ${p.hullNo}` : ''}` : 'The building yard and hull number must be stated'));

  // 4. tonnage
  if (first && !bareboatIn && rule.code !== 'UNDER_CONSTRUCTION') {
    const t = doc.tonnage ?? {};
    const measured = !!(t.gross && t.net);
    out.push(check('Tonnage measured and certified', measured, rule.registryState === 'REGISTERED', measured ? `${t.gross} GT / ${t.net} NT, certificate ${t.certificateNo || 'not referenced'}` : 'Gross and net tonnage not recorded'));
    if (measured && vessel?.grt) {
      const drift = Math.abs(Number(t.gross) - Number(vessel.grt)) / Number(vessel.grt);
      out.push(check('Declared tonnage agrees with the fleet record', drift <= 0.02, false, drift <= 0.02 ? `Within tolerance of the recorded ${vessel.grt} GT` : `Declared ${t.gross} GT against ${vessel.grt} GT on the fleet record`));
    }
  }

  // 5. evidence on file
  const required = requiredEvidence(doc, rule, profile, vessel, liveEncumbrances.length).filter((e) => e.mandatory);
  const held = new Set((doc.evidence ?? []).map((e: Row) => e.key));
  const absent = required.filter((e) => !held.has(e.key));
  out.push(check('Mandatory evidence on file', absent.length === 0, true, absent.length ? `Not lodged: ${absent.map((e) => e.label).join(', ')}` : `${required.length} mandatory document(s) lodged`));
  const unverified = (doc.evidence ?? []).filter((e: Row) => required.some((r) => r.key === e.key) && !e.verified);
  out.push(check('Lodged evidence verified by the registry', unverified.length === 0, false, unverified.length ? `${unverified.length} document(s) awaiting verification` : 'All mandatory evidence verified'));

  // 6. carving and marking — a permanent certificate cannot be granted until the official number is cut into the ship and a surveyor has said so
  if (rule.carving) {
    const cn = doc.carvingNote ?? null;
    const complied = !!cn?.compliedOn;
    out.push(check('Carving and marking note complied with', complied, true, complied ? `Reported by ${cn.surveyor || 'surveyor'} on ${new Date(cn.compliedOn).toISOString().slice(0, 10)}` : cn?.issuedOn ? 'Note issued, compliance not yet reported' : 'Carving and marking note not yet issued'));
  }

  // 7. closure and charter out — nothing leaves the register owing money, carrying a mortgage or under a caveat
  if (rule.family === 'CLOSE' || rule.family === 'OUT') {
    const live = [...liveEncumbrances, ...(doc.encumbrances ?? []).filter((e: Row) => !e.dischargedOn)];
    if (rule.family === 'CLOSE') out.push(check('No subsisting mortgage or charge', live.length === 0, true, live.length ? `${live.length} undischarged: ${live.map((e: Row) => `${String(e.kind).toLowerCase()} in favour of ${e.holder}`).join(', ')}` : 'Encumbrance register clear'));
    out.push(check('Port dues and charges settled', outstandingDues <= 0, true, outstandingDues > 0 ? `${currency} ${outstandingDues.toLocaleString(j.currency.locale)} outstanding against this ship` : 'Nothing outstanding'));
    out.push(check('No caveat subsisting against the entry', caveats === 0, true, caveats ? `${caveats} caveat(s) lodged` : 'No caveat'));
  }
  if (rule.family === 'CLOSE') {
    const reason = doc.deletion?.reason;
    out.push(check('Ground for closure stated', !!reason, true, reason ? kindLabel(reason) : 'No ground recorded'));
    if (reason === 'SOLD_FOREIGN') out.push(check('Receiving flag stated', !!doc.deletion?.newFlag, true, doc.deletion?.newFlag || 'The flag the ship transfers to must be stated on the deletion certificate'));
  }

  // 8. amendment — what is being altered has to be said, and title does not move under a caveat
  if (rule.family === 'ALTER') {
    const types: string[] = doc.amendment?.types ?? [];
    out.push(check('Nature of the alteration stated', types.length > 0, true, types.length ? types.map(kindLabel).join(', ') : 'No alteration type selected'));
    if (types.includes('NAME')) {
      const approved = !!doc.amendment?.approvalReference;
      out.push(check('New name approved in advance', approved, true, approved ? `Approval ${doc.amendment.approvalReference}` : 'A ship may not be renamed without prior approval'));
    }
    if (types.includes('OWNERSHIP')) out.push(check('No caveat subsisting against the entry', caveats === 0, true, caveats ? `${caveats} caveat(s) lodged — title does not pass under a caveat` : 'No caveat'));
  }

  // 9. the ship itself
  if (vessel) out.push(check('Fleet record is active', vessel.status === 'ACTIVE', false, `Vessel record is ${String(vessel.status || '').toLowerCase()}`));
  return out;
}

export const blocking = (checks: Check[]) => checks.filter((c) => c.blocking && !c.passed);

/** What a registration form needs to render: the registrar, the ports, the share rules, and every variant with its SLA, fee and evidence. */
export function reference(profile: string, rules: KindRule[]) {
  const j = getJurisdiction(profile);
  return {
    registrar: j.registry.registrar, statute: j.registry.statute.value, nationalityRule: j.registry.nationalityRule,
    portsOfRegistry: j.registry.portsOfRegistry.map((p) => ({ code: p.code, name: p.name, state: p.region, default: p.code === j.registry.defaultPort })),
    defaultPort: j.registry.defaultPort, shareRules: shareRules(profile),
    kinds: rules.map((k) => ({ kind: k.code, label: k.label, labelAr: k.labelAr, family: k.family, slaDays: k.slaDays, fee: k.fee, currency: j.currency.code, evidence: k.evidence, validityMonths: k.validityMonths, issuesCertificate: k.issuesCertificate, closesRegistry: k.closesRegistry, registryState: k.registryState, carving: k.carving, series: k.series })),
    provisionalValidityMonths: j.registry.provisionalValidityMonths.value,
    registryStates: ['UNREGISTERED', 'PROVISIONAL', 'REGISTERED', 'BAREBOAT_IN', 'BAREBOAT_OUT', 'CLOSED'],
  };
}
export { livesOnRegister };
