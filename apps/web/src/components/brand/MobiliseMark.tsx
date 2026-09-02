/* "Powered by Mobilise" lockup. */
import { Box, Typography, Link } from '@mui/material';
import { MONO } from '../../theme';

export function MobiliseBadge({ size = 26, invert }: { size?: number; invert?: boolean }) {
  const bg = invert ? '#FFFFFF' : '#0A2239';
  const fg = invert ? '#0A2239' : '#FFFFFF';
  return (
    <svg viewBox="0 0 44 44" width={size} height={size} style={{ display: 'block', flexShrink: 0 }} aria-label="Mobilise App Lab" role="img">
      <rect width="44" height="44" rx="10" fill={bg} />
      <path d="M 12 31 L 12 13 L 22 25 L 32 13 L 32 31" fill="none" stroke={fg} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="38.2" cy="37.5" r="3.2" fill="#0E7C86" />
    </svg>
  );
}
export default function MobiliseMark({ light, sx }: { light?: boolean; sx?: object }) {
  const main = light ? 'rgba(255,255,255,0.92)' : 'text.primary';
  const sub = light ? 'rgba(255,255,255,0.6)' : 'text.secondary';
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.1, ...sx }}>
      <MobiliseBadge size={27} invert={light} />
      <Box sx={{ lineHeight: 1 }}>
        <Typography sx={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: sub, lineHeight: 1.2 }}>Powered by</Typography>
        <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 14.5, color: main, lineHeight: 1.15 }}>
          Mobilise{' '}
          <Link href="https://mobilise.co.in" target="_blank" rel="noreferrer" underline="hover" sx={{ fontFamily: MONO, fontWeight: 500, fontSize: 10, color: sub, ml: 0.4 }}>mobilise.co.in</Link>
        </Typography>
      </Box>
    </Box>
  );
}
