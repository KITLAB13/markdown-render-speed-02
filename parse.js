// parse.js — dependency-free Markdown -> HTML renderer.
// Written from the CommonMark 0.31.2 specification and GitHub Flavored
// Markdown rules; output targets byte-identical HTML to marked 18.1.3
// with its default options (gfm: true, breaks: false, pedantic: false).
//
// Architecture: a single-pass, line-oriented block parser (containers are
// stripped column-wise, leaf blocks dispatch on the first line, link
// reference definitions are collected in a document pre-pass) feeding a
// character-scanner inline parser. Emphasis follows the reference's
// regex-style matching model rather than the spec's delimiter-stack
// algorithm where the two observably differ. No dependencies, no state
// shared between parse() calls: every call is pure.

// ---------- small helpers ----------

const ESCAPABLE = new Set('\\`!"#$%&\'()*+,-./:;<=>?@[]^_{|}~'.split(''));

function isPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
         (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Unicode-aware punctuation for delimiter flanking: the reference treats
// any Unicode punctuation (P) or symbol (S) character as punctuation, so
// e.g. currency signs like £ and € block a following * from closing.
const PUNCTU_RE = /[\p{P}\p{S}]/u;
function isPunctU(ch) {
  if (!ch) return false;
  if (isPunct(ch)) return true;
  return ch.charCodeAt(0) > 126 && PUNCTU_RE.test(ch);
}
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
         ch === '\f' || ch === '\v' || ch === '\u00a0';
}
function isAlnum(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// The character class [A-Za-z0-9._%+\-@] tested on a single char
// (the previous-character gate for extended-autolink probes).
function isAutoPrevCh(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) ||
         (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 37 ||
         c === 43 || c === 45 || c === 64;
}

const ESC_HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_HTML_RE = /[&<>"']/;
function escapeHtml(s) {
  if (!ESC_HTML_RE.test(s)) return s;
  return s.replace(/[&<>"']/g, (m) => ESC_HTML_MAP[m]);
}
function escapeAttr(s) {
  // Escape & and ", but leave existing entity references (&name;, &#123;,
  // &#x1f;) untouched: attribute values such as hrefs may carry them raw.
  if (!s.includes('&') && !s.includes('"')) return s;
  return s.replace(/&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);|&|"/g,
    (m) => (m === '&' ? '&amp;' : m === '"' ? '&quot;' : m));
}

// ---------- entities ----------

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  laquo: '\u00ab', raquo: '\u00bb', times: '\u00d7', divide: '\u00f7',
  plusmn: '\u00b1', deg: '\u00b0', micro: '\u00b5', para: '\u00b6',
  middot: '\u00b7', bull: '\u2022', dagger: '\u2020', Dagger: '\u2021',
  permil: '\u2030', prime: '\u2032', Prime: '\u2033', oline: '\u203e',
  frasl: '\u2044', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5',
  cent: '\u00a2', curren: '\u00a4', sect: '\u00a7', uml: '\u00a8',
  ordf: '\u00aa', ordm: '\u00ba', iexcl: '\u00a1', iquest: '\u00bf',
  szlig: '\u00df', agrave: '\u00e0', aacute: '\u00e1', acirc: '\u00e2',
  atilde: '\u00e3', auml: '\u00e4', aring: '\u00e5', aelig: '\u00e6',
  ccedil: '\u00e7', egrave: '\u00e8', eacute: '\u00e9', ecirc: '\u00ea',
  euml: '\u00eb', igrave: '\u00ec', iacute: '\u00ed', icirc: '\u00ee',
  iuml: '\u00ef', eth: '\u00f0', ntilde: '\u00f1', ograve: '\u00f2',
  oacute: '\u00f3', ocirc: '\u00f4', otilde: '\u00f5', ouml: '\u00f6',
  oslash: '\u00f8', ugrave: '\u00f9', uacute: '\u00fa', ucirc: '\u00fb',
  uuml: '\u00fc', yacute: '\u00fd', thorn: '\u00fe', yuml: '\u00ff',
  Amacr: '\u0100', amacr: '\u0101', OElig: '\u0152', oelig: '\u0153',
  Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178', fnof: '\u0192',
  circ: '\u02c6', tilde: '\u02dc', ensp: '\u2002', emsp: '\u2003',
  thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e',
  rlm: '\u200f', trade: '\u2122', larr: '\u2190', uarr: '\u2191',
  rarr: '\u2192', darr: '\u2193', harr: '\u2194', minus: '\u2212',
  lowast: '\u2217', radic: '\u221a', prop: '\u221d', infin: '\u221e',
  ang: '\u2220', and: '\u2227', or: '\u2228', cap: '\u2229',
  cup: '\u222a', int: '\u222b', there4: '\u2234', sim: '\u223c',
  cong: '\u2245', asymp: '\u2248', ne: '\u2260', equiv: '\u2261',
  le: '\u2264', ge: '\u2265', sub: '\u2282', sup: '\u2283',
  nsub: '\u2284', sube: '\u2286', supe: '\u2287', oplus: '\u2295',
  otimes: '\u2297', perp: '\u22a5', sdot: '\u22c5',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4',
  epsilon: '\u03b5', zeta: '\u03b6', eta: '\u03b7', theta: '\u03b8',
  iota: '\u03b9', kappa: '\u03ba', lambda: '\u03bb', mu: '\u03bc',
  nu: '\u03bd', xi: '\u03be', pi: '\u03c0', rho: '\u03c1',
  sigma: '\u03c3', tau: '\u03c4', upsilon: '\u03c5', phi: '\u03c6',
  chi: '\u03c7', psi: '\u03c8', omega: '\u03c9',
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394',
  Epsilon: '\u0395', Zeta: '\u0396', Eta: '\u0397', Theta: '\u0398',
  Iota: '\u0399', Kappa: '\u039a', Lambda: '\u039b', Mu: '\u039c',
  Nu: '\u039d', Xi: '\u039e', Pi: '\u03a0', Rho: '\u03a1',
  Sigma: '\u03a3', Tau: '\u03a4', Upsilon: '\u03a5', Phi: '\u03a6',
  Chi: '\u03a7', Psi: '\u03a7', Omega: '\u03a9',
  thetasym: '\u03d1', upsih: '\u03d2', piv: '\u03d6'
};

// Decode one entity body (between & and ;) -> replacement or null.
function entityValue(body) {
  if (body.charCodeAt(0) === 35) { // '#'
    let cp;
    if (body[1] === 'x' || body[1] === 'X') {
      if (!/^[0-9a-fA-F]+$/.test(body.slice(2))) return null;
      cp = parseInt(body.slice(2), 16);
    } else {
      if (!/^[0-9]+$/.test(body.slice(1))) return null;
      cp = parseInt(body.slice(1), 10);
    }
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return '\ufffd';
    }
    return String.fromCodePoint(cp);
  }
  return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : null;
}

// If s[i] === '&' starts a valid entity reference, return {text, end}.
function matchEntity(s, i) {
  const semi = s.indexOf(';', i + 1);
  if (semi === -1 || semi - i > 32) return null;
  const body = s.slice(i + 1, semi);
  if (!/^[#0-9a-zA-Z]+$/.test(body)) return null;
  const v = entityValue(body);
  if (v === null) return null;
  return { text: v, end: semi + 1 };
}

// Clean a link destination (marked behavior): entity references are
// left raw, existing %XX escapes are preserved, and only characters
// that cannot appear literally in a URL (space, controls, non-ASCII,
// ", <, >) are percent-encoded as UTF-8 bytes.
const utf8 = new TextEncoder();
const CLEAN_URL_BAD = /[\u0000-\u0020\u007f-\uffff"<>\\[\]`]/;
function cleanUrl(href) {
  // Fast path: nothing in the string needs percent-encoding (a '%'
  // not followed by two hex digits also survives the slow loop
  // unchanged, and valid %XX triplets are copied verbatim).
  if (!CLEAN_URL_BAD.test(href)) return href;
  let out = '';
  for (let i = 0; i < href.length; i++) {
    const ch = href[i];
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(href.slice(i + 1, i + 3))) {
      out += href.slice(i, i + 3);
      i += 2;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code <= 0x20 || code === 0x7f || code > 0x7e ||
        ch === '"' || ch === '<' || ch === '>' || ch === '\\' ||
        ch === '[' || ch === ']' || ch === '`') {
      for (const b of utf8.encode(ch)) {
        out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function cleanTitle(t) {
  if (t == null) return null;
  // The loop below only resolves backslash escapes.
  if (!t.includes('\\')) return t;
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\' && i + 1 < t.length && isPunct(t[i + 1])) { out += t[i + 1]; i++; continue; }
    // Entity references stay raw in titles (the reference renderer does
    // not decode them); escapeAttr preserves well-formed references.
    out += ch;
  }
  return out;
}

// ---------- block parsing ----------

function colWidth(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    col += line[i] === '\t' ? 4 - (col % 4) : 1;
  }
  return col;
}
// Remove up to n columns of leading indent; returns stripped line.
// Columns are counted from startCol (the column the line fragment
// begins at in the original line). A partially consumed tab leaves
// its remainder as spaces, and tabs immediately following it in the
// leading whitespace are expanded at their true columns too, so the
// result's column math stays in the original frame.
function stripCols(line, n, startCol = 0, expandTab = false) {
  let col = startCol, i = 0;
  const target = startCol + n;
  while (i < line.length && col < target) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= target) { col += w; i++; }
      else {
        let out = ' '.repeat(col + w - target);
        col += w; i++;
        while (line[i] === '\t') {
          const w2 = 4 - (col % 4);
          out += ' '.repeat(w2);
          col += w2; i++;
        }
        if (!expandTab) return out + line.slice(i);
        // The strip shifted the frame by a non-multiple of 4, so a
        // tab later in the leading whitespace would change width if
        // left raw: expand the rest of the leading whitespace here,
        // at true columns, like the non-straddle path below.
        let rest = '';
        let j = i;
        while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
          if (line[j] === ' ') { rest += ' '; col++; j++; }
          else {
            const w3 = 4 - (col % 4);
            rest += ' '.repeat(w3);
            col += w3; j++;
          }
        }
        return out + rest + line.slice(j);
      }
    } else break;
  }
  // Container strips (list items, blockquotes) also expand any tab
  // left in the line's leading whitespace, at its true column width
  // in the original frame; a block's own indent strip (fences,
  // indented code) leaves such tabs raw.
  if (expandTab) {
    let out = '';
    let j = i;
    let sawTab = false;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
      if (line[j] === ' ') { out += ' '; col++; j++; }
      else {
        const w = 4 - (col % 4);
        out += ' '.repeat(w);
        col += w; j++; sawTab = true;
      }
    }
    if (sawTab) return out + line.slice(j);
  }
  return line.slice(i);
}
// Remove the first n columns of a line, counting every character
// (used for a list item's first line, whose prefix holds the marker).
function dropCols(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    col += line[i] === '\t' ? 4 - (col % 4) : 1;
    i++;
  }
  if (col > n && line[i - 1] === '\t') {
    let out = ' '.repeat(col - n);
    while (line[i] === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w; i++;
    }
    return out + line.slice(i);
  }
  return line.slice(i);
}
function leadCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') col++;
    else if (line[i] === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}
const isBlankLine = (l) => {
  for (let k = 0; k < l.length; k++) {
    const c = l[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
};

function normLabel(s) {
  // Whitespace collapse + Unicode full case folding (ß folds to ss,
  // final sigma to sigma; JS toLowerCase alone misses those).
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
          .replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// Unescape backslash-escaped punctuation in a link destination.
function unescapeDest(h) {
  return h.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
}

// Scan a link destination at s[p]. Returns { href, end } or null.
function scanDestAt(s, p) {
  if (s[p] === '<') {
    let e = p + 1;
    while (e < s.length) {
      const c = s[e];
      if (c === '\\') { e += 2; continue; }
      if (c === '>') return { href: s.slice(p + 1, e), end: e + 1 };
      if (c === '<' || c === '\n') return null;
      e++;
    }
    return null;
  }
  let e = p, depth = 0;
  while (e < s.length) {
    const c = s[e];
    if (c === ' ' || c === '\t' || c === '\n') break;
    if (c === '\\') { e += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) break; depth--; }
    else if (c < ' ') return null;
    e++;
  }
  if (e === p || depth !== 0) return null;
  return { href: s.slice(p, e), end: e };
}

// Scan a link title at s[p] (s[p] is the opening delimiter); the title
// may span lines but not a blank line. Returns { title, end } or null.
function scanTitleAt(s, p) {
  const q = s[p];
  const close = q === '(' ? ')' : q;
  let e = p + 1;
  let title = '';
  while (e < s.length) {
    const c = s[e];
    if (c === '\\' && e + 1 < s.length) { title += c + s[e + 1]; e += 2; continue; }
    if (q === '(' && c === '(') return null;
    if (c === close) return { title, end: e + 1 };
    if (c === '\n' && /^\n[ \t]*\n/.test(s.slice(e))) return null;
    title += c; e++;
  }
  return null;
}

// Try to parse a link reference definition starting at lines[i].
// Works on the chunk text (lines joined up to the next blank line) so
// labels and titles may span lines. Returns { label, href, title,
// next } or null.
function parseLinkDef(lines, i) {
  // A definition must open with '[' past at most 3 spaces; bail out
  // before joining lines when it cannot.
  if (lineTrig(lines[i]) !== '[') return null;
  let j = i;
  while (j < lines.length && j - i < 10 && !isBlankLine(lines[j])) j++;
  const s = lines.slice(i, j).join('\n');
  const lm = /^ {0,3}\[/.exec(s);
  if (!lm) return null;
  const open = lm[0].length - 1;
  const closeL = findClosingBracket(s, open);
  if (closeL === -1 || s[closeL + 1] !== ':') return null;
  const labelRaw = s.slice(open + 1, closeL);
  if (!labelRaw.trim() || labelRaw.length > 999) return null;
  // a definition label may not contain unescaped brackets
  for (let p = 0; p < labelRaw.length; p++) {
    if (labelRaw[p] === '\\') { p++; continue; }
    if (labelRaw[p] === '[' || labelRaw[p] === ']') return null;
  }
  let p = closeL + 2;
  while (s[p] === ' ' || s[p] === '\t') p++;
  if (s[p] === '\n') { p++; while (s[p] === ' ' || s[p] === '\t') p++; }
  const d = scanDestAt(s, p);
  if (!d) return null;
  const nlAfterDest = s.indexOf('\n', d.end);
  const destLineEnd = nlAfterDest === -1 ? s.length : nlAfterDest;
  const destLineBlank = /^[ \t]*$/.test(s.slice(d.end, destLineEnd));
  // Optional title: separated from the destination by whitespace,
  // possibly across one line ending. If the title is malformed or has
  // trailing junk, the definition survives without it only when the
  // rest of the destination's own line is blank.
  let title = null;
  let end = destLineEnd;
  let q = d.end, separated = false;
  while (s[q] === ' ' || s[q] === '\t') { q++; separated = true; }
  if (s[q] === '\n') {
    q++;
    while (s[q] === ' ' || s[q] === '\t') q++;
    separated = true;
  }
  const qc = s[q];
  if (separated && (qc === '"' || qc === "'" || qc === '(')) {
    const t = scanTitleAt(s, q);
    if (t) {
      let r = t.end;
      while (s[r] === ' ' || s[r] === '\t') r++;
      if (r >= s.length || s[r] === '\n') { title = t.title; end = r; }
    }
  }
  if (title === null && !destLineBlank) return null;
  const consumed = s.slice(0, end);
  const nLines = (consumed.match(/\n/g) || []).length + 1;
  return { label: normLabel(labelRaw), href: unescapeDest(d.href), title, next: i + nLines };
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body ' +
  'caption center col colgroup dd details dialog dir div dl dt fieldset ' +
  'figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head ' +
  'header hr html iframe legend li link main menu menuitem nav noframes ' +
  'ol optgroup option p param section source summary table tbody td tfoot ' +
  'th thead title tr track ul').split(' '));

// True when s is exactly one complete open or closing tag followed
// only by spaces/tabs (the type-7 start condition). The tag must be
// complete on this line: quoted attribute values may not span lines,
// and attribute syntax is validated (so `<a href='bar'title=x>` and
// `<a h*#ref="hi">` do not count).
function isCompleteTagLine(s) {
  let p = 1;
  const closing = s[p] === '/';
  if (closing) p++;
  const nm = /^[A-Za-z][A-Za-z0-9-]*/.exec(s.slice(p));
  if (!nm) return false;
  p += nm[0].length;
  const onlyWsLeft = () => /^[ \t]*$/.test(s.slice(p));
  if (closing) {
    while (s[p] === ' ' || s[p] === '\t') p++;
    if (s[p] !== '>') return false;
    p++;
    return onlyWsLeft();
  }
  for (;;) {
    let ws = 0;
    while (s[p] === ' ' || s[p] === '\t') { p++; ws++; }
    if (s[p] === '>') { p++; return onlyWsLeft(); }
    if (s[p] === '/' && s[p + 1] === '>') { p += 2; return onlyWsLeft(); }
    if (!ws) return false;
    const am = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(s.slice(p));
    if (!am) return false;
    p += am[0].length;
    let q = p;
    while (s[q] === ' ' || s[q] === '\t') q++;
    if (s[q] === '=') {
      q++;
      while (s[q] === ' ' || s[q] === '\t') q++;
      const c = s[q];
      if (c === '"' || c === "'") {
        const e = s.indexOf(c, q + 1);
        if (e === -1) return false;
        q = e + 1;
      } else {
        const vm = /^[^\s"'=<>`]+/.exec(s.slice(q));
        if (!vm) return false;
        q += vm[0].length;
      }
      p = q;
    }
  }
}

// HTML block start at this line: returns end-kind or null.
// kind: 'comment' | 'pi' | 'decl' | 'cdata' |
//       'raw' (pre/script/style/textarea) | 'tag' | 'tag7'
function htmlBlockStart(line) {
  const s = stripCols(line, 3);
  if (s[0] !== '<') return null;
  if (s.startsWith('<!--')) return 'comment';
  if (s.startsWith('<?')) return 'pi';
  if (s.startsWith('<![CDATA[')) return 'cdata';
  if (/^<![A-Za-z]/.test(s)) return 'decl';
  const m = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (!m) return null;
  const tag = m[2].toLowerCase();
  const after = s[m[0].length];
  const afterOk = after === undefined || after === ' ' || after === '\t' ||
                  after === '>' || after === '/';
  if (!afterOk) return null;
  if (!m[1] && (tag === 'pre' || tag === 'script' || tag === 'style' ||
                tag === 'textarea')) return 'raw';
  if (BLOCK_TAGS.has(tag)) return 'tag';
  return isCompleteTagLine(s) ? 'tag7' : null;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

// A fence start: like FENCE_RE, except a backtick fence whose info
// string contains a backtick is not a fence at all (it is paragraph
// text with code spans). Tilde fences have no such restriction.
// Strip up to n columns of leading whitespace from a fence content
// line. A tab that straddles the strip boundary is dropped whole
// (the reference does not leave remainder spaces inside fences).
function stripFenceCols(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return line.slice(i);
}

function fenceMatch(line) {
  // Cheap gate: the pattern needs a backtick or tilde run right
  // after at most 3 leading spaces.
  let s = 0;
  while (s < 3 && line[s] === ' ') s++;
  if (line[s] !== '`' && line[s] !== '~') return null;
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return m;
}
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const HR_RE = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}>/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

// First character of a line past at most 3 leading spaces, or null
// for a tab-led line (whose column-based handling is subtler). The
// block-start patterns gated by this all anchor on literal spaces,
// so a line whose trigger character is absent cannot match any of
// them (this includes lines indented 4+ spaces, where line[s] is
// another space).
function lineTrig(line) {
  if (line[0] === '\t') return null;
  let s = 0;
  while (s < 3 && line[s] === ' ') s++;
  return line[s];
}

function blockTrigOk(t) {
  return t === null || t === '\t' || t === '`' || t === '~' || t === '#' ||
         t === '-' || t === '_' || t === '*' || t === '<' || t === '>' ||
         t === '+' || (t >= '0' && t <= '9');
}

// Shared core of wouldInterrupt / wouldInterruptPara: each block
// pattern is only tested when the line's trigger character can
// start it (htmlBlockStart can only fire when the trigger is '<':
// any tab in the indent leaves remainder spaces in front of the
// '<' after the column strip, and space-only indents are exactly
// what lineTrig skips).
function interruptByBlocks(line, t) {
  if (t === '<') {
    const hk = htmlBlockStart(line);
    if (hk !== null && hk !== 'tag7') return true;
  } else if (t === '`' || t === '~') {
    if (fenceMatch(line) !== null) return true;
  } else if (t === '#') {
    if (ATX_RE.test(line)) return true;
  } else if (t === '-' || t === '_' || t === '*') {
    if (HR_RE.test(line)) return true;
  } else if (t === '>') {
    if (QUOTE_RE.test(line)) return true;
  }
  return false;
}

function wouldInterrupt(line) {
  const t = lineTrig(line);
  if (!blockTrigOk(t)) return false;
  return interruptByBlocks(line, t) || listStart(line) !== null;
}

// Whether a line interrupts an open paragraph: same as wouldInterrupt,
// except a list can interrupt only with a non-empty item that is a
// bullet or starts at 1.
function wouldInterruptPara(line) {
  const t = lineTrig(line);
  if (!blockTrigOk(t)) return false;
  if (interruptByBlocks(line, t)) return true;
  const st = listStart(line);
  return st !== null && !st.empty && (!st.ordered || st.num === 1);
}

// Strip one layer of container markers (blockquote / list item) from
// the front of a line, repeatedly; used to classify nested content.
function peelContainers(s) {
  for (;;) {
    const qm = /^ {0,3}>/.exec(s);
    if (qm) {
      s = s.slice(qm[0].length);
      if (s[0] === ' ' || s[0] === '\t') s = stripCols(s, 1);
      continue;
    }
    const st = listStart(s);
    if (st) { s = dropCols(s, st.contentIndent); continue; }
    return s;
  }
}

// Analyse the blocks collected so far inside a blockquote: what kind
// of block is still open at the end, and (when it is a paragraph)
// whether that paragraph sits directly in the quote rather than
// nested inside a list or inner quote. Laziness — absorbing a line
// with no > marker — is only possible when a paragraph is open.
function quoteDepthOf(l) {
  let d = 0, s = l;
  for (;;) {
    const m = /^ {0,3}>/.exec(s);
    if (!m) return d;
    d++; s = s.slice(m[0].length);
  }
}

function openBlockState(inner) {
  let state = null; // null | 'para' | 'fence' | 'code' | 'html'
  let topLevel = true;
  let inFence = false, fCh = '', fLen = 0, fDepth = 0;
  let atStart = true; // at the start of a new block
  let prevQuote = null, prevList = null;
  const classify = (l) => {
    const peeled = peelContainers(l);
    topLevel = !(QUOTE_RE.test(l) || listStart(l) !== null);
    if (ATX_RE.test(peeled) || HR_RE.test(peeled)) { state = null; atStart = true; }
    else if (htmlBlockStart(l)) { state = 'html'; atStart = false; }
    else if (!topLevel && leadCols(peeled) >= 4) { state = 'para'; atStart = false; }
    else if (topLevel && leadCols(l) >= 4) { state = 'code'; atStart = false; }
    else { state = 'para'; atStart = false; }
  };
  for (const l of inner) {
    if (inFence) {
      // A line that drops out of the container the fence opened in
      // (fewer quote markers than the fence's own line) ends both the
      // container and the fence: the fence is left unclosed and this
      // line is classified as a block of the outer level.
      if (quoteDepthOf(l) < fDepth) {
        inFence = false; state = null; atStart = true;
      } else {
        const cm = fenceMatch(peelContainers(l));
        if (cm && cm[1][0] === fCh && cm[1].length >= fLen &&
            cm[2].trim() === '') { inFence = false; state = null; atStart = true; }
        prevQuote = QUOTE_RE.test(l); prevList = listStart(l) !== null;
        continue;
      }
    }
    if (isBlankLine(l)) {
      state = null; atStart = true;
      prevQuote = QUOTE_RE.test(l); prevList = listStart(l) !== null;
      continue;
    }
    const fm = fenceMatch(peelContainers(l));
    if (fm) {
      inFence = true; fCh = fm[1][0]; fLen = fm[1].length; fDepth = quoteDepthOf(l);
      state = 'fence'; atStart = false;
      prevQuote = QUOTE_RE.test(l); prevList = listStart(l) !== null;
      continue;
    }
    // A line that opens a container the previous line did not have
    // starts a new block even in the middle of a paragraph (e.g. a
    // nested quote begins after a quote-level paragraph). The
    // reverse (a plain line after marked lines) is a lazy
    // continuation of the open block and never reclassifies.
    const cQuote = QUOTE_RE.test(l), cList = listStart(l) !== null;
    if (atStart || state === null ||
        (prevQuote !== null && ((cQuote && !prevQuote) || (cList && !prevList)))) {
      classify(l);
    } else if (state === 'code' && leadCols(peelContainers(l)) < 4) classify(l);
    // otherwise 'para' / 'html' continue unchanged over further lines
    prevQuote = cQuote; prevList = cList;
  }
  return { state, topLevel };
}

// A lazy line absorbed into a paragraph that sits directly in a
// blockquote has its leading indent reduced modulo 4 columns (whole
// 4-column units are dropped); a lazy line absorbed into a nested
// container (e.g. a list item in the quote) is taken verbatim.
function lazyLine(l, topLevel) {
  if (!topLevel) return l;
  const rem = leadCols(l) % 4;
  const drop = leadCols(l) - rem;
  return drop > 0 ? stripCols(l, drop) : l;
}

function parseBlocks(lines, defs, endsWithNl = false, lazyIdx = null, inItem = false) {
  return parseBlocksEx(lines, defs, endsWithNl, lazyIdx, inItem).html;
}

function parseBlocksEx(lines, defs, endsWithNl = false, lazyIdx = null, inItem = false) {
  const out = [];
  let blankBetween = false;
  let prevEnd = -1; // index just past the previous block's last line
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    if (prevEnd >= 0) {
      for (let t = prevEnd; t < i; t++) {
        if (isBlankLine(lines[t])) { blankBetween = true; break; }
      }
    }
    // Dispatch guard: the fence/ATX/HR/quote tests below can only
    // match when the line's first character past at most 3 leading
    // spaces is one of their trigger characters, so plain-text
    // lines skip the regexes entirely. Lines starting with a tab
    // (trig === null) keep the html test, whose column-based
    // stripping can still see a '<'; the other four patterns all
    // anchor on literal spaces and cannot match a tab-led line.
    let trig = null;
    if (line[0] !== '\t') {
      let s = 0;
      while (s < 3 && line[s] === ' ') s++;
      trig = line[s];
    }
    let m = (trig === '`' || trig === '~') ? fenceMatch(line) : null;
    if (m) {
      const fence = m[1];
      const ch = fence[0];
      const info = m[2].trim();
      // backtick fence info may not contain backticks
      if (!(ch === '`' && info.includes('`'))) {
        // Up to the fence's own indent (0-3 columns) is stripped
        // from every content line — but only for backtick fences;
        // tilde fence content keeps its indentation verbatim.
        const indent = ch === '`' ? /^ */.exec(line)[0].length : 0;
        const body = [];
        i++;
        while (i < n) {
          const cl = lines[i];
          const cm = fenceMatch(cl);
          if (cm && cm[1][0] === ch && cm[1].length >= fence.length &&
              cm[2].trim() === '') { i++; break; }
          body.push(indent ? stripFenceCols(cl, indent) : cl); i++;
        }
        let content = body.join('\n');
        if (body.length) content += '\n';
        // When the last content line is empty the content loses
        // exactly one trailing newline (so a fence holding a single
        // blank line renders empty).
        if (body.length && body[body.length - 1] === '') {
          content = content.slice(0, -1);
        }
        let lang = info ? info.split(/\s+/)[0] : '';
        // Backslash escapes are resolved in the info string's first word.
        lang = lang.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        const cls = lang ? ` class="language-${escapeAttr(lang)}"` : '';
        out.push(`<pre><code${cls}>${escapeHtml(content)}</code></pre>\n`);
        prevEnd = i;
        continue;
      }
    }

    m = trig === '#' ? ATX_RE.exec(line) : null;
    if (m) {
      let text = m[2].replace(/[ \t]+$/, '');
      if (/^#+$/.test(text)) text = '';
      else text = text.replace(/[ \t]+#+$/, '');
      text = text.replace(/^[ \t]+/, '');
      out.push(`<h${m[1].length}>${renderInline(text, defs)}</h${m[1].length}>\n`);
      i++;
      prevEnd = i;
      continue;
    }

    if ((trig === '-' || trig === '_' || trig === '*') && HR_RE.test(line)) { out.push('<hr>\n'); i++; prevEnd = i; continue; }

    const hk = (trig === '<' || trig === null || trig === '\t') ? htmlBlockStart(line) : null;
    if (hk) {
      const rawTag = hk === 'raw'
        ? /^<([A-Za-z][A-Za-z0-9-]*)/.exec(stripCols(line, 3))[1] : '';
      const closeRe = hk === 'raw'
        ? new RegExp(`</${rawTag}(?:[\\s>]|$)`, 'i') : null;
      const body = [];
      while (i < n) {
        const l = lines[i];
        body.push(l); i++;
        if (hk === 'comment' && l.includes('-->')) break;
        if (hk === 'pi' && l.includes('?>')) break;
        if (hk === 'cdata' && l.includes(']]>')) break;
        if (hk === 'decl' && l.includes('>')) break;
        if (hk === 'raw' && closeRe.test(l)) break;
        if ((hk === 'tag' || hk === 'tag7') &&
            (i >= n || isBlankLine(lines[i]))) break;
      }
      // The block's raw text carries no trailing newline when a blank
      // line separates it from what follows; the newline ending its
      // last line is present when another block follows directly or
      // the block runs to the end of a newline-terminated input. For
      // comment and raw (pre/script/style/textarea) blocks only a
      // completely empty line counts as blank — a whitespace-only
      // separator still earns the trailing newline.
      let text = body.join('\n');
      const nextBlank = i >= n ? false
        : (hk === 'comment' || hk === 'raw')
          ? lines[i] === ''
          : isBlankLine(lines[i]);
      if (i >= n ? endsWithNl : !nextBlank) text += '\n';
      out.push(text);
      prevEnd = i;
      continue;
    }

    if (trig === '>' && QUOTE_RE.test(line)) {
      const inner = [];
      const lazyIdx = new Set();
      let lazySeenInPara = false;
      while (i < n) {
        const l = lines[i];
        if (QUOTE_RE.test(l)) {
          const qm = /^ {0,3}>/.exec(l);
          let rest = l.slice(qm[0].length);
          if (rest[0] === ' ' || rest[0] === '\t') {
            rest = stripCols(rest, 1, qm[0].length, true);
          }
          if (isBlankLine(rest)) lazySeenInPara = false;
          inner.push(rest); i++;
        } else if (!isBlankLine(l) && !wouldInterrupt(l) && inner.length &&
                   !isBlankLine(inner[inner.length - 1])) {
          // Lazy continuation: only an open paragraph can absorb the
          // line; it is taken verbatim for nested containers and with
          // its indent reduced mod 4 for a quote-level paragraph.
          // A lazy line stays paragraph text even when its stripped
          // form looks like a block start, so its index is recorded.
          const open = openBlockState(inner);
          if (open.state !== 'para') break;
          lazyIdx.add(inner.length);
          // Marked quirk: a lazy setext-underline line joining a
          // quote-level paragraph that already holds a lazy line is
          // carried with a 4-space indent (so it can only ever be
          // paragraph text); the first lazy line of a paragraph and
          // lazy lines of nested containers stay verbatim.
          if (open.topLevel && lazySeenInPara && SETEXT_RE.test(l)) {
            inner.push('    ' + l.replace(/^[ \t]+/, ''));
          } else {
            inner.push(lazyLine(l, open.topLevel));
          }
          lazySeenInPara = true;
          i++;
        } else break;
      }
      out.push('<blockquote>\n' + parseBlocks(inner, defs, false, lazyIdx) + '</blockquote>\n');
      prevEnd = i;
      continue;
    }

    const tbl = tryTable(lines, i, defs);
    if (tbl) { out.push(tbl.html); i = tbl.next; prevEnd = i; continue; }

    const lst = parseList(lines, i, defs);
    if (lst) { out.push(lst.html); i = lst.next; prevEnd = i; continue; }

    if (leadCols(line) >= 4) {
      const body = [];
      let lastContent = -1;
      while (i < n && (isBlankLine(lines[i]) || leadCols(lines[i]) >= 4)) {
        // A whitespace-only line keeps whatever columns remain
        // after the 4-column strip (an interior line of 6 spaces
        // contributes 2), like any other content line.
        body.push(stripCols(lines[i], 4));
        if (!isBlankLine(lines[i])) lastContent = body.length - 1;
        i++;
      }
      if (lastContent >= 0) {
        // Rewind over trailing blank lines so a following block can
        // still see the blank gap (matters for list looseness).
        i -= body.length - 1 - lastContent;
        body.length = lastContent + 1;
        out.push('<pre><code>' + escapeHtml(body.join('\n')) + '\n</code></pre>\n');
        prevEnd = i;
        continue;
      }
    }

    const chunk = handleChunk(lines, i, defs, endsWithNl, lazyIdx, inItem);
    out.push(chunk.html);
    i = chunk.next;
    prevEnd = i;
  }
  return { html: out.join(''), blankBetween, blocks: out.filter(Boolean) };
}

// Gather a paragraph / setext / definitions chunk starting at lines[i].
// lazyIdx (optional): indices of lines absorbed lazily by an enclosing
// blockquote — they are paragraph text and never interrupt the chunk.
function handleChunk(lines, i, defs, endsWithNl = false, lazyIdx = null, inItem = false) {
  // Inside a list item's own block content, the reference lets a
  // list of any start number interrupt a paragraph (at the top level
  // and inside blockquotes only a bullet or a 1. can).
  const interrupts = (l) => {
    if (wouldInterruptPara(l)) return true;
    if (!inItem) return false;
    const st = listStart(l);
    return st !== null && !st.empty;
  };
  const chunk = [];
  let setext = 0;
  let setextLine = null;
  let j = i;
  while (j < lines.length) {
    const l = lines[j];
    if (isBlankLine(l)) {
      // A whitespace-only line at the very end of a block context
      // whose text does not end with a newline is absorbed into the
      // paragraph instead of separating it (observed in blockquote
      // content: "> foo\n>  " renders the trailing space line).
      if (chunk.length && j === lines.length - 1 && !endsWithNl &&
          /[ \t]/.test(l)) {
        chunk.push(l); j++;
      }
      break;
    }
    if (chunk.length) {
      // A lazy continuation line (absorbed from an enclosing
      // blockquote or list item) is paragraph text, never a setext
      // underline — only a line native to this block context can
      // underline the chunk.
      const st = lineTrig(l);
      const sm = (lazyIdx && lazyIdx.has(j)) || (st !== '=' && st !== '-')
        ? null : SETEXT_RE.exec(l);
      if (sm) { setext = sm[1][0] === '=' ? 1 : 2; setextLine = l; j++; break; }
      if (interrupts(l) && !(lazyIdx && lazyIdx.has(j))) break;
    }
    chunk.push(l);
    j++;
  }
  // extract link definitions from the start of the chunk only:
  // definitions cannot appear in the middle of a paragraph
  const textLines = [];
  let k = 0;
  while (k < chunk.length) {
    const d = parseLinkDef(chunk, k);
    if (d) {
      if (!defs.has(d.label)) {
        defs.set(d.label, { href: cleanUrl(d.href), title: cleanTitle(d.title) });
      }
      k = d.next;
    } else {
      while (k < chunk.length) { textLines.push(chunk[k]); k++; }
    }
  }
  if (setext && textLines.length) {
    // Heading text loses the first line's leading indent and the
    // last line's trailing whitespace; interior lines keep theirs
    // verbatim (a mid-heading hard break still breaks). Paragraph
    // text (below) keeps every line's whitespace verbatim.
    const text = textLines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    return { html: `<h${setext}>${renderInline(text, defs)}</h${setext}>\n`, next: j };
  }
  if (setext) {
    // The paragraph before the underline was consumed entirely by
    // definitions, so there is nothing for a setext heading to head:
    // the underline line is ordinary paragraph text, and the
    // paragraph continues from here.
    textLines.push(setextLine);
    while (j < lines.length && !isBlankLine(lines[j]) &&
           !interrupts(lines[j])) {
      textLines.push(lines[j]);
      j++;
    }
  }
  if (!textLines.length) return { html: '', next: j };
  const text = textLines.join('\n');
  return { html: `<p>${renderInline(text, defs)}</p>\n`, next: j };
}

// ---------- lists ----------

function listStart(line) {
  // Manual equivalent of /^( {0,3})([*+-]|\d{1,9}[.)])([ \t]+|$)/:
  // up to 3 leading spaces, a bullet or 1-9 digits plus . or ),
  // then at least one space/tab or the end of the line.
  let g = 0;
  while (g < 3 && line[g] === ' ') g++;
  const gc = line[g];
  let marker;
  if (gc === '*' || gc === '+' || gc === '-') {
    marker = gc;
  } else if (gc >= '0' && gc <= '9') {
    let e = g;
    while (e < line.length && e - g < 9 &&
           line[e] >= '0' && line[e] <= '9') e++;
    if (line[e] >= '0' && line[e] <= '9') return null; // 10+ digits
    if (line[e] !== '.' && line[e] !== ')') return null;
    marker = line.slice(g, e + 1);
  } else return null;
  const after = g + marker.length;
  if (after < line.length && line[after] !== ' ' && line[after] !== '\t') {
    return null;
  }
  const ordered = marker[0] >= '0' && marker[0] <= '9';
  const preCols = g;
  let col = preCols + marker.length;
  let p = preCols + marker.length;
  let spaces = 0;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) {
    const w = line[p] === '\t' ? 4 - (col % 4) : 1;
    col += w; spaces += w; p++;
  }
  const blankItem = p >= line.length;
  const contentIndent = (blankItem || spaces >= 5)
    ? preCols + marker.length + 1
    : preCols + marker.length + spaces;
  return {
    ordered,
    delim: ordered ? marker[marker.length - 1] : marker,
    num: ordered ? parseInt(marker, 10) : null,
    contentIndent,
    empty: blankItem
  };
}

function parseList(lines, i, defs) {
  const start = listStart(lines[i]);
  if (!start) return null;
  const items = [];
  let j = i;
  let loose = false;
  while (j < lines.length) {
    // A thematic break line is never a list item, even when its
    // first marker matches this list's (e.g. "* * *" after "* Foo"
    // ends the list and stands as a break).
    const hj = lineTrig(lines[j]);
    if ((hj === '-' || hj === '_' || hj === '*') && HR_RE.test(lines[j])) break;
    const st = listStart(lines[j]);
    if (!st || st.ordered !== start.ordered || st.delim !== start.delim) break;
    const itemLines = [dropCols(lines[j], st.contentIndent)];
    const itemLazy = new Set();
    j++;
    let itemBlank = false;
    // Fence tracking for this item: an open fence swallows
    // unindented lines only once it has consumed at least one
    // content line at the item's own indent (fenceFed). Before
    // that, the first unindented line ends the item and leaves
    // the fence empty.
    let fCh = null, fLen = 0, fenceFed = false;
    const trackFence = (stripped, isContent) => {
      if (fCh !== null) {
        const cm = fenceMatch(stripped);
        if (cm && cm[1][0] === fCh && cm[1].length >= fLen &&
            cm[2].trim() === '') { fCh = null; return; }
        if (isContent) fenceFed = true;
        return;
      }
      const fm = fenceMatch(stripped);
      if (fm) { fCh = fm[1][0]; fLen = fm[1].length; }
    };
    trackFence(itemLines[0], false);
    while (j < lines.length) {
      const l = lines[j];
      if (isBlankLine(l) && fCh !== null && fenceFed) {
        // A blank line inside the item's open fence is fence
        // content, not a block separator.
        itemLines.push(''); j++; continue;
      }
      if (isBlankLine(l)) {
        // look ahead: still in item/list?
        let k = j;
        while (k < lines.length && isBlankLine(lines[k])) k++;
        if (k >= lines.length) { j = k; break; }
        const nst = listStart(lines[k]);
        if (nst && nst.ordered === start.ordered && nst.delim === start.delim &&
            leadCols(lines[k]) < st.contentIndent) {
          itemBlank = true; j = k; break; // blank between items
        }
        if (itemLines.every(isBlankLine)) {
          break; // item still empty: a blank line closes it for good
        }
        if (leadCols(lines[k]) >= st.contentIndent) {
          itemLines.push(''); j++; continue;
        }
        break; // list over; leave j on the blank line for gap tracking
      }
      if (leadCols(l) >= st.contentIndent) {
        const stripped = stripCols(l, st.contentIndent, 0, true);
        itemLines.push(stripped); trackFence(stripped, true); j++; continue;
      }
      // Any list marker at a lower indent ends the item (a different
      // marker starts a new list; even a different ordered number
      // does, since the item's paragraph closes with the item).
      if (listStart(l)) break;
      const hl = lineTrig(l);
      if ((hl === '-' || hl === '_' || hl === '*') && HR_RE.test(l)) break;
      // A line that is neither item content nor a sibling item:
      // what happens depends on the item's open block. Inside a
      // fence the line is raw fence content (stripped by up to the
      // content indent). Inside a paragraph it is a lazy
      // continuation (indent mod 4, like blockquote lazy lines; the
      // index is recorded so the line stays paragraph text when the
      // item is re-parsed). Otherwise the item is over.
      const ost = openBlockState(itemLines).state;
      if (ost === 'fence' && fenceFed) {
        const stripped = stripCols(l, st.contentIndent);
        itemLines.push(stripped); trackFence(stripped, false); j++; continue;
      }
      if (ost !== 'para') break;
      if (isBlankLine(itemLines[itemLines.length - 1])) break;
      if (fenceMatch(l) !== null || ATX_RE.test(l) || QUOTE_RE.test(l)) break;
      itemLazy.add(itemLines.length);
      itemLines.push(lazyLine(l, true)); j++;
    }
    if (itemBlank) loose = true;
    while (itemLines.length && isBlankLine(itemLines[itemLines.length - 1])) itemLines.pop();
    items.push({ lines: itemLines, lazy: itemLazy });
    if (j >= lines.length) break;
  }
  if (!items.length) return null;
  // Looseness is per list: an item makes THIS list loose when its own
  // top-level blocks are separated by a blank line (blankBetween from
  // its block parse) — blanks inside nested lists/quotes do not count.
  const parsed = items.map(({ lines: itemLines, lazy }) => {
    let task = null;
    if (itemLines.length) {
      const tm = /^\[([ xX])\][ \t]+/.exec(itemLines[0]);
      if (tm) {
        task = tm[1] !== ' ';
        itemLines[0] = itemLines[0].slice(tm[0].length);
      }
    }
    const r = parseBlocksEx(itemLines, defs, false, lazy, true);
    if (r.blankBetween) loose = true;
    return { html: r.html, blocks: r.blocks, task };
  });
  const tag = start.ordered ? 'ol' : 'ul';
  const startAttr = start.ordered && start.num !== 1 ? ` start="${start.num}"` : '';
  const out = [`<${tag}${startAttr}>\n`];
  for (const { html, blocks, task } of parsed) {
    let inner = html;
    if (!loose) {
      // Unwrap only the item's OWN top-level paragraphs; paragraphs
      // nested inside blockquotes or sublists keep their tags, and
      // blocks are concatenated with no separator.
      inner = blocks.map((b) =>
        (b.startsWith('<p>') && b.endsWith('</p>\n')) ? b.slice(3, -5) : b
      ).join('');
    }
    if (task !== null) {
      const box = task
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      if (loose && inner.startsWith('<p>')) {
        // In a loose list the checkbox goes inside the item's first
        // paragraph, ahead of its text.
        inner = '<p>' + box + inner.slice(3);
      } else {
        inner = box + inner;
      }
    }
    out.push(`<li>${inner}</li>\n`);
  }
  out.push(`</${tag}>\n`);
  return { html: out.join(''), next: j };
}

// ---------- tables ----------

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // Pipes inside a code span do not split. Spans pair up by equal
  // run length (an opener is matched with the next run of the same
  // length); a run with no such partner is literal text and
  // protects nothing.
  const prot = new Array(s.length).fill(false);
  for (let p = 0; p < s.length;) {
    if (s[p] === '\\') { p += 2; continue; }
    if (s[p] !== '`') { p++; continue; }
    let run = 1;
    while (s[p + run] === '`') run++;
    let q = p + run, closeEnd = -1;
    while (q < s.length) {
      if (s[q] === '\\') { q += 2; continue; }
      if (s[q] === '|') break; // a span never crosses a cell boundary
      if (s[q] === '`') {
        let r2 = 1;
        while (s[q + r2] === '`') r2++;
        if (r2 === run) { closeEnd = q + r2; break; }
        q += r2; continue;
      }
      q++;
    }
    if (closeEnd !== -1) {
      for (let k = p; k < closeEnd; k++) prot[k] = true;
      p = closeEnd;
    } else p += run;
  }
  const cells = [];
  let cur = '';
  for (let p = 0; p < s.length; p++) {
    const ch = s[p];
    if (ch === '\\' && p + 1 < s.length) {
      // An escaped pipe is cell text, not a delimiter, and the
      // backslash is dropped (even inside code spans).
      if (s[p + 1] === '|') { cur += '|'; p++; continue; }
      cur += ch + s[p + 1]; p++; continue;
    }
    if (ch === '|' && !prot[p]) { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function tryTable(lines, i, defs) {
  if (i + 1 >= lines.length) return null;
  if (!lines[i].includes('|') || isBlankLine(lines[i])) return null;
  const delimLine = lines[i + 1];
  if (!delimLine.includes('-')) return null;
  const delims = splitRow(delimLine);
  if (!delims.length || !delims.every((c) => /^:?-+:?$/.test(c))) return null;
  const header = splitRow(lines[i]);
  if (header.length !== delims.length) return null;
  const aligns = delims.map((c) => {
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    if (c.startsWith(':')) return 'left';
    return null;
  });
  const rows = [];
  let j = i + 2;
  // Body rows continue over any line that does not start another
  // block — a row need not contain a pipe (it is then a one-cell
  // row, padded); blank lines, headings, lists, quotes, fences,
  // breaks, HTML blocks and indented code end the table. A line of
  // only whitespace that contains a tab is NOT blank here (the
  // reference's table blank test is spaces-only): it becomes a row
  // of empty cells.
  while (j < lines.length && !/^ *$/.test(lines[j])) {
    if (/^\s+$/.test(lines[j])) {
      rows.push(header.map(() => ''));
      j++;
      continue;
    }
    if (wouldInterrupt(lines[j]) || leadCols(lines[j]) >= 4) break;
    let cells = splitRow(lines[j]);
    if (cells.length < header.length) {
      while (cells.length < header.length) cells.push('');
    } else if (cells.length > header.length) cells = cells.slice(0, header.length);
    rows.push(cells);
    j++;
  }
  const cellTag = (tag, align, text) =>
    `<${tag}${align ? ` align="${align}"` : ''}>${renderInline(text, defs)}</${tag}>\n`;
  let html = '<table>\n<thead>\n<tr>\n';
  header.forEach((c, k) => { html += cellTag('th', aligns[k], c); });
  html += '</tr>\n</thead>\n';
  if (rows.length) {
    html += '<tbody>';
    for (const row of rows) {
      html += '<tr>\n';
      row.forEach((c, k) => { html += cellTag('td', aligns[k], c); });
      html += '</tr>\n';
    }
    html += '</tbody></table>\n';
    return { html, next: j };
  }
  html += '</table>\n';
  return { html, next: j };
}

// ---------- inline parsing ----------

// Naive closing bracket: depth counting with backslash escapes
// only (no code-span or tag awareness). Used to recognise a
// would-be link label when the full scan fails.
function naiveClosingBracket(s, i) {
  let depth = 1;
  let p = i + 1;
  while (p < s.length) {
    const ch = s[p];
    if (ch === '\\') { p += 2; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return p; }
    p++;
  }
  return -1;
}

function findClosingBracket(s, i) {
  let depth = 1;
  let p = i + 1;
  let inCode = false;
  while (p < s.length) {
    const ch = s[p];
    if (ch === '`') {
      // Backtick runs inside a label pair up in order — any run
      // closes the span an earlier run opened — and brackets inside
      // a span do not count. An opening run of length >= 2 sitting
      // immediately before the closing bracket is label text, not a
      // span opener; any other unclosed span swallows the bracket.
      let run = 1;
      while (s[p + run] === '`') run++;
      if (inCode) { inCode = false; p += run; continue; }
      if (run >= 2 && depth === 1 && s[p + run] === ']') return p + run;
      inCode = true; p += run; continue;
    }
    if (inCode) { p++; continue; }
    if (ch === '\\') { p += 2; continue; }
    if (ch === '<') {
      // A raw HTML tag or autolink is one unit: brackets inside its
      // attribute values or URL do not count.
      HTML_TAG_RE_Y.lastIndex = p;
      AUTOLINK_RE_Y.lastIndex = p;
      EMAIL_RE_Y.lastIndex = p;
      const m = HTML_TAG_RE_Y.exec(s) || AUTOLINK_RE_Y.exec(s) ||
                EMAIL_RE_Y.exec(s);
      if (m) { p += m[0].length; continue; }
      p++; continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return p; }
    p++;
  }
  return -1;
}

// Parse "(dest title)" starting at s[pos] === '('.
// Whitespace here is only space/tab/newline: other Unicode spaces
// (e.g. NBSP) are ordinary destination characters.
const isDestWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function parseInlineDest(s, pos) {
  const isWs = isDestWs;
  let p = pos + 1;
  const skipWs = () => { while (p < s.length && isWs(s[p])) p++; };
  skipWs();
  let href = '';
  if (s[p] === '<') {
    let e = p + 1;
    let ok = false;
    while (e < s.length) {
      const c = s[e];
      if (c === '\\') { e += 2; continue; }
      if (c === '>') { ok = true; break; }
      if (c === '<' || c === '\n') return null;
      e++;
    }
    if (!ok) return null;
    href = s.slice(p + 1, e);
    p = e + 1;
  } else {
    let depth = 0;
    const start = p;
    while (p < s.length) {
      const ch = s[p];
      if (ch === '\\') { p += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (isWs(ch)) break;
      else if (ch < ' ') return null;
      p++;
    }
    if (depth !== 0) return null;
    href = s.slice(start, p);
  }
  href = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
  skipWs();
  let title = null;
  const q = s[p];
  if (q === '"' || q === "'" || q === '(') {
    const close = q === '(' ? ')' : q;
    let e = p + 1;
    let raw = '';
    let ok = false;
    while (e < s.length) {
      if (s[e] === '\\') { raw += s[e] + (s[e + 1] ?? ''); e += 2; continue; }
      if (s[e] === close) { ok = true; break; }
      if (q === '(' && s[e] === '(') return null;
      raw += s[e]; e++;
    }
    if (!ok) return null;
    title = raw;
    p = e + 1;
    skipWs();
  }
  if (s[p] !== ')') return null;
  return { href, title, end: p + 1 };
}

// Does this fragment contain a complete link (inline or reference)?
// Used to enforce "links cannot contain links": an outer bracket pair
// whose text holds a link is not itself a link (images are fine).
function containsLink(s, defs) {
  // A link needs a '[' (its own bracket) and angle units only matter
  // as things to skip over; with neither present there is no link.
  if (!s.includes('[') && !s.includes('<')) return false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      const close = s.indexOf('`'.repeat(run), i + run);
      i = close === -1 ? i + run : close + run;
      continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      // Images never block an outer link; skip the image text and
      // its destination part as well.
      const c = findClosingBracket(s, i + 1);
      if (c === -1) { i += 2; continue; }
      i = c + 1;
      if (s[i] === '(') {
        const d = parseInlineDest(s, i);
        if (d) i = d.end;
      } else if (s[i] === '[') {
        const c2 = findClosingBracket(s, i);
        if (c2 !== -1) i = c2 + 1;
      }
      continue;
    }
    if (ch === '<') {
      // Angle autolinks inside link text render as nested links in
      // the reference; they do not block the outer link. Skip any
      // <...> unit (tag or autolink) so brackets inside it are not
      // mistaken for link text brackets.
      HTML_TAG_RE_Y.lastIndex = i;
      const m = HTML_TAG_RE_Y.exec(s);
      if (m) { i += m[0].length; continue; }
      const gt = s.indexOf('>', i + 1);
      i = gt === -1 ? i + 1 : gt + 1;
      continue;
    }
    if (ch === '[') {
      const c = findClosingBracket(s, i);
      if (c === -1) { i++; continue; }
      const inner = s.slice(i + 1, c);
      let p = c + 1;
      if (s[p] === '(') {
        if (parseInlineDest(s, p)) return true;
      } else if (s[p] === '[') {
        const c2 = findClosingBracket(s, p);
        if (c2 !== -1) {
          const lab = s.slice(p + 1, c2);
          if (defs.has(normLabel(lab === '' ? inner : lab))) return true;
        }
      } else if (defs.has(normLabel(inner))) {
        return true;
      }
      i++;
      continue;
    }
    i++;
  }
  return false;
}

const NUM_DEC_RE = /&#([0-9]+);/y;
const NUM_HEX_RE = /&#[xX]([0-9a-fA-F]+);/y;
const NAMED_REF_RE = /&[A-Za-z][A-Za-z0-9]*;/y;

// ---------- GFM extended autolinks (www / http(s) / email / mailto / xmpp) ----------

const EMAIL_CAND_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9._-]+/y;
const URL_TAIL_RE = /[^\s<]+/y;
const XMPP_SEG_RE = /[A-Za-z0-9@._~+-]+/y;

// Match a bare email address at s[i]; returns {text, end} or null.
// The candidate is the longest run of email characters; the domain
// needs at least one dot and no empty labels. Trailing dots stay
// outside the link, but a candidate ending in '-' or '_' is not a
// link at all — except that a trailing '_' run which closes an
// earlier '_' delimiter of the same length in this fragment (the
// scan has already split there) is left outside the link. `nodes`,
// when given, is the current fragment's node list for that check.
function matchEmailAt(s, i, nodes) {
  EMAIL_CAND_RE.lastIndex = i;
  const m = EMAIL_CAND_RE.exec(s);
  if (!m) return null;
  let cand = m[0];
  while (cand.endsWith('.')) cand = cand.slice(0, -1);
  if (cand.endsWith('-')) return null;
  if (cand.endsWith('_')) {
    const run = /_+$/.exec(cand)[0].length;
    const closes = nodes && nodes.some((nd) =>
      nd.t === 'delim' && nd.ch === '_' && nd.len > 0 && nd.origLen === run);
    if (!closes) return null;
    cand = cand.slice(0, -run);
    while (cand.endsWith('.')) cand = cand.slice(0, -1);
    if (cand.endsWith('-') || cand.endsWith('_')) return null;
  }
  const domain = cand.slice(cand.indexOf('@') + 1);
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  for (const lab of labels) if (!lab) return null;
  return { text: cand, end: i + cand.length };
}

// Match mailto:/xmpp: followed by a valid email at s[i]. xmpp links
// may carry one extra /segment; mailto links may not.
function matchSchemeEmailAt(s, i) {
  let scheme = null;
  if (s.startsWith('mailto:', i)) scheme = 'mailto:';
  else if (s.startsWith('xmpp:', i)) scheme = 'xmpp:';
  if (!scheme) return null;
  const em = matchEmailAt(s, i + scheme.length);
  if (!em) return null;
  let end = em.end;
  if (scheme === 'xmpp:' && s[end] === '/') {
    XMPP_SEG_RE.lastIndex = end + 1;
    const seg = XMPP_SEG_RE.exec(s);
    if (seg) end = end + 1 + seg[0].length;
  }
  const text = s.slice(i, end);
  return { text, href: text, end };
}

// Scan the tail of an extended autolink starting at index i:
// plain runs (anything but whitespace, <, >, parens), balanced
// (...) groups (a group that never closes is not consumed), and
// lone ) characters. Returns the end index of the raw match.
// Exact JS \s membership for one character, on char codes.
function isWsCh(c) {
  if (c === ' ' || c === '\t' || c === '\n' || c === '\v' ||
      c === '\f' || c === '\r') return true;
  const cc = c.charCodeAt(0);
  return cc === 0xa0 || cc === 0x1680 || (cc >= 0x2000 && cc <= 0x200a) ||
         cc === 0x2028 || cc === 0x2029 || cc === 0x202f ||
         cc === 0x205f || cc === 0x3000 || cc === 0xfeff;
}

function scanUrlTail(s, i) {
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '(') {
      let depth = 1, k = j + 1;
      while (k < s.length && depth > 0) {
        const d = s[k];
        if (d === '(') depth++;
        else if (d === ')') depth--;
        else if (d === '<' || isWsCh(d)) break;
        k++;
      }
      if (depth !== 0) break; // unclosed group: match ends before (
      j = k;
    } else if (c === '<' || isWsCh(c)) break;
    else j++; // includes lone ) and ] characters
  }
  return j;
}

// Trim an extended www/http autolink the way the reference does: a
// trailing entity reference is excluded and trailing punctuation in
// ?!.,:*_~; is stripped. A trailing ) is dropped when it closes
// nothing: either the match has no ( at all, or its last ( is
// already closed earlier. A trailing ] is never stripped.
function trimAutolink(url, prefixLen) {
  const ent = /&[A-Za-z][A-Za-z0-9]*;$/.exec(url);
  if (ent) url = url.slice(0, ent.index);
  for (;;) {
    const before = url;
    while (url.length > prefixLen && /[?!.,:*_~;]$/.test(url)) url = url.slice(0, -1);
    while (url.length > prefixLen && url.endsWith(')')) {
      const open = url.lastIndexOf('(');
      if (open === -1) { url = url.slice(0, -1); continue; }
      if (url.indexOf(')', open) < url.length - 1) { url = url.slice(0, -1); continue; }
      break;
    }
    if (url === before) return url;
  }
}

function matchUrlAt(s, i) {
  let prefix = null;
  // The http(s) scheme matches case-insensitively (the link keeps
  // the original casing); www. is case-sensitive. The scheme test
  // runs on char codes so ordinary words starting with w/h/H are
  // rejected without slicing or lowercasing.
  if (s[i] === 'w') {
    if (s.startsWith('www.', i)) prefix = 'www.';
  } else if ((s.charCodeAt(i) | 32) === 104 &&
             (s.charCodeAt(i + 1) | 32) === 116 &&
             (s.charCodeAt(i + 2) | 32) === 116 &&
             (s.charCodeAt(i + 3) | 32) === 112) { // tt p
    if (s.charCodeAt(i + 4) === 58 && s.charCodeAt(i + 5) === 47 &&
        s.charCodeAt(i + 6) === 47) prefix = s.slice(i, i + 7); // http://
    else if ((s.charCodeAt(i + 4) | 32) === 115 &&
             s.charCodeAt(i + 5) === 58 && s.charCodeAt(i + 6) === 47 &&
             s.charCodeAt(i + 7) === 47) prefix = s.slice(i, i + 8); // https://
  }
  if (!prefix) return null;
  const end = scanUrlTail(s, i + prefix.length);
  if (end === i + prefix.length) return null;
  const url = trimAutolink(s.slice(i, end), prefix.length);
  if (url.length <= prefix.length) return null;
  const href = prefix === 'www.' ? 'http://' + url : url;
  return { text: url, href, end: i + url.length };
}

const AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const EMAIL_RE = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)>/;
const HTML_TAG_RE = /^<(?:!--(?:>|->|[\s\S]*?-->)|\?[\s\S]*?\?>|![A-Za-z][^>]*>|!\[CDATA\[[\s\S]*?\]\]>|\/[A-Za-z][A-Za-z0-9-]*\s*>|[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^<>"'\s]+|"[^"]*"|'[^']*'))?)*\s*\/?>)/;
// Sticky variants for the renderInline hot loop: exec anchored at
// lastIndex avoids slicing the remaining text for every '<'.
const AUTOLINK_RE_Y = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/y;
// Characters that end a plain-text run in renderInline's fast path.
const PLAIN_RUN_END = /[\\`&<\[!*_~\n]/g;
// Any character that can start an inline construct (used for the
// whole-text plain fast path in renderInline).
const PLAIN_SPECIAL_RE = /[\\`&<\[!*_~]/;
// Union of the extended-autolink hints: '@', 'www.', a mailto: or
// xmpp: scheme, or an http substring in any case.
const AUTO_HINT_RE = /@|www\.|mailto:|xmpp:|[hH][tT][tT][pP]/;
// Literal occurrences that can begin an extended autolink.
const AUTO_SPOT_RE = /www\.|mailto:|xmpp:|[hH][tT][tT][pP]/g;
// The email-candidate character class [A-Za-z0-9._%+-] on char codes.
function isEmailishCode(cc) {
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) ||
         (cc >= 97 && cc <= 122) || cc === 46 || cc === 95 ||
         cc === 37 || cc === 43 || cc === 45;
}
const EMAIL_RE_Y = /<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)>/y;
const HTML_TAG_RE_Y = /<(?:!--(?:>|->|[\s\S]*?-->)|\?[\s\S]*?\?>|![A-Za-z][^>]*>|!\[CDATA\[[\s\S]*?\]\]>|\/[A-Za-z][A-Za-z0-9-]*\s*>|[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^<>"'\s]+|"[^"]*"|'[^']*'))?)*\s*\/?>)/y;

// The reference decides emphasis against a masked view of the
// paragraph: backtick runs are paired across the whole text (each
// run with the next run of exactly the same length, left to right,
// non-overlapping) and emphasis/strikethrough delimiters inside a
// paired region are inert — even when the pairing crosses a link
// boundary, because a link label is tokenised separately in the
// real scan while the mask pairs its unclosed runs with later ones.
// Regions of reference-style usages in the forms [label][ref] and
// [label] are exempt: their labels' runs never take part in the
// pairing. Inline links [label](dest) and collapsed references
// [label][] are NOT exempt.
// Positions that matter to the mask scan: a backtick, a '[', or a
// '!' that opens an image bracket.
const MASK_INTEREST_RE = /`|\[|!(?=\[)/g;
// Positions the strong matcher's opaque scan acts on.
const OPAQUE_INTEREST_RE = /<|\*/g;

function computeEmMask(text) {
  // Masked regions are exactly the paired backtick spans; with no
  // backtick in the text there is nothing to mask.
  if (!text.includes('`')) return null;
  const n = text.length;
  const masked = new Uint8Array(n);
  let any = false;
  if (!text.includes('[')) {
    // Fast path: with no '[' in the text, no reference-style usage
    // region can exist, so backtick runs pair up in one plain scan
    // (same pairing rule as the general path below). The scan jumps
    // between backticks with indexOf instead of walking characters.
    let i = text.indexOf('`');
    while (i !== -1) {
      let run = 1;
      while (text[i + run] === '`') run++;
      let bs = 0;
      for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) bs++;
      let next = -1;
      if (bs % 2 === 0) {
        let j = text.indexOf('`', i + run);
        while (j !== -1) {
          let r = 1;
          while (text[j + r] === '`') r++;
          if (r === run) {
            masked.fill(1, i, j + r); any = true; next = j + r; break;
          }
          j = text.indexOf('`', j + r);
        }
      }
      i = next !== -1 ? text.indexOf('`', next) : text.indexOf('`', i + run);
    }
    return any ? masked : null;
  }
  // End of the reference-style usage starting at or after pos i
  // (forms [label][ref] and [label] only), or -1 when the bracket at
  // i starts an inline link, a collapsed reference, or no usage.
  const refUsageEnd = (i) => {
    const ch = text[i];
    if (ch !== '[' && !(ch === '!' && text[i + 1] === '[')) return -1;
    let bs = 0;
    for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) bs++;
    if (bs % 2 === 1) return -1;
    const open = ch === '!' ? i + 1 : i;
    const closeB = findClosingBracket(text, open);
    if (closeB === -1) return -1;
    const after = text[closeB + 1];
    if (after === '[') {
      const close2 = findClosingBracket(text, closeB + 1);
      if (close2 !== -1 && close2 > closeB + 2) return close2 + 1;
      return -1;
    }
    return after === '(' ? -1 : closeB + 1;
  };
  // The next maximal backtick run at or after pos j (escaped runs
  // included), skipping reference-usage regions. Iteration jumps
  // between interesting positions with a native regex scan.
  const nextRun = (j) => {
    MASK_INTEREST_RE.lastIndex = j;
    let m;
    while ((m = MASK_INTEREST_RE.exec(text)) !== null) {
      const p = m.index;
      if (text[p] === '`') {
        let r = 1;
        while (text[p + r] === '`') r++;
        return { start: p, len: r, end: p + r };
      }
      const e = refUsageEnd(p);
      if (e !== -1) { MASK_INTEREST_RE.lastIndex = e; }
    }
    return null;
  };
  MASK_INTEREST_RE.lastIndex = 0;
  let m;
  while ((m = MASK_INTEREST_RE.exec(text)) !== null) {
    const i = m.index;
    if (text[i] !== '`') {
      const e = refUsageEnd(i);
      if (e !== -1) { MASK_INTEREST_RE.lastIndex = e; }
      continue;
    }
    let run = 1;
    while (text[i + run] === '`') run++;
    let bs = 0;
    for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) bs++;
    if (bs % 2 === 0) {
      // Unescaped run: a span may open here. Its closing run is
      // the next maximal run of exactly the same length, escaped
      // or not.
      let closeEnd = -1;
      let cand = nextRun(i + run);
      while (cand) {
        if (cand.len === run) { closeEnd = cand.end; break; }
        cand = nextRun(cand.end);
      }
      if (closeEnd !== -1) {
        masked.fill(1, i, closeEnd); any = true;
        MASK_INTEREST_RE.lastIndex = closeEnd;
        continue;
      }
    }
    MASK_INTEREST_RE.lastIndex = i + run;
  }
  return any ? masked : null;
}

const ALNUM_CHAR = /[\p{L}\p{N}]/u;

// marked's strong matcher does not use the CommonMark delimiter
// algorithm: a `**` opener matches the first closing run whose
// content validates against a stricter grammar. The content units
// are: plain text; a nested strong with valid content; a clean
// emphasis span whose closer is not followed by a letter or digit;
// a "broken" emphasis (single stars s1 s2 s3 where s2 is followed
// by a letter/digit, the text before s3 ends in a non-space, and
// s3 is followed by the end or by whitespace plus more text); and
// a lone closer-type star followed by whitespace plus more text
// or by the end. Anything else leaves the strong unformed.
function markedStrongContentOk(s, maskedAt) {
  const m = s.length;
  if (m === 0 || m > 1000) return false;
  if (isSpace(s[0]) || isSpace(s[m - 1])) return false;
  const isStar = (i) => s[i] === '*' && !(maskedAt && maskedAt(i));
  const runLen = (i) => {
    let r = 0;
    while (i + r < m && isStar(i + r)) r++;
    return r;
  };
  function strongEnds(pos) {
    const ends = [];
    let j = pos + 2;
    while (j < m) {
      if (isStar(j)) {
        const r = runLen(j);
        if (r >= 2) {
          for (let k = 0; k <= r - 2; k++) {
            const inner = s.slice(pos + 2, j + k);
            if (inner.length && !isSpace(inner[inner.length - 1]) &&
                markedStrongContentOk(inner, maskedAt ? (q) => maskedAt(pos + 2 + q) : null)) {
              ends.push(j + k + 2);
            }
          }
        }
        j += r;
      } else j++;
    }
    return ends;
  }
  function emContentOk(a, b) {
    const memo = new Map();
    function parse(p) {
      if (p === b) return true;
      if (memo.has(p)) return memo.get(p);
      let ok = false;
      if (!isStar(p)) ok = parse(p + 1);
      else if (runLen(p) >= 2) {
        for (const e of strongEnds(p)) {
          if (e <= b && parse(e)) { ok = true; break; }
        }
      }
      memo.set(p, ok);
      return ok;
    }
    return parse(a);
  }
  function emEnds(pos) {
    const ends = [];
    let j = pos + 1;
    while (j < m) {
      if (isStar(j)) {
        const r = runLen(j);
        if (j > pos + 1 && !isSpace(s[j - 1]) && emContentOk(pos + 1, j)) {
          const after = j + 1 < m ? s[j + 1] : '';
          if (!ALNUM_CHAR.test(after)) ends.push(j + 1);
        }
        j += r;
      } else j++;
    }
    return ends;
  }
  function brokenEnds(pos) {
    let mid = -1;
    for (let j = pos + 1; j < m; j++) {
      if (isStar(j)) { mid = j; break; }
    }
    if (mid === -1 || runLen(mid) !== 1) return [];
    if (mid === pos + 1 || isSpace(s[mid - 1])) return [];
    if (mid + 1 >= m || !ALNUM_CHAR.test(s[mid + 1])) return [];
    let fin = -1;
    for (let j = mid + 1; j < m; j++) {
      if (isStar(j)) { fin = j; break; }
    }
    if (fin === -1 || runLen(fin) !== 1) return [];
    if (fin === mid + 1 || isSpace(s[fin - 1])) return [];
    if (fin + 1 < m && !(isSpace(s[fin + 1]) && fin + 2 < m && !isSpace(s[fin + 2]))) return [];
    return [fin + 1];
  }
  const memo = new Map();
  function parseRest(p) {
    if (p === m) return true;
    if (memo.has(p)) return memo.get(p);
    let ok = false;
    if (!isStar(p)) ok = parseRest(p + 1);
    else {
      const r = runLen(p);
      if (r >= 2) {
        for (const e of strongEnds(p)) {
          if (parseRest(e)) { ok = true; break; }
        }
      } else {
        for (const e of emEnds(p)) {
          if (parseRest(e)) { ok = true; break; }
        }
        if (!ok) {
          for (const e of brokenEnds(p)) {
            if (parseRest(e)) { ok = true; break; }
          }
        }
        if (!ok && p > 0 && !isSpace(s[p - 1]) &&
            (p + 1 === m || (isSpace(s[p + 1]) && p + 2 < m && !isSpace(s[p + 2])))) {
          ok = parseRest(p + 1);
        }
      }
    }
    memo.set(p, ok);
    return ok;
  }
  return parseRest(0);
}

// Try a marked-style strong match for the `**` run at `start` in
// text. Candidate closers are unmasked runs of 2+ stars, nearest
// first; for a run of 3+, the content without the extra stars is
// tried before the content that keeps them inside.
function matchStrongMarked(text, start, emMask) {
  const n = text.length;
  const cs = start + 2;
  if (cs >= n || isSpace(text[cs])) return null;
  // Positions whose stars are not delimiters: code-mask regions,
  // backslash-escaped stars, and the inside of HTML tags and
  // angle autolinks (consumed as single tokens by the lexer).
  // markedStrongContentOk rejects content longer than 1000 chars,
  // so no closer past cs + 1000 can ever validate: the opaque scan
  // and the candidate search are confined to that window.
  const limit = Math.min(n, cs + 1001);
  // Only positions below limit are ever read back, so the buffer
  // (and the mask copy) stops there instead of spanning the text.
  const opaque = new Uint8Array(limit);
  if (emMask) opaque.set(emMask.subarray(0, limit));
  // The scan only acts on '<' and '*': jump between them natively.
  OPAQUE_INTEREST_RE.lastIndex = cs;
  let om;
  while ((om = OPAQUE_INTEREST_RE.exec(text)) !== null) {
    const p = om.index;
    if (p >= limit) break;
    if (text[p] === '<') {
      AUTOLINK_RE_Y.lastIndex = p;
      EMAIL_RE_Y.lastIndex = p;
      HTML_TAG_RE_Y.lastIndex = p;
      const m = AUTOLINK_RE_Y.exec(text) || EMAIL_RE_Y.exec(text) || HTML_TAG_RE_Y.exec(text);
      if (m) {
        opaque.fill(1, p, p + m[0].length);
        OPAQUE_INTEREST_RE.lastIndex = p + m[0].length;
      }
    } else {
      let bs = 0;
      for (let k = p - 1; k >= 0 && text[k] === '\\'; k--) bs++;
      if (bs % 2 === 1) opaque[p] = 1;
    }
  }
  const maskedAt = (k) => !!opaque[cs + k];
  const rightFlankAt = (runPos, used) => {
    const prev = runPos === 0 ? ' ' : text[runPos - 1];
    const next = runPos + used >= n ? ' ' : text[runPos + used];
    return !isSpace(prev) && (!isPunctU(prev) || isSpace(next) || isPunctU(next));
  };
  let j = cs;
  while (j < limit) {
    if (text[j] === '*' && !opaque[j]) {
      let r = 1;
      while (text[j + r] === '*') r++;
      if (r >= 2) {
        for (let k = 0; k <= r - 2; k++) {
          const inner = text.slice(cs, j + k);
          if (inner.length && !isSpace(inner[inner.length - 1]) &&
              rightFlankAt(j + k, 2) && markedStrongContentOk(inner, maskedAt)) {
            return { end: j + k + 2, inner };
          }
        }
      }
      j += r;
    } else j++;
  }
  return null;
}

// marked's emphasis matcher for a single `*`, used to detect the
// one failure mode where marked leaves an emphasis opener literal
// while CommonMark would pair it: a strong span inside the
// would-be content that is "glued" to a following letter or digit
// (`*a **b**c*` stays literal apart from the strong). The content
// grammar is text (with tags, links and `__` spans consumed as
// units), strong spans, and nested emphasis spans. With
// enforceGlue set, a strong unit counts only when the character
// after it is not a letter or digit. Returns the end index just
// past the closing star, or null when no emphasis matches.
function parseEmMarked(text, start, emMask, enforceGlue) {
  const n = text.length;
  const cs = start + 1;
  if (cs >= n || isSpace(text[cs])) return null;
  const isStarAt = (p) => {
    if (text[p] !== '*' || (emMask && emMask[p])) return false;
    let bs = 0;
    for (let k = p - 1; k >= 0 && text[k] === '\\'; k--) bs++;
    return bs % 2 === 0;
  };
  const tagLenAt = (p) => {
    AUTOLINK_RE_Y.lastIndex = p;
    EMAIL_RE_Y.lastIndex = p;
    HTML_TAG_RE_Y.lastIndex = p;
    const m = AUTOLINK_RE_Y.exec(text) || EMAIL_RE_Y.exec(text) || HTML_TAG_RE_Y.exec(text);
    return m ? m[0].length : 0;
  };
  const linkUnitEnd = (p) => {
    const open = text[p] === '!' ? p + 1 : p;
    const closeB = findClosingBracket(text, open);
    if (closeB === -1) return 0;
    const after = text[closeB + 1];
    if (after === '(') {
      let depth = 0;
      for (let q = closeB + 1; q < n; q++) {
        if (text[q] === '\\') { q++; continue; }
        if (text[q] === '(') depth++;
        else if (text[q] === ')') { depth--; if (depth === 0) return q + 1; }
      }
      return 0;
    }
    if (after === '[') {
      const close2 = findClosingBracket(text, closeB + 1);
      return close2 === -1 ? 0 : close2 + 1;
    }
    return closeB + 1;
  };
  const strongUndEnd = (p) => {
    let q = p + 2;
    while (q < n) {
      if (text[q] === '_' && text[q + 1] === '_') {
        const inner = text.slice(p + 2, q);
        if (!inner.length || isSpace(inner[0]) || isSpace(inner[inner.length - 1])) return 0;
        if (enforceGlue && ALNUM_CHAR.test(text[q + 2] || '')) return 0;
        return q + 2;
      }
      q++;
    }
    return 0;
  };
  let p = cs;
  while (true) {
    while (p < n && !isStarAt(p)) {
      const c = text[p];
      if (c === '<') { const L = tagLenAt(p); p += L || 1; continue; }
      if (c === '[' || (c === '!' && text[p + 1] === '[')) {
        const e = linkUnitEnd(p);
        if (e) { p = e; continue; }
      }
      if (c === '_' && text[p + 1] === '_') {
        const e = strongUndEnd(p);
        if (e) { p = e; continue; }
      }
      p++;
    }
    if (p >= n) return null;
    if (p > cs && !isSpace(text[p - 1])) return p + 1;
    let r = 1;
    while (text[p + r] === '*') r++;
    if (r >= 2) {
      const sm = matchStrongMarked(text, p, emMask);
      if (sm && (!enforceGlue || !ALNUM_CHAR.test(text[sm.end] || ''))) {
        p = sm.end; continue;
      }
      return null;
    }
    const e = parseEmMarked(text, p, emMask, enforceGlue);
    if (e !== null) { p = e; continue; }
    return null;
  }
}

function renderInline(text, defs, noLink) {
  // Whole-text plain fast path: with no character that can start an
  // inline construct, no autolink hint, and no space-run before a
  // newline (a hard break), the full scan below would produce one
  // text node holding the whole input — its rendering is exactly
  // escapeHtml(text).
  if (!PLAIN_SPECIAL_RE.test(text) && !AUTO_HINT_RE.test(text) &&
      !text.includes('  \n')) {
    return escapeHtml(text);
  }
  const nodes = [];
  // The code-span mask is computed lazily: texts with backticks but
  // no emphasis delimiter that could look inside a span never pay
  // for it.
  let emMask;
  const getEmMask = () => (emMask === undefined
    ? (emMask = text.includes('`') ? computeEmMask(text) : null)
    : emMask);
  // Whether any extended-autolink probe could succeed in this text:
  // without '@', 'www.', a mailto:/xmpp: scheme or an http substring
  // (any case), every probe below is guaranteed to miss, so plain
  // runs never need to stop at word starts.
  const mayAuto = !noLink && AUTO_HINT_RE.test(text);
  // Positions where an autolink probe could succeed in this text:
  // literal www./mailto:/xmpp:/http occurrences, and the start of
  // each maximal email-character run that holds an '@' within the
  // probe window (320 chars) and passes the previous-char gate.
  // Plain runs jump straight to the next candidate instead of
  // testing every word start; probes at any other word start are
  // guaranteed to miss (their run holds no '@', and no literal
  // autolink prefix begins there).
  let autoStops = null;
  let stopPtr = 0;
  if (mayAuto) {
    autoStops = [];
    AUTO_SPOT_RE.lastIndex = 0;
    let sm;
    while ((sm = AUTO_SPOT_RE.exec(text)) !== null) autoStops.push(sm.index);
    let at = -1;
    while ((at = text.indexOf('@', at + 1)) !== -1) {
      let q = at;
      while (q > 0 && isEmailishCode(text.charCodeAt(q - 1))) q--;
      if (q < at && at - q < 320 &&
          (q === 0 || !isAutoPrevCh(text[q - 1]))) autoStops.push(q);
    }
    autoStops.sort((a, b) => a - b);
  }
  // Index until which emphasis delimiters stay literal: the label
  // of a link whose (...) destination failed to parse renders
  // without emphasis (code spans, links and autolinks inside it
  // still work).
  let noEmphUntil = -1;
  let buf = '';
  const flush = () => {
    if (buf) {
      const nd = { t: 'text', s: buf };
      if (inLink) nd.noAuto = true;
      nodes.push(nd);
      buf = '';
    }
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];

    // Fast path: bulk-copy a run of plain text into buf. The run
    // stops at every character the branches below treat specially,
    // and (when autolink probing is active) at word starts where a
    // probe below could match — those positions fall through to
    // the slow path, which re-checks them exactly as before.
    if (ch !== '\\' && ch !== '`' && ch !== '&' && ch !== '<' && ch !== '[' &&
        ch !== '!' && ch !== '*' && ch !== '_' && ch !== '~' && ch !== '\n') {
      let probe = false;
      if (!noLink && !inLink && mayAuto && isAlnum(ch)) {
        const pv = i === 0 ? '' : text[i - 1];
        if ((ch === 'w' || ch === 'h' || ch === 'H') &&
            (!pv || !(isAlnum(pv) || pv === '@'))) probe = true;
        else if (!pv || !isAutoPrevCh(pv)) {
          if (ch === 'm' || ch === 'x') probe = true;
          else {
            const at = text.indexOf('@', i);
            if (at !== -1 && at - i < 320) probe = true;
          }
        }
      }
      if (!probe) {
        let j = i + 1;
        if (noLink || inLink || !mayAuto) {
          // No probe can interrupt this run: jump straight to the
          // next special character with a native regex scan.
          PLAIN_RUN_END.lastIndex = j;
          const pm = PLAIN_RUN_END.exec(text);
          j = pm ? pm.index : n;
        } else {
          // Autolink probing is active: the run ends at the next
          // special character or the next candidate position,
          // whichever comes first.
          PLAIN_RUN_END.lastIndex = j;
          const pm = PLAIN_RUN_END.exec(text);
          let end = pm ? pm.index : n;
          while (stopPtr < autoStops.length && autoStops[stopPtr] <= i) stopPtr++;
          if (stopPtr < autoStops.length && autoStops[stopPtr] < end) {
            end = autoStops[stopPtr];
          }
          j = end;
        }
        buf += text.slice(i, j);
        i = j;
        continue;
      }
    }

    if (ch === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        flush();
        nodes.push({ t: 'html', s: '<br>' });
        i += 2;
        while (text[i] === ' ' || text[i] === '\t') i++;
        continue;
      }
      if (nx && isPunct(nx)) { buf += nx; i += 2; continue; }
      buf += '\\'; i++; continue;
    }

    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const ticks = '`'.repeat(run);
      // The closing fence must be a run of exactly the same length;
      // longer or shorter runs are ordinary content.
      let close = -1;
      for (let j = i + run; j < n;) {
        if (text[j] === '`') {
          let r = 1;
          while (text[j + r] === '`') r++;
          if (r === run) { close = j; break; }
          j += r;
        } else j++;
      }
      if (close !== -1) {
        let content = text.slice(i + run, close).replace(/\n/g, ' ');
        if (content.length > 1 && content.startsWith(' ') && content.endsWith(' ') &&
            /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flush();
        nodes.push({ t: 'html', s: `<code>${escapeHtml(content)}</code>` });
        i = close + run; continue;
      }
      buf += ticks; i += run; continue;
    }

    if (ch === '&') {
      // Numeric character references are decoded (0 and surrogates
      // become U+FFFD; values above U+10FFFF stay literal). Named
      // references are NOT decoded: any &name; sequence passes through
      // raw, exactly as written, defined name or not.
      NUM_DEC_RE.lastIndex = i;
      let m = NUM_DEC_RE.exec(text);
      let cp = null;
      if (m) cp = parseInt(m[1], 10);
      else {
        NUM_HEX_RE.lastIndex = i;
        m = NUM_HEX_RE.exec(text);
        if (m) cp = parseInt(m[1], 16);
      }
      if (m) {
        if (cp <= 0x10ffff) {
          buf += (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff))
            ? '\ufffd' : String.fromCodePoint(cp);
          i += m[0].length; continue;
        }
        buf += '&'; i++; continue;
      }
      NAMED_REF_RE.lastIndex = i;
      m = NAMED_REF_RE.exec(text);
      if (m) {
        flush();
        nodes.push({ t: 'html', s: m[0] });
        i += m[0].length; continue;
      }
      buf += '&'; i++; continue;
    }

    if (ch === '<') {
      AUTOLINK_RE_Y.lastIndex = i;
      let m = AUTOLINK_RE_Y.exec(text);
      if (m) {
        flush();
        nodes.push({ t: 'html', s: `<a href="${escapeAttr(cleanUrl(m[1]))}">${escapeHtml(m[1])}</a>` });
        i += m[0].length; continue;
      }
      EMAIL_RE_Y.lastIndex = i;
      m = EMAIL_RE_Y.exec(text);
      if (m) {
        flush();
        nodes.push({ t: 'html', s: `<a href="mailto:${escapeAttr(cleanUrl(m[1]))}">${escapeHtml(m[1])}</a>` });
        i += m[0].length; continue;
      }
      HTML_TAG_RE_Y.lastIndex = i;
      m = HTML_TAG_RE_Y.exec(text);
      if (m) {
        flush();
        nodes.push({ t: 'html', s: m[0] });
        // An <a> tag opens link state even when written <a /> —
        // a is not a void element, so the slash is ignored. The
        // state is a boolean: any </a> clears it, however many
        // <a> tags opened it.
        if (/^<a[\s>]/i.test(m[0])) inLink = true;
        else if (/^<\/a[\s>]/i.test(m[0])) inLink = false;
        i += m[0].length; continue;
      }
      buf += '<'; i++; continue;
    }

    if ((ch === '!' && text[i + 1] === '[') || (ch === '[' && !noLink)) {
      const isImg = ch === '!';
      const open = isImg ? i + 1 : i;
      const closeB = findClosingBracket(text, open);
      if (closeB === -1) {
        // The bracket scan failed (e.g. the label holds a code span
        // the scan cannot pair), yet a naive ]( exists: the
        // reference still treats the construct as a failed link
        // whose label renders without emphasis.
        const naive = naiveClosingBracket(text, open);
        if (naive !== -1 && text[naive + 1] === '(' && naive > noEmphUntil) {
          noEmphUntil = naive;
        }
      }
      if (closeB !== -1) {
        const innerText = text.slice(open + 1, closeB);
        let done = false;
        let p = closeB + 1;
        let href = null, title = null;
        if (text[p] === '(') {
          const d = parseInlineDest(text, p);
          if (d) { href = d.href; title = d.title; p = d.end; done = true; }
          else {
            // Not a valid inline link: fall back to a shortcut
            // reference using the bracketed text as its label.
            const def = defs.get(normLabel(innerText));
            if (def) { href = def.href; title = def.title; p = closeB + 1; done = true; }
            else if (closeB > noEmphUntil) noEmphUntil = closeB;
          }
        } else if (text[p] === '[') {
          const close2 = findClosingBracket(text, p);
          if (close2 !== -1) {
            const lab = text.slice(p + 1, close2);
            const key = normLabel(lab === '' ? innerText : lab);
            const def = defs.get(key);
            if (def) { href = def.href; title = def.title; p = close2 + 1; done = true; }
          }
        } else {
          const key = normLabel(innerText);
          const def = defs.get(key);
          if (def) { href = def.href; title = def.title; p = closeB + 1; done = true; }
        }
        if (done && href !== null &&
            (isImg || !containsLink(innerText, defs))) {
          flush();
          if (isImg) {
            const alt = escapeAttr(inlineText(innerText, defs));
            nodes.push({ t: 'html', s: `<img src="${escapeAttr(cleanUrl(href))}" alt="${alt}"${title != null ? ` title="${escapeAttr(cleanTitle(title))}"` : ''}>` });
          } else {
            const inner = renderInline(innerText, defs, true);
            nodes.push({ t: 'html', s: `<a href="${escapeAttr(cleanUrl(href))}"${title != null ? ` title="${escapeAttr(cleanTitle(title))}"` : ''}>${inner}</a>` });
          }
          i = p; continue;
        }
      }
      buf += ch; i++; continue;
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 1;
      while (text[i + run] === ch) run++;
      if (i < noEmphUntil || (getEmMask() && emMask[i])) {
        buf += ch.repeat(run); i += run; continue;
      }
      if (ch === '~' && run > 2) { buf += '~'.repeat(run); i += run; continue; }
      const prev = i === 0 ? ' ' : text[i - 1];
      const next = i + run >= n ? ' ' : text[i + run];
      const leftFlank = !isSpace(next) && (!isPunctU(next) || isSpace(prev) || isPunctU(prev));
      const rightFlank = !isSpace(prev) && (!isPunctU(prev) || isSpace(next) || isPunctU(next));
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || isPunctU(prev));
        canClose = rightFlank && (!leftFlank || isPunctU(next));
      } else {
        canOpen = leftFlank; canClose = rightFlank;
      }
      if (ch === '*' && run === 2 && canOpen) {
        const sm = matchStrongMarked(text, i, getEmMask());
        if (sm) {
          flush();
          nodes.push({ t: 'html', s: '<strong>' + renderInline(sm.inner, defs, noLink) + '</strong>' });
          i = sm.end; continue;
        }
      }
      if (ch === '*' && run === 1 && canOpen && !canClose &&
          parseEmMarked(text, i, getEmMask(), true) === null &&
          parseEmMarked(text, i, getEmMask(), false) !== null) {
        buf += '*'; i++; continue;
      }
      flush();
      nodes.push({ t: 'delim', ch, len: run, origLen: run, canOpen, canClose,
                   prevCh: i === 0 ? '' : text[i - 1],
                   nextCh: i + run >= n ? '' : text[i + run] });
      i += run; continue;
    }

    if (ch === '\n') {
      // hard break from trailing spaces
      const m = / +$/.exec(buf);
      if (m && m[0].length >= 2) {
        buf = buf.slice(0, -m[0].length);
        flush();
        nodes.push({ t: 'html', s: '<br>' });
        i++;
        while (text[i] === ' ' || text[i] === '\t') i++;
        continue;
      }
      buf += '\n'; i++; continue;
    }

    // GFM extended autolinks starting at a word boundary.
    if (!noLink && !inLink && isAlnum(ch)) {
      const prev = i === 0 ? '' : text[i - 1];
      let r = null;
      if (ch === 'm' || ch === 'x') {
        if (!prev || !isAutoPrevCh(prev)) r = matchSchemeEmailAt(text, i);
      }
      if (!r && (ch === 'w' || ch === 'h' || ch === 'H')) {
        if (!prev || !(isAlnum(prev) || prev === '@')) r = matchUrlAt(text, i);
      }
      if (!r && (!prev || !isAutoPrevCh(prev))) {
        const at = text.indexOf('@', i);
        if (at !== -1 && at - i < 320) {
          const em = matchEmailAt(text, i, nodes);
          if (em) r = { text: em.text, href: 'mailto:' + em.text, end: em.end };
        }
      }
      if (r) {
        flush();
        nodes.push({ t: 'html', s: `<a href="${escapeAttr(cleanUrl(r.href))}">${escapeHtml(r.text)}</a>` });
        i = r.end; continue;
      }
    }

    buf += ch; i++;
  }
  flush();
  // linkifyTextNodes only ever rewrites a text node the main scan
  // left behind: an autolink whose start the scan's probe gate
  // rejected (preceded by '@'), or one sitting next to raw '<'
  // markup. When neither shape occurs in the text it is a no-op,
  // so skip the call entirely.
  if (!noLink && (text.includes('<') ||
      /@[A-Za-z0-9._%+-]*(?:[hH][tT][tT][pP]|www\.)/.test(text))) {
    linkifyTextNodes(nodes);
  }
  processEmphasis(nodes);
  return renderNodes(nodes);
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += escapeHtml(nd.s);
    else if (nd.t === 'html') out += nd.s;
    else if (nd.t === 'delim') out += nd.ch.repeat(nd.len);
  }
  return out;
}

const isAlnumU = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);

// The reference's emphasis matcher refuses some spans the plain
// delimiter algorithm would form (observed from its output):
// - a *...* span whose content holds a **...** span that starts a
//   word (opener preceded by whitespace or the start) and is
//   immediately followed by a letter or digit;
// - a **...** span whose content holds such a *...* span, unless
//   an unmatched * delimiter follows that inner span;
// - an em span taken from a longer opening run, under the same
//   content condition as the strong case.
function spanVetoed(nodes, oi, ci, o, c, tag) {
  if (c.ch !== '*') return false;
  const findSpan = (wantTag) => {
    for (let k = oi + 1; k < ci; k++) {
      const nd = nodes[k];
      if (nd.t === 'html' && nd.spanTag === wantTag && nd.spanCh === '*' &&
          (nd.spanPrev === '' || isSpace(nd.spanPrev)) && isAlnumU(nd.spanNext)) {
        return k;
      }
    }
    return -1;
  };
  if (tag === 'em' && o.origLen === 1 && c.origLen === 1) {
    return findSpan('strong') !== -1;
  }
  if (tag === 'em' && o.origLen >= 2 && c.len === 1) {
    return findSpan('em') !== -1;
  }
  if (tag === 'strong' && o.origLen === 2 && c.origLen === 2) {
    const at = findSpan('em');
    if (at === -1) return false;
    for (let k = at + 1; k < ci; k++) {
      if (nodes[k].t === 'delim' && nodes[k].ch === '*' && nodes[k].len > 0) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function processEmphasis(nodes) {
  let ci = 0;
  while (ci < nodes.length) {
    const c = nodes[ci];
    if (!c || c.t !== 'delim' || !c.canClose || c.len === 0) { ci++; continue; }
    let oi = -1;
    let use = 0, tag = '';
    for (let k = ci - 1; k >= 0; k--) {
      const o = nodes[k];
      if (o.t === 'delim' && o.ch === c.ch && o.canOpen && o.len > 0) {
        if (c.ch === '~') { oi = k; use = Math.min(o.len, c.len, 2); tag = 'del'; break; }
        // Rule of 3: only applies when one of the two runs can both
        // open and close; otherwise any lengths may match (partially).
        const sum = o.len + c.len;
        const oddBlocked = (o.canClose || c.canOpen) && sum % 3 === 0 &&
          !(o.len % 3 === 0 && c.len % 3 === 0);
        if (oddBlocked) continue;
        const u = (o.len >= 2 && c.len >= 2) ? 2 : 1;
        const t = u === 2 ? 'strong' : 'em';
        // A vetoed pairing is final for this closer: the reference
        // scans left to right and leaves the closer as literal text
        // rather than reaching for an earlier opener.
        if (spanVetoed(nodes, k, ci, o, c, t)) break;
        oi = k; use = u; tag = t; break;
      }
    }
    if (oi === -1) { ci++; continue; }
    const o = nodes[oi];
    const inner = renderNodes(nodes.slice(oi + 1, ci));
    const spanNext = use === c.len ? c.nextCh : c.ch;
    o.len -= use;
    c.len -= use;
    nodes.splice(oi + 1, ci - oi - 1, {
      t: 'html', s: `<${tag}>${inner}</${tag}>`,
      spanTag: tag, spanCh: c.ch, spanPrev: o.prevCh, spanNext,
    });
    // After the splice the opener sits at oi, the span node at
    // oi + 1 and the closer at oi + 2 — the positions indexOf
    // would find — so use them directly.
    if (c.len === 0) {
      nodes.splice(oi + 2, 1);
      ci = oi + 1;
    } else {
      ci = oi + 2;
    }
    if (o.len === 0) {
      nodes.splice(oi, 1);
      if (ci > oi) ci--;
    }
  }
}

// GFM extended autolinks inside plain text nodes.
function linkifyTextNodes(nodes) {
  const re = /([Hh][Tt][Tt][Pp][Ss]?:\/\/|www\.)/g;
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    if (nd.t !== 'text' || nd.noAuto) continue;
    const s = nd.s;
    if (!s.includes('://') && !s.includes('www.')) continue;
    re.lastIndex = 0;
    let m, last = 0;
    const parts = [];
    while ((m = re.exec(s)) !== null) {
      const before = m.index === 0 ? '' : s[m.index - 1];
      if (before && isAlnum(before)) continue;
      const end = scanUrlTail(s, m.index + m[1].length);
      if (end === m.index + m[1].length) continue;
      const url = trimAutolink(s.slice(m.index, end), m[1].length);
      if (url.length <= m[1].length) continue;
      re.lastIndex = m.index + url.length;
      if (m.index > last) parts.push({ t: 'text', s: s.slice(last, m.index) });
      const href = m[1] === 'www.' ? 'http://' + url : url;
      parts.push({ t: 'html', s: `<a href="${escapeAttr(cleanUrl(href))}">${escapeHtml(url)}</a>` });
      last = m.index + url.length;
    }
    if (parts.length) {
      if (last < s.length) parts.push({ t: 'text', s: s.slice(last) });
      nodes.splice(idx, 1, ...parts);
      idx += parts.length - 1;
    }
  }
}

// Plain-text content of an inline fragment (used for image alt text).
function inlineText(s, defs) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && isPunct(s[i + 1])) { out += s[i + 1]; i += 2; continue; }
    if (ch === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      // The closing fence must be a run of exactly the same length;
      // an unclosed run is literal text (its backticks are kept).
      let close = -1;
      for (let j = i + run; j < s.length;) {
        if (s[j] === '`') {
          let r = 1;
          while (s[j + r] === '`') r++;
          if (r === run) { close = j; break; }
          j += r;
        } else j++;
      }
      if (close !== -1) {
        out += s.slice(i + run, close).replace(/\n/g, ' ');
        i = close + run; continue;
      }
      out += '`'.repeat(run); i += run; continue;
    }
    if (ch === '&') {
      const m = matchEntity(s, i);
      if (m) { out += m.text; i = m.end; continue; }
      out += '&'; i++; continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      const close = findClosingBracket(s, i + 1);
      if (close !== -1) {
        out += inlineText(s.slice(i + 2, close), defs);
        let p = close + 1;
        if (s[p] === '(') {
          const d = parseInlineDest(s, p);
          if (d) { i = d.end; continue; }
        } else if (s[p] === '[') {
          const c2 = findClosingBracket(s, p);
          if (c2 !== -1) { i = c2 + 1; continue; }
        }
        i = close + 1; continue;
      }
      i++; continue;
    }
    if (ch === '[') {
      const close = findClosingBracket(s, i);
      if (close !== -1) {
        const inner = s.slice(i + 1, close);
        // A bracket pair whose content holds a link is not itself a
        // link: keep the bracket and let the inner link render.
        if (containsLink(inner, defs)) { out += '['; i++; continue; }
        out += inlineText(inner, defs);
        let p = close + 1;
        if (s[p] === '(') {
          const d = parseInlineDest(s, p);
          if (d) { i = d.end; continue; }
        } else if (s[p] === '[') {
          const c2 = findClosingBracket(s, p);
          if (c2 !== -1) { i = c2 + 1; continue; }
        }
        i = close + 1; continue;
      }
      i++; continue;
    }
    if (ch === '<') {
      const m = HTML_TAG_RE.exec(s.slice(i));
      if (m) { i += m[0].length; continue; }
      out += '<'; i++; continue;
    }
    if (ch === '*' || ch === '~') {
      let run = 1;
      while (s[i + run] === ch) run++;
      i += run; continue;
    }
    out += ch; i++;
  }
  return out;
}

// ---------- entry point ----------

// Pre-collect link reference definitions for the whole document:
// definitions apply everywhere, including before the paragraph that
// defines them. Only definitions at the start of a paragraph chunk
// (after a blank line, or consecutive with other definitions) count;
// fenced code blocks are skipped.
function collectDefs(lines, defs) {
  let inFence = false, fenceCh = '', fenceLen = 0;
  let atStart = true;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const lt = lineTrig(l);
    const fm = (lt === '`' || lt === '~')
      ? /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l) : null;
    if (fm) {
      const run = fm[1];
      if (!inFence) {
        // A backtick fence whose info contains a backtick is not a
        // fence at all (it is paragraph text with inline code).
        if (!(run[0] === '`' && fm[2].includes('`'))) {
          // A fence indented at least one column whose first
          // content line is less indented than the fence itself is
          // the cut-off fence of a list item: it is empty, and the
          // following lines are ordinary blocks (a later bare run
          // opens a new fence). Only the opener line is consumed.
          const find = /^ */.exec(l)[0].length;
          const nl = lines[i + 1];
          if (find >= 1 && fm[2].trim() !== '' && nl !== undefined &&
              !isBlankLine(nl) && leadCols(nl) < find) {
            atStart = true;
            i++;
            continue;
          }
          inFence = true; fenceCh = run[0]; fenceLen = run.length;
          atStart = true;
          i++;
          continue;
        }
      } else if (run[0] === fenceCh && run.length >= fenceLen &&
                 fm[2].trim() === '') {
        // Only a bare run (no info string) closes a fence.
        inFence = false;
        atStart = true;
        i++;
        continue;
      }
    }
    if (inFence) { i++; continue; }
    if (isBlankLine(l)) { atStart = true; i++; continue; }
    const QM = /^ {0,3}>[ \t]?/;
    if (lt === '>' && QM.test(l) && (i === 0 || !QM.test(lines[i - 1]))) {
      // start of a blockquote run: collect definitions defined inside
      // it (they apply to the whole document)
      const inner = [];
      let k = i;
      while (k < lines.length && QM.test(lines[k])) {
        inner.push(lines[k].replace(QM, ''));
        k++;
      }
      let m = 0;
      while (m < inner.length) {
        const d = parseLinkDef(inner, m);
        if (!d) break;
        if (!defs.has(d.label)) {
          defs.set(d.label, { href: cleanUrl(d.href), title: cleanTitle(d.title) });
        }
        m = d.next;
      }
      i++;
      continue;
    }
    if (lt === '#' && /^ {0,3}#{1,6}(?:[ \t]|$)/.test(l)) { atStart = true; i++; continue; }
    if (atStart) {
      const d = parseLinkDef(lines, i);
      if (d) {
        if (!defs.has(d.label)) {
          defs.set(d.label, { href: cleanUrl(d.href), title: cleanTitle(d.title) });
        }
        i = d.next;
        continue;
      }
      atStart = false;
    }
    i++;
  }
}

// Whether an inline <a> tag is currently open in this document.
// While true, extended autolinks (bare www/http/email) are not
// linkified — the reference tracks the same document-wide state;
// it is a boolean, cleared by any </a>.
let inLink = false;

export function parse(markdown) {
  inLink = false;
  const src = String(markdown).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const endsWithNl = src.endsWith('\n');
  const lines = src.split('\n');
  if (endsWithNl) lines.pop();
  const defs = new Map();
  collectDefs(lines, defs);
  return parseBlocks(lines, defs, endsWithNl);
}
