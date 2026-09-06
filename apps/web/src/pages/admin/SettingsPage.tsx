import { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Box, Card, CardActionArea, Chip, Grid, Skeleton, Stack, Typography } from '@mui/material';
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded';
import type { SvgIconComponent } from '@mui/icons-material';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import { MODULES } from '../../modules';
import { fmtDT } from '../../utils/format';
import { INTEGRATIONS_CARD, LEGACY_TABS, MODULE_CARDS, SECTIONS, type Fact } from './settings/catalogue';

/* Platform settings — the landing. One card per platform section, one for the integrations, and one per module's
 * settings, each showing the values that matter, when it last changed and who reads it. A card opens its page. */
type Values = Record<string, any>;
interface Meta { updatedAt: string | null; updatedBy: string | null }
interface Platform { values: Record<string, Values>; meta: Record<string, Meta> }
interface Modules { keys: string[]; modules: Record<string, { values: Values; updatedAt: string | null; updatedBy: string | null }> }

const changed = (m?: Meta | { updatedAt: string | null; updatedBy: string | null } | null) => (m?.updatedAt ? `Changed ${fmtDT(m.updatedAt)}${m.updatedBy ? ` by ${m.updatedBy}` : ''}` : 'Seeded defaults');

export function SettingCard({ icon: Icon, color, title, blurb, facts, meta, readBy, to, testId }: { icon: SvgIconComponent; color: string; title: string; blurb: string; facts: Fact[]; meta: string; readBy: string[]; to: string; testId: string }) {
  const navigate = useNavigate();
  return (
    <Card sx={{ height: '100%' }} data-testid={testId}>
      <CardActionArea onClick={() => navigate(to)} sx={{ height: '100%', p: 2, alignItems: 'stretch', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }} aria-label={`${title} settings`}>
        <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 1 }}>
          <Box sx={{ width: 36, height: 36, borderRadius: '10px', display: 'grid', placeItems: 'center', bgcolor: color, color: '#fff', flexShrink: 0 }} aria-hidden><Icon sx={{ fontSize: 20 }} /></Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography sx={{ fontWeight: 700 }} noWrap>{title}</Typography>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{meta}</Typography>
          </Box>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.25, flex: 1 }}>{blurb}</Typography>
        {facts.length > 0 && (
          <Box component="dl" sx={{ m: 0, mb: 1.25, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1, rowGap: 0.25 }}>
            {facts.map((f) => (
              <Box key={f.label} sx={{ display: 'contents' }}>
                <Typography component="dt" variant="caption" color="text.secondary" noWrap>{f.label}</Typography>
                <Typography component="dd" variant="caption" sx={{ m: 0, fontWeight: 600 }} noWrap>{f.value}</Typography>
              </Box>
            ))}
          </Box>
        )}
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {readBy.slice(0, 3).map((r) => <Chip key={r} size="small" variant="outlined" label={r.split(' — ')[0]} sx={{ height: 20, fontSize: 10.5 }} />)}
        </Stack>
      </CardActionArea>
    </Card>
  );
}

export default function SettingsPage() {
  const dispatch = useAppDispatch();
  const location = useLocation();
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [modules, setModules] = useState<Modules | null>(null);
  const tab = new URLSearchParams(location.search).get('tab');
  useEffect(() => {
    if (tab) return;
    api.get<Platform>('/settings').then((r) => setPlatform(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
    api.get<Modules>('/module-settings', { headers: { 'X-Quiet': '1' } }).then((r) => setModules(r.data)).catch(() => setModules({ keys: [], modules: {} }));
  }, [dispatch, tab]);
  const moduleCards = useMemo(() => MODULE_CARDS.map((m) => ({ ...m, mod: MODULES.find((x) => x.key === m.key) })).filter((m) => m.mod), []);

  // a deep link into the old tabbed screen still lands on the right page
  if (tab) return <Navigate to={LEGACY_TABS[tab] ?? `/admin/settings/${encodeURIComponent(tab)}`} replace />;
  if (!platform) return <Skeleton variant="rounded" height={480} />;

  return (
    <>
      <PageHeader icon={SettingsRoundedIcon} iconColor="#0A2239" title="Platform settings" sub="Every value here is read by a running service the moment it matters — open a card to see what it governs and change it" />
      <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>Platform</Typography>
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {SECTIONS.map((s) => (
          <Grid item xs={12} sm={6} lg={4} key={s.key}>
            <SettingCard icon={s.icon} color={s.color} title={s.label} blurb={s.blurb} facts={s.facts(platform.values[s.key] || {})} meta={changed(platform.meta[s.key])} readBy={s.readBy} to={`/admin/settings/${s.key}`} testId={`settings-card-${s.key}`} />
          </Grid>
        ))}
        <Grid item xs={12} sm={6} lg={4}>
          <SettingCard icon={INTEGRATIONS_CARD.icon} color={INTEGRATIONS_CARD.color} title={INTEGRATIONS_CARD.label} blurb={INTEGRATIONS_CARD.blurb} facts={[]} meta="Adapters, credentials and recorded contracts" readBy={INTEGRATIONS_CARD.readBy} to="/admin/settings/integrations" testId="settings-card-integrations" />
        </Grid>
      </Grid>
      <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>Modules</Typography>
      <Grid container spacing={2}>
        {moduleCards.map((m) => {
          const entry = modules?.modules[m.key];
          return (
            <Grid item xs={12} sm={6} lg={4} key={m.key}>
              <SettingCard icon={m.mod!.icon} color={m.mod!.color} title={m.mod!.name} blurb={m.blurb} facts={m.facts(entry?.values || {})} meta={modules ? changed(entry) : 'Loading…'} readBy={m.readBy} to={`/settings/module/${m.key}`} testId={`settings-card-module-${m.key}`} />
            </Grid>
          );
        })}
      </Grid>
    </>
  );
}
