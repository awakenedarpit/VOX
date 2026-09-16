// VOX microphone reliability patch.
// Loaded after script.js so the existing app keeps its interruption/task logic.
// It replaces the fixed VAD sensitivity with an adaptive noise-aware gate.
(function () {
  const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
  if (!NativeAudioContext || !window.AnalyserNode) return;

  const originalCreateAnalyser = NativeAudioContext.prototype.createAnalyser;
  const state = new WeakMap();

  function rmsOf(values) {
    let sum = 0;
    for (const value of values) {
      const sample = (value - 128) / 128;
      sum += sample * sample;
    }
    return Math.sqrt(sum / values.length);
  }

  NativeAudioContext.prototype.createAnalyser = function (...args) {
    const analyser = originalCreateAnalyser.apply(this, args);
    const originalGet = analyser.getByteTimeDomainData.bind(analyser);
    const scratch = new Uint8Array(analyser.fftSize);
    const s = { noise: 0.006, warmupUntil: performance.now() + 450, loudFrames: 0 };
    state.set(analyser, s);

    analyser.getByteTimeDomainData = function (target) {
      originalGet(target);
      originalGet(scratch);
      const rawRms = rmsOf(scratch);
      const now = performance.now();

      if (now < s.warmupUntil) {
        s.noise = s.noise * 0.85 + Math.min(rawRms, 0.08) * 0.15;
      } else if (rawRms < s.noise * 2.2 + 0.003) {
        s.noise = s.noise * 0.97 + rawRms * 0.03;
      }

      // Gate background noise, but amplify genuinely quiet speech enough for
      // the existing VOX detector to see it across different microphones.
      const gate = Math.max(0.004, s.noise * 2.15 + 0.0025);
      const speech = rawRms >= gate;
      if (speech) s.loudFrames = Math.min(4, s.loudFrames + 1);
      else s.loudFrames = Math.max(0, s.loudFrames - 1);

      if (!speech || s.loudFrames < 1) {
        target.fill(128);
        return;
      }

      const gain = Math.min(3.2, Math.max(1, 0.022 / Math.max(rawRms, 0.001)));
      for (let i = 0; i < target.length; i += 1) {
        const centered = (target[i] - 128) * gain;
        target[i] = Math.max(0, Math.min(255, Math.round(128 + centered)));
      }
    };

    return analyser;
  };
})();
