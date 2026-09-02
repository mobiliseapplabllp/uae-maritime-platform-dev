import { useState, type ReactNode } from 'react';
import { Card, Table, TableHead, TableRow, TableCell, TableBody, TablePagination, Box, TextField, InputAdornment, LinearProgress, Typography, TableSortLabel, TableContainer } from '@mui/material';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import type { Column } from '../../types';
import { MONO } from '../../theme';

interface Props<R> {
  columns: Column<R>[]; rows: R[]; total?: number; page?: number; limit?: number; loading?: boolean;
  onPage?: (page: number) => void; onLimit?: (limit: number) => void;
  search?: string; onSearch?: (q: string) => void; searchPlaceholder?: string;
  sort?: string; onSort?: (sort: string) => void;
  toolbar?: ReactNode; onRowClick?: (row: R) => void; emptyMessage?: string; dense?: boolean; rowKey?: (row: R) => string;
}
/** Server-driven table. columns: [{ key, label, render(row), sortable, align, width, mono }] */
export default function DataTable<R extends Record<string, any>>({
  columns, rows, total, page, limit, onPage, onLimit, loading, search, onSearch, searchPlaceholder = 'Search…', sort, onSort,
  toolbar, onRowClick, emptyMessage = 'Nothing found', dense = true, rowKey,
}: Props<R>) {
  const [q, setQ] = useState(search || '');
  const sortKey = sort?.replace(/^-/, '');
  const sortDir: 'asc' | 'desc' = sort?.startsWith('-') ? 'desc' : 'asc';
  const keyOf = (row: R, i: number) => (rowKey ? rowKey(row) : (row.id ?? row._id ?? i)) as string;
  return (
    <Card>
      <Box sx={{ p: 1.5, display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
        {onSearch && (
          <TextField size="small" value={q} placeholder={searchPlaceholder} inputProps={{ 'aria-label': searchPlaceholder }}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSearch(q); }}
            onBlur={() => { if (q !== (search || '')) onSearch(q); }} sx={{ width: 260 }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchRoundedIcon fontSize="small" /></InputAdornment> }} />
        )}
        {toolbar}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">{total ?? 0} records</Typography>
      </Box>
      {loading && <LinearProgress />}
      <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size={dense ? 'small' : 'medium'}>
          <TableHead>
            <TableRow>
              {columns.map((c) => (
                <TableCell key={c.key} align={c.align} sx={{ width: c.width }}>
                  {c.sortable && onSort ? (
                    <TableSortLabel active={sortKey === c.key} direction={sortKey === c.key ? sortDir : 'asc'} onClick={() => onSort(sortKey === c.key && sortDir === 'asc' ? `-${c.key}` : c.key)}>{c.label}</TableSortLabel>
                  ) : c.label}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={keyOf(row, i)} hover={!!onRowClick} onClick={onRowClick ? () => onRowClick(row) : undefined} sx={onRowClick ? { cursor: 'pointer' } : undefined}>
                {columns.map((c) => (
                  <TableCell key={c.key} align={c.align} sx={c.mono ? { fontFamily: MONO, fontSize: 12.5 } : undefined}>
                    {c.render ? c.render(row) : (row[c.key] ?? '—')}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!loading && rows.length === 0 && (
              <TableRow><TableCell colSpan={columns.length}><Typography sx={{ py: 4, textAlign: 'center' }} color="text.secondary">{emptyMessage}</Typography></TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {onPage && (
        <TablePagination component="div" count={total || 0} page={(page || 1) - 1} rowsPerPage={limit || 20}
          onPageChange={(_, p) => onPage(p + 1)} onRowsPerPageChange={(e) => onLimit?.(Number(e.target.value))} rowsPerPageOptions={[10, 20, 50]} />
      )}
    </Card>
  );
}
