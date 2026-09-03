import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Chip, FormControlLabel, MenuItem, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ExportMenu from '../../components/common/ExportMenu';
import { fmtDT, fromNow } from '../../utils/format';
import type { Column } from '../../types';
import DecisionDrawer from './DecisionDrawer';
import { DISPOSITION_SHORT, EFFECTS, EFFECT_META, ESCALATION_CODES, ESCALATION_META, REVIEW_STATUS_META, confText, dispositionMeta, escalationMeta, reviewStatusMeta } from './constants';
import type { AgentRow, AiDecision, Disposition, ReviewStatus } from './types';

/* The decision register.
 *
 * Every conclusion an agent reached, filterable by the things an officer actually asks: which agent, what it
 * decided, whether anyone has looked at it, which record it concerns, why it was escalated and how sure it was.
 * A reviewer's verdict is a row of its own, so the register shows the agents' own conclusions by default and the
 * verdicts on request — a decision is never counted twice. */

interface ListState { rows: AiDecision[]; total: number; page: number; limit: number; q: string; sort: string; loading: boolean }
type Filters = {
  agentId: string; disposition: string; reviewStatus: string; escalationCode: string; effect: string; applied: string;
  entityType: string; action: string; from: string; to: string; minConfidence: string; maxConfidence: string;
  pending: string; includeSuperseding: string;
};
const EMPTY: Filters = {
  agentId: '', disposition: '', reviewStatus: '', escalationCode: '', effect: '', applied: '',
  entityType: '', action: '', from: '', to: '', minConfidence: '', maxConfidence: '', pending: '', includeSuperseding: '',
};

export default function DecisionRegister() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: '-at', loading: true });
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [more, setMore] = useState(false);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { api.get<AgentRow[]>('/agents').then((r) => setAgents(r.data)).catch(() => {}); }, []);

  const query = useCallback(() => ({
    page: state.page, limit: state.limit, sort: state.sort, q: state.q || undefined,
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '')),
  }), [state.page, state.limit, state.sort, state.q, filters]);

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    return api.get<AiDecision[]>('/agents/decisions', { params: query() })
      .then((r) => setState((s) => ({ ...s, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { dispatch(notify({ message: e.message, severity: 'error' })); setState((s) => ({ ...s, loading: false })); });
  }, [query, dispatch]);
  useEffect(() => { load(); }, [load]);

  const set = (patch: Partial<Filters>) => { setFilters((f) => ({ ...f, ...patch })); setState((s) => ({ ...s, page: 1 })); };
  const active = Object.entries(filters).filter(([, v]) => v !== '').length;

  const select = (name: keyof Filters, label: string, options: { value: string; label: string }[], width = 168) => (
    <TextField key={name} select size="small" label={label} value={filters[name]} sx={{ width }} onChange={(e) => set({ [name]: e.target.value } as Partial<Filters>)}>
      <MenuItem value="">{t('agents.filterAny')}</MenuItem>
      {options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
    </TextField>
  );

  const columns: Column<AiDecision>[] = [
    { key: 'at', label: t('agents.colWhen'), mono: true, width: 160, sortable: true, render: (r) => <span title={fmtDT(r.at)}>{fromNow(r.at)}</span> },
    { key: 'agentId', label: t('agents.colAgent'), sortable: true, render: (r) => r.agentName || r.agentId },
    { key: 'action', label: t('agents.colDecision'), sortable: true, render: (r) => <b>{r.action}</b> },
    { key: 'subjectLabel', label: t('agents.colSubject'), render: (r) => r.subjectLabel || r.subjectType || '—' },
    { key: 'confidence', label: t('agents.colConfidence'), align: 'right', mono: true, sortable: true, render: (r) => confText(r.confidence) },
    {
      key: 'disposition', label: t('agents.colOutcome'), sortable: true,
      render: (r) => { const m = dispositionMeta(r.disposition, true); return <Chip size="small" color={m.color} label={m.label} sx={{ height: 20, fontSize: 10.5 }} variant={m.color === 'default' ? 'outlined' : 'filled'} />; },
    },
    {
      key: 'reviewStatus', label: t('agents.colReview'), sortable: true,
      render: (r) => { const m = reviewStatusMeta(r.reviewStatus); return <Chip size="small" variant="outlined" color={m.color} label={m.label} sx={{ height: 20, fontSize: 10.5 }} />; },
    },
    {
      key: 'escalationCode', label: t('agents.colWhy'),
      render: (r) => (r.escalationCode
        ? <Tooltip describeChild title={escalationMeta(r.escalationCode).blurb}><Chip size="small" variant="outlined" color={escalationMeta(r.escalationCode).color} label={escalationMeta(r.escalationCode).label} sx={{ height: 20, fontSize: 10.5 }} /></Tooltip>
        : <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>—</Typography>),
    },
  ];

  return (
    <>
      <PageHeader icon={FactCheckRoundedIcon} iconColor="#0E7C86" title={t('agents.decisionsTitle')} sub={t('agents.decisionsSub')}
        actions={<ExportMenu name="ai-decision-register" title={t('agents.decisionsTitle')}
          getRows={async () => (await api.get<AiDecision[]>('/agents/decisions', { params: { ...query(), page: 1, limit: 500 } })).data}
          columns={[
            { label: 'When', value: (r: AiDecision) => fmtDT(r.at) },
            { key: 'agentName', label: 'Agent' }, { key: 'action', label: 'Decision' },
            { key: 'subjectType', label: 'Subject type' }, { key: 'subjectLabel', label: 'Subject' },
            { key: 'confidence', label: 'Confidence', align: 'right' }, { key: 'threshold', label: 'Threshold', align: 'right' },
            { label: 'Autonomy in force', value: (r: AiDecision) => r.autonomyLevel },
            { label: 'Effect', value: (r: AiDecision) => EFFECT_META[r.effect]?.label ?? r.effect },
            { label: 'Outcome', value: (r: AiDecision) => dispositionMeta(r.disposition, true).label },
            { label: 'Review state', value: (r: AiDecision) => reviewStatusMeta(r.reviewStatus).label },
            { label: 'Why not applied', value: (r: AiDecision) => (r.escalationCode ? escalationMeta(r.escalationCode).label : '') },
            { key: 'escalationReason', label: 'Escalation reason' }, { key: 'explanation', label: 'Explanation' },
            { key: 'reviewedBy', label: 'Reviewed by' }, { key: 'overrideReason', label: 'Reviewer reason' },
          ]} />} />

      <DataTable<AiDecision>
        columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading} sort={state.sort}
        onPage={(page) => setState((s) => ({ ...s, page }))} onLimit={(limit) => setState((s) => ({ ...s, limit, page: 1 }))} onSort={(sort) => setState((s) => ({ ...s, sort }))}
        search={state.q} onSearch={(q) => setState((s) => ({ ...s, q, page: 1 }))} searchPlaceholder={t('agents.decisionSearch')}
        onRowClick={(r) => setOpen(r.id)} emptyMessage={t('agents.noRecords')}
        toolbar={(
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
            {select('agentId', t('agents.colAgent'), agents.map((a) => ({ value: a.agentId, label: a.name })), 200)}
            {select('disposition', t('agents.colOutcome'), (Object.keys(DISPOSITION_SHORT) as Disposition[]).map((k) => ({ value: k, label: DISPOSITION_SHORT[k].label })))}
            {select('reviewStatus', t('agents.colReview'), (Object.keys(REVIEW_STATUS_META) as ReviewStatus[]).map((k) => ({ value: k, label: REVIEW_STATUS_META[k].label })))}
            <Button size="small" variant={more ? 'contained' : 'outlined'} startIcon={<TuneRoundedIcon sx={{ fontSize: 16 }} />} onClick={() => setMore((v) => !v)}>
              {t('agents.moreFilters')}{active ? ` (${active})` : ''}
            </Button>
            {active > 0 && <Button size="small" color="inherit" onClick={() => { setFilters(EMPTY); setState((s) => ({ ...s, page: 1 })); }}>{t('agents.clearFilters')}</Button>}
            {more && (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', width: '100%' }}>
                {select('escalationCode', t('agents.colWhy'), ESCALATION_CODES.map((c) => ({ value: c, label: ESCALATION_META[c].label })), 200)}
                {select('effect', t('agents.filterEffect'), EFFECTS.map((e) => ({ value: e, label: EFFECT_META[e].label })), 150)}
                {select('applied', t('agents.filterApplied'), [{ value: 'true', label: t('agents.appliedYes') }, { value: 'false', label: t('agents.appliedNo') }], 170)}
                <TextField size="small" label={t('agents.filterSubjectType')} sx={{ width: 150 }} value={filters.entityType} onChange={(e) => set({ entityType: e.target.value })} />
                <TextField size="small" label={t('agents.filterAction')} sx={{ width: 170 }} value={filters.action} onChange={(e) => set({ action: e.target.value })} />
                <TextField size="small" type="date" label={t('agents.filterFrom')} InputLabelProps={{ shrink: true }} sx={{ width: 160 }} value={filters.from} onChange={(e) => set({ from: e.target.value })} />
                <TextField size="small" type="date" label={t('agents.filterTo')} InputLabelProps={{ shrink: true }} sx={{ width: 160 }} value={filters.to} onChange={(e) => set({ to: e.target.value })} />
                <TextField size="small" type="number" label={t('agents.filterMinConf')} inputProps={{ min: 0, max: 1, step: 0.05 }} sx={{ width: 140 }} value={filters.minConfidence} onChange={(e) => set({ minConfidence: e.target.value })} />
                <TextField size="small" type="number" label={t('agents.filterMaxConf')} inputProps={{ min: 0, max: 1, step: 0.05 }} sx={{ width: 140 }} value={filters.maxConfidence} onChange={(e) => set({ maxConfidence: e.target.value })} />
                <FormControlLabel sx={{ m: 0 }} control={<Switch size="small" checked={filters.pending === 'true'} onChange={(e) => set({ pending: e.target.checked ? 'true' : '' })} />}
                  label={<Typography sx={{ fontSize: 12.5 }}>{t('agents.filterPending')}</Typography>} />
                <Tooltip describeChild title={t('agents.supersedingHelp')}>
                  <FormControlLabel sx={{ m: 0 }} control={<Switch size="small" checked={filters.includeSuperseding === 'true'} onChange={(e) => set({ includeSuperseding: e.target.checked ? 'true' : '' })} />}
                    label={<Typography sx={{ fontSize: 12.5 }}>{t('agents.filterSuperseding')}</Typography>} />
                </Tooltip>
              </Box>
            )}
          </Stack>
        )} />

      <DecisionDrawer id={open} onClose={() => setOpen(null)} onReviewed={load} />
    </>
  );
}
