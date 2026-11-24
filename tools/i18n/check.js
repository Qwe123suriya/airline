// Translation check for js/game.js (run: cd tools/i18n && npm i && node check.js [--wrap])
//  - every Thai text in game.js must go through _T("…") or _T`…` (see js/i18n.js); --wrap adds _T to any that don't
//  - every Thai run must have an English entry in js/en.js; missing ones are printed (add them to en.js)
const acorn = require('acorn'), walk = require('acorn-walk'), fs = require('fs'), path = require('path');
const {TH_RE, splitRuns, runKey} = require('./runs.js');
const root = path.join(__dirname, '..', '..'), gp = path.join(root, 'js', 'game.js');
const src = fs.readFileSync(gp, 'utf8'); const ast = acorn.parse(src, {ecmaVersion: 2023, sourceType: 'script', locations: true});
const en = (() => { const t = fs.readFileSync(path.join(root, 'js', 'en.js'), 'utf8'); return JSON.parse(t.slice(t.indexOf('{', t.indexOf('var EN_DICT=')), t.lastIndexOf('}') + 1)) })();
const isT = n => n && n.type === 'Identifier' && n.name === '_T';
const edits = [], miss = new Map(), unwrapped = [];
const note = (joined, line) => { for (const p of splitRuns(joined)) { if (p.t !== 'text' || !TH_RE.test(p.v)) continue; const {key} = runKey(p.v); if (en[key] == null && !miss.has(key)) miss.set(key, line) } };
// text that stays Thai on purpose: the language picker and the Thai↔English rival-name table
const KEEP = new Set(['🌐 ภาษา · Language', 'ไทย']), keepVar = anc => anc.some(a => a.type === 'VariableDeclarator' && a.id.name === 'RIVAL_NAMES');
walk.fullAncestor(ast, (node, st, anc) => { const par = anc[anc.length - 2]; if (node.type === 'Literal' && (KEEP.has(node.value) || keepVar(anc))) return;
  if (node.type === 'Literal' && typeof node.value === 'string' && TH_RE.test(node.value)) {
    const wrapped = par && par.type === 'CallExpression' && isT(par.callee);
    if (!wrapped) { unwrapped.push(node.loc.start.line); edits.push([node.start, '_T(']); edits.push([node.end, ')']) }
    if (wrapped || true) note(node.value, node.loc.start.line) }
  if (node.type === 'TemplateLiteral' && node.quasis.some(q => TH_RE.test(q.value.cooked))) {
    const wrapped = par && par.type === 'TaggedTemplateExpression' && isT(par.tag);
    if (!wrapped) { unwrapped.push(node.loc.start.line); edits.push([node.start, '_T']) }
    note(node.quasis.map((q, i) => q.value.cooked + (i < node.expressions.length ? '' + i + '' : '')).join(''), node.loc.start.line) } });
console.log('Thai text not wrapped in _T:', unwrapped.length ? 'lines ' + [...new Set(unwrapped)].join(', ') : 'none');
console.log('Missing English entries:', miss.size); for (const [k, l] of miss) console.log('  L' + l + '\t' + JSON.stringify(k));
if (process.argv.includes('--wrap') && edits.length) { edits.sort((a, b) => b[0] - a[0] || (a[1] === ')' ? -1 : 1)); let out = src; for (const [pos, s] of edits) out = out.slice(0, pos) + s + out.slice(pos); fs.writeFileSync(gp, out); console.log('wrapped', unwrapped.length) }
process.exitCode = miss.size || unwrapped.length ? 1 : 0;
