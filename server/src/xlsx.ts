import zlib from 'node:zlib';

/*
 * Minimal .xlsx writer (one sheet): an Office Open XML package is a zip of a few XML files.
 * Supports text, numbers and dates, a bold frozen header row with an autofilter, and column widths.
 */

export type Cell = string | number | Date | null | undefined;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Zip archive with deflated entries (no external dependency). */
function zip(files: { name: string; data: string }[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + deflated.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const esc = (s: string) =>
  s
    // Characters XML 1.0 can't carry at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function colName(i: number) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel serial date, in the viewer's wall-clock time (tzOffset = Date#getTimezoneOffset). */
const serial = (d: Date, tzOffset: number) => (d.getTime() - tzOffset * 60_000) / 86_400_000 + 25569;

export function buildXlsx(header: string[], rows: Cell[][], opts: { sheetName?: string; tzOffset?: number; widths?: number[] } = {}) {
  const tz = opts.tzOffset ?? 0;
  const cell = (v: Cell, ref: string, headerRow: boolean) => {
    if (v === null || v === undefined || v === '') return '';
    if (headerRow) return `<c r="${ref}" t="inlineStr" s="1"><is><t>${esc(String(v))}</t></is></c>`;
    if (v instanceof Date) {
      const dateOnly = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0;
      return `<c r="${ref}" s="${dateOnly ? 2 : 3}"><v>${dateOnly ? v.getTime() / 86_400_000 + 25569 : serial(v, tz)}</v></c>`;
    }
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  };
  const all = [header, ...rows];
  const sheetRows = all
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(v, `${colName(ci)}${ri + 1}`, ri === 0)).join('')}</row>`)
    .join('');
  const last = `${colName(header.length - 1)}${all.length}`;
  const cols = header
    .map((h, i) => `<col min="${i + 1}" max="${i + 1}" width="${opts.widths?.[i] ?? Math.min(60, Math.max(10, h.length + 4))}" customWidth="1"/>`)
    .join('');

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
    '</styleSheet>';

  return zip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${esc((opts.sheetName ?? 'Issues').slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>` +
        `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${esc((opts.sheetName ?? 'Issues').slice(0, 31))}'!$A$1:$${colName(header.length - 1)}$${all.length}</definedName></definedNames>` +
        '</workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/styles.xml', data: styles },
  ]);
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel detects the encoding. */
export function buildCsv(header: string[], rows: Cell[][], tzOffset = 0) {
  const fmt = (v: Cell) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) {
      const local = new Date(v.getTime() - tzOffset * 60_000).toISOString();
      const dateOnly = v.getUTCHours() === 0 && v.getUTCMinutes() === 0;
      return dateOnly ? v.toISOString().slice(0, 10) : `${local.slice(0, 10)} ${local.slice(11, 16)}`;
    }
    let s = String(v);
    // Neutralise spreadsheet formula injection (=, +, -, @ at the start of a text cell).
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [header, ...rows].map((r) => r.map(fmt).join(',')).join('\r\n') + '\r\n';
}
