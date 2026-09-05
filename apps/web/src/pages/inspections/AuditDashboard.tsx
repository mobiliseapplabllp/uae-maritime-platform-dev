import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Skeleton, Button, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Chip, LinearProgress, Stack, Tooltip } from '@mui/material';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import InsightsRoundedIcon from '@mui/icons-material/InsightsRounded';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend, LineChart, Line } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { useLookups } from '../../hooks/useLookups';
import { chartChrome, MONO } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import { fmtD } from '../../utils/format';
import { KPI_STATUS_COLOR, REGIME_LOOKUP } from './constants';
import type { InspectionDashboardData, InspectionKpis, KpiResult } from './types';

/* Survey & audit dashboard — outcome mix, deficiency intensity and checklist compliance across every regime, and the
 * Smart Inspection programme: the six eighteen-month KPIs, each measured from the desk's own dated events. */
const RESULT_COLORS = {
  light: { SATISFACTORY: '#056A73', DEFICIENCIES: '#B98A2F', DETAINED: '#C14F33' },
  dark: { SATISFACTORY: '#2FA6AE', DEFICIENCIES: '#B8892B', DETAINED: '#D0644A' },
} as const;
const TREND_KEYS = [['dossierCoverage', '#056A73'], ['aiReports', '#0B74B0'], ['noticeSpeed', '#B98A2F'], ['predictionCorrelation', '#6A4C93'], ['restrictionRouting', '#C14F33']] as const;

const Kpi = ({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) => (
  <Card sx={{ px: 2, py: 1.5, borderLeft: 3, borderLeftColor: tone ? `${tone}.main` : 'divider' }}>
    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
    {sub && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{sub}</Typography>}
  </Card>
);

/** One programme KPI: the measured figure against its target, its standing on the day, and what it was measured from. */
function KpiTile({ k, t }: { k: KpiResult; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const color = KPI_STATUS_COLOR[k.status];
  const value = k.value === null ? t('inspections.kpi.notCaptured') : `${k.value}${k.unit}`;
  return (
    <Card sx={{ p: 2, height: '100%', borderTop: 3, borderTopColor: color === 'default' ? 'divider' : `${color}.main` }} data-testid={`kpi-${k.key}`}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
        <Typography sx={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.3 }}>{t(`inspections.kpi.${k.key}`, { defaultValue: k.label })}</Typography>
        <Chip size="small" color={color === 'default' ? undefined : color} variant={color === 'default' ? 'outlined' : 'filled'} label={t(`inspections.kpi.status.${k.status}`)} sx={{ height: 20, fontSize: 10.5, fontWeight: 700 }} />
      </Stack>
      <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 28, fontVariantNumeric: 'tabular-nums', mt: 0.5 }}>{value}</Typography>
      <Typography variant="caption" color="text.secondary">{t('inspections.kpi.target', { target: k.target, unit: k.unit })}{k.status !== 'NOT_CAPTURED' ? ` · ${t('inspections.kpi.required', { required: k.required, unit: k.unit })}` : ''}</Typography>
      {k.value !== null && <LinearProgress variant="determinate" value={Math.max(0, Math.min(100, (k.value / k.target) * 100))} color={color === 'default' ? 'inherit' : color} sx={{ mt: 1, height: 6, borderRadius: 3 }} aria-label={t(`inspections.kpi.${k.key}`, { defaultValue: k.label })} />}
      <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>{k.detail}</Typography>
    </Card>
  );
}

export default function AuditDashboard() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const mode = useAppSelector((s) => s.ui.mode);
  const regimes = useLookups(REGIME_LOOKUP);
  const RC = RESULT_COLORS[mode];
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [data, setData] = useState<InspectionDashboardData | null>(null);
  const [kpis, setKpis] = useState<InspectionKpis | null | undefined>(undefined);

  useEffect(() => {
    api.get<InspectionDashboardData>('/inspections/dashboard').then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
    api.get<InspectionKpis>('/inspections/kpis', { headers: { 'X-Quiet': '1' } }).then((r) => setKpis(r.data)).catch(() => setKpis(null));
  }, [dispatch]);

  if (!data) {
    return (
      <Grid container spacing={2} aria-busy="true">
        {Array.from({ length: 8 }).map((_, i) => <Grid item xs={6} md={3} key={i}><Skeleton variant="rounded" height={86} /></Grid>)}
        <Grid item xs={12}><Skeleton variant="rounded" height={300} /></Grid>
      </Grid>
    );
  }
  const k = data.kpis;
  const trend = (kpis?.trend ?? []).map((p) => ({ ...p, reportTurnaroundHours: p.reportTurnaroundMinutes === null ? null : Math.round(p.reportTurnaroundMinutes / 6) / 10 }));

  return (
    <>
      <PageHeader icon={FactCheckRoundedIcon} iconColor="#9C6412" title={t('inspections.dashboardTitle')} sub={t('inspections.dashboardSub')}
        actions={<Button variant="contained" endIcon={<ArrowForwardRoundedIcon />} onClick={() => navigate('/inspections')}>{t('inspections.openRegister')}</Button>} />
      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}><Kpi label={t('inspections.kpiOpen')} value={k.open} sub={t('inspections.kpiOpenSub', { n: k.closedYtd })} tone={k.open ? 'warning' : 'success'} /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('inspections.kpiSat')} value={`${k.satisfactionPct}%`} sub={t('inspections.kpiSatSub', { n: k.detentionRatePct })} tone={k.satisfactionPct >= 60 ? 'success' : 'warning'} /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('inspections.kpiFindings')} value={k.avgFindings} sub={t('inspections.kpiFindingsSub', { n: k.openFindings })} tone={k.openFindings ? 'warning' : 'success'} /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('inspections.kpiCompliance')} value={`${k.checklistCompliancePct}%`} sub={t('inspections.kpiComplianceSub')} tone="info" /></Grid>
      </Grid>

      <Card sx={{ p: 2, mb: 2 }} component="section" aria-labelledby="smart-kpis">
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
          <InsightsRoundedIcon color="primary" />
          <Box sx={{ flex: 1, minWidth: 240 }}>
            <Typography variant="h6" component="h2" id="smart-kpis" sx={{ fontSize: 15 }}>{t('inspections.kpi.title')}</Typography>
            <Typography variant="caption" color="text.secondary">{t('inspections.kpi.sub')}</Typography>
          </Box>
          {kpis && (
            <Tooltip title={t('inspections.kpi.programmeHelp', { start: fmtD(kpis.programme.start), end: fmtD(kpis.programme.end) })}>
              <Box sx={{ minWidth: 220 }}>
                <Typography variant="caption" sx={{ fontWeight: 700 }}>{t('inspections.kpi.programme', { elapsed: Math.ceil(kpis.programme.monthsElapsed), total: kpis.programme.monthsTotal })}</Typography>
                <LinearProgress variant="determinate" value={kpis.programme.pct} sx={{ height: 8, borderRadius: 4, mt: 0.5 }} aria-label={t('inspections.kpi.programme', { elapsed: Math.ceil(kpis.programme.monthsElapsed), total: kpis.programme.monthsTotal })} />
              </Box>
            </Tooltip>
          )}
        </Stack>
        {kpis === undefined && <Skeleton variant="rounded" height={160} />}
        {kpis === null && <Typography variant="body2" color="text.secondary">{t('inspections.kpi.unavailable')}</Typography>}
        {kpis && (
          <>
            <Grid container spacing={1.5}>
              {kpis.kpis.map((x) => <Grid item xs={12} sm={6} lg={4} key={x.key}><KpiTile k={x} t={t as never} /></Grid>)}
            </Grid>
            {trend.length > 0 && (
              <Box sx={{ mt: 2 }}>
                <Typography variant="subtitle2">{t('inspections.kpi.trend')}</Typography>
                <Typography variant="caption" color="text.secondary">{t('inspections.kpi.trendSub')}</Typography>
                <Box dir="ltr">{/* Recharts does not mirror its axis gutters under RTL; the plot is laid out left to right in both languages. */}
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={trend} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid stroke={grid} vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 11, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} unit="%" />
                      <RTooltip contentStyle={tooltipStyle} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {TREND_KEYS.map(([key, color]) => <Line key={key} type="monotone" dataKey={key} name={t(`inspections.kpi.${key}`)} stroke={color} dot={false} strokeWidth={2} connectNulls />)}
                    </LineChart>
                  </ResponsiveContainer>
                </Box>
              </Box>
            )}
          </>
        )}
      </Card>

      <Grid container spacing={2}>
        <Grid item xs={12} lg={7.5}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('inspections.byMonth')}</Typography>
            <Typography variant="caption" color="text.secondary">{t('inspections.byMonthSub')}</Typography>
            <Box dir="ltr">
              <ResponsiveContainer width="100%" height={270}>
                <BarChart data={data.byMonth} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke={grid} vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <RTooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="SATISFACTORY" stackId="r" fill={RC.SATISFACTORY} name={t('inspections.resultSatisfactory')} />
                  <Bar dataKey="DEFICIENCIES" stackId="r" fill={RC.DEFICIENCIES} name={t('inspections.resultDeficiencies')} />
                  <Bar dataKey="DETAINED" stackId="r" fill={RC.DETAINED} name={t('inspections.resultDetained')} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Box>
          </Card>
        </Grid>
        <Grid item xs={12} lg={4.5}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('inspections.byType')}</Typography>
            <Typography variant="caption" color="text.secondary">{t('inspections.byTypeSub')}</Typography>
            <TableContainer sx={{ overflowX: 'auto', mt: 1 }}>
              <Table size="small" aria-label={t('inspections.byType')}>
                <TableHead><TableRow><TableCell>{t('inspections.regime')}</TableCell><TableCell align="right">{t('inspections.total')}</TableCell><TableCell align="right">{t('inspections.closed')}</TableCell><TableCell align="right">{t('inspections.detainedCol')}</TableCell></TableRow></TableHead>
                <TableBody>
                  {data.byType.map((x) => (
                    <TableRow key={x.type} hover>
                      <TableCell><b>{regimes.label(x.type)}</b></TableCell>
                      <TableCell align="right">{x.total}</TableCell>
                      <TableCell align="right">{x.closed}</TableCell>
                      <TableCell align="right">{x.detained || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <Box sx={{ mt: 1.5 }}>
              <Button size="small" onClick={() => navigate('/reports/view/deficiency-analysis')}>{t('inspections.deficiencyReport')}</Button>
              <Button size="small" onClick={() => navigate('/reports/view/checklist-compliance')}>{t('inspections.complianceReport')}</Button>
            </Box>
          </Card>
        </Grid>
      </Grid>
    </>
  );
}
