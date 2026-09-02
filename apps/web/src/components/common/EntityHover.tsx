import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Popper, Paper, Typography, Chip, Stack, Divider, Skeleton, Fade, Avatar, Button } from '@mui/material';
import LaunchRoundedIcon from '@mui/icons-material/LaunchRounded';
import api from '../../api/client';
import { BRAND_GRADIENT, MONO } from '../../theme';
import { fromNow, initials } from '../../utils/format';
import type { ChipColor } from '../../utils/status';

/* Teams-style entity hover card. Wrap any label: <EntityHover type="vessel" id={row.vesselId}>{row.vesselName}</EntityHover>
 * Types come from /cards/:type/:id — user, vessel, seafarer, berth, agent, incident, company. Cards are cached for the session. */
export interface HoverCard { kind: string; title: string; subtitle?: string; link?: string; lines?: { label: string; value: string | null; kind?: 'since' }[]; chips?: { label: string; tone?: string }[]; error?: boolean }
const cache = new Map<string, HoverCard>();
const TONE_COLOR: Record<string, ChipColor> = { success: 'success', warning: 'warning', error: 'error', info: 'info', default: 'default' };
const KIND_COLOR: Record<string, string> = { user: '#75479C', vessel: '#3B6FB6', seafarer: '#75479C', berth: '#0797A5', agent: '#2C6E52', company: '#2C6E52', incident: '#B3452E' };

export default function EntityHover({ type, id, children, underline = true }: { type: string; id?: string | null; children: React.ReactNode; underline?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [card, setCard] = useState<HoverCard | null>(null);
  const navigate = useNavigate();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const closing = useRef<ReturnType<typeof setTimeout>>();
  const key = `${type}:${id}`;
  const open = (e: React.MouseEvent<HTMLElement>) => {
    if (!id) return;
    clearTimeout(closing.current);
    const el = e.currentTarget;
    timer.current = setTimeout(() => {
      setAnchor(el);
      if (cache.has(key)) { setCard(cache.get(key)!); return; }
      setCard(null);
      api.get<HoverCard>(`/cards/${type}/${id}`, { headers: { 'X-Quiet': '1' } })
        .then((r) => { cache.set(key, r.data); setCard(r.data); })
        .catch(() => { const err = { kind: type, title: '', error: true }; cache.set(key, err); setCard(err); });
    }, 420);
  };
  const scheduleClose = () => { clearTimeout(timer.current); closing.current = setTimeout(() => setAnchor(null), 220); };
  const holdOpen = () => clearTimeout(closing.current);
  return (
    <>
      <Box component="span" onMouseEnter={open} onMouseLeave={scheduleClose} onFocus={open as never} onBlur={scheduleClose} tabIndex={id ? 0 : undefined}
        sx={{ cursor: 'pointer', borderBottom: underline ? '1px dotted' : 0, borderColor: 'text.disabled', '&:hover': { color: 'primary.main' } }}>
        {children}
      </Box>
      <Popper open={!!anchor} anchorEl={anchor} placement="bottom-start" transition sx={{ zIndex: (t) => t.zIndex.tooltip + 1 }} modifiers={[{ name: 'offset', options: { offset: [0, 6] } }]}>
        {({ TransitionProps }) => (
          <Fade {...TransitionProps} timeout={140}>
            <Paper elevation={8} onMouseEnter={holdOpen} onMouseLeave={scheduleClose} sx={{ width: 316, borderRadius: 2.5, overflow: 'hidden', border: 1, borderColor: 'divider' }}>
              {!card && (
                <Box sx={{ p: 2 }}>
                  <Stack direction="row" spacing={1.5} alignItems="center"><Skeleton variant="circular" width={40} height={40} /><Box sx={{ flex: 1 }}><Skeleton width="70%" /><Skeleton width="45%" /></Box></Stack>
                  <Skeleton sx={{ mt: 1.5 }} /><Skeleton width="80%" />
                </Box>
              )}
              {card && card.error && <Box sx={{ p: 2 }}><Typography variant="body2" color="text.secondary">No further details available.</Typography></Box>}
              {card && !card.error && (
                <>
                  <Box sx={{ px: 2, pt: 1.75, pb: 1.25, display: 'flex', gap: 1.5, alignItems: 'center' }}>
                    <Avatar sx={{ width: 42, height: 42, fontSize: 15, fontWeight: 700, background: KIND_COLOR[card.kind] || BRAND_GRADIENT, color: '#fff' }}>{initials(card.title)}</Avatar>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography noWrap sx={{ fontWeight: 700, fontSize: 14.5 }}>{card.title}</Typography>
                      <Typography noWrap sx={{ fontSize: 12, color: 'text.secondary' }}>{card.subtitle}</Typography>
                    </Box>
                  </Box>
                  {!!(card.chips || []).length && (
                    <Stack direction="row" spacing={0.75} sx={{ px: 2, pb: 1.25, flexWrap: 'wrap' }} useFlexGap>
                      {card.chips!.map((c, i) => <Chip key={i} size="small" label={c.label} color={TONE_COLOR[c.tone || 'default'] || 'default'} variant={c.tone === 'default' || !c.tone ? 'outlined' : 'filled'} sx={{ height: 20, fontSize: 10.5, fontWeight: 700 }} />)}
                    </Stack>
                  )}
                  <Divider />
                  <Box sx={{ px: 2, py: 1.25 }}>
                    {(card.lines || []).map((l, i) => (
                      <Box key={i} sx={{ display: 'flex', gap: 1, py: 0.4 }}>
                        <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary', width: 86, flexShrink: 0, pt: 0.2 }}>{l.label}</Typography>
                        <Typography sx={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>{l.kind === 'since' ? (l.value ? fromNow(l.value) : '—') : (l.value ?? '—')}</Typography>
                      </Box>
                    ))}
                  </Box>
                  {card.link && (
                    <>
                      <Divider />
                      <Button fullWidth size="small" endIcon={<LaunchRoundedIcon sx={{ fontSize: 14 }} />} onClick={() => { setAnchor(null); navigate(card.link!); }} sx={{ borderRadius: 0, py: 0.75, fontSize: 12 }}>Open record</Button>
                    </>
                  )}
                </>
              )}
            </Paper>
          </Fade>
        )}
      </Popper>
    </>
  );
}
