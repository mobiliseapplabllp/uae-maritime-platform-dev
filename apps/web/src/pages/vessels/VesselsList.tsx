import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chip } from '@mui/material';
import DirectionsBoatFilledRoundedIcon from '@mui/icons-material/DirectionsBoatFilledRounded';
import api from '../../api/client';
import CrudPage from '../../components/common/CrudPage';
import StatusChip from '../../components/common/StatusChip';
import EntityHover from '../../components/common/EntityHover';
import { fmtNum } from '../../utils/format';
import { useProfile } from '../../config/runtime';
import type { Option } from '../../types';
import { TYPE_LABELS, VESSEL_STATUS_META } from './shared';
import type { Lookup, Vessel } from './types';

const FALLBACK_TYPES: Option[] = Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }));
const lookups = (category: string) => api.get<Lookup[]>('/lookups', { params: { category, limit: 200 } }).then((r) => r.data.filter((l) => l.active !== false));

export default function VesselsList() {
  const navigate = useNavigate();
  const profile = useProfile();
  const [types, setTypes] = useState<Option[]>([]);
  const [agents, setAgents] = useState<Option[]>([]);
  useEffect(() => {
    lookups('vesselType').then((rows) => setTypes(rows.map((l) => ({ value: l.code, label: l.label })))).catch(() => {});
    lookups('agent').then((rows) => setAgents(rows.map((l) => ({ value: l.code, label: `${l.code} · ${l.label}` })))).catch(() => {});
  }, []);
  const typeOpts = types.length ? types : FALLBACK_TYPES;
  // The jurisdiction's own flag leads the list; the rest are the open registries most often seen alongside it.
  const flags: Option[] = [profile.name, 'Panama', 'Liberia', 'Marshall Islands', 'Singapore', 'Malta', 'Hong Kong'].map((f) => ({ value: f, label: f }));

  return (
    <CrudPage<Vessel>
      statsScope="vessels" icon={DirectionsBoatFilledRoundedIcon} iconColor="#3B6FB6" title="Vessel registry" sub="Ships known to the port, with their particulars and certificates"
      entityName="vessel" endpoint="/vessels" permBase="vessels" perms={{ create: 'vessels.create', edit: 'vessels.edit', del: 'vessels.delete' }}
      defaultSort="name" searchPlaceholder="Search name, IMO, call sign…" onRowClick={(r) => navigate(`/vessels/${r.id}`)}
      columns={[
        { key: 'name', label: 'Vessel', render: (r) => <EntityHover type="vessel" id={r.id}><b>{r.name}</b></EntityHover> },
        { key: 'imo', label: 'IMO', mono: true },
        { key: 'type', label: 'Type', render: (r) => <Chip size="small" variant="outlined" label={r.type} sx={{ height: 20, fontSize: 11 }} /> },
        { key: 'flag', label: 'Flag' },
        { key: 'grt', label: 'GRT', align: 'right', render: (r) => fmtNum(r.grt), mono: true },
        { key: 'loa', label: 'LOA (m)', align: 'right', mono: true },
        { key: 'agent', label: 'Agent', mono: true },
        { key: 'classSociety', label: 'Class' },
        { key: 'status', label: 'Status', render: (r) => <StatusChip value={r.status} map={VESSEL_STATUS_META} /> },
      ]}
      filters={[{ name: 'type', label: 'Type', options: typeOpts }, { name: 'flag', label: 'Flag', options: flags }]}
      formFields={[
        { name: 'name', label: 'Vessel name', required: true },
        { name: 'imo', label: 'IMO number', required: true, helper: '7 digits' },
        { name: 'type', label: 'Type', type: 'select', required: true, options: typeOpts },
        { name: 'flag', label: 'Flag state', type: 'select', required: true, options: flags },
        { name: 'mmsi', label: 'MMSI' }, { name: 'callSign', label: 'Call sign' },
        { name: 'built', label: 'Year built', type: 'number' }, { name: 'classSociety', label: 'Class society' },
        { name: 'grt', label: 'GRT', type: 'number', required: true }, { name: 'dwt', label: 'DWT', type: 'number' },
        { name: 'loa', label: 'LOA (m)', type: 'number' }, { name: 'beam', label: 'Beam (m)', type: 'number' },
        { name: 'maxDraft', label: 'Max draft (m)', type: 'number' },
        agents.length ? { name: 'agent', label: 'Agent', type: 'autocomplete', options: agents } : { name: 'agent', label: 'Agent code' },
        { name: 'owner', label: 'Registered owner', cols: 12 },
        { name: 'status', label: 'Status', type: 'select', options: Object.entries(VESSEL_STATUS_META).map(([value, m]) => ({ value, label: m.label })) },
      ]}
      defaults={{ status: 'ACTIVE', flag: profile.name }}
      deleteMessage={(r) => `Delete ${r?.name}? Vessels with port-call history cannot be deleted.`}
    />
  );
}
