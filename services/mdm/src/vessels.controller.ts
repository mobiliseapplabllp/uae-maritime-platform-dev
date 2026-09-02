import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, type PageQuery } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, AuditClient, RequirePerm, ServiceOnly, zod, paged, parsePage, escapeLike, notFound, badRequest, withTx, enqueue, eventFromContext } from '@maritime/service-kit';
import type { Env } from './env';

/** Golden vessel identity records. The Ships service owns registration and certification; every other service references these ids. */
const imoCheck = (six: string) => String(six.split('').reduce((s, d, i) => s + Number(d) * (7 - i), 0) % 10);
export const validImo = (imo: string) => /^\d{7}$/.test(imo) && imoCheck(imo.slice(0, 6)) === imo[6];
const schema = z.object({ imo: z.string().regex(/^\d{7}$/), name: z.string().min(1).max(120), nameAr: z.string().max(120).optional().nullable(), mmsi: z.string().max(12).optional().nullable(), callSign: z.string().max(12).optional().nullable(), flag: z.string().max(60).optional().default(''), type: z.string().max(20).optional().default('GEN'),
  built: z.number().int().min(1900).max(2100).optional().nullable(), dwt: z.number().int().optional().nullable(), grt: z.number().int().optional().nullable(), loa: z.number().optional().nullable(), beam: z.number().optional().nullable(), maxDraft: z.number().optional().nullable(),
  owner: z.string().max(160).optional().default(''), operator: z.string().max(160).optional().default(''), manager: z.string().max(160).optional().default(''), agentCode: z.string().max(20).optional().nullable(), classSociety: z.string().max(40).optional().nullable(), teuCapacity: z.number().int().optional().nullable(), status: z.enum(['ACTIVE', 'INACTIVE']).optional().default('ACTIVE') });
interface Row { id: string; imo: string; name: string; name_ar: string | null; mmsi: string | null; call_sign: string | null; flag: string; type: string; built: number | null; dwt: number | null; grt: number | null; loa: string | null; beam: string | null; max_draft: string | null; owner: string; operator: string; manager: string; agent_code: string | null; class_society: string | null; teu_capacity: number | null; liner: boolean; real: boolean; status: string; record_status: string; created_at: Date; updated_at: Date }
const toApi = (r: Row) => ({ id: r.id, imo: r.imo, name: r.name, nameAr: r.name_ar, mmsi: r.mmsi, callSign: r.call_sign, flag: r.flag, type: r.type, built: r.built, dwt: r.dwt, grt: r.grt, loa: r.loa == null ? null : Number(r.loa), beam: r.beam == null ? null : Number(r.beam), maxDraft: r.max_draft == null ? null : Number(r.max_draft), owner: r.owner, operator: r.operator, manager: r.manager, agentCode: r.agent_code, classSociety: r.class_society, teuCapacity: r.teu_capacity, liner: r.liner, real: r.real, status: r.status, recordStatus: r.record_status, createdAt: r.created_at, updatedAt: r.updated_at });
const SORT: Record<string, string> = { name: 'name', imo: 'imo', type: 'type', flag: 'flag', built: 'built', grt: 'grt', status: 'status', createdAt: 'created_at' };

@Controller('golden/vessels')
export class VesselsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  @RequirePerm('vessels.view') @Get()
  async list(@Query() query: PageQuery & { type?: string; status?: string; flag?: string }) {
    const p = parsePage(query, { defaultSort: 'name', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    if (query.type) { args.push(query.type); where.push(`type = $${args.length}`); }
    if (query.status) { args.push(query.status); where.push(`status = $${args.length}`); }
    if (query.flag) { args.push(query.flag); where.push(`flag = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(name ILIKE $${args.length} OR imo ILIKE $${args.length} OR coalesce(call_sign,'') ILIKE $${args.length} OR coalesce(mmsi,'') ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM vessels_golden ${w}`, args);
    const rows = await this.pool.query<Row>(`SELECT * FROM vessels_golden ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, id LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(toApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }
  @ServiceOnly() @Get('internal/all')
  async internalAll() { const r = await this.pool.query<Row>('SELECT * FROM vessels_golden ORDER BY name'); return r.rows.map(toApi); }
  @RequirePerm('vessels.view') @Get(':id')
  async get(@Param('id') id: string) { const r = await this.pool.query<Row>('SELECT * FROM vessels_golden WHERE id::text = $1 OR imo = $1', [id]); if (!r.rows[0]) throw notFound('Vessel not found'); return toApi(r.rows[0]); }
  @RequirePerm('vessels.create') @Post()
  async create(@Body(zod(schema)) b: z.infer<typeof schema>) {
    if (!validImo(b.imo)) throw badRequest('IMO number fails its check digit');
    return withTx(this.pool, async (c) => {
      const r = await c.query<Row>('INSERT INTO vessels_golden(imo, name, name_ar, mmsi, call_sign, flag, type, built, dwt, grt, loa, beam, max_draft, owner, operator, manager, agent_code, class_society, teu_capacity, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *',
        [b.imo, b.name, b.nameAr ?? null, b.mmsi ?? null, b.callSign ?? null, b.flag, b.type, b.built ?? null, b.dwt ?? null, b.grt ?? null, b.loa ?? null, b.beam ?? null, b.maxDraft ?? null, b.owner, b.operator, b.manager, b.agentCode ?? null, b.classSociety ?? null, b.teuCapacity ?? null, b.status]);
      await this.audit.record(c, { action: 'CREATE', entity: 'Vessel', entityId: r.rows[0].id, entityLabel: `${b.name} (IMO ${b.imo})`, after: toApi(r.rows[0]) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.mdm.vesselUpserted, { vesselId: r.rows[0].id, imo: b.imo, name: b.name, flag: b.flag, type: b.type, status: b.status }));
      return toApi(r.rows[0]);
    });
  }
  @RequirePerm('vessels.edit') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(schema.partial())) b: Partial<z.infer<typeof schema>>) {
    const before = await this.pool.query<Row>('SELECT * FROM vessels_golden WHERE id = $1', [id]); if (!before.rows[0]) throw notFound('Vessel not found');
    const o = before.rows[0]; const num = (v: unknown, fb: string | null) => (v === undefined ? fb : v);
    return withTx(this.pool, async (c) => {
      const r = await c.query<Row>('UPDATE vessels_golden SET name=$1, name_ar=$2, mmsi=$3, call_sign=$4, flag=$5, type=$6, built=$7, dwt=$8, grt=$9, loa=$10, beam=$11, max_draft=$12, owner=$13, operator=$14, manager=$15, agent_code=$16, class_society=$17, teu_capacity=$18, status=$19, updated_at=now() WHERE id=$20 RETURNING *',
        [b.name ?? o.name, b.nameAr === undefined ? o.name_ar : b.nameAr, b.mmsi === undefined ? o.mmsi : b.mmsi, b.callSign === undefined ? o.call_sign : b.callSign, b.flag ?? o.flag, b.type ?? o.type, b.built === undefined ? o.built : b.built, b.dwt === undefined ? o.dwt : b.dwt, b.grt === undefined ? o.grt : b.grt, num(b.loa, o.loa), num(b.beam, o.beam), num(b.maxDraft, o.max_draft), b.owner ?? o.owner, b.operator ?? o.operator, b.manager ?? o.manager, b.agentCode === undefined ? o.agent_code : b.agentCode, b.classSociety === undefined ? o.class_society : b.classSociety, b.teuCapacity === undefined ? o.teu_capacity : b.teuCapacity, b.status ?? o.status, id]);
      await this.audit.record(c, { action: 'UPDATE', entity: 'Vessel', entityId: id, entityLabel: `${r.rows[0].name} (IMO ${o.imo})`, before: toApi(o), after: toApi(r.rows[0]) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.mdm.vesselUpserted, { vesselId: id, imo: o.imo, name: r.rows[0].name, flag: r.rows[0].flag, type: r.rows[0].type, status: r.rows[0].status }));
      return toApi(r.rows[0]);
    });
  }
}
