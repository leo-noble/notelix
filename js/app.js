const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── STATE ──
let pdfs = [], slides = [];
let editIdx = null, edHist = [], edFut = [];
let selTool = 'rect', eAct = 'invert';
let drawing = false, selS = null, selE = null;
let activeLogoIdx = 0;
let processedPdfBlob = null, processedPdfName = '';
let logoRegions = [
  { w: 13, h: 13, shape: 'rect', corner: 'top-left', enabled: true, useCustom: true, customX: 0, customY: 0 },
  { w: 13, h: 13, shape: 'rect', corner: 'top-right', enabled: false }
];
const PDF_RENDER_BASE_SCALE = 1.65;
const PDF_RENDER_MAX_SIDE = 1800;
const PDF_RENDER_MAX_PIXELS = 2600000;
const THUMB_MAX_SIDE = 360;
const PREVIEW_MAX_SIDE = 1400;
function clampPdfViewport(page) {
  const base = page.getViewport({scale: 1});
  let scale = PDF_RENDER_BASE_SCALE;
  const sideScale = PDF_RENDER_MAX_SIDE / Math.max(base.width, base.height);
  const pixelScale = Math.sqrt(PDF_RENDER_MAX_PIXELS / Math.max(1, base.width * base.height));
  scale = Math.min(scale, sideScale, pixelScale);
  return page.getViewport({scale: Math.max(1, scale)});
}
function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
}
function makeScaledCanvas(src, maxSide, className = '') {
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  const canvas = document.createElement('canvas');
  if (className) canvas.className = className;
  canvas.width = Math.max(1, Math.round(src.width * scale));
  canvas.height = Math.max(1, Math.round(src.height * scale));
  canvas.getContext('2d', {alpha:false}).drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// ── STEP NAV ──
function goStep(n) {
  [1,2,3,4].forEach(i => {
    document.getElementById('p'+i).classList.toggle('active', i===n);
    const sn = document.getElementById('sn'+i);
    const sc = document.getElementById('sc'+i);
    const wasDone = sn.classList.contains('done');
    const wasActive = sn.classList.contains('active');
    sn.classList.remove('active','done','step-popping','step-donepop');
    if (i < n) {
      sn.classList.add('done');
      sc.textContent = '✓';
      // Animate the circle going to "done" only when it just left "active"
      if (wasActive) {
        void sn.offsetWidth; // force reflow
        sn.classList.add('step-donepop');
        setTimeout(() => sn.classList.remove('step-donepop'), 420);
      }
    } else if (i === n) {
      sn.classList.add('active');
      sc.textContent = i;
      if (!wasActive) {
        void sn.offsetWidth;
        sn.classList.add('step-popping');
        setTimeout(() => sn.classList.remove('step-popping'), 520);
      }
    } else {
      sc.textContent = i;
    }
    if (i < 4) document.getElementById('sl'+i).classList.toggle('done', i < n);
  });
  // Show step bar on steps 2-4, hide on step 1
  const stepBar = document.getElementById('step-bar');
  if (stepBar) stepBar.classList.toggle('hidden', n === 1);
  if (n === 2 && !slides.length) loadSlides();
  if (n === 3) syncS3();
  if (!_procScrollLocked) window.scrollTo(0,0);
}

// ── FILE HANDLING ──
const uploadBox = document.getElementById('upload-box');
const dzInner = document.getElementById('dz-inner');
const filesBlock = document.getElementById('files-block');
const fi = document.getElementById('fi');
const fiMore = document.getElementById('fi-more');

uploadBox.addEventListener('dragover', e => { e.preventDefault(); uploadBox.classList.add('over'); });
uploadBox.addEventListener('dragleave', () => uploadBox.classList.remove('over'));
uploadBox.addEventListener('drop', e => { e.preventDefault(); uploadBox.classList.remove('over'); handleFiles([...e.dataTransfer.files]); });
fi.addEventListener('change', () => { handleFiles([...fi.files]); fi.value = ''; });
fiMore.addEventListener('change', () => { handleFiles([...fiMore.files]); fiMore.value = ''; });

function handleFiles(files) {
  const valid = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (!valid.length) { showToast('No PDF files found'); return; }
  valid.forEach(f => {
    if (pdfs.find(p => p.name === f.name)) return;
    pdfs.push({ name: f.name, size: f.size, file: f });
    addPdfRow(pdfs.length - 1);
  });
  syncUpload();
}
function addPdfRow(i) {
  const p = pdfs[i];
  const el = document.createElement('div'); el.className = 'pdf-row'; el.dataset.i = i;
  el.innerHTML = `<div class="pdf-ico">PDF</div>
    <div class="pdf-info"><div class="pdf-name">${p.name}</div><div class="pdf-size">${(p.size/1024).toFixed(0)} KB</div></div>
    <button class="pdf-del" onclick="delPdf(${i});event.stopPropagation()">✕</button>`;
  document.getElementById('pdf-list').appendChild(el);
}
function delPdf(i) {
  pdfs.splice(i, 1);
  document.getElementById('pdf-list').innerHTML = '';
  pdfs.forEach((_,j) => addPdfRow(j));
  syncUpload();
}
function releaseSlides() {
  slides.forEach(sl => {
    releaseCanvas(sl.c);
    releaseCanvas(sl.edited);
  });
  slides = [];
}
function clearAll() { pdfs = []; releaseSlides(); document.getElementById('pdf-list').innerHTML = ''; syncUpload(); }
function procAnother() {
  // Clear all loaded files and slides so a fresh file gets processed
  pdfs = [];
  releaseSlides();
  processedPdfBlob = null;
  processedPdfName = '';
  document.getElementById('pdf-list').innerHTML = '';
  document.getElementById('pv-scroll').innerHTML = '';
  document.getElementById('pv-badge').textContent = '0 pages';
  document.getElementById('sg').innerHTML = '';
  syncUpload();
  goStep(1);
}
function syncUpload() {
  const has = pdfs.length > 0;
  uploadBox.classList.toggle('has-files', has);
  dzInner.style.display = has ? 'none' : 'block';
  filesBlock.style.display = has ? 'block' : 'none';
  document.getElementById('fl-count').textContent = pdfs.length;
}

// ── LOAD SLIDES ──
async function loadSlides() {
  releaseSlides();
  const sg = document.getElementById('sg');
  sg.innerHTML = '<div style="grid-column:1/-1;padding:3rem;text-align:center;color:var(--text3);display:flex;align-items:center;justify-content:center;gap:.75rem"><div class="spinner"></div><span>Loading slides…</span></div>';
  for (const p of pdfs) {
    const buf = await p.file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({data: buf}).promise;
    for (let pg = 1; pg <= pdf.numPages; pg++) {
      const page = await pdf.getPage(pg);
      const vp = clampPdfViewport(page);
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({canvasContext: c.getContext('2d', {alpha:false}), viewport: vp}).promise;
      slides.push({ c, edited: null, pdfName: p.name, pg, selected: true, removed: false, inverted: false });
      if (page.cleanup) page.cleanup();
      if (pg % 3 === 0) await wait(0);
    }
    if (pdf.cleanup) pdf.cleanup();
    if (pdf.destroy) pdf.destroy();
  }
  renderGrid();
  syncBB();
  document.getElementById('bbar').classList.add('up');
}

// ── GRID ──
function renderGrid() {
  const sg = document.getElementById('sg'); sg.innerHTML = '';
  if (!slides.length) { sg.innerHTML = '<div style="grid-column:1/-1;padding:3rem;text-align:center;color:var(--text3)">No slides.</div>'; return; }
  slides.forEach((sl, i) => {
    const card = document.createElement('div');
    card.className = 'sc' + (sl.selected ? ' selected' : '') + (sl.removed ? ' removed' : '');
    card.dataset.i = i;

    // canvas thumb
    const src = sl.edited || sl.c;
    const thumb = makeScaledCanvas(src, THUMB_MAX_SIDE, 'sc-canvas');
    const tctx = thumb.getContext('2d', {alpha:false});
    if (sl.inverted && !sl.edited) {
      tctx.globalCompositeOperation = 'difference'; tctx.fillStyle = 'white';
      tctx.fillRect(0,0,thumb.width,thumb.height); tctx.globalCompositeOperation = 'source-over';
    }

    // removed veil
    const rv = document.createElement('div'); rv.className = 'sc-removed-veil';
    rv.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.72)" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span>RESTORE</span>`;
    rv.onclick = e => { e.stopPropagation(); restoreSlide(i); };

    // checkbox
    const chk = document.createElement('div'); chk.className = 'sc-chk';
    chk.innerHTML = `<svg class="sc-chk-mark" width="9" height="7" viewBox="0 0 9 7" fill="none"><polyline points="1,3.5 3.5,6 8,1" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    chk.onclick = e => { e.stopPropagation(); toggleSel(i); };

    // hover overlay — edit icon bottom-right
    const hov = document.createElement('div'); hov.className = 'sc-hover';
    if (!sl.removed) {
      const eb = document.createElement('div'); eb.className = 'sc-edit-btn';
      eb.title = 'Edit slide';
      eb.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
      eb.onclick = e => { e.stopPropagation(); openEditor(i); };
      hov.appendChild(eb);
    }

    // page number
    const num = document.createElement('div'); num.className = 'sc-num'; num.textContent = sl.pg;

    // Click active slides to include/exclude them; click removed slides to restore.
    card.onclick = () => { sl.removed ? restoreSlide(i) : toggleSel(i); };

    card.appendChild(thumb); card.appendChild(rv); card.appendChild(chk);
    card.appendChild(hov); card.appendChild(num);
    sg.appendChild(card);
  });
}

function syncCardState(i) {
  const card = document.querySelector(`.sc[data-i="${i}"]`);
  if (!card) return;
  card.classList.toggle('selected', slides[i].selected);
  card.classList.toggle('removed', slides[i].removed);
}
function removeSlide(i) {
  slides[i].removed = true;
  slides[i].selected = false;
  syncCardState(i);
  syncBB();
}
function restoreSlide(i) {
  slides[i].removed = false;
  slides[i].selected = true;
  syncCardState(i);
  syncBB();
}
function toggleSel(i) {
  if (slides[i].removed) return;
  slides[i].selected = !slides[i].selected;
  syncCardState(i);
  syncBB();
}
function selAll() { slides.forEach(s => { if (!s.removed) s.selected = true; }); renderGrid(); syncBB(); }
function deselAll() { slides.forEach(s => s.selected = false); renderGrid(); syncBB(); }
function syncBB() {
  document.getElementById('bb-sel').textContent = slides.filter(s=>s.selected).length;
  document.getElementById('bb-rem').textContent = slides.filter(s=>s.removed).length;
}

// ── STEP 3 ──
function syncS3() {
  const active = slides.filter(s => !s.removed);
  document.getElementById('s3-name').textContent = pdfs.map(p=>p.name).join(', ').substring(0,55) || '—';
  document.getElementById('s3-pages').textContent = active.length;
  document.getElementById('s3-removed').textContent = slides.filter(s=>s.removed).length;
  updateLP();
}
function togRow(rowEl, rowId) {
  const tog = rowEl.querySelector('.toggle');
  if (!tog) return;
  tog.classList.toggle('on');
  rowEl.classList.toggle('on', tog.classList.contains('on'));
}
function togToggle(tog, rowId) {
  tog.classList.toggle('on');
  const row = document.getElementById(rowId);
  if (row) row.classList.toggle('on', tog.classList.contains('on'));
}
function setRadioGroup(groupId, el) {
  document.querySelectorAll('#'+groupId+' .radio-row').forEach(r => r.classList.remove('on'));
  el.classList.add('on');
  if (groupId === 'docsize-group') syncDocSizeControls();
  if (groupId === 'ori-group') updateLP();
}
function currentDocSize() {
  return document.querySelector('#docsize-group .radio-row.on span')?.textContent || 'Original';
}
function syncDocSizeControls() {
  const isOriginal = currentDocSize() === 'Original';
  const rows = document.getElementById('spp-r');
  const cols = document.getElementById('spp-c');
  const orientation = document.getElementById('ori-group');
  const spp = document.querySelector('.spp');
  if (isOriginal) {
    rows.value = '1';
    cols.value = '1';
  } else if (rows.value === '1' && cols.value === '1') {
    rows.value = '3';
    cols.value = '1';
  }
  rows.disabled = isOriginal;
  cols.disabled = isOriginal;
  orientation.classList.toggle('locked', isOriginal);
  spp.classList.toggle('locked', isOriginal);
  updateLP();
}
function updateLP() {
  const r = +document.getElementById('spp-r').value || 1;
  const c = +document.getElementById('spp-c').value || 1;
  const grid = document.getElementById('lp-mini');
  const isLandscape = document.querySelector('#ori-group .radio-row.on span')?.textContent === 'Landscape';
  grid.classList.toggle('landscape', isLandscape);
  grid.style.gridTemplateColumns = 'repeat('+c+',1fr)';
  grid.style.gridTemplateRows = 'repeat('+r+',1fr)';
  grid.innerHTML = '';
  for (let i = 0; i < r*c; i++) {
    const cell = document.createElement('div');
    cell.className = 'lp-cell';
    cell.style.animationDelay = (i * 28) + 'ms';
    grid.appendChild(cell);
  }
  document.getElementById('lp-num').textContent = r*c;
  document.getElementById('lp-desc').innerHTML = r+'&times;'+c+'<br>per page';
}

// ── LOGO REMOVER ──
function togLogoRow() {
  const tog = document.getElementById('tog-logo');
  const row = document.getElementById('lr-tog');
  tog.classList.toggle('on');
  row.classList.toggle('on', tog.classList.contains('on'));
  if (tog.classList.contains('on') && !logoRegions.some(r => r.enabled)) logoRegions[0].enabled = true;
  if (tog.classList.contains('on')) openLogoModal();
}
function openLogoModal() {
  // populate page selector
  const sel = document.getElementById('logo-pg-sel'); sel.innerHTML = '';
  slides.filter(s=>!s.removed).forEach((sl,i) => {
    const opt = document.createElement('option'); opt.value = i;
    opt.textContent = `Page ${i+1} of ${slides.filter(s=>!s.removed).length}`;
    sel.appendChild(opt);
  });
  document.getElementById('lmodal').classList.add('open');
  lockPageScroll();
  selectLogoRegion(activeLogoIdx);
  renderLogoPreview();
  setTimeout(() => window._logoRegionDragInit && window._logoRegionDragInit(), 100);
}
function closeLogoModal() {
  const m = document.getElementById('lmodal');
  if (!m || !m.classList.contains('open')) return;
  m.classList.remove('open');
  unlockPageScroll();
}
function activeLogo() { return logoRegions[activeLogoIdx]; }
function anyLogoEnabled() { return logoRegions.some(r => r.enabled); }
function syncLogoControls() {
  const r = activeLogo();
  // Update logo tab cards (Logo 1 / Logo 2)
  document.querySelectorAll('#lmodal .lm-tab').forEach((b,i) => {
    b.classList.toggle('on', i === activeLogoIdx);
    const dot = b.querySelector('.lm-tab-dot');
    const isEnabled = logoRegions[i].enabled;
    b.style.opacity = isEnabled ? '1' : '.55';
    b.title = isEnabled ? '' : 'Disabled';
  });
  // Update enable/disable button
  const en = document.getElementById('logo-enable-btn');
  if (en) {
    en.classList.toggle('on', r.enabled);
    const txt = en.querySelector('.lm-enable-txt');
    if (txt) txt.textContent = r.enabled ? 'Enabled' : 'Disabled';
  }
  document.getElementById('logo-w').value = r.w;
  document.getElementById('logo-h').value = r.h;
  document.getElementById('lw-val').textContent = r.w+'%';
  document.getElementById('lh-val').textContent = r.h+'%';
  document.querySelectorAll('#shape-group .shape-opt').forEach(o => {
    const label = o.textContent.trim().toLowerCase();
    const on = (r.shape === 'rect' && label === 'rectangle') || (r.shape === 'circ' && label === 'circle');
    o.classList.toggle('on', on);
    const dot = o.querySelector('.sdot-i'); if (dot) dot.style.display = on ? 'block' : 'none';
  });
  document.querySelectorAll('#corner-group .lm-corner').forEach(o => o.classList.remove('on'));
  if (!r.useCustom) {
    const idx = { 'top-right':1, 'top-left':0, 'bot-right':3, 'bot-left':2 }[r.corner || 'top-left'];
    const opts = document.querySelectorAll('#corner-group .lm-corner');
    if (opts[idx]) opts[idx].classList.add('on');
  }
  updateLogoRegion();
}
function selectLogoRegion(i) {
  activeLogoIdx = Math.max(0, Math.min(1, i));
  syncLogoControls();
}
function toggleActiveLogoEnabled() {
  const r = activeLogo();
  r.enabled = !r.enabled;
  if (!anyLogoEnabled()) r.enabled = true;
  syncLogoControls();
}
function renderLogoPreview() {
  const idx = +document.getElementById('logo-pg-sel').value || 0;
  const activeSl = slides.filter(s=>!s.removed);
  const wrap = document.getElementById('lm-wrap');
  // Clear/hide placeholder
  const placeholder = wrap && wrap.querySelector('.lm-preview-no-slides');
  if (!activeSl.length) {
    const lmc = document.getElementById('lm-canvas');
    lmc.width = 1; lmc.height = 1;
    if (wrap && !placeholder) {
      const ph = document.createElement('div'); ph.className = 'lm-preview-no-slides';
      ph.innerHTML = '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></svg><span>Load a PDF first</span>';
      wrap.appendChild(ph);
    }
    return;
  }
  if (placeholder) placeholder.remove();
  const sl = activeSl[idx];
  const src = sl.edited || sl.c;
  const lmc = document.getElementById('lm-canvas');
  lmc.width = src.width; lmc.height = src.height;
  layoutLogoPreview();
  const lctx = lmc.getContext('2d', {alpha: false});
  lctx.fillStyle = '#fff';
  lctx.fillRect(0, 0, lmc.width, lmc.height);
  lctx.drawImage(src, 0, 0);
  // If this slide has been individually inverted (but not yet through the editor),
  // show it inverted so placement matches what the user sees in the slide grid
  if (sl.inverted && !sl.edited) {
    lctx.globalCompositeOperation = 'difference';
    lctx.fillStyle = 'white';
    lctx.fillRect(0, 0, lmc.width, lmc.height);
    lctx.globalCompositeOperation = 'source-over';
  }
  updateLogoRegion();
}
function layoutLogoPreview() {
  const wrap = document.getElementById('lm-wrap');
  const stage = document.getElementById('lm-stage');
  const lmc = document.getElementById('lm-canvas');
  if (!wrap || !stage || !lmc || !lmc.width || !lmc.height) return;
  stage.style.setProperty('--lm-aspect', `${lmc.width} / ${lmc.height}`);
  if (!window.matchMedia('(max-width: 768px)').matches) {
    stage.style.width = '';
    stage.style.height = '';
    return;
  }
  const padX = 0;
  const maxW = Math.max(1, wrap.clientWidth - padX);
  const maxH = Math.max(1, wrap.clientHeight);
  const scale = Math.max(.01, Math.min(maxW / lmc.width, maxH / lmc.height));
  stage.style.width = Math.max(1, Math.round(lmc.width * scale)) + 'px';
  stage.style.height = Math.max(1, Math.round(lmc.height * scale)) + 'px';
}
window.addEventListener('resize', () => {
  if (document.getElementById('lmodal')?.classList.contains('open')) {
    layoutLogoPreview();
    updateLogoRegion();
  }
});
function nudgeSlider(sliderId, valId, delta) {
  const sl = document.getElementById(sliderId);
  if (!sl) return;
  const nv = Math.max(+sl.min, Math.min(+sl.max, +sl.value + delta));
  sl.value = nv;
  updateLogoRegion();
}
function updateLogoRegion() {
  const wSl = document.getElementById('logo-w');
  const hSl = document.getElementById('logo-h');
  let wPct = +wSl.value;
  let hPct = +hSl.value;
  if (!Number.isFinite(wPct)) wPct = 15;
  if (!Number.isFinite(hPct)) hPct = 15;
  wPct = Math.max(1, Math.min(50, wPct));
  hPct = Math.max(1, Math.min(50, hPct));
  document.getElementById('lw-val').textContent = wPct+'%';
  document.getElementById('lh-val').textContent = hPct+'%';
  const setRangeFill = (el, val) => {
    const min = Number(el.min || 0), max = Number(el.max || 100);
    const pct = Math.max(0, Math.min(100, (val - min) / Math.max(1, max - min) * 100));
    el.style.setProperty('--fill', pct + '%');
  };
  setRangeFill(wSl, wPct);
  setRangeFill(hSl, hPct);
  const ar = activeLogo(); ar.w = wPct; ar.h = hPct;
  logoRegions.forEach((r, idx) => {
    const reg = document.getElementById('lm-region-'+idx);
    if (!reg) return;
    reg.classList.toggle('selected', idx === activeLogoIdx);
    reg.classList.toggle('off', !r.enabled);
    const w = r.w, h = r.h;
    if (r.useCustom) {
      const nx = Math.max(0, Math.min(100-w, Number.isFinite(+r.customX) ? +r.customX : 0));
      const ny = Math.max(0, Math.min(100-h, Number.isFinite(+r.customY) ? +r.customY : 0));
      reg.style.cssText = `top:${ny}%;left:${nx}%;right:auto;bottom:auto;width:${w}%;height:${h}%`;
      return;
    }
    const corner = r.corner || 'top-right';
    const posMap = {
      'top-right':  `top:0;right:0;left:auto;bottom:auto;width:${w}%;height:${h}%`,
      'top-left':   `top:0;left:0;right:auto;bottom:auto;width:${w}%;height:${h}%`,
      'bot-right':  `bottom:0;right:0;left:auto;top:auto;width:${w}%;height:${h}%`,
      'bot-left':   `bottom:0;left:0;right:auto;top:auto;width:${w}%;height:${h}%`,
    };
    reg.style.cssText = posMap[corner];
  });
}
function setLogoCorner(c, el) {
  const r = activeLogo();
  r.corner = c;
  r.useCustom = false;
  document.querySelectorAll('#corner-group .lm-corner').forEach(o => o.classList.remove('on'));
  el.classList.add('on');
  updateLogoRegion();
}

// ── DRAGGABLE LOGO REGION ──
(function() {
  let dragging = false, activePointerId = null;
  let startMX=0, startMY=0, startRX=0, startRY=0;
  let moved = false;
  function initLogoRegionDrag() {
    document.querySelectorAll('.lm-region').forEach(reg => {
      if (reg.dataset.dragInit) return;
      reg.dataset.dragInit = '1';
      reg.addEventListener('click', e => {
        if (reg.dataset.justDragged === '1') {
          reg.dataset.justDragged = '0';
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }, true);
      if (window.PointerEvent) {
        reg.addEventListener('pointerdown', e => startDrag(e, +reg.dataset.logo), {passive:false});
      } else {
        reg.addEventListener('mousedown', e => startDrag(e, +reg.dataset.logo));
        reg.addEventListener('touchstart', e => startDrag(e.touches[0], +reg.dataset.logo), {passive:false});
      }
    });
  }
  function startDrag(e, idx) {
    if (e.button != null && e.button !== 0) return;
    const reg = document.getElementById('lm-region-'+idx);
    const stage = document.getElementById('lm-stage');
    if (!reg || !stage) return;
    const wRect = stage.getBoundingClientRect();
    const rRect = reg.getBoundingClientRect();
    if (!wRect.width || !wRect.height) return;
    moved = false;
    dragging = true;
    activePointerId = e.pointerId != null ? e.pointerId : null;
    selectLogoRegion(idx);
    startMX = e.clientX; startMY = e.clientY;
    // current % position of the region top-left relative to the rendered slide
    startRX = (rRect.left - wRect.left) / wRect.width * 100;
    startRY = (rRect.top  - wRect.top)  / wRect.height * 100;
    reg.style.transition = 'none';
    e.preventDefault && e.preventDefault();
    try { if (activePointerId != null && reg.setPointerCapture) reg.setPointerCapture(activePointerId); } catch {}

    function onMove(ev) {
      if (!dragging) return;
      if (activePointerId != null && ev.pointerId != null && ev.pointerId !== activePointerId) return;
      const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const stage2 = document.getElementById('lm-stage');
      if (!stage2) return onUp();
      const wRect2 = stage2.getBoundingClientRect();
      if (!wRect2.width || !wRect2.height) return onUp();
      if (!moved && (Math.abs(cx - startMX) > 2 || Math.abs(cy - startMY) > 2)) moved = true;
      const dxPct = (cx - startMX) / wRect2.width * 100;
      const dyPct = (cy - startMY) / wRect2.height * 100;
      let nx = startRX + dxPct;
      let ny = startRY + dyPct;
      const r = logoRegions[idx];
      const wPct = Math.max(1, Math.min(50, +r.w || 15));
      const hPct = Math.max(1, Math.min(50, +r.h || 15));
      nx = Math.max(0, Math.min(100-wPct, nx));
      ny = Math.max(0, Math.min(100-hPct, ny));
      // Store as custom position
      r.customX = nx;
      r.customY = ny;
      r.useCustom = true;
      // Update corner buttons to show none active
      document.querySelectorAll('#corner-group .lm-corner').forEach(o=>o.classList.remove('on'));
      const reg2 = document.getElementById('lm-region-'+idx);
      reg2.style.cssText = `top:${ny}%;left:${nx}%;right:auto;bottom:auto;width:${wPct}%;height:${hPct}%`;
    }
    function onUp() {
      dragging = false;
      if (moved) {
        reg.dataset.justDragged = '1';
        setTimeout(() => { reg.dataset.justDragged = '0'; }, 0);
      }
      activePointerId = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }
    if (window.PointerEvent) {
      window.addEventListener('pointermove', onMove, {passive:false});
      window.addEventListener('pointerup', onUp, {passive:false});
      window.addEventListener('pointercancel', onUp, {passive:false});
    } else {
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, {passive:false});
      window.addEventListener('touchend', onUp);
    }
  }
  window._logoRegionDragInit = initLogoRegionDrag;
  initLogoRegionDrag();
})();
function setLogoShape(s, el) {
  activeLogo().shape = s;
  document.querySelectorAll('#shape-group .shape-opt').forEach(o => {
    o.classList.remove('on');
    const dot = o.querySelector('.sdot-i'); if (dot) dot.style.display='none';
  });
  el.classList.add('on'); el.querySelector('.sdot-i').style.display='block';
  updateLogoRegion();
}
function autoDetectLogos() {
  const activeSl = slides.filter(s=>!s.removed);
  if (!activeSl.length) { showToast('Load slides first'); return; }
  const candidates = [
    {corner:'top-left', x0:0, y0:0, x1:.34, y1:.28, bias:.12}
  ];
  function median(vals) {
    if (!vals.length) return 0;
    vals.sort((a,b)=>a-b);
    return vals[Math.floor(vals.length/2)];
  }
  function estimateBg(img, W, H) {
    const rs=[], gs=[], bs=[], ls=[], ss=[];
    const step = Math.max(2, Math.floor(Math.min(W,H) / 120));
    function add(x,y) {
      const i=(y*W+x)*4;
      rs.push(img[i]); gs.push(img[i+1]); bs.push(img[i+2]);
      ls.push(lumAt(img,i)); ss.push(satAt(img,i));
    }
    for (let x=0; x<W; x+=step) { add(x,0); add(x,H-1); }
    for (let y=0; y<H; y+=step) { add(0,y); add(W-1,y); }
    return { r:median(rs), g:median(gs), b:median(bs), l:median(ls), s:median(ss) };
  }
  function detectCorner(img, W, H, c) {
    const bg = estimateBg(img, W, H);
    const x0=Math.floor(W*c.x0), y0=Math.floor(H*c.y0), x1=Math.min(W,Math.ceil(W*c.x1)), y1=Math.min(H,Math.ceil(H*c.y1));
    let minX=x1, minY=y1, maxX=x0, maxY=y0, fg=0, edge=0, n=0, prev=-1;
    const step = Math.max(1, Math.floor(Math.min(W,H) / 600));
    for (let y=y0; y<y1; y+=step) {
      for (let x=x0; x<x1; x+=step) {
        const i=(y*W+x)*4;
        const l=lumAt(img,i), s=satAt(img,i);
        const dr=img[i]-bg.r, dg=img[i+1]-bg.g, db=img[i+2]-bg.b;
        const dist=Math.sqrt(dr*dr+dg*dg+db*db);
        const isLightBg = bg.l > 175;
        const isFg = dist > 42 || Math.abs(l-bg.l) > 32 || s > bg.s + 34 || (isLightBg ? l < 218 : l > bg.l + 42);
        if (isFg) {
          minX=Math.min(minX,x); maxX=Math.max(maxX,x);
          minY=Math.min(minY,y); maxY=Math.max(maxY,y);
          fg++;
        }
        if (prev >= 0 && Math.abs(l-prev) > 18) edge++;
        prev = l; n++;
      }
    }
    if (fg < 20 || !n) return null;
    const bw=maxX-minX+1, bh=maxY-minY+1;
    const zoneArea=(x1-x0)*(y1-y0);
    const boxArea=bw*bh;
    if (boxArea > zoneArea*.8 || bw < W*.008 || bh < H*.008) return null;
    const touchesCornerX = c.corner.includes('right') ? maxX > W*.86 : minX < W*.14;
    const touchesCornerY = c.corner.includes('bot') ? maxY > H*.86 : minY < H*.14;
    const density = fg / Math.max(1, boxArea/(step*step));
    const score = (fg/n)*.55 + (edge/n)*.25 + density*.12 + (touchesCornerX || touchesCornerY ? .08 : 0) + (c.bias || 0);
    const padX=Math.max(W*.015, bw*.28), padY=Math.max(H*.015, bh*.28);
    minX=Math.max(0,minX-padX); minY=Math.max(0,minY-padY);
    maxX=Math.min(W,maxX+padX); maxY=Math.min(H,maxY+padY);
    return { corner:c.corner, score, x:minX/W*100, y:minY/H*100, w:(maxX-minX)/W*100, h:(maxY-minY)/H*100 };
  }
  const sampleOrder = activeSl.map((_, i) => i).sort((a,b) => {
    if (a === 1) return -1;
    if (b === 1) return 1;
    if (a === 0) return 1;
    if (b === 0) return -1;
    return a-b;
  }).slice(0, Math.min(5, activeSl.length));
  const sampleCount = sampleOrder.length || 1;
  const found = new Map(candidates.map(c => [c.corner, []]));
  for (const slideIdx of sampleOrder) {
    const src = activeSl[slideIdx].edited || activeSl[slideIdx].c;
    const W = src.width, H = src.height;
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    const tctx = tmp.getContext('2d'); tctx.drawImage(src,0,0);
    const img = tctx.getImageData(0,0,W,H).data;
    for (const c of candidates) {
      const hit = detectCorner(img, W, H, c);
      if (hit) {
        hit.score *= slideIdx === 1 ? 1.75 : (slideIdx === 0 ? .45 : 1);
        found.get(c.corner).push(hit);
      }
    }
  }
  const ranked = candidates.map(c => {
    const hits = found.get(c.corner) || [];
    if (!hits.length) return { corner:c.corner, score:0, x:0, y:0, w:15, h:15 };
    const avg = key => hits.reduce((a,b)=>a+b[key],0) / hits.length;
    const best = hits.reduce((a,b)=>a.score>b.score?a:b);
    return {
      corner:c.corner,
      score: avg('score') * (hits.length / sampleCount),
      x: best.x,
      y: best.y,
      w: Math.max(10, Math.min(26, best.w)),
      h: Math.max(10, Math.min(26, best.h))
    };
  }).sort((a,b)=>b.score-a.score);
  const primary = ranked[0] || { corner:'top-left', score:0, x:0, y:0, w:15, h:15 };
  [primary].forEach((c,i) => {
    const fallback = c.score <= 0;
    const size = 18;
    const regionW = fallback ? size : c.w;
    const regionH = fallback ? size : c.h;
    const cornerDefaults = {
      'top-right': {x:100-size,y:0},
      'top-left': {x:0,y:0},
      'bot-right': {x:100-size,y:100-size},
      'bot-left': {x:0,y:100-size}
    }[c.corner];
    logoRegions[i] = {
      w: regionW,
      h: regionH,
      shape: 'rect',
      corner: c.corner,
      enabled: i === 0 || c.score > .035,
      useCustom: true,
      customX: fallback ? cornerDefaults.x : Math.max(0, Math.min(100-regionW, c.x)),
      customY: fallback ? cornerDefaults.y : Math.max(0, Math.min(100-regionH, c.y))
    };
  });
  logoRegions[1] = { ...logoRegions[1], enabled: false };
  activeLogoIdx = 0;
  syncLogoControls();
  renderLogoPreview();
  showToast('Logo region auto-detected');
}
function applyLogoSelection() {
  if (!anyLogoEnabled()) logoRegions[activeLogoIdx].enabled = true;
  const tog = document.getElementById('tog-logo');
  const row = document.getElementById('lr-tog');
  tog.classList.add('on');
  row.classList.add('on');
  closeLogoModal();
  showToast('Logo regions saved — will be blended out on all pages');
}

// ── EDITOR ──
const ecanvas = document.getElementById('ecanvas');
const ec = ecanvas.getContext('2d');

function openEditor(i) {
  editIdx = i; const sl = slides[i];
  document.getElementById('em-ttl').textContent = 'Edit Page ' + sl.pg;
  const src = sl.edited || sl.c;
  ecanvas.width = src.width; ecanvas.height = src.height;
  ec.drawImage(src, 0,0);
  if (sl.inverted && !sl.edited) {
    ec.globalCompositeOperation = 'difference'; ec.fillStyle = 'white';
    ec.fillRect(0,0,ecanvas.width,ecanvas.height); ec.globalCompositeOperation = 'source-over';
  }
  edHist = [ec.getImageData(0,0,ecanvas.width,ecanvas.height)]; edFut = [];
  selS = null; selE = null; clearSV(); updHB();
  document.getElementById('emodal').classList.add('open');
  lockPageScroll();
  setupEv();
}
function saveEditor() {
  const ed = document.createElement('canvas'); ed.width = ecanvas.width; ed.height = ecanvas.height;
  ed.getContext('2d').drawImage(ecanvas, 0,0);
  slides[editIdx].edited = ed; slides[editIdx].inverted = false;
  renderGrid();
  document.getElementById('emodal').classList.remove('open');
  unlockPageScroll();
  clearSV();
  editIdx = null; rmEv();
}
function closeEditor() {
  document.getElementById('emodal').classList.remove('open');
  unlockPageScroll();
  clearSV();
  editIdx = null;
  rmEv();
}
function setupEv() {
  rmEv();
  if (window.PointerEvent) {
    ecanvas.addEventListener('pointerdown', onED, {passive:false});
    ecanvas.addEventListener('pointermove', onEM, {passive:false});
    ecanvas.addEventListener('pointerup', onEU, {passive:false});
    ecanvas.addEventListener('pointercancel', onEU, {passive:false});
    ecanvas.style.touchAction = 'none';
  } else {
    ecanvas.addEventListener('mousedown', onED);
    ecanvas.addEventListener('mousemove', onEM);
    ecanvas.addEventListener('mouseup', onEU);
  }
}
function rmEv() {
  ecanvas.removeEventListener('pointerdown', onED);
  ecanvas.removeEventListener('pointermove', onEM);
  ecanvas.removeEventListener('pointerup', onEU);
  ecanvas.removeEventListener('pointercancel', onEU);
  ecanvas.removeEventListener('mousedown', onED);
  ecanvas.removeEventListener('mousemove', onEM);
  ecanvas.removeEventListener('mouseup', onEU);
}
function cpos(e) {
  const r = ecanvas.getBoundingClientRect();
  const cx = e.touches ? e.touches[0].clientX : e.clientX;
  const cy = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: (cx-r.left)*(ecanvas.width/r.width), y: (cy-r.top)*(ecanvas.height/r.height) };
}
function onED(e) {
  if (e.button != null && e.button !== 0) return;
  drawing = true;
  try { if (e.pointerId != null && ecanvas.setPointerCapture) ecanvas.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault && e.preventDefault();
  selS = cpos(e); selE = cpos(e);
  clearSV();
  updSV();
}
function onEM(e) { if (!drawing) return; selE = cpos(e); updSV(); }
function onEU(e) {
  if (!drawing) return;
  drawing = false;
  selE = cpos(e);
  if (Math.abs(selE.x-selS.x)<3 || Math.abs(selE.y-selS.y)<3) { clearSV(); selS=null; selE=null; return; }
  updSV();
  showSelActions();
}

function applySelectionAction() {
  applyAction();
  clearSV();
  selS = null; selE = null;
}
function cancelSelectionAction() {
  clearSV();
  selS = null; selE = null;
}

function applyAction() {
  if (!selS || !selE) return;
  const x = Math.round(Math.min(selS.x,selE.x)), y = Math.round(Math.min(selS.y,selE.y));
  const w = Math.round(Math.abs(selE.x-selS.x)), h = Math.round(Math.abs(selE.y-selS.y));
  if (w<3||h<3) return;
  saveH();
  if (eAct === 'invert') {
    const img = ec.getImageData(x,y,w,h);
    for (let i = 0; i < img.data.length; i+=4) { img.data[i]=255-img.data[i]; img.data[i+1]=255-img.data[i+1]; img.data[i+2]=255-img.data[i+2]; }
    ec.putImageData(img, x, y);
  } else if (eAct === 'paint') {
    ec.fillStyle = '#000';
    if (selTool==='circ') { ec.beginPath(); ec.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2); ec.fill(); }
    else ec.fillRect(x,y,w,h);
  } else if (eAct === 'white') {
    ec.fillStyle = '#fff';
    if (selTool==='circ') { ec.beginPath(); ec.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2); ec.fill(); }
    else ec.fillRect(x,y,w,h);
  } else if (eAct === 'erase') {
    ec.clearRect(x,y,w,h);
  }
  updHB();
}
function updSV() {
  const ecw = document.getElementById('ecw');
  let sv = ecw.querySelector('.sel-veil');
  if (!sv) { sv = document.createElement('div'); sv.className = 'sel-veil'; ecw.appendChild(sv); }
  const r = ecanvas.getBoundingClientRect(), pr = ecw.getBoundingClientRect();
  const sx = r.width/ecanvas.width, sy = r.height/ecanvas.height;
  const x1 = Math.min(selS.x,selE.x)*sx+(r.left-pr.left)+ecw.scrollLeft;
  const y1 = Math.min(selS.y,selE.y)*sy+(r.top-pr.top)+ecw.scrollTop;
  const bw = Math.abs(selE.x-selS.x)*sx, bh = Math.abs(selE.y-selS.y)*sy;
  sv.style.cssText = `left:${x1}px;top:${y1}px;width:${bw}px;height:${bh}px;border-radius:${selTool==='circ'?'50%':'3px'}`;
}
function showSelActions() {
  const ecw = document.getElementById('ecw');
  let bar = ecw.querySelector('.sel-actions');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'sel-actions';
    bar.innerHTML = '<button class="sel-apply" onclick="applySelectionAction()">Apply</button><button class="sel-cancel" onclick="cancelSelectionAction()">Cancel</button>';
    ecw.appendChild(bar);
  }
  const r = ecanvas.getBoundingClientRect(), pr = ecw.getBoundingClientRect();
  const sx = r.width/ecanvas.width, sy = r.height/ecanvas.height;
  const x1 = Math.min(selS.x,selE.x)*sx+(r.left-pr.left)+ecw.scrollLeft;
  const y1 = Math.min(selS.y,selE.y)*sy+(r.top-pr.top)+ecw.scrollTop;
  const bw = Math.abs(selE.x-selS.x)*sx, bh = Math.abs(selE.y-selS.y)*sy;
  const barW = 126, barH = 34;
  let left = x1 + bw/2 - barW/2;
  let top = y1 + bh + 8;
  left = Math.max(ecw.scrollLeft + 8, Math.min(left, ecw.scrollLeft + ecw.clientWidth - barW - 8));
  if (top + barH > ecw.scrollTop + ecw.clientHeight - 8) top = Math.max(ecw.scrollTop + 8, y1 - barH - 8);
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
}
function clearSV() {
  const ecw = document.getElementById('ecw');
  const v = ecw.querySelector('.sel-veil'); if (v) v.remove();
  const a = ecw.querySelector('.sel-actions'); if (a) a.remove();
}
function saveH() { edFut=[]; edHist.push(ec.getImageData(0,0,ecanvas.width,ecanvas.height)); if(edHist.length>10)edHist.shift(); updHB(); }
function eUndo() { if(edHist.length<2)return; edFut.push(edHist.pop()); ec.putImageData(edHist[edHist.length-1],0,0); updHB(); }
function eRedo() { if(!edFut.length)return; const s=edFut.pop(); edHist.push(s); ec.putImageData(s,0,0); updHB(); }
function updHB() { document.getElementById('undo-btn').disabled=edHist.length<2; document.getElementById('redo-btn').disabled=!edFut.length; }
function setSelTool(t,el) { selTool=t; document.querySelectorAll('.sel-opt').forEach(o=>o.classList.remove('on')); el.classList.add('on'); updStatus(); }
function setEAct(a,el) { eAct=a; document.querySelectorAll('.ea-opt').forEach(o=>o.classList.remove('on')); el.classList.add('on'); updStatus(); }
function updStatus() {
  const tN = selTool==='rect'?'Rectangle':'Circle';
  const aN = {invert:'Invert Colors',paint:'Paint Black',white:'Paint White',erase:'Erase'}[eAct];
  document.getElementById('em-status').textContent = tN+' · '+aN;
}

// ── FINAL CANVAS ──
function lumAt(d, i) {
  return 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
}
function satAt(d, i) {
  return Math.max(d[i],d[i+1],d[i+2]) - Math.min(d[i],d[i+1],d[i+2]);
}
function estimateLightBg(d, W, H) {
  const samples = [];
  const step = Math.max(1, Math.floor(Math.min(W,H) / 70));
  function add(px, py) {
    const i = (py*W + px) * 4;
    const l = lumAt(d, i);
    if (l > 145) samples.push({ r:d[i], g:d[i+1], b:d[i+2], l, s:satAt(d, i) });
  }
  for (let x=0; x<W; x+=step) { add(x,0); add(x,H-1); }
  for (let y=0; y<H; y+=step) { add(0,y); add(W-1,y); }
  if (samples.length < 8) return null;
  samples.sort((a,b) => b.l - a.l);
  const take = samples.slice(0, Math.max(8, Math.floor(samples.length * .55)));
  let r=0,g=0,b=0,l=0,s=0;
  take.forEach(p => { r+=p.r; g+=p.g; b+=p.b; l+=p.l; s+=p.s; });
  const n = take.length;
  return { r:r/n, g:g/n, b:b/n, l:l/n, s:s/n };
}
function cleanLightBackground(d, W, H, preserveMask) {
  const bg = estimateLightBg(d, W, H);
  if (!bg || bg.l < 188) return;
  const distLimit = bg.s < 18 ? 28 : 36;
  function preserved(pi) {
    if (!preserveMask) return false;
    if (preserveMask.restore) return !!preserveMask.restore[pi];
    if (preserveMask.blocks && preserveMask.bs && preserveMask.bcols) {
      const x = pi % W, y = (pi / W) | 0;
      const bc = (x / preserveMask.bs) | 0;
      const br = (y / preserveMask.bs) | 0;
      const bi = br * preserveMask.bcols + bc;
      return !!preserveMask.blocks[bi];
    }
    return !!preserveMask[pi];
  }
  function nearContent(pi) {
    const x = pi % W, y = Math.floor(pi / W);
    for (let dy=-2; dy<=2; dy++) {
      const py = y + dy;
      if (py < 0 || py >= H) continue;
      for (let dx=-2; dx<=2; dx++) {
        const px = x + dx;
        if (px < 0 || px >= W) continue;
        const ni = (py*W + px) * 4;
        if (lumAt(d, ni) < 170 || satAt(d, ni) > 70) return true;
      }
    }
    return false;
  }
  for (let i=0; i<d.length; i+=4) {
    const pi = i / 4;
    if (preserved(pi)) continue;
    const l = lumAt(d, i);
    if (l < 196) continue;
    const dr=d[i]-bg.r, dg=d[i+1]-bg.g, db=d[i+2]-bg.b;
    const dist = Math.sqrt(dr*dr + dg*dg + db*db);
    const sat = satAt(d, i);
    const paper = l > 246;
    const backgroundDust = dist < distLimit && sat < 34 && l > 224;
    const templateLine = dist < 54 && sat < 18 && l > 204 && !nearContent(pi);
    if (paper || backgroundDust || templateLine) {
      d[i]=255; d[i+1]=255; d[i+2]=255; d[i+3]=255;
    }
  }
}
function removeTemplateMarksFromGrayscale(d, W, H, preserveMask) {
  const total = W * H;
  const candidate = new Uint8Array(total);
  const seen = new Uint8Array(total);
  function preserved(pi) {
    if (!preserveMask) return false;
    if (preserveMask.restore) return !!preserveMask.restore[pi];
    if (preserveMask.blocks && preserveMask.bs && preserveMask.bcols) {
      const x = pi % W, y = (pi / W) | 0;
      const bc = (x / preserveMask.bs) | 0;
      const br = (y / preserveMask.bs) | 0;
      const bi = br * preserveMask.bcols + bc;
      return !!preserveMask.blocks[bi];
    }
    return !!preserveMask[pi];
  }
  function nearInk(pi) {
    const x = pi % W, y = Math.floor(pi / W);
    for (let dy=-3; dy<=3; dy++) {
      const py = y + dy;
      if (py < 0 || py >= H) continue;
      for (let dx=-3; dx<=3; dx++) {
        const px = x + dx;
        if (px < 0 || px >= W) continue;
        const ni = (py*W + px) * 4;
        if (d[ni] < 158) return true;
      }
    }
    return false;
  }

  for (let pi=0; pi<total; pi++) {
    if (preserved(pi)) continue;
    const i = pi * 4;
    const l = d[i];
    if (l > 176 && l < 246 && !nearInk(pi)) candidate[pi] = 1;
  }

  const q = [];
  for (let start=0; start<total; start++) {
    if (!candidate[start] || seen[start]) continue;
    q.length = 0; q.push(start); seen[start] = 1;
    let qi=0, minX=W, maxX=0, minY=H, maxY=0, sum=0;
    while (qi < q.length) {
      const pi = q[qi++], x = pi % W, y = Math.floor(pi / W), i = pi * 4;
      minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y);
      sum += d[i];
      const nbs = [pi-1, pi+1, pi-W, pi+W];
      for (const ni of nbs) {
        if (ni < 0 || ni >= total || seen[ni] || !candidate[ni]) continue;
        const nx = ni % W;
        if ((ni === pi-1 && nx > x) || (ni === pi+1 && nx < x)) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const count = q.length;
    const bw = maxX-minX+1, bh = maxY-minY+1;
    const bbox = bw * bh;
    const density = count / bbox;
    const avg = sum / count;
    const thin = bw <= Math.max(8,W*.008) || bh <= Math.max(8,H*.008) || Math.max(bw,bh) / Math.max(1,Math.min(bw,bh)) > 7;
    const edge = minX < W*.04 || minY < H*.04 || maxX > W*.96 || maxY > H*.96;
    const sparse = density < .48;
    const smallFaint = count < total*.0012 && avg > 196;
    const shouldRemove = avg > 198 && (thin || sparse || edge || smallFaint);
    if (!shouldRemove) continue;
    for (const pi of q) {
      const i = pi * 4;
      d[i]=255; d[i+1]=255; d[i+2]=255; d[i+3]=255;
    }
  }
}
function applyNoteBW(d, W, H) {
  const total = W * H;
  const lum = new Uint8Array(total);
  const integral = new Uint32Array((W + 1) * (H + 1));
  const stride = W + 1;

  for (let y=0; y<H; y++) {
    let row = 0;
    for (let x=0; x<W; x++) {
      const pi = y*W + x;
      const i = pi * 4;
      const l = Math.max(0, Math.min(255, Math.round(lumAt(d, i))));
      lum[pi] = l;
      row += l;
      integral[(y+1)*stride + x + 1] = integral[y*stride + x + 1] + row;
    }
  }

  const radius = Math.max(14, Math.min(36, Math.round(Math.min(W,H) / 58)));
  const ink = new Uint8Array(total);
  function localAvg(x, y) {
    const x0 = Math.max(0, x - radius);
    const y0 = Math.max(0, y - radius);
    const x1 = Math.min(W - 1, x + radius);
    const y1 = Math.min(H - 1, y + radius);
    const a = y0*stride + x0;
    const b = y0*stride + x1 + 1;
    const c = (y1+1)*stride + x0;
    const e = (y1+1)*stride + x1 + 1;
    return (integral[e] - integral[b] - integral[c] + integral[a]) / ((x1-x0+1) * (y1-y0+1));
  }

  for (let y=0; y<H; y++) {
    for (let x=0; x<W; x++) {
      const pi = y*W + x;
      const l = lum[pi];
      const avg = localAvg(x, y);
      const contrast = avg - l;
      const strongInk = l < 116;
      const handwriting = avg > 172 && l < 226 && contrast > 15;
      const softPencil = avg > 145 && l < 205 && contrast > 24;
      ink[pi] = (strongInk || handwriting || softPencil) ? 1 : 0;
    }
  }

  const repaired = new Uint8Array(ink);
  function hasInk(x, y) {
    return x >= 0 && x < W && y >= 0 && y < H && ink[y*W + x];
  }
  for (let y=1; y<H-1; y++) {
    for (let x=1; x<W-1; x++) {
      const pi = y*W + x;
      if (ink[pi] || lum[pi] > 232) continue;
      let neighbors = 0;
      for (let dy=-1; dy<=1; dy++) {
        for (let dx=-1; dx<=1; dx++) {
          if (dx || dy) neighbors += hasInk(x+dx, y+dy) ? 1 : 0;
        }
      }
      const bridge =
        (hasInk(x-1,y) && hasInk(x+1,y)) ||
        (hasInk(x,y-1) && hasInk(x,y+1)) ||
        (hasInk(x-1,y-1) && hasInk(x+1,y+1)) ||
        (hasInk(x-1,y+1) && hasInk(x+1,y-1));
      if (bridge || (neighbors >= 4 && lum[pi] < 224)) repaired[pi] = 1;
    }
  }

  for (let pi=0; pi<total; pi++) {
    let keep = repaired[pi];
    if (keep && lum[pi] > 218) {
      const x = pi % W, y = (pi / W) | 0;
      let neighbors = 0;
      for (let dy=-1; dy<=1; dy++) {
        for (let dx=-1; dx<=1; dx++) {
          if (!dx && !dy) continue;
          const nx=x+dx, ny=y+dy;
          if (nx>=0 && nx<W && ny>=0 && ny<H && repaired[ny*W+nx]) neighbors++;
        }
      }
      if (neighbors < 2) keep = 0;
    }
    const i = pi * 4;
    const v = keep ? 0 : 255;
    d[i]=v; d[i+1]=v; d[i+2]=v; d[i+3]=255;
  }
}
function buildBrightPanelMask(d, W, H) {
  const BS = 10;
  const bcols = Math.ceil(W/BS), brows = Math.ceil(H/BS);
  const totalBlocks = bcols * brows;
  const bright = new Uint8Array(bcols*brows);
  const detail = new Uint8Array(bcols*brows);
  const seed = new Uint8Array(bcols*brows);
  const avgL = new Float32Array(bcols*brows);
  for (let br=0; br<brows; br++) {
    for (let bc=0; bc<bcols; bc++) {
      const bi = br*bcols + bc;
      let cnt=0, brightCnt=0, paperCnt=0, inkCnt=0, sum=0, edge=0, prev=-1;
      for (let py=br*BS; py<Math.min((br+1)*BS,H); py++) {
        for (let px=bc*BS; px<Math.min((bc+1)*BS,W); px++) {
          const i=(py*W+px)*4, l=lumAt(d,i);
          const s=satAt(d,i);
          sum += l; cnt++;
          if (l > 210 && s < 54) brightCnt++;
          if (l > 174 && s < 74) paperCnt++;
          if (l < 168 || s > 66) inkCnt++;
          if (prev >= 0 && Math.abs(l-prev) > 24) edge++;
          prev = l;
        }
      }
      const mean = sum / Math.max(1, cnt);
      const ratio = brightCnt / cnt;
      const paperRatio = paperCnt / cnt;
      avgL[bi] = mean;
      bright[bi] = ((ratio > .5 && mean > 178) || (paperRatio > .64 && mean > 166)) ? 1 : 0;
      detail[bi] = (inkCnt/cnt > .032 || edge/cnt > .105) ? 1 : 0;
      seed[bi] = bright[bi];
    }
  }

  function idxAt(br, bc) {
    return br >= 0 && br < brows && bc >= 0 && bc < bcols ? br*bcols + bc : -1;
  }
  function seeded(br, bc, arr = seed) {
    const idx = idxAt(br, bc);
    return idx >= 0 && !!arr[idx];
  }
  for (let pass=0; pass<2; pass++) {
    const next = new Uint8Array(seed);
    for (let br=0; br<brows; br++) {
      for (let bc=0; bc<bcols; bc++) {
        const bi = br*bcols + bc;
        if (seed[bi]) continue;
        let near = 0;
        for (let dr=-1; dr<=1; dr++) {
          for (let dc=-1; dc<=1; dc++) {
            if (!dr && !dc) continue;
            if (seeded(br+dr, bc+dc)) near++;
          }
        }
        const bridged =
          (seeded(br,bc-1) && seeded(br,bc+1)) ||
          (seeded(br-1,bc) && seeded(br+1,bc)) ||
          (seeded(br-1,bc-1) && seeded(br+1,bc+1)) ||
          (seeded(br-1,bc+1) && seeded(br+1,bc-1));
        if ((near >= 2 || bridged) && (detail[bi] || avgL[bi] > 126)) next[bi] = 1;
        if (near >= 5) next[bi] = 1;
      }
    }
    seed.set(next);
  }

  function colSupport(bc, br0, br1) {
    let score=0, n=0;
    for (let br=br0; br<=br1; br++) {
      const bi = idxAt(br, bc);
      if (bi < 0) continue;
      if (bright[bi]) score += 1;
      else if (detail[bi] && avgL[bi] > 118) score += .56;
      else if (avgL[bi] > 150) score += .42;
      n++;
    }
    return n ? score / n : 0;
  }
  function rowSupport(br, bc0, bc1) {
    let score=0, n=0;
    for (let bc=bc0; bc<=bc1; bc++) {
      const bi = idxAt(br, bc);
      if (bi < 0) continue;
      if (bright[bi]) score += 1;
      else if (detail[bi] && avgL[bi] > 118) score += .56;
      else if (avgL[bi] > 150) score += .42;
      n++;
    }
    return n ? score / n : 0;
  }
  function outsideDarkRatio(bc0, br0, bc1, br1) {
    let dark=0, n=0;
    for (let i=0; i<totalBlocks; i++) {
      const br = Math.floor(i / bcols), bc = i % bcols;
      if (bc >= bc0 && bc <= bc1 && br >= br0 && br <= br1) continue;
      if (avgL[i] < 92) dark++;
      n++;
    }
    return n ? dark / n : 0;
  }
  function regionStats(bc0, br0, bc1, br1) {
    let n=0, dark=0, paper=0, sum=0;
    for (let br=br0; br<=br1; br++) {
      for (let bc=bc0; bc<=bc1; bc++) {
        const bi = idxAt(br, bc);
        if (bi < 0) continue;
        const l = avgL[bi];
        sum += l; n++;
        if (l < 96) dark++;
        if (bright[bi] || l > 168) paper++;
      }
    }
    return {
      mean: n ? sum / n : 0,
      darkRatio: n ? dark / n : 1,
      paperRatio: n ? paper / n : 0
    };
  }

  const seen = new Uint8Array(bcols*brows);
  const blocks = new Uint8Array(bcols*brows);
  const panels = [];
  const q = [];
  for (let start=0; start<seed.length; start++) {
    if (!seed[start] || seen[start]) continue;
    q.length = 0; q.push(start); seen[start]=1;
    let qi=0, minB=bcols, maxB=0, minR=brows, maxR=0, brightCount=0;
    const comp = [];
    while (qi < q.length) {
      const idx=q[qi++], br=Math.floor(idx/bcols), bc=idx%bcols;
      comp.push(idx);
      if (bright[idx]) brightCount++;
      minB=Math.min(minB,bc); maxB=Math.max(maxB,bc); minR=Math.min(minR,br); maxR=Math.max(maxR,br);
      [[0,1],[1,0],[-1,0],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([dr,dc]) => {
        const nr=br+dr, nc=bc+dc, ni=nr*bcols+nc;
        if (nr>=0 && nr<brows && nc>=0 && nc<bcols && seed[ni] && !seen[ni]) {
          seen[ni]=1; q.push(ni);
        }
      });
    }
    let detailCount = 0;
    comp.forEach(idx => { if (detail[idx]) detailCount++; });
    const bw=(maxB-minB+1)*BS, bh=(maxR-minR+1)*BS;
    const largeEnough = comp.length >= 8 && bw*bh > W*H*.008 && bw > W*.055 && bh > H*.055;
    if (!largeEnough) continue;
    const rectBlocks = (maxB-minB+1) * (maxR-minR+1);
    const detailRatio = detailCount / comp.length;
    const brightRatio = brightCount / comp.length;
    const fillRatio = comp.length / rectBlocks;
    const rectLike = fillRatio > .45 || (fillRatio > .28 && (detailRatio > .08 || brightRatio > .32));
    if (!rectLike) continue;
    let bc0 = minB, br0 = minR, bc1 = maxB, br1 = maxR;
    const maxGrowC = Math.max(2, Math.min(16, Math.round((bc1-bc0+1) * .55)));
    const maxGrowR = Math.max(2, Math.min(16, Math.round((br1-br0+1) * .55)));
    for (let g=0; g<maxGrowC && bc1+1<bcols && colSupport(bc1+1, br0, br1) > .18; g++) bc1++;
    for (let g=0; g<maxGrowC && bc0-1>=0 && colSupport(bc0-1, br0, br1) > .18; g++) bc0--;
    for (let g=0; g<maxGrowR && br1+1<brows && rowSupport(br1+1, bc0, bc1) > .18; g++) br1++;
    for (let g=0; g<maxGrowR && br0-1>=0 && rowSupport(br0-1, bc0, bc1) > .18; g++) br0--;
    const areaRatio = ((bc1-bc0+1)*BS * (br1-br0+1)*BS) / (W*H);
    const pageLike = (bc1-bc0+1) > bcols*.82 && (br1-br0+1) > brows*.82;
    const stats = regionStats(bc0, br0, bc1, br1);
    const regionW = (bc1-bc0+1) * BS;
    const regionH = (br1-br0+1) * BS;
    const darkTextBlock = stats.darkRatio > .42 && stats.paperRatio < .38;
    const wideTextBand = regionW / Math.max(1, regionH) > 2.6 && stats.darkRatio > .28 && stats.paperRatio < .65;
    if (stats.mean < 112 || darkTextBlock || wideTextBand) continue;
    if (areaRatio > .86 || (pageLike && outsideDarkRatio(bc0, br0, bc1, br1) < .45)) continue;
    const padBlocks = detailRatio > .2 ? 2 : 1;
    bc0 = Math.max(0, bc0 - padBlocks);
    br0 = Math.max(0, br0 - padBlocks);
    bc1 = Math.min(bcols - 1, bc1 + padBlocks);
    br1 = Math.min(brows - 1, br1 + padBlocks);
    for (let br=br0; br<=br1; br++) {
      for (let bc=bc0; bc<=bc1; bc++) blocks[br*bcols + bc] = 1;
    }
    panels.push({ x0:bc0*BS, y0:br0*BS, x1:Math.min(W,(bc1+1)*BS), y1:Math.min(H,(br1+1)*BS) });
  }
  if (!panels.length) return null;

  const restore = new Uint8Array(W * H);
  const paperMask = new Uint8Array(W * H);
  const stride = W + 1;
  const paperIntegral = new Uint32Array((W + 1) * (H + 1));
  const darkIntegral = new Uint32Array((W + 1) * (H + 1));
  for (let y=0; y<H; y++) {
    let rowPaper = 0, rowDark = 0;
    for (let x=0; x<W; x++) {
      const pi = y*W + x;
      const i = pi * 4;
      const l = lumAt(d,i);
      const paper = l > 184 && satAt(d,i) < 78 ? 1 : 0;
      paperMask[pi] = paper;
      rowPaper += paper;
      rowDark += l < 92 ? 1 : 0;
      paperIntegral[(y+1)*stride + x + 1] = paperIntegral[y*stride + x + 1] + rowPaper;
      darkIntegral[(y+1)*stride + x + 1] = darkIntegral[y*stride + x + 1] + rowDark;
    }
  }
  function maskSum(integral, x0, y0, x1, y1) {
    x0 = Math.max(0, Math.min(W, x0));
    y0 = Math.max(0, Math.min(H, y0));
    x1 = Math.max(0, Math.min(W, x1));
    y1 = Math.max(0, Math.min(H, y1));
    if (x1 <= x0 || y1 <= y0) return 0;
    return integral[y1*stride + x1] - integral[y0*stride + x1] - integral[y1*stride + x0] + integral[y0*stride + x0];
  }
  function hasPaperNearby(x, y, r) {
    return maskSum(paperIntegral, x-r, y-r, x+r+1, y+r+1) > 0;
  }
  function paperAmountNearby(x, y, r) {
    return maskSum(paperIntegral, x-r, y-r, x+r+1, y+r+1);
  }
  function localDarkRatio(x, y, r) {
    const x0 = Math.max(0, x-r), y0 = Math.max(0, y-r);
    const x1 = Math.min(W, x+r+1), y1 = Math.min(H, y+r+1);
    const area = Math.max(1, (x1-x0) * (y1-y0));
    return maskSum(darkIntegral, x0, y0, x1, y1) / area;
  }
  panels.forEach(p => {
    const edgeMargin = Math.max(8, Math.min(28, Math.round(Math.min(p.x1-p.x0, p.y1-p.y0) * .07)));
    for (let y=p.y0; y<p.y1; y++) {
      for (let x=p.x0; x<p.x1; x++) {
        const pi = y*W + x;
        const i = pi * 4;
        const l = lumAt(d,i);
        const s = satAt(d,i);
        const nearEdge = x - p.x0 < edgeMargin || p.x1 - x <= edgeMargin || y - p.y0 < edgeMargin || p.y1 - y <= edgeMargin;
        if (paperMask[pi]) {
          restore[pi] = 1;
          continue;
        }
        const onPaper = hasPaperNearby(x, y, 10);
        const paperSupport = paperAmountNearby(x, y, 18);
        const darkAround = localDarkRatio(x, y, 4);
        const lightArtwork = l > 112 && s < 96 && (l > 154 || onPaper || paperSupport > 10);
        const softArtwork = l > 92 && l <= 154 && s < 72 && paperSupport > 24 && darkAround < .72;
        const thinInk = onPaper && (l < 116 || s > 72) && darkAround < (nearEdge ? .18 : .28);
        if (lightArtwork || softArtwork || thinInk) restore[pi] = 1;
      }
    }
  });
  return { bs: BS, bcols, brows, blocks, panels, restore };
}
function normalizeSmartPanels(out, original, W, H, panelMask) {
  if (!panelMask || !panelMask.panels || !panelMask.panels.length) return;
  panelMask.panels.forEach(p => {
    const x0 = Math.max(0, Math.min(W - 1, Math.floor(p.x0)));
    const y0 = Math.max(0, Math.min(H - 1, Math.floor(p.y0)));
    const x1 = Math.max(x0 + 1, Math.min(W, Math.ceil(p.x1)));
    const y1 = Math.max(y0 + 1, Math.min(H, Math.ceil(p.y1)));
    const pw = x1 - x0, ph = y1 - y0, area = pw * ph;
    if (area < 64) return;

    const dark = new Uint8Array(area);
    const seen = new Uint8Array(area);
    const drop = new Uint8Array(area);
    const lift = new Uint8Array(area);
    const q = new Int32Array(area);

    for (let yy=0; yy<ph; yy++) {
      for (let xx=0; xx<pw; xx++) {
        const src = ((y0 + yy) * W + (x0 + xx)) * 4;
        const l = lumAt(original, src);
        const s = satAt(original, src);
        if (l < 118 && s < 104) dark[yy*pw + xx] = 1;
      }
    }

    for (let start=0; start<area; start++) {
      if (!dark[start] || seen[start]) continue;
      let head=0, tail=0, count=0, minX=pw, minY=ph, maxX=0, maxY=0, edge=false;
      q[tail++] = start;
      seen[start] = 1;
      while (head < tail) {
        const idx = q[head++];
        const xx = idx % pw, yy = (idx / pw) | 0;
        count++;
        minX=Math.min(minX,xx); maxX=Math.max(maxX,xx);
        minY=Math.min(minY,yy); maxY=Math.max(maxY,yy);
        if (xx <= 1 || yy <= 1 || xx >= pw - 2 || yy >= ph - 2) edge = true;
        const nbs = [idx-1, idx+1, idx-pw, idx+pw];
        for (const ni of nbs) {
          if (ni < 0 || ni >= area || seen[ni] || !dark[ni]) continue;
          const nx = ni % pw;
          if ((ni === idx-1 && nx > xx) || (ni === idx+1 && nx < xx)) continue;
          seen[ni] = 1;
          q[tail++] = ni;
        }
      }
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const density = count / Math.max(1, bw * bh);
      const minDim = Math.min(bw, bh);
      const edgeBackground = edge && count > Math.max(120, area * .0035) && minDim > 4;
      const chunkyArtwork = !edgeBackground && count > Math.max(70, area * .0014) && minDim > 5 && density > .2;
      if (!edgeBackground && !chunkyArtwork) continue;
      for (let i=0; i<tail; i++) {
        if (edgeBackground) drop[q[i]] = 1;
        else lift[q[i]] = 1;
      }
    }

    for (let yy=0; yy<ph; yy++) {
      for (let xx=0; xx<pw; xx++) {
        const local = yy*pw + xx;
        const dst = ((y0 + yy) * W + (x0 + xx)) * 4;
        if (drop[local]) {
          out[dst]=255; out[dst+1]=255; out[dst+2]=255; out[dst+3]=255;
          continue;
        }
        const l = lumAt(original, dst);
        const s = satAt(original, dst);
        if (lift[local]) {
          const v = Math.max(142, Math.min(198, Math.round(l * .48 + 118)));
          out[dst]=v; out[dst+1]=v; out[dst+2]=v; out[dst+3]=255;
          continue;
        }
        if (l > 224 && s < 52) {
          out[dst]=255; out[dst+1]=255; out[dst+2]=255; out[dst+3]=255;
        } else {
          out[dst]=original[dst];
          out[dst+1]=original[dst+1];
          out[dst+2]=original[dst+2];
          out[dst+3]=255;
        }
      }
    }
  });
}
function blendLogoRegion(ctx, x, y, w, h, shape) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  x = Math.floor(Number.isFinite(x) ? x : 0);
  y = Math.floor(Number.isFinite(y) ? y : 0);
  w = Math.ceil(Number.isFinite(w) ? w : 0);
  h = Math.ceil(Number.isFinite(h) ? h : 0);
  if (w < 1) w = 1;
  if (h < 1) h = 1;
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x >= W || y >= H || w < 1 || h < 1) return;
  if (x + w > W) w = W - x;
  if (y + h > H) h = H - y;

  // Sample background from a ring just outside the region
  const pad = Math.max(8, Math.round(Math.min(w, h) * 0.18));
  const sx = Math.max(0, x - pad), sy = Math.max(0, y - pad);
  const sw = Math.min(W - sx, w + pad * 2), sh = Math.min(H - sy, h + pad * 2);
  if (sw < 1 || sh < 1) return;

  const id = ctx.getImageData(sx, sy, sw, sh);
  const d = id.data;

  // Build the fill mask for the selected region
  const mask = new Uint8Array(sw * sh);
  const ox0 = x - sx, oy0 = y - sy;
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      if (shape === 'circ') {
        const nx = (px - (x + w / 2)) / (w / 2);
        const ny = (py - (y + h / 2)) / (h / 2);
        if (nx * nx + ny * ny > 1) continue;
      }
      mask[(py - sy) * sw + (px - sx)] = 1;
    }
  }

  // Sample background: median of pixels in a narrow ring OUTSIDE the region
  const ringW = Math.max(4, Math.round(Math.min(w, h) * 0.12));
  const rx0 = ox0, ry0 = oy0, rx1 = ox0 + w - 1, ry1 = oy0 + h - 1;
  const rs = [], gs = [], bs = [];
  for (let py = 0; py < sh; py++) {
    for (let px = 0; px < sw; px++) {
      if (mask[py * sw + px]) continue;
      const inRing = px >= rx0 - ringW && px <= rx1 + ringW && py >= ry0 - ringW && py <= ry1 + ringW;
      if (!inRing) continue;
      const i = (py * sw + px) * 4;
      rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
    }
  }

  function median(a) {
    if (!a.length) return 255;
    a.sort((x, y) => x - y);
    return a[a.length >> 1];
  }

  let fillR = median(rs), fillG = median(gs), fillB = median(bs);
  const fillL = 0.299 * fillR + 0.587 * fillG + 0.114 * fillB;
  const fillS = Math.max(fillR, fillG, fillB) - Math.min(fillR, fillG, fillB);
  // Snap near-white or near-black to pure values for clean output
  if (fillL > 230 && fillS < 30) { fillR = 255; fillG = 255; fillB = 255; }
  else if (fillL < 20 && fillS < 30) { fillR = 0; fillG = 0; fillB = 0; }

  // Erase the selected area completely. The preview alignment now keeps the
  // selected box honest, so preserving dark ink would keep logo symbols behind.
  for (let py = 0; py < sh; py++) {
    for (let px = 0; px < sw; px++) {
      if (!mask[py * sw + px]) continue;
      const i = (py * sw + px) * 4;
      d[i] = fillR; d[i + 1] = fillG; d[i + 2] = fillB; d[i + 3] = 255;
    }
  }

  ctx.putImageData(id, sx, sy);
}
function getFinal(sl) {
  const src = sl.edited || sl.c;
  const f = document.createElement('canvas'); f.width=src.width; f.height=src.height;
  const ctx = f.getContext('2d', {alpha:false});

  // Draw on white bg so transparency becomes white
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,f.width,f.height);
  ctx.drawImage(src,0,0);

  if (sl.inverted && !sl.edited) {
    ctx.globalCompositeOperation='difference'; ctx.fillStyle='white';
    ctx.fillRect(0,0,f.width,f.height); ctx.globalCompositeOperation='source-over';
  }

  const inv   = document.getElementById('tog-invert').classList.contains('on');
  const clr   = document.getElementById('tog-clear').classList.contains('on');
  const gry   = document.getElementById('tog-gray').classList.contains('on');
  const bw    = document.getElementById('tog-bw').classList.contains('on');
  // smart is always on (built-in, hidden toggle)
  const smart = true;

  const W = f.width, H = f.height;
  if (inv || clr || gry || bw) {
    const id = ctx.getImageData(0,0,W,H);
    const d = id.data;

    const original = inv ? new Uint8ClampedArray(d) : null;
    const panelMask = (inv && smart) ? buildBrightPanelMask(original, W, H) : null;

    // Clean already-light PDFs before other filters. For dark slides, the useful
    // cleanup happens after inversion when the background has become light.
    if (clr && !inv) cleanLightBackground(d, W, H, panelMask);

    // ── STEP 1: INVERT ──
    if (inv) {
      for (let i=0; i<d.length; i+=4) {
        d[i]  =255-d[i];
        d[i+1]=255-d[i+1];
        d[i+2]=255-d[i+2];
      }
    }

    // ── STEP 2: SMART DIAGRAM/PANEL NORMALIZE ──
    // Rebuild detected figure panels as light panels instead of restoring random
    // pieces, which avoids black blobs and thick source-background borders.
    if (panelMask) normalizeSmartPanels(d, original, W, H, panelMask);

    // ── STEP 3: CLEAR BACKGROUND ──
    // Run after inversion too, so dark-slide grain becomes clean white instead
    // of gray speckles in grayscale output.
    if (clr && !bw) cleanLightBackground(d, W, H, panelMask);

    // ── STEP 4: GRAYSCALE / B&W ──
    if (bw) {
      applyNoteBW(d, W, H);
    } else if (gry) {
      for (let i=0; i<d.length; i+=4) {
        const l=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
        d[i]=d[i+1]=d[i+2]=Math.round(l);
      }
    }

    if (clr && gry && !bw) {
      cleanLightBackground(d, W, H, panelMask);
      removeTemplateMarksFromGrayscale(d, W, H, panelMask);
    }

    ctx.putImageData(id,0,0);
  }

  // ── STEP 6: LOGO REMOVAL ──
  if (document.getElementById('tog-logo').classList.contains('on')) {
    logoRegions.filter(r => r.enabled).forEach(r => {
      const wPct = Math.max(1, Math.min(50, Number.isFinite(+r.w) ? +r.w : 15));
      const hPct = Math.max(1, Math.min(50, Number.isFinite(+r.h) ? +r.h : 15));
      const rw = Math.max(1, Math.round(f.width * wPct / 100));
      const rh = Math.max(1, Math.round(f.height * hPct / 100));
      let rx=0,ry=0;
      if (r.useCustom) {
        const cx = Math.max(0, Math.min(100, Number.isFinite(+r.customX) ? +r.customX : 0));
        const cy = Math.max(0, Math.min(100, Number.isFinite(+r.customY) ? +r.customY : 0));
        rx = Math.round(f.width * cx / 100);
        ry = Math.round(f.height * cy / 100);
      } else {
        const corner = r.corner || 'top-right';
        if(corner==='top-right')  { rx=f.width-rw; ry=0; }
        if(corner==='top-left')   { rx=0; ry=0; }
        if(corner==='bot-right')  { rx=f.width-rw; ry=f.height-rh; }
        if(corner==='bot-left')   { rx=0; ry=f.height-rh; }
      }
      rx = Math.max(0, Math.min(f.width - rw, rx));
      ry = Math.max(0, Math.min(f.height - rh, ry));
      const shape = r.shape === 'circ' ? 'circ' : 'rect';
      blendLogoRegion(ctx, rx, ry, rw, rh, shape);
    });
  }

  return f;
}

// ── PROCESS ──
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}
let _procScrollLocked = false;
let _procScrollY = 0;
let _procScrollHandlersReady = false;
let _processProgressCurrent = .04;
let _processProgressTarget = .04;
let _processProgressRaf = null;
const _procScrollKeys = new Set([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
function blockProcessScroll(e) {
  const screen = document.getElementById('process-screen');
  if (!_procScrollLocked || !screen || !screen.classList.contains('open')) return;
  if (e.type === 'keydown' && !_procScrollKeys.has(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
}
function holdProcessScroll() {
  const screen = document.getElementById('process-screen');
  if (!_procScrollLocked || !screen || !screen.classList.contains('open')) return;
  if ((window.scrollY || 0) !== _procScrollY) window.scrollTo(0, _procScrollY);
}
function initProcessScrollGuards() {
  if (_procScrollHandlersReady) return;
  _procScrollHandlersReady = true;
  window.addEventListener('wheel', blockProcessScroll, { passive: false, capture: true });
  window.addEventListener('touchmove', blockProcessScroll, { passive: false, capture: true });
  window.addEventListener('keydown', blockProcessScroll, { passive: false, capture: true });
  window.addEventListener('scroll', holdProcessScroll, { passive: true });
}
let _scrollLockDepth = 0;
function lockPageScroll() {
  initProcessScrollGuards();
  if (_scrollLockDepth++ > 0) return;
  _procScrollLocked = true;
  _procScrollY = window.scrollY || 0;
  document.documentElement.classList.add('scroll-lock');
  document.body.classList.add('scroll-lock');
  document.documentElement.style.overflow = 'clip';
  document.body.style.overflow = 'clip';
}
function unlockPageScroll() {
  if (_scrollLockDepth <= 0) return;
  if (--_scrollLockDepth > 0) return;
  if (!_procScrollLocked) return;
  document.documentElement.classList.remove('scroll-lock');
  document.body.classList.remove('scroll-lock');
  document.documentElement.style.overflow = '';
  document.documentElement.style.height = '';
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.width = '';
  document.body.style.height = '';
  document.body.style.overflow = '';
  window.scrollTo(0, _procScrollY);
  _procScrollLocked = false;
}
function setProcessOverlay(open) {
  const screen = document.getElementById('process-screen');
  if (!screen) return;
  screen.classList.toggle('open', open);
  screen.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open) lockPageScroll();
  else unlockPageScroll();
  if (open) {
    _processProgressCurrent = .04;
    _processProgressTarget = .04;
    screen.style.setProperty('--process-progress', _processProgressCurrent);
    startProcessProgressLoop();
  } else if (_processProgressRaf) {
    cancelAnimationFrame(_processProgressRaf);
    _processProgressRaf = null;
  }
  if (open) setProcessStage('Reading pages', 8);
}
function setProcessProgress(target) {
  const next = Math.max(.04, Math.min(1, target));
  _processProgressTarget = Math.max(_processProgressTarget, next);
  startProcessProgressLoop();
}
function startProcessProgressLoop() {
  if (_processProgressRaf) return;
  const screen = document.getElementById('process-screen');
  if (!screen || !screen.classList.contains('open')) return;
  let last = performance.now();
  const tick = now => {
    if (!screen.classList.contains('open')) {
      _processProgressRaf = null;
      return;
    }
    const dt = Math.min(48, now - last);
    last = now;
    const speed = _processProgressTarget >= 1 ? .5 : .18;
    const step = 1 - Math.pow(1 - speed, dt / 16.67);
    _processProgressCurrent += (_processProgressTarget - _processProgressCurrent) * step;
    if (Math.abs(_processProgressTarget - _processProgressCurrent) < .001) _processProgressCurrent = _processProgressTarget;
    screen.style.setProperty('--process-progress', _processProgressCurrent.toFixed(4));
    _processProgressRaf = requestAnimationFrame(tick);
  };
  _processProgressRaf = requestAnimationFrame(tick);
}
function setProcessStage(label, progress) {
  const sub = document.getElementById('process-sub');
  if (sub) sub.textContent = label;
  if (Number.isFinite(progress)) setProcessProgress(progress / 100);
}
function easeProcessTo(target, duration = 600) {
  setProcessProgress(Math.min(.98, target / 100));
}
async function processFile() {
  const active = slides.filter(s=>!s.removed&&s.selected);
  if (!active.length) { showToast('No slides selected'); return; }
  processedPdfBlob = null;
  processedPdfName = '';
  const btn = document.getElementById('proc-btn');
  if (btn) btn.disabled = true;
  setProcessOverlay(true);
  easeProcessTo(96, 900);
  await nextPaint();
  try {
    setProcessStage('Applying edits and filters', 18);
    const pvScroll = document.getElementById('pv-scroll');
    pvScroll.querySelectorAll('canvas').forEach(releaseCanvas);
    pvScroll.innerHTML='';
    const rows = +document.getElementById('spp-r').value||1;
    const cols = +document.getElementById('spp-c').value||1;
    const pp = rows*cols;
    const pages = Math.ceil(active.length/pp);
    const firstSrc = active[0].edited || active[0].c;
    const slideW = firstSrc.width, slideH = firstSrc.height;
    const pw = slideW*cols, ph = slideH*rows;
    const land = pw > ph;
    const {jsPDF} = window.jspdf;
    const doc = new jsPDF({orientation: land ? 'landscape' : 'portrait', unit: 'px', format: [pw, ph]});
    for (let pg=0;pg<pages;pg++) {
      setProcessStage('Composing page ' + (pg+1) + ' of ' + pages, 60 + ((pg+1) / pages) * 28);
      if (pg > 0) doc.addPage([pw, ph], land ? 'landscape' : 'portrait');
      const batch = active.slice(pg*pp,(pg+1)*pp);
      const pc=document.createElement('canvas');pc.width=pw;pc.height=ph;
      const pctx=pc.getContext('2d', {alpha:false});pctx.fillStyle='#fff';pctx.fillRect(0,0,pw,ph);
      for (let j=0; j<batch.length; j++) {
        const slideNum = pg*pp + j + 1;
        setProcessStage('Preparing slide ' + slideNum + ' of ' + active.length, 18 + (slideNum / active.length) * 42);
        const finalCanvas = getFinal(batch[j]);
        const c2=j%cols,r2=Math.floor(j/cols);
        pctx.drawImage(finalCanvas,c2*slideW,r2*slideH);
        releaseCanvas(finalCanvas);
        if (j % 2 === 1) await wait(0);
      }
      // ── PAGE NUMBERS ──
      const pgNumOn = document.querySelector('#pgnum-group .radio-row.on span')?.textContent?.trim() === 'Yes';
      if (pgNumOn) {
        const fontSize = Math.max(20, Math.min(44, Math.round(Math.min(pw, ph) * 0.024)));
        const padX = Math.round(fontSize * 0.55);
        const padY = Math.round(fontSize * 0.36);
        pctx.save();
        pctx.font = `700 ${fontSize}px Arial, system-ui, sans-serif`;
        pctx.textAlign = 'center';
        pctx.textBaseline = 'middle';
        const label = `${pg + 1}`;
        const textW = pctx.measureText(label).width;
        const pillW = textW + padX * 2;
        const pillH = fontSize + padY * 2;
        const margin = Math.max(pillH + 10, Math.round(ph * 0.025));
        const cx = pw / 2;
        const cy = ph - margin;
        const pillX = cx - pillW / 2;
        const pillY = cy - pillH / 2;
        const r2 = pillH / 2;
        // Draw pill background
        pctx.fillStyle = 'rgba(0,0,0,0.18)';
        pctx.beginPath();
        pctx.moveTo(pillX + r2, pillY);
        pctx.lineTo(pillX + pillW - r2, pillY);
        pctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, r2);
        pctx.lineTo(pillX + pillW, pillY + pillH - r2);
        pctx.arcTo(pillX + pillW, pillY + pillH, pillX + pillW - r2, pillY + pillH, r2);
        pctx.lineTo(pillX + r2, pillY + pillH);
        pctx.arcTo(pillX, pillY + pillH, pillX, pillY + pillH - r2, r2);
        pctx.lineTo(pillX, pillY + r2);
        pctx.arcTo(pillX, pillY, pillX + r2, pillY, r2);
        pctx.closePath();
        pctx.fill();
        pctx.fillStyle = 'rgba(18,18,28,0.80)';
        pctx.fillText(label, cx, cy);
        pctx.restore();
      }
      doc.addImage(pc.toDataURL('image/jpeg', .9), 'JPEG', 0, 0, pw, ph);
      const wrap=document.createElement('div');wrap.className='pv-pg';
      const c=makeScaledCanvas(pc, PREVIEW_MAX_SIDE);
      wrap.appendChild(c); pvScroll.appendChild(wrap);
      releaseCanvas(pc);
      await wait(0);
    }
    document.getElementById('pv-badge').textContent=pages+' page'+(pages!==1?'s':'');
    document.getElementById('ist-pages').textContent=pages;
    document.getElementById('ist-slides').textContent=active.length;
    // Set filename from first PDF name
    const baseName = pdfs[0]?.name?.replace(/\.pdf$/i,'') || 'output';
    const outName = baseName + ' · Notelix.pdf';
    document.getElementById('if-name').textContent=outName;
    processedPdfName = outName;
    // filters chips
    const fc=document.getElementById('fchips');fc.innerHTML='';
    [['tog-invert','Invert Colors'],['tog-clear','Clear Background'],['tog-gray','Grayscale'],['tog-bw','B&W'],['tog-logo','Logo Removed']].forEach(([id,lbl])=>{
      if(document.getElementById(id).classList.contains('on')){
        const ch=document.createElement('span');ch.className='f-chip';ch.textContent=lbl;fc.appendChild(ch);
      }
    });
    if (document.querySelector('#pgnum-group .radio-row.on span')?.textContent?.trim() === 'Yes') {
      const ch=document.createElement('span');ch.className='f-chip';ch.textContent='Page Numbers';fc.appendChild(ch);
    }
    if(!fc.children.length) fc.innerHTML='<span style="font-size:.72rem;color:var(--text3)">None applied</span>';
    setProcessStage('Finalizing download', 98);
    processedPdfBlob = doc.output('blob');
    setProcessStage('Ready', 100);
    goStep(4);
  } catch (err) {
    console.error(err);
    showToast('Processing failed');
  } finally {
    setProcessOverlay(false);
    if (btn) btn.disabled = false;
  }
}

function doDownload() {
  if (!processedPdfBlob) {
    showToast('Process the file first');
    return;
  }
  const url = URL.createObjectURL(processedPdfBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = processedPdfName || 'Notelix.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Download started');
}

// ── TOAST ──
function showToast(msg) {
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2400);
}

// init
Object.assign(window, {
  applyLogoSelection,
  clearAll,
  closeEditor,
  closeLogoModal,
  delPdf,
  deselAll,
  doDownload,
  eRedo,
  eUndo,
  goStep,
  nudgeSlider,
  openLogoModal,
  procAnother,
  processFile,
  renderLogoPreview,
  saveEditor,
  selAll,
  selectLogoRegion,
  setEAct,
  setLogoCorner,
  setLogoShape,
  setRadioGroup,
  setSelTool,
  togLogoRow,
  togRow,
  togToggle,
  toggleActiveLogoEnabled,
  updateLP,
  updateLogoRegion
});

syncDocSizeControls();
