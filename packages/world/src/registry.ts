import { getJurisdiction, REGISTRATION_KINDS, REGISTRATION_STATUS, REGISTRY_STATES } from '@maritime/contracts';
import { Prng, D, stableId, iso, yearOf, makeSeries, addMonths } from './prng';
import { check, hist, type WorldCheck, type WorldHistoryEntry } from './common';
import { usersByRole, type WorldUser } from './people';
import type { WorldVessel } from './vessels';

export type RegistrationKind = (typeof REGISTRATION_KINDS)[number];
export type RegistrationStatus = (typeof REGISTRATION_STATUS)[number];
export type RegistryState = (typeof REGISTRY_STATES)[number];
export interface WorldRegOwner { name: string; address: string; nationality: string; shares: number; kind: 'INDIVIDUAL' | 'BODY_CORPORATE' | 'COOPERATIVE_SOCIETY'; registrationNo: string; companyId: string | null }
export interface WorldRegEvidence { key: string; label: string; reference: string; issuedBy: string; issuedOn: string; fileName: string; verified: boolean; verifiedBy: string; verifiedAt: string | null }
export interface WorldEncumbrance { kind: 'MORTGAGE' | 'LIEN' | 'CHARGE'; holder: string; amount: number; currency: string; registeredOn: string; dischargedOn: string | null; reference: string }
export interface WorldRegistration {
  id: string; applicationNo: string; kind: RegistrationKind; vesselId: string; vesselName: string; imo: string; portOfRegistry: string; portOfRegistryName: string;
  applicant: { name: string; email: string; phone: string; capacity: string }; owners: WorldRegOwner[];
  tonnage: { gross: number | null; net: number | null; measuredBy: string; certificateNo: string; measuredOn: string | null };
  previousFlag: string; previousRegistry: string; previousOfficialNumber: string; evidence: WorldRegEvidence[]; encumbrances: WorldEncumbrance[];
  carvingNote: { number: string; issuedOn: string; issuedBy: string; compliedOn: string | null; surveyor: string; remarks: string } | null;
  amendment: { types: string[]; before: Record<string, unknown>; after: Record<string, unknown>; approvalReference: string } | null;
  deletion: { reason: string; newFlag: string; effectiveOn: string | null; certificateNo: string; issuedOn: string | null } | null;
  status: RegistrationStatus; checks: WorldCheck[]; assignedToId: string | null; assignedTo: string; officialNumber: string; certificateNo: string; grantedOn: string | null; grantedBy: string; certificateExpiresOn: string | null;
  fee: { amount: number; currency: string; paid: boolean }; decision: { outcome: 'GRANTED' | 'REJECTED'; by: string; at: string; reason: string } | null; submittedAt: string; dueAt: string; closedAt: string | null; history: WorldHistoryEntry[];
}
/** Where the ship itself stands on the register, derived from granted registrations and never set by hand. */
export interface WorldRegistryEntry { vesselId: string; vesselName: string; state: RegistryState; officialNumber: string; portOfRegistry: string; portOfRegistryName: string; certificateNo: string; registeredOn: string | null; certificateExpiresOn: string | null; closedOn: string | null; closureReason: string }

/** What the file must contain before the registrar will look at it; `when` narrows a requirement to the cases it applies to. */
export const EVIDENCE: Record<string, { key: string; label: string; mandatory: boolean; when?: string }[]> = {
  PERMANENT: [{ key: 'DECLARATION_OF_OWNERSHIP', label: 'Declaration of ownership', mandatory: true }, { key: 'TITLE_DOCUMENT', label: "Builder's certificate or bill of sale", mandatory: true }, { key: 'TONNAGE_CERTIFICATE', label: 'Tonnage measurement certificate', mandatory: true },
    { key: 'SURVEY_CERTIFICATE', label: 'Certificate of survey', mandatory: true }, { key: 'CLASS_CERTIFICATE', label: 'Classification certificate', mandatory: false }, { key: 'INSURANCE_CERTIFICATE', label: 'Liability insurance / P&I cover note', mandatory: false }, { key: 'DELETION_CERTIFICATE', label: 'Deletion certificate from the previous registry', mandatory: true, when: 'previouslyForeign' }],
  PROVISIONAL: [{ key: 'DECLARATION_OF_OWNERSHIP', label: 'Declaration of ownership', mandatory: true }, { key: 'TITLE_DOCUMENT', label: "Builder's certificate or bill of sale", mandatory: true }, { key: 'TONNAGE_CERTIFICATE', label: 'Tonnage measurement certificate', mandatory: false }],
  AMENDMENT: [{ key: 'AMENDMENT_APPLICATION', label: 'Application stating the alteration', mandatory: true }, { key: 'SUPPORTING_EVIDENCE', label: 'Evidence supporting the alteration', mandatory: true }, { key: 'NAME_APPROVAL', label: 'Prior approval of the new name', mandatory: true, when: 'nameChange' },
    { key: 'TITLE_DOCUMENT', label: 'Bill of sale or transfer instrument', mandatory: true, when: 'ownershipChange' }, { key: 'TONNAGE_CERTIFICATE', label: 'Revised tonnage measurement certificate', mandatory: true, when: 'tonnageChange' }],
  BAREBOAT_IN: [{ key: 'BAREBOAT_CHARTER_PARTY', label: 'Bareboat charter party', mandatory: true }, { key: 'UNDERLYING_REGISTRY_CONSENT', label: 'Consent of the underlying registry', mandatory: true },
    { key: 'UNDERLYING_REGISTRY_CERTIFICATE', label: 'Certificate of the underlying registry', mandatory: true }, { key: 'MORTGAGEE_CONSENT', label: 'Consent of registered mortgagees', mandatory: true, when: 'encumbered' },
    { key: 'INSURANCE_CERTIFICATE', label: 'Liability insurance / P&I cover note', mandatory: true }, { key: 'TONNAGE_CERTIFICATE', label: 'Tonnage measurement certificate', mandatory: false }],
  BAREBOAT_OUT: [{ key: 'BAREBOAT_CHARTER_PARTY', label: 'Bareboat charter party', mandatory: true }, { key: 'BAREBOAT_REGISTRY_CONFIRMATION', label: 'Confirmation from the bareboat registry', mandatory: true },
    { key: 'MORTGAGEE_CONSENT', label: 'Consent of registered mortgagees', mandatory: true, when: 'encumbered' }],
  UNDER_CONSTRUCTION: [{ key: 'BUILDING_CONTRACT', label: 'Shipbuilding contract', mandatory: true }, { key: 'DECLARATION_OF_OWNERSHIP', label: 'Declaration of ownership', mandatory: true }, { key: 'YARD_CERTIFICATE', label: "Yard's certificate of the hull under construction", mandatory: true }],
  TEMPORARY_PASS: [{ key: 'PASS_APPLICATION', label: 'Application stating the voyage', mandatory: true }, { key: 'INSURANCE_CERTIFICATE', label: 'Liability insurance / P&I cover note', mandatory: true }, { key: 'SEAWORTHINESS_CERTIFICATE', label: 'Certificate of seaworthiness for the voyage', mandatory: true }],
  RE_REGISTRATION: [{ key: 'DECLARATION_OF_OWNERSHIP', label: 'Declaration of ownership', mandatory: true }, { key: 'SURVEY_CERTIFICATE', label: 'Certificate of survey', mandatory: true }, { key: 'INSURANCE_CERTIFICATE', label: 'Liability insurance / P&I cover note', mandatory: true },
    { key: 'BAREBOAT_TERMINATION', label: 'Termination of the bareboat charter registration', mandatory: true, when: 'fromBareboat' }],
  DELETION: [{ key: 'CLOSURE_APPLICATION', label: 'Application for closure of registry', mandatory: true }, { key: 'MORTGAGE_DISCHARGE', label: 'Discharge of registered mortgage', mandatory: true, when: 'encumbered' }, { key: 'DUES_CLEARANCE', label: 'Clearance of port dues and government charges', mandatory: true }, { key: 'TITLE_DOCUMENT', label: 'Bill of sale to the foreign purchaser', mandatory: true, when: 'soldForeign' }],
};

interface Opts { vessel: WorldVessel; kind: RegistrationKind; status: RegistrationStatus; at: Date; leadDays: number; slaDays: number; fee: number; owners?: WorldRegOwner[]; tonnage?: WorldRegistration['tonnage']; evidence?: WorldRegEvidence[]; encumbrances?: WorldEncumbrance[]; amendment?: WorldRegistration['amendment']; deletion?: WorldRegistration['deletion']; carvingNote?: WorldRegistration['carvingNote']; checks?: WorldCheck[]; history: WorldHistoryEntry[]; previous?: [string, string, string] }

/** B1 — the ship register: first registrations dated at delivery, a provisional bridge, amendments and two closures in different states. Only the profile-flagged fictional ships hold entries. */
export function buildRegistrations(rng: Prng, profile: string, vessels: WorldVessel[], users: WorldUser[], now: Date): { registrations: WorldRegistration[]; registry: WorldRegistryEntry[]; closureVesselId: string | null } {
  const j = getJurisdiction(profile); const ae = j.code === 'AE'; const R = j.registry;
  const PORT = R.defaultPort; const portName = (c: string) => R.portsOfRegistry.find((p) => p.code === c)?.name ?? c; const SHARES = R.shareDenominator.value;
  const registrar = usersByRole(users, 'Registrar of Ships')[0] ?? users[0]; const officers = [registrar.name, `Dy. ${R.registrar}`];
  const surveyors = users.filter((u) => u.roleName === 'Marine Surveyor' && /surveyor/i.test(u.designation)).map((u) => u.name);
  const currency = j.currency.code; const nationality = j.name;
  const regNo = (n: number) => (ae ? `CN-${1200000 + n * 131} (sample)` : `U61100GJ${2008 + (n % 15)}PLC0${String(12345 + n * 137).slice(0, 5)} (sample)`);
  const netOf = (v: WorldVessel) => Math.round(v.grt * (v.type === 'TANK' ? 0.55 : v.type === 'CONT' ? 0.46 : 0.52));
  const ownersFor = (v: WorldVessel, i: number): WorldRegOwner[] => (i % 3 === 1
    ? [{ name: v.owner, address: ae ? 'Port Zone, Abu Dhabi' : 'Port District', nationality, shares: SHARES - 3, kind: 'BODY_CORPORATE', registrationNo: regNo(i), companyId: null }, { name: v.operator, address: ae ? 'Dubai' : 'Mumbai, Maharashtra', nationality, shares: 3, kind: 'BODY_CORPORATE', registrationNo: regNo(i + 9), companyId: null }]
    : [{ name: v.owner, address: ae ? 'Port Zone, Abu Dhabi' : 'Port District', nationality, shares: SHARES, kind: 'BODY_CORPORATE', registrationNo: regNo(i), companyId: null }]);
  const evidenceFor = (keys: [string, string, string][], when: Date, by: string): WorldRegEvidence[] => keys.map(([key, label, reference]) => ({ key, label, reference, issuedBy: by, issuedOn: iso(when.getTime() - rng.int(20, 120) * D), fileName: `${key.toLowerCase().replace(/_/g, '-')}.pdf`, verified: true, verifiedBy: rng.pick(officers), verifiedAt: iso(when.getTime() - rng.int(2, 10) * D) }));
  const firstEvidence = (v: WorldVessel): [string, string, string][] => [['DECLARATION_OF_OWNERSHIP', 'Declaration of ownership', `DOO/${v.imo}`], ['TITLE_DOCUMENT', "Builder's certificate", `BC/${v.built}/${v.imo}`], ['TONNAGE_CERTIFICATE', 'Tonnage measurement certificate', `TM/${v.imo}`],
    ['SURVEY_CERTIFICATE', 'Certificate of survey', `SUR/${v.imo}`], ['CLASS_CERTIFICATE', 'Classification certificate', `${v.classSociety}/${v.imo}`], ['INSURANCE_CERTIFICATE', 'P&I cover note', `PI/${v.imo}`]];
  const passed = (rows: [string, string][]): WorldCheck[] => rows.map(([c, d]) => check(c, true, true, d));
  const regs: WorldRegistration[] = [];
  const mk = (o: Opts) => {
    const v = o.vessel; const granted = o.status === 'GRANTED'; const submittedAt = new Date(o.at.getTime() - o.leadDays * D);
    regs.push({ id: '', applicationNo: '', kind: o.kind, vesselId: v.id, vesselName: v.name, imo: v.imo, portOfRegistry: PORT, portOfRegistryName: portName(PORT),
      applicant: { name: v.owner, email: `registry@${v.owner.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}.example`, phone: ae ? `+971 2 ${String(4000000 + (Number(v.imo) % 900000)).slice(0, 3)} ${String(4000000 + (Number(v.imo) % 900000)).slice(3, 7)}` : `+91 2836 2${String(30000 + (Number(v.imo) % 60000)).slice(0, 5)}`, capacity: 'Managing owner' },
      owners: o.owners ?? [], tonnage: o.tonnage ?? { gross: null, net: null, measuredBy: '', certificateNo: '', measuredOn: null }, previousFlag: o.previous?.[0] ?? '', previousRegistry: o.previous?.[1] ?? '', previousOfficialNumber: o.previous?.[2] ?? '',
      evidence: o.evidence ?? [], encumbrances: o.encumbrances ?? [], carvingNote: o.carvingNote ?? null, amendment: o.amendment ?? null, deletion: o.deletion ?? null, status: o.status, checks: o.checks ?? [],
      assignedToId: registrar.id, assignedTo: registrar.name, officialNumber: '', certificateNo: '', grantedOn: granted ? iso(o.at) : null, grantedBy: granted ? registrar.name : '', certificateExpiresOn: null,
      fee: { amount: o.fee, currency, paid: granted }, decision: granted ? { outcome: 'GRANTED', by: registrar.name, at: iso(o.at), reason: '' } : null, submittedAt: iso(submittedAt), dueAt: iso(submittedAt.getTime() + o.slaDays * D), closedAt: granted ? iso(o.at) : null, history: o.history });
  };
  const fees = ae ? { PERMANENT: 5000, PROVISIONAL: 1500, AMENDMENT: 1000, DELETION: 500 } : { PERMANENT: 50000, PROVISIONAL: 15000, AMENDMENT: 10000, DELETION: 5000 };
  const fleet = vessels.filter((v) => !v.real); const registrable = fleet.filter((v) => v.flag === j.code); const registered: WorldVessel[] = [];
  registrable.forEach((v, i) => {
    // a ship is registered when it is delivered, so the entry predates the operating history the rest of the world covers
    const at = new Date(Date.UTC(v.built, (i * 3) % 12, 4 + ((i * 7) % 20), 11, 15)); const owners = ownersFor(v, i); const carvedOn = new Date(at.getTime() - rng.int(8, 20) * D);
    mk({ vessel: v, kind: 'PERMANENT', status: 'GRANTED', at, leadDays: rng.int(34, 70), slaDays: 30, fee: fees.PERMANENT, owners,
      tonnage: { gross: v.grt, net: netOf(v), measuredBy: v.classSociety, certificateNo: `TM/${v.imo}`, measuredOn: iso(at.getTime() - rng.int(60, 150) * D) }, evidence: evidenceFor(firstEvidence(v), at, v.classSociety),
      carvingNote: { number: '', issuedOn: iso(carvedOn.getTime() - 14 * D), issuedBy: rng.pick(officers), compliedOn: iso(carvedOn), surveyor: rng.pick(surveyors), remarks: 'Official number and registered tonnage cut into the main beam and verified.' },
      checks: passed([['Ship is not already on the register', 'No subsisting entry'], ['Port of registry is a declared port', `${portName(PORT)} (${PORT})`], ['Ownership shares account for the whole ship', `${SHARES} of ${SHARES} shares allotted across ${owners.length} owner(s)`],
        ['Registered owners within the statutory maximum', `${owners.length} owner(s), maximum ${R.maxRegisteredOwners.value}`], [`Every owner qualifies to own a ship of ${nationality}`, `${owners.length} owner(s) qualify`], ['Tonnage measured and certified', `${v.grt} GT / ${netOf(v)} NT, certificate TM/${v.imo}`],
        ['Mandatory evidence on file', '4 mandatory document(s) lodged'], ['Carving and marking note complied with', `Reported by a ship surveyor on ${iso(carvedOn).slice(0, 10)}`]]),
      history: [hist('', 'SUBMITTED', at.getTime() - 60 * D, v.owner, 'Permanent registration lodged'), hist('SUBMITTED', 'UNDER_SCRUTINY', at.getTime() - 52 * D, 'Registry'), hist('UNDER_SCRUTINY', 'CARVING_NOTE_ISSUED', carvedOn.getTime() - 14 * D, 'Registry', 'Official number allocated'),
        hist('CARVING_NOTE_ISSUED', 'SURVEY_COMPLETE', carvedOn, 'Registry', 'Carving and marking verified'), hist('SURVEY_COMPLETE', 'APPROVED', at.getTime() - 3 * D, 'Registry'), hist('APPROVED', 'GRANTED', at, 'Registry', 'Certificate of registry granted')] });
    registered.push(v);
  });
  // two foreign-flagged ships being brought onto the flag: a provisional certificate close to running out, and a permanent file with the number cut but the surveyor yet to report
  const inbound = fleet.filter((v) => v.flag !== j.code).slice(0, 2);
  if (inbound[0]) {
    const v = inbound[0]; const at = new Date(now.getTime() - (Math.round(R.provisionalValidityMonths.value * 30.44) - 41) * D); const owners = ownersFor(v, 0);
    mk({ vessel: v, kind: 'PROVISIONAL', status: 'GRANTED', at, leadDays: rng.int(9, 16), slaDays: 7, fee: fees.PROVISIONAL, owners, tonnage: { gross: v.grt, net: netOf(v), measuredBy: v.classSociety, certificateNo: `TM/${v.imo}`, measuredOn: iso(at.getTime() - 40 * D) },
      evidence: evidenceFor([['DECLARATION_OF_OWNERSHIP', 'Declaration of ownership', `DOO/${v.imo}`], ['TITLE_DOCUMENT', 'Bill of sale', `BOS/${v.imo}/${yearOf(at)}`], ['TONNAGE_CERTIFICATE', 'Tonnage measurement certificate', `TM/${v.imo}`]], at, v.classSociety),
      checks: passed([['Ship is not already on the register', 'No subsisting entry'], ['Port of registry is a declared port', `${portName(PORT)} (${PORT})`], ['Ownership shares account for the whole ship', `${SHARES} of ${SHARES} shares allotted across ${owners.length} owner(s)`], [`Every owner qualifies to own a ship of ${nationality}`, `${owners.length} owner(s) qualify`], ['Mandatory evidence on file', '2 mandatory document(s) lodged']]),
      history: [hist('', 'SUBMITTED', at.getTime() - 12 * D, v.owner, 'Provisional registration lodged — ship acquired abroad'), hist('SUBMITTED', 'UNDER_SCRUTINY', at.getTime() - 8 * D, 'Registry'), hist('UNDER_SCRUTINY', 'APPROVED', at.getTime() - 2 * D, 'Registry'), hist('APPROVED', 'GRANTED', at, 'Registry', 'Provisional certificate of registry granted')] });
  }
  if (inbound[1]) {
    const v = inbound[1]; const at = new Date(now.getTime() - 9 * D); const owners = ownersFor(v, 1);
    mk({ vessel: v, kind: 'PERMANENT', status: 'CARVING_NOTE_ISSUED', at, leadDays: 22, slaDays: 30, fee: fees.PERMANENT, owners, tonnage: { gross: v.grt, net: netOf(v), measuredBy: v.classSociety, certificateNo: `TM/${v.imo}`, measuredOn: iso(at.getTime() - 30 * D) },
      previous: [v.flag, `Registry of ${v.flag}`, String(700000 + (Number(v.imo) % 90000))], evidence: evidenceFor([...firstEvidence(v), ['DELETION_CERTIFICATE', 'Deletion certificate from the previous registry', `DEL/${v.flag}/${yearOf(at)}/0148`]], at, v.classSociety),
      carvingNote: { number: '', issuedOn: iso(at.getTime() - 4 * D), issuedBy: rng.pick(officers), compliedOn: null, surveyor: '', remarks: 'Awaiting the surveyor\'s report of compliance.' },
      history: [hist('', 'SUBMITTED', at.getTime() - 22 * D, v.owner, 'Permanent registration lodged on transfer of flag'), hist('SUBMITTED', 'UNDER_SCRUTINY', at.getTime() - 15 * D, 'Registry'), hist('UNDER_SCRUTINY', 'CARVING_NOTE_ISSUED', at.getTime() - 4 * D, 'Registry', 'Official number allocated')] });
  }
  const [renamed, transferred, movingPort, mortgaged, closing] = [registered[0], registered[3] ?? registered[1], registered[2], registered[4], registered[5]];
  if (renamed) {
    const at = new Date(now.getTime() - rng.int(300, 640) * D); const approval = `${ae ? 'MSA' : 'DGS'}/NAME/${yearOf(at)}/0${rng.int(210, 890)}`;
    mk({ vessel: renamed, kind: 'AMENDMENT', status: 'GRANTED', at, leadDays: rng.int(12, 22), slaDays: 15, fee: fees.AMENDMENT, amendment: { types: ['NAME'], approvalReference: approval, before: { name: `${renamed.name.split(' ')[0]} Pride` }, after: { name: renamed.name } },
      evidence: evidenceFor([['AMENDMENT_APPLICATION', 'Application stating the alteration', `AMD/${renamed.imo}`], ['SUPPORTING_EVIDENCE', 'Board resolution approving the change of name', `BR/${yearOf(at)}/44`], ['NAME_APPROVAL', 'Prior approval of the new name', approval]], at, R.registrar),
      checks: passed([['Ship holds a subsisting registry entry', 'On the register'], ['Nature of the alteration stated', 'name'], ['New name approved in advance', `Approval ${approval}`], ['Mandatory evidence on file', '3 mandatory document(s) lodged']]),
      history: [hist('', 'SUBMITTED', at.getTime() - 18 * D, renamed.owner, 'Change of name'), hist('SUBMITTED', 'UNDER_SCRUTINY', at.getTime() - 12 * D, 'Registry'), hist('UNDER_SCRUTINY', 'APPROVED', at.getTime() - 2 * D, 'Registry'), hist('APPROVED', 'GRANTED', at, 'Registry', 'Certificate of registry reissued as altered')] });
  }
  if (transferred) {
    const at = new Date(now.getTime() - rng.int(90, 300) * D);
    const owners: WorldRegOwner[] = [{ name: transferred.operator, address: ae ? 'Dubai' : 'Mumbai, Maharashtra', nationality, shares: SHARES - 2, kind: 'BODY_CORPORATE', registrationNo: regNo(31), companyId: null },
      { name: ae ? 'Coastal Mariners Cooperative Society' : 'Coastal Mariners Co-operative Society Ltd', address: ae ? 'Ras Al Khaimah' : 'Mandvi', nationality, shares: 2, kind: 'COOPERATIVE_SOCIETY', registrationNo: regNo(47), companyId: null }];
    mk({ vessel: transferred, kind: 'AMENDMENT', status: 'GRANTED', at, leadDays: rng.int(11, 19), slaDays: 15, fee: fees.AMENDMENT, owners, amendment: { types: ['OWNERSHIP'], approvalReference: '', before: { owner: transferred.owner }, after: { owner: transferred.operator } },
      evidence: evidenceFor([['AMENDMENT_APPLICATION', 'Application stating the alteration', `AMD/${transferred.imo}`], ['SUPPORTING_EVIDENCE', 'Transfer instrument', `TR/${yearOf(at)}/07`], ['TITLE_DOCUMENT', 'Bill of sale', `BOS/${transferred.imo}/${yearOf(at)}`]], at, R.registrar),
      checks: passed([['Ship holds a subsisting registry entry', 'On the register'], ['Ownership shares account for the whole ship', `${SHARES} of ${SHARES} shares allotted across 2 owner(s)`], [`Every owner qualifies to own a ship of ${nationality}`, '2 owner(s) qualify'], ['Nature of the alteration stated', 'ownership']]),
      history: [hist('', 'SUBMITTED', at.getTime() - 15 * D, transferred.owner, 'Transfer of shares'), hist('SUBMITTED', 'UNDER_SCRUTINY', at.getTime() - 9 * D, 'Registry'), hist('UNDER_SCRUTINY', 'APPROVED', at.getTime() - 2 * D, 'Registry'), hist('APPROVED', 'GRANTED', at, 'Registry', 'Register altered and certificate reissued')] });
  }
  if (movingPort) {
    const target = R.portsOfRegistry[1]?.code ?? PORT;
    mk({ vessel: movingPort, kind: 'AMENDMENT', status: 'UNDER_SCRUTINY', at: now, leadDays: 6, slaDays: 15, fee: fees.AMENDMENT, amendment: { types: ['PORT_OF_REGISTRY'], approvalReference: '', before: { portOfRegistry: PORT }, after: { portOfRegistry: target } },
      evidence: evidenceFor([['AMENDMENT_APPLICATION', 'Application stating the alteration', `AMD/${movingPort.imo}`], ['SUPPORTING_EVIDENCE', 'Board resolution — transfer of port of registry', `BR/${now.getUTCFullYear()}/12`]], now, R.registrar),
      history: [hist('', 'SUBMITTED', now.getTime() - 6 * D, movingPort.owner, `Transfer of port of registry to ${portName(target)}`), hist('SUBMITTED', 'UNDER_SCRUTINY', now.getTime() - 4 * D, 'Registry')] });
  }
  // two closures in different states: one held up by a charge not yet discharged — the check doing its job — and one cleared and waiting only for the grant
  if (mortgaged) {
    const holder = ae ? 'Gulf Coast Maritime Finance PJSC (sample)' : 'Coastal Cooperative Bank Ltd (sample)';
    mk({ vessel: mortgaged, kind: 'DELETION', status: 'UNDER_SCRUTINY', at: now, leadDays: 11, slaDays: 15, fee: fees.DELETION, deletion: { reason: 'SOLD_FOREIGN', newFlag: 'Panama', effectiveOn: iso(now.getTime() + 20 * D), certificateNo: '', issuedOn: null },
      encumbrances: [{ kind: 'MORTGAGE', holder, amount: ae ? 42000000 : 184000000, currency, registeredOn: iso(now.getTime() - 900 * D), dischargedOn: null, reference: `MTG/${PORT}/${now.getUTCFullYear() - 2}/018` }],
      evidence: evidenceFor([['CLOSURE_APPLICATION', 'Application for closure of registry', `CLS/${mortgaged.imo}`], ['TITLE_DOCUMENT', 'Bill of sale to the foreign purchaser', `BOS/${mortgaged.imo}/${now.getUTCFullYear()}`]], now, R.registrar),
      checks: [check('Ship holds a subsisting registry entry', true, true, 'On the register'), check('Mandatory evidence on file', false, true, 'Not lodged: Discharge of registered mortgage, Clearance of port dues and government charges'),
        check('No subsisting mortgage or charge', false, true, `1 undischarged: mortgage in favour of ${holder}`), check('Ground for closure stated', true, true, 'sold foreign'), check('Receiving flag stated', true, true, 'Panama')],
      history: [hist('', 'SUBMITTED', now.getTime() - 11 * D, mortgaged.owner, 'Closure of registry — sale to a foreign purchaser'), hist('SUBMITTED', 'UNDER_SCRUTINY', now.getTime() - 8 * D, 'Registry', 'Mortgage discharge outstanding')] });
  }
  if (closing) {
    mk({ vessel: closing, kind: 'DELETION', status: 'APPROVED', at: now, leadDays: 13, slaDays: 15, fee: fees.DELETION, deletion: { reason: 'BROKEN_UP', newFlag: '', effectiveOn: iso(now.getTime() - 2 * D), certificateNo: '', issuedOn: null },
      evidence: evidenceFor([['CLOSURE_APPLICATION', 'Application for closure of registry', `CLS/${closing.imo}`], ['DUES_CLEARANCE', 'Clearance of port dues and government charges', `DUE/${now.getUTCFullYear()}/${closing.imo}`]], now, R.registrar),
      checks: passed([['Ship holds a subsisting registry entry', 'On the register'], ['No subsisting mortgage or charge', 'Encumbrance register clear'], ['Port dues and charges settled', 'Nothing outstanding'], ['Ground for closure stated', 'broken up'], ['Mandatory evidence on file', '2 mandatory document(s) lodged']]),
      history: [hist('', 'SUBMITTED', now.getTime() - 13 * D, closing.owner, 'Closure of registry — ship sold for demolition'), hist('SUBMITTED', 'UNDER_SCRUTINY', now.getTime() - 9 * D, 'Registry'), hist('UNDER_SCRUTINY', 'APPROVED', now.getTime() - D, 'Registry', 'Cleared for closure')] });
  }
  // applications run in one chronological series per year; official numbers run in one unbroken series and are allocated when the number is carved, not when the certificate is granted
  const seq = makeSeries(); let officialNext = R.officialNumberBase;
  regs.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).forEach((d) => {
    const y = yearOf(d.submittedAt); d.applicationNo = `REG-${y}-${seq(`app:${y}`, 5)}`; d.id = stableId('registration', d.applicationNo);
    if (d.carvingNote) { const k = `${d.portOfRegistry}/CMN/${yearOf(d.carvingNote.issuedOn)}`; d.carvingNote.number = `${k}/${seq(k)}`; }
    if ((d.kind === 'PERMANENT' && d.carvingNote) || (d.kind === 'PROVISIONAL' && d.status === 'GRANTED')) { d.officialNumber = String(officialNext); officialNext += 1; }
    if (d.status === 'GRANTED' && d.grantedOn) {
      const k = `${d.portOfRegistry}/${d.kind === 'PROVISIONAL' ? 'PCR' : d.kind === 'DELETION' ? 'DEL' : 'CR'}/${yearOf(d.grantedOn)}`; d.certificateNo = `${k}/${seq(k)}`;
      if (d.kind === 'PROVISIONAL') d.certificateExpiresOn = iso(addMonths(d.grantedOn, R.provisionalValidityMonths.value));
    }
  });
  const registry: WorldRegistryEntry[] = fleet.map((v) => {
    const first = regs.find((r) => r.vesselId === v.id && r.status === 'GRANTED' && (r.kind === 'PERMANENT' || r.kind === 'PROVISIONAL'));
    const amend = [...regs].reverse().find((r) => r.vesselId === v.id && r.status === 'GRANTED' && r.kind === 'AMENDMENT');
    if (!first) return { vesselId: v.id, vesselName: v.name, state: 'UNREGISTERED', officialNumber: '', portOfRegistry: '', portOfRegistryName: '', certificateNo: '', registeredOn: null, certificateExpiresOn: null, closedOn: null, closureReason: '' };
    return { vesselId: v.id, vesselName: v.name, state: first.kind === 'PROVISIONAL' ? 'PROVISIONAL' : 'REGISTERED', officialNumber: first.officialNumber, portOfRegistry: first.portOfRegistry, portOfRegistryName: first.portOfRegistryName,
      certificateNo: amend?.certificateNo || first.certificateNo, registeredOn: first.grantedOn, certificateExpiresOn: first.certificateExpiresOn, closedOn: null, closureReason: '' };
  });
  return { registrations: regs, registry, closureVesselId: closing?.id ?? null };
}
