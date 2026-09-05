import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Skeleton, Chip, Stack, Button, Table, TableHead, TableRow, TableCell, TableBody, Divider, TableContainer } from '@mui/material';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { chartChrome, MONO } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import { INCIDENT_STATUS_META, SEVERITY_META } from '../../utils/status';
import { fromNow, titleCase } from '../../utils/format';
import { SEV_COLORS, SEV_ORDER } from './constants';
import type { IncidentDashboardData } from './types';

/* Response posture across the desk — trailing-year trend by severity, ageing of what is still open, and the live case list. */
const Kpi = ({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) => (
  <Card sx={{ px: 2, py: 1.5, borderLeft: 3, borderLeftColor: tone ? `${tone}.main` : 'divider' }}>
    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
    {sub && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{sub}</Typography>}
  </Card>
);
const Section = ({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) => (
  <Card sx={{ p: 2, height: '100%' }}>
    <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{title}</Typography>
    {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
    <Box sx={{ mt: 1.5 }}>{children}</Box>
  </Card>
);

export default function IncidentDashboard() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const mode = useAppSelector((s) => s.ui.mode);
  const SEV = SEV_COLORS[mode];
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [data, setData] = useState<IncidentDashboardData | null>(null);

  useEffect(() => { api.get<IncidentDashboardData>('/incidents/dashboard').then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [dispatch]);

  if (!data) {
    return (
      <Grid container spacing={2} aria-busy="true">
        {Array.from({ length: 8 }).map((_, i) => <Grid item xs={6} md={3} key={i}><Skeleton variant="rounded" height={86} /></Grid>)}
        <Grid item xs={12}><Skeleton variant="rounded" height={320} /></Grid>
      </Grid>
    );
  }
  const k = data.kpis;

  return (
    <>
      <PageHeader icon={MonitorHeartRoundedIcon} iconColor="#B3452E" title={t('incidents.dashboardTitle')} sub={t('incidents.dashboardSub')}
        actions={<Button variant="contained" endIcon={<ArrowForwardRoundedIcon />} onClick={() => navigate('/incidents')}>{t('incidents.openRegister')}</Button>} />
      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}><Kpi label={t('incidents.kpiOpen')} value={k.open} sub={t('incidents.kpiOpenSub', { n: k.highOpen })} tone={k.highOpen ? 'error' : 'success'} /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('incidents.kpiLogged')} value={k.loggedYtd} sub={t('incidents.kpiLoggedSub', { n: k.closedYtd })} /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('incidents.kpiMttr')} value={`${k.mttrHrs} h`} sub={t('incidents.kpiMttrSub', { n: k.mttaMin })} tone="info" /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('incidents.kpiInjuries')} value={k.injuriesYtd} sub={t('incidents.kpiInjuriesSub')} tone={k.injuriesYtd ? 'warning' : 'success'} /></Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12} lg={7.5}>
          <Section title={t('incidents.byMonth')} sub={t('incidents.byMonthSub')}>
            <Box dir="ltr">{/* Charts are laid out left to right in both languages: Recharts does not mirror its axis gutters under RTL, so category labels would be painted behind the bars. */}
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={data.byMonth} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {SEV_ORDER.map((s) => <Bar key={s} dataKey={s} stackId="sev" fill={SEV[s]} name={SEVERITY_META[s].label} radius={s === 'CRITICAL' ? [3, 3, 0, 0] : 0} />)}
              </BarChart>
            </ResponsiveContainer>
            </Box>
          </Section>
        </Grid>
        <Grid item xs={12} lg={4.5}>
          <Section title={t('incidents.ageing')} sub={t('incidents.ageingSub')}>
            <Box dir="ltr">
            <ResponsiveContainer width="100%" height={170}>
              <BarChart data={data.aging} layout="vertical" margin={{ top: 0, right: 18, left: 4, bottom: 0 }}>
                <CartesianGrid stroke={grid} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="bucket" width={52} tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                <Bar dataKey="count" fill={SEV.HIGH} name="Open cases" radius={[0, 3, 3, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
            </Box>
            <Divider sx={{ my: 1.5 }} />
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {data.byStatus.map((s) => (
                <Chip key={s.status} size="small" variant="outlined" label={`${INCIDENT_STATUS_META[s.status]?.label || s.status} · ${s.count}`} color={INCIDENT_STATUS_META[s.status]?.color || 'default'} sx={{ fontWeight: 600 }} />
              ))}
            </Stack>
          </Section>
        </Grid>
        <Grid item xs={12} md={7}>
          <Section title={t('incidents.byType')} sub={t('incidents.trailing12')}>
            <Box dir="ltr">
            <ResponsiveContainer width="100%" height={Math.max(200, data.byType.length * 26)}>
              <BarChart data={data.byType} layout="vertical" margin={{ top: 0, right: 24, left: 24, bottom: 0 }}>
                <CartesianGrid stroke={grid} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="type" width={140} tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} tickFormatter={(v: string) => titleCase(v)} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                <Bar dataKey="count" fill={SEV.LOW} name="Cases" radius={[0, 3, 3, 0]} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
            </Box>
          </Section>
        </Grid>
        <Grid item xs={12} md={5}>
          <Section title={t('incidents.liveOpen')} sub={t('incidents.liveOpenSub')}>
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label={t('incidents.liveOpen')}>
                <TableHead><TableRow><TableCell>Case</TableCell><TableCell>Severity</TableCell><TableCell>Status</TableCell><TableCell>Age</TableCell></TableRow></TableHead>
                <TableBody>
                  {data.openList.map((i) => (
                    <TableRow key={i.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/incidents/${i.id}`)}>
                      <TableCell>
                        <Typography sx={{ fontFamily: MONO, fontSize: 12 }}>{i.number}</Typography>
                        <Typography noWrap sx={{ fontSize: 12, color: 'text.secondary', maxWidth: 220 }}>{i.title}</Typography>
                      </TableCell>
                      <TableCell><StatusChip value={i.severity} map={SEVERITY_META} /></TableCell>
                      <TableCell><StatusChip value={i.status} map={INCIDENT_STATUS_META} /></TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fromNow(i.reportedAt)}</TableCell>
                    </TableRow>
                  ))}
                  {data.openList.length === 0 && (
                    <TableRow><TableCell colSpan={4}><Typography sx={{ py: 3, textAlign: 'center' }} color="text.secondary">{t('incidents.allClear')}</Typography></TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Section>
        </Grid>
        <Grid item xs={12}>
          <Section title={t('incidents.byCategory')} sub={t('incidents.byCategorySub')}>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {data.byCategory.map((c) => <Chip key={c.category} label={`${titleCase(c.category)} · ${c.count}`} variant="outlined" sx={{ fontWeight: 600 }} />)}
            </Stack>
          </Section>
        </Grid>
      </Grid>
    </>
  );
}
