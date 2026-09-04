import { useCallback, useEffect, useState } from 'react';
import { Card, Grid, Box, Typography, Stack, Skeleton, Chip, Button, Menu, MenuItem, Divider, Avatar, Tabs, Tab } from '@mui/material';
import type { SvgIconComponent } from '@mui/icons-material';
import DirectionsBoatRoundedIcon from '@mui/icons-material/DirectionsBoatRounded';
import SupportRoundedIcon from '@mui/icons-material/SupportRounded';
import PersonPinCircleRoundedIcon from '@mui/icons-material/PersonPinCircleRounded';
import SailingRoundedIcon from '@mui/icons-material/SailingRounded';
import TravelExploreRoundedIcon from '@mui/icons-material/TravelExploreRounded';
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import PageStats from '../../components/common/PageStats';
import StatusChip from '../../components/common/StatusChip';
import { RESOURCE_STATUS_META } from '../../utils/status';
import { fmtD, fmtNum } from '../../utils/format';
import { MONO } from '../../theme';
import CraftServiceDrawer from './CraftServiceDrawer';
import FleetUtilisation from './FleetUtilisation';
import { RESOURCE_ORDER } from './constants';
import type { CraftRef, MarineResource, ResourceStatus, ResourceType } from './types';

/* Marine craft & pilot board — the resources behind every berthing: tugs, pilot launches, mooring boats, the pilot roster and the survey launch.
 * Each card carries the unit's service digest; the drawer opens the full record. */
const TYPE_META: Record<ResourceType, { label: string; icon: SvgIconComponent; color: string }> = {
  TUG: { label: 'Tugs', icon: DirectionsBoatRoundedIcon, color: '#056A73' },
  PILOT_LAUNCH: { label: 'Pilot launches', icon: SailingRoundedIcon, color: '#0B74B0' },
  MOORING_BOAT: { label: 'Mooring boats', icon: SupportRoundedIcon, color: '#5A6B78' },
  PILOT: { label: 'Pilot roster', icon: PersonPinCircleRoundedIcon, color: '#75479C' },
  SURVEY_LAUNCH: { label: 'Survey launch', icon: TravelExploreRoundedIcon, color: '#2C6E52' },
};
const STATUSES = Object.keys(RESOURCE_STATUS_META) as ResourceStatus[];

const Metric = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <Box>
    <Typography sx={{ fontFamily: MONO, fontSize: 13, fontWeight: 700 }}>{value}</Typography>
    <Typography sx={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography>
  </Box>
);

export default function MarineServices() {
  const dispatch = useAppDispatch();
  const user = useUser();
  const [rows, setRows] = useState<MarineResource[] | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; resource: MarineResource } | null>(null);
  const [detail, setDetail] = useState<CraftRef | null>(null);
  const [tab, setTab] = useState(0);
  const canEdit = hasPerm(user, 'portcalls.edit');

  const load = useCallback(() => api.get<MarineResource[]>('/ops/resources').then((r) => setRows(r.data))
    .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))), [dispatch]);
  useEffect(() => { load(); }, [load]);

  const setStatus = (resource: MarineResource, status: ResourceStatus) => {
    setMenu(null);
    api.put(`/ops/resources/${resource.id}`, { status })
      .then(() => { dispatch(notify(`${resource.name} marked ${RESOURCE_STATUS_META[status].label.toLowerCase()}`)); load(); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  };

  if (!rows) return <Skeleton variant="rounded" height={480} />;
  const available = rows.filter((r) => r.status === 'AVAILABLE').length;
  const tasked = rows.filter((r) => r.status === 'TASKED').length;
  const jobs12m = rows.reduce((s, r) => s + (r.service?.windowJobs || 0), 0);

  return (
    <>
      <PageHeader icon={DirectionsBoatRoundedIcon} iconColor="#056A73" title="Marine craft & pilots" sub={`Pilotage runs 24×365 · ${available} available · ${tasked} tasked now`} />
      <PageStats scope="marine" />
      <Tabs value={tab} onChange={(_, t: number) => setTab(t)} aria-label="Marine craft views" sx={{ mb: 2, borderBottom: 1, borderColor: 'divider', minHeight: 40 }}>
        <Tab label={`Craft board (${rows.length})`} sx={{ minHeight: 40 }} />
        <Tab label={`Fleet utilisation · ${fmtNum(jobs12m)} jobs in 12 months`} sx={{ minHeight: 40 }} />
      </Tabs>

      {tab === 1 && <FleetUtilisation onOpenCraft={(c) => setDetail(rows.find((r) => r.id === c.id) || c)} />}

      {tab === 0 && (
        <Stack spacing={2.5}>
          {RESOURCE_ORDER.map((type) => {
            const group = rows.filter((r) => r.type === type);
            if (!group.length) return null;
            const meta = TYPE_META[type]; const GIcon = meta.icon;
            return (
              <Box key={type}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                  <GIcon aria-hidden sx={{ fontSize: 19, color: meta.color }} />
                  <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{meta.label}</Typography>
                  <Typography variant="caption" color="text.secondary">{group.length} on strength</Typography>
                </Stack>
                <Grid container spacing={1.5}>
                  {group.map((r) => {
                    const sv = r.service;
                    return (
                      <Grid item xs={12} sm={6} md={4} lg={3} key={r.id}>
                        <Card variant="outlined" sx={{ p: 1.75, height: '100%', borderTop: 3, borderTopColor: meta.color }}>
                          <Stack direction="row" spacing={1.25} alignItems="center">
                            <Avatar aria-hidden sx={{ width: 38, height: 38, bgcolor: meta.color, fontSize: 13, fontWeight: 700 }}>{r.code.split('-')[1] || r.code.slice(0, 2)}</Avatar>
                            <Box sx={{ minWidth: 0, flex: 1 }}>
                              <Typography noWrap sx={{ fontWeight: 700, fontSize: 14 }}>{r.name}</Typography>
                              <Typography noWrap variant="caption" color="text.secondary">{r.code} · {r.contact || '—'}</Typography>
                            </Box>
                          </Stack>
                          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1, minHeight: 32 }}>{r.spec}</Typography>
                          {r.master && <Typography variant="caption" sx={{ display: 'block', fontWeight: 600 }}>Master: {r.master}</Typography>}
                          <Divider sx={{ my: 1 }} />
                          <Stack direction="row" spacing={2.5} sx={{ mb: 0.75 }}>
                            <Metric label="Jobs · 12 m" value={fmtNum(sv?.windowJobs || 0)} />
                            <Metric label="Hours" value={fmtNum(sv?.windowHours || 0)} />
                            <Metric label="Available" value={`${sv?.availabilityPct ?? 100}%`} />
                          </Stack>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                            {sv?.jobs ? `${fmtNum(sv.jobs)} jobs on record · last ${fmtD(sv.lastJobAt)}` : 'No taskings on record'}
                          </Typography>
                          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                            <StatusChip value={r.status} map={RESOURCE_STATUS_META} />
                            <Stack direction="row" spacing={0.5}>
                              <Button size="small" startIcon={<HistoryRoundedIcon />} aria-label={`Service record — ${r.name}`} onClick={() => setDetail(r)}>Record</Button>
                              {canEdit && <Button size="small" aria-label={`Set status — ${r.name}`} aria-haspopup="menu" onClick={(e) => setMenu({ anchor: e.currentTarget, resource: r })}>Status</Button>}
                            </Stack>
                          </Stack>
                          {r.status === 'TASKED' && r.currentTask && <Chip size="small" variant="outlined" color="info" label={r.currentTask} sx={{ mt: 1, height: 20, fontSize: 10, maxWidth: '100%' }} />}
                          {r.remarks && <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.75 }}>{r.remarks}</Typography>}
                        </Card>
                      </Grid>
                    );
                  })}
                </Grid>
              </Box>
            );
          })}
        </Stack>
      )}

      <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(null)} MenuListProps={{ 'aria-label': 'Craft status' }}>
        {STATUSES.map((s) => (
          <MenuItem key={s} selected={menu?.resource.status === s} onClick={() => menu && setStatus(menu.resource, s)}>{RESOURCE_STATUS_META[s].label}</MenuItem>
        ))}
      </Menu>
      <CraftServiceDrawer resource={detail} onClose={() => setDetail(null)} />
    </>
  );
}
