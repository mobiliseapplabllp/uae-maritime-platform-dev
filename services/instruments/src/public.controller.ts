import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_POOL, Public, badRequest } from '@maritime/service-kit';
import { SigningService, SIGNED_PAYLOAD } from './signing';
import { forceOf, findLicence } from './licences';
import { typeLabel, classLabel, isStatutory, CONVENTION } from './statutory';

/* What a third party — a port, a charterer, a foreign administration — can learn from a certificate number without an account: enough to know the instrument is real, whose it is, whether it is in force today, and that the register entry has not been altered since it was signed. Nothing else. */
@Controller('public')
export class PublicController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, private readonly signing: SigningService) {}
  @Public() @Get('verify/:licenseNo')
  async verify(@Param('licenseNo') licenseNo: string) {
    const no = String(licenseNo ?? '').trim().toUpperCase(); if (!no || no.length > 40 || !/^[A-Z0-9-]+$/.test(no)) throw badRequest('Enter the number printed on the instrument');
    const row = await findLicence(this.pool, no);
    if (!row) return { found: false, licenseNo: no, message: 'No instrument with this number is on the register' };
    const now = new Date(); const force = forceOf(row, now);
    const verification = await this.signing.verify({ licenseNo: row.license_no, entityType: row.entity_type, subjectKind: row.subject_kind, subjectId: row.subject_id, entityName: row.entity_name, issueDate: row.issue_date, expiryDate: row.expiry_date, signature: row.signature });
    return { found: true, licenseNo: row.license_no, instrumentClass: row.instrument_class, classLabel: classLabel(row.instrument_class), entityType: row.entity_type, typeLabel: typeLabel(row.entity_type), typeLabelAr: typeLabel(row.entity_type, true), subjectKind: row.subject_kind, entityName: row.entity_name, status: row.status,
      issueDate: row.issue_date, expiryDate: row.expiry_date, issuer: row.issuer, statutory: isStatutory(row.entity_type), convention: CONVENTION[row.entity_type] ?? null, inForce: force.inForce, reason: force.reason,
      nextSurvey: force.endorsements?.next ? { kind: force.endorsements.next.kind, dueFrom: force.endorsements.next.dueFrom, dueTo: force.endorsements.next.dueTo, state: force.endorsements.next.state } : null, endorsementsOverdue: force.endorsements?.overdue ?? 0,
      signature: verification, verifiedAt: now.toISOString() };
  }
  /** The public key a verifier needs, the identifier to quote when reporting, and what the signature covers. */
  @Public() @Get('signing-key')
  async signingKey() {
    const keys = await this.pool.query<{ key_id: string; active: boolean; created_at: Date; retired_at: Date | null }>('SELECT key_id, active, created_at, retired_at FROM signing_keys ORDER BY created_at');
    return { ...this.signing.publicKey(), signedPayload: SIGNED_PAYLOAD, keys: keys.rows.map((k) => ({ keyId: k.key_id, active: k.active, createdAt: k.created_at, retiredAt: k.retired_at })) };
  }
}
