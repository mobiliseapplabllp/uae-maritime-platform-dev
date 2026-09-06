import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, ButtonBase, Card, Chip, Grid, LinearProgress, Skeleton, Stack, Tooltip, Typography } from '@mui/material';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import { MONO } from '../../theme';

/* The dashboard kit: the few pieces every module dashboard is built from, so the seven read as one family and a
 * number means the same thing wherever it appears. */

/** Loads one dashboard payload; an error is reported once and the page shows its skeleton until data arrives. */
export function useDashboard<T>(url: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dispatch = useAppDispatch();
  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    api.get<T>(url).then((r) => { if (live) setData(r.data); }).catch((e: Error) => { if (live) { setError(e.message); dispatch(notify({ message: e.message, severity: 'error' })); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, dispatch, ...deps]);
  return { data, error, reload: () => api.get<T>(url).then((r) => setData(r.data)) };
}

export function DashboardSkeleton({ tiles = 8 }: { tiles?: number }) {
  return (
    <Grid container spacing={2} aria-busy="true" data-testid="dashboard-skeleton">
      {Array.from({ length: tiles }).map((_, i) => <Grid item xs={6} md={3} key={i}><Skeleton variant="rounded" height={92} /></Grid>)}
      <Grid item xs={12} md={8}><Skeleton variant="rounded" height={300} /></Grid><Grid item xs={12} md={4}><Skeleton variant="rounded" height={300} /></Grid>
    </Grid>
  );
}

/** A titled card with a fixed-height chart area. The plot is laid out left to right in both languages: Recharts does not mirror its axis gutters under RTL. */
export function ChartCard({ title, sub, children, h = 280, action, testId }: { title: string; sub?: string; children: ReactNode; h?: number; action?: { label: string; to: string }; testId?: string }) {
  const navigate = useNavigate();
  return (
    <Card sx={{ p: 2, height: '100%' }} data-testid={testId}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}>
        <Box><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{title}</Typography>{sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}</Box>
        {action && <Typography variant="caption" component="button" onClick={() => navigate(action.to)} sx={{ color: 'primary.main', cursor: 'pointer', fontWeight: 600, background: 'none', border: 0, font: 'inherit', whiteSpace: 'nowrap' }}>{action.label} →</Typography>}
      </Box>
      <Box sx={{ height: h, mt: 1 }}><Box dir="ltr" sx={{ height: '100%' }}>{children}</Box></Box>
    </Card>
  );
}

/** A section card without a chart: lists, tables, rankings. */
export function PanelCard({ title, sub, children, action, testId, minHeight }: { title: string; sub?: string; children: ReactNode; action?: { label: string; to: string }; testId?: string; minHeight?: number }) {
  const navigate = useNavigate();
  return (
    <Card sx={{ p: 2, height: '100%', minHeight }} data-testid={testId}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1, mb: 1 }}>
        <Box><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{title}</Typography>{sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}</Box>
        {action && <Typography variant="caption" component="button" onClick={() => navigate(action.to)} sx={{ color: 'primary.main', cursor: 'pointer', fontWeight: 600, background: 'none', border: 0, font: 'inherit', whiteSpace: 'nowrap' }}>{action.label} →</Typography>}
      </Box>
      {children}
    </Card>
  );
}

export type Tone = 'success' | 'warning' | 'error' | 'default';
/** The tone of a measured value against its yardstick: `higherIsBetter` decides which side of the target is good. */
export function toneOf(value: number | null | undefined, target: number, higherIsBetter = true, slack = 0.15): Tone {
  if (value === null || value === undefined || Number.isNaN(value)) return 'default';
  const good = higherIsBetter ? value >= target : value <= target;
  if (good) return 'success';
  const off = Math.abs(value - target) / Math.max(1, Math.abs(target));
  return off <= slack ? 'warning' : 'error';
}
const TONE_COLOR: Record<Tone, string> = { success: 'success.main', warning: 'warning.main', error: 'error.main', default: 'text.secondary' };

/** A yardstick tile: the value, the target it is read against, and a colour saying which side of it the port stands. */
export function Yardstick({ label, value, display, target, targetLabel, higherIsBetter = true, sub, testId }: { label: string; value: number | null | undefined; display: string; target: number; targetLabel: string; higherIsBetter?: boolean; sub?: string; testId?: string }) {
  const tone = toneOf(value, target, higherIsBetter);
  return (
    <Card sx={{ px: 2, py: 1.5, height: '100%', borderLeft: 3, borderLeftColor: TONE_COLOR[tone] }} data-testid={testId}>
      <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 22, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' }}>{display}</Typography>
      <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.5 }}>
        <Chip size="small" label={targetLabel} sx={{ height: 18, fontSize: 10.5, color: TONE_COLOR[tone], borderColor: TONE_COLOR[tone] }} variant="outlined" />
        {sub && <Typography variant="caption" color="text.secondary" noWrap>{sub}</Typography>}
      </Stack>
    </Card>
  );
}

/** Horizontal bars for buckets — ageing, bands, shares — with the count and an optional amount beside each. */
export function BucketBars({ rows, max, testId, tone }: { rows: { label: string; value: number; display?: string; sub?: string }[]; max?: number; testId?: string; tone?: (i: number) => string }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <Stack spacing={1} data-testid={testId} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
      {rows.map((r, i) => (
        <Box component="li" key={r.label}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
            <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{r.label}</Typography>
            <Typography sx={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{r.display ?? r.value}{r.sub ? ` · ${r.sub}` : ''}</Typography>
          </Box>
          <LinearProgress variant="determinate" value={Math.min(100, (r.value / top) * 100)} aria-label={`${r.label}: ${r.display ?? r.value}`} sx={{ height: 8, borderRadius: 4, mt: 0.5, '& .MuiLinearProgress-bar': { bgcolor: tone ? tone(i) : undefined } }} />
        </Box>
      ))}
    </Stack>
  );
}

/** A compact ranked list — debtors, agents, weakest masters — that opens a record when given a route. Each row stays a
 * list item; the navigable ones carry a button inside, so the list keeps its semantics for a screen reader. */
export function RankList({ rows, testId, empty = 'Nothing to show' }: { rows: { key: string; primary: string; secondary?: string; value: string; tone?: Tone; to?: string }[]; testId?: string; empty?: string }) {
  const navigate = useNavigate();
  if (!rows.length) return <Typography variant="body2" color="text.secondary" data-testid={testId}>{empty}</Typography>;
  const rowSx = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, py: 0.75, width: '100%', textAlign: 'start' } as const;
  const body = (r: (typeof rows)[number]) => (
    <>
      <Box sx={{ minWidth: 0 }}>
        <Typography noWrap sx={{ fontSize: 13, fontWeight: 600 }}>{r.primary}</Typography>
        {r.secondary && <Typography noWrap variant="caption" color="text.secondary" component="div">{r.secondary}</Typography>}
      </Box>
      <Typography sx={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: r.tone ? TONE_COLOR[r.tone] : 'text.primary' }}>{r.value}</Typography>
    </>
  );
  return (
    <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }} data-testid={testId}>
      {rows.map((r) => (
        <Box component="li" key={r.key} sx={{ borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
          {r.to ? <ButtonBase onClick={() => navigate(r.to!)} sx={{ ...rowSx, font: 'inherit', borderRadius: 1, px: 0.5, mx: -0.5, width: 'calc(100% + 8px)' }}>{body(r)}</ButtonBase> : <Box sx={rowSx}>{body(r)}</Box>}
        </Box>
      ))}
    </Box>
  );
}

/** The link back to the module's working screens, shown in a dashboard header. */
export function OpenLink({ label, to }: { label: string; to: string }) {
  const navigate = useNavigate();
  return <Chip size="small" clickable icon={<ArrowForwardRoundedIcon />} label={label} onClick={() => navigate(to)} variant="outlined" sx={{ fontWeight: 600 }} />;
}

/** A short explanation of how a figure is worked, on hover — every yardstick can say where it came from. */
export function Method({ text, children }: { text: string; children: ReactNode }) { return <Tooltip title={text} arrow><Box component="span" sx={{ cursor: 'help', borderBottom: '1px dotted', borderColor: 'text.disabled' }}>{children}</Box></Tooltip>; }
