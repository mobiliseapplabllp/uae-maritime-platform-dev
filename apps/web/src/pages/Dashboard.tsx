import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Grid, Card, Box, Typography, Skeleton, Tooltip as MuiTooltip, Divider, Stack } from '@mui/material';
import DirectionsBoatFilledRoundedIcon from '@mui/icons-material/DirectionsBoatFilledRounded';
import AnchorRoundedIcon from '@mui/icons-material/AnchorRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import SpeedRoundedIcon from '@mui/icons-material/SpeedRounded';
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded';
import PaymentsRoundedIcon from '@mui/icons-material/PaymentsRounded';
import ReportProblemRoundedIcon from '@mui/icons-material/ReportProblemRounded';
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LineChart, Line, LabelList } from 'recharts';
import api from '../api/client';
import { useAppDispatch, useAppSelector } from '../store';
import { notify } from '../store/uiSlice';
import { CHART_SERIES, SERIES_ORDER, SERIES_LABELS, chartChrome, MONO } from '../theme';
import PageHeader from '../components/common/PageHeader';
import StatCard from '../components/common/StatCard';
import StatusChip from '../components/common/StatusChip';
import { PORTCALL_STATUS_META, CERT_STATUS_META } from '../utils/status';
import { fmtMT, fmtNum, fmtMoneyShort, fmtDT, fromNow, fmtD } from '../utils/format';
import { useProfile } from '../config/runtime';

const CARGO_LABELS: Record<string, string> = { CONTAINERS: 'Containers', COAL: 'Coal', CRUDE: 'Crude oil', POL: 'POL', FERT: 'Fertilizer', GRAIN: 'Grain', STEEL: 'Steel', EDIBLE: 'Edible oil', AUTO: 'Automobiles', PROJ: 'Project', LNG: 'LNG' };
export interface DashboardData {
  kpis: { vesselsAtBerth: number; atAnchorage: number; expectedArrivals72h: number; berthOccupancyPct: number; avgTurnaroundHrs: number; cargoMTD: number; teuMTD: number; revenueMTD: number; openDeficiencies: number; detentionsYTD: number; certsExpiring: number; certsExpired: number };
  throughputByMonth: { month: string; key: string; container: number; dryBulk: number; liquid: number; other: number; total: number }[];
  revenueByMonth: { month: string; key: string; revenue: number }[];
  cargoMix: { name: string; value: number }[];
  berthBoard: { id: string; code: string; name: string; terminal: string; berthType: string; status: string; loaMax: number; draftMax: number; occupiedBy: { callId: string; vcn: string; vessel: string; etd: string; atb: string } | null }[];
  arrivals: { id: string; vcn: string; vessel: string; type: string; status: string; eta: string; agentName?: string }[];
  expiringCerts: { vesselId: string; vessel: string; imo: string; certType: string; expiryDate: string; status: string }[];
  recentActivity: { at: string; actor: string | null; action: string; entity: string; label: string | null }[];
}
function ChartCard({ title, sub, children, h = 280 }: { title: string; sub?: string; children: React.ReactNode; h?: number }) {
  return <Card sx={{ p: 2, height: '100%' }}><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{title}</Typography>{sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}<Box sx={{ height: h, mt: 1 }}>{children}</Box></Card>;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const mode = useAppSelector((s) => s.ui.mode);
  const profile = useProfile();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const C = CHART_SERIES[mode];
  const { axis, grid, paper, tooltipStyle, cursorFill } = chartChrome(mode);

  useEffect(() => { api.get<DashboardData>('/dashboard').then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [dispatch]);

  if (!data) {
    return (
      <Grid container spacing={2} aria-busy="true">
        {Array.from({ length: 8 }).map((_, i) => <Grid item xs={6} md={3} key={i}><Skeleton variant="rounded" height={92} /></Grid>)}
        <Grid item xs={12} md={8}><Skeleton variant="rounded" height={300} /></Grid><Grid item xs={12} md={4}><Skeleton variant="rounded" height={300} /></Grid>
      </Grid>
    );
  }
  const { kpis } = data;
  const mixTotal = data.cargoMix.reduce((s, x) => s + x.value, 0) || 1;
  const mix = data.cargoMix.slice(0, 7).map((x) => ({ ...x, label: CARGO_LABELS[x.name] || x.name, pct: Math.round((x.value / mixTotal) * 100) }));
  const moneyAxis = (v: number) => (profile.currency.grouping === 'lakh-crore' ? `${(v / 1e7).toFixed(1)}Cr` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}K`);

  return (
    <>
      <PageHeader title="Port operations" sub={`Live position and last 12 months — ${fmtD(new Date())}`} />
      <Grid container spacing={2}>
        <Grid item xs={6} md={3}><StatCard icon={<DirectionsBoatFilledRoundedIcon />} label="Vessels at berth" value={kpis.vesselsAtBerth} sub={`${kpis.berthOccupancyPct}% berth occupancy`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<AnchorRoundedIcon />} label="At anchorage" value={kpis.atAnchorage} sub={`${kpis.expectedArrivals72h} expected in 72 h`} tone="warning.main" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<SpeedRoundedIcon />} label="Avg turnaround" value={`${kpis.avgTurnaroundHrs} h`} sub="sailed calls, last 30 days" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<PaymentsRoundedIcon />} label="Revenue MTD" value={fmtMoneyShort(kpis.revenueMTD)} sub="issued + collected" tone="success.main" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<Inventory2RoundedIcon />} label="Cargo MTD" value={fmtMT(kpis.cargoMTD)} sub={`${fmtNum(kpis.teuMTD)} TEU handled`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<ScheduleRoundedIcon />} label="Arrivals 72 h" value={kpis.expectedArrivals72h} sub="announced + confirmed" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<ReportProblemRoundedIcon />} label="Open deficiencies" value={kpis.openDeficiencies} sub={`${kpis.detentionsYTD} detention YTD`} tone="error.main" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<WorkspacePremiumRoundedIcon />} label="Certificates flagged" value={kpis.certsExpiring + kpis.certsExpired} sub={`${kpis.certsExpired} expired · ${kpis.certsExpiring} expiring`} tone="warning.main" /></Grid>
        <Grid item xs={12} lg={8}>
          <ChartCard title="Cargo throughput" sub="metric tonnes handled per month, by cargo group (containers converted at 12 t/TEU)">
            <Box dir="ltr">{/* Charts are laid out left to right in both languages: Recharts does not mirror its axis gutters under RTL, so category labels would be painted behind the bars. */}
            <ResponsiveContainer>
              <BarChart data={data.throughputByMonth} barCategoryGap="28%">
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis tickFormatter={(v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`)} tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => [fmtMT(v), SERIES_LABELS[name as keyof typeof SERIES_LABELS] || name]} cursor={{ fill: cursorFill }} />
                <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{SERIES_LABELS[v as keyof typeof SERIES_LABELS] || v}</span>} iconSize={10} />
                {SERIES_ORDER.map((key) => <Bar key={key} dataKey={key} stackId="mt" fill={C[key]} stroke={paper} strokeWidth={2} radius={key === 'other' ? [4, 4, 0, 0] : 0} />)}
              </BarChart>
            </ResponsiveContainer>
            </Box>
          </ChartCard>
        </Grid>
        <Grid item xs={12} lg={4}>
          <ChartCard title="Cargo mix" sub="tonnage by commodity, last 12 months — share of total">
            <Box dir="ltr">
            <ResponsiveContainer>
              <BarChart data={mix} layout="vertical" margin={{ left: 8, right: 44, top: 4 }} barCategoryGap="28%">
                <CartesianGrid stroke={grid} horizontal={false} />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="label" width={86} tick={{ fill: axis, fontSize: 11.5 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtMT(v), 'Handled']} cursor={{ fill: cursorFill }} />
                <Bar dataKey="value" fill={C.container} radius={[0, 4, 4, 0]}><LabelList dataKey="pct" position="right" formatter={(v: number) => `${v}%`} style={{ fill: axis, fontSize: 11, fontVariantNumeric: 'tabular-nums' }} /></Bar>
              </BarChart>
            </ResponsiveContainer>
            </Box>
          </ChartCard>
        </Grid>
        <Grid item xs={12} lg={4}>
          <ChartCard title="Billed revenue" sub={`issued invoices per month, ${profile.currency.code}`} h={240}>
            <Box dir="ltr">
            <ResponsiveContainer>
              <LineChart data={data.revenueByMonth}>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis tickFormatter={moneyAxis} tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtMoneyShort(v), 'Billed']} />
                <Line type="monotone" dataKey="revenue" stroke={C.liquid} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
            </Box>
          </ChartCard>
        </Grid>
        <Grid item xs={12} lg={8}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>Berth board</Typography>
              <Typography variant="caption" component="button" sx={{ color: 'primary.main', cursor: 'pointer', fontWeight: 600, background: 'none', border: 0, font: 'inherit' }} onClick={() => navigate('/berth-board')}>Open full board →</Typography>
            </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 1, mt: 1.5 }}>
              {data.berthBoard.map((b) => (
                <MuiTooltip key={b.code} title={b.occupiedBy ? `${b.occupiedBy.vessel} · ETD ${fmtDT(b.occupiedBy.etd)}` : b.status === 'MAINTENANCE' ? 'Under maintenance' : 'Free'}>
                  <Box onClick={b.occupiedBy ? () => navigate(`/port-calls/${b.occupiedBy!.callId}`) : undefined} role={b.occupiedBy ? 'button' : undefined} tabIndex={b.occupiedBy ? 0 : undefined}
                    sx={{ p: 1.25, borderRadius: 2, border: 1, minHeight: 64, cursor: b.occupiedBy ? 'pointer' : 'default', borderColor: b.occupiedBy ? 'primary.main' : 'divider',
                      bgcolor: b.status === 'MAINTENANCE' ? (mode === 'dark' ? 'rgba(224,166,78,0.12)' : 'rgba(156,100,18,0.08)') : b.occupiedBy ? (mode === 'dark' ? 'rgba(69,191,198,0.10)' : 'rgba(14,124,134,0.06)') : 'transparent' }}>
                    <Typography sx={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: 'text.secondary' }}>{b.code}</Typography>
                    <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 600, mt: 0.25 }}>{b.status === 'MAINTENANCE' ? 'Maintenance' : b.occupiedBy ? b.occupiedBy.vessel : 'Free'}</Typography>
                    {b.occupiedBy && <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>ETD {fromNow(b.occupiedBy.etd)}</Typography>}
                  </Box>
                </MuiTooltip>
              ))}
            </Box>
          </Card>
        </Grid>
        <Grid item xs={12} md={5}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>Expected arrivals</Typography>
            <Stack divider={<Divider />} spacing={1}>
              {data.arrivals.map((a) => (
                <Box key={a.id} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, cursor: 'pointer', pt: 0.5 }} onClick={() => navigate(`/port-calls/${a.id}`)}>
                  <Box sx={{ minWidth: 0 }}><Typography noWrap sx={{ fontSize: 13.5, fontWeight: 600 }}>{a.vessel}</Typography><Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{a.vcn} · ETA {fmtDT(a.eta)}</Typography></Box>
                  <StatusChip value={a.status} map={PORTCALL_STATUS_META} />
                </Box>
              ))}
              {data.arrivals.length === 0 && <Typography color="text.secondary" variant="body2">No arrivals in the pipeline</Typography>}
            </Stack>
          </Card>
        </Grid>
        <Grid item xs={12} md={4}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>Certificates needing attention</Typography>
            <Stack divider={<Divider />} spacing={1}>
              {data.expiringCerts.map((c, i) => (
                <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, pt: 0.5, cursor: 'pointer' }} onClick={() => navigate(`/vessels/${c.vesselId}`)}>
                  <Box sx={{ minWidth: 0 }}><Typography noWrap sx={{ fontSize: 13.5, fontWeight: 600 }}>{c.vessel}</Typography><Typography noWrap sx={{ fontSize: 11.5, color: 'text.secondary' }}>{c.certType} · {fmtD(c.expiryDate)}</Typography></Box>
                  <StatusChip value={c.status} map={CERT_STATUS_META} />
                </Box>
              ))}
              {data.expiringCerts.length === 0 && <Typography color="text.secondary" variant="body2">Fleet certificates are in order</Typography>}
            </Stack>
          </Card>
        </Grid>
        <Grid item xs={12} md={3}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>Recent activity</Typography>
            <Stack spacing={1.25}>
              {data.recentActivity.map((a, i) => (
                <Box key={i}>
                  <Typography sx={{ fontSize: 12.5 }}><b>{a.actor || 'system'}</b> · {a.action.toLowerCase().replace(/_/g, ' ')} {a.entity}</Typography>
                  <Typography noWrap sx={{ fontSize: 11, color: 'text.secondary' }}>{a.label} · {fromNow(a.at)}</Typography>
                </Box>
              ))}
            </Stack>
          </Card>
        </Grid>
      </Grid>
    </>
  );
}
