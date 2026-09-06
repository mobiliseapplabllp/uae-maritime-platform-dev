import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Card, Chip, Divider, FormControlLabel, Grid, MenuItem, Skeleton, Stack, Switch, TextField, Typography } from '@mui/material';
import SaveRoundedIcon from '@mui/icons-material/SaveRounded';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import MarkEmailReadRoundedIcon from '@mui/icons-material/MarkEmailReadRounded';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import IntegrationsPanel from './IntegrationsPanel';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import { StatePage } from '../../components/common/StatePage';
import { useProfile } from '../../config/runtime';
import { fmtDT } from '../../utils/format';
import { INTEGRATIONS_CARD, SECTIONS } from './settings/catalogue';

/* One platform section: its form, where it is used, and — for the sections that have one — the live state it governs:
 * the SMTP relay's answer, the escalation sweep's standing, the assistant's budget for the day. */
type Values = Record<string, any>;
interface Meta { updatedAt: string | null; updatedBy: string | null }
/** Values an earlier catalogue stored for the same choices. */
const PROVIDER_ALIAS: Record<string, string> = { gateway: 'anthropic', 'uae-hosted': 'uae' };
const AI_PROFILES = [{ value: 'assistant-default', label: 'Platform assistant (in-country hosting, recommended)' }, { value: 'assistant-fast', label: 'Fast tier' }, { value: 'assistant-reasoning', label: 'Reasoning tier' }];
const F = ({ children }: { children: React.ReactNode }) => <Grid item xs={12} sm={6} md={4}>{children}</Grid>;

function UsedBy({ blurb, readBy, meta }: { blurb: string; readBy: string[]; meta?: Meta }) {
  return (
    <Card sx={{ p: 2 }}>
      <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Where this is used</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{blurb}</Typography>
      <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.25 }}>{readBy.map((r) => <Typography component="li" variant="body2" key={r}>{r}</Typography>)}</Stack>
      {meta && <><Divider sx={{ my: 1.5 }} /><Typography variant="caption" color="text.secondary">{meta.updatedAt ? `Last changed ${fmtDT(meta.updatedAt)}${meta.updatedBy ? ` by ${meta.updatedBy}` : ''}` : 'Seeded defaults — never changed here'}</Typography></>}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>A saved value is read by the services on their next request; nothing restarts.</Typography>
    </Card>
  );
}

/** The escalation sweep as the notifications service reports it, and a way to run it now. */
function EscalationPanel({ canManage }: { canManage: boolean }) {
  const dispatch = useAppDispatch();
  const [state, setState] = useState<{ escalation: { hours: number; escalated24h: number; unreadCritical: number }; channels: { email: boolean; sms: boolean; relay: string } } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<typeof state>('/notifications/deliveries', { params: { limit: 1 }, headers: { 'X-Quiet': '1' } }).then((r) => setState(r.data)).catch(() => setState(null));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = () => {
    setBusy(true);
    api.post<{ escalated: number; recipients: number; hours: number }>('/notifications/escalate').then((r) => { dispatch(notify(r.data.hours > 0 ? `Escalated ${r.data.escalated} notice(s) to ${r.data.recipients} recipient(s)` : 'Escalation is switched off (0 hours)')); load(); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))).finally(() => setBusy(false));
  };
  if (!state) return null;
  return (
    <Card sx={{ p: 2, mt: 2 }} data-testid="escalation-panel">
      <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Escalation, live</Typography>
      <Typography variant="body2" color="text.secondary">Unread critical notices are sent on after {state.escalation.hours} h — by email {state.channels.email ? 'on' : 'off'}, SMS {state.channels.sms ? 'on' : 'off'}, through {state.channels.relay}.</Typography>
      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap alignItems="center">
        <Chip size="small" label={`${state.escalation.unreadCritical} unread critical`} color={state.escalation.unreadCritical ? 'warning' : 'default'} />
        <Chip size="small" variant="outlined" label={`${state.escalation.escalated24h} escalated in 24 h`} />
        {canManage && <Button size="small" startIcon={<SendRoundedIcon />} onClick={run} disabled={busy}>Run escalation now</Button>}
      </Stack>
    </Card>
  );
}

/** The assistant's standing for the day, as it reports it. */
function AssistantPanel() {
  const [status, setStatus] = useState<{ enabled: boolean; profile: string; composer: string; keyConfigured: boolean; budget: { dailyTokens: number; usedToday: number; questionsToday: number; remaining: number | null; exhausted: boolean } } | null>(null);
  useEffect(() => { api.get<typeof status>('/ai/status', { headers: { 'X-Quiet': '1' } }).then((r) => setStatus(r.data)).catch(() => setStatus(null)); }, []);
  if (!status) return null;
  return (
    <Card sx={{ p: 2, mt: 2 }} data-testid="assistant-panel">
      <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Assistant, live</Typography>
      <Typography variant="body2" color="text.secondary">{status.enabled ? `Answering on the ${status.composer} under profile ${status.profile}${status.keyConfigured ? ', provider key set' : ''}.` : 'Switched off — every question and every draft is refused with the reason.'}</Typography>
      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
        <Chip size="small" variant="outlined" label={`${status.budget.questionsToday} questions today`} />
        <Chip size="small" variant="outlined" label={`${status.budget.usedToday.toLocaleString('en-GB')} tokens used today`} />
        <Chip size="small" color={status.budget.exhausted ? 'error' : 'default'} label={status.budget.dailyTokens > 0 ? `${(status.budget.remaining ?? 0).toLocaleString('en-GB')} of ${status.budget.dailyTokens.toLocaleString('en-GB')} left` : 'No daily budget'} />
      </Stack>
    </Card>
  );
}

export default function SettingsSection() {
  const { section = '' } = useParams();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const profile = useProfile();
  const canManage = hasPerm(user, 'settings.manage');
  const def = SECTIONS.find((s) => s.key === section);
  const [vals, setVals] = useState<Values | null>(null);
  const [meta, setMeta] = useState<Meta | undefined>();
  const [busy, setBusy] = useState(false);
  const [smtpResult, setSmtpResult] = useState<{ ok: boolean; text: string } | null>(null);
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const back = <Button startIcon={<ArrowBackRoundedIcon />} onClick={() => navigate('/admin/settings')}>All settings</Button>;

  useEffect(() => {
    if (!def) return;
    setVals(null); setSmtpResult(null);
    api.get<{ values: Record<string, Values>; meta: Record<string, Meta> }>('/settings').then((r) => { setVals(r.data.values[def.key] || {}); setMeta(r.data.meta?.[def.key]); }).catch(err);
  }, [section]); // eslint-disable-line react-hooks/exhaustive-deps

  if (section === 'integrations') {
    return (
      <>
        <PageHeader icon={INTEGRATIONS_CARD.icon} iconColor={INTEGRATIONS_CARD.color} title="Integrations" sub={INTEGRATIONS_CARD.blurb} actions={back} />
        <Card sx={{ p: 2 }}><IntegrationsPanel /></Card>
      </>
    );
  }
  if (!def) return <StatePage code="404" title="No such settings section" message="The section named in the address does not exist." />;
  if (!vals) return <Skeleton variant="rounded" height={480} />;

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setVals((v) => ({ ...(v || {}), [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value }));
  const save = () => {
    setBusy(true);
    api.put<Values>(`/settings/${def.key}`, vals).then((r) => { dispatch(notify(`${def.label} settings saved`)); setVals(r.data); setMeta({ updatedAt: new Date().toISOString(), updatedBy: user?.name ?? null }); }).catch(err).finally(() => setBusy(false));
  };
  const testSmtp = () => {
    setBusy(true); setSmtpResult(null);
    api.put(`/settings/smtp`, vals).then(() => api.post<{ ok: boolean; detail: string; tls: boolean; authenticated: boolean; durationMs: number }>('/settings/smtp/test', vals))
      .then((r) => setSmtpResult({ ok: r.data.ok, text: `${r.data.detail}${r.data.ok ? ` — ${r.data.tls ? 'TLS' : 'plain'}${r.data.authenticated ? ', authenticated' : ''}, ${r.data.durationMs} ms` : ''}` }))
      .catch((e: Error) => setSmtpResult({ ok: false, text: e.message })).finally(() => setBusy(false));
  };
  const t = (k: string, label: string, extra: Record<string, unknown> = {}) => <TextField fullWidth size="small" label={label} value={vals[k] ?? ''} onChange={set(k)} disabled={!canManage} {...extra} />;
  const sw = (k: string, label: string) => <FormControlLabel control={<Switch checked={!!vals[k]} onChange={set(k)} disabled={!canManage} />} label={label} />;

  return (
    <>
      <PageHeader icon={def.icon} iconColor={def.color} title={`${def.label} — settings`} sub={def.blurb}
        actions={<Stack direction="row" spacing={1}>{back}{canManage && <Button variant="contained" startIcon={<SaveRoundedIcon />} onClick={save} disabled={busy}>Save {def.label}</Button>}</Stack>} />
      <Grid container spacing={2}>
        <Grid item xs={12} md={8}>
          <Card sx={{ p: 2.5 }}>
            {section === 'org' && (
              <Grid container spacing={2}>
                <F>{t('portName', 'Platform / port name')}</F><F>{t('operator', 'Operator')}</F><F>{t('unlocode', 'UN/LOCODE')}</F>
                <Grid item xs={12} md={8}>{t('address', 'Address')}</Grid><F>{t('taxId', `${vals.taxIdLabel || profile.tax.registrationLabel} (sample)`)}</F>
                <F>{t('taxIdLabel', 'Registration label')}</F><F>{t('currency', 'Base currency')}</F><F>{t('timezone', 'Timezone')}</F>
                <F>{t('contactEmail', 'Contact email', { type: 'email' })}</F><F>{t('contactPhone', 'Contact phone')}</F>
              </Grid>
            )}
            {section === 'billing' && (
              <Grid container spacing={2}>
                <F>{t('taxName', 'Tax name')}</F><F>{t('taxRate', `${vals.taxName || profile.tax.name} rate (%) — applied to every NEW invoice`, { type: 'number' })}</F><F>{t('taxRegistrationLabel', 'Tax registration label')}</F>
                <F>{t('placeOfSupply', 'Place of supply')}</F><F>{t('serviceCode', 'Service code (port services)')}</F><F>{t('currency', 'Invoice currency')}</F>
                <Grid item xs={12}><Typography variant="caption" color="text.secondary">Invoice numbering, payment terms and rounding are the Revenue & Billing module's own settings.</Typography></Grid>
              </Grid>
            )}
            {section === 'notifications' && (
              <Grid container spacing={2}>
                <Grid item xs={12} md={6}>{sw('emailEnabled', 'Email notifications enabled')}</Grid><Grid item xs={12} md={6}>{sw('smsEnabled', 'SMS notifications enabled')}</Grid>
                <F>{t('digestHour', 'Daily digest hour (24h, local time)', { type: 'number', inputProps: { min: 0, max: 23 } })}</F><F>{t('escalationHours', 'Escalate unread critical alerts after (hours)', { type: 'number', helperText: '0 switches escalation off', inputProps: { min: 0 } })}</F>
              </Grid>
            )}
            {section === 'smtp' && (
              <Grid container spacing={2}>
                <F>{t('host', 'SMTP host', { placeholder: 'smtp.example.ae', helperText: 'Empty sends email through the messaging adapter' })}</F><F>{t('port', 'Port', { type: 'number' })}</F>
                <Grid item xs={12} sm={6} md={4} sx={{ display: 'flex', alignItems: 'center' }}>{sw('secure', 'TLS (465) / STARTTLS (other ports)')}</Grid>
                <F>{t('user', 'Username')}</F><F>{t('password', 'Password', { type: 'password', helperText: 'Stored masked — retype to change' })}</F><F>{t('from', 'From (name and address)')}</F>
                <Grid item xs={12}>
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Button variant="outlined" startIcon={<MarkEmailReadRoundedIcon />} onClick={testSmtp} disabled={busy || !canManage}>Test connection</Button>
                    <Typography variant="caption" color="text.secondary">Saves the profile, then opens a session to the relay: greeting, TLS, authentication — no mail is sent.</Typography>
                  </Stack>
                  {smtpResult && <Alert sx={{ mt: 1.5 }} severity={smtpResult.ok ? 'success' : 'error'} data-testid="smtp-result">{smtpResult.text}</Alert>}
                </Grid>
              </Grid>
            )}
            {section === 'ai' && (
              <Grid container spacing={2}>
                <Grid item xs={12}>{sw('enabled', 'AI assistant enabled for permitted roles')}</Grid>
                <F><TextField select fullWidth size="small" label="Profile" value={vals.model ?? 'assistant-default'} onChange={set('model')} disabled={!canManage} helperText="The profile key the answer reports; the hosted provider sees it as the model name">{AI_PROFILES.map((m) => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}</TextField></F>
                <F><TextField select fullWidth size="small" label="Provider" value={PROVIDER_ALIAS[String(vals.provider ?? 'local')] ?? String(vals.provider ?? 'local')} onChange={set('provider')} disabled={!canManage} helperText="Every hosted completion goes through the tool gateway: masked, fenced, classified and logged" inputProps={{ 'data-testid': 'ai-provider' }}><MenuItem value="local">Platform composer — no hosted model</MenuItem><MenuItem value="anthropic">Hosted provider, through the tool gateway</MenuItem><MenuItem value="uae">In-country hosted endpoint, through the tool gateway</MenuItem><MenuItem value="cli">Command line on the gateway host, through the tool gateway (development only)</MenuItem></TextField></F>
                <F>{t('apiKey', 'Hosted provider API key', { type: 'password', helperText: 'Stored masked — retype to change. Read only by the tool gateway.', inputProps: { 'data-testid': 'ai-api-key' } })}</F>
                <F>{t('temperature', 'Temperature', { type: 'number', inputProps: { step: 0.1, min: 0, max: 1 }, helperText: 'Passed to the provider; the platform composer has none' })}</F><F>{t('dailyTokenBudget', 'Daily token budget', { type: 'number', helperText: '0 means no ceiling' })}</F>
                <Grid item xs={12}>{sw('groundedOnly', 'Grounded-only mode — the platform composer answers from the record alone, whatever the provider')}</Grid>
                <Grid item xs={12}><Typography sx={{ fontWeight: 700, fontSize: 13, mt: 1 }}>In-country slot</Typography><Typography sx={{ fontSize: 12, color: 'text.secondary' }}>A UAE-hosted endpoint that speaks the OpenAI-compatible chat API. Leave it empty until one exists; once entered, the residency rules below decide when it answers instead of the hosted provider.</Typography></Grid>
                <F>{t('uaeEndpoint', 'UAE endpoint base URL', { helperText: 'For example https://models.example.ae/v1', inputProps: { 'data-testid': 'ai-uae-endpoint' } })}</F>
                <F>{t('uaeModel', 'UAE profile', { helperText: 'The profile key the resident endpoint serves', inputProps: { 'data-testid': 'ai-uae-model' } })}</F>
                <F>{t('uaeKey', 'UAE endpoint key', { type: 'password', helperText: 'Stored masked — retype to change' })}</F>
                <Grid item xs={12}>{sw('preferResident', 'Prefer the in-country endpoint whenever it is configured')}</Grid>
                <Grid item xs={12}>{sw('residencyRequired', 'Residency required — with no in-country endpoint configured, nothing leaves the platform and the platform composer answers')}</Grid>
              </Grid>
            )}
          </Card>
          {section === 'notifications' && <EscalationPanel canManage={canManage} />}
          {section === 'ai' && hasPerm(user, 'ai.use') && <AssistantPanel />}
        </Grid>
        <Grid item xs={12} md={4}><UsedBy blurb={def.blurb} readBy={def.readBy} meta={meta} /></Grid>
      </Grid>
    </>
  );
}
