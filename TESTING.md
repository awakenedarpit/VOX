# VOX Testing & Evaluation

This document defines the reproducible checks for VOX's core claim: when a user changes a request while VOX is responding, the obsolete task must not produce the final spoken response.

## 1. Deterministic automated tests

Run from the repository root:

```bash
python3 -m unittest tests/test_interruption.py
```

These tests do not require Ollama, a Rime API key, a browser, or network access. They verify:

- task IDs increase monotonically;
- stale task results are rejected;
- an interrupted task cannot win over the newer task;
- repeated interruptions leave only the latest task eligible;
- sequential task IDs are unique.

The live backend/Rime checks in the same file are skipped unless `VOX_LIVE_TESTS=1` is explicitly set.

## 2. Live integration checks

With the VOX backend running and a valid local `.env` configuration:

```bash
VOX_LIVE_TESTS=1 python3 -m unittest tests/test_interruption.py
```

The live checks cover `/health`, task ID preservation in `/chat`, and real Rime audio returned by the backend.

Never commit `.env` or expose the Rime API key.

## 3. Manual acceptance test

1. Start the backend and frontend.
2. Start microphone listening in Chrome.
3. Ask: `Find laptops under ₹60,000.`
4. Wait until VOX is speaking.
5. Interrupt with: `Actually, make it ₹50,000.`
6. Confirm the old speech stops.
7. Confirm the second request becomes the active task.
8. Confirm the old response does not resume or replace the new response.

Repeat the test several times and record the number of successful recoveries and stale responses. Report actual observations only.

## 4. Metrics

For a defensible hackathon result, record:

| Metric | Definition |
|---|---|
| Interruption-to-audio-stop | Time from interruption detection to the client requesting/stopping active audio. |
| Recovery time | Time from interruption detection to playback of the new task. |
| Recovery success rate | Successful superseding responses / interruption trials. |
| Stale-response rate | Stale responses played / interruption trials. |
| Test failure rate | Failed trials / total trials. |

Do not report a metric unless the measurement procedure and number of trials are recorded.

## 5. Evidence requirements

For the Rime submission, keep the following in `RIME_EVIDENCE.md`:

- the exact hard claim;
- the acceptance test;
- the verified Rime model, speaker, endpoint, transport, and audio format;
- the measurement procedure;
- measured results;
- limitations and failure behavior.

Manual observations, deterministic local tests, and live Rime tests should be clearly distinguished.
