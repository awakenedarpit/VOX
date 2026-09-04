// VOX — Real-Time Interruptible Voice Engine
// Voice input: browser microphone -> Groq Whisper Large v3 -> VOX backend -> Rime TTS.

const stateEl = document.getElementById('state');
const hintEl = document.getElementById('hint');
const micBtn = document.getElementById('mic');
const stopBtn = document.getElementById('stop');
const transcriptEl = document.getElementById('transcript');
const orb = document.getElementById('orb');
const errEl = document.getElementById('error');
const taskMetric = document.getElementById('task-metric');
const latencyMetric = document.getElementById('latency-metric');
const simBtn1 = document.getElementById('sim-btn-1');
const simBtn2 = document.getElementById('sim-btn-2');
const textForm = document.getElementById('text-form');
const textInput = document.getElementById('text-input');
const clearBtn = document.getElementById('clear-btn');
const evalBtn = document.getElementById('eval-btn');
const exportBtn = document.getElementById('export-eval-btn');
const evalSummaryEl = document.getElementById('eval-summary');
const languageSelect = document.getElementById('speech-language');

const API_BASE = 'http://127.0.0.1:8000';
const SILENCE_MS = 1400;
const MAX_RECORDING_MS = 12000;
const MIN_RECORDING_MS = 800;
const VAD_INTERVAL_MS = 80;
const NOISE_CALIBRATION_MS = 450;
const MIN_SPEECH_RMS = 0.006;
const NOISE_MULTIPLIER = 1.8;
const NOISE_MARGIN = 0.003;
const SPEECH_CONFIRM_FRAMES = 2;

let currentTaskId = 0;
let currentState = 'IDLE';
let isMicActive = false;
let activeAudio = null;
let currentAbortController = null;
let pendingRecovery = null;
let activeResponseText = '';
let lastSubmittedTranscript = '';

let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let recordingStartedAt = 0;
let lastSpeechAt = 0;
let speechDetected = false;
let vadTimer = null;
let recordingStopReason = '';
let audioContext = null;
let analyser = null;
let micSource = null;
let noiseFloorRms = 0.006;
let calibrationStartedAt = 0;
let speechFrames = 0;

const evaluationEvents = [];
const interruptionTrials = [];

function recordEvent(type, details = {}) {
  const event = { type, time_ms: Number(performance.now().toFixed(3)), task_id: currentTaskId, state: currentState, ...details };
  evaluationEvents.push(event);
  updateEvaluationSummary();
  return event;
}

function updateEvaluationSummary() {
  if (!evalSummaryEl) return;
  const completed = interruptionTrials.filter(t => t.recovery_success !== null);
  const successes = completed.filter(t => t.recovery_success === true).length;
  const stale = completed.reduce((n, t) => n + Number(t.stale_results || 0), 0);
  const recoveryTimes = completed.map(t => t.recovery_time_ms).filter(Number.isFinite);
  const avgRecovery = recoveryTimes.length ? Math.round(recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length) : null;
  const successRate = completed.length ? Math.round(successes / completed.length * 100) : null;
  evalSummaryEl.textContent = completed.length
    ? `Trials ${completed.length} · Recovery ${successRate}% · Stale results ${stale} · Avg recovery ${avgRecovery ?? '--'} ms`
    : 'No completed interruption trials yet.';
}

function exportEvaluation() {
  const payload = { exported_at: new Date().toISOString(), config: { stt: 'Groq Whisper Large v3', silence_ms: SILENCE_MS, max_recording_ms: MAX_RECORDING_MS }, note: 'Browser-session evaluation data. Missing values are not zero.', trials: interruptionTrials, events: evaluationEvents };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `vox-evaluation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setState(state, hintText) {
  currentState = state;
  stateEl.textContent = state;
  hintEl.textContent = hintText || '';
  orb.className = 'orb ' + state.toLowerCase();
  stopBtn.hidden = state !== 'SPEAKING' && state !== 'THINKING';
  micBtn.classList.toggle('active', isMicActive);
  micBtn.textContent = isMicActive ? '⏹️ Stop Listening' : '🎤 Start Listening';
  recordEvent('state_changed', { new_state: state });
}

function addMessage(sender, text, taskId, isInterrupted = false) {
  const msg = document.createElement('div'); msg.className = `msg ${sender}` + (isInterrupted ? ' interrupted-tag' : '');
  const header = document.createElement('div'); header.className = 'msg-header'; header.innerHTML = `<span>${sender === 'user' ? 'YOU' : 'VOX'}</span><span>Task #${taskId || currentTaskId}</span>`;
  const body = document.createElement('div'); body.textContent = text;
  if (isInterrupted) { const tag = document.createElement('em'); tag.textContent = ' (Interrupted)'; tag.style.color = '#ff557f'; tag.style.fontSize = '12px'; body.appendChild(tag); }
  msg.appendChild(header); msg.appendChild(body); transcriptEl.appendChild(msg); transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function showError(msg) { errEl.hidden = false; errEl.textContent = msg; recordEvent('error', { message: msg }); }
function clearError() { errEl.hidden = true; errEl.textContent = ''; }

function stopAudio() {
  const t0 = performance.now(); let stopped = false; recordEvent('audio_stop_requested');
  if (activeAudio) { activeAudio.onended = null; activeAudio.onerror = null; activeAudio.pause(); try { activeAudio.currentTime = 0; } catch (_) {} activeAudio.src = ''; activeAudio.load(); activeAudio = null; stopped = true; }
  if (window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) { window.speechSynthesis.cancel(); stopped = true; }
  if (currentAbortController) { currentAbortController.abort(); currentAbortController = null; }
  const duration = Math.max(0, Number((performance.now() - t0).toFixed(3)));
  if (stopped) recordEvent('audio_stopped', { stop_duration_ms: duration });
  return { stopped, duration };
}

function beginInterruptionTrial(reason) {
  if (currentState !== 'SPEAKING' && currentState !== 'THINKING') return null;
  const detectedAt = performance.now(); const previousTaskId = currentTaskId; const { duration } = stopAudio();
  currentTaskId += 1; taskMetric.textContent = `#${currentTaskId}`; activeResponseText = '';
  pendingRecovery = { trial_id: interruptionTrials.length + 1, interrupted_task_id: previousTaskId, new_task_id: currentTaskId, interruption_detected_at: detectedAt, audio_stop_at: performance.now(), cutoff_latency_ms: duration, recovery_time_ms: null, stale_results: 0, recovery_success: null, reason };
  interruptionTrials.push(pendingRecovery); recordEvent('interruption_detected', { reason, interrupted_task_id: previousTaskId }); recordEvent('task_invalidated', { invalidated_task_id: previousTaskId });
  setState('INTERRUPTED', `${reason}. Previous task cancelled.`); return currentTaskId;
}
function interrupt(reason = 'Interruption') { return beginInterruptionTrial(reason); }
function getSelectedLanguage() { return languageSelect?.value || 'en-IN'; }
function normalizeForCompare(text) { return text.toLowerCase().replace(/[^a-z0-9₹]+/g, ' ').trim(); }
function isLikelyAssistantEcho(text) { const normalized = normalizeForCompare(text); const response = normalizeForCompare(activeResponseText); if (!normalized || !response) return false; const words = normalized.split(/\s+/).filter(Boolean); if (words.length < 2) return false; const responseWords = new Set(response.split(/\s+/)); const overlap = words.filter(w => responseWords.has(w)).length / words.length; return response.includes(normalized) || overlap >= 0.9; }

function stopRecording(reason = 'manual') {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  recordingStopReason = reason; clearInterval(vadTimer); vadTimer = null;
  try { mediaRecorder.stop(); } catch (_) {}
  recordEvent('speech_recording_stop_requested', { reason });
}

function monitorVoice() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording' || !analyser) return;
  const data = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(data);
  let sum = 0; for (const value of data) { const sample = (value - 128) / 128; sum += sample * sample; }
  const rms = Math.sqrt(sum / data.length); const now = performance.now();

  if (now - calibrationStartedAt <= NOISE_CALIBRATION_MS) {
    noiseFloorRms = noiseFloorRms * 0.8 + Math.min(rms, 0.08) * 0.2;
  } else if (!speechDetected && rms < noiseFloorRms * 1.5 + 0.002) {
    noiseFloorRms = noiseFloorRms * 0.97 + rms * 0.03;
  }

  const threshold = Math.max(MIN_SPEECH_RMS, noiseFloorRms * NOISE_MULTIPLIER + NOISE_MARGIN);
  if (rms >= threshold) speechFrames += 1; else speechFrames = Math.max(0, speechFrames - 1);

  if (speechFrames >= SPEECH_CONFIRM_FRAMES) {
    speechDetected = true; lastSpeechAt = now;
    if (currentState === 'SPEAKING' || currentState === 'THINKING') beginInterruptionTrial('Voice barge-in detected');
  }

  if (speechDetected && now - recordingStartedAt >= MIN_RECORDING_MS && now - lastSpeechAt >= SILENCE_MS) stopRecording('silence');
  if (now - recordingStartedAt >= MAX_RECORDING_MS) stopRecording('max-duration');
}

async function transcribeBlob(blob) {
  const form = new FormData(); const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
  form.append('file', blob, `vox.${extension}`); form.append('language', getSelectedLanguage());
  recordEvent('groq_stt_started', { bytes: blob.size, language: getSelectedLanguage() });
  const res = await fetch(`${API_BASE}/transcribe`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Transcription server returned ${res.status}`);
  const data = await res.json(); if (data.error) throw new Error(data.error);
  const text = (data.text || '').trim().replace(/\s+/g, ' ');
  recordEvent('groq_stt_completed', { transcript_length: text.length, provider: data.provider, model: data.model }); return text;
}

async function handleRecordingFinished() {
  const chunks = audioChunks; audioChunks = []; if (!chunks.length) return;
  const type = chunks[0].type || 'audio/webm'; const blob = new Blob(chunks, { type });
  if (blob.size < 1000) { recordEvent('voice_recording_discarded', { reason: 'audio_too_small', bytes: blob.size }); return; }
  try {
    const text = await transcribeBlob(blob);
    if (!text) { setState(isMicActive ? 'LISTENING' : 'IDLE', 'I did not catch that. Try again.'); return; }
    if (isLikelyAssistantEcho(text)) { recordEvent('recognition_echo_ignored', { text_length: text.length }); return; }
    sendQuery(text, true);
  } catch (err) {
    showError(`Voice transcription error: ${err.message}`);
    setState(isMicActive ? 'LISTENING' : 'IDLE', 'Check Groq API configuration and try again.');
  }
}

async function startRecording() {
  clearError();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { showError('This browser does not support microphone recording. Use a current Chrome browser.'); return; }
  if (!mediaStream) {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  }
  audioChunks = []; speechDetected = false; speechFrames = 0; recordingStartedAt = performance.now(); lastSpeechAt = recordingStartedAt; calibrationStartedAt = recordingStartedAt; noiseFloorRms = 0.006;
  const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm']; const mimeType = mimeCandidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  mediaRecorder.ondataavailable = event => { if (event.data.size) audioChunks.push(event.data); };
  mediaRecorder.onstop = async () => {
    clearInterval(vadTimer); vadTimer = null;
    if (audioContext) { try { await audioContext.close(); } catch (_) {} }
    audioContext = null; analyser = null; micSource = null;
    await handleRecordingFinished(); if (isMicActive) setState('LISTENING', 'Listening...');
  };
  mediaRecorder.onerror = event => showError(`Microphone recording error: ${event.error?.message || 'unknown error'}`);
  mediaRecorder.start(150);

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  try { await audioContext.resume(); } catch (_) {}
  micSource = audioContext.createMediaStreamSource(mediaStream); analyser = audioContext.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.15; micSource.connect(analyser);
  recordEvent('microphone_audio_context_ready', { audio_state: audioContext.state, sample_rate: audioContext.sampleRate });
  vadTimer = setInterval(monitorVoice, VAD_INTERVAL_MS);
  recordEvent('speech_recording_started', { language: getSelectedLanguage(), mime_type: mediaRecorder.mimeType });
  setState('LISTENING', 'Listening… speak naturally, then pause briefly when you finish.');
}

async function toggleMic() {
  try {
    if (isMicActive) {
      stopRecording('manual'); isMicActive = false;
      if (mediaStream) mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null; setState('IDLE', 'Ready.');
    } else { isMicActive = true; await startRecording(); }
  } catch (err) {
    isMicActive = false; if (mediaStream) mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null;
    showError(`Microphone access error: ${err.message}`); setState('IDLE', 'Allow microphone access and try again.');
  }
}

async function sendQuery(text, fromVoice = false) {
  const cleaned = text.trim().replace(/\s+/g, ' '); if (!cleaned || cleaned === lastSubmittedTranscript) return; lastSubmittedTranscript = cleaned; clearError();
  const isRecoveryTask = pendingRecovery && pendingRecovery.new_task_id === currentTaskId && pendingRecovery.recovery_success === null; const taskId = isRecoveryTask ? currentTaskId : ++currentTaskId;
  taskMetric.textContent = `#${taskId}`; activeResponseText = ''; recordEvent('task_created', { task_id_created: taskId, text_length: cleaned.length, recovery_task: isRecoveryTask, input_source: fromVoice ? 'groq-whisper' : 'text' }); addMessage('user', cleaned, taskId); setState('THINKING', 'VOX is thinking...');
  if (currentAbortController) currentAbortController.abort(); currentAbortController = new AbortController(); recordEvent('llm_started');
  try {
    const res = await fetch(`${API_BASE}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: cleaned, task_id: taskId, language: getSelectedLanguage() }), signal: currentAbortController.signal });
    if (!res.ok) throw new Error(`Server returned ${res.status}: ${await res.text()}`); const data = await res.json(); recordEvent('llm_completed', { response_task_id: data.task_id });
    if (taskId !== currentTaskId) { recordEvent('stale_result_discarded', { stale_task_id: taskId, active_task_id: currentTaskId }); const trial = interruptionTrials.find(t => t.new_task_id === currentTaskId && t.recovery_success === null); if (trial) trial.stale_results += 1; updateEvaluationSummary(); return; }
    activeResponseText = data.text || ''; addMessage('vox', activeResponseText, taskId); if (data.audio_base64) playRimeAudio(data.audio_base64, data.audio_format, taskId); else speakFallbackVoice(activeResponseText, taskId);
  } catch (err) {
    if (err.name === 'AbortError') recordEvent('request_aborted', { aborted_task_id: taskId }); else if (taskId === currentTaskId) { showError(`Error: ${err.message}`); setState(isMicActive ? 'LISTENING' : 'IDLE', 'Could not reach backend. Verify backend is running.'); }
  }
}

function markRecoveryPlaybackStarted(taskId) { if (!pendingRecovery || pendingRecovery.new_task_id !== taskId || pendingRecovery.recovery_success !== null) return; pendingRecovery.recovery_time_ms = Number((performance.now() - pendingRecovery.interruption_detected_at).toFixed(3)); pendingRecovery.recovery_success = true; latencyMetric.textContent = `${Math.round(pendingRecovery.recovery_time_ms)} ms`; recordEvent('new_audio_playback_started', { recovery_time_ms: pendingRecovery.recovery_time_ms }); updateEvaluationSummary(); }
function playRimeAudio(base64Data, audioFormat, taskId) { stopAudio(); const mimeType = audioFormat || 'audio/mp3'; const audio = new Audio(`data:${mimeType};base64,${base64Data}`); activeAudio = audio; setState('SPEAKING', 'VOX is speaking with official Rime voice. Interrupt anytime.'); recordEvent('rime_audio_received', { audio_format: mimeType }); audio.onended = () => { if (taskId !== currentTaskId) return; activeAudio = null; recordEvent('task_completed', { completed_task_id: taskId }); setState(isMicActive ? 'LISTENING' : 'IDLE', isMicActive ? 'Listening...' : 'Ready.'); }; audio.onerror = () => { if (taskId !== currentTaskId) return; recordEvent('error', { message: 'Rime audio could not be decoded or played.' }); activeAudio = null; setState(isMicActive ? 'LISTENING' : 'IDLE', 'Audio playback error.'); }; audio.play().then(() => { if (taskId === currentTaskId && activeAudio === audio) { recordEvent('audio_playback_started', { playback_task_id: taskId, provider: 'rime' }); markRecoveryPlaybackStarted(taskId); } }).catch(e => { if (taskId !== currentTaskId) return; recordEvent('error', { message: `Audio playback error: ${e.message}` }); setState(isMicActive ? 'LISTENING' : 'IDLE', 'Audio playback error.'); }); }
function speakFallbackVoice(text, taskId) { if (!('speechSynthesis' in window)) { setState('IDLE', 'Rime unconfigured and browser speech is unavailable.'); return; } stopAudio(); const utterance = new SpeechSynthesisUtterance(text); utterance.rate = 1.02; utterance.onstart = () => { if (taskId !== currentTaskId) return; recordEvent('audio_playback_started', { playback_task_id: taskId, provider: 'browser-fallback' }); markRecoveryPlaybackStarted(taskId); setState('SPEAKING', 'VOX is speaking.'); }; utterance.onend = () => { if (taskId !== currentTaskId) return; recordEvent('task_completed', { completed_task_id: taskId }); setState(isMicActive ? 'LISTENING' : 'IDLE', isMicActive ? 'Listening...' : 'Ready.'); }; window.speechSynthesis.speak(utterance); }
function markManualTrial() { const open = interruptionTrials.find(t => t.recovery_success === null); if (!open) { showError('No open interruption trial. Trigger an interruption first.'); return; } open.recovery_success = true; open.manually_marked = true; recordEvent('trial_manually_marked_success', { trial_id: open.trial_id }); updateEvaluationSummary(); }
function simulateFirstStep() { sendQuery('Find laptops under ₹60,000'); }
function simulateSecondStep() { if (currentState !== 'SPEAKING' && currentState !== 'THINKING') { sendQuery('Find laptops under ₹60,000'); setTimeout(() => interrupt('Simulation interruption'), 650); setTimeout(() => sendQuery('Actually, make it ₹50,000'), 700); return; } interrupt('Simulation interruption'); setTimeout(() => sendQuery('Actually, make it ₹50,000'), 50); }

micBtn?.addEventListener('click', toggleMic); stopBtn?.addEventListener('click', () => interrupt('Manual interrupt button')); simBtn1?.addEventListener('click', simulateFirstStep); simBtn2?.addEventListener('click', simulateSecondStep); evalBtn?.addEventListener('click', markManualTrial); exportBtn?.addEventListener('click', exportEvaluation); clearBtn?.addEventListener('click', () => { transcriptEl.innerHTML = ''; });
textForm?.addEventListener('submit', event => { event.preventDefault(); const value = textInput.value.trim(); if (value) { sendQuery(value); textInput.value = ''; } });
languageSelect?.addEventListener('change', () => recordEvent('speech_language_changed', { language: getSelectedLanguage() }));
window.addEventListener('beforeunload', () => { clearInterval(vadTimer); if (mediaStream) mediaStream.getTracks().forEach(track => track.stop()); });
recordEvent('app_ready', { stt_provider: 'groq-whisper-large-v3' });