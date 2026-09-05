import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Button, Card, Chip, Divider, Grid, IconButton, MenuItem, Skeleton, Stack, Table, TableBody, TableCell, TableContainer, TableRow, TextField, Typography } from '@mui/material';
import ListAltRoundedIcon from '@mui/icons-material/ListAltRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import PageStats from '../../components/common/PageStats';
import DataTable from '../../components/common/DataTable';
import StatusChip from '../../components/common/StatusChip';
import FormDrawer from '../../components/common/FormDrawer';
import FormFields from '../../components/common/FormFields';
import EntityHover from '../../components/common/EntityHover';
import { useLookups } from '../../hooks/useLookups';
import { fmtD, fmtDT } from '../../utils/format';
import { MONO } from '../../theme';
import type { Column, FieldSpec } from '../../types';
import { RANK_LOOKUP, listStatusMeta } from './shared';
import type { CrewLinePayload, CrewList, CrewListDashboard, CrewListPayload } from './metTypes';

/* The crew-list desk — FAL-5 lists as they arrive, what the checks found, and the ones waiting on a decision.
 * A list is received here too: the call it belongs to, the source it came from (a master), and one line per
 * person, which the service matches and checks on receipt. */
interface ListState { rows: CrewList[]; total: number; page: number; limit: number; q: string; sort: string; status: string; source: string; ok: string; loading: boolean }
const STATUSES = ['RECEIVED', 'CHECKED', 'CLEARED', 'QUERIED'];
const blankLine = (): CrewLinePayload => ({ familyName: '', givenNames: '', rank: '', nationality: '', idType: 'Passport', idNumber: '', idExpiry: '', dob: '', cdcNo: '' });

export default function CrewLists() {
  const navigate = useNavigate(); const dispatch = useAppDispatch(); const user = useUser(); const { t } = useTranslation();
  const sources = useLookups('crewListSource');
  const [dash, setDash] = useState<CrewListDashboard | null>(null);
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: '-date', status: '', source: '', ok: '', loading: true });
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  const [head, setHead] = useState<Record<string, any>>({ movement: 'ARRIVAL' });
  const [lines, setLines] = useState<CrewLinePayload[]>([blankLine()]);
  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  useEffect(() => { api.get<CrewListDashboard>('/seafarers/crew-lists/dashboard').then((r) => setDash(r.data)).catch(err); }, [err, refresh]);
  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<CrewList[]>('/seafarers/crew-lists', { params: { page: state.page, limit: state.limit, q: state.q || undefined, sort: state.sort, status: state.status || undefined, source: state.source || undefined, ok: state.ok || undefined } })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { err(e); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, state.status, state.source, state.ok, err, refresh]);
  const set = (patch: Partial<ListState>) => setState((x) => ({ ...x, ...patch, page: 1 }));
  const meta = listStatusMeta(t);
  const headFields: FieldSpec[] = [
    { name: 'vcn', label: t('seafarers.cl.vcnLabel'), required: true, helper: t('seafarers.cl.vcnHelper') },
    { name: 'movement', label: t('seafarers.cl.movement'), type: 'select', options: [{ value: 'ARRIVAL', label: t('seafarers.cl.movementLabel.ARRIVAL') }, { value: 'DEPARTURE', label: t('seafarers.cl.movementLabel.DEPARTURE') }] },
    { name: 'source', label: t('seafarers.cl.source'), type: 'select', required: true, lookup: 'crewListSource' },
    { name: 'declaredCrew', label: t('seafarers.cl.declaredCrew'), type: 'number' },
    { name: 'remarks', label: t('seafarers.remarks'), type: 'multiline', cols: 12 },
  ];
  const lineFields: FieldSpec[] = [
    { name: 'familyName', label: t('seafarers.cl.familyName'), required: true, cols: 3 }, { name: 'givenNames', label: t('seafarers.cl.givenNames'), cols: 3 },
    { name: 'rank', label: t('seafarers.cl.rank'), type: 'select', required: true, lookup: RANK_LOOKUP, cols: 3 }, { name: 'nationality', label: t('seafarers.cl.nationality'), required: true, cols: 3 },
    { name: 'idType', label: t('seafarers.cl.idType'), cols: 3 }, { name: 'idNumber', label: t('seafarers.cl.idNumber'), required: true, cols: 3 }, { name: 'idExpiry', label: t('seafarers.cl.idExpiry'), type: 'date', cols: 3 },
    { name: 'cdcNo', label: t('seafarers.cl.cdcNo'), cols: 3 }, { name: 'dob', label: t('seafarers.cl.dob'), type: 'date', cols: 3 }, { name: 'pob', label: t('seafarers.cl.pob'), cols: 3 },
  ];
  const valid = !!head.vcn && !!head.source && lines.length > 0 && lines.every((l) => l.familyName && l.rank && l.nationality && l.idNumber);
  const submit = () => {
    setBusy(true);
    const body: CrewListPayload = { vcn: head.vcn, movement: head.movement || 'ARRIVAL', source: head.source, declaredCrew: head.declaredCrew === '' || head.declaredCrew == null ? null : Number(head.declaredCrew), remarks: head.remarks || '', rows: lines.map((l) => ({ ...l, dob: l.dob || null, idExpiry: l.idExpiry || null })) };
    api.post<CrewList>('/seafarers/crew-lists', body).then((r) => { dispatch(notify(t('seafarers.cl.received', { number: r.data.number }))); setOpen(false); setRefresh((n) => n + 1); navigate(`/seafarers/crew-lists/${r.data.id}`); }).catch(err).finally(() => setBusy(false));
  };
  const result = (r: CrewList) => (r.ok === null ? <Chip size="small" variant="outlined" label={t('seafarers.cl.notChecked')} sx={{ height: 20, fontSize: 10.5 }} /> : r.ok ? <Chip size="small" color="success" label={t('seafarers.cl.passed')} sx={{ height: 20, fontSize: 10.5 }} /> : <Chip size="small" color="warning" label={t('seafarers.cl.failed', { count: r.checks?.summary.length ?? r.flagged })} sx={{ height: 20, fontSize: 10.5 }} />);
  const columns: Column<CrewList>[] = [
    { key: 'number', label: t('seafarers.cl.number'), sortable: true, render: (r) => <b style={{ fontFamily: MONO }}>{r.number}</b> },
    { key: 'vesselName', label: t('seafarers.cl.vessel'), sortable: true, render: (r) => <EntityHover type="vessel" id={r.vesselId}><span>{r.vesselName}</span></EntityHover> },
    { key: 'vcn', label: t('seafarers.cl.vcn'), mono: true, render: (r) => r.vcn || '—' },
    { key: 'movement', label: t('seafarers.cl.movement'), render: (r) => t(`seafarers.cl.movementLabel.${r.movement}`), exportValue: (r) => r.movement },
    { key: 'date', label: t('seafarers.cl.date'), sortable: true, render: (r) => fmtD(r.date) },
    { key: 'source', label: t('seafarers.cl.source'), sortable: true, render: (r) => sources.label(r.source) || r.sourceLabel, exportValue: (r) => sources.label(r.source) || r.sourceLabel },
    { key: 'rowCount', label: t('seafarers.cl.lines'), align: 'right', sortable: true, render: (r) => <span style={{ fontFamily: MONO }}>{r.rowCount}</span> },
    { key: 'matched', label: t('seafarers.cl.matched'), align: 'right', render: (r) => <span style={{ fontFamily: MONO }}>{r.matched}</span> },
    { key: 'foreignCount', label: t('seafarers.cl.foreign'), align: 'right', render: (r) => <span style={{ fontFamily: MONO }}>{r.foreignCount}</span> },
    { key: 'ok', label: t('seafarers.cl.result'), render: result, exportValue: (r) => (r.ok === null ? '' : r.ok ? 'PASSED' : 'FINDINGS') },
    { key: 'status', label: t('seafarers.cl.status'), sortable: true, render: (r) => <StatusChip value={r.status} map={meta} /> },
  ];
  return (
    <>
      <PageHeader icon={ListAltRoundedIcon} iconColor="#75479C" title={t('seafarers.cl.title')} sub={t('seafarers.cl.sub')}
        actions={hasPerm(user, 'seafarers.edit') && <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => { setHead({ movement: 'ARRIVAL', source: sources.options[0]?.value ?? '' }); setLines([blankLine()]); setOpen(true); }}>{t('seafarers.cl.receive')}</Button>} />
      <PageStats scope="crewLists" refreshKey={refresh} />
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} lg={7}>
          <Card sx={{ height: '100%' }}>
            <Box sx={{ px: 2, py: 1.25 }}><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('seafarers.cl.attention')}</Typography></Box>
            <Divider />
            {!dash ? <Skeleton variant="rounded" height={160} sx={{ m: 2 }} /> : (
              <TableContainer sx={{ overflowX: 'auto' }}><Table size="small" aria-label={t('seafarers.cl.attention')}><TableBody>
                {dash.attention.map((a) => (
                  <TableRow key={a.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/seafarers/crew-lists/${a.id}`)}>
                    <TableCell><b style={{ fontFamily: MONO }}>{a.number}</b><Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{a.vesselName} · {a.vcn} · {fmtDT(a.date)}</Typography><Typography variant="caption" sx={{ display: 'block' }}>{a.summary.join(' · ')}</Typography></TableCell>
                    <TableCell align="right"><StatusChip value={a.status} map={meta} /></TableCell>
                  </TableRow>
                ))}
                {dash.attention.length === 0 && <TableRow><TableCell><Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('seafarers.cl.nothingWaiting')}</Typography></TableCell></TableRow>}
              </TableBody></Table></TableContainer>
            )}
          </Card>
        </Grid>
        <Grid item xs={12} lg={5}>
          <Card sx={{ height: '100%' }}>
            <Box sx={{ px: 2, py: 1.25 }}><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('seafarers.cl.bySource')}</Typography></Box>
            <Divider />
            {!dash ? <Skeleton variant="rounded" height={120} sx={{ m: 2 }} /> : (
              <TableContainer><Table size="small" aria-label={t('seafarers.cl.bySource')}><TableBody>
                {dash.bySource.map((s) => <TableRow key={s.source} hover sx={{ cursor: 'pointer' }} onClick={() => set({ source: s.source })}><TableCell>{sources.label(s.source) || s.label}</TableCell><TableCell align="right" sx={{ fontFamily: MONO }}>{s.lists}</TableCell></TableRow>)}
              </TableBody></Table></TableContainer>
            )}
          </Card>
        </Grid>
      </Grid>
      <DataTable<CrewList> columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => set({ limit })} search={state.q} onSearch={(q) => set({ q })} searchPlaceholder={t('seafarers.cl.searchPlaceholder')}
        sort={state.sort} onSort={(sort) => set({ sort })} onRowClick={(r) => navigate(`/seafarers/crew-lists/${r.id}`)}
        toolbar={(
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <TextField select size="small" label={t('seafarers.cl.status')} value={state.status} onChange={(e) => set({ status: e.target.value })} sx={{ minWidth: 150 }}><MenuItem value="">—</MenuItem>{STATUSES.map((s) => <MenuItem key={s} value={s}>{meta[s].label}</MenuItem>)}</TextField>
            <TextField select size="small" label={t('seafarers.cl.source')} value={state.source} onChange={(e) => set({ source: e.target.value })} sx={{ minWidth: 190 }}><MenuItem value="">—</MenuItem>{sources.options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}</TextField>
            <TextField select size="small" label={t('seafarers.cl.result')} value={state.ok} onChange={(e) => set({ ok: e.target.value })} sx={{ minWidth: 150 }}><MenuItem value="">{t('seafarers.cl.anyResult')}</MenuItem><MenuItem value="true">{t('seafarers.cl.passed')}</MenuItem><MenuItem value="false">{t('seafarers.cl.failed', { count: '' }).trim()}</MenuItem></TextField>
          </Stack>
        )} />
      <FormDrawer open={open} title={t('seafarers.cl.receive')} onClose={() => setOpen(false)} busy={busy} disabled={!valid} onSubmit={submit} submitLabel={t('common.save')} width="min(980px, 85vw)">
        <FormFields fields={headFields} values={head} onChange={setHead} />
        <Divider sx={{ my: 2 }} />
        <Stack spacing={1.5}>
          {lines.map((line, i) => (
            <Box key={i} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }} data-testid={`crew-line-${i + 1}`}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
                <Typography variant="caption" sx={{ fontFamily: MONO, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{t('seafarers.cl.lineN', { n: i + 1 })}</Typography>
                <IconButton size="small" aria-label={`${t('seafarers.cl.removeLine')} ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, k) => k !== i))}><DeleteOutlineRoundedIcon fontSize="inherit" /></IconButton>
              </Stack>
              <FormFields fields={lineFields} values={line as unknown as Record<string, any>} onChange={(v) => setLines(lines.map((l, k) => (k === i ? (v as unknown as CrewLinePayload) : l)))} />
            </Box>
          ))}
          <Button size="small" startIcon={<AddRoundedIcon />} onClick={() => setLines([...lines, blankLine()])} sx={{ alignSelf: 'flex-start' }}>{t('seafarers.cl.addLine')}</Button>
          {lines.length === 0 && <Typography color="error">{t('seafarers.cl.noLines')}</Typography>}
        </Stack>
      </FormDrawer>
    </>
  );
}
