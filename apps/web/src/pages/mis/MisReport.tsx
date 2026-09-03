import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Skeleton, Chip, Stack, Button, Tabs, Tab, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, TextField, Divider, Tooltip as MuiTooltip } from '@mui/material';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import PrintRoundedIcon from '@mui/icons-material/PrintRounded';
import AssessmentRoundedIcon from '@mui/icons-material/AssessmentRounded';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LineChart, Line } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { CHART_SERIES, SERIES_ORDER, SERIES_LABELS, chartChrome, MONO } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import { fmtDT, fmtMT, fmtMoney, fmtMoneyShort, fmtNum } from '../../utils/format';
import { useProfile } from '../../config/runtime';
import type { ExportColumn } from '../../utils/exportUtils';
import { MIS_PRESETS, avgOf, benchmarkLabel, benchmarkValue, collectionPct, outstandingOf } from './shared';
import type { MisData, MisMonth } from './types';

/* The MIS report — management aggregates by month across cargo, traffic, revenue and compliance, with the jurisdiction's benchmarks alongside. */
const Kpi = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
  <Card sx={{ px: 2, py: 1.5 }}>
    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
    {sub && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{sub}</Typography>}
  </Card>
);
function Section({ title, sub, onCsv, csvLabel, children }: { title: string; sub?: string; onCsv?: () => void; csvLabel?: string; children: React.ReactNode }) {
  return (
    <Card sx={{ p: 2, height: '100%' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1, gap: 1 }}>
        <Box><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{title}</Typography>{sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}</Box>
        {onCsv && <Button size="small" startIcon={<DownloadRoundedIcon sx={{ fontSize: 16 }} />} onClick={onCsv} sx={{ displayPrint: 'none', flexShrink: 0 }} aria-label={`${csvLabel || 'CSV'} — ${title}`}>{csvLabel || 'CSV'}</Button>}
      </Box>
      {children}
    </Card>
  );
}
const num = { fontVariantNumeric: 'tabular-nums' } as const;

export default function MisReport() {
  const dispatch = useAppDispatch();
  const profile = useProfile();
  const { t } = useTranslation();
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode];
  const { axis, grid, paper, tooltipStyle, cursorFill } = chartChrome(mode);
  const [months, setMonths] = useState(12);
  const [tab, setTab] = useState(0);
  const [data, setData] = useState<MisData | null>(null);

  const load = useCallback((m: number) => {
    setData(null);
    api.get<MisData>('/reports/mis', { params: { months: m } }).then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  }, [dispatch]);
  useEffect(() => { load(12); }, [load]);

  const csv = async (name: string, rows: MisMonth[], columns: ExportColumn[]) => {
    const { exportCsv } = await import('../../utils/exportUtils');
    await exportCsv({ name, columns, rows });
    dispatch(notify(t('mis.csvReady')));
  };
  const rows = data?.rows || [];
  const totals = data?.totals;
  const money = (v: unknown) => fmtMoneyShort(Number(v));

  return (
    <>
      <PageHeader icon={AssessmentRoundedIcon} iconColor="#0B5D8A" title={t('mis.misTitle')} sub={t('mis.misSub')}
        actions={<Button variant="outlined" startIcon={<PrintRoundedIcon />} onClick={() => window.print()}>{t('mis.printPdf')}</Button>} />
      <Card sx={{ p: 1.5, mb: 2, display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', displayPrint: 'none' }} component="form" onSubmit={(e) => { e.preventDefault(); load(months); }} aria-label={t('mis.period')}>
        {MIS_PRESETS.map((m) => <Chip key={m} label={t('mis.monthsPreset', { count: m })} variant={months === m ? 'filled' : 'outlined'} color={months === m ? 'primary' : 'default'} onClick={() => { setMonths(m); load(m); }} sx={{ fontWeight: 600 }} />)}
        <Divider orientation="vertical" flexItem />
        <TextField size="small" type="number" label={t('mis.months')} value={months} onChange={(e) => setMonths(Math.min(36, Math.max(3, Number(e.target.value) || 3)))} inputProps={{ min: 3, max: 36 }} sx={{ width: 120 }} />
        <Button type="submit" variant="contained">{t('mis.runReport')}</Button>
        {data && <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>{t('mis.periodLine', { from: rows[0]?.month || '—', to: rows[rows.length - 1]?.month || '—', at: fmtDT(data.generatedAt) })}</Typography>}
      </Card>

      {!data || !totals ? (
        <Grid container spacing={2} aria-busy="true">{Array.from({ length: 8 }).map((_, i) => <Grid item xs={6} md={3} key={i}><Skeleton variant="rounded" height={86} /></Grid>)}</Grid>
      ) : (
        <>
          <Grid container spacing={1.5} sx={{ mb: 2 }}>
            <Grid item xs={6} md={3}><Kpi label={t('mis.kpiCargo')} value={fmtMT(totals.cargoMT)} sub={`${fmtNum(totals.teu)} TEU`} /></Grid>
            <Grid item xs={6} md={3}><Kpi label={t('mis.kpiCalls')} value={fmtNum(totals.calls)} sub={t('mis.kpiCallsSub', { hours: avgOf(rows, 'avgTurnaroundH') })} /></Grid>
            <Grid item xs={6} md={3}><Kpi label={t('mis.kpiRevenue')} value={fmtMoneyShort(totals.revenue)} sub={t('mis.kpiRevenueSub', { collected: fmtMoneyShort(totals.collected) })} /></Grid>
            <Grid item xs={6} md={3}><Kpi label={t('mis.kpiInspections')} value={fmtNum(totals.inspections)} sub={t('mis.kpiInspectionsSub', { count: totals.detentions })} /></Grid>
          </Grid>

          <Tabs value={tab} onChange={(_, v: number) => setTab(v)} sx={{ mb: 2, displayPrint: 'none' }} aria-label={t('mis.misTitle')}>
            <Tab label={t('mis.tabCargo')} /><Tab label={t('mis.tabRevenue')} /><Tab label={t('mis.tabCompliance')} />
          </Tabs>

          {tab === 0 && (
            <Grid container spacing={2}>
              <Grid item xs={12} lg={8}>
                <Section title={t('mis.cargoByMonth')} sub={t('mis.cargoByMonthSub')} csvLabel="CSV"
                  onCsv={() => csv('mis-cargo-by-month', rows, [{ key: 'month', label: t('mis.month') }, { key: 'container', label: 'Container MT' }, { key: 'dryBulk', label: 'Dry bulk MT' }, { key: 'liquid', label: 'Liquid MT' }, { key: 'other', label: 'Other MT' }, { key: 'cargoMT', label: 'Total MT' }, { key: 'teu', label: 'TEU' }, { key: 'calls', label: t('mis.calls') }])}>
                  <Box sx={{ height: 300 }}>
                    <ResponsiveContainer>
                      <BarChart data={rows} barCategoryGap="28%">
                        <CartesianGrid stroke={grid} vertical={false} />
                        <XAxis dataKey="month" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                        <YAxis tickFormatter={(v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`)} tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown, n: unknown) => [fmtMT(Number(v)), SERIES_LABELS[n as keyof typeof SERIES_LABELS] || String(n)]} cursor={{ fill: cursorFill }} />
                        <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{SERIES_LABELS[v as keyof typeof SERIES_LABELS] || v}</span>} iconSize={10} />
                        {SERIES_ORDER.map((key) => <Bar key={key} dataKey={key} stackId="mt" fill={C[key]} stroke={paper} strokeWidth={2} radius={key === 'other' ? [4, 4, 0, 0] : 0} />)}
                      </BarChart>
                    </ResponsiveContainer>
                  </Box>
                </Section>
              </Grid>
              <Grid item xs={12} lg={4}>
                <Section title={t('mis.callsByMonth')} sub={t('mis.callsByMonthSub', { hours: avgOf(rows, 'avgWaitH') })}>
                  <Box sx={{ height: 300 }}>
                    <ResponsiveContainer>
                      <BarChart data={rows} margin={{ top: 18 }} barCategoryGap="30%">
                        <CartesianGrid stroke={grid} vertical={false} />
                        <XAxis dataKey="month" tick={{ fill: axis, fontSize: 10.5 }} axisLine={{ stroke: grid }} tickLine={false} />
                        <YAxis tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={34} allowDecimals={false} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown) => [String(v), t('mis.calls')]} cursor={{ fill: cursorFill }} />
                        <Bar dataKey="calls" fill={C.liquid} radius={[4, 4, 0, 0]} name={t('mis.calls')} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Box>
                </Section>
              </Grid>
              <Grid item xs={12}>
                <Section title={t('mis.trafficTable')} sub={t('mis.trafficTableSub')} csvLabel="CSV"
                  onCsv={() => csv('mis-traffic', rows, [{ key: 'month', label: t('mis.month') }, { key: 'calls', label: t('mis.calls') }, { key: 'cargoMT', label: 'Cargo MT' }, { key: 'teu', label: 'TEU' }, { key: 'avgTurnaroundH', label: 'Avg turnaround h' }, { key: 'avgWaitH', label: 'Avg wait h' }])}>
                  <TableContainer sx={{ overflowX: 'auto' }}>
                    <Table size="small" aria-label={t('mis.trafficTable')}>
                      <TableHead><TableRow><TableCell>{t('mis.month')}</TableCell><TableCell align="right">{t('mis.calls')}</TableCell><TableCell align="right">{t('mis.cargoMT')}</TableCell><TableCell align="right">TEU</TableCell><TableCell align="right">{t('mis.avgTurnaround')}</TableCell><TableCell align="right">{t('mis.avgWait')}</TableCell></TableRow></TableHead>
                      <TableBody>
                        {rows.map((r) => (
                          <TableRow key={r.key} hover><TableCell><b>{r.month}</b></TableCell><TableCell align="right" sx={num}>{fmtNum(r.calls)}</TableCell><TableCell align="right" sx={num}>{fmtNum(r.cargoMT)}</TableCell><TableCell align="right" sx={num}>{fmtNum(r.teu)}</TableCell><TableCell align="right" sx={num}>{r.avgTurnaroundH}</TableCell><TableCell align="right" sx={num}>{r.avgWaitH}</TableCell></TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Section>
              </Grid>
            </Grid>
          )}

          {tab === 1 && (
            <Grid container spacing={2}>
              <Grid item xs={12} lg={8}>
                <Section title={t('mis.billedVsCollected')} sub={t('mis.billedVsCollectedSub', { currency: data.currency || profile.currency.code })} csvLabel="CSV"
                  onCsv={() => csv('mis-revenue-by-month', rows, [{ key: 'month', label: t('mis.month') }, { key: 'revenue', label: t('mis.billed') }, { key: 'collected', label: t('mis.collected') }])}>
                  <Box sx={{ height: 300 }}>
                    <ResponsiveContainer>
                      <LineChart data={rows}>
                        <CartesianGrid stroke={grid} vertical={false} />
                        <XAxis dataKey="month" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                        <YAxis tickFormatter={(v: number) => fmtMoneyShort(v)} tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={72} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown, n: unknown) => [money(v), n === 'revenue' ? t('mis.billed') : t('mis.collected')]} />
                        <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{v === 'revenue' ? t('mis.billed') : t('mis.collected')}</span>} iconSize={10} />
                        <Line type="monotone" dataKey="revenue" stroke={C.liquid} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                        <Line type="monotone" dataKey="collected" stroke={C.container} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </Box>
                </Section>
              </Grid>
              <Grid item xs={12} lg={4}>
                <Section title={t('mis.revenueByMonth')} sub={t('mis.revenueByMonthSub')}>
                  <TableContainer sx={{ maxHeight: 300, overflowY: 'auto' }}>
                    <Table size="small" stickyHeader aria-label={t('mis.revenueByMonth')}>
                      <TableHead><TableRow><TableCell>{t('mis.month')}</TableCell><TableCell align="right">{t('mis.billed')}</TableCell><TableCell align="right">{t('mis.collected')}</TableCell></TableRow></TableHead>
                      <TableBody>{rows.map((r) => <TableRow key={r.key} hover><TableCell><b>{r.month}</b></TableCell><TableCell align="right" sx={num}>{fmtMoney(r.revenue)}</TableCell><TableCell align="right" sx={num}>{fmtMoney(r.collected)}</TableCell></TableRow>)}</TableBody>
                    </Table>
                  </TableContainer>
                  <Divider sx={{ my: 1 }} />
                  <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">{t('mis.outstanding')}</Typography><Typography variant="body2" sx={{ fontWeight: 700 }}>{fmtMoneyShort(outstandingOf(totals))}</Typography></Stack>
                  <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">{t('mis.collectionRate')}</Typography><Typography variant="body2" sx={{ fontWeight: 700 }}>{collectionPct(totals)}%</Typography></Stack>
                </Section>
              </Grid>
            </Grid>
          )}

          {tab === 2 && (
            <Grid container spacing={2}>
              <Grid item xs={12} md={7}>
                <Section title={t('mis.inspectionsByMonth')} sub={t('mis.inspectionsByMonthSub', { inspections: totals.inspections, detentions: totals.detentions })} csvLabel="CSV"
                  onCsv={() => csv('mis-compliance', rows, [{ key: 'month', label: t('mis.month') }, { key: 'inspections', label: t('mis.inspections') }, { key: 'detentions', label: t('mis.detentions') }, { key: 'findings', label: t('mis.findings') }, { key: 'incidents', label: t('mis.incidents') }, { key: 'highIncidents', label: t('mis.highIncidents') }])}>
                  <Box sx={{ height: 260 }}>
                    <ResponsiveContainer>
                      <BarChart data={rows} barCategoryGap="26%">
                        <CartesianGrid stroke={grid} vertical={false} />
                        <XAxis dataKey="month" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                        <YAxis tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={34} allowDecimals={false} />
                        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                        <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{v}</span>} iconSize={10} />
                        <Bar dataKey="inspections" name={t('mis.inspections')} fill={C.container} radius={[3, 3, 0, 0]} />
                        <Bar dataKey="detentions" name={t('mis.detentions')} fill={C.other} radius={[3, 3, 0, 0]} />
                        <Bar dataKey="findings" name={t('mis.findings')} fill={C.dryBulk} radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Box>
                </Section>
              </Grid>
              <Grid item xs={12} md={5}>
                <Section title={t('mis.incidentsByMonth')} sub={t('mis.incidentsByMonthSub', { count: totals.incidents })}>
                  <Box sx={{ height: 260 }}>
                    <ResponsiveContainer>
                      <BarChart data={rows} barCategoryGap="30%">
                        <CartesianGrid stroke={grid} vertical={false} />
                        <XAxis dataKey="month" tick={{ fill: axis, fontSize: 10.5 }} axisLine={{ stroke: grid }} tickLine={false} />
                        <YAxis tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
                        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                        <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{v}</span>} iconSize={10} />
                        <Bar dataKey="incidents" name={t('mis.incidents')} stackId="i" fill={C.liquid} />
                        <Bar dataKey="highIncidents" name={t('mis.highIncidents')} stackId="i" fill={C.other} radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Box>
                </Section>
              </Grid>
              <Grid item xs={12}>
                <Section title={t('mis.benchmarks')} sub={t('mis.benchmarksSub')}>
                  <TableContainer sx={{ overflowX: 'auto' }}>
                    <Table size="small" aria-label={t('mis.benchmarks')}>
                      <TableHead><TableRow><TableCell>{t('mis.benchmark')}</TableCell><TableCell align="right">{t('mis.target')}</TableCell><TableCell>{t('mis.basis')}</TableCell><TableCell>{t('mis.source')}</TableCell></TableRow></TableHead>
                      <TableBody>
                        {data.benchmarks.map((b) => (
                          <TableRow key={b.key} hover>
                            <TableCell><b>{benchmarkLabel(b.key)}</b></TableCell>
                            <TableCell align="right" sx={{ ...num, fontFamily: MONO }}>{benchmarkValue(b.value)}</TableCell>
                            <TableCell><MuiTooltip title={b.source}><Chip size="small" color={b.confirmed ? 'success' : 'warning'} variant="outlined" label={b.confirmed ? t('mis.confirmed') : t('mis.unverified')} sx={{ height: 20, fontSize: 10.5 }} /></MuiTooltip></TableCell>
                            <TableCell><Typography variant="caption" color="text.secondary">{b.source}</Typography></TableCell>
                          </TableRow>
                        ))}
                        {data.benchmarks.length === 0 && <TableRow><TableCell colSpan={4}><Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('mis.noBenchmarks')}</Typography></TableCell></TableRow>}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Section>
              </Grid>
            </Grid>
          )}
        </>
      )}
    </>
  );
}
