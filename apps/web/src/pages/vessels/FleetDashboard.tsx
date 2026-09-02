import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Grid, Box, Typography, Skeleton, Stack, Button, Table, TableHead, TableRow, TableCell, TableBody, Divider, Chip, TableContainer } from '@mui/material';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import SpaceDashboardRoundedIcon from '@mui/icons-material/SpaceDashboardRounded';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { CHART_SERIES, chartChrome, MONO } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import EntityHover from '../../components/common/EntityHover';
import { fmtNum } from '../../utils/format';
import { certHealthPct, typeLabel } from './shared';
import type { FleetDashboardData } from './types';

const Kpi = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
  <Card sx={{ px: 2, py: 1.5 }}>
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

export default function FleetDashboard() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode];
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [data, setData] = useState<FleetDashboardData | null>(null);

  useEffect(() => { api.get<FleetDashboardData>('/vessels/fleet-dashboard').then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [dispatch]);

  if (!data) {
    return (
      <Grid container spacing={2} aria-busy="true">
        {Array.from({ length: 8 }).map((_, i) => <Grid item xs={6} md={3} key={i}><Skeleton variant="rounded" height={86} /></Grid>)}
        <Grid item xs={12}><Skeleton variant="rounded" height={300} /></Grid>
      </Grid>
    );
  }
  const k = data.kpis;
  const health = certHealthPct(data.certs);

  return (
    <>
      <PageHeader icon={SpaceDashboardRoundedIcon} iconColor="#3B6FB6" title="Fleet dashboard" sub="The registered fleet at a glance — composition, age, certification health and where every ship is right now"
        actions={<Button variant="contained" endIcon={<ArrowForwardRoundedIcon />} onClick={() => navigate('/vessels')}>Open register</Button>} />
      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}><Kpi label="Registered fleet" value={k.fleet} sub={`${fmtNum(k.totalDwt)} DWT combined`} /></Grid>
        <Grid item xs={6} md={3}><Kpi label="In port now" value={k.inPort} sub={`${k.atAnchor} at anchor · ${k.inbound} inbound`} /></Grid>
        <Grid item xs={6} md={3}><Kpi label="Average age" value={`${k.avgAge} yrs`} sub="active vessels" /></Grid>
        <Grid item xs={6} md={3}><Kpi label="Certificate health" value={health === null ? '—' : `${health}%`} sub={`${data.certs.expiring} expiring · ${data.certs.expired} expired`} /></Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12} md={5}>
          <Section title="Composition by type">
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={data.byType} layout="vertical" margin={{ top: 0, right: 24, left: 8, bottom: 0 }}>
                <CartesianGrid stroke={grid} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="type" width={96} tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} tickFormatter={(v: string) => typeLabel(v)} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                <Bar dataKey="count" fill={C.container} name="Vessels" radius={[0, 3, 3, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </Section>
        </Grid>
        <Grid item xs={12} md={4}>
          <Section title="Age profile" sub="Years since build">
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={data.ageBands} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="band" tick={{ fontSize: 11, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                <Bar dataKey="count" fill={C.dryBulk} name="Vessels" radius={[3, 3, 0, 0]} barSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </Section>
        </Grid>
        <Grid item xs={12} md={3}>
          <Section title="Flags & class">
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>FLAG STATES</Typography>
            <Stack direction="row" spacing={0.75} sx={{ my: 1, flexWrap: 'wrap' }} useFlexGap>
              {data.byFlag.map((f) => <Chip key={f.flag} size="small" variant="outlined" label={`${f.flag} · ${f.count}`} sx={{ fontWeight: 600 }} />)}
            </Stack>
            <Divider sx={{ my: 1.25 }} />
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>CLASS SOCIETIES</Typography>
            <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
              {data.byClass.map((f) => <Chip key={f.cls} size="small" variant="outlined" label={`${f.cls} · ${f.count}`} sx={{ fontWeight: 600 }} />)}
            </Stack>
          </Section>
        </Grid>
        <Grid item xs={12}>
          <Section title="Vessels needing certificate attention" sub="Expiring within 30 days or already expired — plan renewals and surveys">
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead><TableRow><TableCell>Vessel</TableCell><TableCell>Type</TableCell><TableCell align="right">Certificates flagged</TableCell><TableCell align="right">Record</TableCell></TableRow></TableHead>
                <TableBody>
                  {data.certAlertVessels.map((v) => (
                    <TableRow key={v.id} hover>
                      <TableCell><EntityHover type="vessel" id={v.id}><b>{v.name}</b></EntityHover></TableCell>
                      <TableCell>{typeLabel(v.type)}</TableCell>
                      <TableCell align="right"><Chip size="small" color="warning" label={v.alerts} sx={{ height: 20, fontWeight: 700 }} /></TableCell>
                      <TableCell align="right"><Button size="small" aria-label={`Open ${v.name}`} onClick={() => navigate(`/vessels/${v.id}`)}>Open</Button></TableCell>
                    </TableRow>
                  ))}
                  {data.certAlertVessels.length === 0 && (
                    <TableRow><TableCell colSpan={4}><Typography sx={{ py: 3, textAlign: 'center' }} color="text.secondary">Every certificate across the fleet is valid ✅</Typography></TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Section>
        </Grid>
      </Grid>
    </>
  );
}
