import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@mui/material';
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded';
import PriceChangeRoundedIcon from '@mui/icons-material/PriceChangeRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageStats from '../../components/common/PageStats';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import FormFields from '../../components/common/FormFields';
import StatusChip from '../../components/common/StatusChip';
import EntityHover from '../../components/common/EntityHover';
import ExportMenu from '../../components/common/ExportMenu';
import { INVOICE_STATUS_META } from '../../utils/status';
import { fmtD, fmtMoney } from '../../utils/format';
import { useProfile } from '../../config/runtime';
import type { Column } from '../../types';
import type { ExportColumn } from '../../utils/exportUtils';
import type { InvoiceRow } from './types';

/* The invoice register — port charges billed per call: draft, issue, collect. A row opens the printable invoice. */
interface ListState { rows: InvoiceRow[]; total: number; page: number; limit: number; q: string; sort: string; status: string; loading: boolean }
const STATUS_OPTIONS = Object.entries(INVOICE_STATUS_META).map(([value, m]) => ({ value, label: m.label }));

export default function InvoicesList() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const profile = useProfile();
  const { t } = useTranslation();
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: '-createdAt', status: '', loading: true });

  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<InvoiceRow[]>('/invoices', { params: { page: state.page, limit: state.limit, q: state.q || undefined, sort: state.sort, status: state.status || undefined } })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { dispatch(notify({ message: e.message, severity: 'error' })); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, state.status, dispatch]);

  const columns: Column<InvoiceRow>[] = [
    { key: 'number', label: t('invoices.invoiceNo'), mono: true, sortable: true },
    { key: 'vesselName', label: t('invoices.vessel'), render: (r) => (r.vesselId ? <EntityHover type="vessel" id={r.vesselId}><b>{r.vesselName}</b></EntityHover> : r.vesselName || '—') },
    { key: 'vcn', label: t('invoices.call'), mono: true, render: (r) => r.vcn || '—' },
    { key: 'billTo', label: t('invoices.billedTo'), render: (r) => r.billTo?.name || '—' },
    { key: 'total', label: t('invoices.totalIncl', { tax: profile.tax.name }), align: 'right', sortable: true, render: (r) => fmtMoney(r.total), mono: true },
    { key: 'status', label: t('invoices.status'), render: (r) => <StatusChip value={r.status} map={INVOICE_STATUS_META} /> },
    { key: 'issuedAt', label: t('invoices.issued'), sortable: true, render: (r) => fmtD(r.issuedAt) },
    { key: 'dueAt', label: t('invoices.due'), render: (r) => fmtD(r.dueAt) },
    { key: 'paidAt', label: t('invoices.paid'), render: (r) => fmtD(r.paidAt) },
  ];
  const exportCols: ExportColumn[] = [
    { key: 'number', label: t('invoices.invoiceNo') }, { key: 'vesselName', label: t('invoices.vessel') }, { key: 'vcn', label: t('invoices.call') },
    { label: t('invoices.billedTo'), value: (r: InvoiceRow) => r.billTo?.name || '' }, { key: 'subtotal', label: t('invoices.subtotal'), align: 'right' },
    { label: profile.tax.name, value: (r: InvoiceRow) => r.taxAmount, align: 'right' }, { key: 'total', label: t('invoices.total'), align: 'right' },
    { key: 'status', label: t('invoices.status') }, { label: t('invoices.issued'), value: (r: InvoiceRow) => fmtD(r.issuedAt) }, { label: t('invoices.paid'), value: (r: InvoiceRow) => fmtD(r.paidAt) },
    { label: t('invoices.paymentRefShort'), value: (r: InvoiceRow) => r.paymentRef || '' },
  ];

  return (
    <>
      <PageHeader icon={ReceiptLongRoundedIcon} iconColor="#BD3861" title={t('invoices.title')} sub={t('invoices.sub')}
        actions={<>
          <ExportMenu name="invoices" title={t('invoices.title')} columns={exportCols} getRows={() => api.get<InvoiceRow[]>('/invoices', { params: { limit: 500, sort: state.sort, q: state.q || undefined, status: state.status || undefined } }).then((r) => r.data)} />
          {hasPerm(user, 'tariffs.view') && <Button size="small" variant="outlined" startIcon={<PriceChangeRoundedIcon />} onClick={() => navigate('/masters/tariffs')}>{t('invoices.tariffs')}</Button>}
        </>} />
      <PageStats scope="invoices" />
      <DataTable<InvoiceRow>
        columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading} sort={state.sort}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => setState((x) => ({ ...x, limit, page: 1 }))} onSort={(sort) => setState((x) => ({ ...x, sort }))}
        search={state.q} onSearch={(q) => setState((x) => ({ ...x, q, page: 1 }))} searchPlaceholder={t('invoices.searchPlaceholder')}
        onRowClick={(r) => navigate(`/invoices/${r.id}`)} emptyMessage={t('invoices.empty')}
        toolbar={<FormFields fields={[{ name: 'status', label: t('invoices.status'), type: 'select', options: STATUS_OPTIONS, cols: 12 }]} values={{ status: state.status }} onChange={(v) => setState((x) => ({ ...x, status: v.status ?? '', page: 1 }))} />} />
    </>
  );
}
