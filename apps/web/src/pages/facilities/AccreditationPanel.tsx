import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Grid, LinearProgress, Rating, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import FormFields from '../../components/common/FormFields';
import StatusChip from '../../components/common/StatusChip';
import { fmtD, toInputD } from '../../utils/format';
import { MONO } from '../../theme';
import type { FieldSpec } from '../../types';
import { cycleStatusMeta, useSchemes } from './accreditationShared';
import type { AccreditationCycle } from './types';

/* A company's accreditation position: the latest cycle under every scheme it has held, read against the calendar,
 * with the visits each cycle called for and the history of cycles behind it. */
interface Props { companyId: string; position: AccreditationCycle[]; canApprove: boolean; onChanged: () => void }
const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box><Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography><Typography component="div" sx={{ fontSize: 13, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography></Box>
);

export function CycleCard({ cycle }: { cycle: AccreditationCycle }) {
  const { t } = useTranslation(); const schemes = useSchemes();
  const live = cycle.status === 'CURRENT' || cycle.status === 'DUE';
  const progress = cycle.visitsRequired ? Math.min(100, Math.round((cycle.visitsDone / cycle.visitsRequired) * 100)) : 100;
  return (
    <Card variant="outlined" sx={{ p: 2, height: '100%' }} data-testid={`cycle-${cycle.category}`}>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap>
        <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{schemes.label(cycle.category)}</Typography>
        <StatusChip value={cycle.status} map={cycleStatusMeta(t)} />
      </Stack>
      <Typography variant="caption" color="text.secondary">{t('facilities.cycleNo', { n: cycle.cycleNo })}{cycle.instrumentNo ? ` · ${cycle.instrumentNo}` : ''}</Typography>
      <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
        <Grid item xs={6}><Item label={t('facilities.startsOn')} value={fmtD(cycle.startsOn)} /></Grid>
        <Grid item xs={6}><Item label={t('facilities.endsOn')} value={fmtD(cycle.endsOn)} /></Grid>
        <Grid item xs={6}><Item label={t('facilities.nextVisitDue')} value={cycle.nextVisitDue ? <Stack direction="row" spacing={0.5} alignItems="center"><span>{fmtD(cycle.nextVisitDue)}</span>{cycle.visitOverdue && <Chip size="small" color="error" label={t('facilities.visitOverdue')} sx={{ height: 18, fontSize: 10 }} />}</Stack> : '—'} /></Grid>
        <Grid item xs={6}><Item label={t('facilities.rating')} value={cycle.rating ? <Rating value={cycle.rating} precision={0.5} size="small" readOnly /> : t('facilities.notRated')} /></Grid>
      </Grid>
      <Box sx={{ mt: 1.5 }}>
        <Stack direction="row" justifyContent="space-between"><Typography variant="caption">{t('facilities.visitsProgress', { done: cycle.visitsDone, required: cycle.visitsRequired })}</Typography>
          <Typography variant="caption" color={cycle.status === 'EXPIRED' ? 'error.main' : cycle.status === 'DUE' ? 'warning.main' : 'text.secondary'}>{live ? t('facilities.daysLeft', { count: Math.max(0, cycle.daysLeft) }) : cycle.status === 'EXPIRED' ? t('facilities.expiredAgo', { count: Math.abs(cycle.daysLeft) }) : cycle.statusReason}</Typography></Stack>
        <LinearProgress variant="determinate" value={progress} sx={{ mt: 0.5, height: 6, borderRadius: 3 }} aria-label={t('facilities.visitsProgress', { done: cycle.visitsDone, required: cycle.visitsRequired })} />
      </Box>
    </Card>
  );
}

export default function AccreditationPanel({ companyId, position, canApprove, onChanged }: Props) {
  const { t } = useTranslation(); const dispatch = useAppDispatch(); const schemes = useSchemes();
  const [history, setHistory] = useState<AccreditationCycle[]>([]);
  const [open, setOpen] = useState(false); const [vals, setVals] = useState<Record<string, any>>({}); const [busy, setBusy] = useState(false);
  const loadHistory = useCallback(() => { api.get<{ history: AccreditationCycle[] }>(`/facilities/companies/${companyId}/accreditations`, { headers: { 'X-Quiet': '1' } }).then((r) => setHistory(r.data.history)).catch(() => setHistory([])); }, [companyId]);
  useEffect(() => { loadHistory(); }, [loadHistory]);
  const fields: FieldSpec[] = [
    { name: 'category', label: t('facilities.scheme'), type: 'select', required: true, options: schemes.options, cols: 12 },
    { name: 'startsOn', label: t('facilities.startsOn'), type: 'date', required: true }, { name: 'endsOn', label: t('facilities.endsOn'), type: 'date', helper: t('facilities.validUntilHelper') },
    { name: 'instrumentNo', label: t('facilities.instrumentNo') }, { name: 'reason', label: t('facilities.reasonOptional') },
  ];
  const grant = () => {
    setBusy(true);
    api.post<{ change: string; cycle: AccreditationCycle }>(`/facilities/companies/${companyId}/accreditations`, { category: vals.category, startsOn: vals.startsOn, endsOn: vals.endsOn || null, instrumentNo: vals.instrumentNo || '', reason: vals.reason || '' })
      .then((r) => { dispatch(notify(t('facilities.accreditationRecorded', { n: r.data.cycle?.cycleNo ?? 1 }))); setOpen(false); loadHistory(); onChanged(); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))).finally(() => setBusy(false));
  };
  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5, gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.accrTab')}</Typography>
        {canApprove && <Button size="small" variant="contained" startIcon={<AddRoundedIcon />} onClick={() => { setVals({ startsOn: toInputD(new Date()) }); setOpen(true); }}>{t('facilities.grantAccreditation')}</Button>}
      </Box>
      {position.length === 0 ? <Card variant="outlined" sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}><WorkspacePremiumRoundedIcon sx={{ fontSize: 28, opacity: 0.5 }} /><Typography>{t('facilities.noAccreditation')}</Typography></Card>
        : <Grid container spacing={1.5}>{position.map((c) => <Grid item xs={12} md={6} lg={4} key={c.id}><CycleCard cycle={c} /></Grid>)}</Grid>}
      {history.length > 0 && (
        <Card sx={{ mt: 2 }}>
          <Box sx={{ px: 2, py: 1.25 }}><Typography variant="h6" component="h3" sx={{ fontSize: 14 }}>{t('facilities.cycleHistory')}</Typography></Box>
          <Divider />
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label={t('facilities.cycleHistory')}>
              <TableHead><TableRow><TableCell>{t('facilities.scheme')}</TableCell><TableCell>{t('facilities.cycle')}</TableCell><TableCell>{t('facilities.startsOn')}</TableCell><TableCell>{t('facilities.endsOn')}</TableCell><TableCell>{t('facilities.status')}</TableCell><TableCell>{t('facilities.lastVisit')}</TableCell><TableCell>{t('facilities.instrumentNo')}</TableCell></TableRow></TableHead>
              <TableBody>{history.map((h) => (
                <TableRow key={h.id}><TableCell>{schemes.label(h.category)}</TableCell><TableCell>{h.cycleNo}</TableCell><TableCell>{fmtD(h.startsOn)}</TableCell><TableCell>{fmtD(h.endsOn)}</TableCell><TableCell><StatusChip value={h.status} map={cycleStatusMeta(t)} /></TableCell><TableCell>{h.lastVisitAt ? `${fmtD(h.lastVisitAt)} · ${h.lastVisitResult ?? ''}` : '—'}</TableCell><TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{h.instrumentNo || '—'}</TableCell></TableRow>
              ))}</TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}
      <Dialog open={open} onClose={() => !busy && setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('facilities.grantAccreditation')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t('facilities.grantHint')}</Typography>
          <FormFields fields={fields} values={vals} onChange={setVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button color="inherit" onClick={() => setOpen(false)} disabled={busy}>{t('common.cancel')}</Button><Button variant="contained" onClick={grant} disabled={busy || !vals.category || !vals.startsOn}>{t('facilities.confirm')}</Button></DialogActions>
      </Dialog>
    </>
  );
}
