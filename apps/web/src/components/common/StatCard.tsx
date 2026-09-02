import { Card, Box, Typography } from '@mui/material';
import { MONO } from '../../theme';

export default function StatCard({ label, value, sub, icon, tone = 'primary.main' }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon?: React.ReactNode; tone?: string }) {
  return (
    <Card sx={{ p: 2, display: 'flex', gap: 1.5, alignItems: 'flex-start', height: '100%' }}>
      {icon && <Box sx={{ width: 38, height: 38, borderRadius: '10px', display: 'grid', placeItems: 'center', color: tone, bgcolor: (t) => (t.palette.mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(11,31,42,0.05)') }} aria-hidden>{icon}</Box>}
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 24, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
        <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
        {sub && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>{sub}</Typography>}
      </Box>
    </Card>
  );
}
