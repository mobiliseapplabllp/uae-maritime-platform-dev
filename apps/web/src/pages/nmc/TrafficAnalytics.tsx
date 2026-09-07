import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Grid, MenuItem, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded';
import DirectionsBoatFilledRoundedIcon from '@mui/icons-material/DirectionsBoatFilledRounded';
import GpsFixedRoundedIcon from '@mui/icons-material/GpsFixedRounded';
import PlaceRoundedIcon from '@mui/icons-material/PlaceRounded';
import AltRouteRoundedIcon from '@mui/icons-material/AltRouteRounded';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { useProfile } from '../../config/runtime';
import { CHART_SERIES, chartChrome } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import StatCard from '../../components/common/StatCard';
import { BucketBars, ChartCard, DashboardSkeleton, OpenLink, PanelCard, RankList } from '../../components/dashboard/kit';
import { fmtDec, fmtNum } from '../../utils/format';
import DensityMap from './analytics/DensityMap';
import type { AnalyticsData } from './analytics/types';
import type { Layers } from './types';

/* Traffic analytics over a period: density on the map, the lanes where courses agree, dwell by published sea area,
 * and the days one by one. Every figure is computed by the maritime-centre service from the fixes it holds; the
 * window and the cell size start from Harbour Operations' settings and are the reader's to change here. */
const WINDOWS = [7, 14, 30];
const CELLS = [1, 2, 5];

export default function TrafficAnalytics() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const profile = useProfile();
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode]; const { axis, grid, tooltipStyle, cursorFill } = chartChrome(mode);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [layers, setLayers] = useState<Layers | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [cellNm, setCellNm] = useState<number | null>(null);
  const load = useCallback((d: number | null, c: number | null) => {
    const params: Record<string, number> = {};
    if (d) params.days = d; if (c) params.cellNm = c;
    api.get<AnalyticsData>('/tracking/analytics', { params }).then((r) => { setData(r.data); if (!d) setDays(r.data.window.days); if (!c) setCellNm(r.data.cellNm); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  }, [dispatch]);
  useEffect(() => { load(null, null); api.get<Layers>('/tracking/layers', { headers: { 'X-Quiet': '1' } }).then((r) => setLayers(r.data)).catch(() => setLayers(null)); }, [load]);
  const home = layers?.home ?? profile.portGeo ?? { lat: 24.81, lon: 54.64 };

  const header = (
    <PageHeader icon={QueryStatsRoundedIcon} iconColor="#0B4F8A" title={t('traffic.analytics.title', 'Traffic analytics')} sub={t('traffic.analytics.sub', 'Where the traffic was, which way it ran and how long ships spent in each published area — read from the fixes of the period')}
      actions={<Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <ToggleButtonGroup size="small" exclusive value={days} onChange={(_, v: number | null) => { if (v) { setDays(v); load(v, cellNm); } }} aria-label={t('traffic.analytics.window', 'Window')} data-testid="analytics-window">
          {WINDOWS.map((w) => <ToggleButton key={w} value={w} aria-label={`${w} ${t('traffic.analytics.days', 'd')}`}>{w} {t('traffic.analytics.days', 'd')}</ToggleButton>)}
        </ToggleButtonGroup>
        <TextField select size="small" label={t('traffic.analytics.cell', 'Cell')} value={cellNm ?? ''} onChange={(e) => { const v = Number(e.target.value); setCellNm(v); load(days, v); }} sx={{ minWidth: 110 }} inputProps={{ 'data-testid': 'analytics-cell' }}>
          {[...new Set([...CELLS, ...(cellNm ? [cellNm] : [])])].sort((a, b) => a - b).map((c) => <MenuItem key={c} value={c}>{c} nm</MenuItem>)}
        </TextField>
        <OpenLink label={t('traffic.analytics.openMap', 'Live traffic')} to="/nmc/map" />
      </Stack>} />
  );
  if (!data) return <>{header}<DashboardSkeleton tiles={4} /></>;
  const k = data.kpis;
  const dayRows = data.byDay.map((d) => ({ ...d, label: d.day.slice(5) }));
  return (
    <>
      {header}
      <Grid container spacing={2} data-testid="traffic-analytics">
        <Grid item xs={6} md={3}><StatCard icon={<DirectionsBoatFilledRoundedIcon />} label={t('traffic.analytics.ships', 'Ships heard')} value={fmtNum(k.ships)} sub={`${k.registered} ${t('traffic.analytics.registered', 'on the register')}`} testId="analytics-ships" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<GpsFixedRoundedIcon />} label={t('traffic.analytics.fixes', 'Fixes')} value={fmtNum(k.fixes)} sub={`${k.movingPct}% ${t('traffic.analytics.moving', 'under way')} · ${t('traffic.analytics.meanSpeed', { defaultValue: 'mean {{kn}} kn under way', kn: fmtDec(k.meanSogKn, 1) })}`} testId="analytics-fixes" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<PlaceRoundedIcon />} label={t('traffic.analytics.busiestArea', 'Busiest area')} value={k.busiestArea ? `${fmtDec(k.busiestArea.hours, 1)} h` : '—'} sub={k.busiestArea ? k.busiestArea.name : t('traffic.analytics.noArea', 'No area visited')} testId="analytics-area" /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<AltRouteRoundedIcon />} label={t('traffic.analytics.lanes', 'Lanes found')} value={fmtNum(k.lanes)} sub={`${fmtNum(k.cellsUsed)} ${t('traffic.analytics.cellsUsed', 'cells used')} · ${data.cellNm} nm`} testId="analytics-lanes" /></Grid>

        <Grid item xs={12} md={8}>
          <PanelCard title={t('traffic.analytics.map', 'Density and lanes')} sub={t('traffic.analytics.mapSub', 'Cells shaded by the ships heard in them; an arrow where their courses agree')} testId="analytics-map-card" explain={{ data: { cellNm: data.cellNm, window: data.window, cells: data.cells.slice(0, 40), lanes: data.lanes.slice(0, 20) }, period: `${data.window.days} days` }}>
            {data.cells.length ? <DensityMap data={data} areas={layers?.areas ?? []} home={home} /> : <Typography color="text.secondary" sx={{ p: 2 }}>{t('traffic.analytics.none', 'No fixes in this period')}</Typography>}
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard title={t('traffic.analytics.cells', 'Busiest cells')} sub={t('traffic.analytics.cellsSub', 'Cells by distinct ships heard')} testId="analytics-cells" explain={{ data: data.cells.slice(0, 12), period: `${data.window.days} days` }}>
            <RankList rows={data.cells.slice(0, 8).map((c) => ({
              key: `${c.lat}:${c.lon}`, primary: `${Math.abs(c.lat).toFixed(2)}° ${c.lat >= 0 ? 'N' : 'S'}, ${Math.abs(c.lon).toFixed(2)}° ${c.lon >= 0 ? 'E' : 'W'}`,
              secondary: t('traffic.analytics.cellLine', { defaultValue: '{{fixes}} fixes · courses agree {{flow}}%', fixes: fmtNum(c.fixes), flow: Math.round(c.flow * 100) }),
              value: t('traffic.analytics.cellValue', { defaultValue: '{{ships}} ships', ships: c.ships }),
            }))} empty={t('traffic.analytics.none', 'No fixes in this period')} />
          </PanelCard>
        </Grid>

        <Grid item xs={12} md={7}>
          <ChartCard title={t('traffic.analytics.byDay', 'Ships and fixes per day')} sub={t('traffic.analytics.byDaySub', 'Distinct ships heard each day, and the fixes behind them')} testId="analytics-by-day" explain={{ data: data.byDay, period: `${data.window.days} days` }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={dayRows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis yAxisId="ships" tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
                <YAxis yAxisId="fixes" orientation="right" tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={44} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                <Legend />
                <Bar yAxisId="ships" dataKey="ships" name={t('traffic.analytics.ships', 'Ships heard')} fill={C.container} radius={[3, 3, 0, 0]} />
                <Bar yAxisId="ships" dataKey="registered" name={t('traffic.analytics.registered', 'on the register')} fill={C.liquid} radius={[3, 3, 0, 0]} />
                <Line yAxisId="fixes" type="monotone" dataKey="fixes" name={t('traffic.analytics.fixes', 'Fixes')} stroke={C.other} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>
        <Grid item xs={12} md={5}>
          <PanelCard title={t('traffic.analytics.dwell', 'Dwell by sea area')} sub={t('traffic.analytics.dwellSub', 'Hours ships spent inside each published area, visit by visit')} testId="analytics-dwell" explain={{ data: data.areas, unit: 'hours', period: `${data.window.days} days` }}>
            {data.areas.some((a) => a.visits > 0) ? (
              <BucketBars rows={data.areas.filter((a) => a.visits > 0).slice(0, 8).map((a) => ({
                label: a.name, value: a.hours, display: `${fmtDec(a.hours, 1)} h`,
                sub: t('traffic.analytics.areaLine', { defaultValue: '{{ships}} ships · {{visits}} visits · avg {{avg}} h', ships: a.ships, visits: a.visits, avg: fmtDec(a.avgVisitHours, 1) }),
              }))} />
            ) : <Box sx={{ p: 1 }}><Typography color="text.secondary">{t('traffic.analytics.noArea', 'No area visited')}</Typography></Box>}
          </PanelCard>
        </Grid>
      </Grid>
    </>
  );
}
