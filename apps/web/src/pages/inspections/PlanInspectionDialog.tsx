import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import FormFields from '../../components/common/FormFields';
import { toInputDT } from '../../utils/format';
import { TYPES } from './constants';
import type { ChecklistTemplate, PlanInspectionPayload, VesselOption } from './types';

/* Planning a survey: pick the ship, the survey type and the checklist template whose questions the survey copies. */
interface Props { open: boolean; onClose: () => void; onPlanned: (r: { id: string; number: string }) => void }

export default function PlanInspectionDialog({ open, onClose, onPlanned }: Props) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const user = useUser();
  const [values, setValues] = useState<Record<string, any>>({});
  const [vessels, setVessels] = useState<VesselOption[]>([]);
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({ plannedAt: toInputDT(new Date()), inspector: user?.name || '' });
    api.get<VesselOption[]>('/vessels', { params: { limit: 100, sort: 'name' } }).then((r) => setVessels(r.data)).catch(() => {});
    api.get<ChecklistTemplate[]>('/checklist-templates', { params: { limit: 50 } }).then((r) => setTemplates(r.data)).catch(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = () => {
    setBusy(true);
    const body: PlanInspectionPayload = { vesselId: values.vesselId, type: values.type, plannedAt: values.plannedAt, inspector: values.inspector, templateId: values.templateId || undefined, remarks: values.remarks || undefined };
    api.post<{ id: string; number: string }>('/inspections', body)
      .then((r) => { dispatch(notify(t('inspections.planned', { number: r.data.number }))); onClose(); onPlanned(r.data); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle>{t('inspections.planTitle')}</DialogTitle>
      <DialogContent sx={{ pt: '12px !important' }}>
        <FormFields fields={[
          { name: 'vesselId', label: 'Vessel', type: 'autocomplete', required: true, cols: 12, options: vessels.map((v) => ({ value: v.id, label: `${v.name} · IMO ${v.imo || '—'}` })) },
          { name: 'type', label: 'Inspection type', type: 'select', required: true, options: TYPES.map((x) => ({ value: x, label: x })) },
          { name: 'plannedAt', label: 'Planned date/time', type: 'datetime', required: true },
          { name: 'inspector', label: 'Inspector', required: true },
          { name: 'templateId', label: 'Checklist template', type: 'select', options: templates.map((x) => ({ value: x.id || '', label: `${x.name} (${x.items.length} items)` })) },
          { name: 'remarks', label: 'Remarks', type: 'multiline', cols: 12 },
        ]} values={values} onChange={setValues} />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" disabled={busy || !values.vesselId || !values.type || !values.inspector} onClick={create}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}
