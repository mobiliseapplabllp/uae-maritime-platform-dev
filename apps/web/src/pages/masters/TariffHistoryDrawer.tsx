import { useEffect, useMemo, useState } from 'react';
import { Box, Typography, Stack, Chip, Card, Skeleton, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, TextField, Divider } from '@mui/material';
import TrendingUpRoundedIcon from '@mui/icons-material/TrendingUpRounded';
import TrendingDownRoundedIcon from '@mui/icons-material/TrendingDownRounded';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { CHART_SERIES, chartChrome, MONO } from '../../theme';
import FormDrawer from '../../components/common/FormDrawer';
import { fmtD, fmtMoney, fmtNum, toInputD } from '../../utils/format';

/* Published rate history for one tariff head — the trend, the revision trail and what the rate read on any given date. */
export interface TariffLite { id: string; code: string; name: string; unit: string; rate: number }
export interface Revision { id: string; effectiveFrom: string; rate: number; previousRate: number; changePct: number; circular?: string; note?: string }
interface History { item: TariffLite; summary: { baseRate: number; totalChangePct: number; lastChangePct: number | null; lastEffectiveFrom: string | null; cagrPct: number; revisions: number; avgChangePct: number }; series: { label: string; rate: number }[]; revisions: Revision[] }
const Kpi = ({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) => (
  <Card variant="outlined" sx={{ px: 1.5, py: 1.25, flex: 1, minWidth: 132 }}>
    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 19, fontVariantNumeric: 'tabular-nums', color: tone }}>{value}</Typography>
    <Typography sx={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
    {sub && <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>{sub}</Typography>}
  </Card>
);
export function rateAsAt(revisions: Revision[], baseRate: number, when: string | Date) {
  const t = new Date(when).getTime();
  let rate = baseRate; let rev: Revision | null = null;
  for (const r of revisions) if (new Date(r.effectiveFrom).getTime() <= t) { rate = r.rate; rev = r; }
  return { rate, revision: rev };
}
export default function TariffHistoryDrawer({ item, onClose }: { item: TariffLite | null; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode];
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [data, setData] = useState<History | null>(null);
  const [asAt, setAsAt] = useState(toInputD(new Date()));
  useEffect(() => { setData(null); setAsAt(toInputD(new Date())); }, [item?.id]);
  useEffect(() => { if (!item) return; api.get<History>(`/tariffs/${item.id}/history`).then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [item, dispatch]);
  const reading = useMemo(() => (data ? rateAsAt(data.revisions, data.summary.baseRate, asAt || new Date()) : null), [data, asAt]);
  const s = data?.summary;
  const up = s ? s.totalChangePct >= 0 : true;
  return (
    <FormDrawer open={!!item} width="62vw" onClose={onClose} title={item ? `${item.code} — ${item.name}` : ''} subtitle={item ? `Published rate history · ${item.unit} · sample tariff schedule` : ''}>
      {!data || !s || !reading ? <Skeleton variant="rounded" height={380} /> : (
        <>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', mb: 2 }} useFlexGap>
            <Kpi label="Current rate" value={fmtMoney(data.item.rate)} sub={data.item.unit} />
            <Kpi label="Since base rate" tone={up ? 'success.main' : 'error.main'} value={`${up ? '+' : ''}${s.totalChangePct}%`} sub={`from ${fmtMoney(s.baseRate)}`} />
            <Kpi label="Last revision" value={s.lastChangePct !== null ? `+${s.lastChangePct}%` : '—'} sub={s.lastEffectiveFrom ? fmtD(s.lastEffectiveFrom) : 'no revision on record'} />
            <Kpi label="Compound annual" value={`${s.cagrPct}%`} sub={`${s.revisions} revisions on record`} />
          </Stack>
          <Typography variant="h6" sx={{ fontSize: 14 }}>Rate trend</Typography>
          <Typography variant="caption" color="text.secondary">Each step is a published circular taking effect on its stated date</Typography>
          <Box sx={{ mt: 1.5 }}>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={data.series} margin={{ top: 6, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 11, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} width={72} domain={['auto', 'auto']} tickFormatter={(v: number) => fmtNum(v)} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtMoney(v)} cursor={{ stroke: grid }} />
                <Line type="stepAfter" dataKey="rate" name={`Rate (${data.item.unit})`} stroke={C.container} strokeWidth={2.5} dot={{ r: 3, fill: C.container }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </Box>
          <Card variant="outlined" sx={{ p: 1.75, mt: 2, display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
            <TextField size="small" type="date" label="Rate as at" value={asAt} sx={{ width: 190 }} onChange={(e) => setAsAt(e.target.value)} InputLabelProps={{ shrink: true }} />
            <Box><Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 20 }}>{fmtMoney(reading.rate)}</Typography><Typography variant="caption" color="text.secondary">{reading.revision ? `in force from ${fmtD(reading.revision.effectiveFrom)} · ${reading.revision.circular || ''}` : 'base rate — before the first revision on record'}</Typography></Box>
            <Box sx={{ flex: 1 }} />
            <Chip size="small" variant="outlined" icon={up ? <TrendingUpRoundedIcon /> : <TrendingDownRoundedIcon />} label={`${s.avgChangePct}% average revision`} sx={{ height: 24, fontSize: 11 }} />
          </Card>
          <Typography variant="h6" sx={{ fontSize: 14, mt: 2.5, mb: 1 }}>Revisions</Typography>
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>Effective from</TableCell><TableCell align="right">Previous</TableCell><TableCell align="right">Revised to</TableCell><TableCell align="right">Change</TableCell><TableCell>Circular</TableCell><TableCell>Note</TableCell></TableRow></TableHead>
              <TableBody>
                {data.revisions.slice().reverse().map((r) => (
                  <TableRow key={r.id} hover>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtD(r.effectiveFrom)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5, color: 'text.secondary' }}>{fmtMoney(r.previousRate)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700 }}>{fmtMoney(r.rate)}</TableCell>
                    <TableCell align="right"><Chip size="small" color={r.changePct >= 0 ? 'warning' : 'success'} variant="outlined" label={`${r.changePct >= 0 ? '+' : ''}${r.changePct}%`} sx={{ height: 20, fontSize: 11 }} /></TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{r.circular || '—'}</TableCell><TableCell sx={{ fontSize: 12 }}>{r.note || '—'}</TableCell>
                  </TableRow>
                ))}
                {data.revisions.length === 0 && <TableRow><TableCell colSpan={6}><Typography sx={{ py: 3, textAlign: 'center' }} color="text.secondary">No published revision on record for this head.</Typography></TableCell></TableRow>}
              </TableBody>
            </Table>
          </TableContainer>
          <Divider sx={{ mt: 2 }} />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Fictional demo tariff schedule — circular references are illustrative.</Typography>
        </>
      )}
    </FormDrawer>
  );
}
