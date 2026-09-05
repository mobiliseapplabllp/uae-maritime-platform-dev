import { useEffect, useState } from 'react';
import { Card, Grid, Box, Typography, Stack, Skeleton, Chip, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, TextField, MenuItem } from '@mui/material';
import { ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { CHART_SERIES, chartChrome, MONO } from '../../theme';
import { fmtD, fmtNum } from '../../utils/format';
import { RESOURCE_TYPE_LABELS } from './constants';
import type { FleetCraft, FleetUtilisationData, ResourceType } from './types';

/* Fleet-level utilisation for the marine craft — how much work the tugs, launches, mooring boats and pilots actually did, month by month.
 * Everything is aggregated server-side from the craft service records. */
const typeLabel = (t: string) => RESOURCE_TYPE_LABELS[t as ResourceType] || t;

const Kpi = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
  <Card sx={{ px: 2, py: 1.5, height: '100%' }}>
    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
    {sub && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{sub}</Typography>}
  </Card>
);
const Section = ({ title, sub, action, children }: { title: string; sub?: string; action?: React.ReactNode; children: React.ReactNode }) => (
  <Card sx={{ p: 2, height: '100%' }}>
    <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between">
      <Box>
        <Typography variant="h6" component="h3" sx={{ fontSize: 15 }}>{title}</Typography>
        {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
      </Box>
      {action}
    </Stack>
    <Box sx={{ mt: 1.5 }}>{children}</Box>
  </Card>
);

export default function FleetUtilisation({ onOpenCraft }: { onOpenCraft?: (c: FleetCraft) => void }) {
  const dispatch = useAppDispatch();
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode];
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [months, setMonths] = useState(12);
  const [data, setData] = useState<FleetUtilisationData | null>(null);

  useEffect(() => {
    setData(null);
    api.get<FleetUtilisationData>('/ops/resources/utilisation', { params: { months } }).then((r) => setData(r.data))
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  }, [months, dispatch]);

  if (!data) {
    return (
      <Grid container spacing={1.5} aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => <Grid item xs={6} md key={i}><Skeleton variant="rounded" height={86} /></Grid>)}
        <Grid item xs={12}><Skeleton variant="rounded" height={280} /></Grid>
      </Grid>
    );
  }
  const t = data.totals;
  const maxJobs = Math.max(1, ...data.craft.map((c) => c.jobs));
  const top = data.craft[0];

  return (
    <>
      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid item xs={6} md={2.4}><Kpi label={`Assists · ${months} months`} value={fmtNum(t.jobs)} sub={`${fmtNum(t.avgJobsPerMonth)} per month`} /></Grid>
        <Grid item xs={6} md={2.4}><Kpi label="Assist hours" value={fmtNum(t.hours)} sub={`${t.avgHoursPerJob} h per job`} /></Grid>
        <Grid item xs={6} md={2.4}><Kpi label="Fleet availability" value={`${t.availabilityPct}%`} sub={`${fmtNum(t.outageDays)} craft-days out of service`} /></Grid>
        <Grid item xs={6} md={2.4}><Kpi label="Busiest craft" value={top ? top.code : '—'} sub={top ? `${fmtNum(top.jobs)} jobs · ${top.name}` : ''} /></Grid>
        <Grid item xs={12} md={2.4}><Kpi label="All-time record" value={fmtNum(t.jobsAllTime)} sub={`${fmtNum(t.hoursAllTime)} hours across ${t.craft} craft`} /></Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12} md={8}>
          <Section title="Jobs per month across the fleet" sub="Every berthing, unberthing, pilotage, transfer and line-handling run"
            action={(
              <TextField select size="small" label="Window" value={months} sx={{ minWidth: 130 }} onChange={(e) => setMonths(Number(e.target.value))}>
                {[6, 12, 24, 36].map((m) => <MenuItem key={m} value={m}>{m} months</MenuItem>)}
              </TextField>
            )}>
            <Box role="img" aria-label={`Jobs per month — ${data.series.map((p) => `${p.label}: ${p.jobs} jobs, ${p.hours} hours`).join('; ')}`}>
              <Box dir="ltr">{/* Charts are laid out left to right in both languages: Recharts does not mirror its axis gutters under RTL, so category labels would be painted behind the bars. */}
              <ResponsiveContainer width="100%" height={250}>
                <ComposedChart data={data.series} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke={grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} interval="preserveStartEnd" />
                  <YAxis yAxisId="l" tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                  <Bar yAxisId="l" dataKey="jobs" name="Jobs" fill={C.container} radius={[3, 3, 0, 0]} barSize={18} />
                  <Line yAxisId="r" type="monotone" dataKey="hours" name="Assist hours" stroke={C.dryBulk} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
              </Box>
            </Box>
          </Section>
        </Grid>
        <Grid item xs={12} md={4}>
          <Section title="Work by craft type" sub={`${t.craft} units on strength`}>
            <Box role="img" aria-label={`Jobs by craft type — ${data.byType.map((x) => `${typeLabel(x.type)}: ${x.jobs}`).join('; ')}`}>
              <Box dir="ltr">
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={data.byType} layout="vertical" margin={{ top: 0, right: 20, left: 8, bottom: 0 }}>
                  <CartesianGrid stroke={grid} horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="type" width={92} tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} tickFormatter={(v: string) => typeLabel(v)} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                  <Bar dataKey="jobs" name="Jobs" fill={C.liquid} radius={[0, 3, 3, 0]} barSize={16} />
                </BarChart>
              </ResponsiveContainer>
              </Box>
            </Box>
          </Section>
        </Grid>

        <Grid item xs={12} md={7}>
          <Section title="Busiest craft" sub="Click a row to open its full service record">
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label="Busiest craft">
                <TableHead><TableRow>
                  <TableCell>Craft</TableCell><TableCell>Type</TableCell><TableCell align="right">Jobs</TableCell><TableCell sx={{ width: 130 }}><Box component="span" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>Share of busiest</Box></TableCell>
                  <TableCell align="right">Hours</TableCell><TableCell align="right">Availability</TableCell><TableCell>Last job</TableCell>
                </TableRow></TableHead>
                <TableBody>
                  {data.craft.map((c) => (
                    <TableRow key={c.id} hover sx={{ cursor: onOpenCraft ? 'pointer' : undefined }} onClick={onOpenCraft ? () => onOpenCraft(c) : undefined}>
                      <TableCell>
                        <Typography sx={{ fontSize: 13, fontWeight: 700 }}>{c.code}</Typography>
                        <Typography variant="caption" color="text.secondary">{c.name}</Typography>
                      </TableCell>
                      <TableCell sx={{ fontSize: 12 }}>{typeLabel(c.type)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{fmtNum(c.jobs)}</TableCell>
                      <TableCell>
                        <Box role="meter" aria-label={`${c.code} share of the busiest craft`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((c.jobs / maxJobs) * 100)} sx={{ height: 7, borderRadius: 4, bgcolor: 'action.hover', overflow: 'hidden' }}>
                          <Box sx={{ width: `${(c.jobs / maxJobs) * 100}%`, height: '100%', bgcolor: 'primary.main', borderRadius: 4 }} />
                        </Box>
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{fmtNum(c.hours)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{c.availabilityPct}%</TableCell>
                      <TableCell sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtD(c.lastJobAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Section>
        </Grid>
        <Grid item xs={12} md={5}>
          <Section title="Jobs by type of movement" sub={`Window ${fmtD(data.window.from)} — ${fmtD(data.window.to)}`}>
            <Stack spacing={1}>
              {data.byKind.map((k) => (
                <Box key={k.kind}>
                  <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                    <Typography sx={{ fontSize: 12.5, fontWeight: 600, textTransform: 'capitalize' }}>{k.kind.replace(/_/g, ' ').toLowerCase()}</Typography>
                    <Typography sx={{ fontFamily: MONO, fontSize: 12 }}>{fmtNum(k.jobs)} · {fmtNum(k.hours)} h</Typography>
                  </Stack>
                  <Box aria-hidden sx={{ height: 6, borderRadius: 3, bgcolor: 'action.hover', mt: 0.5, overflow: 'hidden' }}>
                    <Box sx={{ width: `${(k.jobs / Math.max(1, data.byKind[0].jobs)) * 100}%`, height: '100%', bgcolor: 'secondary.main' }} />
                  </Box>
                </Box>
              ))}
            </Stack>
            <Stack direction="row" spacing={0.75} sx={{ mt: 2, flexWrap: 'wrap' }} useFlexGap>
              <Chip size="small" variant="outlined" label={`${fmtNum(t.outageDays)} craft-days out of service`} sx={{ height: 22, fontSize: 11 }} />
              <Chip size="small" variant="outlined" label={`${t.craft} craft on strength`} sx={{ height: 22, fontSize: 11 }} />
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>Fictional demo data, aggregated server-side from the craft service records.</Typography>
          </Section>
        </Grid>
      </Grid>
    </>
  );
}
