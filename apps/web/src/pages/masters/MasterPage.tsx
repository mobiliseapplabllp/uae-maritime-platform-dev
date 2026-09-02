import { useParams } from 'react-router-dom';
import { Chip } from '@mui/material';
import CrudPage from '../../components/common/CrudPage';
import { StatePage } from '../../components/common/StatePage';
import { masterByKey, type LookupRow } from './mastersConfig';

/* Generic master editor — full CRUD + export over /lookups for one category. */
export default function MasterPage() {
  const { category } = useParams();
  const m = masterByKey(category);
  if (!m) return <StatePage code="404" title="Unknown master" message={`No master is configured for "${category}".`} />;
  const metaFields = m.metaFields || [];
  return (
    <CrudPage<LookupRow> key={m.key} title={m.name} sub={`${m.desc} — maintained in Data Studio`} icon={m.icon} iconColor={m.color} entityName="entry" endpoint="/lookups" permBase="masters" statsScope="masters"
      staticParams={{ category: m.key }} defaultSort="code" exportName={`master-${m.key}`} searchPlaceholder="Search code or label…"
      columns={[
        { key: 'code', label: 'Code', mono: true, sortable: true }, { key: 'label', label: 'Label', sortable: true }, { key: 'labelAr', label: 'Arabic', render: (r) => r.labelAr || '—' },
        ...(m.extraColumns || []),
        { key: 'active', label: 'Status', render: (r) => <Chip size="small" label={r.active === false ? 'Inactive' : 'Active'} color={r.active === false ? 'default' : 'success'} sx={{ height: 20 }} />, exportValue: (r) => (r.active === false ? 'Inactive' : 'Active') },
      ]}
      crumbs={[{ label: 'Data Studio', to: '/masters' }, { label: m.name }]}
      formFields={[{ name: 'code', label: 'Code', required: true }, { name: 'label', label: 'Label', required: true }, { name: 'labelAr', label: 'Label (Arabic)' }, ...metaFields.map((f) => ({ ...f, name: `meta_${f.name}` })), { name: 'active', label: 'Active', type: 'switch' }]}
      defaults={{ active: true }}
      toForm={(row) => ({ code: row.code, label: row.label, labelAr: row.labelAr || '', active: row.active !== false, ...Object.fromEntries(metaFields.map((f) => [`meta_${f.name}`, row.meta?.[f.name] ?? ''])) })}
      transformOut={(values) => ({ category: m.key, code: values.code, label: values.label, labelAr: values.labelAr || null, active: values.active, meta: Object.fromEntries(metaFields.map((f) => [f.name, values[`meta_${f.name}`]])) })}
      deleteMessage={(row) => `Remove ${row?.code} — ${row?.label} from ${m.name}? Records referencing it keep their stored value.`} />
  );
}
