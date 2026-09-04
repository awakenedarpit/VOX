// VOX microphone diagnostics. Loaded after script.js.
(function () {
  const micBtn = document.getElementById('mic');
  const hintEl = document.getElementById('hint');
  if (!micBtn || !hintEl) return;

  const originalGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (!originalGetUserMedia) return;

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const stream = await originalGetUserMedia(constraints);
    const track = stream.getAudioTracks()[0];
    if (track) {
      const settings = track.getSettings ? track.getSettings() : {};
      window.dispatchEvent(new CustomEvent('vox-mic-ready', { detail: {
        label: track.label || 'Microphone',
        sample_rate: settings.sampleRate || null,
        channel_count: settings.channelCount || null,
      }}));
    }
    return stream;
  };

  window.addEventListener('vox-mic-ready', (event) => {
    const d = event.detail || {};
    const label = d.label && d.label.length > 42 ? `${d.label.slice(0, 42)}…` : (d.label || 'Microphone');
    hintEl.textContent = `Microphone ready: ${label}. Speak naturally, then pause briefly.`;
  });
})();
