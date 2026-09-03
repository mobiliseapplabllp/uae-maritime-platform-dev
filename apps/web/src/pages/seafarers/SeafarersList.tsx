import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chip, Badge } from '@mui/material';
import BadgeRoundedIcon from '@mui/icons-material/BadgeRounded';
import CrudPage from '../../components/common/CrudPage';
import EntityHover from '../../components/common/EntityHover';
import StatusChip from '../../components/common/StatusChip';
import { SEAFARER_STATUS_META } from '../../utils/status';
import { fmtNum, toInputD } from '../../utils/format';
import { useProfile } from '../../config/runtime';
import { RANK_OPTIONS } from './shared';
import type { SeafarerRow } from './types';

/* The seafarer register — crew identity, competency documents and verified sea service. A row opens the full record. */
const STATUS_OPTIONS = Object.entries(SEAFARER_STATUS_META).map(([value, m]) => ({ value, label: m.label }));

export default function SeafarersList() {
  const navigate = useNavigate();
  const profile = useProfile();
  const { t } = useTranslation();
  const idLabel = profile.identity?.seafarerIdLabel || 'Seafarer ID';
  const nationalLabel = profile.identity?.nationalIdLabel || 'National ID';

  return (
    <CrudPage<SeafarerRow>
      statsScope="seafarers" icon={BadgeRoundedIcon} iconColor="#75479C" title={t('seafarers.registerTitle')} sub={t('seafarers.registerSub')}
      entityName="seafarer" endpoint="/seafarers" perms={{ create: 'seafarers.create', edit: 'seafarers.edit', del: 'seafarers.delete' }}
      defaultSort="name" searchPlaceholder={t('seafarers.searchPlaceholder', { id: idLabel })} exportName="seafarers"
      onRowClick={(r) => navigate(`/seafarers/${r.id}`)}
      columns={[
        { key: 'name', label: t('seafarers.seafarer'), sortable: true, render: (r) => <EntityHover type="seafarer" id={r.id}><b>{r.name}</b></EntityHover> },
        { key: 'cdcNo', label: t('seafarers.cdcNo'), mono: true },
        { key: 'seafarerId', label: idLabel, mono: true, render: (r) => r.seafarerId || '—' },
        { key: 'rank', label: t('seafarers.rank'), sortable: true },
        { key: 'nationality', label: t('seafarers.nationality') },
        { key: 'currentVesselName', label: t('seafarers.onBoard'), render: (r) => (r.currentVesselId ? <EntityHover type="vessel" id={r.currentVesselId}><span>{r.currentVesselName}</span></EntityHover> : <Chip size="small" variant="outlined" label={t('seafarers.ashore')} sx={{ height: 20, fontSize: 10.5 }} />) },
        { key: 'certAlerts', label: t('seafarers.certAlerts'), align: 'center', render: (r) => (r.certAlerts ? <Badge badgeContent={r.certAlerts} color="error"><Chip size="small" label={t('seafarers.review')} color="warning" variant="outlined" sx={{ height: 20, fontSize: 10.5 }} /></Badge> : '—') },
        { key: 'totalSeaDays', label: t('seafarers.seaDays'), align: 'right', render: (r) => fmtNum(r.totalSeaDays), mono: true },
        { key: 'status', label: t('seafarers.status'), render: (r) => <StatusChip value={r.status} map={SEAFARER_STATUS_META} /> },
      ]}
      filters={[{ name: 'rank', label: t('seafarers.rank'), options: RANK_OPTIONS }, { name: 'status', label: t('seafarers.status'), options: STATUS_OPTIONS }]}
      formFields={[
        { name: 'name', label: t('seafarers.fullName'), required: true },
        { name: 'rank', label: t('seafarers.rank'), type: 'select', required: true, options: RANK_OPTIONS },
        { name: 'cdcNo', label: t('seafarers.cdcNumber'), required: true, helper: t('seafarers.cdcHelper') },
        { name: 'seafarerId', label: t('seafarers.idNumber', { id: idLabel }) },
        { name: 'nationalId', label: nationalLabel },
        { name: 'dob', label: t('seafarers.dob'), type: 'date' },
        { name: 'nationality', label: t('seafarers.nationality') },
        { name: 'phone', label: t('seafarers.phone') }, { name: 'email', label: t('seafarers.email'), type: 'email' },
        { name: 'status', label: t('seafarers.status'), type: 'select', options: STATUS_OPTIONS },
        { name: 'remarks', label: t('seafarers.remarks'), type: 'multiline', cols: 12 },
      ]}
      defaults={{ nationality: profile.name, status: 'ACTIVE' }}
      toForm={(row) => ({ ...row, dob: toInputD(row.dob) })}
      deleteMessage={(r) => t('seafarers.deleteMessage', { name: r?.name })}
    />
  );
}
