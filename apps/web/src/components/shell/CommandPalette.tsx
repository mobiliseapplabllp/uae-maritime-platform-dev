import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, Box, InputBase, List, ListItemButton, ListItemText, Typography, Chip, Divider } from '@mui/material';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import api from '../../api/client';
import { MODULES } from '../../modules';
import { hasPerm } from '../../utils/perms';
import { useUser } from '../../store';

/* Global Ctrl+K command palette — search every register, or jump straight to a module. Recent picks are remembered per browser. */
interface Hit { id: string; label: string; sub?: string; to: string }
interface Group { type: string; label: string; items: Hit[] }
interface Recent { label: string; sub?: string; to: string }
const RECENTS_KEY = 'maritime.palette.recents';
const loadRecents = (): Recent[] => { try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); } catch { return []; } };
const saveRecent = (item: Recent) => { try { const list = loadRecents().filter((r) => r.to !== item.to); list.unshift(item); localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* convenience only */ } };
const Sub = ({ children }: { children: React.ReactNode }) => <Typography sx={{ px: 2, pt: 1.25, fontSize: 10.5, letterSpacing: '0.1em', color: 'text.secondary', textTransform: 'uppercase' }}>{children}</Typography>;

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const user = useUser();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => { if (open) { setQ(''); setResults(null); setTimeout(() => inputRef.current?.focus(), 60); } }, [open]);
  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults(null); return; }
    timer.current = setTimeout(() => {
      setBusy(true);
      api.get<{ groups: Group[] }>('/search', { params: { q } }).then((r) => setResults(r.data.groups)).catch(() => setResults([])).finally(() => setBusy(false));
    }, 220);
    return () => clearTimeout(timer.current);
  }, [q]);

  const navCommands = useMemo(() => MODULES.filter((m) => m.key !== 'home' && hasPerm(user, m.perm)).map((m) => ({ label: `Go to ${m.name}`, sub: m.desc, to: m.home, icon: m.icon, color: m.color })), [user]);
  const go = (item: Recent) => { saveRecent(item); onClose(); navigate(item.to); };
  const recents = !q.trim() ? loadRecents() : [];
  const filteredNav = !q.trim() ? [] : navCommands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 3, mt: -18, overflow: 'hidden' } }} aria-label="Command palette">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <SearchRoundedIcon sx={{ color: 'text.secondary' }} />
        <InputBase inputRef={inputRef} fullWidth placeholder="Search vessels, calls, crew, incidents, companies… or jump to a module" value={q} onChange={(e) => setQ(e.target.value)} sx={{ fontSize: 15 }} inputProps={{ 'aria-label': 'Search everything' }} />
        <Chip size="small" label="ESC" variant="outlined" sx={{ fontSize: 10, height: 20 }} />
      </Box>
      <Box sx={{ maxHeight: 420, overflowY: 'auto' }}>
        {!q.trim() && (
          <>
            {recents.length > 0 && (
              <List component="div" dense subheader={<Sub>Recent</Sub>}>
                {recents.map((r, i) => <ListItemButton key={i} onClick={() => go(r)}><ListItemText primary={r.label} secondary={r.sub} primaryTypographyProps={{ fontSize: 13.5 }} secondaryTypographyProps={{ fontSize: 11.5 }} /></ListItemButton>)}
              </List>
            )}
            <List component="div" dense subheader={<Sub>Modules</Sub>}>
              {navCommands.map((c) => { const Icon = c.icon; return (
                <ListItemButton key={c.to} onClick={() => go(c)}>
                  <Box sx={{ width: 26, height: 26, borderRadius: '7px', bgcolor: c.color, display: 'grid', placeItems: 'center', mr: 1.25, flexShrink: 0 }}><Icon sx={{ fontSize: 15, color: '#fff' }} /></Box>
                  <ListItemText primary={c.label} secondary={c.sub} primaryTypographyProps={{ fontSize: 13.5 }} secondaryTypographyProps={{ fontSize: 11.5, noWrap: true }} />
                </ListItemButton>
              ); })}
            </List>
          </>
        )}
        {q.trim() && (
          <>
            {filteredNav.length > 0 && (
              <List component="div" dense subheader={<Sub>Go to</Sub>}>
                {filteredNav.map((c) => <ListItemButton key={c.to} onClick={() => go(c)}><ArrowForwardRoundedIcon sx={{ fontSize: 16, mr: 1.25, color: 'text.secondary' }} /><ListItemText primary={c.label} primaryTypographyProps={{ fontSize: 13.5 }} /></ListItemButton>)}
              </List>
            )}
            {busy && <Typography sx={{ px: 2, py: 2, fontSize: 13, color: 'text.secondary' }}>Searching…</Typography>}
            {!busy && results && results.length === 0 && q.trim().length >= 2 && <Typography sx={{ px: 2, py: 2, fontSize: 13, color: 'text.secondary' }}>No matches for "{q}"</Typography>}
            {!busy && results && results.map((g) => (
              <Box key={g.type}>
                <Divider />
                <List component="div" dense subheader={<Sub>{g.label}</Sub>}>
                  {g.items.map((it) => <ListItemButton key={it.id} onClick={() => go({ label: it.label, sub: g.label, to: it.to })}><ListItemText primary={it.label} secondary={it.sub} primaryTypographyProps={{ fontSize: 13.5 }} secondaryTypographyProps={{ fontSize: 11.5 }} /></ListItemButton>)}
                </List>
              </Box>
            ))}
          </>
        )}
      </Box>
    </Dialog>
  );
}
