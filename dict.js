/* =========================================================================
   Brick by Brick Reader — word lookup.

   Two layers, in this order:
     1. an offline dictionary kept in IndexedDB (downloaded once, then the
        phone never needs a connection again, and no word ever leaves it);
     2. a free online dictionary, asked only when a word is not in layer 1
        and only if the reader has allowed it. Answers from it are kept, so
        the same word works offline next time.

   The offline file is plain text, gzipped, one JSON value per line:
       {"v":1,"name":"...","license":"...","words":123456}      <- header
       ["abandon",[["v","to leave behind"],["n","a total lack of..."]]]
       ...
       {"exc":{"ran":"run","mice":"mouse"}}                      <- last line
   It is streamed in and written into IndexedDB in small groups, keyed by the
   first three letters of the word, so a 150,000-word dictionary is a few hundred
   database writes rather than 150,000 of them (seconds instead of minutes on a
   phone) and never has to sit in memory in one piece.
   ========================================================================= */

export const DICT_URL  = './dict/en-v1.jsonl.gz';
export const API_HOST  = 'api.dictionaryapi.dev';
const API_URL = 'https://' + API_HOST + '/api/v2/entries/en/';

let getDB = null;
/* index.html owns the database connection; it hands it over on first use. */
export function configure(dbFn){ getDB = dbFn; }

/* ------------------------------------------------------------------ store */
function tx(stores, mode){
  return getDB().then(d => d.transaction(stores, mode));
}
function req(r){ return new Promise((res,rej)=>{ r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }

/* words are grouped by their first three letters (a few thousand small groups:
   quick to write at install time, quick to read back at lookup time) */
export function bucketOf(w){ return w.slice(0,3) || '_'; }
const bucketCache = new Map();          // a handful of recent groups, for speed

async function getBucket(b){
  if(bucketCache.has(b)) return bucketCache.get(b);
  let rec = null;
  const t = await tx('dict','readonly');
  rec = await req(t.objectStore('dict').get(b));
  const map = (rec && rec.w) || null;
  bucketCache.set(b, map);
  if(bucketCache.size > 8) bucketCache.delete(bucketCache.keys().next().value);
  return map;
}
async function getWord(w){
  const map = await getBucket(bucketOf(w));
  if(map && map[w]) return { s: map[w] };
  // words looked up online live in their own store, so installing or
  // reinstalling the offline dictionary never throws them away
  const t = await tx('dictnet','readonly');
  return req(t.objectStore('dictnet').get(w));
}
async function getMeta(k){
  const t = await tx('dictmeta','readonly');
  return req(t.objectStore('dictmeta').get(k));
}
async function putMeta(v){
  const t = await tx('dictmeta','readwrite');
  t.objectStore('dictmeta').put(v);
  return new Promise((res,rej)=>{ t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); });
}

/* --------------------------------------------------------------- normalise */
const CURLY = /[\u2018\u2019\u02bc]/g;
export function normalize(raw){
  let s = String(raw||'').replace(CURLY,"'").toLowerCase();
  s = s.replace(/[\u00ad\u200b]/g,'');            // soft hyphens, zero-width
  s = s.replace(/\s+/g,' ').trim();
  s = s.replace(/^[^\p{L}\p{N}]+/u,'').replace(/[^\p{L}\p{N}.']+$/u,'');
  s = s.replace(/'s$/,'').replace(/s'$/,'s');     // possessives
  s = s.replace(/\.$/,'');                        // trailing full stop
  return s;
}

/* ------------------------------------------------------------- morphology */
/* WordNet's own approach: a list of irregular forms (shipped with the data)
   plus these suffix rules, tried until one lands on a word we have. */
const RULES = [
  ['ses','s'], ['xes','x'], ['zes','z'], ['ches','ch'], ['shes','sh'],
  ['ies','y'], ['ves','f'], ['ves','fe'], ['men','man'], ['s',''],
  ['ied','y'], ['ed','e'], ['ed',''], ['ing','e'], ['ing',''],
  ['er','e'], ['er',''], ['est','e'], ['est',''],
  ['ly',''], ['ily','y']
];
let excMap = null;
async function exceptions(){
  if(excMap) return excMap;
  const m = await getMeta('exc');
  excMap = (m && m.map) || {};
  return excMap;
}
export async function candidates(word){
  const out = [word];
  const exc = await exceptions();
  if(exc[word]) out.push(exc[word]);
  for(const [suf,rep] of RULES){
    if(word.length > suf.length + 1 && word.endsWith(suf)){
      const stem = word.slice(0, word.length - suf.length) + rep;
      if(stem.length > 1) out.push(stem);
      // doubled consonant: stopped -> stop, running -> run
      if((suf==='ed'||suf==='ing'||suf==='er'||suf==='est') && rep===''){
        const m = stem.match(/([b-df-hj-np-tv-z])\1$/);
        if(m) out.push(stem.slice(0,-1));
      }
    }
  }
  if(word.includes('-')) out.push(word.replace(/-/g,''), word.replace(/-/g,' '));
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ lookup */
const POS = { n:'noun', v:'verb', a:'adjective', s:'adjective', r:'adverb' };
export function posName(p){ return POS[p] || p || ''; }

/* Returns { word, lemma, senses:[{pos,def,ex}], source, found }
   source: 'offline' | 'saved' | 'online' | ''                              */
export async function lookup(raw, opts){
  const o = opts || {};
  const word = normalize(raw);
  if(!word) return { word:'', lemma:'', senses:[], source:'', found:false };

  const forms = await candidates(word);
  for(const f of forms){
    let rec = null;
    try{ rec = await getWord(f); }catch(e){ /* database unavailable */ }
    if(rec && rec.s && rec.s.length){
      return { word, lemma:f, senses:rec.s.map(x=>({pos:x[0], def:x[1], ex:x[2]||''})),
               source: rec.o ? 'saved' : 'offline', found:true };
    }
  }
  if(o.online && navigator.onLine !== false){
    const on = await online(word);
    if(on.found) return on;
    if(on.error) return { word, lemma:word, senses:[], source:'', found:false, error:on.error };
  }
  return { word, lemma:word, senses:[], source:'', found:false };
}

/* ------------------------------------------------------------ online layer */
async function online(word){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), 8000);
  try{
    const res = await fetch(API_URL + encodeURIComponent(word), { signal: ctrl.signal });
    clearTimeout(timer);
    if(res.status === 404) return { found:false };
    if(!res.ok) return { found:false, error:'The dictionary service answered with an error.' };
    const data = await res.json();
    if(!Array.isArray(data)) return { found:false };
    const senses = [];
    for(const entry of data){
      if(!entry || !Array.isArray(entry.meanings)) continue;
      for(const m of entry.meanings){
        const pos = String(m.partOfSpeech||'').toLowerCase();
        if(!Array.isArray(m.definitions)) continue;
        for(const d of m.definitions){
          if(!d || typeof d.definition !== 'string') continue;
          senses.push({ pos, def: d.definition.trim(), ex: typeof d.example==='string' ? d.example.trim() : '' });
          if(senses.length >= 8) break;
        }
        if(senses.length >= 8) break;
      }
      if(senses.length >= 8) break;
    }
    if(!senses.length) return { found:false };
    // keep it, so the same word works with no connection next time
    try{
      const t = await tx('dictnet','readwrite');
      t.objectStore('dictnet').put({ w:word, s:senses.map(s=>[s.pos, s.def, s.ex]), o:1 });
    }catch(e){}
    return { word, lemma:word, senses, source:'online', found:true };
  }catch(err){
    clearTimeout(timer);
    return { found:false, error: err && err.name==='AbortError'
      ? 'The dictionary service did not answer in time.'
      : 'Could not reach the dictionary service.' };
  }
}

/* ------------------------------------------------- installing the offline file */
export async function status(){
  let meta = null;
  try{ meta = await getMeta('state'); }catch(e){}
  return {
    installed: !!(meta && meta.installed),
    words: (meta && meta.words) || 0,
    name: (meta && meta.name) || '',
    built: (meta && meta.built) || ''
  };
}

/* Streams the gzipped file in, writing batches into IndexedDB.
   onProgress({ words, bytes, total }) is called as it goes.                */
export async function install(onProgress){
  if(typeof DecompressionStream === 'undefined')
    throw new Error('This browser cannot unpack the dictionary file.');
  const res = await fetch(DICT_URL, { cache:'no-store' });
  if(res.status === 404) { const e = new Error('missing'); e.code='missing'; throw e; }
  if(!res.ok) { const e = new Error('The dictionary file could not be downloaded.'); e.code='http'; throw e; }
  const total = +(res.headers.get('content-length') || 0);

  let bytes = 0;
  const counter = new TransformStream({
    transform(chunk, c){ bytes += chunk.byteLength; c.enqueue(chunk); }
  });
  const stream = res.body.pipeThrough(counter)
                         .pipeThrough(new DecompressionStream('gzip'))
                         .pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();

  const d = await getDB();
  await new Promise((res2,rej)=>{                      // start from empty
    const t = d.transaction(['dict','dictmeta'],'readwrite');
    t.objectStore('dict').clear(); t.objectStore('dictmeta').delete('state');
    t.oncomplete=()=>res2(); t.onerror=()=>rej(t.error);
  });

  bucketCache.clear();
  let header = null, exc = {}, words = 0, stored = 0, tail = '', pending = new Map(), pendingWords = 0;
  /* The file is written in alphabetical order, so a group is normally complete
     before the next one starts; merging on write keeps it correct even if it
     is not. */
  const flush = async () => {
    if(!pending.size) return;
    const groups = pending; pending = new Map(); pendingWords = 0;
    await new Promise((res2,rej)=>{
      const t = d.transaction('dict','readwrite');
      const st = t.objectStore('dict');
      for(const [b, map] of groups){
        const q = st.get(b);
        q.onsuccess = () => {
          const old = q.result && q.result.w;
          const keys = Object.keys(map);
          stored += old ? keys.filter(k => !(k in old)).length : keys.length;
          st.put({ b, w: old ? Object.assign(old, map) : map });
        };
      }
      t.oncomplete=()=>res2(); t.onerror=()=>rej(t.error);
    });
  };
  const handle = async (line) => {
    if(!line) return;
    let v;
    try{ v = JSON.parse(line); }catch(e){ return; }
    if(Array.isArray(v)){
      const w = String(v[0]||'').toLowerCase();
      if(!w || !Array.isArray(v[1])) return;
      const b = bucketOf(w);
      let map = pending.get(b);
      if(!map){ map = {}; pending.set(b, map); }
      map[w] = v[1]; words++; pendingWords++;
      if(pendingWords >= 4000){
        await flush();
        if(onProgress) onProgress({ words, bytes, total });
      }
      return;
    }
    if(v && v.exc) exc = Object.assign(exc, v.exc);
    else if(v && !header) header = v;
  };

  for(;;){
    const { value, done } = await reader.read();
    if(done) break;
    tail += value;
    let i;
    while((i = tail.indexOf('\n')) >= 0){
      await handle(tail.slice(0,i).trim());
      tail = tail.slice(i+1);
    }
  }
  await handle(tail.trim());
  await flush();

  if(!stored){ const e = new Error('The dictionary file looks empty.'); e.code='empty'; throw e; }
  excMap = exc;
  await putMeta({ k:'exc', map:exc });
  await putMeta({ k:'state', installed:true, words:stored,
                  name:(header && header.name) || 'Offline dictionary',
                  built:(header && header.built) || '', ver:(header && header.v) || 1 });
  if(onProgress) onProgress({ words:stored, bytes, total });
  return { words:stored };
}

export async function remove(){
  const d = await getDB();
  await new Promise((res,rej)=>{
    const t = d.transaction(['dict','dictmeta'],'readwrite');
    t.objectStore('dict').clear(); t.objectStore('dictmeta').clear();
    t.oncomplete=()=>res(); t.onerror=()=>rej(t.error);
  });
  excMap = null; bucketCache.clear();
}
