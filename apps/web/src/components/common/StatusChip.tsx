import { Chip } from '@mui/material';
import type { StatusMeta } from '../../utils/status';

export default function StatusChip({ value, map, size = 'small' }: { value?: string | null; map: StatusMeta; size?: 'small' | 'medium' }) {
  const meta = (value && map[value]) || { label: value || '—', color: 'default' as const };
  return <Chip size={size} label={meta.label} color={meta.color} variant={meta.color === 'default' ? 'outlined' : 'filled'} sx={{ fontSize: 11.5, height: 22, '& .MuiChip-label': { px: 1 } }} />;
}
