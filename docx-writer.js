// Client-side .docx writer — no libraries. Mirrors docx-reader.js's own no-dependency stance:
// a .docx is a ZIP of a handful of XML parts, and a ZIP is a well-documented binary format we can
// assemble by hand. Uses STORE (no compression) rather than DEFLATE — bigger files, but it means
// no compression algorithm has to be implemented or trusted, only the much smaller, purely
// mechanical CRC32 checksum every ZIP entry needs regardless of compression method.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes){
  let crc = 0xFFFFFFFF;
  for(let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(n){ return [n & 0xFF, (n >>> 8) & 0xFF]; }
function u32(n){ return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }

// files: [{ name: 'word/document.xml', data: string | Uint8Array }]
function buildZip(files){
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((Math.max(now.getFullYear(), 1980) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  const entries = files.map(f => ({ name: f.name, data: typeof f.data === 'string' ? enc.encode(f.data) : f.data }));

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  entries.forEach(f => {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const localHeader = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0)
    ]);
    const localEntry = new Uint8Array(localHeader.length + nameBytes.length + f.data.length);
    localEntry.set(localHeader, 0);
    localEntry.set(nameBytes, localHeader.length);
    localEntry.set(f.data, localHeader.length + nameBytes.length);
    localChunks.push(localEntry);

    const centralHeader = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset)
    ]);
    const centralEntry = new Uint8Array(centralHeader.length + nameBytes.length);
    centralEntry.set(centralHeader, 0);
    centralEntry.set(nameBytes, centralHeader.length);
    centralChunks.push(centralEntry);

    offset += localEntry.length;
  });

  const centralOffset = offset;
  const centralSize = centralChunks.reduce((s, b) => s + b.length, 0);
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(centralOffset), ...u16(0)
  ]);

  const out = new Uint8Array(offset + centralSize + eocd.length);
  let p = 0;
  localChunks.forEach(b => { out.set(b, p); p += b.length; });
  centralChunks.forEach(b => { out.set(b, p); p += b.length; });
  out.set(eocd, p);
  return out;
}

function xmlEscape(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
// A paragraph's direction is judged on ITS OWN text, same reasoning as the app's own
// bidiSafeParagraphs for on-screen rendering — one strong-RTL paragraph (e.g. an Arabic epigraph)
// inside an otherwise LTR chapter shouldn't flip paragraphs around it, and vice versa.
function isRtlText(t){ return /[؀-ۿ]/.test(t); }

function wpPara(text, opts){
  opts = opts || {};
  const bidi = isRtlText(text) ? '<w:bidi/>' : '';
  const jc = opts.center ? '<w:jc w:val="center"/>' : '<w:jc w:val="both"/>';
  const ind = opts.indent ? '<w:ind w:firstLine="480"/>' : '';
  const pageBr = opts.pageBreak ? '<w:pageBreakBefore/>' : '';
  const spacing = opts.spacingAfter !== undefined ? `<w:spacing w:after="${opts.spacingAfter}"/>` : '';
  const rprParts = [];
  if(opts.bold) rprParts.push('<w:b/>');
  if(opts.italic) rprParts.push('<w:i/>');
  if(opts.color) rprParts.push(`<w:color w:val="${opts.color}"/>`);
  if(opts.size) rprParts.push(`<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>`);
  const rpr = rprParts.length ? `<w:rPr>${rprParts.join('')}</w:rPr>` : '';
  return `<w:p><w:pPr>${pageBr}${spacing}${bidi}${jc}${ind}${rpr}</w:pPr><w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}
function wpSpacer(){ return '<w:p/>'; }

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function wrapDocumentXml(bodyXml){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;
}

function docxBlobFromParagraphs(paragraphsXml){
  const zipBytes = buildZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES_XML },
    { name: '_rels/.rels', data: RELS_XML },
    { name: 'word/document.xml', data: wrapDocumentXml(paragraphsXml) }
  ]);
  return new Blob([zipBytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

// The readable manuscript: title page, then each chapter's approved Translation text only —
// what a reader of the finished book would see. Scene breaks get their own centered marker,
// same convention as the source manuscript's own "***".
function buildReadableDocx(finalUnits, titleLine, subtitleLine){
  const paras = [];
  paras.push(wpPara(titleLine, { center: true, bold: true, size: 44, spacingAfter: 120 }));
  paras.push(wpPara(subtitleLine, { center: true, italic: true, color: '595959', size: 22, spacingAfter: 480 }));
  const byChapter = new Map();
  finalUnits.forEach(u => { if(!byChapter.has(u.chapter)) byChapter.set(u.chapter, []); byChapter.get(u.chapter).push(u); });
  let firstChapter = true;
  byChapter.forEach((units, chapter) => {
    paras.push(wpPara(chapter, { bold: true, size: 32, spacingAfter: 240, pageBreak: !firstChapter }));
    firstChapter = false;
    units.forEach((u, i) => {
      const text = (u.translation.text || '').trim();
      if(!text) return;
      text.split(/\n\s*\n/).forEach(p => {
        const clean = p.replace(/\n/g, ' ').trim();
        if(clean) paras.push(wpPara(clean, { indent: true, spacingAfter: 160 }));
      });
      if(u.sceneBreakAfter && i < units.length - 1) paras.push(wpPara('* * *', { center: true, spacingAfter: 160 }));
    });
  });
  return docxBlobFromParagraphs(paras.join(''));
}

// The editorial comparison: every FINAL unit's Original, Translation, Back Translation and any
// chatbot NOTES, one unit per page — a proofreader or second editor's working copy, not a reading
// copy. Deliberately plain (labeled paragraphs, not a table): a hand-built table in raw OOXML is
// a much larger surface for a subtly malformed document than a labeled paragraph ever is, and the
// labels alone are enough to navigate by when every unit gets its own page.
function buildComparisonDocx(finalUnits, titleLine){
  const paras = [];
  paras.push(wpPara(titleLine, { center: true, bold: true, size: 36, spacingAfter: 80 }));
  paras.push(wpPara('Editorial comparison — Original / Translation / Back Translation', { center: true, italic: true, color: '595959', size: 20, spacingAfter: 480 }));
  finalUnits.forEach((u, idx) => {
    paras.push(wpPara(`${u.id} — ${u.chapter}`, { bold: true, size: 24, spacingAfter: 160, pageBreak: idx > 0 }));
    const section = (label, text) => {
      if(!text || !text.trim()) return;
      paras.push(wpPara(label, { bold: true, color: '802334', size: 18, spacingAfter: 40 }));
      text.trim().split(/\n\s*\n/).forEach(p => paras.push(wpPara(p.replace(/\n/g, ' ').trim(), { spacingAfter: 120 })));
    };
    section('ORIGINAL', u.source);
    section('APPROVED PARAPHRASE', u.parafrasa.text);
    section('TRANSLATION', u.translation.text);
    section('BACK TRANSLATION', u.backTranslation.text);
    if(u.translation.notes) section('TRANSLATION NOTES', u.translation.notes);
    if(u.backTranslation.notes) section('BACK TRANSLATION NOTES', u.backTranslation.notes);
    paras.push(wpPara(`Status: FINAL`, { italic: true, color: '3d6b4c', size: 18, spacingAfter: 0 }));
  });
  return docxBlobFromParagraphs(paras.join(''));
}
