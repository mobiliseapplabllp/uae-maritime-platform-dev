import { useTranslation } from 'react-i18next';
import { Grid, Stack } from '@mui/material';
import CampaignRoundedIcon from '@mui/icons-material/CampaignRounded';
import GavelRoundedIcon from '@mui/icons-material/GavelRounded';
import DraftsRoundedIcon from '@mui/icons-material/DraftsRounded';
import HowToRegRoundedIcon from '@mui/icons-material/HowToRegRounded';
import TravelExploreRoundedIcon from '@mui/icons-material/TravelExploreRounded';
import EventRoundedIcon from '@mui/icons-material/EventRounded';
import HistoryEduRoundedIcon from '@mui/icons-material/HistoryEduRounded';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import RssFeedRoundedIcon from '@mui/icons-material/RssFeedRounded';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { useAppSelector } from '../../store';
import { CHART_SERIES, chartChrome } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import AiInsights from '../../components/ai/AiInsights';
import StatCard from '../../components/common/StatCard';
import { BucketBars, ChartCard, DashboardSkeleton, OpenLink, PanelCard, RankList, Yardstick, useDashboard } from '../../components/dashboard/kit';
import { fmtD } from '../../utils/format';

/* Notices & circulars dashboard — the library in force, what is drafted and owed, how promptly readers acknowledge, the
 * review age of the law, and the IMO watch from seen to transposed. GET /legislation/dashboard and GET /legislation/imo/dashboard. */
interface Summary { id: string; refNo: string; title: string; type: string; category: string; status: string; issuedDate: string | null; effectiveDate?: string | null }
export interface NoticesData {
  kpis: { total: number; inForce: number; drafts: number; superseded: number; withdrawn: number; conventions: number; ackRequired: number; ackOutstanding: number; ackCompliancePct: number; awaitingApproval: number; awaitingReview: number; comingIntoForce: number; lapsingSoon: number };
  byType: { type: string; total: number; inForce: number; drafts: number }[]; bySubject: { subject: string; total: number; inForce: number }[];
  drafts: (Summary & { draftedBy: string; reviewed: boolean; cleared: boolean })[]; recent: Summary[];
  outstanding: (Summary & { recipients: number; acknowledgements: number; outstanding: number })[];
  byMonth: { key: string; month: string; issued: number; circulars: number; notices: number; other: number; acknowledgements: number }[];
  issued12m: number; currency: { inForce: number; olderThanReview: number; olderThanReviewPct: number; reviewYears: number; avgAgeYears: number };
  acknowledgements: { acks12m: number; avgDays: number | null; withinDuePct: number | null };
  reviewList: { id: string; refNo: string; title: string; type: string; category: string; issuedDate: string | null; ageYears: number }[];
  roll: number; ackDueDays: number; generatedAt: string;
}
export interface ImoData {
  kpis: { sources: number; polledOk: number; failed: number; neverPolled: number; items: number; new: number; assessed: number; transposed: number; dismissed: number; overdue: number; last30Days: number; withInstrument: number; leadTimeDays: number | null; dueSoon: number };
  bySource: { source: string; label?: string; items: number; new: number; lastStatus?: string }[];
  attention: { id: string; reference: string; title: string; source: string; sourceLabel?: string; status: string; publishedOn: string | null; dueOn?: string | null; overdue: boolean }[];
}
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export default function NoticesDashboard() {
  const { t } = useTranslation();
  const { data } = useDashboard<NoticesData>('/legislation/dashboard');
  const { data: imo } = useDashboard<ImoData>('/legislation/imo/dashboard');
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode]; const { axis, grid, tooltipStyle, cursorFill } = chartChrome(mode);
  const header = <PageHeader icon={CampaignRoundedIcon} iconColor="#8A5A2B" title={t('dash.notices.title', 'Notices & circulars')} sub={t('dash.notices.sub', { defaultValue: 'The library in force, what is drafted and owed, and the IMO watch — {{date}}', date: fmtD(new Date()) })}
    actions={<Stack direction="row" spacing={1} flexWrap="wrap"><OpenLink label={t('dash.notices.openLibrary', 'Notice library')} to="/legislation" /><OpenLink label={t('dash.notices.openImo', 'IMO watch')} to="/legislation/imo" /><OpenLink label={t('dash.notices.openPortal', 'Public portal')} to="/law" /></Stack>} />;
  if (!data) return <>{header}<DashboardSkeleton /></>;
  const { kpis: k, currency, acknowledgements: ack } = data;
  const funnel = imo ? [
    { label: t('dash.notices.imoNew', 'New'), value: imo.kpis.new }, { label: t('dash.notices.imoAssessed', 'Assessed'), value: imo.kpis.assessed },
    { label: t('dash.notices.imoTransposed', 'Transposed'), value: imo.kpis.transposed }, { label: t('dash.notices.imoDismissed', 'Dismissed'), value: imo.kpis.dismissed },
  ] : [];
  return (
    <>
      {header}
      <Grid container spacing={2} data-testid="notices-dashboard">
        <Grid item xs={6} md={3}><StatCard icon={<GavelRoundedIcon />} label={t('dash.notices.inForce', 'In force')} value={k.inForce} sub={`${k.conventions} ${t('dash.notices.conventions', 'conventions')} · ${k.superseded} ${t('dash.notices.superseded', 'superseded')} · ${k.withdrawn} ${t('dash.notices.withdrawn', 'withdrawn')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<EventRoundedIcon />} label={t('dash.notices.issued12m', 'Issued, 12 months')} value={data.issued12m} sub={`${k.comingIntoForce} ${t('dash.notices.comingIntoForce', 'coming into force')} · ${k.lapsingSoon} ${t('dash.notices.lapsing', 'lapsing soon')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<DraftsRoundedIcon />} label={t('dash.notices.drafts', 'Drafts')} value={k.drafts} sub={`${k.awaitingReview} ${t('dash.notices.awaitingReview', 'awaiting review')} · ${k.awaitingApproval} ${t('dash.notices.awaitingApproval', 'ready to approve')}`} tone={k.awaitingApproval ? 'warning.main' : 'primary.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<HowToRegRoundedIcon />} label={t('dash.notices.ackOutstanding', 'Acknowledgements owed')} value={k.ackOutstanding} sub={`${k.ackRequired} ${t('dash.notices.ackRequired', 'instruments require one')} · ${data.roll} ${t('dash.notices.onRoll', 'on the roll')}`} tone={k.ackOutstanding ? 'warning.main' : 'success.main'} /></Grid>
        <Grid item xs={12} lg={4}><AiInsights module="legis" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<TravelExploreRoundedIcon />} label={t('dash.notices.imoItems', 'IMO watch items')} value={imo ? imo.kpis.items : '—'} sub={imo ? `${imo.kpis.new} ${t('dash.notices.imoNewLower', 'new')} · ${imo.kpis.last30Days} ${t('dash.notices.seen30d', 'seen in 30 days')}` : ''} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<PublicRoundedIcon />} label={t('dash.notices.imoOverdue', 'Assessments overdue')} value={imo ? imo.kpis.overdue : '—'} sub={imo ? `${imo.kpis.dueSoon} ${t('dash.notices.dueSoon', 'due within a fortnight')}` : ''} tone={imo?.kpis.overdue ? 'error.main' : 'success.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<RssFeedRoundedIcon />} label={t('dash.notices.sources', 'Sources watched')} value={imo ? `${imo.kpis.polledOk}/${imo.kpis.sources}` : '—'} sub={imo ? (imo.kpis.failed ? `${imo.kpis.failed} ${t('dash.notices.failing', 'failing')}` : t('dash.notices.allPolling', 'all answering')) : ''} tone={imo?.kpis.failed ? 'error.main' : 'success.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<HistoryEduRoundedIcon />} label={t('dash.notices.avgAge', 'Average age in force')} value={`${currency.avgAgeYears} y`} sub={`${currency.olderThanReview} ${t('dash.notices.olderThan', { defaultValue: 'older than {{y}} years', y: currency.reviewYears })}`} /></Grid>

        <Grid item xs={6} md={3}><Yardstick testId="yard-ack" label={t('dash.notices.ackCompliance', 'Acknowledgement compliance')} value={k.ackCompliancePct} display={`${k.ackCompliancePct}%`} target={95} targetLabel={`${t('dash.target', 'target')} ≥ 95%`} sub={`${ack.acks12m} ${t('dash.notices.acks12m', 'acknowledgements in 12 months')}`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-ackdays" label={t('dash.notices.ackDays', 'Days to acknowledge, avg')} value={ack.avgDays} display={ack.avgDays === null ? '—' : `${ack.avgDays} d`} target={data.ackDueDays} higherIsBetter={false} targetLabel={`${t('dash.notices.due', 'due within')} ${data.ackDueDays} d`} sub={ack.withinDuePct === null ? '' : `${ack.withinDuePct}% ${t('dash.notices.withinDue', 'within the due date')}`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-review" label={t('dash.notices.reviewAge', 'Law past its review age')} value={currency.olderThanReviewPct} display={`${currency.olderThanReviewPct}%`} target={25} higherIsBetter={false} targetLabel={`${t('dash.target', 'target')} ≤ 25%`} sub={t('dash.notices.reviewSub', { defaultValue: 'in force and untouched for {{y}} years', y: currency.reviewYears })} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-lead" label={t('dash.notices.leadTime', 'IMO item: seen to assessed')} value={imo?.kpis.leadTimeDays ?? null} display={imo?.kpis.leadTimeDays == null ? '—' : `${imo.kpis.leadTimeDays} d`} target={14} higherIsBetter={false} targetLabel={`${t('dash.target', 'target')} ≤ 14 d`} sub={imo ? `${imo.kpis.withInstrument} ${t('dash.notices.withInstrument', 'linked to an instrument')}` : ''} /></Grid>

        <Grid item xs={12} lg={8}>
          <ChartCard testId="chart-months" title={t('dash.notices.byMonth', 'Issuance and acknowledgements')} sub={t('dash.notices.byMonthSub', 'instruments issued per month by kind, with the acknowledgements received — trailing 12 months')}>
            <ResponsiveContainer>
              <ComposedChart data={data.byMonth} barCategoryGap="28%">
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis yAxisId="n" tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
                <YAxis yAxisId="acks" orientation="right" tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{v}</span>} iconSize={10} />
                <Bar yAxisId="n" dataKey="circulars" name={t('dash.notices.circulars', 'Circulars')} stackId="i" fill={C.container} />
                <Bar yAxisId="n" dataKey="notices" name={t('dash.notices.noticesKind', 'Notices')} stackId="i" fill={C.dryBulk} />
                <Bar yAxisId="n" dataKey="other" name={t('dash.notices.otherKind', 'Rules, orders, acts')} stackId="i" fill={C.other} radius={[4, 4, 0, 0]} />
                <Line yAxisId="acks" type="monotone" dataKey="acknowledgements" name={t('dash.notices.acknowledgements', 'Acknowledgements')} stroke={C.liquid} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>
        <Grid item xs={12} lg={4}>
          <PanelCard testId="panel-imo" title={t('dash.notices.imoFunnel', 'IMO watch: seen to transposed')} sub={t('dash.notices.imoFunnelSub', 'items by stage, with the sources behind them')} action={{ label: t('dash.notices.openImo', 'IMO watch'), to: '/legislation/imo' }} minHeight={320}>
            <BucketBars rows={funnel} tone={(i) => ['#B98A2F', '#0B74B0', '#056A73', '#8A96A3'][i]} />
            {imo && <BucketBars rows={imo.bySource.slice(0, 6).map((s) => ({ label: s.label ?? s.source, value: s.items, sub: s.new ? `${s.new} ${t('dash.notices.imoNewLower', 'new')}` : undefined }))} />}
          </PanelCard>
        </Grid>

        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-outstanding" title={t('dash.notices.outstanding', 'Most acknowledgements owed')} sub={t('dash.notices.outstandingSub', 'instruments still unread by those who must read them')} action={{ label: t('dash.notices.openLibrary', 'Notice library'), to: '/legislation' }}>
            <RankList empty={t('dash.notices.allRead', 'Everything required has been acknowledged')} rows={data.outstanding.map((o) => ({ key: o.id, primary: `${o.refNo} · ${o.title}`, secondary: `${o.acknowledgements}/${o.recipients} ${t('dash.notices.acknowledged', 'acknowledged')}`, value: `${o.outstanding}`, tone: 'warning', to: `/legislation?q=${encodeURIComponent(o.refNo)}` }))} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-drafts" title={t('dash.notices.draftsTitle', 'Drafts in the four-eyes ladder')} sub={t('dash.notices.draftsSub', 'drafted, reviewed, cleared — then approved')}>
            <RankList empty={t('dash.notices.noDrafts', 'No drafts open')} rows={data.drafts.map((d) => ({ key: d.id, primary: `${d.refNo} · ${d.title}`, secondary: `${label(d.type)} · ${d.draftedBy}`, value: d.cleared ? t('dash.notices.cleared', 'cleared') : d.reviewed ? t('dash.notices.reviewed', 'reviewed') : t('dash.notices.drafted', 'drafted'), tone: d.cleared ? 'success' : d.reviewed ? 'warning' : 'default', to: `/legislation?q=${encodeURIComponent(d.refNo)}` }))} />
            {imo && imo.attention.length > 0 && <>
              <RankList testId="imo-attention" rows={imo.attention.slice(0, 4).map((i) => ({ key: i.id, primary: `${i.reference} · ${i.title}`, secondary: `${i.sourceLabel ?? i.source} · ${i.publishedOn ? fmtD(i.publishedOn) : ''}`, value: i.overdue ? t('dash.notices.overdue', 'overdue') : label(i.status), tone: i.overdue ? 'error' : 'warning', to: '/legislation/imo' }))} />
            </>}
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-review" title={t('dash.notices.reviewList', 'Due for review')} sub={t('dash.notices.reviewListSub', { defaultValue: 'in force for more than {{y}} years without amendment, oldest first', y: currency.reviewYears })}>
            <RankList empty={t('dash.notices.nothingAged', 'Nothing past its review age')} rows={data.reviewList.map((r) => ({ key: r.id, primary: `${r.refNo} · ${r.title}`, secondary: `${label(r.type)} · ${r.category}`, value: `${r.ageYears} y`, tone: r.ageYears > 10 ? 'error' : 'warning', to: `/legislation?q=${encodeURIComponent(r.refNo)}` }))} />
            <BucketBars rows={data.byType.slice(0, 6).map((x) => ({ label: label(x.type), value: x.inForce, display: `${x.inForce}`, sub: `${x.total} ${t('dash.notices.inAll', 'in all')}` }))} />
          </PanelCard>
        </Grid>
      </Grid>
    </>
  );
}
