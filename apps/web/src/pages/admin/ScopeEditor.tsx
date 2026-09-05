import { useEffect, useState } from 'react';
import { Autocomplete, Grid, TextField, Typography } from '@mui/material';
import { SCOPE_LEVELS, type ScopeLevel, type TenancyScope } from '@maritime/contracts';
import api from '../../api/client';
import { useLookups } from '../../hooks/useLookups';
import type { Option } from '../../types';

/*
 * What an account may see. National is everything; a port, a facility or a company narrows it, and the lists come
 * from the registers themselves — the port master, the facility register, the company register — never from a typed
 * code. A facility or zone account also names the port it stands in, which is how a register partitioned by port
 * contains it.
 */
const LEVEL_LABEL: Record<ScopeLevel, string> = { NATIONAL: 'National — the whole register', PORT: 'Port — one or more ports', ZONE: 'Zone — within a port', FACILITY: 'Facility — one or more port facilities', COMPANY: 'Company — its own records only' };
interface Named { code: string; name: string; scopePort?: string; scope_port?: string }

export default function ScopeEditor({ value, onChange, disabled }: { value: TenancyScope | undefined; onChange: (s: TenancyScope) => void; disabled?: boolean }) {
  const scope: TenancyScope = value?.level ? value : { level: 'NATIONAL' };
  const ports = useLookups('port');
  const zones = useLookups('zone');
  const [facilities, setFacilities] = useState<Named[]>([]);
  const [companies, setCompanies] = useState<Named[]>([]);
  useEffect(() => { if (scope.level === 'FACILITY' && !facilities.length) api.get<Named[]>('/facilities/port-facilities', { params: { limit: 500, sort: 'code' } }).then((r) => setFacilities(r.data)).catch(() => {}); }, [scope.level, facilities.length]);
  useEffect(() => { if (scope.level === 'COMPANY' && !companies.length) api.get<Named[]>('/companies', { params: { limit: 500, sort: 'name' } }).then((r) => setCompanies(r.data)).catch(() => {}); }, [scope.level, companies.length]);
  const levels = SCOPE_LEVELS.filter((l) => l !== 'ZONE' || zones.rows.length > 0 || scope.level === 'ZONE');
  const named = (rows: Named[]): Option[] => rows.map((r) => ({ value: r.code, label: `${r.code} — ${r.name}` }));
  const pick = (options: Option[], selected: string[] | undefined, label: string, onPick: (codes: string[]) => void, help?: string, testId?: string) => (
    <Autocomplete multiple size="small" options={options} disabled={disabled} value={options.filter((o) => (selected ?? []).includes(o.value))}
      onChange={(_, v) => onPick(v.map((o) => o.value))} isOptionEqualToValue={(a, b) => a.value === b.value}
      renderInput={(params) => <TextField {...params} label={label} helperText={help} inputProps={{ ...params.inputProps, 'data-testid': testId }} />} />
  );
  const set = (patch: Partial<TenancyScope>) => onChange({ ...scope, ...patch });
  const portsFor = (codes: string[], rows: Named[]) => [...new Set(codes.map((c) => rows.find((r) => r.code === c)?.scopePort || rows.find((r) => r.code === c)?.scope_port || '').filter(Boolean))];
  return (
    <Grid container spacing={2} sx={{ mt: 0 }}>
      <Grid item xs={12}>
        <TextField select fullWidth size="small" label="Scope" value={scope.level} disabled={disabled} SelectProps={{ native: true }} inputProps={{ 'data-testid': 'scope-level' }}
          onChange={(e) => onChange({ level: e.target.value as ScopeLevel })}>
          {levels.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
        </TextField>
      </Grid>
      {scope.level === 'PORT' && <Grid item xs={12}>{pick(ports.options, scope.ports, 'Ports', (codes) => set({ ports: codes }), 'From the port master', 'scope-ports')}</Grid>}
      {scope.level === 'ZONE' && <>
        <Grid item xs={12} md={7}>{pick(zones.options, scope.zones, 'Zones', (codes) => set({ zones: codes }), 'From the zone master', 'scope-zones')}</Grid>
        <Grid item xs={12} md={5}>{pick(ports.options, scope.ports, 'Within ports', (codes) => set({ ports: codes }), 'Contains the account to these ports on port-partitioned registers')}</Grid>
      </>}
      {scope.level === 'FACILITY' && <>
        <Grid item xs={12} md={7}>{pick(named(facilities), scope.facilities, 'Port facilities', (codes) => set({ facilities: codes, ports: scope.ports?.length ? scope.ports : portsFor(codes, facilities) }), 'From the facility register', 'scope-facilities')}</Grid>
        <Grid item xs={12} md={5}>{pick(ports.options, scope.ports, 'Within ports', (codes) => set({ ports: codes }), 'Contains the account to these ports on port-partitioned registers', 'scope-facility-ports')}</Grid>
      </>}
      {scope.level === 'COMPANY' && <Grid item xs={12}>{pick(named(companies), scope.companies, 'Companies', (codes) => set({ companies: codes }), 'From the company register — the account reads its own records only', 'scope-companies')}</Grid>}
      <Grid item xs={12}><Typography variant="caption" color="text.secondary">{LEVEL_LABEL[scope.level]}. Changes to an account's scope apply on its next request.</Typography></Grid>
    </Grid>
  );
}
