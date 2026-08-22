const $ = id => document.getElementById(id);
function escapeHtml(s){ return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

// Copies a textarea and confirms visibly either way. A silent clipboard failure used to leave
// the editor unsure whether anything was actually copied.
async function copyWithFeedback(textareaEl, btnEl){
  const original = btnEl.textContent;
  let ok = false;
  try{ await navigator.clipboard.writeText(textareaEl.value); ok = true; }catch(e){ ok = false; }
  textareaEl.select();
  btnEl.textContent = ok ? '✓ Copied!' : '⚠ Copy failed. Text selected, use Ctrl+C';
  btnEl.classList.toggle('copied', ok);
  setTimeout(() => { btnEl.textContent = original; btnEl.classList.remove('copied'); }, 2000);
}

// ---- Storage -----------------------------------------------------------------
// A library keyed by filename, so opening a second book never destroys the first one's work.
const LIB_KEY = 'adjung-te-library';
const LEGACY_KEY = 'adjung-parafrasa-doc';

let library = JSON.parse(localStorage.getItem(LIB_KEY) || 'null');
if(!library){
  library = { activeFile: null, books: {} };
  const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
  if(legacy && legacy.fileName){ library.books[legacy.fileName] = legacy; library.activeFile = legacy.fileName; }
}
let doc = library.activeFile ? library.books[library.activeFile] : null;

let selected = new Set();
let phase = 'scan'; // scan | parafrasa | translation | backtranslation | final
let mode = 'parafrasa'; // the batch phase currently being worked, used by the unit helpers
let editingUnitId = null;

// A batch with no ceiling can grow into a prompt no chatbot UI can actually take (Select All on
// 87 units built a 51KB prompt in testing). Two independent caps, whichever is hit first wins:
// characters (raw prompt size) and sentences (how much a human reviewer can hold in their head
// per round). Sentence counting is approximate — it only has to be a reasonable proxy, not exact.
// Raised from an initial 6000/60 after real production use on a 52-unit chapter showed the
// review bottleneck was chatbot round-trips, not reviewer attention span — chatbots handle prompts
// this size natively, and a bigger batch means fewer copy/paste/wait cycles per phase.
const BATCH_MAX_CHARS = 12000;
const BATCH_MAX_SENTENCES = 100;
function countSentences(text){ return Math.max(1, (text.match(/[.!?…]+(\s|$)/g) || []).length); }
function batchStatsFor(units){
  return units.reduce((acc, u) => ({ chars: acc.chars + u.source.length, sentences: acc.sentences + countSentences(u.source) }), { chars: 0, sentences: 0 });
}

const BOOK_PROFILE_FIELDS = [
  { key: 'genre', tag: 'GENRE', label: 'Genre', max: 200 },
  { key: 'purpose', tag: 'PURPOSE', label: 'Purpose', max: 300 },
  { key: 'targetReaders', tag: 'TARGET_READERS', label: 'Target readers', max: 250 },
  { key: 'authorVoice', tag: 'AUTHOR_VOICE', label: "Author's voice", max: 350 },
  { key: 'languageStyle', tag: 'LANGUAGE_STYLE', label: 'Language style', max: 350 },
  { key: 'argumentStructure', tag: 'ARGUMENT_STRUCTURE', label: 'Argument structure', max: 400 },
  { key: 'keyTerms', tag: 'KEY_TERMS', label: 'Key terms', max: 500 },
  { key: 'translationRisks', tag: 'TRANSLATION_RISKS', label: 'Translation risks', max: 400 },
  { key: 'processingRecommendations', tag: 'PROCESSING_RECOMMENDATIONS', label: 'Processing recommendations', max: 400 }
];

function blankWork(){ return { text: '', notes: '', status: 'none' }; }

function normalizeDoc(d){
  if(!d) return;
  if(!d.bookProfile) d.bookProfile = { fields: null, status: 'none' };
  if(d.bookProfile.fields === undefined){
    d.bookProfile.fields = d.bookProfile.text ? parseBookProfileFields(d.bookProfile.text) : null;
    delete d.bookProfile.text;
  }
  if(!d.decisionMemory) d.decisionMemory = [];
  if(d.targetLang === undefined) d.targetLang = '';
  if(d.sourceLang === undefined) d.sourceLang = '';
  (d.units || []).forEach(u => {
    if(!u.parafrasa) u.parafrasa = blankWork();
    if(!u.translation) u.translation = blankWork();
    if(!u.backTranslation) u.backTranslation = blankWork();
    if(u.final === undefined) u.final = false;
  });
}
Object.values(library.books).forEach(normalizeDoc);

function save(){
  if(doc){ library.books[doc.fileName] = doc; library.activeFile = doc.fileName; }
  localStorage.setItem(LIB_KEY, JSON.stringify(library));
  $('savedState').textContent = '● Saved locally';
}

// ---- Unit splitting ---------------------------------------------------------
// A fixed "2 paragraphs per unit" rule looks reasonable for expository prose but falls apart on
// dialogue: a one-line reply ("Bardān?") and a dense narration paragraph end up the same "size" of
// unit, so consecutive units can differ 10-25x in length. Instead we accumulate paragraphs by actual
// character count, closing a unit once it's within a sensible target range, so every prompt sent
// to a chatbot carries a comparable, useful amount of text regardless of how the author punctuated
// dialogue. A paragraph longer than the max never gets split mid-sentence; it becomes its own unit.
const UNIT_TARGET_MIN = 220;
const UNIT_TARGET_MAX = 650;

function buildUnitsFromParagraphs(paragraphs){
  const headingIdx = [];
  paragraphs.forEach((p, i) => { if(p.style === 'Heading1') headingIdx.push({ i, title: p.text.replace(/\s*\|.*$/, '').trim() }); });
  const sections = headingIdx.length
    ? headingIdx.map((h, idx) => ({ title: h.title, start: h.i + 1, end: idx + 1 < headingIdx.length ? headingIdx[idx + 1].i : paragraphs.length }))
    : [{ title: 'Manuscript', start: 0, end: paragraphs.length }];

  const units = [];
  let counter = 0;
  sections.forEach(sec => {
    const body = paragraphs.slice(sec.start, sec.end).filter(p => p.style !== 'Heading1' && p.style !== 'TOC1');
    let bucket = [];
    let bucketLen = 0;
    const flush = () => {
      if(!bucket.length) return;
      counter++;
      units.push({
        id: `U${String(counter).padStart(4, '0')}`,
        chapter: sec.title,
        source: bucket.map(p => p.text).join('\n\n'),
        footnotes: bucket.flatMap(p => p.footnoteIds),
        parafrasa: blankWork(), translation: blankWork(), backTranslation: blankWork(),
        final: false
      });
      bucket = []; bucketLen = 0;
    };
    body.forEach(p => {
      // Already over target and this paragraph would push it further: close first, unless the
      // bucket is still under the minimum (a short dialogue line shouldn't stand alone).
      if(bucketLen >= UNIT_TARGET_MIN && bucketLen + p.text.length > UNIT_TARGET_MAX) flush();
      bucket.push(p);
      bucketLen += p.text.length;
      if(bucketLen >= UNIT_TARGET_MAX) flush();
    });
    flush();
  });
  return units;
}

// ---- Upload -----------------------------------------------------------------
$('chooseFileBtn').onclick = () => $('fileInput').click();
$('reuploadBtn').onclick = () => { $('fileInput').value=''; $('fileInput').click(); };
$('fileInput').onchange = (e) => { const file = e.target.files[0]; if(file) handleUploadedFile(file); };

// Drag-and-drop, not just click-to-browse — a document tool that only accepts clicks feels
// a full generation behind what people expect from paid software in this category.
const dropZone = $('uploadScreen');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', e => { if(e.target === dropZone) dropZone.classList.remove('drag-over'); });
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if(file) handleUploadedFile(file);
});

async function handleUploadedFile(file){
  $('uploadError').textContent = '';
  $('fileName').textContent = `Processing ${file.name}…`;
  try{
    const { documentXml, footnotesXml } = await readDocxFile(file);
    const { paragraphs, footnoteDb } = parseDocumentXml(documentXml, footnotesXml);
    if(!paragraphs.length) throw new Error('No text found in this file.');
    const freshUnits = buildUnitsFromParagraphs(paragraphs);

    // Re-uploading a book must never wipe finished work. Units are matched on their exact source
    // text, so unchanged passages keep their paraphrase, translation and approvals even if the
    // manuscript shifted around them.
    const existing = library.books[file.name];
    let carried = 0;
    if(existing){
      const priorBySource = new Map((existing.units || []).map(u => [u.source, u]));
      freshUnits.forEach(u => {
        const old = priorBySource.get(u.source);
        if(!old) return;
        u.parafrasa = old.parafrasa; u.translation = old.translation;
        u.backTranslation = old.backTranslation; u.final = old.final;
        if(old.parafrasa.text || old.translation.text || old.backTranslation.text) carried++;
      });
    }

    doc = {
      fileName: file.name, footnoteDb, units: freshUnits,
      bookProfile: existing?.bookProfile ?? { fields: null, status: 'none' },
      decisionMemory: existing?.decisionMemory ?? [],
      targetLang: existing?.targetLang ?? '', sourceLang: existing?.sourceLang ?? ''
    };
    normalizeDoc(doc);
    save();
    selected.clear();
    setPhase(doc.bookProfile.status === 'approved' ? 'parafrasa' : 'scan');
    renderAll();
    if(carried) $('savedState').textContent = `● Restored work on ${carried} unit(s)`;
  }catch(err){
    $('uploadError').textContent = 'Error: ' + err.message;
    $('fileName').textContent = '';
  }
}

$('bookSwitcher').onchange = () => {
  const name = $('bookSwitcher').value;
  if(!library.books[name]) return;
  doc = library.books[name];
  library.activeFile = name;
  normalizeDoc(doc);
  selected.clear();
  save();
  setPhase(doc.bookProfile.status === 'approved' ? 'parafrasa' : 'scan');
  renderAll();
};

// ---- Book Profile ------------------------------------------------------------
function parseBookProfileFields(raw){
  const fields = {};
  BOOK_PROFILE_FIELDS.forEach(f => { fields[f.key] = extractLabeled(raw, f.tag); });
  return fields;
}

function bookScanPromptText(){
  const limitTable = BOOK_PROFILE_FIELDS.map(f => `${f.tag} ≤${f.max}`).join(', ');
  const fieldBlocks = BOOK_PROFILE_FIELDS.map(f => `[${f.tag}] (${f.label})\n...`).join('\n');
  return `YOU ARE: A literary/editorial analyst producing a BOOK PROFILE for a manuscript, to guide later paraphrase and translation work. You are NOT translating or paraphrasing anything yet.

Read the ENTIRE attached manuscript, then produce a Book Profile.

FORMAT RULES (strict):
- Each field is exactly ONE flowing paragraph. No bullet points, no line breaks, no sub-lists, no headers inside a field.
- Plain text only. No markdown bold, italics, or asterisks.
- Be concise and information-dense: the single most useful sentence or two, not an exhaustive list.
- Character ceilings per field (hard limit, count before answering, shorten if over): ${limitTable}.

Return ONLY this exact structure, one field per block, nothing before or after. The parenthetical after each tag is a hint for you about what belongs there. Do NOT include it in your answer, use the bare [TAG] line only:
${fieldBlocks}
`;
}

function renderBookProfilePanel(){
  const bp = doc.bookProfile;
  const fieldsHtml = BOOK_PROFILE_FIELDS.map(f => {
    const val = (bp.fields && bp.fields[f.key]) || '';
    const over = val.length > f.max;
    const title = over ? `title="The chatbot ran a little long here. Not an error — shorter just keeps every field skimmable and consistent across the book. Edit the field if you want to trim it."` : '';
    return `<div class="bp-field">
      <div class="bp-field-head"><small>${escapeHtml(f.label)}</small><span class="bp-field-count${over ? ' over' : ''}" ${title}>${val.length}/${f.max}</span></div>
      ${val ? `<p dir="auto">${escapeHtml(val)}</p>` : '<p class="bp-field-empty">Not provided by the chatbot.</p>'}
    </div>`;
  }).join('');

  if(bp.status === 'none'){
    $('bookProfileFields').innerHTML = '<div class="empty-state">No Book Profile yet. Copy the prompt on the left, send it to your chatbot with the book file, then paste the reply.</div>';
    $('bookProfileActions').innerHTML = '';
    return;
  }
  $('bookProfileFields').innerHTML = fieldsHtml;
  $('bookProfileActions').innerHTML = bp.status === 'pending'
    ? `<button class="reject-button" id="bpReject">Reject and redo</button><button class="approve-button" id="bpApprove">✓ Approve Book Profile</button>`
    : `<button class="reject-button" id="bpReopen">Reopen for review</button>`;
  if($('bpApprove')) $('bpApprove').onclick = () => {
    doc.bookProfile.status = 'approved'; save(); renderAll(); setPhase('parafrasa');
  };
  if($('bpReject')) $('bpReject').onclick = () => {
    doc.bookProfile = { fields: null, status: 'none' }; save(); renderAll();
  };
  if($('bpReopen')) $('bpReopen').onclick = () => {
    doc.bookProfile.status = 'pending'; save(); renderAll();
  };
}

$('copyBookScanBtn').onclick = () => copyWithFeedback($('bookScanPromptOut'), $('copyBookScanBtn'));

$('processBookProfileBtn').onclick = () => {
  const raw = $('bookProfilePasteIn').value.trim();
  $('bookProfileError').textContent = '';
  if(!raw){ $('bookProfileError').textContent = "Paste the chatbot's Book Profile reply first."; return; }
  const fields = parseBookProfileFields(raw);
  if(!Object.values(fields).some(v => v)){
    $('bookProfileError').textContent = 'No [GENRE], [PURPOSE] or other field tags found. Make sure the chatbot kept the requested format.';
    return;
  }
  doc.bookProfile = { fields, status: 'pending' };
  save();
  $('bookProfilePasteIn').value = '';
  renderAll();
};

// ---- Decision Memory ---------------------------------------------------------
function renderDecisionMemory(){
  if(!doc.decisionMemory) doc.decisionMemory = [];
  $('dmCount').textContent = String(doc.decisionMemory.length);
  const list = $('dmList');
  if(!doc.decisionMemory.length){ list.innerHTML = '<p class="dm-empty">No rulings saved yet.</p>'; return; }
  list.innerHTML = doc.decisionMemory.map(e => `
    <div class="dm-entry">
      <div class="dm-entry-head"><span class="dm-entry-term" dir="auto">${escapeHtml(e.term)}</span><button class="dm-remove" data-dmremove="${escapeHtml(e.id)}">Remove</button></div>
      <p class="dm-entry-decision" dir="auto">${escapeHtml(e.decision)}</p>
    </div>`).join('');
}

$('dmAddBtn').onclick = () => {
  const term = $('dmTermInput').value.trim();
  const decision = $('dmDecisionInput').value.trim();
  if(!term || !decision) return;
  if(doc.decisionMemory.some(e => e.term.toLowerCase() === term.toLowerCase())){
    $('dmTermInput').value = ''; $('dmDecisionInput').value = '';
    return; // a term may only carry one approved ruling
  }
  doc.decisionMemory.push({ id: `DM${Date.now().toString(36)}`, term, decision });
  $('dmTermInput').value = ''; $('dmDecisionInput').value = '';
  save(); renderDecisionMemory(); renderPrompt();
};
$('dmList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-dmremove]');
  if(!btn) return;
  doc.decisionMemory = doc.decisionMemory.filter(x => x.id !== btn.dataset.dmremove);
  save(); renderDecisionMemory(); renderPrompt();
});

// Scholarly transliteration in the manuscript ("shimāgh", "ṣaḥabiyyāh") will not be typed back
// with its diacritics when an editor writes a ruling, so both sides are folded to bare letters
// before matching. Arabic script is untouched: its marks sit outside this range.
function foldDiacritics(s){ return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }

// Whole-word matching. A substring test would fire a ruling for "ia" inside "dia", "siapa" and
// hundreds of unrelated words, quietly poisoning the prompt.
function termAppearsIn(text, term){
  const foldedText = foldDiacritics(text);
  const esc = foldDiacritics(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try{
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, 'iu').test(foldedText);
  }catch(e){
    return foldedText.toLowerCase().includes(esc.toLowerCase());
  }
}
function relevantDecisionMemory(text){
  if(!doc?.decisionMemory?.length) return [];
  return doc.decisionMemory.filter(e => termAppearsIn(text, e.term));
}

// ---- Phases ------------------------------------------------------------------
const PHASES = {
  scan: { label: 'Book Scan', panelTitle: 'Book Profile' },
  parafrasa: {
    label: 'Paraphrase', panelTitle: 'Paraphrase units', field: 'parafrasa',
    intro: 'Restate each unit in its own source language so meaning is confirmed before any translation begins.',
    needsBookProfile: true
  },
  translation: {
    label: 'Translation', panelTitle: 'Translation units', field: 'translation',
    intro: 'Translate from the original text and the approved paraphrase together.',
    gate: 'parafrasa', needsBookProfile: true
  },
  backtranslation: {
    label: 'Back Translation', panelTitle: 'Back translation units', field: 'backTranslation',
    intro: 'Mirror the translation back into the source language, literally, to expose any drift in meaning.',
    gate: 'translation', needsBookProfile: false
  },
  final: { label: 'Final Review', panelTitle: 'Final review', gate: 'backTranslation' }
};
const BATCH_PHASES = ['parafrasa', 'translation', 'backtranslation'];

function anyApproved(field){ return (doc?.units || []).some(u => u[field].status === 'approved'); }
function bookProfileReady(){ return doc?.bookProfile?.status === 'approved'; }

function phaseLocked(name){
  const cfg = PHASES[name];
  if(cfg.gate && !anyApproved(cfg.gate)) return `Needs at least one approved ${PHASES[Object.keys(PHASES).find(k => PHASES[k].field === cfg.gate)]?.label.toLowerCase() || cfg.gate}`;
  if(cfg.needsBookProfile && !bookProfileReady()) return 'Needs an approved Book Profile';
  return null;
}

function setPhase(next){
  if(phaseLocked(next)) return;
  phase = next;
  if(BATCH_PHASES.includes(phase)) mode = phase;
  selected.clear();
  editingUnitId = null;
  $('batchWarning').textContent = '';
  // A filter left over from the previous phase would hide the very units this phase needs.
  $('statusFilter').value = '';
  $('unitSearch').value = '';
  renderAll();
}

$('phaseNav').addEventListener('click', e => {
  const tab = e.target.closest('.phase-tab');
  if(!tab || tab.disabled) return;
  setPhase(tab.dataset.phase);
});

function renderPhaseNav(){
  document.querySelectorAll('.phase-tab').forEach(tab => {
    const name = tab.dataset.phase;
    const locked = phaseLocked(name);
    tab.classList.toggle('active', phase === name);
    tab.classList.toggle('locked', !!locked);
    tab.disabled = !!locked;
    tab.title = locked || '';
  });
  const count = f => (doc?.units || []).filter(u => u[f].status === 'approved').length;
  const pend = f => (doc?.units || []).filter(u => u[f].status === 'pending').length;
  const badge = (el, approved, pending) => {
    $(el).textContent = pending ? `${pending} to review` : approved ? `${approved} done` : '';
    $(el).className = 'phase-badge' + (pending ? ' pending' : approved ? ' done' : '');
  };
  $('badgeScan').textContent = doc?.bookProfile?.status === 'approved' ? 'done' : doc?.bookProfile?.status === 'pending' ? 'to review' : '';
  $('badgeScan').className = 'phase-badge' + (doc?.bookProfile?.status === 'approved' ? ' done' : doc?.bookProfile?.status === 'pending' ? ' pending' : '');
  badge('badgeParaphrase', count('parafrasa'), pend('parafrasa'));
  badge('badgeTranslation', count('translation'), pend('translation'));
  badge('badgeBack', count('backTranslation'), pend('backTranslation'));
  const finalCount = (doc?.units || []).filter(u => u.final).length;
  $('badgeFinal').textContent = finalCount ? `${finalCount} final` : '';
  $('badgeFinal').className = 'phase-badge' + (finalCount ? ' done' : '');
}

// ---- Rendering ---------------------------------------------------------------
function currentChapters(){ return [...new Set((doc?.units || []).map(u => u.chapter))]; }
function workField(u){ return u[PHASES[mode].field]; }

function filteredUnits(){
  if(!doc) return [];
  // Search folds diacritics too, so typing "shimagh" still finds "shimāgh" in the manuscript.
  const rawQ = ($('unitSearch').value || '').trim();
  const q = foldDiacritics(rawQ).toLowerCase();
  const matchesQuery = u => !q
    || foldDiacritics(u.source).toLowerCase().includes(q)
    || u.id.toLowerCase().includes(q);
  const statusF = $('statusFilter').value;
  const chapterF = $('chapterFilter').value;
  if(phase === 'final'){
    return doc.units.filter(u => u.backTranslation.status === 'approved'
      && matchesQuery(u)
      && (!chapterF || u.chapter === chapterF));
  }
  const cfg = PHASES[mode];
  return doc.units.filter(u => {
    if(cfg.gate && u[cfg.gate].status !== 'approved') return false;
    if(!matchesQuery(u)) return false;
    if(statusF && workField(u).status !== statusF) return false;
    if(chapterF && u.chapter !== chapterF) return false;
    return true;
  });
}

function renderChapterFilter(){
  const sel = $('chapterFilter');
  const current = sel.value;
  sel.innerHTML = '<option value="">All sections</option>' + currentChapters().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  if([...sel.options].some(o => o.value === current)) sel.value = current;
}

function renderStatusFilterOptions(){
  const sel = $('statusFilter');
  const current = sel.value;
  const noneLabel = { parafrasa: 'No paraphrase yet', translation: 'No translation yet', backtranslation: 'No back translation yet' }[mode];
  const options = [['', 'All statuses'], ['none', noneLabel], ['sent', 'Sent — awaiting reply'], ['pending', 'Awaiting review'], ['approved', 'Approved'], ['rejected', 'Rejected']];
  sel.innerHTML = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  if(options.some(([v]) => v === current)) sel.value = current;
}

function renderDocSummary(){
  if(!doc) return;
  const total = doc.units.length;
  const stat = f => ({ approved: doc.units.filter(u => u[f].status === 'approved').length, pending: doc.units.filter(u => u[f].status === 'pending').length });
  const p = stat('parafrasa'), t = stat('translation'), b = stat('backTranslation');
  const finalCount = doc.units.filter(u => u.final).length;
  const rows = [`<div class="stat-label">Units</div><div class="stat-value">${total} · ${currentChapters().length} sections</div>`];
  rows.push(`<div class="stat-label">Paraphrase</div><div class="stat-value">${p.approved} approved · ${p.pending} pending</div>`);
  if(p.approved || t.approved || t.pending) rows.push(`<div class="stat-label">Translation</div><div class="stat-value">${t.approved} approved · ${t.pending} pending</div>`);
  if(t.approved || b.approved || b.pending) rows.push(`<div class="stat-label">Back Translation</div><div class="stat-value">${b.approved} approved · ${b.pending} pending</div>`);
  $('docSummary').innerHTML = `<div class="book-card">
    <p class="book-card-title" dir="auto">${escapeHtml(doc.fileName)}</p>
    <div class="book-stats">${rows.join('')}<div class="stat-final"><span>FINAL units</span><span>${finalCount} / ${total}</span></div></div>
  </div>`;

  const names = Object.keys(library.books);
  const sw = $('bookSwitcher');
  sw.hidden = names.length < 2;
  if(names.length > 1){
    sw.innerHTML = names.map(n => `<option value="${escapeHtml(n)}"${n === doc.fileName ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
  }
}

function emptyStateMessage(){
  if(phase === 'final') return 'No units have an approved back translation yet.';
  const statusF = $('statusFilter').value;
  const label = PHASES[mode].label.toLowerCase();
  if(statusF === 'pending') return `Nothing waiting for review. Pick fresh units on the left to send for ${label}.`;
  if(statusF === 'approved') return `No approved ${label} units yet.`;
  const cfg = PHASES[mode];
  if(cfg.gate && !anyApproved(cfg.gate)) return `Approve at least one unit in the previous phase first.`;
  return 'No units match the current filters.';
}

// A single <p dir="auto"> around a whole multi-paragraph unit takes its direction from the FIRST
// strong character in the entire block. A unit that opens with Arabic (e.g. a Bismillah line)
// then flips its own Malay/English paragraphs to RTL too, even though only that first line is
// Arabic — reported live as English text rendering right-aligned. Splitting on blank lines gives
// each paragraph its own dir="auto", so direction is judged per-paragraph, not per-unit.
function bidiSafeParagraphs(text){
  return text.split(/\n{2,}/).map(para =>
    `<p dir="auto">${escapeHtml(para).replace(/\n/g, '<br>')}</p>`
  ).join('');
}

function fieldBlock(label, text, cls, kind){
  if(!text) return '';
  return `<div class="unit-field ${cls || ''} ${kind ? 'kind-' + kind : ''}"><small>${escapeHtml(label)}</small>${bidiSafeParagraphs(text)}</div>`;
}

let singleCardMode = false;
let singleCardIndex = 0;

function renderUnitList(){
  const list = $('unitList');
  const allUnits = filteredUnits();
  if(!allUnits.length){
    list.innerHTML = `<div class="empty-state">${escapeHtml(emptyStateMessage())}</div>`;
    $('singleCardNav').hidden = true;
    return;
  }
  if(singleCardIndex >= allUnits.length) singleCardIndex = allUnits.length - 1;
  if(singleCardIndex < 0) singleCardIndex = 0;
  const units = singleCardMode ? [allUnits[singleCardIndex]] : allUnits;
  $('singleCardNav').hidden = !singleCardMode;
  if(singleCardMode){
    $('singleCardPos').textContent = `${singleCardIndex + 1} / ${allUnits.length} — ${allUnits[singleCardIndex].id}`;
    $('singleCardPrev').disabled = singleCardIndex === 0;
    $('singleCardNext').disabled = singleCardIndex === allUnits.length - 1;
  }
  let lastChapter = null;
  let html = '';
  units.forEach(u => {
    if(u.chapter !== lastChapter){ html += `<div class="chapter-heading" dir="auto">${escapeHtml(u.chapter)}</div>`; lastChapter = u.chapter; }

    if(phase === 'final'){
      html += `<div class="unit-card">
        <div class="unit-card-head"><b>${escapeHtml(u.id)}</b>${u.final ? '<span class="unit-status approved">FINAL</span>' : '<span class="unit-status pending">Not final</span>'}</div>
        ${fieldBlock('ORIGINAL', u.source, '', 'original')}
        ${fieldBlock('PARAPHRASE', u.parafrasa.text, 'reference', 'parafrasa')}
        ${fieldBlock('TRANSLATION', u.translation.text, '', 'translation')}
        ${fieldBlock('BACK TRANSLATION', u.backTranslation.text, 'reference', 'backtranslation')}
        <div class="unit-actions">${u.final
          ? `<button class="reject-button" data-unfinal="${escapeHtml(u.id)}">Unmark FINAL</button>`
          : `<button class="approve-button" data-final="${escapeHtml(u.id)}">✓ Mark FINAL</button>`}</div>
      </div>`;
      return;
    }

    const w = workField(u);
    const cfg = PHASES[mode];
    const isSelectable = w.status === 'none' || w.status === 'rejected';
    const label = { parafrasa: 'PARAPHRASE', translation: 'TRANSLATION', backtranslation: 'BACK TRANSLATION' }[mode];
    const approveLabel = { parafrasa: '✓ Approve paraphrase', translation: '✓ Approve translation', backtranslation: '✓ Approve back translation' }[mode];
    const refLabel = { translation: 'APPROVED PARAPHRASE', backtranslation: 'APPROVED TRANSLATION' }[mode];
    const refText = mode === 'translation' ? u.parafrasa.text : mode === 'backtranslation' ? u.translation.text : '';

    html += `<div class="unit-card">
      <div class="unit-card-head">
        ${isSelectable ? `<input type="checkbox" data-select="${escapeHtml(u.id)}" ${selected.has(u.id) ? 'checked' : ''}>` : '<span class="check-spacer"></span>'}
        <b>${escapeHtml(u.id)}</b>
        <span class="unit-status ${w.status}">${statusLabel(w.status)}</span>
        ${u.final ? '<span class="unit-status approved">FINAL</span>' : ''}
      </div>
      ${fieldBlock('ORIGINAL TEXT', u.source, '', 'original')}
      ${refLabel ? fieldBlock(refLabel, refText, 'reference', mode === 'translation' ? 'parafrasa' : 'translation') : ''}
      ${editingUnitId === u.id
        ? `<div class="unit-field kind-${mode}"><small>${label} (editing)</small><textarea class="edit-textarea" id="editTextarea" dir="auto">${escapeHtml(w.text)}</textarea></div>
           <div class="unit-actions"><button class="text-button" data-canceledit="${escapeHtml(u.id)}">Cancel</button><button class="approve-button" data-saveedit="${escapeHtml(u.id)}">✓ Save</button></div>`
        : `${fieldBlock(label, w.text, '', mode)}
           ${fieldBlock('CHATBOT NOTE', w.notes, 'note')}
           ${w.status === 'pending' ? `<div class="unit-actions"><button class="reject-button" data-reject="${escapeHtml(u.id)}">Reject</button><button class="text-button edit-button" data-edit="${escapeHtml(u.id)}">✎ Edit</button><button class="approve-button" data-approve="${escapeHtml(u.id)}">${approveLabel}</button></div>` : ''}
           ${w.status === 'approved' ? `<div class="unit-actions"><button class="reject-button" data-reject="${escapeHtml(u.id)}">Reopen for review</button><button class="text-button edit-button" data-edit="${escapeHtml(u.id)}">✎ Edit</button></div>` : ''}`
      }
    </div>`;
  });
  list.innerHTML = html;
}

function statusLabel(s){
  const noneLabel = { parafrasa: 'No paraphrase yet', translation: 'No translation yet', backtranslation: 'No back translation yet' }[mode];
  return { none: noneLabel, sent: 'Sent — awaiting reply', pending: 'Awaiting review', approved: 'Approved', rejected: 'Rejected' }[s] || s;
}

// A prompt can be copied and handed to a chatbot without the app ever knowing whether that
// chatbot actually received it — the browser-side send can fail silently. Marking units "sent"
// the moment their prompt is copied gives the editor a visible trail of what's outstanding, so a
// stalled or duplicate send is something the app surfaces instead of something only a human
// happens to remember.
function minutesAgo(iso){
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if(mins < 1) return 'just now';
  if(mins === 1) return '1 minute ago';
  if(mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
}
function renderSentBanner(){
  if(!BATCH_PHASES.includes(phase)){ $('sentBannerSection').hidden = true; return; }
  const sentUnits = (doc?.units || []).filter(u => workField(u).status === 'sent');
  if(!sentUnits.length){ $('sentBannerSection').hidden = true; return; }
  $('sentBannerSection').hidden = false;
  const oldest = sentUnits.reduce((a, b) => new Date(workField(a).sentAt) < new Date(workField(b).sentAt) ? a : b);
  $('sentBanner').textContent = `⏳ ${sentUnits.length} unit(s) sent (${sentUnits.map(u => u.id).join(', ')}) — oldest ${minutesAgo(workField(oldest).sentAt)}, no reply processed yet. Don't resend unless the send genuinely failed.`;
}
$('clearSentBtn').onclick = () => {
  (doc?.units || []).forEach(u => { if(workField(u).status === 'sent'){ workField(u).status = 'none'; workField(u).sentAt = null; } });
  save(); renderAll();
};

// ---- Prompts -----------------------------------------------------------------
// The profile is background for the chatbot, never material to draw from. Without saying so
// explicitly, a chatbot will lift vocabulary out of the Key terms list and work it into units
// where the author never used it — observed in production on a fiqh manuscript, where three
// technical terms appeared in a paraphrase of a passage that contained none of them. In a legal
// or religious text that shifts what the passage actually claims.
function bookProfileBlockFor(){
  const bp = doc?.bookProfile;
  if(!bp || bp.status !== 'approved' || !bp.fields) return '';
  const lines = BOOK_PROFILE_FIELDS.filter(f => bp.fields[f.key]).map(f => `${f.label}: ${bp.fields[f.key]}`).join('\n');
  return `\nBOOK PROFILE (background context only. It tells you what kind of book this is so you can judge tone and terminology. It is NOT source material: never insert a term, name, or idea from this profile into a unit unless that unit's own text already contains it. In particular, the Key terms list is a glossary of what MAY appear in the book, not a list of words to add.):\n${lines}\n`;
}
function memoryBlockFor(combinedText){
  const rel = relevantDecisionMemory(combinedText);
  return rel.length
    ? `\nDECISION MEMORY (approved editorial rulings relevant to these units. Follow exactly):\n${rel.map(e => `- ${e.term}: ${e.decision}`).join('\n')}\n`
    : '';
}

function renderPromptParafrasa(sel){
  const srcLang = (doc?.sourceLang || '').trim();
  if(!srcLang) return null;
  const body = sel.map(u => `[UNIT: ${u.id}]\n${u.source}`).join('\n\n');
  return `YOU ARE: ${srcLang} language editor performing PARAPHRASE-ONLY work on a manuscript. Do not translate to another language. Do not change the author's position, meaning, or tone. Only rephrase, staying in ${srcLang}.
${bookProfileBlockFor()}${memoryBlockFor(sel.map(u => u.source).join('\n'))}
For EACH unit below, return a ${srcLang} paraphrase and a short note flagging anything ambiguous, uncertain, or needing human attention (leave NOTES empty if there is nothing to flag).

UNITS:
${body}

Return EXACTLY this format, once per unit, in the same order, using the same [UNIT: id] markers:
[UNIT: <id>]
[PARAPHRASE]
...
[NOTES]
...
`;
}

function renderPromptTranslation(sel){
  const lang = (doc?.targetLang || '').trim();
  if(!lang) return null;
  const body = sel.map(u => `[UNIT: ${u.id}]\n[ORIGINAL_TEXT]\n${u.source}\n[APPROVED_PARAPHRASE]\n${u.parafrasa.text}`).join('\n\n');
  return `YOU ARE: A professional translator producing a faithful translation into ${lang}. Base your translation on BOTH the original text AND the approved paraphrase together: the paraphrase confirms meaning, the original is the authority for wording and tone. Preserve the author's voice, narrative point of view, and intent exactly as written — first-person stays first-person, third-person stays third-person. Do not soften, summarize, or add commentary.

Translate every word into ${lang}, including ordinary source-language words (e.g. everyday, cultural, technical, or administrative terms in the source language that have a plain ${lang} equivalent). Do NOT leave the source-language word sitting in parentheses next to its ${lang} translation as a crutch (e.g. do not write "translated word (source word)") — just give the ${lang} translation on its own. The ONLY exception is a genuine specialist term from another language that has no adequate ${lang} equivalent and is meant to be recognized in its original form (e.g. a classical/liturgical term, a proper noun, a technical term specific to this book's field) — those may be kept in their original script/transliteration, parenthetically glossed if helpful.
${bookProfileBlockFor()}${memoryBlockFor(sel.map(u => u.source + '\n' + u.parafrasa.text).join('\n'))}
For EACH unit below, return a translation into ${lang} and a short note flagging anything ambiguous, uncertain, or needing human attention (leave NOTES empty if there is nothing to flag).

UNITS:
${body}

Return EXACTLY this format, once per unit, in the same order, using the same [UNIT: id] markers:
[UNIT: <id>]
[TRANSLATION]
...
[NOTES]
...
`;
}

function renderPromptBackTranslation(sel){
  const srcLang = (doc?.sourceLang || '').trim() || 'the original source language';
  const body = sel.map(u => `[UNIT: ${u.id}]\n${u.translation.text}`).join('\n\n');
  return `YOU ARE: A literal back-translator. Your ONLY job is to translate the text below back into its ORIGINAL source language (${srcLang}) as literally as possible, word for word where feasible.

Do NOT improve, polish, reinterpret, or correct anything. Do NOT try to make it read naturally. Literalness matters more than elegance here. This is a mirror used to detect meaning drift against the original text, not a new translation.

For EACH unit below, return the literal back-translation and a short note only if something is structurally impossible to render literally (leave NOTES empty otherwise).

UNITS:
${body}

Return EXACTLY this format, once per unit, in the same order, using the same [UNIT: id] markers:
[UNIT: <id>]
[BACK_TRANSLATION]
...
[NOTES]
...
`;
}

function renderPrompt(){
  if(!BATCH_PHASES.includes(phase)) return;
  const sel = (doc?.units || []).filter(u => selected.has(u.id));
  const stats = batchStatsFor(sel);
  $('selectedCount').textContent = `${sel.length} selected · ${stats.chars}/${BATCH_MAX_CHARS} chars · ${stats.sentences}/${BATCH_MAX_SENTENCES} sentences`;
  // Marking a batch "sent" clears the selection, but blanking the prompt with it would strand an
  // editor whose clipboard copy failed or who needs to paste it a second time. The last prompt
  // stays on screen until a new selection replaces it.
  if(!sel.length) return;
  if(mode === 'parafrasa' && !(doc?.sourceLang || '').trim()){
    $('promptOut').value = "Fill in the manuscript's source language above before a paraphrase prompt can be built.";
    return;
  }
  if(mode === 'translation' && !(doc?.targetLang || '').trim()){
    $('promptOut').value = 'Fill in the target language above before a translation prompt can be built.';
    return;
  }
  $('promptOut').value = mode === 'parafrasa' ? renderPromptParafrasa(sel)
    : mode === 'translation' ? renderPromptTranslation(sel)
    : renderPromptBackTranslation(sel);
}

// ---- Master render -----------------------------------------------------------
function renderAll(){
  const hasDoc = !!doc;
  $('uploadScreen').hidden = hasDoc;
  $('workspace').hidden = !hasDoc;
  if(!hasDoc) return;

  $('toolsScan').hidden = phase !== 'scan';
  $('toolsBatch').hidden = !BATCH_PHASES.includes(phase);
  $('toolsFinal').hidden = phase !== 'final';
  $('bookProfilePanel').hidden = phase !== 'scan';
  $('unitList').hidden = phase === 'scan';
  $('filterRow').hidden = phase === 'scan';
  $('statusFilter').hidden = phase === 'final';
  $('panelTitle').textContent = PHASES[phase].panelTitle;

  if(phase === 'scan'){
    $('bookScanPromptOut').value = bookScanPromptText();
    renderBookProfilePanel();
  }
  if(BATCH_PHASES.includes(phase)){
    $('phaseIntro').textContent = PHASES[mode].intro;
    $('sourceLangSection').hidden = mode !== 'parafrasa';
    $('targetLangSection').hidden = mode !== 'translation';
    $('decisionMemorySection').hidden = mode === 'backtranslation';
    $('sourceLangInput').value = doc.sourceLang || '';
    $('targetLangInput').value = doc.targetLang || '';
    renderStatusFilterOptions();
    renderDecisionMemory();
  }

  renderPhaseNav();
  renderChapterFilter();
  renderDocSummary();
  renderSentBanner();
  renderUnitList();
  renderPrompt();
}

// ---- Selection & filters -----------------------------------------------------
$('unitSearch').oninput = () => { singleCardIndex = 0; renderUnitList(); };
$('statusFilter').onchange = () => { singleCardIndex = 0; renderUnitList(); };
$('chapterFilter').onchange = () => { singleCardIndex = 0; renderUnitList(); };
$('singleCardToggle').onchange = () => { singleCardMode = $('singleCardToggle').checked; singleCardIndex = 0; renderUnitList(); };
$('singleCardPrev').onclick = () => { singleCardIndex--; renderUnitList(); };
$('singleCardNext').onclick = () => { singleCardIndex++; renderUnitList(); };
$('targetLangInput').oninput = () => { if(doc){ doc.targetLang = $('targetLangInput').value; save(); renderPrompt(); } };
$('sourceLangInput').oninput = () => { if(doc){ doc.sourceLang = $('sourceLangInput').value; save(); renderPrompt(); } };
// Fills up to the cap and stops rather than overshooting — the remaining filtered units are left
// unchecked so the editor can just run "Select all filtered" again for the next batch.
$('selectAllBtn').onclick = () => {
  $('batchWarning').textContent = '';
  let stats = batchStatsFor((doc?.units || []).filter(u => selected.has(u.id)));
  let skipped = 0;
  for(const u of filteredUnits()){
    const s = workField(u).status;
    if(s !== 'none' && s !== 'rejected') continue;
    if(selected.has(u.id)) continue;
    const sentences = countSentences(u.source);
    if(stats.chars + u.source.length > BATCH_MAX_CHARS || stats.sentences + sentences > BATCH_MAX_SENTENCES){ skipped++; continue; }
    selected.add(u.id);
    stats.chars += u.source.length; stats.sentences += sentences;
  }
  if(skipped) $('batchWarning').textContent = `Batch limit reached (${BATCH_MAX_CHARS} chars / ${BATCH_MAX_SENTENCES} sentences) — ${skipped} unit(s) left unselected. Process this batch, then select more.`;
  renderUnitList(); renderPrompt();
};
$('selectNoneBtn').onclick = () => { selected.clear(); $('batchWarning').textContent = ''; $('promptOut').value = ''; renderUnitList(); renderPrompt(); };
$('unitList').addEventListener('change', e => {
  const cb = e.target.closest('input[data-select]');
  if(!cb) return;
  $('batchWarning').textContent = '';
  if(cb.checked){
    const u = doc.units.find(x => x.id === cb.dataset.select);
    const stats = batchStatsFor((doc?.units || []).filter(x => selected.has(x.id)));
    if(stats.chars + u.source.length > BATCH_MAX_CHARS || stats.sentences + countSentences(u.source) > BATCH_MAX_SENTENCES){
      cb.checked = false;
      $('batchWarning').textContent = `Adding this unit would exceed the batch limit (${BATCH_MAX_CHARS} chars / ${BATCH_MAX_SENTENCES} sentences). Process the current batch first.`;
      return;
    }
    selected.add(cb.dataset.select);
  } else {
    selected.delete(cb.dataset.select);
  }
  renderPrompt();
});
$('unitList').addEventListener('click', e => {
  const t = sel => e.target.closest(`button[data-${sel}]`);
  const editBtn = t('edit'), saveEditBtn = t('saveedit'), cancelEditBtn = t('canceledit');
  const approveBtn = t('approve'), rejectBtn = t('reject'), finalBtn = t('final'), unfinalBtn = t('unfinal');

  if(editBtn){ editingUnitId = editBtn.dataset.edit; renderUnitList(); return; }
  if(cancelEditBtn){ editingUnitId = null; renderUnitList(); return; }
  if(saveEditBtn){
    const u = doc.units.find(x => x.id === saveEditBtn.dataset.saveedit);
    const newText = $('editTextarea').value.trim();
    if(u && newText) workField(u).text = newText;
    editingUnitId = null;
    save(); renderUnitList();
    return;
  }
  if(approveBtn){
    const u = doc.units.find(x => x.id === approveBtn.dataset.approve);
    if(u) workField(u).status = 'approved';
    save(); renderAll();
  }
  if(rejectBtn){
    const u = doc.units.find(x => x.id === rejectBtn.dataset.reject);
    if(u){ workField(u).status = 'rejected'; if(mode === 'backtranslation') u.final = false; }
    save(); renderAll();
  }
  if(finalBtn){
    const u = doc.units.find(x => x.id === finalBtn.dataset.final);
    if(u) u.final = true;
    save(); renderAll();
  }
  if(unfinalBtn){
    const u = doc.units.find(x => x.id === unfinalBtn.dataset.unfinal);
    if(u) u.final = false;
    save(); renderAll();
  }
});

// ---- Export & backup ---------------------------------------------------------
function downloadJson(obj, filename){
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

$('exportBtn').onclick = () => {
  const finalUnits = (doc?.units || []).filter(u => u.final);
  if(!finalUnits.length){ $('backupMsg').textContent = 'No FINAL units to export yet.'; return; }
  downloadJson({
    fileName: doc.fileName, sourceLang: doc.sourceLang, targetLang: doc.targetLang, bookProfile: doc.bookProfile,
    exportedAt: new Date().toISOString(),
    units: finalUnits.map(u => ({
      id: u.id, chapter: u.chapter, source: u.source,
      paraphrase: u.parafrasa.text, translation: u.translation.text, backTranslation: u.backTranslation.text
    }))
  }, `${doc.fileName.replace(/\.docx$/i, '')}-final.json`);
};

// Builds a Word-openable .doc file entirely client-side, no external library or network call:
// Word reads HTML wrapped in its own XML namespace just as reliably as a real .docx. This keeps
// the export self-contained and offline, matching how the rest of the app already works.
function buildReadableWordDoc(finalUnits, titleLine, subtitleLine){
  const byChapter = new Map();
  finalUnits.forEach(u => {
    if(!byChapter.has(u.chapter)) byChapter.set(u.chapter, []);
    byChapter.get(u.chapter).push(u);
  });

  const chapterHtml = [...byChapter.entries()].map(([chapter, units]) => {
    const body = units.map(u => {
      const text = (u.translation.text || '').trim();
      if(!text) return '';
      return text.split(/\n\s*\n/).map(p => {
        const clean = escapeHtml(p.replace(/\n/g, ' ').trim());
        return clean ? `<p style="margin:0 0 12pt 0;text-indent:24pt;text-align:justify;">${clean}</p>` : '';
      }).join('');
    }).join('');
    return `<h1 style="font-size:16pt;margin:24pt 0 18pt 0;">${escapeHtml(chapter)}</h1>${body}`;
  }).join('<br clear="all" style="page-break-before:always">');

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${escapeHtml(titleLine)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>body{font-family:Calibri,Georgia,serif;font-size:12pt;line-height:1.5;} h1{font-family:Calibri,Arial,sans-serif;}</style>
</head>
<body>
<div style="text-align:center;margin-bottom:48pt;">
  <h1 style="font-size:26pt;margin-bottom:6pt;">${escapeHtml(titleLine)}</h1>
  <p style="font-style:italic;color:#555;">${escapeHtml(subtitleLine)}</p>
</div>
${chapterHtml}
</body></html>`;
}

$('exportDocBtn').onclick = () => {
  const finalUnits = (doc?.units || []).filter(u => u.final).sort((a, b) => a.id.localeCompare(b.id));
  if(!finalUnits.length){ $('exportDocMsg').textContent = 'No FINAL units to export yet.'; return; }
  const missingTranslation = finalUnits.filter(u => !u.translation.text?.trim());
  if(missingTranslation.length){
    $('exportDocMsg').textContent = `${missingTranslation.length} FINAL unit(s) have no translation text — export stopped so nothing is silently blank.`;
    return;
  }
  const titleLine = doc.fileName.replace(/\.docx$/i, '');
  const subtitleLine = `${doc.targetLang || 'Translation'} — exported ${new Date().toLocaleDateString()}`;
  const html = buildReadableWordDoc(finalUnits, titleLine, subtitleLine);
  const blob = new Blob(['﻿', html], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${titleLine} - ${doc.targetLang || 'Translation'}.doc`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  $('exportDocMsg').textContent = `✓ Document downloaded (${finalUnits.length} unit(s)).`;
  setTimeout(() => { $('exportDocMsg').textContent = ''; }, 4000);
};

$('backupBtn').onclick = () => {
  downloadJson(library, `adjung-translation-engine-backup.json`);
  $('backupMsg').textContent = '✓ Backup downloaded.';
  setTimeout(() => { $('backupMsg').textContent = ''; }, 4000);
};
$('restoreBtn').onclick = () => $('restoreInput').click();
$('restoreInput').onchange = async (e) => {
  const file = e.target.files[0];
  if(!file) return;
  try{
    const parsed = JSON.parse(await file.text());
    if(!parsed || !parsed.books) throw new Error('Not an Adjung backup file.');
    // This replaces every book currently in the browser, not just the active one. Without a
    // confirmation, picking the wrong backup file silently destroys everything in one click
    // with no undo — the single most destructive action anywhere in the app deserves one.
    const currentCount = Object.keys(library.books || {}).length;
    const incomingCount = Object.keys(parsed.books).length;
    const warning = currentCount
      ? `Restoring will REPLACE all ${currentCount} book(s) currently in this browser with the ${incomingCount} book(s) in "${file.name}". Anything not backed up separately will be lost. This cannot be undone.\n\nContinue?`
      : `Restore ${incomingCount} book(s) from "${file.name}"?`;
    if(!confirm(warning)){ $('restoreInput').value = ''; return; }
    library = parsed;
    Object.values(library.books).forEach(normalizeDoc);
    doc = library.activeFile ? library.books[library.activeFile] : Object.values(library.books)[0] || null;
    save();
    setPhase('scan');
    renderAll();
    $('backupMsg').textContent = `✓ Restored ${Object.keys(library.books).length} book(s).`;
  }catch(err){
    $('backupMsg').textContent = 'Restore failed: ' + err.message;
  }
};

// ---- Copy & paste ------------------------------------------------------------
$('copyPromptBtn').onclick = async () => {
  await copyWithFeedback($('promptOut'), $('copyPromptBtn'));
  const sentIds = [...selected];
  if(sentIds.length){
    const now = new Date().toISOString();
    doc.units.filter(u => selected.has(u.id)).forEach(u => { workField(u).status = 'sent'; workField(u).sentAt = now; });
    selected.clear();
    save();
    renderAll();
  }
};

function extractLabeled(chunk, label){
  const m = chunk.match(new RegExp(`\\[${label}\\]([\\s\\S]*?)(?=\\n\\[[A-Z_]+\\]|$)`, 'i'));
  return m ? m[1].trim() : '';
}
function parseBatchResponse(raw){
  const re = /\[UNIT:\s*([^\]]+)\]/g;
  const marks = [];
  let m;
  while((m = re.exec(raw)) !== null) marks.push({ id: m[1].trim(), headerEnd: re.lastIndex });
  const out = {};
  marks.forEach((mk, i) => {
    const nextStart = marks[i + 1] ? marks[i + 1].headerEnd - `[UNIT: ${marks[i + 1].id}]`.length : raw.length;
    out[mk.id] = raw.slice(mk.headerEnd, nextStart).trim();
  });
  return out;
}

$('processBtn').onclick = () => {
  const raw = $('pasteIn').value.trim();
  $('parseError').textContent = '';
  if(!raw){ $('parseError').textContent = "Paste the chatbot's reply first."; return; }
  const chunks = parseBatchResponse(raw);
  if(!Object.keys(chunks).length){ $('parseError').textContent = 'No [UNIT: id] markers found. Make sure the chatbot kept the requested format.'; return; }
  const fieldLabel = { parafrasa: 'PARAPHRASE', translation: 'TRANSLATION', backtranslation: 'BACK_TRANSLATION' }[mode];
  const targetField = PHASES[mode].field;

  // A chatbot can cut out mid-reply and still return something that parses — the first unit, or a
  // bare "[UNIT: U0001]" with no body. Silently accepting that leaves the rest of the batch blank
  // and looking merely "not started", so a truncated answer is refused before anything is written.
  const outstanding = doc.units.filter(u => u[targetField].status === 'sent');
  if(outstanding.length){
    const answered = outstanding.filter(u => {
      const chunk = chunks[u.id];
      return chunk && extractLabeled(chunk, fieldLabel);
    });
    if(answered.length < outstanding.length){
      const missing = outstanding.filter(u => !answered.includes(u)).map(u => u.id);
      $('parseError').textContent = `Incomplete reply: ${answered.length} of ${outstanding.length} sent unit(s) answered. Missing ${missing.join(', ')}. The chatbot likely cut out — send the batch again rather than accepting a partial answer. Nothing was saved.`;
      return;
    }
  }

  let applied = 0, unknown = [];
  Object.entries(chunks).forEach(([id, chunk]) => {
    const u = doc.units.find(x => x.id === id);
    if(!u){ unknown.push(id); return; }
    const text = extractLabeled(chunk, fieldLabel);
    if(!text) return;
    u[targetField] = { text, notes: extractLabeled(chunk, 'NOTES'), status: 'pending' };
    applied++;
  });
  save();
  selected.clear();
  $('batchWarning').textContent = '';
  $('pasteIn').value = '';
  $('statusFilter').value = 'pending';
  renderAll();
  const approveLabel = { parafrasa: 'Approve paraphrase', translation: 'Approve translation', backtranslation: 'Approve back translation' }[mode];
  $('parseSuccess').textContent = `✓ ${applied} unit(s) saved. The list is filtered to "Awaiting review". Use "${approveLabel}" or "Reject" on each card.`
    + (unknown.length ? ` Ignored unknown id(s): ${unknown.join(', ')}.` : '');
  setTimeout(() => { $('parseSuccess').textContent = ''; }, 8000);
};

renderAll();
