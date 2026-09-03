import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box, Card, Chip, Divider, InputAdornment, MenuItem, Skeleton, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import SmartToyRoundedIcon from '@mui/icons-material/SmartToyRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import PageStats from '../../components/common/PageStats';
import ExportMenu from '../../components/common/ExportMenu';
import { chartChrome, MONO } from '../../theme';
import { fmtDT } from '../../utils/format';
import type { StatCardData } from '../../types';
import AgentDetailDrawer, { Metric } from './AgentDetailDrawer';
import { LEVELS, LEVEL_META, confText, pctText, triggerLabel } from './constants';
import type { AgentDashboardData, AgentRow } from './types';

/* The agent console.
 *
 * The governance the authority is owed is not a claim that the platform is careful. It is that an officer can see
 * every agent and what it is allowed to do, change that latitude without calling a vendor, overturn any decision
 * and suspend a misbehaving agent. This page is the first of those; the register behind it is append-only, so
 * nothing here can quietly rewrite history. */

type Filters = { level: string; enabled: string; suspended: string; mandated: string; q: string };
const EMPTY: Filters = { level: '', enabled: '', suspended: '', mandated: '', q: '' };

export default function AgentOperations() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const mode = useAppSelector((s) => s.ui.mode);
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [dash, setDash] = useState<AgentDashboardData | null>(null);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  // Empty filters are left off the query entirely — the service reads an empty string as "no filter" only by accident.
  const params = useCallback(() => Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '')), [filters]);
  const loadRoster = useCallback(() => api.get<AgentRow[]>('/agents', { params: params() })
    .then((r) => setAgents(r.data))
    .catch((e: Error) => { dispatch(notify({ message: e.message, severity: 'error' })); setAgents([]); }), [params, dispatch]);

  const loadDash = useCallback(() => api.get<AgentDashboardData>('/agents/dashboard').then((r) => setDash(r.data)).catch(() => {}), []);
  useEffect(() => { loadDash(); }, [loadDash]);
  useEffect(() => { loadRoster(); }, [loadRoster]);

  const cards: StatCardData[] = dash ? [
    { label: t('agents.statAgents'), value: dash.agents, sub: t('agents.statAgentsSub', { active: dash.active, suspended: dash.suspended }), tone: dash.suspended ? 'warning' : 'default' },
    { label: t('agents.statDecisions'), value: dash.decisions.toLocaleString(), sub: t('agents.statDecisionsSub', { n: dash.decisions30d }) },
    { label: t('agents.statAuto'), value: `${dash.autoAppliedPct}%`, sub: t('agents.statAutoSub') },
    { label: t('agents.statPending'), value: dash.pendingReview, sub: t('agents.statPendingSub'), tone: dash.pendingReview ? 'warning' : 'success' },
    { label: t('agents.statAgreement'), value: pctText(dash.agreementRate, 0), sub: t('agents.statAgreementSub'), tone: 'success' },
    { label: t('agents.statConfidence'), value: confText(dash.avgConfidence), sub: t('agents.statConfidenceSub') },
    ...dash.byLevel.map((l) => ({ label: LEVEL_META[l.level]?.label ?? l.level, value: l.count, sub: t('agents.atLevel') })),
  ] : [];

  const filterField = (name: keyof Filters, label: string, options: { value: string; label: string }[]) => (
    <TextField key={name} select size="small" label={label} value={filters[name]} sx={{ width: 155 }}
      onChange={(e) => setFilters((f) => ({ ...f, [name]: e.target.value }))}>
      <MenuItem value="">{t('agents.filterAny')}</MenuItem>
      {options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
    </TextField>
  );

  return (
    <>
      <PageHeader icon={SmartToyRoundedIcon} iconColor="#75479C" title={t('agents.opsTitle')} sub={t('agents.opsSub')}
        actions={<ExportMenu name="agent-register" title={t('agents.registerTitle')} getRows={async () => (await api.get<AgentRow[]>('/agents', { params: params() })).data}
          columns={[
            { key: 'agentId', label: 'Agent ID' }, { key: 'name', label: 'Name' }, { key: 'role', label: 'Role' },
            { label: 'Autonomy', value: (r: AgentRow) => LEVEL_META[r.autonomyLevel]?.label ?? r.autonomyLevel },
            { key: 'confidenceThreshold', label: 'Threshold', align: 'right' },
            { label: 'Confirmation required', value: (r: AgentRow) => (r.requiresConfirmation ? 'Yes' : 'No') },
            { key: 'maxActionsPerHour', label: 'Max actions / hour', align: 'right' },
            { label: 'Enabled', value: (r: AgentRow) => (r.enabled ? 'Yes' : 'No') },
            { label: 'Suspended', value: (r: AgentRow) => (r.suspended ? `Yes — ${r.suspendedReason || ''}` : 'No') },
            { label: 'Trigger', value: (r: AgentRow) => triggerLabel(r.trigger?.kind, r.trigger?.cadence) },
            { label: 'Decisions', value: (r: AgentRow) => r.stats?.decisions ?? 0, align: 'right' },
            { label: 'Escalated', value: (r: AgentRow) => r.stats?.escalated ?? 0, align: 'right' },
            { label: 'Overturned', value: (r: AgentRow) => r.stats?.overridden ?? 0, align: 'right' },
            { label: 'Agreement %', value: (r: AgentRow) => (r.agreementRate == null ? '' : r.agreementRate), align: 'right' },
            { label: 'Last ran', value: (r: AgentRow) => (r.lastRunAt ? fmtDT(r.lastRunAt) : '') },
          ]} />} />

      {dash ? <PageStats cards={cards} /> : <Skeleton variant="rounded" height={86} sx={{ mb: 2 }} />}

      <Card sx={{ p: 0, mb: 2 }}>
        <Box sx={{ p: 1.75, pb: 1.25 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{t('agents.registerTitle')}</Typography>
          <Typography variant="caption" color="text.secondary">{t('agents.registerSub')}</Typography>
        </Box>
        <Box sx={{ px: 1.75, pb: 1.5, display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField size="small" value={q} placeholder={t('agents.searchPlaceholder')} inputProps={{ 'aria-label': t('agents.searchPlaceholder') }}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setFilters((f) => ({ ...f, q })); }}
            onBlur={() => setFilters((f) => (f.q === q ? f : { ...f, q }))} sx={{ width: 240 }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchRoundedIcon fontSize="small" /></InputAdornment> }} />
          {filterField('level', t('agents.filterLevel'), LEVELS.map((l) => ({ value: l, label: LEVEL_META[l].label })))}
          {filterField('enabled', t('agents.filterEnabled'), [{ value: 'true', label: t('agents.enabled') }, { value: 'false', label: t('agents.disabled') }])}
          {filterField('suspended', t('agents.filterSuspended'), [{ value: 'true', label: t('agents.suspendedOnly') }, { value: 'false', label: t('agents.notSuspended') }])}
          {filterField('mandated', t('agents.filterMandated'), [{ value: 'true', label: t('agents.mandated') }, { value: 'false', label: t('agents.workforce') }])}
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">{t('agents.nAgents', { count: agents?.length ?? 0 })}</Typography>
        </Box>
        <Divider />
        {!agents ? (
          <Box sx={{ p: 1.75 }} aria-busy="true"><Skeleton variant="rounded" height={320} /></Box>
        ) : agents.length === 0 ? (
          <Typography sx={{ py: 6, textAlign: 'center' }} color="text.secondary">{t('agents.noAgents')}</Typography>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2,1fr)', xl: 'repeat(3,1fr)' }, gap: 1.5, p: 1.75 }}>
            {agents.map((a) => {
              const meta = LEVEL_META[a.autonomyLevel] || { label: a.autonomyLevel, color: 'default' as const, blurb: '' };
              return (
                <Card key={a.agentId} variant="outlined" role="button" tabIndex={0} aria-label={t('agents.openAgent', { name: a.name })}
                  onClick={() => setOpen(a.agentId)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(a.agentId); } }}
                  sx={{ p: 1.5, cursor: 'pointer', transition: 'all .15s', borderColor: a.suspended ? 'error.main' : 'divider',
                    '&:hover': { borderColor: 'primary.main', transform: 'translateY(-2px)', boxShadow: 3 } }}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                    <Typography sx={{ fontWeight: 700, fontSize: 13.5, flex: 1 }} noWrap>{a.name}</Typography>
                    {a.suspended
                      ? <Chip size="small" color="error" label={t('agents.suspendedChip')} sx={{ height: 20, fontSize: 10.5 }} />
                      : <Tooltip describeChild title={meta.blurb}><Chip size="small" color={meta.color} label={meta.label} sx={{ height: 20, fontSize: 10.5 }} /></Tooltip>}
                  </Stack>
                  <Typography sx={{ fontSize: 11.5, color: 'text.secondary', minHeight: 32 }}>{a.role || '—'}</Typography>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                    {a.mandated && <Chip size="small" variant="outlined" color="primary" label={t('agents.mandated')} sx={{ height: 18, fontSize: 9.5 }} />}
                    <Chip size="small" variant="outlined" label={triggerLabel(a.trigger?.kind, a.trigger?.cadence)} sx={{ height: 18, fontSize: 9.5 }} />
                    {a.requiresConfirmation && <Chip size="small" variant="outlined" label={t('agents.confirms')} sx={{ height: 18, fontSize: 9.5 }} />}
                    {!a.enabled && <Chip size="small" variant="outlined" color="warning" label={t('agents.disabled')} sx={{ height: 18, fontSize: 9.5 }} />}
                  </Stack>
                  <Divider sx={{ my: 1 }} />
                  <Stack direction="row" spacing={2}>
                    <Metric k={t('agents.mDecisions')} v={a.stats?.decisions ?? 0} />
                    <Metric k={t('agents.mEscalated')} v={a.stats?.escalated ?? 0} />
                    <Metric k={t('agents.mOverturned')} v={a.stats?.overridden ?? 0} />
                    <Metric k={t('agents.mAgreement')} v={pctText(a.agreementRate, 0)} />
                  </Stack>
                  <Typography sx={{ mt: 1, fontSize: 10.5, color: 'text.secondary', fontFamily: MONO }}>
                    {t('agents.cardFoot', { threshold: confText(a.confidenceThreshold), max: a.maxActionsPerHour })}
                    {a.escalateTo ? t('agents.cardEscalates', { to: a.escalateTo }) : ''}
                  </Typography>
                  <Typography sx={{ fontSize: 10.5, color: 'text.secondary', fontFamily: MONO }}>
                    {a.lastRunAt ? t('agents.lastRan', { at: fmtDT(a.lastRunAt) }) : t('agents.neverRun')}
                  </Typography>
                </Card>
              );
            })}
          </Box>
        )}
      </Card>

      {dash && dash.perAgent.length > 0 && (
        <Card sx={{ p: 2 }}>
          <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('agents.performance')}</Typography>
          <Typography variant="caption" color="text.secondary">{t('agents.performanceSub')}</Typography>
          <ResponsiveContainer width="100%" height={Math.max(240, dash.perAgent.length * 28)}>
            <BarChart data={dash.perAgent} layout="vertical" margin={{ top: 12, right: 24, left: 24, bottom: 0 }}>
              <CartesianGrid stroke={grid} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} />
              <RTooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="autoApplied" stackId="d" fill="#0797A5" name={t('agents.barApplied')} barSize={14} />
              <Bar dataKey="escalated" stackId="d" fill="#B98A2F" name={t('agents.barEscalated')} barSize={14} />
              <Bar dataKey="awaitingReview" stackId="d" fill="#5A6B78" name={t('agents.barAwaiting')} barSize={14} />
              <Bar dataKey="overridden" stackId="d" fill="#C14F33" name={t('agents.barOverturned')} barSize={14} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      <AgentDetailDrawer agentId={open} onClose={() => setOpen(null)} onChanged={() => { loadRoster(); loadDash(); }} />
    </>
  );
}
