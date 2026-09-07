import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Box } from '@mui/material';
import { useAppSelector } from '../../../store';
import type { AnalyticsCell, AnalyticsData } from './types';
import type { SeaArea } from '../types';

/* The period on the map: a rectangle per cell, shaded by the ships heard in it; an arrow in the cells where the
 * courses agreed; the published sea areas outlined so the dwell figures have a place. Same tiles and dark treatment
 * as the live picture; nothing here is interactive beyond pan and zoom, and every cell carries its figures as a
 * tooltip for the reader who wants the number behind the shade. */
const TILES = (import.meta.env.VITE_MAP_TILES as string | undefined) || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = (import.meta.env.VITE_MAP_ATTRIBUTION as string | undefined) || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const SHADE = '#0B74B0'; const LANE = '#B3261E'; const AREA = '#4A6472';

/** The arrow for a lane: a line along the bearing across most of the cell, with a head. */
function arrow(c: AnalyticsCell, dLat: number, dLon: number): [number, number][][] {
  const rad = ((c.bearing ?? 0) * Math.PI) / 180;
  const len = 0.42; const head = 0.14; const spread = 0.5;
  const tip: [number, number] = [c.lat + Math.cos(rad) * dLat * len, c.lon + Math.sin(rad) * dLon * len];
  const tail: [number, number] = [c.lat - Math.cos(rad) * dLat * len, c.lon - Math.sin(rad) * dLon * len];
  const wing = (sign: number): [number, number] => [tip[0] - Math.cos(rad + sign * spread) * dLat * head, tip[1] - Math.sin(rad + sign * spread) * dLon * head];
  return [[tail, tip], [wing(1), tip, wing(-1)]];
}

export default function DensityMap({ data, areas, home }: { data: AnalyticsData | null; areas: SeaArea[]; home: { lat: number; lon: number } }) {
  const dark = useAppSelector((s) => s.ui.mode) === 'dark';
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const groups = useRef<{ cells: L.LayerGroup; lanes: L.LayerGroup; areas: L.LayerGroup } | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true, minZoom: 2, maxZoom: 16 });
    m.setView([home.lat, home.lon], 8);
    L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19, crossOrigin: true }).addTo(m);
    groups.current = { areas: L.layerGroup().addTo(m), cells: L.layerGroup().addTo(m), lanes: L.layerGroup().addTo(m) };
    map.current = m;
    return () => { m.remove(); map.current = null; groups.current = null; };
    // the map is built once; the home comes with the first layers answer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const g = groups.current; if (!g) return;
    g.areas.clearLayers();
    for (const a of areas) {
      const ring = a.geojson?.coordinates?.[0] ?? [];
      if (ring.length < 3) continue;
      L.polygon(ring.map(([lon, lat]) => [lat, lon] as [number, number]), { color: AREA, weight: 1.2, dashArray: '4 5', fillOpacity: 0.03, interactive: false }).addTo(g.areas);
    }
  }, [areas]);

  useEffect(() => {
    const g = groups.current; const m = map.current; if (!g || !m) return;
    g.cells.clearLayers(); g.lanes.clearLayers();
    if (!data || !data.cells.length) return;
    const { dLat, dLon } = data.grid;
    const max = Math.max(1, ...data.cells.map((c) => c.ships));
    const bounds = L.latLngBounds([]);
    for (const c of data.cells) {
      const rect = L.rectangle([[c.lat - dLat / 2, c.lon - dLon / 2], [c.lat + dLat / 2, c.lon + dLon / 2]], { stroke: false, fillColor: SHADE, fillOpacity: 0.12 + 0.6 * Math.sqrt(c.ships / max), interactive: true });
      rect.bindTooltip(`${c.ships} ships · ${c.fixes} fixes${c.moving ? ` · ${c.meanSog} kn under way` : ''}${c.bearing != null ? ` · courses agree ${Math.round(c.flow * 100)}% on ${c.bearing}°` : ''}`, { sticky: true });
      rect.addTo(g.cells);
      bounds.extend(rect.getBounds());
    }
    for (const c of data.lanes) for (const line of arrow(c, dLat, dLon)) L.polyline(line, { color: LANE, weight: 2.2, opacity: 0.9, interactive: false }).addTo(g.lanes);
    if (!fitted.current && bounds.isValid()) { m.fitBounds(bounds.pad(0.15), { maxZoom: 10 }); fitted.current = true; }
  }, [data]);

  return <Box ref={el} data-testid="analytics-map" role="region" aria-label="Traffic density and lanes on the map" sx={{ height: 440, borderRadius: 1.5, overflow: 'hidden', bgcolor: dark ? '#0B1B26' : '#D7E7EF', '& .leaflet-tile-pane': dark ? { filter: 'invert(1) hue-rotate(190deg) brightness(0.85) contrast(0.9)' } : {} }} />;
}
