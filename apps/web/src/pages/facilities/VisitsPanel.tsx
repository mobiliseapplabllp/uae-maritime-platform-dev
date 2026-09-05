import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, IconButton, MenuItem, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EventAvailableRoundedIcon from '@mui/icons-material/EventAvailableRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded';
import CancelRoundedIcon from '@mui/icons-material/CancelRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import FormFields from '../../components/common/FormFields';
import StatusChip from '../../components/common/StatusChip';
import { useLookups } from '../../hooks/useLookups';
import { fmtD, toInputD } from '../../utils/format';
import { MONO } from '../../theme';
import type { FieldSpec } from '../../types';
import { AUDIT_RESULT_META } from './shared';
import { severityMeta, useSchemes, visitStatusMeta } from './accreditationShared';
import type { AccreditationCycle, Visit, VisitFinding, VisitOutcome } from './types';

/* The inspection visits paid to one subject: planned, completed with what was found, or cancelled with a reason.
 * A spot check is recorded in one step — the same dialog, with the outcome filled in. */
interface Props { subjectKind: 'COMPANY' | 'FACILITY'; subjectId: string; visits: Visit[]; position?: AccreditationCycle[]; canManage: boolean; onChanged: () => void }
const RESULTS = ['SATISFACTORY', 'OBSERVATIONS', 'NON_CONFORMITY'];
const emptyFinding = (): VisitFinding => ({ code: '', title: '', severity: 'MINOR', dueDays: null });

/** The outcome of a visit: result, score, findings and remarks — shared by "record now" and "record outcome". */
function OutcomeFields({ vals, onChange }: { vals: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const { t } = useTranslation();
  const findings: VisitFinding[] = vals.findings ?? [];
  const setFinding = (i: number, patch: Partial<VisitFinding>) => onChange({ ...vals, findings: findings.map((f, k) => (k === i ? { ...f, ...patch } : f)) });
  return (
    <Stack spacing={1.5} sx={{ mt: 1.5 }}>
      <FormFields values={vals} onChange={onChange} fields={[
        { name: 'result', label: t('facilities.result'), type: 'select', required: true, options: RESULTS.map((v) => ({ value: v, label: AUDIT_RESULT_META[v]?.label ?? v })) },
        { name: 'score', label: `${t('facilities.score')} (0–100)`, type: 'number' },
        { name: 'visitedOn', label: t('facilities.visitedOn'), type: 'date' },
        { name: 'remarks', label: t('facilities.remarks'), type: 'multiline', cols: 12 },
      ]} />
      <Box>
        <Stack direction="row" justifyContent="space-between" alignItems="center"><Typography sx={{ fontWeight: 600, fontSize: 13 }}>{t('facilities.findings')} ({findings.length})</Typography><Button size="small" startIcon={<AddRoundedIcon />} onClick={() => onChange({ ...vals, findings: [...findings, emptyFinding()] })}>{t('facilities.addFinding')}</Button></Stack>
        {findings.map((f, i) => (
          <Stack key={i} direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
            <TextField size="small" label={t('facilities.findingCode')} value={f.code} onChange={(e) => setFinding(i, { code: e.target.value })} sx={{ width: 110 }} />
            <TextField size="small" label={t('facilities.findingTitle')} value={f.title} onChange={(e) => setFinding(i, { title: e.target.value })} sx={{ flex: 1 }} required />
            <TextField size="small" select label={t('facilities.severity')} value={f.severity} onChange={(e) => setFinding(i, { severity: e.target.value as VisitFinding['severity'] })} sx={{ width: 130 }}>{['MINOR', 'MAJOR', 'CRITICAL'].map((s) => <MenuItem key={s} value={s}>{t(`facilities.severityLabel.${s}`)}</MenuItem>)}</TextField>
            <TextField size="small" type="number" label={t('facilities.dueDays')} value={f.dueDays ?? ''} onChange={(e) => setFinding(i, { dueDays: e.target.value === '' ? null : Number(e.target.value) })} sx={{ width: 120 }} />
            <IconButton size="small" aria-label={t('facilities.removeFinding')} onClick={() => onChange({ ...vals, findings: findings.filter((_, k) => k !== i) })}><DeleteOutlineRoundedIcon fontSize="small" /></IconButton>
          </Stack>
        ))}
      </Box>
    </Stack>
  );
}
const outcomeBody = (vals: Record<string, any>) => ({ result: vals.result, score: vals.score === '' || vals.score == null ? null : Number(vals.score), visitedOn: vals.visitedOn || null, remarks: vals.remarks || '', findings: (vals.findings ?? []).filter((f: VisitFinding) => f.title.trim()).map((f: VisitFinding) => ({ ...f, dueDays: f.dueDays || null })) });

export default function VisitsPanel({ subjectKind, subjectId, visits, position = [], canManage, onChanged }: Props) {
  const { t } = useTranslation(); const dispatch = useAppDispatch(); const user = useUser();
  const types = useLookups('visitType'); const schemes = useSchemes();
  const [dlg, setDlg] = useState<'new' | 'complete' | 'cancel' | null>(null); const [target, setTarget] = useState<Visit | null>(null);
  const [vals, setVals] = useState<Record<string, any>>({}); const [busy, setBusy] = useState(false);
  const base = subjectKind === 'COMPANY' ? `/facilities/companies/${subjectId}` : `/facilities/port-facilities/${subjectId}`;
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const done = (msg: string) => { dispatch(notify(msg)); setDlg(null); onChanged(); };
  const openNew = (recordNow: boolean) => { setVals({ visitType: recordNow ? 'SPOT_CHECK' : 'ANNUAL', scheduledOn: toInputD(new Date()), inspector: user?.name || '', recordNow, result: 'SATISFACTORY', findings: [], visitedOn: toInputD(new Date()) }); setDlg('new'); };
  const submitNew = () => {
    setBusy(true);
    const body: Record<string, unknown> = { visitType: vals.visitType, category: vals.category || null, scheduledOn: vals.scheduledOn || null, inspector: vals.inspector || undefined, remarks: vals.remarks || '' };
    if (vals.recordNow) body.complete = outcomeBody(vals);
    api.post<VisitOutcome>(`${base}/visits`, body).then((r) => done(vals.recordNow ? t('facilities.visitCompleted', { no: r.data.visit.number }) : t('facilities.visitScheduled', { no: r.data.visit.number }))).catch(err).finally(() => setBusy(false));
  };
  const submitComplete = () => { if (!target) return; setBusy(true); api.post<VisitOutcome>(`/facilities/visits/${target.id}/complete`, outcomeBody(vals)).then((r) => done(t('facilities.visitCompleted', { no: r.data.visit.number }))).catch(err).finally(() => setBusy(false)); };
  const submitCancel = () => { if (!target) return; setBusy(true); api.post<Visit>(`/facilities/visits/${target.id}/cancel`, { reason: vals.reason }).then((r) => done(t('facilities.visitCancelled', { no: r.data.number }))).catch(err).finally(() => setBusy(false)); };
  const liveSchemes = position.filter((p) => p.status === 'CURRENT' || p.status === 'DUE').map((p) => p.category);
  const newFields: FieldSpec[] = [
    { name: 'visitType', label: t('facilities.visitType'), type: 'select', required: true, lookup: 'visitType' },
    ...(subjectKind === 'COMPANY' ? [{ name: 'category', label: t('facilities.scheme'), type: 'select' as const, options: schemes.options.filter((o) => liveSchemes.includes(o.value)) }] : []),
    { name: 'scheduledOn', label: t('facilities.scheduledOn'), type: 'date', required: true }, { name: 'inspector', label: t('facilities.inspector') },
    ...(vals.recordNow ? [] : [{ name: 'remarks', label: t('facilities.remarks'), type: 'multiline' as const, cols: 12 }]),
  ];
  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5, gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.visitsTab')} ({visits.length})</Typography>
        {canManage && <Stack direction="row" spacing={1}><Button size="small" variant="outlined" startIcon={<EventAvailableRoundedIcon />} onClick={() => openNew(false)}>{t('facilities.scheduleVisit')}</Button><Button size="small" variant="contained" startIcon={<TaskAltRoundedIcon />} onClick={() => openNew(true)}>{t('facilities.recordVisit')}</Button></Stack>}
      </Box>
      <Card>
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label={t('facilities.visitsTab')}>
            <TableHead><TableRow><TableCell>{t('facilities.licenceNo')}</TableCell><TableCell>{t('facilities.visitType')}</TableCell><TableCell>{t('facilities.scheme')}</TableCell><TableCell>{t('facilities.status')}</TableCell><TableCell>{t('facilities.date')}</TableCell><TableCell>{t('facilities.inspector')}</TableCell><TableCell>{t('facilities.result')}</TableCell><TableCell align="right">{t('facilities.score')}</TableCell><TableCell align="right">{t('facilities.findings')}</TableCell>{canManage && <TableCell />}</TableRow></TableHead>
            <TableBody>
              {visits.map((v) => (
                <TableRow key={v.id} hover>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}>{v.number}</TableCell>
                  <TableCell>{types.label(v.visitType)}</TableCell>
                  <TableCell>{v.category ? schemes.label(v.category) : '—'}</TableCell>
                  <TableCell><Stack direction="row" spacing={0.5} alignItems="center"><StatusChip value={v.status} map={visitStatusMeta(t)} />{v.overdue && <Chip size="small" color="error" label={t('facilities.overdue')} sx={{ height: 18, fontSize: 10 }} />}</Stack></TableCell>
                  <TableCell>{fmtD(v.visitedOn ?? v.scheduledOn)}</TableCell>
                  <TableCell>{v.inspector || '—'}</TableCell>
                  <TableCell>{v.result ? <StatusChip value={v.result} map={AUDIT_RESULT_META} /> : v.status === 'CANCELLED' ? <Tooltip title={v.cancelReason}><span>{t('facilities.visitStatus.CANCELLED')}</span></Tooltip> : '—'}</TableCell>
                  <TableCell align="right">{v.score ?? '—'}</TableCell>
                  <TableCell align="right">{v.findings?.length ? <Tooltip title={v.findings.map((f) => `${f.code ? `${f.code} — ` : ''}${f.title}`).join(' · ')}><Stack direction="row" spacing={0.5} justifyContent="flex-end">{v.findings.map((f, i) => <StatusChip key={i} value={f.severity} map={severityMeta(t)} />)}</Stack></Tooltip> : 0}</TableCell>
                  {canManage && <TableCell align="right">{v.status === 'SCHEDULED' && <Stack direction="row" spacing={0.5} justifyContent="flex-end"><Tooltip title={t('facilities.completeVisit')}><IconButton size="small" aria-label={`${t('facilities.completeVisit')} ${v.number}`} onClick={() => { setTarget(v); setVals({ result: 'SATISFACTORY', findings: [], visitedOn: toInputD(new Date()) }); setDlg('complete'); }}><TaskAltRoundedIcon fontSize="small" /></IconButton></Tooltip><Tooltip title={t('facilities.cancelVisit')}><IconButton size="small" aria-label={`${t('facilities.cancelVisit')} ${v.number}`} onClick={() => { setTarget(v); setVals({ reason: '' }); setDlg('cancel'); }}><CancelRoundedIcon fontSize="small" /></IconButton></Tooltip></Stack>}</TableCell>}
                </TableRow>
              ))}
              {visits.length === 0 && <TableRow><TableCell colSpan={canManage ? 10 : 9}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('facilities.noVisits')}</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>
      <Dialog open={dlg === 'new'} onClose={() => !busy && setDlg(null)} maxWidth="md" fullWidth>
        <DialogTitle>{vals.recordNow ? t('facilities.recordVisit') : t('facilities.scheduleVisit')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <FormFields fields={newFields} values={vals} onChange={setVals} />
          <Divider sx={{ my: 1.5 }} />
          <FormControlLabel control={<Switch checked={!!vals.recordNow} onChange={(e) => setVals({ ...vals, recordNow: e.target.checked })} />} label={t('facilities.recordNow')} />
          {vals.recordNow && <OutcomeFields vals={vals} onChange={setVals} />}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button color="inherit" onClick={() => setDlg(null)} disabled={busy}>{t('common.cancel')}</Button><Button variant="contained" onClick={submitNew} disabled={busy || !vals.visitType || (vals.recordNow && !vals.result)}>{t('facilities.confirm')}</Button></DialogActions>
      </Dialog>
      <Dialog open={dlg === 'complete'} onClose={() => !busy && setDlg(null)} maxWidth="md" fullWidth>
        <DialogTitle>{t('facilities.completeVisit')} — {target?.number}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}><OutcomeFields vals={vals} onChange={setVals} /></DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button color="inherit" onClick={() => setDlg(null)} disabled={busy}>{t('common.cancel')}</Button><Button variant="contained" onClick={submitComplete} disabled={busy || !vals.result}>{t('facilities.confirm')}</Button></DialogActions>
      </Dialog>
      <Dialog open={dlg === 'cancel'} onClose={() => !busy && setDlg(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('facilities.cancelVisit')} — {target?.number}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}><FormFields fields={[{ name: 'reason', label: t('facilities.cancelReason'), type: 'multiline', required: true, cols: 12 }]} values={vals} onChange={setVals} /></DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button color="inherit" onClick={() => setDlg(null)} disabled={busy}>{t('common.cancel')}</Button><Button variant="contained" color="error" onClick={submitCancel} disabled={busy || !vals.reason}>{t('facilities.confirm')}</Button></DialogActions>
      </Dialog>
    </>
  );
}
