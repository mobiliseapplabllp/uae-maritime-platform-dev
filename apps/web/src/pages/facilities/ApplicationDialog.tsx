import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography } from '@mui/material';
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import FormFields from '../../components/common/FormFields';
import { useProfile } from '../../config/runtime';
import type { FieldSpec } from '../../types';
import { FACILITY_KINDS, SUBJECT_KIND_OPTIONS } from './shared';
import type { ApplicationPayload, BerthOption, Company, Licence, LicenceMeta, SubjectKind } from './types';

/* A new application — the instrument is issued against a directory record (company, port facility or institution) or, for an applicant not yet on the directory, against a name.
 * The type list follows the subject kind, exactly as the engine enforces it. */
interface Preset { subjectKind?: SubjectKind; subjectRef?: string; entityName?: string }
let META: LicenceMeta | null = null;

export default function ApplicationDialog({ open, onClose, onCreated, preset }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; preset?: Preset }) {
  const dispatch = useAppDispatch();
  const profile = useProfile();
  const { t } = useTranslation();
  const [meta, setMeta] = useState<LicenceMeta | null>(META);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [berths, setBerths] = useState<BerthOption[]>([]);
  const [vals, setVals] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setVals({ subjectKind: preset?.subjectKind || 'COMPANY', subjectRef: preset?.subjectRef || '', entityName: preset?.entityName || '' });
    if (!META) api.get<LicenceMeta>('/licenses/meta').then((r) => { META = r.data; setMeta(r.data); }).catch(() => {});
    api.get<Company[]>('/companies', { params: { limit: 200, sort: 'name' } }).then((r) => setCompanies(r.data)).catch(() => {});
    api.get<BerthOption[]>('/berths', { params: { limit: 200, sort: 'code' } }).then((r) => setBerths(r.data)).catch(() => {});
  }, [open, preset?.subjectKind, preset?.subjectRef, preset?.entityName]);

  const kind: SubjectKind = FACILITY_KINDS.includes(vals.subjectKind) ? vals.subjectKind : 'COMPANY';
  const typeOptions = (meta?.typesBySubject[kind] || []).map((v) => ({ value: v, label: meta?.types.find((x) => x.value === v)?.label || v }));
  const subjectOptions = kind === 'PORT_FACILITY' ? berths.map((b) => ({ value: b.id, label: `${b.code}${b.terminal ? ` — ${b.terminal}` : ''}` })) : companies.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }));
  const subjectName = (id: string) => (kind === 'PORT_FACILITY' ? berths.find((b) => b.id === id)?.name || berths.find((b) => b.id === id)?.code : companies.find((c) => c.id === id)?.name) || '';
  const change = (v: Record<string, any>) => {
    const next = { ...v };
    if (next.subjectKind !== vals.subjectKind) { next.subjectRef = ''; next.entityType = ''; }
    if (next.subjectRef && next.subjectRef !== vals.subjectRef) next.entityName = subjectName(next.subjectRef);
    setVals(next);
  };
  const fields: FieldSpec[] = [
    { name: 'subjectKind', label: t('facilities.subjectKind'), type: 'select', required: true, options: SUBJECT_KIND_OPTIONS, disabled: !!preset?.subjectKind },
    { name: 'entityType', label: t('facilities.licenceType'), type: 'select', required: true, options: typeOptions },
    { name: 'subjectRef', label: t('facilities.directoryRecord'), type: 'autocomplete', cols: 12, options: subjectOptions, helper: t('facilities.directoryRecordHelper'), disabled: !!preset?.subjectRef },
    { name: 'entityName', label: t('facilities.entityName'), cols: 12, required: !vals.subjectRef, disabled: !!vals.subjectRef },
    { name: 'contactPerson', label: t('facilities.contactPerson') }, { name: 'phone', label: t('facilities.phone') },
    { name: 'email', label: t('facilities.email'), type: 'email' }, { name: 'taxId', label: profile.tax.registrationLabel },
    { name: 'address', label: t('facilities.address'), type: 'multiline', cols: 12 },
    { name: 'conditions', label: t('facilities.conditions'), type: 'multiline', cols: 12 },
  ];
  const submit = () => {
    setBusy(true);
    const body: ApplicationPayload = { subjectKind: kind, subjectRef: vals.subjectRef || null, entityType: vals.entityType, entityName: vals.entityName || undefined, contactPerson: vals.contactPerson || undefined, phone: vals.phone || undefined, email: vals.email || undefined, address: vals.address || undefined, taxId: vals.taxId || undefined, conditions: vals.conditions || undefined };
    api.post<Licence>('/licenses', body).then((r) => { dispatch(notify(t('facilities.applicationReceived', { no: r.data.licenseNo }))); onCreated(r.data.id); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))).finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><WorkspacePremiumRoundedIcon aria-hidden sx={{ color: '#2C6E52' }} /> {t('facilities.newApplication')}</DialogTitle>
      <DialogContent sx={{ pt: '12px !important' }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t('facilities.applicationHint')}</Typography>
        <FormFields fields={fields} values={vals} onChange={change} />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !vals.entityType || (!vals.subjectRef && !vals.entityName)}>{t('facilities.submitApplication')}</Button>
      </DialogActions>
    </Dialog>
  );
}
