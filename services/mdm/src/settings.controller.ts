import { Body, Controller, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, MODULE_SETTING_DEFAULTS, SETTING_FIELDS, SETTING_SECTIONS, getJurisdiction, unconfirmedFigures, type SettingSection } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, AuditClient, Public, RequirePerm, ServiceOnly, zod, badRequest, withTx, enqueue, eventFromContext, getContext, smtpVerify } from '@maritime/service-kit';
import type { Env } from './env';

const SECRET_FIELDS: Record<string, string[]> = { smtp: ['password'], ai: ['apiKey', 'uaeKey'] };
const MASK = '••••••••';
const mask = (section: string, value: Record<string, unknown>) => {
  const out = { ...value };
  for (const f of SECRET_FIELDS[section] ?? []) if (typeof out[f] === 'string' && (out[f] as string).length) out[f] = MASK;
  return out;
};
const valueSchema = z.record(z.unknown());
/** A section cut down to the keys it declares, so a retired setting never reaches a screen or a service. */
const known = (section: SettingSection, v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).filter(([k]) => SETTING_FIELDS[section].includes(k)));
const isSection = (s: string): s is SettingSection => (SETTING_SECTIONS as readonly string[]).includes(s);

@Controller()
export class SettingsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  private async read(key: string): Promise<Record<string, unknown> | null> { const r = await this.pool.query<{ value: Record<string, unknown> }>('SELECT value FROM settings WHERE key = $1', [key]); return r.rows[0]?.value ?? null; }

  /** Every platform section with its values, and when and by whom each was last changed. */
  @RequirePerm('settings.view') @Get('settings')
  async all() {
    const r = await this.pool.query<{ key: string; value: Record<string, unknown>; updated_at: Date; updated_by: string | null }>('SELECT key, value, updated_at, updated_by FROM settings WHERE key = ANY($1)', [[...SETTING_SECTIONS]]);
    const values: Record<string, unknown> = {}; const meta: Record<string, unknown> = {};
    for (const section of SETTING_SECTIONS) {
      const row = r.rows.find((x) => x.key === section);
      values[section] = mask(section, known(section, row?.value ?? {}));
      meta[section] = { updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null };
    }
    return { sections: SETTING_SECTIONS, fields: SETTING_FIELDS, values, meta };
  }
  @RequirePerm('settings.manage') @Put('settings/:section')
  async update(@Param('section') section: string, @Body(zod(valueSchema)) body: Record<string, unknown>) {
    if (!isSection(section)) throw badRequest('Unknown settings section');
    const unknown = Object.keys(body).filter((k) => !SETTING_FIELDS[section].includes(k)); if (unknown.length) throw badRequest(`Unknown settings: ${unknown.join(', ')}`);
    const before = known(section, (await this.read(section)) ?? {});
    const merged = { ...before, ...body };
    for (const f of SECRET_FIELDS[section] ?? []) if (merged[f] === MASK) merged[f] = before[f]; // masked value means "unchanged"
    return withTx(this.pool, async (c) => {
      await c.query('INSERT INTO settings(key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by', [section, JSON.stringify(merged), getContext()?.actor?.name ?? getContext()?.actor?.id ?? null]);
      await this.audit.record(c, { action: 'UPDATE', entity: 'Setting', entityId: section, entityLabel: section, before: mask(section, before), after: mask(section, merged) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.mdm.settingsChanged, { key: section }));
      return mask(section, merged);
    });
  }
  /** Connects to the relay with the stored profile, negotiates TLS and authenticates, and reports what actually happened. */
  @RequirePerm('settings.manage') @Post('settings/smtp/test')
  async smtpTest() {
    const smtp = (await this.read('smtp')) ?? {};
    if (!smtp.host) throw badRequest('SMTP host is not configured');
    const r = await smtpVerify({ host: String(smtp.host), port: Number(smtp.port) || undefined, secure: !!smtp.secure, user: smtp.user ? String(smtp.user) : undefined, password: smtp.password ? String(smtp.password) : undefined, from: smtp.from ? String(smtp.from) : undefined, timeoutMs: 6000 });
    return { status: r.ok ? 'OK' : 'FAILED', ok: r.ok, tls: r.tls, authenticated: r.authenticated, durationMs: r.durationMs, detail: r.detail };
  }
  /** Every module's settings at once — values over defaults, and when and by whom each was last changed — for the settings landing. */
  @RequirePerm('settings.view') @Get('module-settings')
  async moduleAll() {
    const keys = Object.keys(MODULE_SETTING_DEFAULTS);
    const r = await this.pool.query<{ key: string; value: Record<string, unknown>; updated_at: Date; updated_by: string | null }>('SELECT key, value, updated_at, updated_by FROM settings WHERE key = ANY($1)', [keys.map((k) => `module:${k}`)]);
    const modules: Record<string, unknown> = {};
    for (const key of keys) {
      const row = r.rows.find((x) => x.key === `module:${key}`);
      modules[key] = { defaults: MODULE_SETTING_DEFAULTS[key], values: { ...MODULE_SETTING_DEFAULTS[key], ...(row?.value ?? {}) }, updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null };
    }
    return { keys, modules };
  }
  @Get('module-settings/:key')
  async moduleGet(@Param('key') key: string) {
    const defaults = MODULE_SETTING_DEFAULTS[key]; if (!defaults) throw badRequest('Unknown module');
    const stored = (await this.read(`module:${key}`)) ?? {};
    return { key, defaults, values: { ...defaults, ...stored } };
  }
  @RequirePerm('settings.manage') @Put('module-settings/:key')
  async modulePut(@Param('key') key: string, @Body(zod(valueSchema)) body: Record<string, unknown>) {
    const defaults = MODULE_SETTING_DEFAULTS[key]; if (!defaults) throw badRequest('Unknown module');
    const unknown = Object.keys(body).filter((k) => !(k in defaults)); if (unknown.length) throw badRequest(`Unknown settings: ${unknown.join(', ')}`);
    const before = (await this.read(`module:${key}`)) ?? {};
    const merged = { ...before, ...body };
    return withTx(this.pool, async (c) => {
      await c.query('INSERT INTO settings(key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by', [`module:${key}`, JSON.stringify(merged), getContext()?.actor?.name ?? getContext()?.actor?.id ?? null]);
      await this.audit.record(c, { action: 'UPDATE', entity: 'ModuleSetting', entityId: key, entityLabel: `module:${key}`, before: { ...defaults, ...before }, after: { ...defaults, ...merged } });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.mdm.settingsChanged, { key: `module:${key}` }));
      return { key, defaults, values: { ...defaults, ...merged } };
    });
  }
  @RequirePerm('settings.manage') @Post('module-settings/:key/reset')
  async moduleReset(@Param('key') key: string) {
    const defaults = MODULE_SETTING_DEFAULTS[key]; if (!defaults) throw badRequest('Unknown module');
    await withTx(this.pool, async (c) => {
      await c.query('DELETE FROM settings WHERE key = $1', [`module:${key}`]);
      await this.audit.record(c, { action: 'RESET', entity: 'ModuleSetting', entityId: key, entityLabel: `module:${key}` });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.mdm.settingsChanged, { key: `module:${key}` }));
    });
    return { key, defaults, values: defaults };
  }
  @ServiceOnly() @Get('internal/settings/:key')
  async internal(@Param('key') key: string) {
    const stored = (await this.read(key)) ?? {};
    if (key.startsWith('module:')) return { ...(MODULE_SETTING_DEFAULTS[key.slice(7)] ?? {}), ...stored };
    return stored;
  }
  @Public() @Get('jurisdiction')
  async jurisdiction() {
    const org = (await this.read('org')) ?? {};
    const code = String(org.jurisdiction ?? this.env.SERVICE_NAME === 'mdm' ? org.jurisdiction ?? 'AE' : 'AE');
    const p = getJurisdiction(code);
    const str = (k: string) => (typeof org[k] === 'string' ? String(org[k]) : '');
    return { code: p.code, name: p.name, authority: p.authority, pscRegime: p.pscRegime, currency: p.currency, tax: p.tax, timezone: str('timezone') || p.timezone, languages: p.languages, workingWeek: p.workingWeek, identity: p.identity,
      // the deployment's own identity, from Settings → Organisation: what the shell, documents and senders call this administration
      org: { portName: str('portName'), operator: str('operator'), unlocode: str('unlocode'), address: str('address'), contactEmail: str('contactEmail'), contactPhone: str('contactPhone') },
      registry: { registrar: p.registry.registrar, statute: p.registry.statute, portsOfRegistry: p.registry.portsOfRegistry, defaultPort: p.registry.defaultPort, shareDenominator: p.registry.shareDenominator, maxRegisteredOwners: p.registry.maxRegisteredOwners, provisionalValidityMonths: p.registry.provisionalValidityMonths, nationalityRule: p.registry.nationalityRule },
      benchmarks: Object.entries(p.benchmarks).map(([key, b]) => ({ key, ...b })), unconfirmed: unconfirmedFigures(code) };
  }
}
