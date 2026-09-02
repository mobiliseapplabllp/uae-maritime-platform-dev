import { getJurisdiction, CERT_EXPIRING_DAYS } from '@maritime/contracts';
import { Prng, D, stableId, iso } from './prng';
import type { WorldVessel } from './vessels';
import { CERT_LABEL, CONVENTION, nonExpiring, type WorldLicence } from './instruments';
import type { WorldRegistryEntry } from './registry';

export interface WorldVesselCertificate { id: string; vesselId: string; vesselName: string; certType: string; number: string; issuer: string; issueDate: string; expiryDate: string; remarks: string; instrumentId: string | null; state: 'VALID' | 'EXPIRING' | 'EXPIRED' }
/** EXPIRED strictly before now; a certificate expiring today is still usable today, so it reads EXPIRING. */
export const certStatus = (expiry: string | Date, now: Date, windowDays = CERT_EXPIRING_DAYS): WorldVesselCertificate['state'] => { const e = new Date(expiry).getTime(); return e < now.getTime() ? 'EXPIRED' : e <= now.getTime() + windowDays * D ? 'EXPIRING' : 'VALID'; };
/** The certificate list every ship carries: the reference seven plus the other SOLAS and MARPOL certificates a cargo ship holds. */
export const VESSEL_CERT_TYPES: string[] = ['Certificate of Registry', 'Classification Certificate', CERT_LABEL.SAFETY_MANAGEMENT_CERTIFICATE, CERT_LABEL.SHIP_SECURITY_CERTIFICATE, CERT_LABEL.IOPP_CERTIFICATE, CERT_LABEL.INTERNATIONAL_LOAD_LINE,
  CERT_LABEL.MARITIME_LABOUR_CERTIFICATE, CERT_LABEL.CARGO_SHIP_SAFETY_CONSTRUCTION, CERT_LABEL.CARGO_SHIP_SAFETY_EQUIPMENT, CERT_LABEL.CARGO_SHIP_SAFETY_RADIO, CERT_LABEL.IAPP_CERTIFICATE, CERT_LABEL.TONNAGE_CERTIFICATE, CERT_LABEL.MINIMUM_SAFE_MANNING_DOCUMENT];
const TYPE_BY_LABEL: Record<string, string> = Object.fromEntries(Object.entries(CERT_LABEL).map(([t, l]) => [l, t]));

/** Per active vessel: the certificate of registry and statutory certificates are mirrored from the registers; the rest are generated with an expiry spread. Documented liner callers carry clean records. */
export function buildVesselCertificates(rng: Prng, profile: string, vessels: WorldVessel[], licences: WorldLicence[], registry: WorldRegistryEntry[], now: Date): WorldVesselCertificate[] {
  const j = getJurisdiction(profile); const ae = j.code === 'AE';
  const regByVessel = new Map(registry.map((r) => [r.vesselId, r]));
  const statutory = new Map(licences.filter((l) => l.subjectKind === 'VESSEL' && l.status === 'ISSUED' && CERT_LABEL[l.entityType]).map((l) => [`${l.subjectId}:${l.entityType}`, l]));
  const flagAdmin = ae ? 'Ministry of Energy and Infrastructure — Maritime Sector' : 'Directorate General of Shipping';
  const out: WorldVesselCertificate[] = []; let spread = 0;
  vessels.filter((v) => v.status === 'ACTIVE').forEach((v, i) => VESSEL_CERT_TYPES.forEach((certType, k) => {
    const mk = (p: Pick<WorldVesselCertificate, 'number' | 'issuer' | 'issueDate' | 'expiryDate'> & Partial<Pick<WorldVesselCertificate, 'remarks' | 'instrumentId'>>) =>
      out.push({ id: stableId('vcert', `${v.id}:${certType}`), vesselId: v.id, vesselName: v.name, certType, remarks: '', instrumentId: null, ...p, state: certStatus(p.expiryDate, now) });
    const reg = regByVessel.get(v.id); const type = TYPE_BY_LABEL[certType]; const inst = type ? statutory.get(`${v.id}:${type}`) : undefined;
    if (certType === 'Certificate of Registry' && reg && reg.state !== 'UNREGISTERED' && reg.registeredOn) {
      mk({ number: reg.certificateNo, issuer: `${j.registry.registrar}, ${reg.portOfRegistryName}`, issueDate: reg.registeredOn, expiryDate: reg.certificateExpiresOn ?? iso(new Date(reg.registeredOn).getTime() + 100 * 365 * D), remarks: `Official number ${reg.officialNumber}` }); return;
    }
    if (inst?.issueDate && inst.expiryDate) {
      mk({ number: inst.licenseNo, issuer: flagAdmin, issueDate: inst.issueDate, expiryDate: inst.expiryDate, instrumentId: inst.id,
        remarks: nonExpiring(inst.entityType) ? `Issued under ${CONVENTION[inst.entityType]}. Not renewed on a term — reissued on any change to the ship.` : `Issued on the register under ${CONVENTION[inst.entityType]}` }); return;
    }
    let expiry = new Date(now.getTime() + (v.real ? 200 + ((i * 13 + k * 61) % 800) : 120 + ((i * 7 + k * 97) % 700)) * D);
    const perpetual = !!type && nonExpiring(type);
    // about a tenth of the fleet's certificates are expiring or expired, dealt by position so the share holds whatever the seed
    if (!v.real && !perpetual) { spread += 1; if (spread % 9 === 4) expiry = new Date(now.getTime() - rng.int(1, 60) * D); else if (spread % 5 === 1) expiry = new Date(now.getTime() + rng.int(1, 30) * D); }
    const issue = perpetual ? new Date(Date.UTC(v.built, 5, 1)) : new Date(expiry.getTime() - 5 * 365 * D);
    if (perpetual) expiry = new Date(issue.getTime() + 100 * 365 * D);
    const issuer = certType === 'Classification Certificate' ? v.classSociety : certType === 'Certificate of Registry' ? `Registry of ${v.flag}` : v.flag === j.code ? flagAdmin : 'Flag administration / RO';
    mk({ number: `${certType.split(' ').map((w) => w[0]).join('')}-${9100 + i * 13 + k}`, issuer, issueDate: iso(issue), expiryDate: iso(expiry) });
  }));
  return out;
}
