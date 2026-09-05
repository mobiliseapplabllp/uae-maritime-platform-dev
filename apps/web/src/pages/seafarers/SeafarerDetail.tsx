import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Tabs, Tab, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Button, IconButton, Skeleton, Chip, Stack, LinearProgress, Tooltip } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded';
import DirectionsBoatRoundedIcon from '@mui/icons-material/DirectionsBoatRounded';
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import FormFields from '../../components/common/FormFields';
import FormDrawer from '../../components/common/FormDrawer';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import EntityHover from '../../components/common/EntityHover';
import { CERT_STATUS_META, LICENCE_STATUS_META, SEAFARER_STATUS_META } from '../../utils/status';
import { fmtD, fmtDT, fmtNum, fromNow, toInputD } from '../../utils/format';
import { MONO } from '../../theme';
import { useProfile } from '../../config/runtime';
import SignOnOffDialog from './SignOnOffDialog';
import { CERT_TYPE_LOOKUP, RANK_LOOKUP, daysLeft, seaDays, serviceValid } from './shared';
import { useLookups } from '../../hooks/useLookups';
import type { AuditEntry, CertificatePayload, Seafarer, SeafarerCertificate, SeaServicePayload, SeaServiceRecord } from './types';
import type { LicenceDetail } from '../facilities/types';

/* One seafarer — identity, the documents that gate a sign-on, verified sea service, the instruments this administration issued and the change trail. */
const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box>
    <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography>
    <Typography component="div" sx={{ fontSize: 14, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography>
  </Box>
);
const mono = { fontFamily: MONO, fontSize: 12 } as const;
const empty = (cols: number, text: string) => <TableRow><TableCell colSpan={cols}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{text}</Typography></TableCell></TableRow>;
type Pending = { kind: 'cert' | 'service'; id: string; label: string };

export default function SeafarerDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const profile = useProfile();
  const { t } = useTranslation();
  const ranks = useLookups(RANK_LOOKUP); const certTypes = useLookups(CERT_TYPE_LOOKUP);
  const [doc, setDoc] = useState<Seafarer | null>(null);
  const [tab, setTab] = useState(0);
  const [certDlg, setCertDlg] = useState<SeafarerCertificate | Record<string, never> | null>(null);
  const [certVals, setCertVals] = useState<Record<string, any>>({});
  const [svcDlg, setSvcDlg] = useState(false);
  const [svcVals, setSvcVals] = useState<Record<string, any>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [signDlg, setSignDlg] = useState(false);
  const [instruments, setInstruments] = useState<LicenceDetail[] | undefined>(undefined);
  const [history, setHistory] = useState<AuditEntry[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  const load = useCallback(() => api.get<Seafarer>(`/seafarers/${id}`).then((r) => setDoc(r.data)).catch(err), [id, err]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setTab(0); setInstruments(undefined); setHistory(undefined); }, [id]);
  useEffect(() => {
    if (tab === 3 && instruments === undefined) api.get<LicenceDetail[]>(`/instruments/subjects/SEAFARER/${id}`).then((r) => setInstruments(r.data)).catch(() => setInstruments([]));
    if (tab === 4 && history === undefined) {
      if (!hasPerm(user, 'audit.view')) setHistory([]);
      else api.get<AuditEntry[]>('/audit', { params: { entity: 'Seafarer', entityId: id, limit: 50, sort: '-at' } }).then((r) => setHistory(r.data)).catch(() => setHistory([]));
    }
  }, [tab, id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) return <Skeleton variant="rounded" height={420} />;
  const canEdit = hasPerm(user, 'seafarers.edit');
  const idLabel = profile.identity?.seafarerIdLabel || 'Seafarer ID';
  const editingCertId = certDlg && 'id' in certDlg ? (certDlg as SeafarerCertificate).id : undefined;

  const openCert = (c?: SeafarerCertificate) => {
    setCertVals(c ? { certType: c.certCode || c.certType, grade: c.grade || '', number: c.number || '', issuer: c.issuer || '', issueDate: toInputD(c.issueDate), expiryDate: toInputD(c.expiryDate), remarks: c.remarks || '' } : { issuer: profile.authority });
    setCertDlg(c || {});
  };
  const saveCert = () => {
    setBusy(true);
    const body = certVals as CertificatePayload;
    const req = editingCertId ? api.put(`/seafarers/${id}/certificates/${editingCertId}`, body) : api.post(`/seafarers/${id}/certificates`, body);
    req.then(() => { dispatch(notify(t('seafarers.certificateSaved'))); setCertDlg(null); load(); }).catch(err).finally(() => setBusy(false));
  };
  const saveService = () => {
    setBusy(true);
    const body: SeaServicePayload = { vesselName: svcVals.vesselName, imo: svcVals.imo || undefined, rank: svcVals.rank, from: svcVals.from, to: svcVals.to, verified: !!svcVals.verified, remarks: svcVals.remarks || undefined };
    api.post(`/seafarers/${id}/service`, body).then(() => { dispatch(notify(t('seafarers.serviceAdded'))); setSvcDlg(false); load(); }).catch(err).finally(() => setBusy(false));
  };
  const confirmDelete = () => {
    if (!pending) return;
    setBusy(true);
    const url = pending.kind === 'cert' ? `/seafarers/${id}/certificates/${pending.id}` : `/seafarers/${id}/service/${pending.id}`;
    api.delete(url).then(() => { dispatch(notify(pending.kind === 'cert' ? t('seafarers.certificateDeleted') : t('seafarers.serviceDeleted'))); setPending(null); load(); }).catch(err).finally(() => setBusy(false));
  };
  const verifyEmployment = () => {
    setBusy(true);
    api.post(`/seafarers/${id}/verify-employment`).then(() => { dispatch(notify(t('seafarers.employmentVerified'))); load(); }).catch(err).finally(() => setBusy(false));
  };
  const expiryNote = (c: SeafarerCertificate) => { const d = daysLeft(c.expiryDate); return d < 0 ? t('seafarers.lapsedDaysAgo', { days: -d }) : t('seafarers.expiresInDays', { days: d }); };

  return (
    <>
      <PageHeader crumbs={[{ label: t('seafarers.crumbRegister'), to: '/seafarers' }, { label: doc.name }]}
        title={<Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap><span>{doc.name}</span><StatusChip value={doc.status} map={SEAFARER_STATUS_META} /></Stack>}
        sub={`${ranks.label(doc.rankCode) || doc.rank} · CDC ${doc.cdcNo} · ${idLabel} ${doc.seafarerId || '—'} · ${doc.nationality || '—'}`}
        actions={canEdit && <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button variant="outlined" startIcon={<VerifiedRoundedIcon />} disabled={busy} onClick={verifyEmployment} data-testid="verify-employment">{t('seafarers.verifyEmployment')}</Button>
          {doc.currentVesselId
            ? <Button variant="outlined" color="inherit" startIcon={<LogoutRoundedIcon />} onClick={() => setSignDlg(true)}>{t('seafarers.signOff')}</Button>
            : <Button variant="contained" startIcon={<DirectionsBoatRoundedIcon />} onClick={() => setSignDlg(true)}>{t('seafarers.signOn')}</Button>}
        </Stack>} />
      <SignOnOffDialog seafarer={doc} open={signDlg} onClose={() => setSignDlg(false)} onDone={load} />

      <Card sx={{ p: 2.5, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid item xs={6} md={2}><Item label={t('seafarers.status')} value={<StatusChip value={doc.status} map={SEAFARER_STATUS_META} />} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.dob')} value={fmtD(doc.dob)} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.totalSeaDays')} value={fmtNum(doc.totalSeaDays)} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.currentVessel')} value={doc.currentVesselId ? <EntityHover type="vessel" id={doc.currentVesselId}><span>{doc.currentVesselName}</span></EntityHover> : t('seafarers.ashore')} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.phone')} value={doc.phone || '—'} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.employmentCheck')} value={doc.employmentCheck ? <Tooltip title={`${doc.employmentCheck.occupation} · ${t('seafarers.checkedAt', { when: fromNow(doc.employmentCheck.checkedAt) })}`}><Chip size="small" color={doc.employmentCheck.employed ? 'success' : 'warning'} label={doc.employmentCheck.employed ? t('seafarers.employed', { by: doc.employmentCheck.establishment }) : t('seafarers.notEmployed')} sx={{ height: 20, maxWidth: '100%' }} data-testid="employment-check" /></Tooltip> : t('seafarers.notChecked')} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.certAlerts')} value={doc.certAlerts ? <Chip size="small" color="warning" label={t('seafarers.toReview', { count: doc.certAlerts })} sx={{ height: 20 }} /> : t('seafarers.none')} /></Grid>
        </Grid>
      </Card>

      <Card>
        <Tabs value={tab} onChange={(_, v: number) => setTab(v)} variant="scrollable" allowScrollButtonsMobile aria-label={t('seafarers.recordSections')} sx={{ px: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Tab label={t('seafarers.tabProfile')} />
          <Tab label={`${t('seafarers.tabCertificates')} (${doc.certificates.length})`} />
          <Tab label={`${t('seafarers.tabSeaService')} (${doc.seaService.length})`} />
          <Tab label={instruments ? `${t('seafarers.tabInstruments')} (${instruments.length})` : t('seafarers.tabInstruments')} />
          <Tab label={t('seafarers.tabHistory')} />
        </Tabs>

        {tab === 0 && (
          <Grid container spacing={2.5} sx={{ p: 2.5 }}>
            <Grid item xs={6} md={3}><Item label={t('seafarers.fullName')} value={doc.name} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.rank')} value={ranks.label(doc.rankCode) || doc.rank} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.cdcNumber')} value={<span style={mono}>{doc.cdcNo}</span>} /></Grid>
            <Grid item xs={6} md={3}><Item label={doc.seafarerIdLabel || idLabel} value={<span style={mono}>{doc.seafarerId || '—'}</span>} /></Grid>
            <Grid item xs={6} md={3}><Item label={doc.nationalIdLabel || profile.identity?.nationalIdLabel || 'National ID'} value={<span style={mono}>{doc.nationalId || '—'}</span>} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.nationality')} value={doc.nationality || '—'} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.dob')} value={fmtD(doc.dob)} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.email')} value={doc.email || '—'} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.phone')} value={doc.phone || '—'} /></Grid>
            <Grid item xs={6} md={3}><Item label={t('seafarers.signedOnSince')} value={doc.signedOnAt ? `${fmtD(doc.signedOnAt)} · ${fromNow(doc.signedOnAt)}` : t('seafarers.ashore')} /></Grid>
            <Grid item xs={12} md={6}><Item label={t('seafarers.remarks')} value={doc.remarks || '—'} /></Grid>
          </Grid>
        )}

        {tab === 1 && (
          <Box sx={{ p: 2 }}>
            {canEdit && <Button size="small" startIcon={<AddRoundedIcon />} sx={{ mb: 1 }} onClick={() => openCert()}>{t('seafarers.addCertificate')}</Button>}
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label={t('seafarers.tabCertificates')}>
                <TableHead><TableRow>
                  <TableCell>{t('seafarers.certificate')}</TableCell><TableCell>{t('seafarers.grade')}</TableCell><TableCell>{t('seafarers.number')}</TableCell>
                  <TableCell>{t('seafarers.issuer')}</TableCell><TableCell>{t('seafarers.issued')}</TableCell><TableCell>{t('seafarers.expires')}</TableCell><TableCell>{t('seafarers.status')}</TableCell><TableCell align="right">{canEdit ? t('seafarers.actions') : ''}</TableCell>
                </TableRow></TableHead>
                <TableBody>
                  {doc.certificates.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell><b>{certTypes.label(c.certCode) || c.certType}</b></TableCell>
                      <TableCell>{c.grade || '—'}</TableCell>
                      <TableCell sx={mono}>{c.number || '—'}</TableCell>
                      <TableCell>{c.issuer || '—'}</TableCell>
                      <TableCell>{fmtD(c.issueDate)}</TableCell>
                      <TableCell>
                        {fmtD(c.expiryDate)}
                        {c.status !== 'VALID' && <Typography variant="caption" color={c.status === 'EXPIRED' ? 'error.main' : 'warning.main'} sx={{ display: 'block' }}>{expiryNote(c)}</Typography>}
                      </TableCell>
                      <TableCell><StatusChip value={c.status} map={CERT_STATUS_META} /></TableCell>
                      <TableCell align="right">
                        {canEdit && (
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                            <IconButton size="small" aria-label={`Edit ${c.certType}`} onClick={() => openCert(c)}><EditRoundedIcon fontSize="inherit" /></IconButton>
                            <IconButton size="small" color="error" aria-label={`Delete ${c.certType}`} onClick={() => setPending({ kind: 'cert', id: c.id, label: c.certType })}><DeleteOutlineRoundedIcon fontSize="inherit" /></IconButton>
                          </Stack>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {doc.certificates.length === 0 && empty(8, t('seafarers.noCertificates'))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {tab === 2 && (
          <Box sx={{ p: 2 }}>
            {canEdit && <Button size="small" startIcon={<AddRoundedIcon />} sx={{ mb: 1 }} onClick={() => { setSvcVals({ rank: doc.rankCode || doc.rank, verified: false }); setSvcDlg(true); }}>{t('seafarers.addSeaService')}</Button>}
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label={t('seafarers.tabSeaService')}>
                <TableHead><TableRow>
                  <TableCell>{t('seafarers.vessel')}</TableCell><TableCell>IMO</TableCell><TableCell>{t('seafarers.rank')}</TableCell>
                  <TableCell>{t('seafarers.signedOn')}</TableCell><TableCell>{t('seafarers.signedOff')}</TableCell><TableCell align="right">{t('seafarers.days')}</TableCell><TableCell>{t('seafarers.verified')}</TableCell><TableCell align="right">{canEdit ? t('seafarers.actions') : ''}</TableCell>
                </TableRow></TableHead>
                <TableBody>
                  {doc.seaService.map((sv: SeaServiceRecord) => (
                    <TableRow key={sv.id}>
                      <TableCell>{sv.vesselId ? <EntityHover type="vessel" id={sv.vesselId}><b>{sv.vesselName}</b></EntityHover> : <b>{sv.vesselName}</b>}</TableCell>
                      <TableCell sx={mono}>{sv.imo || '—'}</TableCell>
                      <TableCell>{ranks.label(sv.rankCode) || sv.rank}</TableCell>
                      <TableCell>{fmtD(sv.from)}</TableCell><TableCell>{fmtD(sv.to)}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNum(seaDays(sv.from, sv.to))}</TableCell>
                      <TableCell>{sv.verified ? <Chip size="small" icon={<VerifiedRoundedIcon sx={{ fontSize: 14 }} />} label={t('seafarers.verified')} color="success" variant="outlined" sx={{ height: 21, fontSize: 10.5 }} /> : <Chip size="small" label={t('seafarers.declared')} variant="outlined" sx={{ height: 21, fontSize: 10.5 }} />}</TableCell>
                      <TableCell align="right">
                        {canEdit && <IconButton size="small" color="error" aria-label={`Delete service on ${sv.vesselName}`} onClick={() => setPending({ kind: 'service', id: sv.id, label: sv.vesselName })}><DeleteOutlineRoundedIcon fontSize="inherit" /></IconButton>}
                      </TableCell>
                    </TableRow>
                  ))}
                  {doc.seaService.length === 0 && empty(8, t('seafarers.noSeaService'))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {tab === 3 && (
          <Box sx={{ p: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>{t('seafarers.instrumentsHint')}</Typography>
            {!instruments ? <LinearProgress aria-label={t('seafarers.loadingInstruments')} /> : (
              <TableContainer sx={{ overflowX: 'auto' }}>
                <Table size="small" aria-label={t('seafarers.tabInstruments')}>
                  <TableHead><TableRow>
                    <TableCell>{t('seafarers.number')}</TableCell><TableCell>{t('seafarers.instrument')}</TableCell><TableCell>{t('seafarers.status')}</TableCell>
                    <TableCell>{t('seafarers.issued')}</TableCell><TableCell>{t('seafarers.expires')}</TableCell><TableCell>{t('seafarers.inForce')}</TableCell><TableCell align="right" />
                  </TableRow></TableHead>
                  <TableBody>
                    {instruments.map((l) => (
                      <TableRow key={l.id} hover>
                        <TableCell sx={{ ...mono, fontWeight: 700 }}>{l.licenseNo}</TableCell>
                        <TableCell><b>{l.typeLabel}</b><Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{l.classLabel} · {l.issuer}</Typography></TableCell>
                        <TableCell><StatusChip value={l.status} map={LICENCE_STATUS_META} /></TableCell>
                        <TableCell>{fmtD(l.issueDate)}</TableCell><TableCell>{fmtD(l.expiryDate)}</TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            {l.inForce ? <Chip size="small" color="success" label={t('seafarers.inForce')} sx={{ height: 21, fontSize: 11 }} /> : <Tooltip title={l.forceReason || ''}><Chip size="small" color="error" label={t('seafarers.notInForce')} sx={{ height: 21, fontSize: 11 }} /></Tooltip>}
                            {l.signature?.verification?.valid && <Tooltip title={t('seafarers.signedTooltip')}><VerifiedRoundedIcon titleAccess={t('seafarers.digitallySigned')} sx={{ fontSize: 17, color: 'success.main' }} /></Tooltip>}
                          </Stack>
                        </TableCell>
                        <TableCell align="right"><Button size="small" aria-label={`Open ${l.licenseNo}`} onClick={() => navigate(`/facilities/${l.id}`)}>{t('seafarers.open')}</Button></TableCell>
                      </TableRow>
                    ))}
                    {instruments.length === 0 && empty(7, t('seafarers.noInstruments'))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
        )}

        {tab === 4 && (
          <Box sx={{ p: 2.5 }}>
            {!history && <LinearProgress aria-label={t('seafarers.loadingHistory')} />}
            {history && !hasPerm(user, 'audit.view') && <Typography color="text.secondary">{t('seafarers.noAuditAccess')}</Typography>}
            {history && hasPerm(user, 'audit.view') && (
              <Stack spacing={0} component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }} aria-label={t('seafarers.tabHistory')}>
                {history.map((h, i) => (
                  <Box component="li" key={h.id} sx={{ display: 'flex', gap: 2 }}>
                    <Box aria-hidden sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: i === 0 ? 'primary.main' : 'divider', mt: 0.75 }} />
                      {i < history.length - 1 && <Box sx={{ width: 2, flex: 1, bgcolor: 'divider' }} />}
                    </Box>
                    <Box sx={{ pb: 2.5 }}>
                      <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>{h.action.replace(/_/g, ' ')}{h.entityLabel ? <Typography component="span" variant="caption" color="text.secondary"> — {h.entityLabel}</Typography> : null}</Typography>
                      <Typography variant="caption" color="text.secondary">{fmtDT(h.at)} · {h.actor?.name || '—'}{h.note ? ` · ${h.note}` : ''}</Typography>
                    </Box>
                  </Box>
                ))}
                {history.length === 0 && <Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('seafarers.noHistory')}</Typography>}
              </Stack>
            )}
          </Box>
        )}
      </Card>

      <FormDrawer open={!!certDlg} title={editingCertId ? t('seafarers.editCertificate') : t('seafarers.addCertificate')} subtitle={doc.name} width="min(560px, 75vw)"
        onClose={() => setCertDlg(null)} busy={busy} disabled={!certVals.certType || !certVals.expiryDate} onSubmit={saveCert} submitLabel={t('common.save')}>
        <FormFields fields={[
          { name: 'certType', label: t('seafarers.certificateType'), type: 'autocomplete', required: true, cols: 12, lookup: CERT_TYPE_LOOKUP },
          { name: 'grade', label: t('seafarers.gradeClass') }, { name: 'number', label: t('seafarers.number') },
          { name: 'issuer', label: t('seafarers.issuer'), cols: 12 },
          { name: 'issueDate', label: t('seafarers.issueDate'), type: 'date' }, { name: 'expiryDate', label: t('seafarers.expiryDate'), type: 'date', required: true },
          { name: 'remarks', label: t('seafarers.remarks'), type: 'multiline', cols: 12 },
        ]} values={certVals} onChange={setCertVals} />
      </FormDrawer>
      <FormDrawer open={svcDlg} title={t('seafarers.addSeaService')} subtitle={t('seafarers.seaServiceSubtitle', { name: doc.name })} width="min(560px, 75vw)"
        onClose={() => setSvcDlg(false)} busy={busy} disabled={!serviceValid(svcVals)} onSubmit={saveService} submitLabel={t('common.save')}>
        <FormFields fields={[
          { name: 'vesselName', label: t('seafarers.vesselName'), required: true }, { name: 'imo', label: t('seafarers.imoNumber') },
          { name: 'rank', label: t('seafarers.rankServed'), type: 'select', required: true, lookup: RANK_LOOKUP },
          { name: 'verified', label: t('seafarers.verifiedAgainstRecords'), type: 'switch' },
          { name: 'from', label: t('seafarers.signedOn'), type: 'date', required: true }, { name: 'to', label: t('seafarers.signedOff'), type: 'date', required: true, helper: svcVals.from && svcVals.to && !serviceValid(svcVals) ? t('seafarers.signOffAfterSignOn') : undefined },
          { name: 'remarks', label: t('seafarers.remarks'), type: 'multiline', cols: 12 },
        ]} values={svcVals} onChange={setSvcVals} />
      </FormDrawer>
      <ConfirmDialog open={!!pending} busy={busy} title={pending?.kind === 'cert' ? t('seafarers.deleteCertificateTitle') : t('seafarers.deleteServiceTitle')}
        message={t('seafarers.deleteMessageRecord', { label: pending?.label || '', name: doc.name })} onClose={() => setPending(null)} onConfirm={confirmDelete} />
    </>
  );
}
