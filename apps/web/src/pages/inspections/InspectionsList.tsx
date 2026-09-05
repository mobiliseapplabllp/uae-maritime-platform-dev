import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Chip, MenuItem, Stack, TextField } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageStats from '../../components/common/PageStats';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import StatusChip from '../../components/common/StatusChip';
import EntityHover from '../../components/common/EntityHover';
import { INSPECTION_STATUS_META, RESULT_META } from '../../utils/status';
import { useLookups } from '../../hooks/useLookups';
import { fmtDT } from '../../utils/format';
import type { Column } from '../../types';
import { REGIME_LOOKUP, SUBJECT_KINDS } from './constants';
import PlanInspectionDialog from './PlanInspectionDialog';
import type { InspectionRow } from './types';

/* The survey register — every regime the master defines, against ships, companies, port facilities and training institutions; a survey is planned here and worked from its own page. */
interface ListState { rows: InspectionRow[]; total: number; page: number; limit: number; q: string; sort: string; status: string; type: string; subjectKind: string; loading: boolean }
const STATUS_OPTIONS = Object.entries(INSPECTION_STATUS_META).map(([value, m]) => ({ value, label: m.label }));

export default function InspectionsList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const regimes = useLookups(REGIME_LOOKUP);
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: '-plannedAt', status: '', type: '', subjectKind: '', loading: true });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<InspectionRow[]>('/inspections', { params: { page: state.page, limit: state.limit, q: state.q || undefined, sort: state.sort, status: state.status || undefined, regime: state.type || undefined, subjectKind: state.subjectKind || undefined } })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { dispatch(notify({ message: e.message, severity: 'error' })); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, state.status, state.type, state.subjectKind, dispatch]);

  const columns: Column<InspectionRow>[] = [
    { key: 'number', label: t('inspections.number'), mono: true, sortable: true },
    { key: 'subjectName', label: t('inspections.subject'), sortable: true, exportValue: (r) => r.subjectName || r.vesselName, render: (r) => (
      <>
        {r.vesselId ? <EntityHover type="vessel" id={r.vesselId}><b>{r.subjectName || r.vesselName}</b></EntityHover> : <b>{r.subjectName || r.vesselName || '—'}</b>}
        {r.subjectKind && r.subjectKind !== 'VESSEL' && <Chip size="small" variant="outlined" label={t(`inspections.subjectKind.${r.subjectKind}`)} sx={{ height: 18, fontSize: 10, ml: 0.75 }} />}
      </>
    ) },
    { key: 'type', label: t('inspections.regime'), exportValue: (r) => regimes.label(r.type), render: (r) => <Chip size="small" variant="outlined" label={regimes.label(r.type)} sx={{ height: 20, fontSize: 11 }} /> },
    { key: 'inspector', label: t('inspections.inspector') },
    { key: 'plannedAt', label: t('inspections.plannedCol'), sortable: true, render: (r) => fmtDT(r.plannedAt) },
    { key: 'status', label: t('inspections.status'), render: (r) => <StatusChip value={r.status} map={INSPECTION_STATUS_META} /> },
    { key: 'result', label: t('inspections.result'), render: (r) => (r.result ? <StatusChip value={r.result} map={RESULT_META} /> : '—') },
    { key: 'findings', label: t('inspections.findingsCol'), align: 'right', render: (r) => r.findingsCount ?? r.findings?.length ?? 0 },
    { key: 'dossier', label: t('inspections.dossierCol'), noExport: true, render: (r) => (r.hasDossier ? <Chip size="small" color="success" variant="outlined" label={t('inspections.dossierReady')} sx={{ height: 20, fontSize: 10.5 }} /> : '—') },
  ];

  return (
    <>
      <PageHeader icon={FactCheckRoundedIcon} iconColor="#9C6412" title={t('inspections.registerTitle')} sub={t('inspections.registerSub')}
        actions={hasPerm(user, 'inspections.create') && <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setCreating(true)}>{t('inspections.newInspection')}</Button>} />
      <PageStats scope="inspections" />
      <DataTable<InspectionRow>
        columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading} sort={state.sort}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => setState((x) => ({ ...x, limit, page: 1 }))} onSort={(sort) => setState((x) => ({ ...x, sort }))}
        search={state.q} onSearch={(q) => setState((x) => ({ ...x, q, page: 1 }))} searchPlaceholder={t('inspections.searchPlaceholder')}
        onRowClick={(r) => navigate(`/inspections/${r.id}`)}
        toolbar={(
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <TextField select size="small" label={t('inspections.status')} value={state.status} sx={{ width: 150 }} onChange={(e) => setState((x) => ({ ...x, status: e.target.value, page: 1 }))}>
              <MenuItem value="">{t('inspections.all')}</MenuItem>
              {STATUS_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
            </TextField>
            <TextField select size="small" label={t('inspections.regime')} value={state.type} sx={{ width: 200 }} onChange={(e) => setState((x) => ({ ...x, type: e.target.value, page: 1 }))}>
              <MenuItem value="">{t('inspections.all')}</MenuItem>
              {regimes.options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
            </TextField>
            <TextField select size="small" label={t('inspections.subject')} value={state.subjectKind} sx={{ width: 170 }} onChange={(e) => setState((x) => ({ ...x, subjectKind: e.target.value, page: 1 }))}>
              <MenuItem value="">{t('inspections.all')}</MenuItem>
              {SUBJECT_KINDS.map((k) => <MenuItem key={k} value={k}>{t(`inspections.subjectKind.${k}`)}</MenuItem>)}
            </TextField>
          </Stack>
        )} />
      <PlanInspectionDialog open={creating} onClose={() => setCreating(false)} onPlanned={(r) => navigate(`/inspections/${r.id}`)} />
    </>
  );
}
