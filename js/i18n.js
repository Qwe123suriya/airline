/* Language: Thai (the text as written in game.js) or English (js/en.js). First visit follows the device language;
   the choice in Settings is kept in localStorage "airline-lang" and applied by reloading the page. */
const LANG=(()=>{try{const v=localStorage.getItem("airline-lang");if(v==="th"||v==="en")return v}catch(e){}
  const l=String((navigator.languages&&navigator.languages[0])||navigator.language||"th").toLowerCase();return l.startsWith("th")?"th":"en"})();
document.documentElement.lang=LANG;
if(LANG==="en")document.write('<script src="js/en.js?v=1.65"><\/script>');
// Shared splitter: the same code runs at build time (to list what needs translating) and in the game (to translate).
// A template is joined with placeholder marks +i, then cut into "runs": text between HTML tags, and quoted
// attribute values inside tags. A run that holds Thai is looked up with its placeholders renumbered {0},{1},...
const TH_RE = /[ก-ฺเ-๛]/;
function splitRuns(s) { // -> array of {t:"text"|"raw", v}
  const out = []; let i = 0; const n = s.length;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out.push({t: 'text', v: s.slice(i)}); break }
    // is this a real tag start? letter, / or ! after <
    const c = s[lt + 1];
    if (!(c && /[a-zA-Z\/!]/.test(c))) { const nx = lt + 1; out.push({t: 'text', v: s.slice(i, nx)}); i = nx; continue }
    if (lt > i) out.push({t: 'text', v: s.slice(i, lt)});
    // find tag end, respecting quotes
    let j = lt + 1, q = null;
    for (; j < n; j++) { const ch = s[j]; if (q) { if (ch === q) q = null } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break }
    const tag = s.slice(lt, Math.min(n, j + 1));
    // split quoted attribute values out of the tag
    let k = 0; const re = /(=\s*)(["'])([\s\S]*?)\2/g; let m;
    while ((m = re.exec(tag))) { const vs = m.index + m[1].length + 1; out.push({t: 'raw', v: tag.slice(k, vs)}); out.push({t: 'text', v: m[3], attr: 1}); k = vs + m[3].length }
    out.push({t: 'raw', v: tag.slice(k)});
    i = j + 1;
  }
  // merge adjacent text pieces (from fake '<')
  const merged = []; for (const p of out) { const l = merged[merged.length - 1]; if (l && l.t === 'text' && p.t === 'text' && !l.attr && !p.attr) l.v += p.v; else merged.push({...p}) } return merged;
}
// normalise a run: trim outer whitespace, renumber placeholders. returns {pre, key, post, map:[global idx...]}
function runKey(v) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(v); const core = m[2]; const map = [];
  const key = core.replace(/(\d+)/g, (_, g) => { map.push(+g); return '{' + (map.length - 1) + '}' });
  return {pre: m[1], key, post: m[3], map};
}

/* _T: every Thai text in the game goes through _T("…") or _T`…`. In Thai it returns the text as written (fast path).
   In English each piece of text between HTML tags (and each quoted attribute value) is looked up in EN_DICT with its
   ${…} values written as {0},{1}… so a translation can move them around. Results are cached per call site. */
const I18N_MISS=new Set(),T_TPL=new WeakMap(),T_STR=new Map();
// Thai is written without spaces between words, so a Thai run often touches the bold/inline tag next to it.
// English needs a space there: add one when a translated run meets an inline tag with no space in between.
const INL_OPEN=/^<(b|span|i|strong|em|small|a|code|u)[\s>]/,INL_CLOSE=/<\/(b|span|i|strong|em|small|a|code|u)>$/;
function trJoined(s){if(typeof EN_DICT==="undefined")return s;let o="";const P=splitRuns(s);
  for(let i=0;i<P.length;i++){const p=P[i];if(p.t!=="text"||!TH_RE.test(p.v)){o+=p.v;continue}
    const k=runKey(p.v),e=EN_DICT[k.key];if(e==null){I18N_MISS.add(k.key);o+=p.v;continue}
    let t=e.replace(/\{(\d+)\}/g,(_,n)=>k.map[+n]!=null?""+k.map[+n]+"":"");
    if(!p.attr&&t){const nx=P[i+1],pv=P[i-1];
      if(!k.post&&nx&&nx.t==="raw"&&INL_OPEN.test(nx.v)&&/[\w)%.,:;!?]$/.test(t))t+=" ";
      if(!k.pre&&pv&&pv.t==="raw"&&INL_CLOSE.test(pv.v)&&/^[\w(]/.test(t))t=" "+t}
    o+=k.pre+t+k.post}
  return o}
function tr(s){if(LANG==="th"||typeof s!=="string"||!TH_RE.test(s))return s;let r=T_STR.get(s);if(r===undefined){r=trJoined(s);if(T_STR.size<5000)T_STR.set(s,r)}return r}
function _T(s,...v){
  if(typeof s==="string")return LANG==="th"?s:tr(s);
  if(LANG==="th"){let o=s[0];for(let i=0;i<v.length;i++)o+=v[i]+s[i+1];return o}
  let c=T_TPL.get(s);
  if(!c){const j=trJoined(s.map((q,i)=>q+(i<s.length-1?""+i+"":"")).join("")),bits=j.split(/(\d+)/);
    c={parts:bits.filter((_,i)=>i%2===0),order:bits.filter((_,i)=>i%2===1).map(Number)};T_TPL.set(s,c)}
  let o=c.parts[0];for(let i=0;i<c.order.length;i++)o+=v[c.order[i]]+c.parts[i+1];return o}
