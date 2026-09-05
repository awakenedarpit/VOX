// VOX — reliable real-time voice engine
// Input: Chrome SpeechRecognition -> VOX backend -> Rime TTS.

const $ = (id) => document.getElementById(id);
const stateEl = $('state'), hintEl = $('hint'), micBtn = $('mic'), stopBtn = $('stop');
const transcriptEl = $('transcript'), orb = $('orb'), errEl = $('error');
const taskMetric = $('task-metric'), latencyMetric = $('latency-metric');
const simBtn1 = $('sim-btn-1'), simBtn2 = $('sim-btn-2');
const textForm = $('text-form'), textInput = $('text-input'), clearBtn = $('clear-btn');
const evalBtn = $('eval-btn'), exportBtn = $('export-eval-btn'), evalSummaryEl = $('eval-summary');
const languageSelect = $('speech-language');

// Resolve the API correctly in both local Chrome and remote Codespaces.
// Codespaces forwards each port using a hostname containing the port number,
// e.g. ...-5500.app.github.dev -> ...-8000.app.github.dev.
function resolveApiBase() {
  if (window.VOX_API_BASE) return window.VOX_API_BASE.replace(/\/$/, '');
  const host = window.location.hostname;
  if (host.endsWith('.app.github.dev')) return window.location.origin;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return `${window.location.protocol}//${host}:8000`;
  return window.location.origin;
}
const API_BASE = resolveApiBase();

let currentTaskId = 0;
let currentState = 'IDLE';
let isMicActive = false;
let recognition = null;
let recognitionRunning = false;
let activeAudio = null;
let currentAbortController = null;
let pendingRecovery = null;
let activeResponseText = '';
let ignoreRecognitionUntil = 0;
let restartTimer = null;
let finalBuffer = '';
let finalTimer = null;
let lastSubmittedTranscript = '';
let bargeInTask = null;

const evaluationEvents = [];
const interruptionTrials = [];

function recordEvent(type, details = {}) {
  evaluationEvents.push({ type, time_ms: Number(performance.now().toFixed(2)), task_id: currentTaskId, state: currentState, ...details });
  updateEvaluationSummary();
}

function updateEvaluationSummary() {
  if (!evalSummaryEl) return;
  const done = interruptionTrials.filter(t => t.recovery_success !== null);
  const success = done.filter(t => t.recovery_success).length;
  const stale = done.reduce((n, t) => n + Number(t.stale_results || 0), 0);
  const times = done.map(t => t.recovery_time_ms).filter(Number.isFinite);
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : '--';
  evalSummaryEl.textContent = done.length ? `Trials ${done.length} · Recovery ${Math.round(success / done.length * 100)}% · Stale results ${stale} · Avg recovery ${avg} ms` : 'No completed interruption trials yet.';
}

function exportEvaluation() {
  const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), api_base: API_BASE, stt: 'Browser SpeechRecognition', trials: interruptionTrials, events: evaluationEvents }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `vox-evaluation-${Date.now()}.json`; a.click();
}

function setState(state, hint = '') {
  currentState = state;
  if (stateEl) stateEl.textContent = state;
  if (hintEl) hintEl.textContent = hint;
  if (orb) orb.className = 'orb ' + state.toLowerCase();
  if (stopBtn) stopBtn.hidden = state !== 'SPEAKING' && state !== 'THINKING';
  if (micBtn) { micBtn.classList.toggle('active', isMicActive); micBtn.textContent = isMicActive ? '⏹️ Stop Listening' : '🎤 Start Listening'; }
  recordEvent('state_changed', { new_state: state });
}

function showError(message) { if (errEl) { errEl.hidden = false; errEl.textContent = message; } recordEvent('error', { message }); }
function clearError() { if (errEl) { errEl.hidden = true; errEl.textContent = ''; } }

function addMessage(sender, text, taskId, interrupted = false) {
  const msg = document.createElement('div'); msg.className = `msg ${sender}` + (interrupted ? ' interrupted-tag' : '');
  const header = document.createElement('div'); header.className = 'msg-header'; header.innerHTML = `<span>${sender === 'user' ? 'YOU' : 'VOX'}</span><span>Task #${taskId}</span>`;
  const body = document.createElement('div'); body.textContent = text;
  if (interrupted) { const tag = document.createElement('em'); tag.textContent = ' (Interrupted)'; body.appendChild(tag); }
  msg.append(header, body); transcriptEl.appendChild(msg); transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function normalize(text) { return text.toLowerCase().replace(/[^a-z0-9₹]+/g, ' ').trim(); }
function isEcho(text) {
  const a = normalize(text), b = normalize(activeResponseText);
  if (!a || !b || a.split(/\s+/).length < 2) return false;
  const words = a.split(/\s+/), set = new Set(b.split(/\s+/));
  const overlap = words.filter(w => set.has(w)).length / words.length;
  return b.includes(a) || overlap >= 0.9;
}
function acceptable(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t || performance.now() < ignoreRecognitionUntil || t === lastSubmittedTranscript) return false;
  if (isEcho(t)) { recordEvent('recognition_echo_ignored', { text_length: t.length }); return false; }
  return true;
}
function language() { return languageSelect?.value || 'en-IN'; }

function stopAudio() {
  const t = performance.now(); let stopped = false;
  if (activeAudio) { activeAudio.onended = null; activeAudio.onerror = null; activeAudio.pause(); try { activeAudio.currentTime = 0; } catch (_) {} activeAudio.removeAttribute('src'); activeAudio.load(); activeAudio = null; stopped = true; }
  if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) { window.speechSynthesis.cancel(); stopped = true; }
  if (currentAbortController) { currentAbortController.abort(); currentAbortController = null; }
  recordEvent('audio_stop_requested'); if (stopped) recordEvent('audio_stopped', { stop_duration_ms: Number((performance.now() - t).toFixed(2)) });
  return Number((performance.now() - t).toFixed(2));
}

function beginInterruption(reason = 'Voice barge-in detected') {
  if (currentState !== 'SPEAKING' && currentState !== 'THINKING') return null;
  const detected = performance.now(), oldTask = currentTaskId, cutoff = stopAudio();
  currentTaskId += 1; activeResponseText = ''; bargeInTask = currentTaskId; ignoreRecognitionUntil = performance.now() + 250;
  pendingRecovery = { trial_id: interruptionTrials.length + 1, interrupted_task_id: oldTask, new_task_id: currentTaskId, interruption_detected_at: detected, cutoff_latency_ms: cutoff, recovery_time_ms: null, stale_results: 0, recovery_success: null, reason };
  interruptionTrials.push(pendingRecovery); if (taskMetric) taskMetric.textContent = `#${currentTaskId}`;
  recordEvent('interruption_detected', { reason, interrupted_task_id: oldTask }); recordEvent('task_invalidated', { invalidated_task_id: oldTask });
  setState('INTERRUPTED', 'Previous response stopped. Listening for your new instruction…'); return currentTaskId;
}
function interrupt(reason = 'Manual interruption') { return beginInterruption(reason); }

async function sendQuery(text) {
  const cleaned = text.trim().replace(/\s+/g, ' '); if (!acceptable(cleaned)) return;
  lastSubmittedTranscript = cleaned; clearError();
  const recovery = pendingRecovery && pendingRecovery.new_task_id === currentTaskId && pendingRecovery.recovery_success === null;
  const taskId = recovery ? currentTaskId : ++currentTaskId;
  if (taskMetric) taskMetric.textContent = `#${taskId}`; bargeInTask = null; activeResponseText = '';
  recordEvent('task_created', { task_id_created: taskId, input_source: 'browser-speech-recognition', speech_language: language(), recovery_task: recovery, api_base: API_BASE });
  addMessage('user', cleaned, taskId); setState('THINKING', 'VOX is thinking…');
  if (currentAbortController) currentAbortController.abort(); currentAbortController = new AbortController();
  try {
    recordEvent('llm_started');
    const res = await fetch(`${API_BASE}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: cleaned, task_id: taskId, language: language() }), signal: currentAbortController.signal });
    if (!res.ok) throw new Error(`Server returned ${res.status}: ${await res.text()}`);
    const data = await res.json(); recordEvent('llm_completed', { response_task_id: data.task_id });
    if (taskId !== currentTaskId) { recordEvent('stale_result_discarded', { stale_task_id: taskId, active_task_id: currentTaskId }); const trial = interruptionTrials.find(t => t.new_task_id === currentTaskId && t.recovery_success === null); if (trial) trial.stale_results += 1; return; }
    activeResponseText = data.text || ''; addMessage('vox', activeResponseText, taskId);
    if (data.audio_base64) playRimeAudio(data.audio_base64, data.audio_format, taskId); else speakFallback(activeResponseText, taskId);
  } catch (err) {
    if (err.name === 'AbortError') recordEvent('request_aborted', { aborted_task_id: taskId });
    else if (taskId === currentTaskId) { const detail = err instanceof TypeError && err.message === 'Failed to fetch' ? `Cannot connect to VOX backend at ${API_BASE}. Make sure port 8000 is running and forwarded.` : `Error: ${err.message}`; showError(detail); setState(isMicActive ? 'LISTENING' : 'IDLE', 'Backend connection failed.'); }
  }
}

function markRecovery(taskId) {
  if (!pendingRecovery || pendingRecovery.new_task_id !== taskId || pendingRecovery.recovery_success !== null) return;
  pendingRecovery.recovery_time_ms = Number((performance.now() - pendingRecovery.interruption_detected_at).toFixed(2)); pendingRecovery.recovery_success = true;
  if (latencyMetric) latencyMetric.textContent = `${Math.round(pendingRecovery.recovery_time_ms)} ms`; recordEvent('new_audio_playback_started', { recovery_time_ms: pendingRecovery.recovery_time_ms });
}

function playRimeAudio(base64, format, taskId) {
  stopAudio(); const audio = new Audio(`data:${format || 'audio/mp3'};base64,${base64}`); activeAudio = audio;
  setState('SPEAKING', 'VOX is speaking with official Rime voice. Interrupt anytime.'); recordEvent('rime_audio_received', { audio_format: format || 'audio/mp3' });
  audio.onended = () => { if (taskId !== currentTaskId) return; activeAudio = null; recordEvent('task_completed', { completed_task_id: taskId }); setState(isMicActive ? 'LISTENING' : 'IDLE', isMicActive ? 'Listening…' : 'Ready.'); };
  audio.onerror = () => { if (taskId !== currentTaskId) return; activeAudio = null; showError('Rime audio could not be played.'); setState(isMicActive ? 'LISTENING' : 'IDLE', 'Ready.'); };
  audio.play().then(() => { if (taskId === currentTaskId && activeAudio === audio) { recordEvent('audio_playback_started', { playback_task_id: taskId, provider: 'rime' }); markRecovery(taskId); } }).catch(err => showError(`Audio playback error: ${err.message}`));
}

// Browser fallback: explicitly prefer an English voice instead of the browser's
// default voice. This prevents en-IN text from being spoken with a Hindi voice.
function speakFallback(text, taskId) {
  if (!('speechSynthesis' in window)) { setState(isMicActive ? 'LISTENING' : 'IDLE', 'Rime audio unavailable.'); return; }
  stopAudio();
  const u = new SpeechSynthesisUtterance(text); u.rate = 1.02; u.lang = language();
  const voices = window.speechSynthesis.getVoices();
  const target = language();
  const englishVoice = voices.find(v => v.lang === target)
    || voices.find(v => v.lang?.toLowerCase() === target.toLowerCase())
    || voices.find(v => v.lang?.toLowerCase().startsWith('en-in'))
    || voices.find(v => v.lang?.toLowerCase().startsWith('en-us'))
    || voices.find(v => v.lang?.toLowerCase().startsWith('en'));
  if (englishVoice) { u.voice = englishVoice; u.lang = englishVoice.lang; recordEvent('fallback_voice_selected', { voice_name: englishVoice.name, voice_lang: englishVoice.lang }); }
  else { recordEvent('fallback_voice_selected', { voice_name: 'browser-default', voice_lang: u.lang }); }
  u.onstart = () => { if (taskId === currentTaskId) { setState('SPEAKING', 'VOX is speaking. Interrupt anytime.'); recordEvent('audio_playback_started', { provider: 'browser-fallback', playback_task_id: taskId }); markRecovery(taskId); } };
  u.onend = () => { if (taskId === currentTaskId) { recordEvent('task_completed', { completed_task_id: taskId }); setState(isMicActive ? 'LISTENING' : 'IDLE', isMicActive ? 'Listening…' : 'Ready.'); } };
  window.speechSynthesis.speak(u);
}

function flushFinal() { clearTimeout(finalTimer); const text = finalBuffer.trim(); finalBuffer = ''; if (text && acceptable(text)) sendQuery(text); }
function restartRecognition() { if (!isMicActive || !recognition || recognitionRunning) return; clearTimeout(restartTimer); restartTimer = setTimeout(() => { if (isMicActive && !recognitionRunning) { try { recognition.lang = language(); recognition.start(); } catch (_) {} } }, 200); }

function setupSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showError('Speech recognition is not supported in this browser. Use current Chrome.'); return false; }
  recognition = new SR(); recognition.continuous = true; recognition.interimResults = true; recognition.maxAlternatives = 3; recognition.lang = language();
  recognition.onstart = () => { recognitionRunning = true; recordEvent('speech_recognition_started', { language: recognition.lang }); };
  recognition.onend = () => { recognitionRunning = false; recordEvent('speech_recognition_ended'); restartRecognition(); };
  recognition.onerror = (e) => { recognitionRunning = false; recordEvent('speech_recognition_error', { error: e.error }); if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { isMicActive = false; showError('Microphone permission was denied. Allow microphone access for this site.'); setState('IDLE', 'Allow microphone access and try again.'); return; } if (e.error !== 'aborted' && e.error !== 'no-speech') showError(`Speech recognition error: ${e.error}`); restartRecognition(); };
  recognition.onresult = (event) => {
    let interim = '', finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) { const result = event.results[i]; const best = result[0]?.transcript?.trim() || ''; if (result.isFinal) finalText += `${best} `; else interim += `${best} `; }
    const candidate = (finalText || interim).trim();
    if ((currentState === 'SPEAKING' || currentState === 'THINKING') && bargeInTask !== currentTaskId && candidate && acceptable(candidate)) { bargeInTask = currentTaskId; beginInterruption('Voice barge-in detected'); }
    if (finalText.trim() && performance.now() >= ignoreRecognitionUntil) { finalBuffer = `${finalBuffer} ${finalText.trim()}`.trim(); clearTimeout(finalTimer); finalTimer = setTimeout(flushFinal, 300); }
    if (interim && hintEl && currentState === 'LISTENING') hintEl.textContent = interim;
  };
  return true;
}

function startListening() { clearError(); if (!recognition && !setupSpeechRecognition()) return; isMicActive = true; recognition.lang = language(); setState('LISTENING', 'Listening… speak normally.'); try { if (!recognitionRunning) recognition.start(); } catch (_) { restartRecognition(); } }
function stopListening() { isMicActive = false; clearTimeout(restartTimer); clearTimeout(finalTimer); finalBuffer = ''; if (recognition) { try { recognition.stop(); } catch (_) {} } recognitionRunning = false; stopAudio(); setState('IDLE', 'Ready.'); }

if (micBtn) micBtn.addEventListener('click', () => isMicActive ? stopListening() : startListening());
if (stopBtn) stopBtn.addEventListener('click', () => interrupt());
if (clearBtn) clearBtn.addEventListener('click', () => { if (transcriptEl) transcriptEl.innerHTML = ''; clearError(); });
if (languageSelect) languageSelect.addEventListener('change', () => { if (recognition) recognition.lang = language(); });
if (evalBtn) evalBtn.addEventListener('click', () => { const last = interruptionTrials[interruptionTrials.length - 1]; if (last && last.recovery_success === null) { last.recovery_success = true; updateEvaluationSummary(); } });
if (exportBtn) exportBtn.addEventListener('click', exportEvaluation);
if (simBtn1) simBtn1.addEventListener('click', () => sendQuery('Find laptops under sixty thousand rupees.'));
if (simBtn2) simBtn2.addEventListener('click', () => { if (currentState === 'SPEAKING' || currentState === 'THINKING') beginInterruption('Simulation interruption'); sendQuery('Actually, make it fifty thousand rupees.'); });
if (textForm) textForm.addEventListener('submit', (e) => { e.preventDefault(); const text = textInput?.value || ''; if (currentState === 'SPEAKING' || currentState === 'THINKING') beginInterruption('Text interruption'); sendQuery(text); if (textInput) textInput.value = ''; });

// Chrome may populate voices asynchronously; loading them here makes the
// fallback voice selection reliable on the first response.
if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', () => recordEvent('speech_voices_loaded', { voice_count: window.speechSynthesis.getVoices().length }));

setState('IDLE', 'Ready. Start listening when you are ready.');
