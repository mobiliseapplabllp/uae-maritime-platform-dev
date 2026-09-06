import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_POOL, RequirePerm } from '@maritime/service-kit';
import { studioDashboard } from './studio';

/** The Data Studio dashboard: the masters, the golden records and the settings, graded on the data-quality dimensions. */
@Controller('golden')
export class StudioController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}

  @RequirePerm('masters.view', 'dashboard.view') @Get('dashboard')
  async dashboard() {
    const [lookups, vessels, companies, settings] = await Promise.all([
      this.pool.query<{ category: string; code: string; label: string; label_ar: string | null; active: boolean; updated_at: Date; created_at: Date }>('SELECT category, code, label, label_ar, active, updated_at, created_at FROM lookups'),
      this.pool.query<{ imo: string; mmsi: string | null; call_sign: string | null; flag: string | null; type: string | null; built: number | null; dwt: string | null; grt: string | null; loa: string | null; owner: string | null; operator: string | null; class_society: string | null; status: string; record_status: string; updated_at: Date }>(
        'SELECT imo, mmsi, call_sign, flag, type, built, dwt, grt, loa, owner, operator, class_society, status, record_status, updated_at FROM vessels_golden'),
      this.pool.query<{ code: string; name: string; name_ar: string | null; category: string | null; tax_id: string | null; registration_no: string | null; has_contacts: boolean; status: string; record_status: string; updated_at: Date }>(
        "SELECT code, name, name_ar, category, tax_id, registration_no, (coalesce(contact_email, '') <> '' OR coalesce(contact_phone, '') <> '') AS has_contacts, status, record_status, updated_at FROM companies"),
      this.pool.query<{ key: string; updated_at: Date; updated_by: string | null }>('SELECT key, updated_at, updated_by FROM settings'),
    ]);
    return studioDashboard({
      lookups: lookups.rows.map((l) => ({ category: l.category, code: l.code, label: l.label, labelAr: l.label_ar, active: l.active, updatedAt: l.updated_at, createdAt: l.created_at })),
      vessels: vessels.rows.map((v) => ({ imo: v.imo, mmsi: v.mmsi, callSign: v.call_sign, flag: v.flag, type: v.type, built: v.built, dwt: Number(v.dwt) || null, grt: Number(v.grt) || null, loa: Number(v.loa) || null, owner: v.owner, operator: v.operator, classSociety: v.class_society, status: v.status, recordStatus: v.record_status, updatedAt: v.updated_at })),
      companies: companies.rows.map((c) => ({ code: c.code, name: c.name, nameAr: c.name_ar, category: c.category, taxId: c.tax_id, registrationNo: c.registration_no, hasContacts: !!c.has_contacts, status: c.status, recordStatus: c.record_status, updatedAt: c.updated_at })),
      settings: settings.rows.map((s) => ({ key: s.key, updatedAt: s.updated_at, updatedBy: s.updated_by })),
    }, new Date());
  }
}
