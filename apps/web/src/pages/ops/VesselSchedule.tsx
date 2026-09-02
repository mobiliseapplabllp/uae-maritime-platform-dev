import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Box, Typography, Stack, Skeleton, Chip, ToggleButtonGroup, ToggleButton, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Divider } from '@mui/material';
import EventNoteRoundedIcon from '@mui/icons-material/EventNoteRounded';
import dayjs from 'dayjs';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import EntityHover from '../../components/common/EntityHover';
import StatusChip from '../../components/common/StatusChip';
import { PORTCALL_STATUS_META } from '../../utils/status';
import { MONO } from '../../theme';
import { KIND_META } from './constants';
import { dayLabel, groupByDay } from './planner';
import type { ScheduleData } from './types';

/* Day-wise arrivals / berthings / sailings board — the daily vessel programme. */
export default function VesselSchedule() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [days, setDays] = useState(5);
  const [data, setData] = useState<ScheduleData | null>(null);

  useEffect(() => {
    setData(null);
    api.get<ScheduleData>('/ops/schedule', { params: { days } }).then((r) => setData(r.data))
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  }, [days, dispatch]);

  const byDay = useMemo(() => (data ? groupByDay(data.events) : []), [data]);

  return (
    <>
      <PageHeader icon={EventNoteRoundedIcon} iconColor="#0797A5" title="Vessel schedule" sub="The daily programme — expected arrivals, planned berthings and sailings, and what actually sailed"
        actions={(
          <ToggleButtonGroup exclusive size="small" value={days} onChange={(_, v: number | null) => v && setDays(v)} aria-label="Window">
            <ToggleButton value={3}>3 days</ToggleButton>
            <ToggleButton value={5}>5 days</ToggleButton>
            <ToggleButton value={7}>7 days</ToggleButton>
          </ToggleButtonGroup>
        )} />
      {!data ? <Skeleton variant="rounded" height={480} /> : (
        <Stack spacing={2}>
          {byDay.map(({ date, events }) => {
            const label = dayLabel(date);
            return (
              <Card key={date.toISOString()}>
                <Box sx={{ px: 2, py: 1.25, display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <Typography variant="h6" component="h2" sx={{ fontSize: 14.5 }}>{label}</Typography>
                  <Chip size="small" variant="outlined" label={`${events.length} movement${events.length > 1 ? 's' : ''}`} sx={{ height: 20, fontSize: 10.5 }} />
                </Box>
                <Divider />
                <TableContainer sx={{ overflowX: 'auto' }}>
                  <Table size="small" aria-label={`Movements — ${label}`}>
                    <TableHead><TableRow>
                      <TableCell width={80}>Time</TableCell><TableCell width={130}>Movement</TableCell><TableCell>Vessel</TableCell>
                      <TableCell>VCN</TableCell><TableCell>Berth</TableCell><TableCell>Agent</TableCell><TableCell>Call status</TableCell>
                    </TableRow></TableHead>
                    <TableBody>
                      {events.map((e, i) => (
                        <TableRow key={`${e.callId}-${e.kind}-${i}`} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/port-calls/${e.callId}`)}>
                          <TableCell sx={{ fontFamily: MONO, fontSize: 12.5, whiteSpace: 'nowrap' }}>
                            {dayjs(e.at).format('HH:mm')}
                            {e.planned && <Typography component="span" variant="caption" color="text.secondary"> est</Typography>}
                          </TableCell>
                          <TableCell><Chip size="small" label={KIND_META[e.kind].label} sx={{ height: 20, fontSize: 10.5, fontWeight: 700, color: '#fff', bgcolor: KIND_META[e.kind].color }} /></TableCell>
                          <TableCell onClick={(ev) => ev.stopPropagation()}><EntityHover type="vessel" id={e.vesselId}><b>{e.vessel}</b></EntityHover></TableCell>
                          <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{e.vcn}</TableCell>
                          <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{e.berth}</TableCell>
                          <TableCell>{e.agent || '—'}</TableCell>
                          <TableCell><StatusChip value={e.status} map={PORTCALL_STATUS_META} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Card>
            );
          })}
          {byDay.length === 0 && <Card sx={{ p: 4, textAlign: 'center' }}><Typography color="text.secondary">No movements in this window.</Typography></Card>}
        </Stack>
      )}
    </>
  );
}
