import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Card, Grid, Box, Typography, Skeleton, Button, TextField, MenuItem, Switch, FormControlLabel, Chip, Stack } from '@mui/material';
import SaveRoundedIcon from '@mui/icons-material/SaveRounded';
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded';
import SettingsSuggestRoundedIcon from '@mui/icons-material/SettingsSuggestRounded';
import api from '../api/client';
import { useAppDispatch, useUser } from '../store';
import { notify } from '../store/uiSlice';
import { hasPerm } from '../utils/perms';
import PageHeader from '../components/common/PageHeader';
import { MODULES } from '../modules';
import { StatePage } from '../components/common/StatePage';
import { useProfile } from '../config/runtime';

/* Every module carries its own settings page; values loop straight back into that module's behaviour. */
interface F { k: string; label: string; type?: 'number' | 'switch' | 'select' | 'text'; help?: string; options?: string[]; cols?: number }
const FIELDS: Record<string, F[]> = {
  ops: [
    { k: 'vcnPrefix', label: 'VCN prefix', help: 'Applied to every NEW vessel call number' },
    { k: 'anchorageAlertHrs', label: 'Anchorage wait alert (hours)', type: 'number', help: 'Waiting beyond this raises an operations flag' },
    { k: 'defaultTugsUnder250m', label: 'Default tugs — LOA < 250 m', type: 'number' }, { k: 'defaultTugsOver250m', label: 'Default tugs — LOA ≥ 250 m', type: 'number' },
    { k: 'scheduleWindowDays', label: 'Schedule window (days)', type: 'number', help: 'Default span of the vessel schedule board' },
    { k: 'channelSpeedLimitKn', label: 'Channel speed limit (kn)', type: 'number', help: 'Referenced by surveillance speed alerts' },
    { k: 'aisGapAlertMin', label: 'AIS gap alert (minutes)', type: 'number' }, { k: 'anchorDriftNm', label: 'Anchor drift threshold (NM)', type: 'number' },
    { k: 'zoneEntryWatch', label: 'Alert on unannounced zone entry', type: 'switch' },
  ],
  ships: [{ k: 'certExpiringDays', label: 'Certificate expiring window (days)', type: 'number', help: 'Drives EXPIRING status across certificates, stats and reports' }, { k: 'dryDockReminderDays', label: 'Dry-dock reminder (days ahead)', type: 'number' }, { k: 'riskRefreshMinutes', label: 'Risk score refresh (minutes)', type: 'number' }],
  crew: [{ k: 'medicalExpiringDays', label: 'Medical expiring window (days)', type: 'number' }, { k: 'minRestHours', label: 'Minimum rest hours (24 h)', type: 'number' }, { k: 'cocVerifyOnSignOn', label: 'Verify CoC on sign-on', type: 'switch' }],
  legis: [{ k: 'ackRequiredDefault', label: 'New notices require acknowledgment by default', type: 'switch' }, { k: 'ackReminderDays', label: 'Acknowledgment reminder (days)', type: 'number' }, { k: 'showSupersededDays', label: 'Show superseded instruments for (days)', type: 'number' }],
  incidents: [
    { k: 'mttaTargetMin', label: 'Acknowledge target — MTTA (minutes)', type: 'number', help: 'Shown against actuals on the incident dashboard' },
    { k: 'mttrTargetHrs', label: 'Resolve target — MTTR (hours)', type: 'number', help: 'Shown against actuals on the incident dashboard' },
    { k: 'autoNotifySeverity', label: 'Auto-notify from severity', type: 'select', options: ['MEDIUM', 'HIGH', 'CRITICAL'] },
    { k: 'reopenWindowDays', label: 'Reopen window (days)', type: 'number' }, { k: 'injuryReportHrs', label: 'Injury report deadline (hours)', type: 'number' },
  ],
  inspect: [{ k: 'findingDueDays', label: 'Finding rectification default (days)', type: 'number' }, { k: 'detentionThreshold', label: 'Detainable findings for detention', type: 'number' }, { k: 'passScorePct', label: 'Checklist pass score (%)', type: 'number' }, { k: 'requireEvidencePhotos', label: 'Evidence photos mandatory on findings', type: 'switch' }],
  facil: [{ k: 'licenceValidityYears', label: 'Licence validity (years)', type: 'number' }, { k: 'auditIntervalMonths', label: 'Audit interval (months)', type: 'number' }, { k: 'renewalReminderDays', label: 'Renewal reminder (days ahead)', type: 'number' }],
  finance: [{ k: 'invoicePrefix', label: 'Invoice number prefix', help: 'Applied to every NEW invoice' }, { k: 'paymentTermsDays', label: 'Payment terms (days)', type: 'number' }, { k: 'overdueReminderDays', label: 'Overdue reminder cadence (days)', type: 'number' }, { k: 'roundTotalsToWholeUnit', label: 'Round totals to the whole currency unit', type: 'switch' }],
  mis: [{ k: 'defaultPeriodMonths', label: 'Default report period (months)', type: 'number' }, { k: 'exportFooter', label: 'Export footer text', cols: 8 }],
  masters: [{ k: 'allowHardDelete', label: 'Allow hard delete of master entries', type: 'switch' }],
  agents: [{ k: 'defaultAutonomy', label: 'Default autonomy level', type: 'select', options: ['ASSIST', 'SUPERVISED', 'AUTONOMOUS'] }, { k: 'escalationHours', label: 'Escalate unreviewed decisions after (hours)', type: 'number' }, { k: 'suspensionNoticeHours', label: 'Suspension notice (hours)', type: 'number' }],
  admin: [{ k: 'sessionTimeoutMin', label: 'Session timeout (minutes)', type: 'number' }, { k: 'passwordMinLength', label: 'Password minimum length', type: 'number' }, { k: 'auditRetentionDays', label: 'Audit log retention (days)', type: 'number' }, { k: 'mfaRequiredForStaff', label: 'Multi-factor authentication required for staff', type: 'switch' }],
};

export default function ModuleSettingsPage() {
  const { moduleKey = '' } = useParams();
  const dispatch = useAppDispatch();
  const user = useUser();
  const profile = useProfile();
  const canManage = hasPerm(user, 'settings.manage');
  const mod = MODULES.find((m) => m.key === moduleKey);
  const fields = FIELDS[moduleKey];
  const [vals, setVals] = useState<Record<string, any> | null>(null);
  const [defaults, setDefaults] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!fields) return;
    setVals(null);
    api.get<{ values: Record<string, unknown>; defaults: Record<string, unknown> }>(`/module-settings/${moduleKey}`).then((r) => { setVals(r.data.values); setDefaults(r.data.defaults || {}); }).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  }, [moduleKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mod || !fields) return <StatePage code="404" title="No settings" message="This module has no configurable settings." />;
  if (!vals) return <Skeleton variant="rounded" height={420} />;
  const save = () => {
    setBusy(true);
    const body = Object.fromEntries(Object.entries(vals).filter(([k]) => k in defaults || fields.some((f) => f.k === k)));
    api.put<{ values: Record<string, unknown> }>(`/module-settings/${moduleKey}`, body)
      .then((r) => { setVals(r.data.values); dispatch(notify(`${mod.name} settings saved — changes apply immediately`)); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))).finally(() => setBusy(false));
  };
  const setField = (k: string, v: unknown) => setVals((x) => ({ ...(x || {}), [k]: v }));

  return (
    <>
      <PageHeader icon={SettingsSuggestRoundedIcon} iconColor={mod.color} title={`${mod.name} — settings`} sub="Module-scoped configuration; every value loops back into this module's behaviour without a restart"
        actions={canManage && (
          <Stack direction="row" spacing={1}>
            <Button startIcon={<RestartAltRoundedIcon />} onClick={() => setVals({ ...defaults })} disabled={busy}>Reset to defaults</Button>
            <Button variant="contained" startIcon={<SaveRoundedIcon />} onClick={save} disabled={busy}>Save settings</Button>
          </Stack>
        )} />
      <Card sx={{ p: 2.5 }}>
        <Grid container spacing={2}>
          {fields.map((f) => (
            <Grid item xs={12} sm={6} md={f.cols || 4} key={f.k} sx={f.type === 'switch' ? { display: 'flex', alignItems: 'center' } : undefined}>
              {f.type === 'switch' ? (
                <FormControlLabel control={<Switch checked={!!vals[f.k]} disabled={!canManage} onChange={(e) => setField(f.k, e.target.checked)} />} label={f.label} />
              ) : f.type === 'select' ? (
                <TextField select fullWidth size="small" label={f.label} value={vals[f.k] ?? ''} disabled={!canManage} helperText={f.help} onChange={(e) => setField(f.k, e.target.value)}>
                  {f.options!.map((o) => <MenuItem key={o} value={o}>{o}</MenuItem>)}
                </TextField>
              ) : (
                <TextField fullWidth size="small" label={f.label} type={f.type || 'text'} value={vals[f.k] ?? ''} disabled={!canManage} helperText={f.help}
                  onChange={(e) => setField(f.k, f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
              )}
            </Grid>
          ))}
        </Grid>
        <Box sx={{ mt: 2 }}><Chip size="small" variant="outlined" label={canManage ? 'Saved values override the platform defaults; Reset restores them.' : 'Read-only — the settings.manage permission is required to change these.'} sx={{ fontSize: 11 }} /></Box>
      </Card>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
        Examples of live hooks: VCN and invoice prefixes stamp new records; the certificate window drives EXPIRING statuses; incident MTTA/MTTR targets appear on the incident dashboard; {profile.tax.name} settings feed every new invoice.
      </Typography>
    </>
  );
}
