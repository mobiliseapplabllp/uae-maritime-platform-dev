/* Excel / PDF / CSV export helpers used by masters, registers and the report library. */
import writeXlsxFile, { type Row as XlsxRow, type Sheet as XlsxSheet } from 'write-excel-file/browser';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { getProfile } from '../config/runtime';

export interface ExportColumn { key?: string; label: string; value?: (row: any) => unknown; align?: 'left' | 'right' | 'center'; noExport?: boolean }
const cellValue = (row: any, col: ExportColumn) => { const v = typeof col.value === 'function' ? col.value(row) : row[col.key as string]; return v === null || v === undefined ? '' : v; };

function saveBytes(filename: string, data: Blob | string, mime?: string) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}
/**
 * A cell, typed the way a spreadsheet reads it: a number stays a number so a column can be summed, a date
 * stays a date so it sorts, and everything else goes across as text.
 */
const cell = (v: unknown) => {
  if (v === null || v === undefined || v === '') return { value: '' };
  if (typeof v === 'number' && Number.isFinite(v)) return { value: v, type: Number };
  if (v instanceof Date) return { value: v, type: Date, format: 'yyyy-mm-dd hh:mm' };
  if (typeof v === 'boolean') return { value: v, type: Boolean };
  return { value: String(v), type: String };
};

/**
 * Writes the workbook.
 *
 * This used SheetJS, which is unmaintained on npm at 0.18.5 and carries two open high advisories — both in
 * the parser, which the platform never reached because it only ever wrote files. Depending on an abandoned
 * package for a capability we use one tenth of is not a position to defend at an audit, so the export moved
 * to a maintained writer with the same shape.
 */
export async function exportExcel({ name, sheets }: { name: string; sheets: { name: string; columns: ExportColumn[]; rows: any[] }[] }) {
  // Excel refuses a sheet name over 31 characters, one carrying \ / ? * [ ] :, or one that repeats — and a
  // page title can be any of those.
  const seen = new Set<string>();
  const sheetName = (raw: string, i: number) => {
    let out = (raw || `Sheet ${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || `Sheet ${i + 1}`;
    while (seen.has(out.toLowerCase())) out = `${out.slice(0, 25)} ${seen.size + 1}`;
    seen.add(out.toLowerCase());
    return out;
  };
  const books: XlsxSheet<Blob>[] = sheets.map((s, i) => ({
    sheet: sheetName(s.name, i),
    columns: s.columns.map((c) => ({ width: Math.min(42, Math.max(10, String(c.label).length + 6)) })),
    data: [
      s.columns.map((c) => ({ value: c.label, fontWeight: 'bold' as const })),
      ...s.rows.map((r) => s.columns.map((c) => cell(cellValue(r, c)))),
    ] as XlsxRow[],
  }));
  saveBytes(`${name}.xlsx`, await writeXlsxFile(books).toBlob());
}
export async function exportPdf({ name, title, subtitle, sections, landscape = false }: { name: string; title?: string; subtitle?: string; sections: { heading?: string; columns: ExportColumn[]; rows: any[] }[]; landscape?: boolean }) {
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFillColor(10, 34, 57); doc.rect(0, 0, pageW, 64, 'F');
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('Maritime Operations Portal', 40, 28);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(title || name, 40, 46);
  doc.setFontSize(8); doc.setTextColor(200, 214, 226);
  doc.text(`Generated ${new Date().toLocaleString(getProfile().currency.locale, { hour12: false, timeZone: getProfile().timezone })} · demo data`, pageW - 40, 46, { align: 'right' });
  let y = 84;
  if (subtitle) { doc.setTextColor(90, 107, 120); doc.setFontSize(9.5); doc.text(String(subtitle), 40, y); y += 16; }
  for (const s of sections) {
    if (s.heading) { doc.setTextColor(10, 34, 57); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(s.heading, 40, y + 6); y += 14; }
    autoTable(doc, {
      startY: y, head: [s.columns.map((c) => c.label)], body: s.rows.map((r) => s.columns.map((c) => String(cellValue(r, c)))),
      margin: { left: 40, right: 40 }, styles: { fontSize: 7.5, cellPadding: 3, textColor: [40, 55, 66] },
      headStyles: { fillColor: [11, 116, 176], textColor: 255, fontSize: 7.5, fontStyle: 'bold' }, alternateRowStyles: { fillColor: [244, 248, 250] },
      columnStyles: Object.fromEntries(s.columns.map((c, i) => [i, c.align === 'right' ? { halign: 'right' } : {}])),
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;
    if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); y = 48; }
  }
  saveBytes(`${name}.pdf`, doc.output('blob'), 'application/pdf');
}
export function toCsv(rows: any[], columns: ExportColumn[]) {
  const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(cellValue(r, c))).join(','))].join('\n');
}
export async function exportCsv({ name, columns, rows }: { name: string; columns: ExportColumn[]; rows: any[] }) { saveBytes(`${name}.csv`, toCsv(rows, columns), 'text/csv;charset=utf-8'); }
