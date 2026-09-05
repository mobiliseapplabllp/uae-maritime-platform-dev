import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Box, Typography, Button, Stack, Table, TableRow, TableCell, TableBody, ToggleButtonGroup, ToggleButton, IconButton, Dialog, DialogTitle, DialogContent, DialogActions, Skeleton, Chip, Grid, Divider, Collapse, MenuItem, TextField } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded';
import ShieldRoundedIcon from '@mui/icons-material/ShieldRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import SmartToyRoundedIcon from '@mui/icons-material/SmartToyRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import FormFields from '../../components/common/FormFields';
import { useLookups } from '../../hooks/useLookups';
import { INSPECTION_STATUS_META, RESULT_META } from '../../utils/status';
import { fmtDT, toInputD, fmtD } from '../../utils/format';
import { MONO } from '../../theme';
import { DEFAULT_PASS_PCT, RECOMMENDATION_STATUS_COLOR, REGIME_LOOKUP, scoreChecklist } from './constants';
import type { Answer, ChecklistAnswer, ChecklistTemplate, ClosePayload, Finding, FindingPayload, Inspection, InspectionNotice, InspectionReport, LookupOption, RestrictionRecommendation } from './types';

/* One survey: the checklist answered on the left, findings on the right, a live weighted compliance score and the close dialog that
 * suggests the result — and, around it, the Smart Inspection records: the dossier the party held, the prediction and how it scored,
 * the report and the notices (the assistant's first drafts, or the officer's own), the restriction the rules recommended and the
 * decision on it, and the timeline every one of those wrote. */
const Fact = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box><Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography><Typography component="div" sx={{ fontSize: 13, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography></Box>
);
const SourceChip = ({ source, t }: { source: string; t: (k: string) => string }) => (
  <Chip size="small" icon={source === 'AI' ? <SmartToyRoundedIcon sx={{ fontSize: 14 }} /> : undefined} color={source === 'AI' ? 'info' : 'default'} variant="outlined" label={t(`inspections.source.${source}`)} sx={{ height: 20, fontSize: 10.5 }} />
);

export default function InspectionDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const user = useUser();
  const regimes = useLookups(REGIME_LOOKUP);
  const [doc, setDoc] = useState<Inspection | null>(null);
  const [checklist, setChecklist] = useState<ChecklistAnswer[]>([]);
  const [dirty, setDirty] = useState(false);
  const [findDlg, setFindDlg] = useState<Finding | Record<string, never> | null>(null);
  const [findVals, setFindVals] = useState<Record<string, any>>({});
  const [defCodes, setDefCodes] = useState<LookupOption[]>([]);
  const [actCodes, setActCodes] = useState<LookupOption[]>([]);
  const [closeDlg, setCloseDlg] = useState(false);
  const [closeVals, setCloseVals] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [tpl, setTpl] = useState<ChecklistTemplate | null>(null);
  const [passScorePct, setPassScorePct] = useState(DEFAULT_PASS_PCT);
  const [dlg, setDlg] = useState<'report' | 'notice' | 'recommend' | 'decide' | null>(null);
  const [vals, setVals] = useState<Record<string, any>>({});
  const [decideRec, setDecideRec] = useState<RestrictionRecommendation | null>(null);
  const [openBody, setOpenBody] = useState<string | null>(null);

  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const load = useCallback(() => api.get<Inspection>(`/inspections/${id}`).then((r) => {
    setDoc(r.data); setChecklist(r.data.checklist || []); setDirty(false);
    return api.get<ChecklistTemplate[]>('/checklist-templates', { params: { inspectionType: r.data.type, active: true, limit: 1 } }).then((x) => setTpl(x.data[0] || null)).catch(() => setTpl(null));
  }).catch(err), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get<{ passScorePct?: number }>('/module-settings/inspect').then((r) => setPassScorePct(r.data.passScorePct || DEFAULT_PASS_PCT)).catch(() => {}); }, []);

  const live = scoreChecklist(checklist, tpl, passScorePct);
  if (!doc) return <Skeleton variant="rounded" height={420} />;
  const open = doc.status !== 'CLOSED';
  const canEdit = hasPerm(user, 'inspections.edit') && open;
  const canWrite = hasPerm(user, 'inspections.edit');
  const canClose = hasPerm(user, 'inspections.close') && open;
  const canDecide = hasPerm(user, 'inspections.close');
  const findings = doc.findings || [];
  const openFindings = findings.filter((f) => f.status === 'OPEN').length;
  const shownPct = doc.status === 'CLOSED' ? (doc.scorePct ?? null) : live.pct;
  const editingFinding = findDlg && 'id' in findDlg ? (findDlg as Finding) : null;
  const answered = checklist.filter((i) => i.answer).length;
  const subjectKind = doc.subjectKind ?? 'VESSEL';
  const subjectName = doc.subjectName || doc.vesselName;
  const reports = doc.reports ?? []; const notices = doc.notices ?? []; const recommendations = doc.recommendations ?? []; const timeline = doc.timeline ?? [];

  const loadCodes = () => {
    api.get<LookupOption[]>('/lookups', { params: { category: 'deficiencyCode', limit: 100 } }).then((r) => setDefCodes(r.data)).catch(() => {});
    api.get<LookupOption[]>('/lookups', { params: { category: 'actionCode', limit: 100 } }).then((r) => setActCodes(r.data)).catch(() => {});
  };
  const saveChecklist = () => { setBusy(true); api.put(`/inspections/${id}`, { checklist }).then(() => { dispatch(notify(t('inspections.checklistSaved'))); load(); }).catch(err).finally(() => setBusy(false)); };
  const start = () => api.post(`/inspections/${id}/start`).then(load).catch(err);
  const saveFinding = () => {
    setBusy(true);
    const body: FindingPayload = { deficiencyCode: findVals.deficiencyCode, description: findVals.description, actionCode: findVals.actionCode || undefined, dueDate: findVals.dueDate || undefined, status: findVals.status || undefined };
    const req = editingFinding ? api.put(`/inspections/${id}/findings/${editingFinding.id}`, body) : api.post(`/inspections/${id}/findings`, body);
    req.then(() => { dispatch(notify(t('inspections.findingSaved'))); setFindDlg(null); load(); }).catch(err).finally(() => setBusy(false));
  };
  const closeInspection = () => {
    setBusy(true);
    const body: ClosePayload = { result: closeVals.result, remarks: closeVals.remarks || undefined };
    api.post(`/inspections/${id}/close`, body).then(() => { dispatch(notify(t('inspections.inspectionClosed'))); setCloseDlg(false); load(); }).catch(err).finally(() => setBusy(false));
  };
  const act = (p: Promise<unknown>, done: string) => { setBusy(true); p.then(() => { dispatch(notify(done)); setDlg(null); setDecideRec(null); load(); }).catch(err).finally(() => setBusy(false)); };
  const refreshDossier = () => act(api.post(`/inspections/${id}/dossier`), t('inspections.smart.dossierRefreshed'));
  const submitDialog = () => {
    if (dlg === 'report') act(api.post(`/inspections/${id}/report`, { title: vals.title || undefined, summary: vals.summary || undefined, body: vals.body }), t('inspections.smart.reportSaved'));
    if (dlg === 'notice') act(api.post(`/inspections/${id}/notices`, { kind: vals.kind || 'DEFICIENCY', subject: vals.subject || undefined, body: vals.body, addressedTo: vals.addressedTo || undefined, findingIds: vals.findingIds || undefined }), t('inspections.smart.noticeSaved'));
    if (dlg === 'recommend') act(api.post(`/inspections/${id}/recommendations`, { kind: vals.kind || 'RESTRICTION', grounds: vals.grounds, codes: findings.filter((f) => f.status === 'OPEN').map((f) => f.deficiencyCode) }), t('inspections.smart.recommendationSaved'));
    if (dlg === 'decide' && decideRec) act(api.post(`/inspections/${id}/recommendations/${decideRec.id}/decide`, { decision: vals.decision, note: vals.note || '' }), t('inspections.smart.decided'));
  };
  const issueReport = (r: InspectionReport) => act(api.post(`/inspections/${id}/report/${r.id}/issue`), t('inspections.smart.reportIssued'));
  const issueNotice = (n: InspectionNotice) => act(api.post(`/inspections/${id}/notices/${n.id}/issue`), t('inspections.smart.noticeIssued'));
  const dossier = doc.dossier ?? null; const prediction = doc.prediction ?? null;

  return (
    <>
      <PageHeader crumbs={[{ label: t('inspections.crumb'), to: '/inspections' }, { label: doc.number }]}
        title={<>{doc.number} <Typography component="span" sx={{ color: 'text.secondary', fontSize: 16, ml: 1 }}>{subjectName}</Typography></>}
        sub={`${regimes.label(doc.type)} · ${t(`inspections.subjectKind.${subjectKind}`)} · ${doc.inspector} · ${t('inspections.plannedOn', { date: fmtDT(doc.plannedAt) })}`}
        actions={<>
          {canEdit && doc.status === 'PLANNED' && <Button variant="outlined" startIcon={<PlayArrowRoundedIcon />} onClick={start}>{t('inspections.startInspection')}</Button>}
          {canClose && <Button variant="contained" startIcon={<TaskAltRoundedIcon />} onClick={() => { setCloseVals({ remarks: doc.remarks || '', result: live.suggested }); setCloseDlg(true); }}>{t('inspections.closeInspection')}</Button>}
        </>} />
      <Card sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <StatusChip value={doc.status} map={INSPECTION_STATUS_META} size="medium" />
          {doc.result && <StatusChip value={doc.result} map={RESULT_META} size="medium" />}
          {doc.detention && <Chip color="error" label={t('inspections.detained')} size="small" />}
          {subjectKind !== 'VESSEL' && <Chip variant="outlined" size="small" label={t(`inspections.subjectKind.${subjectKind}`)} />}
          {doc.vcn && <Chip variant="outlined" size="small" label={`${t('inspections.call')} ${doc.vcn}`} sx={{ fontFamily: MONO, fontSize: 11 }} />}
          {doc.severity && doc.severity !== 'NONE' && <Chip size="small" color={doc.severity === 'CRITICAL' ? 'error' : doc.severity === 'MAJOR' ? 'warning' : 'default'} label={t(`inspections.severity.${doc.severity}`)} />}
          {doc.recommendation && doc.recommendation !== 'NONE' && <Chip size="small" variant="outlined" label={t('inspections.smart.rulesSay', { what: t(`inspections.recommendation.${doc.recommendation}`) })} />}
          {shownPct !== null && (
            <Chip icon={<ShieldRoundedIcon sx={{ fontSize: 15 }} />} label={`${shownPct}% ${t('inspections.compliance')}${doc.status !== 'CLOSED' ? ` (${t('inspections.live')})` : ''}`} size="small" color={shownPct >= passScorePct ? 'success' : 'warning'} sx={{ fontWeight: 700 }} />
          )}
          {live.criticalFail && doc.status !== 'CLOSED' && <Chip size="small" color="error" label={t('inspections.criticalFailed')} />}
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">{doc.startedAt ? t('inspections.startedOn', { date: fmtDT(doc.startedAt) }) : t('inspections.notStarted')}{doc.closedAt ? ` · ${t('inspections.closedOn', { date: fmtDT(doc.closedAt) })}` : ''}</Typography>
        </Stack>
      </Card>

      <Grid container spacing={2}>
        <Grid item xs={12} lg={7}>
          <Card>
            <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('inspections.checklist')} <Typography component="span" variant="caption" color="text.secondary">{t('inspections.answered', { a: answered, b: checklist.length })}</Typography></Typography>
              {canEdit && dirty && <Button size="small" variant="contained" onClick={saveChecklist} disabled={busy}>{t('inspections.saveAnswers')}</Button>}
            </Box>
            <Divider />
            <Table size="small" aria-label={t('inspections.checklist')}>
              <TableBody>
                {checklist.map((item, idx) => (
                  <TableRow key={idx}>
                    <TableCell sx={{ width: 30, color: 'text.secondary', fontFamily: MONO, fontSize: 11 }}>{item.seq}</TableCell>
                    <TableCell>
                      <Typography sx={{ fontSize: 13 }}>{item.text}</Typography>
                      <Typography variant="caption" color="text.secondary">{item.category}</Typography>
                    </TableCell>
                    <TableCell align="right" sx={{ width: 168 }}>
                      <ToggleButtonGroup size="small" exclusive value={item.answer || null} aria-label={`${t('inspections.answer')} — ${item.text}`}
                        onChange={(_, val: Answer | null) => { if (!canEdit) return; setChecklist((c) => c.map((x, i) => (i === idx ? { ...x, answer: val || '' } : x))); setDirty(true); }}
                        sx={{ '& .MuiToggleButton-root': { px: 1, py: 0.25, fontSize: 11, fontWeight: 700 } }}>
                        <ToggleButton value="YES" color="success">YES</ToggleButton>
                        <ToggleButton value="NO" color="error">NO</ToggleButton>
                        <ToggleButton value="NA">N/A</ToggleButton>
                      </ToggleButtonGroup>
                    </TableCell>
                  </TableRow>
                ))}
                {checklist.length === 0 && <TableRow><TableCell colSpan={3}><Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('inspections.noChecklist')}</Typography></TableCell></TableRow>}
              </TableBody>
            </Table>
          </Card>
        </Grid>

        <Grid item xs={12} lg={5}>
          <Card>
            <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('inspections.findings', { n: findings.length })}</Typography>
              {canEdit && <Button size="small" startIcon={<AddRoundedIcon />} onClick={() => { setFindVals({ status: 'OPEN' }); loadCodes(); setFindDlg({}); }}>{t('inspections.addFinding')}</Button>}
            </Box>
            <Divider />
            <Stack divider={<Divider />}>
              {findings.map((f) => (
                <Box key={f.id} sx={{ p: 2, display: 'flex', gap: 1.5 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Chip size="small" label={f.deficiencyCode} sx={{ fontFamily: MONO, height: 20, fontSize: 11 }} />
                      {f.actionCode && <Chip size="small" variant="outlined" label={`${t('inspections.action')} ${f.actionCode}`} sx={{ height: 20, fontSize: 11 }} color={f.actionCode === '30' ? 'error' : 'default'} />}
                      <Chip size="small" label={f.status} color={f.status === 'OPEN' ? 'warning' : 'success'} sx={{ height: 20, fontSize: 10.5 }} />
                    </Stack>
                    <Typography sx={{ fontSize: 13, mt: 0.75 }}>{f.description}</Typography>
                    <Typography variant="caption" color="text.secondary">{t('inspections.due')} {fmtD(f.dueDate)}{f.closedAt ? ` · ${t('inspections.closedLower')} ${fmtD(f.closedAt)}` : ''}</Typography>
                  </Box>
                  {canEdit && (
                    <Stack spacing={0.5}>
                      <IconButton size="small" aria-label={`${t('inspections.editFinding')} ${f.deficiencyCode}`} onClick={() => { setFindVals({ deficiencyCode: f.deficiencyCode, description: f.description, actionCode: f.actionCode || '', dueDate: toInputD(f.dueDate), status: f.status }); loadCodes(); setFindDlg(f); }}><EditRoundedIcon fontSize="inherit" /></IconButton>
                      <IconButton size="small" color="error" aria-label={`${t('common.delete')} ${f.deficiencyCode}`} onClick={() => api.delete(`/inspections/${id}/findings/${f.id}`).then(load).catch(err)}><DeleteOutlineRoundedIcon fontSize="inherit" /></IconButton>
                    </Stack>
                  )}
                </Box>
              ))}
              {findings.length === 0 && <Typography color="text.secondary" sx={{ p: 2.5, textAlign: 'center' }} variant="body2">{t('inspections.noFindings')}</Typography>}
            </Stack>
          </Card>
          {doc.remarks && (
            <Card sx={{ p: 2, mt: 2 }}>
              <Typography variant="subtitle2" gutterBottom>{t('inspections.remarks')}</Typography>
              <Typography variant="body2" color="text.secondary">{doc.remarks}</Typography>
            </Card>
          )}
        </Grid>

        {/* ---- Smart Inspection ---- */}
        <Grid item xs={12} md={6}>
          <Card sx={{ p: 2, height: '100%' }} data-testid="dossier-card">
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('inspections.smart.dossier')}</Typography>
              {canEdit && <Button size="small" startIcon={<RefreshRoundedIcon />} disabled={busy} onClick={refreshDossier}>{t('inspections.smart.refreshDossier')}</Button>}
            </Stack>
            {!dossier && <Typography variant="body2" color="text.secondary">{t('inspections.smart.noDossier')}</Typography>}
            {dossier && (
              <Stack spacing={1.5}>
                <Typography variant="caption" color="text.secondary">{t('inspections.smart.preparedAt', { date: fmtDT(doc.dossierPreparedAt ?? dossier.preparedAt), source: t(`inspections.source.${dossier.source || doc.dossierSource || 'AUTO'}`) })}</Typography>
                <Grid container spacing={1.5}>
                  <Grid item xs={6}><Fact label={t('inspections.subject')} value={String(dossier.subject?.name ?? subjectName)} /></Grid>
                  <Grid item xs={6}><Fact label={t('inspections.smart.priorInspections')} value={`${dossier.history.inspections}${dossier.history.lastResult ? ` · ${t('inspections.smart.last')} ${dossier.history.lastResult.toLowerCase()}` : ''}`} /></Grid>
                  <Grid item xs={6}><Fact label={t('inspections.smart.detentions')} value={dossier.history.detentions ? `${dossier.history.detentions} · ${fmtD(dossier.history.lastDetentionAt)}` : '0'} /></Grid>
                  <Grid item xs={6}><Fact label={t('inspections.smart.openFindingsPrior')} value={dossier.history.openFindings.length} /></Grid>
                </Grid>
                {dossier.history.openFindings.length > 0 && (
                  <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>{dossier.history.openFindings.slice(0, 8).map((f, i) => <Chip key={`${f.code}-${i}`} size="small" variant="outlined" color="warning" label={`${f.code} · ${f.number}`} sx={{ height: 20, fontSize: 10.5, fontFamily: MONO }} />)}</Stack>
                )}
                {dossier.history.recurringCodes.length > 0 && <Typography variant="caption">{t('inspections.smart.recurring')}: {dossier.history.recurringCodes.map((r) => `${r.code} ×${r.times}`).join(', ')}</Typography>}
                {dossier.agentDossier && <Typography variant="caption" color="text.secondary">{t('inspections.smart.agentDossier')}</Typography>}
              </Stack>
            )}
          </Card>
        </Grid>
        <Grid item xs={12} md={6}>
          <Card sx={{ p: 2, height: '100%' }} data-testid="prediction-card">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('inspections.smart.prediction')}</Typography>
            {!prediction && <Typography variant="body2" color="text.secondary">{t('inspections.smart.noPrediction')}</Typography>}
            {prediction && (
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Chip size="small" color={prediction.band === 'HIGH' ? 'error' : prediction.band === 'MEDIUM' ? 'warning' : 'success'} label={t(`inspections.smart.band.${prediction.band}`, { defaultValue: prediction.band })} />
                  <SourceChip source={prediction.source} t={t as never} />
                  <Typography variant="caption" color="text.secondary">{t('inspections.smart.predictedAt', { date: fmtDT(prediction.predictedAt), score: prediction.riskScore ?? '—' })}</Typography>
                </Stack>
                <Fact label={t('inspections.smart.predictedCodes')} value={prediction.predictedCodes.length ? <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>{prediction.predictedCodes.map((c) => <Chip key={c} size="small" label={c} sx={{ height: 20, fontSize: 10.5, fontFamily: MONO }} />)}</Stack> : t('inspections.smart.noneExpected')} />
                {prediction.scoredAt
                  ? <Chip size="small" color={prediction.correlated ? 'success' : 'default'} variant={prediction.correlated ? 'filled' : 'outlined'} label={prediction.correlated ? t('inspections.smart.correlated', { matched: (prediction.outcome?.matched ?? []).join(', ') || '—' }) : t('inspections.smart.notCorrelated')} sx={{ alignSelf: 'flex-start' }} />
                  : <Typography variant="caption" color="text.secondary">{t('inspections.smart.scoredAtClose')}</Typography>}
              </Stack>
            )}
          </Card>
        </Grid>
        <Grid item xs={12} md={6}>
          <Card sx={{ p: 2, height: '100%' }} data-testid="report-card">
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('inspections.smart.report')}</Typography>
              {canWrite && <Button size="small" startIcon={<EditRoundedIcon />} onClick={() => { setVals({}); setDlg('report'); }}>{t('inspections.smart.writeReport')}</Button>}
            </Stack>
            {reports.length === 0 && <Typography variant="body2" color="text.secondary">{open ? t('inspections.smart.reportAfterClose') : t('inspections.smart.noReport')}</Typography>}
            <Stack spacing={1} divider={<Divider />}>
              {reports.map((r) => (
                <Box key={r.id}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography sx={{ fontWeight: 700, fontSize: 13 }}>v{r.version} · {r.title}</Typography>
                    <SourceChip source={r.source} t={t as never} />
                    <Chip size="small" label={t(`inspections.smart.reportStatus.${r.status}`, { defaultValue: r.status })} color={r.status === 'ISSUED' ? 'success' : 'default'} variant="outlined" sx={{ height: 20, fontSize: 10.5 }} />
                    <Box sx={{ flex: 1 }} />
                    {canDecide && !open && r.status === 'DRAFT' && <Button size="small" variant="contained" disabled={busy} onClick={() => issueReport(r)}>{t('inspections.smart.issue')}</Button>}
                    <IconButton size="small" aria-label={t('inspections.smart.readText')} onClick={() => setOpenBody(openBody === r.id ? null : r.id)}><ExpandMoreRoundedIcon sx={{ transform: openBody === r.id ? 'rotate(180deg)' : 'none' }} /></IconButton>
                  </Stack>
                  <Typography variant="caption" color="text.secondary">{t('inspections.smart.draftedBy', { by: r.draftedBy, date: fmtDT(r.draftedAt) })}{r.issuedAt ? ` · ${t('inspections.smart.issuedBy', { by: r.issuedBy, date: fmtDT(r.issuedAt) })}` : ''}</Typography>
                  <Collapse in={openBody === r.id}><Typography sx={{ whiteSpace: 'pre-wrap', fontSize: 12.5, mt: 1, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>{r.body}</Typography></Collapse>
                </Box>
              ))}
            </Stack>
          </Card>
        </Grid>
        <Grid item xs={12} md={6}>
          <Card sx={{ p: 2, height: '100%' }} data-testid="notice-card">
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('inspections.smart.notices')}</Typography>
              {canWrite && <Button size="small" startIcon={<EditRoundedIcon />} onClick={() => { setVals({ kind: 'DEFICIENCY', findingIds: findings.filter((f) => f.status === 'OPEN').map((f) => f.id) }); setDlg('notice'); }}>{t('inspections.smart.draftNotice')}</Button>}
            </Stack>
            {notices.length === 0 && <Typography variant="body2" color="text.secondary">{t('inspections.smart.noNotices')}</Typography>}
            <Stack spacing={1} divider={<Divider />}>
              {notices.map((n) => (
                <Box key={n.id}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography sx={{ fontWeight: 700, fontSize: 13, fontFamily: MONO }}>{n.number}</Typography>
                    <Chip size="small" variant="outlined" label={t(`inspections.smart.noticeKind.${n.kind}`, { defaultValue: n.kind })} sx={{ height: 20, fontSize: 10.5 }} />
                    <SourceChip source={n.source} t={t as never} />
                    <Chip size="small" label={t(`inspections.smart.reportStatus.${n.status}`, { defaultValue: n.status })} color={n.status === 'ISSUED' ? 'success' : 'default'} variant="outlined" sx={{ height: 20, fontSize: 10.5 }} />
                    <Box sx={{ flex: 1 }} />
                    {canDecide && n.status === 'DRAFT' && <Button size="small" variant="contained" disabled={busy} onClick={() => issueNotice(n)}>{t('inspections.smart.issue')}</Button>}
                    <IconButton size="small" aria-label={t('inspections.smart.readText')} onClick={() => setOpenBody(openBody === n.id ? null : n.id)}><ExpandMoreRoundedIcon sx={{ transform: openBody === n.id ? 'rotate(180deg)' : 'none' }} /></IconButton>
                  </Stack>
                  <Typography variant="caption" color="text.secondary">{t('inspections.smart.draftedBy', { by: n.draftedBy, date: fmtDT(n.draftedAt) })}{n.issuedAt ? ` · ${t('inspections.smart.issuedBy', { by: n.issuedBy, date: fmtDT(n.issuedAt) })}` : ''} · {n.addressedTo}</Typography>
                  <Collapse in={openBody === n.id}><Typography sx={{ whiteSpace: 'pre-wrap', fontSize: 12.5, mt: 1, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>{n.body}</Typography></Collapse>
                </Box>
              ))}
            </Stack>
          </Card>
        </Grid>
        <Grid item xs={12} md={7}>
          <Card sx={{ p: 2, height: '100%' }} data-testid="recommendation-card">
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('inspections.smart.recommendations')}</Typography>
              {canWrite && <Button size="small" startIcon={<AddRoundedIcon />} onClick={() => { setVals({ kind: 'RESTRICTION' }); setDlg('recommend'); }}>{t('inspections.smart.recommend')}</Button>}
            </Stack>
            {recommendations.length === 0 && <Typography variant="body2" color="text.secondary">{t('inspections.smart.noRecommendations')}</Typography>}
            <Stack spacing={1} divider={<Divider />}>
              {recommendations.map((r) => (
                <Box key={r.id}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Chip size="small" color={r.kind === 'DETENTION' ? 'error' : 'warning'} label={t(`inspections.smart.recKind.${r.kind}`, { defaultValue: r.kind })} />
                    <Chip size="small" variant="outlined" color={RECOMMENDATION_STATUS_COLOR[r.status] ?? 'default'} label={t(`inspections.smart.recStatus.${r.status}`, { defaultValue: r.status })} sx={{ height: 20, fontSize: 10.5 }} />
                    <SourceChip source={r.source} t={t as never} />
                    <Box sx={{ flex: 1 }} />
                    {canDecide && (r.status === 'PENDING' || r.status === 'DEFERRED') && <Button size="small" variant="contained" onClick={() => { setDecideRec(r); setVals({ decision: 'APPROVED', note: '' }); setDlg('decide'); }}>{t('inspections.smart.decide')}</Button>}
                  </Stack>
                  <Typography sx={{ fontSize: 13, mt: 0.5 }}>{r.grounds}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t('inspections.smart.recommendedAt', { date: fmtDT(r.recommendedAt), by: r.recommendedBy })}
                    {r.routedMinutes !== null ? ` · ${t('inspections.smart.routedIn', { minutes: r.routedMinutes })}` : ` · ${t('inspections.smart.notRouted')}`}
                    {r.decidedAt ? ` · ${t('inspections.smart.decidedBy', { by: r.decidedBy, minutes: r.decidedMinutes ?? 0 })}${r.decisionNote ? ` — ${r.decisionNote}` : ''}` : ''}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Card>
        </Grid>
        <Grid item xs={12} md={5}>
          <Card sx={{ p: 2, height: '100%' }} data-testid="timeline-card">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('inspections.smart.timeline')}</Typography>
            <Typography variant="caption" color="text.secondary">{t('inspections.smart.timelineSub')}</Typography>
            <Stack spacing={0.5} sx={{ mt: 1 }} component="ol" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {timeline.map((e) => (
                <Stack component="li" key={e.id} direction="row" spacing={1} alignItems="baseline">
                  <Typography sx={{ fontFamily: MONO, fontSize: 11, color: 'text.secondary', minWidth: 130 }}>{fmtDT(e.at)}</Typography>
                  <Typography sx={{ fontSize: 12.5 }}>{t(`inspections.smart.event.${e.kind}`, { defaultValue: e.kind.toLowerCase().replace(/_/g, ' ') })}</Typography>
                  {e.source && <Typography variant="caption" color="text.secondary">· {t(`inspections.source.${e.source}`, { defaultValue: e.source })}</Typography>}
                </Stack>
              ))}
              {timeline.length === 0 && <Typography variant="body2" color="text.secondary">{t('inspections.smart.noTimeline')}</Typography>}
            </Stack>
          </Card>
        </Grid>
      </Grid>

      <Dialog open={!!findDlg} onClose={() => !busy && setFindDlg(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{editingFinding ? t('inspections.editFinding') : t('inspections.recordFinding')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <FormFields fields={[
            { name: 'deficiencyCode', label: t('inspections.deficiencyCode'), type: 'autocomplete', required: true, cols: 12, options: defCodes.map((c) => ({ value: c.code, label: `${c.code} — ${c.label}` })) },
            { name: 'description', label: t('inspections.description'), type: 'multiline', required: true, cols: 12 },
            { name: 'actionCode', label: t('inspections.actionCode'), type: 'select', options: actCodes.map((c) => ({ value: c.code, label: `${c.code} — ${c.label}` })) },
            { name: 'dueDate', label: t('inspections.rectifyBy'), type: 'date' },
            { name: 'status', label: t('inspections.status'), type: 'select', options: [{ value: 'OPEN', label: t('inspections.open') }, { value: 'CLOSED', label: t('inspections.closed') }] },
          ]} values={findVals} onChange={setFindVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setFindDlg(null)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" disabled={busy || !findVals.deficiencyCode || !findVals.description} onClick={saveFinding}>{t('common.save')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={closeDlg} onClose={() => !busy && setCloseDlg(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('inspections.closeInspection')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{t('inspections.closeNote', { n: openFindings })}</Typography>
          {live.pct !== null && (
            <Typography variant="caption" sx={{ display: 'block', mb: 2, color: live.criticalFail ? 'error.main' : 'text.secondary' }}>
              {t('inspections.suggested', { result: RESULT_META[live.suggested]?.label, pct: live.pct })}{live.criticalFail ? ` (${t('inspections.criticalFailed')})` : ` (${t('inspections.passMark', { pct: passScorePct })})`}
            </Typography>
          )}
          <FormFields fields={[
            { name: 'result', label: t('inspections.result'), type: 'select', required: true, cols: 12, options: Object.entries(RESULT_META).map(([value, m]) => ({ value, label: m.label })) },
            { name: 'remarks', label: t('inspections.closingRemarks'), type: 'multiline', cols: 12 },
          ]} values={closeVals} onChange={setCloseVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setCloseDlg(false)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" disabled={busy || !closeVals.result} onClick={closeInspection}>{t('inspections.closeInspection')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!dlg} onClose={() => !busy && setDlg(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{dlg ? t(`inspections.smart.dialog.${dlg}`) : ''}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          {dlg === 'report' && <FormFields fields={[{ name: 'title', label: t('inspections.smart.title'), cols: 12 }, { name: 'summary', label: t('inspections.smart.summary'), type: 'multiline', cols: 12 }, { name: 'body', label: t('inspections.smart.body'), type: 'multiline', rows: 8, required: true, cols: 12 }]} values={vals} onChange={setVals} />}
          {dlg === 'notice' && (
            <>
              <FormFields fields={[
                { name: 'kind', label: t('inspections.smart.kind'), type: 'select', options: ['DEFICIENCY', 'DETENTION', 'WARNING', 'RECTIFICATION'].map((k) => ({ value: k, label: t(`inspections.smart.noticeKind.${k}`) })) },
                { name: 'addressedTo', label: t('inspections.smart.addressedTo'), placeholder: subjectName },
                { name: 'subject', label: t('inspections.smart.subjectLine'), cols: 12 }, { name: 'body', label: t('inspections.smart.body'), type: 'multiline', rows: 8, required: true, cols: 12 },
              ]} values={vals} onChange={setVals} />
              <TextField select fullWidth size="small" sx={{ mt: 1.5 }} label={t('inspections.smart.findingsOnNotice')} SelectProps={{ multiple: true }} value={vals.findingIds ?? []} onChange={(e) => setVals((v) => ({ ...v, findingIds: e.target.value }))}>
                {findings.map((f) => <MenuItem key={f.id} value={f.id}>{f.deficiencyCode} — {f.description}</MenuItem>)}
              </TextField>
            </>
          )}
          {dlg === 'recommend' && <FormFields fields={[{ name: 'kind', label: t('inspections.smart.kind'), type: 'select', options: ['DETENTION', 'RESTRICTION', 'BAN'].map((k) => ({ value: k, label: t(`inspections.smart.recKind.${k}`) })) }, { name: 'grounds', label: t('inspections.smart.grounds'), type: 'multiline', required: true, cols: 12 }]} values={vals} onChange={setVals} />}
          {dlg === 'decide' && decideRec && (
            <>
              <Typography variant="body2" sx={{ mb: 1.5 }}>{decideRec.grounds}</Typography>
              <FormFields fields={[{ name: 'decision', label: t('inspections.smart.decision'), type: 'select', required: true, options: ['APPROVED', 'REJECTED', 'DEFERRED'].map((d) => ({ value: d, label: t(`inspections.smart.recStatus.${d}`) })) }, { name: 'note', label: t('inspections.smart.decisionNote'), type: 'multiline', cols: 12 }]} values={vals} onChange={setVals} />
              {vals.decision === 'APPROVED' && decideRec.kind === 'DETENTION' && <Typography variant="caption" color="error.main">{t('inspections.smart.approveDetains')}</Typography>}
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setDlg(null)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" disabled={busy || (dlg === 'report' && !vals.body) || (dlg === 'notice' && !vals.body) || (dlg === 'recommend' && !vals.grounds) || (dlg === 'decide' && !vals.decision)} onClick={submitDialog}>{t('common.save')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
