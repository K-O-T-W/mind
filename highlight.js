// Syntax colouring for exactly three languages: JSON, TypeScript, Rust.
// The language is picked by hand when the block is inserted, so nothing here
// has to guess — which is why the lexing can be this literal.

const HL_ALIAS = {
  json: 'json', jsonc: 'json', json5: 'json',
  ts: 'ts', typescript: 'ts', tsx: 'ts',
  rust: 'rust', rs: 'rust',
  text: 'text', plain: 'text', '': 'text',
};

const TS_KW = 'abstract any as asserts async await bigint boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of override private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield';

const RUST_KW = 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while';

const RUST_TY = 'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc RefCell Cell HashMap BTreeMap HashSet VecDeque Cow Iterator Default Clone Copy Debug Send Sync Sized Drop Fn FnMut FnOnce Some None Ok Err';

const HL_SPEC = {
  json: { tag: 'json' },
  ts: {
    tag: 'ts',
    guard: /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/y,
    kwSet: new Set(TS_KW.split(' ')),
    type: /^[A-Z][A-Za-z0-9_]*$/,
  },
  rust: {
    tag: 'rust',
    // A char literal holds exactly one char, so this cannot swallow a lifetime
    // pair like <'a>(x: &'a str).
    guard: /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:\\.|[^'\\\n])'|#!?\[[^\]\n]*\]/y,
    kwSet: new Set(RUST_KW.split(' ')),
    tySet: new Set(RUST_TY.split(' ')),
    type: /^[A-Z][A-Za-z0-9_]*$/,
  },
  text: { tag: 'text' },
};

function hlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hlResolve(name) {
  const key = String(name || '').toLowerCase().replace(/^language-/, '');
  return HL_ALIAS[key] || '';
}

// ---------------------------------------------------------------- JSON
// Keys, string values, numbers, literals and punctuation all get their own
// colour, so a JSON block reads as colour instead of one grey mass.
const JSON_RE = /("(?:[^"\\\n]|\\.)*")(?=[ \t]*:)|("(?:[^"\\\n]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

function hlRenderJson(code) {
  let out = '';
  let last = 0;
  let m;
  JSON_RE.lastIndex = 0;
  while ((m = JSON_RE.exec(code))) {
    out += hlEsc(code.slice(last, m.index));
    const cls = m[1] ? 'key' : m[2] ? 'str' : m[3] ? 'num' : m[4] ? 'kw' : 'punc';
    out += `<span class="tok-${cls}">${hlEsc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + hlEsc(code.slice(last));
}

// ---------------------------------------------------------------- TS / Rust
// NOTE: the quote is excluded from the punctuation run, otherwise "<'a" is
// swallowed as one blob and the lifetime branch never sees it.
const WORD_RE = /[A-Za-z_$][\w$]*|\d[\w.]*|\s+|[^\sA-Za-z_$\d']+/y;
const LIFE_RE = /'[a-z_]\w*/iy;

function hlRenderCode(code, spec) {
  let out = '';
  let i = 0;
  const n = code.length;
  const guard = new RegExp(spec.guard.source, 'y');

  while (i < n) {
    guard.lastIndex = i;
    const g = guard.exec(code);
    if (g && g.index === i && g[0]) {
      const s = g[0];
      const t = /^(\/\/|\/\*)/.test(s) ? 'cmt' : /^#/.test(s) ? 'meta' : 'str';
      out += `<span class="tok-${t}">${hlEsc(s)}</span>`;
      i += s.length;
      continue;
    }

    // Rust lifetimes: 'a, 'static — the quote is part of the token
    if (code[i] === "'" && /[a-z_]/i.test(code[i + 1] || '')) {
      LIFE_RE.lastIndex = i;
      const lm = LIFE_RE.exec(code);
      if (lm) {
        out += `<span class="tok-life">${hlEsc(lm[0])}</span>`;
        i += lm[0].length;
        continue;
      }
    }

    WORD_RE.lastIndex = i;
    const w = WORD_RE.exec(code);
    if (!w || w.index !== i) {
      out += hlEsc(code[i]);
      i++;
      continue;
    }

    const s = w[0];
    let t = 'plain';
    if (/^\s/.test(s)) t = 'plain';
    else if (/^\d/.test(s)) t = 'num';
    else if (/^[A-Za-z_$]/.test(s)) {
      const after = code.slice(i + s.length);
      if (spec.kwSet.has(s)) t = 'kw';
      else if (spec.tySet && spec.tySet.has(s)) t = 'type';
      else if (spec.type && spec.type.test(s)) t = 'type';
      else if (after[0] === '!') t = 'macro';
      else if (/^[ \t]*\(/.test(after)) t = 'fn';
    } else t = 'punc';

    out += t === 'plain' ? hlEsc(s) : `<span class="tok-${t}">${hlEsc(s)}</span>`;
    i += s.length;
  }
  return out;
}

function hlRender(code, lang) {
  const spec = HL_SPEC[lang];
  if (!spec || spec.tag === 'text') return hlEsc(code);
  if (spec.tag === 'json') return hlRenderJson(code);
  return hlRenderCode(code, spec);
}

// Whole-note render. The line count must match the textarea exactly, so fence
// lines are emitted too — painted as fence, not as code.
// markLine(i) 返回这一行的附加类名（审批 diff 用它把新增的行垫色）。
function hlNote(text, markLine) {
  const lines = String(text || '').split('\n');
  const out = [];
  let fence = null;
  let lang = 'text';
  let li = 0;

  const push = (html) => {
    const cls = markLine ? markLine(li) : '';
    out.push(cls ? `<span class="${cls}">${html}</span>` : html);
  };

  for (const line of lines) {
    const fm = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len && !fm[2].trim()) {
        push(`<span class="hl-fence">${hlEsc(line)}</span>`);
        fence = null;
        li++;
        continue;
      }
      push(hlRender(line, lang));
      li++;
      continue;
    }
    if (fm) {
      fence = { ch: fm[1][0], len: fm[1].length };
      lang = hlResolve(fm[2].trim()) || 'text';
      push(`<span class="hl-fence">${hlEsc(line)}</span>`);
      li++;
      continue;
    }
    push(hlEsc(line));
    li++;
  }
  return out.join('\n') + '\n';
}
