import { useEffect, useState } from 'react';
import { Card, Grid, Box, Typography, Stack, Skeleton, Chip, Collapse, Button, TextField, MenuItem } from '@mui/material';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { CHART_SERIES, chartChrome, MONO } from '../../theme';
import { fmtNum } from '../../utils/format';
import { OUTAGE_KIND_META, type BerthLite } from './BerthOutageDrawer';

/* Estate-wide berth downtime — what the outage windows cost the quay over the trailing window, by month, by cause and by berth. */
interface Downtime { estate: { berths: number; availabilityPct: number; berthDays: number; days: number; outages: number; worst: { code: string; days: number; availabilityPct: number } | null; underMaintenanceNow: number }; series: { label: string; days: number }[]; byKind: { kind: string; days: number; sharePct: number }[]; berths: (BerthLite & { days: number; availabilityPct: number })[] }
const Kpi = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
  <Box sx={{ minWidth: 118 }}>
    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 21, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    <Typography sx={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography>
    {sub && <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>{sub}</Typography>}
  </Box>
);
export default function BerthDowntimePanel({ onOpenBerth }: { onOpenBerth?: (b: BerthLite) => void }) {
  const dispatch = useAppDispatch();
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode];
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [open, setOpen] = useState(true);
  const [months, setMonths] = useState(12);
  const [data, setData] = useState<Downtime | null>(null);
  useEffect(() => { setData(null); api.get<Downtime>('/berths/downtime', { params: { months } }).then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [months, dispatch]);
  if (!data) return <Skeleton variant="rounded" height={150} sx={{ mb: 2 }} />;
  const e = data.estate;
  const worst = data.berths.filter((b) => b.days > 0).slice(0, 6);
  const maxDays = Math.max(1, ...worst.map((b) => b.days));
  return (
    <Card sx={{ p: 2, mb: 2 }}>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ flexWrap: 'wrap' }} useFlexGap>
        <Box sx={{ mr: 'auto' }}><Typography variant="h6" sx={{ fontSize: 15 }}>Estate downtime</Typography><Typography variant="caption" color="text.secondary">Maintenance, breakdown, dredging and weather windows across {e.berths} berths · last {months} months</Typography></Box>
        <Kpi label="Availability" value={`${e.availabilityPct}%`} sub={`of ${fmtNum(e.berthDays)} berth-days`} />
        <Kpi label="Days lost" value={fmtNum(e.days)} sub={`${fmtNum(e.outages)} outage windows`} />
        <Kpi label="Most affected" value={e.worst ? e.worst.code : '—'} sub={e.worst ? `${fmtNum(e.worst.days)} days · ${e.worst.availabilityPct}% available` : ''} />
        <Kpi label="Under maintenance" value={fmtNum(e.underMaintenanceNow)} sub="berths right now" />
        <TextField select size="small" label="Window" value={months} sx={{ width: 142 }} onChange={(ev) => setMonths(Number(ev.target.value))}>{[6, 12, 24, 36].map((m) => <MenuItem key={m} value={m}>{m} months</MenuItem>)}</TextField>
        <Button size="small" onClick={() => setOpen(!open)} endIcon={open ? <ExpandLessRoundedIcon /> : <ExpandMoreRoundedIcon />}>{open ? 'Hide' : 'Show'} detail</Button>
      </Stack>
      <Collapse in={open} unmountOnExit>
        <Grid container spacing={2} sx={{ mt: 0.5 }}>
          <Grid item xs={12} md={7}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>BERTH-DAYS LOST PER MONTH</Typography>
            <ResponsiveContainer width="100%" height={168}>
              <BarChart data={data.series} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 10.5, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} interval="preserveStartEnd" /><YAxis tick={{ fontSize: 10.5, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} formatter={(v: number) => `${v} berth-days`} /><Bar dataKey="days" name="Berth-days lost" fill={C.other} radius={[3, 3, 0, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </Grid>
          <Grid item xs={12} md={5}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>BY CAUSE</Typography>
            <Stack direction="row" spacing={0.75} sx={{ my: 1, flexWrap: 'wrap' }} useFlexGap>{data.byKind.map((k) => <Chip key={k.kind} size="small" variant="outlined" color={OUTAGE_KIND_META[k.kind]?.color || 'default'} label={`${OUTAGE_KIND_META[k.kind]?.label || k.kind} · ${fmtNum(k.days)} d (${k.sharePct}%)`} sx={{ height: 22, fontSize: 11, fontWeight: 600 }} />)}</Stack>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>MOST AFFECTED BERTHS</Typography>
            <Stack spacing={0.75} sx={{ mt: 1 }}>
              {worst.map((b) => (
                <Box key={b.id} onClick={onOpenBerth ? () => onOpenBerth(b) : undefined} sx={{ cursor: onOpenBerth ? 'pointer' : undefined, '&:hover .bar': { opacity: 0.8 } }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="baseline"><Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{b.code} <Typography component="span" variant="caption" color="text.secondary">{b.terminal}</Typography></Typography><Typography sx={{ fontFamily: MONO, fontSize: 12 }}>{fmtNum(b.days)} d · {b.availabilityPct}%</Typography></Stack>
                  <Box sx={{ height: 6, borderRadius: 3, bgcolor: 'action.hover', mt: 0.35, overflow: 'hidden' }}><Box className="bar" sx={{ width: `${(b.days / maxDays) * 100}%`, height: '100%', bgcolor: 'warning.main' }} /></Box>
                </Box>
              ))}
              {worst.length === 0 && <Typography variant="body2" color="text.secondary">No outage fell inside this window.</Typography>}
            </Stack>
          </Grid>
        </Grid>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>Fictional demo data — availability is berth-days not spent in an outage window.</Typography>
      </Collapse>
    </Card>
  );
}
