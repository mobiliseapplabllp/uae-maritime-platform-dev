import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Box, Typography, Stack, Skeleton, Chip, Button, Divider, Table, TableHead, TableRow, TableCell, TableBody } from '@mui/material';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import SpaceDashboardRoundedIcon from '@mui/icons-material/SpaceDashboardRounded';
import dayjs from 'dayjs';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { CHART_SERIES, type SeriesKey } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import { fmtDT, fromNow } from '../../utils/format';
import { seriesOf } from './constants';
import { QUAY_H, SHIP_H, SLOT_W, SLOT_GAP, shipWidth, shortName, twinLayout } from './twin';
import type { TwinBerth, TwinData } from './types';

/* Stylised 2-D "digital twin" of the quay: every berth as a slot on its terminal, the vessel alongside drawn to scale (LOA vs berth length),
 * the anchorage and inbound traffic below. Data: /ops/twin. Click a ship to open its call. A visually hidden table carries the same picture for screen readers. */
const SR_ONLY = { position: 'absolute', width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 } as const;
const LEGEND: [SeriesKey, string][] = [['container', 'Container'], ['dryBulk', 'Dry bulk / coal'], ['liquid', 'Liquid / crude'], ['other', 'General · Ro-Ro']];
const H = 780;
const ROW_Y = [88, 300, 560];
const activate = (fn: () => void) => (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };

function Ship({ x, y, w, color, label, dark, onClick, title }: { x: number; y: number; w: number; color: string; label: string; dark: boolean; onClick?: () => void; title: string }) {
  const bow = Math.min(16, w * 0.22);
  return (
    <g transform={`translate(${x},${y})`} onClick={onClick} onKeyDown={onClick ? activate(onClick) : undefined} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      aria-label={title.replace(/\n/g, ' · ')} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      <title>{title}</title>
      <path d={`M0,0 H${w - bow} L${w},${SHIP_H / 2} L${w - bow},${SHIP_H} H0 Z`} fill={color} stroke={dark ? '#071A29' : '#FFFFFF'} strokeWidth="1.6" />
      <rect x={Math.max(4, w * 0.12)} y={SHIP_H * 0.22} width={Math.max(8, w * 0.24)} height={SHIP_H * 0.56} rx="2" fill={dark ? 'rgba(7,26,41,0.45)' : 'rgba(255,255,255,0.45)'} />
      {w > 58 && (
        <text aria-hidden x={w / 2 - bow / 4} y={SHIP_H / 2 + 3.6} textAnchor="middle" fontSize="10" fontWeight="700" fill={dark ? '#071A29' : '#FFFFFF'} fontFamily="Public Sans, sans-serif" style={{ pointerEvents: 'none' }}>{label}</text>
      )}
    </g>
  );
}

export default function PortTwin() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const mode = useAppSelector((s) => s.ui.mode);
  const dark = mode === 'dark';
  const C = CHART_SERIES[mode];
  const [data, setData] = useState<TwinData | null>(null);

  const load = useCallback(() => api.get<TwinData>('/ops/twin').then((r) => setData(r.data))
    .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))), [dispatch]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const layout = useMemo(() => (data ? twinLayout(data.berths) : null), [data]);

  if (!data || !layout) return <Skeleton variant="rounded" height={560} />;

  const sea = dark ? '#0A2233' : '#D7E7EF';
  const seaDeep = dark ? '#071A29' : '#C7DEEA';
  const quay = dark ? '#2B4254' : '#B9AC93';
  const apron = dark ? '#122C3C' : '#EDE7DA';
  const ink = dark ? '#AAC1C7' : '#4A6472';
  const free = dark ? '#39566A' : '#9FB4C0';
  const amber = dark ? '#E8B155' : '#9C6412';
  const shipColor = (t?: string) => C[seriesOf(t)];
  const occupied = data.berths.filter((b) => b.occupiedBy).length;
  const openCall = (id: string) => navigate(`/port-calls/${id}`);

  const berthSlot = (b: TwinBerth, x: number, y: number) => {
    const shipW = shipWidth(b);
    const o = b.occupiedBy;
    return (
      <g key={b.code} transform={`translate(${x},${y})`}>
        <rect x="0" y={-QUAY_H - 26} width={SLOT_W} height={26} fill={apron} />
        <rect x="0" y={-QUAY_H} width={SLOT_W} height={QUAY_H} fill={quay} rx="2" />
        {b.status !== 'OPERATIONAL' && (
          <g>
            <rect x="0" y={-QUAY_H} width={SLOT_W} height={QUAY_H} fill="url(#maint)" rx="2" />
            <text aria-hidden x={SLOT_W / 2} y={-QUAY_H - 8} textAnchor="middle" fontSize="9" fill={ink} fontFamily="IBM Plex Mono, monospace">MAINTENANCE</text>
          </g>
        )}
        <text aria-hidden x="4" y={-QUAY_H - 32} fontSize="10.5" fontWeight="700" fill={ink} fontFamily="IBM Plex Mono, monospace">{b.code}</text>
        {o ? (
          <Ship x={(SLOT_W - shipW) / 2} y={7} w={shipW} color={shipColor(o.type)} dark={dark} label={shortName(o.vessel)}
            title={`${o.vessel} · ${o.vcn}\n${o.cargo || 'cargo ops'}\nETD ${o.etd ? fmtDT(o.etd) : '—'}`} onClick={() => openCall(o.callId)} />
        ) : (
          b.status === 'OPERATIONAL' && (
            <g>
              <rect x={(SLOT_W - 64) / 2} y={13} width="64" height="18" rx="9" fill="none" stroke={free} strokeDasharray="4 3" />
              <text aria-hidden x={SLOT_W / 2} y={25.5} textAnchor="middle" fontSize="9" fill={free} fontFamily="IBM Plex Mono, monospace">FREE</text>
            </g>
          )
        )}
      </g>
    );
  };
  const quayRow = (r: 0 | 1) => layout.rows[r].map((g) => (
    <g key={g.terminal}>
      <text aria-hidden x={g.x + 2} y={ROW_Y[r] - QUAY_H - 48} fontSize="12" fontWeight="800" fill={ink} fontFamily="Archivo, sans-serif">{g.terminal.toUpperCase()}</text>
      {g.berths.map((b, i) => berthSlot(b, g.x + 8 + i * (SLOT_W + SLOT_GAP), ROW_Y[r]))}
    </g>
  ));

  return (
    <>
      <PageHeader icon={SpaceDashboardRoundedIcon} iconColor="#0797A5" title="Quay view — live 2-D twin"
        sub={`${occupied} of ${data.berths.length} berths occupied · ${data.anchorage.length} at anchorage · ${data.inbound.length} inbound — refreshes every minute`}
        actions={<Button size="small" startIcon={<RefreshRoundedIcon />} onClick={load}>Refresh</Button>} />
      <Card sx={{ p: 1.5 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <svg viewBox={`0 0 ${layout.width} ${H}`} role="group" aria-label="Quay view — berths, anchorage and inbound traffic" style={{ width: '100%', minWidth: 1180, display: 'block', borderRadius: 8 }}>
            <defs>
              <pattern id="maint" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                <rect width="8" height="8" fill={quay} />
                <line x1="0" y1="0" x2="0" y2="8" stroke={amber} strokeWidth="3" />
              </pattern>
            </defs>
            <rect width={layout.width} height={H} fill={sea} />
            <rect y={ROW_Y[2] - 60} width={layout.width} height={H - ROW_Y[2] + 60} fill={seaDeep} />
            {quayRow(0)}
            {quayRow(1)}
            {/* offshore band: SPMs, anchorage, inbound */}
            <text aria-hidden x="26" y={ROW_Y[2] - 34} fontSize="12" fontWeight="800" fill={ink} fontFamily="Archivo, sans-serif">OFFSHORE — SPM · ANCHORAGE · APPROACHES</text>
            {layout.rows[2].flatMap((g) => g.berths).map((b, i) => (
              <g key={b.code} transform={`translate(${60 + i * 190},${ROW_Y[2] + 30})`}>
                <circle r="16" fill="none" stroke={amber} strokeWidth="2.5" strokeDasharray="4 3" />
                <circle r="4" fill={amber} />
                <text aria-hidden x="0" y="34" textAnchor="middle" fontSize="10" fill={ink} fontFamily="IBM Plex Mono, monospace">{b.code}</text>
                {b.occupiedBy && (
                  <Ship x={24} y={-SHIP_H / 2} w={92} color={shipColor(b.occupiedBy.type)} dark={dark} label={shortName(b.occupiedBy.vessel)}
                    title={`${b.occupiedBy.vessel} · ${b.occupiedBy.vcn}\n${b.occupiedBy.cargo || 'crude transfer'}`} onClick={() => openCall(b.occupiedBy!.callId)} />
                )}
              </g>
            ))}
            <g transform={`translate(${Math.max(480, layout.width * 0.34)},${ROW_Y[2] - 6})`}>
              <rect width="420" height="150" rx="10" fill="none" stroke={ink} strokeDasharray="6 5" strokeWidth="1.6" opacity="0.7" />
              <text aria-hidden x="10" y="-8" fontSize="10.5" fill={ink} fontFamily="IBM Plex Mono, monospace">ANCHORAGE — AWAITING BERTH</text>
              {data.anchorage.map((a, i) => (
                <g key={a.callId} transform={`translate(${16 + (i % 3) * 136},${18 + Math.floor(i / 3) * 46})`}>
                  <Ship x={0} y={0} w={104} color={shipColor(a.type)} dark={dark} label={shortName(a.vessel)}
                    title={`${a.vessel} · ${a.vcn}\nAt anchor since ${fromNow(a.since)}\nETB ${a.etb ? fmtDT(a.etb) : '—'}`} onClick={() => openCall(a.callId)} />
                </g>
              ))}
            </g>
            <g transform={`translate(${Math.max(960, layout.width * 0.66)},${ROW_Y[2] - 6})`}>
              <text aria-hidden x="10" y="-8" fontSize="10.5" fill={ink} fontFamily="IBM Plex Mono, monospace">INBOUND — NEXT ARRIVALS</text>
              {data.inbound.slice(0, 5).map((a, i) => (
                <g key={a.callId} transform={`translate(10,${14 + i * 30})`}>
                  <path d="M0,7 L10,0 L10,14 Z" fill={shipColor(a.type)} />
                  <text x="18" y="11" fontSize="11" fontWeight="700" fill={dark ? '#DCE7EA' : '#22404F'} fontFamily="Public Sans, sans-serif" role="button" tabIndex={0}
                    aria-label={`${a.vessel} — open call ${a.vcn}`} style={{ cursor: 'pointer' }} onClick={() => openCall(a.callId)} onKeyDown={activate(() => openCall(a.callId))}>{a.vessel}</text>
                  <text aria-hidden x="230" y="11" fontSize="10" fill={ink} fontFamily="IBM Plex Mono, monospace">ETA {a.eta ? dayjs(a.eta).format('DD MMM HH:mm') : '—'}</text>
                </g>
              ))}
              {data.inbound.length === 0 && <text x="18" y="24" fontSize="11" fill={ink}>None expected in the window</text>}
            </g>
          </svg>
        </Box>
        {/* text alternative for screen readers */}
        <Box sx={SR_ONLY}>
          <Table aria-label="Berth occupancy">
            <TableHead><TableRow><TableCell>Berth</TableCell><TableCell>Terminal</TableCell><TableCell>Status</TableCell><TableCell>Vessel alongside</TableCell><TableCell>ETD</TableCell></TableRow></TableHead>
            <TableBody>
              {data.berths.map((b) => (
                <TableRow key={b.id}><TableCell>{b.code}</TableCell><TableCell>{b.terminal}</TableCell><TableCell>{b.status}</TableCell><TableCell>{b.occupiedBy ? `${b.occupiedBy.vessel} (${b.occupiedBy.vcn})` : 'Free'}</TableCell><TableCell>{b.occupiedBy ? fmtDT(b.occupiedBy.etd) : '—'}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
          <Table aria-label="At anchorage">
            <TableHead><TableRow><TableCell>Vessel</TableCell><TableCell>VCN</TableCell><TableCell>At anchor since</TableCell><TableCell>ETB</TableCell></TableRow></TableHead>
            <TableBody>{data.anchorage.map((a) => <TableRow key={a.callId}><TableCell>{a.vessel}</TableCell><TableCell>{a.vcn}</TableCell><TableCell>{fmtDT(a.since)}</TableCell><TableCell>{fmtDT(a.etb)}</TableCell></TableRow>)}</TableBody>
          </Table>
          <Table aria-label="Inbound">
            <TableHead><TableRow><TableCell>Vessel</TableCell><TableCell>VCN</TableCell><TableCell>ETA</TableCell><TableCell>Status</TableCell></TableRow></TableHead>
            <TableBody>{data.inbound.map((a) => <TableRow key={a.callId}><TableCell>{a.vessel}</TableCell><TableCell>{a.vcn}</TableCell><TableCell>{fmtDT(a.eta)}</TableCell><TableCell>{a.status}</TableCell></TableRow>)}</TableBody>
          </Table>
        </Box>
        <Divider sx={{ my: 1.25 }} />
        <Stack direction="row" spacing={1.5} sx={{ px: 0.5, flexWrap: 'wrap', alignItems: 'center' }} useFlexGap>
          {LEGEND.map(([k, label]) => (
            <Stack key={k} direction="row" spacing={0.6} alignItems="center">
              <Box aria-hidden sx={{ width: 12, height: 12, borderRadius: '3px', bgcolor: C[k] }} />
              <Typography variant="caption" color="text.secondary">{label}</Typography>
            </Stack>
          ))}
          <Chip size="small" variant="outlined" label="Ship length drawn to scale against its berth" sx={{ fontSize: 10.5 }} />
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto !important' }}>Schematic representation for operations — not for navigation</Typography>
        </Stack>
      </Card>
    </>
  );
}
