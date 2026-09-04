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

let currentTaskId = 0;
let currentState = 'IDLE';
let isMicActive = false;
let recognition = null;
let activeAudio = null;
let currentAbortController = null;
let bargeInHandledForTask = null;
let pendingRecovery = null;

// Evaluation event log. Timestamps are performance.now() values and are only
// used for relative timings within the current browser session.
const evaluationEvents = [];
const interruptionTrials = [];

function recordEvent(type, details = {}) {
  const event = {
    type,
    time_ms: Number(performance.now().toFixed(3)),
    task_id: currentTaskId,
    state: currentState,
    ...details,
  };
  evaluationEvents.push(event);
  updateEvaluationSummary();
  return event;
}

function updateEvaluationSummary() {
  if (!evalSummaryEl) return;
  const completed = interruptionTrials.filter(t => t.recovery_success !== null);
  const successes = completed.filter(t => t.recovery_success).length;
  const stale = completed.reduce((n, t) => n + t.stale_results, 0);
  const recoveryTimes = completed
    .map(t => t.recovery_time_ms)
    .filter(v => Number.isFinite(v));
  const avgRecovery = recoveryTimes.length
    ? Math.round(recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length)
    : null;
  const successRate = completed.length ? Math.round((successes / completed.length) * 100) : null;
  const staleRate = completed.length ? Math.round((stale / completed.length) * 1000) / 10 : null;

  evalSummaryEl.textContent = completed.length
    ? `Trials ${completed.length} · Recovery ${successRate}% · Stale ${staleRate}% · Avg recovery ${avgRecovery ?? '--'} ms`
    : 'No completed interruption trials yet.';
}

function exportEvaluation() {
  const payload = {
    exported_at: new Date().toISOString(),
    note: 'Browser-session evaluation data. Do not treat missing values as zero.',
    trials: interruptionTrials,
    events: evaluationEvents,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vox-evaluation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// UI State Updater
function setState(state, hintText) {
  currentState = state;
  stateEl.textContent = state;
  hintEl.textContent = hintText || '';
  orb.className = 'orb ' + state.toLowerCase();
  stopBtn.hidden = (state !== 'SPEAKING' && state !== 'THINKING');

  if (state === 'LISTENING') {
    micBtn.classList.add('active');
    micBtn.textContent = '⏹️ Stop Listening';
  } else if (state === 'IDLE') {
    if (!isMicActive) {
      micBtn.classList.remove('active');
      micBtn.textContent = '🎤 Start Listening';
    }
  }
  recordEvent('state_changed', { new_state: state });
}

function addMessage(sender, text, taskId, isInterrupted = false) {
  const msg = document.createElement('div');
  msg.className = `msg ${sender}` + (isInterrupted ? ' interrupted-tag' : '');

  const header = document.createElement('div');
  header.className = 'msg-header';
  const senderLabel = sender === 'user' ? 'YOU' : 'VOX';
  header.innerHTML = `<span>${senderLabel}</span><span>Task #${taskId || currentTaskId}</span>`;

  const body = document.createElement('div');
  body.textContent = text;
  if (isInterrupted) {
    body.innerHTML += ' <em style="color:#ff557f;font-size:12px;">(Interrupted)</em>';
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
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
    stopped = true;
  }

  if (window.speechSynthesis && window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    stopped = true;
  }

  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }

  const duration = Math.max(1, Number((performance.now() - t0).toFixed(3)));
  if (stopped) recordEvent('audio_stopped', { stop_duration_ms: duration });
  return { stopped, duration };
}

function beginInterruptionTrial(reason) {
  const detectedAt = performance.now();
  const previousTaskId = currentTaskId;
  const { duration } = stopAudio();
  currentTaskId++;
  taskMetric.textContent = `#${currentTaskId}`;

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
  setState('INTERRUPTED', `${reason}. Stale response discarded.`);
  return currentTaskId;
}

function interrupt(reason = 'Interruption') {
  return beginInterruptionTrial(reason);
}

async function sendQuery(text) {
  clearError();
  const taskId = ++currentTaskId;
  taskMetric.textContent = `#${taskId}`;
  recordEvent('task_created', { task_id_created: taskId, text_length: text.length });
  addMessage('user', text, taskId);
  setState('THINKING', 'VOX is thinking...');

  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();
  recordEvent('ollama_started');

  try {
    const res = await fetch('http://127.0.0.1:8000/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, task_id: taskId }),
      signal: currentAbortController.signal,
    });

    if (!res.ok) throw new Error(`Server returned ${res.status}: ${await res.text()}`);
    const data = await res.json();
    recordEvent('ollama_completed', { response_task_id: data.task_id });

    if (taskId !== currentTaskId) {
      console.log(`[VOX] Discarding stale response from Task #${taskId}. Active task is #${currentTaskId}.`);
      recordEvent('stale_result_discarded', { stale_task_id: taskId, active_task_id: currentTaskId });
      const trial = interruptionTrials.find(t => t.new_task_id === currentTaskId && t.recovery_success === null);
      if (trial) trial.stale_results += 1;
      updateEvaluationSummary();
      return;
    }

    addMessage('vox', data.text, taskId);

    if (data.audio_base64) {
      playRimeAudio(data.audio_base64, data.audio_format, taskId);
    } else {
      if (data.rime_error) console.warn('[VOX] Rime notice:', data.rime_error);
      speakFallbackVoice(data.text, taskId);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log(`[VOX] Request #${taskId} aborted due to interruption.`);
      recordEvent('request_aborted', { aborted_task_id: taskId });
    } else if (taskId === currentTaskId) {
      showError(`Error: ${err.message}`);
      setState('IDLE', 'Could not reach backend. Verify backend is running.');
    }
  }
}

function markRecoveryPlaybackStarted(taskId) {
  if (!pendingRecovery || pendingRecovery.new_task_id !== taskId) return;
  pendingRecovery.recovery_time_ms = Number((performance.now() - pendingRecovery.interruption_detected_at).toFixed(3));
  pendingRecovery.recovery_success = true;
  recordEvent('new_audio_playback_started', { recovery_time_ms: pendingRecovery.recovery_time_ms });
  updateEvaluationSummary();
}

function playRimeAudio(base64Data, audioFormat, taskId) {
  stopAudio();
  const mimeType = audioFormat || 'audio/mp3';
  activeAudio = new Audio(`data:${mimeType};base64,` + base64Data);
  setState('SPEAKING', 'VOX is speaking with official Rime voice. Interrupt anytime.');
  recordEvent('rime_audio_received', { audio_format: mimeType });

  activeAudio.onended = () => {
    if (taskId === currentTaskId) {
      activeAudio = null;
      recordEvent('task_completed', { completed_task_id: taskId });
      setState(isMicActive ? 'LISTENING' : 'IDLE', isMicActive ? 'Listening...' : 'Ready.');
    }
  };

  activeAudio.play().then(() => {
    if (taskId === currentTaskId) {
      recordEvent('audio_playback_started', { playback_task_id: taskId });
      markRecoveryPlaybackStarted(taskId);
    }
  }).catch(e => {
    console.warn('[VOX] Audio play error:', e);
    recordEvent('error', { message: `Audio playback error: ${e.message}` });
    if (taskId === currentTaskId) setState('IDLE', 'Audio playback error.');
  });
}

function speakFallbackVoice(text, taskId) {
  if (!('speechSynthesis' in window)) {
    setState('IDLE', 'Rime unconfigured. Web speech not supported.');
    return;
  }

  stopAudio();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.pitch = 1.0;

  utterance.onstart = () => {
    if (taskId === currentTaskId) {
      recordEvent('audio_playback_started', { playback_task_id: taskId, provider: 'browser-fallback' });
      markRecoveryPlaybackStarted(taskId);
      setState('SPEAKING', 'VOX is speaking. Speak or click Interrupt anytime.');
    }
  };

  utterance.onend = () => {
    if (taskId === currentTaskId) {
      recordEvent('task_completed', { completed_task_id: taskId });
      setState(isMicActive ? 'LISTENING' : 'IDLE', isMicActive ? 'Listening...' : 'Ready.');
    }
  };

  utterance.onerror = () => {
    if (taskId === currentTaskId) setState(isMicActive ? 'LISTENING' : 'IDLE', 'Ready.');
  };

  window.speechSynthesis.speak(utterance);
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showError('Speech recognition is not supported in this browser. Please use Chrome for voice input.');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-IN';

  recognition.onspeechstart = () => {
    if ((currentState === 'SPEAKING' || currentState === 'THINKING') && bargeInHandledForTask !== currentTaskId) {
      bargeInHandledForTask = currentTaskId;
      console.log('[VOX] Voice barge-in detected! Cutting off audio immediately.');
      interrupt('Voice barge-in detected');
    }
  };

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += transcript;
      else interimTranscript += transcript;
    }

    if (interimTranscript && (currentState === 'SPEAKING' || currentState === 'THINKING') && bargeInHandledForTask !== currentTaskId) {
      bargeInHandledForTask = currentTaskId;
      interrupt('Voice detected');
    }

    if (finalTranscript.trim()) sendQuery(finalTranscript.trim());
  };

  recognition.onerror = (event) => {
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.warn('[VOX] Speech recognition error:', event.error);
      recordEvent('error', { message: `Speech recognition: ${event.error}` });
    }
  };

  recognition.onend = () => {
    if (isMicActive) {
      try { recognition.start(); } catch (e) {}
    } else {
      setState('IDLE', 'Microphone paused.');
    }
  };
}

function startListening() {
  if (!recognition) setupSpeechRecognition();
  if (!recognition) return;
  isMicActive = true;
  clearError();
  setState('LISTENING', 'Listening... Start speaking.');
  try { recognition.start(); } catch (e) { console.log('[VOX] Recognition start error or already running:', e); }
}

function stopListening() {
  isMicActive = false;
  if (recognition) {
    try { recognition.stop(); } catch (e) {}
  }
  setState('IDLE', 'Click microphone or run a simulation step.');
}

micBtn.addEventListener('click', () => {
  if (isMicActive) stopListening();
  else startListening();
});

stopBtn.addEventListener('click', () => {
  interrupt('User clicked Interrupt button');
  setTimeout(() => {
    if (isMicActive) setState('LISTENING', 'Listening for new instruction...');
  }, 300);
});

simBtn1.addEventListener('click', () => sendQuery('Find laptops under ₹60,000'));

simBtn2.addEventListener('click', () => {
  interrupt('Interrupted with new query');
  setTimeout(() => sendQuery('Actually, make it ₹50,000'), 100);
});

textForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';

  if (currentState === 'SPEAKING' || currentState === 'THINKING') {
    interrupt('New text command entered');
    setTimeout(() => sendQuery(text), 100);
  } else {
    sendQuery(text);
  }
});

clearBtn.addEventListener('click', () => {
  transcriptEl.innerHTML = '<div class="msg system">Transcript cleared. Ready for new interaction.</div>';
  latencyMetric.textContent = '-- ms';
});

evalBtn?.addEventListener('click', () => {
  const current = interruptionTrials.find(t => t.new_task_id === currentTaskId && t.recovery_success === null);
  if (current) current.recovery_success = false;
  recordEvent('evaluation_snapshot', { completed_trials: interruptionTrials.length });
  updateEvaluationSummary();
});

exportBtn?.addEventListener('click', exportEvaluation);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') interrupt('Escape key pressed');
});

setupSpeechRecognition();
updateEvaluationSummary();
