import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Box, Typography, Skeleton, Stack, Button, Tooltip, Chip, ButtonGroup } from '@mui/material';
import ViewTimelineRoundedIcon from '@mui/icons-material/ViewTimelineRounded';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import { MONO } from '../../theme';
import { TERM_COLOR } from './constants';
import { DAY, dayTicks, fmtDayShort, pctOf, plannerStart, spanOf } from './planner';
import type { BerthPlan, PlanBlock } from './types';

/* Berth window planner — every berth as a lane, every call as a block. Time runs left to right; unallocated inbound calls
 * sit in a rail below, from which the register opens to assign a berth. Conflicts are computed server-side. */
const DAYS = 6;
const ROW_H = 46;

export default function BerthPlanner() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const mode = useAppSelector((s) => s.ui.mode);
  const [data, setData] = useState<BerthPlan | null>(null);
  const [from, setFrom] = useState<Date>(() => plannerStart());

  useEffect(() => {
    api.get<BerthPlan>('/ops/berth-plan', { params: { from: from.toISOString(), days: DAYS } })
      .then((r) => setData(r.data))
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  }, [from, dispatch]);

  const span = useMemo(() => (data ? spanOf(data.window.from, data.window.to) : null), [data]);

  if (!data || !span) return <><PageHeader icon={ViewTimelineRoundedIcon} iconColor="#0797A5" title="Berth Window Planner" sub="Loading…" /><Skeleton variant="rounded" height={520} /></>;

  const nowPct = pctOf(span, new Date());
  const ticks = dayTicks(span);
  const conflictBerths = new Set(data.conflicts.map((c) => c.berthId));
  const grid = mode === 'dark' ? '#1E3844' : '#E4EAE9';
  const open = (id: string) => navigate(`/port-calls/${id}`);
  const blockTitle = (bl: PlanBlock) => `${bl.vessel ? bl.vessel.name : ''} · ${bl.vcn} · ${bl.status}${bl.actual ? ' (actual)' : ' (planned)'}`;

  return (
    <>
      <PageHeader icon={ViewTimelineRoundedIcon} iconColor="#0797A5" title="Berth Window Planner"
        sub={`${data.berths.length} berths · ${fmtDayShort(data.window.from)} – ${fmtDayShort(data.window.to)}`}
        actions={(
          <Stack direction="row" spacing={1} alignItems="center">
            {data.conflicts.length > 0 && <Chip size="small" color="error" icon={<WarningAmberRoundedIcon sx={{ fontSize: 15 }} />} label={`${data.conflicts.length} berth conflict${data.conflicts.length > 1 ? 's' : ''}`} />}
            <ButtonGroup size="small" variant="outlined" aria-label="Planner window">
              <Button aria-label="Two days earlier" onClick={() => setFrom((f) => new Date(f.getTime() - 2 * DAY))}><ChevronLeftRoundedIcon fontSize="small" /></Button>
              <Button onClick={() => setFrom(plannerStart())}>Today</Button>
              <Button aria-label="Two days later" onClick={() => setFrom((f) => new Date(f.getTime() + 2 * DAY))}><ChevronRightRoundedIcon fontSize="small" /></Button>
            </ButtonGroup>
          </Stack>
        )} />

      <Card sx={{ p: 0, overflow: 'hidden' }}>
        <Box sx={{ display: 'flex' }}>
          {/* berth label column */}
          <Box sx={{ width: 168, flexShrink: 0, borderRight: 1, borderColor: 'divider' }}>
            <Box sx={{ height: 34, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', px: 1.5 }}>
              <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.08em', color: 'text.secondary', textTransform: 'uppercase' }}>Berth</Typography>
            </Box>
            {data.berths.map((b) => (
              <Box key={b.id} sx={{ height: ROW_H, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', px: 1.5, gap: 1 }}>
                <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '3px', bgcolor: TERM_COLOR[b.berthType] || '#999', flexShrink: 0 }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.2 }}>{b.code}</Typography>
                  <Typography noWrap sx={{ fontSize: 10, color: 'text.secondary', lineHeight: 1.2 }}>{b.terminal}</Typography>
                </Box>
                {conflictBerths.has(b.id) && <WarningAmberRoundedIcon titleAccess="Berth conflict" sx={{ fontSize: 14, color: 'error.main', ml: 'auto' }} />}
              </Box>
            ))}
          </Box>

          {/* timeline */}
          <Box sx={{ flex: 1, position: 'relative', overflowX: 'auto' }}>
            <Box sx={{ minWidth: 900, position: 'relative' }}>
              <Box sx={{ height: 34, borderBottom: 1, borderColor: 'divider', position: 'relative' }}>
                {ticks.map((t, i) => (
                  <Box key={i} sx={{ position: 'absolute', left: `${t.pct}%`, top: 0, bottom: 0, borderLeft: `1px dashed ${grid}`, pl: 0.75, display: 'flex', alignItems: 'center' }}>
                    <Typography sx={{ fontSize: 10.5, fontWeight: 700, color: 'text.secondary', whiteSpace: 'nowrap' }}>{t.label}</Typography>
                  </Box>
                ))}
              </Box>
              <Box sx={{ position: 'relative' }}>
                {data.berths.map((b) => {
                  const blocks = data.blocks.filter((bl) => bl.berthId === b.id);
                  const accent = TERM_COLOR[b.berthType] || '#0797A5';
                  return (
                    <Box key={b.id} sx={{ height: ROW_H, borderBottom: 1, borderColor: 'divider', position: 'relative', bgcolor: b.status === 'MAINTENANCE' ? (mode === 'dark' ? 'rgba(180,120,20,0.08)' : 'rgba(180,120,20,0.05)') : 'transparent' }}>
                      {ticks.map((t, i) => <Box key={i} aria-hidden sx={{ position: 'absolute', left: `${t.pct}%`, top: 0, bottom: 0, borderLeft: `1px dashed ${grid}` }} />)}
                      {blocks.map((bl) => {
                        const startPct = pctOf(span, bl.start);
                        const endPct = bl.end ? pctOf(span, bl.end) : 100;
                        const w = Math.max(1.2, endPct - startPct);
                        const isConflict = data.conflicts.some((c) => c.berthId === bl.berthId && (c.a === bl.vcn || c.b === bl.vcn));
                        const title = blockTitle(bl);
                        return (
                          <Tooltip key={bl.id} title={title}>
                            <Box role="button" tabIndex={0} aria-label={`${b.code}: ${title}${isConflict ? ' — conflict' : ''}`} onClick={() => open(bl.id)}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(bl.id); } }}
                              sx={{
                                position: 'absolute', left: `${startPct}%`, width: `${w}%`, top: 6, bottom: 6, borderRadius: '5px', cursor: 'pointer', px: 0.75, display: 'flex', alignItems: 'center', overflow: 'hidden',
                                bgcolor: isConflict ? '#B3452E' : bl.actual ? accent : 'transparent', border: bl.actual ? 'none' : `1.5px dashed ${accent}`, color: bl.actual ? '#fff' : accent,
                                boxShadow: isConflict ? '0 0 0 2px rgba(179,69,46,0.35)' : 'none', transition: 'transform .1s', '&:hover': { transform: 'scale(1.015)', zIndex: 2 },
                              }}>
                              <Typography noWrap sx={{ fontSize: 10.5, fontWeight: 700 }}>{bl.vessel ? bl.vessel.name : bl.vcn}</Typography>
                            </Box>
                          </Tooltip>
                        );
                      })}
                    </Box>
                  );
                })}
                {nowPct >= 0 && nowPct <= 100 && (
                  <Box aria-hidden sx={{ position: 'absolute', left: `${nowPct}%`, top: 0, bottom: 0, width: '2px', bgcolor: '#B3452E', zIndex: 3 }}>
                    <Chip label="NOW" size="small" sx={{ position: 'absolute', top: -4, left: 4, height: 16, fontSize: 9, fontWeight: 700, bgcolor: '#B3452E', color: '#fff' }} />
                  </Box>
                )}
              </Box>
            </Box>
          </Box>
        </Box>
      </Card>

      {data.unallocated.length > 0 && (
        <Card sx={{ p: 2, mt: 2 }}>
          <Typography variant="h6" component="h2" sx={{ fontSize: 14.5, mb: 1 }}>Awaiting berth allocation ({data.unallocated.length})</Typography>
          <Stack direction="row" flexWrap="wrap" gap={1}>
            {data.unallocated.map((c) => (
              <Chip key={c.id} clickable onClick={() => open(c.id)} label={`${c.vessel ? c.vessel.name : c.vcn} — ETA ${fmtDayShort(c.eta)}`} variant="outlined" sx={{ fontSize: 11.5 }} />
            ))}
          </Stack>
        </Card>
      )}
    </>
  );
}
