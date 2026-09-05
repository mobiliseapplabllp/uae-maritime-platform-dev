import { Suspense, useEffect, useMemo } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ThemeProvider, CssBaseline, Snackbar, Alert } from '@mui/material';
import { CacheProvider } from '@emotion/react';
import createCache from '@emotion/cache';
import { prefixer } from 'stylis';
import rtlPlugin from 'stylis-plugin-rtl';
import { useTranslation } from 'react-i18next';
import { buildTheme } from './theme';
import { useAppDispatch, useAppSelector } from './store';
import { clearSnackbar } from './store/uiSlice';
import { setProfile, type Profile } from './config/runtime';
import api from './api/client';
import AppShell from './components/shell/AppShell';
import IdleWatch from './components/shell/IdleWatch';
import { PageLoader } from './components/common/Loaders';
import { StatePage } from './components/common/StatePage';
import { Guard, ROUTES, PUBLIC_ROUTES } from './routes';

const ltrCache = createCache({ key: 'mui', prepend: true });
const rtlCache = createCache({ key: 'mui-rtl', prepend: true, stylisPlugins: [prefixer, rtlPlugin] });

export default function App() {
  const mode = useAppSelector((s) => s.ui.mode);
  const lang = useAppSelector((s) => s.ui.lang);
  const snackbar = useAppSelector((s) => s.ui.snackbar);
  const user = useAppSelector((s) => s.auth.user);
  const dispatch = useAppDispatch();
  const location = useLocation();
  const { i18n, t } = useTranslation();
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const theme = useMemo(() => buildTheme(mode, dir), [mode, dir]);

  useEffect(() => { void i18n.changeLanguage(lang); document.documentElement.setAttribute('dir', dir); document.documentElement.setAttribute('lang', lang); }, [lang, dir, i18n]);
  useEffect(() => { api.get<Profile>('/jurisdiction', { headers: { 'X-Quiet': '1' } }).then((r) => setProfile(r.data)).catch(() => {}); }, []);

  return (
    <CacheProvider value={dir === 'rtl' ? rtlCache : ltrCache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Suspense fallback={<PageLoader />}>
          <Routes>
            {PUBLIC_ROUTES.map((r) => <Route key={r.path} path={r.path} element={r.path === '/login' && user ? <Navigate to="/" replace /> : r.element} />)}
            <Route element={user ? <><IdleWatch /><AppShell /></> : <Navigate to="/login" replace state={{ from: location }} />}>
              {ROUTES.map((r) => <Route key={r.path} path={r.path} element={r.redirect ? <Navigate to={r.redirect} replace /> : <Guard perm={r.perm}>{r.element}</Guard>} />)}
              <Route path="*" element={<StatePage code="404" title={t('common.notFound')} message={t('common.notFoundMsg')} />} />
            </Route>
          </Routes>
        </Suspense>
        <Snackbar open={!!snackbar} autoHideDuration={3500} onClose={() => dispatch(clearSnackbar())} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
          {snackbar ? <Alert severity={snackbar.severity || 'success'} variant="filled" onClose={() => dispatch(clearSnackbar())}>{snackbar.message}</Alert> : <span />}
        </Snackbar>
      </ThemeProvider>
    </CacheProvider>
  );
}
