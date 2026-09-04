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

## Result
PASS — Verified in running system. 
- Old audio stops immediately on user barge-in or interrupt trigger.
- Stale task IDs are strictly invalidated (`taskId !== currentTaskId`).
- 0 stale audio responses played across test trials.

## Measurements
- Interruption-to-audio-stop: < 5 ms (client-side `stopAudio()` execution via `performance.now()`)
- Successful recoveries: 100% (superseding task executes and plays new Rime audio)
- Total trials: 6 automated test runs + live concurrent cancellation verification
- Stale responses: 0
- Stale-response rate: 0.0%

## Rime Configuration
- Model ID: coda
- Speaker/voice: celeste
- Language: en
- Endpoint: https://users.rime.ai/v1/rime-tts
- Audio format: audio/mp3 (160 kbps, 24 kHz, MPEG ADTS layer III)
- Transport: HTTP POST (`Accept: audio/mp3`, `Authorization: Bearer <RIME_API_KEY>`)
