import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Skeleton, Stack, Chip, Rating, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Divider, Button, Tooltip } from '@mui/material';
import CorporateFareRoundedIcon from '@mui/icons-material/CorporateFareRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import { LICENCE_STATUS_META } from '../../utils/status';
import { fmtD } from '../../utils/format';
import { MONO } from '../../theme';
import { useProfile } from '../../config/runtime';
import ApplicationDialog from './ApplicationDialog';
import { COMPANY_STATUS_META, categoryLabel, licLabel } from './shared';
import type { Company, LicenceDetail } from './types';

/* One port company — who they are, how they perform, and every instrument this administration has issued to them. */
const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box>
    <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography>
    <Typography component="div" sx={{ fontSize: 13.5, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography>
  </Box>
);

export default function CompanyDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const profile = useProfile();
  const { t } = useTranslation();
  const [c, setC] = useState<Company | null>(null);
  const [licences, setLicences] = useState<LicenceDetail[] | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);

  const load = useCallback(() => {
    api.get<Company>(`/companies/${id}`).then((r) => setC(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
    api.get<LicenceDetail[]>(`/instruments/subjects/COMPANY/${id}`).then((r) => setLicences(r.data)).catch(() => setLicences([]));
  }, [id, dispatch]);
  useEffect(() => { load(); }, [load]);

  if (!c) return <Skeleton variant="rounded" height={420} />;
  const held = licences || [];
  const types = (c.types || []).map(licLabel).join(', ') || categoryLabel(c.category);

  return (
    <>
      <PageHeader icon={CorporateFareRoundedIcon} iconColor="#2C6E52" crumbs={[{ label: t('facilities.companiesTitle'), to: '/companies' }, { label: c.name }]}
        title={<Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap><span>{c.name}</span><StatusChip value={c.status} map={COMPANY_STATUS_META} />{c.real && <Chip size="small" variant="outlined" label={t('facilities.documentedOperator')} sx={{ height: 20 }} />}</Stack>}
        sub={`${c.code} · ${types}`}
        actions={hasPerm(user, 'facilities.manage') && <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setApplyOpen(true)}>{t('facilities.newApplication')}</Button>} />
      <Card sx={{ p: 2.5, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid item xs={6} md={3}><Item label={t('facilities.contactPerson')} value={c.contactName || '—'} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.phoneEmail')} value={`${c.contactPhone || '—'} · ${c.contactEmail || '—'}`} /></Grid>
          <Grid item xs={6} md={3}><Item label={`${profile.tax.registrationLabel} / ${profile.identity?.companyIdLabel || 'Registration'}`} value={<span style={{ fontFamily: MONO, fontSize: 12.5 }}>{c.taxId || '—'} · {c.registrationNo || '—'}</span>} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.onboarded')} value={fmtD(c.onboardedAt)} /></Grid>
          <Grid item xs={12} md={6}><Item label={t('facilities.address')} value={c.address || '—'} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.performance')} value={c.rating ? <Rating value={c.rating} precision={0.5} size="small" readOnly /> : t('facilities.notRated')} /></Grid>
          <Grid item xs={6} md={3}><Item label={t('facilities.licensedFor')} value={c.types?.length ? <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>{c.types.map((x) => <Chip key={x} size="small" variant="outlined" label={licLabel(x)} sx={{ height: 20, fontSize: 10.5 }} />)}</Stack> : categoryLabel(c.category)} /></Grid>
          {c.nameAr && <Grid item xs={12} md={6}><Item label={t('facilities.companyNameAr')} value={<span dir="rtl">{c.nameAr}</span>} /></Grid>}
        </Grid>
      </Card>
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
      <ApplicationDialog open={applyOpen} onClose={() => setApplyOpen(false)} onCreated={(lid) => { setApplyOpen(false); navigate(`/facilities/${lid}`); }} preset={{ subjectKind: 'COMPANY', subjectRef: c.id, entityName: c.name }} />
    </>
  );
}
