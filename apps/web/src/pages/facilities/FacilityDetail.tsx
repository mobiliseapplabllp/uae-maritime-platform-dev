import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Button, Stack, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Skeleton, Chip, Rating, Divider, Dialog, DialogTitle, DialogContent, DialogActions, Tooltip, Alert } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import VerifiedUserRoundedIcon from '@mui/icons-material/VerifiedUserRounded';
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded';
import GppBadRoundedIcon from '@mui/icons-material/GppBadRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CancelRoundedIcon from '@mui/icons-material/CancelRounded';
import LaunchRoundedIcon from '@mui/icons-material/LaunchRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import FormFields from '../../components/common/FormFields';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import { LICENCE_STATUS_META } from '../../utils/status';
import { fmtD, fmtDT, toInputD } from '../../utils/format';
import { MONO } from '../../theme';
import { useProfile } from '../../config/runtime';
import type { FieldSpec } from '../../types';
import CertificateDialog from './CertificateDialog';
import { AUDIT_RESULT_META, ENDORSEMENT_RESULT_META, NEEDS_NOTE, SUBJECT_KIND_LABEL, WINDOW_STATE_META, nextActions, subjectPath, verifyPath, type LicenceAction } from './shared';
import type { AuditPayload, ChecksResult, EndorsePayload, EndorsementsView, LicenceDetail, TransitionPayload } from './types';

/* One instrument — its lifecycle, the checks that gate issue, the audits that move its rating, the survey endorsements a statutory certificate runs on, and the signature that proves the register entry. */
const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box>
    <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography>
    <Typography component="div" sx={{ fontSize: 14, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography>
  </Box>
);
const ENDORSEMENT_KINDS = ['ANNUAL', 'INTERMEDIATE', 'RENEWAL', 'ADDITIONAL'];
const ENDORSEMENT_RESULTS = ['ENDORSED', 'ENDORSED_WITH_CONDITIONS', 'NOT_ENDORSED'];
const AUDIT_RESULTS = ['SATISFACTORY', 'OBSERVATIONS', 'NON_CONFORMITY'];
const DELETABLE = ['APPLIED', 'UNDER_REVIEW', 'REJECTED'];

export default function FacilityDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const profile = useProfile();
  const { t } = useTranslation();
  const [doc, setDoc] = useState<LicenceDetail | null>(null);
  const [checks, setChecks] = useState<ChecksResult | null>(null);
  const [endorsements, setEndorsements] = useState<EndorsementsView | null>(null);
  const [action, setAction] = useState<LicenceAction | null>(null);
  const [vals, setVals] = useState<Record<string, any>>({});
  const [auditDlg, setAuditDlg] = useState(false);
  const [auditVals, setAuditVals] = useState<Record<string, any>>({});
  const [endorseDlg, setEndorseDlg] = useState(false);
  const [endorseVals, setEndorseVals] = useState<Record<string, any>>({});
  const [editDlg, setEditDlg] = useState(false);
  const [editVals, setEditVals] = useState<Record<string, any>>({});
  const [certOpen, setCertOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  const load = useCallback(() => api.get<LicenceDetail>(`/licenses/${id}`).then((r) => {
    setDoc(r.data);
    if (['APPLIED', 'UNDER_REVIEW'].includes(r.data.status)) api.get<ChecksResult>(`/licenses/${id}/checks`, { headers: { 'X-Quiet': '1' } }).then((c) => setChecks(c.data)).catch(() => setChecks(null)); else setChecks(null);
    if (r.data.statutory) api.get<EndorsementsView>(`/licenses/${id}/endorsements`, { headers: { 'X-Quiet': '1' } }).then((e) => setEndorsements(e.data)).catch(() => setEndorsements(null)); else setEndorsements(null);
  }).catch(err), [id, err]);
  useEffect(() => { load(); }, [load]);

  if (!doc) return <Skeleton variant="rounded" height={420} />;
  const canManage = hasPerm(user, 'facilities.manage');
  const canApprove = hasPerm(user, 'facilities.approve') || (doc.statutory && hasPerm(user, 'certificates.manage'));
  const canEndorse = doc.statutory && doc.status === 'ISSUED' && (canManage || hasPerm(user, 'certificates.manage'));
  const actions = nextActions(doc.status, doc.classLabel);
  const blocking = checks ? checks.checks.filter((c) => c.blocking && !c.passed) : [];
  const issuing = action?.to === 'ISSUED' && doc.status !== 'SUSPENDED';
  const needsNote = !!action && (NEEDS_NOTE.includes(action.to) || (issuing && !!vals.override));
  const verification = doc.signature?.verification;
  const subjectLink = subjectPath(doc.subjectKind, doc.subjectId);
  const post = (url: string, body: unknown, done: string, close: () => void) => {
    setBusy(true);
    api.post(url, body).then(() => { dispatch(notify(done)); close(); load(); }).catch(err).finally(() => setBusy(false));
  };
  const runAction = () => {
    if (!action) return;
    const body: TransitionPayload = { to: action.to, note: vals.note || undefined, expiryDate: vals.expiryDate || undefined, override: !!vals.override };
    post(`/licenses/${id}/transition`, body, t('facilities.actionDone', { action: action.label }), () => setAction(null));
  };
  const saveAudit = () => post(`/licenses/${id}/audits`, { date: auditVals.date, auditor: auditVals.auditor, result: auditVals.result, remarks: auditVals.remarks || undefined } as AuditPayload, t('facilities.auditRecorded'), () => setAuditDlg(false));
  const saveEndorsement = () => post(`/licenses/${id}/endorsements`, { kind: endorseVals.kind, completedOn: endorseVals.completedOn || undefined, surveyor: endorseVals.surveyor || undefined, organisation: endorseVals.organisation || undefined, place: endorseVals.place || undefined, result: endorseVals.result || 'ENDORSED', remarks: endorseVals.remarks || undefined } as EndorsePayload, t('facilities.endorsementRecorded'), () => setEndorseDlg(false));
  const saveEdit = () => {
    setBusy(true);
    api.put(`/licenses/${id}`, { contactPerson: editVals.contactPerson, phone: editVals.phone, email: editVals.email, taxId: editVals.taxId, address: editVals.address, conditions: editVals.conditions })
      .then(() => { dispatch(notify(t('facilities.detailsSaved'))); setEditDlg(false); load(); }).catch(err).finally(() => setBusy(false));
  };
  const doDelete = () => {
    setBusy(true);
    api.delete(`/licenses/${id}`).then(() => { dispatch(notify(t('facilities.applicationDeleted', { no: doc.licenseNo }))); navigate('/facilities'); }).catch(err).finally(() => setBusy(false));
  };
  const actionFields: FieldSpec[] = [
    ...(issuing && doc.status === 'UNDER_REVIEW' ? [{ name: 'expiryDate', label: t('facilities.validUntil'), type: 'date' as const, cols: 12, helper: t('facilities.validUntilHelper') }] : []),
    ...(issuing && blocking.length ? [{ name: 'override', label: t('facilities.overrideChecks', { count: blocking.length }), type: 'switch' as const, cols: 12 }] : []),
    { name: 'note', label: needsNote ? t('facilities.reason') : t('facilities.noteOptional'), type: 'multiline', required: needsNote, cols: 12 },
  ];

  return (
    <>
      <PageHeader crumbs={[{ label: t('facilities.registerTitle'), to: '/facilities' }, { label: doc.licenseNo }]}
        title={<Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap><span>{doc.entityName}</span><StatusChip value={doc.status} map={LICENCE_STATUS_META} /></Stack>}
        sub={`${doc.licenseNo} · ${doc.typeLabel} · ${doc.classLabel} · ${SUBJECT_KIND_LABEL[doc.subjectKind] || doc.subjectKind}`}
        actions={<>
          {['ISSUED', 'SUSPENDED'].includes(doc.status) && <Button variant="outlined" startIcon={<VerifiedUserRoundedIcon />} onClick={() => setCertOpen(true)}>{t('facilities.printCertificate')}</Button>}
          {doc.status === 'ISSUED' && <Button variant="outlined" endIcon={<LaunchRoundedIcon />} onClick={() => window.open(verifyPath(doc.licenseNo), '_blank', 'noopener')}>{t('facilities.publicVerification')}</Button>}
          {canManage && <Button variant="outlined" color="inherit" startIcon={<EditRoundedIcon />} onClick={() => { setEditVals({ contactPerson: doc.contactPerson, phone: doc.phone, email: doc.email, taxId: doc.taxId, address: doc.address, conditions: doc.conditions }); setEditDlg(true); }}>{t('facilities.editDetails')}</Button>}
          {canManage && DELETABLE.includes(doc.status) && <Button variant="outlined" color="error" startIcon={<DeleteOutlineRoundedIcon />} onClick={() => setDelOpen(true)}>{t('common.delete')}</Button>}
          {canApprove && actions.map((a) => <Button key={a.to} variant={a.danger ? 'outlined' : 'contained'} color={a.danger ? 'error' : 'primary'} onClick={() => { setVals({}); setAction(a); }}>{a.label}</Button>)}
        </>} />
      <CertificateDialog licence={doc} open={certOpen} onClose={() => setCertOpen(false)} />

      <Card sx={{ p: 2.5, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid item xs={6} md={2}><Item label={t('facilities.status')} value={<Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap><StatusChip value={doc.status} map={LICENCE_STATUS_META} />{doc.status === 'ISSUED' && (doc.inForce ? <Chip size="small" color="success" label={t('facilities.inForce')} sx={{ height: 21, fontSize: 11 }} /> : <Tooltip title={doc.forceReason}><Chip size="small" color="error" label={t('facilities.notInForce')} sx={{ height: 21, fontSize: 11 }} /></Tooltip>)}</Stack>} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('facilities.applied')} value={fmtD(doc.appliedDate)} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('facilities.issued')} value={fmtD(doc.issueDate)} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('facilities.expires')} value={doc.nonExpiring ? t('facilities.nonExpiring') : fmtD(doc.expiryDate)} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('facilities.performance')} value={doc.performanceRating ? <Rating value={doc.performanceRating} precision={0.5} size="small" readOnly /> : t('facilities.notRated')} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('facilities.contact')} value={doc.contactPerson || '—'} /></Grid>
          <Grid item xs={12} md={4}><Item label={t('facilities.address')} value={doc.address || '—'} /></Grid>
          <Grid item xs={6} md={2}><Item label={profile.tax.registrationLabel} value={<span style={{ fontFamily: MONO, fontSize: 12.5 }}>{doc.taxId || '—'}</span>} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.subject')} value={subjectLink ? <Button size="small" sx={{ p: 0, minWidth: 0, fontWeight: 600 }} onClick={() => navigate(subjectLink)}>{t('facilities.openRecord', { kind: SUBJECT_KIND_LABEL[doc.subjectKind] || doc.subjectKind })}</Button> : t('facilities.notLinked')} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.signature')} value={verification
            ? <Chip size="small" icon={verification.valid ? <VerifiedRoundedIcon /> : <GppBadRoundedIcon />} color={verification.valid ? 'success' : 'error'} variant="outlined" label={verification.valid ? t('facilities.signatureValid', { key: verification.keyId || '' }) : t('facilities.signatureMismatch')} sx={{ height: 22 }} />
            : <Typography component="span" sx={{ color: 'text.secondary', fontSize: 13 }}>{t('facilities.unsigned')}</Typography>} /></Grid>
          {doc.statutory && <Grid item xs={12} md={6}><Item label={t('facilities.convention')} value={`${doc.certificateName || doc.typeLabel} · ${doc.convention || '—'}`} /></Grid>}
          <Grid item xs={12} md={doc.statutory ? 6 : 12}><Item label={t('facilities.conditions')} value={doc.conditions || '—'} /></Grid>
        </Grid>
      </Card>

      <Grid container spacing={2}>
        <Grid item xs={12} md={7}>
          <Card sx={{ height: '100%' }}>
            <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.auditHistory', { count: doc.audits.length })}</Typography>
              {canManage && ['ISSUED', 'SUSPENDED'].includes(doc.status) && <Button size="small" startIcon={<AddRoundedIcon />} onClick={() => { setAuditVals({ date: toInputD(new Date()), auditor: user?.name || '', result: 'SATISFACTORY' }); setAuditDlg(true); }}>{t('facilities.recordAudit')}</Button>}
            </Box>
            <Divider />
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label={t('facilities.auditHistory', { count: doc.audits.length })}>
                <TableHead><TableRow><TableCell>{t('facilities.date')}</TableCell><TableCell>{t('facilities.auditor')}</TableCell><TableCell>{t('facilities.result')}</TableCell><TableCell>{t('facilities.remarks')}</TableCell></TableRow></TableHead>
                <TableBody>
                  {[...doc.audits].reverse().map((a, i) => (
                    <TableRow key={i}><TableCell>{fmtD(a.date)}</TableCell><TableCell>{a.auditor}</TableCell><TableCell><StatusChip value={a.result} map={AUDIT_RESULT_META} /></TableCell><TableCell>{a.remarks || '—'}</TableCell></TableRow>
                  ))}
                  {doc.audits.length === 0 && <TableRow><TableCell colSpan={4}><Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('facilities.noAudits')}</Typography></TableCell></TableRow>}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
        </Grid>
        <Grid item xs={12} md={5}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1.5 }}>{t('facilities.lifecycle')}</Typography>
            <Stack spacing={0} component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }} aria-label={t('facilities.lifecycle')}>
              {[...doc.history].reverse().map((h, i) => (
                <Box component="li" key={i} sx={{ display: 'flex', gap: 2 }}>
                  <Box aria-hidden sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: i === 0 ? 'primary.main' : 'divider', mt: 0.75 }} />
                    {i < doc.history.length - 1 && <Box sx={{ width: 2, flex: 1, bgcolor: 'divider' }} />}
                  </Box>
                  <Box sx={{ pb: 2 }}>
                    <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>{LICENCE_STATUS_META[h.to]?.label || h.to}{h.from && <Typography component="span" variant="caption" color="text.secondary"> ({t('facilities.from')} {LICENCE_STATUS_META[h.from]?.label || h.from})</Typography>}</Typography>
                    <Typography variant="caption" color="text.secondary">{fmtDT(h.at)} · {h.by}{h.note ? ` · ${h.note}` : ''}</Typography>
                  </Box>
                </Box>
              ))}
              {doc.history.length === 0 && <Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('facilities.noHistory')}</Typography>}
            </Stack>
          </Card>
        </Grid>

        {(checks || doc.issueChecks.length > 0) && (
          <Grid item xs={12} md={doc.statutory ? 5 : 12}>
            <Card sx={{ p: 2, height: '100%' }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.issueChecks')}</Typography>
              <Typography variant="caption" color="text.secondary">{checks ? (checks.subjectLinked ? t('facilities.issueChecksLive') : t('facilities.issueChecksUnlinked')) : t('facilities.issueChecksRecorded')}</Typography>
              <Stack spacing={0.75} sx={{ mt: 1.5 }} component="ul" aria-label={t('facilities.issueChecks')} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(checks ? checks.checks : doc.issueChecks).map((c, i) => (
                  <Stack key={i} component="li" direction="row" spacing={1} alignItems="flex-start">
                    {c.passed ? <CheckCircleRoundedIcon fontSize="small" sx={{ color: 'success.main', mt: 0.2 }} titleAccess={t('facilities.passed')} /> : <CancelRoundedIcon fontSize="small" sx={{ color: c.blocking ? 'error.main' : 'warning.main', mt: 0.2 }} titleAccess={c.blocking ? t('facilities.blocking') : t('facilities.advisory')} />}
                    <Box><Typography sx={{ fontSize: 13, fontWeight: 600 }}>{c.check}{!c.passed && c.blocking && <Chip size="small" color="error" label={t('facilities.blocking')} sx={{ height: 18, fontSize: 10, ml: 0.75 }} />}</Typography><Typography variant="caption" color="text.secondary">{c.detail}</Typography></Box>
                  </Stack>
                ))}
              </Stack>
              {checks && <Alert severity={checks.canIssue ? 'success' : blocking.length ? 'error' : 'info'} sx={{ mt: 1.5 }}>{checks.canIssue ? t('facilities.canIssue') : blocking.length ? t('facilities.blockedIssue', { count: blocking.length }) : t('facilities.notReadyForIssue')}</Alert>}
            </Card>
          </Grid>
        )}

        {doc.statutory && (
          <Grid item xs={12} md={checks || doc.issueChecks.length > 0 ? 7 : 12}>
            <Card sx={{ height: '100%' }}>
              <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Box>
                  <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.surveyEndorsements')}</Typography>
                  <Typography variant="caption" color="text.secondary">{endorsements ? t('facilities.endorsementSummary', { overdue: endorsements.overdue ?? 0, due: endorsements.due ?? 0, refused: endorsements.refused ?? 0 }) : doc.forceReason}</Typography>
                </Box>
                {canEndorse && <Button size="small" startIcon={<AddRoundedIcon />} onClick={() => { setEndorseVals({ kind: endorsements?.next?.kind || 'ANNUAL', completedOn: toInputD(new Date()), surveyor: user?.name || '', result: 'ENDORSED' }); setEndorseDlg(true); }}>{t('facilities.recordEndorsement')}</Button>}
              </Box>
              <Divider />
              <TableContainer sx={{ overflowX: 'auto' }}>
                <Table size="small" aria-label={t('facilities.surveyEndorsements')}>
                  <TableHead><TableRow><TableCell>{t('facilities.survey')}</TableCell><TableCell>{t('facilities.anniversary')}</TableCell><TableCell>{t('facilities.window')}</TableCell><TableCell>{t('facilities.state')}</TableCell><TableCell>{t('facilities.completed')}</TableCell><TableCell>{t('facilities.surveyor')}</TableCell></TableRow></TableHead>
                  <TableBody>
                    {(endorsements?.schedule || doc.endorsementState?.schedule || []).map((s, i) => (
                      <TableRow key={i}>
                        <TableCell><b>{s.kind}</b></TableCell><TableCell>{fmtD(s.anniversary)}</TableCell><TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtD(s.dueFrom)} → {fmtD(s.dueTo)}</TableCell>
                        <TableCell><StatusChip value={s.state} map={WINDOW_STATE_META} /></TableCell><TableCell>{fmtD(s.completedOn)}</TableCell><TableCell>{s.surveyor || '—'}</TableCell>
                      </TableRow>
                    ))}
                    {(endorsements?.schedule || doc.endorsementState?.schedule || []).length === 0 && <TableRow><TableCell colSpan={6}><Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('facilities.noSchedule')}</Typography></TableCell></TableRow>}
                  </TableBody>
                </Table>
              </TableContainer>
              {doc.endorsements.length > 0 && (
                <Box sx={{ px: 2, py: 1.5 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>{t('facilities.recordedEndorsements')}</Typography>
                  <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                    {doc.endorsements.map((e, i) => <Typography key={i} sx={{ fontSize: 12.5 }}><StatusChip value={e.result} map={ENDORSEMENT_RESULT_META} /> {e.kind} · {fmtD(e.completedOn)} · {e.surveyor}{e.organisation ? ` (${e.organisation})` : ''}{e.remarks ? ` — ${e.remarks}` : ''}</Typography>)}
                  </Stack>
                </Box>
              )}
            </Card>
          </Grid>
        )}
      </Grid>

      <Dialog open={!!action} onClose={() => !busy && setAction(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{action?.label} — {doc.entityName}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          {issuing && blocking.length > 0 && <Alert severity="warning" sx={{ mb: 1.5 }}>{t('facilities.blockedIssue', { count: blocking.length })}: {blocking.map((b) => b.detail).join('; ')}</Alert>}
          <FormFields fields={actionFields} values={vals} onChange={setVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setAction(null)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" color={action?.danger ? 'error' : 'primary'} disabled={busy || (needsNote && !vals.note) || (issuing && blocking.length > 0 && !vals.override)} onClick={runAction}>{t('facilities.confirm')}</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={auditDlg} onClose={() => !busy && setAuditDlg(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('facilities.recordAudit')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <FormFields fields={[
            { name: 'date', label: t('facilities.auditDate'), type: 'date', required: true }, { name: 'auditor', label: t('facilities.auditor'), required: true },
            { name: 'result', label: t('facilities.result'), type: 'select', required: true, cols: 12, options: AUDIT_RESULTS.map((r) => ({ value: r, label: AUDIT_RESULT_META[r].label })) },
            { name: 'remarks', label: t('facilities.remarks'), type: 'multiline', cols: 12 },
          ]} values={auditVals} onChange={setAuditVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setAuditDlg(false)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" disabled={busy || !auditVals.date || !auditVals.auditor || !auditVals.result} onClick={saveAudit}>{t('common.save')}</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={endorseDlg} onClose={() => !busy && setEndorseDlg(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('facilities.recordEndorsement')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t('facilities.endorsementHint')}</Typography>
          <FormFields fields={[
            { name: 'kind', label: t('facilities.survey'), type: 'select', required: true, options: ENDORSEMENT_KINDS.map((k) => ({ value: k, label: k })) },
            { name: 'completedOn', label: t('facilities.completed'), type: 'date', required: true },
            { name: 'surveyor', label: t('facilities.surveyor'), required: true }, { name: 'organisation', label: t('facilities.organisation') },
            { name: 'place', label: t('facilities.place') },
            { name: 'result', label: t('facilities.result'), type: 'select', required: true, options: ENDORSEMENT_RESULTS.map((r) => ({ value: r, label: ENDORSEMENT_RESULT_META[r].label })) },
            { name: 'remarks', label: t('facilities.remarks'), type: 'multiline', cols: 12, required: endorseVals.result === 'NOT_ENDORSED' },
          ]} values={endorseVals} onChange={setEndorseVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setEndorseDlg(false)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" disabled={busy || !endorseVals.kind || !endorseVals.surveyor || (endorseVals.result === 'NOT_ENDORSED' && !endorseVals.remarks)} onClick={saveEndorsement}>{t('common.save')}</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={editDlg} onClose={() => !busy && setEditDlg(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('facilities.editDetails')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          {doc.status === 'ISSUED' && <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t('facilities.signedFactsHint')}</Typography>}
          <FormFields fields={[
            { name: 'contactPerson', label: t('facilities.contactPerson') }, { name: 'phone', label: t('facilities.phone') },
            { name: 'email', label: t('facilities.email'), type: 'email' }, { name: 'taxId', label: profile.tax.registrationLabel },
            { name: 'address', label: t('facilities.address'), type: 'multiline', cols: 12 }, { name: 'conditions', label: t('facilities.conditions'), type: 'multiline', cols: 12 },
          ]} values={editVals} onChange={setEditVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setEditDlg(false)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" disabled={busy} onClick={saveEdit}>{t('common.save')}</Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog open={delOpen} busy={busy} title={t('facilities.deleteApplicationTitle')} message={t('facilities.deleteApplicationMessage', { no: doc.licenseNo })} onClose={() => setDelOpen(false)} onConfirm={doDelete} />
    </>
  );
}
