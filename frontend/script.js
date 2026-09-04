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

let currentTaskId = 0;
let currentState = 'IDLE';
let isMicActive = false;
let recognition = null;
let activeAudio = null;
let currentAbortController = null;
let lastInterruptTime = null;

// UI State Updater
function setState(state, hintText) {
  currentState = state;
  stateEl.textContent = state;
  hintEl.textContent = hintText || '';
  orb.className = 'orb ' + state.toLowerCase();
  
  // Show manual interrupt button if VOX is talking or thinking
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
}

// Add message to transcript
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
}

function clearError() {
  errEl.hidden = true;
  errEl.textContent = '';
}

// Immediate audio cutoff
function stopAudio() {
  const t0 = performance.now();
  let stopped = false;

  // 1. Stop HTML5 Audio if playing
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
    stopped = true;
  }

  // 2. Stop Browser SpeechSynthesis if speaking
  if (window.speechSynthesis && window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    stopped = true;
  }

  // 3. Abort pending HTTP requests
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
    stopped = true;
  }

  const duration = Math.max(1, Math.round(performance.now() - t0));
  return { stopped, duration };
}

// Invalidate existing task and stop playback
function interrupt(reason = 'Interruption') {
  const { duration } = stopAudio();
  currentTaskId++;
  taskMetric.textContent = `#${currentTaskId}`;
  latencyMetric.textContent = `${duration} ms`;

  setState('INTERRUPTED', `${reason}. Stale response discarded.`);
  return currentTaskId;
}

// Send user request to backend
async function sendQuery(text) {
  clearError();
  const taskId = ++currentTaskId;
  taskMetric.textContent = `#${taskId}`;
  
  addMessage('user', text, taskId);
  setState('THINKING', 'VOX is thinking...');

  // Setup abort controller for this specific request
  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();

  try {
    const res = await fetch('http://127.0.0.1:8000/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, task_id: taskId }),
      signal: currentAbortController.signal
    });

    if (!res.ok) throw new Error(`Server returned ${res.status}: ${await res.text()}`);
    const data = await res.json();

    // Stale check: if another request started in the meantime, discard this response
    if (taskId !== currentTaskId) {
      console.log(`[VOX] Discarding stale response from Task #${taskId}. Active task is #${currentTaskId}.`);
      return;
    }

    addMessage('vox', data.text, taskId);

    // Speak audio (Rime audio if available, otherwise local browser voice fallback)
    if (data.audio_base64) {
      playRimeAudio(data.audio_base64, data.audio_format, taskId);
    } else {
      if (data.rime_error) {
        console.warn('[VOX] Rime notice:', data.rime_error);
      }
      speakFallbackVoice(data.text, taskId);
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      console.log(`[VOX] Request #${taskId} aborted due to interruption.`);
    } else if (taskId === currentTaskId) {
      showError(`Error: ${err.message}`);
      setState('IDLE', 'Could not reach backend. Verify backend is running.');
    }
  }
}

// Play real Rime audio from Base64
function playRimeAudio(base64Data, audioFormat, taskId) {
  stopAudio();
  const mimeType = audioFormat || 'audio/mp3';
  activeAudio = new Audio(`data:${mimeType};base64,` + base64Data);
  setState('SPEAKING', 'VOX is speaking with official Rime voice. Interrupt anytime.');

  activeAudio.onended = () => {
    if (taskId === currentTaskId) {
      activeAudio = null;
      setState(isMicActive ? 'LISTENING' : 'IDLE', isMicActive ? 'Listening...' : 'Ready.');
    }
  };

  activeAudio.play().catch(e => {
    console.warn('[VOX] Audio play error:', e);
    setState('IDLE', 'Audio playback error.');
  });
}

// Fallback TTS when Rime credentials are not yet configured
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
      setState('SPEAKING', 'VOX is speaking. Speak or click Interrupt anytime.');
    }
  };

  utterance.onend = () => {
    if (taskId === currentTaskId) {
      setState(isMicActive ? 'LISTENING' : 'IDLE', isMicActive ? 'Listening...' : 'Ready.');
    }
  };

  utterance.onerror = () => {
    if (taskId === currentTaskId) {
      setState(isMicActive ? 'LISTENING' : 'IDLE', 'Ready.');
    }
  };

  window.speechSynthesis.speak(utterance);
}

// Speech Recognition & Barge-In
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

  // Voice barge-in detection: speech started while VOX is speaking or thinking
  recognition.onspeechstart = () => {
    if (currentState === 'SPEAKING' || currentState === 'THINKING') {
      console.log('[VOX] Voice barge-in detected! Cutting off audio immediately.');
      interrupt('Voice barge-in detected');
    }
  };

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }

    // If interim words are detected while speaking, trigger immediate interrupt
    if (interimTranscript && (currentState === 'SPEAKING' || currentState === 'THINKING')) {
      interrupt('Voice detected');
    }

    // When user finishes speaking the utterance
    if (finalTranscript.trim()) {
      sendQuery(finalTranscript.trim());
    }
  };

  recognition.onerror = (event) => {
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.warn('[VOX] Speech recognition error:', event.error);
    }
  };

  recognition.onend = () => {
    // Keep listening if user hasn't explicitly clicked stop
    if (isMicActive) {
      try {
        recognition.start();
      } catch (e) {
        // already started or transitioning
      }
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
  try {
    recognition.start();
  } catch (e) {
    console.log('[VOX] Recognition start error or already running:', e);
  }
}

function stopListening() {
  isMicActive = false;
  if (recognition) {
    try { recognition.stop(); } catch (e) {}
  }
  setState('IDLE', 'Click microphone or run a simulation step.');
}

// Event Listeners
micBtn.addEventListener('click', () => {
  if (isMicActive) {
    stopListening();
  } else {
    startListening();
  }
});

stopBtn.addEventListener('click', () => {
  interrupt('User clicked Interrupt button');
  setTimeout(() => {
    if (isMicActive) setState('LISTENING', 'Listening for new instruction...');
  }, 300);
});

// Acceptance Test Simulation Buttons
simBtn1.addEventListener('click', () => {
  sendQuery('Find laptops under ₹60,000');
});

simBtn2.addEventListener('click', () => {
  // Simulate immediate interruption & new query
  interrupt('Interrupted with new query');
  setTimeout(() => {
    sendQuery('Actually, make it ₹50,000');
  }, 100);
});

// Text Form Submission
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

// Keyboard Shortcut: Escape to interrupt
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    interrupt('Escape key pressed');
  }
});

// Initialize on page load
setupSpeechRecognition();