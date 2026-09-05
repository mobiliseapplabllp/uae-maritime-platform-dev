import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Autocomplete, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Grid, Link, MenuItem, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import TravelExploreRoundedIcon from '@mui/icons-material/TravelExploreRounded';
import SyncRoundedIcon from '@mui/icons-material/SyncRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import api from '../../api/client';
import { useAppDispatch, useAppSelector, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import PageStats from '../../components/common/PageStats';
import DataTable from '../../components/common/DataTable';
import StatusChip from '../../components/common/StatusChip';
import { useLookups } from '../../hooks/useLookups';
import { fmtD, fmtDT, fromNow } from '../../utils/format';
import { MONO } from '../../theme';
import type { Column, StatCardData } from '../../types';
import { IMO_ITEM_STATUSES, IMO_ITEM_STATUS_META, POLL_STATUS_META, SOURCE_LOOKUP } from './shared';
import type { ImoDashboard, ImoItem, ImoSource, LegalInstrument, PollOutcome } from './types';

/* The IMO watch — what the Organization's committees publish, read from the sources the `imoSource` master
 * names, and where the desk's assessment of each document stands: new, assessed (with a due date), transposed
 * into an instrument on the register, or dismissed. The scheduler reads the sources on their own cadence; the
 * desk can read one now. */
const ENDPOINT = '/legislation/imo';
interface ListState { rows: ImoItem[]; total: number; page: number; limit: number; q: string; sort: string; status: string; source: string; overdue: boolean; loading: boolean }
const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box><Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography><Typography component="div" sx={{ fontSize: 13.5, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography></Box>
);

export default function ImoWatch() {
  const dispatch = useAppDispatch(); const user = useUser(); const { t } = useTranslation();
  const lang = useAppSelector((s) => s.ui.lang);
  const [params, setParams] = useSearchParams();
  const sourceMaster = useLookups(SOURCE_LOOKUP);
  const [dash, setDash] = useState<ImoDashboard | null>(null);
  const [sources, setSources] = useState<ImoSource[]>([]);
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: '-publishedOn', status: params.get('status') ?? '', source: params.get('source') ?? '', overdue: params.get('overdue') === 'true', loading: true });
  const [item, setItem] = useState<ImoItem | null>(null);
  const [form, setForm] = useState<{ status: string; assessment: string; dueOn: string; instrument: LegalInstrument | null }>({ status: 'ASSESSED', assessment: '', dueOn: '', instrument: null });
  const [candidates, setCandidates] = useState<LegalInstrument[]>([]);
  const [busy, setBusy] = useState(false); const [polling, setPolling] = useState<string | null>(null); const [refresh, setRefresh] = useState(0);
  const canManage = hasPerm(user, 'legislation.manage');
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const bump = () => setRefresh((x) => x + 1);

  useEffect(() => {
    api.get<ImoDashboard>(`${ENDPOINT}/dashboard`, { headers: { 'X-Quiet': '1' } }).then((r) => setDash(r.data)).catch(() => setDash(null));
    api.get<ImoSource[]>(`${ENDPOINT}/sources`, { headers: { 'X-Quiet': '1' } }).then((r) => setSources(r.data)).catch(() => setSources([]));
  }, [refresh]);
  const load = useCallback((s: ListState) => {
    setState((x) => ({ ...x, loading: true }));
    api.get<ImoItem[]>(`${ENDPOINT}/items`, { params: { page: s.page, limit: s.limit, q: s.q || undefined, sort: s.sort, status: s.status || undefined, source: s.source || undefined, overdue: s.overdue ? 'true' : undefined } })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: (r.meta?.total as number | undefined) ?? r.data.length, loading: false })))
      .catch((e: Error) => { err(e); setState((x) => ({ ...x, loading: false })); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(state); }, [state.page, state.limit, state.q, state.sort, state.status, state.source, state.overdue, refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const next = new URLSearchParams(params);
    for (const [k, v] of [['status', state.status], ['source', state.source], ['overdue', state.overdue ? 'true' : '']] as const) { if (v) next.set(k, v); else next.delete(k); }
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [state.status, state.source, state.overdue]); // eslint-disable-line react-hooks/exhaustive-deps

  const poll = (source?: string, force = true) => {
    setPolling(source ?? '*');
    api.post<{ polled: PollOutcome[]; newItems: number }>(`${ENDPOINT}/poll`, { source, force })
      .then((r) => {
        const failed = r.data.polled.filter((p) => p.status === 'FAILED');
        dispatch(notify({ message: failed.length ? t('legislation.imo.polledWithFailures', { count: r.data.newItems, failed: failed.map((p) => `${p.source}: ${p.error}`).join('; ') }) : t('legislation.imo.polled', { count: r.data.newItems, sources: r.data.polled.filter((p) => p.status === 'OK').length }), severity: failed.length ? 'warning' : 'success' }));
        bump();
      }).catch(err).finally(() => setPolling(null));
  };
  const openItem = (row: ImoItem) => { setItem(row); setForm({ status: row.status === 'NEW' ? 'ASSESSED' : row.status, assessment: row.assessment, dueOn: row.dueOn ?? '', instrument: row.instrumentRef ? ({ id: row.instrumentId ?? '', refNo: row.instrumentRef, title: '' } as LegalInstrument) : null }); setCandidates([]); };
  const searchInstruments = (q: string) => { if (q.length < 2) return; api.get<LegalInstrument[]>('/legislation/instruments', { params: { q, limit: 10, sort: 'refNo' }, headers: { 'X-Quiet': '1' } }).then((r) => setCandidates(r.data)).catch(() => setCandidates([])); };
  const assess = () => {
    if (!item) return;
    setBusy(true);
    api.post<ImoItem>(`${ENDPOINT}/items/${item.id}/assess`, { status: form.status, assessment: form.assessment || undefined, dueOn: form.dueOn || null, instrumentRef: form.instrument?.refNo || null })
      .then((r) => { dispatch(notify(t('legislation.imo.assessed', { status: t(`legislation.imo.status.${r.data.status}`) }))); setItem(null); bump(); }).catch(err).finally(() => setBusy(false));
  };
  const sourceLabel = (code: string, fallback?: string) => sourceMaster.label(code) || fallback || code;
  const cards: StatCardData[] | undefined = dash ? [
    { label: t('legislation.imo.cards.sources'), value: dash.kpis.sources, sub: t('legislation.imo.cards.sourcesSub', { ok: dash.kpis.polledOk, failed: dash.kpis.failed }), tone: dash.kpis.failed ? 'error' : 'default' },
    { label: t('legislation.imo.cards.new'), value: dash.kpis.new, sub: t('legislation.imo.cards.newSub'), tone: dash.kpis.new ? 'warning' : 'default' },
    { label: t('legislation.imo.cards.overdue'), value: dash.kpis.overdue, sub: t('legislation.imo.cards.overdueSub'), tone: dash.kpis.overdue ? 'error' : 'success' },
    { label: t('legislation.imo.cards.transposed'), value: dash.kpis.transposed, sub: t('legislation.imo.cards.transposedSub', { count: dash.kpis.withInstrument }), tone: 'default' },
    { label: t('legislation.imo.cards.last30'), value: dash.kpis.last30Days, sub: t('legislation.imo.cards.last30Sub'), tone: 'info' },
  ] : undefined;
  const columns: Column<ImoItem>[] = [
    { key: 'reference', label: t('legislation.imo.reference'), mono: true, sortable: true, render: (r) => <b>{r.reference}</b> },
    { key: 'title', label: t('legislation.titleCol'), render: (r) => <Box><Typography sx={{ fontSize: 13, fontWeight: 600 }}>{r.title}</Typography><Typography variant="caption" color="text.secondary">{r.subject}</Typography></Box> },
    { key: 'source', label: t('legislation.imo.source'), render: (r) => <Chip size="small" variant="outlined" label={sourceLabel(r.source, lang === 'ar' && r.sourceLabelAr ? r.sourceLabelAr : r.sourceLabel)} sx={{ height: 20, fontSize: 10.5 }} /> },
    { key: 'publishedOn', label: t('legislation.imo.published'), sortable: true, render: (r) => fmtD(r.publishedOn) },
    { key: 'entryIntoForce', label: t('legislation.imo.entryIntoForce'), sortable: true, render: (r) => fmtD(r.entryIntoForce) },
    { key: 'status', label: t('legislation.status'), sortable: true, render: (r) => <Stack direction="row" spacing={0.5}><StatusChip value={r.status} map={IMO_ITEM_STATUS_META} />{r.overdue && <Chip size="small" color="error" label={t('legislation.imo.overdue')} sx={{ height: 20, fontSize: 10.5 }} />}</Stack> },
    { key: 'instrumentRef', label: t('legislation.imo.instrument'), mono: true, render: (r) => r.instrumentRef || '—' },
    { key: 'seenCount', label: t('legislation.imo.seen'), align: 'right', render: (r) => r.seenCount },
  ];

  return (
    <>
      <PageHeader icon={TravelExploreRoundedIcon} iconColor="#8A5A2B" title={t('legislation.imo.title')} sub={t('legislation.imo.sub')}
        crumbs={[{ label: t('legislation.title'), to: '/legislation' }, { label: t('legislation.imo.title') }]}
        actions={canManage && (
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" disabled={!!polling} onClick={() => poll(undefined, false)}>{t('legislation.imo.readDue')}</Button>
            <Button variant="contained" startIcon={<SyncRoundedIcon />} disabled={!!polling} onClick={() => poll(undefined, true)}>{t('legislation.imo.readAll')}</Button>
          </Stack>
        )} />
      <PageStats cards={cards} refreshKey={refresh} />
      <Card sx={{ mb: 2 }}>
        <Box sx={{ px: 2, pt: 1.5 }}><Typography variant="subtitle2">{t('legislation.imo.sources')}</Typography><Typography variant="caption" color="text.secondary">{t('legislation.imo.sourcesHelp')}</Typography></Box>
        <TableContainer>
          <Table size="small" aria-label={t('legislation.imo.sources')}>
            <TableHead><TableRow><TableCell>{t('legislation.imo.source')}</TableCell><TableCell>{t('legislation.imo.lastRead')}</TableCell><TableCell align="right">{t('legislation.imo.items')}</TableCell><TableCell align="right">{t('legislation.imo.newItems')}</TableCell><TableCell>{t('legislation.imo.nextDue')}</TableCell><TableCell>{t('legislation.imo.mode')}</TableCell>{canManage && <TableCell align="right" />}</TableRow></TableHead>
            <TableBody>
              {sources.map((s) => (
                <TableRow key={s.source} hover>
                  <TableCell><Typography sx={{ fontWeight: 600, fontSize: 13 }}>{sourceLabel(s.source, lang === 'ar' && s.labelAr ? s.labelAr : s.label)}</Typography><Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>{s.body}{s.series ? ` · ${s.series}` : ''}{s.url ? <> · <Link href={s.url} target="_blank" rel="noopener">{t('legislation.imo.sourceSite')}</Link></> : null}</Typography></TableCell>
                  <TableCell><Stack direction="row" spacing={0.75} alignItems="center"><StatusChip value={s.lastStatus} map={POLL_STATUS_META} /><Typography variant="caption">{s.lastPolledAt ? fromNow(s.lastPolledAt) : ''}</Typography></Stack>{s.lastError && <Typography variant="caption" color="error.main" sx={{ display: 'block' }}>{s.lastError}</Typography>}</TableCell>
                  <TableCell align="right">{s.lastItems}</TableCell>
                  <TableCell align="right">{s.newItems}</TableCell>
                  <TableCell>{s.nextDueAt ? fmtDT(s.nextDueAt) : '—'}<Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{t('legislation.imo.everyHours', { hours: s.pollHours })}</Typography></TableCell>
                  <TableCell><Chip size="small" variant="outlined" label={s.mode || '—'} sx={{ height: 20, fontSize: 10.5, fontFamily: MONO }} /></TableCell>
                  {canManage && <TableCell align="right"><Button size="small" disabled={!!polling} onClick={() => poll(s.source)} aria-label={t('legislation.imo.readSource', { source: s.source })}>{polling === s.source ? t('legislation.imo.reading') : t('legislation.imo.readNow')}</Button></TableCell>}
                </TableRow>
              ))}
              {!sources.length && <TableRow><TableCell colSpan={7}><Typography variant="body2" color="text.secondary">{t('legislation.imo.noSources')}</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>
      {!!dash?.attention.length && (
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 2 }} aria-label={t('legislation.imo.attention')}>
          <Typography variant="caption" sx={{ alignSelf: 'center', fontWeight: 700 }}>{t('legislation.imo.attention')}:</Typography>
          {dash.attention.map((a) => <Chip key={a.id} size="small" color={a.overdue ? 'error' : 'warning'} variant="outlined" label={`${a.reference} — ${a.title}`} onClick={() => openItem(a)} sx={{ maxWidth: 420 }} />)}
        </Stack>
      )}
      <DataTable<ImoItem>
        columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => setState((x) => ({ ...x, limit, page: 1 }))}
        search={state.q} onSearch={(q) => setState((x) => ({ ...x, q, page: 1 }))} searchPlaceholder={t('legislation.imo.searchPlaceholder')}
        sort={state.sort} onSort={(sort) => setState((x) => ({ ...x, sort }))} onRowClick={openItem} emptyMessage={t('legislation.imo.empty')}
        toolbar={(
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <TextField select size="small" label={t('legislation.status')} value={state.status} onChange={(e) => setState((x) => ({ ...x, status: e.target.value, page: 1 }))} sx={{ minWidth: 150 }}><MenuItem value="">{t('legislation.imo.allStatuses')}</MenuItem>{IMO_ITEM_STATUSES.map((s) => <MenuItem key={s} value={s}>{t(`legislation.imo.status.${s}`)}</MenuItem>)}</TextField>
            <TextField select size="small" label={t('legislation.imo.source')} value={state.source} onChange={(e) => setState((x) => ({ ...x, source: e.target.value, page: 1 }))} sx={{ minWidth: 170 }}><MenuItem value="">{t('legislation.imo.allSources')}</MenuItem>{sourceMaster.options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}</TextField>
            <FormControlLabel control={<Switch size="small" checked={state.overdue} onChange={(e) => setState((x) => ({ ...x, overdue: e.target.checked, page: 1 }))} />} label={t('legislation.imo.overdueOnly')} />
          </Stack>
        )}
      />
      <Dialog open={!!item} onClose={() => setItem(null)} maxWidth="md" fullWidth aria-labelledby="imo-item-title">
        {item && (
          <>
            <DialogTitle id="imo-item-title"><Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap><Typography component="span" sx={{ fontFamily: MONO, fontWeight: 700 }}>{item.reference}</Typography><StatusChip value={item.status} map={IMO_ITEM_STATUS_META} />{item.overdue && <Chip size="small" color="error" label={t('legislation.imo.overdue')} />}</Stack></DialogTitle>
            <DialogContent dividers>
              <Typography sx={{ fontWeight: 700, fontSize: 16, mb: 0.5 }}>{item.title}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{item.subject}</Typography>
              <Grid container spacing={2} sx={{ mb: 2 }}>
                <Grid item xs={6} md={3}><Item label={t('legislation.imo.source')} value={sourceLabel(item.source, item.sourceLabel)} /></Grid>
                <Grid item xs={6} md={3}><Item label={t('legislation.imo.published')} value={fmtD(item.publishedOn)} /></Grid>
                <Grid item xs={6} md={3}><Item label={t('legislation.imo.entryIntoForce')} value={fmtD(item.entryIntoForce)} /></Grid>
                <Grid item xs={6} md={3}><Item label={t('legislation.imo.seen')} value={t('legislation.imo.seenTimes', { count: item.seenCount, first: fmtD(item.firstSeenAt), last: fmtD(item.lastSeenAt) })} /></Grid>
                {item.url && <Grid item xs={12}><Link href={item.url} target="_blank" rel="noopener" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}><OpenInNewRoundedIcon sx={{ fontSize: 16 }} />{t('legislation.imo.openDocument')}</Link></Grid>}
                {item.status !== 'NEW' && <Grid item xs={12}><Item label={t('legislation.imo.assessment')} value={<>{item.assessment || '—'}<Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{t('legislation.imo.assessedBy', { by: item.assessedBy, on: fmtDT(item.assessedAt) })}{item.dueOn ? ` · ${t('legislation.imo.dueOn', { date: fmtD(item.dueOn) })}` : ''}{item.instrumentRef ? ` · ${item.instrumentRef}` : ''}</Typography></>} /></Grid>}
              </Grid>
              {canManage && (
                <Box sx={{ p: 2, borderRadius: 2, bgcolor: 'action.hover' }}>
                  <Typography variant="subtitle2" gutterBottom>{t('legislation.imo.assess')}</Typography>
                  <Grid container spacing={1.5}>
                    <Grid item xs={12} md={4}><TextField select fullWidth size="small" label={t('legislation.imo.decision')} value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>{IMO_ITEM_STATUSES.filter((s) => s !== 'NEW').map((s) => <MenuItem key={s} value={s}>{t(`legislation.imo.status.${s}`)}</MenuItem>)}</TextField></Grid>
                    <Grid item xs={12} md={4}><TextField fullWidth size="small" type="date" label={t('legislation.imo.dueDate')} InputLabelProps={{ shrink: true }} value={form.dueOn} onChange={(e) => setForm((f) => ({ ...f, dueOn: e.target.value }))} helperText={t('legislation.imo.dueDateHelp')} /></Grid>
                    <Grid item xs={12} md={4}>
                      <Autocomplete size="small" options={candidates} value={form.instrument} getOptionLabel={(o) => (o.refNo ? `${o.refNo}${o.title ? ` — ${o.title}` : ''}` : '')} isOptionEqualToValue={(a, b) => a.refNo === b.refNo}
                        onInputChange={(_, v) => searchInstruments(v)} onChange={(_, v) => setForm((f) => ({ ...f, instrument: v }))} filterOptions={(o) => o}
                        renderInput={(p) => <TextField {...p} label={t('legislation.imo.instrument')} helperText={form.status === 'TRANSPOSED' ? t('legislation.imo.instrumentRequired') : t('legislation.imo.instrumentHelp')} />} />
                    </Grid>
                    <Grid item xs={12}><TextField fullWidth multiline minRows={2} size="small" label={t('legislation.imo.assessment')} value={form.assessment} onChange={(e) => setForm((f) => ({ ...f, assessment: e.target.value }))} helperText={form.status === 'ASSESSED' ? t('legislation.imo.assessmentRequired') : ''} /></Grid>
                  </Grid>
                </Box>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setItem(null)}>{t('common.close')}</Button>
              {canManage && <Button variant="contained" disabled={busy || (form.status === 'ASSESSED' && !form.assessment.trim()) || (form.status === 'TRANSPOSED' && !form.instrument)} onClick={assess}>{t('legislation.imo.record')}</Button>}
            </DialogActions>
          </>
        )}
      </Dialog>
    </>
  );
}
