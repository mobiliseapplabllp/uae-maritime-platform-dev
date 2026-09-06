import { Card, Box, Typography } from '@mui/material';
import { MONO } from '../../theme';
import ExplainButton from '../ai/ExplainButton';

/* A headline figure with its label and a line under it. The corner carries "explain this" for readers who may use the
 * assistant: the card hands over exactly what it shows — the label, the figure and the line — nothing more. */
export default function StatCard({ label, value, sub, icon, tone = 'primary.main', testId }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon?: React.ReactNode; tone?: string; testId?: string }) {
  const plain = (v: React.ReactNode) => (typeof v === 'string' || typeof v === 'number' ? v : undefined);
  return (
    <Card sx={{ p: 2, display: 'flex', gap: 1.5, alignItems: 'flex-start', height: '100%', position: 'relative' }} data-testid={testId}>
      <ExplainButton corner ctx={{ kind: 'stat', title: label, value: plain(value), sub: typeof sub === 'string' ? sub : undefined }} testId={testId} />
      {icon && <Box sx={{ width: 38, height: 38, borderRadius: '10px', display: 'grid', placeItems: 'center', color: tone, bgcolor: (t) => (t.palette.mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(11,31,42,0.05)') }} aria-hidden>{icon}</Box>}
      <Box sx={{ minWidth: 0, pr: 2.5 }}>
        <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 24, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
        <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
        {sub && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>{sub}</Typography>}
      </Box>
    </Card>
  );
}
