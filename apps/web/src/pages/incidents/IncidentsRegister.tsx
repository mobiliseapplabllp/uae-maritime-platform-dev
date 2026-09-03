import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CrisisAlertRoundedIcon from '@mui/icons-material/CrisisAlertRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import StatusChip from '../../components/common/StatusChip';
import PageStats from '../../components/common/PageStats';
import EntityHover from '../../components/common/EntityHover';
import { INCIDENT_STATUS_META, SEVERITY_META } from '../../utils/status';
import { fmtDT, fromNow, titleCase } from '../../utils/format';
import type { Column } from '../../types';
import { CATEGORIES, SEVERITIES, STATUSES } from './constants';
import ReportIncidentDrawer from './ReportIncidentDrawer';
import type { IncidentRow } from './types';

/* The incident register — every logged case, searchable and filterable, each row opening its case file. */
interface ListState { rows: IncidentRow[]; total: number; page: number; limit: number; q: string; sort: string; loading: boolean }
type Filters = { status: string; severity: string; category: string };

export default function IncidentsRegister() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const user = useUser();
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: '-reportedAt', loading: true });
  const [filters, setFilters] = useState<Filters>({ status: '', severity: '', category: '' });
  const [statsKey, setStatsKey] = useState(0);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    const params = { page: state.page, limit: state.limit, q: state.q || undefined, sort: state.sort, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) };
    api.get<IncidentRow[]>('/incidents', { params })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { dispatch(notify({ message: e.message, severity: 'error' })); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, filters, dispatch]);

  const canCreate = hasPerm(user, 'incidents.create');
  const filterField = (name: keyof Filters, label: string, options: readonly string[]) => (
    <TextField key={name} select size="small" label={label} value={filters[name]} sx={{ width: 150 }}
      onChange={(e) => { setFilters((f) => ({ ...f, [name]: e.target.value })); setState((x) => ({ ...x, page: 1 })); }}>
      <MenuItem value="">All</MenuItem>
      {options.map((o) => <MenuItem key={o} value={o}>{titleCase(o)}</MenuItem>)}
    </TextField>
  );

  const columns: Column<IncidentRow>[] = [
    { key: 'number', label: 'Case no.', mono: true, sortable: true, render: (r) => <EntityHover type="incident" id={r.id}><span>{r.number}</span></EntityHover> },
    { key: 'title', label: 'Title', render: (r) => <Typography noWrap sx={{ fontSize: 13, fontWeight: 600, maxWidth: 380 }}>{r.title}</Typography> },
    { key: 'category', label: 'Category', render: (r) => titleCase(r.category) },
    { key: 'severity', label: 'Severity', sortable: true, render: (r) => <StatusChip value={r.severity} map={SEVERITY_META} /> },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusChip value={r.status} map={INCIDENT_STATUS_META} /> },
    { key: 'vesselName', label: 'Vessel / craft', render: (r) => (r.vesselId ? <EntityHover type="vessel" id={r.vesselId}><span>{r.vesselName}</span></EntityHover> : (r.vesselName || '—')) },
    { key: 'assignedTo', label: 'Case officer', render: (r) => (r.assignedToId ? <EntityHover type="user" id={r.assignedToId}><span>{r.assignedTo}</span></EntityHover> : (r.assignedTo || '—')) },
    { key: 'reportedAt', label: 'Reported', sortable: true, render: (r) => <span title={fmtDT(r.reportedAt)}>{fromNow(r.reportedAt)}</span> },
  ];

  return (
    <>
      <PageHeader icon={CrisisAlertRoundedIcon} iconColor="#B3452E" title={t('incidents.registerTitle')} sub={t('incidents.registerSub')}
        actions={canCreate && <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setCreating(true)}>{t('incidents.logIncident')}</Button>} />
      <PageStats scope="incidents" refreshKey={statsKey} />
      <DataTable<IncidentRow>
        columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading} sort={state.sort}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => setState((x) => ({ ...x, limit, page: 1 }))} onSort={(sort) => setState((x) => ({ ...x, sort }))}
        search={state.q} onSearch={(q) => setState((x) => ({ ...x, q, page: 1 }))} searchPlaceholder={t('incidents.searchPlaceholder')}
        onRowClick={(r) => navigate(`/incidents/${r.id}`)}
        toolbar={<Stack direction="row" spacing={1}>{filterField('status', 'Status', STATUSES)}{filterField('severity', 'Severity', SEVERITIES)}{filterField('category', 'Category', CATEGORIES)}</Stack>} />
      <ReportIncidentDrawer open={creating} onClose={() => setCreating(false)} onLogged={(inc) => { setStatsKey((k) => k + 1); navigate(`/incidents/${inc.id}`); }} />
    </>
  );
}
