# VOX — Interruptible Real-Time AI Voice Assistant

VOX is a voice-native prototype focused on **interruption and recovery**.

Flow: microphone → speech recognition → FastAPI → AI → Rime TTS → audio.

## Core behavior
When the user changes a request while VOX is responding, the old task is invalidated and its result must not be played.

## Setup
Requirements: Python 3.10+, Chrome recommended, Ollama for local AI, and Rime access for real voice output.

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

The FastAPI app serves both the API and the frontend from the same origin. Open:

`http://localhost:8000`

Do not start a separate frontend server on port 5500; the frontend resolves its API relative to the single port-8000 origin.

When VOX is launched inside a remote sandbox, `localhost:8000` is local to that sandbox and is not reachable from the user's own computer. Use the sandbox's forwarded/public port-8000 URL to open it externally. If running on your own computer, run the command above there and then open `http://localhost:8000` in that same computer's browser.

Copy `.env.example` to `.env` and add real Rime configuration. Never commit `.env`.

## Verified Rime Configuration

The following configuration is the configuration currently documented for the working prototype. Re-verify it against the active Rime account/configuration before submission if it changes.

- Endpoint: `https://users.rime.ai/v1/rime-tts`
- Model ID: `coda`
- Speaker: `celeste`
- Audio Format: `audio/mp3` (160 kbps, 24 kHz)
- Transport: HTTP/POST (`Accept: audio/mp3`, `Authorization: Bearer <RIME_API_KEY>`)

## Acceptance test

Ask “Find laptops under ₹60,000.” Let VOX speak, then interrupt with “Actually, make it ₹50,000.” Verify old audio stops, the newer request wins, and no stale result is spoken.

## Testing

Deterministic tests do not require Ollama, Rime, a browser, or network access:

```bash
python3 -m unittest tests/test_interruption.py
```

Live backend/Rime checks are available separately and require a running backend plus valid local Rime configuration:

```bash
VOX_LIVE_TESTS=1 python3 -m unittest tests/test_interruption.py
```

See `TESTING.md` for the manual acceptance procedure and metric definitions. Do not report measurements that have not actually been observed and recorded.
