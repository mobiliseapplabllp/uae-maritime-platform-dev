import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Grid, Skeleton, Stack, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, Typography } from '@mui/material';
import AnchorRoundedIcon from '@mui/icons-material/AnchorRounded';
import SecurityRoundedIcon from '@mui/icons-material/SecurityRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import FormFields from '../../components/common/FormFields';
import { LICENCE_STATUS_META } from '../../utils/status';
import { fmtD, fmtDT, fromNow, toInputD } from '../../utils/format';
import { MONO } from '../../theme';
import { useLookups } from '../../hooks/useLookups';
import VisitsPanel from './VisitsPanel';
import CompliancePanel from './CompliancePanel';
import { FACILITY_STATUS_META, ISPS_STATUS_META, REVIEW_STATUS_META, reviewOpen } from './shared';
import type { FacilityVisits, IcpReviewEntry, PortFacility } from './types';

/* One port facility — who operates it, where it stands under the ISPS Code, and the federal authority's security
 * review of it: submitted with a reason, answered with a reference at once and an outcome later, kept as a history.
 * The review runs through the ICP adapter, so the same screen serves the recorded contract and the live counterpart. */
const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box>
    <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography>
    <Typography component="div" sx={{ fontSize: 13.5, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography>
  </Box>
);
const TABS = ['security', 'instruments', 'visits', 'compliance'] as const;
type TabKey = (typeof TABS)[number];
const ISPS_STATUSES = Object.keys(ISPS_STATUS_META);
const BASE = '/facilities/port-facilities';

export default function PortFacilityDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const dispatch = useAppDispatch();
  const user = useUser();
  const { t } = useTranslation();
  const types = useLookups('facilityType');
  const capabilities = useLookups('facilityCapability');
  const [f, setF] = useState<PortFacility | null>(null);
  const [history, setHistory] = useState<IcpReviewEntry[]>([]);
  const [visits, setVisits] = useState<FacilityVisits | null>(null);
  const [dlg, setDlg] = useState<'submit' | 'isps' | null>(null);
  const [vals, setVals] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const tab: TabKey = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabKey) : 'security';

  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  const load = useCallback(() => {
    api.get<PortFacility>(`${BASE}/${id}`).then((r) => setF(r.data)).catch(err);
    api.get<IcpReviewEntry[]>(`${BASE}/${id}/icp-reviews`, { headers: { 'X-Quiet': '1' } }).then((r) => setHistory(r.data)).catch(() => setHistory([]));
    api.get<FacilityVisits>(`${BASE}/${id}/visits`, { headers: { 'X-Quiet': '1' } }).then((r) => setVisits(r.data)).catch(() => setVisits(null));
  }, [id, err]);
  useEffect(() => { load(); }, [load]);

  if (!f) return <Skeleton variant="rounded" height={420} />;
  const canManage = hasPerm(user, 'facilities.manage');
  const review = f.icpReview;
  const open = reviewOpen(review);
  const setTab = (next: TabKey) => { const p = new URLSearchParams(params); if (next === 'security') p.delete('tab'); else p.set('tab', next); setParams(p, { replace: true }); };
  const post = (url: string, body: unknown, done: (d: PortFacility) => string) => {
    setBusy(true);
    api.post<PortFacility>(url, body).then((r) => { dispatch(notify(done(r.data))); setDlg(null); load(); }).catch(err).finally(() => setBusy(false));
  };
  const submit = () => post(`${BASE}/${id}/icp-review`, { reason: String(vals.reason ?? '').trim() }, (d) => t('facilities.reviewSubmitted', { ref: d.icpReview?.reference ?? '' }));
  const refresh = () => post(`${BASE}/${id}/icp-review/refresh`, {}, (d) => t('facilities.reviewChecked', { status: REVIEW_STATUS_META[d.icpReview?.status ?? '']?.label ?? d.icpReview?.status ?? '' }));
  const saveIsps = () => post(`${BASE}/${id}/isps`, { ispsStatus: vals.ispsStatus, ispsLevel: vals.ispsLevel === '' || vals.ispsLevel == null ? undefined : Number(vals.ispsLevel), socNo: vals.socNo || '', socExpiry: vals.socExpiry || null, reason: vals.reason || '' }, () => t('facilities.ispsUpdated'));
  const modeChip = (mode: string) => (mode === 'live' ? <Chip size="small" variant="outlined" color="success" label={t('facilities.liveAnswer')} sx={{ height: 20, fontSize: 10.5 }} /> : mode === 'stub' ? <Chip size="small" variant="outlined" label={t('facilities.stubAnswer')} sx={{ height: 20, fontSize: 10.5 }} /> : null);
  const pfso = f.pssoName ? `${f.pssoName}${f.pssoPhone ? ` · ${f.pssoPhone}` : ''}` : '—';

  return (
    <>
      <PageHeader icon={AnchorRoundedIcon} iconColor="#2C6E52" crumbs={[{ label: t('facilities.portFacilitiesTitle'), to: '/port-facilities' }, { label: f.name }]}
        title={<Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap><span>{f.name}</span><StatusChip value={f.status} map={FACILITY_STATUS_META} /><StatusChip value={f.ispsStatus} map={ISPS_STATUS_META} /></Stack>}
        sub={`${f.code} · ${types.label(f.facilityType)}${f.terminal ? ` · ${f.terminal}` : ''}${f.operatorName ? ` · ${f.operatorName}` : ''}`}
        actions={canManage && <>
          <Button variant="outlined" color="inherit" startIcon={<SecurityRoundedIcon />} onClick={() => { setVals({ ispsStatus: f.ispsStatus, ispsLevel: f.ispsLevel, socNo: f.socNo, socExpiry: toInputD(f.socExpiry), reason: '' }); setDlg('isps'); }} data-testid="update-isps">{t('facilities.updateIsps')}</Button>
          {!open && <Button variant="contained" startIcon={<SendRoundedIcon />} onClick={() => { setVals({ reason: '' }); setDlg('submit'); }} data-testid="submit-review">{review ? t('facilities.submitAgain') : t('facilities.submitReview')}</Button>}
        </>} />

      <Card sx={{ p: 2.5, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid item xs={6} md={3}><Item label={t('facilities.operator')} value={f.operatorId ? <Button size="small" sx={{ p: 0, minWidth: 0, fontWeight: 600, textAlign: 'left' }} onClick={() => navigate(`/companies/${f.operatorId}`)}>{f.operatorName}</Button> : f.operatorName || '—'} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.ispsStanding')} value={<Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap><StatusChip value={f.ispsStatus} map={ISPS_STATUS_META} /><Chip size="small" variant="outlined" label={t('facilities.securityLevel', { n: f.ispsLevel })} sx={{ height: 20, fontSize: 10.5 }} /></Stack>} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.soc')} value={f.socNo ? <><span style={{ fontFamily: MONO, fontSize: 12.5 }}>{f.socNo}</span><Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{f.socExpiry ? t('facilities.socValidTill', { date: fmtD(f.socExpiry) }) : ''}{f.ispsInForce ? '' : ` · ${t('facilities.notInForce')}`}</Typography></> : t('facilities.noSoc')} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.pfso')} value={pfso} /></Grid>
          <Grid item xs={12} md={6}><Item label={t('facilities.capabilities')} value={f.capabilities.length ? <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>{f.capabilities.map((x) => <Chip key={x} size="small" variant="outlined" label={capabilities.label(x)} sx={{ height: 20, fontSize: 10.5 }} />)}</Stack> : '—'} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.loaDraft')} value={f.loaMax || f.draftMax ? `${f.loaMax ?? '—'} m · ${f.draftMax ?? '—'} m` : '—'} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.capacity')} value={f.capacity ? `${f.capacity.toLocaleString()} ${f.capacityUnit}`.trim() : '—'} /></Grid>
          {f.remarks && <Grid item xs={12}><Item label={t('facilities.remarks')} value={f.remarks} /></Grid>}
        </Grid>
      </Card>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable" allowScrollButtonsMobile aria-label={f.name}>
        <Tab value="security" label={<Badge color="warning" variant="dot" invisible={!open}>{t('facilities.securityTab')}</Badge>} />
        <Tab value="instruments" label={t('facilities.licencesHeld', { count: f.instrumentsHeld })} />
        <Tab value="visits" label={<Badge color="info" badgeContent={visits?.scheduled || undefined}>{t('facilities.visitsTab')}</Badge>} />
        <Tab value="compliance" label={<Badge color="error" badgeContent={f.openObligations || undefined}>{t('facilities.complianceTab')}</Badge>} />
      </Tabs>

      {tab === 'security' && (
        <Grid container spacing={2}>
          <Grid item xs={12} lg={7}>
            <Card sx={{ p: 2, mb: 2 }} data-testid="security-review">
              <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap">
                <Box>
                  <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.securityReview')}</Typography>
                  <Typography variant="caption" color="text.secondary">{t('facilities.securityReviewSub')}</Typography>
                </Box>
                {canManage && review && open && <Button size="small" variant="outlined" startIcon={<RefreshRoundedIcon />} onClick={refresh} disabled={busy} data-testid="check-review">{t('facilities.checkOutcome')}</Button>}
              </Stack>
              <Divider sx={{ my: 1.5 }} />
              {!review ? (
                <Alert severity="info" data-testid="review-status">{t('facilities.noReview')}</Alert>
              ) : (
                <Grid container spacing={2}>
                  <Grid item xs={6} md={3}><Item label={t('facilities.reviewReference')} value={<span style={{ fontFamily: MONO, fontSize: 12.5 }}>{review.reference}</span>} /></Grid>
                  <Grid item xs={6} md={3}><Item label={t('facilities.status')} value={<Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap data-testid="review-status"><StatusChip value={review.status} map={REVIEW_STATUS_META} />{modeChip(review.mode)}</Stack>} /></Grid>
                  <Grid item xs={6} md={3}><Item label={t('facilities.requestedBy')} value={<>{review.requestedBy || '—'}<Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{fmtDT(review.requestedAt)}</Typography></>} /></Grid>
                  <Grid item xs={6} md={3}><Item label={open ? t('facilities.expectedBy') : t('facilities.decidedOn')} value={open ? fmtD(review.expectedBy) : fmtDT(review.decidedAt)} /></Grid>
                  <Grid item xs={12}><Item label={t('facilities.reviewReason')} value={review.reason || '—'} /></Grid>
                  <Grid item xs={12}>
                    <Item label={t('facilities.conditionsImposed')} value={review.conditions.length
                      ? <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid="review-conditions">{review.conditions.map((c, i) => <Typography component="li" key={i} sx={{ fontSize: 13.5, fontWeight: 500 }}>{String(c)}</Typography>)}</Box>
                      : <Typography component="span" sx={{ color: 'text.secondary', fontSize: 13, fontWeight: 400 }}>{t('facilities.noConditions')}</Typography>} />
                  </Grid>
                  <Grid item xs={12}><Typography variant="caption" color="text.secondary">{t('facilities.lastChecked', { when: fromNow(review.checkedAt) })}</Typography></Grid>
                </Grid>
              )}
            </Card>
            <Card data-testid="review-history">
              <Box sx={{ px: 2, py: 1.25 }}><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.reviewHistory', { count: history.length })}</Typography></Box>
              <Divider />
              <TableContainer sx={{ overflowX: 'auto' }}>
                <Table size="small" aria-label={t('facilities.reviewHistory', { count: history.length })}>
                  <TableHead><TableRow><TableCell>{t('facilities.reviewReference')}</TableCell><TableCell>{t('facilities.submittedOn')}</TableCell><TableCell>{t('facilities.reviewReason')}</TableCell><TableCell>{t('facilities.reviewOutcome')}</TableCell><TableCell>{t('facilities.decidedOn')}</TableCell><TableCell align="right">{t('facilities.conditions')}</TableCell></TableRow></TableHead>
                  <TableBody>
                    {history.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell sx={{ fontFamily: MONO, fontSize: 12.5, whiteSpace: 'nowrap' }}>{h.reference}</TableCell>
                        <TableCell>{fmtD(h.requestedAt)}<Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{h.requestedBy}</Typography></TableCell>
                        <TableCell>{h.reason || '—'}</TableCell>
                        <TableCell><StatusChip value={h.status} map={REVIEW_STATUS_META} /></TableCell>
                        <TableCell>{fmtD(h.decidedAt)}</TableCell>
                        <TableCell align="right">{h.conditions.length}</TableCell>
                      </TableRow>
                    ))}
                    {history.length === 0 && <TableRow><TableCell colSpan={6}><Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('facilities.noReviewHistory')}</Typography></TableCell></TableRow>}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Grid>
          <Grid item xs={12} lg={5}>
            <Card sx={{ p: 2 }} data-testid="isps-standing">
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.ispsStanding')}</Typography>
              <Typography variant="caption" color="text.secondary">{t('facilities.ispsStandingSub')}</Typography>
              <Divider sx={{ my: 1.5 }} />
              <Grid container spacing={2}>
                <Grid item xs={6}><Item label={t('facilities.status')} value={<StatusChip value={f.ispsStatus} map={ISPS_STATUS_META} />} /></Grid>
                <Grid item xs={6}><Item label={t('facilities.securityLevelLabel')} value={t('facilities.securityLevel', { n: f.ispsLevel })} /></Grid>
                <Grid item xs={6}><Item label={t('facilities.soc')} value={f.socNo ? <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{f.socNo}</span> : t('facilities.noSoc')} /></Grid>
                <Grid item xs={6}><Item label={t('facilities.socExpiry')} value={fmtD(f.socExpiry)} /></Grid>
                <Grid item xs={12}><Item label={t('facilities.pfso')} value={pfso} /></Grid>
              </Grid>
              {f.ispsStatus === 'COMPLIANT' && !f.ispsInForce && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('facilities.socLapsed')}</Alert>}
            </Card>
          </Grid>
        </Grid>
      )}

      {tab === 'instruments' && (
        <Card>
          <Box sx={{ px: 2, py: 1.25, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.licencesHeld', { count: f.instruments.length })}</Typography>
            <Button size="small" onClick={() => navigate('/facilities')}>{t('facilities.openLicenceRegister')}</Button>
          </Box>
          <Divider />
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label={t('facilities.licencesHeld', { count: f.instruments.length })}>
              <TableHead><TableRow><TableCell>{t('facilities.licenceNo')}</TableCell><TableCell>{t('facilities.type')}</TableCell><TableCell>{t('facilities.status')}</TableCell><TableCell>{t('facilities.issued')}</TableCell><TableCell>{t('facilities.validTill')}</TableCell><TableCell>{t('facilities.inForce')}</TableCell></TableRow></TableHead>
              <TableBody>
                {f.instruments.map((l) => (
                  <TableRow key={l.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/facilities/${l.id}`)}>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}>{l.number}</TableCell>
                    <TableCell>{l.typeLabel}<Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{l.classLabel}</Typography></TableCell>
                    <TableCell><StatusChip value={l.status} map={LICENCE_STATUS_META} /></TableCell>
                    <TableCell>{fmtD(l.issueDate)}</TableCell><TableCell>{fmtD(l.expiryDate)}</TableCell>
                    <TableCell>{l.status === 'ISSUED' ? <Chip size="small" color={l.inForce ? 'success' : 'error'} label={l.inForce ? t('facilities.inForce') : t('facilities.notInForce')} sx={{ height: 21, fontSize: 11 }} /> : '—'}</TableCell>
                  </TableRow>
                ))}
                {f.instruments.length === 0 && <TableRow><TableCell colSpan={6}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('facilities.noLicences')}</Typography></TableCell></TableRow>}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}
      {tab === 'visits' && <VisitsPanel subjectKind="FACILITY" subjectId={id} visits={visits?.visits ?? []} canManage={canManage} onChanged={load} />}
      {tab === 'compliance' && <CompliancePanel companyId={id} subjectKind="FACILITY" audits={f.audits} obligations={f.obligations} canManage={canManage} onChanged={load} />}

      <Dialog open={dlg === 'submit'} onClose={() => !busy && setDlg(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('facilities.submitReview')} — {f.name}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t('facilities.submitReviewHint')}</Typography>
          <FormFields fields={[{ name: 'reason', label: t('facilities.reviewReason'), type: 'multiline', required: true, cols: 12, helper: t('facilities.reviewReasonHelp') }]} values={vals} onChange={setVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setDlg(null)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" disabled={busy || String(vals.reason ?? '').trim().length < 3} onClick={submit} data-testid="submit-review-confirm">{t('facilities.submitReview')}</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={dlg === 'isps'} onClose={() => !busy && setDlg(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('facilities.updateIsps')} — {f.name}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <FormFields fields={[
            { name: 'ispsStatus', label: t('facilities.ispsStanding'), type: 'select', required: true, options: ISPS_STATUSES.map((s) => ({ value: s, label: ISPS_STATUS_META[s].label })) },
            { name: 'ispsLevel', label: t('facilities.securityLevelLabel'), type: 'number' },
            { name: 'socNo', label: t('facilities.soc') }, { name: 'socExpiry', label: t('facilities.socExpiry'), type: 'date' },
            { name: 'reason', label: t('facilities.ispsReason'), type: 'multiline', cols: 12 },
          ]} values={vals} onChange={setVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setDlg(null)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" disabled={busy || !vals.ispsStatus} onClick={saveIsps}>{t('common.save')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
