import { useEffect, useState } from 'react';
import { Box, Typography, Stack, Chip, Card, Skeleton, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Divider } from '@mui/material';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { CHART_SERIES, chartChrome, MONO } from '../../theme';
import FormDrawer from '../../components/common/FormDrawer';
import StatusChip from '../../components/common/StatusChip';
import { BERTH_STATUS_META, type ChipColor } from '../../utils/status';
import { fmtD, fmtNum } from '../../utils/format';

/* One berth's outage record — planned works, breakdowns, dredging and weather stand-downs — and the availability those windows leave. */
export const OUTAGE_KIND_META: Record<string, { label: string; color: ChipColor }> = { PLANNED: { label: 'Planned', color: 'info' }, BREAKDOWN: { label: 'Breakdown', color: 'error' }, DREDGING: { label: 'Dredging', color: 'warning' }, WEATHER: { label: 'Weather', color: 'default' } };
export interface BerthLite { id: string; code: string; name: string; terminal: string }
interface Outage { id: string; from: string; to: string; days: number; kind: string; reason: string; by?: string }
interface OutageData { berth: { status: string; berthType: string; loaMax: number; draftMax: number }; summary: { availabilityPct: number; days: number; outages: number; window: { months: number }; lifetime: { firstFrom: string; lastTo: string; outages: number; days: number }; longest: { days: number; reason: string } | null; series: { label: string; days: number }[]; byKind: { kind: string; outages: number; days: number }[] }; outages: Outage[] }
const Kpi = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
  <Card variant="outlined" sx={{ px: 1.5, py: 1.25, flex: 1, minWidth: 130 }}>
    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    <Typography sx={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
    {sub && <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>{sub}</Typography>}
  </Card>
);
export default function BerthOutageDrawer({ berth, onClose }: { berth: BerthLite | null; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode];
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [data, setData] = useState<OutageData | null>(null);
  useEffect(() => { setData(null); }, [berth?.id]);
  useEffect(() => { if (!berth) return; api.get<OutageData>(`/berths/${berth.id}/outages`).then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [berth, dispatch]);
  const s = data?.summary;
  return (
    <FormDrawer open={!!berth} width="64vw" onClose={onClose} title={berth ? `${berth.code} — ${berth.name}` : ''} subtitle={berth ? `${berth.terminal} · outage history and availability (sample data)` : ''}>
      {!data || !s ? <Skeleton variant="rounded" height={380} /> : (
        <>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5, flexWrap: 'wrap' }} useFlexGap>
            <StatusChip value={data.berth.status} map={BERTH_STATUS_META} /><Chip size="small" variant="outlined" label={data.berth.berthType} sx={{ height: 22, fontSize: 11 }} />
            <Chip size="small" variant="outlined" label={`LOA ≤ ${data.berth.loaMax} m · draft ≤ ${data.berth.draftMax} m`} sx={{ height: 22, fontSize: 11 }} />
            <Typography variant="caption" color="text.secondary">Record from {fmtD(s.lifetime.firstFrom)} to {fmtD(s.lifetime.lastTo)}</Typography>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }} useFlexGap>
            <Kpi label="Availability · 12 m" value={`${s.availabilityPct}%`} sub={`${fmtNum(s.days)} days out of ${s.window.months} months`} />
            <Kpi label="Outages · 12 m" value={fmtNum(s.outages)} sub="windows taken over the berth" />
            <Kpi label="Since 2023" value={fmtNum(s.lifetime.outages)} sub={`${fmtNum(s.lifetime.days)} days lost in total`} />
            <Kpi label="Longest window" value={s.longest ? `${s.longest.days} d` : '—'} sub={s.longest ? s.longest.reason : ''} />
          </Stack>
          <Typography variant="h6" sx={{ fontSize: 14, mt: 2.5 }}>Days out of service by month</Typography>
          <Typography variant="caption" color="text.secondary">Last 12 months — windows split across month boundaries</Typography>
          <Box sx={{ mt: 1.5 }}>
            <Box dir="ltr">{/* Charts are laid out left to right in both languages: Recharts does not mirror its axis gutters under RTL, so category labels would be painted behind the bars. */}
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={s.series} margin={{ top: 6, right: 8, left: -22, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 10.5, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} /><YAxis tick={{ fontSize: 10.5, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} formatter={(v: number) => `${v} days`} /><Bar dataKey="days" name="Days out" fill={C.other} radius={[3, 3, 0, 0]} barSize={18} />
              </BarChart>
            </ResponsiveContainer>
            </Box>
          </Box>
          <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
            {s.byKind.map((k) => <Chip key={k.kind} size="small" variant="outlined" color={OUTAGE_KIND_META[k.kind]?.color || 'default'} label={`${OUTAGE_KIND_META[k.kind]?.label || k.kind} · ${k.outages} × ${fmtNum(k.days)} d`} sx={{ height: 22, fontSize: 11, fontWeight: 600 }} />)}
          </Stack>
          <Typography variant="h6" sx={{ fontSize: 14, mt: 2.5, mb: 1 }}>Outage windows</Typography>
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>From</TableCell><TableCell>To</TableCell><TableCell align="right">Days</TableCell><TableCell>Type</TableCell><TableCell>Reason</TableCell><TableCell>Carried out by</TableCell></TableRow></TableHead>
              <TableBody>
                {data.outages.map((o) => (
                  <TableRow key={o.id} hover>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtD(o.from)}</TableCell><TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtD(o.to)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{o.days}</TableCell>
                    <TableCell><Chip size="small" color={OUTAGE_KIND_META[o.kind]?.color || 'default'} label={OUTAGE_KIND_META[o.kind]?.label || o.kind} sx={{ height: 20, fontSize: 10.5 }} /></TableCell>
                    <TableCell sx={{ fontSize: 12.5 }}>{o.reason}</TableCell><TableCell sx={{ fontSize: 12 }}>{o.by || '—'}</TableCell>
                  </TableRow>
                ))}
                {data.outages.length === 0 && <TableRow><TableCell colSpan={6}><Typography sx={{ py: 3, textAlign: 'center' }} color="text.secondary">No outage recorded against this berth.</Typography></TableCell></TableRow>}
              </TableBody>
            </Table>
          </TableContainer>
          <Divider sx={{ mt: 2 }} />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Fictional demo data — maintenance windows are generated for the sample estate.</Typography>
        </>
      )}
    </FormDrawer>
  );
}
