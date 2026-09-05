import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Divider, MenuItem, Rating, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Chip, Stack, Skeleton } from '@mui/material';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import PageStats from '../../components/common/PageStats';
import DataTable from '../../components/common/DataTable';
import StatusChip from '../../components/common/StatusChip';
import { useLookups } from '../../hooks/useLookups';
import { fmtD } from '../../utils/format';
import { MONO } from '../../theme';
import type { Column } from '../../types';
import { cycleStatusMeta, useSchemes, visitStatusMeta } from './accreditationShared';
import type { AccreditationCycle, AccreditationDashboard, CycleStatus, Visit } from './types';

/* The accreditation desk — every company under every scheme: where each cycle stands today, the renewals
 * coming up, and the inspection visits planned and overdue. Everything here is read against the calendar. */
interface ListState { rows: AccreditationCycle[]; total: number; page: number; limit: number; q: string; sort: string; category: string; status: string; loading: boolean }
const STATUSES: CycleStatus[] = ['CURRENT', 'DUE', 'EXPIRED', 'SUSPENDED', 'WITHDRAWN'];

export default function AccreditationDesk() {
  const navigate = useNavigate(); const dispatch = useAppDispatch(); const { t } = useTranslation();
  const schemes = useSchemes(); const types = useLookups('visitType');
  const [dash, setDash] = useState<AccreditationDashboard | null>(null);
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: 'endsOn', category: '', status: '', loading: true });
  useEffect(() => { api.get<AccreditationDashboard>('/facilities/accreditations/dashboard').then((r) => setDash(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [dispatch]);
  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<AccreditationCycle[]>('/facilities/accreditations', { params: { page: state.page, limit: state.limit, q: state.q || undefined, sort: state.sort, category: state.category || undefined, status: state.status || undefined } })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { dispatch(notify({ message: e.message, severity: 'error' })); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, state.category, state.status, dispatch]);
  const set = (patch: Partial<ListState>) => setState((x) => ({ ...x, ...patch, page: 1 }));
  const k = dash?.kpis;
  const cards = k ? [
    { label: t('facilities.kpiAccredited'), value: k.accredited, sub: `${k.schemes} ${t('facilities.scheme').toLowerCase()}`, tone: 'success' as const },
    { label: t('facilities.kpiCompanies'), value: k.companies, sub: '', tone: 'default' as const },
    { label: t('facilities.kpiDue'), value: k.due, sub: `${k.renewalsNext90} · 90d`, tone: k.due ? 'warning' as const : 'default' as const },
    { label: t('facilities.kpiExpired'), value: k.expired, sub: '', tone: k.expired ? 'error' as const : 'success' as const },
    { label: t('facilities.kpiSuspended'), value: k.suspended, sub: '', tone: k.suspended ? 'warning' as const : 'default' as const },
    { label: t('facilities.kpiRenewals30'), value: k.renewalsNext30, sub: '', tone: 'info' as const },
    { label: t('facilities.kpiVisitsScheduled'), value: k.visitsScheduled, sub: `${k.visitsCompleted90} · 90d`, tone: 'info' as const },
    { label: t('facilities.kpiVisitsOverdue'), value: k.visitsOverdue, sub: `${k.nonConformities90} NC · 90d`, tone: k.visitsOverdue ? 'error' as const : 'success' as const },
  ] : undefined;
  const columns: Column<AccreditationCycle>[] = [
    { key: 'companyName', label: t('facilities.company'), sortable: true, render: (r) => <b>{r.companyName}</b> },
    { key: 'category', label: t('facilities.scheme'), sortable: true, render: (r) => schemes.label(r.category), exportValue: (r) => schemes.label(r.category) },
    { key: 'cycleNo', label: t('facilities.cycle'), sortable: true, render: (r) => `${r.cycleNo}${r.instrumentNo ? ` · ${r.instrumentNo}` : ''}` },
    { key: 'status', label: t('facilities.status'), render: (r) => <StatusChip value={r.status} map={cycleStatusMeta(t)} /> },
    { key: 'endsOn', label: t('facilities.endsOn'), sortable: true, render: (r) => <>{fmtD(r.endsOn)}<Typography variant="caption" color={r.daysLeft < 0 ? 'error.main' : r.status === 'DUE' ? 'warning.main' : 'text.secondary'} sx={{ display: 'block' }}>{r.daysLeft < 0 ? t('facilities.expiredAgo', { count: Math.abs(r.daysLeft) }) : t('facilities.daysLeft', { count: r.daysLeft })}</Typography></> },
    { key: 'visitsDone', label: t('facilities.visitsTab'), render: (r) => <Stack direction="row" spacing={0.5} alignItems="center"><span>{r.visitsDone}/{r.visitsRequired}</span>{r.visitOverdue && <Chip size="small" color="error" label={t('facilities.visitOverdue')} sx={{ height: 18, fontSize: 10 }} />}</Stack>, exportValue: (r) => `${r.visitsDone}/${r.visitsRequired}` },
    { key: 'rating', label: t('facilities.rating'), sortable: true, render: (r) => (r.rating ? <Rating value={r.rating} precision={0.5} size="small" readOnly /> : '—'), exportValue: (r) => r.rating ?? '' },
  ];
  return (
    <>
      <PageHeader icon={FactCheckRoundedIcon} iconColor="#2C6E52" title={t('facilities.deskTitle')} sub={t('facilities.deskSub')} />
      <PageStats cards={cards} />
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} lg={7}>
          <Card>
            <Box sx={{ px: 2, py: 1.25 }}><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.bySchemeTitle')}</Typography></Box>
            <Divider />
            {!dash ? <Skeleton variant="rounded" height={180} sx={{ m: 2 }} /> : (
              <TableContainer sx={{ overflowX: 'auto' }}><Table size="small" aria-label={t('facilities.bySchemeTitle')}>
                <TableHead><TableRow><TableCell>{t('facilities.scheme')}</TableCell><TableCell align="right">{t('facilities.companies')}</TableCell><TableCell align="right">{t('facilities.current')}</TableCell><TableCell align="right">{t('facilities.due')}</TableCell><TableCell align="right">{t('facilities.expired')}</TableCell><TableCell align="right">{t('facilities.suspended')}</TableCell><TableCell align="right">{t('facilities.kpiVisitsOverdue')}</TableCell><TableCell align="right">{t('facilities.avgRating')}</TableCell></TableRow></TableHead>
                <TableBody>{dash.bySchemes.map((s) => (
                  <TableRow key={s.category} hover sx={{ cursor: 'pointer' }} onClick={() => set({ category: s.category })}>
                    <TableCell><b>{schemes.label(s.category) || s.label}</b><Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{s.cycleMonths} mo</Typography></TableCell>
                    <TableCell align="right">{s.companies}</TableCell><TableCell align="right">{s.current}</TableCell><TableCell align="right" sx={{ color: s.due ? 'warning.main' : undefined }}>{s.due}</TableCell><TableCell align="right" sx={{ color: s.expired ? 'error.main' : undefined }}>{s.expired}</TableCell><TableCell align="right">{s.suspended}</TableCell><TableCell align="right" sx={{ color: s.visitsOverdue ? 'error.main' : undefined }}>{s.visitsOverdue}</TableCell><TableCell align="right">{s.averageRating ?? '—'}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table></TableContainer>
            )}
          </Card>
        </Grid>
        <Grid item xs={12} lg={5}>
          <Card sx={{ height: '100%' }}>
            <Box sx={{ px: 2, py: 1.25 }}><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.visitsDueTitle')}</Typography></Box>
            <Divider />
            <TableContainer sx={{ overflowX: 'auto' }}><Table size="small" aria-label={t('facilities.visitsDueTitle')}>
              <TableHead><TableRow><TableCell>{t('facilities.licenceNo')}</TableCell><TableCell>{t('facilities.company')}</TableCell><TableCell>{t('facilities.visitType')}</TableCell><TableCell>{t('facilities.scheduledOn')}</TableCell></TableRow></TableHead>
              <TableBody>
                {(dash?.visitsDue ?? []).map((v: Visit) => <TableRow key={v.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/companies/${v.subjectId}?tab=visits`)}><TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{v.number}</TableCell><TableCell>{v.subjectName}</TableCell><TableCell>{types.label(v.visitType)}</TableCell><TableCell>{fmtD(v.scheduledOn)}{v.overdue ? <Chip size="small" color="error" label={t('facilities.overdue')} sx={{ height: 18, fontSize: 10, ml: 0.5 }} /> : <StatusChip value={v.status} map={visitStatusMeta(t)} />}</TableCell></TableRow>)}
                {dash && dash.visitsDue.length === 0 && <TableRow><TableCell colSpan={4}><Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('facilities.noVisits')}</Typography></TableCell></TableRow>}
              </TableBody>
            </Table></TableContainer>
          </Card>
        </Grid>
      </Grid>
      <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('facilities.workList')}</Typography>
      <DataTable<AccreditationCycle>
        columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading} sort={state.sort}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => setState((x) => ({ ...x, limit, page: 1 }))} onSort={(sort) => setState((x) => ({ ...x, sort }))}
        search={state.q} onSearch={(q) => set({ q })} searchPlaceholder={t('facilities.companySearch', { tax: '' })} onRowClick={(r) => navigate(`/companies/${r.companyId}?tab=accreditation`)} emptyMessage={t('facilities.noAccreditation')}
        toolbar={<>
          <TextField select size="small" label={t('facilities.scheme')} sx={{ minWidth: 220 }} value={state.category} onChange={(e) => set({ category: e.target.value })}>
            <MenuItem value="">{t('facilities.allSchemes')}</MenuItem>{schemes.options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <TextField select size="small" label={t('facilities.status')} sx={{ minWidth: 160 }} value={state.status} onChange={(e) => set({ status: e.target.value })}>
            <MenuItem value="">{t('facilities.allStatuses')}</MenuItem>{STATUSES.map((s) => <MenuItem key={s} value={s}>{t(`facilities.cycleStatus.${s}`)}</MenuItem>)}
          </TextField>
        </>} />
    </>
  );
}
