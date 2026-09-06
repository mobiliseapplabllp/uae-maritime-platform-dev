import { useTranslation } from 'react-i18next';
import { Grid, Stack } from '@mui/material';
import ViewTimelineRoundedIcon from '@mui/icons-material/ViewTimelineRounded';
import DirectionsBoatFilledRoundedIcon from '@mui/icons-material/DirectionsBoatFilledRounded';
import AnchorRoundedIcon from '@mui/icons-material/AnchorRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded';
import SpeedRoundedIcon from '@mui/icons-material/SpeedRounded';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import DirectionsBoatRoundedIcon from '@mui/icons-material/DirectionsBoatRounded';
import BuildRoundedIcon from '@mui/icons-material/BuildRounded';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, BarChart } from 'recharts';
import { useAppSelector } from '../../store';
import { CHART_SERIES, chartChrome } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import AiInsights from '../../components/ai/AiInsights';
import StatCard from '../../components/common/StatCard';
import { BucketBars, ChartCard, DashboardSkeleton, OpenLink, PanelCard, RankList, Yardstick, useDashboard } from '../../components/dashboard/kit';
import { fmtD, fmtDT, fmtDec, fmtMT, fmtNum, fromNow } from '../../utils/format';

/* Harbour operations dashboard — the port's service quality read against the yardsticks the port-performance literature
 * uses: waiting at anchorage, turnaround, ETA reliability, berth occupancy and craft utilisation, with the live position
 * and the year month by month. Every figure comes from GET /ops/dashboard and the timestamps the desk records. */
export interface HarbourData {
  kpis: { callsMtd: number; callsPrevMonth: number; calls30d: number; sailed30d: number; inPort: number; atAnchorage: number; expected72h: number; expected7d: number; avgTurnaroundHrs: number; medianTurnaroundHrs: number; avgAlongsideHrs: number; avgWaitingHrs: number; medianWaitingHrs: number; waitingWithinTargetPct: number; waitingOverAlertPct: number; etaReliabilityPct: number; berthOccupancyPct: number; operationalBerths: number; berthsUnderMaintenance: number; berthDowntimeHrs30d: number; outages30d: number; pilotUtilisationPct: number; tugUtilisationPct: number; craftJobs30d: number; craftHours30d: number; cargoMtd: number; teuMtd: number; cargoPrevMonth: number };
  targets: { waitingHrs: number; occupancyPct: number; congestionPct: number; etaSlackHrs: number; anchorageAlertHrs: number };
  byMonth: { month: string; key: string; calls: number; avgWaitingHrs: number; avgTurnaroundHrs: number; cargoMT: number }[];
  byTerminal: { terminal: string; berths: number; occupiedHrs: number; availableHrs: number; occupancyPct: number }[];
  byBerth: { id: string; code: string; name: string; terminal: string; berthType: string; occupiedHrs: number; availableHrs: number; occupancyPct: number }[];
  byType: { type: string; calls: number; avgTurnaroundHrs: number; avgWaitingHrs: number; cargoMT: number }[];
  outagesByKind: { kind: string; count: number; hours: number }[]; outages30ByKind: { kind: string; count: number; hours: number }[];
  craftByType: { type: string; craft: number; available: number; tasked: number; jobs: number; hours: number; utilisationPct: number }[];
  agents: { agentCode: string; agentName: string; calls: number; sharePct: number }[];
  arrivals: { id: string; vcn: string; vesselName: string; vesselType: string | null; status: string; eta: string; berthCode: string | null; agentName: string; purpose: string }[];
  anchored: { id: string; vcn: string; vesselName: string; vesselType: string | null; agentName: string; since: string | null; waitingHrs: number; etb: string | null }[];
  generatedAt: string;
}
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const delta = (now: number, before: number, vs: string, none: string) => (before ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}% ${vs}` : none);

export default function HarbourDashboard() {
  const { t } = useTranslation();
  const { data } = useDashboard<HarbourData>('/ops/dashboard');
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode]; const { axis, grid, tooltipStyle, cursorFill } = chartChrome(mode);
  const header = <PageHeader icon={ViewTimelineRoundedIcon} iconColor="#06737E" title={t('dash.harbour.title', 'Harbour operations')} sub={t('dash.harbour.sub', { defaultValue: 'Service quality over the last 30 days, the year month by month, and the live position — {{date}}', date: fmtD(new Date()) })}
    actions={<Stack direction="row" spacing={1} flexWrap="wrap"><OpenLink label={t('dash.harbour.openCalls', 'Vessel calls')} to="/port-calls" /><OpenLink label={t('dash.harbour.openBoard', 'Berth board')} to="/berth-board" /><OpenLink label={t('dash.harbour.openQuay', 'Quay view')} to="/quay-view" /><OpenLink label={t('dash.harbour.openCraft', 'Marine craft')} to="/marine-services" /></Stack>} />;
  if (!data) return <>{header}<DashboardSkeleton /></>;
  const { kpis: k, targets } = data;
  const hrs = (v: number) => `${fmtDec(v, 1)} h`;
  return (
    <>
      {header}
      <Grid container spacing={2} data-testid="harbour-dashboard">
        <Grid item xs={6} md={3}><StatCard icon={<DirectionsBoatFilledRoundedIcon />} label={t('dash.harbour.inPort', 'Vessels in port')} value={k.inPort} sub={`${k.atAnchorage} ${t('dash.harbour.atAnchorage', 'at anchorage')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<ScheduleRoundedIcon />} label={t('dash.harbour.expected', 'Expected, 72 h')} value={k.expected72h} sub={`${k.expected7d} ${t('dash.harbour.within7d', 'within 7 days')}`} tone="warning.main" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<AnchorRoundedIcon />} label={t('dash.harbour.callsMtd', 'Calls this month')} value={k.callsMtd} sub={delta(k.callsMtd, k.callsPrevMonth, t('dash.vsSameDays', 'vs the same days last month'), t('dash.noComparison', 'no comparison yet'))} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<Inventory2RoundedIcon />} label={t('dash.harbour.cargoMtd', 'Cargo this month')} value={fmtMT(k.cargoMtd)} sub={`${fmtNum(k.teuMtd)} TEU · ${delta(k.cargoMtd, k.cargoPrevMonth, t('dash.vsSameDays', 'vs the same days last month'), t('dash.noComparison', 'no comparison yet'))}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<SpeedRoundedIcon />} label={t('dash.harbour.turnaround', 'Avg turnaround, 30 d')} value={hrs(k.avgTurnaroundHrs)} sub={`${t('dash.harbour.median', 'median')} ${hrs(k.medianTurnaroundHrs)} · ${hrs(k.avgAlongsideHrs)} ${t('dash.harbour.alongside', 'alongside')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<GridViewRoundedIcon />} label={t('dash.harbour.occupancy', 'Berth occupancy, 30 d')} value={`${k.berthOccupancyPct}%`} sub={`${k.operationalBerths} ${t('dash.harbour.operational', 'operational berths')}${k.berthsUnderMaintenance ? ` · ${k.berthsUnderMaintenance} ${t('dash.harbour.maintenance', 'under maintenance')}` : ''}`} tone={k.berthOccupancyPct > targets.congestionPct ? 'error.main' : 'primary.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<DirectionsBoatRoundedIcon />} label={t('dash.harbour.craftJobs', 'Craft jobs, 30 d')} value={fmtNum(k.craftJobs30d)} sub={`${fmtNum(k.craftHours30d)} ${t('dash.harbour.assistHours', 'assist hours')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<BuildRoundedIcon />} label={t('dash.harbour.downtime', 'Berth downtime, 30 d')} value={hrs(k.berthDowntimeHrs30d)} sub={`${k.outages30d} ${t('dash.harbour.outages', 'outages recorded')}`} tone={k.berthDowntimeHrs30d > 0 ? 'warning.main' : 'success.main'} /></Grid>
        <Grid item xs={12}><AiInsights module="ops" /></Grid>

        <Grid item xs={6} md={3}><Yardstick testId="yard-waiting" label={t('dash.harbour.waiting', 'Anchorage waiting, avg')} value={k.avgWaitingHrs} display={hrs(k.avgWaitingHrs)} target={targets.waitingHrs} higherIsBetter={false} targetLabel={`${t('dash.target', 'target')} ≤ ${targets.waitingHrs} h`} sub={`${k.waitingWithinTargetPct}% ${t('dash.harbour.withinTarget', 'of calls within target')}`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-eta" label={t('dash.harbour.eta', 'ETA reliability')} value={k.etaReliabilityPct} display={`${k.etaReliabilityPct}%`} target={85} targetLabel={`${t('dash.target', 'target')} ≥ 85%`} sub={`${t('dash.harbour.etaSub', 'arrived within')} ±${targets.etaSlackHrs} h`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-alert" label={t('dash.harbour.overAlert', 'Waits over the alert line')} value={k.waitingOverAlertPct} display={`${k.waitingOverAlertPct}%`} target={10} higherIsBetter={false} targetLabel={`${t('dash.target', 'target')} ≤ 10%`} sub={`${t('dash.harbour.alertLine', 'alert at')} ${targets.anchorageAlertHrs} h`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-tugs" label={t('dash.harbour.tugUtil', 'Tug utilisation, 30 d')} value={k.tugUtilisationPct} display={`${k.tugUtilisationPct}%`} target={40} targetLabel={`${t('dash.reference', 'reference')} 40–60%`} sub={`${t('dash.harbour.pilots', 'pilots')} ${k.pilotUtilisationPct}%`} /></Grid>

        <Grid item xs={12} lg={8}>
          <ChartCard testId="chart-months" title={t('dash.harbour.byMonth', 'Calls and waiting time')} sub={t('dash.harbour.byMonthSub', 'arrivals per month with the average wait at anchorage — trailing 12 months')} explain={{ data: data.byMonth }}>
            <ResponsiveContainer>
              <ComposedChart data={data.byMonth} barCategoryGap="28%">
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis yAxisId="calls" tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={36} />
                <YAxis yAxisId="hrs" orientation="right" tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={36} tickFormatter={(v: number) => `${v}h`} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{v}</span>} iconSize={10} />
                <Bar yAxisId="calls" dataKey="calls" name={t('dash.harbour.calls', 'Calls')} fill={C.container} radius={[4, 4, 0, 0]} />
                <Line yAxisId="hrs" type="monotone" dataKey="avgWaitingHrs" name={t('dash.harbour.avgWait', 'Avg wait (h)')} stroke={C.liquid} strokeWidth={2} dot={false} />
                <Line yAxisId="hrs" type="monotone" dataKey="avgTurnaroundHrs" name={t('dash.harbour.avgTurn', 'Avg turnaround (h)')} stroke={C.other} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>
        <Grid item xs={12} lg={4}>
          <ChartCard testId="chart-types" title={t('dash.harbour.byType', 'Turnaround by vessel type')} sub={t('dash.harbour.byTypeSub', 'average hours in port, sailed calls — 12 months')} explain={{ data: data.byType.slice(0, 7).map((x) => ({ ...x, label: label(x.type) })) }}>
            <ResponsiveContainer>
              <BarChart data={data.byType.slice(0, 7).map((x) => ({ ...x, label: label(x.type) }))} layout="vertical" margin={{ left: 8, right: 36, top: 4 }} barCategoryGap="28%">
                <CartesianGrid stroke={grid} horizontal={false} />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="label" width={92} tick={{ fill: axis, fontSize: 11.5 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => [`${v} h`, name]} cursor={{ fill: cursorFill }} />
                <Bar dataKey="avgTurnaroundHrs" name={t('dash.harbour.avgTurn', 'Avg turnaround (h)')} fill={C.dryBulk} radius={[0, 4, 4, 0]} />
                <Bar dataKey="avgWaitingHrs" name={t('dash.harbour.avgWait', 'Avg wait (h)')} fill={C.liquid} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>

        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-terminals" title={t('dash.harbour.byTerminal', 'Occupancy by terminal')} sub={t('dash.harbour.byTerminalSub', 'occupied hours against available hours, 30 days')} action={{ label: t('dash.harbour.openBoard', 'Berth board'), to: '/berth-board' }} explain={{ data: data.byTerminal.map((x) => ({ label: x.terminal, value: x.occupancyPct, display: `${x.occupancyPct}%`, sub: `${x.berths} ${t('dash.harbour.berths', 'berths')}` })) }}>
            <BucketBars rows={data.byTerminal.map((x) => ({ label: x.terminal, value: x.occupancyPct, display: `${x.occupancyPct}%`, sub: `${x.berths} ${t('dash.harbour.berths', 'berths')}` }))} max={100} tone={(i) => (data.byTerminal[i].occupancyPct > targets.congestionPct ? '#C14F33' : '#0E7C86')} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-craft" title={t('dash.harbour.craft', 'Marine craft utilisation')} sub={t('dash.harbour.craftSub', 'assist hours against the hours the fleet could work, 30 days')} action={{ label: t('dash.harbour.openCraft', 'Marine craft'), to: '/marine-services' }} explain={{ data: data.craftByType.map((x) => ({ label: `${label(x.type)} (${x.craft})`, value: x.utilisationPct, display: `${x.utilisationPct}%`, sub: `${x.jobs} ${t('dash.harbour.jobs', 'jobs')} · ${fmtNum(x.hours)} h` })) }}>
            <BucketBars rows={data.craftByType.map((x) => ({ label: `${label(x.type)} (${x.craft})`, value: x.utilisationPct, display: `${x.utilisationPct}%`, sub: `${x.jobs} ${t('dash.harbour.jobs', 'jobs')} · ${fmtNum(x.hours)} h` }))} max={100} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-outages" title={t('dash.harbour.outagesByKind', 'Berth downtime by cause')} sub={t('dash.harbour.outagesSub', 'hours lost in the last 12 months')} explain={{ data: data.outagesByKind.map((x) => ({ label: label(x.kind), value: x.hours, display: `${fmtNum(x.hours)} h`, sub: `${x.count}` })) }}>
            <BucketBars rows={data.outagesByKind.map((x) => ({ label: label(x.kind), value: x.hours, display: `${fmtNum(x.hours)} h`, sub: `${x.count}` }))} />
          </PanelCard>
        </Grid>

        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-arrivals" title={t('dash.harbour.arrivals', 'Expected arrivals, 7 days')} sub={t('dash.harbour.arrivalsSub', 'announced and confirmed calls, soonest first')} action={{ label: t('dash.harbour.openSchedule', 'Schedule'), to: '/schedule' }} explain={{ data: data.arrivals.map((a) => ({ key: a.id, primary: a.vesselName, secondary: `${a.vcn} · ${a.agentName || '—'}${a.berthCode ? ` · ${a.berthCode}` : ''}`, value: fmtDT(a.eta), to: `/port-calls/${a.id}` })) }}>
            <RankList empty={t('dash.harbour.noArrivals', 'No arrivals announced')} rows={data.arrivals.map((a) => ({ key: a.id, primary: a.vesselName, secondary: `${a.vcn} · ${a.agentName || '—'}${a.berthCode ? ` · ${a.berthCode}` : ''}`, value: fmtDT(a.eta), to: `/port-calls/${a.id}` }))} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-anchored" title={t('dash.harbour.anchored', 'At anchorage now')} sub={t('dash.harbour.anchoredSub', 'longest waiting first')} explain={{ data: data.anchored.map((a) => ({ key: a.id, primary: a.vesselName, secondary: `${a.vcn} · ${a.since ? `${t('dash.harbour.since', 'since')} ${fromNow(a.since)}` : ''}${a.etb ? ` · ETB ${fmtDT(a.etb)}` : ''}`, value: hrs(a.waitingHrs), tone: a.waitingHrs > targets.anchorageAlertHrs ? 'error' : a.waitingHrs > targets.waitingHrs ? 'warning' : 'success', to: `/port-calls/${a.id}` })) }}>
            <RankList empty={t('dash.harbour.noAnchored', 'Nobody is waiting')} rows={data.anchored.map((a) => ({ key: a.id, primary: a.vesselName, secondary: `${a.vcn} · ${a.since ? `${t('dash.harbour.since', 'since')} ${fromNow(a.since)}` : ''}${a.etb ? ` · ETB ${fmtDT(a.etb)}` : ''}`, value: hrs(a.waitingHrs), tone: a.waitingHrs > targets.anchorageAlertHrs ? 'error' : a.waitingHrs > targets.waitingHrs ? 'warning' : 'success', to: `/port-calls/${a.id}` }))} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-agents" title={t('dash.harbour.agents', 'Calls by agent')} sub={t('dash.harbour.agentsSub', 'share of arrivals, 12 months')} action={{ label: t('dash.harbour.openCompanies', 'Companies'), to: '/companies' }} explain={{ data: data.agents.map((a) => ({ label: a.agentName || a.agentCode, value: a.calls, display: `${a.calls}`, sub: `${a.sharePct}%` })) }}>
            <BucketBars rows={data.agents.map((a) => ({ label: a.agentName || a.agentCode, value: a.calls, display: `${a.calls}`, sub: `${a.sharePct}%` }))} />
          </PanelCard>
        </Grid>
      </Grid>
    </>
  );
}
