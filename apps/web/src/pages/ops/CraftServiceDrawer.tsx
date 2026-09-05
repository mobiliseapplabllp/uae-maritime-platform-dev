import { useEffect, useState } from 'react';
import { Box, Typography, Stack, Chip, Divider, Skeleton, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, TablePagination, TextField, MenuItem, Card } from '@mui/material';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import dayjs from 'dayjs';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { CHART_SERIES, chartChrome, MONO } from '../../theme';
import FormDrawer from '../../components/common/FormDrawer';
import StatusChip from '../../components/common/StatusChip';
import { RESOURCE_STATUS_META } from '../../utils/status';
import { fmtD, fmtDT, fmtNum } from '../../utils/format';
import type { CraftRef, HistoryMeta, ResourceHistory } from './types';

/* One craft's service record — every tasking it has run, its out-of-service windows and the utilisation those two produce.
 * Jobs are paged server-side; a tug carries several hundred. All figures are sample data. */
const words = (s?: string) => String(s || '').replace(/_/g, ' ');

const Kpi = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
  <Card variant="outlined" sx={{ px: 1.5, py: 1.25, flex: 1, minWidth: 128 }}>
    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    <Typography sx={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
    {sub && <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>{sub}</Typography>}
  </Card>
);
const Heading = ({ children, sub }: { children: React.ReactNode; sub?: string }) => (
  <Box sx={{ mt: 2.5, mb: 1 }}>
    <Typography variant="h6" component="h3" sx={{ fontSize: 14 }}>{children}</Typography>
    {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
  </Box>
);

export default function CraftServiceDrawer({ resource, onClose }: { resource: CraftRef | null; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode];
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [data, setData] = useState<ResourceHistory | null>(null);
  const [meta, setMeta] = useState<HistoryMeta>({ total: 0, page: 1, limit: 10, kinds: [] });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [kind, setKind] = useState('');
  const resourceId = resource?.id;

  useEffect(() => { setPage(1); setKind(''); setData(null); }, [resourceId]);
  useEffect(() => {
    if (!resourceId) return;
    api.get<ResourceHistory>(`/ops/resources/${resourceId}/history`, { params: { page, limit, kind: kind || undefined } })
      .then((r) => { setData(r.data); setMeta({ total: 0, page, limit, kinds: [], ...((r.meta || {}) as Partial<HistoryMeta>) }); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  }, [resourceId, page, limit, kind, dispatch]);

  const s = data?.summary;
  const sinceYear = s?.lifetime.firstJobAt ? dayjs(s.lifetime.firstJobAt).format('YYYY') : null;
  return (
    <FormDrawer open={!!resource} width="72vw" onClose={onClose} title={resource ? `${resource.code} — ${resource.name}` : ''}
      subtitle={resource ? `${resource.spec || resource.type} · service record and utilisation (sample data)` : ''}>
      {!data || !s ? <Skeleton variant="rounded" height={420} /> : (
        <>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5, flexWrap: 'wrap' }} useFlexGap>
            <StatusChip value={data.resource.status} map={RESOURCE_STATUS_META} />
            {data.resource.master && <Chip size="small" variant="outlined" label={`Master: ${data.resource.master}`} sx={{ height: 22, fontSize: 11 }} />}
            {data.resource.contact && <Chip size="small" variant="outlined" label={data.resource.contact} sx={{ height: 22, fontSize: 11 }} />}
            <Typography variant="caption" color="text.secondary">In service since {fmtD(s.lifetime.firstJobAt)} · last job {fmtD(s.lifetime.lastJobAt)}</Typography>
          </Stack>

          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }} useFlexGap>
            <Kpi label="Jobs · 12 months" value={fmtNum(s.jobs)} sub={`${s.avgJobsPerMonth}/month average`} />
            <Kpi label="Assist hours · 12 m" value={fmtNum(s.hours)} sub={`${s.avgHours} h per job`} />
            <Kpi label="Availability" value={`${s.availabilityPct}%`} sub={`${fmtNum(s.outageDays)} days out of service`} />
            <Kpi label={sinceYear ? `Jobs since ${sinceYear}` : 'Jobs on record'} value={fmtNum(s.lifetime.jobs)} sub={`${fmtNum(s.lifetime.hours)} hours logged`} />
            <Kpi label="Busiest month" value={s.busiestMonth ? s.busiestMonth.label : '—'} sub={s.busiestMonth ? `${fmtNum(s.busiestMonth.jobs)} jobs` : ''} />
          </Stack>

          <Heading sub="Jobs completed and hours run, last 12 months">Utilisation</Heading>
          <Box role="img" aria-label={`Utilisation by month — ${s.series.map((p) => `${p.label}: ${p.jobs} jobs, ${p.hours} hours`).join('; ')}`}>
            <Box dir="ltr">{/* Charts are laid out left to right in both languages: Recharts does not mirror its axis gutters under RTL, so category labels would be painted behind the bars. */}
            <ResponsiveContainer width="100%" height={190}>
              <ComposedChart data={s.series} margin={{ top: 6, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis yAxisId="l" tick={{ fontSize: 10.5, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10.5, fill: axis }} axisLine={false} tickLine={false} width={34} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                <Bar yAxisId="l" dataKey="jobs" name="Jobs" fill={C.container} radius={[3, 3, 0, 0]} barSize={16} />
                <Line yAxisId="r" type="monotone" dataKey="hours" name="Hours" stroke={C.dryBulk} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
            </Box>
          </Box>

          <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
            {s.byKind.map((k) => <Chip key={k.kind} size="small" variant="outlined" sx={{ height: 22, fontSize: 11, fontWeight: 600 }} label={`${words(k.kind).toLowerCase()} · ${fmtNum(k.jobs)} jobs · ${fmtNum(k.hours)} h`} />)}
          </Stack>

          <Heading sub={`${data.outages.length} window(s) on record — ${fmtNum(s.lifetime.outageDays)} days total`}>Out of service</Heading>
          {data.outages.length === 0 ? <Typography variant="body2" color="text.secondary">No out-of-service window recorded for this unit.</Typography> : (
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label="Out-of-service windows">
                <TableHead><TableRow><TableCell>From</TableCell><TableCell>To</TableCell><TableCell align="right">Days</TableCell><TableCell>Reason</TableCell></TableRow></TableHead>
                <TableBody>
                  {data.outages.map((o) => (
                    <TableRow key={o.id} hover>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtD(o.from)}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtD(o.to)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{o.days}</TableCell>
                      <TableCell>{o.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          <Heading sub="Newest first — paged from the server">Jobs done</Heading>
          <TextField select size="small" label="Job type" value={kind} sx={{ minWidth: 190, mb: 1 }} onChange={(e) => { setKind(e.target.value); setPage(1); }}>
            <MenuItem value="">All types</MenuItem>
            {meta.kinds.map((k) => <MenuItem key={k} value={k}>{words(k)}</MenuItem>)}
          </TextField>
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="Jobs done">
              <TableHead><TableRow>
                <TableCell>When</TableCell><TableCell>VCN</TableCell><TableCell>Vessel</TableCell><TableCell>Berth</TableCell><TableCell>Type</TableCell><TableCell align="right">Hours</TableCell><TableCell>Remarks</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {data.jobs.map((j) => (
                  <TableRow key={j.id} hover>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDT(j.at)}</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}>{j.vcn || '—'}</TableCell>
                    <TableCell>{j.vesselName || '—'}</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}>{j.berth || '—'}</TableCell>
                    <TableCell><Chip size="small" label={words(j.kind)} sx={{ height: 20, fontSize: 10.5 }} /></TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{j.hours}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{j.remarks || '—'}</TableCell>
                  </TableRow>
                ))}
                {data.jobs.length === 0 && <TableRow><TableCell colSpan={7}><Typography sx={{ py: 3, textAlign: 'center' }} color="text.secondary">No jobs recorded for this unit.</Typography></TableCell></TableRow>}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination component="div" count={meta.total || 0} page={page - 1} rowsPerPage={limit} onPageChange={(_, p) => setPage(p + 1)}
            onRowsPerPageChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }} rowsPerPageOptions={[10, 25, 50]} />
          <Divider sx={{ mt: 1 }} />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Fictional demo data — taskings are generated against the sample port-call history.</Typography>
        </>
      )}
    </FormDrawer>
  );
}
