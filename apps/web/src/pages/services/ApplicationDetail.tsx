import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Grid, LinearProgress, Skeleton, Stack, Switch, FormControlLabel, TextField, Typography } from '@mui/material';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded';
import PersonRoundedIcon from '@mui/icons-material/PersonRounded';
import PaymentsRoundedIcon from '@mui/icons-material/PaymentsRounded';
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import { fmtDT, fmtMoney, fromNow } from '../../utils/format';
import { MONO } from '../../theme';
import { REQUEST_STATUS_META, type RequestDetail } from './types';

/* One application as the desk works it: the form as lodged, the documents and their verification, the fee and its
 * payment, the checks, the timeline — and every action the workflow allows this reader from the state the application
 * is in. GET /services/requests/:id and the transition, issue, assign, document and payment routes behind it. */
type Note = { id: string; author?: { name?: string } | string; body: string; internal?: boolean; createdAt: string };

export default function ApplicationDetail() {
  const { id = '' } = useParams(); const navigate = useNavigate(); const dispatch = useAppDispatch(); const user = useUser();
  const { t, i18n } = useTranslation(); const ar = i18n.language === 'ar';
  const [req, setReq] = useState<RequestDetail | null>(null); const [notes, setNotes] = useState<Note[]>([]);
  const [action, setAction] = useState<{ key: string; label: string } | null>(null); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const [newNote, setNewNote] = useState(''); const [internal, setInternal] = useState(true); const [payRef, setPayRef] = useState('');
  const load = useCallback(() => api.get<RequestDetail>(`/services/requests/${id}`).then((r) => setReq(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))), [id, dispatch]);
  useEffect(() => { setReq(null); load(); api.get<Note[]>(`/services/requests/${id}/notes`, { headers: { 'X-Quiet': '1' } }).then((r) => setNotes(r.data)).catch(() => setNotes([])); }, [id, load]);
  const assessor = hasPerm(user, 'services.assess') || hasPerm(user, 'services.manage'); const approver = hasPerm(user, 'services.approve') || hasPerm(user, 'services.manage');
  const fail = (e: unknown) => dispatch(notify({ message: (e as Error).message, severity: 'error' }));
  const run = async (fn: () => Promise<unknown>, done: string) => { setBusy(true); try { await fn(); dispatch(notify({ message: done, severity: 'success' })); await load(); } catch (e) { fail(e); } finally { setBusy(false); } };
  const transition = () => action && run(() => api.post(`/services/requests/${id}/transition`, { action: action.key, note }), t('services.actionDone', { defaultValue: '{{action}} recorded', action: action.label })).then(() => { setAction(null); setNote(''); });
  const issue = () => run(() => api.post(`/services/requests/${id}/issue`, { note: '' }), t('services.issued', 'Instrument issued'));
  const assignMe = () => run(() => api.post(`/services/requests/${id}/assign`, { userId: user?.id ?? null, name: user?.name ?? '' }), t('services.assigned', 'Assigned to you'));
  const verify = (code: string, verified: boolean) => run(() => api.put(`/services/requests/${id}/documents/${code}`, { verified }), verified ? t('services.docVerified', 'Document verified') : t('services.docUnverified', 'Verification withdrawn'));
  const pay = () => run(() => api.post(`/services/requests/${id}/payment`, { reference: payRef }), t('services.paid', 'Payment recorded')).then(() => setPayRef(''));
  const addNote = () => run(async () => { await api.post(`/services/requests/${id}/notes`, { body: newNote, internal }); const r = await api.get<Note[]>(`/services/requests/${id}/notes`); setNotes(r.data); }, t('services.noteAdded', 'Note added')).then(() => setNewNote(''));
  const header = <PageHeader icon={AccountTreeRoundedIcon} iconColor="#0E7C86" title={req ? `${req.number} · ${ar && req.definitionNameAr ? req.definitionNameAr : req.definitionName}` : t('services.application', 'Application')}
    sub={req ? `${req.subjectName ?? '—'} · ${req.applicant?.organisation || req.applicant?.name || '—'} · ${t('services.lodgedOn', 'lodged')} ${req.submittedAt ? fmtDT(req.submittedAt) : t('services.notYet', 'not yet')}` : ''}
    crumbs={[{ label: t('services.openRequests', 'Applications'), to: '/services/requests' }]}
    actions={req ? <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
      <StatusChip value={req.status} map={REQUEST_STATUS_META} size="medium" />
      {req.availableActions.map((a) => <Button key={a.key} size="small" variant={/approve|issue|submit/.test(a.key) ? 'contained' : 'outlined'} color={/reject|withdraw/.test(a.key) ? 'error' : 'primary'} disabled={busy} onClick={() => setAction({ key: a.key, label: ar && a.labelAr ? a.labelAr : a.label })} data-testid={`action-${a.key}`}>{ar && a.labelAr ? a.labelAr : a.label}</Button>)}
      {approver && req.status === 'APPROVED' && req.definition.outputs?.instrumentType && !req.issuedInstrument && <Button size="small" variant="contained" startIcon={<WorkspacePremiumRoundedIcon />} disabled={busy} onClick={issue} data-testid="action-issue">{t('services.issueInstrument', 'Issue instrument')}</Button>}
      {assessor && req.assignee?.userId !== user?.id && <Button size="small" variant="text" startIcon={<PersonRoundedIcon />} disabled={busy} onClick={assignMe}>{t('services.assignMe', 'Assign to me')}</Button>}
    </Stack> : undefined} />;
  if (!req) return <>{header}<Skeleton variant="rounded" height={360} /></>;
  const fields = req.definition.form.fields; const docDefs = new Map(req.definition.documents.map((d) => [d.code, d]));
  const slaTone = req.slaBreached ? 'error.main' : req.slaDueAt && new Date(req.slaDueAt).getTime() - Date.now() < 48 * 3600_000 ? 'warning.main' : 'text.secondary';
  return (
    <>
      {header}
      {busy && <LinearProgress sx={{ mb: 1 }} />}
      <Grid container spacing={2} data-testid="application-detail">
        <Grid item xs={12} md={8}>
          <Card sx={{ p: 2, mb: 2 }} data-testid="application-form">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('services.asLodged', 'The application as lodged')}</Typography>
            <Grid container spacing={1}>
              {fields.map((f) => <Grid item xs={12} sm={6} key={f.key}><Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary' }}>{ar && f.labelAr ? f.labelAr : f.label}</Typography><Typography variant="body2">{(() => { const v = req.formData[f.key]; const opt = f.options?.find((o) => o.value === v); return opt ? (ar && opt.labelAr ? opt.labelAr : opt.label) : v === undefined || v === null || v === '' ? '—' : typeof v === 'boolean' ? (v ? t('common.yes', 'Yes') : t('common.no', 'No')) : String(v); })()}</Typography></Grid>)}
              {!fields.length && <Grid item xs={12}><Typography variant="body2" color="text.secondary">{t('services.noForm', 'This service asks nothing beyond the subject')}</Typography></Grid>}
            </Grid>
          </Card>
          <Card sx={{ p: 2, mb: 2 }} data-testid="application-documents">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('services.documents', 'Documents')}</Typography>
            {req.documents.length ? req.documents.map((d) => { const def = docDefs.get(d.code); return (
              <Box key={d.code} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: 0.75, borderBottom: 1, borderColor: 'divider', gap: 1 }}>
                <Box><Typography variant="body2" sx={{ fontWeight: 600 }}>{def?.label ?? d.code}{def?.required ? ' *' : ''}</Typography><Typography variant="caption" color="text.secondary">{d.name || d.documentId || t('services.notAttached', 'not attached')}{d.notes ? ` · ${d.notes}` : ''}</Typography></Box>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip size="small" label={d.verified ? t('services.verified', 'verified') : t('services.unverified', 'unverified')} color={d.verified ? 'success' : 'default'} sx={{ height: 20, fontSize: 10.5 }} />
                  {assessor && <Button size="small" disabled={busy} onClick={() => verify(d.code, !d.verified)}>{d.verified ? t('services.withdraw', 'Withdraw') : t('services.verify', 'Verify')}</Button>}
                </Stack>
              </Box>); }) : <Typography variant="body2" color="text.secondary">{t('services.noDocumentsAttached', 'No documents attached')}</Typography>}
          </Card>
          {req.checks.length > 0 && <Card sx={{ p: 2, mb: 2 }} data-testid="application-checks">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('services.checks', 'Checks')}</Typography>
            {req.checks.map((c, i) => <Box key={c.key ?? i} sx={{ display: 'flex', gap: 1, alignItems: 'center', py: 0.5 }}><TaskAltRoundedIcon fontSize="small" color={c.passed ? 'success' : 'disabled'} /><Typography variant="body2">{c.label ?? c.key}{c.note ? ` — ${c.note}` : ''}</Typography></Box>)}
          </Card>}
          <Card sx={{ p: 2 }} data-testid="application-timeline">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('services.timeline', 'Timeline')}</Typography>
            <Box component="ol" sx={{ listStyle: 'none', p: 0, m: 0 }}>
              {[...req.timeline].reverse().map((e, i) => <Box component="li" key={i} sx={{ display: 'flex', gap: 1.5, py: 0.75, borderBottom: 1, borderColor: 'divider' }}>
                <Typography sx={{ fontFamily: MONO, fontSize: 11, color: 'text.secondary', minWidth: 130 }}>{fmtDT(e.at)}</Typography>
                <Box><Typography variant="body2"><b>{e.from ? `${e.from} → ` : ''}{e.to}</b>{e.action ? ` · ${e.action}` : ''}</Typography><Typography variant="caption" color="text.secondary">{typeof e.by === 'string' ? e.by : e.by?.name}{e.note ? ` — ${e.note}` : ''}</Typography></Box>
              </Box>)}
            </Box>
          </Card>
        </Grid>
        <Grid item xs={12} md={4}>
          <Card sx={{ p: 2, mb: 2 }} data-testid="application-status">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('services.where', 'Where it stands')}</Typography>
            <Typography variant="body2"><b>{ar && req.stateLabelAr ? req.stateLabelAr : req.stateLabel}</b> · v{req.definitionVersion} {req.environment}</Typography>
            <Typography variant="body2" sx={{ color: slaTone, mt: 0.5 }}>{req.slaDueAt ? `${t('services.dueBy', 'Due by')} ${fmtDT(req.slaDueAt)} (${fromNow(req.slaDueAt)})${req.slaBreached ? ` · ${t('services.breached', 'past service level')}` : ''}` : t('services.noSla', 'No service level applies yet')}</Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>{t('services.assignee', 'Assignee')}: {req.assignee?.name || '—'}</Typography>
            {req.decidedAt && <Typography variant="body2" sx={{ mt: 0.5 }}>{t('services.decided', 'Decided')} {fmtDT(req.decidedAt)}</Typography>}
            {req.issuedInstrument && <Typography variant="body2" sx={{ mt: 0.5 }}>{t('services.instrument', 'Instrument')}: <b>{req.issuedInstrument.number ?? req.issuedInstrument.licenseNo ?? req.issuedInstrument.id}</b></Typography>}
            <Divider sx={{ my: 1.5 }} />
            <Typography variant="subtitle2">{t('services.applicant', 'Applicant')}</Typography>
            <Typography variant="body2">{req.applicant?.name}{req.applicant?.organisation ? ` · ${req.applicant.organisation}` : ''}</Typography>
            <Typography variant="caption" color="text.secondary">{req.applicant?.email}{req.applicant?.phone ? ` · ${req.applicant.phone}` : ''}</Typography>
          </Card>
          <Card sx={{ p: 2, mb: 2 }} data-testid="application-fees">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}><PaymentsRoundedIcon fontSize="small" sx={{ verticalAlign: 'text-bottom', mr: 0.5 }} />{t('services.feesTitle', 'Fee')}</Typography>
            {req.fees?.lines.map((l) => <Box key={l.code} sx={{ display: 'flex', justifyContent: 'space-between', py: 0.25 }}><Typography variant="body2">{l.description}</Typography><Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(l.amount)}</Typography></Box>)}
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}><Typography sx={{ fontWeight: 700 }}>{t('services.total', 'Total')}</Typography><Typography sx={{ fontWeight: 700 }}>{fmtMoney(req.fees?.total ?? 0)}</Typography></Box>
            <Chip size="small" sx={{ mt: 1 }} label={req.payment ? `${req.payment.status === 'PAID' ? t('services.paidOn', 'Paid') : req.payment.status === 'DUE' ? t('services.due', 'Due') : t('services.notRequired', 'No fee')}${req.payment.paidAt ? ` ${fmtDT(req.payment.paidAt)}` : ''}${req.payment.reference ? ` · ${req.payment.reference}` : ''}` : t('services.notRequired', 'No fee')} color={req.payment?.status === 'PAID' ? 'success' : req.payment?.status === 'DUE' ? 'warning' : 'default'} />
            {req.payment?.status === 'DUE' && (assessor || hasPerm(user, 'invoices.pay')) && <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}><TextField size="small" label={t('services.paymentRef', 'Payment reference')} value={payRef} onChange={(e) => setPayRef(e.target.value)} inputProps={{ 'data-testid': 'payment-ref' }} /><Button variant="outlined" size="small" disabled={busy} onClick={pay} data-testid="record-payment">{t('services.recordPayment', 'Record')}</Button></Stack>}
          </Card>
          <Card sx={{ p: 2 }} data-testid="application-notes">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('services.notes', 'Notes')}</Typography>
            {notes.map((n) => <Box key={n.id} sx={{ py: 0.75, borderBottom: 1, borderColor: 'divider' }}><Typography variant="body2">{n.body}</Typography><Typography variant="caption" color="text.secondary">{typeof n.author === 'string' ? n.author : n.author?.name} · {fromNow(n.createdAt)}{n.internal ? ` · ${t('services.internal', 'internal')}` : ''}</Typography></Box>)}
            <TextField fullWidth size="small" multiline minRows={2} sx={{ mt: 1.5 }} label={t('services.addNote', 'Add a note')} value={newNote} onChange={(e) => setNewNote(e.target.value)} inputProps={{ 'data-testid': 'note-body' }} />
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 0.5 }}><FormControlLabel control={<Switch size="small" checked={internal} onChange={(e) => setInternal(e.target.checked)} />} label={<Typography variant="caption">{t('services.internalOnly', 'Internal only')}</Typography>} /><Button size="small" disabled={busy || !newNote.trim()} onClick={addNote} data-testid="note-submit">{t('services.post', 'Post')}</Button></Stack>
          </Card>
        </Grid>
      </Grid>
      <Dialog open={!!action} onClose={() => !busy && setAction(null)} fullWidth maxWidth="xs">
        <DialogTitle>{action?.label}</DialogTitle>
        <DialogContent><TextField autoFocus fullWidth multiline minRows={3} sx={{ mt: 1 }} label={t('services.note', 'Note')} value={note} onChange={(e) => setNote(e.target.value)} inputProps={{ 'data-testid': 'action-note' }} /></DialogContent>
        <DialogActions><Button onClick={() => setAction(null)} disabled={busy}>{t('common.cancel', 'Cancel')}</Button><Button variant="contained" onClick={transition} disabled={busy} data-testid="action-confirm">{t('common.confirm', 'Confirm')}</Button></DialogActions>
      </Dialog>
      <Button sx={{ mt: 2 }} size="small" onClick={() => navigate(-1)}>{t('common.back', 'Back')}</Button>
    </>
  );
}
