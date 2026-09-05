import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Autocomplete, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, Grid, MenuItem, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import StatusChip from '../../components/common/StatusChip';
import FormFields from '../../components/common/FormFields';
import { useLookups } from '../../hooks/useLookups';
import { fmtD, fmtDT } from '../../utils/format';
import { MONO } from '../../theme';
import type { Column } from '../../types';
import { RANK_LOOKUP, ledgerStatusMeta, listStatusMeta } from './shared';
import type { ForeignSeafarer } from './metTypes';
import type { SeafarerRow } from './types';

/* The foreign seafarer ledger — every person a crew list named who is not on the national register, counted
 * on every sight. The desk records the flag's endorsement of a foreign officer here (STCW I/10), and
 * reconciles an entry to a register record when the two turn out to be one person. */
interface ListState { rows: ForeignSeafarer[]; total: number; page: number; limit: number; q: string; sort: string; status: string; officer: boolean; loading: boolean }
const STATUSES = ['LEDGER', 'WATCH', 'RECONCILED', 'REGISTERED'];
const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box><Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography><Typography component="div" sx={{ fontSize: 13.5, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography></Box>
);

export default function ForeignLedger() {
  const navigate = useNavigate(); const dispatch = useAppDispatch(); const user = useUser(); const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const ranks = useLookups(RANK_LOOKUP);
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: '-lastSeenAt', status: '', officer: false, loading: true });
  const [entry, setEntry] = useState<ForeignSeafarer | null>(null);
  const [mode, setMode] = useState<'view' | 'endorse' | 'reconcile'>('view');
  const [vals, setVals] = useState<Record<string, any>>({});
  const [candidates, setCandidates] = useState<SeafarerRow[]>([]); const [chosen, setChosen] = useState<SeafarerRow | null>(null);
  const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<ForeignSeafarer[]>('/seafarers/foreign', { params: { page: state.page, limit: state.limit, q: state.q || undefined, sort: state.sort, status: state.status || undefined, officer: state.officer ? 'true' : undefined } })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { err(e); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, state.status, state.officer, err, refresh]);
  const openEntry = useCallback((id: string) => { api.get<ForeignSeafarer>(`/seafarers/foreign/${id}`).then((r) => { setEntry(r.data); setMode('view'); }).catch(err); }, [err]);
  useEffect(() => { const id = params.get('open'); if (id) openEntry(id); }, [params, openEntry]);
  const close = () => { setEntry(null); setChosen(null); setCandidates([]); if (params.get('open')) { params.delete('open'); setParams(params, { replace: true }); } };
  const set = (patch: Partial<ListState>) => setState((x) => ({ ...x, ...patch, page: 1 }));
  const canEdit = hasPerm(user, 'seafarers.edit');
  const meta = ledgerStatusMeta(t); const listMeta = listStatusMeta(t);
  const search = (q: string) => { if (q.trim().length < 2) return; api.get<SeafarerRow[]>('/seafarers', { params: { q, limit: 10, sort: 'name' }, headers: { 'X-Quiet': '1' } }).then((r) => setCandidates(r.data)).catch(() => setCandidates([])); };
  const endorse = () => {
    if (!entry) return; setBusy(true);
    api.post<ForeignSeafarer>(`/seafarers/foreign/${entry.id}/endorsement`, { number: vals.number, issuer: vals.issuer || undefined, expiryDate: vals.expiryDate || null, remarks: vals.remarks || '' })
      .then((r) => { dispatch(notify(t('seafarers.fl.endorsementSaved'))); setEntry({ ...entry, ...r.data }); setMode('view'); setRefresh((n) => n + 1); }).catch(err).finally(() => setBusy(false));
  };
  const reconcile = () => {
    if (!entry || !chosen) return; setBusy(true);
    api.post<ForeignSeafarer & { relinked: number }>(`/seafarers/foreign/${entry.id}/reconcile`, { seafarerId: chosen.id, note: vals.note || '' })
      .then((r) => { dispatch(notify(t('seafarers.fl.reconciled', { count: r.data.relinked }))); setEntry({ ...entry, ...r.data }); setMode('view'); setRefresh((n) => n + 1); }).catch(err).finally(() => setBusy(false));
  };
  const columns: Column<ForeignSeafarer>[] = [
    { key: 'name', label: t('seafarers.fl.name'), sortable: true, render: (f) => <><b>{f.name}</b>{f.dob && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{fmtD(f.dob)}</Typography>}</> },
    { key: 'nationality', label: t('seafarers.fl.nationality'), sortable: true },
    { key: 'idNumber', label: t('seafarers.fl.document'), render: (f) => <><span style={{ fontFamily: MONO, fontSize: 12 }}>{f.idType} {f.idNumber}</span>{f.idExpired && <Chip size="small" color="error" label={t('seafarers.fl.idExpired')} sx={{ ml: 0.5, height: 18, fontSize: 10 }} />}</>, exportValue: (f) => `${f.idType} ${f.idNumber}` },
    { key: 'lastRank', label: t('seafarers.fl.rank'), sortable: true, render: (f) => ranks.label(f.lastRankCode) || f.lastRank },
    { key: 'appearances', label: t('seafarers.fl.appearances'), align: 'right', sortable: true, render: (f) => <span style={{ fontFamily: MONO }}>{f.appearances}</span> },
    { key: 'distinctVessels', label: t('seafarers.fl.vessels'), align: 'right', render: (f) => <span style={{ fontFamily: MONO }}>{f.distinctVessels}</span> },
    { key: 'lastSeenAt', label: t('seafarers.fl.lastSeen'), sortable: true, render: (f) => fmtD(f.lastSeenAt) },
    { key: 'endorsement', label: t('seafarers.fl.endorsement'), render: (f) => (f.endorsement ? <Chip size="small" color={f.endorsement.valid ? 'success' : 'error'} label={`${f.endorsement.number}`} sx={{ height: 20, fontSize: 10.5, fontFamily: MONO }} /> : <Typography variant="caption" color="text.secondary">{t('seafarers.fl.noEndorsement')}</Typography>), exportValue: (f) => f.endorsement?.number ?? '' },
    { key: 'status', label: t('seafarers.fl.status'), sortable: true, render: (f) => <StatusChip value={f.status} map={meta} /> },
  ];
  return (
    <>
      <PageHeader icon={PublicRoundedIcon} iconColor="#75479C" title={t('seafarers.fl.title')} sub={t('seafarers.fl.sub')} />
      <DataTable<ForeignSeafarer> columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => set({ limit })} search={state.q} onSearch={(q) => set({ q })} searchPlaceholder={t('seafarers.fl.searchPlaceholder')}
        sort={state.sort} onSort={(sort) => set({ sort })} onRowClick={(f) => openEntry(f.id)}
        toolbar={(
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <TextField select size="small" label={t('seafarers.fl.status')} value={state.status} onChange={(e) => set({ status: e.target.value })} sx={{ minWidth: 160 }}><MenuItem value="">—</MenuItem>{STATUSES.map((s) => <MenuItem key={s} value={s}>{meta[s].label}</MenuItem>)}</TextField>
            <FormControlLabel control={<Switch size="small" checked={state.officer} onChange={(e) => set({ officer: e.target.checked })} />} label={t('seafarers.fl.officer')} />
          </Stack>
        )} />
      <Dialog open={!!entry} onClose={() => !busy && close()} maxWidth="md" fullWidth>
        {entry && (
          <>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}><span>{entry.name}</span><StatusChip value={entry.status} map={meta} /></DialogTitle>
            <DialogContent>
              <Grid container spacing={2} sx={{ mb: 1 }}>
                <Grid item xs={6} md={3}><Item label={t('seafarers.fl.nationality')} value={entry.nationality} /></Grid>
                <Grid item xs={6} md={3}><Item label={t('seafarers.fl.document')} value={<span style={{ fontFamily: MONO }}>{entry.idType} {entry.idNumber}</span>} /></Grid>
                <Grid item xs={6} md={3}><Item label={t('seafarers.fl.dob')} value={fmtD(entry.dob)} /></Grid>
                <Grid item xs={6} md={3}><Item label={t('seafarers.fl.cdcNo')} value={entry.cdcNo || '—'} /></Grid>
                <Grid item xs={6} md={3}><Item label={t('seafarers.fl.rank')} value={ranks.label(entry.lastRankCode) || entry.lastRank} /></Grid>
                <Grid item xs={6} md={3}><Item label={t('seafarers.fl.appearances')} value={`${entry.appearances} · ${entry.distinctVessels} ${t('seafarers.fl.vessels').toLowerCase()}`} /></Grid>
                <Grid item xs={6} md={3}><Item label={t('seafarers.fl.firstSeen')} value={fmtD(entry.firstSeenAt)} /></Grid>
                <Grid item xs={6} md={3}><Item label={t('seafarers.fl.lastSeen')} value={fmtD(entry.lastSeenAt)} /></Grid>
                <Grid item xs={12} md={6}><Item label={t('seafarers.fl.endorsement')} value={entry.endorsement ? <>{entry.endorsement.number} · {entry.endorsement.issuer} · {fmtD(entry.endorsement.expiryDate)} <Chip size="small" color={entry.endorsement.valid ? 'success' : 'error'} label={entry.endorsement.valid ? t('seafarers.fl.valid') : t('seafarers.fl.expired')} sx={{ height: 18, fontSize: 10, ml: 0.5 }} /></> : t('seafarers.fl.noEndorsement')} /></Grid>
                {entry.statusReason && <Grid item xs={12} md={6}><Item label={t('seafarers.fl.reason')} value={entry.statusReason} /></Grid>}
                {entry.reconciledSeafarerId && <Grid item xs={12}><Item label={t('seafarers.fl.reconciledTo')} value={<Button size="small" onClick={() => navigate(`/seafarers/${entry.reconciledSeafarerId}`)}>{t('seafarers.cl.openSeafarer')}</Button>} /></Grid>}
              </Grid>
              {mode === 'view' && (
                <>
                  <Divider sx={{ my: 1.5 }} />
                  <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t('seafarers.fl.appearanceList')}</Typography>
                  <TableContainer sx={{ maxHeight: 260 }}><Table size="small" stickyHeader aria-label={t('seafarers.fl.appearanceList')}>
                    <TableHead><TableRow><TableCell>{t('seafarers.fl.list')}</TableCell><TableCell>{t('seafarers.cl.vessel')}</TableCell><TableCell>{t('seafarers.fl.date')}</TableCell><TableCell>{t('seafarers.fl.rank')}</TableCell><TableCell>{t('seafarers.cl.status')}</TableCell><TableCell /></TableRow></TableHead>
                    <TableBody>{(entry.appearanceList ?? []).map((a) => (
                      <TableRow key={a.crewListId} hover>
                        <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{a.number}</TableCell><TableCell>{a.vesselName}<Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{a.vcn}</Typography></TableCell>
                        <TableCell>{fmtDT(a.date)}</TableCell><TableCell>{a.rank}</TableCell><TableCell><StatusChip value={a.listStatus} map={listMeta} /></TableCell>
                        <TableCell align="right"><Button size="small" onClick={() => navigate(`/seafarers/crew-lists/${a.crewListId}`)}>{t('seafarers.fl.openList')}</Button></TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table></TableContainer>
                </>
              )}
              {mode === 'endorse' && (
                <Box sx={{ mt: 1.5 }}>
                  <FormFields fields={[{ name: 'number', label: t('seafarers.fl.endorsementNo'), required: true }, { name: 'issuer', label: t('seafarers.fl.issuer') }, { name: 'expiryDate', label: t('seafarers.fl.expiryDate'), type: 'date' }, { name: 'remarks', label: t('seafarers.remarks'), type: 'multiline', cols: 12 }]} values={vals} onChange={setVals} />
                </Box>
              )}
              {mode === 'reconcile' && (
                <Box sx={{ mt: 1.5 }}>
                  <Autocomplete options={candidates} value={chosen} onChange={(_, v) => setChosen(v)} onInputChange={(_, q) => search(q)} getOptionLabel={(s) => `${s.name} · ${s.rank} · CDC ${s.cdcNo}`} isOptionEqualToValue={(a, b) => a.id === b.id}
                    renderInput={(p) => <TextField {...p} size="small" label={t('seafarers.fl.seafarer')} helperText={t('seafarers.fl.reconcileHelper')} />} sx={{ mb: 1.5 }} />
                  <TextField fullWidth size="small" multiline minRows={2} label={t('seafarers.fl.note')} value={vals.note ?? ''} onChange={(e) => setVals({ ...vals, note: e.target.value })} />
                </Box>
              )}
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2 }}>
              {mode === 'view' && canEdit && entry.status !== 'RECONCILED' && <Button onClick={() => { setVals({}); setMode('reconcile'); }}>{t('seafarers.fl.reconcile')}</Button>}
              {mode === 'view' && canEdit && <Button onClick={() => { setVals({ number: entry.endorsement?.number ?? '' }); setMode('endorse'); }}>{t('seafarers.fl.recordEndorsement')}</Button>}
              {mode === 'view' && <Button variant="contained" onClick={close}>{t('common.close')}</Button>}
              {mode !== 'view' && <Button onClick={() => setMode('view')} disabled={busy}>{t('common.cancel')}</Button>}
              {mode === 'endorse' && <Button variant="contained" disabled={busy || !vals.number} onClick={endorse}>{t('common.save')}</Button>}
              {mode === 'reconcile' && <Button variant="contained" disabled={busy || !chosen} onClick={reconcile}>{t('common.confirm')}</Button>}
            </DialogActions>
          </>
        )}
      </Dialog>
    </>
  );
}
