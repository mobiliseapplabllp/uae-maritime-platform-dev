import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box, Card, Chip, Divider, MenuItem, Skeleton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import PendingActionsRoundedIcon from '@mui/icons-material/PendingActionsRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import PageStats from '../../components/common/PageStats';
import ExportMenu from '../../components/common/ExportMenu';
import { fmtDT, fromNow } from '../../utils/format';
import { MONO } from '../../theme';
import type { StatCardData } from '../../types';
import DecisionDrawer from './DecisionDrawer';
import { EFFECTS, EFFECT_META, ESCALATION_CODES, ESCALATION_META, confText, dispositionMeta, escalationMeta, escalationText } from './constants';
import type { AgentRow, AiDecision, EscalationMeta } from './types';

/* The escalation queue.
 *
 * Everything the autonomy ladder refused to let an agent do on its own and nobody has closed yet, oldest first,
 * grouped by the rule that refused it. The point of a queue is that nothing sits in it unseen, so the age of the
 * oldest item is on the header and each group says, in words, why its decisions are here. */

type Filters = { agentId: string; escalationCode: string; effect: string };
const EMPTY: Filters = { agentId: '', escalationCode: '', effect: '' };

export default function EscalationQueue() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [rows, setRows] = useState<AiDecision[] | null>(null);
  const [meta, setMeta] = useState<EscalationMeta | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { api.get<AgentRow[]>('/agents').then((r) => setAgents(r.data)).catch(() => {}); }, []);

  const query = useCallback(() => ({ page, limit, sort: 'at', ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '')) }), [page, limit, filters]);
  const load = useCallback(() => api.get<AiDecision[]>('/agents/decisions/escalations', { params: query() })
    .then((r) => { setRows(r.data); setMeta((r.meta as unknown as EscalationMeta) ?? null); })
    .catch((e: Error) => { dispatch(notify({ message: e.message, severity: 'error' })); setRows([]); }), [query, dispatch]);
  useEffect(() => { load(); }, [load]);

  const cards: StatCardData[] = meta ? [
    { label: t('agents.qWaiting'), value: meta.total, sub: t('agents.qWaitingSub'), tone: meta.total ? 'warning' : 'success' },
    { label: t('agents.qOldest'), value: meta.oldest ? fromNow(meta.oldest) : '—', sub: meta.oldest ? fmtDT(meta.oldest) : t('agents.qClear'), tone: meta.total ? 'warning' : 'success' },
    { label: t('agents.qCauses'), value: (meta.byCode || []).length, sub: t('agents.qCausesSub') },
    { label: t('agents.qAgents'), value: (meta.byAgent || []).length, sub: t('agents.qAgentsSub') },
  ] : [];

  // The page is already ordered oldest first; grouping preserves that order inside each cause.
  const groups = (rows || []).reduce<{ code: string; items: AiDecision[] }[]>((acc, d) => {
    const code = d.escalationCode || 'NONE';
    const g = acc.find((x) => x.code === code);
    if (g) g.items.push(d); else acc.push({ code, items: [d] });
    return acc;
  }, []);

  const select = (name: keyof Filters, label: string, options: { value: string; label: string }[], width = 190) => (
    <TextField key={name} select size="small" label={label} value={filters[name]} sx={{ width }}
      onChange={(e) => { setFilters((f) => ({ ...f, [name]: e.target.value })); setPage(1); }}>
      <MenuItem value="">{t('agents.filterAny')}</MenuItem>
      {options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
    </TextField>
  );

  return (
    <>
      <PageHeader icon={PendingActionsRoundedIcon} iconColor="#B98A2F" title={t('agents.queueTitle')} sub={t('agents.queueSub')}
        actions={<ExportMenu name="ai-escalation-queue" title={t('agents.queueTitle')}
          getRows={async () => (await api.get<AiDecision[]>('/agents/decisions/escalations', { params: { ...query(), page: 1, limit: 500 } })).data}
          columns={[
            { label: 'Waiting since', value: (r: AiDecision) => fmtDT(r.at) }, { key: 'agentName', label: 'Agent' }, { key: 'action', label: 'Decision' },
            { key: 'subjectLabel', label: 'Subject' }, { key: 'confidence', label: 'Confidence', align: 'right' },
            { label: 'Why it is here', value: (r: AiDecision) => escalationMeta(r.escalationCode).label },
            { key: 'escalationReason', label: 'Escalation reason' }, { key: 'explanation', label: 'Explanation' },
          ]} />} />

      {meta ? <PageStats cards={cards} /> : <Skeleton variant="rounded" height={86} sx={{ mb: 2 }} />}

      <Card sx={{ p: 1.75, mb: 2 }}>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
          {select('agentId', t('agents.colAgent'), agents.map((a) => ({ value: a.agentId, label: a.name })))}
          {select('escalationCode', t('agents.colWhy'), ESCALATION_CODES.map((c) => ({ value: c, label: ESCALATION_META[c].label })))}
          {select('effect', t('agents.filterEffect'), EFFECTS.map((e) => ({ value: e, label: EFFECT_META[e].label })), 160)}
          <Box sx={{ flex: 1 }} />
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {(meta?.byCode || []).map((c) => (
              <Tooltip describeChild key={c.code} title={escalationMeta(c.code).blurb}>
                <Chip size="small" color={escalationMeta(c.code).color} variant={filters.escalationCode === c.code ? 'filled' : 'outlined'}
                  label={`${escalationMeta(c.code).label} · ${c.decisions}`} sx={{ height: 22, fontSize: 11 }}
                  onClick={() => { setFilters((f) => ({ ...f, escalationCode: f.escalationCode === c.code ? '' : c.code })); setPage(1); }} />
              </Tooltip>
            ))}
          </Stack>
        </Stack>
      </Card>

      {!rows ? <Skeleton variant="rounded" height={320} /> : rows.length === 0 ? (
        <Card sx={{ p: 6, textAlign: 'center' }}>
          <Typography variant="h6" sx={{ fontSize: 15 }}>{t('agents.queueEmpty')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{t('agents.queueEmptySub')}</Typography>
        </Card>
      ) : (
        <>
          {groups.map((g) => (
            <Card key={g.code} sx={{ mb: 2 }}>
              <Box sx={{ p: 1.75, pb: 1.25, display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                <Chip size="small" color={escalationMeta(g.code).color} label={escalationMeta(g.code).label} sx={{ height: 22, fontSize: 11 }} />
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 200 }}>{escalationMeta(g.code).blurb}</Typography>
                <Typography sx={{ fontFamily: MONO, fontSize: 11, color: 'text.secondary' }}>{t('agents.nWaiting', { count: g.items.length })}</Typography>
              </Box>
              <Divider />
              <TableContainer sx={{ overflowX: 'auto' }}>
                <Table size="small" aria-label={escalationMeta(g.code).label}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ width: 160 }}>{t('agents.colWaiting')}</TableCell>
                      <TableCell>{t('agents.colAgent')}</TableCell>
                      <TableCell>{t('agents.colDecision')}</TableCell>
                      <TableCell>{t('agents.colSubject')}</TableCell>
                      <TableCell align="right">{t('agents.colConfidence')}</TableCell>
                      <TableCell>{t('agents.colOutcome')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {g.items.map((d) => (
                      <TableRow key={d.id} hover sx={{ cursor: 'pointer' }} onClick={() => setOpen(d.id)}>
                        <TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}><span title={fmtDT(d.at)}>{fromNow(d.at)}</span></TableCell>
                        <TableCell>{d.agentName || d.agentId}</TableCell>
                        <TableCell>
                          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{d.action}</Typography>
                          <Typography noWrap sx={{ fontSize: 11.5, color: 'text.secondary', maxWidth: 420 }}>{escalationText(d.escalationCode, d.escalationReason)}</Typography>
                        </TableCell>
                        <TableCell>{d.subjectLabel || d.subjectType || '—'}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{confText(d.confidence)}</TableCell>
                        <TableCell>
                          <Chip size="small" variant="outlined" color={dispositionMeta(d.disposition, true).color} label={dispositionMeta(d.disposition, true).label} sx={{ height: 20, fontSize: 10.5 }} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          ))}
          <TablePagination component="div" count={meta?.total || 0} page={page - 1} rowsPerPage={limit}
            onPageChange={(_, p) => setPage(p + 1)} onRowsPerPageChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }} rowsPerPageOptions={[10, 25, 50]} />
        </>
      )}

      <DecisionDrawer id={open} onClose={() => setOpen(null)} onReviewed={load} />
    </>
  );
}
