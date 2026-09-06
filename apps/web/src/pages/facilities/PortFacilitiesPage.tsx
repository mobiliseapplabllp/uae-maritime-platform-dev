import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MenuItem, TextField, Typography } from '@mui/material';
import AnchorRoundedIcon from '@mui/icons-material/AnchorRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import PageStats from '../../components/common/PageStats';
import DataTable from '../../components/common/DataTable';
import StatusChip from '../../components/common/StatusChip';
import ExportMenu from '../../components/common/ExportMenu';
import { useLookups } from '../../hooks/useLookups';
import { fmtD } from '../../utils/format';
import { MONO } from '../../theme';
import type { Column, StatCardData } from '../../types';
import type { ExportColumn } from '../../utils/exportUtils';
import { FACILITY_STATUS_META, ISPS_STATUS_META, REVIEW_FILTERS, REVIEW_STATUS_META } from './shared';
import type { PortFacility, SecurityReviewStats } from './types';

/* The port-facility register — every berth, terminal and jetty as a regulated subject: who operates it, where it stands
 * under the ISPS Code, and where the federal authority's security review of it stands. */
interface ListState { rows: PortFacility[]; total: number; page: number; limit: number; q: string; sort: string; facilityType: string; ispsStatus: string; review: string; loading: boolean }
interface Dashboard { kpis: { facilities: number; ispsCompliant: number }; securityReviews: SecurityReviewStats }
const ISPS_OPTIONS = Object.entries(ISPS_STATUS_META).map(([value, m]) => ({ value, label: m.label }));
const reviewLabel = (r: PortFacility['icpReview']) => (r ? REVIEW_STATUS_META[r.status]?.label ?? r.status : '');

export default function PortFacilitiesPage() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const types = useLookups('facilityType');
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: 'code', facilityType: '', ispsStatus: '', review: params.get('review') ?? '', loading: true });
  const [cards, setCards] = useState<StatCardData[] | undefined>(undefined);

  useEffect(() => {
    api.get<Dashboard>('/facilities/dashboard', { headers: { 'X-Quiet': '1' } }).then((r) => {
      const s = r.data.securityReviews;
      setCards([
        { label: t('facilities.kpiFacilities'), value: r.data.kpis.facilities, sub: t('facilities.kpiFacilitiesSub') },
        { label: t('facilities.kpiIspsCompliant'), value: r.data.kpis.ispsCompliant, sub: t('facilities.kpiIspsCompliantSub'), tone: 'success' },
        { label: t('facilities.kpiReviewsOpen'), value: s.open, sub: t('facilities.kpiReviewsOpenSub'), tone: s.open ? 'warning' : 'default' },
        { label: t('facilities.kpiReviewsCleared'), value: s.cleared12m, sub: t('facilities.kpiReviewsClearedSub', { rejected: s.rejected }), tone: s.rejected ? 'error' : 'info' },
      ]);
    }).catch(() => setCards([]));
  }, [t]);
  const query = (extra: Record<string, unknown> = {}) => ({ sort: state.sort, q: state.q || undefined, facilityType: state.facilityType || undefined, ispsStatus: state.ispsStatus || undefined, review: state.review || undefined, ...extra });
  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<PortFacility[]>('/facilities/port-facilities', { params: query({ page: state.page, limit: state.limit }) })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { dispatch(notify({ message: e.message, severity: 'error' })); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, state.facilityType, state.ispsStatus, state.review, dispatch]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<ListState>) => setState((x) => ({ ...x, ...patch, page: 1 }));

  const columns: Column<PortFacility>[] = [
    { key: 'code', label: t('facilities.code'), mono: true, sortable: true, render: (r) => <b>{r.code}</b> },
    { key: 'name', label: t('facilities.facility'), sortable: true, render: (r) => <><span style={{ fontWeight: 600 }}>{r.name}</span><Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.terminal || '—'}</Typography></> },
    { key: 'facilityType', label: t('facilities.facilityType'), sortable: true, render: (r) => types.label(r.facilityType) },
    { key: 'operatorName', label: t('facilities.operator'), sortable: true, render: (r) => r.operatorName || '—' },
    { key: 'ispsStatus', label: t('facilities.ispsStanding'), sortable: true, render: (r) => <><StatusChip value={r.ispsStatus} map={ISPS_STATUS_META} />{r.socNo && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: MONO }}>{r.socNo}</Typography>}</> },
    { key: 'socExpiry', label: t('facilities.socExpiry'), sortable: true, render: (r) => fmtD(r.socExpiry) },
    { key: 'reviewStatus', label: t('facilities.securityReview'), sortable: true, render: (r) => (r.icpReview
      ? <><StatusChip value={r.icpReview.status} map={REVIEW_STATUS_META} /><Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: MONO }}>{r.icpReview.reference}</Typography></>
      : <Typography variant="caption" color="text.secondary">{t('facilities.neverSubmitted')}</Typography>) },
    { key: 'status', label: t('facilities.status'), sortable: true, render: (r) => <StatusChip value={r.status} map={FACILITY_STATUS_META} /> },
  ];
  const exportCols: ExportColumn[] = [
    { key: 'code', label: t('facilities.code') }, { key: 'name', label: t('facilities.facility') }, { label: t('facilities.facilityType'), value: (r: PortFacility) => types.label(r.facilityType) },
    { key: 'terminal', label: t('facilities.terminal') }, { key: 'operatorName', label: t('facilities.operator') },
    { label: t('facilities.ispsStanding'), value: (r: PortFacility) => ISPS_STATUS_META[r.ispsStatus]?.label ?? r.ispsStatus }, { key: 'socNo', label: t('facilities.soc') }, { label: t('facilities.socExpiry'), value: (r: PortFacility) => fmtD(r.socExpiry) },
    { label: t('facilities.securityReview'), value: (r: PortFacility) => reviewLabel(r.icpReview) }, { label: t('facilities.reviewReference'), value: (r: PortFacility) => r.icpReview?.reference ?? '' },
    { key: 'pssoName', label: t('facilities.pfso') }, { label: t('facilities.status'), value: (r: PortFacility) => FACILITY_STATUS_META[r.status]?.label ?? r.status },
  ];

  return (
    <>
      <PageHeader icon={AnchorRoundedIcon} iconColor="#2C6E52" title={t('facilities.portFacilitiesTitle')} sub={t('facilities.portFacilitiesSub')}
        actions={<ExportMenu name="port-facilities" title={t('facilities.portFacilitiesTitle')} columns={exportCols} getRows={() => api.get<PortFacility[]>('/facilities/port-facilities', { params: query({ limit: 500 }) }).then((r) => r.data)} />} />
      <PageStats cards={cards} />
      <DataTable<PortFacility>
        columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading} sort={state.sort}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => setState((x) => ({ ...x, limit, page: 1 }))} onSort={(sort) => setState((x) => ({ ...x, sort }))}
        search={state.q} onSearch={(q) => set({ q })} searchPlaceholder={t('facilities.facilitySearch')} onRowClick={(r) => navigate(`/port-facilities/${r.id}`)} emptyMessage={t('facilities.noFacilities')}
        toolbar={<>
          <TextField select size="small" label={t('facilities.facilityType')} sx={{ minWidth: 150 }} value={state.facilityType} onChange={(e) => set({ facilityType: e.target.value })}>
            <MenuItem value="">{t('facilities.all')}</MenuItem>{types.options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <TextField select size="small" label={t('facilities.ispsStanding')} sx={{ minWidth: 160 }} value={state.ispsStatus} onChange={(e) => set({ ispsStatus: e.target.value })}>
            <MenuItem value="">{t('facilities.all')}</MenuItem>{ISPS_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <TextField select size="small" label={t('facilities.reviewFilter')} sx={{ minWidth: 180 }} value={state.review} onChange={(e) => set({ review: e.target.value })} inputProps={{ 'data-testid': 'review-filter' }}>
            <MenuItem value="">{t('facilities.all')}</MenuItem>{REVIEW_FILTERS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
        </>} />
    </>
  );
}
