import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Skeleton, Stack, Chip, Rating, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Divider, Button, Tooltip, Tabs, Tab, Dialog, DialogTitle, DialogContent, DialogActions, Badge } from '@mui/material';
import CorporateFareRoundedIcon from '@mui/icons-material/CorporateFareRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import FormFields from '../../components/common/FormFields';
import { LICENCE_STATUS_META } from '../../utils/status';
import { fmtD } from '../../utils/format';
import { MONO } from '../../theme';
import { useProfile } from '../../config/runtime';
import { useLookups } from '../../hooks/useLookups';
import ApplicationDialog from './ApplicationDialog';
import AccreditationPanel from './AccreditationPanel';
import VisitsPanel from './VisitsPanel';
import CompliancePanel from './CompliancePanel';
import { COMPANY_STATUS_META, COMPANY_STATUS_OPTIONS, licLabel } from './shared';
import type { Company, CompanyOverlay, LicenceDetail } from './types';

/* One port company — who they are, how they perform, every instrument this administration has issued to them,
 * and the administration's own record on them: the accreditation cycles they hold, the visits paid, the audits
 * and obligations, and the line of standing decisions. The identity is master data's; the rest is the desk's. */
const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box>
    <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography>
    <Typography component="div" sx={{ fontSize: 13.5, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography>
  </Box>
);
const TABS = ['overview', 'accreditation', 'visits', 'compliance', 'standing'] as const;
type TabKey = (typeof TABS)[number];

export default function CompanyDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const dispatch = useAppDispatch();
  const user = useUser();
  const profile = useProfile();
  const { t } = useTranslation();
  const categories = useLookups('companyCategory');
  const [c, setC] = useState<Company | null>(null);
  const [overlay, setOverlay] = useState<CompanyOverlay | null>(null);
  const [licences, setLicences] = useState<LicenceDetail[] | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [standing, setStanding] = useState<{ transitions: Record<string, string[]> } | null>(null);
  const [standingOpen, setStandingOpen] = useState(false); const [vals, setVals] = useState<Record<string, any>>({}); const [busy, setBusy] = useState(false);
  const tab: TabKey = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabKey) : 'overview';

  const load = useCallback(() => {
    api.get<Company>(`/companies/${id}`).then((r) => setC(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
    api.get<LicenceDetail[]>(`/instruments/subjects/COMPANY/${id}`).then((r) => setLicences(r.data)).catch(() => setLicences([]));
    // the administration's overlay — quiet when the directory has no record yet
    api.get<CompanyOverlay>(`/facilities/companies/${id}`, { headers: { 'X-Quiet': '1' } }).then((r) => setOverlay(r.data)).catch(() => setOverlay(null));
  }, [id, dispatch]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'standing' && !standing) api.get<{ statusTransitions: Record<string, string[]> }>('/facilities/meta', { headers: { 'X-Quiet': '1' } }).then((r) => setStanding({ transitions: r.data.statusTransitions })).catch(() => setStanding({ transitions: {} })); }, [tab, standing]);

  if (!c) return <Skeleton variant="rounded" height={420} />;
  const held = licences || [];
  const types = (c.types || []).map(licLabel).join(', ') || categories.label(c.category);
  const canManage = hasPerm(user, 'facilities.manage'); const canApprove = hasPerm(user, 'facilities.approve');
  const rating = overlay?.rating ?? c.rating;
  const status = overlay?.status ?? c.status;
  const setTab = (next: TabKey) => { const p = new URLSearchParams(params); if (next === 'overview') p.delete('tab'); else p.set('tab', next); setParams(p, { replace: true }); };
  const changeStanding = () => {
    setBusy(true);
    api.post(`/facilities/companies/${id}/status`, { status: vals.status, reason: vals.reason || '' }).then(() => { dispatch(notify(t('facilities.standingChanged'))); setStandingOpen(false); load(); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))).finally(() => setBusy(false));
  };
  const nextStandings = (standing?.transitions[status] ?? []).map((s) => COMPANY_STATUS_OPTIONS.find((o) => o.value === s) ?? { value: s, label: s });

  return (
    <>
      <PageHeader icon={CorporateFareRoundedIcon} iconColor="#2C6E52" crumbs={[{ label: t('facilities.companiesTitle'), to: '/companies' }, { label: c.name }]}
        title={<Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap><span>{c.name}</span><StatusChip value={status} map={COMPANY_STATUS_META} />{c.real && <Chip size="small" variant="outlined" label={t('facilities.documentedOperator')} sx={{ height: 20 }} />}</Stack>}
        sub={`${c.code} · ${types}`}
        actions={canManage && <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setApplyOpen(true)}>{t('facilities.newApplication')}</Button>} />
      <Card sx={{ p: 2.5, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid item xs={6} md={3}><Item label={t('facilities.contactPerson')} value={c.contactName || '—'} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.phoneEmail')} value={`${c.contactPhone || '—'} · ${c.contactEmail || '—'}`} /></Grid>
          <Grid item xs={6} md={3}><Item label={`${profile.tax.registrationLabel} / ${profile.identity?.companyIdLabel || 'Registration'}`} value={<span style={{ fontFamily: MONO, fontSize: 12.5 }}>{c.taxId || '—'} · {c.registrationNo || '—'}</span>} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.onboarded')} value={fmtD(c.onboardedAt)} /></Grid>
          <Grid item xs={12} md={6}><Item label={t('facilities.address')} value={c.address || '—'} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.performance')} value={rating ? <Rating value={rating} precision={0.5} size="small" readOnly /> : t('facilities.notRated')} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.licensedFor')} value={c.types?.length ? <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>{c.types.map((x) => <Chip key={x} size="small" variant="outlined" label={licLabel(x)} sx={{ height: 20, fontSize: 10.5 }} />)}</Stack> : categories.label(c.category)} /></Grid>
          {c.nameAr && <Grid item xs={12} md={6}><Item label={t('facilities.companyNameAr')} value={<span dir="rtl">{c.nameAr}</span>} /></Grid>}
        </Grid>
      </Card>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable" allowScrollButtonsMobile aria-label={c.name}>
        <Tab value="overview" label={t('facilities.overviewTab')} />
        <Tab value="accreditation" label={<Badge color="warning" badgeContent={(overlay?.accreditationsDue ?? 0) + (overlay?.accreditationsExpired ?? 0) || undefined}>{t('facilities.accrTab')}</Badge>} />
        <Tab value="visits" label={<Badge color="info" badgeContent={overlay?.visitsScheduled || undefined}>{t('facilities.visitsTab')}</Badge>} />
        <Tab value="compliance" label={<Badge color="error" badgeContent={overlay?.overdueObligations || undefined}>{t('facilities.complianceTab')}</Badge>} />
        <Tab value="standing" label={t('facilities.historyTab')} />
      </Tabs>
      {tab === 'overview' && (
        <Card>
          <Box sx={{ px: 2, py: 1.25, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.licencesHeld', { count: held.length })}</Typography>
            <Button size="small" onClick={() => navigate('/facilities')}>{t('facilities.openLicenceRegister')}</Button>
          </Box>
          <Divider />
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label={t('facilities.licencesHeld', { count: held.length })}>
              <TableHead><TableRow>
                <TableCell>{t('facilities.licenceNo')}</TableCell><TableCell>{t('facilities.type')}</TableCell><TableCell>{t('facilities.status')}</TableCell>
                <TableCell>{t('facilities.issued')}</TableCell><TableCell>{t('facilities.validTill')}</TableCell><TableCell>{t('facilities.inForce')}</TableCell><TableCell align="right">{t('facilities.rating')}</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {held.map((l) => (
                  <TableRow key={l.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/facilities/${l.id}`)}>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}>{l.licenseNo}</TableCell>
                    <TableCell>{l.typeLabel}</TableCell>
                    <TableCell><StatusChip value={l.status} map={LICENCE_STATUS_META} /></TableCell>
                    <TableCell>{fmtD(l.issueDate)}</TableCell>
                    <TableCell>{l.nonExpiring ? t('facilities.nonExpiring') : fmtD(l.expiryDate)}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        {l.inForce ? <Chip size="small" color="success" label={t('facilities.inForce')} sx={{ height: 21, fontSize: 11 }} /> : <Tooltip title={l.forceReason || ''}><Chip size="small" color={l.status === 'ISSUED' ? 'error' : 'default'} variant={l.status === 'ISSUED' ? 'filled' : 'outlined'} label={t('facilities.notInForce')} sx={{ height: 21, fontSize: 11 }} /></Tooltip>}
                        {l.signature?.verification?.valid && <VerifiedRoundedIcon titleAccess={t('facilities.digitallySigned')} sx={{ fontSize: 17, color: 'success.main' }} />}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">{l.performanceRating || '—'}</TableCell>
                  </TableRow>
                ))}
                {licences && held.length === 0 && <TableRow><TableCell colSpan={7}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('facilities.noLicences')}</Typography></TableCell></TableRow>}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}
      {tab === 'accreditation' && <AccreditationPanel companyId={id} position={overlay?.accreditations ?? []} canApprove={canApprove} onChanged={load} />}
      {tab === 'visits' && <VisitsPanel subjectKind="COMPANY" subjectId={id} visits={overlay?.visits ?? []} position={overlay?.accreditations ?? []} canManage={canManage} onChanged={load} />}
      {tab === 'compliance' && <CompliancePanel companyId={id} audits={overlay?.audits ?? []} obligations={overlay?.obligations ?? []} canManage={canManage} onChanged={load} />}
      {tab === 'standing' && (
        <Card>
          <Box sx={{ px: 2, py: 1.25, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('facilities.standingHistory')}</Typography>
            {canApprove && nextStandings.length > 0 && <Button size="small" variant="outlined" onClick={() => { setVals({ status: nextStandings[0]?.value, reason: '' }); setStandingOpen(true); }}>{t('facilities.changeStanding')}</Button>}
          </Box>
          <Divider />
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label={t('facilities.standingHistory')}>
              <TableHead><TableRow><TableCell>{t('facilities.date')}</TableCell><TableCell>{t('facilities.from')}</TableCell><TableCell>{t('facilities.status')}</TableCell><TableCell>{t('facilities.reason')}</TableCell><TableCell>{t('facilities.issuer')}</TableCell></TableRow></TableHead>
              <TableBody>
                {(overlay?.history ?? []).map((h, i) => <TableRow key={i}><TableCell>{fmtD(h.at)}</TableCell><TableCell>{h.from ? <StatusChip value={h.from} map={COMPANY_STATUS_META} /> : '—'}</TableCell><TableCell><StatusChip value={h.to} map={COMPANY_STATUS_META} /></TableCell><TableCell>{h.reason}</TableCell><TableCell>{h.by}</TableCell></TableRow>)}
                {(overlay?.history ?? []).length === 0 && <TableRow><TableCell colSpan={5}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('facilities.noHistory')}</Typography></TableCell></TableRow>}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}
      <ApplicationDialog open={applyOpen} onClose={() => setApplyOpen(false)} onCreated={(lid) => { setApplyOpen(false); navigate(`/facilities/${lid}`); }} preset={{ subjectKind: 'COMPANY', subjectRef: c.id, entityName: c.name }} />
      <Dialog open={standingOpen} onClose={() => !busy && setStandingOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('facilities.changeStanding')} — {c.name}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}><FormFields fields={[{ name: 'status', label: t('facilities.newStanding'), type: 'select', required: true, options: nextStandings, cols: 12 }, { name: 'reason', label: t('facilities.standingReason'), type: 'multiline', required: vals.status !== 'ACTIVE', cols: 12 }]} values={vals} onChange={setVals} /></DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button color="inherit" onClick={() => setStandingOpen(false)} disabled={busy}>{t('common.cancel')}</Button><Button variant="contained" color={vals.status === 'ACTIVE' ? 'primary' : 'error'} onClick={changeStanding} disabled={busy || !vals.status || (vals.status !== 'ACTIVE' && !vals.reason)}>{t('facilities.confirm')}</Button></DialogActions>
      </Dialog>
    </>
  );
}
