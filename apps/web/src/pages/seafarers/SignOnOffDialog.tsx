import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, Alert, Stack, Chip } from '@mui/material';
import DirectionsBoatRoundedIcon from '@mui/icons-material/DirectionsBoatRounded';
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded';
import api, { type ApiError } from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import FormFields from '../../components/common/FormFields';
import type { Seafarer, SignOnGate, SignOnPayload, SignOffResult, VesselOption } from './types';

/* Guided crew change. Sign-on is gated server-side on the medical, the CoC and STCW basic safety — a hard stop unless an officer overrides with a reason.
 * Sign-off closes the tour and writes a verified sea-service record automatically. */
export default function SignOnOffDialog({ seafarer, open, onClose, onDone }: { seafarer: Seafarer; open: boolean; onClose: () => void; onDone: () => void }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const isSignOn = !seafarer.currentVesselId;
  const [vessels, setVessels] = useState<VesselOption[]>([]);
  const [vals, setVals] = useState<Record<string, any>>({});
  const [gate, setGate] = useState<SignOnGate | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { setVals({}); setGate(null); return; }
    if (isSignOn) api.get<VesselOption[]>('/vessels', { params: { status: 'ACTIVE', limit: 200, sort: 'name' } }).then((r) => setVessels(r.data)).catch(() => {});
  }, [open, isSignOn]);

  const submit = (override: boolean) => {
    setBusy(true);
    const body: SignOnPayload = { vesselId: vals.vesselId, rank: vals.rank || undefined, override, overrideReason: vals.overrideReason || undefined };
    const req = isSignOn ? api.post(`/seafarers/${seafarer.id}/sign-on`, body) : api.post<SignOffResult>(`/seafarers/${seafarer.id}/sign-off`, { remarks: vals.remarks || undefined });
    req.then((r) => {
      const vesselName = vessels.find((v) => v.id === vals.vesselId)?.name || seafarer.currentVesselName || 'vessel';
      dispatch(notify(isSignOn ? t('seafarers.signedOnDone', { vessel: vesselName }) : t('seafarers.signedOffDone', { days: (r.data as SignOffResult).seaServiceDays })));
      onDone(); onClose();
    }).catch((e: ApiError) => {
      const payload = e.payload as { data?: SignOnGate } | undefined;
      if (e.status === 422) setGate(payload?.data || { failures: [e.message] });
      else dispatch(notify({ message: e.message, severity: 'error' }));
    }).finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {isSignOn ? <DirectionsBoatRoundedIcon aria-hidden sx={{ color: '#75479C' }} /> : <LogoutRoundedIcon aria-hidden sx={{ color: '#75479C' }} />}
        {isSignOn ? t('seafarers.signOn') : t('seafarers.signOff')}
      </DialogTitle>
      <DialogContent sx={{ pt: '12px !important' }}>
        {isSignOn ? (
          <>
            <FormFields fields={[
              { name: 'vesselId', label: t('seafarers.vessel'), type: 'autocomplete', required: true, cols: 12, options: vessels.map((v) => ({ value: v.id, label: `${v.name} — IMO ${v.imo}` })) },
              { name: 'rank', label: t('seafarers.signOnRank'), cols: 12 },
            ]} values={vals} onChange={setVals} />
            {gate && (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                <Typography sx={{ fontWeight: 700, fontSize: 13, mb: 0.5 }}>{t('seafarers.documentCheckFailed')}</Typography>
                <Stack spacing={0.25} sx={{ mb: 1 }}>{(gate.failures || []).map((f, i) => <Typography key={i} sx={{ fontSize: 12.5 }}>• {f}</Typography>)}</Stack>
                <FormFields fields={[{ name: 'overrideReason', label: t('seafarers.overrideReason'), cols: 12 }]} values={vals} onChange={setVals} />
              </Alert>
            )}
          </>
        ) : (
          <>
            <Chip label={t('seafarers.currentlyOn', { vessel: seafarer.currentVesselName || 'vessel' })} sx={{ mb: 1.5 }} />
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{t('seafarers.signOffHint')}</Typography>
            <FormFields fields={[{ name: 'remarks', label: t('seafarers.remarksOptional'), type: 'multiline', cols: 12 }]} values={vals} onChange={setVals} />
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        {isSignOn && !gate && <Button variant="contained" disabled={busy || !vals.vesselId} onClick={() => submit(false)}>{t('seafarers.checkAndSignOn')}</Button>}
        {isSignOn && gate && <Button variant="contained" color="error" disabled={busy || !vals.overrideReason} onClick={() => submit(true)}>{t('seafarers.overrideAndSignOn')}</Button>}
        {!isSignOn && <Button variant="contained" disabled={busy} onClick={() => submit(false)}>{t('seafarers.signOff')}</Button>}
      </DialogActions>
    </Dialog>
  );
}
