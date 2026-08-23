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
  { key: 'argumentStructure', tag: 'ARGUMENT_STRUCTURE', label: 'Structure', max: 400 },
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

// A standalone line of asterisks/dashes/etc. between paragraphs is a scene break in prose —
// worth flagging in the unit list (not auto-merging: that's an editorial call) so the editor
// notices "U0018 ends mid-scene, U0019 starts a new one" before selecting a batch that
// straddles it without meaning to.
const SCENE_BREAK_RE = /^[\s*×✦⁂—–\-•·#~]{2,}$/;

// Footnotes were extracted from the .docx (footnoteDb, per-paragraph footnoteIds) but nothing
// downstream ever read them — no prompt, no UI panel, no export used this data. A manuscript
// with real footnotes (common in academic/religious texts) silently lost them between upload
// and FINAL. Folding the footnote text directly into the unit's source, clearly marked, means
// every existing stage (Book Scan, Paraphrase, Translation, Back Translation, export) carries
// it through for free — no new subsystem, no new UI, nothing to forget to wire up later.
function buildUnitsFromParagraphs(paragraphs, footnoteDb){
  footnoteDb = footnoteDb || {};
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
    const flush = (sceneBreakAfter) => {
      if(!bucket.length) return;
      counter++;
      const footnoteIds = [...new Set(bucket.flatMap(p => p.footnoteIds))];
      const footnoteLines = footnoteIds.map(id => `[Footnote: ${footnoteDb[id]}]`).join('\n');
      units.push({
        id: `U${String(counter).padStart(4, '0')}`,
        chapter: sec.title,
        source: bucket.map(p => p.text).join('\n\n') + (footnoteLines ? `\n\n${footnoteLines}` : ''),
        parafrasa: blankWork(), translation: blankWork(), backTranslation: blankWork(),
        final: false, sceneBreakAfter: !!sceneBreakAfter
      });
      bucket = []; bucketLen = 0;
    };
    body.forEach(p => {
      // A standalone break-marker line (***, —, etc.) is a real editorial boundary, not manuscript
      // prose — close whatever's accumulated so far right here rather than folding the marker
      // into either neighboring unit's body text.
      if(SCENE_BREAK_RE.test(p.text.trim())){ flush(true); return; }
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
    const freshUnits = buildUnitsFromParagraphs(paragraphs, footnoteDb);

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
      fileName: file.name, units: freshUnits,
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

// "Reject and redo" alone means one wrong field (say, a mistranscribed Key Terms list) forces
// throwing away eight fields that were fine and re-running the whole book through a chatbot
// again. Per-field editing turns a partial fix into a partial fix, not a full do-over.
let editingBpField = null;

function renderBookProfilePanel(){
  const bp = doc.bookProfile;
  const fieldsHtml = BOOK_PROFILE_FIELDS.map(f => {
    const val = (bp.fields && bp.fields[f.key]) || '';
    const over = val.length > f.max;
    const title = over ? `title="The chatbot ran a little long here. Not an error — shorter just keeps every field skimmable and consistent across the book. Edit the field if you want to trim it."` : '';
    if(editingBpField === f.key){
      return `<div class="bp-field bp-field-editing">
        <div class="bp-field-head"><small>${escapeHtml(f.label)} (editing)</small></div>
        <textarea class="edit-textarea" id="editBpTextarea" dir="auto">${escapeHtml(val)}</textarea>
        <div class="unit-actions"><button class="text-button" id="bpCancelFieldEdit">Cancel</button><button class="approve-button" id="bpSaveFieldEdit" data-field="${f.key}">✓ Save</button></div>
      </div>`;
    }
    return `<div class="bp-field final-field-wrap">
      <div class="bp-field-head"><small>${escapeHtml(f.label)}</small><span class="bp-field-count${over ? ' over' : ''}" ${title}>${val.length}/${f.max}</span></div>
      ${val ? `<p dir="auto">${escapeHtml(val)}</p>` : '<p class="bp-field-empty">Not provided by the chatbot.</p>'}
      <button class="text-button edit-button final-edit-btn" data-editbp="${f.key}">✎ Edit</button>
    </div>`;
  }).join('');

  if(bp.status === 'none'){
    $('bookProfileFields').innerHTML = '<div class="empty-state">No Book Profile yet. Copy the prompt on the left, send it to your chatbot with the book file, then paste the reply.</div>';
    $('bookProfileActions').innerHTML = '';
    return;
  }
  const filledCount = BOOK_PROFILE_FIELDS.filter(f => (bp.fields && bp.fields[f.key])).length;
  const overCount = BOOK_PROFILE_FIELDS.filter(f => (bp.fields && bp.fields[f.key] || '').length > f.max).length;
  const validationLine = `<p class="bp-validation${filledCount < BOOK_PROFILE_FIELDS.length ? ' bp-validation-warn' : ''}">${filledCount}/${BOOK_PROFILE_FIELDS.length} fields complete${overCount ? ` · ${overCount} running long (not an error)` : ''}</p>`;
  $('bookProfileFields').innerHTML = validationLine + fieldsHtml;
  $('bookProfileActions').innerHTML = bp.status === 'pending'
    ? `<button class="reject-button" id="bpReject">Reject and redo</button><button class="approve-button" id="bpApprove">✓ Approve Book Profile &amp; Start Paraphrase</button>`
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
  renderKeyTermsImport();
}

// Key Terms is a comma-separated list the chatbot already produced from reading the whole book —
// turning it into one-click Decision Memory entries (with an empty ruling to fill in) is much
// less friction than retyping each term by hand into the Decision Memory form later, term by term.
function renderKeyTermsImport(){
  const box = $('bpKeyTermsImport');
  if(!box) return;
  const bp = doc.bookProfile;
  const raw = bp?.fields?.keyTerms || '';
  const terms = [...new Set(raw.split(',').map(t => t.trim()).filter(Boolean))];
  const existing = new Set((doc.decisionMemory || []).map(e => e.term.toLowerCase()));
  const newTerms = terms.filter(t => !existing.has(t.toLowerCase()));
  if(!terms.length){ box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = newTerms.length
    ? `<p class="hint-small">Key Terms recognised ${terms.length} term(s). Add the ${newTerms.length} not yet in Decision Memory as empty entries ready for you to fill in a ruling?</p>
       <p class="hint-small">Creates ${newTerms.length} draft Decision Memory entr${newTerms.length === 1 ? 'y' : 'ies'} with no ruling — none of them affects a prompt until you write and save a ruling for it. Nothing is auto-accepted.</p>
       <button class="text-button" id="bpImportTerms">+ Add ${newTerms.length} term(s) to Decision Memory</button>`
    : `<p class="hint-small">All ${terms.length} Key Terms already have a Decision Memory entry.</p>`;
  if($('bpImportTerms')) $('bpImportTerms').onclick = () => {
    if(!doc.decisionMemory) doc.decisionMemory = [];
    newTerms.forEach(term => doc.decisionMemory.push({ id: `DM${Date.now().toString(36)}${Math.floor(Math.random()*1000)}`, term, decision: '' }));
    save(); renderAll();
  };
}

$('copyBookScanBtn').onclick = () => copyWithFeedback($('bookScanPromptOut'), $('copyBookScanBtn'));
$('bpReopenFromBar').onclick = () => { doc.bookProfile.status = 'pending'; save(); renderAll(); };

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

$('bookProfileFields').addEventListener('click', e => {
  const editBtn = e.target.closest('button[data-editbp]');
  const cancelBtn = e.target.closest('button#bpCancelFieldEdit');
  const saveBtn = e.target.closest('button#bpSaveFieldEdit');
  if(editBtn){ editingBpField = editBtn.dataset.editbp; renderBookProfilePanel(); return; }
  if(cancelBtn){ editingBpField = null; renderBookProfilePanel(); return; }
  if(saveBtn){
    if(!doc.bookProfile.fields) doc.bookProfile.fields = {};
    doc.bookProfile.fields[saveBtn.dataset.field] = $('editBpTextarea').value.trim();
    editingBpField = null;
    save(); renderAll();
    return;
  }
});

// ---- Decision Memory ---------------------------------------------------------
let editingDmId = null;

function renderDecisionMemory(){
  if(!doc.decisionMemory) doc.decisionMemory = [];
  $('dmCount').textContent = String(doc.decisionMemory.length);
  const ruled = doc.decisionMemory.filter(e => e.decision);
  const empty = doc.decisionMemory.length - ruled.length;
  // The panel starts collapsed, so this line is the only thing an editor sees without opening
  // it — naming the actual terms (not just a count) is what lets them judge at a glance whether
  // the rulings they need are already there.
  const names = ruled.length <= 6 ? ruled.map(e => e.term).join(', ') : `${ruled.slice(0, 5).map(e => e.term).join(', ')} +${ruled.length - 5} more`;
  $('dmSummaryLine').textContent = !doc.decisionMemory.length
    ? '0 rulings — add or review before processing, especially names and religious/technical terms.'
    : !ruled.length ? `${empty} term(s) waiting for a ruling`
    : empty ? `${ruled.length} ruling(s) saved (${names}) · ${empty} term(s) still need one` : `${ruled.length} ruling(s) saved: ${names}`;
  const list = $('dmList');
  if(!doc.decisionMemory.length){ list.innerHTML = '<p class="dm-empty">No rulings saved yet.</p>'; return; }
  list.innerHTML = doc.decisionMemory.map(e => {
    if(editingDmId === e.id){
      return `<div class="dm-entry">
        <div class="dm-entry-head"><span class="dm-entry-term" dir="auto">${escapeHtml(e.term)}</span></div>
        <textarea class="dm-decision-input" id="dmEditDecision" rows="2" placeholder="Ruling for this term…">${escapeHtml(e.decision)}</textarea>
        <div class="unit-actions"><button class="text-button" data-dmcanceledit="1">Cancel</button><button class="approve-button" data-dmsaveedit="${escapeHtml(e.id)}">✓ Save</button></div>
      </div>`;
    }
    // A term imported from Key Terms starts with no ruling — flag it so it doesn't sit forgotten
    // and silently do nothing (an empty decision never matches a chatbot instruction to follow).
    const empty = !e.decision;
    const suggestionHtml = (e.suggestion && !e.decision) ? `<div class="dm-suggestion">
        <p dir="auto"><small>AI SUGGESTION</small><br>${escapeHtml(e.suggestion)}</p>
        <div class="unit-actions"><button class="reject-button" data-dmrejectsuggest="${escapeHtml(e.id)}">Reject</button><button class="approve-button" data-dmacceptsuggest="${escapeHtml(e.id)}">✓ Accept</button></div>
      </div>` : '';
    return `<div class="dm-entry">
      <div class="dm-entry-head"><span class="dm-entry-term" dir="auto">${escapeHtml(e.term)}</span><span class="dm-entry-actions"><button class="dm-remove" data-dmedit="${escapeHtml(e.id)}">Edit</button><button class="dm-remove" data-dmremove="${escapeHtml(e.id)}">Remove</button></span></div>
      <p class="dm-entry-decision${empty ? ' dm-entry-empty' : ''}" dir="auto">${e.decision ? escapeHtml(e.decision) : 'No ruling yet — click Edit to add one. Until then this term is not sent to the chatbot.'}</p>
      ${suggestionHtml}
    </div>`;
  }).join('');
  renderDmSuggestPrompt();
}

// ---- Decision Memory ruling suggestions ---------------------------------------
// Same "AI proposes, human decides" gate as everywhere else in the app: a suggested ruling
// never becomes an active Decision Memory entry by itself. It sits next to the term, editable
// as plain text (Accept just copies it into `decision`), until the editor explicitly accepts
// or rejects it.
function dmTermsNeedingSuggestion(){
  return (doc.decisionMemory || []).filter(e => !e.decision && !e.suggestion);
}
function renderDmSuggestPrompt(){
  const out = $('dmSuggestPromptOut');
  if(!out) return;
  const terms = dmTermsNeedingSuggestion();
  if(!terms.length){ out.value = ''; out.placeholder = 'No terms without a ruling right now.'; return; }
  const bp = doc?.bookProfile;
  const context = bp?.status === 'approved' && bp.fields
    ? BOOK_PROFILE_FIELDS.filter(f => bp.fields[f.key]).map(f => `${f.label}: ${bp.fields[f.key]}`).join('\n')
    : '(No approved Book Profile yet — suggest based on the term itself.)';
  out.value = `YOU ARE: An editorial assistant proposing terminology rulings for a translation project, based on context already gathered about this book. You are NOT deciding anything — a human editor will accept or reject each suggestion.

BOOK CONTEXT:
${context}

For EACH term below, propose ONE short, concrete ruling: how it should be handled in translation (e.g. keep untranslated, translate as X, treat as a proper noun, etc.), in one sentence. If you have no confident basis for a term, say so plainly rather than guessing.

TERMS:
${terms.map(t => `- ${t.term}`).join('\n')}

Return EXACTLY this format, once per term, in the same order:
[TERM: <term>]
<one-sentence ruling>
`;
}
$('dmCopySuggestBtn')?.addEventListener('click', () => copyWithFeedback($('dmSuggestPromptOut'), $('dmCopySuggestBtn')));
$('dmProcessSuggestBtn')?.addEventListener('click', () => {
  const raw = $('dmSuggestPasteIn').value.trim();
  $('dmSuggestError').textContent = '';
  if(!raw){ $('dmSuggestError').textContent = "Paste the chatbot's suggestions first."; return; }
  const blocks = [...raw.matchAll(/\[TERM:\s*([^\]]+)\]\s*([\s\S]*?)(?=\[TERM:|$)/g)];
  if(!blocks.length){ $('dmSuggestError').textContent = 'No [TERM: ...] markers found. Make sure the chatbot kept the requested format.'; return; }
  let matched = 0;
  blocks.forEach(([, term, text]) => {
    const entry = doc.decisionMemory.find(e => e.term.toLowerCase() === term.trim().toLowerCase());
    if(entry && !entry.decision){ entry.suggestion = text.trim(); matched++; }
  });
  if(!matched){ $('dmSuggestError').textContent = "Terms in the reply didn't match any term still waiting for a ruling."; return; }
  $('dmSuggestPasteIn').value = '';
  save(); renderDecisionMemory();
});
$('dmList').addEventListener('click', e => {
  const acceptBtn = e.target.closest('button[data-dmacceptsuggest]');
  const rejectBtn = e.target.closest('button[data-dmrejectsuggest]');
  if(acceptBtn){
    const entry = doc.decisionMemory.find(x => x.id === acceptBtn.dataset.dmacceptsuggest);
    if(entry){ entry.decision = entry.suggestion; entry.suggestion = null; }
    save(); renderDecisionMemory(); renderPrompt();
    return;
  }
  if(rejectBtn){
    const entry = doc.decisionMemory.find(x => x.id === rejectBtn.dataset.dmrejectsuggest);
    if(entry) entry.suggestion = null;
    save(); renderDecisionMemory();
    return;
  }
});

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
  const removeBtn = e.target.closest('button[data-dmremove]');
  const editBtn = e.target.closest('button[data-dmedit]');
  const saveBtn = e.target.closest('button[data-dmsaveedit]');
  const cancelBtn = e.target.closest('button[data-dmcanceledit]');
  if(removeBtn){
    doc.decisionMemory = doc.decisionMemory.filter(x => x.id !== removeBtn.dataset.dmremove);
    save(); renderDecisionMemory(); renderPrompt();
    return;
  }
  if(editBtn){ editingDmId = editBtn.dataset.dmedit; renderDecisionMemory(); return; }
  if(cancelBtn){ editingDmId = null; renderDecisionMemory(); return; }
  if(saveBtn){
    const entry = doc.decisionMemory.find(x => x.id === saveBtn.dataset.dmsaveedit);
    const newDecision = $('dmEditDecision').value.trim();
    if(entry) entry.decision = newDecision;
    editingDmId = null;
    save(); renderDecisionMemory(); renderPrompt();
    return;
  }
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
  // An entry imported from Key Terms with no ruling filled in yet has nothing useful to tell a
  // chatbot — "- term: " with a blank instruction is confusing, not helpful. Skip it until the
  // editor actually writes a ruling.
  return doc.decisionMemory.filter(e => e.decision && termAppearsIn(text, e.term));
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

// FINAL means Paraphrase, Translation AND Back Translation are all correct together — editing,
// rejecting, or reopening any earlier stage doesn't just invalidate that stage, it invalidates
// everything built on top of it. Marking a downstream stage 'stale' (rather than silently leaving
// it 'approved') is what stops a since-changed Paraphrase from quietly exporting a Back
// Translation that was actually checked against an earlier, different Translation.
const STAGE_ORDER = ['parafrasa', 'translation', 'backTranslation'];
const STAGE_LABEL = { parafrasa: 'Paraphrase', translation: 'Translation', backTranslation: 'Back Translation' };
function invalidateDownstream(u, fromField){
  const idx = STAGE_ORDER.indexOf(fromField);
  const invalidated = [];
  for(let i = idx + 1; i < STAGE_ORDER.length; i++){
    const f = STAGE_ORDER[i];
    if(['approved', 'pending', 'sent'].includes(u[f].status)){
      u[f].status = 'stale';
      invalidated.push(STAGE_LABEL[f]);
    }
  }
  if(u.final){ u.final = false; invalidated.push('FINAL'); }
  return invalidated;
}

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
  if(!tab) return;
  const name = tab.dataset.phase;
  const locked = phaseLocked(name);
  if(locked){
    $('nextUnlockLine').hidden = false;
    $('nextUnlockLine').textContent = unlockSentence(name);
    return;
  }
  setPhase(name);
});

// What unlocks `name`, in two forms — a full sentence ("X unlocks after ...") for the tab's
// hover title and the click explanation, and a short imperative clause ("approve a ...") for
// the single "Next" line under the nav. Built from the same underlying gate check so the two
// phrasings can never drift into describing different conditions.
function unlockSentence(name){
  const cfg = PHASES[name];
  if(cfg.gate && !anyApproved(cfg.gate)){
    const gatePhase = Object.values(PHASES).find(p => p.field === cfg.gate);
    return `${cfg.label} unlocks after at least one ${gatePhase.label.toLowerCase()} is approved.`;
  }
  if(cfg.needsBookProfile && !bookProfileReady()) return `${cfg.label} unlocks after the Book Profile is approved.`;
  return '';
}
function unlockImperative(name){
  const cfg = PHASES[name];
  if(cfg.gate && !anyApproved(cfg.gate)){
    const gatePhase = Object.values(PHASES).find(p => p.field === cfg.gate);
    return `approve a ${gatePhase.label.toLowerCase()}`;
  }
  if(cfg.needsBookProfile && !bookProfileReady()) return 'approve the Book Profile';
  return '';
}
const PHASE_ORDER = ['parafrasa', 'translation', 'backtranslation', 'final'];
function nextUnlockMessage(){
  for(const name of PHASE_ORDER){
    if(phaseLocked(name)) return `Next: ${unlockImperative(name)} to unlock ${PHASES[name].label}.`;
  }
  return null;
}

function renderPhaseNav(){
  document.querySelectorAll('.phase-tab').forEach(tab => {
    const name = tab.dataset.phase;
    const locked = phaseLocked(name);
    tab.classList.toggle('active', phase === name);
    tab.classList.toggle('locked', !!locked);
    // Kept focusable/clickable rather than truly `disabled` — a genuinely disabled button is
    // invisible to keyboard navigation and a screen reader, and clicking it is exactly how the
    // inline "why is this locked" explanation below gets triggered.
    tab.disabled = false;
    tab.setAttribute('aria-disabled', locked ? 'true' : 'false');
    tab.title = locked ? unlockSentence(name) : '';
  });
  const count = f => (doc?.units || []).filter(u => u[f].status === 'approved').length;
  const pend = f => (doc?.units || []).filter(u => u[f].status === 'pending').length;
  const stale = f => (doc?.units || []).filter(u => u[f].status === 'stale').length;
  // A locked badge stays a short fixed "Locked" — the full unlock reason lives in one place
  // (the "Next" line below the nav, or the inline explanation on click), not repeated three
  // times in slightly different wording across three crowded tab badges. "done" on its own would
  // be a lie the moment an earlier stage invalidates this one, so stale takes priority over it.
  const badge = (el, name, approved, pending, staleCount) => {
    const locked = phaseLocked(name);
    $(el).textContent = locked ? '🔒 Locked' : staleCount ? `${staleCount} stale — rerun` : pending ? `${pending} to review` : approved ? `${approved} done` : '';
    $(el).className = 'phase-badge' + (locked ? ' locked' : staleCount ? ' stale' : pending ? ' pending' : approved ? ' done' : '');
  };
  $('badgeScan').textContent = doc?.bookProfile?.status === 'approved' ? 'done' : doc?.bookProfile?.status === 'pending' ? 'to review' : '';
  $('badgeScan').className = 'phase-badge' + (doc?.bookProfile?.status === 'approved' ? ' done' : doc?.bookProfile?.status === 'pending' ? ' pending' : '');
  badge('badgeParaphrase', 'parafrasa', count('parafrasa'), pend('parafrasa'), stale('parafrasa'));
  badge('badgeTranslation', 'translation', count('translation'), pend('translation'), stale('translation'));
  badge('badgeBack', 'backtranslation', count('backTranslation'), pend('backTranslation'), stale('backTranslation'));
  const finalCount = (doc?.units || []).filter(u => u.final).length;
  badge('badgeFinal', 'final', finalCount, 0);
  if(!phaseLocked('final')){
    $('badgeFinal').textContent = finalCount ? `${finalCount} final` : '';
    $('badgeFinal').className = 'phase-badge' + (finalCount ? ' done' : '');
  }
  const next = nextUnlockMessage();
  $('nextUnlockLine').hidden = !next;
  if(next) $('nextUnlockLine').textContent = next;
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
    // A unit whose Back Translation went stale mid-review used to just vanish from this list —
    // technically correct (it's no longer ready), but an editor working through Final Review has
    // no reason to know that's WHY it's gone. Keeping it visible with its own filter bucket means
    // "why did U0007 disappear" never has to be answered by switching phases to go look for it.
    return doc.units.filter(u => (u.backTranslation.status === 'approved' || u.backTranslation.status === 'stale')
      && matchesQuery(u)
      && (!chapterF || u.chapter === chapterF)
      && (!statusF || (
        statusF === 'final' ? u.final :
        statusF === 'ready' ? (!u.final && u.backTranslation.status === 'approved') :
        statusF === 'stale' ? u.backTranslation.status === 'stale' : true
      )));
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
  let options;
  if(phase === 'final'){
    options = [['', 'All'], ['ready', 'Ready for final review'], ['final', 'Marked FINAL'], ['stale', 'Incomplete / needs rerun']];
  } else {
    const noneLabel = { parafrasa: 'No paraphrase yet', translation: 'No translation yet', backtranslation: 'No back translation yet' }[mode];
    options = [['', 'All statuses'], ['none', noneLabel], ['sent', 'Sent — awaiting reply'], ['pending', 'Awaiting review'], ['approved', 'Approved'], ['stale', 'Stale — rerun needed'], ['rejected', 'Rejected']];
  }
  sel.innerHTML = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  if(options.some(([v]) => v === current)) sel.value = current;
  else sel.value = '';
}

function renderDocSummary(){
  if(!doc) return;
  const total = doc.units.length;
  // "0 pending" alone reads as "nothing left to do" — spelling out how many units haven't even
  // been sent yet (vs. sent-and-waiting vs. waiting-for-editor-review) is the difference between
  // a status line and a status line someone can act on.
  const stat = f => {
    const approved = doc.units.filter(u => u[f].status === 'approved').length;
    const pending = doc.units.filter(u => u[f].status === 'pending').length;
    const sent = doc.units.filter(u => u[f].status === 'sent').length;
    const stale = doc.units.filter(u => u[f].status === 'stale').length;
    const notStarted = total - approved - pending - sent - stale;
    return { approved, pending, sent, stale, notStarted };
  };
  // "Approved" alone during a re-run doesn't say the approval is against text that no longer
  // exists — surfacing "stale" here is what stops a chain that looks finished from actually
  // being finished.
  const statLine = s => `${s.approved} approved · ${s.notStarted} not started`
    + (s.sent ? ` · ${s.sent} sent` : '') + (s.pending ? ` · ${s.pending} awaiting review` : '') + (s.stale ? ` · ${s.stale} stale` : '');
  const p = stat('parafrasa'), t = stat('translation'), b = stat('backTranslation');
  const finalCount = doc.units.filter(u => u.final).length;
  const rows = [`<div class="stat-label">Units</div><div class="stat-value">${total} · ${currentChapters().length} sections</div>`];
  rows.push(`<div class="stat-label">Paraphrase</div><div class="stat-value">${statLine(p)}</div>`);
  if(p.approved || t.approved || t.pending || t.sent || t.stale) rows.push(`<div class="stat-label">Translation</div><div class="stat-value">${statLine(t)}</div>`);
  if(t.approved || b.approved || b.pending || b.sent || b.stale) rows.push(`<div class="stat-label">Back Translation</div><div class="stat-value">${statLine(b)}</div>`);
  $('docSummary').innerHTML = `<div class="book-card">
    <p class="book-card-title" dir="auto">${escapeHtml(doc.fileName)}</p>
    <div class="book-stats">${rows.join('')}<div class="stat-final"><span>FINAL units</span><span>${finalCount} / ${total}</span></div></div>
    ${doc.targetLang ? `<p class="hint-small target-lang-row">Target language: <b>${escapeHtml(doc.targetLang)}</b></p>` : ''}
  </div>`;

  const names = Object.keys(library.books);
  const sw = $('bookSwitcher');
  sw.hidden = names.length < 2;
  if(names.length > 1){
    sw.innerHTML = names.map(n => `<option value="${escapeHtml(n)}"${n === doc.fileName ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
  }
}

function emptyStateMessage(){
  if(phase === 'final'){
    const f = $('statusFilter').value;
    if(f === 'final') return 'No units marked FINAL yet.';
    if(f === 'stale') return 'Nothing incomplete right now — no unit needs a rerun.';
    if(f === 'ready') return 'Nothing ready to mark FINAL — every reviewable unit is already FINAL, or none have an approved back translation yet.';
    return 'No units have an approved back translation yet.';
  }
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

// Original and Back Translation are meant to end up close to identical (both in the source
// language — Back Translation is a literal mirror of the Translation, back into that language),
// which is exactly what makes a word-level diff between them useful: real drift shows up as
// visible insertions/deletions instead of requiring the editor to read both blocks in full and
// hold the comparison in their head. Classic LCS diff on whitespace-preserving tokens, no library.
let diffShownIds = new Set();
function diffWords(a, b){
  const aw = a.split(/(\s+)/), bw = b.split(/(\s+)/);
  const n = aw.length, m = bw.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for(let i = n - 1; i >= 0; i--){
    for(let j = m - 1; j >= 0; j--){
      dp[i][j] = aw[i] === bw[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while(i < n && j < m){
    if(aw[i] === bw[j]){ ops.push({ type: 'same', text: aw[i] }); i++; j++; }
    else if(dp[i + 1][j] >= dp[i][j + 1]){ ops.push({ type: 'del', text: aw[i] }); i++; }
    else { ops.push({ type: 'add', text: bw[j] }); j++; }
  }
  while(i < n){ ops.push({ type: 'del', text: aw[i] }); i++; }
  while(j < m){ ops.push({ type: 'add', text: bw[j] }); j++; }
  return ops;
}
function renderDiffHtml(a, b){
  return diffWords(a, b).map(op => {
    if(op.type === 'same') return escapeHtml(op.text);
    if(op.type === 'del') return `<del>${escapeHtml(op.text)}</del>`;
    return `<ins>${escapeHtml(op.text)}</ins>`;
  }).join('');
}

// Final Review used to be read-only: catching a mistake there meant leaving the screen,
// remembering which of three phases it came from, hunting the unit down again by search,
// fixing it, and navigating all the way back. This state tracks an in-place edit on one of
// a FINAL card's three writable fields (not the original source, which isn't editable),
// independent of `mode`/`editingUnitId` since Final Review isn't a single-field batch phase.
let editingFinalId = null;
let editingFinalField = null; // 'parafrasa' | 'translation' | 'backTranslation'
const FINAL_FIELD_META = {
  parafrasa: { label: 'PARAPHRASE', cls: 'reference', kind: 'parafrasa' },
  translation: { label: 'TRANSLATION', cls: '', kind: 'translation' },
  backTranslation: { label: 'BACK TRANSLATION', cls: 'reference', kind: 'backtranslation' }
};
function finalFieldBlock(u, fieldKey){
  const meta = FINAL_FIELD_META[fieldKey];
  const text = u[fieldKey].text;
  if(editingFinalId === u.id && editingFinalField === fieldKey){
    return `<div class="unit-field kind-${meta.kind}"><small>${meta.label} (editing)</small><textarea class="edit-textarea" id="editFinalTextarea" dir="auto">${escapeHtml(text)}</textarea></div>
      <div class="unit-actions"><button class="text-button" data-cancelfinaledit="1">Cancel</button><button class="approve-button" data-savefinaledit="${escapeHtml(u.id)}|${fieldKey}">✓ Save</button></div>`;
  }
  return `<div class="final-field-wrap">${fieldBlock(meta.label, text, meta.cls, meta.kind)}<button class="text-button edit-button final-edit-btn" data-editfinal="${escapeHtml(u.id)}|${fieldKey}">✎ Edit</button></div>`;
}

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
      const isStale = u.backTranslation.status === 'stale';
      const showingDiff = diffShownIds.has(u.id);
      const diffBlock = showingDiff
        ? `<div class="unit-field diff-field"><small>DIFFERENCES — ORIGINAL → BACK TRANSLATION</small><p dir="auto">${renderDiffHtml(u.source, u.backTranslation.text)}</p></div>`
        : '';
      html += `<div class="unit-card">
        <div class="unit-card-head"><b>${escapeHtml(u.id)}</b>${u.final ? '<span class="unit-status approved">FINAL</span>' : isStale ? '<span class="unit-status stale">Needs rerun</span>' : '<span class="unit-status pending">Not final</span>'}</div>
        ${fieldBlock('ORIGINAL', u.source, '', 'original')}
        ${finalFieldBlock(u, 'parafrasa')}
        ${finalFieldBlock(u, 'translation')}
        ${isStale
          ? `<p class="stale-banner">⚠ Back Translation is stale — it no longer matches the current Translation. <button class="text-button" data-gotobt="${escapeHtml(u.id)}">Go rerun it →</button></p>`
          : `${finalFieldBlock(u, 'backTranslation')}
             <button class="text-button" data-togglediff="${escapeHtml(u.id)}">${showingDiff ? '✕ Hide differences' : '🔍 Show differences (Original ↔ Back Translation)'}</button>
             ${diffBlock}`}
        <div class="unit-actions final-actions-sticky">${isStale
          ? `<span class="hint-small">Rerun Back Translation before this unit can be marked FINAL again.</span>`
          : u.final
            ? `<button class="reject-button" data-unfinal="${escapeHtml(u.id)}">Unmark FINAL</button>`
            : `<button class="approve-button" data-final="${escapeHtml(u.id)}">✓ Mark FINAL</button>`}</div>
      </div>`;
      if(u.sceneBreakAfter) html += `<div class="scene-break-marker">✦ scene break ✦</div>`;
      return;
    }

    const w = workField(u);
    const cfg = PHASES[mode];
    const isSelectable = w.status === 'none' || w.status === 'rejected' || w.status === 'stale';
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
      ${w.status === 'stale' ? `<p class="stale-banner">⚠ ${statusLabel('stale')} — the text below is outdated. Pick this unit above to send it again.</p>` : ''}
      ${editingUnitId === u.id
        ? `<div class="unit-field kind-${mode}"><small>${label} (editing)</small><textarea class="edit-textarea" id="editTextarea" dir="auto">${escapeHtml(w.text)}</textarea></div>
           <div class="unit-actions"><button class="text-button" data-canceledit="${escapeHtml(u.id)}">Cancel</button><button class="approve-button" data-saveedit="${escapeHtml(u.id)}">✓ Save</button></div>`
        : `${fieldBlock(label, w.text, '', mode)}
           ${fieldBlock('CHATBOT NOTE', w.notes, 'note')}
           ${w.status === 'pending' ? `<div class="unit-actions"><button class="reject-button" data-reject="${escapeHtml(u.id)}">Reject</button><button class="text-button edit-button" data-edit="${escapeHtml(u.id)}">✎ Edit</button><button class="approve-button" data-approve="${escapeHtml(u.id)}">${approveLabel}</button></div>` : ''}
           ${w.status === 'approved' ? `<div class="unit-actions"><button class="reject-button" data-reject="${escapeHtml(u.id)}">Reopen for review</button><button class="text-button edit-button" data-edit="${escapeHtml(u.id)}">✎ Edit</button></div>` : ''}`
      }
    </div>`;
    if(u.sceneBreakAfter) html += `<div class="scene-break-marker">✦ scene break ✦</div>`;
  });
  list.innerHTML = html;
}

function statusLabel(s){
  const noneLabel = { parafrasa: 'No paraphrase yet', translation: 'No translation yet', backtranslation: 'No back translation yet' }[mode];
  const staleLabel = { parafrasa: 'Stale — earlier text changed, rerun needed', translation: 'Stale — earlier text changed, rerun needed', backtranslation: 'Stale — Translation changed, rerun needed' }[mode];
  return { none: noneLabel, sent: 'Sent — awaiting reply', pending: 'Awaiting review', approved: 'Approved', rejected: 'Rejected', stale: staleLabel }[s] || s;
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

// Only added to a prompt when a selected unit actually carries a folded-in footnote — most
// units don't, and repeating this instruction on every batch regardless would be exactly the
// prompt-bloat this app already avoids for Book Profile terms and Decision Memory.
function footnoteNoteFor(sel, textOf){
  textOf = textOf || (u => u.source);
  if(!sel.some(u => textOf(u).includes('[Footnote:'))) return '';
  return `\nSome units contain a line like "[Footnote: ...]" — this is the manuscript's own footnote text, carried inline because it belongs with that passage. Treat it as real content to render faithfully, not as an instruction to you and not as part of the main body prose; keep it as its own "[Footnote: ...]" line in your reply so it stays distinguishable.\n`;
}

function renderPromptParafrasa(sel){
  const srcLang = (doc?.sourceLang || '').trim();
  if(!srcLang) return null;
  const body = sel.map(u => `[UNIT: ${u.id}]\n${u.source}`).join('\n\n');
  return `YOU ARE: ${srcLang} language editor performing PARAPHRASE-ONLY work on a manuscript. Do not translate to another language. Do not change the author's position, meaning, or tone. Only rephrase, staying in ${srcLang}.
${footnoteNoteFor(sel)}${bookProfileBlockFor()}${memoryBlockFor(sel.map(u => u.source).join('\n'))}
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
${footnoteNoteFor(sel)}${bookProfileBlockFor()}${memoryBlockFor(sel.map(u => u.source + '\n' + u.parafrasa.text).join('\n'))}
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
${footnoteNoteFor(sel, u => u.translation.text)}
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

// A rough, honest estimate (not a real tokenizer) — good enough to tell an editor "this prompt
// is small" vs "this prompt is huge" before they copy a wall of text they can't skim.
function estimateTokens(text){ return Math.round((text || '').length / 4); }

function renderPromptSummary(promptText, sel){
  const box = $('promptSummary');
  if(!promptText || !sel.length){ box.hidden = true; return; }
  const relTexts = mode === 'parafrasa' ? sel.map(u => u.source)
    : mode === 'translation' ? sel.map(u => u.source + '\n' + u.parafrasa.text)
    : sel.map(u => u.translation.text);
  const relevant = mode === 'backtranslation' ? [] : relevantDecisionMemory(relTexts.join('\n'));
  const bpIncluded = mode !== 'backtranslation' && bookProfileReady();
  box.hidden = false;
  box.innerHTML = `~${estimateTokens(promptText).toLocaleString()} tokens · ${sel.length} unit(s)`
    + (mode === 'backtranslation' ? '' : ` · Decision Memory applied: ${relevant.length ? relevant.map(e => escapeHtml(e.term)).join(', ') : 'none'}`)
    + (bpIncluded ? ` · <button class="summary-toggle" id="promptSummaryBpToggle">Book Profile included ▾</button>` : '');
  if(bpIncluded){
    $('promptSummaryBpToggle').onclick = () => {
      let preview = box.querySelector('.prompt-summary-preview');
      if(preview){ preview.remove(); return; }
      preview = document.createElement('div');
      preview.className = 'prompt-summary-preview';
      preview.textContent = bookProfileBlockFor().trim();
      box.appendChild(preview);
    };
  }
}

// Which of Step A/B/C the editor is actually on right now, driven by state rather than a
// separate flag — picked-but-not-copied is Step B, copied-and-sent is Step C, anything else
// (including right after a batch finishes and there's nothing outstanding) falls back to Step A.
function renderBatchAccordion(){
  if(!BATCH_PHASES.includes(phase)) return;
  const sel = (doc?.units || []).filter(u => selected.has(u.id));
  const sentCount = (doc?.units || []).filter(u => workField(u).status === 'sent').length;
  const pendingCount = (doc?.units || []).filter(u => workField(u).status === 'pending').length;
  const active = sentCount ? 'C' : sel.length ? 'B' : 'A';
  $('stepA').open = active === 'A';
  $('stepB').open = active === 'B';
  $('stepC').open = active === 'C';
  $('stepASummary').textContent = sel.length ? `${sel.length} unit(s) picked`
    : pendingCount || sentCount ? `${pendingCount} awaiting review · ${sentCount} sent` : 'Nothing picked yet';
  $('stepBSummary').textContent = sel.length ? `Prompt ready for ${sel.length} unit(s)`
    : sentCount ? 'Sent — waiting for a reply' : 'Pick units first';
  $('stepCSummary').textContent = sentCount ? `${sentCount} unit(s) sent, waiting for a reply`
    : pendingCount ? `${pendingCount} unit(s) awaiting your review` : 'Nothing to paste yet';
}

function renderPrompt(){
  if(!BATCH_PHASES.includes(phase)) return;
  renderBatchAccordion();
  const sel = (doc?.units || []).filter(u => selected.has(u.id));
  const stats = batchStatsFor(sel);
  $('selectedCount').textContent = `${sel.length} selected · ${stats.chars}/${BATCH_MAX_CHARS} chars · ${stats.sentences}/${BATCH_MAX_SENTENCES} sentences`;
  // Marking a batch "sent" clears the selection, but blanking the prompt with it would strand an
  // editor whose clipboard copy failed or who needs to paste it a second time. The last prompt
  // stays on screen until a new selection replaces it.
  if(!sel.length){ $('promptSummary').hidden = true; return; }
  if(mode === 'parafrasa' && !(doc?.sourceLang || '').trim()){
    $('promptOut').value = "Fill in the manuscript's source language above before a paraphrase prompt can be built.";
    $('promptSummary').hidden = true;
    return;
  }
  if(mode === 'translation' && !(doc?.targetLang || '').trim()){
    $('promptOut').value = 'Fill in the target language above before a translation prompt can be built.';
    $('promptSummary').hidden = true;
    return;
  }
  const promptText = mode === 'parafrasa' ? renderPromptParafrasa(sel)
    : mode === 'translation' ? renderPromptTranslation(sel)
    : renderPromptBackTranslation(sel);
  $('promptOut').value = promptText;
  renderPromptSummary(promptText, sel);
}

// ---- Master render -----------------------------------------------------------
function renderAll(){
  const hasDoc = !!doc;
  $('uploadScreen').hidden = hasDoc;
  $('workspace').hidden = !hasDoc;
  if(!hasDoc) return;
  renderBackupStatus();

  $('toolsScan').hidden = phase !== 'scan';
  $('toolsBatch').hidden = !BATCH_PHASES.includes(phase);
  $('toolsFinal').hidden = phase !== 'final';
  $('bookProfilePanel').hidden = phase !== 'scan';
  $('unitList').hidden = phase === 'scan';
  $('filterRow').hidden = phase === 'scan';
  $('panelTitle').textContent = PHASES[phase].panelTitle;
  if(phase === 'final'){
    renderStatusFilterOptions();
    // "Export FINAL units" on its own reads as "export everything" to someone who hasn't been
    // tracking the FINAL count closely — naming the actual number on the button itself is what
    // stops a 1-of-19 export from being mistaken for the whole book.
    const finalCount = doc.units.filter(u => u.final).length;
    $('exportDocBtn').textContent = `⬇ Export ${finalCount} FINAL unit${finalCount === 1 ? '' : 's'} (.doc)`;
    $('exportBtn').textContent = `⬇ Export ${finalCount} FINAL unit${finalCount === 1 ? '' : 's'} (.json)`;
  }

  if(phase === 'scan'){
    $('bookScanPromptOut').value = bookScanPromptText();
    $('targetLangInputScan').value = doc.targetLang || '';
    const targetSet = (doc.targetLang || '').trim();
    $('targetLangScanStatus').textContent = targetSet ? `✓ Set: ${doc.targetLang}` : 'Not set — optional for now, required before Translation unlocks.';
    $('targetLangScanStatus').className = 'hint-small target-lang-status' + (targetSet ? ' set' : '');
    // The copy/paste controls that built this profile are one-time setup — once approved, they
    // no longer need to dominate the screen above the profile they produced. A collapsed bar
    // still lets the editor reopen and redo the whole thing if the profile turns out wrong.
    const bpApproved = doc.bookProfile?.status === 'approved';
    $('bookScanCompleteBar').hidden = !bpApproved;
    $('bookScanSteps').hidden = bpApproved;
    renderBookProfilePanel();
  }
  if(BATCH_PHASES.includes(phase)){
    $('phaseIntro').textContent = PHASES[mode].intro;
    $('sourceLangSection').hidden = mode !== 'parafrasa';
    $('targetLangSection').hidden = mode !== 'translation';
    $('decisionMemorySection').hidden = mode === 'backtranslation';
    // Back Translation intentionally has no source-language picker or Decision Memory of its
    // own — it always mirrors into the language already set for Paraphrase, and a literal
    // mirror-back isn't the place to apply terminology rulings. Without saying so, the missing
    // panels read as something broken rather than something deliberate.
    $('backtranslationInfo').hidden = mode !== 'backtranslation';
    if(mode === 'backtranslation') $('backtranslationInfo').innerHTML = `Back-translating into: <b>${escapeHtml(doc.sourceLang || '(source language not set)')}</b><br>Literal comparison mode — Decision Memory is intentionally not applied.`;
    $('sourceLangInput').value = doc.sourceLang || '';
    $('targetLangInput').value = doc.targetLang || '';
    $('targetLangInputScan').value = doc.targetLang || '';
    renderStatusFilterOptions();
    renderDecisionMemory();
    renderSourceLangSuggest();
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
$('targetLangInput').oninput = () => { if(doc){ doc.targetLang = $('targetLangInput').value; save(); $('targetLangInputScan').value = doc.targetLang; renderPrompt(); renderDocSummary(); } };
$('targetLangInputScan').oninput = () => {
  if(!doc) return;
  doc.targetLang = $('targetLangInputScan').value; save();
  $('targetLangInput').value = doc.targetLang;
  renderDocSummary();
  const targetSet = doc.targetLang.trim();
  $('targetLangScanStatus').textContent = targetSet ? `✓ Set: ${doc.targetLang}` : 'Not set — optional for now, required before Translation unlocks.';
  $('targetLangScanStatus').className = 'hint-small target-lang-status' + (targetSet ? ' set' : '');
};
$('sourceLangInput').oninput = () => { if(doc){ doc.sourceLang = $('sourceLangInput').value; save(); renderSourceLangSuggest(); renderPrompt(); } };

// A free-text source language field trusts whatever the editor typed, with nothing to catch a
// mismatch (e.g. field says "Malay" but a manuscript mixes in English chapters) until it shows
// up as a garbled paraphrase several steps later. This is a lightweight in-browser heuristic —
// not real language detection — that only ever SUGGESTS from the actual text of the units about
// to be sent, so the editor can catch an obviously wrong setting before copying the prompt. It
// never overwrites the field on its own.
// Malay and Indonesian share almost their entire stopword list, so trying to tell them apart
// from ~20 common words is false precision that would flip on a single word and confuse more
// than it helps — one "Malay" bucket for both is the honest level of confidence this gives.
const LANG_MARKERS = [
  { lang: 'Arabic', test: t => /[؀-ۿ]/.test(t) },
  { lang: 'Malay', words: ['yang','dan','ini','itu','saya','tidak','ada','dengan','untuk','tak','dia','kami','kita','pada','dari','akan','sudah','juga','boleh','bisa','nggak'] },
  { lang: 'English', words: ['the','and','of','to','is','was','in','that','it','with','for','as','on','are','this','his','her'] }
];
function detectLanguage(text){
  if(!text) return null;
  const arabic = LANG_MARKERS[0];
  if(arabic.test(text)) return 'Arabic';
  const lower = ' ' + text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ') + ' ';
  let best = null, bestScore = 0;
  LANG_MARKERS.slice(1).forEach(m => {
    const score = m.words.reduce((n, w) => n + (lower.includes(` ${w} `) ? 1 : 0), 0);
    if(score > bestScore){ bestScore = score; best = m.lang; }
  });
  return bestScore >= 2 ? best : null;
}
function renderSourceLangSuggest(){
  const box = $('sourceLangSuggest');
  if(!box || !doc) return;
  const sample = (doc.units || []).filter(u => selected.has(u.id)).slice(0, 3);
  const units = sample.length ? sample : (doc.units || []).slice(0, 3);
  const detected = detectLanguage(units.map(u => u.source).join(' '));
  const current = (doc.sourceLang || '').trim();
  if(!detected || detected.toLowerCase() === current.toLowerCase()){ box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `Detected from ${sample.length ? 'the selected units' : "this book's opening"}: <b>${escapeHtml(detected)}</b><button id="applyLangSuggest">Use ${escapeHtml(detected)}</button><span class="lang-suggest-note">This is only a suggestion — it won't fill the field on its own. You can set a different language for this batch.</span>`;
  $('applyLangSuggest').onclick = () => {
    doc.sourceLang = detected; $('sourceLangInput').value = detected; save(); box.hidden = true; renderPrompt();
  };
}
// Fills up to the cap and stops rather than overshooting — the remaining filtered units are left
// unchecked so the editor can just run "Select all filtered" again for the next batch.
$('selectAllBtn').onclick = () => {
  $('batchWarning').textContent = '';
  let stats = batchStatsFor((doc?.units || []).filter(u => selected.has(u.id)));
  let skipped = 0, picked = 0;
  for(const u of filteredUnits()){
    const s = workField(u).status;
    if(s !== 'none' && s !== 'rejected') continue;
    if(selected.has(u.id)) continue;
    const sentences = countSentences(u.source);
    if(stats.chars + u.source.length > BATCH_MAX_CHARS || stats.sentences + sentences > BATCH_MAX_SENTENCES){ skipped++; continue; }
    selected.add(u.id);
    stats.chars += u.source.length; stats.sentences += sentences;
    picked++;
  }
  // Naming the actual outcome (not just the cap being hit) means the editor never has to
  // recount the checkboxes themselves to know what a click just did.
  $('batchWarning').textContent = skipped
    ? `All filtered selected up to the batch limit (${BATCH_MAX_CHARS} chars / ${BATCH_MAX_SENTENCES} sentences): ${picked} unit(s) selected, ${skipped} left over — process this batch, then run it again.`
    : `All filtered selected: ${picked} unit(s).`;
  renderUnitList(); renderPrompt(); renderSourceLangSuggest();
};
// A smaller, round-trip-sized pick — "Select all filtered" deliberately fills to the hard cap,
// which is more than a first-time editor needs for one comfortable review pass.
const SUGGESTED_BATCH_UNITS = 5;
$('suggestBatchBtn').onclick = () => {
  $('batchWarning').textContent = '';
  let stats = batchStatsFor((doc?.units || []).filter(u => selected.has(u.id)));
  let picked = 0;
  for(const u of filteredUnits()){
    if(picked >= SUGGESTED_BATCH_UNITS) break;
    const s = workField(u).status;
    if(s !== 'none' && s !== 'rejected') continue;
    if(selected.has(u.id)) continue;
    const sentences = countSentences(u.source);
    if(stats.chars + u.source.length > BATCH_MAX_CHARS || stats.sentences + sentences > BATCH_MAX_SENTENCES) break;
    selected.add(u.id);
    stats.chars += u.source.length; stats.sentences += sentences;
    picked++;
  }
  $('batchWarning').textContent = picked
    ? `Suggested batch selected: ${picked} next unit(s) not yet started.`
    : 'No unstarted units left to suggest — everything filtered is already sent, pending, or approved.';
  renderUnitList(); renderPrompt(); renderSourceLangSuggest();
};
$('selectNoneBtn').onclick = () => { selected.clear(); $('batchWarning').textContent = ''; $('promptOut').value = ''; renderUnitList(); renderPrompt(); renderSourceLangSuggest(); };
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
  renderPrompt(); renderSourceLangSuggest();
});
$('unitList').addEventListener('click', e => {
  const t = sel => e.target.closest(`button[data-${sel}]`);
  const editBtn = t('edit'), saveEditBtn = t('saveedit'), cancelEditBtn = t('canceledit');
  const approveBtn = t('approve'), rejectBtn = t('reject'), finalBtn = t('final'), unfinalBtn = t('unfinal');
  const editFinalBtn = t('editfinal'), saveFinalEditBtn = t('savefinaledit'), cancelFinalEditBtn = t('cancelfinaledit');
  const toggleDiffBtn = t('togglediff'), gotoBtBtn = t('gotobt');

  if(toggleDiffBtn){
    const id = toggleDiffBtn.dataset.togglediff;
    if(diffShownIds.has(id)) diffShownIds.delete(id); else diffShownIds.add(id);
    renderUnitList();
    return;
  }
  if(gotoBtBtn){
    const id = gotoBtBtn.dataset.gotobt;
    setPhase('backtranslation');
    $('unitSearch').value = id;
    $('unitSearch').dispatchEvent(new Event('input'));
    return;
  }
  if(editBtn){ editingUnitId = editBtn.dataset.edit; renderUnitList(); return; }
  if(cancelEditBtn){ editingUnitId = null; renderUnitList(); return; }
  if(saveEditBtn){
    const u = doc.units.find(x => x.id === saveEditBtn.dataset.saveedit);
    const newText = $('editTextarea').value.trim();
    const changed = u && newText && newText !== workField(u).text;
    if(u && newText) workField(u).text = newText;
    // Changing an already-approved Paraphrase or Translation text here is possible (Edit stays
    // available after approval) — cascade the same way a Reject would, since the text a later
    // stage was built on just changed under it.
    if(changed) invalidateDownstream(u, PHASES[mode].field);
    editingUnitId = null;
    save(); renderUnitList();
    return;
  }
  if(editFinalBtn){
    const [id, field] = editFinalBtn.dataset.editfinal.split('|');
    editingFinalId = id; editingFinalField = field;
    renderUnitList(); return;
  }
  if(cancelFinalEditBtn){ editingFinalId = null; editingFinalField = null; renderUnitList(); return; }
  if(saveFinalEditBtn){
    const [id, field] = saveFinalEditBtn.dataset.savefinaledit.split('|');
    const u = doc.units.find(x => x.id === id);
    const newText = $('editFinalTextarea').value.trim();
    // A FINAL unit's text edited without touching FINAL status would let a post-approval change
    // slip into an export having never been re-reviewed — the whole point of marking FINAL in
    // the first place. Auto-unmarking is the simplest rule an editor can't accidentally defeat:
    // any actual text change means the unit goes back to "not final" until reconfirmed.
    const changed = u && newText && newText !== u[field].text;
    if(u && newText) u[field].text = newText;
    if(changed){
      const invalidated = invalidateDownstream(u, field);
      const stagesOnly = invalidated.filter(x => x !== 'FINAL');
      if(invalidated.length){
        $('finalEditNotice').textContent = stagesOnly.length
          ? `${id}: ${stagesOnly.join(' and ')} now stale, FINAL removed — rerun the stale stage(s) before this unit returns to Final Review.`
          : `${id}: FINAL removed — review this unit again before export.`;
        setTimeout(() => { $('finalEditNotice').textContent = ''; }, 8000);
      }
    }
    editingFinalId = null; editingFinalField = null;
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
    // FINAL depends on Paraphrase, Translation, AND Back Translation all being correct together —
    // rejecting or reopening any ONE of the three (this button doubles as "Reject" on a pending
    // unit and "Reopen for review" on an approved one) has to cascade to every stage built on top
    // of it, not just clear FINAL. A Translation reopened after Back Translation already ran
    // against the old text leaves that Back Translation checking against text that no longer
    // exists — it needs to be marked stale, not left reading "Approved".
    if(u){ workField(u).status = 'rejected'; invalidateDownstream(u, PHASES[mode].field); }
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

// A "✓ Backup downloaded" toast that fades after 4 seconds tells an editor nothing 10 minutes
// later when they're wondering whether they actually protected today's work — a persistent
// "last downloaded" line does.
function formatBackupTime(iso){
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? `today, ${time}` : `${d.toLocaleDateString()}, ${time}`;
}
function renderBackupStatus(){
  const el = $('backupMsg');
  if(!el) return;
  el.textContent = library.lastBackupAt ? `Last backup downloaded: ${formatBackupTime(library.lastBackupAt)}` : 'No backup downloaded yet.';
}
$('backupBtn').onclick = () => {
  downloadJson(library, `adjung-translation-engine-backup.json`);
  library.lastBackupAt = new Date().toISOString();
  localStorage.setItem(LIB_KEY, JSON.stringify(library));
  renderBackupStatus();
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

// Live feedback the moment the reply lands, before "Process & Save" is even clicked — the old
// flow only reported a malformed or partial reply after the click, forcing a fix-and-retry loop
// that a glance at this line can avoid.
$('pasteIn').addEventListener('input', () => {
  const el = $('pasteInStatus');
  const raw = $('pasteIn').value.trim();
  if(!raw){ el.textContent = ''; el.className = 'hint-small paste-status'; return; }
  const chunks = parseBatchResponse(raw);
  const found = Object.keys(chunks).length;
  const targetField = PHASES[mode].field;
  const outstanding = doc.units.filter(u => u[targetField].status === 'sent').length;
  if(!found){ el.textContent = '⚠ No [UNIT: id] markers detected yet — check the reply kept the requested format.'; el.className = 'hint-small paste-status warn'; return; }
  if(outstanding && found < outstanding){
    const missingIds = doc.units.filter(u => u[targetField].status === 'sent' && !chunks[u.id]).map(u => u.id);
    el.textContent = `⚠ ${found} of ${outstanding} sent unit(s) detected — missing ${missingIds.join(', ') || 'some units'}. Looks incomplete.`;
    el.className = 'hint-small paste-status warn';
    return;
  }
  el.textContent = found === 1 ? '✓ 1 unit detected. Structure is valid — review the content before saving.' : `✓ ${found} units detected. Structure is valid — review the content before saving.`;
  el.className = 'hint-small paste-status ok';
});

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

  let applied = 0, unknown = [], firstAppliedId = null;
  Object.entries(chunks).forEach(([id, chunk]) => {
    const u = doc.units.find(x => x.id === id);
    if(!u){ unknown.push(id); return; }
    const text = extractLabeled(chunk, fieldLabel);
    if(!text) return;
    u[targetField] = { text, notes: extractLabeled(chunk, 'NOTES'), status: 'pending' };
    if(!firstAppliedId) firstAppliedId = id;
    applied++;
  });
  save();
  selected.clear();
  $('batchWarning').textContent = '';
  $('pasteIn').value = '';
  $('pasteInStatus').textContent = '';
  $('statusFilter').value = 'pending';
  renderAll();
  const approveLabel = { parafrasa: 'Approve paraphrase', translation: 'Approve translation', backtranslation: 'Approve back translation' }[mode];
  const fieldNoun = { parafrasa: 'paraphrase', translation: 'translation', backtranslation: 'back translation' }[mode];
  $('parseSuccess').textContent = `✓ ${applied} ${fieldNoun}${applied === 1 ? '' : 's'} saved — now awaiting review. Use "${approveLabel}" or "Reject" on each card below.`
    + (unknown.length ? ` Ignored unknown id(s): ${unknown.join(', ')}.` : '');
  setTimeout(() => { $('parseSuccess').textContent = ''; }, 8000);
  // Collapsing the accordion and re-filtering the list can leave the unit that was just saved
  // scrolled out of view, which reads as the content having vanished rather than moved — scroll
  // it back into frame so "saved" and "here it is" happen together.
  if(firstAppliedId){
    const card = [...document.querySelectorAll('.unit-card')].find(el => el.querySelector('b')?.textContent === firstAppliedId);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
};

renderAll();
