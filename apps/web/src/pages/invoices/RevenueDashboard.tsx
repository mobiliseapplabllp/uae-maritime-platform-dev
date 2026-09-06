import { useTranslation } from 'react-i18next';
import { Grid, Stack } from '@mui/material';
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded';
import PaymentsRoundedIcon from '@mui/icons-material/PaymentsRounded';
import AccountBalanceWalletRoundedIcon from '@mui/icons-material/AccountBalanceWalletRounded';
import ReportProblemRoundedIcon from '@mui/icons-material/ReportProblemRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import DescriptionRoundedIcon from '@mui/icons-material/DescriptionRounded';
import CancelRoundedIcon from '@mui/icons-material/CancelRounded';
import PercentRoundedIcon from '@mui/icons-material/PercentRounded';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, BarChart, LabelList } from 'recharts';
import { useAppSelector } from '../../store';
import { CHART_SERIES, chartChrome } from '../../theme';
import { useProfile } from '../../config/runtime';
import PageHeader from '../../components/common/PageHeader';
import AiInsights from '../../components/ai/AiInsights';
import StatCard from '../../components/common/StatCard';
import { BucketBars, ChartCard, DashboardSkeleton, OpenLink, PanelCard, RankList, Yardstick, useDashboard } from '../../components/dashboard/kit';
import { fmtD, fmtMoney, fmtMoneyShort, fmtNum } from '../../utils/format';

/* Revenue & billing dashboard — the receivables read the way a finance director reads them: billed against collected,
 * the open book by age, days sales outstanding, the collection effectiveness index, and who owes what. GET /invoices/dashboard. */
export interface RevenueData {
  currency: string; termsDays: number;
  kpis: { billedMtd: number; billedPrevMonth: number; billedYtd: number; billed12m: number; collectedMtd: number; collectedYtd: number; collected12m: number; outstanding: number; openInvoices: number; overdueAmount: number; overdueCount: number; dsoDays: number | null; ceiPct: number | null; avgDaysToPay: number | null; paidOnTimePct: number | null; settled90d: number; collectionRate12mPct: number | null; vatMtd: number; remindersDue: number; drafts: { count: number; total: number; proforma: number }; cancelled12m: { count: number; total: number } };
  targets: { dsoDays: number; ceiPct: number; paidOnTimePct: number; currentSharePct: number };
  ageing: { bucket: string; count: number; amount: number }[];
  byMonth: { key: string; month: string; billed: number; collected: number; invoices: number }[];
  byLine: { code: string; label: string; amount: number; invoices: number; sharePct: number }[];
  debtors: { name: string; invoices: number; billed: number; outstanding: number; overdue: number; avgDaysToPay: number | null }[];
  methods: { method: string; count: number; amount: number }[];
  overdueList: { id: string; number: string; vesselName: string; billTo: string; total: number; outstanding: number; dueAt: string | null; daysOverdue: number; reminded: boolean }[];
  generatedAt: string;
}
const delta = (now: number, before: number, vs: string, none: string) => (before ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}% ${vs}` : none);

export default function RevenueDashboard() {
  const { t } = useTranslation();
  const { data } = useDashboard<RevenueData>('/invoices/dashboard');
  const mode = useAppSelector((s) => s.ui.mode); const profile = useProfile();
  const C = CHART_SERIES[mode]; const { axis, grid, tooltipStyle, cursorFill } = chartChrome(mode);
  const moneyAxis = (v: number) => (profile.currency.grouping === 'lakh-crore' ? `${(v / 1e7).toFixed(1)}Cr` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}K`);
  const header = <PageHeader icon={ReceiptLongRoundedIcon} iconColor="#BD3861" title={t('dash.revenue.title', 'Revenue & billing')} sub={t('dash.revenue.sub', { defaultValue: 'Billed, collected and owed — the receivables at {{date}}', date: fmtD(new Date()) })}
    actions={<Stack direction="row" spacing={1} flexWrap="wrap"><OpenLink label={t('dash.revenue.openInvoices', 'Invoices')} to="/invoices" /><OpenLink label={t('dash.revenue.openOverdue', 'Overdue')} to="/invoices?overdue=true" /><OpenLink label={t('dash.revenue.openTariffs', 'Tariffs')} to="/masters/tariffs" /></Stack>} />;
  if (!data) return <>{header}<DashboardSkeleton /></>;
  const { kpis: k, targets } = data;
  const currentShare = (() => { const total = data.ageing.reduce((s, b) => s + b.amount, 0); const cur = data.ageing.find((b) => b.bucket === 'Current')?.amount ?? 0; return total ? Math.round((cur / total) * 100) : null; })();
  return (
    <>
      {header}
      <Grid container spacing={2} data-testid="revenue-dashboard">
        <Grid item xs={6} md={3}><StatCard icon={<PaymentsRoundedIcon />} label={t('dash.revenue.billedMtd', 'Billed this month')} value={fmtMoneyShort(k.billedMtd)} sub={delta(k.billedMtd, k.billedPrevMonth, t('dash.vsSameDays', 'vs the same days last month'), t('dash.noComparison', 'no comparison yet'))} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<AccountBalanceWalletRoundedIcon />} label={t('dash.revenue.collectedMtd', 'Collected this month')} value={fmtMoneyShort(k.collectedMtd)} sub={`${fmtMoneyShort(k.collectedYtd)} ${t('dash.revenue.ytd', 'year to date')}`} tone="success.main" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<ReceiptLongRoundedIcon />} label={t('dash.revenue.outstanding', 'Outstanding')} value={fmtMoneyShort(k.outstanding)} sub={`${k.openInvoices} ${t('dash.revenue.openInvoicesSub', 'open invoices')}`} tone="warning.main" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<ReportProblemRoundedIcon />} label={t('dash.revenue.overdue', 'Overdue')} value={fmtMoneyShort(k.overdueAmount)} sub={`${k.overdueCount} ${t('dash.revenue.invoicesPastDue', 'invoices past due')} · ${k.remindersDue} ${t('dash.revenue.remindersDue', 'not yet reminded')}`} tone={k.overdueCount ? 'error.main' : 'success.main'} /></Grid>
        <Grid item xs={12} lg={4}><AiInsights module="finance" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<ScheduleRoundedIcon />} label={t('dash.revenue.billedYtd', 'Billed year to date')} value={fmtMoneyShort(k.billedYtd)} sub={`${fmtMoneyShort(k.billed12m)} ${t('dash.revenue.last12m', 'trailing 12 months')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<PercentRoundedIcon />} label={t('dash.revenue.vat', 'Tax billed this month')} value={fmtMoneyShort(k.vatMtd)} sub={t('dash.revenue.vatSub', 'on issued invoices')} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<DescriptionRoundedIcon />} label={t('dash.revenue.drafts', 'Draft pipeline')} value={fmtMoneyShort(k.drafts.total)} sub={`${k.drafts.count} ${t('dash.revenue.draftsSub', 'drafts')} · ${k.drafts.proforma} ${t('dash.revenue.proforma', 'pro-forma')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<CancelRoundedIcon />} label={t('dash.revenue.cancelled', 'Cancelled, 12 months')} value={k.cancelled12m.count} sub={`${fmtMoneyShort(k.cancelled12m.total)} ${t('dash.revenue.cancelledSub', 'withdrawn from the book')}`} /></Grid>

        <Grid item xs={6} md={3}><Yardstick testId="yard-dso" label={t('dash.revenue.dso', 'Days sales outstanding')} value={k.dsoDays} display={k.dsoDays === null ? '—' : `${k.dsoDays} d`} target={targets.dsoDays} higherIsBetter={false} targetLabel={`${t('dash.target', 'target')} ≤ ${targets.dsoDays} d`} sub={`${t('dash.revenue.terms', 'terms')} ${data.termsDays} d`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-cei" label={t('dash.revenue.cei', 'Collection effectiveness')} value={k.ceiPct} display={k.ceiPct === null ? '—' : `${k.ceiPct}%`} target={targets.ceiPct} targetLabel={`${t('dash.target', 'target')} ≥ ${targets.ceiPct}%`} sub={t('dash.revenue.ceiSub', 'collected of what fell due, 90 days')} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-ontime" label={t('dash.revenue.onTime', 'Paid on time')} value={k.paidOnTimePct} display={k.paidOnTimePct === null ? '—' : `${k.paidOnTimePct}%`} target={targets.paidOnTimePct} targetLabel={`${t('dash.target', 'target')} ≥ ${targets.paidOnTimePct}%`} sub={`${k.settled90d} ${t('dash.revenue.settled', 'settled in 90 days')} · ${k.avgDaysToPay ?? '—'} ${t('dash.revenue.daysToPay', 'days to pay')}`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-current" label={t('dash.revenue.currentShare', 'Book not yet due')} value={currentShare} display={currentShare === null ? '—' : `${currentShare}%`} target={targets.currentSharePct} targetLabel={`${t('dash.target', 'target')} ≥ ${targets.currentSharePct}%`} sub={`${k.collectionRate12mPct ?? '—'}% ${t('dash.revenue.collectionRate', 'collected of billed, 12 months')}`} /></Grid>

        <Grid item xs={12} lg={8}>
          <ChartCard testId="chart-months" title={t('dash.revenue.byMonth', 'Billed and collected')} sub={t('dash.revenue.byMonthSub', { defaultValue: 'issued invoices and payments received per month, {{currency}} — trailing 12 months', currency: data.currency })}>
            <ResponsiveContainer>
              <ComposedChart data={data.byMonth} barCategoryGap="28%">
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis tickFormatter={moneyAxis} tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => [fmtMoney(v), name]} cursor={{ fill: cursorFill }} />
                <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{v}</span>} iconSize={10} />
                <Bar dataKey="billed" name={t('dash.revenue.billed', 'Billed')} fill={C.container} radius={[4, 4, 0, 0]} />
                <Line type="monotone" dataKey="collected" name={t('dash.revenue.collected', 'Collected')} stroke={C.liquid} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>
        <Grid item xs={12} lg={4}>
          <ChartCard testId="chart-lines" title={t('dash.revenue.byLine', 'Revenue by service line')} sub={t('dash.revenue.byLineSub', 'share of billed, 12 months')}>
            <ResponsiveContainer>
              <BarChart data={data.byLine.slice(0, 8)} layout="vertical" margin={{ left: 8, right: 44, top: 4 }} barCategoryGap="28%">
                <CartesianGrid stroke={grid} horizontal={false} />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="label" width={118} tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtMoney(v), t('dash.revenue.billed', 'Billed')]} cursor={{ fill: cursorFill }} />
                <Bar dataKey="amount" fill={C.dryBulk} radius={[0, 4, 4, 0]}><LabelList dataKey="sharePct" position="right" formatter={(v: number) => `${v}%`} style={{ fill: axis, fontSize: 11 }} /></Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>

        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-ageing" title={t('dash.revenue.ageing', 'Ageing of the open book')} sub={t('dash.revenue.ageingSub', 'days past due — count and amount outstanding')} action={{ label: t('dash.revenue.openOverdue', 'Overdue'), to: '/invoices?overdue=true' }}>
            <BucketBars rows={data.ageing.map((b) => ({ label: b.bucket === 'Current' ? t('dash.revenue.current', 'Not yet due') : `${b.bucket} ${t('dash.revenue.days', 'days')}`, value: b.amount, display: fmtMoneyShort(b.amount), sub: `${b.count}` }))} tone={(i) => ['#0E7C86', '#B98A2F', '#D0644A', '#C14F33', '#8B2E1F'][i]} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-debtors" title={t('dash.revenue.debtors', 'Debtors')} sub={t('dash.revenue.debtorsSub', 'outstanding by account — overdue in red')} action={{ label: t('dash.revenue.openCompanies', 'Companies'), to: '/companies' }}>
            <RankList rows={data.debtors.map((d) => ({ key: d.name, primary: d.name, secondary: `${d.invoices} ${t('dash.revenue.invoices12m', 'invoices, 12 m')} · ${fmtMoneyShort(d.billed)} ${t('dash.revenue.billedLower', 'billed')}${d.avgDaysToPay !== null ? ` · ${d.avgDaysToPay} ${t('dash.revenue.daysToPay', 'days to pay')}` : ''}`, value: fmtMoneyShort(d.outstanding), tone: d.overdue > 0 ? 'error' : d.outstanding > 0 ? 'warning' : 'success' }))} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-overdue" title={t('dash.revenue.overdueList', 'Overdue invoices')} sub={t('dash.revenue.overdueListSub', 'largest first — open the account to remind or record a payment')}>
            <RankList empty={t('dash.revenue.noOverdue', 'Nothing is overdue')} rows={data.overdueList.map((o) => ({ key: o.id, primary: `${o.number} · ${o.billTo}`, secondary: `${o.vesselName} · ${o.daysOverdue} ${t('dash.revenue.daysOverdue', 'days overdue')}${o.reminded ? ` · ${t('dash.revenue.reminded', 'reminded')}` : ''}`, value: fmtMoneyShort(o.outstanding), tone: 'error', to: `/invoices/${o.id}` }))} />
            {data.methods.length > 0 && <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', fontSize: 12, color: 'text.secondary' }}>{data.methods.map((m) => <span key={m.method}>{m.method.toLowerCase()}: {fmtNum(m.count)} · {fmtMoneyShort(m.amount)}</span>)}</Stack>}
          </PanelCard>
        </Grid>
      </Grid>
    </>
  );
}
