/* =========================================================================
   pdf-extract.js — dependency-free PDF → reflowable text for Brick by Brick Reader.

   Reads the text layer of a PDF and rebuilds paragraphs from where the words sit
   on the page: line spacing, first-line indents, ragged last lines, running
   headers and page numbers (dropped), hyphenated line ends (rejoined), headings
   (by size) and chapters (from bookmarks, else headings).

   No DOM, no network, no libraries — runs in the browser and in Node.
   ========================================================================= */

export class PdfError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ------------------------------------------------------------------ objects */
class Name { constructor(n) { this.n = n; } }
class Ref  { constructor(num, gen) { this.num = num; this.gen = gen; } }
class PStr { constructor(b, hex) { this.b = b; this.hex = hex; } }
class Cmd  { constructor(c) { this.c = c; } }
class Stream { constructor(dict, start, end) { this.dict = dict; this.start = start; this.end = end; this.decoded = null; } }
const isDict = v => v instanceof Map;
const nm = v => (v instanceof Name ? v.n : null);

/* ------------------------------------------------------------------ lexer */
const WS = new Uint8Array(256); [0, 9, 10, 12, 13, 32].forEach(c => WS[c] = 1);
const DL = new Uint8Array(256); '()<>[]{}/%'.split('').forEach(c => DL[c.charCodeAt(0)] = 1);
const HEXV = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i++) HEXV[48 + i] = i;
for (let i = 0; i < 6; i++) { HEXV[65 + i] = 10 + i; HEXV[97 + i] = 10 + i; }
const EOF = new Cmd('<EOF>');

class Lexer {
  constructor(b, p = 0) { this.b = b; this.p = p; }
  skip() {
    const b = this.b; let p = this.p;
    for (;;) {
      while (p < b.length && WS[b[p]]) p++;
      if (p < b.length && b[p] === 37) { while (p < b.length && b[p] !== 10 && b[p] !== 13) p++; continue; }
      break;
    }
    this.p = p;
  }
  next() {
    this.skip();
    const b = this.b; let p = this.p;
    if (p >= b.length) return EOF;
    const c = b[p];
    if (c === 40) return this.literal();
    if (c === 60) {
      if (b[p + 1] === 60) { this.p = p + 2; return new Cmd('<<'); }
      return this.hexStr();
    }
    if (c === 62) { if (b[p + 1] === 62) { this.p = p + 2; return new Cmd('>>'); } this.p = p + 1; return new Cmd('>'); }
    if (c === 91 || c === 93 || c === 123 || c === 125) { this.p = p + 1; return new Cmd(String.fromCharCode(c)); }
    if (c === 47) return this.name();
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      let q = p + 1, dot = c === 46;
      while (q < b.length) {
        const d = b[q];
        if (d >= 48 && d <= 57) q++;
        else if (d === 46 && !dot) { dot = true; q++; }
        else if ((d === 45 || d === 43) && q === p + 1) q++;       // tolerate "--5"
        else break;
      }
      let s = ''; for (let i = p; i < q; i++) s += String.fromCharCode(b[i]);
      this.p = q;
      const v = parseFloat(s.replace(/^[+-]{2,}/, '-'));
      return isNaN(v) ? 0 : v;
    }
    let q = p; while (q < b.length && !WS[b[q]] && !DL[b[q]]) q++;
    if (q === p) { this.p = p + 1; return new Cmd(String.fromCharCode(c)); }
    let s = ''; for (let i = p; i < q; i++) s += String.fromCharCode(b[i]);
    this.p = q;
    return new Cmd(s);
  }
  name() {
    const b = this.b; let p = this.p + 1, s = '';
    while (p < b.length && !WS[b[p]] && !DL[b[p]]) {
      if (b[p] === 35 && HEXV[b[p + 1]] >= 0 && HEXV[b[p + 2]] >= 0) {
        s += String.fromCharCode(HEXV[b[p + 1]] * 16 + HEXV[b[p + 2]]); p += 3;
      } else s += String.fromCharCode(b[p++]);
    }
    this.p = p; return new Name(s);
  }
  literal() {
    const b = this.b; let p = this.p + 1, depth = 1; const out = [];
    while (p < b.length) {
      let c = b[p++];
      if (c === 92) {
        c = b[p++];
        switch (c) {
          case 110: out.push(10); break; case 114: out.push(13); break; case 116: out.push(9); break;
          case 98: out.push(8); break; case 102: out.push(12); break;
          case 13: if (b[p] === 10) p++; break;
          case 10: break;
          default:
            if (c >= 48 && c <= 55) {
              let v = c - 48;
              for (let k = 0; k < 2 && b[p] >= 48 && b[p] <= 55; k++) v = v * 8 + (b[p++] - 48);
              out.push(v & 255);
            } else out.push(c);
        }
      } else if (c === 40) { depth++; out.push(c); }
      else if (c === 41) { if (--depth === 0) break; out.push(c); }
      else out.push(c);
    }
    this.p = p; return new PStr(Uint8Array.from(out), false);
  }
  hexStr() {
    const b = this.b; let p = this.p + 1; const out = []; let hi = -1;
    while (p < b.length && b[p] !== 62) {
      const v = HEXV[b[p++]];
      if (v < 0) continue;
      if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);
    this.p = p + 1; return new PStr(Uint8Array.from(out), true);
  }
}

/* parse one value; refs ("1 0 R") need two-token lookahead */
function parseValue(lx, tok) {
  if (tok === undefined) tok = lx.next();
  if (typeof tok === 'number') {
    const save = lx.p;
    const t2 = lx.next();
    if (typeof t2 === 'number' && Number.isInteger(tok) && Number.isInteger(t2)) {
      const t3 = lx.next();
      if (t3 instanceof Cmd && t3.c === 'R') return new Ref(tok, t2);
    }
    lx.p = save; return tok;
  }
  if (tok instanceof Cmd) {
    switch (tok.c) {
      case '[': {
        const arr = [];
        for (;;) {
          const t = lx.next();
          if (t === EOF || (t instanceof Cmd && t.c === ']')) break;
          arr.push(parseValue(lx, t));
        }
        return arr;
      }
      case '<<': {
        const d = new Map();
        for (;;) {
          const k = lx.next();
          if (k === EOF || (k instanceof Cmd && k.c === '>>')) break;
          if (!(k instanceof Name)) continue;
          const v = lx.next();
          if (v instanceof Cmd && v.c === '>>') { d.set(k.n, null); break; }
          d.set(k.n, parseValue(lx, v));
        }
        return d;
      }
      case 'true': return true;
      case 'false': return false;
      case 'null': return null;
    }
  }
  return tok;
}

/* ------------------------------------------------------------------ filters */
async function inflateWith(fmt, bytes) {
  const ds = new DecompressionStream(fmt);
  const w = ds.writable.getWriter();
  w.write(bytes).catch(() => {}); w.close().catch(() => {});
  const r = ds.readable.getReader(); const chunks = []; let err = null, len = 0;
  try { for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); len += value.length; } }
  catch (e) { err = e; }
  if (err && len === 0) throw err;
  const out = new Uint8Array(len); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;                       // a bad checksum still yields everything before it
}
async function inflate(bytes) {
  try { return await inflateWith('deflate', bytes); } catch (e) {}
  try { return await inflateWith('deflate-raw', bytes.subarray(2)); } catch (e) {}
  try { return await inflateWith('deflate-raw', bytes); } catch (e) {}
  return new Uint8Array(0);
}
function predict(data, parms) {
  if (!isDict(parms)) return data;
  const pred = parms.get('Predictor') || 1;
  if (pred < 2) return data;
  const colors = parms.get('Colors') || 1, bpc = parms.get('BitsPerComponent') || 8, cols = parms.get('Columns') || 1;
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8)), rowLen = Math.ceil(colors * bpc * cols / 8);
  if (pred === 2) {                               // TIFF, 8-bit only
    const out = Uint8Array.from(data);
    for (let r = 0; r + rowLen <= out.length; r += rowLen)
      for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen); let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)], src = r * (rowLen + 1) + 1, dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i], left = i >= bpp ? out[dst + i - bpp] : 0, up = prev[i], ul = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (ft) {
        case 1: v = x + left; break;
        case 2: v = x + up; break;
        case 3: v = x + ((left + up) >> 1); break;
        case 4: { const p = left + up - ul, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
                  v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul); break; }
        default: v = x;
      }
      out[dst + i] = v & 255;
    }
    prev = out.subarray(dst, dst + rowLen);
  }
  return out;
}
function lzw(data, early = 1) {
  const out = []; let dict = [], next = 258, len = 9, prev = null;
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict[i] = [i]; next = 258; len = 9; prev = null; };
  reset();
  let buf = 0, bits = 0, p = 0;
  for (;;) {
    while (bits < len && p < data.length) { buf = (buf << 8) | data[p++]; bits += 8; }
    if (bits < len) break;
    const code = (buf >>> (bits - len)) & ((1 << len) - 1); bits -= len; buf &= (1 << bits) - 1;
    if (code === 256) { reset(); continue; }
    if (code === 257) break;
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (code === next && prev) entry = prev.concat(prev[0]);
    else break;
    for (const v of entry) out.push(v);
    if (prev && next < 4096) { dict[next++] = prev.concat(entry[0]); }
    prev = entry;
    if (next + early >= (1 << len) && len < 12) len++;
  }
  return Uint8Array.from(out);
}
function ascii85(data) {
  const out = []; let group = [], i = 0;
  if (data[0] === 60 && data[1] === 126) i = 2;
  for (; i < data.length; i++) {
    const c = data[i];
    if (WS[c]) continue;
    if (c === 126) break;
    if (c === 122 && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    if (c < 33 || c > 117) continue;
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0; for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length; while (group.length < 5) group.push(84);
    let v = 0; for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let k = 0; k < n - 1; k++) out.push(bytes[k]);
  }
  return Uint8Array.from(out);
}
function asciiHex(data) {
  const out = []; let hi = -1;
  for (const c of data) {
    if (c === 62) break;
    const v = HEXV[c]; if (v < 0) continue;
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}
function runLength(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) { for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]); }
    else { const v = data[i++]; for (let k = 0; k < 257 - n; k++) out.push(v); }
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------------ encodings */
const WIN = [], MAC = [], STD = [], PDFDOC = [];
(function buildEncodings() {
  const win = new TextDecoder('windows-1252'), mac = new TextDecoder('macintosh');
  for (let i = 0; i < 256; i++) {
    const b = Uint8Array.of(i);
    WIN[i] = i < 32 ? '' : win.decode(b);
    MAC[i] = i < 32 ? '' : mac.decode(b);
    STD[i] = i >= 32 && i < 127 ? String.fromCharCode(i) : '';
  }
  for (const i of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) WIN[i] = '';
  WIN[0xad] = '\u00ad';
  STD[0x27] = '’'; STD[0x60] = '‘';
  const hi = {0o241:'¡',0o242:'¢',0o243:'£',0o244:'⁄',0o245:'¥',0o246:'ƒ',0o247:'§',0o250:'¤',0o251:"'",0o252:'“',0o253:'«',
    0o254:'‹',0o255:'›',0o256:'fi',0o257:'fl',0o261:'–',0o262:'†',0o263:'‡',0o264:'·',0o266:'¶',0o267:'•',0o270:'‚',0o271:'„',
    0o272:'”',0o273:'»',0o274:'…',0o275:'‰',0o277:'¿',0o301:'`',0o302:'´',0o303:'ˆ',0o304:'˜',0o305:'¯',0o306:'˘',0o307:'˙',
    0o310:'¨',0o312:'˚',0o313:'¸',0o315:'˝',0o316:'˛',0o317:'ˇ',0o320:'—',0o341:'Æ',0o343:'ª',0o350:'Ł',0o351:'Ø',0o352:'Œ',
    0o353:'º',0o361:'æ',0o365:'ı',0o370:'ł',0o371:'ø',0o372:'œ',0o373:'ß'};
  for (const k in hi) STD[k] = hi[k];
  for (let i = 0; i < 256; i++) PDFDOC[i] = String.fromCharCode(i);
  const pd = '•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž';
  for (let i = 0; i < pd.length; i++) PDFDOC[0x80 + i] = pd[i];
  PDFDOC[0xa0] = '€';
})();

const GN = {space:' ',exclam:'!',quotedbl:'"',numbersign:'#',dollar:'$',percent:'%',ampersand:'&',quotesingle:"'",
  quoteright:'’',quoteleft:'‘',parenleft:'(',parenright:')',asterisk:'*',plus:'+',comma:',',hyphen:'-',period:'.',slash:'/',
  zero:'0',one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',colon:':',semicolon:';',
  less:'<',equal:'=',greater:'>',question:'?',at:'@',bracketleft:'[',backslash:'\\',bracketright:']',asciicircum:'^',
  underscore:'_',grave:'`',braceleft:'{',bar:'|',braceright:'}',asciitilde:'~',exclamdown:'¡',cent:'¢',sterling:'£',
  currency:'¤',yen:'¥',brokenbar:'¦',section:'§',dieresis:'¨',copyright:'©',ordfeminine:'ª',guillemotleft:'«',
  guillemetleft:'«',logicalnot:'¬',registered:'®',macron:'¯',degree:'°',plusminus:'±',twosuperior:'²',threesuperior:'³',
  acute:'´',mu:'µ',paragraph:'¶',periodcentered:'·',cedilla:'¸',onesuperior:'¹',ordmasculine:'º',guillemotright:'»',
  guillemetright:'»',onequarter:'¼',onehalf:'½',threequarters:'¾',questiondown:'¿',multiply:'×',divide:'÷',endash:'–',
  emdash:'—',quotedblleft:'“',quotedblright:'”',quotesinglbase:'‚',quotedblbase:'„',guilsinglleft:'‹',guilsinglright:'›',
  bullet:'•',ellipsis:'…',dagger:'†',daggerdbl:'‡',perthousand:'‰',trademark:'™',Euro:'€',euro:'€',fi:'fi',fl:'fl',ff:'ff',
  ffi:'ffi',ffl:'ffl',germandbls:'ß',ae:'æ',AE:'Æ',oe:'œ',OE:'Œ',oslash:'ø',Oslash:'Ø',eth:'ð',Eth:'Ð',thorn:'þ',Thorn:'Þ',
  lslash:'ł',Lslash:'Ł',dotlessi:'ı',minus:'−',fraction:'⁄',florin:'ƒ',circumflex:'ˆ',tilde:'˜',breve:'˘',dotaccent:'˙',
  ring:'˚',hungarumlaut:'˝',ogonek:'˛',caron:'ˇ',nbspace:'\u00a0',nonbreakingspace:'\u00a0',sfthyphen:'\u00ad',
  softhyphen:'\u00ad',figuredash:'‒',quotereversed:'‛',minute:'′',second:'″',arrowright:'→',arrowleft:'←',
  Idotaccent:'İ',idotaccent:'i',Scedilla:'Ş',scedilla:'ş',dcroat:'đ',Dcroat:'Đ',longs:'ſ',Gamma:'Γ',Delta:'Δ',Omega:'Ω',
  alpha:'α',beta:'β',pi:'π'};
const ACC = {acute:'́',grave:'̀',circumflex:'̂',dieresis:'̈',tilde:'̃',ring:'̊',
  cedilla:'̧',caron:'̌',macron:'̄',breve:'̆',ogonek:'̨',dotaccent:'̇',
  hungarumlaut:'̋',commaaccent:'̦'};
function glyphUni(name) {
  if (!name) return '';
  if (GN[name] !== undefined) return GN[name];
  const dot = name.indexOf('.');
  if (dot > 0) return glyphUni(name.slice(0, dot));
  if (name.includes('_')) return name.split('_').map(glyphUni).join('');
  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name);
  if (m) { let s = ''; for (let i = 0; i < m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16)); return s; }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) { const cp = parseInt(m[1], 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; }
  if (/^[A-Za-z]$/.test(name)) return name;
  if (/^[A-Za-z]/.test(name) && ACC[name.slice(1)]) return (name[0] + ACC[name.slice(1)]).normalize('NFC');
  return '';
}

const STD_W = {
  "Times-Roman":"250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541,350,500,350,333,500,444,1000,500,500,333,1000,556,333,889,350,611,350,350,333,333,444,444,350,500,1000,333,980,389,333,722,350,444,722,250,333,500,500,500,500,200,500,333,760,276,500,564,333,760,333,400,564,300,300,333,500,453,250,333,300,310,500,750,750,750,444,722,722,722,722,722,722,889,667,611,611,611,611,333,333,333,333,722,722,722,722,722,722,722,564,722,722,722,722,722,722,556,500,444,444,444,444,444,444,667,444,444,444,444,444,278,278,278,278,500,500,500,500,500,500,500,564,500,500,500,500,500,500,500,500",
  "Times-Bold":"250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520,350,500,350,333,500,500,1000,500,500,333,1000,556,333,1000,350,667,350,350,333,333,500,500,350,500,1000,333,1000,389,333,722,350,444,722,250,333,500,500,500,500,220,500,333,747,300,500,570,333,747,333,400,570,300,300,333,556,540,250,333,300,330,500,750,750,750,500,722,722,722,722,722,722,1000,722,667,667,667,667,389,389,389,389,722,722,778,778,778,778,778,570,778,722,722,722,722,722,611,556,500,500,500,500,500,500,722,444,444,444,444,444,278,278,278,278,500,556,500,500,500,500,500,570,500,556,556,556,556,500,556,500",
  "Times-Italic":"250,333,420,500,500,833,778,214,333,333,500,675,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,675,675,675,500,920,611,611,667,722,611,611,722,722,333,444,667,556,833,667,722,611,722,611,500,556,722,611,833,611,556,556,389,278,389,422,500,333,500,500,444,500,444,278,500,500,278,278,444,278,722,500,500,500,500,389,389,278,500,444,667,444,444,389,400,275,400,541,350,500,350,333,500,556,889,500,500,333,1000,500,333,944,350,556,350,350,333,333,556,556,350,500,889,333,980,389,333,667,350,389,556,250,389,500,500,500,500,275,500,333,760,276,500,675,333,760,333,400,675,300,300,333,500,523,250,333,300,310,500,750,750,750,500,611,611,611,611,611,611,889,667,611,611,611,611,333,333,333,333,722,667,722,722,722,722,722,675,722,722,722,722,722,556,611,500,500,500,500,500,500,500,667,444,444,444,444,444,278,278,278,278,500,500,500,500,500,500,500,675,500,500,500,500,500,444,500,444",
  "Times-BoldItalic":"250,389,555,500,500,833,778,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,832,667,667,667,722,667,667,722,778,389,500,667,611,889,722,722,611,722,667,556,611,722,667,889,667,611,611,333,278,333,570,500,333,500,500,444,500,444,333,500,556,278,278,500,278,778,556,500,500,500,389,389,278,556,444,667,500,444,389,348,220,348,570,350,500,350,333,500,500,1000,500,500,333,1000,556,333,944,350,611,350,350,333,333,500,500,350,500,1000,333,1000,389,333,722,350,389,611,250,389,500,500,500,500,220,500,333,747,266,500,606,333,747,333,400,570,300,300,333,576,500,250,333,300,300,500,750,750,750,500,667,667,667,667,667,667,944,667,667,667,667,667,389,389,389,389,722,722,722,722,722,722,722,570,722,722,722,722,722,611,611,500,500,500,500,500,500,500,722,444,444,444,444,444,278,278,278,278,500,556,500,500,500,500,500,570,500,556,556,556,556,444,500,444",
  "Helvetica":"278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500",
  "Helvetica-Bold":"278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556"
};

const STD_TABLES = {};
function stdWidths(base) {
  const n = (base || '').replace(/^[A-Z]{6}\+/, '').toLowerCase();
  if (/courier|mono/.test(n)) return 'courier';
  const bold = /bold|black|heavy|semibold/.test(n), ital = /italic|oblique/.test(n);
  let key = null;
  if (/helvetica|arial|sans/.test(n)) key = bold ? 'Helvetica-Bold' : 'Helvetica';
  else if (/times|serif|roman|georgia|garamond|minion|palatino|book/.test(n))
    key = bold ? (ital ? 'Times-BoldItalic' : 'Times-Bold') : (ital ? 'Times-Italic' : 'Times-Roman');
  if (!key) return null;
  if (!STD_TABLES[key]) STD_TABLES[key] = STD_W[key].split(',').map(Number);
  return STD_TABLES[key];
}
const WIN_REV = new Map(); // unicode char -> WinAnsi code (for standard-14 width lookups)
function winCode(u) {
  if (!WIN_REV.size) for (let i = 32; i < 256; i++) if (WIN[i] && !WIN_REV.has(WIN[i])) WIN_REV.set(WIN[i], i);
  return WIN_REV.get(u);
}

/* ------------------------------------------------------------------ CMaps */
function utf16be(b) {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  if (b.length % 2) s += String.fromCharCode(b[b.length - 1]);
  return s;
}
const toInt = b => { let v = 0; for (const x of b) v = v * 256 + x; return v; };
function parseCMap(bytes) {
  const cm = { map: new Map(), ranges: [], space: [], cid: new Map(), cidRanges: [] };
  const lx = new Lexer(bytes); const ops = [];
  for (;;) {
    const t = lx.next(); if (t === EOF) break;
    if (t instanceof Cmd) {
      switch (t.c) {
        case 'endcodespacerange':
          for (let i = 0; i + 1 < ops.length; i += 2)
            if (ops[i] instanceof PStr) cm.space.push({ n: ops[i].b.length, lo: toInt(ops[i].b), hi: toInt(ops[i + 1].b) });
          break;
        case 'endbfchar':
          for (let i = 0; i + 1 < ops.length; i += 2) {
            const src = ops[i], dst = ops[i + 1]; if (!(src instanceof PStr)) continue;
            cm.map.set(toInt(src.b), dst instanceof PStr ? utf16be(dst.b) : dst instanceof Name ? glyphUni(dst.n) : '');
          }
          break;
        case 'endbfrange':
          for (let i = 0; i + 2 < ops.length; i += 3) {
            const lo = toInt(ops[i].b), hi = toInt(ops[i + 1].b), dst = ops[i + 2];
            if (Array.isArray(dst)) { for (let c = lo; c <= hi && c - lo < dst.length; c++) if (dst[c - lo] instanceof PStr) cm.map.set(c, utf16be(dst[c - lo].b)); }
            else if (dst instanceof PStr) {
              if (hi - lo < 4096) {
                const base = utf16be(dst.b), lastUnit = base.charCodeAt(base.length - 1), head = base.slice(0, -1);
                for (let c = lo; c <= hi; c++) cm.map.set(c, head + String.fromCharCode(lastUnit + (c - lo)));
              } else cm.ranges.push({ lo, hi, base: utf16be(dst.b) });
            }
          }
          break;
        case 'endcidchar':
          for (let i = 0; i + 1 < ops.length; i += 2) if (ops[i] instanceof PStr) cm.cid.set(toInt(ops[i].b), ops[i + 1]);
          break;
        case 'endcidrange':
          for (let i = 0; i + 2 < ops.length; i += 3) if (ops[i] instanceof PStr) cm.cidRanges.push({ lo: toInt(ops[i].b), hi: toInt(ops[i + 1].b), cid: ops[i + 2] });
          break;
      }
      if (t.c !== '[' && t.c !== ']') { ops.length = 0; continue; }
    }
    if (t instanceof Cmd && t.c === '[') { ops.push(parseValue(lx, t)); continue; }
    ops.push(t);
  }
  return cm;
}
function cmapLookup(cm, code) {
  const v = cm.map.get(code);
  if (v !== undefined) return v;
  for (const r of cm.ranges) if (code >= r.lo && code <= r.hi) {
    const last = r.base.charCodeAt(r.base.length - 1);
    return r.base.slice(0, -1) + String.fromCharCode(last + code - r.lo);
  }
  return undefined;
}

/* ------------------------------------------------------------------ document */
function latin1(b) { return new TextDecoder('latin1').decode(b); }

class PDFDoc {
  constructor(bytes) {
    this.b = bytes; this.xref = new Map(); this.cache = new Map(); this.trailer = null; this.recovered = false;
  }
  async open() {
    try {
      await this.readXrefChain();
      this.checkRoot();
    } catch (e) {
      if (e instanceof PdfError) throw e;
      await this.recover();
      this.checkRoot();
    }
    await this.loadObjStreams();
    if (!this.catalog()) { if (!this.recovered) { await this.recover(); await this.loadObjStreams(); } }
    if (!this.catalog()) throw new PdfError('invalid', 'This file does not look like a readable PDF.');
    if (this.trailer.get('Encrypt')) throw new PdfError('encrypted', 'This PDF is encrypted, so its text cannot be read.');
  }
  checkRoot() { if (!this.trailer || !(this.trailer.get('Root') instanceof Ref || isDict(this.trailer.get('Root')))) throw new Error('no root'); }
  catalog() {
    try { const c = this.get(this.trailer.get('Root')); return isDict(c) && (c.get('Pages') || nm(c.get('Type')) === 'Catalog') ? c : null; }
    catch (e) { return null; }
  }
  findStartxref() {
    const b = this.b, tail = latin1(b.subarray(Math.max(0, b.length - 2048)));
    const i = tail.lastIndexOf('startxref'); if (i < 0) throw new Error('no startxref');
    const m = /startxref\s+(\d+)/.exec(tail.slice(i)); if (!m) throw new Error('bad startxref');
    return +m[1];
  }
  async readXrefChain() {
    let off = this.findStartxref(); const seen = new Set(); const trailers = [];
    while (off != null && !seen.has(off)) {
      seen.add(off);
      if (off < 0 || off >= this.b.length) throw new Error('xref offset out of range');
      const lx = new Lexer(this.b, off); const t = lx.next();
      let tr;
      if (t instanceof Cmd && t.c === 'xref') {
        this.readXrefTable(lx);
        const tk = lx.next(); if (!(tk instanceof Cmd && tk.c === 'trailer')) throw new Error('no trailer');
        tr = parseValue(lx);
        const xs = tr.get('XRefStm'); if (typeof xs === 'number') await this.readXrefStream(xs);
      } else if (typeof t === 'number') {
        tr = await this.readXrefStream(off);
      } else throw new Error('bad xref');
      trailers.push(tr);
      off = typeof tr.get('Prev') === 'number' ? tr.get('Prev') : null;
    }
    this.trailer = new Map();
    for (let i = trailers.length - 1; i >= 0; i--) for (const [k, v] of trailers[i]) this.trailer.set(k, v);
  }
  readXrefTable(lx) {
    for (;;) {
      const save = lx.p, s = lx.next();
      if (typeof s !== 'number') { lx.p = save; break; }
      const n = lx.next();
      for (let i = 0; i < n; i++) {
        const o = lx.next(), g = lx.next(), f = lx.next();
        const num = s + i;
        if (f instanceof Cmd && f.c === 'n' && !this.xref.has(num) && o > 0) this.xref.set(num, { t: 1, off: o, gen: g });
        else if (!this.xref.has(num)) this.xref.set(num, { t: 0 });
      }
    }
  }
  async readXrefStream(off) {
    const obj = this.parseAt(off);
    if (!(obj instanceof Stream)) throw new Error('xref stream missing');
    const d = obj.dict, data = await this.decode(obj);
    const W = d.get('W') || [1, 2, 1], idx = d.get('Index') || [0, d.get('Size')];
    const rec = W[0] + W[1] + W[2]; let p = 0;
    const rd = n => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + data[p++]; return v; };
    for (let k = 0; k + 1 < idx.length; k += 2) {
      for (let i = 0; i < idx[k + 1] && p + rec <= data.length; i++) {
        const type = W[0] ? rd(W[0]) : 1, f2 = rd(W[1]), f3 = rd(W[2]);
        const num = idx[k] + i;
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { t: 1, off: f2, gen: f3 });
        else if (type === 2) this.xref.set(num, { t: 2, stm: f2, idx: f3 });
        else this.xref.set(num, { t: 0 });
      }
    }
    return d;
  }
  /* rebuild everything by scanning — for files whose xref is broken or missing */
  async recover() {
    this.recovered = true; this.xref = new Map(); this.cache = new Map();
    const s = latin1(this.b), re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
    while ((m = re.exec(s))) {
      if (m.index > 0 && /[0-9]/.test(s[m.index - 1])) continue;
      this.xref.set(+m[1], { t: 1, off: m.index, gen: +m[2] });
    }
    let trailer = null;
    let i = s.lastIndexOf('trailer');
    while (i >= 0 && !trailer) {
      try { const tr = parseValue(new Lexer(this.b, i + 7)); if (isDict(tr) && tr.get('Root')) trailer = tr; } catch (e) {}
      i = s.lastIndexOf('trailer', i - 1);
    }
    if (!trailer) {                                   // xref-stream files have no trailer keyword
      const nums = [...this.xref.keys()].sort((a, b) => this.xref.get(b).off - this.xref.get(a).off);
      for (const n of nums) {
        let o; try { o = this.parseAt(this.xref.get(n).off); } catch (e) { continue; }
        const d = o instanceof Stream ? o.dict : o;
        if (isDict(d) && nm(d.get('Type')) === 'XRef' && d.get('Root')) { trailer = d; break; }
      }
    }
    await this.loadObjStreams(true);
    if (!trailer) {
      for (const n of this.xref.keys()) {
        let o; try { o = this.get(new Ref(n, 0)); } catch (e) { continue; }
        if (isDict(o) && nm(o.get('Type')) === 'Catalog') { trailer = new Map([['Root', new Ref(n, 0)]]); break; }
      }
    }
    if (!trailer) throw new PdfError('invalid', 'This file does not look like a readable PDF.');
    this.trailer = trailer;
  }
  async loadObjStreams(scanAll = false) {
    const stms = new Set();
    for (const e of this.xref.values()) if (e.t === 2) stms.add(e.stm);
    if (scanAll) {
      for (const [n, e] of this.xref) {
        if (e.t !== 1) continue;
        let o; try { o = this.parseAt(e.off); } catch (err) { continue; }
        if (o instanceof Stream && nm(o.dict.get('Type')) === 'ObjStm') stms.add(n);
      }
    }
    for (const sn of stms) {
      const e = this.xref.get(sn); if (!e || e.t !== 1) continue;
      let st; try { st = this.parseAt(e.off); } catch (err) { continue; }
      if (!(st instanceof Stream)) continue;
      const data = await this.decode(st);
      const n = st.dict.get('N') || 0, first = st.dict.get('First') || 0;
      const lx = new Lexer(data); const hdr = [];
      for (let i = 0; i < n; i++) hdr.push([lx.next(), lx.next()]);
      for (const [num, off] of hdr) {
        if (typeof num !== 'number') continue;
        const cur = this.xref.get(num);
        if (cur && cur.t === 1 && !scanAll) continue;
        if (cur && cur.t === 1 && scanAll) continue;         // direct objects beat compressed copies
        if (cur && cur.t === 2 && cur.stm !== sn) continue;
        try {
          const val = parseValue(new Lexer(data, first + off));
          this.cache.set(num, val);
          if (!cur) this.xref.set(num, { t: 2, stm: sn, idx: 0 });
        } catch (err) {}
      }
    }
  }
  parseAt(off, expectNum) {
    const lx = new Lexer(this.b, off);
    const num = lx.next(), gen = lx.next(), kw = lx.next();
    if (!(kw instanceof Cmd && kw.c === 'obj')) throw new Error('not an object at ' + off);
    if (expectNum !== undefined && num !== expectNum) throw new Error('object number mismatch');
    const val = parseValue(lx);
    const save = lx.p; const t = lx.next();
    if (isDict(val) && t instanceof Cmd && t.c === 'stream') {
      let p = lx.p;
      if (this.b[p] === 13) p++;
      if (this.b[p] === 10) p++;
      let len = val.get('Length');
      if (len instanceof Ref) { try { len = this.get(len); } catch (e) { len = null; } }
      let end = typeof len === 'number' ? p + len : -1;
      const okEnd = end > 0 && end <= this.b.length &&
        /^\s*endstream/.test(latin1(this.b.subarray(end, Math.min(this.b.length, end + 12))));
      if (!okEnd) {
        const s = latin1(this.b.subarray(p, Math.min(this.b.length, p + 50_000_000)));
        const k = s.indexOf('endstream');
        end = k >= 0 ? p + k : this.b.length;
        while (end > p && (this.b[end - 1] === 10 || this.b[end - 1] === 13)) end--;
      }
      return new Stream(val, p, end);
    }
    lx.p = save;
    return val;
  }
  get(v, depth = 0) {
    if (!(v instanceof Ref)) return v;
    if (depth > 32) return null;
    if (this.cache.has(v.num)) { const c = this.cache.get(v.num); return c instanceof Ref ? this.get(c, depth + 1) : c; }
    const e = this.xref.get(v.num);
    if (!e || e.t !== 1) { this.cache.set(v.num, null); return null; }
    let o = null;
    try { o = this.parseAt(e.off, v.num); } catch (err) {
      try { o = this.parseAt(e.off); } catch (err2) { o = null; }
    }
    this.cache.set(v.num, o);
    return o instanceof Ref ? this.get(o, depth + 1) : o;
  }
  raw(st) { return this.b.subarray(st.start, st.end); }
  async decode(st) {
    if (st.decoded) return st.decoded;
    let data = this.raw(st);
    let filters = this.get(st.dict.get('Filter')), parms = this.get(st.dict.get('DecodeParms') || st.dict.get('DP'));
    if (!Array.isArray(filters)) filters = filters ? [filters] : [];
    if (!Array.isArray(parms)) parms = [parms];
    for (let i = 0; i < filters.length; i++) {
      const f = nm(this.get(filters[i])), pr = this.get(parms[i]);
      switch (f) {
        case 'FlateDecode': case 'Fl': data = predict(await inflate(data), pr); break;
        case 'LZWDecode': case 'LZW': data = predict(lzw(data, isDict(pr) && pr.has('EarlyChange') ? pr.get('EarlyChange') : 1), pr); break;
        case 'ASCII85Decode': case 'A85': data = ascii85(data); break;
        case 'ASCIIHexDecode': case 'AHx': data = asciiHex(data); break;
        case 'RunLengthDecode': case 'RL': data = runLength(data); break;
        default: st.decoded = data; return data;          // image codecs: leave raw
      }
    }
    st.decoded = data;
    return data;
  }
  pages() {
    const out = [], seen = new Set();
    const walk = (ref, inh) => {
      const node = this.get(ref);
      if (!isDict(node)) return;
      if (ref instanceof Ref) { if (seen.has(ref.num)) return; seen.add(ref.num); }
      const res = node.get('Resources') !== undefined ? node.get('Resources') : inh.res;
      const mb = node.get('MediaBox') !== undefined ? node.get('MediaBox') : inh.mb;
      const kids = this.get(node.get('Kids'));
      if (Array.isArray(kids) && nm(node.get('Type')) !== 'Page') { for (const k of kids) walk(k, { res, mb }); return; }
      out.push({ ref: ref instanceof Ref ? ref.num : -1, dict: node, res: this.get(res), mb: this.get(mb) || [0, 0, 612, 792] });
    };
    walk(this.catalog().get('Pages'), { res: null, mb: null });
    return out;
  }
}

/* ------------------------------------------------------------------ fonts */
let fontSeq = 0;
function loadFont(doc, fd, cache) {
  const key = fd;
  if (cache.has(key)) return cache.get(key);
  const f = buildFont(doc, doc.get(fd));
  cache.set(key, f);
  return f;
}
function buildFont(doc, d) {
  const font = { id: ++fontSeq, type0: false, bytesFixed: 1, space: [], toUni: null, enc: null,
                 widths: null, first: 0, dw: 500, wmap: null, std: null, scale: 1, name: '' };
  if (!isDict(d)) return font;
  const subtype = nm(d.get('Subtype'));
  font.name = nm(d.get('BaseFont')) || '';
  const tu = doc.get(d.get('ToUnicode'));
  if (tu instanceof Stream) font.toUniRef = tu;
  if (subtype === 'Type0') {
    font.type0 = true; font.bytesFixed = 2;
    const enc = doc.get(d.get('Encoding'));
    if (enc instanceof Stream) font.encStream = enc;
    else if (nm(enc) && !/^Identity-[HV]$/.test(nm(enc))) font.predefinedCMap = nm(enc);
    const desc = doc.get((doc.get(d.get('DescendantFonts')) || [])[0]);
    if (isDict(desc)) {
      font.dw = typeof desc.get('DW') === 'number' ? desc.get('DW') : 1000;
      const W = doc.get(desc.get('W'));
      if (Array.isArray(W)) {
        font.wmap = new Map();
        for (let i = 0; i < W.length;) {
          const c = doc.get(W[i]), nx = doc.get(W[i + 1]);
          if (Array.isArray(nx)) { nx.forEach((w, k) => font.wmap.set(c + k, doc.get(w))); i += 2; }
          else { const w = doc.get(W[i + 2]); for (let k = c; k <= nx && k - c < 65536; k++) font.wmap.set(k, w); i += 3; }
        }
      }
    }
    return font;
  }
  if (subtype === 'Type3') {
    const fm = doc.get(d.get('FontMatrix')) || [0.001, 0, 0, 0.001, 0, 0];
    font.scale = Math.abs(fm[3] || 0.001) * 1000;
    font.wscale = (fm[0] || 0.001) * 1000;
  }
  const W = doc.get(d.get('Widths'));
  if (Array.isArray(W)) { font.widths = W.map(x => doc.get(x)); font.first = doc.get(d.get('FirstChar')) || 0; }
  else font.std = stdWidths(font.name);
  const fdesc = doc.get(d.get('FontDescriptor'));
  if (isDict(fdesc) && typeof fdesc.get('MissingWidth') === 'number') font.dw = fdesc.get('MissingWidth');
  const flags = isDict(fdesc) ? (fdesc.get('Flags') || 0) : 0;
  const symbolic = (flags & 4) && !(flags & 32);
  let enc = doc.get(d.get('Encoding')), base, diffs = null;
  if (isDict(enc)) { base = nm(doc.get(enc.get('BaseEncoding'))); diffs = doc.get(enc.get('Differences')); }
  else base = nm(enc);
  let table;
  if (base === 'WinAnsiEncoding') table = WIN;
  else if (base === 'MacRomanEncoding') table = MAC;
  else if (base === 'StandardEncoding') table = STD;
  else if (symbolic) table = null;
  else table = subtype === 'TrueType' ? WIN : STD;
  font.enc = table ? table.slice() : [];
  if (!table) for (let i = 32; i < 256; i++) font.enc[i] = String.fromCharCode(i);
  if (Array.isArray(diffs)) {
    let code = 0;
    for (const x of diffs) { const v = doc.get(x); if (typeof v === 'number') code = v; else if (v instanceof Name) font.enc[code++] = glyphUni(v.n); }
  }
  return font;
}
async function finishFont(doc, font) {
  if (font.ready) return font;
  font.ready = true;
  if (font.toUniRef) { try { font.toUni = parseCMap(await doc.decode(font.toUniRef)); } catch (e) {} }
  if (font.encStream) {
    try { const cm = parseCMap(await doc.decode(font.encStream)); font.encCMap = cm; if (cm.space.length) font.space = cm.space; } catch (e) {}
  }
  if (font.type0 && !font.space.length) font.space = [{ n: 2, lo: 0, hi: 0xffff }];
  return font;
}
function cidOf(font, code) {
  const cm = font.encCMap;
  if (!cm) return code;
  if (cm.cid.has(code)) return cm.cid.get(code);
  for (const r of cm.cidRanges) if (code >= r.lo && code <= r.hi) return r.cid + (code - r.lo);
  return code;
}
function decodeText(font, bytes) {
  const out = [];
  if (font.type0) {
    for (let i = 0; i < bytes.length;) {
      let n = 0;
      for (let k = 1; k <= 4 && !n; k++) {
        if (i + k > bytes.length) break;
        const v = toInt(bytes.subarray(i, i + k));
        for (const sp of font.space) if (sp.n === k && v >= sp.lo && v <= sp.hi) { n = k; break; }
      }
      if (!n) n = Math.min(2, bytes.length - i);
      const code = toInt(bytes.subarray(i, i + n)); i += n;
      const cid = cidOf(font, code);
      let u = font.toUni ? cmapLookup(font.toUni, code) : undefined;
      if (u === undefined) u = '\ufffd';
      const w = font.wmap && font.wmap.has(cid) ? font.wmap.get(cid) : font.dw;
      out.push(code, u, w, 0);
    }
    return out;
  }
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes[i];
    let u = font.toUni ? cmapLookup(font.toUni, code) : undefined;
    if (u === undefined) u = font.enc[code] !== undefined ? font.enc[code] : (code >= 32 ? String.fromCharCode(code) : '');
    let w;
    if (font.widths) {
      const k = code - font.first;
      w = k >= 0 && k < font.widths.length && typeof font.widths[k] === 'number' ? font.widths[k] : font.dw;
      if (font.wscale) w *= font.wscale;
    } else if (font.std === 'courier') w = 600;
    else if (font.std) { const wc = u.length === 1 ? winCode(u) : undefined; w = wc ? font.std[wc - 32] : (code >= 32 ? font.std[code - 32] || 500 : 500); }
    else w = font.dw || 500;
    out.push(code, u, w, 1);
  }
  return out;
}

/* ------------------------------------------------------------------ content streams */
const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2],
                       m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const apply = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

async function runContent(doc, bytes, resources, gs, runs, fontCache, depth, imgs) {
  const lx = new Lexer(bytes);
  const ops = [];
  let Tm = [1, 0, 0, 1, 0, 0], Tlm = [1, 0, 0, 1, 0, 0];
  const res = doc.get(resources);
  const fonts = isDict(res) ? doc.get(res.get('Font')) : null;
  const xobjs = isDict(res) ? doc.get(res.get('XObject')) : null;
  const stack = [];
  let st = gs;

  const show = (pstr) => {
    const f = st.font; if (!f || !(pstr instanceof PStr)) return;
    const g = decodeText(f, pstr.b);
    const fs = st.size, Th = st.Th;
    const M = mul(Tm, st.ctm);
    const [x0, y0] = apply(M, 0, st.Ts);
    let tx = 0, text = '';
    for (let i = 0; i < g.length; i += 4) {
      const code = g[i], u = g[i + 1], w = g[i + 2], single = g[i + 3];
      const adv = ((w / 1000) * fs * (f.type0 ? 1 : 1) + st.Tc + (single && code === 32 ? st.Tw : 0)) * Th;
      text += u; tx += adv;
    }
    const [x1, y1] = apply(M, tx, st.Ts);
    Tm = mul([1, 0, 0, 1, tx, 0], Tm);
    const size = Math.abs(fs * f.scale) * Math.hypot(M[2], M[3]);
    const angle = Math.atan2(M[1], M[0]);
    if (text) runs.push({ x0, y: y0, x1, size, text, fid: f.id, angle });
  };

  for (;;) {
    const t = lx.next();
    if (t === EOF) break;
    if (!(t instanceof Cmd)) { ops.push(t); continue; }
    const c = t.c;
    if (c === '[') { ops.push(parseValue(lx, t)); continue; }
    if (c === '<<') { ops.push(parseValue(lx, t)); continue; }
    switch (c) {
      case 'q': stack.push(st); st = Object.assign({}, st); break;
      case 'Q': if (stack.length) st = stack.pop(); break;
      case 'cm': if (ops.length >= 6) st.ctm = mul(ops.slice(-6), st.ctm); break;
      case 'BT': Tm = [1, 0, 0, 1, 0, 0]; Tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'Tf': {
        const fname = nm(ops[ops.length - 2]), size = ops[ops.length - 1];
        st.size = typeof size === 'number' ? size : st.size;
        const fref = fonts && fname ? fonts.get(fname) : null;
        st.font = fref ? await finishFont(doc, loadFont(doc, fref, fontCache)) : null;
        break;
      }
      case 'Tc': st.Tc = ops[ops.length - 1] || 0; break;
      case 'Tw': st.Tw = ops[ops.length - 1] || 0; break;
      case 'Tz': st.Th = (ops[ops.length - 1] || 100) / 100; break;
      case 'TL': st.TL = ops[ops.length - 1] || 0; break;
      case 'Ts': st.Ts = ops[ops.length - 1] || 0; break;
      case 'Td': Tlm = mul([1, 0, 0, 1, ops[ops.length - 2] || 0, ops[ops.length - 1] || 0], Tlm); Tm = Tlm.slice(); break;
      case 'TD': st.TL = -(ops[ops.length - 1] || 0);
                 Tlm = mul([1, 0, 0, 1, ops[ops.length - 2] || 0, ops[ops.length - 1] || 0], Tlm); Tm = Tlm.slice(); break;
      case 'Tm': if (ops.length >= 6) { Tlm = ops.slice(-6); Tm = Tlm.slice(); } break;
      case 'T*': Tlm = mul([1, 0, 0, 1, 0, -st.TL], Tlm); Tm = Tlm.slice(); break;
      case 'Tj': show(ops[ops.length - 1]); break;
      case "'": Tlm = mul([1, 0, 0, 1, 0, -st.TL], Tlm); Tm = Tlm.slice(); show(ops[ops.length - 1]); break;
      case '"': st.Tw = ops[ops.length - 3] || 0; st.Tc = ops[ops.length - 2] || 0;
                Tlm = mul([1, 0, 0, 1, 0, -st.TL], Tlm); Tm = Tlm.slice(); show(ops[ops.length - 1]); break;
      case 'TJ': {
        const arr = ops[ops.length - 1];
        if (Array.isArray(arr)) for (const el of arr) {
          if (el instanceof PStr) show(el);
          else if (typeof el === 'number') Tm = mul([1, 0, 0, 1, -el / 1000 * st.size * st.Th, 0], Tm);
        }
        break;
      }
      case 'Do': {
        if (depth > 8 || !xobjs) break;
        const x = doc.get(xobjs.get(nm(ops[ops.length - 1])));
        if (!(x instanceof Stream)) break;
        const sub = nm(x.dict.get('Subtype'));
        if (sub === 'Form') {
          const m = doc.get(x.dict.get('Matrix'));
          const inner = Object.assign({}, st, { ctm: Array.isArray(m) && m.length === 6 ? mul(m.map(v => doc.get(v)), st.ctm) : st.ctm });
          const data = await doc.decode(x);
          await runContent(doc, data, x.dict.get('Resources') || resources, inner, runs, fontCache, depth + 1, imgs);
        } else if (sub === 'Image' && imgs) imgs.push(x);
        break;
      }
      case 'BI': {                        // skip inline image data safely
        const b = lx.b; let p = lx.p;
        const s = latin1(b.subarray(p, Math.min(b.length, p + 4096)));
        const id = /\sID[\s]/.exec(s);
        if (!id) break;
        p += id.index + id[0].length;
        while (p < b.length - 2) {
          if ((WS[b[p]]) && b[p + 1] === 69 && b[p + 2] === 73 && (p + 3 >= b.length || WS[b[p + 3]] || DL[b[p + 3]])) { p += 3; break; }
          p++;
        }
        lx.p = p;
        break;
      }
    }
    ops.length = 0;
  }
}

/* ------------------------------------------------------------------ layout */
const TERMINAL = /[.!?:;…"”’'»«)\]—–]$/;
function cleanText(s) {
  return s.replace(/[\ufb00-\ufb06]/g, ch => ch.normalize('NFKC'))
          .replace(/\u00a0/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u200b\u200c\u200d\ufeff]/g, '')
          .replace(/\s+/g, ' ');
}
/* Two-column pages: find a vertical gutter that text (almost) never crosses, in the middle
   of the text block, with real text running side by side on both sides. Strict on purpose —
   a false positive would scramble an ordinary book page. */
function findGutter(rs) {
  rs = rs.filter(r => r.text.trim() && Math.abs(r.angle) < 0.2);
  if (rs.length < 20) return null;
  let minX = Infinity, maxX = -Infinity;
  for (const r of rs) { if (r.x0 < minX) minX = r.x0; if (r.x1 > maxX) maxX = r.x1; }
  const W = maxX - minX; if (W < 120) return null;
  const lines = new Set(rs.map(r => Math.round(r.y))).size;
  const bins = Math.ceil(W), cover = new Uint16Array(bins + 1);
  for (const r of rs) {
    const a = Math.max(0, Math.floor(r.x0 - minX)), b = Math.min(bins, Math.ceil(r.x1 - minX));
    for (let x = a; x < b; x++) cover[x]++;
  }
  const sizes = rs.map(r => r.size).sort((a, b) => a - b), size = sizes[sizes.length >> 1];
  const lo = Math.floor(W * 0.3), hi = Math.ceil(W * 0.7), limit = Math.max(1, lines * 0.04);
  let best = null, start = -1;
  for (let x = lo; x <= hi + 1; x++) {
    if (x <= hi && cover[x] <= limit) { if (start < 0) start = x; }
    else if (start >= 0) { if (!best || x - start > best.w) best = { a: start, w: x - start }; start = -1; }
  }
  if (!best || best.w < size * 0.8) return null;
  const g0 = minX + best.a, g1 = g0 + best.w;
  let lc = 0, rc = 0; const ly = [], ry = [];
  for (const r of rs) {
    if (r.x1 <= g0 + 1) { lc += r.text.length; ly.push(r.y); }
    else if (r.x0 >= g1 - 1) { rc += r.text.length; ry.push(r.y); }
  }
  const tot = lc + rc;
  if (!tot || lc / tot < 0.2 || rc / tot < 0.2) return null;
  if (new Set(ly.map(Math.round)).size < 6 || new Set(ry.map(Math.round)).size < 6) return null;
  const lTop = Math.max(...ly), lBot = Math.min(...ly), rTop = Math.max(...ry), rBot = Math.min(...ry);
  const overlap = Math.min(lTop, rTop) - Math.max(lBot, rBot);
  if (overlap < 0.5 * Math.min(lTop - lBot, rTop - rBot)) return null;       // side by side, not stacked
  return { g0, g1, top: Math.max(lTop, rTop) };
}
/* reading order for a page: [spanning above] [left column] [right column] [spanning below] */
function segmentsOf(runs) {
  const g = findGutter(runs);
  if (!g) return [runs];
  const top = [], left = [], right = [], bottom = [];
  for (const r of runs) {
    if (r.x1 <= g.g0 + 1) left.push(r);
    else if (r.x0 >= g.g1 - 1) right.push(r);
    else (r.y > g.top ? top : bottom).push(r);
  }
  return [top, left, right, bottom].filter(s => s.length);
}
function buildLines(runs) {
  const rs = runs.filter(r => Math.abs(r.angle) < 0.2 && r.text.trim() !== '' || (r.text === ' '));
  rs.sort((a, b) => (b.y - a.y) || (a.x0 - b.x0));
  const lines = [];
  for (const r of rs) {
    let L = null;
    for (let k = lines.length - 1; k >= Math.max(0, lines.length - 3); k--) {
      const c = lines[k];
      const big = Math.max(c.size, r.size), small = Math.min(c.size, r.size);
      const tol = (small < big * 0.85 ? 0.75 : 0.5) * big;          // footnote markers ride high
      if (Math.abs(c.y - r.y) < tol && r.x0 > c.minX - c.size * 40) { L = c; break; }
    }
    if (!L) { L = { y: r.y, size: r.size, runs: [], minX: r.x0, weight: 0 }; lines.push(L); }
    L.runs.push(r);
    const wgt = r.text.length;
    if (wgt > L.weight) { L.weight = wgt; L.y = r.y; L.size = r.size; }
    L.minX = Math.min(L.minX, r.x0);
  }
  const out = [];
  for (const L of lines) {
    L.runs.sort((a, b) => a.x0 - b.x0);
    let text = '', lastEnd = null, lastRun = null, x1 = -Infinity, x0 = Infinity, chars = 0, maxSize = 0;
    for (const r of L.runs) {
      if (lastRun && r.text === lastRun.text && Math.abs(r.x0 - lastRun.x0) < 1.5 && Math.abs(r.y - lastRun.y) < 1.5) continue;   // fake-bold double draw
      if (lastEnd !== null) {
        const gap = r.x0 - lastEnd;
        if (gap > 0.15 * r.size && !/\s$/.test(text) && !/^\s/.test(r.text)) text += ' ';
      }
      let piece = r.text;
      if (r.size < L.size * 0.85 && r.y > L.y + L.size * 0.15 && /^[0-9]+$/.test(piece.trim()))
        piece = piece.trim().replace(/[0-9]/g, d => '\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079'[d]);
      text += piece;
      if (r.text.trim()) { x0 = Math.min(x0, r.x0); x1 = Math.max(x1, r.x1); chars += r.text.length; maxSize = Math.max(maxSize, r.size); }
      lastEnd = Math.max(lastEnd === null ? -Infinity : lastEnd, r.x1); lastRun = r;
    }
    text = cleanText(text).trim();
    if (text) out.push({ y: L.y, x0, x1, size: L.size, text, chars });
  }
  out.sort((a, b) => b.y - a.y);
  return out;
}
const mode = (vals, step) => {
  const m = new Map(); let best = null, bc = 0;
  for (const [v, w] of vals) { const k = Math.round(v / step) * step; const c = (m.get(k) || 0) + w; m.set(k, c); if (c > bc) { bc = c; best = k; } }
  return best;
};
const pct = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const norm = s => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const PAGE_NUM = /^(?:page\s*)?(?:[-–—\s]*)(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:\/|of)\s*\d{1,4})?(?:[-–—\s]*)$/i;

function removeFurniture(pages) {
  const n = pages.length, counts = new Map();
  for (const p of pages) {
    const seen = new Set();
    const cand = p.lines.slice(0, 2).concat(p.lines.slice(-2));
    for (const L of cand) {
      const k = norm(L.text); if (seen.has(k)) continue; seen.add(k);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  for (const p of pages) {
    const H = p.h, top = p.top;
    const edge = L => (top - L.y) < H * 0.12 || (L.y - (top - H)) < H * 0.12;
    const cand = new Set(p.lines.slice(0, 2).concat(p.lines.slice(-2)));
    p.lines = p.lines.filter(L => {
      if (!cand.has(L) || !edge(L)) return true;
      if (PAGE_NUM.test(L.text)) return false;
      const c = counts.get(norm(L.text)) || 0;
      if (n >= 3 && c >= Math.max(2, Math.ceil(n * 0.3))) return false;
      if (n === 2 && c === 2) return false;
      return true;
    });
  }
}

function buildDict(pages) {
  const dict = new Set();
  for (const p of pages) for (const L of p.lines) {
    const toks = L.text.match(/[\p{L}]+(?:[-\u2010][\p{L}]+)+|[\p{L}]+/gu) || [];
    const words = L.text.split(' ');
    toks.forEach(t => dict.add(t.toLowerCase()));
    // a trailing "exam-" fragment is not evidence of anything; drop what the regex took from it
    const last = words[words.length - 1] || '';
    if (/[-\u2010]$/.test(last)) dict.delete(last.replace(/[-\u2010]$/, '').toLowerCase().replace(/^.*[^\p{L}]/u, ''));
  }
  return dict;
}
/* A line-end hyphen is a soft break in a typeset book but a real hyphen in a browser or
   Word export, which never hyphenate on their own. Evidence from the document itself wins;
   otherwise use how often this document breaks lines on a hyphen at all. */
function joinLine(a, b, dict, softByDefault) {
  if (/\u00ad$/.test(a)) return a.slice(0, -1) + b;
  const m = /([\p{L}]+)[-\u2010]$/u.exec(a);
  if (m && /^\p{Ll}/u.test(b)) {
    const tail = (/^[\p{L}]+/u.exec(b) || [''])[0];
    const joined = (m[1] + tail).toLowerCase(), hyph = (m[1] + '-' + tail).toLowerCase();
    const hasJ = dict.has(joined), hasH = dict.has(hyph);
    if (hasH && !hasJ) return a + b;
    if (hasJ && !hasH) return a.slice(0, -1) + b;
    return softByDefault ? a.slice(0, -1) + b : a + b;
  }
  return a + ' ' + b;
}

function segment(pages) {
  const body = [];
  for (const p of pages) for (const L of p.lines) body.push([L.size, L.chars]);
  const bodySize = mode(body, 0.5) || 10;
  const gaps = [];
  for (const p of pages) for (let i = 1; i < p.lines.length; i++) {
    const a = p.lines[i - 1], b = p.lines[i];
    if (Math.abs(a.size - bodySize) < 0.6 && Math.abs(b.size - bodySize) < 0.6) gaps.push([a.y - b.y, 1]);
  }
  const lineGap = mode(gaps, 0.25) || bodySize * 1.25;
  const isBody = L => Math.abs(L.size - bodySize) < bodySize * 0.12;
  const widths = [];
  for (const p of pages) {
    const bl = p.lines.filter(isBody);
    const starts = new Map();
    for (const L of bl) { const k = Math.round(L.x0); starts.set(k, (starts.get(k) || 0) + 1); }
    const rep = [...starts].filter(([, c]) => c >= 2).map(([k]) => k);
    p.left = rep.length ? Math.min(...rep) : (bl.length ? Math.min(...bl.map(L => L.x0)) : 0);
    p.right = bl.length >= 4 ? pct(bl.map(L => L.x1), 0.85) : null;
    if (p.right != null) widths.push([p.right - p.left, 1]);
  }
  const width = mode(widths, 2) || 300;
  let justified = 0, total = 0;
  for (const p of pages) {
    if (p.right == null) p.right = p.left + width;
    for (const L of p.lines) if (isBody(L)) { total++; if (L.x1 >= p.right - 2) justified++; }
  }
  const isJustified = total > 0 && justified / total > 0.45;
  const dict = buildDict(pages);
  let bodyLines = 0, hyphLines = 0;
  for (const p of pages) for (const L of p.lines) if (isBody(L)) { bodyLines++; if (/\p{L}[-\u2010]$/u.test(L.text)) hyphLines++; }
  // typeset books break ~1 line in 10-20 on a hyphen; exports only where a compound lands
  const softByDefault = bodyLines < 40 ? true : hyphLines / bodyLines >= 0.03;
  const heading = L => L.size >= bodySize * 1.2 && L.text.length < 160;

  const centred = (L, pg) => {
    const c0 = L.x0 - pg.left, c1 = pg.right - L.x1, em = bodySize;
    // well in from BOTH margins: more than any paragraph indent, so ragged prose never qualifies
    return c0 > 2.5 * em && c1 > 2.5 * em && Math.abs(c0 - c1) < Math.max(em, 0.12 * (c0 + c1));
  };
  const blocks = []; let cur = null, prev = null, prevPage = null;
  const flush = () => {
    if (cur) {
      cur.text = cur.t === 'v' ? cur.text.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
                               : cur.text.replace(/\s+/g, ' ').trim();
      if (cur.text) blocks.push(cur);
    }
    cur = null;
  };
  const endsParagraph = (P, pg) => {
    const short = P.x1 < pg.right - bodySize * (isJustified ? 1.0 : 0);
    const veryShort = P.x1 - pg.left < (pg.right - pg.left) * 0.6;
    if (isJustified) return short && (TERMINAL.test(P.text) || veryShort);
    return (P.x1 < pg.right - (pg.right - pg.left) * 0.25) && TERMINAL.test(P.text);
  };
  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi];
    for (const L of pg.lines) {
      if (heading(L)) {
        const last = blocks[blocks.length - 1];
        if (!cur && last && last.t === 'h' && prev && heading(prev) && prevPage === pg && prev.y - L.y < L.size * 2.2) {
          last.text += ' ' + L.text;
        } else { flush(); blocks.push({ t: 'h', text: L.text, page: pg.idx ?? pi, y: L.y }); }
        prev = L; prevPage = pg; continue;
      }
      if (centred(L, pg)) {
        const cont = cur && cur.t === 'v' && prevPage === pg && prev && prev.y - L.y < lineGap * 1.45;
        if (cont) cur.text += '\n' + L.text;
        else { flush(); cur = { t: 'v', text: L.text, page: pg.idx ?? pi, y: L.y }; }
        prev = L; prevPage = pg; continue;
      }
      let brk = !cur || cur.t === 'v' || !prev || heading(prev);
      if (!brk) {
        const sameP = prevPage === pg;
        const indL = L.x0 - pg.left, indP = prev.x0 - prevPage.left;
        const indent = indL > bodySize * 0.5 && indL < bodySize * 10 && indL - indP > bodySize * 0.4;
        if (indent) brk = true;
        else if (endsParagraph(prev, prevPage)) brk = true;
        else if (sameP && prev.y - L.y > lineGap * 1.45) brk = true;
      }
      if (brk) { flush(); cur = { t: 'p', text: L.text, page: pg.idx ?? pi, y: L.y }; }
      else cur.text = joinLine(cur.text, L.text, dict, softByDefault);
      prev = L; prevPage = pg;
    }
  }
  flush();
  return { blocks, bodySize };
}

/* ------------------------------------------------------------------ outline / metadata */
function textString(doc, v) {
  v = doc.get(v);
  if (!(v instanceof PStr)) return '';
  const b = v.b;
  if (b[0] === 0xfe && b[1] === 0xff) return utf16be(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  let s = ''; for (const x of b) s += PDFDOC[x]; return s;
}
function nameTreeLookup(doc, node, key, depth = 0) {
  node = doc.get(node);
  if (!isDict(node) || depth > 20) return null;
  const names = doc.get(node.get('Names'));
  if (Array.isArray(names)) for (let i = 0; i + 1 < names.length; i += 2) {
    const k = doc.get(names[i]);
    if (k instanceof PStr && latin1(k.b) === key) return doc.get(names[i + 1]);
  }
  const kids = doc.get(node.get('Kids'));
  if (Array.isArray(kids)) for (const k of kids) { const r = nameTreeLookup(doc, k, key, depth + 1); if (r) return r; }
  return null;
}
function resolveDest(doc, cat, d) {
  d = doc.get(d);
  if (d instanceof Name || d instanceof PStr) {
    const key = d instanceof Name ? d.n : latin1(d.b);
    let v = null;
    const names = doc.get(cat.get('Names'));
    if (isDict(names) && names.get('Dests')) v = nameTreeLookup(doc, names.get('Dests'), key);
    if (!v) { const dd = doc.get(cat.get('Dests')); if (isDict(dd)) v = doc.get(dd.get(key)); }
    if (isDict(v)) v = doc.get(v.get('D'));
    d = v;
  }
  if (!Array.isArray(d) || !d.length) return null;
  const pref = d[0], kind = nm(d[1]);
  const top = kind === 'XYZ' ? doc.get(d[3]) : kind === 'FitH' || kind === 'FitBH' ? doc.get(d[2]) : null;
  return { page: pref instanceof Ref ? pref.num : (typeof pref === 'number' ? -1 - pref : null), top: typeof top === 'number' ? top : null };
}
function outline(doc) {
  const cat = doc.catalog(), ol = doc.get(cat.get('Outlines'));
  if (!isDict(ol)) return [];
  const read = (first, depth) => {
    const out = []; let n = doc.get(first), guard = 0;
    while (isDict(n) && guard++ < 5000) {
      let dest = n.get('Dest');
      const a = doc.get(n.get('A'));
      if (!dest && isDict(a) && nm(a.get('S')) === 'GoTo') dest = a.get('D');
      out.push({ title: textString(doc, n.get('Title')).trim(), dest: dest ? resolveDest(doc, cat, dest) : null,
                 kids: depth < 2 && n.get('First') ? read(n.get('First'), depth + 1) : [] });
      n = doc.get(n.get('Next'));
    }
    return out;
  };
  let items = read(ol.get('First'), 0);
  if (items.length === 1 && items[0].kids.length >= 2) items = items[0].kids;
  return items;
}
function xmpTitle(doc) {
  try {
    const m = doc.get(doc.catalog().get('Metadata'));
    if (!(m instanceof Stream)) return '';
    const s = new TextDecoder('utf-8').decode(doc.raw(m));
    const t = /<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(s);
    return t ? t[1].replace(/<[^>]+>/g, '').trim() : '';
  } catch (e) { return ''; }
}
function tidyTitle(t) {
  t = (t || '').replace(/^Microsoft (?:Word|PowerPoint) - /i, '').replace(/\s+/g, ' ').trim();
  if (!t || /^(untitled|unknown|document|title)$/i.test(t) || /\.(docx?|indd|pdf|rtf|odt|pages|tex|qxp)$/i.test(t)) return '';
  return t;
}

/* producers fill Author with placeholders; showing "(anonymous)" on a shelf is worse than nothing */
function tidyAuthor(a) {
  a = (a || '').replace(/\s+/g, ' ').trim();
  if (/^\(?(anonymous|unknown|author|administrator|admin|user|owner|default|none|n\/a|-|microsoft office user|windows user|pc|home)\)?$/i.test(a)) return '';
  return a;
}

/* ------------------------------------------------------------------ public API */
export async function extractPdf(buffer, opts = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const head = latin1(bytes.subarray(0, 1024));
  if (!/%PDF-/.test(head)) throw new PdfError('invalid', 'This file is not a PDF.');
  const doc = new PDFDoc(bytes);
  await doc.open();

  const pageList = doc.pages();
  if (!pageList.length) throw new PdfError('invalid', 'This PDF has no pages.');
  const fontCache = new Map(); const pages = []; let chars = 0, bad = 0, cover = null;
  for (let i = 0; i < pageList.length; i++) {
    const pg = pageList[i];
    const mb = pg.mb.map(v => doc.get(v));
    const runs = [], imgs = i === 0 ? [] : null;
    let contents = doc.get(pg.dict.get('Contents'));
    if (!Array.isArray(contents)) contents = contents ? [contents] : [];
    const parts = [];
    for (const c of contents) { const s = doc.get(c); if (s instanceof Stream) parts.push(await doc.decode(s)); }
    const total = parts.reduce((n, p) => n + p.length + 1, 0), all = new Uint8Array(total);
    let o = 0; for (const p of parts) { all.set(p, o); o += p.length; all[o++] = 10; }
    const gs = { ctm: [1, 0, 0, 1, 0, 0], font: null, size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0 };
    try { await runContent(doc, all, pg.res, gs, runs, fontCache, 0, imgs); } catch (e) {}
    for (const r of runs) { const t = r.text.replace(/\s/g, ''); chars += t.length; for (const ch of t) if (ch === '\ufffd' || (ch >= '\ue000' && ch <= '\uf8ff')) bad++; }
    const top = Math.max(mb[1], mb[3]), h = Math.abs(mb[3] - mb[1]);
    const lines = [];
    segmentsOf(runs).forEach((seg, k) => { for (const L of buildLines(seg)) { L.seg = k; lines.push(L); } });
    pages.push({ ref: pg.ref, lines, top, h });
    if (imgs && imgs.length) {
      let best = null, area = 0;
      for (const im of imgs) {
        const f = doc.get(im.dict.get('Filter')), list = Array.isArray(f) ? f.map(x => nm(doc.get(x))) : [nm(f)];
        const a = (doc.get(im.dict.get('Width')) || 0) * (doc.get(im.dict.get('Height')) || 0);
        if (list[list.length - 1] === 'DCTDecode' && a > area) { area = a; best = im; }
      }
      if (best && area >= 100 * 100) {
        const jpg = await doc.decode(best);                 // undoes any wrapping filters, stops at DCT
        if (jpg[0] === 0xff && jpg[1] === 0xd8) cover = jpg.slice();
      }
    }
    if (opts.onProgress) opts.onProgress(i + 1, pageList.length);
    if (i % 8 === 7) await new Promise(r => setTimeout(r, 0));
  }
  if (chars < 30) throw new PdfError('no-text', 'This PDF has no text layer — it looks like scanned pages, which would need text recognition to read.');
  if (bad / chars > 0.6) throw new PdfError('unmappable', 'The fonts in this PDF do not say which letters they draw, so its text cannot be recovered.');

  removeFurniture(pages);
  const flow = [];
  pages.forEach((p, pi) => {
    const bySeg = new Map();
    for (const L of p.lines) { if (!bySeg.has(L.seg)) bySeg.set(L.seg, []); bySeg.get(L.seg).push(L); }
    for (const k of [...bySeg.keys()].sort((a, b) => a - b)) flow.push({ idx: pi, lines: bySeg.get(k), top: p.top, h: p.h });
  });
  const { blocks } = segment(flow);
  if (!blocks.length) throw new PdfError('no-text', 'No readable text was found in this PDF.');

  /* sections: bookmarks, else headings, else ten-page groups */
  const pageIndex = new Map(pageList.map((p, i) => [p.ref, i]));
  let marks = [];
  for (const it of outline(doc)) {
    if (!it.dest || it.dest.page == null) continue;
    const pi = it.dest.page >= 0 ? pageIndex.get(it.dest.page) : -1 - it.dest.page;
    if (pi === undefined || pi < 0 || pi >= pages.length) continue;
    marks.push({ title: it.title || 'Section', page: pi, top: it.dest.top });
  }
  marks.sort((a, b) => a.page - b.page || (b.top ?? 1e9) - (a.top ?? 1e9));
  const sections = [];
  const startSection = (title) => { const s = { title, blocks: [] }; sections.push(s); return s; };
  if (marks.length >= 2) {
    let mi = -1, cur = null;
    for (const b of blocks) {
      while (mi + 1 < marks.length && (marks[mi + 1].page < b.page ||
             (marks[mi + 1].page === b.page && (marks[mi + 1].top == null || b.y <= marks[mi + 1].top + 2)))) {
        mi++; cur = startSection(marks[mi].title);
      }
      if (!cur) cur = startSection('Start');
      cur.blocks.push(b);
    }
  } else if (blocks.filter(b => b.t === 'h').length >= 2) {
    let cur = null;
    for (const b of blocks) {
      if (b.t === 'h') cur = startSection(b.text);
      else if (!cur) cur = startSection('Start');
      cur.blocks.push(b);
    }
  } else {
    let cur = null, curStart = -1;
    for (const b of blocks) {
      if (!cur || b.page - curStart >= 10) { curStart = Math.floor(b.page / 10) * 10; cur = startSection(''); cur.from = curStart; }
      cur.blocks.push(b); cur.to = b.page;
    }
    for (const s of sections) s.title = pages.length <= 10 ? 'Text' : `Pages ${s.from + 1}–${Math.min(s.from + 10, pages.length)}`;
  }
  const cleanSections = sections.filter(s => s.blocks.length).map(s => ({ title: s.title, blocks: s.blocks.map(b => ({ t: b.t, text: b.text })) }));

  const info = doc.get(doc.trailer.get('Info'));
  let title = tidyTitle(isDict(info) ? textString(doc, info.get('Title')) : '') || tidyTitle(xmpTitle(doc));
  const author = tidyAuthor(isDict(info) ? textString(doc, info.get('Author')) : '');
  if (!title && opts.fileName) title = opts.fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
  if (!title) { const h = blocks.find(b => b.t === 'h'); title = h ? h.text : 'Untitled PDF'; }

  return { title, author, pageCount: pages.length, sections: cleanSections, cover };
}
