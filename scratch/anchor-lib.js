// ---------------------------------------------------------------------------
// anchor-lib — the anchor grammar of Claude Design's canvas editor, ported.
//
// SOURCE OF TRUTH. THIS FILE IS INLINED, NOT IMPORTED.
//
// A web-chat component installs exactly four files (CONTRACT §1.2, §9.4), so
// `component.html` cannot `import` a helper from this repo. The pane script is
// compiled as `new Function('store','root','params','mountId', body)`
// (CONTRACT §5.1), which has no module system at all. So this file is the
// authoritative copy and its body is COPIED verbatim into the pane script.
// Edit it here, re-run `node --test test/uc-port.test.mjs`, then re-inline.
//
// Constraints this file is written to satisfy, so the copy is mechanical:
//   - no `import` / `export` / top-level `await` — it must compile as the body
//     of a `new Function(...)`, where any of those is a SyntaxError that fails
//     near-silently (CONTRACT §5.1).
//   - exactly one identifier leaks into the pane scope: `DsnAnchor`.
//   - no `document.*` — nothing here touches the DOM.
//   - the trailing `module.exports` line is guarded and is inert in a pane
//     (`typeof module` is 'undefined' there); it exists only so Node tooling
//     can require this file directly.
//
// PROVENANCE. Every constant and every function below is a port of a named
// symbol in Claude Design's `payload.template.html`, read from the user's own
// local install. No upstream bytes are reproduced here beyond the short
// expressions the port necessarily restates (CONTRACT §9.1). The port is
// proven byte-identical to the payload's own implementation by
// `test/uc-port.test.mjs`, which extracts the payload's version at test time
// from the LOCAL install and never from a committed copy (CONTRACT §8.2).
// If that test fails, this file is wrong — not the test.
//
// Upstream symbol map (minified names as of Claude Code 2.1.263 /
// payload sha256 76a2b0a4…; the names are minifier output and WILL churn, so
// the test locates them by shape, never by name):
//
//   Uc   → fileHash12          cyrb53, low 12 hex digits of the 53-bit value
//   ZP   → fraction4           round(clamp01(v) * 9999), zero-padded to 4
//   JP   → fractionFrom4       Number(s) / 9999
//   QP   → anchorSegment       (kind, payload) => "dc"+kind+payload+":nth-of-type(1)"
//   dE   → artboardAnchor      the mint site, artboard branch
//   fE   → parseArtboardAnchor the parse site, artboard branch
//   Die  → FINAL_SEGMENT_RE
//   _ie  → PLAIN_SEGMENT_RE
//   Aie  → ID_SEGMENT_RE
//   Pie  → NTH_OF_TYPE (1)
//   ZCe  → FILE_HASH_HEX (12)
//   Oie  → MAX_ANCHOR_SEGMENTS (10)
//
// WHAT THIS FILE IS NOT. It does not sanitise `anchor.text`. CONTRACT §4.4
// caps the label at 60 characters and forbids deriving it from frame DOM text;
// that is the pane's job at the call site, because the label is untrusted input
// from inside the same-origin frame (CONTRACT §9.3) and this module never sees
// the frame.
// ---------------------------------------------------------------------------

const DsnAnchor = (function () {
  // --- constants, all mirrored from the payload -----------------------------

  // ZCe — how many hex digits of the 53-bit hash survive into an anchor.
  const FILE_HASH_HEX = 12;

  // ZP — a fraction is stored as an integer 0…9999, zero-padded to 4 digits.
  const FRACTION_SCALE = 9999;
  const FRACTION_DIGITS = 4;

  // Pie — the payload mints every synthetic segment with this index and its
  // parser REFUSES any other value, so it is a constant and not a parameter.
  const NTH_OF_TYPE = 1;

  // The four anchor kinds the payload's grammar admits. v0.1.0 mints only 'a'.
  const KIND_ELEMENT = 'e';
  const KIND_ARTBOARD = 'a';
  const KIND_NOTE = 'n';
  const KIND_CANVAS_POINT = 'c';

  // CONTRACT §4.3 / payload dE + fE. The web-chat server stores `anchor`
  // verbatim with zero validation, so this is the only gate there is.
  const SEGMENT_SEPARATOR = ' > ';
  const MAX_ANCHOR_LENGTH = 1024;
  const MAX_ANCHOR_SEGMENTS = 10; // Oie

  // Die — the final segment of any valid anchor.
  const FINAL_SEGMENT_RE =
    /^dc([eanc])([0-9a-z]*):nth-of-type\(([1-9][0-9]{0,3})\)$/;
  // _ie — every other segment (a plain synthetic CSS type selector).
  const PLAIN_SEGMENT_RE = /^[a-z][a-z0-9-]{0,23}:nth-of-type\([1-9][0-9]{0,3}\)$/;
  // Aie — segment 0 only may instead be an id selector.
  const ID_SEGMENT_RE = /^#[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

  // The payload's own read-back shape for the 'e' and 'a' kinds:
  // 12 hex of file hash, then two 4-digit fractions.
  const HASH_AND_FRACTIONS_RE = /^([0-9a-f]{12})([0-9]{4})([0-9]{4})$/;

  // --- fileHash12 (payload `Uc`) --------------------------------------------
  //
  // cyrb53 with seed 0, truncated. The payload hashes the artboard's FILE PATH
  // with this and splices the 12 hex digits into the anchor.
  //
  // Every step is byte-load-bearing and none of it may be "cleaned up":
  //  - the two seeds are 0xdeadbeef and 0x41c6ce57, written the way the
  //    payload writes them (0xdeadbeef as a signed 32-bit int);
  //  - `Math.imul` is what makes the multiplies 32-bit — plain `*` overflows
  //    into float and silently produces a different hash;
  //  - the finalisation assigns h1 FIRST and h2 then reads the NEW h1;
  //  - the value is a 53-bit safe integer, so `toString(16)` is exact;
  //  - `padStart(14, '0')` then `slice(-12)` keeps the LOW 12 hex digits,
  //    i.e. the low 48 bits — it is a truncation, not a re-hash;
  //  - iteration is over UTF-16 CODE UNITS (`charCodeAt`), so an astral
  //    character contributes its two surrogates. Do not "fix" this to
  //    code points: it would break equivalence with the payload.
  //
  // Strictness added deliberately: the payload would accept a non-string and
  // quietly hash the empty string (`(5).length` is undefined, so its loop never
  // runs). An anchor is durable data, so a non-string here is a caller bug and
  // is thrown rather than encoded.
  function fileHash12(text) {
    if (typeof text !== 'string') {
      throw new TypeError('fileHash12 expects a string, got ' + typeof text);
    }
    let h1 = -559038737; // 0xdeadbeef as a signed 32-bit integer
    let h2 = 1103547991; // 0x41c6ce57
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 =
      Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
      Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 =
      Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
      Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    // 4294967296 === 2 ** 32; 2097151 === 2 ** 21 - 1. Together: 53 bits.
    const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return value.toString(16).padStart(14, '0').slice(-FILE_HASH_HEX);
  }

  // --- fraction4 (payload `ZP`) ---------------------------------------------
  //
  // CONTRACT §4.2 states this as `String(Math.round(clamp01(v) * 9999)).padStart(4,'0')`
  // and leaves the non-finite case open. The payload closes it: a non-finite
  // value becomes 0.5 (the artboard centre) BEFORE the clamp. That matters —
  // clamping NaN yields NaN, and `String(Math.round(NaN)).padStart(4,'0')` is
  // the literal string "0NaN", which would mint an anchor the payload's own
  // parser rejects. This port keeps the payload's guard.
  //
  // Note `Number.isFinite` is not coercing: the string "0.5" is NOT finite by
  // it and falls back to the 0.5 default. That is the payload's behaviour and
  // is reproduced exactly; pass numbers.
  function fraction4(value) {
    const finite = Number.isFinite(value) ? value : 0.5;
    const clamped = Math.min(1, Math.max(0, finite));
    return String(Math.round(clamped * FRACTION_SCALE)).padStart(
      FRACTION_DIGITS,
      '0',
    );
  }

  // JP — the inverse, for reading an anchor back. Lossy by design: the round
  // trip is exact only to 1/9999.
  function fractionFrom4(digits) {
    return Number(digits) / FRACTION_SCALE;
  }

  // --- anchor construction (payload `QP`, and the artboard branch of `dE`) ---

  function anchorSegment(kind, payload) {
    return 'dc' + kind + payload + ':nth-of-type(' + String(NTH_OF_TYPE) + ')';
  }

  // `dca<fileHash12><fx4><fy4>:nth-of-type(1)` — CONTRACT §4.2.
  //
  // `filePath` is the artboard's file path exactly as the canvas knows it
  // (e.g. "Pricing.dc.html"); fx/fy are fractions of the artboard box.
  // Returns null rather than an invalid string if validation fails, mirroring
  // the payload's own mint site, which also ends in a validate-or-null.
  function artboardAnchor(filePath, fx, fy) {
    const anchor = anchorSegment(
      KIND_ARTBOARD,
      fileHash12(filePath) + fraction4(fx) + fraction4(fy),
    );
    return validateAnchor(anchor, { strict: true }).ok ? anchor : null;
  }

  // --- validation (CONTRACT §4.3) -------------------------------------------
  //
  // Applies in BOTH directions: to anything minted here before it becomes
  // durable data, and to anything read back out of an anchor store. The
  // web-chat server stores `anchor` verbatim with zero validation and
  // `describeAnchor` does not truncate `selector`, so an unbounded or malformed
  // anchor read from the frame would flow straight into Claude's context.
  // An invalid anchor is DROPPED, never stored.
  //
  // Default mode is exactly the three rules CONTRACT §4.3 names.
  // `{ strict: true }` additionally applies the payload's own per-segment
  // grammar (`_ie`, with `Aie` allowed at index 0), which is what the payload's
  // mint site enforces on itself.
  function validateAnchor(anchor, options) {
    const strict = !!(options && options.strict);
    if (typeof anchor !== 'string') {
      return { ok: false, reason: 'anchor is not a string' };
    }
    if (anchor === '') {
      return { ok: false, reason: 'anchor is empty' };
    }
    if (anchor.length > MAX_ANCHOR_LENGTH) {
      return {
        ok: false,
        reason:
          'anchor is ' +
          anchor.length +
          ' chars, over the ' +
          MAX_ANCHOR_LENGTH +
          '-char limit',
      };
    }
    const segments = anchor.split(SEGMENT_SEPARATOR);
    if (segments.length > MAX_ANCHOR_SEGMENTS) {
      return {
        ok: false,
        reason:
          'anchor has ' +
          segments.length +
          ' segments, over the limit of ' +
          MAX_ANCHOR_SEGMENTS,
      };
    }
    const last = segments[segments.length - 1];
    const match = FINAL_SEGMENT_RE.exec(last);
    if (!match) {
      return {
        ok: false,
        reason: 'final segment does not match the anchor grammar',
      };
    }
    if (Number(match[3]) !== NTH_OF_TYPE) {
      return {
        ok: false,
        reason:
          'final segment is :nth-of-type(' +
          match[3] +
          '); the grammar admits only ' +
          NTH_OF_TYPE,
      };
    }
    if (strict) {
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const okSegment =
          PLAIN_SEGMENT_RE.test(segment) ||
          (i === 0 && ID_SEGMENT_RE.test(segment));
        if (!okSegment) {
          return { ok: false, reason: 'segment ' + i + ' is not a valid selector' };
        }
      }
    }
    return { ok: true, reason: null, kind: match[1], payload: match[2] };
  }

  function isValidAnchor(anchor, options) {
    return validateAnchor(anchor, options).ok;
  }

  // --- read-back (the artboard branch of payload `fE`) ----------------------
  //
  // Returns { fileHash12, fx, fy } for a canonical single-segment artboard
  // anchor, else null. Deliberately narrow: v0.1.0 mints only 'a' anchors, and
  // anything else read out of a store is not ours and is not decoded here.
  function parseArtboardAnchor(anchor) {
    const check = validateAnchor(anchor);
    if (!check.ok) return null;
    if (check.kind !== KIND_ARTBOARD) return null;
    if (anchor.split(SEGMENT_SEPARATOR).length !== 1) return null;
    const parts = HASH_AND_FRACTIONS_RE.exec(check.payload);
    if (!parts) return null;
    return {
      kind: KIND_ARTBOARD,
      fileHash12: parts[1],
      fx: fractionFrom4(parts[2]),
      fy: fractionFrom4(parts[3]),
      fx4: parts[2],
      fy4: parts[3],
    };
  }

  return {
    FILE_HASH_HEX,
    FRACTION_SCALE,
    FRACTION_DIGITS,
    NTH_OF_TYPE,
    KIND_ELEMENT,
    KIND_ARTBOARD,
    KIND_NOTE,
    KIND_CANVAS_POINT,
    SEGMENT_SEPARATOR,
    MAX_ANCHOR_LENGTH,
    MAX_ANCHOR_SEGMENTS,
    FINAL_SEGMENT_RE,
    PLAIN_SEGMENT_RE,
    ID_SEGMENT_RE,
    fileHash12,
    fraction4,
    fractionFrom4,
    anchorSegment,
    artboardAnchor,
    validateAnchor,
    isValidAnchor,
    parseArtboardAnchor,
  };
})();

// Inert in a pane (`typeof module` is 'undefined' under `new Function`);
// present only so Node tooling can require this file without a build step.
if (typeof module === 'object' && module !== null && module.exports) {
  module.exports = DsnAnchor;
}
