// Client-side DOCX reader — no libraries. A .docx is a ZIP file; we read the ZIP central
// directory ourselves and inflate entries with the browser's native DecompressionStream
// (supported in Chromium/Edge/Firefox since ~2020), so nothing needs to run outside the browser.
async function readDocxFile(file){
  const buf = await file.arrayBuffer();
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Find End Of Central Directory record (search backward for its signature).
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for(let i = bytes.length - 22; i >= 0; i--){
    if(view.getUint32(i, true) === EOCD_SIG){ eocdOffset = i; break; }
  }
  if(eocdOffset < 0) throw new Error('This file is not a valid .docx (ZIP end-of-directory not found).');

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const entries = {};
  let ptr = centralDirOffset;
  const CENTRAL_SIG = 0x02014b50;
  for(let i = 0; i < entryCount; i++){
    if(view.getUint32(ptr, true) !== CENTRAL_SIG) break;
    const compMethod = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const uncompSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);
    const nameBytes = bytes.slice(ptr + 46, ptr + 46 + nameLen);
    const name = new TextDecoder('utf-8').decode(nameBytes);
    entries[name] = { compMethod, compSize, uncompSize, localHeaderOffset };
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  async function extract(name){
    const e = entries[name];
    if(!e) return null;
    const LOCAL_SIG = 0x04034b50;
    const lo = e.localHeaderOffset;
    if(view.getUint32(lo, true) !== LOCAL_SIG) throw new Error(`Corrupt local header for ${name}`);
    const localNameLen = view.getUint16(lo + 26, true);
    const localExtraLen = view.getUint16(lo + 28, true);
    const dataStart = lo + 30 + localNameLen + localExtraLen;
    const compressed = bytes.slice(dataStart, dataStart + e.compSize);
    if(e.compMethod === 0) return new TextDecoder('utf-8').decode(compressed);
    if(e.compMethod === 8){
      if(typeof DecompressionStream === 'undefined'){
        throw new Error('This browser does not support DecompressionStream — needs a recent Chrome/Edge.');
      }
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([compressed]).stream().pipeThrough(ds);
      const outBuf = await new Response(stream).arrayBuffer();
      return new TextDecoder('utf-8').decode(outBuf);
    }
    throw new Error(`Compression method ${e.compMethod} is not supported for ${name}`);
  }

  const documentXml = await extract('word/document.xml');
  if(!documentXml) throw new Error('word/document.xml not found — this file may not be a valid .docx.');
  let footnotesXml = null;
  try{ footnotesXml = await extract('word/footnotes.xml'); }catch(e){ /* footnotes optional */ }

  return { documentXml, footnotesXml };
}

function unescapeXmlEntities(s){
  return s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
}

// Parses document.xml into an ordered list of paragraphs: { style, text, footnoteIds }.
// Mirrors the logic already validated in the Node-side parser used earlier this project.
function parseDocumentXml(documentXml, footnotesXml){
  const footnoteDb = {};
  if(footnotesXml){
    const fnRegex = /<w:footnote\b[^>]*w:id="(-?\d+)"[^>]*>([\s\S]*?)<\/w:footnote>/g;
    let fm;
    while((fm = fnRegex.exec(footnotesXml)) !== null){
      const id = fm[1];
      if(id === '-1' || id === '0') continue;
      const text = [...fm[2].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(x => unescapeXmlEntities(x[1])).join('');
      footnoteDb[id] = text.trim();
    }
  }

  const paraRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  const paragraphs = [];
  let m;
  while((m = paraRegex.exec(documentXml)) !== null){
    const body = m[1];
    const styleMatch = body.match(/<w:pStyle w:val="([^"]+)"/);
    const style = styleMatch ? styleMatch[1] : null;
    const text = [...body.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(x => unescapeXmlEntities(x[1])).join('');
    const footnoteIds = [...body.matchAll(/<w:footnoteReference\b[^>]*w:id="(-?\d+)"/g)].map(x => x[1]).filter(id => footnoteDb[id] !== undefined);
    const t = text.trim();
    if(t) paragraphs.push({ style, text: t, footnoteIds });
  }
  return { paragraphs, footnoteDb };
}
