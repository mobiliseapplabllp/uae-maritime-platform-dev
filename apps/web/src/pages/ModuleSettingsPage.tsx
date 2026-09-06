import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, Grid, Box, Typography, Skeleton, Button, TextField, MenuItem, Switch, FormControlLabel, Chip, Stack, Autocomplete } from '@mui/material';
import SaveRoundedIcon from '@mui/icons-material/SaveRounded';
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import SettingsSuggestRoundedIcon from '@mui/icons-material/SettingsSuggestRounded';
import api from '../api/client';
import { useAppDispatch, useUser } from '../store';
import { notify } from '../store/uiSlice';
import { hasPerm } from '../utils/perms';
import PageHeader from '../components/common/PageHeader';
import { MODULES } from '../modules';
import { StatePage } from '../components/common/StatePage';
import { useProfile } from '../config/runtime';
import { MODULE_CARDS } from './admin/settings/catalogue';

/* Every module carries its own settings page; values loop straight back into that module's behaviour. */
interface F { k: string; label: string; type?: 'number' | 'switch' | 'select' | 'text' | 'multiselect'; help?: string; options?: string[]; /** Options drawn from the permission catalogue rather than an inline list. */ optionsFrom?: 'permissions'; cols?: number }
const FIELDS: Record<string, F[]> = {
  ops: [
    { k: 'vcnPrefix', label: 'VCN prefix', help: 'Applied to every NEW vessel call number' },
    { k: 'anchorageAlertHrs', label: 'Anchorage wait alert (hours)', type: 'number', help: 'Waiting beyond this raises an operations flag' },
    { k: 'defaultTugsUnder250m', label: 'Default tugs — LOA < 250 m', type: 'number' }, { k: 'defaultTugsOver250m', label: 'Default tugs — LOA ≥ 250 m', type: 'number' },
    { k: 'berthWindowSlackHrs', label: 'Berth window slack (hours)', type: 'number', help: 'A berthing is refused when another call is within this margin of it' },
    { k: 'scheduleWindowDays', label: 'Schedule window (days)', type: 'number', help: 'Default span of the vessel schedule board' },
    { k: 'channelSpeedLimitKn', label: 'Channel speed limit (kn)', type: 'number', help: 'A fix over this in the approach channel raises a speed alert' },
    { k: 'aisGapAlertMin', label: 'AIS gap alert (minutes)', type: 'number', help: 'A target silent for longer is raised by the five-minute sweep' }, { k: 'anchorDriftNm', label: 'Anchor drift threshold (NM)', type: 'number', help: 'Measured from where she anchored' },
    { k: 'zoneEntryWatch', label: 'Alert on zone entry and exit', type: 'switch', help: 'Crossings of the published sea areas that ask to be told' },
  ],
  ships: [{ k: 'certExpiringDays', label: 'Certificate expiring window (days)', type: 'number', help: 'Drives EXPIRING status across certificates, stats and reports' }, { k: 'dryDockReminderDays', label: 'Dry-dock reminder (days ahead)', type: 'number' }, { k: 'riskRefreshMinutes', label: 'Risk score refresh (minutes)', type: 'number' }],
  crew: [{ k: 'medicalExpiringDays', label: 'Medical expiring window (days)', type: 'number', help: 'Drives the EXPIRING medical status and the crew dashboard' }, { k: 'signOnMarginDays', label: 'Sign-on margin (days)', type: 'number', help: 'A document expiring inside this margin of sign-on is queried' }, { k: 'cocVerifyOnSignOn', label: 'Verify CoC on sign-on', type: 'switch' }],
  legis: [{ k: 'ackRequiredDefault', label: 'New notices require acknowledgment by default', type: 'switch' }, { k: 'ackReminderDays', label: 'Acknowledgment reminder (days)', type: 'number' }, { k: 'showSupersededDays', label: 'Show superseded instruments for (days)', type: 'number' }],
  incidents: [
    { k: 'mttaTargetMin', label: 'Acknowledge target — MTTA (minutes)', type: 'number', help: 'Shown against actuals on the incident dashboard' },
    { k: 'mttrTargetHrs', label: 'Resolve target — MTTR (hours)', type: 'number', help: 'Shown against actuals on the incident dashboard' },
    { k: 'autoNotifySeverity', label: 'Auto-notify from severity', type: 'select', options: ['MEDIUM', 'HIGH', 'CRITICAL'] },
    { k: 'reopenWindowDays', label: 'Reopen window (days)', type: 'number' }, { k: 'injuryReportHrs', label: 'Injury report deadline (hours)', type: 'number' },
  ],
  inspect: [
    { k: 'findingDueDays', label: 'Finding rectification default (days)', type: 'number' }, { k: 'detentionThreshold', label: 'Detainable findings for detention', type: 'number' }, { k: 'passScorePct', label: 'Checklist pass score (%)', type: 'number' },
    // the Smart Inspection programme and its six KPI targets — measured from the survey desk's events, graded against these
    { k: 'kpiProgrammeStart', label: 'Programme start date (YYYY-MM-DD)', help: 'Empty means the day of the first instrumented survey' }, { k: 'kpiProgrammeMonths', label: 'Programme length (months)', type: 'number' },
    { k: 'kpiDossierTargetPct', label: 'Dossier before boarding — target (%)', type: 'number' }, { k: 'kpiAiReportTargetPct', label: 'Reports first drafted by AI — target (%)', type: 'number' },
    { k: 'kpiNoticeTargetPct', label: 'Notices AI-drafted in time — target (%)', type: 'number' }, { k: 'kpiNoticeMinutes', label: 'Notice window after closing (minutes)', type: 'number' },
    { k: 'kpiPredictionTargetPct', label: 'Prediction correlation — target (%)', type: 'number' }, { k: 'kpiPredictionWindowMonths', label: 'Prediction window (months)', type: 'number' },
    { k: 'kpiReportReductionTargetPct', label: 'Report time reduction — target (%)', type: 'number' }, { k: 'kpiReportBaselineMinutes', label: 'Report turnaround baseline (minutes)', type: 'number', help: '0 measures the baseline from manual reports on the platform' },
    { k: 'kpiRestrictionTargetPct', label: 'Restrictions routed in time — target (%)', type: 'number' }, { k: 'kpiRestrictionMinutes', label: 'Restriction routing window (minutes)', type: 'number' },
  ],
  facil: [{ k: 'auditIntervalMonths', label: 'Audit interval (months)', type: 'number', help: 'Sets the audit-due date on every company and facility' }, { k: 'renewalReminderDays', label: 'Renewal reminder (days ahead)', type: 'number', help: 'The renewal window on accreditations and licences' }],
  finance: [{ k: 'invoicePrefix', label: 'Invoice number prefix', help: 'Applied to every NEW invoice' }, { k: 'paymentTermsDays', label: 'Payment terms (days)', type: 'number' }, { k: 'overdueReminderDays', label: 'Overdue reminder cadence (days)', type: 'number' }, { k: 'roundTotalsToWholeUnit', label: 'Round totals to the whole currency unit', type: 'switch' }],
  mis: [{ k: 'defaultPeriodMonths', label: 'Default report period (months)', type: 'number' }, { k: 'exportFooter', label: 'Export footer text', cols: 8 }],
  masters: [{ k: 'allowHardDelete', label: 'Allow hard delete of master entries', type: 'switch' }],
  agents: [{ k: 'escalationHours', label: 'Chase an unreviewed decision after (hours)', type: 'number', help: 'The hourly sweep publishes it as overdue, once' }, { k: 'suspensionNoticeHours', label: 'Suspension notice after (hours)', type: 'number', help: 'The desk is reminded of an agent still suspended' }],
  // Users & security: read by the identity service at the moment each one matters, never captured at boot
  admin: [
    { k: 'accessTokenMinutes', label: 'Access token lifetime (minutes)', type: 'number', help: 'Short-lived; refreshed silently while the person is active' },
    { k: 'refreshTokenHours', label: 'Session lifetime (hours)', type: 'number', help: 'The longest a session lasts, active or not' },
    { k: 'idleTimeoutMinutes', label: 'Idle timeout (minutes)', type: 'number', help: 'Signed out after this long without activity' },
    { k: 'passwordMinLength', label: 'Password minimum length', type: 'number', help: 'The platform floor is 12; this can only raise it' },
    { k: 'mfaRequiredFrom', label: 'Two-step verification required from (YYYY-MM-DD)', help: 'Empty encourages enrolment; a date enforces it for roles that require it' },
    { k: 'mfaGraceDays', label: 'Enrolment grace (days)', type: 'number', help: 'Days a person may keep signing in before enrolment is demanded' },
    { k: 'dormantAfterDays', label: 'Dormant after (days without sign-in)', type: 'number' },
    { k: 'dormantAction', label: 'Dormant accounts are', type: 'select', options: ['FLAG', 'DEACTIVATE'], help: 'Flagged for the next review, or deactivated by the daily sweep' },
    { k: 'accessReviewDays', label: 'Access review cadence (days)', type: 'number' },
    { k: 'auditRetentionDays', label: 'Audit log retention (days)', type: 'number' },
    { k: 'fourEyesPermissions', label: 'Privileged permissions (four-eyes)', type: 'multiselect', optionsFrom: 'permissions', cols: 12, help: 'Granting a role that holds any of these, or editing such a role, waits for a second administrator' },
  ],
};

export default function ModuleSettingsPage() {
  const { moduleKey = '' } = useParams();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const profile = useProfile();
  const canManage = hasPerm(user, 'settings.manage');
  const mod = MODULES.find((m) => m.key === moduleKey);
  const fields = FIELDS[moduleKey];
  const card = MODULE_CARDS.find((m) => m.key === moduleKey);
  const [vals, setVals] = useState<Record<string, any> | null>(null);
  const [defaults, setDefaults] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [permOptions, setPermOptions] = useState<string[]>([]);
  useEffect(() => {
    if (!fields?.some((f) => f.optionsFrom === 'permissions')) return;
    api.get<{ permissionGroups: { module: string; actions: string[] }[] }>('/meta', { headers: { 'X-Quiet': '1' } }).then((m) => setPermOptions(['*', ...m.data.permissionGroups.flatMap((g) => g.actions.map((a) => `${g.module}.${a}`))])).catch(() => {});
  }, [fields]);

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
        actions={(
          <Stack direction="row" spacing={1}>
            <Button startIcon={<ArrowBackRoundedIcon />} onClick={() => navigate('/admin/settings')}>All settings</Button>
            {canManage && <Button startIcon={<RestartAltRoundedIcon />} onClick={() => setVals({ ...defaults })} disabled={busy}>Reset to defaults</Button>}
            {canManage && <Button variant="contained" startIcon={<SaveRoundedIcon />} onClick={save} disabled={busy}>Save settings</Button>}
          </Stack>
        )} />
      <Card sx={{ p: 2.5 }}>
        <Grid container spacing={2}>
          {fields.map((f) => (
            <Grid item xs={12} sm={6} md={f.cols || 4} key={f.k} sx={f.type === 'switch' ? { display: 'flex', alignItems: 'center' } : undefined}>
              {f.type === 'switch' ? (
                <FormControlLabel control={<Switch checked={!!vals[f.k]} disabled={!canManage} onChange={(e) => setField(f.k, e.target.checked)} />} label={f.label} />
              ) : f.type === 'multiselect' ? (
                <Autocomplete multiple size="small" disabled={!canManage} options={f.optionsFrom === 'permissions' ? permOptions : (f.options ?? [])} value={Array.isArray(vals[f.k]) ? (vals[f.k] as string[]) : []}
                  onChange={(_, v) => setField(f.k, v)} renderInput={(params) => <TextField {...params} label={f.label} helperText={f.help} />} />
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
      {card && (
        <Card sx={{ p: 2, mt: 2 }} data-testid="module-settings-used-by">
          <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Where this is used</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{card.blurb}</Typography>
          <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.25 }}>{card.readBy.map((r) => <Typography component="li" variant="body2" key={r}>{r}</Typography>)}</Stack>
        </Card>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
        A saved value is read by the module's service on its next request; the {profile.tax.name} head itself is a platform setting under Billing & tax.
      </Typography>
    </>
  );
}
