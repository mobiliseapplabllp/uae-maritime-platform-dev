import { useEffect, useState } from 'react';
import { Box, Typography, keyframes } from '@mui/material';
import AnchorRoundedIcon from '@mui/icons-material/AnchorRounded';
import { onBusy } from '../../api/busy';
import { BRAND_GRADIENT, MONO } from '../../theme';

const slide = keyframes`0%{transform:translateX(-100%)}100%{transform:translateX(250%)}`;
const spin = keyframes`0%{transform:rotate(0)}100%{transform:rotate(360deg)}`;
const pulse = keyframes`0%,100%{opacity:.55}50%{opacity:1}`;

/** 2.5px gradient activity bar pinned under the header — lights on any API traffic. */
export function GlobalProgress() {
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => onBusy(setBusy), []);
  useEffect(() => { if (busy) { setVisible(true); return undefined; } const t = setTimeout(() => setVisible(false), 350); return () => clearTimeout(t); }, [busy]);
  return (
    <Box sx={{ position: 'relative', height: 2.5, overflow: 'hidden', bgcolor: 'transparent' }} role="progressbar" aria-hidden={!visible}>
      {visible && <Box sx={{ position: 'absolute', inset: 0, width: '40%', background: BRAND_GRADIENT, animation: `${slide} 1s ease-in-out infinite`, borderRadius: 2 }} />}
    </Box>
  );
}
/** Branded centre loader used by Suspense route fallbacks and module switches. */
export function PageLoader({ label = 'Loading module…' }: { label?: string }) {
  return (
    <Box sx={{ minHeight: '55vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }} role="status" aria-live="polite">
      <Box sx={{ position: 'relative', width: 64, height: 64 }}>
        <Box sx={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'conic-gradient(from 0deg, #0B74B0, #75479C, #BD3861, transparent 78%)', animation: `${spin} 0.9s linear infinite`, WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px))', mask: 'radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px))' }} />
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', animation: `${pulse} 1.6s ease-in-out infinite` }}><AnchorRoundedIcon sx={{ color: 'primary.main', fontSize: 26 }} /></Box>
      </Box>
      <Typography sx={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography>
    </Box>
  );
}
