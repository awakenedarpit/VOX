import os, base64, re, html, json
from pathlib import Path
from collections import deque
import asyncio
import logging
from urllib.parse import unquote

# pyrefly: ignore [missing-import]
from dotenv import load_dotenv
# pyrefly: ignore [missing-import]
from fastapi import FastAPI, File, Form, UploadFile
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
# pyrefly: ignore [missing-import]
from fastapi.staticfiles import StaticFiles
# pyrefly: ignore [missing-import]
from pydantic import BaseModel
import httpx

_env_path = Path(__file__).resolve().parent.parent / '.env'
if _env_path.exists(): load_dotenv(dotenv_path=_env_path, override=True)
else: load_dotenv(override=True)

app = FastAPI(title='VOX API')
logger = logging.getLogger('vox')
UPSTREAM_RETRIES = max(1, int(os.getenv('VOX_UPSTREAM_RETRIES', '3')))
HISTORY_CONTEXT_CHARS = max(4000, int(os.getenv('VOX_HISTORY_CONTEXT_CHARS', '12000')))
_provider_gate = asyncio.Semaphore(2)
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])

class ChatRequest(BaseModel):
    text: str
    task_id: int
    language: str = 'en-IN'
    session_id: str = 'local-demo'

GENERIC_RESPONSES = {'what can i help you with','how can i help you','how can i assist you','what can i do for you','how may i help you','sure, how can i help you'}
LANGUAGE_NAMES = {'en-IN':'English (India)','en-US':'English (US)','hi-IN':'Hindi (India)'}
VOX_ASR_PROMPT = ('VOX technical vocabulary and spelling context: VS Code, Visual Studio Code, Git, GitHub, GitHub Actions, API, REST API, Python, JavaScript, TypeScript, React, FastAPI, HTML, CSS, Ollama, Rime, LiveKit, Whisper, Groq, laptop, tablet, Indore, Ujjain. Preserve technical names, acronyms, numbers, currency, model names, and code terms.')
HISTORY_MESSAGES = max(2, int(os.getenv('VOX_HISTORY_MESSAGES', '30')))
HISTORY_FILE = Path(__file__).resolve().parent / 'data' / 'conversation_history.json'

def _load_conversation_memory() -> dict[str, deque]:
    try:
        raw = json.loads(HISTORY_FILE.read_text(encoding='utf-8')) if HISTORY_FILE.exists() else {}
        return {sid: deque([item for item in turns if isinstance(item, dict) and item.get('role') in {'user', 'assistant'} and isinstance(item.get('content'), str)], maxlen=HISTORY_MESSAGES) for sid, turns in raw.items() if isinstance(sid, str) and isinstance(turns, list)}
    except Exception:
        return {}

def _persist_conversation_memory() -> None:
    try:
        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        payload = {sid: list(turns) for sid, turns in conversation_memory.items()}
        temp = HISTORY_FILE.with_suffix('.tmp')
        temp.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        temp.replace(HISTORY_FILE)
    except Exception:
        pass

conversation_memory: dict[str, deque] = _load_conversation_memory()
FOLLOW_UP_MARKERS = ('actually','instead','make it','change it','change that','update it','keep everything else','same thing','same one','under ','below ','increase it','decrease it','raise it','lower it','remove that','add that','add it','only change','change the budget','change the price')
PRODUCT_TERMS = ('laptop','notebook','macbook','chromebook','tablet','phone','smartphone','monitor','headphones','earbuds','keyboard','mouse','camera','tv','television','watch','smartwatch')
SHOPPING_TERMS = ('find','search','recommend','best','buy','price','cost','under','below','budget','cheapest','available','deal','deals','for sale')

def is_follow_up(text):
    n=' '.join(text.lower().split()); return any(n.startswith(m) or f' {m}' in n for m in FOLLOW_UP_MARKERS)

def is_product_request(text):
    n=text.lower(); return any(t in n for t in PRODUCT_TERMS) and any(t in n for t in SHOPPING_TERMS)

def product_search_query(text):
    return f'{" ".join(text.split())} India price specifications buy'

async def search_products(text: str) -> list[dict]:
    query=product_search_query(text)
    headers={'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36'}
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers=headers) as c:
            r=await c.get('https://html.duckduckgo.com/html/', params={'q':query,'kl':'in-en'})
            r.raise_for_status()
        page=r.text
        items=[]
        for match in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', page, re.S|re.I):
            raw_url=html.unescape(match.group(1)); title=html.unescape(re.sub(r'<[^>]+>','',match.group(2))).strip()
            raw_url=unquote(raw_url)
            if 'uddg=' in raw_url:
                target=re.search(r'[?&]uddg=([^&]+)',raw_url)
                if target: raw_url=unquote(target.group(1))
            start=match.end(); tail=page[start:start+1800]
            sm=re.search(r'class="result__snippet"[^>]*>(.*?)</',tail,re.S|re.I)
            snippet=html.unescape(re.sub(r'<[^>]+>','',sm.group(1))).strip() if sm else ''
            if title and raw_url.startswith('http'): items.append({'title':title[:180],'url':raw_url,'snippet':snippet[:500]})
            if len(items)>=8: break
        return items
    except Exception:
        return []

def remember_turn(session_id,user_text,assistant_text):
    history=conversation_memory.setdefault(session_id or 'local-demo',deque(maxlen=HISTORY_MESSAGES)); history.append({'role':'user','content':user_text})
    if assistant_text: history.append({'role':'assistant','content':assistant_text})
    _persist_conversation_memory()

def memory_snapshot(session_id):
    history=conversation_memory.get(session_id or 'local-demo', deque(maxlen=HISTORY_MESSAGES))
    return {'session_id': session_id or 'local-demo', 'messages': len(history), 'turns': len([item for item in history if item.get('role') == 'user']), 'max_turns': HISTORY_MESSAGES // 2}

def _system_prompt(language):
    return f'''You are VOX, a precise real-time voice assistant. The input is a speech-recognition transcript and may contain small phonetic or homophone errors. Correct only obvious ASR mistakes when meaning is clear. Never invent facts. Preserve names, numbers, units, dates and model names.
Conversation matters. Short follow-ups modify the previous request and inherit unchanged constraints. Never reject a short follow-up.
Answer the CURRENT request directly. Never claim to have searched or accessed live data unless LIVE PRODUCT SEARCH CONTEXT is supplied below. For voice output, use short natural sentences. The user's speech language is {LANGUAGE_NAMES.get(language,language)}. Understand mixed English/Hindi naturally.'''

def _bounded_history(history):
    selected=[]; total=0
    for item in reversed(list(history)[-HISTORY_MESSAGES:]):
        content=str(item.get('content',''))
        if not content: continue
        remaining=max(0, HISTORY_CONTEXT_CHARS-total)
        if remaining <= 0: break
        clipped=content[:remaining]
        selected.append({'role':item.get('role','user'),'content':clipped})
        total += len(clipped)
    return list(reversed(selected))

def build_messages(text,language,session_id,product_context=''):
    messages=[{'role':'system','content':_system_prompt(language)}]
    history=conversation_memory.get(session_id or 'local-demo',deque())
    # Always provide recent conversation context, but keep the request bounded so
    # long product answers do not exhaust the upstream gateway after many turns.
    if history:
        messages.extend(_bounded_history(history))
    if is_follow_up(text) and history:
        messages.append({'role':'system','content':'This is a follow-up to the immediately previous request. Carry forward the previous subject and constraints. If the user says “actually, make it ₹50,000” after asking for laptops under ₹60,000, treat it as the same laptop search with a ₹50,000 limit.'})
    if product_context: messages.append({'role':'system','content':product_context})
    messages.append({'role':'user','content':text.strip()})
    return messages

async def groq_transcribe(audio,filename,language):
    key=os.getenv('GROQ_API_KEY','').strip()
    if not key or key=='your_groq_api_key_here': raise RuntimeError('GROQ_API_KEY is not configured in .env')
    model=os.getenv('GROQ_STT_MODEL','whisper-large-v3').strip(); lang=language.split('-')[0].lower() if language else 'en'
    data={'model':model,'language':lang,'prompt':VOX_ASR_PROMPT,'response_format':'json','temperature':'0'}
    files={'file':(filename or 'vox.webm',audio,'audio/webm')}
    async with httpx.AsyncClient(timeout=30) as c:
        r=await c.post('https://api.groq.com/openai/v1/audio/transcriptions',data=data,files=files,headers={'Authorization':f'Bearer {key}'})
        if r.status_code!=200: raise RuntimeError(f'Groq STT returned HTTP {r.status_code}: {r.text[:300]}')
        return (r.json().get('text') or '').strip()

async def _installed_model(preferred):
    if preferred and preferred not in {'auto','llama3.2:1b'}: return preferred
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r=await c.get('http://127.0.0.1:11434/api/tags'); r.raise_for_status(); names=[m.get('name','') for m in r.json().get('models',[])]
        for candidate in ['qwen2.5:7b','qwen2.5:3b','gemma3:4b','llama3.2:3b','llama3.1:8b','llama3.2:1b']:
            if candidate in names:return candidate
        return names[0] if names else 'llama3.2:1b'
    except Exception:return 'llama3.2:1b'

async def _ollama_chat(messages,model):
    payload={'model':model,'messages':messages,'stream':False,'options':{'temperature':0.2,'top_p':0.9,'repeat_penalty':1.08,'num_ctx':4096}}
    async with httpx.AsyncClient(timeout=45) as c:
        r=await c.post('http://127.0.0.1:11434/api/chat',json=payload); r.raise_for_status(); return (r.json().get('message',{}).get('content') or '').strip()

def _response_error(response, provider):
    content_type=response.headers.get('content-type','').lower()
    if 'html' in content_type or response.text.lstrip().lower().startswith('<!doctype') or response.text.lstrip().lower().startswith('<html'):
        return f'{provider} returned an HTML gateway response (HTTP {response.status_code})'
    try:
        data=response.json()
        detail=data.get('error',{}).get('message') if isinstance(data.get('error'),dict) else data.get('message')
        if detail: return f'{provider} returned HTTP {response.status_code}: {str(detail)[:240]}'
    except Exception:
        pass
    return f'{provider} returned HTTP {response.status_code}: {response.text[:240]}'

async def _chat_completion_request(url, payload, headers, provider, timeout=45):
    last_error=None
    async with _provider_gate:
        for attempt in range(UPSTREAM_RETRIES):
            try:
                async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as c:
                    response=await c.post(url,json=payload,headers=headers)
                if 200 <= response.status_code < 300:
                    try: return response.json()
                    except ValueError as e: raise RuntimeError(f'{provider} returned invalid JSON') from e
                detail=_response_error(response,provider)
                if response.status_code not in {408,425,429} and not 500 <= response.status_code <= 599:
                    raise RuntimeError(detail)
                last_error=RuntimeError(detail)
            except (httpx.ConnectError,httpx.ConnectTimeout,httpx.ReadTimeout,httpx.ReadError,httpx.RemoteProtocolError) as e:
                last_error=RuntimeError(f'{provider} connection interrupted: {type(e).__name__}')
            if attempt < UPSTREAM_RETRIES - 1:
                await asyncio.sleep(0.35 * (2 ** attempt))
    raise last_error or RuntimeError(f'{provider} request failed')

async def _groq_chat(messages):
    key=os.getenv('GROQ_API_KEY','').strip(); model=os.getenv('GROQ_LLM_MODEL','openai/gpt-oss-20b').strip()
    if not key or key=='your_groq_api_key_here': raise RuntimeError('GROQ_API_KEY is not configured')
    payload={'model':model,'messages':messages,'temperature':0.2,'top_p':0.9,'max_completion_tokens':500}
    data=await _chat_completion_request('https://api.groq.com/openai/v1/chat/completions',payload,{'Authorization':f'Bearer {key}','Content-Type':'application/json'},'Groq',30)
    return (data.get('choices',[{}])[0].get('message',{}).get('content') or '').strip()

async def _openai_chat(messages):
    key=os.getenv('OPENAI_API_KEY','').strip()
    base=os.getenv('OPENAI_API_BASE','https://api.openai.com/v1').strip().rstrip('/')
    model=os.getenv('OPENAI_LLM_MODEL','gpt-5-mini').strip()
    if not key or key=='your_openai_api_key_here': raise RuntimeError('OPENAI_API_KEY is not configured')
    payload={'model':model,'messages':messages,'max_completion_tokens':500}
    headers={'Authorization':f'Bearer {key}','Content-Type':'application/json'}
    data=await _chat_completion_request(f'{base}/chat/completions',payload,headers,'OpenAI-compatible provider',45)
    return (data.get('choices',[{}])[0].get('message',{}).get('content') or '').strip()

def _configured_provider():
    provider=os.getenv('LLM_PROVIDER','auto').strip().lower()
    if provider != 'auto': return provider
    if os.getenv('OPENAI_API_KEY','').strip() and os.getenv('OPENAI_API_KEY','').strip() != 'your_openai_api_key_here': return 'openai'
    if os.getenv('GROQ_API_KEY','').strip() and os.getenv('GROQ_API_KEY','').strip() != 'your_groq_api_key_here': return 'groq'
    return 'ollama'

def _clean_voice_answer(a): return a.strip().replace('**','').replace('__','').replace('```','').strip()
def _is_generic(a):
    n=' '.join(a.lower().split()).strip(' .!?'); return not n or n in GENERIC_RESPONSES

async def ask_ollama(text,language='en-IN',session_id='local-demo'):
    search_text=text
    if is_follow_up(text):
        previous=_last_product_context(session_id)
        if previous: search_text=f'{previous}; follow-up constraint: {text}'
    product_context=''
    if is_product_request(search_text):
        products=await search_products(search_text)
        if products:
            lines=['LIVE PRODUCT SEARCH CONTEXT: Current public-web results fetched for this request. Use only facts present in these results. Do not invent prices/specifications. Listings can change.']
            for i,p in enumerate(products,1): lines.append(f'{i}. {p["title"]} | {p["snippet"]} | {p["url"]}')
            product_context='\n'.join(lines)
        else:
            product_context='LIVE PRODUCT SEARCH CONTEXT: No usable public-web results were retrieved. Do not claim to have product listings. Say live listings could not be retrieved.'
    messages=build_messages(text,language,session_id,product_context)
    try:
        provider=_configured_provider()
        async def generate(current_messages):
            if provider == 'openai': return await _openai_chat(current_messages)
            if provider == 'groq': return await _groq_chat(current_messages)
            return await _ollama_chat(current_messages,await _installed_model(os.getenv('OLLAMA_MODEL','auto').strip()))
        answer=_clean_voice_answer(await generate(messages))
        if _is_generic(answer):
            retry=messages+[{'role':'system','content':'Retry: answer the exact request directly. If LIVE PRODUCT SEARCH CONTEXT is present, use it and do not say you cannot access product data.'}]
            answer=_clean_voice_answer(await generate(retry))
        answer=answer or "I couldn't generate a useful answer to that request."; remember_turn(session_id,text.strip(),answer); return answer
    except Exception as e:
        logger.warning('LLM request failed for provider %s: %s', _configured_provider(), str(e)[:300])
        detail=str(e).lower()
        if 'html gateway' in detail or 'connection interrupted' in detail or 'http 502' in detail or 'http 503' in detail or 'http 504' in detail:
            return '[LLM temporarily unavailable: the upstream AI service had a transient gateway problem. Please try again.]'
        return f'[LLM Error: {type(e).__name__} - Check the configured {_configured_provider()} service and model.]'

def _last_product_context(session_id):
    history=conversation_memory.get(session_id or 'local-demo',deque())
    user_turns=[x['content'] for x in history if x.get('role')=='user']
    return next((t for t in reversed(user_turns) if any(p in t.lower() for p in PRODUCT_TERMS)), '')

async def rime_tts(text):
    key=os.getenv('RIME_API_KEY','').strip(); endpoint=os.getenv('RIME_ENDPOINT','https://users.rime.ai/v1/rime-tts').strip(); model=os.getenv('RIME_MODEL','coda').strip(); speaker=os.getenv('RIME_SPEAKER','celeste').strip()
    if not key or key=='your_rime_api_key_here': return None,None,'RIME_API_KEY is not configured in .env'
    headers={'Authorization':f'Bearer {key}','Content-Type':'application/json','Accept':'audio/mp3'}
    payload={'modelId':model,'speaker':speaker,'text':text,'lang':'en'}
    last_error=None
    for attempt in range(UPSTREAM_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=45, follow_redirects=True) as c:
                r=await c.post(endpoint,json=payload,headers=headers)
            if r.status_code != 200:
                detail=_response_error(r,'Rime')
                if r.status_code not in {408,425,429} and not 500 <= r.status_code <= 599: return None,None,detail
                last_error=detail
            else:
                ct=r.headers.get('content-type','audio/mp3')
                if 'audio' in ct or 'mpeg' in ct or 'octet-stream' in ct:return r.content,'audio/mp3',None
                try:
                    data=r.json(); b64=data.get('audio') or data.get('audio_base64')
                    return (base64.b64decode(b64),'audio/mp3',None) if b64 else (None,None,f'Rime returned unexpected JSON format: {list(data.keys())}')
                except Exception:return (r.content,'audio/mp3',None) if r.content else (None,None,'Empty response received from Rime API')
        except (httpx.ConnectError,httpx.ConnectTimeout,httpx.ReadTimeout,httpx.ReadError,httpx.RemoteProtocolError) as e:
            last_error=f'Rime network error: {type(e).__name__}'
        if attempt < UPSTREAM_RETRIES - 1: await asyncio.sleep(0.35 * (2 ** attempt))
    return None,None,last_error or 'Rime synthesis failed after retries'

@app.get('/health')
async def health():
    rime_key=os.getenv('RIME_API_KEY','').strip()
    return {'ok':True,'stt':os.getenv('STT_PROVIDER','groq'),'llm':_configured_provider(),'rime_configured':bool(rime_key and rime_key != 'your_rime_api_key_here'),'product_search':'duckduckgo-web','memory_messages':HISTORY_MESSAGES,'memory_turns':HISTORY_MESSAGES // 2}

@app.get('/memory')
async def memory_status(session_id: str = 'local-demo'):
    return memory_snapshot(session_id)

@app.get('/memory/history')
async def memory_history(session_id: str = 'local-demo'):
    history=conversation_memory.get(session_id or 'local-demo', deque(maxlen=HISTORY_MESSAGES))
    return {'session_id': session_id or 'local-demo', 'history': list(history), **memory_snapshot(session_id)}

@app.delete('/memory')
async def clear_memory(session_id: str = 'local-demo'):
    conversation_memory.pop(session_id or 'local-demo', None)
    _persist_conversation_memory()
    return memory_snapshot(session_id)

@app.post('/transcribe')
async def transcribe(file: UploadFile=File(...),language: str=Form('en-IN')):
    audio=await file.read()
    if not audio:return {'text':'','error':'Empty audio'}
    try:return {'text':await groq_transcribe(audio,file.filename or 'vox.webm',language),'provider':'groq','model':os.getenv('GROQ_STT_MODEL','whisper-large-v3')}
    except Exception as e:return {'text':'','error':str(e),'provider':'groq'}

@app.post('/chat')
async def chat(req: ChatRequest):
    text=await ask_ollama(req.text,req.language,req.session_id); audio_bytes,audio_format,rime_err=await rime_tts(text)
    return {'task_id':req.task_id,'text':text,'audio_base64':base64.b64encode(audio_bytes).decode() if audio_bytes else None,'audio_format':audio_format or 'audio/mp3','rime_error':rime_err,'memory':memory_snapshot(req.session_id)}

FRONTEND_DIR = Path(__file__).resolve().parent.parent / 'frontend'
if FRONTEND_DIR.exists():
    app.mount('/', StaticFiles(directory=FRONTEND_DIR, html=True), name='frontend')
