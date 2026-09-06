import { useTranslation } from 'react-i18next';
import { Grid, Stack } from '@mui/material';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import ListAltRoundedIcon from '@mui/icons-material/ListAltRounded';
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded';
import TranslateRoundedIcon from '@mui/icons-material/TranslateRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import RuleRoundedIcon from '@mui/icons-material/RuleRounded';
import UpdateRoundedIcon from '@mui/icons-material/UpdateRounded';
import DirectionsBoatFilledRoundedIcon from '@mui/icons-material/DirectionsBoatFilledRounded';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LabelList } from 'recharts';
import { useAppSelector } from '../../store';
import { CHART_SERIES, chartChrome } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import AiInsights from '../../components/ai/AiInsights';
import StatCard from '../../components/common/StatCard';
import { BucketBars, ChartCard, DashboardSkeleton, OpenLink, PanelCard, RankList, Yardstick, useDashboard } from '../../components/dashboard/kit';
import { fmtD, fmtNum, fromNow } from '../../utils/format';

/* Data Studio dashboard — the state of the reference data every module validates against, graded on the dimensions the
 * data-quality discipline uses plus the bilingual one this platform owes: completeness, uniqueness, validity, timeliness,
 * Arabic coverage. GET /golden/dashboard. */
export interface StudioData {
  kpis: { masters: number; entries: number; active: number; inactive: number; arabicPct: number; duplicates: number; invalid: number; staleMasters: number; staleDays: number; updated30d: number; goldenVessels: number; goldenCompanies: number; vesselCompletenessPct: number; companyCompletenessPct: number; pendingRecords: number; settingsChanged30d: number; qualityScore: number; grade: string };
  dimensions: { dimension: string; score: number; detail: string }[];
  masters: { category: string; entries: number; active: number; arabicPct: number; duplicates: number; invalid: number; updatedAt: string | null; ageDays: number | null; stale: boolean; score: number; grade: string }[];
  recentSettings: { key: string; updatedAt: string | null; updatedBy: string }[];
  weakest: StudioData['masters'];
  generatedAt: string;
}
const humanise = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());
const settingLink = (key: string) => (key.startsWith('module:') ? `/settings/module/${key.slice(7)}` : `/admin/settings/${key}`);

export default function DataStudioDashboard() {
  const { t } = useTranslation();
  const { data } = useDashboard<StudioData>('/golden/dashboard');
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode]; const { axis, grid, tooltipStyle, cursorFill } = chartChrome(mode);
  const header = <PageHeader icon={HubRoundedIcon} iconColor="#5A6B78" title={t('dash.studio.title', 'Data Studio')} sub={t('dash.studio.sub', { defaultValue: 'The reference data every module validates against, graded on the data-quality dimensions — {{date}}', date: fmtD(new Date()) })}
    actions={<Stack direction="row" spacing={1} flexWrap="wrap"><OpenLink label={t('dash.studio.openMasters', 'All masters')} to="/masters" /><OpenLink label={t('dash.studio.openBerths', 'Berths')} to="/masters/berths" /><OpenLink label={t('dash.studio.openLookups', 'Raw lookups')} to="/masters/lookups" /></Stack>} />;
  if (!data) return <>{header}<DashboardSkeleton /></>;
  const { kpis: k } = data;
  const dim = (name: string) => data.dimensions.find((d) => d.dimension === name);
  return (
    <>
      {header}
      <Grid container spacing={2} data-testid="studio-dashboard">
        <Grid item xs={6} md={3}><StatCard icon={<HubRoundedIcon />} label={t('dash.studio.masters', 'Masters')} value={k.masters} sub={`${fmtNum(k.entries)} ${t('dash.studio.values', 'values')} · ${k.inactive} ${t('dash.studio.retired', 'retired')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<VerifiedRoundedIcon />} label={t('dash.studio.quality', 'Data quality')} value={`${k.qualityScore} · ${k.grade}`} sub={t('dash.studio.qualitySub', 'mean of the five dimensions')} tone={k.qualityScore >= 85 ? 'success.main' : k.qualityScore >= 70 ? 'warning.main' : 'error.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<TranslateRoundedIcon />} label={t('dash.studio.arabic', 'Arabic labels')} value={`${k.arabicPct}%`} sub={t('dash.studio.arabicSub', 'of master values carry one')} tone={k.arabicPct >= 95 ? 'success.main' : 'warning.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<ContentCopyRoundedIcon />} label={t('dash.studio.duplicates', 'Duplicate labels')} value={k.duplicates} sub={t('dash.studio.duplicatesSub', 'same label twice within a master')} tone={k.duplicates ? 'warning.main' : 'success.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<RuleRoundedIcon />} label={t('dash.studio.invalid', 'Malformed values')} value={k.invalid} sub={t('dash.studio.invalidSub', 'bad code or empty label')} tone={k.invalid ? 'error.main' : 'success.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<UpdateRoundedIcon />} label={t('dash.studio.stale', 'Masters untouched')} value={k.staleMasters} sub={t('dash.studio.staleSub', { defaultValue: 'for more than {{days}} days · {{n}} values changed in 30 d', days: k.staleDays, n: k.updated30d })} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<DirectionsBoatFilledRoundedIcon />} label={t('dash.studio.golden', 'Golden records')} value={k.goldenVessels + k.goldenCompanies} sub={`${k.goldenVessels} ${t('dash.studio.vessels', 'vessels')} · ${k.goldenCompanies} ${t('dash.studio.companies', 'companies')} · ${k.pendingRecords} ${t('dash.studio.pending', 'unpublished')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<ListAltRoundedIcon />} label={t('dash.studio.settingsChanged', 'Settings changed, 30 d')} value={k.settingsChanged30d} sub={t('dash.studio.settingsSub', 'platform and module settings')} /></Grid>
        <Grid item xs={12}><AiInsights module="masters" /></Grid>

        {data.dimensions.map((d) => (
          <Grid item xs={6} md={4} lg={2.4} key={d.dimension}>
            <Yardstick testId={`yard-${d.dimension.toLowerCase()}`} label={t(`dash.studio.dim.${d.dimension.toLowerCase()}`, d.dimension)} value={d.score} display={`${d.score}`} target={90} targetLabel={`${t('dash.target', 'target')} ≥ 90`} sub={d.detail} />
          </Grid>
        ))}

        <Grid item xs={12} lg={7}>
          <ChartCard testId="chart-masters" title={t('dash.studio.largest', 'The largest masters')} sub={t('dash.studio.largestSub', 'values per master, with the share carrying an Arabic label')} action={{ label: t('dash.studio.openMasters', 'All masters'), to: '/masters' }} h={320} explain={{ data: data.masters.slice(0, 12).map((m) => ({ ...m, label: humanise(m.category) })) }}>
            <ResponsiveContainer>
              <BarChart data={data.masters.slice(0, 12).map((m) => ({ ...m, label: humanise(m.category) }))} layout="vertical" margin={{ left: 8, right: 40, top: 4 }} barCategoryGap="24%">
                <CartesianGrid stroke={grid} horizontal={false} />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="label" width={140} tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                <Bar dataKey="entries" name={t('dash.studio.values', 'values')} fill={C.container} radius={[0, 4, 4, 0]}><LabelList dataKey="arabicPct" position="right" formatter={(v: number) => `${v}% AR`} style={{ fill: axis, fontSize: 10.5 }} /></Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>
        <Grid item xs={12} lg={5}>
          <PanelCard testId="panel-weakest" title={t('dash.studio.weakest', 'Masters needing work')} sub={t('dash.studio.weakestSub', 'lowest grade first — open one to complete it')} minHeight={320} explain={{ data: data.weakest.map((m) => ({ key: m.category, primary: humanise(m.category), secondary: `${m.entries} ${t('dash.studio.values', 'values')} · ${m.arabicPct}% ${t('dash.studio.arabicShort', 'Arabic')}${m.duplicates ? ` · ${m.duplicates} ${t('dash.studio.dupShort', 'duplicate')}` : ''}${m.invalid ? ` · ${m.invalid} ${t('dash.studio.invalidShort', 'malformed')}` : ''}${m.stale ? ` · ${t('dash.studio.staleShort', 'stale')}` : ''}`, value: `${m.grade} · ${m.score}`, tone: m.grade === 'D' ? 'error' : m.grade === 'C' ? 'warning' : 'default', to: `/masters/m/${m.category}` })) }}>
            <RankList empty={t('dash.studio.allGood', 'Every master grades A')} rows={data.weakest.map((m) => ({ key: m.category, primary: humanise(m.category), secondary: `${m.entries} ${t('dash.studio.values', 'values')} · ${m.arabicPct}% ${t('dash.studio.arabicShort', 'Arabic')}${m.duplicates ? ` · ${m.duplicates} ${t('dash.studio.dupShort', 'duplicate')}` : ''}${m.invalid ? ` · ${m.invalid} ${t('dash.studio.invalidShort', 'malformed')}` : ''}${m.stale ? ` · ${t('dash.studio.staleShort', 'stale')}` : ''}`, value: `${m.grade} · ${m.score}`, tone: m.grade === 'D' ? 'error' : m.grade === 'C' ? 'warning' : 'default', to: `/masters/m/${m.category}` }))} />
          </PanelCard>
        </Grid>

        <Grid item xs={12} md={6}>
          <PanelCard testId="panel-golden" title={t('dash.studio.goldenTitle', 'Golden record completeness')} sub={t('dash.studio.goldenSub', 'key fields filled on the records other services copy')} explain={{ data: [
              { label: t('dash.studio.vesselsGolden', { defaultValue: 'Vessels ({{n}})', n: k.goldenVessels }), value: k.vesselCompletenessPct, display: `${k.vesselCompletenessPct}%` },
              { label: t('dash.studio.companiesGolden', { defaultValue: 'Companies ({{n}})', n: k.goldenCompanies }), value: k.companyCompletenessPct, display: `${k.companyCompletenessPct}%` },
              { label: t('dash.studio.arabicRow', 'Master values with Arabic'), value: k.arabicPct, display: `${k.arabicPct}%` },
              { label: t('dash.studio.timelinessRow', 'Masters touched recently'), value: dim('Timeliness')?.score ?? 0, display: `${dim('Timeliness')?.score ?? 0}%` },
            ] }}>
            <BucketBars rows={[
              { label: t('dash.studio.vesselsGolden', { defaultValue: 'Vessels ({{n}})', n: k.goldenVessels }), value: k.vesselCompletenessPct, display: `${k.vesselCompletenessPct}%` },
              { label: t('dash.studio.companiesGolden', { defaultValue: 'Companies ({{n}})', n: k.goldenCompanies }), value: k.companyCompletenessPct, display: `${k.companyCompletenessPct}%` },
              { label: t('dash.studio.arabicRow', 'Master values with Arabic'), value: k.arabicPct, display: `${k.arabicPct}%` },
              { label: t('dash.studio.timelinessRow', 'Masters touched recently'), value: dim('Timeliness')?.score ?? 0, display: `${dim('Timeliness')?.score ?? 0}%` },
            ]} max={100} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={6}>
          <PanelCard testId="panel-settings" title={t('dash.studio.recent', 'Recent setting changes')} sub={t('dash.studio.recentSub', 'who changed what in the last 30 days')} action={{ label: t('dash.studio.openSettings', 'Settings'), to: '/admin/settings' }} explain={{ data: data.recentSettings.map((s) => ({ key: s.key, primary: s.key.startsWith('module:') ? `${t('dash.studio.moduleSetting', 'Module')} · ${s.key.slice(7)}` : humanise(s.key), secondary: s.updatedBy, value: s.updatedAt ? fromNow(s.updatedAt) : '—', to: settingLink(s.key) })) }}>
            <RankList empty={t('dash.studio.noChanges', 'No changes in 30 days')} rows={data.recentSettings.map((s) => ({ key: s.key, primary: s.key.startsWith('module:') ? `${t('dash.studio.moduleSetting', 'Module')} · ${s.key.slice(7)}` : humanise(s.key), secondary: s.updatedBy, value: s.updatedAt ? fromNow(s.updatedAt) : '—', to: settingLink(s.key) }))} />
          </PanelCard>
        </Grid>
      </Grid>
    </>
  );
}
