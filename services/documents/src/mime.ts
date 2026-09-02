/** Allow-listed content types with the magic bytes that must open the file. Office formats are OLE or zip containers; text formats must contain no NUL bytes. */
type Check = (b: Buffer) => boolean;
const startsWith = (sig: number[] | string, offset = 0): Check => (b) => {
  const s = typeof sig === 'string' ? Buffer.from(sig, 'latin1') : Buffer.from(sig);
  return b.length >= offset + s.length && b.subarray(offset, offset + s.length).equals(s);
};
const anyOf = (...checks: Check[]): Check => (b) => checks.some((c) => c(b));
export const isPdf = startsWith('%PDF-');
export const isPng = startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const isJpeg = startsWith([0xff, 0xd8, 0xff]);
export const isGif = anyOf(startsWith('GIF87a'), startsWith('GIF89a'));
export const isWebp: Check = (b) => startsWith('RIFF')(b) && startsWith('WEBP', 8)(b);
export const isZip = anyOf(startsWith([0x50, 0x4b, 0x03, 0x04]), startsWith([0x50, 0x4b, 0x05, 0x06]), startsWith([0x50, 0x4b, 0x07, 0x08]));
export const isOle = startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
export const isText: Check = (b) => !b.subarray(0, 8192).includes(0);

export interface MimeRule { ext: string[]; check: Check }
export const ALLOWED_MIMES: Record<string, MimeRule> = {
  'application/pdf': { ext: ['pdf'], check: isPdf },
  'image/png': { ext: ['png'], check: isPng },
  'image/jpeg': { ext: ['jpg', 'jpeg'], check: isJpeg },
  'image/gif': { ext: ['gif'], check: isGif },
  'image/webp': { ext: ['webp'], check: isWebp },
  'application/zip': { ext: ['zip'], check: isZip },
  'application/msword': { ext: ['doc'], check: isOle },
  'application/vnd.ms-excel': { ext: ['xls'], check: isOle },
  'application/vnd.ms-powerpoint': { ext: ['ppt'], check: isOle },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: ['docx'], check: isZip },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: ['xlsx'], check: isZip },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: ['pptx'], check: isZip },
  'text/csv': { ext: ['csv'], check: isText },
  'text/plain': { ext: ['txt', 'md', 'log'], check: isText },
};
const ALIASES: Record<string, string> = {
  'application/x-pdf': 'application/pdf', 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'application/x-zip-compressed': 'application/zip', 'application/x-zip': 'application/zip',
  'text/comma-separated-values': 'text/csv', 'application/csv': 'text/csv', 'application/vnd.ms-excel.sheet.macroenabled.12': 'application/vnd.ms-excel',
};
const GENERIC = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/unknown']);

export const extensionOf = (name: string): string => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(name ?? ''); return m ? m[1].toLowerCase() : ''; };
export function mimeForExtension(ext: string): string | null {
  for (const [mime, rule] of Object.entries(ALLOWED_MIMES)) if (rule.ext.includes(ext)) return mime;
  return null;
}
/** Normalises the declared type (parameters stripped, aliases folded, generic types inferred from the file name) and returns it only when allow-listed. */
export function resolveMime(declared: string | undefined | null, filename: string): string | null {
  const base = String(declared ?? '').split(';')[0].trim().toLowerCase();
  const folded = ALIASES[base] ?? base;
  if (GENERIC.has(folded)) return mimeForExtension(extensionOf(filename));
  if (ALLOWED_MIMES[folded]) return folded;
  return null;
}
/** Magic-byte sniff: the bytes must open the way the declared type says they do. */
export const contentMatches = (mime: string, buffer: Buffer): boolean => ALLOWED_MIMES[mime]?.check(buffer) ?? false;

/** A file name safe for storage metadata and Content-Disposition: no path segments, no control characters, bounded length. */
export function safeFileName(name: string | undefined | null, fallback = 'document'): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (cleaned || fallback).slice(0, 200);
}
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
