import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chip, Typography } from '@mui/material';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import FormFields from '../../components/common/FormFields';
import StatusChip from '../../components/common/StatusChip';
import { OpenLink } from '../../components/dashboard/kit';
import { fmtD, fmtDT, fmtMoney, fromNow } from '../../utils/format';
import type { Column } from '../../types';
import { REQUEST_STATUS_META, type RequestRow } from './types';

/* The applications register — every application lodged against the catalogue, as the desk works it: what it is for,
 * who lodged it, where it stands and whether it is inside its service level. A row opens the application. GET /services/requests. */
interface ListState { rows: RequestRow[]; total: number; page: number; limit: number; q: string; sort: string; status: string; scope: string; loading: boolean }
const STATUS_OPTIONS = Object.entries(REQUEST_STATUS_META).map(([value, m]) => ({ value, label: m.label }));

export default function ApplicationsRegister() {
  const navigate = useNavigate(); const dispatch = useAppDispatch(); const user = useUser(); const { t, i18n } = useTranslation(); const ar = i18n.language === 'ar';
  const [params] = useSearchParams();
  const definition = params.get('definition') || undefined;
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: '-createdAt', status: '', scope: params.get('breached') === 'true' ? 'breached' : params.get('open') === 'true' ? 'open' : params.get('mine') === 'true' ? 'mine' : '', loading: true });
  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<RequestRow[]>('/services/requests', { params: { page: state.page, limit: state.limit, q: state.q || undefined, sort: state.sort, status: state.status || undefined, definition, open: state.scope === 'open' ? 'true' : undefined, breached: state.scope === 'breached' ? 'true' : undefined, mine: state.scope === 'mine' ? 'true' : undefined } })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { dispatch(notify({ message: e.message, severity: 'error' })); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, state.status, state.scope, definition, dispatch]);
  const columns: Column<RequestRow>[] = [
    { key: 'number', label: t('services.number', 'Application'), mono: true, sortable: true },
    { key: 'definitionName', label: t('services.service', 'Service'), sortable: true, render: (r) => <><b>{ar && r.definitionNameAr ? r.definitionNameAr : r.definitionName}</b><Typography variant="caption" color="text.secondary" component="div">{r.category}</Typography></> },
    { key: 'subjectName', label: t('services.subject', 'Subject'), sortable: true, render: (r) => r.subjectName || '—' },
    { key: 'applicant', label: t('services.applicant', 'Applicant'), render: (r) => <>{r.applicant?.organisation || r.applicant?.name || '—'}{r.applicant?.organisation && r.applicant?.name ? <Typography variant="caption" color="text.secondary" component="div">{r.applicant.name}</Typography> : null}</> },
    { key: 'status', label: t('services.status', 'Status'), sortable: true, render: (r) => <StatusChip value={r.status} map={REQUEST_STATUS_META} /> },
    { key: 'slaDueAt', label: t('services.dueBy', 'Due by'), sortable: true, render: (r) => (r.slaDueAt ? <Chip size="small" label={`${fmtD(r.slaDueAt)} · ${fromNow(r.slaDueAt)}`} color={r.slaBreached ? 'error' : new Date(r.slaDueAt).getTime() - Date.now() < 48 * 3600_000 && !r.closedAt ? 'warning' : 'default'} variant="outlined" sx={{ height: 20, fontSize: 10.5 }} /> : '—') },
    { key: 'fee', label: t('services.fee', 'Fee'), align: 'right', mono: true, render: (r) => (r.fees?.total ? `${fmtMoney(r.fees.total)}${r.payment?.status === 'PAID' ? ' ✓' : ''}` : '—') },
    { key: 'submittedAt', label: t('services.lodgedOn', 'Lodged'), sortable: true, render: (r) => (r.submittedAt ? fmtDT(r.submittedAt) : t('services.draft', 'draft')) },
    { key: 'assignee', label: t('services.assignee', 'Assignee'), render: (r) => r.assignee?.name || '—' },
  ];
  const scopeOptions = [{ value: '', label: t('services.everything', 'Everything') }, { value: 'open', label: t('services.openOnly', 'Open') }, { value: 'breached', label: t('services.breachedOnly', 'Past service level') }, { value: 'mine', label: t('services.mine', 'Lodged by me') }];
  return (
    <>
      <PageHeader icon={AccountTreeRoundedIcon} iconColor="#0E7C86" title={t('services.requestsTitle', 'Applications')} sub={definition ? t('services.requestsForService', { defaultValue: 'Applications for {{service}}', service: definition }) : t('services.requestsSub', 'Every application lodged against the catalogue — search, filter, open the file')}
        actions={<>{(hasPerm(user, 'services.apply') || hasPerm(user, 'services.manage')) && <OpenLink label={t('services.newApplication', 'New application')} to="/services" />}<OpenLink label={t('services.openDashboard', 'Dashboard')} to="/services/overview" /></>} />
      <DataTable columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading} sort={state.sort}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => setState((x) => ({ ...x, limit, page: 1 }))} onSort={(sort) => setState((x) => ({ ...x, sort }))}
        search={state.q} onSearch={(q) => setState((x) => ({ ...x, q, page: 1 }))} searchPlaceholder={t('services.searchRequests', 'Search by number, applicant, subject or service')}
        onRowClick={(r) => navigate(`/services/requests/${r.id}`)} emptyMessage={t('services.noRequests', 'No applications match')}
        toolbar={<FormFields fields={[{ name: 'status', label: t('services.status', 'Status'), type: 'select', options: STATUS_OPTIONS, cols: 6 }, { name: 'scope', label: t('services.show', 'Show'), type: 'select', options: scopeOptions, cols: 6 }]} values={{ status: state.status, scope: state.scope }} onChange={(v) => setState((x) => ({ ...x, status: v.status ?? '', scope: v.scope ?? '', page: 1 }))} />} />
    </>
  );
}
