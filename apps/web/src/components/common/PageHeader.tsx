import { Box, Typography, Breadcrumbs, Link as MuiLink } from '@mui/material';
import { Link } from 'react-router-dom';
import type { SvgIconComponent } from '@mui/icons-material';

export interface Crumb { label: string; to?: string }
interface Props { title: React.ReactNode; sub?: React.ReactNode; crumbs?: Crumb[]; actions?: React.ReactNode; icon?: SvgIconComponent; iconColor?: string }
export default function PageHeader({ title, sub, crumbs = [], actions, icon: Icon, iconColor = '#0B74B0' }: Props) {
  return (
    <Box sx={{ mb: 2.5, display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'flex-end', justifyContent: 'space-between' }}>
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: crumbs.length ? 'flex-end' : 'center' }}>
        {Icon && (
          <Box sx={{ width: 44, height: 44, borderRadius: '12px', flexShrink: 0, display: 'grid', placeItems: 'center', bgcolor: iconColor, color: '#fff', boxShadow: `0 6px 14px ${iconColor}55`, mb: 0.25 }} aria-hidden>
            <Icon sx={{ fontSize: 24 }} />
          </Box>
        )}
        <Box>
          {crumbs.length > 0 && (
            <Breadcrumbs sx={{ mb: 0.5, '& .MuiTypography-root, & a': { fontSize: 12.5 } }}>
              {crumbs.map((c, i) => c.to ? <MuiLink key={i} component={Link} to={c.to} underline="hover" color="text.secondary">{c.label}</MuiLink> : <Typography key={i} color="text.primary" fontSize={12.5}>{c.label}</Typography>)}
            </Breadcrumbs>
          )}
          <Typography variant="h5" component="h1">{title}</Typography>
          {sub && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>{sub}</Typography>}
        </Box>
      </Box>
      {actions && <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>{actions}</Box>}
    </Box>
  );
}
