import { useState } from 'react';
import { Chip, IconButton, Tooltip, Typography } from '@mui/material';
import PriceChangeRoundedIcon from '@mui/icons-material/PriceChangeRounded';
import TimelineRoundedIcon from '@mui/icons-material/TimelineRounded';
import CrudPage from '../../components/common/CrudPage';
import TariffHistoryDrawer, { type TariffLite, type Revision } from './TariffHistoryDrawer';
import { fmtD, fmtMoney } from '../../utils/format';
import { useProfile } from '../../config/runtime';

interface TariffRow extends TariffLite { category: string; active: boolean; revisions?: Revision[] }
const CATS = ['MARINE', 'CARGO', 'MISC'].map((c) => ({ value: c, label: c }));
const lastRevision = (r: TariffRow) => { const revs = r.revisions || []; return revs.length ? revs[revs.length - 1] : null; };

export default function TariffsPage() {
  const [history, setHistory] = useState<TariffLite | null>(null);
  const profile = useProfile();
  return (
    <>
      <CrudPage<TariffRow> icon={PriceChangeRoundedIcon} iconColor="#BD3861" title="Tariff master" sub="Rates applied when invoices are generated from a port call · click a row for its published rate history"
        entityName="tariff item" endpoint="/tariffs" permBase="tariffs" defaultSort="code" statsScope="tariffs" perms={{ create: 'tariffs.manage', edit: 'tariffs.manage', del: 'tariffs.manage' }} searchPlaceholder="Search code or name…" exportName="tariffs"
        onRowClick={(row) => setHistory(row)}
        columns={[
          { key: 'code', label: 'Code', mono: true, sortable: true }, { key: 'name', label: 'Charge' }, { key: 'category', label: 'Category' }, { key: 'unit', label: 'Unit' },
          { key: 'rate', label: 'Rate', align: 'right', render: (r) => fmtMoney(r.rate), mono: true },
          { key: 'revisions', label: 'Last revised', render: (r) => { const rev = lastRevision(r); if (!rev) return <Typography variant="caption" color="text.secondary">No history</Typography>; return <><Chip size="small" variant="outlined" color={rev.changePct >= 0 ? 'warning' : 'success'} label={`${rev.changePct >= 0 ? '+' : ''}${rev.changePct}%`} sx={{ height: 20, fontSize: 11, mr: 0.75 }} /><Typography component="span" variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>{fmtD(rev.effectiveFrom)}</Typography></>; }, exportValue: (r) => { const rev = lastRevision(r); return rev ? `${rev.changePct}% ${fmtD(rev.effectiveFrom)}` : ''; } },
          { key: 'active', label: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
        ]}
        filters={[{ name: 'category', label: 'Category', options: CATS }]}
        rowActionsExtra={(row) => <Tooltip title="Rate history"><IconButton size="small" aria-label="Rate history" onClick={() => setHistory(row)}><TimelineRoundedIcon fontSize="inherit" /></IconButton></Tooltip>}
        formFields={[
          { name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Charge name', required: true }, { name: 'category', label: 'Category', type: 'select', required: true, options: CATS },
          { name: 'unit', label: 'Unit', required: true, placeholder: 'per GRT / per TEU / per movement' }, { name: 'rate', label: `Rate (${profile.currency.code})`, type: 'number', required: true }, { name: 'active', label: 'Active', type: 'switch' },
        ]}
        defaults={{ category: 'MARINE', active: true }} />
      <TariffHistoryDrawer item={history} onClose={() => setHistory(null)} />
    </>
  );
}
