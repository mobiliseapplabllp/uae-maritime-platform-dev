import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Box, Typography, Skeleton, Stack, Chip, Tooltip, TextField, InputAdornment } from '@mui/material';
import EventRepeatRoundedIcon from '@mui/icons-material/EventRepeatRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import { fmtD } from '../../utils/format';
import { MONO } from '../../theme';
import { SURVEY_STATUS_COLOR, SURVEY_TYPE_LABEL, laneMatches, overdueCount, plannerScale } from './shared';
import type { SurveyPlannerData } from './types';

/* Class survey & dry-dock planner — one lane per vessel, 24-month horizon. Annuals, intermediate, special survey and docking windows, coloured by how close (or overdue) each one is. */
const ROW_H = 44;

export default function SurveyPlanner() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const mode = useAppSelector((s) => s.ui.mode);
  const [data, setData] = useState<SurveyPlannerData | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => { api.get<SurveyPlannerData>('/vessels/survey-planner').then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [dispatch]);

  if (!data) return <><PageHeader icon={EventRepeatRoundedIcon} iconColor="#3B6FB6" title="Class Survey & Dry-Dock Planner" sub="Loading…" /><Skeleton variant="rounded" height={520} /></>;

  const { pctOf, monthTicks } = plannerScale(data.from, data.to);
  const nowPct = pctOf(new Date());
  const lanes = data.lanes.filter((l) => laneMatches(l, q));
  const overdue = overdueCount(data.lanes);
  const gridLine = `1px dashed ${mode === 'dark' ? '#1E3844' : '#E4EAE9'}`;
  const openVessel = (id: string) => navigate(`/vessels/${id}`);

  return (
    <>
      <PageHeader icon={EventRepeatRoundedIcon} iconColor="#3B6FB6" title="Class Survey & Dry-Dock Planner"
        sub={`${data.lanes.length} vessels · ${data.horizonMonths || 24}-month horizon · annual / intermediate / special survey & dry-dock windows`}
        actions={(
          <Stack direction="row" spacing={1.5} alignItems="center">
            {overdue > 0 && <Chip size="small" color="error" label={`${overdue} overdue`} />}
            <TextField size="small" placeholder="Search vessel or IMO" value={q} onChange={(e) => setQ(e.target.value)} inputProps={{ 'aria-label': 'Search vessel or IMO' }}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchRoundedIcon fontSize="small" /></InputAdornment> }} sx={{ width: 220 }} />
          </Stack>
        )} />

      <Card sx={{ p: 0, overflow: 'hidden' }}>
        <Box sx={{ display: 'flex' }}>
          <Box sx={{ width: 190, flexShrink: 0, borderRight: 1, borderColor: 'divider' }}>
            <Box sx={{ height: 32, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', px: 1.5 }}>
              <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.08em', color: 'text.secondary', textTransform: 'uppercase' }}>Vessel</Typography>
            </Box>
            {lanes.map((l) => (
              <Box key={l.vessel.id} role="button" tabIndex={0} aria-label={`Open ${l.vessel.name}`} onClick={() => openVessel(l.vessel.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openVessel(l.vessel.id); } }}
                sx={{ height: ROW_H, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', px: 1.5, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography noWrap sx={{ fontSize: 12, fontWeight: 700, lineHeight: 1.25 }}>{l.vessel.name}</Typography>
                  <Typography sx={{ fontSize: 10, color: 'text.secondary', lineHeight: 1.2 }}>{l.vessel.classSociety || '—'} · IMO {l.vessel.imo}</Typography>
                </Box>
              </Box>
            ))}
          </Box>
          <Box tabIndex={0} role="group" aria-label="Survey and dry-dock timeline — scrolls sideways" sx={{ flex: 1, position: 'relative', overflowX: 'auto' }}>
            <Box sx={{ minWidth: 1100, position: 'relative' }}>
              <Box sx={{ height: 32, borderBottom: 1, borderColor: 'divider', position: 'relative' }}>
                {monthTicks.map((t, i) => (
                  <Box key={i} sx={{ position: 'absolute', left: `${t.pct}%`, top: 0, bottom: 0, borderLeft: gridLine, pl: 0.5, display: 'flex', alignItems: 'center' }}>
                    <Typography sx={{ fontSize: 9.5, fontWeight: 700, color: 'text.secondary', whiteSpace: 'nowrap' }}>{t.label}</Typography>
                  </Box>
                ))}
              </Box>
              <Box sx={{ position: 'relative' }}>
                {lanes.map((l) => (
                  <Box key={l.vessel.id} sx={{ height: ROW_H, borderBottom: 1, borderColor: 'divider', position: 'relative' }}>
                    {monthTicks.map((t, i) => <Box key={i} aria-hidden sx={{ position: 'absolute', left: `${t.pct}%`, top: 0, bottom: 0, borderLeft: gridLine }} />)}
                    {l.events.map((e, i) => {
                      const winStart = pctOf(e.window.from);
                      const winEnd = pctOf(e.window.to);
                      const color = SURVEY_STATUS_COLOR[e.status];
                      const title = `${SURVEY_TYPE_LABEL[e.type]} — due ${fmtD(e.due)} (${e.status.replace('_', ' ')})`;
                      return (
                        <Tooltip key={i} title={title}>
                          <Box role="img" aria-label={`${l.vessel.name}: ${title}`} sx={{ position: 'absolute', left: `${winStart}%`, width: `${Math.max(0.5, winEnd - winStart)}%`, top: 10, bottom: 10, borderRadius: '4px', bgcolor: color, opacity: e.type === 'DRY_DOCK' ? 0.9 : 0.28, border: e.type === 'DRY_DOCK' ? 'none' : `1px solid ${color}` }} />
                        </Tooltip>
                      );
                    })}
                    {l.events.map((e, i) => <Box key={`d${i}`} aria-hidden sx={{ position: 'absolute', left: `${pctOf(e.due)}%`, top: 6, bottom: 6, width: '2px', bgcolor: SURVEY_STATUS_COLOR[e.status] }} />)}
                  </Box>
                ))}
                {nowPct >= 0 && nowPct <= 100 && <Box aria-hidden sx={{ position: 'absolute', left: `${nowPct}%`, top: 0, bottom: 0, width: '2px', bgcolor: '#B3452E', zIndex: 2 }} />}
              </Box>
            </Box>
          </Box>
        </Box>
      </Card>
      <Stack direction="row" spacing={2.5} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
        {(Object.entries(SURVEY_STATUS_COLOR) as [string, string][]).map(([k, c]) => (
          <Stack key={k} direction="row" spacing={0.75} alignItems="center">
            <Box aria-hidden sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: c }} />
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{k.replace('_', ' ')}</Typography>
          </Stack>
        ))}
        <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>· Solid blocks are dry-dock windows; outlined blocks are surveys; the line marks the due date.</Typography>
      </Stack>
    </>
  );
}
