import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Chip, MenuItem, Rating, TextField, Typography } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageStats from '../../components/common/PageStats';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import StatusChip from '../../components/common/StatusChip';
import ExportMenu from '../../components/common/ExportMenu';
import { LICENCE_STATUS_META } from '../../utils/status';
import { fmtD } from '../../utils/format';
import type { Column } from '../../types';
import type { ExportColumn } from '../../utils/exportUtils';
import ApplicationDialog from './ApplicationDialog';
import { FACILITY_KINDS, SUBJECT_KIND_LABEL, SUBJECT_KIND_OPTIONS } from './shared';
import type { Licence, LicenceMeta } from './types';

/* The licence register — every instrument the port-companies desk issues: agency and supplier licences, ISPS statements, accreditations and the company's statutory certificates. */
interface ListState { rows: Licence[]; total: number; page: number; limit: number; q: string; sort: string; status: string; entityType: string; subjectKind: string; loading: boolean }
const STATUS_OPTIONS = Object.entries(LICENCE_STATUS_META).map(([value, m]) => ({ value, label: m.label }));

export default function FacilitiesList() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const { t } = useTranslation();
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: '-createdAt', status: '', entityType: '', subjectKind: '', loading: true });
  const [meta, setMeta] = useState<LicenceMeta | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);

  useEffect(() => { api.get<LicenceMeta>('/licenses/meta').then((r) => setMeta(r.data)).catch(() => {}); }, []);
  const params = (extra: Record<string, unknown> = {}) => ({ sort: state.sort, q: state.q || undefined, status: state.status || undefined, entityType: state.entityType || undefined, subjectKind: state.subjectKind || undefined, ...extra });
  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<Licence[]>('/licenses', { params: params({ page: state.page, limit: state.limit }) })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { dispatch(notify({ message: e.message, severity: 'error' })); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, state.status, state.entityType, state.subjectKind, dispatch]); // eslint-disable-line react-hooks/exhaustive-deps

  const typeOptions = (meta?.types || []).filter((x) => FACILITY_KINDS.some((k) => (meta?.typesBySubject[k] || []).includes(x.value)) && (!state.subjectKind || (meta?.typesBySubject[state.subjectKind] || []).includes(x.value)));
  const set = (patch: Partial<ListState>) => setState((x) => ({ ...x, ...patch, page: 1 }));
  const columns: Column<Licence>[] = [
    { key: 'licenseNo', label: t('facilities.licence'), mono: true, sortable: true, render: (r) => <b>{r.licenseNo}</b> },
    { key: 'entityName', label: t('facilities.entity'), sortable: true, render: (r) => <><span>{r.entityName}</span><Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{SUBJECT_KIND_LABEL[r.subjectKind] || r.subjectKind}</Typography></> },
    { key: 'entityType', label: t('facilities.type'), sortable: true, render: (r) => <><span>{r.typeLabel}</span><Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.classLabel}</Typography></>, exportValue: (r) => r.typeLabel },
    { key: 'status', label: t('facilities.status'), sortable: true, render: (r) => <StatusChip value={r.status} map={LICENCE_STATUS_META} /> },
    { key: 'issueDate', label: t('facilities.issued'), sortable: true, render: (r) => fmtD(r.issueDate) },
    { key: 'expiryDate', label: t('facilities.expires'), sortable: true, render: (r) => fmtD(r.expiryDate) },
    { key: 'performanceRating', label: t('facilities.performance'), sortable: true, render: (r) => (r.performanceRating ? <Rating value={r.performanceRating} precision={0.5} size="small" readOnly /> : '—') },
    { key: 'audits', label: t('facilities.audits'), align: 'right', render: (r) => r.audits?.length || 0 },
  ];
  const exportCols: ExportColumn[] = [
    { key: 'licenseNo', label: t('facilities.licence') }, { key: 'entityName', label: t('facilities.entity') }, { label: t('facilities.subjectKind'), value: (r: Licence) => SUBJECT_KIND_LABEL[r.subjectKind] || r.subjectKind },
    { key: 'typeLabel', label: t('facilities.type') }, { key: 'classLabel', label: t('facilities.instrumentClass') }, { key: 'status', label: t('facilities.status') },
    { label: t('facilities.issued'), value: (r: Licence) => fmtD(r.issueDate) }, { label: t('facilities.expires'), value: (r: Licence) => fmtD(r.expiryDate) },
    { key: 'performanceRating', label: t('facilities.performance'), align: 'right' }, { label: t('facilities.audits'), value: (r: Licence) => r.audits?.length || 0, align: 'right' }, { key: 'issuer', label: t('facilities.issuer') },
  ];

  return (
    <>
      <PageHeader icon={WorkspacePremiumRoundedIcon} iconColor="#2C6E52" title={t('facilities.registerTitle')} sub={t('facilities.registerSub')}
        actions={<>
          <ExportMenu name="licence-register" title={t('facilities.registerTitle')} columns={exportCols} getRows={() => api.get<Licence[]>('/licenses', { params: params({ limit: 500 }) }).then((r) => r.data)} />
          {hasPerm(user, 'facilities.manage') && <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setApplyOpen(true)}>{t('facilities.newApplication')}</Button>}
        </>} />
      <PageStats scope="facilities" />
      <DataTable<Licence>
        columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading} sort={state.sort}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => setState((x) => ({ ...x, limit, page: 1 }))} onSort={(sort) => setState((x) => ({ ...x, sort }))}
        search={state.q} onSearch={(q) => set({ q })} searchPlaceholder={t('facilities.searchPlaceholder')} onRowClick={(r) => navigate(`/facilities/${r.id}`)} emptyMessage={t('facilities.noInstruments')}
        toolbar={<>
          <TextField select size="small" label={t('facilities.subjectKind')} sx={{ minWidth: 150 }} value={state.subjectKind} onChange={(e) => set({ subjectKind: e.target.value, entityType: '' })}>
            <MenuItem value="">{t('facilities.all')}</MenuItem>{SUBJECT_KIND_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <TextField select size="small" label={t('facilities.type')} sx={{ minWidth: 220 }} value={state.entityType} onChange={(e) => set({ entityType: e.target.value })}>
            <MenuItem value="">{t('facilities.all')}</MenuItem>{typeOptions.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <TextField select size="small" label={t('facilities.status')} sx={{ minWidth: 150 }} value={state.status} onChange={(e) => set({ status: e.target.value })}>
            <MenuItem value="">{t('facilities.all')}</MenuItem>{STATUS_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          {meta && <Chip size="small" variant="outlined" label={t('facilities.typesAvailable', { count: typeOptions.length })} sx={{ fontSize: 11 }} />}
        </>} />
      <ApplicationDialog open={applyOpen} onClose={() => setApplyOpen(false)} onCreated={(id) => { setApplyOpen(false); navigate(`/facilities/${id}`); }} />
    </>
  );
}
