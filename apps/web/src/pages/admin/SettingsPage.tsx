import { useEffect, useState } from 'react';
import { Card, Grid, Box, Typography, Skeleton, Stack, Button, Tabs, Tab, TextField, MenuItem, Switch, FormControlLabel, Divider, Chip, Alert } from '@mui/material';
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded';
import SaveRoundedIcon from '@mui/icons-material/SaveRounded';
import MarkEmailReadRoundedIcon from '@mui/icons-material/MarkEmailReadRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import ApartmentRoundedIcon from '@mui/icons-material/ApartmentRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded';
import NotificationsActiveRoundedIcon from '@mui/icons-material/NotificationsActiveRounded';
import MailRoundedIcon from '@mui/icons-material/MailRounded';
import InsightsRoundedIcon from '@mui/icons-material/InsightsRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import { useProfile } from '../../config/runtime';

/* Platform settings — organisation, operations, billing & tax, notifications, SMTP, the AI assistant and risk weights. Every save loops straight back into behaviour. */
const AI_MODELS = [{ value: 'assistant-default', label: 'Platform assistant (UAE-hosted, recommended)' }, { value: 'assistant-fast', label: 'Fast tier' }, { value: 'assistant-reasoning', label: 'Reasoning tier' }];
const TABS = [
  { key: 'org', label: 'Organisation', icon: ApartmentRoundedIcon }, { key: 'operations', label: 'Operations', icon: TuneRoundedIcon }, { key: 'billing', label: 'Billing & tax', icon: ReceiptLongRoundedIcon },
  { key: 'notifications', label: 'Notifications', icon: NotificationsActiveRoundedIcon }, { key: 'smtp', label: 'SMTP', icon: MailRoundedIcon }, { key: 'ai', label: 'AI assistant', icon: AutoAwesomeRoundedIcon }, { key: 'riskWeights', label: 'Risk weights', icon: InsightsRoundedIcon },
];
const F = ({ children }: { children: React.ReactNode }) => <Grid item xs={12} sm={6} md={4}>{children}</Grid>;
type Values = Record<string, any>;

export default function SettingsPage() {
  const dispatch = useAppDispatch();
  const user = useUser();
  const profile = useProfile();
  const canManage = hasPerm(user, 'settings.manage');
  const [all, setAll] = useState<Record<string, Values> | null>(null);
  const [tab, setTab] = useState(0);
  const [vals, setVals] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const [smtpResult, setSmtpResult] = useState<{ ok: boolean; text: string } | null>(null);
  const section = TABS[tab].key;
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));

  useEffect(() => { api.get<{ values: Record<string, Values> }>('/settings').then((r) => { setAll(r.data.values); setVals(r.data.values[TABS[0].key] || {}); }).catch(err); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (all) { setVals(all[section] || {}); setSmtpResult(null); } }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setVals((v) => ({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value }));
  const save = () => {
    setBusy(true);
    api.put<Values>(`/settings/${section}`, vals).then((r) => { dispatch(notify(`${TABS[tab].label} settings saved`)); setAll((a) => ({ ...(a || {}), [section]: r.data })); setVals(r.data); }).catch(err).finally(() => setBusy(false));
  };
  const testSmtp = () => {
    setBusy(true); setSmtpResult(null);
    api.put(`/settings/smtp`, vals).then(() => api.post<{ detail: string }>('/settings/smtp/test', vals)).then((r) => setSmtpResult({ ok: true, text: r.data.detail })).catch((e: Error) => setSmtpResult({ ok: false, text: e.message })).finally(() => setBusy(false));
  };
  if (!all) return <Skeleton variant="rounded" height={480} />;
  const t = (k: string, label: string, extra: Record<string, unknown> = {}) => <TextField fullWidth size="small" label={label} value={vals[k] ?? ''} onChange={set(k)} disabled={!canManage} {...extra} />;
  const sw = (k: string, label: string) => <FormControlLabel control={<Switch checked={!!vals[k]} onChange={set(k)} disabled={!canManage} />} label={label} />;

  return (
    <>
      <PageHeader icon={SettingsRoundedIcon} iconColor="#0A2239" title="Platform settings" sub="Global configuration — each section feeds live behaviour across the platform"
        actions={canManage && <Button variant="contained" startIcon={<SaveRoundedIcon />} onClick={save} disabled={busy}>Save {TABS[tab].label}</Button>} />
      <Card>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" allowScrollButtonsMobile sx={{ px: 1, borderBottom: 1, borderColor: 'divider' }} aria-label="Settings sections">
          {TABS.map((tb) => { const I = tb.icon; return <Tab key={tb.key} icon={<I sx={{ fontSize: 17 }} />} iconPosition="start" label={tb.label} sx={{ minHeight: 48 }} />; })}
        </Tabs>
        <Box sx={{ p: 2.5 }}>
          {section === 'org' && (
            <Grid container spacing={2}>
              <F>{t('portName', 'Platform / port name')}</F><F>{t('operator', 'Operator')}</F><F>{t('unlocode', 'UN/LOCODE')}</F>
              <Grid item xs={12} md={8}>{t('address', 'Address')}</Grid><F>{t('taxId', `${vals.taxIdLabel || profile.tax.registrationLabel} (sample)`)}</F>
              <F>{t('currency', 'Base currency')}</F><F>{t('timezone', 'Timezone')}</F><F>{t('contactEmail', 'Contact email', { type: 'email' })}</F><F>{t('contactPhone', 'Contact phone')}</F>
            </Grid>
          )}
          {section === 'operations' && (
            <Grid container spacing={2}>
              <F>{t('anchorageAlertHrs', 'Anchorage wait alert (hours)', { type: 'number' })}</F>
              <F>{t('certExpiringDays', 'Certificate expiring window (days)', { type: 'number' })}</F>
              <F>{t('berthWindowSlackHrs', 'Berth window slack (hours)', { type: 'number' })}</F>
            </Grid>
          )}
          {section === 'billing' && (
            <Grid container spacing={2}>
              <F>{t('taxName', 'Tax name')}</F><F>{t('taxRate', `${vals.taxName || profile.tax.name} rate (%) — applied to every NEW invoice`, { type: 'number' })}</F><F>{t('taxRegistrationLabel', 'Tax registration label')}</F>
              <F>{t('placeOfSupply', 'Place of supply')}</F><F>{t('serviceCode', 'Service code (port services)')}</F><F>{t('invoicePrefix', 'Invoice prefix')}</F>
              <F>{t('paymentTermsDays', 'Payment terms (days)', { type: 'number' })}</F><F>{t('currency', 'Invoice currency')}</F>
            </Grid>
          )}
          {section === 'notifications' && (
            <Grid container spacing={2}>
              <Grid item xs={12} md={6}>{sw('emailEnabled', 'Email notifications enabled')}</Grid><Grid item xs={12} md={6}>{sw('smsEnabled', 'SMS notifications enabled')}</Grid>
              <F>{t('digestHour', 'Daily digest hour (24h, local time)', { type: 'number' })}</F><F>{t('escalationHours', 'Escalate unread critical alerts after (hours)', { type: 'number' })}</F>
            </Grid>
          )}
          {section === 'smtp' && (
            <Grid container spacing={2}>
              <F>{t('host', 'SMTP host', { placeholder: 'smtp.example.ae' })}</F><F>{t('port', 'Port', { type: 'number' })}</F>
              <Grid item xs={12} sm={6} md={4} sx={{ display: 'flex', alignItems: 'center' }}>{sw('secure', 'TLS / STARTTLS')}</Grid>
              <F>{t('user', 'Username')}</F><F>{t('password', 'Password', { type: 'password', helperText: 'Stored masked — retype to change' })}</F><F>{t('from', 'From (name and address)')}</F>
              <Grid item xs={12}>
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <Button variant="outlined" startIcon={<MarkEmailReadRoundedIcon />} onClick={testSmtp} disabled={busy || !canManage}>Test connection</Button>
                  <Typography variant="caption" color="text.secondary">Digest and alert mails (certificates, incidents, overdue invoices) go out through this profile.</Typography>
                </Stack>
                {smtpResult && <Alert sx={{ mt: 1.5 }} severity={smtpResult.ok ? 'success' : 'error'}>{smtpResult.text}</Alert>}
              </Grid>
            </Grid>
          )}
          {section === 'ai' && (
            <Grid container spacing={2}>
              <Grid item xs={12}>{sw('enabled', 'AI assistant enabled for permitted roles')}</Grid>
              <F><TextField select fullWidth size="small" label="Model" value={vals.model ?? 'assistant-default'} onChange={set('model')} disabled={!canManage}>{AI_MODELS.map((m) => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}</TextField></F>
              <F>{t('provider', 'Provider (in-country hosting)')}</F>
              <F>{t('apiKey', 'Provider API key', { type: 'password', helperText: 'Stored masked — retype to change. Falls back to the server environment key.' })}</F>
              <F>{t('temperature', 'Temperature', { type: 'number', inputProps: { step: 0.1, min: 0, max: 1 } })}</F><F>{t('dailyTokenBudget', 'Daily token budget', { type: 'number' })}</F>
              <Grid item xs={12}>{sw('groundedOnly', 'Grounded-only mode (skip the language-model polish; the deterministic engine answers directly)')}</Grid>
              <Grid item xs={12}><Chip size="small" variant="outlined" icon={<AutoAwesomeRoundedIcon sx={{ fontSize: 14 }} />} label="Answers are always grounded in live platform records; the model only phrases them. Changes apply to the next question — no restart." sx={{ fontSize: 11, py: 1.5 }} /></Grid>
            </Grid>
          )}
          {section === 'riskWeights' && (
            <Grid container spacing={2}>
              {['age', 'certificates', 'deficiencies', 'detentions', 'inspectionGap', 'agentPerformance'].map((k) => <F key={k}>{t(k, `${k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())} (max points)`, { type: 'number' })}</F>)}
              <Grid item xs={12}><Divider /></Grid>
              <Grid item xs={12}><Typography variant="caption" color="text.secondary">The explainable risk engine caps each factor's contribution at these values; the sum is the 0–100 scale used for boarding targets.</Typography></Grid>
            </Grid>
          )}
        </Box>
      </Card>
    </>
  );
}
