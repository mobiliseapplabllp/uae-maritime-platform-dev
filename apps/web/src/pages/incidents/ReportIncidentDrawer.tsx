import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import FormDrawer from '../../components/common/FormDrawer';
import FormFields from '../../components/common/FormFields';
import { titleCase } from '../../utils/format';
import { CATEGORIES, SEVERITIES, SOURCES, TYPES } from './constants';
import type { BerthOption, LookupOption, ReportIncidentPayload, VesselOption } from './types';

/* Logging a case: the first information in one slide-over. The desk assigns the number and the lifecycle opens at OPEN. */
interface Props { open: boolean; onClose: () => void; onLogged: (inc: { id: string; number: string }) => void }
const DEFAULTS = { severity: 'MEDIUM', category: 'MARINE', source: 'PORTAL' };

export default function ReportIncidentDrawer({ open, onClose, onLogged }: Props) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [values, setValues] = useState<Record<string, any>>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [vessels, setVessels] = useState<VesselOption[]>([]);
  const [berths, setBerths] = useState<BerthOption[]>([]);
  const [areas, setAreas] = useState<LookupOption[]>([]);

  useEffect(() => {
    if (!open) return;
    setValues({ ...DEFAULTS });
    api.get<VesselOption[]>('/vessels', { params: { limit: 100, sort: 'name' } }).then((r) => setVessels(r.data)).catch(() => {});
    api.get<BerthOption[]>('/berths', { params: { limit: 100 } }).then((r) => setBerths(r.data)).catch(() => {});
    api.get<LookupOption[]>('/lookups', { params: { category: 'incidentArea', limit: 100 } }).then((r) => setAreas(r.data)).catch(() => {});
  }, [open]);

  const submit = () => {
    setBusy(true);
    const body: ReportIncidentPayload = {
      title: values.title, category: values.category, type: values.type, severity: values.severity || undefined, source: values.source || undefined,
      vesselId: values.vesselId || undefined, vesselName: values.vesselName || undefined, berthId: values.berthId || undefined,
      location: values.area ? { area: values.area } : undefined, reportedBy: values.reportedBy || undefined, description: values.description || undefined,
    };
    api.post<{ id: string; number: string }>('/incidents', body)
      .then((r) => { dispatch(notify(t('incidents.logged', { number: r.data.number }))); onClose(); onLogged(r.data); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })))
      .finally(() => setBusy(false));
  };

  return (
    <FormDrawer open={open} title={t('incidents.logTitle')} subtitle={t('incidents.logSub')} onClose={() => !busy && onClose()} busy={busy} onSubmit={submit} submitLabel={t('incidents.logIncident')} disabled={!(values.type && values.title)}>
      <FormFields fields={[
        { name: 'title', label: 'Title', required: true, cols: 12, placeholder: 'What happened, where — one line' },
        { name: 'category', label: 'Category', type: 'select', required: true, options: CATEGORIES.map((c) => ({ value: c, label: titleCase(c) })) },
        { name: 'type', label: 'Incident type', type: 'select', required: true, options: TYPES.map((c) => ({ value: c, label: titleCase(c) })) },
        { name: 'severity', label: 'Severity', type: 'select', options: SEVERITIES.map((c) => ({ value: c, label: titleCase(c) })) },
        { name: 'source', label: 'Reported via', type: 'select', options: SOURCES.map((c) => ({ value: c, label: c })) },
        { name: 'vesselId', label: 'Vessel (registered)', type: 'select', options: vessels.map((v) => ({ value: v.id, label: v.name })) },
        { name: 'vesselName', label: 'Craft (unregistered)', placeholder: 'FV name / registration if not in the registry' },
        { name: 'berthId', label: 'Berth', type: 'select', options: berths.map((b) => ({ value: b.id, label: `${b.code} — ${b.terminal || ''}` })) },
        { name: 'area', label: 'Location / area (master)', type: 'select', options: areas.map((a) => ({ value: a.label, label: a.label })) },
        { name: 'reportedBy', label: 'Reported by', placeholder: 'Defaults to you' },
        { name: 'description', label: 'First information', type: 'multiline', rows: 3, cols: 12 },
      ]} values={values} onChange={setValues} />
    </FormDrawer>
  );
}
