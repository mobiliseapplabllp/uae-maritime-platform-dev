import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Card, Chip, Grid, InputAdornment, Skeleton, Stack, TextField, Typography } from '@mui/material';
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import BoltRoundedIcon from '@mui/icons-material/BoltRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import { OpenLink } from '../../components/dashboard/kit';
import { fmtMoney } from '../../utils/format';
import { MONO } from '../../theme';
import type { Catalogue, CatalogueService } from './types';

/* The service catalogue — every published maritime service, by category, as an applicant or an assessor would browse
 * it: what it is for, whom it concerns, what it costs, how long it takes, and what it issues. GET /services/catalogue. */
const kindLabel: Record<string, string> = { VESSEL: 'Vessel', COMPANY: 'Company', SEAFARER: 'Seafarer', PORT_FACILITY: 'Port facility', MET_INSTITUTION: 'MET institution', NONE: '—' };

export default function ServiceCatalogue() {
  const { t, i18n } = useTranslation(); const navigate = useNavigate(); const dispatch = useAppDispatch();
  const [data, setData] = useState<Catalogue | null>(null);
  const [q, setQ] = useState(''); const [category, setCategory] = useState<string | null>(null);
  useEffect(() => { api.get<Catalogue>('/services/catalogue').then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [dispatch]);
  const ar = i18n.language === 'ar';
  const shown = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.categories.filter((c) => !category || c.category === category).map((c) => ({ ...c, services: c.services.filter((s) => !needle || `${s.code} ${s.name} ${s.nameAr ?? ''} ${s.description}`.toLowerCase().includes(needle)) })).filter((c) => c.services.length);
  }, [data, q, category]);
  const nameOf = (s: CatalogueService) => (ar && s.nameAr ? s.nameAr : s.name);
  return (
    <>
      <PageHeader icon={StorefrontRoundedIcon} iconColor="#0E7C86" title={t('services.catalogueTitle', 'Service catalogue')} sub={data ? t('services.catalogueSub', { defaultValue: '{{n}} services published in {{env}} · {{auto}} decided automatically when the checks pass', n: data.total, env: data.environment, auto: data.autoApprovable }) : ''}
        actions={<Stack direction="row" spacing={1}><OpenLink label={t('services.openRequests', 'Applications')} to="/services/requests" /><OpenLink label={t('services.openStudio', 'Service Studio')} to="/services/studio" /></Stack>} />
      <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', alignItems: 'center' }} useFlexGap>
        <TextField size="small" placeholder={t('services.search', 'Search services')} value={q} onChange={(e) => setQ(e.target.value)} inputProps={{ 'aria-label': t('services.search', 'Search services'), 'data-testid': 'catalogue-search' }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchRoundedIcon fontSize="small" /></InputAdornment> }} sx={{ minWidth: 260 }} />
        <Chip label={t('services.allCategories', 'All')} clickable color={category === null ? 'primary' : 'default'} onClick={() => setCategory(null)} />
        {data?.categories.map((c) => <Chip key={c.category} label={`${ar ? c.categoryAr ?? c.category : c.category} (${c.count})`} clickable color={category === c.category ? 'primary' : 'default'} onClick={() => setCategory(category === c.category ? null : c.category)} />)}
      </Stack>
      {!data ? <Grid container spacing={2}>{Array.from({ length: 6 }).map((_, i) => <Grid item xs={12} md={6} lg={4} key={i}><Skeleton variant="rounded" height={120} /></Grid>)}</Grid> : shown.map((c) => (
        <Box key={c.category} sx={{ mb: 3 }} data-testid={`catalogue-${c.category.replace(/\s+/g, '-').toLowerCase()}`}>
          <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{ar ? c.categoryAr ?? c.category : c.category} <Typography component="span" variant="caption" color="text.secondary">· {c.services.length}</Typography></Typography>
          <Grid container spacing={1.5}>
            {c.services.map((s) => (
              <Grid item xs={12} md={6} lg={4} key={s.key}>
                <Card component="article" data-testid={`service-${s.key}`} onClick={() => navigate(`/services/${s.key}`)} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/services/${s.key}`); }} aria-label={nameOf(s)}
                  sx={{ p: 1.75, height: '100%', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 0.75, '&:hover': { borderColor: 'primary.main' } }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'flex-start' }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: 'text.secondary' }}>{s.code} · v{s.version}</Typography>
                      <Typography sx={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3 }}>{nameOf(s)}</Typography>
                    </Box>
                    {s.autoApprovable && <Chip size="small" icon={<BoltRoundedIcon />} label={t('services.auto', 'Auto')} color="success" variant="outlined" sx={{ height: 20, fontSize: 10.5 }} />}
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{ar && s.descriptionAr ? s.descriptionAr : s.description}</Typography>
                  <Stack direction="row" spacing={0.75} sx={{ mt: 'auto', flexWrap: 'wrap' }} useFlexGap>
                    <Chip size="small" label={kindLabel[s.subjectKind] ?? s.subjectKind} sx={{ height: 20, fontSize: 10.5 }} />
                    <Chip size="small" label={`${s.slaDays} ${t('services.days', 'days')}`} sx={{ height: 20, fontSize: 10.5 }} />
                    <Chip size="small" label={s.fee.amount ? fmtMoney(s.fee.amount) : t('services.noFee', 'No fee')} sx={{ height: 20, fontSize: 10.5 }} />
                    {s.instrumentType && <Chip size="small" label={t('services.issues', { defaultValue: 'Issues {{what}}', what: s.instrumentType.replace(/_/g, ' ').toLowerCase() })} sx={{ height: 20, fontSize: 10.5 }} variant="outlined" />}
                  </Stack>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Box>
      ))}
      {data && !shown.length && <Typography color="text.secondary">{t('services.nothing', 'No service matches')}</Typography>}
    </>
  );
}
