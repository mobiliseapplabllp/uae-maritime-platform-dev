import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, DialogTitle, DialogContent, DialogActions, Typography } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import ViewTimelineRoundedIcon from '@mui/icons-material/ViewTimelineRounded';
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
import { PORTCALL_STATUS_META } from '../../utils/status';
import { fmtDT } from '../../utils/format';
import type { Column } from '../../types';
import { PURPOSES } from './constants';
import type { AnnouncePayload, LookupOption, PortCallRow, VesselOption } from './types';

/* The vessel-call register — every call from announcement to sailing. A call is announced here and then worked from its own page. */
interface ListState { rows: PortCallRow[]; total: number; page: number; limit: number; q: string; sort: string; status: string; loading: boolean }
const STATUS_OPTIONS = Object.entries(PORTCALL_STATUS_META).map(([value, m]) => ({ value, label: m.label }));

export default function PortCallsList() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: '-eta', status: '', loading: true });
  const [creating, setCreating] = useState(false);
  const [values, setValues] = useState<Record<string, any>>({});
  const [vessels, setVessels] = useState<VesselOption[]>([]);
  const [agents, setAgents] = useState<LookupOption[]>([]);
  const [busy, setBusy] = useState(false);
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));

  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<PortCallRow[]>('/port-calls', { params: { page: state.page, limit: state.limit, q: state.q || undefined, sort: state.sort, status: state.status || undefined } })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { dispatch(notify({ message: e.message, severity: 'error' })); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, state.status, dispatch]);

  const openCreate = () => {
    setCreating(true); setValues({});
    api.get<VesselOption[]>('/vessels', { params: { limit: 100, status: 'ACTIVE', sort: 'name' } }).then((r) => setVessels(r.data)).catch(() => {});
    api.get<LookupOption[]>('/lookups', { params: { category: 'agent', limit: 100 } }).then((r) => setAgents(r.data)).catch(() => {});
  };
  const create = () => {
    setBusy(true);
    const body: AnnouncePayload = {
      vesselId: values.vesselId, eta: values.eta, etd: values.etd || undefined, agentCode: values.agentCode || undefined, purpose: values.purpose || undefined,
      prevPort: values.prevPort || undefined, nextPort: values.nextPort || undefined, remarks: values.remarks || undefined,
    };
    api.post<{ id: string; vcn: string }>('/port-calls', body)
      .then((r) => { dispatch(notify(`Call ${r.data.vcn} announced`)); setCreating(false); navigate(`/port-calls/${r.data.id}`); })
      .catch(err).finally(() => setBusy(false));
  };

  const columns: Column<PortCallRow>[] = [
    { key: 'vcn', label: 'VCN', mono: true, sortable: true },
    { key: 'vesselName', label: 'Vessel', render: (r) => (r.vesselId ? <EntityHover type="vessel" id={r.vesselId}><b>{r.vesselName}</b></EntityHover> : '—') },
    { key: 'vesselType', label: 'Type', render: (r) => r.vesselType || '—' },
    { key: 'status', label: 'Status', render: (r) => <StatusChip value={r.status} map={PORTCALL_STATUS_META} /> },
    { key: 'eta', label: 'ETA', sortable: true, render: (r) => fmtDT(r.eta), mono: true },
    { key: 'berthCode', label: 'Berth', render: (r) => r.berthCode || '—', mono: true },
    { key: 'agentName', label: 'Agent' },
    { key: 'purpose', label: 'Purpose' },
  ];

  return (
    <>
      <PageHeader icon={ViewTimelineRoundedIcon} iconColor="#056A73" title="Port calls" sub="Every vessel call from announcement to sailing"
        actions={hasPerm(user, 'portcalls.create') && <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={openCreate}>Announce call</Button>} />
      <PageStats scope="portcalls" />
      <DataTable<PortCallRow>
        columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading} sort={state.sort}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => setState((x) => ({ ...x, limit, page: 1 }))} onSort={(sort) => setState((x) => ({ ...x, sort }))}
        search={state.q} onSearch={(q) => setState((x) => ({ ...x, q, page: 1 }))} searchPlaceholder="Search VCN…"
        onRowClick={(r) => navigate(`/port-calls/${r.id}`)}
        toolbar={(
          <FormFields fields={[{ name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS, cols: 12 }]} values={{ status: state.status }}
            onChange={(v) => setState((x) => ({ ...x, status: v.status, page: 1 }))} />
        )} />
      <Dialog open={creating} onClose={() => !busy && setCreating(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Announce port call</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>The call starts as <b>Announced</b> and moves through the lifecycle from its detail page.</Typography>
          <FormFields fields={[
            { name: 'vesselId', label: 'Vessel', type: 'autocomplete', required: true, cols: 12, options: vessels.map((v) => ({ value: v.id, label: `${v.name} · IMO ${v.imo}` })) },
            { name: 'eta', label: 'ETA (pilot station)', type: 'datetime', required: true },
            { name: 'etd', label: 'ETD (planned)', type: 'datetime' },
            { name: 'agentCode', label: 'Shipping agent', type: 'select', options: agents.map((a) => ({ value: a.code, label: a.label })) },
            { name: 'purpose', label: 'Purpose', type: 'select', options: PURPOSES.map((p) => ({ value: p, label: p })) },
            { name: 'prevPort', label: 'Last port', placeholder: 'SGSIN — Singapore' },
            { name: 'nextPort', label: 'Next port' },
            { name: 'remarks', label: 'Remarks', type: 'multiline', cols: 12 },
          ]} values={values} onChange={setValues} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setCreating(false)} disabled={busy}>Cancel</Button>
          <Button variant="contained" onClick={create} disabled={busy || !values.vesselId || !values.eta}>Announce</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
