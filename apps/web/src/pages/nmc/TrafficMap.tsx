import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Box, Button, Chip, Divider, FormControlLabel, IconButton, InputAdornment, List, ListItem, ListItemButton, ListItemText, Paper, Stack, Switch, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Tooltip, Typography } from '@mui/material';
import RadarRoundedIcon from '@mui/icons-material/RadarRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import FullscreenRoundedIcon from '@mui/icons-material/FullscreenRounded';
import FullscreenExitRoundedIcon from '@mui/icons-material/FullscreenExitRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import DoneRoundedIcon from '@mui/icons-material/DoneRounded';
import HomeRoundedIcon from '@mui/icons-material/HomeRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import api from '../../api/client';
import { useAppDispatch, useAppSelector, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import { useProfile } from '../../config/runtime';
import PageHeader from '../../components/common/PageHeader';
import { fmtDT, fromNow } from '../../utils/format';
import { TargetLayer } from './traffic/TargetLayer';
import VesselCard from './traffic/VesselCard';
import { CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL, ageWords, flagEmoji, navLabel, type Category } from './traffic/legend';
import type { Layers, MdaAlert, OpenIncident, Target, TargetDetail, TargetTrack, TargetsResponse, WatchItem } from './types';

/* The live traffic picture.
 *
 * A real map, every ship the feed reports drawn on it — arrows under way, dots stopped, coloured by class, clustered
 * where the zoom cannot hold them — and a card for any of them: silhouette, flag, voyage, last report, her track on
 * request. The register's own ships are outlined and carry their case files; everyone else is traffic. Ports, the
 * published sea areas, the chart's own zones and the open incidents are layers a person switches. */
const TILES = (import.meta.env.VITE_MAP_TILES as string | undefined) || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = (import.meta.env.VITE_MAP_ATTRIBUTION as string | undefined) || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const SR_ONLY = { position: 'absolute', width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 } as const;
const ZONE_STYLE: Record<string, L.PathOptions> = {
  ANCHORAGE: { color: '#9C6412', weight: 1.5, dashArray: '5 4', fillOpacity: 0.05 }, CHANNEL: { color: '#0B74B0', weight: 2.5, dashArray: '8 6', fill: false },
  RESTRICTED: { color: '#A33229', weight: 1.5, dashArray: '5 4', fillOpacity: 0.08 }, PORT_LIMIT: { color: '#4A6472', weight: 1.2, dashArray: '3 5', fillOpacity: 0.03 },
  TSS: { color: '#75479C', weight: 1.2, dashArray: '2 6', fillOpacity: 0.03 }, FISHING: { color: '#F2861F', weight: 1.2, dashArray: '3 5', fillOpacity: 0.03 }, CUSTOM: { color: '#4A6472', weight: 1.2, dashArray: '3 5', fillOpacity: 0.03 },
};
const words = (s?: string) => String(s || '').replace(/_/g, ' ');
interface FeedSourceStatus { source: string; label: string; lastStatus: string; lastMode: string | null; ageMinutes: number | null; received: number; matched: number; pollMinutes: number; lastError?: string | null }
type FeedStatus = FeedSourceStatus & { sources?: FeedSourceStatus[] };
const FEED_SHORT: Record<string, string> = { 'ais-lrit': 'AIS', lrit: 'LRIT' };
// the chip stays short so the header holds both feeds on one line; the cadence and any error sit in its tooltip
const feedChip = (f: FeedSourceStatus) => (f.lastStatus === 'never' ? `${FEED_SHORT[f.source] ?? f.source} · not read yet` : `${FEED_SHORT[f.source] ?? f.source} · ${f.lastMode ?? ''} · ${f.lastStatus}${f.ageMinutes != null ? ` · ${f.ageMinutes} min` : ''}`);
const feedTip = (f: FeedSourceStatus) => `${f.label || f.source}: read every ${f.pollMinutes} min${f.lastError ? ` — ${f.lastError}` : ''}`;
const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number) => { let t: ReturnType<typeof setTimeout> | undefined; return (...a: A) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export default function TrafficMap() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const user = useUser();
  const profile = useProfile();
  const mode = useAppSelector((s) => s.ui.mode);
  const dark = mode === 'dark';
  const canAck = hasPerm(user, 'nmc.manage');
  const [data, setData] = useState<TargetsResponse | null>(null);
  const [layers, setLayers] = useState<Layers | null>(null);
  const [alerts, setAlerts] = useState<MdaAlert[]>([]);
  const [openCases, setOpenCases] = useState<OpenIncident[]>([]);
  const [watch, setWatch] = useState<WatchItem[]>([]);
  const [feed, setFeed] = useState<FeedStatus | null>(null);
  const [selected, setSelected] = useState<TargetDetail | null>(null);
  const [track, setTrack] = useState<TargetTrack | null>(null);
  const [hidden, setHidden] = useState<Set<Category>>(new Set());
  const [showPorts, setShowPorts] = useState(true);
  const [showAreas, setShowAreas] = useState(true);
  const [showIncidents, setShowIncidents] = useState(true);
  const [panel, setPanel] = useState<'alerts' | 'fleet'>('alerts');
  const [panelOpen, setPanelOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Target[]>([]);
  const [full, setFull] = useState(false);
  const [zoom, setZoom] = useState(9);
  const stage = useRef<HTMLDivElement>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<TargetLayer | null>(null);
  const groups = useRef<{ ports: L.LayerGroup; portLabels: L.LayerGroup; areas: L.LayerGroup; incidents: L.LayerGroup; track: L.LayerGroup } | null>(null);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  const home = layers?.home ?? profile.portGeo ?? { name: 'Home port', lat: 24.81, lon: 54.64, zoomKm: 25 };

  /* ------------------------------------------------------------------------------- data --- */
  const loadTargets = useCallback(() => {
    const m = map.current; if (!m) return;
    const b = m.getBounds();
    const params: Record<string, string | number> = { minLat: b.getSouth(), maxLat: b.getNorth(), minLon: b.getWest(), maxLon: b.getEast(), zoom: m.getZoom(), limit: 2500 };
    const shown = CATEGORIES.filter((c) => !hiddenRef.current.has(c));
    if (shown.length < CATEGORIES.length) params.categories = shown.join(',');
    api.get<TargetsResponse>('/tracking/targets', { params, headers: { 'X-Quiet': '1' } }).then((r) => { setData(r.data); layer.current?.setState({ targets: r.data.targets, clusters: r.data.clusters }); }).catch(err);
  }, [err]);
  const loadSide = useCallback(() => {
    api.get<{ items: MdaAlert[] } | MdaAlert[]>('/tracking/alerts', { params: { acknowledged: 'false', limit: 20 }, headers: { 'X-Quiet': '1' } }).then((r) => setAlerts(Array.isArray(r.data) ? r.data : r.data.items ?? [])).catch(() => setAlerts([]));
    api.get<OpenIncident[]>('/incidents', { params: { open: 'true', limit: 50 }, headers: { 'X-Quiet': '1' } }).then((r) => setOpenCases(r.data || [])).catch(() => setOpenCases([]));
    api.get<typeof feed>('/tracking/feed', { headers: { 'X-Quiet': '1' } }).then((f) => setFeed(f.data)).catch(() => setFeed(null));
    api.get<WatchItem[]>('/tracking/watch', { headers: { 'X-Quiet': '1' } }).then((r) => { setWatch(r.data); layer.current?.setState({ watched: new Set(r.data.map((w) => w.mmsi)) }); }).catch(() => setWatch([]));
  }, []);
  const refresh = useCallback(() => { loadTargets(); loadSide(); }, [loadTargets, loadSide]);
  const select = useCallback((t: Target | null) => {
    setTrack(null); groups.current?.track.clearLayers();
    if (!t) { setSelected(null); layer.current?.setState({ selected: null }); return; }
    layer.current?.setState({ selected: t.mmsi });
    api.get<TargetDetail>(`/tracking/targets/${encodeURIComponent(t.mmsi)}`).then((r) => setSelected(r.data)).catch(err);
  }, [err]);

  /* -------------------------------------------------------------------------------- map --- */
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = L.map(mapEl.current, { zoomControl: true, attributionControl: true, worldCopyJump: true, minZoom: 2, maxZoom: 18 });
    m.setView([home.lat, home.lon], 9);
    L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19, crossOrigin: true }).addTo(m);
    const g = { ports: L.layerGroup().addTo(m), portLabels: L.layerGroup().addTo(m), areas: L.layerGroup().addTo(m), incidents: L.layerGroup().addTo(m), track: L.layerGroup().addTo(m) };
    groups.current = g;
    const tl = new TargetLayer((t) => select(t), dark);
    tl.addTo(m); layer.current = tl;
    const onMove = debounce(() => loadTargets(), 250);
    m.on('moveend', onMove);
    m.on('zoomend', () => { setZoom(m.getZoom()); if (m.getZoom() >= 8) { if (!m.hasLayer(g.portLabels)) g.portLabels.addTo(m); } else if (m.hasLayer(g.portLabels)) m.removeLayer(g.portLabels); });
    map.current = m;
    api.get<Layers>('/tracking/layers', { headers: { 'X-Quiet': '1' } }).then((r) => { setLayers(r.data); m.setView([r.data.home.lat, r.data.home.lon], 9); }).catch(() => {});
    loadTargets(); loadSide();
    const timer = setInterval(() => { loadTargets(); loadSide(); }, 60_000);
    return () => { clearInterval(timer); m.remove(); map.current = null; layer.current = null; groups.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the layers people switch, redrawn when the data or the switch changes
  useEffect(() => {
    const g = groups.current; const m = map.current; if (!g || !m) return;
    g.ports.clearLayers(); g.portLabels.clearLayers();
    if (showPorts && layers) for (const p of layers.ports) {
      L.circleMarker([p.lat, p.lon], { radius: 5, color: dark ? '#E6EEF2' : '#1B2A33', weight: 1.5, fillColor: '#F2C94C', fillOpacity: 0.95 }).bindTooltip(`${p.name} (${p.code})`).addTo(g.ports)
        .on('click', () => m.setView([p.lat, p.lon], Math.max(m.getZoom(), 11)));
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'maritime-port-label', html: `<span style="font:600 11px 'Public Sans',sans-serif;color:${dark ? '#E6EEF2' : '#1B2A33'};text-shadow:0 0 3px ${dark ? '#0B1B26' : '#fff'},0 0 3px ${dark ? '#0B1B26' : '#fff'};white-space:nowrap;padding-left:9px">${p.name}</span>`, iconSize: [0, 0], iconAnchor: [0, 6] }), interactive: false, keyboard: false }).addTo(g.portLabels);
    }
    if (m.getZoom() < 8 && m.hasLayer(g.portLabels)) m.removeLayer(g.portLabels);
  }, [layers, showPorts, dark]);
  useEffect(() => {
    const g = groups.current; if (!g || !layers) return;
    g.areas.clearLayers();
    if (!showAreas) return;
    for (const a of layers.areas) L.geoJSON(a.geojson as never, { style: ZONE_STYLE[a.kind] ?? ZONE_STYLE.CUSTOM }).bindTooltip(`${a.name} — ${a.kind.replace(/_/g, ' ').toLowerCase()}${a.alertOn !== 'NONE' ? ` · alerts on ${a.alertOn.toLowerCase()}` : ''}`, { sticky: true }).addTo(g.areas);
    for (const z of [...layers.zones, ...layers.restrictions]) {
      if (z.kind === 'LAND' || !z.points.length) continue;
      const pts = z.points.map((p) => [p.lat, p.lon] as [number, number]);
      const style = z.kind === 'RESTRICTED' ? { color: '#A33229', weight: 1.5, dashArray: '5 4', fillOpacity: 0.1 } : ZONE_STYLE[z.kind] ?? ZONE_STYLE.CUSTOM;
      const shape = z.kind === 'CHANNEL' ? L.polyline(pts, style) : z.kind === 'SPM' ? L.layerGroup(pts.map((p) => L.circleMarker(p, { radius: 7, color: '#9C6412', weight: 2, fill: false }))) : L.polygon(pts, style);
      (shape as L.Layer).addTo(g.areas);
      if ('bindTooltip' in shape) (shape as L.Path).bindTooltip(z.label, { sticky: true });
    }
  }, [layers, showAreas]);
  useEffect(() => {
    const g = groups.current; const m = map.current; if (!g || !m) return;
    g.incidents.clearLayers();
    if (!showIncidents) return;
    // cases within a marker's width of each other share one marker: two touch targets on top of each other are neither
    const placed: { x: number; y: number; cases: OpenIncident[]; lat: number; lon: number }[] = [];
    for (const i of openCases) {
      const lat = i.position?.lat ?? i.location?.lat; const lon = i.position?.lon ?? i.location?.lon;
      if (lat == null || lon == null) continue;
      const pt = m.latLngToContainerPoint([lat, lon]);
      const near = placed.find((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < 32);
      if (near) near.cases.push(i); else placed.push({ x: pt.x, y: pt.y, cases: [i], lat, lon });
    }
    for (const p of placed) {
      const top = p.cases.reduce((a, b) => (['HIGH', 'CRITICAL'].includes(b.severity) && !['HIGH', 'CRITICAL'].includes(a.severity) ? b : a), p.cases[0]);
      const hot = ['HIGH', 'CRITICAL'].includes(top.severity); const c = hot ? '#A33229' : top.severity === 'MEDIUM' ? '#9C6412' : '#4A6472';
      const many = p.cases.length > 1;
      const label = many ? `${p.cases.length} open incidents here: ${p.cases.map((x) => x.number).join(', ')}` : `Open incident ${top.number}, ${top.severity.toLowerCase()} severity`;
      const badge = many ? `<circle cx="9" cy="-9" r="7" fill="${c}"/><text x="9" y="-6" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="Public Sans, sans-serif">${p.cases.length}</text>` : '';
      const marker = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'maritime-incident', html: `<svg width="28" height="28" viewBox="-14 -14 28 28" aria-hidden><path d="M0,-9 L9,7 L-9,7 Z" fill="${hot ? c + '33' : 'none'}" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/><circle cy="2.5" r="1.6" fill="${c}"/>${badge}</svg>`, iconSize: [28, 28], iconAnchor: [14, 14] }), keyboard: true, alt: label })
        .bindTooltip(many ? p.cases.map((x) => `${x.number} — ${x.severity}`).join('<br/>') : `${top.number} — ${top.severity}`)
        .on('click', () => navigate(many ? '/incidents?open=true' : `/incidents/${top.id}`)).addTo(g.incidents);
      marker.getElement()?.setAttribute('aria-label', label);
    }
  }, [openCases, showIncidents, navigate, zoom]);
  useEffect(() => { layer.current?.setState({ hidden }); loadTargets(); }, [hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = () => { const f = document.fullscreenElement === stage.current; setFull(f); setTimeout(() => map.current?.invalidateSize(), 50); };
    document.addEventListener('fullscreenchange', on); return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  /* ---------------------------------------------------------------------------- actions --- */
  const toggleTrack = () => {
    const g = groups.current; if (!selected || !g) return;
    if (track) { setTrack(null); g.track.clearLayers(); return; }
    api.get<TargetTrack>(`/tracking/targets/${encodeURIComponent(selected.mmsi)}/track`, { params: { hours: 24 } }).then((r) => {
      setTrack(r.data); g.track.clearLayers();
      const pts = r.data.track.map((p) => [p.lat, p.lon] as [number, number]);
      if (pts.length) { pts.push([selected.lat, selected.lon]); L.polyline(pts, { color: CATEGORY_COLOR[selected.category], weight: 2.5, opacity: 0.85 }).addTo(g.track); for (const p of r.data.track) L.circleMarker([p.lat, p.lon], { radius: 2.5, color: CATEGORY_COLOR[selected.category], fillOpacity: 1, weight: 1 }).bindTooltip(`${fmtDT(p.receivedAt)} · ${p.sog} kn`).addTo(g.track); }
      if (!r.data.track.length) dispatch(notify('No track is held for her yet — points are kept as reports arrive'));
    }).catch(err);
  };
  const centreOn = (t: Target) => { map.current?.setView([t.lat, t.lon], Math.max(map.current.getZoom(), 11)); select(t); setResults([]); setQuery(''); };
  const search = useMemo(() => debounce((q: string) => { if (q.trim().length < 2) { setResults([]); return; } api.get<Target[]>('/tracking/targets/search', { params: { q, limit: 8 }, headers: { 'X-Quiet': '1' } }).then((r) => setResults(r.data)).catch(() => setResults([])); }, 220), []);
  const ack = (a: MdaAlert) => api.post(`/tracking/alerts/${a.id}/ack`).then(loadSide).catch(err);
  // both feeds are read: the AIS picture and the LRIT data centre, each reported in its own words
  const readFeed = () => Promise.all((feed?.sources ?? [{ source: 'ais-lrit' }]).map((f) => api.post<{ source: string; status: string; received: number; matched: number; targets?: number; error?: string }>('/tracking/feed/poll', null, { params: { source: f.source } }).then((r) => r.data)))
    .then((outs) => { dispatch(notify(`Feed read: ${outs.map((o) => `${FEED_SHORT[o.source] ?? o.source} ${o.status === 'ok' ? `${o.received} reports, ${o.targets ?? 0} on the picture, ${o.matched} on the register` : `${o.status}${o.error ? ` — ${o.error}` : ''}`}`).join(' · ')}`)); refresh(); }).catch(err);
  const toggleFull = () => { if (document.fullscreenElement) document.exitFullscreen?.(); else stage.current?.requestFullscreen?.(); };
  const onFollow = (following: boolean) => { if (selected) setSelected({ ...selected, following }); loadSide(); dispatch(notify(following ? 'Added to your fleet' : 'Removed from your fleet')); };
  const feeds: FeedSourceStatus[] = feed ? (feed.sources?.length ? feed.sources : [feed]) : [];
  const visible = data?.targets.filter((t) => !hidden.has(t.category)) ?? [];

  return (
    <>
      <PageHeader icon={RadarRoundedIcon} iconColor="#0B4F8A" title="Live traffic picture"
        sub={data ? `${data.totals.all.toLocaleString('en-GB')} ships on the picture · ${data.totals.registered} on the register · ${data.total.toLocaleString('en-GB')} in view · ${data.coverage}` : 'Loading the picture…'}
        actions={<Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          {feeds.map((f, i) => <Tooltip key={f.source} title={feedTip(f)}><Chip size="small" label={feedChip(f)} color={f.lastStatus === 'ok' ? 'success' : f.lastStatus === 'never' ? 'default' : 'warning'} variant="outlined" data-testid={i === 0 ? 'feed-status' : `feed-status-${f.source}`} /></Tooltip>)}
          {data?.thresholds && <Chip size="small" variant="outlined" data-testid="surveillance-thresholds" onClick={() => navigate('/settings/module/ops')} label={`Alerts at: channel ${data.thresholds.channelSpeedLimitKn} kn · AIS gap ${data.thresholds.aisGapAlertMin} min · drift ${data.thresholds.anchorDriftNm} nm`} />}
          {canAck && <Button size="small" variant="outlined" onClick={readFeed} data-testid="feed-read">Read feed now</Button>}
          <Button size="small" startIcon={<RefreshRoundedIcon />} onClick={refresh}>Refresh</Button>
          <Button size="small" variant="outlined" startIcon={<FullscreenRoundedIcon />} onClick={toggleFull} data-testid="map-fullscreen">Full screen</Button>
        </Stack>} />
      <Box ref={stage} data-testid="traffic-stage" sx={{ position: 'relative', height: full ? '100vh' : 'calc(100vh - 200px)', minHeight: 560, borderRadius: full ? 0 : 2, overflow: 'hidden', bgcolor: dark ? '#0B1B26' : '#D7E7EF', '& .leaflet-tile-pane': dark ? { filter: 'invert(1) hue-rotate(190deg) brightness(0.86) saturate(0.7)' } : undefined, '& .leaflet-container': { fontFamily: 'inherit' }, '& .leaflet-div-icon': { background: 'none', border: 0 } }}>
        <div ref={mapEl} style={{ position: 'absolute', inset: 0 }} aria-label="Traffic map" role="application" />

        {/* search, legend and layers — top left */}
        <Stack spacing={1} sx={{ position: 'absolute', top: 12, left: 56, zIndex: 1000, width: 300, maxWidth: 'calc(100% - 72px)' }}>
          <Paper sx={{ p: 0.5 }} elevation={4}>
            <TextField size="small" fullWidth placeholder="Search a ship — name, MMSI, IMO" value={query} onChange={(e) => { setQuery(e.target.value); search(e.target.value); }} inputProps={{ 'aria-label': 'Search a ship' }} data-testid="traffic-search"
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchRoundedIcon fontSize="small" /></InputAdornment> }} />
            {results.length > 0 && (
              <List dense disablePadding data-testid="traffic-search-results" sx={{ maxHeight: 260, overflowY: 'auto' }}>
                {results.map((t) => (
                  <ListItem key={t.mmsi} disablePadding><ListItemButton onClick={() => centreOn(t)}>
                    <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: CATEGORY_COLOR[t.category], mr: 1, flexShrink: 0 }} aria-hidden />
                    <ListItemText primary={`${flagEmoji(t.flag)} ${t.name}`} secondary={`${t.typeLabel} · ${navLabel(t.navStatus)} · ${ageWords(t.receivedAt)}${t.registered ? ' · on the register' : ''}`} primaryTypographyProps={{ noWrap: true, fontWeight: 600, fontSize: 13 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} />
                  </ListItemButton></ListItem>
                ))}
              </List>
            )}
          </Paper>
          <Paper sx={{ p: 1.25 }} elevation={4} data-testid="traffic-legend">
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, letterSpacing: 0.5 }}>VESSEL TYPES</Typography>
            <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5} sx={{ mt: 0.5 }}>
              {CATEGORIES.map((c) => (
                <Chip key={c} size="small" label={CATEGORY_LABEL[c]} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(c)) n.delete(c); else n.add(c); return n; })}
                  variant={hidden.has(c) ? 'outlined' : 'filled'} aria-pressed={!hidden.has(c)}
                  sx={{ height: 24, fontSize: 11, bgcolor: hidden.has(c) ? 'transparent' : `${CATEGORY_COLOR[c]}33`, borderColor: CATEGORY_COLOR[c], '& .MuiChip-label': { pl: 0.75 }, opacity: hidden.has(c) ? 0.55 : 1 }}
                  icon={<Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: CATEGORY_COLOR[c], ml: 0.75 }} aria-hidden />} />
              ))}
            </Stack>
            <Divider sx={{ my: 1 }} />
            <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1}>
              <FormControlLabel control={<Switch size="small" checked={showPorts} onChange={(e) => setShowPorts(e.target.checked)} />} label={<Typography variant="caption">Ports</Typography>} />
              <FormControlLabel control={<Switch size="small" checked={showAreas} onChange={(e) => setShowAreas(e.target.checked)} />} label={<Typography variant="caption">Sea areas</Typography>} />
              <FormControlLabel control={<Switch size="small" checked={showIncidents} onChange={(e) => setShowIncidents(e.target.checked)} />} label={<Typography variant="caption">Incidents</Typography>} />
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>Outlined arrows are ships on the register. {zoom < 11 ? 'Zoom in for names.' : ''}{data?.clustered ? ` ${data.total.toLocaleString('en-GB')} in view — clustered.` : ''}</Typography>
          </Paper>
        </Stack>

        {/* the home button — back to the port */}
        <Tooltip title={`Back to ${home.name}`}><IconButton aria-label={`Back to ${home.name}`} onClick={() => map.current?.setView([home.lat, home.lon], 9)} sx={{ position: 'absolute', left: 12, top: 90, zIndex: 1000, bgcolor: 'background.paper', boxShadow: 2, '&:hover': { bgcolor: 'background.paper' } }} size="small"><HomeRoundedIcon fontSize="small" /></IconButton></Tooltip>

        {/* the card and the side panel — right */}
        <Stack spacing={1} sx={{ position: 'absolute', top: 12, right: 12, bottom: 12, zIndex: 1000, alignItems: 'flex-end', overflowY: 'auto', overflowX: 'hidden', pr: 0.25, '&::-webkit-scrollbar': { width: 6 } }}>
          {selected && <VesselCard target={selected} trackShown={!!track} onClose={() => select(null)} onTrack={toggleTrack} onFollow={onFollow} />}
          {track && <Chip size="small" label={`Track: ${track.summary.fixes} fixes · ${track.summary.distanceNm} nm · max ${track.summary.maxSpeedKn} kn over ${track.hours} h`} sx={{ bgcolor: 'background.paper' }} data-testid="track-summary" />}
          <Paper elevation={4} sx={{ width: panelOpen ? 320 : 'auto', maxWidth: 'calc(100vw - 24px)', display: 'flex', flexDirection: 'column', flex: '0 0 auto', maxHeight: selected ? 280 : '100%', minHeight: panelOpen ? 120 : 0 }} data-testid="traffic-side-panel">
            <Stack direction="row" alignItems="center">
              <IconButton size="small" onClick={() => setPanelOpen((o) => !o)} aria-label={panelOpen ? 'Collapse the side panel' : 'Open the side panel'} aria-expanded={panelOpen}>{panelOpen ? <ChevronRightRoundedIcon fontSize="small" /> : <ChevronLeftRoundedIcon fontSize="small" />}</IconButton>
              {panelOpen && <Tabs value={panel} onChange={(_, v) => setPanel(v)} sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0.5, fontSize: 12 } }}><Tab value="alerts" label={`Alerts (${alerts.length})`} /><Tab value="fleet" label={`My fleet (${watch.length})`} /></Tabs>}
            </Stack>
            {panelOpen && panel === 'alerts' && (
              <Stack component="ul" sx={{ listStyle: 'none', m: 0, p: 0, overflowY: 'auto', '& > li + li': { borderTop: 1, borderColor: 'divider' } }} aria-label="Unacknowledged alerts">
                {alerts.map((a) => {
                  const who = a.vessel?.name || a.vesselName || 'Unknown target';
                  return (
                    <Box component="li" key={a.id} sx={{ p: 1.25, display: 'flex', gap: 1 }}>
                      <Box sx={{ flex: 1, minWidth: 0, cursor: a.vesselId ? 'pointer' : 'default' }} onClick={() => { if (a.vesselId) api.get<TargetDetail>(`/tracking/targets/vessel:${a.vesselId}`).then((r) => centreOn(r.data)).catch(() => {}); }}>
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          <Chip size="small" label={words(a.type)} color={a.severity === 'error' ? 'error' : a.severity === 'warning' ? 'warning' : 'info'} variant="outlined" sx={{ height: 20, fontSize: 10 }} />
                          <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 700 }}>{who}</Typography>
                        </Stack>
                        <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.25 }}>{a.note}</Typography>
                        <Typography variant="caption" color="text.secondary">{fromNow(a.at)}</Typography>
                      </Box>
                      {canAck && <Tooltip title="Acknowledge"><IconButton size="small" aria-label={`Acknowledge ${words(a.type).toLowerCase()} — ${who}`} onClick={() => ack(a)}><DoneRoundedIcon fontSize="inherit" /></IconButton></Tooltip>}
                    </Box>
                  );
                })}
                {alerts.length === 0 && <Typography component="li" color="text.secondary" variant="body2" sx={{ p: 2, textAlign: 'center' }}>No unacknowledged alerts</Typography>}
              </Stack>
            )}
            {panelOpen && panel === 'fleet' && (
              <List dense sx={{ overflowY: 'auto', py: 0 }} aria-label="My fleet" data-testid="my-fleet">
                {watch.map((w) => (
                  <ListItem key={w.mmsi} disablePadding><ListItemButton onClick={() => { if (w.target) centreOn(w.target); }}>
                    <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: w.target ? CATEGORY_COLOR[w.target.category] : '#8A96A3', mr: 1, flexShrink: 0 }} aria-hidden />
                    <ListItemText primary={`${flagEmoji(w.target?.flag)} ${w.name}`} secondary={w.target ? `${navLabel(w.target.navStatus)} · ${w.target.sog.toFixed(1)} kn · ${ageWords(w.target.receivedAt)}` : 'No position held'} primaryTypographyProps={{ noWrap: true, fontWeight: 600, fontSize: 13 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} />
                  </ListItemButton></ListItem>
                ))}
                {watch.length === 0 && <ListItem><Typography color="text.secondary" variant="body2" sx={{ p: 1, textAlign: 'center', width: '100%' }}>Add a ship to your fleet from her card</Typography></ListItem>}
              </List>
            )}
          </Paper>
        </Stack>
        {full && <Button size="small" variant="contained" startIcon={<FullscreenExitRoundedIcon />} onClick={toggleFull} sx={{ position: 'absolute', bottom: 24, right: 12, zIndex: 1000 }}>Exit full screen</Button>}
        <Typography variant="caption" sx={{ position: 'absolute', bottom: 2, left: 12, zIndex: 1000, color: 'text.secondary', bgcolor: 'background.paper', px: 0.75, borderRadius: 1, opacity: 0.9 }}>{data ? `Updated ${fromNow(data.generatedAt)} · refreshes every minute` : ''}</Typography>
      </Box>
      <Box sx={SR_ONLY}>
        <Table aria-label="Targets in view">
          <TableHead><TableRow><TableCell>Vessel</TableCell><TableCell>Type</TableCell><TableCell>Status</TableCell><TableCell>Speed</TableCell><TableCell>Course</TableCell><TableCell>Received</TableCell></TableRow></TableHead>
          <TableBody>{visible.slice(0, 200).map((t) => <TableRow key={t.mmsi}><TableCell>{t.name}</TableCell><TableCell>{t.typeLabel}</TableCell><TableCell>{navLabel(t.navStatus)}</TableCell><TableCell>{t.sog} kn</TableCell><TableCell>{String(t.cog).padStart(3, '0')}°</TableCell><TableCell>{fmtDT(t.receivedAt)}</TableCell></TableRow>)}</TableBody>
        </Table>
      </Box>
    </>
  );
}
