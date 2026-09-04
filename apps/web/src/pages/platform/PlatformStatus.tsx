import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Chip, Stack, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, LinearProgress, Tooltip, IconButton, Skeleton } from '@mui/material';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded';
import StorageRoundedIcon from '@mui/icons-material/StorageRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import SpeedRoundedIcon from '@mui/icons-material/SpeedRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import { MONO } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import { fmtDT } from '../../utils/format';
import { availabilityColor, duration, mb, outboxTone, pct } from './shared';
import type { AvailabilityRow, PlatformStatus as Status, TargetState } from './types';

/* The live board. Everything here is measured by the observability service, not asserted by the
 * services themselves — a service claiming to be healthy is exactly what an outage looks like from
 * the inside. */

const num = { fontVariantNumeric: 'tabular-nums' } as const;
const label = { fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'text.secondary' };

const Kpi = ({ value, caption, sub, tone }: { value: React.ReactNode; caption: string; sub?: string; tone?: 'success' | 'warning' | 'error' }) => (
  <Card sx={{ px: 2, py: 1.5, borderLeft: 3, borderColor: tone ? `${tone}.main` : 'divider' }}>
    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 22, ...num }}>{value}</Typography>
    <Typography sx={label}>{caption}</Typography>
    {sub && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{sub}</Typography>}
  </Card>
);

/** One service, at a glance: state, how long it has held, latency, and the internals that predict
 *  trouble before it becomes an outage. */
function ServiceTile({ t, avail }: { t: TargetState; avail?: AvailabilityRow }) {
  const tel = t.detail.telemetry;
  const ob = tel?.outbox;
  const obTone = ob ? outboxTone(ob.unpublished, ob.oldestUnpublishedSec) : 'success';
  return (
    <Card data-testid={`platform-tile-${t.target}`} sx={{ p: 1.5, height: '100%', borderTop: 3, borderColor: t.up ? 'success.main' : 'error.main' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 13.5 }} noWrap>{t.target}</Typography>
          <Typography sx={{ ...label, fontSize: 9 }}>{t.detail.kind || t.kind} · :{t.detail.port ?? '—'}</Typography>
        </Box>
        <Chip size="small" color={t.up ? 'success' : 'error'} label={t.up ? 'UP' : 'DOWN'} sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />
      </Stack>
      <Stack direction="row" spacing={1.5} sx={{ mt: 1 }}>
        <Box><Typography sx={{ fontSize: 15, fontWeight: 700, ...num }}>{t.latencyMs === null ? '—' : `${t.latencyMs}ms`}</Typography><Typography sx={{ ...label, fontSize: 8.5 }}>latency</Typography></Box>
        <Box>
          <Typography sx={{ fontSize: 15, fontWeight: 700, ...num, color: availabilityColor(avail?.availability ?? null) }}>{pct(avail?.availability ?? null)}</Typography>
          <Typography sx={{ ...label, fontSize: 8.5 }}>24h</Typography>
        </Box>
        <Box><Typography sx={{ fontSize: 15, fontWeight: 700, ...num }}>{duration(t.forSec)}</Typography><Typography sx={{ ...label, fontSize: 8.5 }}>{t.up ? 'up for' : 'down for'}</Typography></Box>
      </Stack>
      {t.error && <Typography sx={{ fontSize: 10.5, color: 'error.main', mt: 0.75 }} noWrap>{t.error}</Typography>}
      {tel && (
        <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
          <Tooltip title={`Database ${tel.db.reachable ? 'reachable' : 'unreachable'} · pool ${tel.db.poolIdle}/${tel.db.poolTotal} idle, ${tel.db.poolWaiting} waiting`}>
            <Chip size="small" variant="outlined" color={tel.db.reachable ? 'default' : 'error'} label={`db ${tel.db.latencyMs ?? '—'}ms`} sx={{ height: 17, fontSize: 9.5 }} />
          </Tooltip>
          <Tooltip title={ob && ob.unpublished > 0 ? `${ob.unpublished} events written but not published, oldest ${ob.oldestUnpublishedSec ?? 0}s ago` : 'No unpublished events'}>
            <Chip size="small" variant="outlined" color={obTone === 'success' ? 'default' : obTone} label={`outbox ${ob?.unpublished ?? '—'}`} sx={{ height: 17, fontSize: 9.5 }} />
          </Tooltip>
          <Tooltip title={`${tel.migrations.applied} migrations applied · last ${tel.migrations.last ?? 'none'}`}>
            <Chip size="small" variant="outlined" label={`mig ${tel.migrations.applied}`} sx={{ height: 17, fontSize: 9.5 }} />
          </Tooltip>
          <Tooltip title={`Resident memory ${tel.memory.rssMb} MB, heap ${tel.memory.heapUsedMb}/${tel.memory.heapTotalMb} MB`}>
            <Chip size="small" variant="outlined" label={`${tel.memory.rssMb}MB`} sx={{ height: 17, fontSize: 9.5 }} />
          </Tooltip>
        </Stack>
      )}
      {/* The gateway is a proxy: no database, no service-kit, so it has no telemetry to report and
          saying so in warning colours would be crying wolf about expected behaviour. */}
      {!tel && t.up && t.kind === 'service' && t.detail.kind !== 'edge' && (
        <Typography sx={{ fontSize: 10, color: 'warning.main', mt: 0.75 }}>{t.detail.telemetryError ? 'telemetry unavailable' : 'telemetry not reported'}</Typography>
      )}
      {!tel && t.up && t.detail.kind === 'edge' && (
        <Typography sx={{ fontSize: 10, color: 'text.secondary', mt: 0.75 }}>edge proxy — no database</Typography>
      )}
    </Card>
  );
}

export default function PlatformStatusPage() {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);
  const [avail, setAvail] = useState<AvailabilityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [s, a] = await Promise.all([
        api.get<Status>('/platform/status', quiet ? { headers: { 'X-Quiet': '1' } } : undefined),
        api.get<AvailabilityRow[]>('/platform/availability', { params: { hours: 24 }, ...(quiet ? { headers: { 'X-Quiet': '1' } } : {}) }),
      ]);
      setStatus(s.data); setAvail(a.data);
    } catch (e) {
      if (!quiet) dispatch(notify({ message: (e as Error).message, severity: 'error' }));
    } finally { if (!quiet) setLoading(false); }
  }, [dispatch]);

  useEffect(() => {
    void load();
    // Refresh on the collector's own cadence. Quiet refreshes so a blip does not raise a toast on
    // a screen someone is likely to leave open all day.
    timer.current = setInterval(() => void load(true), 15000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  const byKind = useMemo(() => {
    const g = { service: [] as TargetState[], database: [] as TargetState[], broker: [] as TargetState[], sla: [] as TargetState[] };
    for (const x of status?.targets ?? []) g[x.kind]?.push(x);
    return g;
  }, [status]);
  const availOf = useMemo(() => new Map(avail.map((a) => [a.target, a])), [avail]);

  const pg = byKind.database[0];
  const nats = byKind.broker[0];
  const summary = status?.summary;
  const worstOutbox = useMemo(() => byKind.service
    .map((s) => ({ name: s.target, ob: s.detail.telemetry?.outbox }))
    .filter((x) => (x.ob?.unpublished ?? 0) > 0)
    .sort((a, b) => (b.ob?.unpublished ?? 0) - (a.ob?.unpublished ?? 0)), [byKind.service]);

  return (
    <Box>
      <PageHeader
        icon={MonitorHeartRoundedIcon}
        title={t('platform.title')}
        sub={status ? t('platform.subtitle', { at: fmtDT(status.lastSweepAt || status.generatedAt), every: Math.round((status.tickMs || 0) / 1000) }) : ' '}
        actions={<IconButton size="small" onClick={() => void load()} aria-label={t('platform.refresh')} data-testid="platform-refresh"><RefreshRoundedIcon fontSize="small" /></IconButton>}
      />
      {loading && !status && <LinearProgress sx={{ mb: 2 }} />}

      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}>
          <Kpi value={summary ? `${summary.servicesUp}/${summary.services}` : <Skeleton width={60} />} caption={t('platform.kpi.services')}
               tone={summary ? (summary.servicesUp === summary.services ? 'success' : 'error') : undefined} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Kpi value={summary ? `${summary.targetsUp}/${summary.targets}` : <Skeleton width={60} />} caption={t('platform.kpi.targets')} sub={t('platform.kpi.targetsSub')} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Kpi value={summary?.openIncidents ?? <Skeleton width={30} />} caption={t('platform.kpi.openIncidents')}
               tone={summary ? (summary.openIncidents === 0 ? 'success' : 'error') : undefined} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Kpi value={pg?.detail.totalSizeMb !== undefined ? mb(pg.detail.totalSizeMb) : <Skeleton width={70} />} caption={t('platform.kpi.dataSize')}
               sub={pg ? t('platform.kpi.databases', { n: pg.detail.databaseCount ?? 0 }) : undefined} />
        </Grid>
      </Grid>

      <Typography sx={{ ...label, mb: 1 }}>{t('platform.section.services')}</Typography>
      <Grid container spacing={1.5} sx={{ mb: 3 }}>
        {byKind.service.length === 0 && loading && Array.from({ length: 8 }).map((_, i) => (
          <Grid item xs={12} sm={6} md={4} lg={3} key={i}><Skeleton variant="rounded" height={132} /></Grid>
        ))}
        {byKind.service.map((s) => (
          <Grid item xs={12} sm={6} md={4} lg={3} key={s.target}><ServiceTile t={s} avail={availOf.get(s.target)} /></Grid>
        ))}
      </Grid>

      <Grid container spacing={1.5}>
        <Grid item xs={12} lg={6}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <StorageRoundedIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('platform.section.database')}</Typography>
              {pg && <Chip size="small" color={pg.up ? 'success' : 'error'} label={pg.up ? 'UP' : 'DOWN'} sx={{ height: 18, fontSize: 10 }} />}
            </Stack>
            {pg && (
              <>
                <Stack direction="row" spacing={2} sx={{ mb: 1.5 }}>
                  <Box><Typography sx={{ fontSize: 17, fontWeight: 700, ...num }}>{pg.detail.connections ?? '—'}/{pg.detail.maxConnections ?? '—'}</Typography><Typography sx={label}>{t('platform.db.connections')}</Typography></Box>
                  <Box><Typography sx={{ fontSize: 17, fontWeight: 700, ...num }}>{mb(pg.detail.totalSizeMb)}</Typography><Typography sx={label}>{t('platform.db.total')}</Typography></Box>
                  <Box><Typography sx={{ fontSize: 17, fontWeight: 700, ...num }}>{pg.detail.longestQuerySec ?? 0}s</Typography><Typography sx={label}>{t('platform.db.longest')}</Typography></Box>
                </Stack>
                <TableContainer sx={{ maxHeight: 260 }}>
                  <Table size="small" stickyHeader>
                    <TableHead><TableRow><TableCell>{t('platform.db.name')}</TableCell><TableCell align="right">{t('platform.db.size')}</TableCell><TableCell align="right">{t('platform.db.conns')}</TableCell></TableRow></TableHead>
                    <TableBody>
                      {(pg.detail.databases ?? []).map((d) => (
                        <TableRow key={d.name} hover>
                          <TableCell sx={{ fontSize: 12 }}>{d.name}</TableCell>
                          <TableCell align="right" sx={{ fontSize: 12, ...num }}>{mb(d.sizeMb)}</TableCell>
                          <TableCell align="right" sx={{ fontSize: 12, ...num }}>{d.connections}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </>
            )}
          </Card>
        </Grid>

        <Grid item xs={12} lg={6}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <HubRoundedIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
              <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('platform.section.broker')}</Typography>
              {nats && <Chip size="small" color={nats.up ? 'success' : 'error'} label={nats.up ? 'UP' : 'DOWN'} sx={{ height: 18, fontSize: 10 }} />}
            </Stack>
            {nats?.detail.jetstream && (
              <>
                <Stack direction="row" spacing={2} sx={{ mb: 1.5 }}>
                  <Box><Typography sx={{ fontSize: 17, fontWeight: 700, ...num }}>{nats.detail.jetstream.streamCount}</Typography><Typography sx={label}>{t('platform.bus.streams')}</Typography></Box>
                  <Box><Typography sx={{ fontSize: 17, fontWeight: 700, ...num }}>{nats.detail.jetstream.consumerCount}</Typography><Typography sx={label}>{t('platform.bus.consumers')}</Typography></Box>
                  <Box>
                    <Typography sx={{ fontSize: 17, fontWeight: 700, ...num, color: nats.detail.jetstream.totalPending > 0 ? 'warning.main' : undefined }}>{nats.detail.jetstream.totalPending}</Typography>
                    <Tooltip title={t('platform.bus.pendingHelp')}><Typography sx={label}>{t('platform.bus.pending')}</Typography></Tooltip>
                  </Box>
                  <Box><Typography sx={{ fontSize: 17, fontWeight: 700, ...num }}>{nats.detail.server?.connections ?? '—'}</Typography><Typography sx={label}>{t('platform.bus.connections')}</Typography></Box>
                </Stack>
                <TableContainer sx={{ maxHeight: 260 }}>
                  <Table size="small" stickyHeader>
                    <TableHead><TableRow><TableCell>{t('platform.bus.stream')}</TableCell><TableCell align="right">{t('platform.bus.messages')}</TableCell><TableCell align="right">{t('platform.bus.consumers')}</TableCell><TableCell align="right">{t('platform.bus.maxLag')}</TableCell></TableRow></TableHead>
                    <TableBody>
                      {nats.detail.jetstream.streams.map((s) => (
                        <TableRow key={s.name} hover>
                          <TableCell sx={{ fontSize: 12 }}>{s.name}</TableCell>
                          <TableCell align="right" sx={{ fontSize: 12, ...num }}>{s.messages.toLocaleString()}</TableCell>
                          <TableCell align="right" sx={{ fontSize: 12, ...num }}>{s.consumers.length}</TableCell>
                          <TableCell align="right" sx={{ fontSize: 12, ...num, color: s.maxPending > 0 ? 'warning.main' : undefined }}>{s.maxPending}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </>
            )}
            {nats && !nats.detail.jetstream && <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{t('platform.bus.noJetstream')}</Typography>}
          </Card>
        </Grid>

        {worstOutbox.length > 0 && (
          <Grid item xs={12}>
            <Card sx={{ p: 2, borderLeft: 3, borderColor: 'warning.main' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <SpeedRoundedIcon sx={{ fontSize: 18, color: 'warning.main' }} />
                <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('platform.outbox.title')}</Typography>
              </Stack>
              <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 1 }}>{t('platform.outbox.help')}</Typography>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                {worstOutbox.map((x) => (
                  <Chip key={x.name} size="small" color={outboxTone(x.ob?.unpublished ?? 0, x.ob?.oldestUnpublishedSec ?? null)}
                        label={`${x.name}: ${x.ob?.unpublished} (${x.ob?.oldestUnpublishedSec ?? 0}s)`} />
                ))}
              </Stack>
            </Card>
          </Grid>
        )}
      </Grid>
    </Box>
  );
}
