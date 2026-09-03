import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Tabs, Tab, Table, TableHead, TableRow, TableCell, TableBody, Button, Skeleton, Stack, Chip, Divider, TextField, MenuItem, Avatar, Checkbox, Tooltip, Dialog, DialogTitle, DialogContent, DialogActions, TableContainer, Badge } from '@mui/material';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import AttachFileRoundedIcon from '@mui/icons-material/AttachFileRounded';
import AddTaskRoundedIcon from '@mui/icons-material/AddTaskRounded';
import InsertDriveFileRoundedIcon from '@mui/icons-material/InsertDriveFileRounded';
import PlaceRoundedIcon from '@mui/icons-material/PlaceRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import EntityHover from '../../components/common/EntityHover';
import FormFields from '../../components/common/FormFields';
import { INCIDENT_STATUS_META, SEVERITY_META, TASK_STATUS_META } from '../../utils/status';
import { fmtD, fmtDT, fromNow, titleCase } from '../../utils/format';
import { MONO } from '../../theme';
import { buildTimeline, CHANNEL_COLOR, DIRECTIONS, DOC_TYPES, RCA_CATEGORIES, SOURCES, TRANSITION_LABEL, directionLabel, docSize, isLive, isReopen, transitionsFor } from './constants';
import type { Incident, TransitionPayload } from './types';

/* The case file: facts on top, then the communications thread, response tasks, documents, the merged timeline and the RCA that closes it.
 * Every step goes through the declared lifecycle and lands in the audit log. */
const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box>
    <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography>
    <Typography component="div" sx={{ fontSize: 13.5, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography>
  </Box>
);

export default function IncidentCase() {
  const { id = '' } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const user = useUser();
  const [inc, setInc] = useState<Incident | null>(null);
  const [docTypes, setDocTypes] = useState<string[]>([]);
  const [tab, setTab] = useState(0);
  const [busy, setBusy] = useState(false);
  const [transTo, setTransTo] = useState<string | null>(null);
  const [transNote, setTransNote] = useState('');
  const [commText, setCommText] = useState('');
  const [commChannel, setCommChannel] = useState('PORTAL');
  const [commDirection, setCommDirection] = useState('INTERNAL');
  const [docVals, setDocVals] = useState<{ name?: string; docType?: string }>({});
  const [taskVals, setTaskVals] = useState<{ title?: string; assignee?: string; due?: string }>({});
  const [logText, setLogText] = useState('');
  const [rcaVals, setRcaVals] = useState<Record<string, any>>({});

  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const load = useCallback(() => api.get<Incident>(`/incidents/${id}`).then((r) => { setInc(r.data); setRcaVals({ ...(r.data.rca || {}) }); }).catch(err), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
    api.get<{ code: string }[]>('/lookups', { params: { category: 'documentType', limit: 50 } }).then((r) => setDocTypes(r.data.map((d) => d.code))).catch(() => {});
  }, [load]);

  if (!inc) return <Skeleton variant="rounded" height={480} />;
  const canManage = hasPerm(user, 'incidents.manage');
  const allowed = transitionsFor(inc.status);
  const live = isLive(inc.status);
  const canWork = canManage && live;
  const labelFor = (to: string) => (isReopen(inc.status, to) ? t('incidents.reopen') : TRANSITION_LABEL[to] || titleCase(to));
  const comms = [...(inc.comms || [])].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const tasks = inc.tasks || [];
  const documents = inc.documents || [];
  const timeline = buildTimeline(inc);
  const openTasks = tasks.filter((x) => x.status === 'OPEN').length;
  const rcaDisabled = !canWork;

  const doTransition = () => {
    if (!transTo) return;
    setBusy(true);
    const body: TransitionPayload = { to: transTo as TransitionPayload['to'], note: transNote };
    api.post(`/incidents/${id}/transition`, body)
      .then(() => { dispatch(notify(t('incidents.movedTo', { status: titleCase(transTo) }))); setTransTo(null); setTransNote(''); load(); })
      .catch(err).finally(() => setBusy(false));
  };
  const post = (url: string, body: unknown, after?: () => void) => { setBusy(true); api.post(url, body).then(() => { after?.(); load(); }).catch(err).finally(() => setBusy(false)); };
  const sendComm = () => { if (!commText.trim()) return; post(`/incidents/${id}/comms`, { channel: commChannel, direction: commDirection, message: commText.trim() }, () => setCommText('')); };
  const addLog = () => { if (!logText.trim()) return; post(`/incidents/${id}/log`, { entry: logText.trim() }, () => setLogText('')); };
  const setTask = (taskId: string, done: boolean) => { setBusy(true); api.put(`/incidents/${id}/tasks/${taskId}`, { status: done ? 'DONE' : 'OPEN' }).then(load).catch(err).finally(() => setBusy(false)); };
  const saveRca = () => { setBusy(true); api.put(`/incidents/${id}`, { rca: rcaVals }).then(() => { dispatch(notify(t('incidents.rcaSaved'))); load(); }).catch(err).finally(() => setBusy(false)); };

  return (
    <>
      <PageHeader crumbs={[{ label: t('incidents.crumb'), to: '/incidents' }, { label: inc.number }]}
        title={<Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
          <span>{inc.number}</span>
          <StatusChip value={inc.severity} map={SEVERITY_META} />
          <StatusChip value={inc.status} map={INCIDENT_STATUS_META} />
          <Chip size="small" variant="outlined" label={inc.priority} sx={{ height: 20, fontWeight: 700 }} />
        </Stack>}
        sub={inc.title}
        actions={canManage && (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {allowed.map((to) => (
              <Button key={to} size="small" variant={['RESOLVED', 'CLOSED'].includes(to) ? 'contained' : 'outlined'}
                color={to === 'CLOSED' ? 'success' : isReopen(inc.status, to) ? 'warning' : 'primary'} onClick={() => { setTransTo(to); setTransNote(''); }}>
                {labelFor(to)}
              </Button>
            ))}
          </Stack>
        )} />

      <Card sx={{ p: 2.5, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid item xs={6} md={2.4}><Item label="Category / type" value={`${titleCase(inc.category)} · ${titleCase(inc.type)}`} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Reported" value={<span title={fmtDT(inc.reportedAt)}>{fromNow(inc.reportedAt)}</span>} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Reported by" value={`${inc.reportedBy || '—'} · via ${inc.source}`} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Case officer" value={inc.assignedToId ? <EntityHover type="user" id={inc.assignedToId}><span>{inc.assignedTo}</span></EntityHover> : (inc.assignedTo || 'Unassigned')} /></Grid>
          <Grid item xs={6} md={2.4}>
            <Item label="Location" value={<Stack direction="row" spacing={0.5} alignItems="center">
              <PlaceRoundedIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
              <span>{inc.berthCode ? `${inc.berthCode}${inc.berthTerminal ? ` — ${inc.berthTerminal}` : ''}` : (inc.location?.area || '—')}</span>
            </Stack>} />
          </Grid>
          <Grid item xs={6} md={2.4}><Item label="Vessel / craft" value={inc.vesselId ? <EntityHover type="vessel" id={inc.vesselId}><span>{inc.vesselName}</span></EntityHover> : (inc.vesselName || '—')} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Weather" value={inc.weather?.windKn ? `Wind ${inc.weather.windKn} kn · sea state ${inc.weather.seaState ?? '—'}` : '—'} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Injuries" value={String(inc.injuries || 0)} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Pollution tier" value={inc.pollutionTier ? `Tier ${inc.pollutionTier}` : 'None'} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Assets tasked" value={(inc.assets || []).join(', ') || '—'} /></Grid>
          {inc.description && <Grid item xs={12}><Item label="First information" value={inc.description} /></Grid>}
        </Grid>
      </Card>

      <Card>
        <Tabs value={tab} onChange={(_, v: number) => setTab(v)} variant="scrollable" allowScrollButtonsMobile aria-label="Case file sections" sx={{ px: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Tab label={t('incidents.tabComms', { n: comms.length })} />
          <Tab label={<Badge color="warning" badgeContent={openTasks} sx={{ '& .MuiBadge-badge': { right: -10 } }}>{t('incidents.tabTasks')}</Badge>} />
          <Tab label={t('incidents.tabDocs', { n: documents.length })} />
          <Tab label={t('incidents.tabTimeline')} />
          <Tab label={t('incidents.tabRca')} />
        </Tabs>

        {tab === 0 && (
          <Box sx={{ p: 2.5 }}>
            {canWork && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2.5 }}>
                <TextField select size="small" label="Channel" value={commChannel} onChange={(e) => setCommChannel(e.target.value)} sx={{ width: 120 }}>
                  {SOURCES.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
                </TextField>
                <TextField select size="small" label="Direction" value={commDirection} onChange={(e) => setCommDirection(e.target.value)} sx={{ width: 130 }}>
                  {DIRECTIONS.map((d) => <MenuItem key={d} value={d}>{titleCase(d)}</MenuItem>)}
                </TextField>
                <TextField size="small" fullWidth placeholder="Record a message, call or radio exchange…" inputProps={{ 'aria-label': 'Message' }} value={commText}
                  onChange={(e) => setCommText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendComm(); }} />
                <Button variant="contained" endIcon={<SendRoundedIcon />} disabled={busy || !commText.trim()} onClick={sendComm}>Log</Button>
              </Stack>
            )}
            <Stack spacing={1.5}>
              {comms.map((c) => (
                <Box key={c.id} sx={{ display: 'flex', gap: 1.5 }}>
                  <Avatar sx={{ width: 34, height: 34, fontSize: 12.5, fontWeight: 700, bgcolor: CHANNEL_COLOR[c.channel] || 'grey.600' }}>{c.channel.slice(0, 3)}</Avatar>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                      <Typography sx={{ fontSize: 13, fontWeight: 700 }}>{c.by}</Typography>
                      <Chip size="small" variant="outlined" label={directionLabel(c.direction)} sx={{ height: 17, fontSize: 9.5 }} />
                      <Typography variant="caption" color="text.secondary" title={fmtDT(c.at)}>{fromNow(c.at)}</Typography>
                    </Stack>
                    <Typography sx={{ fontSize: 13.5, mt: 0.25 }}>{c.message}</Typography>
                  </Box>
                </Box>
              ))}
              {comms.length === 0 && <Typography color="text.secondary" sx={{ textAlign: 'center', py: 3 }}>{t('incidents.noComms')}</Typography>}
            </Stack>
          </Box>
        )}

        {tab === 1 && (
          <Box sx={{ p: 2.5 }}>
            {canWork && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2 }}>
                <TextField size="small" fullWidth label="New response task" value={taskVals.title || ''} onChange={(e) => setTaskVals((v) => ({ ...v, title: e.target.value }))} />
                <TextField size="small" label="Assignee" value={taskVals.assignee || ''} sx={{ minWidth: 170 }} onChange={(e) => setTaskVals((v) => ({ ...v, assignee: e.target.value }))} />
                <TextField size="small" type="date" label="Due" InputLabelProps={{ shrink: true }} value={taskVals.due || ''} sx={{ minWidth: 150 }} onChange={(e) => setTaskVals((v) => ({ ...v, due: e.target.value }))} />
                <Button variant="contained" startIcon={<AddTaskRoundedIcon />} disabled={busy || !taskVals.title} onClick={() => post(`/incidents/${id}/tasks`, taskVals, () => setTaskVals({}))}>Add</Button>
              </Stack>
            )}
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label="Response tasks">
                <TableHead><TableRow><TableCell width={40}>Done</TableCell><TableCell>Task</TableCell><TableCell>Assignee</TableCell><TableCell>Due</TableCell><TableCell>Status</TableCell></TableRow></TableHead>
                <TableBody>
                  {tasks.map((task) => (
                    <TableRow key={task.id} sx={{ opacity: task.status === 'DONE' ? 0.62 : 1 }}>
                      <TableCell padding="checkbox"><Checkbox size="small" checked={task.status === 'DONE'} disabled={!canManage || busy} inputProps={{ 'aria-label': `Done — ${task.title}` }} onChange={(e) => setTask(task.id, e.target.checked)} /></TableCell>
                      <TableCell sx={{ textDecoration: task.status === 'DONE' ? 'line-through' : 'none', fontWeight: 600 }}>{task.title}</TableCell>
                      <TableCell>{task.assignee || '—'}</TableCell>
                      <TableCell>{task.due ? fmtD(task.due) : '—'}</TableCell>
                      <TableCell><StatusChip value={task.status} map={TASK_STATUS_META} /></TableCell>
                    </TableRow>
                  ))}
                  {tasks.length === 0 && <TableRow><TableCell colSpan={5}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('incidents.noTasks')}</Typography></TableCell></TableRow>}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {tab === 2 && (
          <Box sx={{ p: 2.5 }}>
            {canWork && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2 }}>
                <TextField size="small" fullWidth label="Document name (with extension)" value={docVals.name || ''} placeholder="e.g. site-photographs.zip" onChange={(e) => setDocVals((v) => ({ ...v, name: e.target.value }))} />
                <TextField select size="small" label="Type" value={docVals.docType || 'REPORT'} sx={{ minWidth: 140 }} onChange={(e) => setDocVals((v) => ({ ...v, docType: e.target.value }))}>
                  {(docTypes.length ? docTypes : DOC_TYPES).map((d) => <MenuItem key={d} value={d}>{titleCase(d)}</MenuItem>)}
                </TextField>
                <Button variant="contained" startIcon={<AttachFileRoundedIcon />} disabled={busy || !docVals.name}
                  onClick={() => post(`/incidents/${id}/documents`, { name: docVals.name, docType: docVals.docType || 'REPORT', sizeKB: Math.round(200 + Math.random() * 4000) }, () => setDocVals({}))}>Attach</Button>
              </Stack>
            )}
            <Grid container spacing={1.5}>
              {documents.map((d) => (
                <Grid item xs={12} sm={6} md={4} key={d.id}>
                  <Card variant="outlined" sx={{ p: 1.5, display: 'flex', gap: 1.25, alignItems: 'center' }}>
                    <InsertDriveFileRoundedIcon sx={{ color: 'text.secondary' }} />
                    <Box sx={{ minWidth: 0 }}>
                      <Tooltip title={d.name}><Typography noWrap sx={{ fontSize: 13, fontWeight: 600 }}>{d.name}</Typography></Tooltip>
                      <Typography variant="caption" color="text.secondary">{titleCase(d.docType)} · {docSize(d.sizeKB)} · {d.uploadedBy} · {fromNow(d.at)}</Typography>
                    </Box>
                  </Card>
                </Grid>
              ))}
              {documents.length === 0 && <Grid item xs={12}><Typography color="text.secondary" sx={{ textAlign: 'center', py: 3 }}>{t('incidents.noDocs')}</Typography></Grid>}
            </Grid>
          </Box>
        )}

        {tab === 3 && (
          <Box sx={{ p: 2.5 }}>
            {canWork && (
              <Stack direction="row" spacing={1} sx={{ mb: 2.5 }}>
                <TextField size="small" fullWidth placeholder="Add an operational log entry…" inputProps={{ 'aria-label': 'Log entry' }} value={logText} onChange={(e) => setLogText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addLog(); }} />
                <Button variant="outlined" disabled={busy || !logText.trim()} onClick={addLog}>Add entry</Button>
              </Stack>
            )}
            <Stack spacing={0}>
              {timeline.map((x, i) => (
                <Box key={i} sx={{ display: 'flex', gap: 1.5, position: 'relative', pb: i === timeline.length - 1 ? 0 : 2 }}>
                  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <Box sx={{ width: 10, height: 10, borderRadius: '50%', mt: 0.6, flexShrink: 0, bgcolor: x.kind === 'STATUS' ? 'primary.main' : x.kind === 'DOC' ? 'success.main' : 'text.disabled' }} />
                    {i !== timeline.length - 1 && <Box sx={{ width: '2px', flex: 1, bgcolor: 'divider', mt: 0.5 }} />}
                  </Box>
                  <Box sx={{ pb: 0.5, minWidth: 0 }}>
                    <Typography sx={{ fontSize: 13, fontWeight: x.kind === 'STATUS' ? 700 : 500 }}>{x.text}</Typography>
                    <Typography variant="caption" color="text.secondary">{x.who} · {fmtDT(x.at)}</Typography>
                  </Box>
                </Box>
              ))}
            </Stack>
          </Box>
        )}

        {tab === 4 && (
          <Box sx={{ p: 2.5, maxWidth: 860 }}>
            {!live && inc.outcome && (
              <Card variant="outlined" sx={{ p: 2, mb: 2, borderColor: 'success.main' }}>
                <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'success.main' }}>{t('incidents.outcome')}</Typography>
                <Typography sx={{ fontSize: 14, fontWeight: 600, mt: 0.5 }}>{inc.outcome}</Typography>
                <Typography variant="caption" color="text.secondary">Resolved {inc.resolvedAt ? fmtDT(inc.resolvedAt) : '—'}{inc.closedAt ? ` · closed ${fmtDT(inc.closedAt)}` : ''}</Typography>
              </Card>
            )}
            <FormFields fields={[
              { name: 'rootCause', label: 'Root cause', cols: 12, disabled: rcaDisabled },
              { name: 'category', label: 'RCA category', type: 'select', disabled: rcaDisabled, options: RCA_CATEGORIES.map((c) => ({ value: c, label: c })) },
              { name: 'correctiveAction', label: 'Corrective action (what fixed it)', type: 'multiline', rows: 2, cols: 12, disabled: rcaDisabled },
              { name: 'preventiveAction', label: 'Preventive action (what stops recurrence)', type: 'multiline', rows: 2, cols: 12, disabled: rcaDisabled },
            ]} values={rcaVals} onChange={setRcaVals} />
            {canWork && <Button variant="contained" sx={{ mt: 2 }} disabled={busy} onClick={saveRca}>{t('incidents.saveRca')}</Button>}
            <Divider sx={{ my: 2.5 }} />
            <Typography variant="caption" color="text.secondary">{t('incidents.lifecycleNote')}</Typography>
          </Box>
        )}
      </Card>

      <Dialog open={!!transTo} onClose={() => !busy && setTransTo(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{transTo && (isReopen(inc.status, transTo) ? t('incidents.reopenQ', { number: inc.number }) : `${labelFor(transTo)} — ${inc.number}`)}</DialogTitle>
        <DialogContent sx={{ pt: '10px !important' }}>
          <TextField autoFocus fullWidth size="small" multiline minRows={2} label={transTo === 'RESOLVED' ? 'Resolution summary (required)' : 'Note (optional)'} value={transNote} onChange={(e) => setTransNote(e.target.value)} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setTransTo(null)} disabled={busy}>Cancel</Button>
          <Button variant="contained" onClick={doTransition} disabled={busy || (transTo === 'RESOLVED' && !transNote.trim())}>{t('incidents.confirm')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
