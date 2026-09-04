import { useEffect, useRef, useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Drawer, List, ListItemButton, ListItemIcon, ListItemText, Typography, Divider, AppBar, Toolbar, IconButton, Badge, Menu, MenuItem, ListSubheader, Chip, Avatar, Popover, ListItem, ListItemAvatar, Tooltip, useMediaQuery, Dialog, Grow, ButtonBase, Fade } from '@mui/material';
import AppsRoundedIcon from '@mui/icons-material/AppsRounded';
import AnchorRoundedIcon from '@mui/icons-material/AnchorRounded';
import NotificationsRoundedIcon from '@mui/icons-material/NotificationsRounded';
import DarkModeRoundedIcon from '@mui/icons-material/DarkModeRounded';
import LightModeRoundedIcon from '@mui/icons-material/LightModeRounded';
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded';
import MenuRoundedIcon from '@mui/icons-material/MenuRounded';
import MenuOpenRoundedIcon from '@mui/icons-material/MenuOpenRounded';
import PersonRoundedIcon from '@mui/icons-material/PersonRounded';
import TranslateRoundedIcon from '@mui/icons-material/TranslateRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import api from '../../api/client';
import { hasPerm } from '../../utils/perms';
import { useAppDispatch, useAppSelector, useUser } from '../../store';
import { toggleMode, setLang, toggleNav } from '../../store/uiSlice';
import { clearSession } from '../../store/authSlice';
import { fromNow, initials } from '../../utils/format';
import { BRAND_GRADIENT, MONO } from '../../theme';
import { MODULES, moduleOf } from '../../modules';
import { GlobalProgress, PageLoader } from '../common/Loaders';
import { AI_PORTAL, IS_DEMO, openAiPortal } from '../../aiPortal';
import { useProfile } from '../../config/runtime';
import type { Notification, SessionUser } from '../../types';
import CommandPalette from './CommandPalette';
import AiDock from './AiDock';
import { internalPath } from '../../utils/navigation';

const W = 236;
/* Collapsed, the sidebar becomes an icon rail rather than disappearing: navigation stays one click
 * away and the main content still has a fixed left edge to sit against. 68px is wide enough for a
 * 38px target with the same 8px gutters the expanded list uses. */
const W_RAIL = 68;
const SEVERITY_COLOR: Record<string, string> = { info: 'info.main', success: 'success.main', warning: 'warning.main', error: 'error.main' };

function Bell() {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();
  const load = () => api.get<{ items: Notification[]; unread: number }>('/notifications', { headers: { 'X-Quiet': '1' } })
    .then((r) => { setItems(r.data.items); setUnread(r.data.unread || 0); }).catch(() => {});
  useEffect(() => { load(); const timer = setInterval(load, 60000); return () => clearInterval(timer); }, []);
  return (
    <>
      <Tooltip title={t('app.notifications')}>
        <IconButton color="inherit" onClick={(e) => setAnchor(e.currentTarget)} aria-label={t('app.notifications')}>
          <Badge badgeContent={unread} color="error"><NotificationsRoundedIcon /></Badge>
        </IconButton>
      </Tooltip>
      <Popover open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }} slotProps={{ paper: { sx: { width: 380, maxHeight: 440 } } }}>
        <Box sx={{ px: 2, py: 1.25, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="subtitle2">{t('app.notifications')}</Typography>
          {unread > 0 && <Typography variant="caption" component="button" sx={{ cursor: 'pointer', color: 'primary.main', fontWeight: 600, background: 'none', border: 0, font: 'inherit' }} onClick={() => api.post('/notifications/read-all').then(load)}>{t('app.markAllRead')}</Typography>}
        </Box>
        <Divider />
        <List dense disablePadding>
          {items.length === 0 && <ListItem><ListItemText primary={t('app.nothingYet')} primaryTypographyProps={{ color: 'text.secondary' }} /></ListItem>}
          {items.map((n) => (
            <ListItemButton key={n.id} alignItems="flex-start" sx={{ opacity: n.read ? 0.62 : 1 }}
              onClick={() => { api.post(`/notifications/${n.id}/read`).then(load); if (n.link) { navigate(internalPath(n.link)); setAnchor(null); } }}>
              <ListItemAvatar sx={{ minWidth: 30, mt: 1 }}><Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: SEVERITY_COLOR[n.severity || 'info'] || 'info.main' }} /></ListItemAvatar>
              <ListItemText primary={n.title} secondary={`${n.body || ''} · ${fromNow(n.createdAt)}`} primaryTypographyProps={{ fontWeight: n.read ? 400 : 600, fontSize: 13.5 }} secondaryTypographyProps={{ fontSize: 12 }} />
            </ListItemButton>
          ))}
        </List>
      </Popover>
    </>
  );
}

function Launcher({ open, onClose, user, onOpenAi }: { open: boolean; onClose: () => void; user: SessionUser | null; onOpenAi: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const visible = MODULES.filter((m) => hasPerm(user, m.perm));
  const showAi = hasPerm(user, 'ai.use');
  const cardSx = { borderRadius: 3, p: 2, textAlign: 'left', alignItems: 'flex-start', flexDirection: 'column', gap: 1.25, border: 1, borderColor: 'divider', transition: 'all .15s' } as const;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth TransitionComponent={Grow} slotProps={{ backdrop: { sx: { backdropFilter: 'blur(5px)' } } }} PaperProps={{ sx: { borderRadius: 4, p: 1 } }} aria-label={t('app.applications')}>
      <Box sx={{ px: 3, pt: 2.5, pb: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="h6">{t('app.applications')}</Typography>
          <Typography variant="caption" color="text.secondary">{t('app.modulesAvailable', { count: visible.length, role: user?.role?.name })}{showAi && ` · ${t('app.plus', { name: AI_PORTAL.name })}`}</Typography>
        </Box>
        <IconButton onClick={onClose} aria-label="Close"><CloseRoundedIcon /></IconButton>
      </Box>
      <Box sx={{ p: 2.5, pt: 1.5, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 1.5 }}>
        {visible.map((m) => { const Icon = m.icon; return (
          <ButtonBase key={m.key} onClick={() => { onClose(); navigate(m.home); }} sx={{ ...cardSx, '&:hover': { borderColor: m.color, transform: 'translateY(-2px)', boxShadow: 3 } }}>
            <Box sx={{ width: 42, height: 42, borderRadius: '12px', display: 'grid', placeItems: 'center', bgcolor: m.color, color: '#fff' }}><Icon sx={{ fontSize: 23 }} /></Box>
            <Box><Typography sx={{ fontWeight: 700, fontSize: 14.5 }}>{m.name}</Typography><Typography sx={{ fontSize: 11.8, color: 'text.secondary', lineHeight: 1.35, mt: 0.25 }}>{m.desc}</Typography></Box>
          </ButtonBase>
        ); })}
        {showAi && (
          <ButtonBase onClick={() => { onClose(); onOpenAi(); }} sx={{ ...cardSx, borderStyle: 'dashed', '&:hover': { borderColor: AI_PORTAL.color, borderStyle: 'solid', transform: 'translateY(-2px)', boxShadow: 3 } }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
              <Box sx={{ width: 42, height: 42, borderRadius: '12px', display: 'grid', placeItems: 'center', bgcolor: AI_PORTAL.color, color: '#fff' }}><AutoAwesomeRoundedIcon sx={{ fontSize: 23 }} /></Box>
              <OpenInNewRoundedIcon sx={{ fontSize: 15, color: 'text.disabled', ml: 'auto' }} />
            </Box>
            <Box><Typography sx={{ fontWeight: 700, fontSize: 14.5 }}>{AI_PORTAL.name}</Typography><Typography sx={{ fontSize: 11.8, color: 'text.secondary', lineHeight: 1.35, mt: 0.25 }}>{AI_PORTAL.desc}</Typography></Box>
          </ButtonBase>
        )}
      </Box>
    </Dialog>
  );
}

export default function AppShell() {
  const { t } = useTranslation();
  const user = useUser();
  const mode = useAppSelector((s) => s.ui.mode);
  const lang = useAppSelector((s) => s.ui.lang);
  const profile = useProfile();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const [userMenu, setUserMenu] = useState<HTMLElement | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [launcher, setLauncher] = useState(false);
  const [aiInfo, setAiInfo] = useState(false);
  const [dock, setDock] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const wide = useMediaQuery('(min-width:1000px)');
  // Collapsing only means anything for the permanent drawer. The temporary one on a narrow screen
  // is already an overlay, and an icon rail there would be strictly worse than the full list.
  const rail = useAppSelector((st) => st.ui.navCollapsed) && wide;
  const drawerWidth = rail ? W_RAIL : W;
  const openAi = () => (IS_DEMO ? setAiInfo(true) : openAiPortal());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((v) => !v); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const activeModule = moduleOf(location.pathname);
  const prevModule = useRef(activeModule.key);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (prevModule.current !== activeModule.key) { prevModule.current = activeModule.key; setSwitching(true); const timer = setTimeout(() => setSwitching(false), 520); return () => clearTimeout(timer); }
    return undefined;
  }, [activeModule.key]);
  const ActiveIcon = activeModule.icon;
  const navSx = { borderRadius: '8px', mb: 0.25, color: '#B7C9DA', minHeight: 38, '& .MuiListItemIcon-root': { color: '#7C9BB5', minWidth: 34 }, '&.active': { bgcolor: 'rgba(11,116,176,0.32)', color: '#fff', '& .MuiListItemIcon-root': { color: '#6EC1EF' } }, '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' } };
  // In the rail the icon is the whole control, so it centres and the label's gutter goes away.
  const railSx = rail
    ? { ...navSx, justifyContent: 'center', px: 0, '& .MuiListItemIcon-root': { ...navSx['& .MuiListItemIcon-root'], minWidth: 0, justifyContent: 'center' } }
    : navSx;

  const drawer = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', bgcolor: mode === 'dark' ? '#071A2E' : '#0A2239', color: '#D8E4EE' }} component="nav" id="module-navigation" aria-label="Module navigation">
      <Box sx={{ px: rail ? 0 : 2.25, py: 2, display: 'flex', gap: 1.25, alignItems: 'center', justifyContent: rail ? 'center' : 'flex-start' }}>
        <Box sx={{ width: 34, height: 34, borderRadius: '9px', background: BRAND_GRADIENT, display: 'grid', placeItems: 'center', flexShrink: 0 }}><AnchorRoundedIcon sx={{ fontSize: 20, color: '#fff' }} /></Box>
        {!rail && (
          <Box>
            <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 15, lineHeight: 1.1, color: '#fff' }}>{t('app.name')}</Typography>
            <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.14em', color: '#7C9BB5' }}>{t('app.tag')}</Typography>
          </Box>
        )}
      </Box>
      <Tooltip title={rail ? `${activeModule.name} — ${t('app.activeModule')}` : ''} placement="right">
        <Box sx={{ mx: rail ? 1 : 1.5, mb: 1, p: rail ? 0.75 : 1.25, borderRadius: 2.5, bgcolor: 'rgba(255,255,255,0.055)', display: 'flex', gap: 1.25, alignItems: 'center', justifyContent: rail ? 'center' : 'flex-start' }}>
          <Box sx={{ width: 30, height: 30, borderRadius: '8px', bgcolor: activeModule.color, display: 'grid', placeItems: 'center', flexShrink: 0 }}><ActiveIcon sx={{ fontSize: 17, color: '#fff' }} /></Box>
          {!rail && <Box sx={{ minWidth: 0 }}><Typography noWrap sx={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{activeModule.name}</Typography><Typography noWrap sx={{ fontSize: 10, color: '#7C9BB5' }}>{t('app.activeModule')}</Typography></Box>}
        </Box>
      </Tooltip>
      <List component="div" sx={{ flex: 1, overflowY: 'auto', px: 1, py: 0.5 }} dense>
        {activeModule.nav.map((group) => (
          <Box key={group.header}>
            {group.items.some((i) => hasPerm(user, i.perm)) && (
              rail
                // A group label has nowhere to go in 68px; a rule keeps the grouping legible without it.
                ? <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', my: 0.75 }} />
                : <ListSubheader component="div" disableSticky sx={{ bgcolor: 'transparent', color: '#7C9BB5', fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.15em', textTransform: 'uppercase', lineHeight: '30px' }}>{group.header}</ListSubheader>
            )}
            {group.items.filter((i) => hasPerm(user, i.perm)).map((item) => { const ItemIcon = item.icon; return (
              <Tooltip key={item.to} title={rail ? item.label : ''} placement="right">
                <ListItemButton component={NavLink} to={item.to} end={item.end} sx={railSx}>
                  <ListItemIcon sx={{ '& svg': { fontSize: 19 } }}><ItemIcon /></ListItemIcon>
                  {!rail && <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 13.5, fontWeight: 600 }} />}
                </ListItemButton>
              </Tooltip>
            ); })}
          </Box>
        ))}
        <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', my: 1 }} />
        {hasPerm(user, 'ai.use') && (
          <Tooltip title={rail ? AI_PORTAL.name : ''} placement="right">
            <ListItemButton onClick={openAi} sx={{ ...railSx, '& .MuiListItemIcon-root': { color: AI_PORTAL.color, minWidth: rail ? 0 : 34 } }}>
              <ListItemIcon><AutoAwesomeRoundedIcon sx={{ fontSize: 19 }} /></ListItemIcon>
              {!rail && <>
                <ListItemText primary={AI_PORTAL.name} secondary="AI analytics" primaryTypographyProps={{ fontSize: 13.5, fontWeight: 600 }} secondaryTypographyProps={{ fontSize: 10.5, color: '#7C9BB5' }} />
                <OpenInNewRoundedIcon sx={{ fontSize: 13, color: '#5B7C99' }} />
              </>}
            </ListItemButton>
          </Tooltip>
        )}
        <Tooltip title={rail ? t('app.allApplications') : ''} placement="right">
          <ListItemButton onClick={() => setLauncher(true)} sx={railSx}>
            <ListItemIcon><AppsRoundedIcon sx={{ fontSize: 19 }} /></ListItemIcon>
            {!rail && <ListItemText primary={t('app.allApplications')} primaryTypographyProps={{ fontSize: 13.5, fontWeight: 600 }} />}
          </ListItemButton>
        </Tooltip>
      </List>
      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />
      <Tooltip title={rail ? `${user?.name ?? ''} — ${user?.role?.name ?? ''}` : ''} placement="right">
        <Box sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1.25, justifyContent: rail ? 'center' : 'flex-start' }}>
          <Avatar sx={{ width: 32, height: 32, background: BRAND_GRADIENT, fontSize: 14, fontWeight: 700, flexShrink: 0 }}>{initials(user?.name)}</Avatar>
          {!rail && <Box sx={{ minWidth: 0 }}><Typography noWrap sx={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{user?.name}</Typography><Typography noWrap sx={{ fontSize: 11, color: '#7C9BB5' }}>{user?.role?.name}</Typography></Box>}
        </Box>
      </Tooltip>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <Drawer
        variant={wide ? 'permanent' : 'temporary'}
        open={wide ? true : mobileOpen}
        onClose={() => setMobileOpen(false)}
        sx={{
          width: wide ? drawerWidth : W,
          flexShrink: 0,
          // Animate the width on both the slot and the paper, or the paper snaps while the space
          // reserved for it eases, and the main content visibly tears away from the sidebar.
          transition: (th) => th.transitions.create('width', { duration: th.transitions.duration.shorter }),
          '& .MuiDrawer-paper': {
            width: wide ? drawerWidth : W,
            border: 0,
            overflowX: 'hidden',
            transition: (th) => th.transitions.create('width', { duration: th.transitions.duration.shorter }),
          },
        }}
      >{drawer}</Drawer>
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <AppBar position="sticky" elevation={0} color="transparent" sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}>
          <Toolbar variant="dense" sx={{ minHeight: 54, gap: 0.75 }}>
            {/* One control at every width: it opens the overlay on a narrow screen and collapses the
                sidebar to a rail on a wide one. aria-expanded reports the sidebar's real state. */}
            <Tooltip title={wide ? (rail ? t('app.expandNav') : t('app.collapseNav')) : t('app.openNav')}>
              <IconButton
                edge="start"
                data-testid="nav-toggle"
                onClick={() => (wide ? dispatch(toggleNav()) : setMobileOpen(true))}
                aria-label={wide ? (rail ? t('app.expandNav') : t('app.collapseNav')) : t('app.openNav')}
                aria-expanded={wide ? !rail : mobileOpen}
                aria-controls="module-navigation"
              >
                {wide && !rail ? <MenuOpenRoundedIcon /> : <MenuRoundedIcon />}
              </IconButton>
            </Tooltip>
            <Tooltip title={t('app.allApplications')}><IconButton onClick={() => setLauncher(true)} sx={{ borderRadius: 2 }} aria-label={t('app.allApplications')}><AppsRoundedIcon /></IconButton></Tooltip>
            <Chip size="small" label={activeModule.name} sx={{ bgcolor: activeModule.color, color: '#fff', fontWeight: 700, fontSize: 11, display: { xs: 'none', sm: 'inline-flex' } }} />
            <ButtonBase onClick={() => setPaletteOpen(true)} aria-label={t('app.search')} sx={{ ml: { xs: 0.5, sm: 2 }, px: 1.25, py: 0.5, borderRadius: 2, gap: 1, display: 'flex', alignItems: 'center', border: 1, borderColor: 'divider', color: 'text.secondary', maxWidth: 280, flex: { xs: 1, sm: '0 1 auto' }, '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' } }}>
              <SearchRoundedIcon sx={{ fontSize: 17 }} />
              <Typography noWrap sx={{ fontSize: 12.5, display: { xs: 'none', sm: 'block' } }}>{t('app.search')}</Typography>
              <Chip size="small" label={navigator.platform && /Mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl K'} sx={{ ml: 'auto', height: 18, fontSize: 9.5, display: { xs: 'none', md: 'inline-flex' } }} />
            </ButtonBase>
            <Box sx={{ flex: 1 }} />
            <Chip size="small" label={IS_DEMO ? t('app.readOnly') : t('app.demoData')} color="warning" variant="outlined" sx={{ fontSize: 10, fontWeight: 700, display: { xs: 'none', md: 'inline-flex' } }} />
            {profile.languages.length > 1 && (
              <Tooltip title={t('app.language')}><IconButton color="inherit" onClick={() => dispatch(setLang(lang === 'ar' ? 'en' : 'ar'))} aria-label={t('app.language')}><TranslateRoundedIcon /></IconButton></Tooltip>
            )}
            <Tooltip title={mode === 'dark' ? t('app.lightMode') : t('app.darkMode')}><IconButton color="inherit" onClick={() => dispatch(toggleMode())} aria-label={mode === 'dark' ? t('app.lightMode') : t('app.darkMode')}>{mode === 'dark' ? <LightModeRoundedIcon /> : <DarkModeRoundedIcon />}</IconButton></Tooltip>
            <Bell />
            <IconButton onClick={(e) => setUserMenu(e.currentTarget)} sx={{ p: 0.5 }} aria-label="Account menu"><Avatar sx={{ width: 30, height: 30, background: BRAND_GRADIENT, fontSize: 13, fontWeight: 700 }}>{initials(user?.name)}</Avatar></IconButton>
            <Menu anchorEl={userMenu} open={!!userMenu} onClose={() => setUserMenu(null)}>
              <MenuItem onClick={() => { setUserMenu(null); navigate('/profile'); }}><ListItemIcon><PersonRoundedIcon fontSize="small" /></ListItemIcon>{t('app.profile')}</MenuItem>
              <Divider />
              <MenuItem onClick={() => { setUserMenu(null); dispatch(clearSession()); }}><ListItemIcon><LogoutRoundedIcon fontSize="small" /></ListItemIcon>{t('app.signOut')}</MenuItem>
            </Menu>
          </Toolbar>
          <GlobalProgress />
        </AppBar>
        <Box component="main" id="main" sx={{ flex: 1, p: { xs: 2, md: 3 }, maxWidth: 1480, width: '100%', mx: 'auto' }}>
          {switching ? <PageLoader label={t('app.opening', { name: activeModule.name })} /> : <Fade in timeout={250}><Box><Outlet /></Box></Fade>}
        </Box>
      </Box>
      <Launcher open={launcher} onClose={() => setLauncher(false)} user={user} onOpenAi={openAi} />
      {hasPerm(user, 'ai.use') && (
        <Tooltip title="Port Assistant — ask about live records" placement="left">
          <IconButton onClick={() => setDock(true)} aria-label="Open the port assistant"
            sx={{ position: 'fixed', right: 22, bottom: 22, zIndex: (th) => th.zIndex.drawer + 2, width: 54, height: 54, background: BRAND_GRADIENT, color: '#fff', boxShadow: '0 8px 22px rgba(11,50,80,0.38)', transition: 'all .18s',
              '&:hover': { background: BRAND_GRADIENT, transform: 'translateY(-2px)', boxShadow: '0 12px 26px rgba(11,50,80,0.45)' },
              '&::after': { content: '""', position: 'absolute', inset: -5, borderRadius: '50%', border: '2px solid', borderColor: 'rgba(117,71,156,0.45)', animation: 'aiPulse 2.6s ease-out infinite' },
              '@keyframes aiPulse': { '0%': { transform: 'scale(0.85)', opacity: 0.9 }, '70%': { transform: 'scale(1.22)', opacity: 0 }, '100%': { transform: 'scale(1.22)', opacity: 0 } } }}>
            <AutoAwesomeRoundedIcon sx={{ fontSize: 26 }} />
          </IconButton>
        </Tooltip>
      )}
      <AiDock open={dock} onClose={() => setDock(false)} onOpenPortal={openAi} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Dialog open={aiInfo} onClose={() => setAiInfo(false)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 4, p: 1 } }}>
        <Box sx={{ p: 3 }}>
          <Box sx={{ width: 46, height: 46, borderRadius: '13px', bgcolor: AI_PORTAL.color, display: 'grid', placeItems: 'center', mb: 1.75 }}><AutoAwesomeRoundedIcon sx={{ fontSize: 25, color: '#fff' }} /></Box>
          <Typography sx={{ fontWeight: 700, fontSize: 17 }}>{AI_PORTAL.name}</Typography>
          <Typography sx={{ fontSize: 13.5, color: 'text.secondary', mt: 1, lineHeight: 1.6 }}>{AI_PORTAL.desc}. It is a companion application to this portal, running on the same dataset.</Typography>
          <Typography sx={{ fontSize: 13.5, color: 'text.secondary', mt: 1.5, lineHeight: 1.6 }}>It needs its own server, so it is not part of this read-only demo. In a full deployment it opens from here in one click.</Typography>
          <Box sx={{ mt: 2.5, display: 'flex', justifyContent: 'flex-end' }}><Chip label="Got it" onClick={() => setAiInfo(false)} color="primary" sx={{ fontWeight: 600 }} /></Box>
        </Box>
      </Dialog>
    </Box>
  );
}
