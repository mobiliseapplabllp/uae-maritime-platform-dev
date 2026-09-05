import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Chip, Stack, LinearProgress, Skeleton } from '@mui/material';
import SpeedRoundedIcon from '@mui/icons-material/SpeedRounded';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { MONO, chartChrome } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import { fmtDT } from '../../utils/format';
import { availabilityTone, pct } from './shared';
import type { HistoryPoint, SlaRow } from './types';

/* Service levels, measured as synthetic transactions through the gateway — the same request a real
 * client makes, timed end to end. A per-service health check can be green while the path through it
 * is broken; this measures the path. */

const num = { fontVariantNumeric: 'tabular-nums' } as const;
const label = { fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'text.secondary' };

export default function PlatformSlasPage() {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const mode = useAppSelector((s) => s.ui.mode);
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [rows, setRows] = useState<SlaRow[] | null>(null);
  const [series, setSeries] = useState<Record<string, HistoryPoint[]>>({});

  const load = useCallback(async () => {
    try {
      const r = await api.get<SlaRow[]>('/platform/slas');
      setRows(r.data);
      const hist = await Promise.all(r.data.map(async (s) => [s.key, (await api.get<HistoryPoint[]>(`/platform/history/${s.key}`, { params: { granularity: 'hour', limit: 48 } })).data] as const));
      setSeries(Object.fromEntries(hist));
    } catch (e) { dispatch(notify({ message: (e as Error).message, severity: 'error' })); }
  }, [dispatch]);
  useEffect(() => { void load(); }, [load]);

  return (
    <Box>
      <PageHeader icon={SpeedRoundedIcon} title={t('platform.sla.title')} sub={t('platform.sla.subtitle')} />
      {!rows && <LinearProgress sx={{ mb: 2 }} />}
      <Grid container spacing={1.5}>
        {(rows ?? []).map((s) => {
          const pts = series[s.key] ?? [];
          return (
            <Grid item xs={12} md={6} key={s.key}>
              <Card data-testid={`sla-${s.key}`} sx={{ p: 2, height: '100%', borderLeft: 3, borderColor: s.up === false ? 'error.main' : s.withinTarget === false ? 'warning.main' : 'success.main' }}>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1 }}>
                  <Box>
                    <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{s.label}</Typography>
                    <Typography sx={label}>{s.domain}</Typography>
                  </Box>
                  <Chip size="small" color={availabilityTone(s.availability24h)} label={pct(s.availability24h)} sx={{ height: 20, fontSize: 11, fontWeight: 700 }} />
                </Stack>
                <Stack direction="row" spacing={2.5} sx={{ mb: 1 }}>
                  <Box>
                    <Typography sx={{ fontSize: 17, fontWeight: 700, ...num, color: s.withinTarget === false ? 'warning.main' : undefined }}>{s.latencyMs === null ? '—' : `${s.latencyMs}ms`}</Typography>
                    <Typography sx={label}>{t('platform.sla.now')}</Typography>
                  </Box>
                  <Box><Typography sx={{ fontSize: 17, fontWeight: 700, ...num }}>{s.targetMs}ms</Typography><Typography sx={label}>{t('platform.sla.target')}</Typography></Box>
                  <Box><Typography sx={{ fontSize: 17, fontWeight: 700, ...num }}>{s.latencyP95 === null ? '—' : `${s.latencyP95}ms`}</Typography><Typography sx={label}>{t('platform.sla.p95')}</Typography></Box>
                </Stack>
                <Typography sx={{ fontFamily: MONO, fontSize: 10, color: 'text.secondary', mb: 1 }}>{s.path}</Typography>
                <Box sx={{ height: 90 }}>
                  {pts.length > 1 ? (
                    <Box dir="ltr">{/* Charts are laid out left to right in both languages: Recharts does not mirror its axis gutters under RTL, so category labels would be painted behind the bars. */}
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={pts} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
                        <CartesianGrid stroke={grid} vertical={false} />
                        <XAxis dataKey="bucket" tick={{ fill: axis, fontSize: 9 }} tickFormatter={(v: string) => new Date(v).getHours() + 'h'} interval="preserveStartEnd" />
                        <YAxis tick={{ fill: axis, fontSize: 9 }} width={40} />
                        <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => fmtDT(String(v))} formatter={(v: number) => [`${v}ms`, t('platform.sla.p50')]} />
                        <Line type="monotone" dataKey="latencyP50" stroke="#0B74B0" strokeWidth={1.6} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                    </Box>
                  ) : (
                    <Typography sx={{ fontSize: 11, color: 'text.secondary', pt: 3 }}>{t('platform.sla.building')}</Typography>
                  )}
                </Box>
              </Card>
            </Grid>
          );
        })}
        {!rows && Array.from({ length: 4 }).map((_, i) => <Grid item xs={12} md={6} key={i}><Skeleton variant="rounded" height={250} /></Grid>)}
      </Grid>
    </Box>
  );
}
