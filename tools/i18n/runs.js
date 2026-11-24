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
if (typeof module !== 'undefined') module.exports = {TH_RE, splitRuns, runKey};
