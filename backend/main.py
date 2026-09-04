import os,base64
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

# Load .env from project root or backend directory
_env_path = Path(__file__).resolve().parent.parent / '.env'
if _env_path.exists():
    load_dotenv(dotenv_path=_env_path, override=True)
else:
    load_dotenv(override=True)

app=FastAPI(title='VOX API')
app.add_middleware(CORSMiddleware,allow_origins=['*'],allow_methods=['*'],allow_headers=['*'])
class ChatRequest(BaseModel): text:str; task_id:int

GENERIC_RESPONSES = {
    'what can i help you with',
    'how can i help you',
    'how can i assist you',
    'what can i do for you',
    'how may i help you',
}

async def _ollama_generate(prompt: str, model: str) -> str:
    async with httpx.AsyncClient(timeout=45) as c:
        r=await c.post('http://127.0.0.1:11434/api/generate',json={'model':model,'prompt':prompt,'stream':False})
        r.raise_for_status()
        return r.json()['response'].strip()

async def ask_ollama(text:str)->str:
    """Generate a direct answer to the user's request.

    The prompt is deliberately explicit because small local models can otherwise
    fall back to a generic assistant greeting instead of answering the question.
    """
    model = os.getenv('OLLAMA_MODEL', 'llama3.2:1b')
    prompt = f'''You are VOX, a real-time voice assistant.

Your job is to answer the user's CURRENT request directly. Do not greet the user.
Do not say "What can I help you with?" or "How can I help?" unless the user
literally asks for help choosing a task.

Rules:
- Answer the actual question or request in the user's message.
- For factual questions, give the useful facts first.
- For lists or recommendations, provide a concise list with the most relevant items.
- If the request is ambiguous, ask one short clarification question instead of giving a generic greeting.
- Never pretend you searched the web or used a tool when you did not.
- Keep the response natural for speech: short sentences, no markdown tables, and no unnecessary preamble.

User's current request:
{text}

VOX response:'''
    try:
        answer = await _ollama_generate(prompt, model)
        normalized = ' '.join(answer.lower().split()).strip(' .!?')
        if not answer or normalized in GENERIC_RESPONSES:
            retry_prompt = f'''Answer this user request directly and concisely.
Do NOT greet the user and do NOT ask what they need help with.
If it is a factual question, answer it. If it asks for places or recommendations,
name the relevant places and briefly explain why they matter.

User request: {text}

Direct answer:'''
            answer = await _ollama_generate(retry_prompt, model)
        return answer or "I couldn't generate an answer to that request."
    except Exception as e:
        return f"[Ollama Error: {type(e).__name__} - Could not connect to local Ollama service. Ensure 'ollama serve' is running.]"

async def rime_tts(text: str):
    key = os.getenv('RIME_API_KEY', '').strip()
    endpoint = os.getenv('RIME_ENDPOINT', 'https://users.rime.ai/v1/rime-tts').strip()
    model = os.getenv('RIME_MODEL', 'coda').strip()
    speaker = os.getenv('RIME_SPEAKER', 'celeste').strip()

    if not key or key == 'your_rime_api_key_here':
        return None, None, "RIME_API_KEY is not configured in .env"

    headers = {
        'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json',
        'Accept': 'audio/mp3',
    }
    payload = {
        'modelId': model,
        'speaker': speaker,
        'text': text,
        'lang': 'en',
    }

    try:
        async with httpx.AsyncClient(timeout=45) as c:
            r = await c.post(endpoint, json=payload, headers=headers)
            content_type = r.headers.get('content-type', 'audio/mp3')
            if r.status_code != 200:
                return None, None, f"Rime API returned HTTP {r.status_code}: {r.text[:200]}"
            
            if 'audio' in content_type or 'mpeg' in content_type or 'octet-stream' in content_type:
                return r.content, 'audio/mp3', None
            
            try:
                data = r.json()
                b64 = data.get('audio') or data.get('audio_base64')
                if b64:
                    return base64.b64decode(b64), 'audio/mp3', None
                return None, None, f"Rime returned unexpected JSON format: {list(data.keys())}"
            except Exception:
                if len(r.content) > 0:
                    return r.content, 'audio/mp3', None
                return None, None, "Empty response received from Rime API"
    except Exception as e:
        return None, None, f"Rime network error: {type(e).__name__} - {str(e)}"

@app.get('/health')
async def health(): return {'ok':True}

@app.post('/chat')
async def chat(req:ChatRequest):
    text = await ask_ollama(req.text)
    audio_bytes, audio_format, rime_err = await rime_tts(text)
    return {
        'task_id': req.task_id,
        'text': text,
        'audio_base64': base64.b64encode(audio_bytes).decode() if audio_bytes else None,
        'audio_format': audio_format or 'audio/mp3',
        'rime_error': rime_err
    }
