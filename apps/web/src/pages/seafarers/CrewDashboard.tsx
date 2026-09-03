import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Skeleton, Stack, Button, Table, TableRow, TableCell, TableBody, TableContainer, Chip, Divider } from '@mui/material';
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { CHART_SERIES, chartChrome, MONO } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import PageStats from '../../components/common/PageStats';
import EntityHover from '../../components/common/EntityHover';
import { fmtNum } from '../../utils/format';
import { funnelBands } from './shared';
import type { CrewDashboardData } from './types';

/* Crew dashboard — the manning picture: roll strength, rank mix, the document expiry funnel and who needs attention first. */
const Kpi = ({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: 'success' | 'warning' | 'error' | 'info' }) => (
  <Card sx={{ px: 2, py: 1.5, borderLeft: 3, borderLeftColor: tone ? `${tone}.main` : 'divider' }}>
    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
    {sub && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{sub}</Typography>}
  </Card>
);

export default function CrewDashboard() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode];
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [data, setData] = useState<CrewDashboardData | null>(null);

  useEffect(() => { api.get<CrewDashboardData>('/seafarers/dashboard').then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [dispatch]);

  if (!data) {
    return (
      <Grid container spacing={2} aria-busy="true">
        {Array.from({ length: 8 }).map((_, i) => <Grid item xs={6} md={3} key={i}><Skeleton variant="rounded" height={86} /></Grid>)}
        <Grid item xs={12}><Skeleton variant="rounded" height={300} /></Grid>
      </Grid>
    );
  }
  const k = data.kpis;
  const funnel = funnelBands(data.funnel);

  return (
    <>
      <PageHeader icon={GroupsRoundedIcon} iconColor="#75479C" title={t('seafarers.dashboardTitle')} sub={t('seafarers.dashboardSub')}
        actions={(
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={() => navigate('/reports/view/crew-roster')}>{t('seafarers.crewRosterReport')}</Button>
            <Button size="small" onClick={() => navigate('/reports/view/certificate-expiry')}>{t('seafarers.expiryReport')}</Button>
            <Button variant="contained" endIcon={<ArrowForwardRoundedIcon />} onClick={() => navigate('/seafarers')}>{t('seafarers.openRegister')}</Button>
          </Stack>
        )} />
      <PageStats scope="seafarers" />
      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}><Kpi label={t('seafarers.kpiRoll')} value={k.roll} sub={t('seafarers.kpiRollSub', { onboard: k.onboard, ashore: k.ashore })} /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('seafarers.kpiMedical')} value={k.medicalIssues} sub={t('seafarers.kpiMedicalSub', { days: k.medicalWindow })} tone={k.medicalIssues ? 'warning' : 'success'} /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('seafarers.kpiExpired')} value={data.funnel.expired} sub={t('seafarers.kpiExpiredSub', { count: data.funnel.d30 })} tone={data.funnel.expired ? 'error' : 'success'} /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('seafarers.kpiSeaService')} value={`${fmtNum(k.avgSeaDays)} d`} sub={t('seafarers.kpiSeaServiceSub')} tone="info" /></Grid>
      </Grid>
      <Grid container spacing={2}>
        <Grid item xs={12} md={5}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('seafarers.rankDistribution')}</Typography>
            <ResponsiveContainer width="100%" height={Math.max(220, data.byRank.length * 24)}>
              <BarChart data={data.byRank} layout="vertical" margin={{ top: 8, right: 24, left: 40, bottom: 0 }}>
                <CartesianGrid stroke={grid} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="rank" width={130} tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                <Bar dataKey="count" fill={C.container} name={t('seafarers.seafarers')} radius={[0, 3, 3, 0]} barSize={13} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </Grid>
        <Grid item xs={12} md={3.5}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('seafarers.expiryFunnel')}</Typography>
            <Typography variant="caption" color="text.secondary">{t('seafarers.expiryFunnelSub')}</Typography>
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={funnel} margin={{ top: 10, right: 8, left: -22, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="band" tick={{ fontSize: 10.5, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                <Bar dataKey="count" name={t('seafarers.documents')} radius={[3, 3, 0, 0]} barSize={30} fill={C.dryBulk} />
              </BarChart>
            </ResponsiveContainer>
            <Divider sx={{ my: 1 }} />
            <Button size="small" onClick={() => navigate('/reports/view/certificate-expiry')}>{t('seafarers.fullExpiryReport')}</Button>
          </Card>
        </Grid>
        <Grid item xs={12} md={3.5}>
          <Card sx={{ height: '100%' }}>
            <Box sx={{ px: 2, py: 1.5 }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('seafarers.needsAttention')}</Typography>
              <Typography variant="caption" color="text.secondary">{t('seafarers.needsAttentionSub')}</Typography>
            </Box>
            <Divider />
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label={t('seafarers.needsAttention')}>
                <TableBody>
                  {data.alertList.map((s) => (
                    <TableRow key={s.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/seafarers/${s.id}`)}>
                      <TableCell>
                        <EntityHover type="seafarer" id={s.id}><b>{s.name}</b></EntityHover>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{s.rank} · {s.vessel}</Typography>
                      </TableCell>
                      <TableCell align="right"><Chip size="small" color="warning" label={s.alerts} sx={{ height: 20, fontWeight: 700 }} /></TableCell>
                    </TableRow>
                  ))}
                  {data.alertList.length === 0 && <TableRow><TableCell><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('seafarers.everyDocumentValid')}</Typography></TableCell></TableRow>}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
        </Grid>
      </Grid>
    </>
  );
}
