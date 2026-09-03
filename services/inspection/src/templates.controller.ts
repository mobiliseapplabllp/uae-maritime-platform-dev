import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, type PageQuery } from '@maritime/contracts';
import { AuditClient, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, escapeLike, notFound, paged, parsePage, withTx, zod } from '@maritime/service-kit';
import type { Env } from './env';
import { ANSWER_TYPES, CHECKLIST_TYPES, publishTemplate, publishTemplateDeleted, templateApi, type Row, type TemplateRow } from './inspections';

/* The checklist builder's register.
 *
 * A template is versioned rather than overwritten: every save that changes the questions raises the version, and
 * a template that is no longer used is deactivated rather than deleted, because surveys carry the version they
 * were worked from and the register has to be able to show it. Deleting is allowed only while nothing has been
 * worked from the template at all. */

const text = (max: number) => z.string().trim().max(max);
const itemBody = z.object({
  seq: z.coerce.number().int().min(1).optional(), text: text(400).min(1), category: text(120).default('General'),
  answerType: z.enum(ANSWER_TYPES).default('YES_NO_NA'), weight: z.coerce.number().min(0).max(100).default(1),
  critical: z.coerce.boolean().default(false), guidance: text(600).default(''),
});
const templateBody = z.object({
  name: text(160).min(1), inspectionType: z.enum(CHECKLIST_TYPES), description: text(1000).default(''),
  items: z.array(itemBody).default([]), active: z.coerce.boolean().default(true),
  passScorePct: z.coerce.number().int().min(0).max(100).default(80), version: z.coerce.number().int().min(1).optional(),
});
const templatePatch = templateBody.partial();
const activateBody = z.object({ active: z.coerce.boolean().default(true) });

const SORT: Record<string, string> = { name: 'name', inspectionType: 'inspection_type', version: 'version', active: 'active', passScorePct: 'pass_score_pct', createdAt: 'created_at', updatedAt: 'updated_at' };
const reseq = (items: Row[]) => items.map((i, ix) => ({ ...i, seq: ix + 1 }));

@Controller('checklist-templates')
export class TemplatesController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  private async load(id: string): Promise<TemplateRow> {
    const r = await this.pool.query<TemplateRow>('SELECT * FROM checklist_templates WHERE id::text = $1', [id]);
    if (!r.rows[0]) throw notFound('Checklist template not found');
    return r.rows[0];
  }

  @RequirePerm('masters.view', 'inspections.view') @Get()
  async list(@Query() query: PageQuery & { inspectionType?: string; active?: string }) {
    const p = parsePage(query, { defaultSort: 'name', sortable: Object.keys(SORT), maxLimit: 200 });
    const where: string[] = []; const args: unknown[] = [];
    if (query.inspectionType) { args.push(query.inspectionType); where.push(`inspection_type = $${args.length}`); }
    if (query.active !== undefined && query.active !== '') { args.push(String(query.active) === 'true'); where.push(`active = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(name ILIKE $${args.length} OR description ILIKE $${args.length} OR inspection_type ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM checklist_templates ${w}`, args);
    const rows = await this.pool.query<TemplateRow>(`SELECT * FROM checklist_templates ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir}, name LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(templateApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('masters.view', 'inspections.view') @Get(':id')
  async get(@Param('id') id: string) {
    const t = await this.load(id);
    const used = await this.pool.query<{ n: string }>('SELECT count(*) AS n FROM inspections WHERE template_id = $1', [t.id]);
    return { ...templateApi(t), inspectionsUsing: Number(used.rows[0].n) };
  }

  @RequirePerm('masters.manage', 'inspections.edit') @Post()
  async create(@Body(zod(templateBody)) body: z.infer<typeof templateBody>) {
    return withTx(this.pool, async (c) => {
      const dupe = await c.query('SELECT id FROM checklist_templates WHERE lower(name) = lower($1)', [body.name]);
      if (dupe.rowCount) throw conflict(`A checklist named ${body.name} already exists`);
      const r = await c.query<TemplateRow>(
        'INSERT INTO checklist_templates(name, inspection_type, description, items, active, version, pass_score_pct) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [body.name, body.inspectionType, body.description, JSON.stringify(reseq(body.items)), body.active, body.version ?? 1, body.passScorePct]);
      const t = r.rows[0];
      await this.audit.record(c, { action: 'CREATE', entity: 'ChecklistTemplate', entityId: t.id, entityLabel: t.name, after: templateApi(t) });
      return publishTemplate(c, this.env, t, EVENTS.inspection.templateCreated);
    });
  }

  /** Saving a changed question set raises the version; a metadata-only edit leaves it where it is. */
  @RequirePerm('masters.manage', 'inspections.edit') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(templatePatch)) body: z.infer<typeof templatePatch>) {
    return withTx(this.pool, async (c) => {
      const found = await c.query<TemplateRow>('SELECT * FROM checklist_templates WHERE id::text = $1 FOR UPDATE', [id]);
      const before = found.rows[0];
      if (!before) throw notFound('Checklist template not found');
      if (body.name && body.name.toLowerCase() !== before.name.toLowerCase()) {
        const dupe = await c.query('SELECT id FROM checklist_templates WHERE lower(name) = lower($1) AND id <> $2', [body.name, before.id]);
        if (dupe.rowCount) throw conflict(`A checklist named ${body.name} already exists`);
      }
      const items = body.items === undefined ? (before.items ?? []) : reseq(body.items);
      const questionsChanged = body.items !== undefined && JSON.stringify(items) !== JSON.stringify(before.items ?? []);
      const version = body.version ?? (questionsChanged ? before.version + 1 : before.version);
      const r = await c.query<TemplateRow>(
        `UPDATE checklist_templates SET name = $2, inspection_type = $3, description = $4, items = $5, active = $6, version = $7, pass_score_pct = $8, updated_at = now() WHERE id = $1 RETURNING *`,
        [before.id, body.name ?? before.name, body.inspectionType ?? before.inspection_type, body.description ?? before.description,
          JSON.stringify(items), body.active ?? before.active, version, body.passScorePct ?? before.pass_score_pct]);
      const t = r.rows[0];
      await this.audit.record(c, { action: 'UPDATE', entity: 'ChecklistTemplate', entityId: t.id, entityLabel: t.name, before: templateApi(before), after: templateApi(t) });
      return publishTemplate(c, this.env, t, EVENTS.inspection.templateUpdated, { versionRaised: version !== before.version });
    });
  }

  /** Activation is its own step, because retiring a checklist is a policy decision, not an edit. */
  @RequirePerm('masters.manage', 'inspections.edit') @Post(':id/activate')
  async activate(@Param('id') id: string, @Body(zod(activateBody)) body: z.infer<typeof activateBody>) {
    return withTx(this.pool, async (c) => {
      const found = await c.query<TemplateRow>('SELECT * FROM checklist_templates WHERE id::text = $1 FOR UPDATE', [id]);
      const before = found.rows[0];
      if (!before) throw notFound('Checklist template not found');
      if (before.active === body.active) throw conflict(`${before.name} is already ${body.active ? 'active' : 'inactive'}`);
      if (!before.items?.length && body.active) throw badRequest('A checklist with no questions cannot be activated');
      const r = await c.query<TemplateRow>('UPDATE checklist_templates SET active = $2, updated_at = now() WHERE id = $1 RETURNING *', [before.id, body.active]);
      const t = r.rows[0];
      await this.audit.record(c, { action: body.active ? 'ACTIVATE' : 'DEACTIVATE', entity: 'ChecklistTemplate', entityId: t.id, entityLabel: t.name, before: { active: before.active }, after: { active: t.active } });
      return publishTemplate(c, this.env, t, EVENTS.inspection.templateActivated, { active: t.active });
    });
  }

  @RequirePerm('masters.manage', 'inspections.edit') @Delete(':id')
  async remove(@Param('id') id: string) {
    return withTx(this.pool, async (c) => {
      const found = await c.query<TemplateRow>('SELECT * FROM checklist_templates WHERE id::text = $1 FOR UPDATE', [id]);
      const t = found.rows[0];
      if (!t) throw notFound('Checklist template not found');
      const used = await c.query<{ n: string }>('SELECT count(*) AS n FROM inspections WHERE template_id = $1', [t.id]);
      if (Number(used.rows[0].n) > 0) throw conflict(`${t.name} has been used on ${used.rows[0].n} survey(s) — deactivate it instead of deleting`);
      await this.audit.record(c, { action: 'DELETE', entity: 'ChecklistTemplate', entityId: t.id, entityLabel: t.name, before: templateApi(t) });
      await c.query('DELETE FROM checklist_templates WHERE id = $1', [t.id]);
      await publishTemplateDeleted(c, this.env, t);
      return { deleted: true, id: t.id };
    });
  }
}
