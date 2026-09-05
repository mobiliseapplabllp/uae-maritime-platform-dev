import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Container, IconButton, Link, Tooltip, Typography } from '@mui/material';
import TranslateRoundedIcon from '@mui/icons-material/TranslateRounded';
import RssFeedRoundedIcon from '@mui/icons-material/RssFeedRounded';
import PlatformWordmark from '../../components/brand/PlatformWordmark';
import { useAppDispatch, useAppSelector } from '../../store';
import { setLang } from '../../store/uiSlice';

/* The frame of the public legislation portal: no session, no navigation, both languages.
 * A reader lands here from a citation, a search engine or the desk's own "open portal page" button. */
export const LAW_ROOT = '/law';
export default function LawFrame({ children, feedUrl, crumb }: { children: React.ReactNode; feedUrl?: string | null; crumb?: React.ReactNode }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const lang = useAppSelector((s) => s.ui.lang);
  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', display: 'flex', flexDirection: 'column' }}>
      <Link href="#main" sx={{ position: 'absolute', left: -9999, '&:focus': { left: 16, top: 8, zIndex: 10, bgcolor: 'background.paper', p: 1 } }}>{t('legislation.portal.skip')}</Link>
      <Box component="header" sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper', '@media print': { display: 'none' } }}>
        <Container maxWidth="lg" sx={{ py: 1.5, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Link component={RouterLink} to={LAW_ROOT} underline="none" color="inherit" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }} aria-label={t('legislation.portal.publicTitle')}>
            <PlatformWordmark height={22} />
            <Typography sx={{ fontWeight: 700, fontSize: 15 }}>{t('legislation.portal.publicTitle')}</Typography>
          </Link>
          <Box sx={{ flex: 1 }} />
          {crumb}
          {feedUrl && <Tooltip title={t('legislation.portal.feed')}><IconButton component="a" href={feedUrl} aria-label={t('legislation.portal.feed')} size="small"><RssFeedRoundedIcon /></IconButton></Tooltip>}
          <Tooltip title={t('app.language')}><IconButton onClick={() => dispatch(setLang(lang === 'ar' ? 'en' : 'ar'))} aria-label={t('app.language')} size="small"><TranslateRoundedIcon /></IconButton></Tooltip>
        </Container>
      </Box>
      <Container component="main" id="main" maxWidth="lg" sx={{ py: 3, flex: 1 }}>{children}</Container>
      <Box component="footer" sx={{ borderTop: 1, borderColor: 'divider', '@media print': { display: 'none' } }}>
        <Container maxWidth="lg" sx={{ py: 2 }}>
          <Typography variant="caption" color="text.secondary">{t('legislation.portal.footer')}</Typography>
        </Container>
      </Box>
    </Box>
  );
}
