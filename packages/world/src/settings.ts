import { getJurisdiction, MODULE_SETTING_DEFAULTS, DEFAULT_RISK_WEIGHTS } from '@maritime/contracts';

export interface WorldSetting { key: string; value: Record<string, unknown> }
export function buildSettings(profile: string): WorldSetting[] {
  const j = getJurisdiction(profile);
  const ae = j.code === 'AE';
  return [
    { key: 'org', value: { portName: 'Maritime Platform', operator: ae ? 'Federal maritime administration — reference deployment' : 'Reference deployment', unlocode: ae ? 'AEAUH' : 'REFPT', jurisdiction: j.code,
      address: ae ? 'Reference deployment — demonstration data, Abu Dhabi' : 'Reference deployment — demonstration data', taxId: ae ? '100200300400003 (sample)' : '24XXXXX0000X1Z5 (sample)', taxIdLabel: j.tax.registrationLabel,
      currency: j.currency.code, timezone: j.timezone, contactEmail: 'ops@maritime.example', contactPhone: ae ? '+971 2 000 0000' : '+91 2838 000000', languages: j.languages } },
    { key: 'operations', value: { anchorageAlertHrs: 24, certExpiringDays: 30, berthWindowSlackHrs: 4 } },
    { key: 'billing', value: { taxName: j.tax.name, taxRate: j.tax.ratePct, taxRegistrationLabel: j.tax.registrationLabel, placeOfSupply: ae ? 'Abu Dhabi' : 'Gujarat', serviceCode: ae ? '996751' : '996751', invoicePrefix: j.tax.invoicePrefix, paymentTermsDays: 30, currency: j.currency.code } },
    { key: 'notifications', value: { emailEnabled: true, smsEnabled: false, digestHour: 7, escalationHours: 4 } },
    { key: 'smtp', value: { host: 'smtp.maritime.example', port: 587, secure: false, user: 'notifications@maritime.example', password: '', from: 'Maritime Platform <notifications@maritime.example>' } },
    { key: 'ai', value: { enabled: true, provider: 'uae-hosted', model: 'assistant-default', temperature: 0.2, groundedOnly: true, dailyTokenBudget: 500000, apiKey: '' } },
    { key: 'riskWeights', value: { ...DEFAULT_RISK_WEIGHTS } },
    ...Object.entries(MODULE_SETTING_DEFAULTS).map(([k, v]) => ({ key: `module:${k}`, value: { ...v, ...(k === 'finance' ? { invoicePrefix: j.tax.invoicePrefix } : {}), ...(k === 'ops' ? { vcnPrefix: ae ? 'MAR' : 'REF' } : {}) } })),
  ];
}
