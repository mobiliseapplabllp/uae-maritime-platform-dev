import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Grid, Card, Box, Typography, Chip, Stack, Skeleton, IconButton, Tooltip, Divider, Button, Table, TableHead, TableRow, TableCell, TableBody } from '@mui/material';
import DoneRoundedIcon from '@mui/icons-material/DoneRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import RadarRoundedIcon from '@mui/icons-material/RadarRounded';
import api from '../../api/client';
import { useAppDispatch, useAppSelector, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import { useProfile } from '../../config/runtime';
import PageHeader from '../../components/common/PageHeader';
import { fmtDT, fromNow } from '../../utils/format';
import type { ChipColor } from '../../utils/status';
import { bboxAround, fmtLat, fmtLon, gridTicks, inBbox, makeProjector } from './geo';
import type { MdaAlert, NavStatus, OpenIncident, TrackedPosition, TrafficPicture, TrafficZone } from './types';

/* The live traffic picture — a stylised approach chart drawn on SVG around the home port (no map tiles, no external services).
 * Chart features come from the /tracking payload's zones; the centre and scale from the payload's port or the jurisdiction profile.
 * A visually hidden table carries the same targets for screen readers. */
const W = 980; const H = 640;
const SR_ONLY = { position: 'absolute', width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 } as const;
const STATUS_COLOR: Record<NavStatus, string> = { MOORED: '#2C6E52', AT_ANCHOR: '#9C6412', UNDERWAY: '#0B74B0', RESTRICTED: '#A33229' };
const STATUS_LABEL: Record<NavStatus, string> = { MOORED: 'Moored', AT_ANCHOR: 'At anchor', UNDERWAY: 'Underway', RESTRICTED: 'Restricted manoeuvrability' };
const ALERT_COLOR: Record<MdaAlert['severity'], ChipColor> = { info: 'info', warning: 'warning', error: 'error' };
const words = (s?: string) => String(s || '').replace(/_/g, ' ');
const activate = (fn: () => void) => (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
const posOf = (i: OpenIncident) => ({ lat: i.position?.lat ?? i.location?.lat, lon: i.position?.lon ?? i.location?.lon });

export default function TrafficMap() {
  const [data, setData] = useState<TrafficPicture | null>(null);
  const [openCases, setOpenCases] = useState<OpenIncident[]>([]);
  const [selected, setSelected] = useState<TrackedPosition | null>(null);
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const user = useUser();
  const profile = useProfile();
  const mode = useAppSelector((s) => s.ui.mode);
  const dark = mode === 'dark';

  const load = useCallback(() => Promise.all([
    api.get<TrafficPicture>('/tracking'),
    api.get<OpenIncident[]>('/incidents', { params: { open: 'true', limit: 50 } }).catch(() => ({ data: [] as OpenIncident[] })),
  ]).then(([t, i]) => { setData(t.data); setOpenCases(i.data || []); })
    .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))), [dispatch]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const port = data?.port || profile.portGeo || { name: 'Home port', lat: 0, lon: 0, zoomKm: 25 };
  const bbox = useMemo(() => bboxAround(port.lat, port.lon, port.zoomKm || 25, W / H), [port.lat, port.lon, port.zoomKm]);
  const { X, Y } = useMemo(() => makeProjector(bbox, W, H), [bbox]);

  if (!data) return <Skeleton variant="rounded" height={480} />;
  const sea = dark ? '#0A2233' : '#D7E7EF';
  const seaDeep = dark ? '#071A29' : '#C4DBE8';
  const land = dark ? '#14303F' : '#EFE9DC';
  const landLine = dark ? '#1F4557' : '#CBBFA5';
  const ink = dark ? '#AAC1C7' : '#4A6472';
  const chan = dark ? '#57B0E3' : '#0B74B0';
  const amber = dark ? '#E8B155' : '#9C6412';
  const canAck = hasPerm(user, 'nmc.manage');
  const onChart = data.positions.filter((p) => inBbox(bbox, p.lat, p.lon));
  const ack = (a: MdaAlert) => api.post(`/tracking/alerts/${a.id}/ack`).then(load).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  const path = (pts: TrafficZone['points'], close: boolean) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.lon)},${Y(p.lat)}`).join(' ') + (close ? ' Z' : '');
  const anchor = (pts: TrafficZone['points']) => ({ x: Math.min(...pts.map((p) => X(p.lon))), y: Math.min(...pts.map((p) => Y(p.lat))) });
  const centre = (pts: TrafficZone['points']) => ({ x: pts.reduce((s, p) => s + X(p.lon), 0) / pts.length, y: pts.reduce((s, p) => s + Y(p.lat), 0) / pts.length });

  const zone = (z: TrafficZone) => {
    if (!z.points.length) return null;
    const mono = 'IBM Plex Mono, monospace';
    if (z.kind === 'LAND') { const c = centre(z.points); return <g key={z.id}><path d={path(z.points, true)} fill={land} stroke={landLine} strokeWidth="2" /><text aria-hidden x={c.x} y={c.y} textAnchor="middle" fontSize="11" fill={ink} fontFamily="Archivo, sans-serif" opacity="0.8">{z.label.toUpperCase()}</text></g>; }
    if (z.kind === 'ANCHORAGE') { const a = anchor(z.points); return <g key={z.id}><path d={path(z.points, true)} fill="none" stroke={ink} strokeDasharray="5 4" strokeWidth="1.5" opacity="0.65" /><text aria-hidden x={a.x + 4} y={a.y - 5} fontSize="10" fill={ink} fontFamily={mono}>{z.label.toUpperCase()}</text></g>; }
    if (z.kind === 'CHANNEL') { const c = centre(z.points); return <g key={z.id}><path d={path(z.points, false)} stroke={chan} strokeWidth="2.5" strokeDasharray="8 6" fill="none" opacity="0.6" /><text aria-hidden x={c.x + 8} y={c.y} fontSize="10" fill={chan} fontFamily={mono} opacity="0.9">{z.label.toUpperCase()}</text></g>; }
    if (z.kind === 'RESTRICTED') { const a = anchor(z.points); return <g key={z.id}><path d={path(z.points, true)} fill="#A33229" fillOpacity="0.08" stroke="#A33229" strokeDasharray="5 4" strokeWidth="1.5" opacity="0.8" /><text aria-hidden x={a.x + 4} y={a.y - 5} fontSize="10" fill="#A33229" fontFamily={mono}>{z.label.toUpperCase()}</text></g>; }
    const first = z.points[0];
    return (
      <g key={z.id}>
        {z.points.map((p, i) => <g key={i}><circle cx={X(p.lon)} cy={Y(p.lat)} r="7" fill="none" stroke={amber} strokeWidth="2" /><circle cx={X(p.lon)} cy={Y(p.lat)} r="2.4" fill={amber} /></g>)}
        <text aria-hidden x={X(first.lon) - 12} y={Y(first.lat) + 22} fontSize="10" fill={amber} fontFamily={mono}>{z.label.toUpperCase()}</text>
      </g>
    );
  };

  return (
    <>
      <PageHeader icon={RadarRoundedIcon} iconColor="#0B4F8A" title="Live traffic picture"
        sub={`${data.positions.length} tracked targets · ${openCases.length} open incident${openCases.length === 1 ? '' : 's'} on the picture · ${data.coverage}`}
        actions={<Button size="small" startIcon={<RefreshRoundedIcon />} onClick={load}>Refresh</Button>} />
      <Grid container spacing={2}>
        <Grid item xs={12} lg={8.5}>
          <Card sx={{ p: 1.5 }}>
            <Box sx={{ overflowX: 'auto' }}>
              <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`Traffic picture around ${port.name}`} style={{ width: '100%', minWidth: 640, display: 'block', borderRadius: 8 }}>
                <rect width={W} height={H} fill={seaDeep} />
                <rect width={W} height={H * 0.62} fill={sea} />
                {gridTicks(bbox.latMin, bbox.latMax).map((lat) => (
                  <g key={`lat${lat}`}>
                    <line x1="0" y1={Y(lat)} x2={W} y2={Y(lat)} stroke={ink} strokeOpacity="0.16" strokeDasharray="3 6" />
                    <text aria-hidden x="6" y={Y(lat) - 4} fontSize="10" fill={ink} fontFamily="IBM Plex Mono, monospace">{fmtLat(lat)}</text>
                  </g>
                ))}
                {gridTicks(bbox.lonMin, bbox.lonMax).map((lon) => (
                  <g key={`lon${lon}`}>
                    <line x1={X(lon)} y1="0" x2={X(lon)} y2={H} stroke={ink} strokeOpacity="0.16" strokeDasharray="3 6" />
                    <text aria-hidden x={X(lon) + 4} y={H - 8} fontSize="10" fill={ink} fontFamily="IBM Plex Mono, monospace">{fmtLon(lon)}</text>
                  </g>
                ))}
                {(data.zones || []).map(zone)}
                {/* the home port */}
                <g transform={`translate(${X(port.lon)},${Y(port.lat)})`}>
                  <rect x="-7" y="-7" width="14" height="14" fill={landLine} stroke={ink} strokeWidth="1.2" opacity="0.9" />
                  <text aria-hidden x="12" y="-6" fontSize="12" fontWeight="700" fill={ink} fontFamily="Archivo, sans-serif">{port.name.toUpperCase()}</text>
                </g>
                {/* vessels */}
                {onChart.map((p) => {
                  const sel = selected?.id === p.id;
                  const c = STATUS_COLOR[p.navStatus] || '#0B74B0';
                  const label = `${p.vessel.name} — ${STATUS_LABEL[p.navStatus] || words(p.navStatus)}, ${p.speed} kn, course ${String(p.course).padStart(3, '0')}°`;
                  return (
                    <g key={p.id} transform={`translate(${X(p.lon)},${Y(p.lat)})`} role="button" tabIndex={0} aria-pressed={sel} aria-label={label} style={{ cursor: 'pointer' }}
                      onClick={() => setSelected(sel ? null : p)} onKeyDown={activate(() => setSelected(sel ? null : p))}>
                      <title>{label}</title>
                      {sel && <circle r="14" fill={c} opacity="0.18" />}
                      <g transform={`rotate(${p.course})`}><path d="M0,-8 L5.5,7 L0,3.6 L-5.5,7 Z" fill={c} stroke={dark ? '#071A29' : '#fff'} strokeWidth="1.4" /></g>
                      {p.speed > 0.5 && <line x1="0" y1="0" x2="0" y2={-10 - p.speed} stroke={c} strokeWidth="1.4" transform={`rotate(${p.course})`} opacity="0.55" />}
                      {(sel || onChart.length <= 24) && (
                        <text aria-hidden x="9" y="4" fontSize="10.5" fontWeight={sel ? 700 : 500} fill={dark ? '#DCE7EA' : '#22404F'} fontFamily="Public Sans, sans-serif">{p.vessel.name.replace(/^M[VT] /, '')}</text>
                      )}
                    </g>
                  );
                })}
                {/* open incidents — the same picture the rescue coordination centre works from */}
                {openCases.map((i) => {
                  const { lat, lon } = posOf(i);
                  if (lat == null || lon == null || !inBbox(bbox, lat, lon)) return null;
                  const hot = ['HIGH', 'CRITICAL'].includes(i.severity);
                  const c = hot ? '#A33229' : i.severity === 'MEDIUM' ? '#9C6412' : '#4A6472';
                  return (
                    <g key={i.id} transform={`translate(${X(lon)},${Y(lat)})`} role="link" tabIndex={0} aria-label={`Open incident ${i.number}`} style={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/incidents/${i.id}`)} onKeyDown={activate(() => navigate(`/incidents/${i.id}`))}>
                      {hot && <circle r="13" fill={c} opacity="0.14" />}
                      <path d="M0,-7.5 L7,5.5 L-7,5.5 Z" fill="none" stroke={c} strokeWidth="2.2" strokeLinejoin="round" />
                      <circle cy="1.6" r="1.3" fill={c} />
                      <text aria-hidden x="10" y="4" fontSize="10" fontWeight="700" fill={c} fontFamily="IBM Plex Mono, monospace">{i.number}</text>
                    </g>
                  );
                })}
              </svg>
            </Box>
            <Box sx={SR_ONLY}>
              <Table aria-label="Tracked targets">
                <TableHead><TableRow><TableCell>Vessel</TableCell><TableCell>IMO</TableCell><TableCell>Status</TableCell><TableCell>Speed</TableCell><TableCell>Course</TableCell><TableCell>Position</TableCell><TableCell>Received</TableCell></TableRow></TableHead>
                <TableBody>
                  {data.positions.map((p) => (
                    <TableRow key={p.id}><TableCell>{p.vessel.name}</TableCell><TableCell>{p.vessel.imo}</TableCell><TableCell>{STATUS_LABEL[p.navStatus] || words(p.navStatus)}</TableCell><TableCell>{p.speed} kn</TableCell><TableCell>{String(p.course).padStart(3, '0')}°</TableCell><TableCell>{fmtLat(p.lat)} {fmtLon(p.lon)}</TableCell><TableCell>{fmtDT(p.receivedAt)}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            <Stack direction="row" spacing={1.5} sx={{ mt: 1, px: 0.5, flexWrap: 'wrap' }} useFlexGap>
              {(Object.keys(STATUS_LABEL) as NavStatus[]).map((k) => (
                <Stack key={k} direction="row" spacing={0.6} alignItems="center">
                  <Box aria-hidden sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: STATUS_COLOR[k] }} />
                  <Typography variant="caption" color="text.secondary">{STATUS_LABEL[k]}</Typography>
                </Stack>
              ))}
              <Stack direction="row" spacing={0.6} alignItems="center">
                <Box component="svg" viewBox="0 0 16 16" aria-hidden sx={{ width: 12, height: 12 }}><path d="M8,2 L14.5,13.5 L1.5,13.5 Z" fill="none" stroke="#A33229" strokeWidth="2" strokeLinejoin="round" /></Box>
                <Typography variant="caption" color="text.secondary">Open incident (click to open the case)</Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto !important' }}>Simulated AIS feed for demonstration — positions refresh every minute</Typography>
            </Stack>
          </Card>
        </Grid>
        <Grid item xs={12} lg={3.5}>
          <Stack spacing={2}>
            {selected && (
              <Card sx={{ p: 2 }} aria-live="polite">
                <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{selected.vessel.name}</Typography>
                <Typography variant="caption" color="text.secondary">IMO {selected.vessel.imo} · {selected.vessel.type} · {selected.vessel.flag}</Typography>
                <Divider sx={{ my: 1.25 }} />
                <Stack spacing={0.5}>
                  <Typography variant="body2">Status: <b>{words(selected.navStatus)}</b> · SOG <b>{selected.speed} kn</b> · COG <b>{String(selected.course).padStart(3, '0')}°</b></Typography>
                  <Typography variant="body2">Position: <b>{fmtLat(selected.lat)} {fmtLon(selected.lon)}</b></Typography>
                  <Typography variant="body2">Destination: <b>{selected.destination || '—'}</b> · {fromNow(selected.receivedAt)}</Typography>
                </Stack>
                <Button size="small" sx={{ mt: 1.5 }} variant="outlined" onClick={() => navigate(`/vessels/${selected.vessel.id}`)}>Open vessel record</Button>
              </Card>
            )}
            <Card>
              <Box sx={{ px: 2, py: 1.5 }}>
                <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>MDA alerts ({data.alerts.length})</Typography>
                <Typography variant="caption" color="text.secondary">Derived signals — advisory, never auto-enforcement</Typography>
              </Box>
              <Divider />
              <Stack divider={<Divider />} component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }} aria-label="Unacknowledged alerts">
                {data.alerts.map((a) => {
                  const who = a.vessel?.name || a.vesselName || 'Unknown target';
                  return (
                    <Box component="li" key={a.id} sx={{ p: 1.75, display: 'flex', gap: 1.25 }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          <Chip size="small" label={words(a.type)} color={ALERT_COLOR[a.severity]} variant="outlined" sx={{ height: 20, fontSize: 10 }} />
                          <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 700 }}>{who}</Typography>
                        </Stack>
                        <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>{a.note}</Typography>
                        <Typography variant="caption" color="text.secondary">{fromNow(a.at)}</Typography>
                      </Box>
                      {canAck && (
                        <Tooltip title="Acknowledge">
                          <IconButton size="small" aria-label={`Acknowledge ${words(a.type).toLowerCase()} — ${who}`} onClick={() => ack(a)}><DoneRoundedIcon fontSize="inherit" /></IconButton>
                        </Tooltip>
                      )}
                    </Box>
                  );
                })}
                {data.alerts.length === 0 && <Typography component="li" color="text.secondary" variant="body2" sx={{ p: 2, textAlign: 'center' }}>No unacknowledged alerts ✅</Typography>}
              </Stack>
            </Card>
          </Stack>
        </Grid>
      </Grid>
    </>
  );
}
