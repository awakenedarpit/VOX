// VOX — Real-Time Interruptible Voice Engine

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

let currentTaskId = 0;
let currentState = 'IDLE';
let isMicActive = false;
let recognition = null;
let recognitionRunning = false;
let activeAudio = null;
let currentAbortController = null;
let bargeInHandledForTask = null;
let pendingRecovery = null;
let activeResponseText = '';
let ignoreRecognitionUntil = 0;
let recognitionRestartTimer = null;
let finalTranscriptBuffer = '';
let finalTranscriptTimer = null;
let lastSubmittedTranscript = '';

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
  const payload = { exported_at: new Date().toISOString(), note: 'Browser-session evaluation data. Missing values are not zero.', trials: interruptionTrials, events: evaluationEvents };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vox-evaluation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setState(state, hintText) {
  currentState = state;
  stateEl.textContent = state;
  hintEl.textContent = hintText || '';
  orb.className = 'orb ' + state.toLowerCase();
  stopBtn.hidden = state !== 'SPEAKING' && state !== 'THINKING';
  if (state === 'LISTENING') {
    micBtn.classList.add('active');
    micBtn.textContent = '⏹️ Stop Listening';
  } else if (state === 'IDLE' && !isMicActive) {
    micBtn.classList.remove('active');
    micBtn.textContent = '🎤 Start Listening';
  }
  recordEvent('state_changed', { new_state: state });
}

function addMessage(sender, text, taskId, isInterrupted = false) {
  const msg = document.createElement('div');
  msg.className = `msg ${sender}` + (isInterrupted ? ' interrupted-tag' : '');
  const header = document.createElement('div');
  header.className = 'msg-header';
  header.innerHTML = `<span>${sender === 'user' ? 'YOU' : 'VOX'}</span><span>Task #${taskId || currentTaskId}</span>`;
  const body = document.createElement('div');
  body.textContent = text;
  if (isInterrupted) {
    const tag = document.createElement('em');
    tag.textContent = ' (Interrupted)';
    tag.style.color = '#ff557f';
    tag.style.fontSize = '12px';
    body.appendChild(tag);
  }
  msg.appendChild(header);
  msg.appendChild(body);
  transcriptEl.appendChild(msg);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function showError(msg) {
  errEl.hidden = false;
  errEl.textContent = msg;
  recordEvent('error', { message: msg });
}

function clearError() {
  errEl.hidden = true;
  errEl.textContent = '';
}

function stopAudio() {
  const t0 = performance.now();
  let stopped = false;
  recordEvent('audio_stop_requested');
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.onerror = null;
    activeAudio.pause();
    try { activeAudio.currentTime = 0; } catch (_) {}
    activeAudio.src = '';
    activeAudio.load();
    activeAudio = null;
    stopped = true;
  }
  if (window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
    window.speechSynthesis.cancel();
    stopped = true;
  }
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  const duration = Math.max(0, Number((performance.now() - t0).toFixed(3)));
  if (stopped) recordEvent('audio_stopped', { stop_duration_ms: duration });
  return { stopped, duration };
}

function beginInterruptionTrial(reason) {
  if (currentState !== 'SPEAKING' && currentState !== 'THINKING') return null;
  const detectedAt = performance.now();
  const previousTaskId = currentTaskId;
  const { duration } = stopAudio();
  currentTaskId += 1;
  taskMetric.textContent = `#${currentTaskId}`;
  activeResponseText = '';
  bargeInHandledForTask = currentTaskId;
  ignoreRecognitionUntil = performance.now() + 450;
  pendingRecovery = {
    trial_id: interruptionTrials.length + 1,
    interrupted_task_id: previousTaskId,
    new_task_id: currentTaskId,
    interruption_detected_at: detectedAt,
    audio_stop_at: performance.now(),
    cutoff_latency_ms: duration,
    recovery_time_ms: null,
    stale_results: 0,
    recovery_success: null,
    reason,
  };
  interruptionTrials.push(pendingRecovery);
  recordEvent('interruption_detected', { reason, interrupted_task_id: previousTaskId });
  recordEvent('task_invalidated', { invalidated_task_id: previousTaskId });
  setState('INTERRUPTED', `${reason}. Previous task cancelled.`);
  return currentTaskId;
}

function interrupt(reason = 'Interruption') {
  return beginInterruptionTrial(reason);
}

function normalizeForCompare(text) {
  return text.toLowerCase().replace(/[^a-z0-9₹]+/g, ' ').trim();
}

function isLikelyAssistantEcho(text) {
  const normalized = normalizeForCompare(text);
  const response = normalizeForCompare(activeResponseText);
  if (!normalized || !response) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const responseWords = new Set(response.split(/\s+/));
  const overlap = words.filter(w => responseWords.has(w)).length / words.length;
  return response.includes(normalized) || normalized.includes(response.slice(0, Math.min(response.length, 80))) || overlap >= 0.9;
}

function shouldAcceptUserSpeech(text) {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (!cleaned || performance.now() < ignoreRecognitionUntil) return false;
  if (isLikelyAssistantEcho(cleaned)) {
    recordEvent('recognition_echo_ignored', { text_length: cleaned.length });
    return false;
  }
  if (cleaned === lastSubmittedTranscript) return false;
  return true;
}

function getSelectedLanguage() {
  return languageSelect?.value || 'en-IN';
}

async function sendQuery(text) {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (!cleaned || performance.now() < ignoreRecognitionUntil || cleaned === lastSubmittedTranscript) return;
  lastSubmittedTranscript = cleaned;
  clearError();
  const isRecoveryTask = pendingRecovery && pendingRecovery.new_task_id === currentTaskId && pendingRecovery.recovery_success === null;
  const taskId = isRecoveryTask ? currentTaskId : ++currentTaskId;
  taskMetric.textContent = `#${taskId}`;
  bargeInHandledForTask = null;
  activeResponseText = '';
  recordEvent('task_created', { task_id_created: taskId, text_length: cleaned.length, recovery_task: isRecoveryTask, speech_language: getSelectedLanguage() });
  addMessage('user', cleaned, taskId);
  setState('THINKING', 'VOX is thinking...');

  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();
  recordEvent('ollama_started');

  try {
    const res = await fetch('http://127.0.0.1:8000/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: cleaned, task_id: taskId, language: getSelectedLanguage() }),
      signal: currentAbortController.signal,
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}: ${await res.text()}`);
    const data = await res.json();
    recordEvent('ollama_completed', { response_task_id: data.task_id });

    if (taskId !== currentTaskId) {
      recordEvent('stale_result_discarded', { stale_task_id: taskId, active_task_id: currentTaskId });
      const trial = interruptionTrials.find(t => t.new_task_id === currentTaskId && t.recovery_success === null);
      if (trial) trial.stale_results += 1;
      updateEvaluationSummary();
      return;
    }

    activeResponseText = data.text || '';
    addMessage('vox', activeResponseText, taskId);
    if (data.audio_base64) playRimeAudio(data.audio_base64, data.audio_format, taskId);
    else {
      if (data.rime_error) console.warn('[VOX] Rime notice:', data.rime_error);
      speakFallbackVoice(activeResponseText, taskId);
    }
  } catch (err) {
    if (err.name === 'AbortError') recordEvent('request_aborted', { aborted_task_id: taskId });
    else if (taskId === currentTaskId) {
      showError(`Error: ${err.message}`);
      setState('IDLE', 'Could not reach backend. Verify backend is running.');
    }
  }
}

function markRecoveryPlaybackStarted(taskId) {
  if (!pendingRecovery || pendingRecovery.new_task_id !== taskId || pendingRecovery.recovery_success !== null) return;
  pendingRecovery.recovery_time_ms = Number((performance.now() - pendingRecovery.interruption_detected_at).toFixed(3));
  pendingRecovery.recovery_success = true;
  latencyMetric.textContent = `${Math.round(pendingRecovery.recovery_time_ms)} ms`;
  recordEvent('new_audio_playback_started', { recovery_time_ms: pendingRecovery.recovery_time_ms });
  updateEvaluationSummary();
}

function playRimeAudio(base64Data, audioFormat, taskId) {
  stopAudio();
  const mimeType = audioFormat || 'audio/mp3';
  const audio = new Audio(`data:${mimeType};base64,${base64Data}`);
  activeAudio = audio;
  setState('SPEAKING', 'VOX is speaking with official Rime voice. Interrupt anytime.');
  recordEvent('rime_audio_received', { audio_format: mimeType });
  audio.onended = () => {
    if (taskId !== currentTaskId) return;
    activeAudio = null;
    recordEvent('task_completed', { completed_task_id: taskId });
    setState(isMicActive ? 'LISTENING' : 'IDLE', isMicActive ? 'Listening...' : 'Ready.');
  };
  audio.onerror = () => {
    if (taskId !== currentTaskId) return;
    recordEvent('error', { message: 'Rime audio could not be decoded or played.' });
    activeAudio = null;
    setState(isMicActive ? 'LISTENING' : 'IDLE', 'Audio playback error.');
  };
  audio.play().then(() => {
    if (taskId === currentTaskId && activeAudio === audio) {
      recordEvent('audio_playback_started', { playback_task_id: taskId, provider: 'rime' });
      markRecoveryPlaybackStarted(taskId);
    }
  }).catch(e => {
    if (taskId !== currentTaskId) return;
    recordEvent('error', { message: `Audio playback error: ${e.message}` });
    setState(isMicActive ? 'LISTENING' : 'IDLE', 'Audio playback error.');
  });
}

function speakFallbackVoice(text, taskId) {
  if (!('speechSynthesis' in window)) {
    setState('IDLE', 'Rime unconfigured. Web speech not supported.');
    return;
  }
  stopAudio();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.02;
  utterance.pitch = 1.0;
  utterance.onstart = () => {
    if (taskId !== currentTaskId) return;
    recordEvent('audio_playback_started', { playback_task_id: taskId, provider: 'browser-fallback' });
    markRecoveryPlaybackStarted(taskId);
    setState('SPEAKING', 'VOX is speaking. Speak or click Interrupt anytime.');
  };
  utterance.onend = () => {
    if (taskId !== currentTaskId) return;
    recordEvent('task_completed', { completed_task_id: taskId });
    setState(isMicActive ? 'LISTENING' : 'IDLE', isMicActive ? 'Listening...' : 'Ready.');
  };
  utterance.onerror = () => {
    if (taskId === currentTaskId) setState(isMicActive ? 'LISTENING' : 'IDLE', 'Ready.');
  };
  window.speechSynthesis.speak(utterance);
}

function restartRecognitionSoon() {
  if (!isMicActive || !recognition || recognitionRunning) return;
  clearTimeout(recognitionRestartTimer);
  recognitionRestartTimer = setTimeout(() => {
    if (!isMicActive || recognitionRunning) return;
    try { recognition.start(); } catch (_) {}
  }, 180);
}

function flushFinalTranscript() {
  clearTimeout(finalTranscriptTimer);
  const text = finalTranscriptBuffer.trim();
  finalTranscriptBuffer = '';
  if (text && shouldAcceptUserSpeech(text)) sendQuery(text);
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showError('Speech recognition is not supported. Please use Chrome.');
    return;
  }
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;
  recognition.lang = getSelectedLanguage();

  recognition.onstart = () => {
    recognitionRunning = true;
    recordEvent('speech_recognition_started', { language: recognition.lang });
  };

  recognition.onspeechstart = () => {
    if ((currentState === 'SPEAKING' || currentState === 'THINKING') && performance.now() >= ignoreRecognitionUntil) recordEvent('speech_candidate_detected');
  };

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const result = event.results[i];
      const transcript = result[0].transcript.trim();
      if (result.isFinal) finalTranscript += `${transcript} `;
      else interimTranscript += `${transcript} `;
    }

    const interim = interimTranscript.trim();
    const final = finalTranscript.trim();

    // Barge-in is transcript-driven, not speechstart-driven, so VOX's own audio
    // does not automatically interrupt itself. A short command such as "wait"
    // is still enough to interrupt once the recognizer actually transcribes it.
    if ((currentState === 'SPEAKING' || currentState === 'THINKING') && bargeInHandledForTask !== currentTaskId) {
      const candidate = final || interim;
      if (candidate && shouldAcceptUserSpeech(candidate)) {
        bargeInHandledForTask = currentTaskId;
        interrupt('Voice barge-in detected');
      }
    }

    if (final && shouldAcceptUserSpeech(final)) {
      // Browser recognition can split one sentence into several final chunks.
      // Wait briefly so VOX sends the whole utterance to Ollama instead of
      // answering the first fragment.
      finalTranscriptBuffer = `${finalTranscriptBuffer} ${final}`.trim();
      clearTimeout(finalTranscriptTimer);
      finalTranscriptTimer = setTimeout(flushFinalTranscript, 500);
    }
  };

  recognition.onerror = (event) => {
    recognitionRunning = false;
    if (event.error === 'language-not-supported') {
      showError(`Speech language ${getSelectedLanguage()} is not supported by this browser.`);
    } else if (!['no-speech', 'aborted'].includes(event.error)) {
      console.warn('[VOX] Speech recognition error:', event.error);
      recordEvent('error', { message: `Speech recognition: ${event.error}` });
    }
  };

  recognition.onend = () => {
    recognitionRunning = false;
    if (isMicActive) restartRecognitionSoon();
    else if (currentState === 'LISTENING') setState('IDLE', 'Microphone paused.');
  };
}

function startListening() {
  if (!recognition) setupSpeechRecognition();
  if (!recognition) return;
  isMicActive = true;
  clearError();
  finalTranscriptBuffer = '';
  lastSubmittedTranscript = '';
  const desiredLanguage = getSelectedLanguage();
  if (recognition.lang !== desiredLanguage) recognition.lang = desiredLanguage;
  setState('LISTENING', `Listening in ${desiredLanguage}. Start speaking.`);
  try { if (!recognitionRunning) recognition.start(); } catch (_) {}
}

function stopListening() {
  isMicActive = false;
  clearTimeout(recognitionRestartTimer);
  clearTimeout(finalTranscriptTimer);
  flushFinalTranscript();
  if (recognitionRunning && recognition) {
    try { recognition.stop(); } catch (_) {}
  }
  setState('IDLE', 'Click microphone or run a simulation step.');
}

micBtn.addEventListener('click', () => isMicActive ? stopListening() : startListening());

languageSelect?.addEventListener('change', () => {
  if (!isMicActive || !recognition) return;
  const wasRunning = recognitionRunning;
  try { if (wasRunning) recognition.stop(); } catch (_) {}
  recognition.lang = getSelectedLanguage();
  if (wasRunning) setTimeout(() => { try { recognition.start(); } catch (_) {} }, 220);
  recordEvent('speech_language_changed', { language: recognition.lang });
});

stopBtn.addEventListener('click', () => {
  if (currentState === 'SPEAKING' || currentState === 'THINKING') {
    interrupt('User clicked Interrupt button');
    setTimeout(() => { if (isMicActive) setState('LISTENING', 'Listening for new instruction...'); }, 100);
  }
});

simBtn1?.addEventListener('click', () => sendQuery('Find laptops under ₹60,000'));
simBtn2?.addEventListener('click', () => {
  if (currentState === 'SPEAKING' || currentState === 'THINKING') interrupt('Interrupted with new query');
  setTimeout(() => sendQuery('Actually, make it ₹50,000'), 120);
});

textForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  if (currentState === 'SPEAKING' || currentState === 'THINKING') interrupt('New text command entered');
  setTimeout(() => sendQuery(text), 80);
});

clearBtn?.addEventListener('click', () => {
  transcriptEl.innerHTML = '<div class="msg system">Transcript cleared. Ready for new interaction.</div>';
  latencyMetric.textContent = '-- ms';
});

evalBtn?.addEventListener('click', () => {
  const current = interruptionTrials.find(t => t.new_task_id === currentTaskId && t.recovery_success === null);
  if (!current) return;
  current.recovery_success = false;
  recordEvent('trial_marked_failed', { trial_id: current.trial_id });
  updateEvaluationSummary();
});

exportBtn?.addEventListener('click', exportEvaluation);
setState('IDLE', 'Ready. Ask VOX anything.');
