import os, base64
from pathlib import Path
# pyrefly: ignore [missing-import]
from dotenv import load_dotenv
# pyrefly: ignore [missing-import]
from fastapi import FastAPI, File, Form, UploadFile
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
# pyrefly: ignore [missing-import]
from pydantic import BaseModel
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
    'what can i help you with', 'how can i help you', 'how can i assist you',
    'what can i do for you', 'how may i help you', 'sure, how can i help you',
}

LANGUAGE_NAMES = {'en-IN': 'English (India)', 'en-US': 'English (US)', 'hi-IN': 'Hindi (India)'}

VOX_ASR_PROMPT = (
    'VOX technical vocabulary and spelling context: VS Code, Visual Studio Code, Git, GitHub, '
    'GitHub Actions, API, REST API, Python, JavaScript, TypeScript, React, FastAPI, HTML, CSS, '
    'Ollama, Rime, LiveKit, Whisper, Groq, laptop, tablet, Indore, Ujjain. '
    'Preserve technical names, acronyms, numbers, currency, model names, and code terms.'
)

async def groq_transcribe(audio: bytes, filename: str, language: str) -> str:
    key = os.getenv('GROQ_API_KEY', '').strip()
    if not key or key == 'your_groq_api_key_here':
        raise RuntimeError('GROQ_API_KEY is not configured in .env')
    model = os.getenv('GROQ_STT_MODEL', 'whisper-large-v3').strip()
    lang = language.split('-')[0].lower() if language else 'en'
    data = {
        'model': model,
        'language': lang,
        'prompt': VOX_ASR_PROMPT,
        'response_format': 'json',
        'temperature': '0',
    }
    files = {'file': (filename or 'vox.webm', audio, 'audio/webm')}
    headers = {'Authorization': f'Bearer {key}'}
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post('https://api.groq.com/openai/v1/audio/transcriptions', data=data, files=files, headers=headers)
        if r.status_code != 200:
            detail = r.text[:300]
            raise RuntimeError(f'Groq STT returned HTTP {r.status_code}: {detail}')
        return (r.json().get('text') or '').strip()

async def _installed_model(preferred: str) -> str:
    if preferred and preferred not in {'auto', 'llama3.2:1b'}:
        return preferred
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get('http://127.0.0.1:11434/api/tags')
            r.raise_for_status()
            names = [m.get('name', '') for m in r.json().get('models', [])]
        preferred_models = ['qwen2.5:7b', 'qwen2.5:3b', 'gemma3:4b', 'llama3.2:3b', 'llama3.1:8b', 'llama3.2:1b']
        for candidate in preferred_models:
            if candidate in names:
                return candidate
        return names[0] if names else 'llama3.2:1b'
    except Exception:
        return 'llama3.2:1b'

async def _ollama_chat(messages: list[dict], model: str) -> str:
    payload = {
        'model': model,
        'messages': messages,
        'stream': False,
        'options': {'temperature': 0.2, 'top_p': 0.9, 'repeat_penalty': 1.08, 'num_ctx': 4096},
    }
    async with httpx.AsyncClient(timeout=45) as c:
        r = await c.post('http://127.0.0.1:11434/api/chat', json=payload)
        r.raise_for_status()
        return (r.json().get('message', {}).get('content') or '').strip()

async def _groq_chat(messages: list[dict]) -> str:
    key = os.getenv('GROQ_API_KEY', '').strip()
    model = os.getenv('GROQ_LLM_MODEL', 'openai/gpt-oss-20b').strip()
    if not key or key == 'your_groq_api_key_here':
        raise RuntimeError('GROQ_API_KEY is not configured')
    payload = {'model': model, 'messages': messages, 'temperature': 0.2, 'top_p': 0.9, 'max_completion_tokens': 500}
    headers = {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post('https://api.groq.com/openai/v1/chat/completions', json=payload, headers=headers)
        r.raise_for_status()
        return (r.json().get('choices', [{}])[0].get('message', {}).get('content') or '').strip()


def _clean_voice_answer(answer: str) -> str:
    return answer.strip().replace('**', '').replace('__', '').replace('```', '').strip()


def _is_generic(answer: str) -> bool:
    normalized = ' '.join(answer.lower().split()).strip(' .!?')
    return not normalized or normalized in GENERIC_RESPONSES


def _system_prompt(language: str) -> str:
    language_name = LANGUAGE_NAMES.get(language, language)
    return f'''You are VOX, a precise real-time voice assistant.
The input is a speech-recognition transcript and may contain small phonetic or homophone errors.
Correct only an obvious ASR mistake when the intended meaning is clear. Never invent missing facts.
Preserve proper nouns, place names, numbers, units, dates, model names, acronyms, and code terms.
If a critical word is genuinely unclear, ask one short clarification.

Answer the CURRENT request directly. Never begin with a generic greeting or an offer to help.
Do not describe hidden reasoning. Do not claim to have searched or used a tool unless one was used.
The user's speech language is {language_name}. Understand mixed English/Hindi naturally.
For voice output, use short natural sentences. Give the key answer first.'''

async def ask_ollama(text: str, language: str = 'en-IN') -> str:
    messages = [{'role': 'system', 'content': _system_prompt(language)}, {'role': 'user', 'content': text.strip()}]
    try:
        use_groq = os.getenv('LLM_PROVIDER', 'ollama').strip().lower() == 'groq'
        if use_groq:
            answer = _clean_voice_answer(await _groq_chat(messages))
        else:
            model = await _installed_model(os.getenv('OLLAMA_MODEL', 'auto').strip())
            answer = _clean_voice_answer(await _ollama_chat(messages, model))
        if _is_generic(answer):
            retry = [
                {'role': 'system', 'content': _system_prompt(language) + '\nThis is a retry: answer the exact user sentence now. Do not say you are ready to help.'},
                {'role': 'user', 'content': text.strip()},
            ]
            answer = _clean_voice_answer(await (_groq_chat(retry) if use_groq else _ollama_chat(retry, await _installed_model(os.getenv('OLLAMA_MODEL', 'auto').strip()))))
        return answer or "I couldn't generate a useful answer to that request."
    except Exception as e:
        return f"[LLM Error: {type(e).__name__} - Check the configured {os.getenv('LLM_PROVIDER', 'ollama')} service and model.]"

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
                return (r.content, 'audio/mp3', None) if r.content else (None, None, 'Empty response received from Rime API')
    except Exception as e:
        return None, None, f'Rime network error: {type(e).__name__} - {str(e)}'

@app.get('/health')
async def health():
    return {'ok': True, 'stt': os.getenv('STT_PROVIDER', 'browser'), 'llm': os.getenv('LLM_PROVIDER', 'ollama')}

@app.post('/transcribe')
async def transcribe(file: UploadFile = File(...), language: str = Form('en-IN')):
    audio = await file.read()
    if not audio:
        return {'text': '', 'error': 'Empty audio'}
    try:
        text = await groq_transcribe(audio, file.filename or 'vox.webm', language)
        return {'text': text, 'provider': 'groq', 'model': os.getenv('GROQ_STT_MODEL', 'whisper-large-v3')}
    except Exception as e:
        return {'text': '', 'error': str(e), 'provider': 'groq'}

@app.post('/chat')
async def chat(req: ChatRequest):
    text = await ask_ollama(req.text, req.language)
    audio_bytes, audio_format, rime_err = await rime_tts(text)
    return {'task_id': req.task_id, 'text': text, 'audio_base64': base64.b64encode(audio_bytes).decode() if audio_bytes else None, 'audio_format': audio_format or 'audio/mp3', 'rime_error': rime_err}
