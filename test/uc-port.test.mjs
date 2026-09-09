// ---------------------------------------------------------------------------
// uc-port.test.mjs — proof that our anchor port is byte-identical to the
// payload's own implementation. CONTRACT §8.2.
//
// WHAT THIS PROVES, AND HOW
//
// `scratch/anchor-lib.js` reimplements three things the Claude Design payload
// does: `Uc` (the 12-hex hash of an artboard file path), `ZP` (the 4-digit
// fraction encoder) and the anchor grammar the two feed. CONTRACT §4.2 requires
// the hash port to be proven byte-identical BEFORE it is used to mint anchors,
// because an anchor is durable data and a wrong hash is a silently wrong pin
// forever.
//
// The proof works by extracting the payload's OWN implementation at test time,
// from the copy Claude Code materialised on this machine, and running the two
// side by side. Nothing upstream is committed to this repo (CONTRACT §9.1):
//   - the payload is located with `scripts/find-payload.mjs`, the same verified
//     discovery the service uses;
//   - the extracted function is held in memory for the duration of the run and
//     never written anywhere;
//   - when the payload is absent the payload-backed tests SKIP with the remedy,
//     they do not fail. A machine that has never run `/design` is not a broken
//     checkout.
//
// The extraction locates symbols BY SHAPE, never by minified name. `Uc` and its
// neighbours are minifier output and will churn on any upstream rebuild; the
// cyrb53 seed constants and the `padStart(14, …)` tail will not.
//
// The port is loaded the way the pane will actually load it — the file's text
// compiled as the body of a `new Function(...)`. That is not a convenience: it
// is the third thing under test. CONTRACT §5.1 compiles pane scripts exactly
// this way, where an `import`, an `export` or a top-level `await` is a
// SyntaxError that fails near-silently. If anchor-lib ever grows one, this file
// fails here rather than the pane failing in front of a user.
//
// Run:  node --test test/uc-port.test.mjs      (or just: node test/uc-port.test.mjs)
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePayload } from '../scripts/find-payload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const LIB_PATH = join(REPO, 'scratch', 'anchor-lib.js');

// ---------------------------------------------------------------------------
// Load the port exactly as the pane will: as `new Function` body text.
// ---------------------------------------------------------------------------

let lib = null;
let libLoadError = null;

if (!existsSync(LIB_PATH)) {
  libLoadError =
    'scratch/anchor-lib.js is missing. It is the source of truth for the anchor ' +
    'grammar and is inlined into components/design-canvas/component.html. ' +
    'Note that `scratch/` is listed in .gitignore, so a fresh clone will not ' +
    'have it — un-ignore this one file (or move it) before relying on CI.';
} else {
  try {
    const source = readFileSync(LIB_PATH, 'utf8');
    // Compiled with the same four parameter names the mount runtime uses, so
    // an accidental reference to one of them is caught here too.
    const compile = new Function(
      'store',
      'root',
      'params',
      'mountId',
      source + '\nreturn DsnAnchor;',
    );
    lib = compile(undefined, undefined, undefined, undefined);
  } catch (err) {
    libLoadError =
      'scratch/anchor-lib.js does not compile as a `new Function` body, which ' +
      'is how CONTRACT §5.1 runs pane scripts. It must contain no import, no ' +
      'export and no top-level await. Error: ' +
      err.message;
  }
}

// ---------------------------------------------------------------------------
// Extract the payload's own implementations.
// ---------------------------------------------------------------------------

// Walk from an opening brace to its match, skipping over quoted strings so a
// brace inside a string literal cannot unbalance the scan. Bounded: these
// functions are a few hundred characters and an unbounded scan over a 2.4 MB
// minified file on a shape change would be a hang, not a failure.
function matchBrace(source, openIndex, limitChars = 8000) {
  let depth = 0;
  let quote = null;
  const end = Math.min(source.length, openIndex + limitChars);
  for (let i = openIndex; i < end; i++) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Resolve a free identifier the extracted body references, e.g. the `ZCe` in
// `.slice(-ZCe)`, by finding its numeric definition elsewhere in the payload.
function resolveNumericConst(source, identifier) {
  const re = new RegExp('[,;{(=\\s]' + identifier + '=(-?[0-9]+)(?=[,;)}\\s])');
  const m = re.exec(source);
  return m ? Number(m[1]) : null;
}

// cyrb53's two seeds. The payload writes 0xdeadbeef as the signed 32-bit
// -559038737; a rebuild could emit the unsigned form instead, and Math.imul
// makes the two identical, so accept either.
const CYRB53_HEAD =
  /function\s+([A-Za-z0-9_$]+)\s*\(\s*([A-Za-z0-9_$]+)\s*\)\s*\{\s*let\s+[A-Za-z0-9_$]+\s*=\s*(?:-559038737|3735928559)\s*,\s*[A-Za-z0-9_$]+\s*=\s*1103547991\b/g;

function extractFileHash(source) {
  const candidates = [];
  CYRB53_HEAD.lastIndex = 0;
  for (let m; (m = CYRB53_HEAD.exec(source)); ) {
    const open = m.index + m[0].indexOf('{');
    const close = matchBrace(source, open);
    if (close === -1) continue;
    const text = source.slice(m.index, close + 1);
    candidates.push({ name: m[1], text });
  }
  if (candidates.length === 0) {
    return { ok: false, reason: 'no cyrb53-shaped function found in the payload' };
  }
  // The payload carries a second, unrelated cyrb53 (a 16-hex route hash). Only
  // the anchor one finalises through `.padStart(14, …)`, which is the 53-bit
  // width — that is the discriminator, and it is behavioural, not cosmetic.
  const hits = candidates.filter((c) => c.text.includes('padStart(14'));
  if (hits.length !== 1) {
    return {
      ok: false,
      reason:
        'expected exactly 1 cyrb53 function finalising through padStart(14, …), found ' +
        hits.length +
        ' (of ' +
        candidates.length +
        ' cyrb53-shaped functions). Re-probe the payload: the anchor hash changed shape.',
    };
  }
  const { name, text } = hits[0];

  // Bind whatever free constants the body references (`ZCe`, the truncation
  // width) so the function can be evaluated in isolation.
  const decls = [];
  const seen = new Set();
  for (const m of text.matchAll(/\.slice\(-([A-Za-z_$][A-Za-z0-9_$]*)\)/g)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const value = resolveNumericConst(source, id);
    if (value === null) {
      return {
        ok: false,
        reason: 'could not resolve the payload constant ' + id + ' referenced by the hash',
      };
    }
    decls.push('const ' + id + ' = ' + value + ';');
  }

  let fn;
  try {
    fn = new Function(decls.join('\n') + '\n' + text + '\nreturn ' + name + ';')();
  } catch (err) {
    return { ok: false, reason: 'extracted hash did not evaluate: ' + err.message };
  }
  return { ok: true, name, fn, truncation: decls.join(' ') };
}

// `ZP` — the fraction encoder. Located by its literal expression head, which is
// distinctive and appears once.
const FRACTION_HEAD = '=>String(Math.round(Math.min(1,Math.max(0,';
const FRACTION_EXPR =
  /((?:\([A-Za-z0-9_$,\s]*\)|[A-Za-z0-9_$]+)\s*=>\s*String\(Math\.round\(Math\.min\(1,Math\.max\(0,[\s\S]{0,200}?\.padStart\(4,\s*["']0["']\))/;

function extractFraction(source) {
  const at = source.indexOf(FRACTION_HEAD);
  if (at === -1) {
    return { ok: false, reason: 'the fraction encoder (ZP) was not found in the payload' };
  }
  if (source.indexOf(FRACTION_HEAD, at + 1) !== -1) {
    return { ok: false, reason: 'the fraction encoder shape appears more than once; re-probe' };
  }
  const window = source.slice(Math.max(0, at - 80), at + 300);
  const m = FRACTION_EXPR.exec(window);
  if (!m) {
    return { ok: false, reason: 'could not delimit the fraction encoder expression' };
  }
  let fn;
  try {
    fn = new Function('return (' + m[1] + ');')();
  } catch (err) {
    return { ok: false, reason: 'extracted fraction encoder did not evaluate: ' + err.message };
  }
  return { ok: true, fn, text: m[1] };
}

// `QP` — the segment builder. We do not evaluate it; we read the nth-of-type
// index out of it, because the payload's parser refuses any other value.
const SEGMENT_BUILDER =
  /"dc"\s*\+\s*[A-Za-z0-9_$]+\s*\+\s*[A-Za-z0-9_$]+\s*\+\s*":nth-of-type\("\s*\+\s*String\(([A-Za-z0-9_$]+)\)\s*\+\s*"\)"/;

function extractNthOfType(source) {
  const m = SEGMENT_BUILDER.exec(source);
  if (!m) return { ok: false, reason: 'the anchor segment builder (QP) was not found' };
  const value = resolveNumericConst(source, m[1]);
  if (value === null) {
    return { ok: false, reason: 'could not resolve the segment builder constant ' + m[1] };
  }
  return { ok: true, value };
}

const found = resolvePayload();
let payloadSource = null;
let hash = null;
let fraction = null;
let nth = null;
let skip = false;

if (!found.ok) {
  skip =
    'Claude Design payload not found on this machine (' +
    found.reason +
    '). ' +
    found.hint +
    ' Searched: ' +
    found.searched +
    '. The port itself is still checked; only the equivalence proof is skipped.';
} else {
  payloadSource = readFileSync(found.payload, 'utf8');
  hash = extractFileHash(payloadSource);
  fraction = extractFraction(payloadSource);
  nth = extractNthOfType(payloadSource);
}

// ---------------------------------------------------------------------------
// Sample inputs. Artboard file paths are the real input, but the payload feeds
// the same hash note ids and page ids, so the samples deliberately range wider
// than any name the seeding helper would accept — a hash must be right on
// whatever it is handed, including what a hostile canvas could put in front of
// it (CONTRACT §9.3).
// ---------------------------------------------------------------------------

const SAMPLE_PATHS = [
  // the ordinary cases
  'Main.dc.html',
  'Pricing.dc.html',
  'Checkout.dc.html',
  'canvas.json',
  // case sensitivity must survive
  'main.dc.html',
  'MAIN.DC.HTML',
  // dots, the helper's own "Card.v2.dc.html" shape, and dot-only names
  'Card.v2.dc.html',
  'a.b.c.d.e.dc.html',
  '.',
  '..',
  '...',
  '.hidden.dc.html',
  // spaces, including leading/trailing and runs
  'Spring Menu.dc.html',
  ' leading.dc.html',
  'trailing .dc.html',
  'double  space.dc.html',
  '\t tab and space .dc.html',
  // path separators both ways — the hash is over the path as given
  './Main.dc.html',
  'artboards/Main.dc.html',
  '/path/to/artboards/Main.dc.html',
  'C:\\path\\to\\Main.dc.html',
  // unicode: latin supplement, combining vs precomposed, CJK, kana, cyrillic,
  // RTL, astral, and a ZWJ grapheme cluster
  '\u00c9cran 1.dc.html',
  'U\u0308bersicht.dc.html',
  '\u00dcbersicht.dc.html',
  'e\u0301cran.dc.html',
  '\u00e9cran.dc.html',
  '\u8bbe\u8ba1\u753b\u677f.dc.html',
  '\u30ad\u30e3\u30f3\u30d0\u30b9.dc.html',
  '\u0434\u0438\u0437\u0430\u0439\u043d.dc.html',
  '\u0644\u0648\u062d\u0629.dc.html',
  '\ud83c\udfa8 Poster.dc.html',
  '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66 family.dc.html',
  '\ud83c\udff3\ufe0f\u200d\ud83c\udf08.dc.html',
  // lone surrogates — invalid UTF-16 that charCodeAt still yields
  '\ud800lone-high.dc.html',
  '\udfffLone-low.dc.html',
  // control characters and quoting metacharacters
  '\u0000null.dc.html',
  'new\nline.dc.html',
  'quote"and\'apos.dc.html',
  '<script>alert(1)</script>.dc.html',
  // long names, at and past every limit in the grammar
  'L'.repeat(80) + '.dc.html',
  'L'.repeat(300) + '.dc.html',
  'x'.repeat(1024),
  'x'.repeat(4096),
  // single characters and near-neighbours, where a weak hash would collide
  '',
  'a',
  'b',
  'ab',
  'ba',
  '0',
  '00',
  '1',
  // the other things the payload hashes with the same function
  'note-id-abc123',
  'page-1',
  'page-2',
];

// Deterministic PRNG so a failure names an input that can be reproduced.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFuzzInputs(count, seed) {
  const rand = mulberry32(seed);
  const pick = (n) => Math.floor(rand() * n);
  const pools = [
    () => String.fromCharCode(32 + pick(95)), // ASCII printable
    () => String.fromCharCode(0x00a0 + pick(0x2f00)), // BMP, mostly letters/symbols
    () => String.fromCodePoint(0x1f300 + pick(0x400)), // astral, as a surrogate pair
    () => String.fromCharCode(pick(0x10000)), // any code unit, lone surrogates included
  ];
  const out = [];
  for (let i = 0; i < count; i++) {
    const len = pick(64);
    let s = '';
    for (let j = 0; j < len; j++) s += pools[pick(pools.length)]();
    out.push(s);
  }
  return out;
}

const FUZZ_INPUTS = makeFuzzInputs(500, 0x5eed);
const ALL_INPUTS = SAMPLE_PATHS.concat(FUZZ_INPUTS);

const SAMPLE_FRACTIONS = [
  0, 1, 0.5, 0.25, 0.75, 0.1, 0.9, 0.0001, 0.9999, 0.00005, 0.99995,
  1 / 3, 2 / 3, 0.12345, 0.42, 0.77,
  -0, -1, -0.5, 2, 1e9, -1e9, // out of range, must clamp
  NaN, Infinity, -Infinity, // non-finite, must fall back to the centre
  Number.EPSILON, 1 - Number.EPSILON,
];

// ---------------------------------------------------------------------------
// Tests that need no payload — the port must stand on its own.
// ---------------------------------------------------------------------------

test('anchor-lib compiles as a pane script body (CONTRACT §5.1)', () => {
  assert.equal(libLoadError, null, String(libLoadError));
  assert.ok(lib, 'anchor-lib exported no DsnAnchor object');
  for (const name of [
    'fileHash12',
    'fraction4',
    'fractionFrom4',
    'anchorSegment',
    'artboardAnchor',
    'validateAnchor',
    'isValidAnchor',
    'parseArtboardAnchor',
  ]) {
    assert.equal(typeof lib[name], 'function', name + ' is not exported');
  }
});

test('fileHash12 always returns 12 lowercase hex digits', () => {
  for (const input of ALL_INPUTS) {
    const out = lib.fileHash12(input);
    assert.match(
      out,
      /^[0-9a-f]{12}$/,
      'fileHash12(' + JSON.stringify(input) + ') = ' + JSON.stringify(out),
    );
  }
});

test('fileHash12 is a pure function of a string', () => {
  assert.equal(lib.fileHash12('Main.dc.html'), lib.fileHash12('Main.dc.html'));
  assert.notEqual(lib.fileHash12('Main.dc.html'), lib.fileHash12('main.dc.html'));
  assert.notEqual(lib.fileHash12('ab'), lib.fileHash12('ba'));
  for (const bad of [null, undefined, 12, {}, ['Main.dc.html']]) {
    assert.throws(
      () => lib.fileHash12(bad),
      TypeError,
      'a non-string must throw rather than silently hash the empty string',
    );
  }
});

test('fileHash12 has no collisions across the sample set', () => {
  // Not a cryptographic claim — 48 bits over ~550 inputs has a collision
  // probability around 1e-covering-nothing. It is a smoke test that the
  // truncation is taking the low digits and not, say, a constant prefix.
  const seen = new Map();
  for (const input of ALL_INPUTS) {
    const h = lib.fileHash12(input);
    if (seen.has(h) && seen.get(h) !== input) {
      assert.fail(
        'collision: ' + JSON.stringify(seen.get(h)) + ' and ' + JSON.stringify(input),
      );
    }
    seen.set(h, input);
  }
  assert.ok(seen.size > 500, 'expected the sample set to produce >500 distinct hashes');
});

test('fraction4 encodes to 4 digits and clamps (CONTRACT §4.2)', () => {
  assert.equal(lib.fraction4(0), '0000');
  assert.equal(lib.fraction4(1), '9999');
  assert.equal(lib.fraction4(0.5), '5000'); // round(4999.5) rounds half up
  assert.equal(lib.fraction4(0.0001), '0001');
  assert.equal(lib.fraction4(2), '9999');
  assert.equal(lib.fraction4(-5), '0000');
  // Non-finite falls back to the artboard centre, never to the string "0NaN".
  assert.equal(lib.fraction4(NaN), '5000');
  assert.equal(lib.fraction4(Infinity), '5000');
  assert.equal(lib.fraction4(undefined), '5000');
  for (const v of SAMPLE_FRACTIONS) {
    assert.match(lib.fraction4(v), /^[0-9]{4}$/, 'fraction4(' + String(v) + ')');
  }
});

test('validateAnchor enforces exactly CONTRACT §4.3', () => {
  const good = 'dca0123456789ab42007700:nth-of-type(1)';
  assert.equal(lib.validateAnchor(good).ok, true);

  // length <= 1024, checked before the grammar so an unbounded string minted by
  // the frame can never reach describeAnchor (which does not truncate).
  const overLong = 'x'.repeat(1025);
  assert.equal(lib.validateAnchor(overLong).ok, false);
  assert.match(lib.validateAnchor(overLong).reason, /1024/);
  const JOIN = ':nth-of-type(1) > ';
  const atLimit = 'd'.repeat(1024 - good.length - JOIN.length) + JOIN + good;
  assert.equal(atLimit.length, 1024, 'fixture should sit exactly on the cap');
  assert.equal(lib.validateAnchor(atLimit).ok, true, 'exactly 1024 chars is legal');
  assert.equal(lib.validateAnchor('d' + atLimit).ok, false, '1025 chars is not');

  // <= 10 " > " segments
  const ten = Array.from({ length: 9 }, () => 'div:nth-of-type(1)')
    .concat([good])
    .join(' > ');
  assert.equal(ten.split(' > ').length, 10);
  assert.equal(lib.validateAnchor(ten).ok, true);
  const eleven = Array.from({ length: 10 }, () => 'div:nth-of-type(1)')
    .concat([good])
    .join(' > ');
  assert.equal(lib.validateAnchor(eleven).ok, false);
  assert.match(lib.validateAnchor(eleven).reason, /segments/);

  // final segment must match Die
  for (const bad of [
    '',
    'div:nth-of-type(1)',
    'dcx0123456789ab42007700:nth-of-type(1)', // kind not in [eanc]
    'dcaXYZ:nth-of-type(1)', // payload not [0-9a-z]*
    'dca0123456789ab42007700:nth-of-type(0)', // index must be 1-9…
    'dca0123456789ab42007700:nth-of-type(2)', // …and specifically 1
    'dca0123456789ab42007700',
    'div:nth-of-type(1) > dca0123456789ab42007700:nth-of-type(1) > div:nth-of-type(1)',
  ]) {
    assert.equal(
      lib.validateAnchor(bad).ok,
      false,
      'should be rejected: ' + JSON.stringify(bad),
    );
  }
  for (const bad of [null, undefined, 42, {}, ['dca…']]) {
    assert.equal(lib.validateAnchor(bad).ok, false);
  }
});

test('artboardAnchor mints the CONTRACT §4.2 grammar and round-trips', () => {
  const anchor = lib.artboardAnchor('Pricing.dc.html', 0.42, 0.77);
  assert.match(anchor, /^dca[0-9a-f]{12}[0-9]{4}[0-9]{4}:nth-of-type\(1\)$/);
  assert.equal(
    anchor,
    'dca' +
      lib.fileHash12('Pricing.dc.html') +
      lib.fraction4(0.42) +
      lib.fraction4(0.77) +
      ':nth-of-type(1)',
  );
  assert.equal(lib.isValidAnchor(anchor, { strict: true }), true);

  const parsed = lib.parseArtboardAnchor(anchor);
  assert.ok(parsed, 'artboard anchor did not parse back');
  assert.equal(parsed.kind, 'a');
  assert.equal(parsed.fileHash12, lib.fileHash12('Pricing.dc.html'));
  assert.ok(Math.abs(parsed.fx - 0.42) < 1 / 9999);
  assert.ok(Math.abs(parsed.fy - 0.77) < 1 / 9999);

  // Every sample path and fraction mints something valid and parseable.
  for (const file of SAMPLE_PATHS) {
    for (const fx of [0, 0.5, 1, NaN]) {
      const a = lib.artboardAnchor(file, fx, 1 - (Number.isFinite(fx) ? fx : 0.5));
      assert.ok(a, 'failed to mint for ' + JSON.stringify(file));
      assert.ok(a.length <= 1024);
      assert.ok(lib.parseArtboardAnchor(a));
    }
  }

  // An anchor of another kind is not decoded as an artboard.
  assert.equal(lib.parseArtboardAnchor('dcn0123456789ab:nth-of-type(1)'), null);
  assert.equal(
    lib.parseArtboardAnchor(
      'dcp0123456789ab:nth-of-type(1) > dccp0000000p0000000:nth-of-type(1)',
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// The equivalence proof. Skips, loudly, when the payload is absent.
// ---------------------------------------------------------------------------

if (skip) {
  console.error('\n' + '-'.repeat(72));
  console.error('uc-port.test.mjs: SKIPPING the payload equivalence proof.');
  console.error(skip);
  console.error('-'.repeat(72) + '\n');
}

test('the payload\'s hash implementation can be extracted', { skip }, () => {
  assert.ok(hash.ok, hash.reason);
  assert.equal(typeof hash.fn, 'function');
  // The truncation width the payload uses must be the 12 CONTRACT §4.2 names.
  assert.match(hash.truncation, /= 12;/);
  assert.equal(lib.FILE_HASH_HEX, 12);
});

test('fileHash12 is byte-identical to the payload over the sample paths', { skip }, () => {
  assert.ok(hash.ok, hash && hash.reason);
  assert.ok(
    SAMPLE_PATHS.length >= 20,
    'CONTRACT §8.2 requires at least 20 sample paths, have ' + SAMPLE_PATHS.length,
  );
  let checked = 0;
  for (const input of SAMPLE_PATHS) {
    const theirs = hash.fn(input);
    const ours = lib.fileHash12(input);
    assert.equal(
      ours,
      theirs,
      'fileHash12 mismatch for ' +
        JSON.stringify(input) +
        ': ours=' +
        ours +
        ' payload=' +
        theirs,
    );
    checked += 1;
  }
  assert.equal(checked, SAMPLE_PATHS.length);
});

test('fileHash12 is byte-identical to the payload over 500 fuzz inputs', { skip }, () => {
  assert.ok(hash.ok, hash && hash.reason);
  for (const input of FUZZ_INPUTS) {
    assert.equal(
      lib.fileHash12(input),
      hash.fn(input),
      'fileHash12 mismatch for ' + JSON.stringify(input),
    );
  }
});

test('fraction4 is byte-identical to the payload\'s encoder', { skip }, () => {
  assert.ok(fraction.ok, fraction && fraction.reason);
  const rand = mulberry32(0xf00d);
  const inputs = SAMPLE_FRACTIONS.slice();
  for (let i = 0; i < 500; i++) inputs.push(rand() * 1.4 - 0.2);
  for (const v of inputs) {
    assert.equal(
      lib.fraction4(v),
      fraction.fn(v),
      'fraction4 mismatch for ' + String(v),
    );
  }
});

test('the anchor grammar constants match the payload', { skip }, () => {
  // The regexes are compared by source text against the payload's own literals.
  for (const [name, re] of [
    ['FINAL_SEGMENT_RE (Die)', lib.FINAL_SEGMENT_RE],
    ['PLAIN_SEGMENT_RE (_ie)', lib.PLAIN_SEGMENT_RE],
    ['ID_SEGMENT_RE (Aie)', lib.ID_SEGMENT_RE],
  ]) {
    assert.ok(
      payloadSource.includes('/' + re.source + '/'),
      name + ' does not appear verbatim in the payload: /' + re.source + '/',
    );
  }
  assert.ok(nth.ok, nth && nth.reason);
  assert.equal(
    lib.NTH_OF_TYPE,
    nth.value,
    'the payload mints :nth-of-type(' + nth.value + ') and its parser refuses any other value',
  );
  // Oie, the segment cap.
  assert.equal(
    resolveNumericConst(payloadSource, 'Oie') ?? lib.MAX_ANCHOR_SEGMENTS,
    lib.MAX_ANCHOR_SEGMENTS,
  );
});

test('a whole artboard anchor is byte-identical to the payload\'s', { skip }, () => {
  assert.ok(hash.ok, hash && hash.reason);
  assert.ok(fraction.ok, fraction && fraction.reason);
  // Rebuild the payload's own mint site (the artboard branch of dE) from the
  // pieces extracted out of it, and compare the finished strings.
  const theirAnchor = (file, fx, fy) =>
    'dc' + 'a' + hash.fn(file) + fraction.fn(fx) + fraction.fn(fy) + ':nth-of-type(1)';
  const rand = mulberry32(0xbeef);
  for (const file of SAMPLE_PATHS) {
    for (let i = 0; i < 6; i++) {
      const fx = rand();
      const fy = rand();
      assert.equal(
        lib.artboardAnchor(file, fx, fy),
        theirAnchor(file, fx, fy),
        'anchor mismatch for ' + JSON.stringify(file) + ' at ' + fx + ',' + fy,
      );
    }
  }
});

test('the payload build this ran against is recorded', { skip }, () => {
  // Not an assertion about correctness — it puts the provenance in the test log
  // so a future failure can be told apart from upstream drift.
  console.error(
    '    payload: claude code ' +
      found.version +
      ', sha256 ' +
      found.payload_sha256.slice(0, 16) +
      '\u2026, hash symbol ' +
      hash.name,
  );
  assert.equal(found.payload_sha256.length, 64);
});
