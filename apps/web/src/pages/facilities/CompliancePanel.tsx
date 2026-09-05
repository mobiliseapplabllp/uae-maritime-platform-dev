import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Grid, Rating, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
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
import { OBLIGATION_STATUS_META } from './accreditationShared';
import type { DirectoryAudit, Obligation, RatingBreakdown } from './types';

/* The compliance record on one company: the audits taken, what the company still owes, and how its rating is earned. */
interface Props { companyId: string; audits: DirectoryAudit[]; obligations: Obligation[]; canManage: boolean; onChanged: () => void }
const RESULTS = ['SATISFACTORY', 'OBSERVATIONS', 'NON_CONFORMITY'];

export default function CompliancePanel({ companyId, audits, obligations, canManage, onChanged }: Props) {
  const { t } = useTranslation(); const dispatch = useAppDispatch(); const user = useUser(); const kinds = useLookups('obligationKind');
  const [rating, setRating] = useState<RatingBreakdown | null>(null);
  const [dlg, setDlg] = useState<'audit' | 'raise' | 'clear' | null>(null); const [target, setTarget] = useState<Obligation | null>(null);
  const [vals, setVals] = useState<Record<string, any>>({}); const [busy, setBusy] = useState(false);
  const base = `/facilities/companies/${companyId}`;
  const loadRating = useCallback(() => { api.get<RatingBreakdown>(`${base}/rating`, { headers: { 'X-Quiet': '1' } }).then((r) => setRating(r.data)).catch(() => setRating(null)); }, [base]);
  useEffect(() => { loadRating(); }, [loadRating, audits.length]);
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const done = (msg: string) => { dispatch(notify(msg)); setDlg(null); onChanged(); loadRating(); };
  const post = (url: string, body: unknown, msg: string) => { setBusy(true); api.post(url, body).then(() => done(msg)).catch(err).finally(() => setBusy(false)); };
  const auditFields: FieldSpec[] = [{ name: 'date', label: t('facilities.auditDate'), type: 'date', required: true }, { name: 'auditor', label: t('facilities.auditor') }, { name: 'result', label: t('facilities.result'), type: 'select', required: true, options: RESULTS.map((v) => ({ value: v, label: AUDIT_RESULT_META[v]?.label ?? v })) }, { name: 'scope', label: t('facilities.subject') }, { name: 'remarks', label: t('facilities.remarks'), type: 'multiline', cols: 12 }];
  const raiseFields: FieldSpec[] = [{ name: 'kind', label: t('facilities.obligationKind'), type: 'select', required: true, lookup: 'obligationKind' }, { name: 'dueAt', label: t('facilities.dueAt'), type: 'date' }, { name: 'title', label: t('facilities.obligationTitle'), required: true, cols: 12 }, { name: 'detail', label: t('facilities.detail'), type: 'multiline', cols: 12 }];
  const open = obligations.filter((o) => o.status === 'OPEN');
  return (
    <Grid container spacing={2}>
      <Grid item xs={12} lg={7}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1, gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.obligations')} · {open.length} {t('facilities.open').toLowerCase()}</Typography>
          {canManage && <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={() => { setVals({}); setDlg('raise'); }}>{t('facilities.raiseObligation')}</Button>}
        </Box>
        <Card>
          <TableContainer sx={{ overflowX: 'auto' }}><Table size="small" aria-label={t('facilities.obligations')}>
            <TableHead><TableRow><TableCell>{t('facilities.obligationKind')}</TableCell><TableCell>{t('facilities.obligationTitle')}</TableCell><TableCell>{t('facilities.dueAt')}</TableCell><TableCell>{t('facilities.status')}</TableCell>{canManage && <TableCell />}</TableRow></TableHead>
            <TableBody>
              {obligations.map((o) => (
                <TableRow key={o.id} hover>
                  <TableCell>{kinds.label(o.kind)}</TableCell>
                  <TableCell><b>{o.title}</b>{o.detail && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{o.detail}</Typography>}{o.sourceRef && <Typography variant="caption" sx={{ fontFamily: MONO, display: 'block' }}>{o.sourceRef}</Typography>}</TableCell>
                  <TableCell>{fmtD(o.dueAt)}{o.overdue && <Chip size="small" color="error" label={t('facilities.overdue')} sx={{ height: 18, fontSize: 10, ml: 0.5 }} />}</TableCell>
                  <TableCell><StatusChip value={o.status} map={OBLIGATION_STATUS_META(t)} />{o.status === 'CLEARED' && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{fmtD(o.clearedAt)} · {o.clearedBy}</Typography>}</TableCell>
                  {canManage && <TableCell align="right">{o.status === 'OPEN' && <Button size="small" onClick={() => { setTarget(o); setVals({ note: '' }); setDlg('clear'); }}>{t('facilities.clearObligation')}</Button>}</TableCell>}
                </TableRow>
              ))}
              {obligations.length === 0 && <TableRow><TableCell colSpan={canManage ? 5 : 4}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('facilities.noObligations')}</Typography></TableCell></TableRow>}
            </TableBody>
          </Table></TableContainer>
        </Card>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 2.5, mb: 1, gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.auditHistory', { count: audits.length })}</Typography>
          {canManage && <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={() => { setVals({ date: toInputD(new Date()), auditor: user?.name || '', result: 'SATISFACTORY' }); setDlg('audit'); }}>{t('facilities.recordAudit')}</Button>}
        </Box>
        <Card>
          <TableContainer sx={{ overflowX: 'auto' }}><Table size="small" aria-label={t('facilities.auditHistory', { count: audits.length })}>
            <TableHead><TableRow><TableCell>{t('facilities.licenceNo')}</TableCell><TableCell>{t('facilities.date')}</TableCell><TableCell>{t('facilities.auditor')}</TableCell><TableCell>{t('facilities.result')}</TableCell><TableCell>{t('facilities.remarks')}</TableCell></TableRow></TableHead>
            <TableBody>
              {audits.map((a) => <TableRow key={a.id}><TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}>{a.number}</TableCell><TableCell>{fmtD(a.date)}</TableCell><TableCell>{a.auditor}</TableCell><TableCell><StatusChip value={a.result} map={AUDIT_RESULT_META} /></TableCell><TableCell>{a.scope && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{a.scope}</Typography>}{a.remarks}</TableCell></TableRow>)}
              {audits.length === 0 && <TableRow><TableCell colSpan={5}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('facilities.noAudits')}</Typography></TableCell></TableRow>}
            </TableBody>
          </Table></TableContainer>
        </Card>
      </Grid>
      <Grid item xs={12} lg={5}>
        <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('facilities.ratingBreakdown')}</Typography>
        <Card sx={{ p: 2 }}>
          <Stack direction="row" spacing={1.5} alignItems="center"><Rating value={rating?.rating ?? 0} precision={0.1} readOnly /><Typography sx={{ fontWeight: 700 }}>{rating?.rating ?? '—'}</Typography></Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>{rating?.method}</Typography>
          <Divider sx={{ my: 1.5 }} />
          {rating && rating.entries.length > 0 ? (
            <Table size="small" aria-label={t('facilities.ratingBreakdown')}>
              <TableHead><TableRow><TableCell>{t('facilities.entry')}</TableCell><TableCell>{t('facilities.date')}</TableCell><TableCell align="right">{t('facilities.value')}</TableCell><TableCell align="right">{t('facilities.weight')}</TableCell></TableRow></TableHead>
              <TableBody>{rating.entries.map((e) => <TableRow key={`${e.source}-${e.number}-${e.date}`}><TableCell><span style={{ fontFamily: MONO, fontSize: 12 }}>{e.number}</span><Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{e.source === 'VISIT' ? t('facilities.visitsTab') : t('facilities.audits')} · {AUDIT_RESULT_META[e.result]?.label ?? e.result}{e.score != null ? ` · ${e.score}` : ''}</Typography></TableCell><TableCell>{fmtD(e.date)}</TableCell><TableCell align="right">{e.value}</TableCell><TableCell align="right">{e.weight}</TableCell></TableRow>)}</TableBody>
            </Table>
          ) : <Typography color="text.secondary" sx={{ fontSize: 13 }}>{t('facilities.notEarned')}</Typography>}
        </Card>
      </Grid>
      <Dialog open={dlg === 'audit'} onClose={() => !busy && setDlg(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('facilities.recordAudit')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}><FormFields fields={auditFields} values={vals} onChange={setVals} /></DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button color="inherit" onClick={() => setDlg(null)} disabled={busy}>{t('common.cancel')}</Button><Button variant="contained" onClick={() => post(`${base}/audits`, { date: vals.date, auditor: vals.auditor, result: vals.result, scope: vals.scope || '', remarks: vals.remarks || '' }, t('facilities.auditRecorded'))} disabled={busy || !vals.result}>{t('facilities.confirm')}</Button></DialogActions>
      </Dialog>
      <Dialog open={dlg === 'raise'} onClose={() => !busy && setDlg(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('facilities.raiseObligation')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}><FormFields fields={raiseFields} values={vals} onChange={setVals} /></DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button color="inherit" onClick={() => setDlg(null)} disabled={busy}>{t('common.cancel')}</Button><Button variant="contained" onClick={() => post(`${base}/obligations`, { kind: vals.kind, title: vals.title, detail: vals.detail || '', dueAt: vals.dueAt || null }, t('facilities.obligationRaised'))} disabled={busy || !vals.kind || !vals.title}>{t('facilities.confirm')}</Button></DialogActions>
      </Dialog>
      <Dialog open={dlg === 'clear'} onClose={() => !busy && setDlg(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('facilities.clearObligation')} — {target?.title}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}><FormFields fields={[{ name: 'note', label: t('facilities.clearanceNote'), type: 'multiline', cols: 12 }]} values={vals} onChange={setVals} /></DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button color="inherit" onClick={() => setDlg(null)} disabled={busy}>{t('common.cancel')}</Button><Button variant="contained" onClick={() => target && post(`${base}/obligations/${target.id}/clear`, { note: vals.note || '' }, t('facilities.obligationCleared'))} disabled={busy}>{t('facilities.confirm')}</Button></DialogActions>
      </Dialog>
    </Grid>
  );
}
