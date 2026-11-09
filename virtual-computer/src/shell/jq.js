import {ShellError} from './parse.js';

// A jq subset: paths, pipes, comma, alternatives, comparisons, arithmetic,
// array/object construction, string interpolation, if/elif/else, try/catch,
// reduce/foreach, `as $x` bindings, assignments, and the common builtins and
// @formats. Pure data processing; no input/output, env, modules or `def`.

class JqError extends Error {}
const fail = message => { throw new JqError(message); };

// ---------- lexer ----------

const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'end', 'as', 'and', 'or', 'not', 'try', 'catch', 'reduce', 'foreach', 'def', 'import', 'include', 'label', 'true', 'false', 'null']);

function lex(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '"') {
      // String with \(...) interpolation: parts are strings or sub-sources.
      const parts = [];
      let text = '';
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const n = source[i + 1];
          if (n === '(') {
            let depth = 1, j = i + 2;
            for (; j < source.length && depth; j++) {
              if (source[j] === '(') depth++;
              else if (source[j] === ')') depth--;
              else if (source[j] === '"') { j++; while (j < source.length && source[j] !== '"') { if (source[j] === '\\') j++; j++; } }
            }
            if (depth) fail('unterminated string interpolation');
            if (text) parts.push(text);
            text = '';
            parts.push({source: source.slice(i + 2, j - 1)});
            i = j; continue;
          }
          const map = {n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/'};
          if (n in map) { text += map[n]; i += 2; continue; }
          if (n === 'u') { text += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16)); i += 6; continue; }
          fail(`invalid escape \\${n}`);
        }
        text += source[i++];
      }
      if (i >= source.length) fail('unterminated string');
      i++;
      if (text || !parts.length) parts.push(text);
      tokens.push({t: 'str', parts});
      continue;
    }
    const number = /^(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/.exec(source.slice(i));
    if (number && !(c === '.' && /[a-zA-Z_]/.test(source[i + 1] || ''))) { tokens.push({t: 'num', v: Number(number[0])}); i += number[0].length; continue; }
    const ident = /^[a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*/.exec(source.slice(i));
    if (ident) { tokens.push({t: KEYWORDS.has(ident[0]) ? ident[0] : 'ident', v: ident[0]}); i += ident[0].length; continue; }
    if (c === '$') {
      const name = /^\$([a-zA-Z_][a-zA-Z0-9_]*)/.exec(source.slice(i));
      if (!name) fail('invalid variable');
      tokens.push({t: 'var', v: name[1]}); i += name[0].length; continue;
    }
    if (c === '@') {
      const name = /^@([a-zA-Z0-9_]+)/.exec(source.slice(i));
      if (!name) fail('invalid format');
      tokens.push({t: 'format', v: name[1]}); i += name[0].length; continue;
    }
    if (c === '.' && /[a-zA-Z_]/.test(source[i + 1] || '')) {
      const field = /^\.([a-zA-Z_][a-zA-Z0-9_]*)/.exec(source.slice(i));
      tokens.push({t: 'field', v: field[1]}); i += field[0].length; continue;
    }
    const op = ['|=', '+=', '-=', '*=', '/=', '%=', '//=', '==', '!=', '<=', '>=', '//', '..', '|', ',', '.', '[', ']', '(', ')', '{', '}', ':', ';', '=', '<', '>', '+', '-', '*', '/', '%', '?']
      .find(o => source.startsWith(o, i));
    if (!op) fail(`unexpected character '${c}'`);
    tokens.push({t: op}); i += op.length;
  }
  tokens.push({t: 'eof'});
  return tokens;
}

// ---------- parser ----------

function parser(source) {
  const tokens = lex(source);
  let p = 0;
  const peek = (k = 0) => tokens[p + k];
  const is = t => peek().t === t;
  const take = t => { if (!is(t)) fail(`syntax error: expected '${t}' but got '${peek().v ?? peek().t}'`); return tokens[p++]; };
  const accept = t => is(t) ? tokens[p++] : null;

  function pipe() {
    if (is('def')) fail('def is unavailable in the computer shell jq');
    let left = comma();
    if (accept('as')) {
      const name = take('var').v;
      take('|');
      return {k: 'as', src: left, name, body: pipe()};
    }
    if (accept('|')) return {k: 'pipe', a: left, b: pipe()};
    return left;
  }
  function comma() {
    let left = alternative();
    while (accept(',')) left = {k: 'comma', a: left, b: alternative()};
    return left;
  }
  function alternative() {
    const left = assignment();
    if (accept('//')) return {k: 'alt', a: left, b: alternative()};
    return left;
  }
  function assignment() {
    const left = or();
    for (const op of ['=', '|=', '+=', '-=', '*=', '/=', '%=', '//=']) if (accept(op)) return {k: 'assign', op, path: left, value: alternative()};
    return left;
  }
  function or() { let left = and(); while (accept('or')) left = {k: 'or', a: left, b: and()}; return left; }
  function and() { let left = compare(); while (accept('and')) left = {k: 'and', a: left, b: compare()}; return left; }
  function compare() {
    const left = additive();
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) if (accept(op)) return {k: 'bin', op, a: left, b: additive()};
    return left;
  }
  function additive() {
    let left = multiplicative();
    for (;;) {
      if (accept('+')) left = {k: 'bin', op: '+', a: left, b: multiplicative()};
      else if (accept('-')) left = {k: 'bin', op: '-', a: left, b: multiplicative()};
      else return left;
    }
  }
  function multiplicative() {
    let left = unary();
    for (;;) {
      const op = ['*', '/', '%'].find(o => is(o));
      if (!op) return left;
      p++;
      left = {k: 'bin', op, a: left, b: unary()};
    }
  }
  function unary() {
    if (accept('-')) return {k: 'neg', a: postfix()};
    return postfix();
  }
  function postfix() {
    let node = term();
    for (;;) {
      if (is('field')) node = {k: 'pipe', a: node, b: {k: 'index', key: {k: 'lit', v: tokens[p++].v}}};
      else if (is('.') && peek(1).t === 'str') { p++; node = {k: 'pipe', a: node, b: {k: 'index', key: string(take('str'))}}; }
      else if (is('[') || (is('.') && peek(1).t === '[')) { accept('.'); node = {k: 'pipe', a: node, b: bracket()}; }
      else if (accept('?')) node = {k: 'try', body: node};
      else return node;
    }
  }
  function bracket() {
    take('[');
    if (accept(']')) return {k: 'iterate'};
    if (accept(':')) { const to = pipe(); take(']'); return {k: 'slice', to}; }
    const key = pipe();
    if (accept(':')) { const to = is(']') ? null : pipe(); take(']'); return {k: 'slice', from: key, to}; }
    take(']');
    return {k: 'index', key};
  }
  function string(token) {
    return {k: 'str', parts: token.parts.map(part => typeof part === 'string' ? part : parser(part.source))};
  }
  function term() {
    const token = peek();
    switch (token.t) {
      case 'num': p++; return {k: 'lit', v: token.v};
      case 'str': p++; return string(token);
      case 'true': p++; return {k: 'lit', v: true};
      case 'false': p++; return {k: 'lit', v: false};
      case 'null': p++; return {k: 'lit', v: null};
      case 'format': {
        p++;
        if (is('str')) return {k: 'fmtstr', format: token.v, str: string(take('str'))};
        return {k: 'format', format: token.v};
      }
      case 'field': p++; return {k: 'index', key: {k: 'lit', v: token.v}};
      case '..': p++; return {k: 'call', name: 'recurse', args: []};
      case '.': {
        p++;
        if (is('str')) return {k: 'index', key: string(take('str'))};
        if (is('[')) return bracket();
        return {k: 'identity'};
      }
      case 'var': p++; return {k: 'var', name: token.v};
      case '(': { p++; const inner = pipe(); take(')'); return inner; }
      case '[': { p++; if (accept(']')) return {k: 'array', body: null}; const body = pipe(); take(']'); return {k: 'array', body}; }
      case '{': return object();
      case 'if': {
        p++;
        const cond = pipe(); take('then');
        const then = pipe();
        let otherwise = null;
        if (is('elif')) { tokens[p] = {t: 'if'}; otherwise = term(); return {k: 'if', cond, then, otherwise}; }
        if (accept('else')) otherwise = pipe();
        take('end');
        return {k: 'if', cond, then, otherwise};
      }
      case 'try': {
        p++;
        const body = postfix();
        const handler = accept('catch') ? postfix() : null;
        return {k: 'try', body, handler};
      }
      case 'reduce': case 'foreach': {
        p++;
        const src = postfix(); take('as');
        const name = take('var').v;
        take('(');
        const init = pipe(); take(';');
        const update = pipe();
        let extract = null;
        if (token.t === 'foreach' && accept(';')) extract = pipe();
        take(')');
        return {k: token.t, src, name, init, update, extract};
      }
      case 'not': p++; return {k: 'call', name: 'not', args: []};
      case 'ident': {
        p++;
        const args = [];
        if (accept('(')) { do args.push(pipe()); while (accept(';')); take(')'); }
        return {k: 'call', name: token.v, args};
      }
      case '-': p++; return {k: 'neg', a: postfix()};
      default: fail(`syntax error: unexpected '${token.v ?? token.t}'`);
    }
  }
  function object() {
    take('{');
    const entries = [];
    if (!accept('}')) {
      do {
        let key, value = null;
        if (is('var')) { const name = take('var').v; key = {k: 'lit', v: name}; value = {k: 'var', name}; }
        else if (is('ident') || KEYWORDS.has(peek().t)) { const name = tokens[p++].v; key = {k: 'lit', v: name}; }
        else if (is('str')) key = string(take('str'));
        else if (is('format')) { key = {k: 'format', format: take('format').v}; }
        else if (accept('(')) { key = pipe(); take(')'); }
        else if (is('num')) key = {k: 'lit', v: String(take('num').v)};
        else fail('syntax error in object key');
        if (accept(':')) value = objectValue();
        else if (!value) value = {k: 'index', key};
        entries.push({key, value});
      } while (accept(','));
      take('}');
    }
    return {k: 'object', entries};
  }
  function objectValue() {
    let left = alternative();
    while (is('|')) { p++; left = {k: 'pipe', a: left, b: alternative()}; }
    return left;
  }
  const ast = pipe();
  if (!is('eof')) fail(`syntax error: unexpected '${peek().v ?? peek().t}'`);
  return ast;
}

// ---------- values ----------

const type = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v;
const ORDER = ['null', 'boolean', 'number', 'string', 'array', 'object'];
const truthy = v => v !== null && v !== false;
function compare(a, b) {
  const ta = type(a), tb = type(b);
  if (ta !== tb) return ORDER.indexOf(ta) - ORDER.indexOf(tb);
  if (ta === 'boolean') return Number(a) - Number(b);
  if (ta === 'number') return a - b;
  if (ta === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (ta === 'array') { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = compare(a[i], b[i]); if (c) return c; } return a.length - b.length; }
  if (ta === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    const c = compare(ka, kb);
    if (c) return c;
    for (const k of ka) { const d = compare(a[k], b[k]); if (d) return d; }
  }
  return 0;
}
const equal = (a, b) => compare(a, b) === 0;
const text = v => typeof v === 'string' ? v : JSON.stringify(v);
const show = v => { const s = JSON.stringify(v); return s.length > 40 ? s.slice(0, 37) + '...' : s; };

function arithmetic(op, a, b) {
  const ta = type(a), tb = type(b);
  switch (op) {
    case '+':
      if (a === null) return b;
      if (b === null) return a;
      if (ta === 'number' && tb === 'number') return a + b;
      if (ta === 'string' && tb === 'string') return a + b;
      if (ta === 'array' && tb === 'array') return [...a, ...b];
      if (ta === 'object' && tb === 'object') return {...a, ...b};
      break;
    case '-':
      if (ta === 'number' && tb === 'number') return a - b;
      if (ta === 'array' && tb === 'array') return a.filter(x => !b.some(y => equal(x, y)));
      break;
    case '*':
      if (ta === 'number' && tb === 'number') return a * b;
      if (ta === 'string' && tb === 'number') return b > 0 ? a.repeat(Math.min(b, 1e6)) : null;
      if (ta === 'object' && tb === 'object') return deepMerge(a, b);
      break;
    case '/':
      if (ta === 'number' && tb === 'number') { if (b === 0) fail(`${show(a)} and ${show(b)} cannot be divided because the divisor is zero`); return a / b; }
      if (ta === 'string' && tb === 'string') return a.split(b);
      break;
    case '%':
      if (ta === 'number' && tb === 'number') { if (Math.trunc(b) === 0) fail(`${show(a)} and ${show(b)} cannot be divided because the divisor is zero`); return Math.trunc(a) % Math.trunc(b); }
      break;
  }
  fail(`${ta} (${show(a)}) and ${tb} (${show(b)}) cannot be ${{'+': 'added', '-': 'subtracted', '*': 'multiplied', '/': 'divided', '%': 'divided'}[op]}`);
}
function deepMerge(a, b) {
  const out = {...a};
  for (const [k, v] of Object.entries(b)) out[k] = type(out[k]) === 'object' && type(v) === 'object' ? deepMerge(out[k], v) : v;
  return out;
}

function index(value, key) {
  if (value === null) return null;
  if (typeof key === 'string') { if (type(value) !== 'object') fail(`Cannot index ${type(value)} with "${key}"`); return Object.hasOwn(value, key) ? value[key] : null; }
  if (typeof key === 'number') {
    if (!Array.isArray(value)) fail(`Cannot index ${type(value)} with number`);
    const i = Math.floor(key) < 0 ? value.length + Math.floor(key) : Math.floor(key);
    return i >= 0 && i < value.length ? value[i] : null;
  }
  if (key && typeof key === 'object' && !Array.isArray(key)) return slice(value, key.start ?? null, key.end ?? null);
  fail(`Cannot index ${type(value)} with ${type(key)}`);
}
function sliceBounds(length, from, to) {
  const norm = (v, d) => v === null ? d : Math.max(0, Math.min(length, v < 0 ? length + Math.floor(v) : Math.floor(v)));
  return [norm(from, 0), norm(to, length)];
}
function slice(value, from, to) {
  if (value === null) return null;
  if (typeof value !== 'string' && !Array.isArray(value)) fail(`Cannot index ${type(value)} with object`);
  const [a, b] = sliceBounds(value.length, from, to);
  return value.slice(a, Math.max(a, b));
}

function setPath(root, path, value) {
  if (!path.length) return value;
  const [key, ...rest] = path;
  if (key && typeof key === 'object') {
    const base = root ?? [];
    const [a, b] = sliceBounds(base.length, key.start ?? null, key.end ?? null);
    const replaced = setPath(base.slice(a, Math.max(a, b)), rest, value);
    if (!Array.isArray(replaced)) fail('A slice of an array can only be assigned another array');
    return [...base.slice(0, a), ...replaced, ...base.slice(Math.max(a, b))];
  }
  if (typeof key === 'number') {
    if (root !== null && !Array.isArray(root)) fail(`Cannot index ${type(root)} with number`);
    const out = [...(root ?? [])];
    const i = key < 0 ? out.length + key : key;
    if (i < 0) fail('Out of bounds negative array index');
    if (i > 100_000_000) fail('Array index too large');
    while (out.length < i) out.push(null);
    out[i] = setPath(out[i] ?? null, rest, value);
    return out;
  }
  if (root !== null && type(root) !== 'object') fail(`Cannot index ${type(root)} with "${key}"`);
  return {...(root ?? {}), [key]: setPath(root?.[key] ?? null, rest, value)};
}
function getPath(root, path) {
  let v = root;
  for (const key of path) { if (v === null) return null; v = index(v, key); }
  return v;
}
function deletePaths(root, paths) {
  const sorted = [...paths].sort((a, b) => compare(b, a));
  let out = root;
  for (const path of sorted) out = deletePath(out, path);
  return out;
}
function deletePath(root, path) {
  if (!path.length) return null;
  if (root === null) return null;
  const [key, ...rest] = path;
  if (rest.length) {
    const child = index(root, key);
    if (child === null) return root;
    return setPath(root, [key], deletePath(child, rest));
  }
  if (Array.isArray(root)) {
    if (key && typeof key === 'object') { const [a, b] = sliceBounds(root.length, key.start ?? null, key.end ?? null); return [...root.slice(0, a), ...root.slice(Math.max(a, b))]; }
    const i = key < 0 ? root.length + key : key;
    return root.filter((_, k) => k !== i);
  }
  if (type(root) !== 'object') fail(`Cannot delete field at index of ${type(root)}`);
  const out = {...root};
  delete out[key];
  return out;
}

function toRegExp(re, flags = '') {
  if (typeof re !== 'string') fail(`${type(re)} cannot be matched, as it is not a string`);
  if (typeof flags !== 'string' && flags !== null) fail('flags must be a string');
  let js = 'u';
  for (const f of flags || '') { if (f === 'i') js += 'i'; else if (f === 'g') js += 'g'; else if (f === 'x') re = re.replace(/\s+|#.*$/gm, ''); else if (f === 's') js += 's'; else if (f === 'n' || f === 'l' || f === 'p') continue; else fail(`${f} is not a valid modifier string`); }
  try { return new RegExp(re.replace(/\(\?<([a-zA-Z_][a-zA-Z0-9_]*)>/g, '(?<$1>'), js); }
  catch { fail(`${re} (at offset 0) is not a valid regex`); }
}

function formatValue(name, v) {
  switch (name) {
    case 'text': return text(v);
    case 'json': return JSON.stringify(v);
    case 'html': return text(v).replace(/[<>&'"]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;'})[c]);
    case 'uri': return [...Buffer.from(text(v))].map(b => /[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
    case 'csv': case 'tsv': {
      if (!Array.isArray(v)) fail(`${type(v)} (${show(v)}) cannot be ${name}-formatted, only an array can be`);
      return v.map(x => {
        if (x === null) return '';
        if (typeof x === 'number' || typeof x === 'boolean') return String(x);
        if (typeof x !== 'string') fail(`${type(x)} (${show(x)}) is not valid in a csv row`);
        return name === 'csv' ? '"' + x.replaceAll('"', '""') + '"' : x.replace(/[\\\t\r\n]/g, c => ({'\\': '\\\\', '\t': '\\t', '\r': '\\r', '\n': '\\n'})[c]);
      }).join(name === 'csv' ? ',' : '\t');
    }
    case 'sh': return (Array.isArray(v) ? v : [v]).map(x => typeof x === 'string' ? "'" + x.replaceAll("'", "'\\''") + "'" : type(x) === 'object' || Array.isArray(x) ? fail(`${type(x)} can not be escaped for shell`) : String(x)).join(' ');
    case 'base64': return Buffer.from(text(v)).toString('base64');
    case 'base64d': return Buffer.from(text(v), 'base64').toString('utf8');
    default: fail(`${name} is not a valid format`);
  }
}

// ---------- evaluator ----------

const MAX_STEPS = 50_000_000;
const MAX_RANGE = 10_000_000;

function makeEvaluator(vars) {
  let steps = 0;
  const tick = () => { if (++steps > MAX_STEPS) fail('jq program is too expensive; narrow it'); };
  const single = (node, input, env) => { for (const v of ev(node, input, env)) return v; return undefined; };
  const all = (node, input, env) => [...ev(node, input, env)];
  const cartesian = function* (nodes, input, env, k = 0, acc = []) {
    if (k === nodes.length) { yield acc; return; }
    for (const v of ev(nodes[k], input, env)) yield* cartesian(nodes, input, env, k + 1, [...acc, v]);
  };

  function* ev(node, input, env) {
    tick();
    switch (node.k) {
      case 'identity': yield input; return;
      case 'lit': yield node.v; return;
      case 'str': {
        for (const parts of cartesian(node.parts.map(part => typeof part === 'string' ? {k: 'lit', v: part} : part), input, env))
          yield parts.map((v, i) => typeof node.parts[i] === 'string' ? v : text(v)).join('');
        return;
      }
      case 'fmtstr': {
        for (const parts of cartesian(node.str.parts.map(part => typeof part === 'string' ? {k: 'lit', v: part} : part), input, env))
          yield parts.map((v, i) => typeof node.str.parts[i] === 'string' ? v : formatValue(node.format, v)).join('');
        return;
      }
      case 'format': yield formatValue(node.format, input); return;
      case 'var': {
        if (node.name === 'ENV' || node.name === '__prog_args') { yield {}; return; }
        if (node.name === '__loc__') { yield {file: '<stdin>', line: 1}; return; }
        if (!env.has(node.name)) fail(`$${node.name} is not defined`);
        yield env.get(node.name); return;
      }
      case 'index':
        for (const key of ev(node.key, input, env)) yield index(input, key);
        return;
      case 'slice': {
        for (const to of node.to ? ev(node.to, input, env) : [null]) for (const from of node.from ? ev(node.from, input, env) : [null]) yield slice(input, from, to);
        return;
      }
      case 'iterate':
        if (Array.isArray(input)) yield* input;
        else if (type(input) === 'object') yield* Object.values(input);
        else fail(`Cannot iterate over ${type(input)}${input === null ? '' : ` (${show(input)})`}`);
        return;
      case 'pipe': for (const v of ev(node.a, input, env)) yield* ev(node.b, v, env); return;
      case 'comma': yield* ev(node.a, input, env); yield* ev(node.b, input, env); return;
      case 'alt': {
        let any = false;
        try { for (const v of ev(node.a, input, env)) if (truthy(v)) { any = true; yield v; } }
        catch (error) { if (!(error instanceof JqError)) throw error; }
        if (!any) yield* ev(node.b, input, env);
        return;
      }
      case 'or': for (const a of ev(node.a, input, env)) { if (truthy(a)) yield true; else for (const b of ev(node.b, input, env)) yield truthy(b); } return;
      case 'and': for (const a of ev(node.a, input, env)) { if (!truthy(a)) yield false; else for (const b of ev(node.b, input, env)) yield truthy(b); } return;
      case 'bin': {
        for (const b of ev(node.b, input, env)) for (const a of ev(node.a, input, env)) {
          switch (node.op) {
            case '==': yield equal(a, b); break;
            case '!=': yield !equal(a, b); break;
            case '<': yield compare(a, b) < 0; break;
            case '<=': yield compare(a, b) <= 0; break;
            case '>': yield compare(a, b) > 0; break;
            case '>=': yield compare(a, b) >= 0; break;
            default: yield arithmetic(node.op, a, b);
          }
        }
        return;
      }
      case 'neg': for (const v of ev(node.a, input, env)) { if (typeof v !== 'number') fail(`${type(v)} (${show(v)}) cannot be negated`); yield -v; } return;
      case 'array': yield node.body ? all(node.body, input, env) : []; return;
      case 'object': {
        const build = function* (k, acc) {
          if (k === node.entries.length) { yield acc; return; }
          const {key, value} = node.entries[k];
          for (const name of ev(key, input, env)) {
            if (typeof name !== 'string') fail(`Object keys must be strings`);
            for (const v of ev(value, input, env)) yield* build(k + 1, {...acc, [name]: v});
          }
        };
        yield* build(0, {});
        return;
      }
      case 'if':
        for (const c of ev(node.cond, input, env)) {
          if (truthy(c)) yield* ev(node.then, input, env);
          else if (node.otherwise) yield* ev(node.otherwise, input, env);
          else yield input;
        }
        return;
      case 'try': {
        const out = [];
        try { for (const v of ev(node.body, input, env)) out.push(v); }
        catch (error) {
          if (!(error instanceof JqError)) throw error;
          yield* out;
          if (node.handler && !error.isBreak) yield* ev(node.handler, error.value ?? error.message, env);
          return;
        }
        yield* out;
        return;
      }
      case 'as':
        for (const v of ev(node.src, input, env)) yield* ev(node.body, input, new Map(env).set(node.name, v));
        return;
      case 'reduce': {
        for (const init of ev(node.init, input, env)) {
          let acc = init;
          for (const v of ev(node.src, input, env)) {
            const scope = new Map(env).set(node.name, v);
            let last = null;
            for (const next of ev(node.update, acc, scope)) last = next;
            acc = last;
          }
          yield acc;
        }
        return;
      }
      case 'foreach': {
        for (const init of ev(node.init, input, env)) {
          let acc = init;
          for (const v of ev(node.src, input, env)) {
            const scope = new Map(env).set(node.name, v);
            for (const next of ev(node.update, acc, scope)) {
              acc = next;
              if (node.extract) yield* ev(node.extract, acc, scope); else yield acc;
            }
          }
        }
        return;
      }
      case 'assign': yield* assign(node, input, env); return;
      case 'call': yield* call(node, input, env); return;
    }
    fail(`unsupported expression ${node.k}`);
  }

  // Path mode: [path, value] pairs for path expressions.
  function* paths(node, input, env, base = []) {
    tick();
    switch (node.k) {
      case 'identity': yield [base, input]; return;
      case 'index': for (const key of ev(node.key, input, env)) yield [[...base, key], index(input, key)]; return;
      case 'slice':
        for (const to of node.to ? ev(node.to, input, env) : [null]) for (const from of node.from ? ev(node.from, input, env) : [null])
          yield [[...base, {start: from, end: to}], slice(input, from, to)];
        return;
      case 'iterate':
        if (Array.isArray(input)) for (let i = 0; i < input.length; i++) yield [[...base, i], input[i]];
        else if (type(input) === 'object') for (const [k, v] of Object.entries(input)) yield [[...base, k], v];
        else if (input !== null) fail(`Cannot iterate over ${type(input)}`);
        return;
      case 'pipe': for (const [p, v] of paths(node.a, input, env, base)) yield* paths(node.b, v, env, p); return;
      case 'comma': yield* paths(node.a, input, env, base); yield* paths(node.b, input, env, base); return;
      case 'if': for (const c of ev(node.cond, input, env)) { if (truthy(c)) yield* paths(node.then, input, env, base); else if (node.otherwise) yield* paths(node.otherwise, input, env, base); else yield [base, input]; } return;
      case 'alt': {
        const found = [];
        try { for (const pair of paths(node.a, input, env, base)) if (truthy(pair[1])) found.push(pair); } catch (error) { if (!(error instanceof JqError)) throw error; }
        if (found.length) yield* found; else yield* paths(node.b, input, env, base);
        return;
      }
      case 'try': try { yield* [...paths(node.body, input, env, base)]; } catch (error) { if (!(error instanceof JqError)) throw error; } return;
      case 'as': for (const v of ev(node.src, input, env)) yield* paths(node.body, input, new Map(env).set(node.name, v), base); return;
      case 'lit': if (node.v === null) { yield [base, null]; return; } break;
      case 'call': {
        const name = node.name, args = node.args;
        if (name === 'empty') return;
        if (name === 'select' && args.length === 1) { for (const c of ev(args[0], input, env)) if (truthy(c)) yield [base, input]; return; }
        if (name === 'recurse' && args.length === 0) {
          const walk = function* (p, v) { yield [p, v]; if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* walk([...p, i], v[i]); else if (type(v) === 'object') for (const [k, x] of Object.entries(v)) yield* walk([...p, k], x); };
          yield* walk(base, input); return;
        }
        if (name === 'first' && args.length === 1) { for (const pair of paths(args[0], input, env, base)) { yield pair; return; } return; }
        if (name === 'last' && args.length === 0) { yield [[...base, -1], index(input, -1)]; return; }
        if (name === 'first' && args.length === 0) { yield [[...base, 0], index(input, 0)]; return; }
        if (name === 'getpath' && args.length === 1) { for (const p of ev(args[0], input, env)) yield [[...base, ...p], getPath(input, p)]; return; }
        break;
      }
    }
    fail('Invalid path expression');
  }

  function* assign(node, input, env) {
    if (node.op === '=') {
      for (const value of ev(node.value, input, env)) {
        let out = input;
        for (const [p] of [...paths(node.path, input, env)]) out = setPath(out, p, value);
        yield out;
      }
      return;
    }
    if (node.op === '|=') {
      let out = input;
      for (const [p] of [...paths(node.path, input, env)]) {
        const next = single(node.value, getPath(out, p), env);
        out = next === undefined ? deletePath(out, p) : setPath(out, p, next);
      }
      yield out;
      return;
    }
    const op = node.op.slice(0, -1);
    for (const value of ev(node.value, input, env)) {
      let out = input;
      for (const [p] of [...paths(node.path, input, env)]) {
        const current = getPath(out, p);
        out = setPath(out, p, op === '//' ? (truthy(current) ? current : value) : arithmetic(op, current, value));
      }
      yield out;
    }
  }

  function* call(node, input, env) {
    const {name, args} = node;
    const arg = k => args[k];
    const one = k => { const v = single(args[k], input, env); if (v === undefined) fail(`${name}: argument produced no value`); return v; };
    const each = function* (k) { yield* ev(args[k], input, env); };
    const str = (v, what = name) => { if (typeof v !== 'string') fail(`${type(v)} (${show(v)}) cannot be ${what === name ? 'used with ' + name : what}`); return v; };
    const arr = v => { if (!Array.isArray(v)) fail(`Cannot ${name} ${type(v)}${v === null ? '' : ` (${show(v)})`}`); return v; };
    const key = `${name}/${args.length}`;
    switch (key) {
      case 'empty/0': return;
      case 'error/0': throw Object.assign(new JqError(text(input)), {value: input});
      case 'error/1': { const v = one(0); throw Object.assign(new JqError(text(v)), {value: v}); }
      case 'not/0': yield !truthy(input); return;
      case 'length/0':
        if (input === null) yield 0;
        else if (typeof input === 'boolean') fail('boolean (' + input + ') has no length');
        else if (typeof input === 'number') yield Math.abs(input);
        else if (typeof input === 'string') yield [...input].length;
        else yield Array.isArray(input) ? input.length : Object.keys(input).length;
        return;
      case 'utf8bytelength/0': yield Buffer.byteLength(str(input)); return;
      case 'keys/0': case 'keys_unsorted/0':
        if (Array.isArray(input)) yield input.map((_, i) => i);
        else if (type(input) === 'object') yield name === 'keys' ? Object.keys(input).sort() : Object.keys(input);
        else fail(`${type(input)} (${show(input)}) has no keys`);
        return;
      case 'values/0': if (input !== null) yield input; return;
      case 'has/1': for (const k of each(0)) yield Array.isArray(input) ? (typeof k === 'number' && k >= 0 && k < input.length) : (type(input) === 'object' ? Object.hasOwn(input, str(k)) : fail(`Cannot check whether ${type(input)} has a key`)); return;
      case 'in/1': for (const o of each(0)) yield Array.isArray(o) ? input >= 0 && input < o.length : Object.hasOwn(o, input); return;
      case 'contains/1': for (const b of each(0)) yield contains(input, b); return;
      case 'inside/1': for (const b of each(0)) yield contains(b, input); return;
      case 'map/1': yield arr(input).flatMap(v => all(arg(0), v, env)); return;
      case 'map_values/1': {
        if (Array.isArray(input)) { yield input.flatMap(v => { const r = single(arg(0), v, env); return r === undefined ? [] : [r]; }); return; }
        if (type(input) !== 'object') fail(`Cannot iterate over ${type(input)}`);
        const out = {};
        for (const [k, v] of Object.entries(input)) { const r = single(arg(0), v, env); if (r !== undefined) out[k] = r; }
        yield out; return;
      }
      case 'select/1': for (const c of each(0)) if (truthy(c)) yield input; return;
      case 'recurse/0': {
        const walk = function* (v) { yield v; if (Array.isArray(v)) for (const x of v) yield* walk(x); else if (type(v) === 'object') for (const x of Object.values(v)) yield* walk(x); };
        yield* walk(input); return;
      }
      case 'recurse/1': {
        const walk = function* (v, depth) { if (depth > 10000) fail('recursion too deep'); yield v; for (const next of ev(arg(0), v, env)) yield* walk(next, depth + 1); };
        try { yield* walk(input, 0); } catch (error) { if (!(error instanceof JqError) || !/Cannot iterate/.test(error.message)) throw error; }
        return;
      }
      case 'add/0': {
        const list = Array.isArray(input) ? input : type(input) === 'object' ? Object.values(input) : fail(`Cannot iterate over ${type(input)}`);
        yield list.reduce((acc, v) => acc === undefined ? v : arithmetic('+', acc, v), undefined) ?? null; return;
      }
      case 'add/1': { const list = all(arg(0), input, env); yield list.reduce((acc, v) => acc === undefined ? v : arithmetic('+', acc, v), undefined) ?? null; return; }
      case 'any/0': yield arr(input).some(truthy); return;
      case 'all/0': yield arr(input).every(truthy); return;
      case 'any/1': yield arr(input).some(v => all(arg(0), v, env).some(truthy)); return;
      case 'all/1': yield arr(input).every(v => all(arg(0), v, env).every(truthy)); return;
      case 'any/2': yield all(arg(0), input, env).some(v => all(arg(1), v, env).some(truthy)); return;
      case 'all/2': yield all(arg(0), input, env).every(v => all(arg(1), v, env).every(truthy)); return;
      case 'range/1': case 'range/2': case 'range/3': {
        const [from, to, by] = args.length === 1 ? [0, one(0), 1] : args.length === 2 ? [one(0), one(1), 1] : [one(0), one(1), one(2)];
        if (![from, to, by].every(n => typeof n === 'number')) fail('Range bounds must be numeric');
        if (by === 0) return;
        if (Math.abs((to - from) / by) > MAX_RANGE) fail('range is too large');
        for (let v = from; by > 0 ? v < to : v > to; v += by) yield v;
        return;
      }
      case 'floor/0': yield Math.floor(input); return;
      case 'ceil/0': yield Math.ceil(input); return;
      case 'round/0': yield Math.round(input); return;
      case 'fabs/0': case 'abs/0': yield Math.abs(input); return;
      case 'sqrt/0': yield Math.sqrt(input); return;
      case 'pow/2': yield Math.pow(one(0), one(1)); return;
      case 'log/0': yield Math.log(input); return;
      case 'exp/0': yield Math.exp(input); return;
      case 'log10/0': yield Math.log10(input); return;
      case 'infinite/0': yield Infinity; return;
      case 'nan/0': yield NaN; return;
      case 'isnan/0': yield Number.isNaN(input); return;
      case 'tostring/0': yield text(input); return;
      case 'tonumber/0': {
        if (typeof input === 'number') { yield input; return; }
        const n = Number(str(input));
        if (input.trim() === '' || Number.isNaN(n)) fail(`Cannot parse '${input}' as JSON`);
        yield n; return;
      }
      case 'type/0': yield type(input); return;
      case 'arrays/0': if (Array.isArray(input)) yield input; return;
      case 'objects/0': if (type(input) === 'object') yield input; return;
      case 'strings/0': if (typeof input === 'string') yield input; return;
      case 'numbers/0': if (typeof input === 'number') yield input; return;
      case 'booleans/0': if (typeof input === 'boolean') yield input; return;
      case 'nulls/0': if (input === null) yield input; return;
      case 'iterables/0': if (Array.isArray(input) || type(input) === 'object') yield input; return;
      case 'scalars/0': if (!Array.isArray(input) && type(input) !== 'object') yield input; return;
      case 'sort/0': yield [...arr(input)].sort(compare); return;
      case 'sort_by/1': yield [...arr(input)].map(v => [all(arg(0), v, env), v]).sort((a, b) => compare(a[0], b[0])).map(x => x[1]); return;
      case 'group_by/1': {
        const sorted = [...arr(input)].map(v => [all(arg(0), v, env), v]).sort((a, b) => compare(a[0], b[0]));
        const out = [];
        for (const [k, v] of sorted) { if (out.length && equal(out[out.length - 1].k, k)) out[out.length - 1].v.push(v); else out.push({k, v: [v]}); }
        yield out.map(g => g.v); return;
      }
      case 'unique/0': yield [...arr(input)].sort(compare).filter((v, i, a) => i === 0 || !equal(a[i - 1], v)); return;
      case 'unique_by/1': {
        const sorted = [...arr(input)].map(v => [all(arg(0), v, env), v]).sort((a, b) => compare(a[0], b[0]));
        yield sorted.filter((x, i) => i === 0 || !equal(sorted[i - 1][0], x[0])).map(x => x[1]); return;
      }
      case 'min/0': yield arr(input).length ? [...input].sort(compare)[0] : null; return;
      case 'max/0': yield arr(input).length ? [...input].sort(compare).at(-1) : null; return;
      case 'min_by/1': case 'max_by/1': {
        const list = [...arr(input)].map(v => [all(arg(0), v, env), v]).sort((a, b) => compare(a[0], b[0]));
        yield list.length ? (name === 'min_by' ? list[0][1] : list.at(-1)[1]) : null; return;
      }
      case 'reverse/0': yield input === null ? [] : typeof input === 'string' ? [...input].reverse().join('') : [...arr(input)].reverse(); return;
      case 'flatten/0': case 'flatten/1': {
        const depth = args.length ? one(0) : 1e9;
        if (depth < 0) fail('flatten depth must not be negative');
        const flat = (list, d) => list.flatMap(v => Array.isArray(v) && d > 0 ? flat(v, d - 1) : [v]);
        yield flat(arr(input), depth); return;
      }
      case 'first/0': yield index(input, 0); return;
      case 'last/0': yield index(input, -1); return;
      case 'first/1': for (const v of each(0)) { yield v; return; } return;
      case 'last/1': { let last, any = false; for (const v of each(0)) { last = v; any = true; } if (any) yield last; return; }
      case 'nth/1': yield index(input, one(0)); return;
      case 'nth/2': { let k = one(0); for (const v of ev(arg(1), input, env)) if (k-- === 0) { yield v; return; } return; }
      case 'limit/2': { let n = one(0); if (n <= 0) return; for (const v of ev(arg(1), input, env)) { yield v; if (--n <= 0) return; } return; }
      case 'until/2': { let v = input, k = 0; while (!truthy(single(arg(0), v, env))) { if (++k > 1e6) fail('until: too many iterations'); v = single(arg(1), v, env); } yield v; return; }
      case 'while/2': { let v = input, k = 0; while (truthy(single(arg(0), v, env))) { if (++k > 1e6) fail('while: too many iterations'); yield v; v = single(arg(1), v, env); } return; }
      case 'repeat/1': { let v = input, k = 0; for (;;) { if (++k > 1e6) fail('repeat: too many iterations'); yield v; v = single(arg(0), v, env); if (v === undefined) return; } }
      case 'isempty/1': { for (const _ of each(0)) { yield false; return; } yield true; return; }
      case 'indices/1': case 'index/1': case 'rindex/1': {
        const needle = one(0);
        let found = [];
        if (typeof input === 'string') { if (needle === '') found = []; else for (let i = input.indexOf(needle); i >= 0; i = input.indexOf(needle, i + 1)) found.push(i); }
        else if (Array.isArray(input)) {
          const seq = Array.isArray(needle) ? needle : [needle];
          for (let i = 0; i + seq.length <= input.length; i++) if (seq.length && seq.every((x, j) => equal(input[i + j], x))) found.push(i);
        } else if (input === null) { yield null; return; }
        yield name === 'indices' ? found : name === 'index' ? (found[0] ?? null) : (found.at(-1) ?? null); return;
      }
      case 'startswith/1': yield str(input).startsWith(str(one(0))); return;
      case 'endswith/1': yield str(input).endsWith(str(one(0))); return;
      case 'ltrimstr/1': { const p = one(0); yield typeof input === 'string' && typeof p === 'string' && input.startsWith(p) ? input.slice(p.length) : input; return; }
      case 'rtrimstr/1': { const p = one(0); yield typeof input === 'string' && typeof p === 'string' && p && input.endsWith(p) ? input.slice(0, -p.length) : input; return; }
      case 'trim/0': yield str(input).trim(); return;
      case 'ltrim/0': yield str(input).trimStart(); return;
      case 'rtrim/0': yield str(input).trimEnd(); return;
      case 'ascii_downcase/0': yield str(input).replace(/[A-Z]/g, c => c.toLowerCase()); return;
      case 'ascii_upcase/0': yield str(input).replace(/[a-z]/g, c => c.toUpperCase()); return;
      case 'explode/0': yield [...str(input)].map(c => c.codePointAt(0)); return;
      case 'implode/0': yield String.fromCodePoint(...arr(input)); return;
      case 'split/1': yield str(input).split(str(one(0))); return;
      case 'split/2': yield str(input).split(toRegExp(one(0), (one(1) || '').replace('g', ''))); return;
      case 'join/1': { const sep = str(one(0)); yield arr(input).map(v => v === null ? '' : typeof v === 'object' ? fail(`Cannot join with ${type(v)}`) : String(v)).join(sep); return; }
      case 'ascii/0': yield String.fromCharCode(input); return;
      case 'test/1': case 'test/2': yield toRegExp(one(0), args[1] ? one(1) : '').test(str(input, 'matched, as it is not a string')); return;
      case 'match/1': case 'match/2': case 'capture/1': case 'capture/2': case 'scan/1': case 'scan/2': {
        const flags = args[1] ? one(1) || '' : '';
        const re = toRegExp(one(0), name === 'scan' && !flags.includes('g') ? flags + 'g' : flags);
        const s = str(input, 'matched, as it is not a string');
        const matches = re.global ? [...s.matchAll(re)] : [re.exec(s)].filter(Boolean);
        for (const m of matches) {
          if (name === 'capture') { yield {...(m.groups || {})}; continue; }
          if (name === 'scan') { yield m.length > 1 ? m.slice(1) : m[0]; continue; }
          yield {offset: m.index, length: m[0].length, string: m[0], captures: m.slice(1).map(c => ({offset: c === undefined ? -1 : s.indexOf(c, m.index), length: c?.length ?? 0, string: c ?? null, name: null}))};
        }
        return;
      }
      case 'sub/2': case 'sub/3': case 'gsub/2': case 'gsub/3': {
        const flags = (args[2] ? one(2) || '' : '') + (name === 'gsub' ? 'g' : '');
        const re = toRegExp(one(0), flags);
        const s = str(input);
        let out = '', last = 0, count = 0;
        for (const m of re.global ? s.matchAll(re) : [re.exec(s)].filter(Boolean)) {
          if (++count > 100000) fail('too many replacements');
          const scope = {...(m.groups || {})};
          out += s.slice(last, m.index) + text(single(arg(1), scope, env) ?? '');
          last = m.index + m[0].length;
          if (!re.global) break;
        }
        yield out + s.slice(last); return;
      }
      case 'ascii_lowercase/0': yield str(input).toLowerCase(); return;
      case 'to_entries/0': {
        if (type(input) !== 'object' && !Array.isArray(input)) fail(`${type(input)} has no keys`);
        yield Object.entries(input).map(([key, value]) => ({key: Array.isArray(input) ? Number(key) : key, value})); return;
      }
      case 'from_entries/0': {
        const out = {};
        for (const e of arr(input)) {
          const k = e?.key ?? e?.k ?? e?.name ?? e?.Name ?? e?.Key ?? e?.K;
          if (k === undefined || k === null) fail('Cannot use null as object key');
          out[typeof k === 'string' ? k : text(k)] = e.value ?? e.v ?? e.Value ?? e.V ?? null;
        }
        yield out; return;
      }
      case 'with_entries/1': {
        const entries = Object.entries(input ?? {}).map(([key, value]) => ({key: Array.isArray(input) ? Number(key) : key, value}));
        const mapped = entries.flatMap(e => all(arg(0), e, env));
        const out = {};
        for (const e of mapped) out[typeof e.key === 'string' ? e.key : text(e.key)] = e.value ?? null;
        yield out; return;
      }
      case 'tojson/0': yield JSON.stringify(input); return;
      case 'fromjson/0': { try { yield JSON.parse(str(input)); } catch { fail(`${show(input)} cannot be parsed as JSON`); } return; }
      case 'ascii/1': case 'env/0': yield {}; return;
      case 'input/0': case 'inputs/0': case 'debug/0': case 'stderr/0': case 'input_filename/0': case '$__loc__/0': case 'halt/0':
        if (name === 'debug' || name === 'stderr') { yield input; return; }
        if (name === 'input_filename') { yield null; return; }
        fail(`${name} is unavailable in the computer shell jq`);
        return;
      case 'paths/0': for (const [p] of paths({k: 'call', name: 'recurse', args: []}, input, env)) if (p.length) yield p; return;
      case 'paths/1': for (const [p, v] of paths({k: 'call', name: 'recurse', args: []}, input, env)) if (p.length && all(arg(0), v, env).some(truthy)) yield p; return;
      case 'leaf_paths/0': for (const [p, v] of paths({k: 'call', name: 'recurse', args: []}, input, env)) if (p.length && !Array.isArray(v) && type(v) !== 'object') yield p; return;
      case 'path/1': for (const [p] of paths(arg(0), input, env)) yield p; return;
      case 'getpath/1': for (const p of each(0)) { try { yield getPath(input, arr(p)); } catch (error) { if (error instanceof JqError) yield null; else throw error; } } return;
      case 'setpath/2': for (const v of ev(arg(1), input, env)) for (const p of each(0)) yield setPath(input, arr(p), v); return;
      case 'delpaths/1': for (const ps of each(0)) yield deletePaths(input, arr(ps)); return;
      case 'del/1': yield deletePaths(input, [...paths(arg(0), input, env)].map(([p]) => p)); return;
      case 'to_array/0': yield Array.isArray(input) ? input : [input]; return;
      case 'tostream/0': for (const [p, v] of paths({k: 'call', name: 'recurse', args: []}, input, env)) if (!Array.isArray(v) && type(v) !== 'object' || !Object.keys(v).length) yield [p, v]; return;
      case 'splits/1': case 'splits/2': for (const part of str(input).split(toRegExp(one(0), args[1] ? one(1) : ''))) yield part; return;
      case 'combinations/0': {
        const lists = arr(input);
        const rec = function* (k, acc) { if (k === lists.length) { yield acc; return; } for (const v of arr(lists[k])) yield* rec(k + 1, [...acc, v]); };
        yield* rec(0, []); return;
      }
      case 'transpose/0': { const rows = arr(input), width = Math.max(0, ...rows.map(r => arr(r).length)); yield Array.from({length: width}, (_, i) => rows.map(r => r[i] ?? null)); return; }
      case 'todate/0': case 'fromdate/0': case 'now/0': case 'strftime/1': case 'mktime/0': case 'gmtime/0': case 'todateiso8601/0': case 'fromdateiso8601/0': case 'dateadd/2':
        if (name === 'now') { yield Date.now() / 1000; return; }
        if (name === 'todate' || name === 'todateiso8601') { yield new Date(input * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); return; }
        if (name === 'fromdate' || name === 'fromdateiso8601') { const t = Date.parse(str(input)); if (Number.isNaN(t)) fail(`date "${input}" does not match format`); yield t / 1000; return; }
        fail(`${name} is unavailable`);
        return;
      case 'walk/1': {
        const walk = v => {
          let inner = v;
          if (Array.isArray(v)) inner = v.flatMap(x => { const r = walk(x); return r === undefined ? [] : [r]; });
          else if (type(v) === 'object') { inner = {}; for (const [k, x] of Object.entries(v)) { const r = walk(x); if (r !== undefined) inner[k] = r; } }
          return single(arg(0), inner, env);
        };
        const r = walk(input);
        if (r !== undefined) yield r;
        return;
      }
      case 'env/1': yield null; return;
      case 'builtins/0': yield []; return;
      case 'input_line_number/0': yield 0; return;
      case 'pick/1': {
        let out = null;
        for (const [p] of paths(arg(0), input, env)) out = setPath(out, p, getPath(input, p));
        yield out; return;
      }
      case 'toarray/0': yield Array.isArray(input) ? input : [input]; return;
      case 'have_literal_numbers/0': case 'have_decnum/0': yield false; return;
      case 'halt_error/0': case 'halt_error/1': fail(text(input));
    }
    fail(`${name}/${args.length} is not defined`);
  }

  function contains(a, b) {
    const ta = type(a), tb = type(b);
    if (ta !== tb) fail(`${ta} (${show(a)}) and ${tb} (${show(b)}) cannot have their containment checked`);
    if (ta === 'object') return Object.entries(b).every(([k, v]) => Object.hasOwn(a, k) && contains(a[k], v));
    if (ta === 'array') return b.every(x => a.some(y => type(y) === type(x) && contains(y, x)));
    if (ta === 'string') return a.includes(b);
    return equal(a, b);
  }

  return {ev};
}

// ---------- CLI ----------

function* parseStream(textInput) {
  let i = 0;
  const n = textInput.length;
  while (i < n) {
    while (i < n && /\s/.test(textInput[i])) i++;
    if (i >= n) return;
    const start = i;
    const c = textInput[i];
    if (c === '{' || c === '[') {
      let depth = 0;
      for (; i < n; i++) {
        const ch = textInput[i];
        if (ch === '"') { i++; while (i < n && textInput[i] !== '"') { if (textInput[i] === '\\') i++; i++; } }
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') { depth--; if (depth === 0) { i++; break; } }
      }
    } else if (c === '"') { i++; while (i < n && textInput[i] !== '"') { if (textInput[i] === '\\') i++; i++; } i++; }
    else while (i < n && !/[\s{["]/.test(textInput[i])) i++;
    const chunk = textInput.slice(start, i);
    try { yield JSON.parse(chunk); }
    catch { throw new ShellError(`parse error: invalid JSON near '${chunk.slice(0, 40)}'`, 2); }
  }
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (type(v) === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}

function encode(v, {compact, indent, tab}) {
  const fix = x => typeof x === 'number' && !Number.isFinite(x) ? (Number.isNaN(x) ? null : x > 0 ? 1.7976931348623157e308 : -1.7976931348623157e308) : x;
  const replacer = (_, x) => fix(x);
  return compact ? JSON.stringify(v, replacer) : JSON.stringify(v, replacer, tab ? '\t' : indent);
}

export function jq(args, readInput) {
  let filter = null, compact = false, raw = false, join = false, nullInput = false, slurp = false, exitStatus = false, sort = false, rawInput = false, tab = false, indent = 2, asciiOut = false, rawOutput0 = false;
  const vars = new Map(), files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--arg') { vars.set(args[i + 1], args[i + 2]); i += 2; continue; }
    if (a === '--argjson') { try { vars.set(args[i + 1], JSON.parse(args[i + 2])); } catch { throw new ShellError(`--argjson ${args[i + 1]}: invalid JSON text`, 2); } i += 2; continue; }
    if (a === '--indent') { indent = Number(args[++i]); if (!(indent >= 0 && indent <= 7)) throw new ShellError('--indent takes 0-7', 2); continue; }
    if (a === '--tab') { tab = true; continue; }
    if (a === '--raw-output0') { raw = true; rawOutput0 = true; continue; }
    if (a === '--args' || a === '--jsonargs' || a === '--rawfile' || a === '--slurpfile' || a === '-f' || a === '--from-file' || a === '-L' || a === '--seq' || a === '--stream')
      throw new ShellError(`${a} is unavailable in the computer shell jq`, 2);
    const long = {'--compact-output': 'c', '--raw-output': 'r', '--join-output': 'j', '--null-input': 'n', '--slurp': 's', '--exit-status': 'e', '--sort-keys': 'S', '--raw-input': 'R', '--ascii-output': 'a', '--monochrome-output': 'M', '--color-output': 'C'}[a];
    if (long || (/^-[a-zA-Z]+$/.test(a))) {
      for (const f of long ? long : a.slice(1)) {
        if (f === 'c') compact = true; else if (f === 'r') raw = true; else if (f === 'j') { raw = true; join = true; } else if (f === 'n') nullInput = true;
        else if (f === 's') slurp = true; else if (f === 'e') exitStatus = true; else if (f === 'S') sort = true; else if (f === 'R') rawInput = true;
        else if (f === 'a') asciiOut = true; else if (f === 'M' || f === 'C') continue;
        else throw new ShellError(`unknown option -${f}`, 2);
      }
      continue;
    }
    if (filter === null) filter = a; else files.push(a);
  }
  if (filter === null) throw new ShellError('usage: jq [-r -c -n -s -e -S -R -j] [--arg N V] [--argjson N JSON] FILTER [FILE...]', 2);
  let ast;
  try { ast = parser(filter); } catch (error) { if (error instanceof JqError) throw new ShellError(`error: ${error.message}\njq: 1 compile error`, 3); throw error; }
  const {ev} = makeEvaluator(vars);
  return (async () => {
    const source = await readInput(files);
    let inputs;
    if (nullInput) inputs = [null];
    else if (rawInput) {
      const lines = source.split('\n');
      if (lines.at(-1) === '') lines.pop();
      inputs = slurp ? [source] : lines;
    } else {
      const values = [...parseStream(source)];
      inputs = slurp ? [values] : values;
    }
    const out = [];
    let last;
    let error = null;
    for (const input of inputs) {
      try {
        for (const v of ev(ast, input, vars)) {
          last = v;
          const value = sort ? sortKeys(v) : v;
          let s = raw && typeof value === 'string' ? value : encode(value, {compact, indent, tab});
          if (asciiOut) s = s.replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
          out.push(s + (rawOutput0 ? '\0' : join ? '' : '\n'));
        }
      } catch (e) {
        if (!(e instanceof JqError)) throw e;
        error = e;
        break;
      }
    }
    const status = error ? 5 : exitStatus ? (last === undefined ? 4 : truthy(last) ? 0 : 1) : 0;
    return {stdout: out.join(''), error: error ? `jq: error (at <stdin>:0): ${error.message}\n` : '', status};
  })();
}
