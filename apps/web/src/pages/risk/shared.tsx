/* Risk engine constants, pure helpers and the score bar shared by the risk screens and the vessel record. */
import { Box, Stack, Typography } from '@mui/material';
import { MONO } from '../../theme';
import type { ChipColor } from '../../utils/status';
import type { RiskBand, RiskFactor, RiskFactorKey } from './types';

export const BAND_META: Record<RiskBand, [string, ChipColor]> = { LOW: ['Low', 'success'], MEDIUM: ['Medium', 'warning'], HIGH: ['High', 'error'] };
export const WEIGHT_LABELS: Record<RiskFactorKey, string> = {
  age: 'Vessel age', certificates: 'Statutory certificates', deficiencies: 'Open deficiencies',
  detentions: 'Detention history', inspectionGap: 'Time since inspection', agentPerformance: 'Agent fleet record',
};
export const WEIGHT_KEYS = Object.keys(WEIGHT_LABELS) as RiskFactorKey[];
/** The ceiling the engine accepts for any one weight. */
export const WEIGHT_MAX = 50;
export const bandMeta = (band: string): [string, ChipColor] => BAND_META[band as RiskBand] || [band, 'default'];
/** Theme colour token for a band — what the score bar is painted with. */
export const bandColor = (band: string) => (band === 'HIGH' ? 'error.main' : band === 'MEDIUM' ? 'warning.main' : 'success.main');
/** How hard one factor is pressing: above 65 % of its weight reads as error, above 35 % as warning. */
export const factorTone = (points: number, max: number): 'error' | 'warning' | 'success' => { const r = points / (max || 1); return r > 0.65 ? 'error' : r > 0.35 ? 'warning' : 'success'; };
export const factorPct = (f: Pick<RiskFactor, 'points' | 'max'>) => (f.points / Math.max(1, f.max)) * 100;
/** The factor carrying most points — what the targeting list calls the primary driver. */
export const primaryDriver = (factors: RiskFactor[]) => (factors[0] ? `${factors[0].label} — ${factors[0].evidence}` : '—');

export function ScoreBar({ score, band }: { score: number; band: string }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 130 }}>
      <Box role="meter" aria-label="Risk score" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} sx={{ flex: 1, height: 7, borderRadius: 4, bgcolor: 'action.hover', overflow: 'hidden' }}>
        <Box sx={{ width: `${score}%`, height: '100%', bgcolor: bandColor(band), borderRadius: 4 }} />
      </Box>
      <Typography sx={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, width: 26, textAlign: 'right' }}>{score}</Typography>
    </Stack>
  );
}
