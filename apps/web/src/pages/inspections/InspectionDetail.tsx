import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Box, Typography, Button, Stack, Table, TableRow, TableCell, TableBody, ToggleButtonGroup, ToggleButton, IconButton, Dialog, DialogTitle, DialogContent, DialogActions, Skeleton, Chip, Grid, Divider } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded';
import ShieldRoundedIcon from '@mui/icons-material/ShieldRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import FormFields from '../../components/common/FormFields';
import { INSPECTION_STATUS_META, RESULT_META } from '../../utils/status';
import { fmtDT, toInputD, fmtD } from '../../utils/format';
import { MONO } from '../../theme';
import { DEFAULT_PASS_PCT, scoreChecklist } from './constants';
import type { Answer, ChecklistAnswer, ChecklistTemplate, ClosePayload, Finding, FindingPayload, Inspection, LookupOption } from './types';

/* One survey: the checklist answered on the left, findings on the right, a live weighted compliance score and the close dialog that suggests the result. */
export default function InspectionDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const user = useUser();
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
  const canClose = hasPerm(user, 'inspections.close') && open;
  const findings = doc.findings || [];
  const openFindings = findings.filter((f) => f.status === 'OPEN').length;
  const shownPct = doc.status === 'CLOSED' ? (doc.scorePct ?? null) : live.pct;
  const editingFinding = findDlg && 'id' in findDlg ? (findDlg as Finding) : null;
  const answered = checklist.filter((i) => i.answer).length;

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

  return (
    <>
      <PageHeader crumbs={[{ label: t('inspections.crumb'), to: '/inspections' }, { label: doc.number }]}
        title={<>{doc.number} <Typography component="span" sx={{ color: 'text.secondary', fontSize: 16, ml: 1 }}>{doc.vesselName}</Typography></>}
        sub={`${doc.type} inspection · ${doc.inspector} · planned ${fmtDT(doc.plannedAt)}`}
        actions={<>
          {canEdit && doc.status === 'PLANNED' && <Button variant="outlined" startIcon={<PlayArrowRoundedIcon />} onClick={start}>{t('inspections.startInspection')}</Button>}
          {canClose && <Button variant="contained" startIcon={<TaskAltRoundedIcon />} onClick={() => { setCloseVals({ remarks: doc.remarks || '', result: live.suggested }); setCloseDlg(true); }}>{t('inspections.closeInspection')}</Button>}
        </>} />
      <Card sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <StatusChip value={doc.status} map={INSPECTION_STATUS_META} size="medium" />
          {doc.result && <StatusChip value={doc.result} map={RESULT_META} size="medium" />}
          {doc.detention && <Chip color="error" label={t('inspections.detained')} size="small" />}
          {doc.vcn && <Chip variant="outlined" size="small" label={`Call ${doc.vcn}`} sx={{ fontFamily: MONO, fontSize: 11 }} />}
          {shownPct !== null && (
            <Chip icon={<ShieldRoundedIcon sx={{ fontSize: 15 }} />} label={`${shownPct}% compliance${doc.status !== 'CLOSED' ? ' (live)' : ''}`} size="small" color={shownPct >= passScorePct ? 'success' : 'warning'} sx={{ fontWeight: 700 }} />
          )}
          {live.criticalFail && doc.status !== 'CLOSED' && <Chip size="small" color="error" label={t('inspections.criticalFailed')} />}
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">{doc.startedAt ? `Started ${fmtDT(doc.startedAt)}` : t('inspections.notStarted')}{doc.closedAt ? ` · Closed ${fmtDT(doc.closedAt)}` : ''}</Typography>
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
                      <ToggleButtonGroup size="small" exclusive value={item.answer || null} aria-label={`Answer — ${item.text}`}
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
                      {f.actionCode && <Chip size="small" variant="outlined" label={`Action ${f.actionCode}`} sx={{ height: 20, fontSize: 11 }} color={f.actionCode === '30' ? 'error' : 'default'} />}
                      <Chip size="small" label={f.status} color={f.status === 'OPEN' ? 'warning' : 'success'} sx={{ height: 20, fontSize: 10.5 }} />
                    </Stack>
                    <Typography sx={{ fontSize: 13, mt: 0.75 }}>{f.description}</Typography>
                    <Typography variant="caption" color="text.secondary">Due {fmtD(f.dueDate)}{f.closedAt ? ` · closed ${fmtD(f.closedAt)}` : ''}</Typography>
                  </Box>
                  {canEdit && (
                    <Stack spacing={0.5}>
                      <IconButton size="small" aria-label={`Edit finding ${f.deficiencyCode}`} onClick={() => { setFindVals({ deficiencyCode: f.deficiencyCode, description: f.description, actionCode: f.actionCode || '', dueDate: toInputD(f.dueDate), status: f.status }); loadCodes(); setFindDlg(f); }}><EditRoundedIcon fontSize="inherit" /></IconButton>
                      <IconButton size="small" color="error" aria-label={`Delete finding ${f.deficiencyCode}`} onClick={() => api.delete(`/inspections/${id}/findings/${f.id}`).then(load).catch(err)}><DeleteOutlineRoundedIcon fontSize="inherit" /></IconButton>
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
      </Grid>

      <Dialog open={!!findDlg} onClose={() => !busy && setFindDlg(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{editingFinding ? t('inspections.editFinding') : t('inspections.recordFinding')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <FormFields fields={[
            { name: 'deficiencyCode', label: 'Deficiency code', type: 'autocomplete', required: true, cols: 12, options: defCodes.map((c) => ({ value: c.code, label: `${c.code} — ${c.label}` })) },
            { name: 'description', label: 'Description', type: 'multiline', required: true, cols: 12 },
            { name: 'actionCode', label: 'Action code', type: 'select', options: actCodes.map((c) => ({ value: c.code, label: `${c.code} — ${c.label}` })) },
            { name: 'dueDate', label: 'Rectify by', type: 'date' },
            { name: 'status', label: 'Status', type: 'select', options: [{ value: 'OPEN', label: 'Open' }, { value: 'CLOSED', label: 'Closed' }] },
          ]} values={findVals} onChange={setFindVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setFindDlg(null)} disabled={busy}>Cancel</Button>
          <Button variant="contained" disabled={busy || !findVals.deficiencyCode || !findVals.description} onClick={saveFinding}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={closeDlg} onClose={() => !busy && setCloseDlg(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('inspections.closeInspection')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{openFindings} open finding(s). Closing as <b>Detained</b> raises a detention notification.</Typography>
          {live.pct !== null && (
            <Typography variant="caption" sx={{ display: 'block', mb: 2, color: live.criticalFail ? 'error.main' : 'text.secondary' }}>
              Suggested from the checklist: <b>{RESULT_META[live.suggested]?.label}</b> ({live.pct}% weighted compliance{live.criticalFail ? ', a critical question failed' : `, pass mark ${passScorePct}%`}) — pre-filled below, change if needed.
            </Typography>
          )}
          <FormFields fields={[
            { name: 'result', label: 'Result', type: 'select', required: true, cols: 12, options: Object.entries(RESULT_META).map(([value, m]) => ({ value, label: m.label })) },
            { name: 'remarks', label: 'Closing remarks', type: 'multiline', cols: 12 },
          ]} values={closeVals} onChange={setCloseVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setCloseDlg(false)} disabled={busy}>Cancel</Button>
          <Button variant="contained" disabled={busy || !closeVals.result} onClick={closeInspection}>{t('inspections.closeInspection')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
