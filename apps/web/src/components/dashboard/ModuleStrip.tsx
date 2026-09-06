import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, ButtonBase, Card, Skeleton, Typography } from '@mui/material';
import api from '../../api/client';
import { MODULES, type ModuleDef } from '../../modules';
import { useUser } from '../../store';
import { hasPerm } from '../../utils/perms';
import { MONO } from '../../theme';
import { fmtDec, fmtMoneyShort, fmtNum } from '../../utils/format';

/* The Command Centre's module strip: one tile per module the reader may open, carrying that module's headline numbers
 * from the reporting read models, and opening on the module's dashboard. The platform tile reads service health from
 * the observability service instead, because health is not a read model. */
export interface StripKpi { label: string; value: number; format?: 'count' | 'money' | 'hours' | 'pct'; tone?: 'default' | 'success' | 'warning' | 'error' }
export interface StripData { modules: { key: string; kpis: StripKpi[] }[]; generatedAt: string }
const TONE: Record<NonNullable<StripKpi['tone']>, string> = { default: 'text.primary', success: 'success.main', warning: 'warning.main', error: 'error.main' };
export const formatKpi = (k: StripKpi) => (k.format === 'money' ? fmtMoneyShort(k.value) : k.format === 'hours' ? `${fmtDec(k.value, 1)} h` : k.format === 'pct' ? `${k.value}%` : fmtNum(k.value));

/** What the observability service says, reduced to the three numbers a tile can carry: services answering, targets watched, incidents open. */
function healthKpis(status: unknown): StripKpi[] {
  const s = (status ?? {}) as { summary?: { services?: number; servicesUp?: number; targets?: number; targetsUp?: number; openIncidents?: number } };
  const sum = s.summary ?? {};
  const services = Number(sum.services ?? 0); const up = Number(sum.servicesUp ?? 0); const incidents = Number(sum.openIncidents ?? 0);
  return [
    { label: 'Services up', value: up, tone: services && up < services ? 'error' : 'success' },
    { label: 'Targets watched', value: Number(sum.targetsUp ?? sum.targets ?? 0) },
    { label: 'Open incidents', value: incidents, tone: incidents > 0 ? 'error' : 'default' },
  ];
}

export default function ModuleStrip() {
  const { t } = useTranslation();
  const user = useUser(); const navigate = useNavigate();
  const [data, setData] = useState<StripData | null>(null);
  const [health, setHealth] = useState<StripKpi[] | null>(null);
  const visible = MODULES.filter((m) => m.key !== 'home' && hasPerm(user, m.perm));
  useEffect(() => {
    api.get<StripData>('/dashboard/modules', { headers: { 'X-Quiet': '1' } }).then((r) => setData(r.data)).catch(() => setData({ modules: [], generatedAt: '' }));
    if (visible.some((m) => m.key === 'platform')) api.get<unknown>('/platform/status', { headers: { 'X-Quiet': '1' } }).then((r) => setHealth(healthKpis(r.data))).catch(() => setHealth([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  if (!visible.length) return null;
  const kpisOf = (m: ModuleDef): StripKpi[] | null => (m.key === 'platform' ? health : data ? (data.modules.find((x) => x.key === m.key)?.kpis ?? []) : null);
  return (
    <Box data-testid="module-strip" sx={{ mb: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 1 }}>
        <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('dash.strip.title', 'Every module at a glance')}</Typography>
        <Typography variant="caption" color="text.secondary">{t('dash.strip.sub', 'headline numbers under your own scope — open a tile for its dashboard')}</Typography>
      </Box>
      <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(224px, 1fr))', gap: 1.25 }}>
        {visible.map((m) => {
          const kpis = kpisOf(m); const Icon = m.icon;
          return (
            <Box component="li" key={m.key}>
              <Card sx={{ height: '100%' }}>
                <ButtonBase data-testid={`strip-${m.key}`} onClick={() => navigate(m.home)} aria-label={`${m.name}: ${(kpis ?? []).map((k) => `${k.label} ${formatKpi(k)}`).join(', ')}`}
                  sx={{ width: '100%', height: '100%', display: 'block', textAlign: 'start', p: 1.5, borderTop: 3, borderTopColor: m.color, borderRadius: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                    <Icon sx={{ fontSize: 18, color: m.color }} />
                    <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 700 }}>{m.name}</Typography>
                  </Box>
                  {kpis === null ? <Skeleton variant="rounded" height={44} /> : kpis.length === 0 ? <Typography variant="caption" color="text.secondary">{t('dash.strip.open', 'Open the dashboard')}</Typography> : (
                    <Box sx={{ display: 'grid', gridTemplateColumns: kpis.length > 2 ? '1fr 1fr 1fr' : '1fr 1fr', gap: 0.5 }}>
                      {kpis.slice(0, 3).map((k) => (
                        <Box key={k.label} sx={{ minWidth: 0 }}>
                          <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 16, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', color: TONE[k.tone ?? 'default'] }}>{formatKpi(k)}</Typography>
                          <Typography noWrap sx={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.secondary' }}>{k.label}</Typography>
                        </Box>
                      ))}
                    </Box>
                  )}
                </ButtonBase>
              </Card>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
