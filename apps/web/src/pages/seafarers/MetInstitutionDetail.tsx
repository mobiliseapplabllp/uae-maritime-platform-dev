import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid, IconButton, LinearProgress, MenuItem, Skeleton, Stack, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, TextField, Tooltip, Typography } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import PauseCircleOutlineRoundedIcon from '@mui/icons-material/PauseCircleOutlineRounded';
import PlayCircleOutlineRoundedIcon from '@mui/icons-material/PlayCircleOutlineRounded';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import FormDrawer from '../../components/common/FormDrawer';
import FormFields from '../../components/common/FormFields';
import EntityHover from '../../components/common/EntityHover';
import { useLookups } from '../../hooks/useLookups';
import { fmtD, fmtDT, fmtNum } from '../../utils/format';
import { MONO } from '../../theme';
import type { FieldSpec } from '../../types';
import { CycleCard } from '../facilities/AccreditationPanel';
import VisitsPanel from '../facilities/VisitsPanel';
import type { CompanyOverlay } from '../facilities/types';
import type { AuditEntry } from './types';
import { accreditationStatusMeta, institutionStatusMeta, programmeStatusMeta } from './shared';
import type { Institution, MetReference, Programme } from './metTypes';

/* One training provider: what it is approved to teach, where its accreditation stands (mirrored from the
 * facilities engine, with the cycles and audit visits read from there), its profile and its change trail. */
const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box><Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography><Typography component="div" sx={{ fontSize: 14, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography></Box>
);
const mono = { fontFamily: MONO, fontSize: 12 } as const;

export default function MetInstitutionDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate(); const dispatch = useAppDispatch(); const user = useUser(); const { t } = useTranslation();
  const types = useLookups('metInstitutionType'); const programmes = useLookups('metProgramme');
  const [doc, setDoc] = useState<Institution | null>(null);
  const [ref, setRef] = useState<MetReference | null>(null);
  const [tab, setTab] = useState(0);
  const [overlay, setOverlay] = useState<CompanyOverlay | null | undefined>(undefined);
  const [history, setHistory] = useState<AuditEntry[] | undefined>(undefined);
  const [progDlg, setProgDlg] = useState(false); const [progVals, setProgVals] = useState<Record<string, any>>({});
  const [reason, setReason] = useState<{ kind: 'withdraw' | 'suspend' | 'status'; programme?: Programme; status?: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  const load = useCallback(() => api.get<Institution>(`/seafarers/met/institutions/${id}`).then((r) => setDoc(r.data)).catch(err), [id, err]);
  useEffect(() => { load(); api.get<MetReference>('/seafarers/met/reference', { headers: { 'X-Quiet': '1' } }).then((r) => setRef(r.data)).catch(() => setRef(null)); }, [load]);
  useEffect(() => { setTab(0); setOverlay(undefined); setHistory(undefined); }, [id]);
  const loadOverlay = useCallback(() => {
    if (!doc) return;
    if (!hasPerm(user, 'facilities.view')) { setOverlay(null); return; }
    api.get<CompanyOverlay>(`/companies/${doc.companyId}`, { headers: { 'X-Quiet': '1' } }).then((r) => setOverlay(r.data)).catch(() => setOverlay(null));
  }, [doc, user]);
  useEffect(() => {
    if (tab === 1 && overlay === undefined) loadOverlay();
    if (tab === 3 && history === undefined) {
      if (!hasPerm(user, 'audit.view')) setHistory([]);
      else api.get<AuditEntry[]>('/audit', { params: { entity: 'MetInstitution', entityId: doc?.id, limit: 50, sort: '-at' } }).then((r) => setHistory(r.data)).catch(() => setHistory([]));
    }
  }, [tab, overlay, history, loadOverlay, user, doc?.id]);

  if (!doc) return <Skeleton variant="rounded" height={420} />;
  const canEdit = hasPerm(user, 'seafarers.edit');
  const accr = accreditationStatusMeta(t); const inst = institutionStatusMeta(t); const prog = programmeStatusMeta(t);
  const schemes = new Set(ref?.schemes ?? []);
  const cycles = (overlay?.accreditations ?? []).filter((c) => schemes.has(c.category));

  const progFields: FieldSpec[] = [
    { name: 'programme', label: t('seafarers.met.programme'), type: 'select', required: true, lookup: 'metProgramme', cols: 12 },
    { name: 'seatsPerIntake', label: t('seafarers.met.seatsPerIntake'), type: 'number' }, { name: 'intakesPerYear', label: t('seafarers.met.intakesPerYear'), type: 'number' },
    { name: 'approvalNo', label: t('seafarers.met.approvalNo'), helper: t('seafarers.met.approvalHelper') }, { name: 'approvedOn', label: t('seafarers.met.approvedOn'), type: 'date' },
    { name: 'expiresOn', label: t('seafarers.met.expiresOn'), type: 'date' }, { name: 'remarks', label: t('seafarers.met.remarks'), type: 'multiline', cols: 12 },
  ];
  const saveProgramme = () => {
    setBusy(true);
    api.post(`/seafarers/met/institutions/${doc.id}/programmes`, { ...progVals, seatsPerIntake: Number(progVals.seatsPerIntake || 0), intakesPerYear: Number(progVals.intakesPerYear || 1), approvedOn: progVals.approvedOn || null, expiresOn: progVals.expiresOn || null })
      .then(() => { dispatch(notify(t('seafarers.met.programmeSaved'))); setProgDlg(false); load(); }).catch(err).finally(() => setBusy(false));
  };
  const amend = (p: Programme, patch: Record<string, unknown>, done: string) => {
    setBusy(true);
    api.put(`/seafarers/met/institutions/${doc.id}/programmes/${p.id}`, patch).then(() => { dispatch(notify(done)); setReason(null); load(); }).catch(err).finally(() => setBusy(false));
  };
  const confirmReason = () => {
    if (!reason) return;
    if (reason.kind === 'withdraw' && reason.programme) { setBusy(true); api.post(`/seafarers/met/institutions/${doc.id}/programmes/${reason.programme.id}/withdraw`, { reason: reason.text }).then(() => { dispatch(notify(t('seafarers.met.withdrawn'))); setReason(null); load(); }).catch(err).finally(() => setBusy(false)); }
    if (reason.kind === 'suspend' && reason.programme) amend(reason.programme, { status: 'SUSPENDED', statusReason: reason.text }, t('seafarers.met.programmeSaved'));
    if (reason.kind === 'status') { setBusy(true); api.post(`/seafarers/met/institutions/${doc.id}/status`, { status: reason.status, reason: reason.text }).then(() => { dispatch(notify(t('seafarers.met.statusChanged'))); setReason(null); load(); }).catch(err).finally(() => setBusy(false)); }
  };
  const a = doc.accreditation;
  return (
    <>
      <PageHeader crumbs={[{ label: t('seafarers.met.crumb'), to: '/seafarers/met' }, { label: doc.name }]}
        title={<Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap><span>{doc.name}</span><StatusChip value={doc.status} map={inst} /><StatusChip value={a.status} map={accr} /></Stack>}
        sub={`${doc.code} · ${types.label(doc.institutionType)}${doc.city ? ` · ${doc.city}` : ''}${doc.nameAr ? ` · ${doc.nameAr}` : ''}`}
        actions={canEdit && <Button variant="outlined" color="inherit" onClick={() => setReason({ kind: 'status', status: doc.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE', text: '' })}>{t('seafarers.met.setStatus')}</Button>} />
      <Card sx={{ p: 2.5, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid item xs={6} md={2}><Item label={t('seafarers.met.accreditation')} value={<StatusChip value={a.status} map={accr} />} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.met.instrumentNo')} value={a.instrumentNo ? <span style={mono}>{a.instrumentNo}</span> : '—'} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.met.until')} value={a.until ? <>{fmtD(a.until)}<Typography variant="caption" color={a.daysLeft != null && a.daysLeft < 0 ? 'error.main' : 'text.secondary'} sx={{ display: 'block' }}>{a.daysLeft != null && a.daysLeft < 0 ? t('seafarers.met.expiredAgo', { count: -a.daysLeft }) : t('seafarers.met.daysLeft', { count: a.daysLeft ?? 0 })}</Typography></> : '—'} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.met.programmes')} value={`${doc.approvedProgrammes}/${doc.programmeCount}`} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.met.seatsPerYear')} value={fmtNum(doc.seatsPerYear)} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.met.company')} value={<EntityHover type="company" id={doc.code}><Button size="small" sx={{ p: 0, minWidth: 0 }} onClick={() => navigate(`/companies/${doc.companyId}`)}>{doc.code}</Button></EntityHover>} /></Grid>
        </Grid>
      </Card>
      <Card>
        <Tabs value={tab} onChange={(_, v: number) => setTab(v)} variant="scrollable" allowScrollButtonsMobile aria-label={t('seafarers.met.sections')} sx={{ px: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Tab label={`${t('seafarers.met.tabProgrammes')} (${doc.programmes.length})`} /><Tab label={t('seafarers.met.tabAccreditation')} /><Tab label={t('seafarers.met.tabProfile')} /><Tab label={t('seafarers.met.tabHistory')} />
        </Tabs>
        {tab === 0 && (
          <Box sx={{ p: 2 }}>
            {canEdit && doc.status === 'ACTIVE' && <Button size="small" startIcon={<AddRoundedIcon />} sx={{ mb: 1 }} onClick={() => { setProgVals({ intakesPerYear: 1 }); setProgDlg(true); }}>{t('seafarers.met.addProgramme')}</Button>}
            <TableContainer sx={{ overflowX: 'auto' }}><Table size="small" aria-label={t('seafarers.met.tabProgrammes')}>
              <TableHead><TableRow><TableCell>{t('seafarers.met.programme')}</TableCell><TableCell>{t('seafarers.met.regulation')}</TableCell><TableCell align="right">{t('seafarers.met.seatsPerIntake')}</TableCell><TableCell align="right">{t('seafarers.met.seatsPerYear')}</TableCell><TableCell>{t('seafarers.met.approvalNo')}</TableCell><TableCell>{t('seafarers.met.expiresOn')}</TableCell><TableCell>{t('seafarers.met.status')}</TableCell><TableCell align="right" /></TableRow></TableHead>
              <TableBody>
                {doc.programmes.map((p) => (
                  <TableRow key={p.id} hover>
                    <TableCell><b>{programmes.label(p.programme) || p.title}</b>{p.statusReason && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{p.statusReason}</Typography>}</TableCell>
                    <TableCell sx={mono}>{p.regulation || '—'}</TableCell>
                    <TableCell align="right">{p.seatsPerIntake} × {p.intakesPerYear}</TableCell><TableCell align="right">{fmtNum(p.seatsPerYear)}</TableCell>
                    <TableCell sx={mono}>{p.approvalNo || '—'}</TableCell>
                    <TableCell>{fmtD(p.expiresOn)}{p.expired && <Chip size="small" color="error" label={t('seafarers.fl.expired')} sx={{ ml: 0.5, height: 18, fontSize: 10 }} />}</TableCell>
                    <TableCell><StatusChip value={p.status} map={prog} /></TableCell>
                    <TableCell align="right">
                      {canEdit && p.status !== 'WITHDRAWN' && (
                        <Stack direction="row" spacing={0.25} justifyContent="flex-end">
                          {p.status === 'PENDING' && <Tooltip title={t('seafarers.met.approveProgramme')}><IconButton size="small" aria-label={`${t('seafarers.met.approveProgramme')} ${p.title}`} onClick={() => { const no = window.prompt(t('seafarers.met.approvalNo')); if (no) amend(p, { status: 'APPROVED', approvalNo: no }, t('seafarers.met.programmeSaved')); }}><CheckCircleOutlineRoundedIcon fontSize="inherit" /></IconButton></Tooltip>}
                          {p.status === 'APPROVED' && <Tooltip title={t('seafarers.met.suspendProgramme')}><IconButton size="small" aria-label={`${t('seafarers.met.suspendProgramme')} ${p.title}`} onClick={() => setReason({ kind: 'suspend', programme: p, text: '' })}><PauseCircleOutlineRoundedIcon fontSize="inherit" /></IconButton></Tooltip>}
                          {p.status === 'SUSPENDED' && <Tooltip title={t('seafarers.met.reinstateProgramme')}><IconButton size="small" aria-label={`${t('seafarers.met.reinstateProgramme')} ${p.title}`} onClick={() => amend(p, { status: 'APPROVED', statusReason: '' }, t('seafarers.met.programmeSaved'))}><PlayCircleOutlineRoundedIcon fontSize="inherit" /></IconButton></Tooltip>}
                          <Tooltip title={t('seafarers.met.withdrawProgramme')}><IconButton size="small" color="error" aria-label={`${t('seafarers.met.withdrawProgramme')} ${p.title}`} onClick={() => setReason({ kind: 'withdraw', programme: p, text: '' })}><BlockRoundedIcon fontSize="inherit" /></IconButton></Tooltip>
                        </Stack>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {doc.programmes.length === 0 && <TableRow><TableCell colSpan={8}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('seafarers.met.noProgrammes')}</Typography></TableCell></TableRow>}
              </TableBody>
            </Table></TableContainer>
          </Box>
        )}
        {tab === 1 && (
          <Box sx={{ p: 2 }}>
            <Alert severity="info" sx={{ mb: 2 }}>{t('seafarers.met.cycleHint')}{a.reason ? ` — ${a.reason}` : ''}</Alert>
            {overlay === undefined && <LinearProgress aria-label={t('common.loading')} />}
            {overlay === null && <Typography color="text.secondary">{t('seafarers.met.cyclesUnavailable')}</Typography>}
            {overlay && (
              <>
                {cycles.length === 0 ? <Typography color="text.secondary" sx={{ mb: 2 }}>{t('seafarers.met.noCycles')}</Typography>
                  : <Grid container spacing={1.5} sx={{ mb: 2 }}>{cycles.map((c) => <Grid item xs={12} md={6} lg={4} key={c.id}><CycleCard cycle={c} /></Grid>)}</Grid>}
                <VisitsPanel subjectKind="COMPANY" subjectId={doc.companyId} visits={overlay.visits} position={cycles} canManage={hasPerm(user, 'facilities.approve')} onChanged={loadOverlay} />
              </>
            )}
          </Box>
        )}
        {tab === 2 && (
          <Grid container spacing={2.5} sx={{ p: 2.5 }}>
            <Grid item xs={6} md={3}><Item label={t('seafarers.met.type')} value={types.label(doc.institutionType)} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.met.establishedOn')} value={fmtD(doc.establishedOn)} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.met.instructors')} value={doc.instructors} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.met.capacity')} value={doc.capacity} /></Grid>
            <Grid item xs={12} md={6}><Item label={t('seafarers.met.simulators')} value={doc.simulators.length ? <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>{doc.simulators.map((s) => <Chip key={s} size="small" variant="outlined" label={s} />)}</Stack> : '—'} /></Grid>
            <Grid item xs={12} md={6}><Item label={t('seafarers.met.qualitySystem')} value={doc.qualitySystem || '—'} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.met.contact')} value={doc.contactName || '—'} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.met.email')} value={doc.contactEmail || '—'} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.met.phone')} value={doc.contactPhone || '—'} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.met.address')} value={doc.address || '—'} /></Grid>
            <Grid item xs={12}><Item label={t('seafarers.met.remarks')} value={doc.remarks || '—'} /></Grid>
            {doc.statusReason && <Grid item xs={12}><Item label={t('seafarers.met.statusReason')} value={doc.statusReason} /></Grid>}
          </Grid>
        )}
        {tab === 3 && (
          <Box sx={{ p: 2.5 }}>
            {!history && <LinearProgress aria-label={t('seafarers.loadingHistory')} />}
            {history && !hasPerm(user, 'audit.view') && <Typography color="text.secondary">{t('seafarers.noAuditAccess')}</Typography>}
            {history && hasPerm(user, 'audit.view') && (
              <Stack spacing={0} component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }} aria-label={t('seafarers.met.tabHistory')}>
                {history.map((h, i) => (
                  <Box component="li" key={h.id} sx={{ display: 'flex', gap: 2 }}>
                    <Box aria-hidden sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}><Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: i === 0 ? 'primary.main' : 'divider', mt: 0.75 }} />{i < history.length - 1 && <Box sx={{ width: 2, flex: 1, bgcolor: 'divider' }} />}</Box>
                    <Box sx={{ pb: 2.5 }}><Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>{h.action.replace(/_/g, ' ')}{h.entityLabel ? <Typography component="span" variant="caption" color="text.secondary"> — {h.entityLabel}</Typography> : null}</Typography><Typography variant="caption" color="text.secondary">{fmtDT(h.at)} · {h.actor?.name || '—'}{h.note ? ` · ${h.note}` : ''}</Typography></Box>
                  </Box>
                ))}
                {history.length === 0 && <Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('seafarers.noHistory')}</Typography>}
              </Stack>
            )}
          </Box>
        )}
      </Card>
      <FormDrawer open={progDlg} title={t('seafarers.met.addProgramme')} subtitle={doc.name} width="min(560px, 75vw)" onClose={() => setProgDlg(false)} busy={busy} disabled={!progVals.programme} onSubmit={saveProgramme} submitLabel={t('common.save')}>
        <FormFields fields={progFields} values={progVals} onChange={setProgVals} />
      </FormDrawer>
      <Dialog open={!!reason} onClose={() => !busy && setReason(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{reason?.kind === 'withdraw' ? t('seafarers.met.withdrawProgramme') : reason?.kind === 'suspend' ? t('seafarers.met.suspendProgramme') : t('seafarers.met.setStatus')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          {reason?.kind === 'status' && (
            <TextField select fullWidth size="small" label={t('seafarers.met.newStatus')} value={reason.status} onChange={(e) => setReason({ ...reason, status: e.target.value })} sx={{ mb: 1.5 }}>
              {(ref?.institutionStatuses ?? ['ACTIVE', 'SUSPENDED', 'CLOSED']).map((s) => <MenuItem key={s} value={s}>{inst[s]?.label ?? s}</MenuItem>)}
            </TextField>
          )}
          <TextField fullWidth multiline minRows={2} size="small" label={reason?.kind === 'withdraw' ? t('seafarers.met.withdrawReason') : t('seafarers.met.statusReason')} value={reason?.text ?? ''} onChange={(e) => reason && setReason({ ...reason, text: e.target.value })} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={() => setReason(null)} disabled={busy}>{t('common.cancel')}</Button><Button variant="contained" onClick={confirmReason} disabled={busy || (reason?.kind === 'withdraw' && !reason.text.trim())}>{t('common.confirm')}</Button></DialogActions>
      </Dialog>
    </>
  );
}
