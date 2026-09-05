import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Button, Card, Chip, Divider, Grid, MenuItem, Skeleton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import SchoolRoundedIcon from '@mui/icons-material/SchoolRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
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
import { useLookups } from '../../hooks/useLookups';
import { fmtD, fmtNum, toInputD } from '../../utils/format';
import { MONO } from '../../theme';
import type { Column, FieldSpec, Option } from '../../types';
import { accreditationStatusMeta, institutionStatusMeta } from './shared';
import type { Institution, MetDashboard } from './metTypes';

/* The MET register — every maritime education and training provider, where its accreditation stands and
 * what it is approved to teach. Types and programmes are masters; the accreditation standing is mirrored
 * from the facilities engine that runs the cycle. */
interface ListState { rows: Institution[]; total: number; page: number; limit: number; q: string; sort: string; institutionType: string; accreditationStatus: string; programme: string; loading: boolean }
const ACCR = ['NONE', 'CURRENT', 'DUE', 'EXPIRED', 'SUSPENDED', 'WITHDRAWN'];

export default function MetRegister() {
  const navigate = useNavigate(); const dispatch = useAppDispatch(); const user = useUser(); const { t } = useTranslation();
  const types = useLookups('metInstitutionType'); const programmes = useLookups('metProgramme');
  const [dash, setDash] = useState<MetDashboard | null>(null);
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: 'name', institutionType: '', accreditationStatus: '', programme: '', loading: true });
  const [open, setOpen] = useState(false); const [vals, setVals] = useState<Record<string, any>>({}); const [busy, setBusy] = useState(false);
  const [companies, setCompanies] = useState<Option[]>([]);
  const refresh = 0;
  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);

  useEffect(() => { api.get<MetDashboard>('/seafarers/met/dashboard').then((r) => setDash(r.data)).catch(err); }, [err, refresh]);
  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<Institution[]>('/seafarers/met/institutions', { params: { page: state.page, limit: state.limit, q: state.q || undefined, sort: state.sort, institutionType: state.institutionType || undefined, accreditationStatus: state.accreditationStatus || undefined, programme: state.programme || undefined } })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { err(e); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, state.institutionType, state.accreditationStatus, state.programme, err, refresh]);
  useEffect(() => {
    if (!open || companies.length) return;
    api.get<{ id: string; code: string; name: string }[]>('/companies', { params: { limit: 200, sort: 'name' }, headers: { 'X-Quiet': '1' } }).then((r) => setCompanies(r.data.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })))).catch(() => setCompanies([]));
  }, [open, companies.length]);
  const set = (patch: Partial<ListState>) => setState((x) => ({ ...x, ...patch, page: 1 }));

  const fields: FieldSpec[] = [
    { name: 'companyId', label: t('seafarers.met.company'), type: 'autocomplete', required: true, options: companies, cols: 12 },
    { name: 'code', label: t('seafarers.met.code'), required: true }, { name: 'institutionType', label: t('seafarers.met.type'), type: 'select', required: true, lookup: 'metInstitutionType' },
    { name: 'name', label: t('seafarers.met.name'), required: true }, { name: 'nameAr', label: t('seafarers.met.nameAr') },
    { name: 'city', label: t('seafarers.met.city') }, { name: 'address', label: t('seafarers.met.address') },
    { name: 'contactName', label: t('seafarers.met.contact') }, { name: 'contactEmail', label: t('seafarers.met.email'), type: 'email' }, { name: 'contactPhone', label: t('seafarers.met.phone') },
    { name: 'instructors', label: t('seafarers.met.instructors'), type: 'number' }, { name: 'capacity', label: t('seafarers.met.capacity'), type: 'number' },
    { name: 'simulators', label: t('seafarers.met.simulators'), helper: t('seafarers.met.simulatorsHelper'), cols: 12 }, { name: 'qualitySystem', label: t('seafarers.met.qualitySystem'), cols: 12 },
    { name: 'establishedOn', label: t('seafarers.met.establishedOn'), type: 'date' }, { name: 'remarks', label: t('seafarers.met.remarks'), type: 'multiline', cols: 12 },
  ];
  const submit = () => {
    setBusy(true);
    const body = { ...vals, code: String(vals.code || '').toUpperCase(), instructors: Number(vals.instructors || 0), capacity: Number(vals.capacity || 0), simulators: String(vals.simulators || '').split(',').map((s) => s.trim()).filter(Boolean), establishedOn: vals.establishedOn || null };
    api.post<Institution>('/seafarers/met/institutions', body).then((r) => { dispatch(notify(t('seafarers.met.registered'))); setOpen(false); navigate(`/seafarers/met/${r.data.id}`); }).catch(err).finally(() => setBusy(false));
  };
  const accr = accreditationStatusMeta(t); const inst = institutionStatusMeta(t);
  const columns: Column<Institution>[] = [
    { key: 'name', label: t('seafarers.met.institution'), sortable: true, render: (r) => <><b>{r.name}</b>{r.nameAr && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.nameAr}</Typography>}</> },
    { key: 'code', label: t('seafarers.met.code'), sortable: true, mono: true },
    { key: 'institutionType', label: t('seafarers.met.type'), sortable: true, render: (r) => types.label(r.institutionType), exportValue: (r) => types.label(r.institutionType) },
    { key: 'city', label: t('seafarers.met.city'), sortable: true },
    { key: 'accreditationStatus', label: t('seafarers.met.accreditation'), sortable: true, render: (r) => <Stack spacing={0.25}><StatusChip value={r.accreditation.status} map={accr} />{r.accreditation.until && <Typography variant="caption" color="text.secondary">{t('seafarers.met.until')} {fmtD(r.accreditation.until)}</Typography>}</Stack>, exportValue: (r) => accr[r.accreditation.status]?.label ?? r.accreditation.status },
    { key: 'programmes', label: t('seafarers.met.programmes'), align: 'center', render: (r) => <Chip size="small" variant="outlined" label={`${r.approvedProgrammes}/${r.programmeCount}`} sx={{ height: 20, fontFamily: MONO }} />, exportValue: (r) => `${r.approvedProgrammes}/${r.programmeCount}` },
    { key: 'seatsPerYear', label: t('seafarers.met.seatsPerYear'), align: 'right', render: (r) => fmtNum(r.seatsPerYear), mono: true },
    { key: 'status', label: t('seafarers.met.status'), sortable: true, render: (r) => <StatusChip value={r.status} map={inst} /> },
  ];
  return (
    <>
      <PageHeader icon={SchoolRoundedIcon} iconColor="#75479C" title={t('seafarers.met.title')} sub={t('seafarers.met.sub')}
        actions={hasPerm(user, 'seafarers.create') && <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => { setVals({ institutionType: types.options[0]?.value ?? '' }); setOpen(true); }}>{t('seafarers.met.register')}</Button>} />
      <PageStats scope="met" refreshKey={refresh} />
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} lg={7}>
          <Card>
            <Box sx={{ px: 2, py: 1.25 }}><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('seafarers.met.byProgramme')}</Typography></Box>
            <Divider />
            {!dash ? <Skeleton variant="rounded" height={180} sx={{ m: 2 }} /> : (
              <TableContainer sx={{ overflowX: 'auto', maxHeight: 320 }}><Table size="small" stickyHeader aria-label={t('seafarers.met.byProgramme')}>
                <TableHead><TableRow><TableCell>{t('seafarers.met.programme')}</TableCell><TableCell>{t('seafarers.met.regulation')}</TableCell><TableCell align="right">{t('seafarers.met.providers')}</TableCell><TableCell align="right">{t('seafarers.met.seatsPerYear')}</TableCell></TableRow></TableHead>
                <TableBody>{dash.byProgramme.map((p) => (
                  <TableRow key={p.programme} hover sx={{ cursor: 'pointer' }} onClick={() => set({ programme: p.programme })}>
                    <TableCell><b>{programmes.label(p.programme) || p.title}</b>{p.simulator && <Chip size="small" variant="outlined" label={t('seafarers.met.simulator')} sx={{ ml: 0.75, height: 18, fontSize: 10 }} />}</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{p.regulation || '—'}</TableCell>
                    <TableCell align="right">{p.providers}</TableCell><TableCell align="right">{fmtNum(p.seatsPerYear)}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table></TableContainer>
            )}
          </Card>
        </Grid>
        <Grid item xs={12} lg={5}>
          <Card sx={{ height: '100%' }}>
            <Box sx={{ px: 2, py: 1.25 }}><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('seafarers.met.attention')}</Typography><Typography variant="caption" color="text.secondary">{t('seafarers.met.attentionSub')}</Typography></Box>
            <Divider />
            {!dash ? <Skeleton variant="rounded" height={140} sx={{ m: 2 }} /> : (
              <TableContainer sx={{ overflowX: 'auto' }}><Table size="small" aria-label={t('seafarers.met.attention')}><TableBody>
                {dash.attention.map((a) => (
                  <TableRow key={a.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/seafarers/met/${a.id}`)}>
                    <TableCell><b>{a.name}</b><Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{a.reason}</Typography></TableCell>
                    <TableCell align="right"><StatusChip value={a.accreditationStatus} map={accr} /></TableCell>
                  </TableRow>
                ))}
                {dash.attention.length === 0 && <TableRow><TableCell><Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('seafarers.met.noAttention')}</Typography></TableCell></TableRow>}
              </TableBody></Table></TableContainer>
            )}
          </Card>
        </Grid>
      </Grid>
      <DataTable<Institution> columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => set({ limit })} search={state.q} onSearch={(q) => set({ q })} searchPlaceholder={t('seafarers.met.searchPlaceholder')}
        sort={state.sort} onSort={(sort) => set({ sort })} onRowClick={(r) => navigate(`/seafarers/met/${r.id}`)}
        toolbar={(
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <TextField select size="small" label={t('seafarers.met.type')} value={state.institutionType} onChange={(e) => set({ institutionType: e.target.value })} sx={{ minWidth: 180 }}><MenuItem value="">—</MenuItem>{types.options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}</TextField>
            <TextField select size="small" label={t('seafarers.met.accreditation')} value={state.accreditationStatus} onChange={(e) => set({ accreditationStatus: e.target.value })} sx={{ minWidth: 170 }}><MenuItem value="">—</MenuItem>{ACCR.map((s) => <MenuItem key={s} value={s}>{accr[s].label}</MenuItem>)}</TextField>
            <TextField select size="small" label={t('seafarers.met.programme')} value={state.programme} onChange={(e) => set({ programme: e.target.value })} sx={{ minWidth: 220 }}><MenuItem value="">—</MenuItem>{programmes.options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}</TextField>
          </Stack>
        )} />
      <FormDrawer open={open} title={t('seafarers.met.register')} onClose={() => setOpen(false)} busy={busy} disabled={!vals.companyId || !vals.code || !vals.name || !vals.institutionType} onSubmit={submit} submitLabel={t('common.save')} width="min(720px, 80vw)">
        <FormFields fields={fields} values={{ ...vals, establishedOn: vals.establishedOn ? toInputD(vals.establishedOn) : '' }} onChange={setVals} />
      </FormDrawer>
    </>
  );
}
