// Grammar of the computer shell: words, quotes, globs, pipes, && || ;, and
// file redirects. No variables, substitution, subshells, heredocs or jobs:
// every word is data, never code.
export class ShellError extends Error {
  constructor(message, status = 1) { super(message); this.status = status; }
}

const BREAK = ' \t\n;&|<>()';
const GLOB = '*?[';
const SUBSTITUTION = /[A-Za-z_{(0-9@*#?$!]/;
const escapeGlob = text => text.replace(/[*?[\]\\]/g, '\\$&');

function unavailable(what) {
  return new ShellError(`${what} unavailable in the computer shell; quote the character to use it literally`, 2);
}

export function lex(source) {
  const tokens = [];
  let i = 0;
  const redirect = (fd, append) => {
    if (source[i] === '&' && /[12]/.test(source[i + 1] || '') && !append) {
      tokens.push({redir: '>&', fd, target: Number(source[i + 1])});
      i += 2;
    } else tokens.push({redir: append ? '>>' : '>', fd});
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '\\' && source[i + 1] === '\n') { i += 2; continue; }
    if (ch === '\n' || ch === ';') {
      if (source[i + 1] === ';' && ch === ';') throw unavailable('case statements are');
      tokens.push({op: ';'}); i++; continue;
    }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (ch === '&') {
      if (source[i + 1] === '&') { tokens.push({op: '&&'}); i += 2; continue; }
      if (source[i + 1] === '>') { i += 2; const append = source[i] === '>'; if (append) i++; tokens.push({redir: append ? '&>>' : '&>', fd: 1}); continue; }
      throw unavailable('background jobs (&) are');
    }
    if (ch === '|') {
      if (source[i + 1] === '|') { tokens.push({op: '||'}); i += 2; continue; }
      if (source[i + 1] === '&') throw unavailable('|& is');
      tokens.push({op: '|'}); i++; continue;
    }
    if (ch === '<') {
      if (source[i + 1] === '<') throw unavailable('heredocs are');
      if (source[i + 1] === '(') throw unavailable('process substitution is');
      tokens.push({redir: '<', fd: 0}); i++; continue;
    }
    if (ch === '>') {
      i++;
      if (source[i] === '(') throw unavailable('process substitution is');
      const append = source[i] === '>';
      if (append) i++;
      redirect(1, append); continue;
    }
    if ((ch === '1' || ch === '2') && source[i + 1] === '>') {
      i += 2;
      const append = source[i] === '>';
      if (append) i++;
      redirect(Number(ch), append); continue;
    }
    if (ch === '(' || ch === ')') throw unavailable('subshells are');
    let text = '', pattern = '', glob = false;
    while (i < source.length && !BREAK.includes(source[i])) {
      const c = source[i];
      if (c === "'") {
        const end = source.indexOf("'", i + 1);
        if (end < 0) throw new ShellError('unterminated single quote', 2);
        const part = source.slice(i + 1, end);
        text += part; pattern += escapeGlob(part); i = end + 1; continue;
      }
      if (c === '"') {
        i++;
        let part = '';
        while (i < source.length && source[i] !== '"') {
          if (source[i] === '\\' && '"\\$`\n'.includes(source[i + 1])) {
            if (source[i + 1] !== '\n') part += source[i + 1];
            i += 2; continue;
          }
          if (source[i] === '`' || (source[i] === '$' && SUBSTITUTION.test(source[i + 1] || ''))) throw unavailable('variables and command substitution are');
          part += source[i++];
        }
        if (i >= source.length) throw new ShellError('unterminated double quote', 2);
        i++;
        text += part; pattern += escapeGlob(part); continue;
      }
      if (c === '\\') {
        if (i + 1 < source.length && source[i + 1] !== '\n') { text += source[i + 1]; pattern += escapeGlob(source[i + 1]); }
        i += 2; continue;
      }
      if (c === '`' || (c === '$' && SUBSTITUTION.test(source[i + 1] || ''))) throw unavailable('variables and command substitution are');
      if (GLOB.includes(c)) glob = true;
      if (c === '{' && /^\{[^{}]*,[^{}]*\}/.test(source.slice(i))) throw unavailable('brace expansion is');
      text += c; pattern += c; i++;
    }
    tokens.push({word: text, pattern: glob ? pattern : null});
  }
  return tokens;
}

// [{op: null|'&&'|'||', pipeline: [{words, redirs}]}]
export function parse(source) {
  const tokens = lex(source);
  const list = [];
  let op = null, pipeline = [], cmd = {words: [], redirs: []};
  const empty = () => !cmd.words.length && !cmd.redirs.length;
  const endCommand = what => {
    if (empty()) throw new ShellError(`syntax error near ${what}`, 2);
    pipeline.push(cmd); cmd = {words: [], redirs: []};
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.word !== undefined) cmd.words.push(t);
    else if (t.redir) {
      if (t.redir === '>&') { cmd.redirs.push(t); continue; }
      const target = tokens[++k];
      if (!target || target.word === undefined) throw new ShellError(`syntax error: ${t.redir} needs a file name`, 2);
      cmd.redirs.push({...t, target});
    } else if (t.op === '|') endCommand("'|'");
    else {
      if (empty() && !pipeline.length) {
        if (t.op === ';' && op === null) continue;
        throw new ShellError(`syntax error near '${t.op}'`, 2);
      }
      endCommand(`'${t.op}'`);
      list.push({op, pipeline}); pipeline = [];
      op = t.op === ';' ? null : t.op;
    }
  }
  if (!empty()) endCommand('end');
  else if (pipeline.length) throw new ShellError("syntax error: command expected after '|'", 2);
  if (pipeline.length) list.push({op, pipeline});
  else if (op) throw new ShellError(`syntax error: command expected after '${op}'`, 2);
  return list;
}

// One path segment; '*' and '?' never match '/', a leading dot needs a literal dot.
export function globRegExp(segment, {ignoreCase = false} = {}) {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '\\') { out += (segment[i + 1] ?? '\\').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); i++; }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      let j = i + 1;
      if (segment[j] === '!' || segment[j] === '^') j++;
      if (segment[j] === ']') j++;
      while (j < segment.length && segment[j] !== ']') j++;
      if (j >= segment.length) { out += '\\['; continue; }
      let body = segment.slice(i + 1, j);
      if (body[0] === '!') body = '^' + body.slice(1);
      out += '[' + body.replace(/\\/g, '\\\\').replace(/\[(?!:)/g, '\\[') + ']';
      i = j;
    } else out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  out = out.replace(/\[:alpha:\]/g, 'a-zA-Z').replace(/\[:digit:\]/g, '0-9').replace(/\[:alnum:\]/g, 'a-zA-Z0-9')
    .replace(/\[:upper:\]/g, 'A-Z').replace(/\[:lower:\]/g, 'a-z').replace(/\[:space:\]/g, '\\s');
  return new RegExp('^' + out + '$', ignoreCase ? 'iu' : 'u');
}

export const hasGlob = pattern => /(^|[^\\])[*?[]/.test(pattern);
export const unescapeGlob = pattern => pattern.replace(/\\(.)/g, '$1');
