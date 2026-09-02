/* Excel / PDF / CSV export helpers used by masters, registers and the report library. */
import * as XLSX from 'xlsx';
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
export async function exportExcel({ name, sheets }: { name: string; sheets: { name: string; columns: ExportColumn[]; rows: any[] }[] }) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const data = [s.columns.map((c) => c.label), ...s.rows.map((r) => s.columns.map((c) => cellValue(r, c)))];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = s.columns.map((c) => ({ wch: Math.min(42, Math.max(10, String(c.label).length + 6)) }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 28));
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  saveBytes(`${name}.xlsx`, new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
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
