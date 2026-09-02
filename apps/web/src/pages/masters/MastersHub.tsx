import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Grid, Card, Box, Typography, ButtonBase, Chip, Stack } from '@mui/material';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import AnchorRoundedIcon from '@mui/icons-material/AnchorRounded';
import PriceChangeRoundedIcon from '@mui/icons-material/PriceChangeRounded';
import ChecklistRoundedIcon from '@mui/icons-material/ChecklistRounded';
import api from '../../api/client';
import PageHeader from '../../components/common/PageHeader';
import { MASTERS } from './mastersConfig';
import { MONO } from '../../theme';

/* Data Studio home — every configuration master as an icon card, grouped, with live record counts. */
const DEDICATED = [
  { key: '_berths', name: 'Berths & Terminals', icon: AnchorRoundedIcon, color: '#0797A5', desc: 'The berth master behind the board and the twin', group: 'Marine', to: '/masters/berths' },
  { key: '_tariffs', name: 'Tariff Items', icon: PriceChangeRoundedIcon, color: '#BD3861', desc: 'Rate card behind invoicing', group: 'Commercial', to: '/masters/tariffs' },
  { key: '_checklists', name: 'Checklist Templates', icon: ChecklistRoundedIcon, color: '#9C6412', desc: 'Built in the Survey & Audit Cell builder', group: 'Compliance', to: '/checklist-builder' },
];
export default function MastersHub() {
  const navigate = useNavigate();
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => { api.get<{ key: string; count: number }[]>('/lookups/categories').then((r) => setCounts(Object.fromEntries(r.data.map((c) => [c.key, c.count])))).catch(() => {}); }, []);
  const groups = [...new Set([...MASTERS, ...DEDICATED].map((m) => m.group))];
  return (
    <>
      <PageHeader icon={HubRoundedIcon} iconColor="#5A6B78" title="Data Studio" sub="Every configuration master behind the platform — geography, commercial, marine, assets, organisation and compliance reference data" />
      {groups.map((g) => (
        <Box key={g} sx={{ mb: 3 }}>
          <Typography component="h2" sx={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'text.secondary', mb: 1.25 }}>{g}</Typography>
          <Grid container spacing={1.5}>
            {[...MASTERS.filter((m) => m.group === g).map((m) => ({ ...m, to: `/masters/m/${m.key}` })), ...DEDICATED.filter((m) => m.group === g)].map((m) => { const Icon = m.icon; return (
              <Grid item xs={12} sm={6} md={4} lg={3} key={m.key}>
                <ButtonBase onClick={() => navigate(m.to)} sx={{ width: '100%', textAlign: 'left', borderRadius: 3 }}>
                  <Card variant="outlined" sx={{ p: 1.75, width: '100%', display: 'flex', gap: 1.5, alignItems: 'flex-start', transition: 'all .15s', '&:hover': { borderColor: m.color, transform: 'translateY(-2px)', boxShadow: 3 } }}>
                    <Box sx={{ width: 40, height: 40, borderRadius: '11px', display: 'grid', placeItems: 'center', bgcolor: m.color, color: '#fff', flexShrink: 0 }}><Icon sx={{ fontSize: 22 }} /></Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Stack direction="row" spacing={0.75} alignItems="center"><Typography noWrap sx={{ fontWeight: 700, fontSize: 13.5 }}>{m.name}</Typography>{counts[m.key] !== undefined && <Chip size="small" label={counts[m.key]} sx={{ height: 17, fontSize: 10, fontWeight: 700 }} />}</Stack>
                      <Typography sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.35, mt: 0.25 }}>{m.desc}</Typography>
                    </Box>
                  </Card>
                </ButtonBase>
              </Grid>
            ); })}
          </Grid>
        </Box>
      ))}
    </>
  );
}
