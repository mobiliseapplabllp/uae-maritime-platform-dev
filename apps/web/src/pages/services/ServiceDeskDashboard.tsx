import { useTranslation } from 'react-i18next';
import { Grid, Stack } from '@mui/material';
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded';
import InboxRoundedIcon from '@mui/icons-material/InboxRounded';
import PendingActionsRoundedIcon from '@mui/icons-material/PendingActionsRounded';
import TimerOffRoundedIcon from '@mui/icons-material/TimerOffRounded';
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded';
import PaymentsRoundedIcon from '@mui/icons-material/PaymentsRounded';
import LibraryBooksRoundedIcon from '@mui/icons-material/LibraryBooksRounded';
import HourglassTopRoundedIcon from '@mui/icons-material/HourglassTopRounded';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, BarChart } from 'recharts';
import { useAppSelector } from '../../store';
import { CHART_SERIES, chartChrome } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import StatCard from '../../components/common/StatCard';
import { BucketBars, ChartCard, DashboardSkeleton, OpenLink, PanelCard, RankList, Yardstick, useDashboard } from '../../components/dashboard/kit';
import { fmtD, fmtMoneyShort, fmtNum } from '../../utils/format';

/* Service desk dashboard — the applications desk read the way a service-management practice reads it: intake and
 * decisions month by month, the age of the open work, what is about to breach, service-level attainment, decision time,
 * first-time-right, straight-through processing and the fee position. GET /services/dashboard. */
export interface DeskData {
  series: { key: string; month: string; received: number; decided: number; issued: number; breached: number }[];
  ageing: { bucket: string; count: number }[]; byStage: { status: string; count: number; breached: number }[]; bySubjectKind: { subjectKind: string; total: number; open: number }[];
  desk: { receivedMtd: number; receivedPrevMonth: number; decidedMtd: number; received12m: number; decided12m: number; breachedOpen: number; atRisk48h: number; decided90d: number; withinSlaPct90d: number | null; medianDecisionDays90d: number | null; avgDecisionDays90d: number | null; firstTimeRightPct90d: number | null; approvalRatePct90d: number | null; straightThroughPct90d: number | null; autoDecided90d: number; feesCollectedMtd: number; feesCollectedYtd: number; feesCollected12m: number; feesOutstanding: number; feesDueCount: number; oldestOpenDays: number };
  targets: { withinSlaPct: number; firstTimeRightPct: number; straightThroughPct: number };
  total: number; open: number; breached: number; slaCompliance: number; avgDecisionDays: number; approved: number; rejected: number; issued: number; withdrawn: number; automated: number;
  byCategory: { category: string; categoryAr: string | null; count: number }[]; byStatus: { status: string; count: number }[]; topServices: { key: string; name: string; count: number }[];
  catalogue: { published: number; total: number };
}
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const delta = (now: number, before: number, vs: string, none: string) => (before ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}% ${vs}` : none);

export default function ServiceDeskDashboard() {
  const { t } = useTranslation();
  const { data } = useDashboard<DeskData>('/services/dashboard');
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode]; const { axis, grid, tooltipStyle, cursorFill } = chartChrome(mode);
  const header = <PageHeader icon={StorefrontRoundedIcon} iconColor="#0E7C86" title={t('dash.desk.title', 'Service desk')} sub={t('dash.desk.sub', { defaultValue: 'Applications received, decided and owed against their service levels — {{date}}', date: fmtD(new Date()) })}
    actions={<Stack direction="row" spacing={1} flexWrap="wrap"><OpenLink label={t('dash.desk.openCatalogue', 'Service catalogue')} to="/services" /><OpenLink label={t('dash.desk.openRequests', 'Applications')} to="/services/requests" /><OpenLink label={t('dash.desk.openStudio', 'Service Studio')} to="/services/studio" /></Stack>} />;
  if (!data) return <>{header}<DashboardSkeleton /></>;
  const { desk: d, targets } = data;
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
  return (
    <>
      {header}
      <Grid container spacing={2} data-testid="desk-dashboard">
        <Grid item xs={6} md={3}><StatCard icon={<InboxRoundedIcon />} label={t('dash.desk.open', 'Applications open')} value={data.open} sub={`${d.oldestOpenDays} ${t('dash.desk.oldest', 'days, the oldest')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<TimerOffRoundedIcon />} label={t('dash.desk.breached', 'Past service level')} value={d.breachedOpen} sub={`${d.atRisk48h} ${t('dash.desk.atRisk', 'due within 48 h')}`} tone={d.breachedOpen ? 'error.main' : 'success.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<PendingActionsRoundedIcon />} label={t('dash.desk.receivedMtd', 'Received this month')} value={d.receivedMtd} sub={delta(d.receivedMtd, d.receivedPrevMonth, t('dash.vsSameDays', 'vs the same days last month'), t('dash.noComparison', 'no comparison yet'))} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<TaskAltRoundedIcon />} label={t('dash.desk.decidedMtd', 'Decided this month')} value={d.decidedMtd} sub={`${d.decided12m} ${t('dash.desk.in12m', 'in 12 months')} · ${data.issued} ${t('dash.desk.issuedAllTime', 'instruments issued in all')}`} tone="success.main" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<HourglassTopRoundedIcon />} label={t('dash.desk.decisionDays', 'Median decision time')} value={d.medianDecisionDays90d === null ? '—' : `${d.medianDecisionDays90d} d`} sub={`${t('dash.desk.avg', 'average')} ${d.avgDecisionDays90d ?? '—'} d · ${d.decided90d} ${t('dash.desk.decided90', 'decided in 90 days')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<PaymentsRoundedIcon />} label={t('dash.desk.fees', 'Fees collected this month')} value={fmtMoneyShort(d.feesCollectedMtd)} sub={`${fmtMoneyShort(d.feesCollectedYtd)} ${t('dash.desk.ytd', 'year to date')}`} tone="success.main" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<PaymentsRoundedIcon />} label={t('dash.desk.feesDue', 'Fees awaiting payment')} value={fmtMoneyShort(d.feesOutstanding)} sub={`${d.feesDueCount} ${t('dash.desk.feesDueSub', 'applications with a fee due')}`} tone={d.feesOutstanding ? 'warning.main' : 'primary.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<LibraryBooksRoundedIcon />} label={t('dash.desk.catalogue', 'Services published')} value={`${data.catalogue.published}/${data.catalogue.total}`} sub={`${data.automated} ${t('dash.desk.automatedSub', 'decided automatically, all time')}`} /></Grid>

        <Grid item xs={6} md={3}><Yardstick testId="yard-sla" label={t('dash.desk.withinSla', 'Decided within service level')} value={d.withinSlaPct90d} display={pct(d.withinSlaPct90d)} target={targets.withinSlaPct} targetLabel={`${t('dash.target', 'target')} ≥ ${targets.withinSlaPct}%`} sub={t('dash.desk.last90', 'last 90 days')} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-ftr" label={t('dash.desk.ftr', 'First time right')} value={d.firstTimeRightPct90d} display={pct(d.firstTimeRightPct90d)} target={targets.firstTimeRightPct} targetLabel={`${t('dash.target', 'target')} ≥ ${targets.firstTimeRightPct}%`} sub={t('dash.desk.ftrSub', 'decided without a request for more information')} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-stp" label={t('dash.desk.stp', 'Straight-through processing')} value={d.straightThroughPct90d} display={pct(d.straightThroughPct90d)} target={targets.straightThroughPct} targetLabel={`${t('dash.target', 'target')} ≥ ${targets.straightThroughPct}%`} sub={`${d.autoDecided90d} ${t('dash.desk.stpSub', 'eligible decisions in 90 days')}`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-approval" label={t('dash.desk.approval', 'Approval rate')} value={d.approvalRatePct90d} display={pct(d.approvalRatePct90d)} target={70} targetLabel={`${t('dash.reference', 'reference')} 70–90%`} sub={`${data.rejected} ${t('dash.desk.rejectedAllTime', 'rejected in all')} · ${data.withdrawn} ${t('dash.desk.withdrawn', 'withdrawn')}`} /></Grid>

        <Grid item xs={12} lg={8}>
          <ChartCard testId="chart-months" title={t('dash.desk.byMonth', 'Intake and decisions')} sub={t('dash.desk.byMonthSub', 'applications received and decided per month, with service-level breaches — trailing 12 months')}>
            <ResponsiveContainer>
              <ComposedChart data={data.series} barCategoryGap="28%">
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{v}</span>} iconSize={10} />
                <Bar dataKey="received" name={t('dash.desk.received', 'Received')} fill={C.container} radius={[4, 4, 0, 0]} />
                <Bar dataKey="decided" name={t('dash.desk.decided', 'Decided')} fill={C.dryBulk} radius={[4, 4, 0, 0]} />
                <Line type="monotone" dataKey="breached" name={t('dash.desk.breaches', 'Breaches')} stroke="#C14F33" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>
        <Grid item xs={12} lg={4}>
          <ChartCard testId="chart-categories" title={t('dash.desk.byCategory', 'Applications by category')} sub={t('dash.desk.byCategorySub', 'all time')}>
            <ResponsiveContainer>
              <BarChart data={data.byCategory.slice(0, 8)} layout="vertical" margin={{ left: 8, right: 28, top: 4 }} barCategoryGap="28%">
                <CartesianGrid stroke={grid} horizontal={false} />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="category" width={104} tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                <Bar dataKey="count" name={t('dash.desk.applications', 'Applications')} fill={C.liquid} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>

        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-ageing" title={t('dash.desk.ageing', 'Age of the open work')} sub={t('dash.desk.ageingSub', 'days since lodged')} action={{ label: t('dash.desk.openRequests', 'Applications'), to: '/services/requests?open=true' }}>
            <BucketBars rows={data.ageing.map((b) => ({ label: `${b.bucket} ${t('dash.desk.days', 'days')}`, value: b.count }))} tone={(i) => ['#0E7C86', '#0B74B0', '#B98A2F', '#D0644A', '#C14F33'][i]} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-stages" title={t('dash.desk.byStage', 'Open work by stage')} sub={t('dash.desk.byStageSub', 'and how much of it is past its service level')}>
            <BucketBars rows={data.byStage.map((s) => ({ label: label(s.status), value: s.count, sub: s.breached ? `${s.breached} ${t('dash.desk.pastSla', 'past service level')}` : undefined }))} />
            <BucketBars rows={data.bySubjectKind.map((s) => ({ label: label(s.subjectKind), value: s.total, display: `${fmtNum(s.total)}`, sub: `${s.open} ${t('dash.desk.openLower', 'open')}` }))} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-top" title={t('dash.desk.topServices', 'Most requested services')} sub={t('dash.desk.topServicesSub', 'all time')} action={{ label: t('dash.desk.openCatalogue', 'Service catalogue'), to: '/services' }}>
            <RankList rows={data.topServices.map((s) => ({ key: s.key, primary: s.name, value: fmtNum(s.count), to: `/services/${s.key}` }))} />
          </PanelCard>
        </Grid>
      </Grid>
    </>
  );
}
