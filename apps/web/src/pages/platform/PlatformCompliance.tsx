import { useTranslation } from 'react-i18next';
import { Box, Card, Chip, Grid, Link, Stack, Typography, Divider } from '@mui/material';
import RuleRoundedIcon from '@mui/icons-material/RuleRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import { MONO } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import { COMPLIANCE, COMPLIANCE_URL, PLAN_URL, COMPLIANCE_COMPILED, statusColor } from './compliance';

/* The headline of the RFP compliance matrix, with the full traceability living in the published
 * artifact. The counts are stated here as of the compile date rather than computed: they are a
 * judgement about 70 written commitments, not something the platform can measure about itself. */

const num = { fontVariantNumeric: 'tabular-nums' } as const;
const label = { fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'text.secondary' };

export default function PlatformCompliancePage() {
  const { t } = useTranslation();
  const total = COMPLIANCE.totals.reduce((a, s) => a + s.count, 0);

  return (
    <Box>
      <PageHeader icon={RuleRoundedIcon} title={t('platform.compliance.title')} sub={t('platform.compliance.subtitle', { n: total, at: COMPLIANCE_COMPILED })} />

      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        {COMPLIANCE.totals.map((s) => (
          <Grid item xs={6} md={3} key={s.key}>
            <Card data-testid={`compliance-${s.key}`} sx={{ px: 2, py: 1.5, borderTop: 3, borderColor: statusColor(s.key) }}>
              <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 26, ...num, color: statusColor(s.key) }}>{s.count}</Typography>
              <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>{t(`platform.compliance.status.${s.key}`)}</Typography>
              <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.25, lineHeight: 1.4 }}>{t(`platform.compliance.statusHelp.${s.key}`)}</Typography>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Grid container spacing={1.5}>
        <Grid item xs={12} lg={7}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography sx={{ ...label, mb: 1.25 }}>{t('platform.compliance.bySection')}</Typography>
            <Stack spacing={1.25}>
              {COMPLIANCE.sections.map((sec) => {
                const n = sec.built + sec.partial + sec.absent + sec.diverged;
                return (
                  <Box key={sec.key}>
                    <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 0.5 }}>
                      <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>{sec.label}</Typography>
                      <Typography sx={{ ...label, fontSize: 10 }}>{n}</Typography>
                    </Stack>
                    {/* one bar per section: proportions, not a score — the sections are different sizes */}
                    <Box sx={{ display: 'flex', height: 7, borderRadius: 1, overflow: 'hidden', bgcolor: 'divider' }}>
                      {(['built', 'partial', 'absent', 'diverged'] as const).map((k) => (
                        sec[k] > 0 ? <Box key={k} sx={{ width: `${(sec[k] / n) * 100}%`, bgcolor: statusColor(k) }} /> : null
                      ))}
                    </Box>
                  </Box>
                );
              })}
            </Stack>
          </Card>
        </Grid>

        <Grid item xs={12} lg={5}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography sx={{ ...label, mb: 1.25 }}>{t('platform.compliance.deltaTitle')}</Typography>
            <Stack spacing={1.25} divider={<Divider flexItem />}>
              {COMPLIANCE.delta.map((d, i) => (
                <Box key={d.key}>
                  <Stack direction="row" spacing={1} alignItems="baseline">
                    <Typography sx={{ ...label, fontSize: 11, minWidth: 14 }}>{i + 1}</Typography>
                    <Box>
                      <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>{d.name}</Typography>
                      <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.5 }}>{d.why}</Typography>
                    </Box>
                  </Stack>
                </Box>
              ))}
            </Stack>
          </Card>
        </Grid>

        <Grid item xs={12}>
          <Card sx={{ p: 2.5, borderLeft: 3, borderColor: 'primary.main' }}>
            <Typography sx={{ fontSize: 14.5, fontWeight: 600, mb: 0.5 }}>{t('platform.compliance.fullTitle')}</Typography>
            <Typography sx={{ fontSize: 13.5, color: 'text.secondary', mb: 1.5, maxWidth: '72ch', lineHeight: 1.6 }}>{t('platform.compliance.fullBody')}</Typography>
            <Stack direction="row" spacing={2.5} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              <Link href={COMPLIANCE_URL} target="_blank" rel="noopener noreferrer" data-testid="compliance-link"
                sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, fontWeight: 600, fontSize: 14 }}>
                {t('platform.compliance.open')}<OpenInNewRoundedIcon sx={{ fontSize: 15 }} />
              </Link>
              <Link href={PLAN_URL} target="_blank" rel="noopener noreferrer" data-testid="plan-link"
                sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, fontWeight: 600, fontSize: 14 }}>
                {t('platform.compliance.openPlan')}<OpenInNewRoundedIcon sx={{ fontSize: 15 }} />
              </Link>
            </Stack>
            {/* a Chip renders a div, so the line around it has to be a div too — inside a <p> it is invalid nesting */}
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 0.5 }}>
              <Chip size="small" label={t('platform.compliance.internal')} color="warning" variant="outlined" sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />
              <Typography component="span" sx={{ fontSize: 11.5, color: 'text.secondary' }}>{t('platform.compliance.internalHelp')}</Typography>
            </Stack>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
