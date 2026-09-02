import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chip, Stack, Tooltip, Typography } from '@mui/material';
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded';
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded';
import api from '../api/client';
import PageStats from '../components/common/PageStats';
import PageHeader from '../components/common/PageHeader';
import DataTable from '../components/common/DataTable';
import StatusChip from '../components/common/StatusChip';
import EntityHover from '../components/common/EntityHover';
import { CERT_STATUS_META } from '../utils/status';
import { fmtD } from '../utils/format';
import type { FleetCertificateRow } from './vessels/types';

type Row = FleetCertificateRow & { id: string };
interface State { rows: Row[]; total: number; page: number; limit: number; q: string; status: string; notInForce: boolean; loading: boolean }

export default function CertificatesPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ rows: [], total: 0, page: 1, limit: 25, q: '', status: '', notInForce: false, loading: true });

  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<FleetCertificateRow[]>('/vessels/certificates/all', { params: { page: state.page, limit: state.limit, q: state.q || undefined, status: state.status || undefined, notInForce: state.notInForce ? 'true' : undefined } })
      .then((r) => setState((x) => ({ ...x, rows: r.data.map((c, i) => ({ ...c, id: `${c.certId}-${i}` })), total: r.meta?.total ?? r.data.length, loading: false })))
      .catch(() => setState((x) => ({ ...x, loading: false })));
  }, [state.page, state.limit, state.q, state.status, state.notInForce]);

  return (
    <>
      <PageHeader icon={WorkspacePremiumRoundedIcon} iconColor="#3B6FB6" title="Fleet certificates" sub="Statutory certificates across all active vessels, ordered by expiry. A certificate this administration issued also carries its survey endorsements and its signature." />
      <PageStats scope="certificates" />
      <DataTable<Row>
        columns={[
          { key: 'vesselName', label: 'Vessel', render: (r) => <EntityHover type="vessel" id={r.vesselId}><b>{r.vesselName}</b></EntityHover> },
          { key: 'imo', label: 'IMO', mono: true },
          { key: 'certType', label: 'Certificate' },
          { key: 'number', label: 'Number', mono: true },
          { key: 'issuer', label: 'Issuer' },
          { key: 'expiryDate', label: 'Expires', render: (r) => fmtD(r.expiryDate) },
          { key: 'status', label: 'Status', render: (r) => <StatusChip value={r.status} map={CERT_STATUS_META} /> },
          /* The column that earns its place: a certificate can be unexpired and still not in force because a survey window closed unendorsed. */
          { key: 'inForce', label: 'On the register', render: (r) => {
            if (!r.onRegister) return <Typography component="span" sx={{ color: 'text.secondary', fontSize: 12 }}>Issued elsewhere</Typography>;
            return (
              <Stack direction="row" spacing={0.5} alignItems="center">
                {r.inForce
                  ? <Chip size="small" color="success" label="In force" sx={{ height: 21, fontSize: 11 }} />
                  : <Tooltip title={r.forceReason || ''}><Chip size="small" color="error" label="Not in force" sx={{ height: 21, fontSize: 11 }} /></Tooltip>}
                {r.signed && <Tooltip title="Digitally signed — the register entry still matches the signature taken at issue"><VerifiedRoundedIcon titleAccess="Digitally signed" sx={{ fontSize: 17, color: 'success.main' }} /></Tooltip>}
              </Stack>
            );
          } },
        ]}
        rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => setState((x) => ({ ...x, limit, page: 1 }))}
        search={state.q} onSearch={(q) => setState((x) => ({ ...x, q, page: 1 }))} searchPlaceholder="Search vessel or certificate…"
        onRowClick={(r) => navigate(`/vessels/${r.vesselId}`)}
        toolbar={
          <Stack direction="row" spacing={0.75} role="group" aria-label="Certificate status filter">
            {['', 'EXPIRED', 'EXPIRING', 'VALID'].map((s) => (
              <Chip key={s || 'all'} size="small" label={s ? CERT_STATUS_META[s].label : 'All'} color={state.status === s && s ? CERT_STATUS_META[s].color : 'default'}
                variant={state.status === s ? 'filled' : 'outlined'} aria-pressed={state.status === s} onClick={() => setState((x) => ({ ...x, status: s, page: 1 }))} />
            ))}
            <Chip size="small" label="Survey overdue" color={state.notInForce ? 'error' : 'default'} variant={state.notInForce ? 'filled' : 'outlined'} aria-pressed={state.notInForce}
              onClick={() => setState((x) => ({ ...x, notInForce: !x.notInForce, page: 1 }))} />
          </Stack>
        } />
    </>
  );
}
