import L from 'leaflet';
import { CATEGORY_COLOR, isMoving, type Category } from './legend';
import type { Target, TargetCluster } from '../types';

/* The targets, drawn on one canvas.
 *
 * A picture with thousands of ships cannot be thousands of DOM nodes, so the layer paints them itself: an arrow for a
 * ship under way, turned to her course and coloured by her class; a dot for one stopped; a count in a circle where the
 * server clustered a crowded cell. Names appear when the zoom leaves room for them, and a grid keeps them from
 * overprinting. A click is answered with the nearest target within a few pixels. */

export interface LayerState { targets: Target[]; clusters: TargetCluster[]; selected: string | null; watched: Set<string>; hidden: Set<Category> }
const ARROW = 7; const DOT = 4;

export class TargetLayer extends L.Layer {
  private canvas: HTMLCanvasElement | null = null;
  private state: LayerState = { targets: [], clusters: [], selected: null, watched: new Set(), hidden: new Set() };
  private frame = 0;
  private hits: { x: number; y: number; t: Target }[] = [];
  private mapRef: L.Map | null = null;
  constructor(private readonly onPick: (t: Target | null) => void, private readonly dark = false) { super(); }

  onAdd(map: L.Map): this {
    this.mapRef = map;
    const canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated maritime-targets') as HTMLCanvasElement;
    canvas.style.position = 'absolute'; canvas.style.pointerEvents = 'none';
    canvas.setAttribute('role', 'img');
    this.canvas = canvas;
    map.getPanes().overlayPane.appendChild(canvas);
    map.on('moveend zoomend viewreset resize', this.schedule, this);
    map.on('zoomanim', this.onZoomAnim, this);
    map.on('click', this.onClick, this);
    this.schedule();
    return this;
  }
  onRemove(map: L.Map): this {
    map.off('moveend zoomend viewreset resize', this.schedule, this);
    map.off('zoomanim', this.onZoomAnim, this);
    map.off('click', this.onClick, this);
    this.canvas?.remove(); this.canvas = null; this.mapRef = null;
    return this;
  }
  setState(next: Partial<LayerState>) { this.state = { ...this.state, ...next }; this.schedule(); }

  private onZoomAnim(e: L.ZoomAnimEvent) {
    if (!this.canvas || !this.mapRef) return;
    const scale = this.mapRef.getZoomScale(e.zoom);
    const offset = this.mapRef['_latLngBoundsToNewLayerBounds' as keyof L.Map] ? null : null;
    void offset;
    const origin = this.mapRef.latLngToLayerPoint(this.mapRef.getBounds().getNorthWest());
    L.DomUtil.setTransform(this.canvas, origin, scale);
  }
  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }
  private onClick(e: L.LeafletMouseEvent) {
    if (!this.mapRef) return;
    const p = this.mapRef.latLngToContainerPoint(e.latlng);
    let best: { d: number; t: Target } | null = null;
    for (const h of this.hits) { const d = Math.hypot(h.x - p.x, h.y - p.y); if (d <= 12 && (!best || d < best.d)) best = { d, t: h.t }; }
    this.onPick(best ? best.t : null);
  }

  draw() {
    const map = this.mapRef; const canvas = this.canvas;
    if (!map || !canvas) return;
    const size = map.getSize();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = size.x * ratio; canvas.height = size.y * ratio; canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    const zoom = map.getZoom();
    const { targets, clusters, selected, watched, hidden } = this.state;
    this.hits = [];
    const ink = this.dark ? '#E6EEF2' : '#1B2A33';
    const halo = this.dark ? '#0B1B26' : '#FFFFFF';

    // clusters: a disc scaled to the count, the classes as a ring
    for (const c of clusters) {
      const p = map.latLngToContainerPoint([c.lat, c.lon]);
      if (p.x < -40 || p.y < -40 || p.x > size.x + 40 || p.y > size.y + 40) continue;
      const r = Math.min(26, 12 + Math.log2(c.count) * 2.2);
      const entries = Object.entries(c.categories);
      let start = -Math.PI / 2;
      for (const [k, n] of entries) {
        const span = (n / c.count) * Math.PI * 2;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.arc(p.x, p.y, r, start, start + span); ctx.closePath();
        ctx.fillStyle = CATEGORY_COLOR[k as Category] ?? CATEGORY_COLOR.other; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1;
        start += span;
      }
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.62, 0, Math.PI * 2); ctx.fillStyle = halo; ctx.fill();
      ctx.fillStyle = ink; ctx.font = `700 ${r > 18 ? 12 : 11}px "Public Sans", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(c.count >= 1000 ? `${(c.count / 1000).toFixed(1)}k` : String(c.count), p.x, p.y);
    }

    // targets: dots and arrows, the followed ones ringed, the selected one haloed and named
    const labelGrid = new Set<string>();
    const showLabels = zoom >= 11;
    const scale = zoom >= 12 ? 1.25 : zoom >= 9 ? 1 : 0.8;
    const ordered = targets.filter((t) => !hidden.has(t.category)).sort((a, b) => (a.mmsi === selected ? 1 : b.mmsi === selected ? -1 : 0));
    for (const t of ordered) {
      const p = map.latLngToContainerPoint([t.lat, t.lon]);
      if (p.x < -20 || p.y < -20 || p.x > size.x + 20 || p.y > size.y + 20) continue;
      const colour = CATEGORY_COLOR[t.category] ?? CATEGORY_COLOR.other;
      const sel = t.mmsi === selected; const moving = isMoving(t.sog, t.navStatus);
      this.hits.push({ x: p.x, y: p.y, t });
      if (sel) { ctx.beginPath(); ctx.arc(p.x, p.y, 16, 0, Math.PI * 2); ctx.fillStyle = colour; ctx.globalAlpha = 0.22; ctx.fill(); ctx.globalAlpha = 1; }
      if (watched.has(t.mmsi)) { ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2); ctx.strokeStyle = '#E5B800'; ctx.lineWidth = 2; ctx.stroke(); }
      if (moving) {
        const a = ARROW * scale; const rad = ((t.heading ?? t.cog) * Math.PI) / 180;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(rad);
        ctx.beginPath(); ctx.moveTo(0, -a * 1.3); ctx.lineTo(a * 0.8, a); ctx.lineTo(0, a * 0.45); ctx.lineTo(-a * 0.8, a); ctx.closePath();
        ctx.fillStyle = colour; ctx.fill(); ctx.strokeStyle = t.registered ? ink : halo; ctx.lineWidth = t.registered ? 1.6 : 1; ctx.stroke();
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(p.x, p.y, DOT * scale, 0, Math.PI * 2); ctx.fillStyle = colour; ctx.fill(); ctx.strokeStyle = t.registered ? ink : halo; ctx.lineWidth = t.registered ? 1.6 : 1; ctx.stroke();
      }
      if ((showLabels || sel || t.registered && zoom >= 9) && t.name) {
        const cell = `${Math.floor(p.x / 90)}:${Math.floor(p.y / 18)}`;
        if (sel || !labelGrid.has(cell)) {
          labelGrid.add(cell);
          ctx.font = `${sel ? 700 : 500} 11px "Public Sans", sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.lineWidth = 3; ctx.strokeStyle = halo; ctx.strokeText(t.name, p.x + 11, p.y); ctx.fillStyle = ink; ctx.fillText(t.name, p.x + 11, p.y);
        }
      }
    }
    canvas.setAttribute('aria-label', `${ordered.length} targets drawn${clusters.length ? `, ${clusters.reduce((n, c) => n + c.count, 0)} more in ${clusters.length} clusters` : ''}`);
  }
}
