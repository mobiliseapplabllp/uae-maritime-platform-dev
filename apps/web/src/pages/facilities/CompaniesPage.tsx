import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chip, Rating } from '@mui/material';
import CorporateFareRoundedIcon from '@mui/icons-material/CorporateFareRounded';
import CrudPage from '../../components/common/CrudPage';
import StatusChip from '../../components/common/StatusChip';
import { useProfile } from '../../config/runtime';
import { toInputD } from '../../utils/format';
import { useLookups } from '../../hooks/useLookups';
import { COMPANY_STATUS_META, COMPANY_STATUS_OPTIONS } from './shared';
import type { Company } from './types';

/* Port companies directory — every organisation working inside port limits. */
export default function CompaniesPage() {
  const navigate = useNavigate();
  const profile = useProfile();
  const { t } = useTranslation();
  const taxLabel = profile.tax.registrationLabel;
  const regLabel = profile.identity?.companyIdLabel || 'Registration no.';
  const categories = useLookups('companyCategory');
  return (
    <CrudPage<Company>
      title={t('facilities.companiesTitle')} sub={t('facilities.companiesSub')} icon={CorporateFareRoundedIcon} iconColor="#2C6E52"
      entityName="company" endpoint="/companies" permBase="facilities" exportName="port-companies" defaultSort="name" statsScope="facilities"
      searchPlaceholder={t('facilities.companySearch', { tax: taxLabel })} onRowClick={(r) => navigate(`/companies/${r.id}`)}
      columns={[
        { key: 'code', label: t('facilities.code'), mono: true, sortable: true },
        { key: 'name', label: t('facilities.company'), sortable: true, render: (r) => <b>{r.name}</b> },
        { key: 'category', label: t('facilities.category'), sortable: true, render: (r) => categories.label(r.category), exportValue: (r) => categories.label(r.category) },
        { key: 'contactName', label: t('facilities.contact'), render: (r) => r.contactName || '—' },
        { key: 'taxId', label: taxLabel, mono: true, render: (r) => r.taxId || '—' },
        { key: 'rating', label: t('facilities.rating'), sortable: true, render: (r) => (r.rating ? <Rating value={r.rating} precision={0.5} size="small" readOnly /> : '—'), exportValue: (r) => r.rating || '' },
        { key: 'status', label: t('facilities.status'), render: (r) => <StatusChip value={r.status} map={COMPANY_STATUS_META} /> },
        { key: 'real', label: '', noExport: true, render: (r) => (r.real ? <Chip size="small" variant="outlined" label={t('facilities.documentedOperator')} sx={{ height: 18, fontSize: 9.5 }} /> : null) },
      ]}
      filters={[{ name: 'category', label: t('facilities.category'), lookup: 'companyCategory' }, { name: 'status', label: t('facilities.status'), options: COMPANY_STATUS_OPTIONS }]}
      formFields={[
        { name: 'code', label: t('facilities.shortCode'), required: true }, { name: 'name', label: t('facilities.companyName'), required: true },
        { name: 'nameAr', label: t('facilities.companyNameAr'), cols: 12 },
        { name: 'category', label: t('facilities.category'), type: 'select', required: true, lookup: 'companyCategory' },
        { name: 'contactName', label: t('facilities.contactPerson') }, { name: 'contactPhone', label: t('facilities.phone') }, { name: 'contactEmail', label: t('facilities.email'), type: 'email' },
        { name: 'address', label: t('facilities.address'), cols: 12 },
        { name: 'taxId', label: taxLabel }, { name: 'registrationNo', label: regLabel },
        { name: 'status', label: t('facilities.status'), type: 'select', options: COMPANY_STATUS_OPTIONS },
        { name: 'rating', label: t('facilities.performanceRating'), type: 'number' },
        { name: 'onboardedAt', label: t('facilities.onboarded'), type: 'date' },
      ]}
      defaults={{ status: 'ACTIVE', rating: 0 }}
      toForm={(row) => ({ ...row, onboardedAt: toInputD(row.onboardedAt) })}
      transformOut={(v) => ({ ...v, nameAr: v.nameAr || null, rating: v.rating === '' || v.rating === undefined ? 0 : Number(v.rating), onboardedAt: v.onboardedAt || null })}
      deleteMessage={(row) => t('facilities.deleteCompany', { name: row?.name })}
    />
  );
}
