import { useTranslation } from 'react-i18next';
import { Grid, Stack } from '@mui/material';
import CorporateFareRoundedIcon from '@mui/icons-material/CorporateFareRounded';
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded';
import EventRepeatRoundedIcon from '@mui/icons-material/EventRepeatRounded';
import PendingActionsRoundedIcon from '@mui/icons-material/PendingActionsRounded';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import AssignmentLateRoundedIcon from '@mui/icons-material/AssignmentLateRounded';
import SecurityRoundedIcon from '@mui/icons-material/SecurityRounded';
import StarRateRoundedIcon from '@mui/icons-material/StarRateRounded';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { useAppSelector } from '../../store';
import { CHART_SERIES, chartChrome } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import AiInsights from '../../components/ai/AiInsights';
import StatCard from '../../components/common/StatCard';
import { BucketBars, ChartCard, DashboardSkeleton, OpenLink, PanelCard, RankList, Yardstick, useDashboard } from '../../components/dashboard/kit';
import { fmtD } from '../../utils/format';

/* Port companies dashboard — who is on the register and in what standing, the licences and accreditations they hold
 * and when those lapse, the applications waiting, the obligations overdue, the security reviews and the ratings.
 * GET /facilities/dashboard and GET /facilities/accreditations/dashboard. */
export interface CompaniesData {
  kpis: { companies: number; active: number; suspended: number; blacklisted: number; inactive: number; averageRating: number; facilities: number; ispsCompliant: number; instrumentsHeld: number; dueForRenewal: number; expired: number; auditsLastYear: number; nonConformities: number; openObligations: number };
  byCategory: { category: string; total: number; active: number }[]; byStatus: { status: string; total: number }[]; byIsps: { ispsStatus: string; total: number }[]; byFacilityType: { facilityType: string; total: number }[];
  auditResults: { result: string; total: number }[];
  expiries: { d30: number; d60: number; d90: number; expired: number }; byClass: { instrumentClass: string; issued: number; pending: number; suspended: number }[];
  applications: { pending: number; applied: number; underReview: number; oldestDays: number; avgDays: number };
  obligations: { open: number; overdue: number; byKind: { kind: string; open: number; overdue: number }[] };
  securityReviewsDetail: { submitted: number; cleared12m: number; rejected12m: number; avgClearanceDays: number | null };
  ratingBands: { band: string; total: number }[]; renewalStats: { total: number; onTime: number; onTimePct: number | null }; issued12m: number;
  securityReviews: { open: number; cleared12m: number; rejected: number; never: number; total: number };
  watchlist: { id: string; code: string; name: string; category: string; status: string; rating: number }[];
  renewals: { id?: string; instrumentId?: string; number?: string; entityName?: string; companyName?: string; expiryDate?: string | null; daysLeft?: number; instrumentClass?: string }[];
}
export interface AccreditationData {
  kpis: { schemes: number; accredited: number; companies: number; due: number; expired: number; suspended: number; renewalsNext30: number; renewalsNext90: number; visitsScheduled: number; visitsOverdue: number; visitsCompleted90: number; nonConformities90: number };
  bySchemes: { category: string; label: string; companies: number; current: number; due: number; expired: number; suspended: number; visitsOverdue: number; averageRating: number | null }[];
}
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export default function CompaniesDashboard() {
  const { t } = useTranslation();
  const { data } = useDashboard<CompaniesData>('/facilities/dashboard');
  const { data: acc } = useDashboard<AccreditationData>('/facilities/accreditations/dashboard');
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode]; const { axis, grid, tooltipStyle, cursorFill } = chartChrome(mode);
  const header = <PageHeader icon={CorporateFareRoundedIcon} iconColor="#2C6E52" title={t('dash.companies.title', 'Port companies')} sub={t('dash.companies.sub', { defaultValue: 'The register, its licences and accreditations, and what the licensing desk owes — {{date}}', date: fmtD(new Date()) })}
    actions={<Stack direction="row" spacing={1} flexWrap="wrap"><OpenLink label={t('dash.companies.openDirectory', 'Company directory')} to="/companies" /><OpenLink label={t('dash.companies.openLicences', 'Licence register')} to="/facilities" /><OpenLink label={t('dash.companies.openAccreditation', 'Accreditation desk')} to="/accreditations" /><OpenLink label={t('dash.companies.openFacilities', 'Port facilities')} to="/port-facilities" /></Stack>} />;
  if (!data) return <>{header}<DashboardSkeleton /></>;
  const { kpis: k, expiries, applications: ap, obligations: ob, securityReviewsDetail: sr, renewalStats } = data;
  const audits = data.auditResults.reduce((s, r) => s + r.total, 0); const satisfactory = data.auditResults.find((r) => r.result === 'SATISFACTORY')?.total ?? 0;
  const auditPassPct = audits ? Math.round((satisfactory / audits) * 100) : null;
  return (
    <>
      {header}
      <Grid container spacing={2} data-testid="companies-dashboard">
        <Grid item xs={6} md={3}><StatCard icon={<CorporateFareRoundedIcon />} label={t('dash.companies.active', 'Companies active')} value={k.active} sub={`${k.suspended} ${t('dash.companies.suspended', 'suspended')} · ${k.inactive} ${t('dash.companies.inactive', 'inactive')} · ${k.companies} ${t('dash.companies.inAll', 'in all')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<WorkspacePremiumRoundedIcon />} label={t('dash.companies.held', 'Instruments in force')} value={k.instrumentsHeld} sub={`${data.issued12m} ${t('dash.companies.issued12m', 'issued in 12 months')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<EventRepeatRoundedIcon />} label={t('dash.companies.expiring', 'Lapsing within 90 days')} value={expiries.d90} sub={`${expiries.d30} ${t('dash.companies.in30', 'within 30')} · ${expiries.d60} ${t('dash.companies.in60', 'within 60')} · ${expiries.expired} ${t('dash.companies.expired', 'expired')}`} tone={expiries.d30 || expiries.expired ? 'warning.main' : 'primary.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<PendingActionsRoundedIcon />} label={t('dash.companies.applications', 'Applications waiting')} value={ap.pending} sub={`${ap.underReview} ${t('dash.companies.underReview', 'under review')} · ${t('dash.companies.oldest', 'oldest')} ${ap.oldestDays} d`} tone={ap.oldestDays > 60 ? 'error.main' : 'primary.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<AssignmentLateRoundedIcon />} label={t('dash.companies.obligations', 'Obligations overdue')} value={ob.overdue} sub={`${ob.open} ${t('dash.companies.obligationsOpen', 'open in all')}`} tone={ob.overdue ? 'error.main' : 'success.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<FactCheckRoundedIcon />} label={t('dash.companies.audits', 'Audits, 12 months')} value={k.auditsLastYear} sub={`${k.nonConformities} ${t('dash.companies.nonConformities', 'non-conformities')}`} tone={k.nonConformities ? 'warning.main' : 'success.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<SecurityRoundedIcon />} label={t('dash.companies.security', 'Security reviews with the authority')} value={sr.submitted} sub={`${sr.cleared12m} ${t('dash.companies.cleared', 'cleared')} · ${sr.rejected12m} ${t('dash.companies.sentBack', 'sent back, 12 months')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<StarRateRoundedIcon />} label={t('dash.companies.rating', 'Average rating')} value={k.averageRating ? k.averageRating.toFixed(1) : '—'} sub={`${data.watchlist.length} ${t('dash.companies.watchlist', 'on the watchlist')}`} /></Grid>
        <Grid item xs={12}><AiInsights module="facil" /></Grid>

        <Grid item xs={6} md={3}><Yardstick testId="yard-renewal" label={t('dash.companies.onTime', 'Renewals on time')} value={renewalStats.onTimePct} display={renewalStats.onTimePct === null ? '—' : `${renewalStats.onTimePct}%`} target={90} targetLabel={`${t('dash.target', 'target')} ≥ 90%`} sub={`${renewalStats.onTime}/${renewalStats.total} ${t('dash.companies.onTimeSub', 'cycles renewed before lapsing')}`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-clearance" label={t('dash.companies.clearance', 'Security clearance, avg')} value={sr.avgClearanceDays} display={sr.avgClearanceDays === null ? '—' : `${sr.avgClearanceDays} d`} target={30} higherIsBetter={false} targetLabel={`${t('dash.target', 'target')} ≤ 30 d`} sub={t('dash.companies.clearanceSub', 'from submission to decision')} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-audit" label={t('dash.companies.auditPass', 'Audits satisfactory')} value={auditPassPct} display={auditPassPct === null ? '—' : `${auditPassPct}%`} target={80} targetLabel={`${t('dash.target', 'target')} ≥ 80%`} sub={`${audits} ${t('dash.companies.auditsSub', 'audited in 12 months')}`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-wait" label={t('dash.companies.wait', 'Application wait, avg')} value={ap.avgDays} display={`${ap.avgDays} d`} target={45} higherIsBetter={false} targetLabel={`${t('dash.target', 'target')} ≤ 45 d`} sub={`${ap.applied} ${t('dash.companies.notYetScreened', 'not yet screened')}`} /></Grid>

        <Grid item xs={12} lg={7}>
          <ChartCard testId="chart-classes" title={t('dash.companies.byClass', 'Instruments by class')} sub={t('dash.companies.byClassSub', 'in force, pending and suspended')} action={{ label: t('dash.companies.openLicences', 'Licence register'), to: '/facilities' }}>
            <ResponsiveContainer>
              <BarChart data={data.byClass.map((c) => ({ ...c, label: label(c.instrumentClass) }))} barCategoryGap="28%">
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{v}</span>} iconSize={10} />
                <Bar dataKey="issued" name={t('dash.companies.inForce', 'In force')} stackId="c" fill={C.container} />
                <Bar dataKey="pending" name={t('dash.companies.pending', 'Pending')} stackId="c" fill={C.dryBulk} />
                <Bar dataKey="suspended" name={t('dash.companies.suspendedKind', 'Suspended')} stackId="c" fill="#C14F33" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>
        <Grid item xs={12} lg={5}>
          <PanelCard testId="panel-schemes" title={t('dash.companies.schemes', 'Accreditation schemes')} sub={t('dash.companies.schemesSub', 'companies accredited under each scheme, and how many are due')} action={{ label: t('dash.companies.openAccreditation', 'Accreditation desk'), to: '/accreditations' }} minHeight={320}>
            {acc ? <BucketBars rows={acc.bySchemes.map((s) => ({ label: s.label, value: s.companies, sub: `${s.current} ${t('dash.companies.current', 'current')}${s.due ? ` · ${s.due} ${t('dash.companies.due', 'due')}` : ''}${s.visitsOverdue ? ` · ${s.visitsOverdue} ${t('dash.companies.visitsOverdue', 'visits overdue')}` : ''}${s.averageRating ? ` · ★ ${s.averageRating}` : ''}` }))} /> : null}
            {acc && <BucketBars rows={[{ label: t('dash.companies.renewals90', 'Renewals due within 90 days'), value: acc.kpis.renewalsNext90, sub: `${acc.kpis.renewalsNext30} ${t('dash.companies.within30', 'within 30')}` }, { label: t('dash.companies.visitsScheduled', 'Visits scheduled'), value: acc.kpis.visitsScheduled, sub: acc.kpis.visitsOverdue ? `${acc.kpis.visitsOverdue} ${t('dash.companies.overdue', 'overdue')}` : undefined }]} />}
          </PanelCard>
        </Grid>

        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-categories" title={t('dash.companies.byCategory', 'Register by category')} sub={t('dash.companies.byCategorySub', 'companies, and how many are active')} action={{ label: t('dash.companies.openDirectory', 'Company directory'), to: '/companies' }}>
            <BucketBars rows={data.byCategory.map((c) => ({ label: label(c.category), value: c.total, sub: `${c.active} ${t('dash.companies.activeLower', 'active')}` }))} />
            <BucketBars rows={data.ratingBands.map((b) => ({ label: `★ ${b.band}`, value: b.total }))} tone={(i) => ['#C14F33', '#D0644A', '#B98A2F', '#056A73'][i]} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-renewals" title={t('dash.companies.renewalsList', 'Lapsing soonest')} sub={t('dash.companies.renewalsListSub', 'instruments due for renewal')} action={{ label: t('dash.companies.openLicences', 'Licence register'), to: '/facilities' }}>
            <RankList empty={t('dash.companies.nothingLapsing', 'Nothing lapses in the window')} rows={data.renewals.map((r, i) => ({ key: String(r.instrumentId ?? r.id ?? i), primary: `${r.number ?? ''} ${r.entityName ?? r.companyName ?? ''}`.trim(), secondary: r.instrumentClass ? label(r.instrumentClass) : undefined, value: r.expiryDate ? fmtD(r.expiryDate) : '—', tone: (r.daysLeft ?? 99) <= 30 ? 'error' : 'warning', to: r.instrumentId ? `/facilities/${r.instrumentId}` : '/facilities' }))} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-watchlist" title={t('dash.companies.watchlistTitle', 'Watchlist and obligations')} sub={t('dash.companies.watchlistSub', 'lowest-rated companies, and what is owed by kind')}>
            <RankList rows={data.watchlist.map((c) => ({ key: c.id, primary: c.name, secondary: `${label(c.category)} · ${label(c.status)}`, value: `★ ${c.rating.toFixed(1)}`, tone: c.rating < 3 ? 'error' : 'warning', to: `/companies/${c.id}` }))} />
            <BucketBars rows={ob.byKind.map((o) => ({ label: label(o.kind), value: o.open, sub: o.overdue ? `${o.overdue} ${t('dash.companies.overdue', 'overdue')}` : undefined }))} />
          </PanelCard>
        </Grid>
      </Grid>
    </>
  );
}
