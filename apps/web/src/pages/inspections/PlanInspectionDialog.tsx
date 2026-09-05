import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Autocomplete, Button, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Typography } from '@mui/material';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import FormFields from '../../components/common/FormFields';
import { useLookups } from '../../hooks/useLookups';
import { toInputDT } from '../../utils/format';
import { REGIME_LOOKUP } from './constants';
import type { ChecklistTemplate, PlanInspectionPayload, SubjectKind, SubjectOption } from './types';

/* Planning a survey: pick the regime from the master — which says what kind of subject it applies to — then the ship, company,
 * port facility or training institution, and the checklist template whose questions the survey copies. The dossier and the
 * prediction are made by the service the moment the survey is planned. */
interface Props { open: boolean; onClose: () => void; onPlanned: (r: { id: string; number: string }) => void }

export default function PlanInspectionDialog({ open, onClose, onPlanned }: Props) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const user = useUser();
  const regimes = useLookups(REGIME_LOOKUP);
  const [values, setValues] = useState<Record<string, any>>({});
  const [subject, setSubject] = useState<SubjectOption | null>(null);
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [busy, setBusy] = useState(false);

  const kind: SubjectKind = (regimes.meta(values.type)?.subjectKind as SubjectKind | undefined) ?? 'VESSEL';
  useEffect(() => {
    if (!open) return;
    setValues({ plannedAt: toInputDT(new Date()), inspector: user?.name || '' }); setSubject(null);
    api.get<ChecklistTemplate[]>('/checklist-templates', { params: { limit: 100 } }).then((r) => setTemplates(r.data)).catch(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // the subject list follows the regime: a ship regime lists ships, a facility regime lists the port's facilities
  const search = (q: string) => api.get<SubjectOption[]>('/inspections/subjects', { params: { kind, q, limit: 30 }, headers: { 'X-Quiet': '1' } }).then((r) => setSubjects(r.data)).catch(() => setSubjects([]));
  useEffect(() => { if (open) { setSubject(null); void search(''); } }, [kind, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const templateOptions = useMemo(() => templates.filter((x) => !values.type || x.inspectionType === values.type).map((x) => ({ value: x.id || '', label: `${x.name} (${x.items.length} items)` })), [templates, values.type]);

  const create = () => {
    setBusy(true);
    const body: PlanInspectionPayload = { type: values.type, subjectKind: kind, ...(kind === 'VESSEL' ? { vesselId: subject?.id } : { subjectId: subject?.id }), plannedAt: values.plannedAt, inspector: values.inspector, templateId: values.templateId || undefined, remarks: values.remarks || undefined };
    api.post<{ id: string; number: string }>('/inspections', body)
      .then((r) => { dispatch(notify(t('inspections.planned', { number: r.data.number }))); onClose(); onPlanned(r.data); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })))
      .finally(() => setBusy(false));
  };
  const subjectLabel = (s: SubjectOption) => (s.kind === 'VESSEL' ? `${s.name} · IMO ${s.code || '—'}` : `${s.name}${s.code ? ` · ${s.code}` : ''}`);

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle>{t('inspections.planTitle')}</DialogTitle>
      <DialogContent sx={{ pt: '12px !important' }}>
        <FormFields fields={[
          { name: 'type', label: t('inspections.regime'), type: 'select', required: true, cols: 12, lookup: REGIME_LOOKUP, helper: t('inspections.regimeHelper', { kind: t(`inspections.subjectKind.${kind}`) }) },
        ]} values={values} onChange={(v) => { setValues(v); }} />
        <Autocomplete
          sx={{ my: 1.5 }} options={subjects} value={subject} getOptionLabel={subjectLabel} isOptionEqualToValue={(a, b) => a.id === b.id} filterOptions={(o) => o}
          onInputChange={(_, q, reason) => { if (reason === 'input') void search(q); }} onChange={(_, v) => setSubject(v)}
          renderInput={(p) => <TextField {...p} required label={t(`inspections.subjectKind.${kind}`)} placeholder={t('inspections.subjectSearch')} />} />
        <FormFields fields={[
          { name: 'plannedAt', label: t('inspections.plannedAt'), type: 'datetime', required: true },
          { name: 'inspector', label: t('inspections.inspector'), required: true },
          { name: 'templateId', label: t('inspections.template'), type: 'select', options: templateOptions, cols: 12 },
          { name: 'remarks', label: t('inspections.remarks'), type: 'multiline', cols: 12 },
        ]} values={values} onChange={setValues} />
        <Typography variant="caption" color="text.secondary">{t('inspections.planNote')}</Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="contained" disabled={busy || !subject || !values.type || !values.inspector} onClick={create}>{t('common.create')}</Button>
      </DialogActions>
    </Dialog>
  );
}
