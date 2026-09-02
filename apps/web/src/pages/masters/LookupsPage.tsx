import { useEffect, useState } from 'react';
import { Tabs, Tab, Box, Chip } from '@mui/material';
import ListAltRoundedIcon from '@mui/icons-material/ListAltRounded';
import api from '../../api/client';
import CrudPage from '../../components/common/CrudPage';
import type { LookupRow } from './mastersConfig';

interface Cat { key: string; label: string; count: number }
export default function LookupsPage() {
  const [cats, setCats] = useState<Cat[]>([]);
  const [cat, setCat] = useState('vesselType');
  useEffect(() => { api.get<Cat[]>('/lookups/categories').then((r) => setCats(r.data)).catch(() => {}); }, []);
  return (
    <>
      <Tabs value={cat} onChange={(_, c) => setCat(c)} sx={{ mb: 2 }} variant="scrollable" allowScrollButtonsMobile aria-label="Lookup categories">{cats.map((c) => <Tab key={c.key} value={c.key} label={c.label} />)}</Tabs>
      <Box key={cat}>
        <CrudPage<LookupRow> icon={ListAltRoundedIcon} iconColor="#5A6B78" title={cats.find((c) => c.key === cat)?.label || 'Lookups'} sub="Reference data used across forms, checks and billing" entityName="entry" endpoint="/lookups" permBase="masters" defaultSort="code"
          staticParams={{ category: cat }} searchPlaceholder="Search code or label…" exportName={`lookups-${cat}`}
          columns={[
            { key: 'code', label: 'Code', mono: true, sortable: true }, { key: 'label', label: 'Label' }, { key: 'labelAr', label: 'Arabic', render: (r) => r.labelAr || '—' },
            { key: 'meta', label: 'Attributes', render: (r) => { const entries = Object.entries(r.meta || {}).slice(0, 3); return entries.length ? entries.map(([k, v]) => <Chip key={k} size="small" variant="outlined" label={`${k}: ${String(v)}`} sx={{ mr: 0.5, height: 20, fontSize: 10.5 }} />) : '—'; }, exportValue: (r) => JSON.stringify(r.meta || {}) },
            { key: 'active', label: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
          ]}
          formFields={[{ name: 'code', label: 'Code', required: true }, { name: 'label', label: 'Label', required: true }, { name: 'labelAr', label: 'Label (Arabic)' }, { name: 'metaJson', label: 'Attributes (JSON)', type: 'multiline', cols: 12, rows: 3, helper: 'e.g. {"group":"dryBulk","unit":"MT","mtFactor":1}' }, { name: 'active', label: 'Active', type: 'switch' }]}
          defaults={{ active: true, metaJson: '{}' }}
          toForm={(row) => ({ code: row.code, label: row.label, labelAr: row.labelAr || '', metaJson: JSON.stringify(row.meta || {}), active: row.active })}
          transformOut={(v) => { let meta = {}; try { meta = JSON.parse(v.metaJson || '{}'); } catch { meta = {}; } return { category: cat, code: v.code, label: v.label, labelAr: v.labelAr || null, meta, active: v.active }; }} />
      </Box>
    </>
  );
}
