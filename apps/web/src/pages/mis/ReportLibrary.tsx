import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Grid, Card, Box, Typography, ButtonBase, Chip, Stack, Skeleton } from '@mui/material';
import type { SvgIconComponent } from '@mui/icons-material';
import LibraryBooksRoundedIcon from '@mui/icons-material/LibraryBooksRounded';
import AnchorRoundedIcon from '@mui/icons-material/AnchorRounded';
import DirectionsBoatFilledRoundedIcon from '@mui/icons-material/DirectionsBoatFilledRounded';
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import CrisisAlertRoundedIcon from '@mui/icons-material/CrisisAlertRounded';
import BadgeRoundedIcon from '@mui/icons-material/BadgeRounded';
import CorporateFareRoundedIcon from '@mui/icons-material/CorporateFareRounded';
import AdminPanelSettingsRoundedIcon from '@mui/icons-material/AdminPanelSettingsRounded';
import DescriptionRoundedIcon from '@mui/icons-material/DescriptionRounded';
import api from '../../api/client';
import { useAppSelector, useUser } from '../../store';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import { MONO } from '../../theme';
import { categoryColor } from './shared';
import type { ReportDef } from './types';

/* The report library — every saved report across modules, run on demand in the viewer with Excel / PDF / print export. */
const ICONS: Record<string, SvgIconComponent> = { Traffic: AnchorRoundedIcon, Fleet: DirectionsBoatFilledRoundedIcon, Revenue: ReceiptLongRoundedIcon, Compliance: FactCheckRoundedIcon, Safety: CrisisAlertRoundedIcon, Crew: BadgeRoundedIcon, Companies: CorporateFareRoundedIcon, Administration: AdminPanelSettingsRoundedIcon };

export default function ReportLibrary() {
  const navigate = useNavigate();
  const user = useUser();
  const lang = useAppSelector((s) => s.ui.lang);
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<ReportDef[] | null>(null);

  useEffect(() => { api.get<ReportDef[]>('/reports/catalog').then((r) => setCatalog(r.data)).catch(() => setCatalog([])); }, []);

  const visible = (catalog || []).filter((c) => hasPerm(user, c.perm));
  const groups = [...new Set(visible.map((c) => c.category))];
  const nameOf = (r: ReportDef) => (lang === 'ar' && r.name_ar ? r.name_ar : r.name);

  return (
    <>
      <PageHeader icon={LibraryBooksRoundedIcon} iconColor="#0B5D8A" title={t('mis.libraryTitle')} sub={t('mis.librarySub')} />
      {!catalog && <Grid container spacing={1.5} aria-busy="true">{Array.from({ length: 8 }).map((_, i) => <Grid item xs={12} md={3} key={i}><Skeleton variant="rounded" height={110} /></Grid>)}</Grid>}
      {catalog && groups.map((g) => {
        const Icon = ICONS[g] || DescriptionRoundedIcon;
        const color = categoryColor(g);
        return (
          <Box key={g} sx={{ mb: 3 }} component="section" aria-label={g}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.25 }}>
              <Box aria-hidden sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: color }} />
              <Typography component="h2" sx={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'text.secondary' }}>{g}</Typography>
            </Stack>
            <Grid container spacing={1.5}>
              {visible.filter((c) => c.category === g).map((rep) => (
                <Grid item xs={12} sm={6} md={4} lg={3} key={rep.key}>
                  <ButtonBase onClick={() => navigate(`/reports/view/${rep.key}`)} aria-label={`${t('mis.runReport')}: ${nameOf(rep)}`} sx={{ width: '100%', textAlign: 'left', borderRadius: 3, height: '100%' }}>
                    <Card variant="outlined" sx={{ p: 1.75, width: '100%', height: '100%', display: 'flex', gap: 1.5, alignItems: 'flex-start', transition: 'all .15s', '&:hover': { borderColor: color, transform: 'translateY(-2px)', boxShadow: 3 } }}>
                      <Box aria-hidden sx={{ width: 40, height: 40, borderRadius: '11px', display: 'grid', placeItems: 'center', bgcolor: color, color: '#fff', flexShrink: 0 }}><Icon sx={{ fontSize: 22 }} /></Box>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography sx={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 }}>{nameOf(rep)}</Typography>
                        <Typography sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.4, mt: 0.4 }}>{rep.description}</Typography>
                        {rep.params.length > 0 && <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mt: 0.5, fontFamily: MONO }}>{rep.params.map((p) => `${p.label}${p.default !== undefined ? ` = ${p.default}` : ''}`).join(' · ')}</Typography>}
                      </Box>
                    </Card>
                  </ButtonBase>
                </Grid>
              ))}
            </Grid>
          </Box>
        );
      })}
      {catalog && visible.length === 0 && <Typography color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>{t('mis.noReports')}</Typography>}
      {catalog && visible.length > 0 && <Chip size="small" variant="outlined" label={t('mis.reportCount', { count: visible.length })} sx={{ fontSize: 11 }} />}
    </>
  );
}
