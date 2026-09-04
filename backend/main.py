import os, base64, re, html
from pathlib import Path
from collections import deque
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
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])

class ChatRequest(BaseModel):
    text: str
    task_id: int
    language: str = 'en-IN'
    session_id: str = 'local-demo'

GENERIC_RESPONSES = {'what can i help you with','how can i help you','how can i assist you','what can i do for you','how may i help you','sure, how can i help you'}
LANGUAGE_NAMES = {'en-IN':'English (India)','en-US':'English (US)','hi-IN':'Hindi (India)'}
VOX_ASR_PROMPT = ('VOX technical vocabulary and spelling context: VS Code, Visual Studio Code, Git, GitHub, GitHub Actions, API, REST API, Python, JavaScript, TypeScript, React, FastAPI, HTML, CSS, Ollama, Rime, LiveKit, Whisper, Groq, laptop, tablet, Indore, Ujjain. Preserve technical names, acronyms, numbers, currency, model names, and code terms.')
conversation_memory: dict[str, deque] = {}
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
    history=conversation_memory.setdefault(session_id or 'local-demo',deque(maxlen=6)); history.append({'role':'user','content':user_text})
    if assistant_text: history.append({'role':'assistant','content':assistant_text})

def _system_prompt(language):
    return f'''You are VOX, a precise real-time voice assistant. The input is a speech-recognition transcript and may contain small phonetic or homophone errors. Correct only obvious ASR mistakes when meaning is clear. Never invent facts. Preserve names, numbers, units, dates and model names.
Conversation matters. Short follow-ups modify the previous request and inherit unchanged constraints. Never reject a short follow-up.
Answer the CURRENT request directly. Never claim to have searched or accessed live data unless LIVE PRODUCT SEARCH CONTEXT is supplied below. For voice output, use short natural sentences. The user's speech language is {LANGUAGE_NAMES.get(language,language)}. Understand mixed English/Hindi naturally.'''

def build_messages(text,language,session_id,product_context=''):
    messages=[{'role':'system','content':_system_prompt(language)}]
    history=conversation_memory.get(session_id or 'local-demo',deque())
    # Always provide recent conversation context, not only obvious follow-ups.
    # This lets VOX answer references such as "what about the second one?"
    # even when the new utterance does not contain a follow-up keyword.
    if history:
        messages.extend(list(history)[-6:])
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

async def _groq_chat(messages):
    key=os.getenv('GROQ_API_KEY','').strip(); model=os.getenv('GROQ_LLM_MODEL','openai/gpt-oss-20b').strip()
    if not key or key=='your_groq_api_key_here': raise RuntimeError('GROQ_API_KEY is not configured')
    payload={'model':model,'messages':messages,'temperature':0.2,'top_p':0.9,'max_completion_tokens':500}
    async with httpx.AsyncClient(timeout=30) as c:
        r=await c.post('https://api.groq.com/openai/v1/chat/completions',json=payload,headers={'Authorization':f'Bearer {key}','Content-Type':'application/json'}); r.raise_for_status(); return (r.json().get('choices',[{}])[0].get('message',{}).get('content') or '').strip()

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
        use_groq=os.getenv('LLM_PROVIDER','ollama').strip().lower()=='groq'
        answer=_clean_voice_answer(await (_groq_chat(messages) if use_groq else _ollama_chat(messages,await _installed_model(os.getenv('OLLAMA_MODEL','auto').strip()))))
        if _is_generic(answer):
            retry=messages+[{'role':'system','content':'Retry: answer the exact request directly. If LIVE PRODUCT SEARCH CONTEXT is present, use it and do not say you cannot access product data.'}]
            answer=_clean_voice_answer(await (_groq_chat(retry) if use_groq else _ollama_chat(retry,await _installed_model(os.getenv('OLLAMA_MODEL','auto').strip()))))
        answer=answer or "I couldn't generate a useful answer to that request."; remember_turn(session_id,text.strip(),answer); return answer
    except Exception as e: return f'[LLM Error: {type(e).__name__} - Check the configured {os.getenv("LLM_PROVIDER","ollama")} service and model.]'

def _last_product_context(session_id):
    history=conversation_memory.get(session_id or 'local-demo',deque())
    user_turns=[x['content'] for x in history if x.get('role')=='user']
    return next((t for t in reversed(user_turns) if any(p in t.lower() for p in PRODUCT_TERMS)), '')

async def rime_tts(text):
    key=os.getenv('RIME_API_KEY','').strip(); endpoint=os.getenv('RIME_ENDPOINT','https://users.rime.ai/v1/rime-tts').strip(); model=os.getenv('RIME_MODEL','coda').strip(); speaker=os.getenv('RIME_SPEAKER','celeste').strip()
    if not key or key=='your_rime_api_key_here': return None,None,'RIME_API_KEY is not configured in .env'
    try:
        async with httpx.AsyncClient(timeout=45) as c:
            r=await c.post(endpoint,json={'modelId':model,'speaker':speaker,'text':text,'lang':'en'},headers={'Authorization':f'Bearer {key}','Content-Type':'application/json','Accept':'audio/mp3'})
            if r.status_code!=200:return None,None,f'Rime API returned HTTP {r.status_code}: {r.text[:200]}'
            ct=r.headers.get('content-type','audio/mp3')
            if 'audio' in ct or 'mpeg' in ct or 'octet-stream' in ct:return r.content,'audio/mp3',None
            try:
                data=r.json(); b64=data.get('audio') or data.get('audio_base64')
                return (base64.b64decode(b64),'audio/mp3',None) if b64 else (None,None,f'Rime returned unexpected JSON format: {list(data.keys())}')
            except Exception:return (r.content,'audio/mp3',None) if r.content else (None,None,'Empty response received from Rime API')
    except Exception as e:return None,None,f'Rime network error: {type(e).__name__} - {str(e)}'

@app.get('/health')
async def health(): return {'ok':True,'stt':os.getenv('STT_PROVIDER','groq'),'llm':os.getenv('LLM_PROVIDER','ollama'),'product_search':'duckduckgo-web'}

@app.post('/transcribe')
async def transcribe(file: UploadFile=File(...),language: str=Form('en-IN')):
    audio=await file.read()
    if not audio:return {'text':'','error':'Empty audio'}
    try:return {'text':await groq_transcribe(audio,file.filename or 'vox.webm',language),'provider':'groq','model':os.getenv('GROQ_STT_MODEL','whisper-large-v3')}
    except Exception as e:return {'text':'','error':str(e),'provider':'groq'}

@app.post('/chat')
async def chat(req: ChatRequest):
    text=await ask_ollama(req.text,req.language,req.session_id); audio_bytes,audio_format,rime_err=await rime_tts(text)
    return {'task_id':req.task_id,'text':text,'audio_base64':base64.b64encode(audio_bytes).decode() if audio_bytes else None,'audio_format':audio_format or 'audio/mp3','rime_error':rime_err}

FRONTEND_DIR = Path(__file__).resolve().parent.parent / 'frontend'
if FRONTEND_DIR.exists():
    app.mount('/', StaticFiles(directory=FRONTEND_DIR, html=True), name='frontend')
