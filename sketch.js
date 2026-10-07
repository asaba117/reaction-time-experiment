'use strict';

// A1 protocol: fixed order, 20 trials per block, equal target size and radius.
const COUNTS = [2, 4, 8];
const TRIALS = 20;
const RADIUS = 160;
const STORAGE_KEY = 'reaction-lab-session-v1';
const HEADER = 'user#,block#,trial#,elapsedTime,numberOfErrors';
const $ = id => document.getElementById(id);
let participant = '';
let block = 0;
let rows = [];
let phase = 'setup';
let target = -1;
let startedAt = 0;
let errors = 0;
let targetButtons = [];
let audioContext;
let resumePhase = 'ready';
let previousCSV = '';
let previousParticipant = '';
let hasExported = false;
let sessionId = null;
const resultStore = window.createResultsStore(window.SUPABASE_CONFIG, {
  canUpload: () => !['active', 'ready'].includes(phase),
  onChange: () => { if (phase !== 'active') updateDatabaseStatus(); }
});

function updateDatabaseStatus() {
  const state = resultStore.status();
  let message;
  if (state.configurationError) message = 'Database setup needs attention: ' + state.configurationError + ' CSV export is available.';
  else if (!state.configured) message = 'Database not configured. CSV export is available.';
  else if (state.uploading) message = 'Saving results to the database…';
  else if (state.pending) message = state.pending + ' trial(s) awaiting database upload.' + (state.lastError ? ' ' + state.lastError : ' Uploads run at block breaks and session completion.');
  else message = state.uploaded ? 'All queued results are saved to the database.' : 'Database configured. Results will upload at block breaks and session completion.';
  if (!state.durable) message += ' Local upload backup is unavailable; keep this page open and export CSV.';
  $('database-status').textContent = message;
  $('retry-upload').hidden = !state.pending || ['active', 'ready'].includes(phase);
  $('retry-upload').disabled = state.uploading;
  $('data-notice').textContent = state.configured ? 'Results are sent to the researcher’s database. CSV backup is available.' : 'Data stays in this browser until database storage is configured. CSV export is available.';
}
function syncAtBreak() {
  updateDatabaseStatus();
  void resultStore.flush();
}

function csv(records = rows) {
  return [HEADER, ...records.map(r => [r.user, r.block, r.trial, r.elapsedTime, r.numberOfErrors].join(','))].join('\r\n') + '\r\n';
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({participant, rows})); }
  catch { $('storage-warning').hidden = false; }
}
function recoverSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && /^\d{1,6}$/.test(saved.participant) && Array.isArray(saved.rows) && saved.rows.length) {
      previousCSV = csv(saved.rows);
      previousParticipant = saved.participant;
      $('recover').hidden = false;
    }
  } catch { /* Storage may be disabled or contain an invalid prior session. */ }
}
function downloadCSV(content, user) {
  const blob = new Blob([content], {type: 'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'reaction-time-participant-' + user + '.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportCurrent() {
  downloadCSV(csv(), participant);
  hasExported = true;
  $('export-status').textContent = 'CSV download requested. Keep this file for your study analysis.';
}
function initAudio() {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!audioContext && Audio) audioContext = new Audio();
    if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
  } catch { /* Audio failure must not stop collection. */ }
}
function playSuccess() {
  if (!audioContext || audioContext.state !== 'running') return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;
  oscillator.frequency.value = 740;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.09, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.09);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
}
function blockRows() { return rows.filter(r => r.block === block + 1); }
function updateProgress() {
  $('block-label').textContent = 'BLOCK 0' + (block + 1) + ' / 03';
  $('trial-label').innerHTML = 'Trial ' + String(Math.min(blockRows().length + 1, TRIALS)).padStart(2, '0') + ' <span>/ 20</span>';
  $('progress').style.width = (rows.length / 60 * 100) + '%';
  $('saved-count').textContent = rows.length + ' / 60 trials saved';
  $('download-partial').disabled = rows.length === 0;
  document.querySelectorAll('[data-block]').forEach((el, i) => {
    el.classList.toggle('active', i === block);
    el.classList.toggle('done', i < block);
    el.querySelector('b').textContent = i < block ? '✓' : i === block ? '•' : '';
  });
}
function drawTargets() {
  $('targets').replaceChildren();
  targetButtons = Array.from({length: COUNTS[block]}, (_, i) => {
    // Opposing positions for 2, cardinal positions for 4, then diagonals for 8.
    const angle = -Math.PI / 2 + (2 * Math.PI * i / COUNTS[block]);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'target';
    button.dataset.target = String(i);
    button.tabIndex = -1;
    button.setAttribute('aria-label', 'Target ' + (i + 1));
    button.style.left = 'calc(50% + ' + (Math.cos(angle) * RADIUS) + 'px)';
    button.style.top = 'calc(50% + ' + (Math.sin(angle) * RADIUS) + 'px)';
    $('targets').append(button);
    return button;
  });
}
function clearTarget() {
  for (const button of targetButtons) {
    button.classList.remove('lit');
    button.setAttribute('aria-label', 'Target ' + (Number(button.dataset.target) + 1));
  }
  target = -1;
}
function ready() {
  clearTarget();
  phase = 'ready';
  $('overlay').hidden = true;
  $('start').setAttribute('aria-disabled', 'false');
  $('status').textContent = 'Ready to start';
  $('hint').textContent = 'Click the center button when you’re ready.';
  updateProgress();
  updateDatabaseStatus();
}
function showOverlay(eyebrow, title, message, action = 'Click to continue →') {
  $('overlay-eyebrow').textContent = eyebrow;
  $('overlay-title').textContent = title;
  $('overlay-text').textContent = message;
  $('continue').textContent = action;
  $('overlay').hidden = false;
}
function spaceAvailable() {
  const rect = $('arena').getBoundingClientRect();
  return rect.width >= 410 && rect.height >= 410;
}
function pause(reason) {
  if (!['ready', 'active', 'break'].includes(phase)) return;
  const wasActive = phase === 'active';
  resumePhase = phase === 'break' ? 'break' : 'ready';
  clearTarget();
  phase = 'paused';
  $('status').textContent = 'Session paused';
  showOverlay('SESSION PAUSED', 'Let’s keep it consistent.', reason + (wasActive ? ' The interrupted trial was discarded and will restart. Completed trials are saved.' : ' Completed trials are saved.'), 'Resume session →');
  updateDatabaseStatus();
}
function startTrial() {
  if (!spaceAvailable()) { pause('Enlarge your browser window to fit the target area.'); return; }
  initAudio();
  errors = 0;
  target = Math.floor(Math.random() * COUNTS[block]);
  targetButtons[target].classList.add('lit');
  targetButtons[target].setAttribute('aria-label', 'Highlighted target ' + (target + 1));
  startedAt = performance.now();
  phase = 'active';
  $('retry-upload').hidden = true;
  $('start').setAttribute('aria-disabled', 'true');
  $('status').textContent = 'Target illuminated';
  $('hint').textContent = 'Click the highlighted target as quickly and accurately as possible.';
}
function completeTrial() {
  const elapsedTime = Number((performance.now() - startedAt).toFixed(3));
  const record = {user: participant, block: block + 1, trial: blockRows().length + 1, elapsedTime, numberOfErrors: errors};
  rows.push(record);
  hasExported = false;
  console.log([record.user, record.block, record.trial, record.elapsedTime, record.numberOfErrors].join(','));
  clearTarget();
  playSuccess();
  save();
  resultStore.enqueue(sessionId, record);
  updateProgress();
  if (blockRows().length < TRIALS) { ready(); return; }
  if (block === COUNTS.length - 1) { finish(); return; }
  phase = 'break';
  syncAtBreak();
  $('status').textContent = 'Block complete';
  $('hint').textContent = 'Rest before continuing to the next block.';
  showOverlay('BLOCK ' + (block + 1) + ' COMPLETE · 20 / 20 TRIALS', 'Take a moment.', 'Next up: ' + COUNTS[block + 1] + ' targets. Rest your hand, then click to continue when you’re ready.');
}
function finish() {
  phase = 'complete';
  syncAtBreak();
  $('experiment').hidden = true;
  $('results').hidden = false;
  $('result-participant').textContent = participant;
  $('overall-time').textContent = (rows.reduce((s, r) => s + r.elapsedTime, 0) / rows.length).toFixed(1) + ' ms';
  $('overall-errors').textContent = rows.reduce((s, r) => s + r.numberOfErrors, 0);
  $('results-body').replaceChildren();
  COUNTS.forEach((count, i) => {
    const records = rows.filter(r => r.block === i + 1);
    const tr = document.createElement('tr');
    for (const value of [String(i + 1).padStart(2, '0'), count, records.length, (records.reduce((s, r) => s + r.elapsedTime, 0) / records.length).toFixed(1), (records.reduce((s, r) => s + r.numberOfErrors, 0) / records.length).toFixed(2)]) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    $('results-body').append(tr);
  });
  $('csv-preview').value = csv();
  $('download').focus();
}
$('session-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = $('participant').value.trim();
  if (!/^\d{1,6}$/.test(value)) { $('participant').focus(); return; }
  participant = value; rows = []; block = 0; hasExported = false;
  sessionId = resultStore.newSession();
  $('participant-label').textContent = value;
  $('setup').hidden = true;
  $('experiment').hidden = false;
  initAudio();
  console.log(HEADER);
  drawTargets(); ready();
  if (!spaceAvailable()) pause('Enlarge your browser window to fit the target area.');
});
// Count every primary pointer click during an active trial, including outside the arena.
// Keyboard-generated clicks are excluded: this protocol measures pointing responses.
document.addEventListener('click', event => {
  if (event.detail === 0 || event.button !== 0) return;
  if (phase === 'ready' && event.target === $('start')) { startTrial(); return; }
  if (phase !== 'active') return;
  if (event.target.closest('.target') === targetButtons[target]) completeTrial();
  else errors += 1;
}, true);
$('continue').addEventListener('click', () => {
  if (phase === 'break') { block += 1; drawTargets(); ready(); }
  else if (phase === 'paused') {
    if (!spaceAvailable()) { $('overlay-text').textContent = 'The target area needs at least 410 × 410 pixels. Enlarge your window, then resume.'; return; }
    if (resumePhase === 'break') {
      phase = 'break';
      showOverlay('BLOCK ' + (block + 1) + ' COMPLETE', 'Take a moment.', 'Next up: ' + COUNTS[block + 1] + ' targets. Continue when you’re ready.');
    } else ready();
  }
});
$('download-partial').addEventListener('click', () => {
  if (phase === 'active') pause('You opened a data export during a trial.');
  exportCurrent();
});
$('download').addEventListener('click', exportCurrent);
$('recover').addEventListener('click', () => downloadCSV(previousCSV, previousParticipant));
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(csv()); hasExported = true; $('export-status').textContent = 'CSV copied to clipboard.'; }
  catch { $('csv-preview').parentElement.open = true; $('csv-preview').focus(); $('csv-preview').select(); $('export-status').textContent = 'Automatic copying is unavailable. The CSV is selected below; press Ctrl+C (or Command+C).'; }
});
$('new-session').addEventListener('click', () => {
  const stored = resultStore.status().configured && resultStore.status().pending === 0;
  if (!hasExported && !stored && !window.confirm('Your data has not been exported. Start a new participant anyway?')) return;
  recoverSaved();
  phase = 'setup';
  $('results').hidden = true;
  $('setup').hidden = false;
  $('participant').value = '';
  $('export-status').textContent = '';
  $('participant').focus();
  updateDatabaseStatus();
});
$('retry-upload').addEventListener('click', () => {
  if (!['active', 'ready'].includes(phase)) syncAtBreak();
});
window.addEventListener('online', () => {
  if (!['active', 'ready'].includes(phase)) syncAtBreak();
});
window.addEventListener('blur', () => pause('The experiment lost focus. Return to the experiment before resuming.'));
document.addEventListener('visibilitychange', () => { if (document.hidden) pause('The experiment was hidden.'); });
window.addEventListener('resize', () => pause('The window size changed. Keep its size and zoom constant during the study.'));
window.addEventListener('beforeunload', event => {
  if (resultStore.status().pending || (rows.length && !hasExported && !resultStore.status().configured)) { event.preventDefault(); event.returnValue = ''; }
});
// The brand link must not accidentally end a running session.
document.querySelector('.brand').addEventListener('click', event => { if (phase !== 'setup') event.preventDefault(); });
recoverSaved();
updateDatabaseStatus();
void resultStore.flush();
