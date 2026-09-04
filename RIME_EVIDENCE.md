# Rime Evidence

## Hard Claim
During an active response, the user can interrupt with a changed instruction; current speech stops and the previous task becomes obsolete.

## Acceptance Test
1. Ask: “Find laptops under ₹60,000.”
2. Wait until VOX speaks.
3. Interrupt: “Actually, make it ₹50,000.”
4. Verify old audio stops.
5. Verify the latest instruction wins.
6. Verify no stale response resumes.

## Current Result
**Manual verification: PASS.** The working prototype has been manually tested with the laptop-budget change scenario. The UI also exposes a manual interrupt control and the implementation invalidates the active task before processing the replacement request.

Automated deterministic checks are included in `tests/test_interruption.py`. They must be run locally before submission; this document intentionally does not claim a test count or performance number that has not been recorded from an actual run.

## Measurements

Record measured values here after running the procedure in `TESTING.md`:

- Interruption-to-audio-stop: **TBD — measure and record actual value**
- Successful recoveries: **TBD — record successful trials / total trials**
- Total trials: **TBD**
- Stale responses played: **TBD**
- Stale-response rate: **TBD**
- Recovery time: **TBD**

Do not substitute implementation timing for end-to-end user-perceived latency. The `stopAudio()` client timing is only an internal execution measurement and should not be presented as complete acoustic latency.

## Rime Configuration

- Model ID: coda
- Speaker/voice: celeste
- Language: en
- Endpoint: https://users.rime.ai/v1/rime-tts
- Audio format: audio/mp3 (160 kbps, 24 kHz, MPEG ADTS layer III)
- Transport: HTTP POST (`Accept: audio/mp3`, `Authorization: Bearer <RIME_API_KEY>`)

Re-verify these values against the active Rime account/configuration before final submission if the deployed configuration changes.
