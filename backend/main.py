import os, base64
from pathlib import Path
from typing import Optional
# pyrefly: ignore [missing-import]
from dotenv import load_dotenv
# pyrefly: ignore [missing-import]
from fastapi import FastAPI
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
# pyrefly: ignore [missing-import]
from pydantic import BaseModel
# pyrefly: ignore [missing-import]
import httpx

_env_path = Path(__file__).resolve().parent.parent / '.env'
if _env_path.exists():
    load_dotenv(dotenv_path=_env_path, override=True)
else:
    load_dotenv(override=True)

app = FastAPI(title='VOX API')
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])

class ChatRequest(BaseModel):
    text: str
    task_id: int
    language: str = 'en-IN'

GENERIC_RESPONSES = {
    'what can i help you with',
    'how can i help you',
    'how can i assist you',
    'what can i do for you',
    'how may i help you',
    'sure, how can i help you',
}

LANGUAGE_NAMES = {
    'en-IN': 'English (India)',
    'en-US': 'English (US)',
    'hi-IN': 'Hindi (India)',
}

async def _ollama_chat(messages: list[dict], model: str) -> str:
    payload = {
        'model': model,
        'messages': messages,
        'stream': False,
        'options': {
            'temperature': 0.2,
            'top_p': 0.9,
            'repeat_penalty': 1.08,
            'num_ctx': 4096,
        },
    }
    async with httpx.AsyncClient(timeout=45) as c:
        r = await c.post('http://127.0.0.1:11434/api/chat', json=payload)
        r.raise_for_status()
        data = r.json()
        return (data.get('message', {}).get('content') or '').strip()


def _clean_voice_answer(answer: str) -> str:
    answer = answer.strip()
    # Small local models sometimes wrap an otherwise good spoken answer in markdown.
    answer = answer.replace('**', '').replace('__', '')
    answer = answer.replace('```', '')
    return answer.strip()


def _is_generic(answer: str) -> bool:
    normalized = ' '.join(answer.lower().split()).strip(' .!?')
    return not normalized or normalized in GENERIC_RESPONSES

async def ask_ollama(text: str, language: str = 'en-IN') -> str:
    """Answer the current request while compensating conservatively for ASR noise."""
    model = os.getenv('OLLAMA_MODEL', 'llama3.2:3b')
    language_name = LANGUAGE_NAMES.get(language, language)

    system = f'''You are VOX, a precise real-time voice assistant.
The input below is a speech-recognition transcript, so it can contain small phonetic
or homophone errors. Correct only obvious ASR mistakes when the intended meaning is
clear from context. Never invent missing facts or silently change the user's request.
Preserve proper nouns, place names, numbers, units, dates, and named entities exactly
when they are clear. If a critical word is genuinely unclear, ask one short clarification.

Answer the CURRENT request directly. Never start with a generic greeting or "What can I
help you with?". Do not describe your internal reasoning. Do not claim to have searched
or used a tool unless a tool was actually used.

The user's selected speech language is {language_name}. If the user speaks a mix of
English and Hindi, understand the meaning rather than translating everything unless asked.

For voice output: use short natural sentences, pronounceable punctuation, and compact
answers. For factual questions, give the key facts first. For comparisons, state the
comparison directly. For recommendations, give a useful shortlist with brief reasons.'''

    messages = [
        {'role': 'system', 'content': system},
        {'role': 'user', 'content': text.strip()},
    ]

    try:
        answer = _clean_voice_answer(await _ollama_chat(messages, model))
        if _is_generic(answer):
            retry_messages = [
                {'role': 'system', 'content': 'Answer the user directly. No greeting. No generic offer of help. If the transcript contains an obvious speech-recognition error, infer the correction only when context makes it clear. Keep the answer concise and factual.'},
                {'role': 'user', 'content': text.strip()},
            ]
            answer = _clean_voice_answer(await _ollama_chat(retry_messages, model))
        return answer or "I couldn't generate a useful answer to that request."
    except Exception as e:
        return f"[Ollama Error: {type(e).__name__} - Could not connect to local Ollama service. Ensure 'ollama serve' is running and that OLLAMA_MODEL is installed.]"

async def rime_tts(text: str):
    key = os.getenv('RIME_API_KEY', '').strip()
    endpoint = os.getenv('RIME_ENDPOINT', 'https://users.rime.ai/v1/rime-tts').strip()
    model = os.getenv('RIME_MODEL', 'coda').strip()
    speaker = os.getenv('RIME_SPEAKER', 'celeste').strip()

    if not key or key == 'your_rime_api_key_here':
        return None, None, 'RIME_API_KEY is not configured in .env'

    headers = {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'Accept': 'audio/mp3'}
    payload = {'modelId': model, 'speaker': speaker, 'text': text, 'lang': 'en'}

    try:
        async with httpx.AsyncClient(timeout=45) as c:
            r = await c.post(endpoint, json=payload, headers=headers)
            content_type = r.headers.get('content-type', 'audio/mp3')
            if r.status_code != 200:
                return None, None, f'Rime API returned HTTP {r.status_code}: {r.text[:200]}'
            if 'audio' in content_type or 'mpeg' in content_type or 'octet-stream' in content_type:
                return r.content, 'audio/mp3', None
            try:
                data = r.json()
                b64 = data.get('audio') or data.get('audio_base64')
                if b64:
                    return base64.b64decode(b64), 'audio/mp3', None
                return None, None, f"Rime returned unexpected JSON format: {list(data.keys())}"
            except Exception:
                if r.content:
                    return r.content, 'audio/mp3', None
                return None, None, 'Empty response received from Rime API'
    except Exception as e:
        return None, None, f'Rime network error: {type(e).__name__} - {str(e)}'

@app.get('/health')
async def health():
    return {'ok': True}

@app.post('/chat')
async def chat(req: ChatRequest):
    text = await ask_ollama(req.text, req.language)
    audio_bytes, audio_format, rime_err = await rime_tts(text)
    return {
        'task_id': req.task_id,
        'text': text,
        'audio_base64': base64.b64encode(audio_bytes).decode() if audio_bytes else None,
        'audio_format': audio_format or 'audio/mp3',
        'rime_error': rime_err,
    }
