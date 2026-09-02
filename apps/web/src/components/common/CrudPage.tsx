import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Stack, TextField, MenuItem, IconButton } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import type { SvgIconComponent } from '@mui/icons-material';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import type { Column, FieldSpec, Option } from '../../types';
import type { ExportColumn } from '../../utils/exportUtils';
import PageHeader, { type Crumb } from './PageHeader';
import DataTable from './DataTable';
import FormFields from './FormFields';
import ConfirmDialog from './ConfirmDialog';
import FormDrawer from './FormDrawer';
import PageStats from './PageStats';
import ExportMenu from './ExportMenu';

export interface CrudConfig<R extends Record<string, any> = any> {
  title: string; sub?: string; icon?: SvgIconComponent; iconColor?: string; crumbs?: Crumb[];
  endpoint: string; entityName?: string; addLabel?: string; columns: Column<R>[];
  formFields: FieldSpec[] | ((editing: R | Record<string, never> | null) => FieldSpec[]);
  defaults?: Record<string, unknown>; permBase?: string; perms?: { create: string; edit: string; del: string };
  filters?: { name: string; label: string; options: Option[] }[]; staticParams?: Record<string, unknown>; defaultSort?: string;
  transformOut?: (values: Record<string, any>, editing: R | Record<string, never> | null) => unknown; toForm?: (row: R) => Record<string, any>;
  rowActionsExtra?: (row: R, reload: () => void) => ReactNode; onRowClick?: (row: R) => void; searchPlaceholder?: string;
  drawerWidth?: number | string; headerActions?: ReactNode; beforeTable?: ReactNode; statsScope?: string; exportName?: string; exportColumns?: ExportColumn[];
  drawerExtra?: (editing: R | Record<string, never>, values: Record<string, any>, setValues: (v: Record<string, any>) => void) => ReactNode;
  deleteMessage?: (row: R | null) => string;
}
interface ListState<R> { rows: R[]; total: number; page: number; limit: number; q: string; sort: string; loading: boolean }

/** Full server-side CRUD page driven by config. */
export default function CrudPage<R extends Record<string, any>>(cfg: CrudConfig<R>) {
  const dispatch = useAppDispatch();
  const user = useUser();
  const perms = cfg.perms || { create: `${cfg.permBase}.manage`, edit: `${cfg.permBase}.manage`, del: `${cfg.permBase}.manage` };
  const [state, setState] = useState<ListState<R>>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: cfg.defaultSort || '-createdAt', loading: true });
  const [filterVals, setFilterVals] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<R | Record<string, never> | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<R | null>(null);
  const [statsKey, setStatsKey] = useState(0);
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const staticKey = JSON.stringify(cfg.staticParams || {});

  const load = useCallback(() => {
    setState((x) => ({ ...x, loading: true }));
    const params = { page: state.page, limit: state.limit, q: state.q || undefined, sort: state.sort, ...filterVals, ...(cfg.staticParams || {}) };
    api.get<R[]>(cfg.endpoint, { params })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e) => { err(e); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, filterVals, cfg.endpoint, staticKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const fieldsFor = (row: R | Record<string, never> | null) => (typeof cfg.formFields === 'function' ? cfg.formFields(row) : cfg.formFields);
  const fields = useMemo(() => fieldsFor(editing), [cfg.formFields, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const idOf = (row: R | Record<string, never> | null) => (row && 'id' in row ? (row as R).id : undefined);

  const openNew = () => { setEditing({}); setValues({ ...(cfg.defaults || {}) }); };
  const openEdit = (row: R) => {
    setEditing(row);
    const v: Record<string, any> = {};
    const src = cfg.toForm ? cfg.toForm(row) : row;
    for (const f of fieldsFor(row)) { v[f.name] = src[f.name]; if (v[f.name] === undefined || v[f.name] === null) v[f.name] = f.type === 'switch' ? false : ''; }
    setValues(v);
  };
  const save = () => {
    setBusy(true);
    const body = cfg.transformOut ? cfg.transformOut(values, editing) : values;
    const id = idOf(editing);
    const req = id ? api.put(`${cfg.endpoint}/${id}`, body) : api.post(cfg.endpoint, body);
    req.then(() => { dispatch(notify(id ? `${cfg.entityName || 'Record'} updated` : `${cfg.entityName || 'Record'} created`)); setEditing(null); load(); setStatsKey((k) => k + 1); })
      .catch(err).finally(() => setBusy(false));
  };
  const doDelete = () => {
    if (!deleting) return;
    setBusy(true);
    api.delete(`${cfg.endpoint}/${deleting.id}`)
      .then(() => { dispatch(notify(`${cfg.entityName || 'Record'} deleted`)); setDeleting(null); load(); setStatsKey((k) => k + 1); })
      .catch(err).finally(() => setBusy(false));
  };

  const columns: Column<R>[] = [...cfg.columns];
  if (hasPerm(user, perms.edit) || hasPerm(user, perms.del) || cfg.rowActionsExtra) {
    columns.push({
      key: '__actions', label: '', align: 'right', width: 110, noExport: true,
      render: (row) => (
        <Stack direction="row" spacing={0.5} justifyContent="flex-end" onClick={(e) => e.stopPropagation()}>
          {cfg.rowActionsExtra && cfg.rowActionsExtra(row, load)}
          {hasPerm(user, perms.edit) && <IconButton size="small" aria-label="Edit" onClick={() => openEdit(row)}><EditRoundedIcon fontSize="inherit" /></IconButton>}
          {hasPerm(user, perms.del) && <IconButton size="small" color="error" aria-label="Delete" onClick={() => setDeleting(row)}><DeleteOutlineRoundedIcon fontSize="inherit" /></IconButton>}
        </Stack>
      ),
    });
  }
  const exportCols: ExportColumn[] = cfg.exportColumns || cfg.columns.filter((c) => c.key !== '__actions' && !c.noExport).map((c) => ({
    label: c.label || c.key, value: c.exportValue || ((r: R) => { const v = r[c.key]; return v && typeof v === 'object' ? (v.name || v.code || '') : (v ?? ''); }),
  }));

  return (
    <>
      <PageHeader title={cfg.title} sub={cfg.sub} icon={cfg.icon} iconColor={cfg.iconColor} crumbs={cfg.crumbs}
        actions={<>
          {cfg.exportName && <ExportMenu name={cfg.exportName} title={cfg.title} columns={exportCols} getRows={() => api.get<R[]>(cfg.endpoint, { params: { limit: 1000, sort: state.sort, q: state.q || undefined, ...filterVals, ...(cfg.staticParams || {}) } }).then((r) => r.data)} />}
          {cfg.headerActions}
          {hasPerm(user, perms.create) && <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={openNew}>{cfg.addLabel || `Add ${cfg.entityName || ''}`}</Button>}
        </>} />
      {cfg.statsScope && <PageStats scope={cfg.statsScope} refreshKey={statsKey} />}
      {cfg.beforeTable}
      <DataTable columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => setState((x) => ({ ...x, limit, page: 1 }))}
        search={state.q} onSearch={(q) => setState((x) => ({ ...x, q, page: 1 }))} searchPlaceholder={cfg.searchPlaceholder}
        sort={state.sort} onSort={(sort) => setState((x) => ({ ...x, sort }))} onRowClick={cfg.onRowClick}
        toolbar={(cfg.filters || []).map((f) => (
          <TextField key={f.name} select size="small" label={f.label} sx={{ minWidth: 150 }} value={filterVals[f.name] ?? ''}
            onChange={(e) => { setFilterVals((v) => ({ ...v, [f.name]: e.target.value })); setState((x) => ({ ...x, page: 1 })); }}>
            <MenuItem value="">All</MenuItem>
            {f.options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
        ))} />
      <FormDrawer open={!!editing} busy={busy} width={cfg.drawerWidth || '75vw'} title={idOf(editing) ? `Edit ${cfg.entityName || ''}` : `New ${cfg.entityName || ''}`} subtitle={cfg.sub}
        onClose={() => setEditing(null)} onSubmit={save} submitLabel={idOf(editing) ? 'Save changes' : 'Create'}>
        {editing && <FormFields fields={fields} values={values} onChange={setValues} />}
        {cfg.drawerExtra && editing && cfg.drawerExtra(editing, values, setValues)}
      </FormDrawer>
      <ConfirmDialog open={!!deleting} busy={busy} title={`Delete ${cfg.entityName || 'record'}?`} message={cfg.deleteMessage ? cfg.deleteMessage(deleting) : 'This cannot be undone.'} onClose={() => setDeleting(null)} onConfirm={doDelete} />
    </>
  );
}
