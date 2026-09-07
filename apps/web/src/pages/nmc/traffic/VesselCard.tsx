import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Card, Chip, Dialog, DialogContent, DialogTitle, Divider, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import StarBorderRoundedIcon from '@mui/icons-material/StarBorderRounded';
import TimelineRoundedIcon from '@mui/icons-material/TimelineRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import api from '../../../api/client';
import { fmtDT } from '../../../utils/format';
import { useProfile } from '../../../config/runtime';
import { CATEGORY_COLOR, CATEGORY_LABEL, SILHOUETTE, ageWords, countryName, flagEmoji, fmtCoord, navLabel } from './legend';
import type { TargetDetail } from '../types';

/* One ship, as the picture presents her: the silhouette of her class, her flag and name, the voyage she is on, the
 * facts of her last report, and the things a person can do — follow her, draw her track, open her record. */
interface Voyage { origin: string | null; destination: string | null; atd: string | null; eta: string | null; ata: string | null; status: string | null; vcn: string | null }
interface PortCallRow { id: string; vcn: string; status: string; eta: string | null; ata: string | null; atd: string | null; etd: string | null; berthCode?: string | null; prevPort?: string | null; nextPort?: string | null }

export function Silhouette({ category, height = 96 }: { category: TargetDetail['category']; height?: number }) {
  const colour = CATEGORY_COLOR[category] ?? CATEGORY_COLOR.other;
  return (
    <Box component="svg" viewBox="0 0 140 70" preserveAspectRatio="xMidYMid meet" aria-hidden sx={{ width: '100%', height, display: 'block', background: `linear-gradient(180deg, ${colour}22 0%, ${colour}55 100%)` }}>
      <rect x="0" y="62" width="140" height="8" fill={colour} opacity="0.35" />
      <path d={SILHOUETTE[category] ?? SILHOUETTE.other} fill={colour} stroke="#0B1B26" strokeOpacity="0.35" strokeWidth="1" />
    </Box>
  );
}

export default function VesselCard({ target, trackShown, onClose, onTrack, onFollow }: { target: TargetDetail; trackShown: boolean; onClose: () => void; onTrack: () => void; onFollow: (following: boolean) => void }) {
  const navigate = useNavigate();
  const profile = useProfile();
  const homeName = profile.portGeo?.name || profile.name;
  const [voyage, setVoyage] = useState<Voyage | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const flag = flagEmoji(target.flag);
  // a ship on our register has a call on the books: her voyage is what the harbour knows, not only what AIS says
  useEffect(() => {
    setVoyage(null);
    if (!target.registered || !target.vesselId) { setVoyage({ origin: null, destination: target.destinationPort || target.destination || null, atd: null, eta: target.eta || null, ata: null, status: null, vcn: null }); return; }
    api.get<PortCallRow[] | { items: PortCallRow[] }>('/port-calls', { params: { vesselId: target.vesselId, limit: 1, sort: '-eta' }, headers: { 'X-Quiet': '1' } })
      .then((r) => {
        const rows = Array.isArray(r.data) ? r.data : (r.data as { items: PortCallRow[] }).items ?? [];
        const c = rows[0];
        setVoyage(c ? { origin: c.atd ? homeName : (c.prevPort || null), destination: c.atd ? (c.nextPort || target.destination || null) : homeName, atd: c.atd, eta: c.eta, ata: c.ata, status: c.status, vcn: c.vcn }
          : { origin: null, destination: target.destinationPort || target.destination || null, atd: null, eta: target.eta || null, ata: null, status: null, vcn: null });
      })
      .catch(() => setVoyage({ origin: null, destination: target.destinationPort || target.destination || null, atd: null, eta: target.eta || null, ata: null, status: null, vcn: null }));
  }, [target.mmsi, target.vesselId, target.registered, target.destination, target.destinationPort, target.eta, homeName]);

  const follow = () => {
    setBusy(true);
    const req = target.following ? api.delete(`/tracking/watch/${encodeURIComponent(target.mmsi)}`) : api.post('/tracking/watch', { key: target.mmsi });
    req.then(() => onFollow(!target.following)).catch(() => {}).finally(() => setBusy(false));
  };
  const under = voyage?.ata && !voyage?.atd ? 'IN PORT' : voyage?.atd ? 'AT SEA' : target.registered ? 'ON THE REGISTER' : 'HIGH SEAS';
  const row = (label: string, value: React.ReactNode) => (
    <Box sx={{ flex: 1, minWidth: 0, px: 1.25, py: 1, '& + &': { borderLeft: 1, borderColor: 'divider' } }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.2 }}>{label}</Typography>
      <Typography sx={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>{value}</Typography>
    </Box>
  );

  return (
    <Card data-testid="vessel-card" aria-live="polite" sx={{ width: 380, maxWidth: 'calc(100vw - 32px)', overflow: 'hidden', boxShadow: 8, flex: '0 0 auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, pt: 1.25, pb: 1 }}>
        <Box sx={{ width: 28, height: 28, borderRadius: '7px', bgcolor: CATEGORY_COLOR[target.category], flexShrink: 0 }} aria-hidden />
        {flag && <Tooltip title={countryName(target.flag)}><Typography component="span" sx={{ fontSize: 20, lineHeight: 1 }} aria-label={countryName(target.flag)}>{flag}</Typography></Tooltip>}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 800, fontFamily: 'Archivo', fontSize: 18, lineHeight: 1.3, textTransform: 'uppercase' }} noWrap>{target.name}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{target.typeLabel || CATEGORY_LABEL[target.category]}{target.registered ? ' · on the register' : ''}</Typography>
        </Box>
        <IconButton size="small" onClick={onClose} aria-label="Close"><CloseRoundedIcon fontSize="small" /></IconButton>
      </Stack>
      <Silhouette category={target.category} />
      <Stack direction="row" spacing={1} sx={{ px: 1.5, py: 1.25 }}>
        <Button size="small" variant={target.following ? 'contained' : 'outlined'} startIcon={target.following ? <StarRoundedIcon /> : <StarBorderRoundedIcon />} onClick={follow} disabled={busy} data-testid="card-follow">{target.following ? 'In my fleet' : 'Add to fleet'}</Button>
        {target.registered && target.vesselId
          ? <Button size="small" variant="contained" onClick={() => navigate(`/vessels/${target.vesselId}`)} data-testid="card-details">Vessel details</Button>
          : <Button size="small" variant="contained" startIcon={<InfoOutlinedIcon />} onClick={() => setMore(true)} data-testid="card-details">Vessel details</Button>}
      </Stack>
      <Box sx={{ px: 1.5, pb: 1.25 }}>
        <Stack direction="row" alignItems="baseline" justifyContent="space-between">
          <Typography sx={{ fontSize: 20, fontWeight: 300, letterSpacing: 0.3 }} noWrap data-testid="card-voyage">{voyage?.origin ? `${voyage.origin} → ` : ''}{voyage?.destination || target.destination || '—'}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: 1 }}>{under}</Typography>
        </Stack>
        <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
          <Typography variant="caption"><b>ATD:</b> {voyage?.atd ? fmtDT(voyage.atd) : '—'}</Typography>
          <Typography variant="caption"><b>{voyage?.ata && !voyage.atd ? 'ATA' : 'ETA'}:</b> {voyage?.ata && !voyage.atd ? fmtDT(voyage.ata) : voyage?.eta ? (voyage.eta.length <= 11 ? voyage.eta : fmtDT(voyage.eta)) : '—'}</Typography>
        </Stack>
        <Box sx={{ position: 'relative', height: 14, mt: 1, mb: 0.5 }} aria-hidden>
          <Box sx={{ position: 'absolute', left: 6, right: 12, top: 6, height: 2, bgcolor: 'primary.main', opacity: 0.8 }} />
          <Box sx={{ position: 'absolute', left: 0, top: 1, width: 12, height: 12, borderRadius: '50%', bgcolor: 'primary.main' }} />
          <Box sx={{ position: 'absolute', right: 0, top: 0, width: 0, height: 0, borderTop: '7px solid transparent', borderBottom: '7px solid transparent', borderLeft: '14px solid', borderLeftColor: 'primary.main' }} />
        </Box>
        <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap alignItems="center">
          <Button size="small" variant={trackShown ? 'contained' : 'outlined'} color="inherit" startIcon={<TimelineRoundedIcon />} onClick={onTrack} data-testid="card-track" sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{trackShown ? 'Hide track' : 'Past track'}</Button>
          {voyage?.vcn && <Chip size="small" variant="outlined" label={`Call ${voyage.vcn}${voyage.status ? ` · ${voyage.status}` : ''}`} />}
        </Stack>
      </Box>
      <Divider />
      <Stack direction="row">
        {row('Navigational status', navLabel(target.navStatus))}
        {row('Speed / Course', `${target.sog.toFixed(1)} kn / ${String(target.heading ?? target.cog).padStart(3, '0')}°`)}
        {row('Draught', target.draught != null ? `${target.draught.toFixed(1)} m` : '—')}
      </Stack>
      <Divider />
      <Box sx={{ px: 1.5, py: 1 }}>
        <Typography variant="caption" color="text.secondary">Received: <b>{ageWords(target.receivedAt)}</b> (source: {target.source || '—'})</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{fmtCoord(target.lat, target.lon)} · MMSI {target.mmsi}{target.imo ? ` · IMO ${target.imo}` : ''}{target.callSign ? ` · ${target.callSign}` : ''}</Typography>
        {target.alerts.length > 0 && <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }} flexWrap="wrap" useFlexGap>{target.alerts.map((a) => <Chip key={a.id} size="small" color={a.severity === 'error' ? 'error' : a.severity === 'warning' ? 'warning' : 'info'} label={a.type.replace(/_/g, ' ')} sx={{ height: 20, fontSize: 10 }} />)}</Stack>}
      </Box>
      <Dialog open={more} onClose={() => setMore(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 16 }}>{flag} {target.name} — as AIS reports her</DialogTitle>
        <DialogContent>
          <Stack spacing={0.5}>
            {[['MMSI', target.mmsi], ['IMO', target.imo || '—'], ['Call sign', target.callSign || '—'], ['Flag', target.flag ? `${countryName(target.flag)} (${target.flag})` : 'Not known from the MMSI'], ['Type', `${target.typeLabel || CATEGORY_LABEL[target.category]}${target.shipType != null ? ` (AIS type ${target.shipType})` : ''}`],
              ['Dimensions', target.length ? `${target.length} m × ${target.width ?? '—'} m` : '—'], ['Draught', target.draught != null ? `${target.draught} m` : '—'], ['Destination', target.destination || '—'], ['ETA (AIS)', target.eta || '—'],
              ['Navigational status', navLabel(target.navStatus)], ['Speed / course / heading', `${target.sog} kn / ${target.cog}° / ${target.heading ?? '—'}°`], ['Position', fmtCoord(target.lat, target.lon)], ['Last report', `${fmtDT(target.receivedAt)} · ${target.source}`]]
              .map(([k, v]) => <Stack key={k} direction="row" justifyContent="space-between" spacing={2}><Typography variant="body2" color="text.secondary">{k}</Typography><Typography variant="body2" sx={{ fontWeight: 600, textAlign: 'right' }}>{v}</Typography></Stack>)}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>This ship is not on the platform's register: what is shown is her own AIS broadcast, unverified.</Typography>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
