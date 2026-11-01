// ============================================================ мінімальний запис .xlsx (без бібліотек)
// Аркуш із клітинками (числа, текст, формули з обчисленим значенням), стилями (шрифт, заливка, рамки, формат числа,
// вирівнювання), об'єднаними клітинками, шириною колонок і висотою рядків. Файл — ZIP без стиснення.

const XLSX_LITE = (() => {
  const xe = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const colNum = (L) => [...L].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

  // ---- стилі: кожна унікальна комбінація → індекс у cellXfs
  function Styles() {
    const fonts = ['<font><sz val="12"/><name val="Calibri"/><family val="2"/></font>'];
    const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const borders = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
    const numFmts = [];
    const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    const idx = (arr, x) => { let i = arr.indexOf(x); if (i < 0) { arr.push(x); i = arr.length - 1; } return i; };
    const cache = {};
    return {
      id(st) {
        if (!st) return 0;
        const key = JSON.stringify(st);
        if (cache[key] != null) return cache[key];
        const font = idx(fonts, `<font>${st.bold ? "<b/>" : ""}<sz val="${st.size || 12}"/><name val="Calibri"/><family val="2"/></font>`);
        const fill = st.fill ? idx(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${st.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
        const b = st.border || {};
        const side = (n) => (b[n] ? `<${n} style="${b[n]}"><color indexed="64"/></${n}>` : `<${n}/>`);
        const border = idx(borders, `<border>${side("left")}${side("right")}${side("top")}${side("bottom")}<diagonal/></border>`);
        let fmt = 0;
        if (st.fmt) { const i = idx(numFmts, st.fmt); fmt = 164 + i; }
        const al = st.align || st.wrap || st.valign ? `<alignment${st.align ? ` horizontal="${st.align}"` : ""}${st.valign ? ` vertical="${st.valign}"` : ""}${st.wrap ? ' wrapText="1"' : ""}/>` : "";
        xfs.push(`<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"${fmt ? ' applyNumberFormat="1"' : ""} applyFont="1" applyFill="1" applyBorder="1"${al ? ' applyAlignment="1">' + al + "</xf>" : "/>"}`);
        return (cache[key] = xfs.length - 1);
      },
      xml() {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
          + (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xe(f)}"/>`).join("")}</numFmts>` : "")
          + `<fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills>`
          + `<borders count="${borders.length}">${borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
          + `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
      },
    };
  }

  // ---- ZIP (метод 0 — без стиснення)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    for (const [name, text] of files) {
      const nb = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
      h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), nb, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true);
      c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), nb);
      off += 30 + nb.length + data.length;
    }
    const csize = central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  // sheet = { name, cols: {B: 10.9}, rows: {5: 64.5}, merges: ["B1:H1"], cells: {"B1": {v, f, s}}, landscape, fitWidth }
  function build(sheet) {
    const st = Styles();
    const byRow = {};
    for (const [ref, c] of Object.entries(sheet.cells)) {
      const m = ref.match(/^([A-Z]+)(\d+)$/);
      (byRow[+m[2]] = byRow[+m[2]] || []).push([colNum(m[1]), ref, c]);
    }
    const rowsXml = Object.keys({ ...byRow, ...(sheet.rows || {}) }).map(Number).sort((a, b) => a - b).map((r) => {
      const cells = (byRow[r] || []).sort((a, b) => a[0] - b[0]).map(([, ref, c]) => {
        const s = st.id(c.s), sa = s ? ` s="${s}"` : "";
        if (c.f) return `<c r="${ref}"${sa}><f>${xe(c.f)}</f>${c.v != null ? `<v>${c.v}</v>` : ""}</c>`;
        if (typeof c.v === "number") return `<c r="${ref}"${sa}><v>${c.v}</v></c>`;
        if (c.v == null || c.v === "") return `<c r="${ref}"${sa}/>`;
        return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xe(c.v)}</t></is></c>`;
      }).join("");
      const h = (sheet.rows || {})[r];
      return `<row r="${r}"${h ? ` ht="${h}" customHeight="1"` : ""}>${cells}</row>`;
    }).join("");
    const cols = Object.entries(sheet.cols || {}).map(([L, w]) => `<col min="${colNum(L)}" max="${colNum(L)}" width="${w}" customWidth="1"/>`).join("");
    const ws = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + (sheet.fitWidth ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : "")
      + '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><sheetFormatPr defaultRowHeight="15.75"/>'
      + (cols ? `<cols>${cols}</cols>` : "") + `<sheetData>${rowsXml}</sheetData>`
      + ((sheet.merges || []).length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "")
      + '<pageMargins left="0.5" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
      + `<pageSetup paperSize="9" orientation="${sheet.landscape ? "landscape" : "portrait"}"${sheet.fitWidth ? ' fitToWidth="1" fitToHeight="0"' : ""}/></worksheet>`;
    return zip([
      ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xe(sheet.name || "Аркуш1")}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
      ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ["xl/worksheets/sheet1.xml", ws],
      ["xl/styles.xml", st.xml()],
    ]);
  }
  return { build };
})();
