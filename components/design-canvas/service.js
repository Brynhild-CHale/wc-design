'use strict';
/*
 * design-canvas — host-side service for the wc-design pack.
 *
 * check-no-vendored: names upstream markers for detection, ships none
 * (the template marker below is how we RECOGNISE the payload; it is a
 * fingerprint, not payload content — see scripts/check-no-vendored.mjs.)
 *
 * It resolves Claude Design's editor payload on THIS machine, seeds it from the
 * user's own `.dc.html` artboards by running Anthropic's own seed-canvas.mjs
 * helper, hands the 2.4 MB result to the pane through a runtime-written carrier
 * component, and keeps it current while files change.
 *
 * ── WHERE THIS SERVICE WRITES (CONTRACT §6.4) ───────────────────────────────
 * v0.1.0's rule was "this service NEVER writes to `dir`". §6.4 has since been
 * reversed, deliberately, into a NARROW LICENCE: edit mode (§9.5) makes Save
 * write the user's own edits back to the user's own files, and `saveBack()`
 * (§13b) is the ONLY code path in this file permitted to do it. Everything else
 * — seeding, watching, the carrier, the generated canvas.json, every diagnostic
 * — still writes to exactly two roots and never to `dir`:
 *
 *     <webChatDir>/.wc-design-build/<carrier>/     the seed output, the
 *                                                  generated canvas.json (§8b),
 *                                                  and the save backups (§13b)
 *     <webChatDir>/components/<carrier>/           the delivery carrier
 *
 * That includes the frame manifest: when `dir` has no canvas.json this service
 * SYNTHESISES one, and it goes to the build dir and is passed as `--canvas`
 * from there. Seeding leaves the user's folder byte-identical, and a canvas.json
 * they DO have is never rewritten at seed time — §8b/§8c only ever add keys they
 * omitted, into a copy.
 *
 * and that is ENFORCED, not merely asserted, by TWO gates that between them
 * cover every write in this file:
 *
 *   assertWritable(p)     the two roots above, and explicitly NOT anything under
 *                         `dir`. Used by `writeAtomic`, `writeCarrier`,
 *                         `removeCarrier`, `sweepStaleCarriers`, the build-dir
 *                         mkdir in `seedNow`, and saveBack's own temp + backup
 *                         tree.
 *   assertSaveTarget(n)   ONE file directly inside `dir`, named by a basename
 *                         the helper's own `--extract` just produced. Used by
 *                         NOTHING but `saveBack`, which is the whole of §6.4's
 *                         licence.
 *
 * Grep this file for `fsp.` and for
 *   fs\.(writeFileSync|renameSync|rmSync|mkdirSync|copyFileSync|unlinkSync)
 * — every PATH any of them touches is the return value of one of those two
 * functions. The spawned helper is likewise write-bounded: in seeding mode
 * seed-canvas.mjs performs exactly one write, to `--out`, which is always under
 * the build dir; in `--extract` mode (reached only from saveBack) it writes only
 * into the fresh `--to` directory, which is also under the build dir. So the
 * helper never writes into `dir` in either mode — saveBack does, one file at a
 * time, only after the extract has already succeeded. `dir` is otherwise opened
 * read-only, and the child is spawned with cwd set to the build dir so a
 * relative write inside it could not land in `dir` either.
 *
 * ── Export shape (CONTRACT §6.1) ────────────────────────────────────────────
 * The forked runner tests `typeof svc.start === 'function'` and SILENTLY NO-OPS
 * otherwise — a bare exported function means the service never starts and the
 * pane waits forever. See
 *   ~/.web-chat/versions/0.7.5/lib/server/service-runner.js:53
 *     `if (svc && typeof svc.start === 'function') await svc.start(ctx);`
 * so this module ends in `module.exports = { name, start, stop }`.
 *
 * `ctx` is built at service-runner.js:33-52 and is exactly
 *   { driver, params, mountId, name, log, diff, webChatDir, fence }
 * `ctx.webChatDir` is the project's `.web-chat` absolute path (services.js:240
 * passes `paths.WEB_CHAT_DIR`); `ctx.fence(parent, child)` is lib/core/paths.js
 * `fence` — the one containment engine, which refuses a lexical `../..` AND a
 * symlink that resolves out of the tree.
 *
 * ── Params (CONTRACT §1.1) ──────────────────────────────────────────────────
 *   dir title isolate watch routing        as documented there, plus:
 *   frame_w / frame_h  number, optional    an explicit frame size for artboards
 *                                          that declare none of their own. An
 *                                          artboard that DOES declare one keeps
 *                                          it — a declaration beats a blanket.
 *   expand  "auto" | "fit" | "fill"        default "auto": decided per artboard
 *                                          from the same evidence as the size
 *                                          (§8b). "fill" forces fill on every
 *                                          artboard; "fit" forces fit.
 *   wide_scan  boolean, default false      opt into the weakest size rung — the
 *                                          widest declared px width anywhere in
 *                                          the source. Off by default because it
 *                                          is a heuristic, not a declaration;
 *                                          what it WOULD have found is published
 *                                          either way as `frames[].widest_px`.
 *
 * ── Store keys (CONTRACT §2) ────────────────────────────────────────────────
 *   dsn_canvas  service → pane   the pane's whole world; written in EVERY state
 *   dsn_files   service → pane   what is actually on disk
 *   dsn_ctl     pane → service   { seq, op: 'reseed' | 'rescan' }  (read only)
 * `dsn_ask` is the pane's declared wake signal and is never read or written here.
 *
 * Two ADDITIVE dsn_canvas keys carry edit mode (§13b). CONTRACT §2.1 does not
 * close the shape, and both are documented at their publish site:
 *   save_endpoint  { url, token } | null   the loopback save listener (§6.6)
 *   last_save      the outcome of the last Save, or null (§6.4/§6.7)
 *
 * `ctx.driver.setStore(patch)` takes the PATCH DIRECTLY — the `{patch:{…}}`
 * wrapper belongs to the MCP `set_store` tool, not the driver. Confirmed at
 * ~/.web-chat/versions/0.7.5/lib/driver.js:51-53
 *     setStore(patch) { return call('POST', '/api/store', { patch }); }
 * i.e. the driver adds the wrapper itself.
 *
 * See CONTRACT.md for the normative shapes; § references below point there,
 * except where a comment says FINDINGS.
 */

const fs = require('fs');
const fsp = fs.promises;            // saveBack only — see §13b
const http = require('http');       // the loopback save listener — see §13b
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/* ------------------------------------------------------------------ *
 * 1. Payload discovery
 *
 * !! DUPLICATED INLINE FROM scripts/find-payload.mjs — KEEP THE TWO IN SYNC !!
 *
 * A component installs exactly four files (component.html, meta.json, seed.js,
 * service.js — CONTRACT §1.2/§9.4), so this file CANNOT import a helper module
 * from the repo. The duplication is deliberate (CONTRACT §6.2). The script says
 * the same thing at its own site. If you change the search roots, the ranking,
 * the template marker or the OWNERSHIP GATE in one, change the other in the
 * same commit.
 *
 * Three things about the path that are easy to get wrong (FINDINGS §1):
 *  - the temp root is NOT $TMPDIR: it is `CLAUDE_CODE_TMPDIR || "/tmp"`, a
 *    hardcoded literal (macOS resolves /tmp → /private/tmp through a symlink,
 *    which is the only reason the observed path looks like that);
 *  - the 32-hex segment is randomBytes(16).toString('hex'), a per-process
 *    nonce, not a content hash — never a stable key: enumerate, then rank;
 *  - there is a `claude-<uid>` segment between the temp root and bundled-skills.
 *
 * We read the copy Claude Code itself wrote to the user's temp directory. This
 * pack ships none of Anthropic's bytes and contains no code that extracts
 * assets from the Claude Code executable (CONTRACT §9.1, FINDINGS §11).
 * ------------------------------------------------------------------ */

const TMP_ROOT = process.env.CLAUDE_CODE_TMPDIR || '/tmp';
const BUNDLED_ROOTS = [
  path.join(TMP_ROOT, `claude-${typeof process.getuid === 'function' ? process.getuid() : ''}`, 'bundled-skills'),
  path.join(TMP_ROOT, 'bundled-skills'),
];
const PAYLOAD_FILE = 'payload.template.html';
const HELPER_FILE = 'seed-canvas.mjs';
// The one string that proves a file is an UNSEEDED editor template.
const TEMPLATE_MARKER = 'APPIFACT-TITLE-PLACEHOLDER';

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/* ── OWNERSHIP GATE (CONTRACT §9.2/§9.3) ────────────────────────────────────
 *
 * The FIRST search root is `<tmp>/claude-<uid>/bundled-skills`, which Claude
 * Code creates 0700 and owns. The SECOND is the bare `<tmp>/bundled-skills`,
 * which on macOS and Linux lives directly under a world-writable sticky
 * directory (`/private/tmp` is `drwxrwxrwt`). Nothing owns that path: ANY local
 * principal can create it.
 *
 * Without this gate, that is not a cosmetic problem. `findCandidates` ranks by
 * version string, so a planted `<tmp>/bundled-skills/99.0.0/<nonce>/design/`
 * outranks the real install; the only content test is "does the first 64 KB
 * contain the template marker", which is a 25-byte string anyone can write. The
 * service would then
 *   1. `spawn(process.execPath, [<their seed-canvas.mjs>, …])` — arbitrary code
 *      as the user, and
 *   2. write their HTML into the carrier, which the pane mounts as `srcdoc`
 *      SAME-ORIGIN with the daemon — the realm §9.3 describes, which reads
 *      private pins with their text, forges pins into Claude's context, and can
 *      POST /api/packs/install.
 * §9.2 ("only ever display locally-authored canvases") is the invariant that
 * makes §9.3's exposure survivable, so it has to be enforced at the point the
 * bytes are chosen, not assumed.
 *
 * The gate: every level from the search root down to `design/`, plus both files
 * in it, must be owned by THIS uid, must not be a symlink, and must not be
 * group- or world-writable. The supported tree passes untouched (verified:
 * `drwx------` all the way down, `-rw-------` on both files). Anything a second
 * principal could have written fails, and fails LOUDLY — see resolveUpstream(),
 * which says which path it refused rather than reporting a bare `no-payload`.
 *
 * No-op where POSIX ownership does not apply (Windows), where `process.getuid`
 * is undefined and `st.mode` carries no meaningful permission bits.
 */
const TRUST_UID = typeof process.getuid === 'function' ? process.getuid() : null;

function trustedEntry(p, wantDir) {
  if (TRUST_UID === null) return true;      // non-POSIX: no ownership model
  let st;
  // lstat, never stat: a symlink must be judged as itself. A symlink anywhere in
  // this chain is an attacker redirect, never something the design skill writes.
  try { st = fs.lstatSync(p); } catch { return false; }
  if (st.isSymbolicLink()) return false;
  if (wantDir ? !st.isDirectory() : !st.isFile()) return false;
  if (st.uid !== TRUST_UID) return false;
  return (st.mode & 0o022) === 0;           // no group / other write
}

// Returns null when the candidate is trustworthy, else the first path that is
// not — so the failure can name it.
function untrustedPath(bundled, version, nonce, dir, payload, helper) {
  const dirs = [bundled, path.join(bundled, version), path.join(bundled, version, nonce), dir];
  for (const d of dirs) if (!trustedEntry(d, true)) return d;
  if (!trustedEntry(payload, false)) return payload;
  if (!trustedEntry(helper, false)) return helper;
  return null;
}

// Compare two version strings ("2.1.263") numerically, descending.
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

function findCandidates() {
  const out = [];
  for (const bundled of BUNDLED_ROOTS) {
    for (const version of safeReaddir(bundled)) {
      const vDir = path.join(bundled, version);
      for (const nonce of safeReaddir(vDir)) {
        const dir = path.join(vDir, nonce, 'design');
        const payload = path.join(dir, PAYLOAD_FILE);
        const helper = path.join(dir, HELPER_FILE);
        if (!fs.existsSync(payload) || !fs.existsSync(helper)) continue;
        let mtime = 0;
        try { mtime = fs.statSync(payload).mtimeMs; } catch { continue; }
        // Evaluated here, carried on the record, ENFORCED in resolvePayload —
        // so the diagnostic path can still see and name what was refused.
        const untrusted = untrustedPath(bundled, version, nonce, dir, payload, helper);
        out.push({ version, nonce, dir, payload, helper, mtime, untrusted });
      }
    }
  }
  // Newest version wins; within a version, the most recently written nonce.
  out.sort((a, b) => cmpVersion(a.version, b.version) || b.mtime - a.mtime);
  return out;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function resolvePayload() {
  const candidates = findCandidates();
  const refused = [];
  for (const c of candidates) {
    // The ownership gate runs BEFORE any read of the candidate: this decides
    // whose code gets spawned and whose HTML gets mounted same-origin, so it
    // must not be reachable past a `continue` that a crafted file could trip.
    if (c.untrusted) { refused.push(c); continue; }
    try {
      // Sniff the marker in the first 64 KB — the file is 2.4 MB and nothing
      // here needs it in memory.
      const head = fs.readFileSync(c.payload).subarray(0, 65536).toString('utf8');
      if (!head.includes(TEMPLATE_MARKER)) continue;
      return {
        ok: true,
        ...c,
        payload_sha256: sha256File(c.payload),
        helper_sha256: sha256File(c.helper),
        others: candidates.length - 1,
        refused: refused.length,
      };
    } catch { continue; }
  }
  return {
    ok: false,
    reason: refused.length ? 'untrusted-candidate'
      : candidates.length ? 'no-valid-template' : 'not-materialised',
    searched: BUNDLED_ROOTS.join(' , '),
    // Non-empty only in the untrusted case; each entry is the FIRST path in that
    // candidate's chain that failed the gate.
    refused: refused.map((c) => c.untrusted),
    hint: 'Run `/design` once in Claude Code. The design skill materialises the canvas '
      + 'editor into the temp directory on first use; this pack reads that copy and '
      + 'never ships one of its own.',
  };
}

/* ------------------------------------------------------------------ *
 * 2. The helper's own grammars, mirrored
 *
 * KEEP IN SYNC with seed-canvas.mjs. These are used only to decide which files
 * in `dir` are worth handing to the helper at all. Artboards and canvas.json
 * are ALWAYS passed through even when the name looks wrong, so the helper's own
 * refusal (which names the file and the rule) is what the user sees — its
 * stderr is written to be read (CONTRACT §3, FINDINGS §2). Images are the
 * exception: they are incidental assets, and one stray photo dropped in the
 * folder must not take the whole canvas down, so an image the helper would
 * refuse is skipped and reported in `dsn_files.skipped` instead.
 * ------------------------------------------------------------------ */

const ARTBOARD_SUFFIX = '.dc.html';
const CANVAS_FILE = 'canvas.json';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg']);
const IMAGE_STEM_RE = /^[A-Za-z0-9_-][A-Za-z0-9 _.-]{0,80}$/;
const DOS_DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]) *(\.|$)/i;
// seed-canvas.mjs's --out gate, verbatim.
const OUT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.html$/;
const GENERIC_FILES = new Set([
  'your-file-name.html', 'canvas.html', 'design.html', 'design-canvas.html',
  'new-design.html', 'untitled.html', 'appifact.html', 'artifact.html',
  'output.html', 'out.html', 'index.html', 'page.html', 'main.html',
  'payload.template.html',
]);
// The editor's load-time limits: at most 200 files entries, 2 MiB per value.
const MAX_FILES = 200;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
// base64 inflates by 4/3, so a raw image over this cannot fit MAX_ENTRY_BYTES.
const MAX_IMAGE_BYTES = Math.floor(MAX_ENTRY_BYTES * 3 / 4);

// seed-canvas.mjs L48, verbatim. Two artboard tests live in this file and the
// difference is deliberate:
//   isArtboardName()      SUFFIX ONLY. Decides what to HAND the helper, so a
//                         badly-named artboard still reaches it and the user
//                         reads the helper's own refusal (§2 above).
//   HELPER_ARTBOARD_RE    the helper's real gate. Used only on the way BACK, in
//                         saveBack (§13b), where a name that came out of an
//                         --extract decides which of the user's files we are
//                         about to replace. There, loose is exactly wrong.
const HELPER_ARTBOARD_RE = /^[A-Za-z0-9_][A-Za-z0-9 _.-]{0,80}\.dc\.html$/;

function saneName(name) {
  return !name.includes('..') && !/[/\\]/.test(name) && !DOS_DEVICE_RE.test(name);
}
function isArtboardName(name) { return name.endsWith(ARTBOARD_SUFFIX); }
function isImageName(name) {
  const ext = path.extname(name).toLowerCase();
  return saneName(name) && IMAGE_EXT.has(ext) && IMAGE_STEM_RE.test(name.slice(0, -ext.length));
}

/* ------------------------------------------------------------------ *
 * 3. Tunables
 * ------------------------------------------------------------------ */

const DEBOUNCE_MS = 250;            // CONTRACT §6.3.6
const POLL_MS = 5000;               // control-key + self-heal fallback
const SEED_TIMEOUT_MS = 90000;
const MAX_CAPTURE_BYTES = 16384;    // per stream, on the child's stdio
const CARRIER_BASE = 'design-canvas-payload';
const CARRIER_RE = /^design-canvas-payload(-[0-9a-f]{8})?$/;
const CARRIER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BUILD_DIRNAME = '.wc-design-build';   // matches the pack's .gitignore

/* ── edit mode (§13b) ─────────────────────────────────────────────────────── */
const SAVE_PATH_PREFIX = '/save/';
const SAVE_TOKEN_BYTES = 32;        // 64 hex chars, fresh per spawn
// The body is the STATE BLOCK, not the 2.4 MB document (CONTRACT §6.6): measured
// at 19,777 bytes of a 2,495,380-byte page for the fixture. Images live in it as
// base64, though, and the editor's own load limits are 200 entries x 2 MiB, so
// the cap has to clear a real image-carrying canvas by a wide margin while still
// bounding what one POST can make this child buffer. 32 MiB is ~1,600x the
// measured block and ~10x any canvas that loads comfortably.
const SAVE_BODY_CAP = 32 * 1024 * 1024;
// CONTRACT §6.7. The window is CLOSED EARLY, the moment the deliberate
// post-save re-seed lands; this is only the hard bound for the case where that
// re-seed never gets there.
const SAVE_SUPPRESS_MS = 10000;

/* ------------------------------------------------------------------ *
 * 4. Module state
 * ------------------------------------------------------------------ */

let stopped = true;
let driver = null;
let logFn = null;
let mountId = null;
let paramsIn = null;

let webChatDir = null;
let componentsDir = null;
let buildRoot = null;       // <webChatDir>/.wc-design-build
let buildDir = null;        // <buildRoot>/<carrierName>
let carrierName = CARRIER_BASE;
let carrierDir = null;      // <componentsDir>/<carrierName>

let upstream = null;        // { version, payload_sha256 } once resolved
let payloadInfo = null;     // full resolvePayload() result

let dirAbs = null;          // the fenced, validated `dir`
let webChatDirParam = null; // ctx.webChatDir VERBATIM (null when unset) — §1.1
let degraded = false;       // a failure state is published; retry quietly
let title = '';
let outName = null;         // <slug>.html
let watchEnabled = true;

let seq = 0;
let lastPublished = null;   // the last dsn_canvas we wrote (for self-heal)
let lastFingerprint = null; // file-set fingerprint of the last successful seed
let planCache = null;       // the seeding plan (§8c) for planCacheKey
let planCacheKey = null;    // the listing fingerprint planCache was built from
let seededAt = null;
let seededBytes = null;
let seedWarnings = [];
let haveSeeded = false;

let watcher = null;
let debTimer = null;
let pollTimer = null;
let stream = null;
let chain = Promise.resolve();
let seedInFlight = false;
let reseedPending = false;
let forcePending = false;
let lastCtlSeq = -Infinity;
let child = null;

/* edit mode (§13b) */
let saveServer = null;      // the loopback listener
let saveSockets = new Set();
let savePort = null;
let saveToken = null;       // per-spawn, 64 hex
let saveUrl = null;         // http://127.0.0.1:<port>/save/<token>
let saveSeq = 0;            // counts completed save ATTEMPTS (not dsn_canvas.seq)
let lastSave = null;        // the published outcome of the last attempt
let pendingSaveReseed = false;      // the next publish is the post-save re-seed
let saveSuppressUntil = 0;          // §6.7 watcher-suppression window
let saveSuppressFiles = new Map();  // name -> {size, mtimeMs} as WE left it

function log(msg) { try { if (logFn) logFn('[design-canvas] ' + msg); } catch { /* ignore */ } }

/* ------------------------------------------------------------------ *
 * 5. The write fence — the enforcement half of §6.4
 * ------------------------------------------------------------------ */

function under(root, abs) {
  return !!root && (abs === root || abs.startsWith(root + path.sep));
}

// Every write in this file passes through here first. `dir` is never one of the
// roots, so no code path in this service can create, modify or delete a file
// under the user's working directory.
function assertWritable(p) {
  const abs = path.resolve(p);
  if (!under(buildRoot, abs) && !under(componentsDir, abs)) {
    throw new Error('design-canvas refused a write outside its build dir and the components dir: ' + abs);
  }
  if (dirAbs && under(dirAbs, abs)) {
    throw new Error('design-canvas refused a write inside the working directory: ' + abs);
  }
  return abs;
}

// The SECOND gate, and the whole of §6.4's licence. saveBack — and nothing else
// in this file — writes into `dir`, and only ever to a single file sitting
// directly in it, named by a basename that came out of the helper's own
// `--extract`. Everything this refuses is a bug in the caller, not a user error:
// a name with a separator or a `..` in it, an absolute path, an empty `dir`.
// Returns the absolute path to write, or throws.
function assertSaveTarget(name) {
  if (!dirAbs) throw new Error('design-canvas refused a save write with no working directory resolved');
  if (typeof name !== 'string' || !name || name.length > 200) {
    throw new Error('design-canvas refused a save write to an implausible name');
  }
  // Basenames only. `saneName` is the helper's own test (no `..`, no separator,
  // no DOS device); `path.basename` equality catches anything else it misses.
  if (!saneName(name) || path.basename(name) !== name || path.isAbsolute(name)) {
    throw new Error('design-canvas refused a save write to a name that is not a plain basename: ' + JSON.stringify(name.slice(0, 60)));
  }
  const abs = path.resolve(path.join(dirAbs, name));
  if (path.dirname(abs) !== dirAbs) {
    throw new Error('design-canvas refused a save write outside the working directory: ' + abs);
  }
  return abs;
}

// Write via a sibling temp + rename, so a reader (GET /api/components/:name)
// never sees a half-written 2.4 MB file.
function writeAtomic(target, data) {
  const abs = assertWritable(target);
  const tmp = assertWritable(abs + '.tmp-' + process.pid);
  fs.mkdirSync(assertWritable(path.dirname(abs)), { recursive: true });
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, abs);
  return abs;
}

/* ------------------------------------------------------------------ *
 * 6. Naming
 * ------------------------------------------------------------------ */

function shortHash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

// CONTRACT §2.1 names the carrier `design-canvas-payload`. That base name alone
// would make two design-canvas panes on one node clobber each other's 2.4 MB
// payload, so the mount id is folded in as a suffix — the pane never hardcodes
// the name, it reads `dsn_canvas.payload_component`. The name must satisfy
// lib/core/names.js COMPONENT_NAME_RE (`^[a-z][a-z0-9-]*$`); hex does.
function carrierNameFor(mid) {
  return mid ? `${CARRIER_BASE}-${shortHash(mid)}` : CARRIER_BASE;
}

// `--out` is CONTENT, not a temp name: the helper refuses a generic one
// (CONTRACT §6.3). Derive a slug from the title and re-check it against the
// helper's own two gates so we fail here, legibly, rather than in the child.
function slugFromTitle(t, salt) {
  const base = String(t == null ? '' : t)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  let name = base ? base + '.html' : '';
  if (!name || !OUT_NAME_RE.test(name) || GENERIC_FILES.has(name) || DOS_DEVICE_RE.test(name)) {
    const h = shortHash(String(t == null ? '' : t) + '|' + String(salt == null ? '' : salt));
    name = (base ? base.slice(0, 50).replace(/-+$/, '') + '-' : 'canvas-') + h + '.html';
  }
  return name;
}

/* ------------------------------------------------------------------ *
 * 7. Publishing
 * ------------------------------------------------------------------ */

function pushStore(patch) {
  if (stopped || !driver) return;
  // guardDriver (lib/driver.js:96) already keeps an unawaited rejection from
  // killing the child; this catch covers a synchronous throw.
  try { driver.setStore(patch); } catch (e) { log('setStore failed: ' + ((e && e.message) || e)); }
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length <= n ? str : str.slice(0, n) + '\n… (' + (str.length - n) + ' more characters)';
}

// `seq` is monotonic ACROSS RESTARTS, not merely within one run (CONTRACT §2.1),
// and starting a fresh child back at 1 is a SILENT failure, not a cosmetic one:
//
//   - the supervisor stops this child whenever the last browser stops watching
//     (lib/server/services.js:133 — `getViewers() < 1` makes `computeDesired`
//     return an empty map, and the WS client count is what feeds it:
//     lib/server/index.js:274 → ws.js:14-15 `onViewersChanged(clients.size)`),
//     and respawns it when one comes back;
//   - but the browser's reconnect handshake is
//     `applySnapshot(msg, { mode: 'reconcile' })` (public/app/ws.js:137), and a
//     reconcile deliberately does NOT re-mount a pane whose spec is unchanged
//     (public/app/mounts.js:746-751) — the pane script, and its own
//     strictly-increasing seq guard, survive the gap holding our OLD seq;
//   - so every publish from the new child (seq 1, 2, 3 …) is below the pane's
//     high-water mark and is dropped on arrival. The canvas keeps rendering the
//     stale document, file edits stop landing, and Reseed acknowledges and does
//     nothing — the pane looks perfectly healthy and is inert until a remount.
//
// So adopt whatever seq the store already carries as the floor before the first
// publish. Cheap (one GET), and failure is harmless: no store, no floor needed.
async function adoptSeqFloor() {
  let got = null;
  try { got = await driver.getStore(['dsn_canvas', 'dsn_files']); }
  catch { return; }                       // first mount, or no daemon yet: 0 is right
  for (const k of ['dsn_canvas', 'dsn_files']) {
    const v = got && got[k];
    if (!v || typeof v !== 'object') continue;
    if (typeof v.seq === 'number' && Number.isFinite(v.seq) && v.seq > seq) seq = v.seq;
  }
  if (seq) log('adopted seq floor ' + seq + ' from the store (a previous child of this pane)');
}

// dsn_canvas is the pane's whole world and is written in EVERY state,
// including failure (CONTRACT §2.1).
function publish(state, extra) {
  seq += 1;
  // §6.7. A save asks for exactly ONE deliberate re-seed, and the pane has to be
  // able to tell that re-seed apart from a file the user changed in an editor:
  // one is its own Save coming back and must not blow away the frame it was
  // typed in, the other is genuinely new content. So the publish that carries
  // the post-save re-seed stamps its own seq into last_save.reseed_seq, and the
  // pane's test is `canvas.seq === canvas.last_save.reseed_seq`.
  if (pendingSaveReseed) {
    pendingSaveReseed = false;
    if (lastSave) lastSave = Object.assign({}, lastSave, { reseed_seq: seq });
  }
  const canvas = Object.assign({
    seq,
    ok: state === 'ready' || state === 'seeding',
    state,
    payload_component: carrierName,
    title,
    artboards: [],
    seeded_at: seededAt,
    bytes: seededBytes,
    upstream,
    error: null,
    hint: null,
    // Additive (CONTRACT §2.1 does not close the shape): the helper's
    // exit-0 stderr, which is advisory rather than fatal and is worth showing,
    // plus this service's own notes about the frames it derived.
    warnings: seedWarnings,
    // Where the artboard layout came from, so the pane can explain itself
    // rather than presenting a derived frame as if the user had chosen it:
    //   'user'         canvas.json passed through exactly as written
    //   'user-filled'  their canvas.json, with keys they OMITTED filled in
    //   'synthesised'  no canvas.json on disk; this service generated one
    //   'none'         no manifest at all — the editor's 800x600 default
    //   null           no seed has happened yet (a failure state)
    layout: null,
    // [{file, w, h, source, expand}] — `source` is one of "canvas.json",
    // "$preview", "root-style", "wide-scan", "param", "default" or null.
    frames: [],
    // ADDITIVE, edit mode (§13b). Both are written in EVERY state for the same
    // reason the rest of this object is: the pane must never have to guess.
    //   save_endpoint  {url, token} — where the PANE (never the frame) posts a
    //                  handover; null when the listener could not be opened, and
    //                  the pane must then not offer editing chrome at all.
    //   last_save      the outcome of the last Save attempt, or null if none
    //                  has happened in this service's lifetime:
    //                  {seq, at, ok, written[], created[], unchanged[],
    //                   orphaned[], backup_dir, state_bytes, warnings[],
    //                   error, hint, reseed_seq}
    save_endpoint: saveEndpoint(),
    last_save: lastSave,
  }, extra || {});
  lastPublished = canvas;
  pushStore({ dsn_canvas: canvas });
  return canvas;
}

// Re-publish the LAST state with the current edit-mode fields folded in. Used
// by the save path, which changes `last_save` without changing anything the
// seeding pipeline computed — republishing through publish() would need a plan
// and a listing this caller does not have, and would risk reporting a state the
// service is not actually in.
function republishSave() {
  if (stopped || !lastPublished) return null;
  seq += 1;
  const next = Object.assign({}, lastPublished, {
    seq,
    save_endpoint: saveEndpoint(),
    last_save: lastSave,
  });
  lastPublished = next;
  pushStore({ dsn_canvas: next });
  return next;
}

// Paired with publish() by default, so both keys carry the same seq (CONTRACT
// §2.2's example shows them in lockstep). `bump:true` is for the one caller that
// publishes dsn_files ALONE — a `rescan` — so the pane can still see it changed.
function publishFiles(listing, { bump = false } = {}) {
  if (bump) seq += 1;
  const payload = {
    seq,
    dir: dirAbs || (paramsIn && typeof paramsIn.dir === 'string' ? paramsIn.dir : null),
    files: (listing && listing.files) || [],
    has_canvas_json: !!(listing && listing.hasCanvasJson),
  };
  // Additive: images the helper's own name/size gates would have refused, so
  // the pane can say why a file in the folder is not on the canvas.
  if (listing && listing.skipped && listing.skipped.length) payload.skipped = listing.skipped;
  pushStore({ dsn_files: payload });
}

/* ------------------------------------------------------------------ *
 * 8. Reading `dir` (read-only, always)
 * ------------------------------------------------------------------ */

function fenceInsideDir(name) {
  // Reuse the daemon's containment engine rather than hand-rolling a second
  // one: it refuses a lexical escape AND a symlink resolving out of the tree
  // (lib/core/paths.js fence / isInside).
  try { return fenceFn(dirAbs, name); } catch { return null; }
}

let fenceFn = null; // ctx.fence, captured in start()

function scanDir() {
  const files = [];
  const artboards = [];
  const images = [];
  const skipped = [];
  let canvasJson = null;

  let ents = [];
  try { ents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (e) {
    return { error: 'cannot read ' + dirAbs + ' (' + ((e && e.code) || e) + ')' };
  }

  for (const ent of ents) {
    const name = ent.name;
    if (!name || name.charAt(0) === '.') continue;
    const isArtboard = isArtboardName(name);
    const isCanvas = name === CANVAS_FILE;
    const looksImage = IMAGE_EXT.has(path.extname(name).toLowerCase());
    if (!isArtboard && !isCanvas && !looksImage) continue;

    // A symlink out of `dir` is refused before a single byte is read.
    const abs = fenceInsideDir(name);
    if (!abs) { skipped.push({ name, reason: 'resolves outside the working directory' }); continue; }

    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;

    const rec = { name, bytes: st.size, mtime: Math.round(st.mtimeMs || 0) };
    files.push(rec);

    if (isArtboard) { artboards.push({ name, abs }); continue; }
    if (isCanvas) { canvasJson = { name, abs }; continue; }
    // Images only: skip what the helper would fatally refuse (see §2 above).
    if (!isImageName(name)) { skipped.push({ name, reason: 'not a name the editor accepts for an image' }); continue; }
    if (st.size > MAX_IMAGE_BYTES) {
      skipped.push({ name, reason: 'over the editor\'s 2 MiB per-file limit as base64 — downsample it (aim for under ~70 KB)' });
      continue;
    }
    images.push({ name, abs });
  }

  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Main first, then alphabetical — the editor picks its entry artboard by
  // name, so this is presentation only, but it keeps argv stable between runs.
  artboards.sort((a, b) => {
    if (a.name === 'Main' + ARTBOARD_SUFFIX) return -1;
    if (b.name === 'Main' + ARTBOARD_SUFFIX) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  images.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // The editor loads at most 200 entries and silently drops the rest; drop the
  // overflow here instead, preferring artboards, and say so. One slot is always
  // reserved for a canvas.json, whether or not `dir` has one: when it does not,
  // this service generates one (§8b) and the seed would otherwise gain an entry
  // the budget never counted.
  let budget = MAX_FILES - 1 - artboards.length;
  while (images.length > Math.max(0, budget)) {
    const dropped = images.pop();
    skipped.push({ name: dropped.name, reason: 'over the editor\'s 200-entry limit' });
  }
  budget = null;

  return {
    files, artboards, images, canvasJson,
    hasCanvasJson: !!canvasJson,
    skipped,
    fingerprint: files.map((f) => f.name + ':' + f.bytes + ':' + f.mtime).join('|'),
  };
}

// dsn_canvas.artboards used to be derived here, straight off the user's
// canvas.json. It is now built by the seeding PLAN (§8c) instead, because what
// the pane must show is the layout the canvas was actually seeded with —
// including the frames this service derived — not just what is on disk.
// `userIndex()` in §8c is the direct descendant of the function that lived here.

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/* ------------------------------------------------------------------ *
 * 8b. Frame derivation — the generated canvas.json
 *
 * THE BUG THIS SECTION EXISTS FOR. With no canvas.json the editor frames EVERY
 * artboard at 800x600 and says nothing about it. Those are the payload's own
 * constants — one block in payload.template.html (2.1.263) reads
 *   var jT=800,GT=600,qSe=80,…,Tne=120,Pne=8e3,Cp=1e6
 * and the loader's normaliser applies them:
 *   LF(e) = { …, w: Rp(t(e.w, jT), Tne, Pne), h: Rp(t(e.h, GT), Tne, Pne) }
 * `t` substitutes the default for a non-number, `Rp` clamps — SILENTLY, and
 * seed-canvas.mjs's own `badNums` only reports a w/h that is PRESENT and
 * non-numeric, so a MISSING one is never mentioned by anybody. A 1288-wide
 * desktop design therefore gets an 800x600 frame, and both reported symptoms
 * follow from that single fact:
 *
 *   - "the page is shrunk"  — the un-focused canvas view always frames at w x h
 *     (`fullscreenBox` is null unless an artboard is focused) and opens at
 *     {x:-60,y:-80,scale:.5}, so a design is drawn into an 800x600 box and then
 *     halved. NO value of `expand` can fix this: `expand` is read in exactly one
 *     place (`MH = e => e?.expand !== "fill"`) and only when an artboard is
 *     focused/fullscreen. Only correct w/h fixes it.
 *   - "fill mode has a scrollbar but the wheel does nothing" — fill resizes the
 *     frame to the pane at scale 1 and the design clips, because the artboard
 *     document cannot scroll at all: support.js's boot() does
 *       if (!parsed.preview) inject "html,body{height:100%;margin:0}…"
 *     so an artboard with no `$preview` is PINNED to its frame. A wheel over it
 *     finds no scroller and chains out to the surface page — the scrollbar the
 *     user could drag was the surface's, not the canvas's.
 *
 * So the service derives a real frame per artboard and hands the helper a
 * canvas.json carrying it. Everything here is BOUNDED STRING PARSING over the
 * artboard source: the design is never executed, never fetched, never trusted
 * (CONTRACT §9.3). Caps are `MAX_SOURCE_SCAN` per file, `MAX_ATTR` per
 * attribute, and an iteration bound on the one global regex.
 *
 * The ladder, best signal first, per artboard:
 *   A  `$preview:{width,height}` in a data-props attribute — the format's own
 *      hint, and semantically load-bearing (see the FULL_PAGE_CSS note above).
 *   B  an explicit px box on the root element inside <x-dc>.
 *   C  the `frame_w` / `frame_h` params — the user's explicit override.
 *   B2 the widest declared px width anywhere (WEAK) — opt-in via `wide_scan`,
 *      and always labelled as weak in what we publish.
 *   D  the documented default, 1440x1024.
 * Height is biased up (`max(1024, w * 0.75)`) when only the width is known,
 * because an over-tall frame costs blank canvas while an under-tall one
 * destroys content — fit never scales UP (`Math.min(1, …)`), so over-tall is
 * cheap. That one number is a judgement call, not an observed constant.
 *
 * WHAT WE NEVER DO: write into `dir` (§6.4). The manifest is written to the
 * build dir and passed as `--canvas <buildDir>/canvas.json`. The user's folder
 * is not touched, and `payload.template.html` / `seed-canvas.mjs` are used 1:1.
 *
 * !! KEEP IN SYNC with seed-canvas.mjs — the key vocabularies and the rules
 * below are mirrored from it so we never emit something it would refuse. Every
 * canvas.json problem is FATAL at seed time (`fail('--canvas <p>: …')`).
 * ------------------------------------------------------------------ */

// Mirrored from the payload (2.1.263). Constants we OBSERVED, not upstream
// bytes: jT/GT are the frame defaults, qSe the 80px auto-append gap ($Se), and
// Tne/Pne the silent 120..8000 w/h clamp inside LF().
const EDITOR_GAP = 80;
const EDITOR_MIN_WH = 120;
const EDITOR_MAX_WH = 8000;
// Ours, used only when NOTHING is derivable. See the height-bias note above.
const FALLBACK_W = 1440;
const FALLBACK_H = 1024;

const MAX_SOURCE_SCAN = 512 * 1024;   // never regex more of an artboard than this
const MAX_ATTR = 64 * 1024;           // data-props / root open tag cap
const MAX_WIDTH_MATCHES = 5000;       // iteration bound on the wide scan

// seed-canvas.mjs L93-94, verbatim. The loader reads a CLOSED set at every
// level and the helper refuses anything else BY NAME, fatally.
const CANVAS_KEYS = ['artboards', 'annotations', 'launch', 'pages'];
const ARTBOARD_KEYS = ['file', 'x', 'y', 'w', 'h', 'title', 'expand', 'print', 'page', 'is_interactive'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (v) => isNum(v) && v > 0;
// Clamp ourselves so the value we store and the value the editor uses agree —
// LF() would clamp anyway, silently, and then our published `frames` would be
// describing a frame the canvas is not actually drawing.
const clampWH = (n) => Math.min(EDITOR_MAX_WH, Math.max(EDITOR_MIN_WH, Math.round(n)));

// A number from a param. Params can arrive from a spawn form as strings, so a
// numeric string is accepted; anything else (including NaN) is `null`, never
// coerced — a coerced NaN lands straight back on the editor's 800.
function posNum(v) {
  if (isPos(v)) return v;
  if (typeof v === 'string' && /^\s*\d{1,5}(?:\.\d+)?\s*$/.test(v)) {
    const n = Number(v);
    return isPos(n) ? n : null;
  }
  return null;
}

// Read at most `max` bytes of a file. Artboards can be 2 MiB each and there can
// be 200 of them; nothing here needs more than the head.
function readHead(abs, max) {
  let fd = null;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.allocUnsafe(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    // A cut multi-byte character at the boundary is harmless to every regex here.
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/* ── Rung A — $preview in data-props ──────────────────────────────────────── */
const DATA_PROPS_RE = /<script\b[^>]*?\bdata-props\s*=\s*(["'])([\s\S]*?)\1/i;

function unescapeAttr(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function rungPreview(src) {
  const m = DATA_PROPS_RE.exec(src);
  if (!m || m[2].length > MAX_ATTR) return null;
  let parsed;
  try { parsed = JSON.parse(unescapeAttr(m[2])); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed.$preview;
  // support.js accepts ANY object as $preview and only tests its presence; the
  // numbers inside it are ours to validate.
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const w = isPos(p.width) ? p.width : null;
  const h = isPos(p.height) ? p.height : null;
  if (w === null && h === null) return null;
  return { w, h };
}

/* ── Rung B — an explicit px box on the root element inside <x-dc> ─────────── */
const HELMET_RE = /<helmet\b[\s\S]*?<\/helmet\s*>/i;
const OPEN_TAG_RE = /<([a-zA-Z][\w-]*)\b([^>]*)>/;
const STYLE_ATTR_RE = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i;

function rootOpenTag(src) {
  const i = src.search(/<x-dc\b[^>]*>/i);
  if (i === -1) return null;
  let rest = src.slice(i).replace(/^<x-dc\b[^>]*>/i, '');
  rest = rest.replace(HELMET_RE, '');
  rest = rest.replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/, '');
  const m = OPEN_TAG_RE.exec(rest.slice(0, MAX_ATTR));
  return m ? { tag: m[1], attrs: m[2] } : null;
}

// One declaration out of an inline style. A value carrying a `{{ }}` template
// hole is REFUSED, never coerced — the helper warns about holes in style
// attributes for exactly this reason, and a NaN here would silently become 800.
function pxDecl(style, prop) {
  const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]{0,120})', 'i').exec(style);
  if (!m) return null;
  const v = m[1].trim();
  if (v.includes('{{') || v.includes('}}')) return null;
  const n = /^(\d{1,5}(?:\.\d+)?)px$/i.exec(v);
  return n ? parseFloat(n[1]) : null;
}

function rungRootBox(src) {
  const root = rootOpenTag(src);
  if (!root) return null;
  const sm = STYLE_ATTR_RE.exec(root.attrs);
  if (!sm) return { tag: root.tag, w: null, h: null };
  const style = unescapeAttr(sm[2]);
  const w = pxDecl(style, 'width') || pxDecl(style, 'max-width') || pxDecl(style, 'min-width');
  const h = pxDecl(style, 'height') || pxDecl(style, 'min-height') || pxDecl(style, 'max-height');
  return { tag: root.tag, w: isPos(w) ? w : null, h: isPos(h) ? h : null };
}

/* ── Rung B2 — the widest declared px width anywhere (WEAK, opt-in) ────────── */
const ANY_WIDTH_RE = /(?:max-width|width)\s*:\s*(\d{3,5})px/gi;

function rungWidestDeclared(src) {
  let best = null;
  let n = 0;
  ANY_WIDTH_RE.lastIndex = 0;
  for (let m; (m = ANY_WIDTH_RE.exec(src)) && n < MAX_WIDTH_MATCHES; n++) {
    const v = parseInt(m[1], 10);
    if (v >= 320 && v <= EDITOR_MAX_WH && (best === null || v > best)) best = v;
  }
  return best;
}

/* ── Scroll / fluidity signals — these decide `expand`, never the size ─────── */
function scrollSignals(src) {
  return {
    own_scroller: /overflow(?:-y)?\s*:\s*(?:auto|scroll)/i.test(src),
    // The payload styles a declared canvas surface `html[data-dc-canvas]{overflow:hidden}`,
    // i.e. it OWNS its viewport — exactly the fluid case fill is for.
    dc_canvas: /\bdata-dc-canvas\b/i.test(src),
  };
}

// Derive one artboard's frame. `src` is the (bounded) head of its source.
function deriveFrame(file, src, opts) {
  const o = opts || {};
  const hay = String(src == null ? '' : src).slice(0, MAX_SOURCE_SCAN);
  const preview = rungPreview(hay);
  const root = rungRootBox(hay);
  const widest = rungWidestDeclared(hay);
  const sig = scrollSignals(hay);

  let w = null;
  let h = null;
  let wSrc = null;
  let hSrc = null;

  // A: the author's own declaration.
  if (preview && preview.w) { w = preview.w; wSrc = '$preview'; }
  if (preview && preview.h) { h = preview.h; hSrc = '$preview'; }
  // B: an explicit px box on the root element.
  if (w === null && root && root.w) { w = root.w; wSrc = 'root-style'; }
  if (h === null && root && root.h) { h = root.h; hSrc = 'root-style'; }
  // C: the params. Below the two declarations on purpose — an artboard that
  // states its own size is stating a fact, and a blanket param is a guess for
  // the artboards that state nothing.
  if (w === null && isPos(o.frameW)) { w = o.frameW; wSrc = 'param'; }
  if (h === null && isPos(o.frameH)) { h = o.frameH; hSrc = 'param'; }
  // B2: the weak scan, only when asked for.
  if (w === null && o.wideScan && widest) { w = widest; wSrc = 'wide-scan'; }
  // D: the documented default.
  if (w === null) { w = FALLBACK_W; wSrc = 'default'; }
  if (h === null) { h = Math.max(FALLBACK_H, Math.round(w * 0.75)); hSrc = 'default'; }

  // `expand` — per artboard, from the same evidence that decided the size.
  // fill resizes the frame to the pane at scale 1 and shows whatever fits, so
  // it is right ONLY for a design that is fluid AND can scroll. An artboard
  // with no $preview cannot scroll (FULL_PAGE_CSS pins html/body to the frame),
  // so for it fill CLIPS — which is precisely the reported symptom 2.
  let expand = 'fit';
  let expandWhy;
  if (o.expand === 'fit' || o.expand === 'fill') {
    expand = o.expand;
    expandWhy = 'the `expand` param says ' + o.expand;
  } else if (wSrc === 'default' && (sig.own_scroller || sig.dc_canvas)) {
    expand = 'fill';
    expandWhy = 'no intrinsic width, and the design '
      + (sig.dc_canvas ? 'declares its own canvas surface' : 'has its own scroll container');
  } else if (wSrc === 'default') {
    expandWhy = 'no intrinsic width and no scroll container — fill would clip it permanently';
  } else {
    expandWhy = 'the frame is a definite box (' + wSrc + '), so fit shows all of it';
  }

  return {
    file,
    w: clampWH(w),
    h: clampWH(h),
    w_source: wSrc,
    h_source: hSrc,
    expand,
    expand_why: expandWhy,
    widest_px: widest,
    // What decides scrollability, and therefore whether fill is survivable.
    can_scroll: !!(preview || sig.own_scroller || sig.dc_canvas),
  };
}

// The published per-artboard record (CONTRACT §2.1 `artboards`, extended).
function entryOf(file, box, frame, sources) {
  return {
    file,
    x: num(box.x),
    y: num(box.y),
    w: num(box.w),
    h: num(box.h),
    w_source: sources.w,
    h_source: sources.h,
    expand: typeof box.expand === 'string' ? box.expand : (sources.w ? 'fit' : null),
    widest_px: frame ? frame.widest_px : null,
    can_scroll: frame ? frame.can_scroll : null,
  };
}

// The editor's own auto-append origin, mirrored: $Se(e) = {x: max(x+w)+80,
// y: min(y)}. Used both to lay out a generated manifest and to place an entry
// whose position the user omitted, so a filled entry never lands on top of one
// they positioned themselves.
function appendOrigin(boxes) {
  if (!boxes.length) return { x: 0, y: 0 };
  let right = -Infinity;
  let top = Infinity;
  for (const b of boxes) { right = Math.max(right, b.x + b.w); top = Math.min(top, b.y); }
  return { x: right + EDITOR_GAP, y: top };
}

// SYNTHESIS: no canvas.json on disk, so build the whole manifest.
// Every .dc.html gets an entry — an unlisted artboard is appended by the
// loader's Kv() at the 800x600 default, so a partially-listed manifest would
// leave the bug alive for whatever it left out. x/y are ALWAYS emitted beside
// w/h: the helper's overlap scan only looks at entries where all four are
// numbers, so w/h alone stacks every frame at 0,0 and nothing warns.
function buildManifest(frames) {
  const artboards = [];
  const entries = [];
  const boxes = [];
  for (const f of frames) {
    const at = appendOrigin(boxes);
    const e = { file: f.file, x: at.x, y: 0, w: f.w, h: f.h };
    // "fit" is the default and `LF` stores only "fill", so writing "fit" is
    // legal but identical to omitting it. Omit it — fewer keys, same canvas.
    if (f.expand === 'fill') e.expand = 'fill';
    artboards.push(e);
    boxes.push({ x: e.x, y: e.y, w: e.w, h: e.h });
    entries.push(entryOf(f.file, e, f, { w: f.w_source, h: f.h_source }));
  }
  const manifest = { artboards };
  // A single-artboard canvas opens on the artboard rather than on the canvas at
  // scale .5 — which is most of the felt "shrunk". Strictly validated by the
  // helper: `file` must be a listed artboard and a focused launch carries no
  // `page`. Multi-artboard canvases keep the default launch.
  if (artboards.length === 1) manifest.launch = { view: 'focused', file: artboards[0].file };
  return { manifest, entries };
}

// RESPECT: the user has a canvas.json. THEIR VALUES ALWAYS WIN — nothing here
// ever rewrites a key they set. We only ADD keys they left `undefined`, and
// only to entries naming an artboard that is actually present:
//   - a missing w/h  (the silent 800x600, the whole bug)
//   - a missing x/y  ALONGSIDE a w/h we filled, because an entry with w/h and
//     no x/y is skipped by the overlap scan and then stacked at 0,0 by LF()
//   - a missing expand, and then only when the size was ours to derive (an
//     entry whose w THEY set is a box they chose; fit shows all of it), or
//     when the `expand` param explicitly asks for fill everywhere.
// A key they wrote — including a deliberately wrong one — is passed through
// untouched, so the helper's own refusal still names the value they wrote.
function fillManifest(user, derivedByFile, present) {
  const src = Array.isArray(user.artboards) ? user.artboards : [];
  const artboards = [];
  const entries = [];
  const boxes = [];
  let filled = false;

  // Everything the user positioned, first: the append origin must clear it.
  for (const a of src) {
    if (a && typeof a === 'object' && ['x', 'y', 'w', 'h'].every((k) => isNum(a[k]))) {
      boxes.push({ x: a.x, y: a.y, w: a.w, h: a.h });
    }
  }

  for (const a of src) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) { artboards.push(a); continue; }
    const e = Object.assign({}, a);
    const file = typeof a.file === 'string' ? a.file : null;
    const frame = file && present.includes(file) ? derivedByFile.get(file) : null;
    const sources = { w: isNum(a.w) ? 'canvas.json' : null, h: isNum(a.h) ? 'canvas.json' : null };
    const userGaveW = a.w !== undefined;

    if (frame) {
      if (e.w === undefined) { e.w = frame.w; sources.w = frame.w_source; filled = true; }
      if (e.h === undefined) { e.h = frame.h; sources.h = frame.h_source; filled = true; }
      if (isNum(e.w) && isNum(e.h) && (e.x === undefined || e.y === undefined)) {
        const at = appendOrigin(boxes);
        if (e.x === undefined) { e.x = at.x; filled = true; }
        if (e.y === undefined) { e.y = at.y; filled = true; }
      }
      const wantFill = paramExpand() === 'fill'
        || (paramExpand() === 'auto' && !userGaveW && frame.expand === 'fill');
      if (e.expand === undefined && wantFill) { e.expand = 'fill'; filled = true; }
    }

    if (isNum(e.x) && isNum(e.y) && isNum(e.w) && isNum(e.h)) boxes.push({ x: e.x, y: e.y, w: e.w, h: e.h });
    artboards.push(e);
    if (file) entries.push(entryOf(file, e, frame, sources));
  }

  // Unlisted artboards keep the loader's own behaviour (appended at the
  // default) — filling in a manifest is a repair, not a rewrite, and adding
  // entries the user did not write is the rewrite half.
  for (const name of present) {
    if (entries.some((e) => e.file === name)) continue;
    entries.push(entryOf(name, {}, null, { w: null, h: null }));
  }

  const manifest = Object.assign({}, user, { artboards });
  return { manifest, entries, filled };
}

// Our mirror of the helper's canvas.json gates, restricted to the ones that are
// FATAL at seed time and that we can judge cheaply. Two uses, both defensive:
//   - on a manifest WE generated: if it fails, do not pass it at all;
//   - on the user's manifest: any problem here means we do NOT gap-fill it but
//     pass THEIR path verbatim, so the helper's fatal `--canvas <path>: …`
//     names their file rather than a build-dir temp. (Anything this mirror
//     misses is caught by the fallback attempt in seedNow, which re-runs with
//     their own file for exactly the same reason.)
function manifestProblems(manifest, present) {
  const out = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['not an object'];
  for (const k of Object.keys(manifest)) if (!CANVAS_KEYS.includes(k)) out.push('top-level key "' + k.slice(0, 40) + '"');
  if (!Array.isArray(manifest.artboards)) return out.concat('"artboards" is not an array');
  const seen = new Set();
  for (const a of manifest.artboards) {
    if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.file !== 'string') { out.push('an entry is not an object with a "file" string'); continue; }
    const f = a.file.slice(0, 60);
    if (!present.includes(a.file)) out.push('entry "' + f + '" is not one of the .dc.html files');
    else if (seen.has(a.file)) out.push('entry "' + f + '" is listed twice');
    seen.add(a.file);
    for (const k of Object.keys(a)) if (!ARTBOARD_KEYS.includes(k)) out.push('"' + f + '" has a key the editor never reads: "' + k.slice(0, 40) + '"');
    for (const k of ['x', 'y', 'w', 'h']) if (a[k] !== undefined && !isNum(a[k])) out.push('"' + f + '" has non-numeric ' + k);
    if (a.w !== undefined && isNum(a.w) && (a.w < EDITOR_MIN_WH || a.w > EDITOR_MAX_WH)) out.push('"' + f + '" w is outside the editor\'s silent 120..8000 clamp');
    if (a.h !== undefined && isNum(a.h) && (a.h < EDITOR_MIN_WH || a.h > EDITOR_MAX_WH)) out.push('"' + f + '" h is outside the editor\'s silent 120..8000 clamp');
    if (a.expand !== undefined && a.expand !== 'fit' && a.expand !== 'fill') out.push('"' + f + '" has an expand that is neither "fit" nor "fill"');
    if (a.print !== undefined && a.print !== 'fixed' && a.print !== 'flow') out.push('"' + f + '" has a print that is neither "fixed" nor "flow"');
    if (a.is_interactive !== undefined && typeof a.is_interactive !== 'boolean') out.push('"' + f + '" has a non-boolean is_interactive');
    if (a.title !== undefined && (typeof a.title !== 'string' || !a.title.trim() || a.title.trim().length > 120)) out.push('"' + f + '" has a title the editor would drop or cut');
  }
  // The helper's own overlap advice, mirrored: it only warns, but a generated
  // layout that overlaps is our bug, not the user's.
  const bs = manifest.artboards.filter((a) => a && typeof a === 'object' && ['x', 'y', 'w', 'h'].every((k) => isNum(a[k])));
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i];
      const b = bs[j];
      if (a.page !== b.page) continue;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        out.push('"' + String(a.file).slice(0, 60) + '" and "' + String(b.file).slice(0, 60) + '" overlap');
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 8c. The seeding plan — which canvas.json (if any) this seed passes
 *
 * An "attempt" is one `--canvas` choice plus the artboard view the pane would
 * see if it succeeds. The first is what we want; the second, when present, is
 * the STATUS QUO ANTE — the user's own file, or no manifest at all. A generated
 * manifest can therefore never turn a canvas that used to seed into a
 * `seed-failed`: if the helper refuses ours, seedNow falls back and says so.
 * ------------------------------------------------------------------ */

function paramExpand() {
  const v = paramsIn && paramsIn.expand;
  return v === 'fit' || v === 'fill' ? v : 'auto';
}

function frameOpts() {
  return {
    frameW: posNum(paramsIn && paramsIn.frame_w),
    frameH: posNum(paramsIn && paramsIn.frame_h),
    wideScan: !!(paramsIn && paramsIn.wide_scan === true),
    expand: paramExpand(),
  };
}

// One entry per .dc.html with x/y/w/h null — what dsn_canvas.artboards carried
// before this section existed, and what it still carries when no manifest is in
// play. The pane must tolerate nulls (CONTRACT §2.1).
function plainIndex(listing) {
  return listing.artboards.map((a) => entryOf(a.name, {}, null, { w: null, h: null }));
}

// The user's canvas.json as the pane should see it, with nothing derived.
function userIndex(manifest, listing) {
  const present = listing.artboards.map((a) => a.name);
  const out = [];
  const seen = new Set();
  const entries = manifest && Array.isArray(manifest.artboards) ? manifest.artboards : [];
  for (const a of entries.slice(0, MAX_FILES)) {
    if (!a || typeof a !== 'object') continue;
    const file = typeof a.file === 'string' ? a.file : null;
    if (!file || !present.includes(file) || seen.has(file)) continue;
    seen.add(file);
    out.push(entryOf(file, a, null, { w: isNum(a.w) ? 'canvas.json' : null, h: isNum(a.h) ? 'canvas.json' : null }));
  }
  for (const name of present) if (!seen.has(name)) out.push(entryOf(name, {}, null, { w: null, h: null }));
  return out;
}

function readUserManifest(listing) {
  if (!listing.canvasJson) return null;
  try { return JSON.parse(readHead(listing.canvasJson.abs, MAX_ENTRY_BYTES)); } catch { return null; }
}

function planAttempts(listing) {
  const present = listing.artboards.map((a) => a.name);
  const notes = [];
  const genPath = path.join(buildDir, CANVAS_FILE);
  const noManifest = { canvasArg: null, layout: 'none', artboards: plainIndex(listing), manifestJson: null };

  // The editor loads at most 200 files entries and the helper refuses a 201st;
  // a manifest costs one. scanDir() reserves that slot by trimming images, but
  // artboards alone can fill it, and then there is no room for a canvas.json.
  const roomForManifest = present.length + listing.images.length + 1 <= MAX_FILES;

  const derived = new Map();
  for (const a of listing.artboards) {
    derived.set(a.name, deriveFrame(a.name, readHead(a.abs, MAX_SOURCE_SCAN), frameOpts()));
  }

  /* ---- no canvas.json on disk: synthesise one ---- */
  if (!listing.canvasJson) {
    if (!roomForManifest) {
      notes.push('too many files to add a canvas.json (the editor loads at most ' + MAX_FILES
        + ' entries), so every artboard keeps the editor\'s 800x600 default frame');
      return { attempts: [noManifest], notes };
    }
    const built = buildManifest(present.map((f) => derived.get(f)));
    const problems = manifestProblems(built.manifest, present);
    if (problems.length) {
      notes.push('the generated canvas.json failed its own check (' + problems[0]
        + '), so it was not used and the artboards keep the editor\'s 800x600 default frame');
      return { attempts: [noManifest], notes };
    }
    return {
      attempts: [
        { canvasArg: genPath, layout: 'synthesised', artboards: built.entries, manifestJson: JSON.stringify(built.manifest, null, 2) },
        noManifest,
      ],
      notes,
    };
  }

  /* ---- the user has one: it wins ---- */
  const user = readUserManifest(listing);
  const verbatim = {
    canvasArg: listing.canvasJson.abs,
    layout: 'user',
    artboards: userIndex(user, listing),
    manifestJson: null,
  };
  if (!user || typeof user !== 'object' || Array.isArray(user) || !Array.isArray(user.artboards)) {
    // Unreadable or the wrong shape: hand it to the helper untouched, whose
    // refusal names their file and the rule it broke.
    return { attempts: [verbatim], notes };
  }
  if (manifestProblems(user, present).length || !roomForManifest) {
    return { attempts: [verbatim], notes };
  }
  const gap = fillManifest(user, derived, present);
  if (!gap.filled) return { attempts: [verbatim], notes };
  const problems = manifestProblems(gap.manifest, present);
  if (problems.length) {
    notes.push('could not fill in the missing frame sizes (' + problems[0] + '); canvas.json was used as written');
    return { attempts: [verbatim], notes };
  }
  return {
    attempts: [
      { canvasArg: genPath, layout: 'user-filled', artboards: gap.entries, manifestJson: JSON.stringify(gap.manifest, null, 2) },
      verbatim,
    ],
    notes,
  };
}

// The plan depends only on the files (their content decides every rung) and on
// params, which are fixed for the life of the service — so cache it on the same
// fingerprint scanDir() already computes. `used` records which attempt actually
// seeded, so the unchanged-files short circuit republishes the right view.
function planFor(listing) {
  if (planCache && planCacheKey === listing.fingerprint) return planCache;
  planCache = planAttempts(listing);
  planCache.used = 0;
  planCacheKey = listing.fingerprint;
  return planCache;
}

// What an attempt contributes to dsn_canvas (CONTRACT §2.1).
function viewOf(att) {
  return {
    artboards: att.artboards,
    layout: att.layout,
    // A flat digest of the same rows, in the shape the pane's "where did this
    // size come from" line reads. `widest_px` is what the weak wide-scan rung
    // WOULD have found, reported whether or not `wide_scan` let it be used, so
    // the pane can offer it rather than the user having to guess it exists.
    frames: att.artboards.map((a) => ({
      file: a.file,
      w: a.w,
      h: a.h,
      source: a.w_source,
      expand: a.expand,
      widest_px: a.widest_px,
      can_scroll: a.can_scroll,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 9. Seeding
 * ------------------------------------------------------------------ */

// CONTRACT §6.3.3 / FINDINGS §2. Two rules the helper's hand-rolled parser
// forces on any caller:
//
//  1. NEVER a flag in FINAL argv position. `args()` scans
//     `for (let i = 0; i < process.argv.length - 1; i++)`, so a flag that is
//     the last token contributes no value and READS AS ABSENT — a trailing
//     `--title` makes the helper say "need --template, --out, --title …" and
//     exit 1, with no hint that the value was simply never seen. Every push
//     below is a flag/value PAIR, and `--artboard` (whose values are absolute
//     paths and so can never begin with `--`) goes last, so the final token is
//     always a value. The assertion below makes that structural.
//  2. No `=` form, no short flags, no `--` terminator; repeated single-valued
//     flags are last-wins, and `--artboard`/`--image` are repeatable with order
//     preserved.
//
// `canvasPath` selects the `--canvas` manifest: a path (the user's own file, or
// the one this service generated into the build dir — §8c), or `null` for no
// manifest at all. Omitting the argument falls back to whatever is in `dir`,
// which is what the tests and the pre-derivation code path expect.
function buildArgv(helper, payload, outFile, listing, canvasPath) {
  // Built as PAIRS, never as a flat list, so the structure itself carries the
  // rule: a flag is only ever emitted together with its value, and the final
  // token is therefore always a value slot. Note the test that must NOT be
  // written here — "does the last token start with `--`". A title may legally
  // begin with `--` (the helper's title gate refuses only < > & " backslash and
  // control characters), and such a value IS read correctly, because the scan
  // bound `i < argv.length - 1` only ever loses the value of a flag that has
  // none after it. Verified against the real helper with --title '--force'.
  const pairs = [
    ['--template', payload],
    ['--out', outFile],
    // Passed through verbatim even when empty or generic: the helper owns the
    // title gate and its refusal is the message the user should read.
    ['--title', String(title)],
  ];
  const canvasArg = canvasPath === undefined
    ? (listing.canvasJson ? listing.canvasJson.abs : null)
    : canvasPath;
  if (canvasArg) pairs.push(['--canvas', canvasArg]);
  for (const img of listing.images) pairs.push(['--image', img.abs]);
  // LAST: artboard values are absolute paths, the least surprising thing to
  // find in final argv position, and their order is preserved by the helper.
  for (const ab of listing.artboards) pairs.push(['--artboard', ab.abs]);

  const argv = [helper];
  for (const [flag, value] of pairs) {
    if (typeof value !== 'string') {
      throw new Error('internal: refusing to spawn seed-canvas.mjs with a valueless ' + flag
        + ' — a flag in final argv position reads as ABSENT (FINDINGS §2)');
    }
    argv.push(flag, value);
  }
  if (argv.length !== 1 + pairs.length * 2) {
    throw new Error('internal: seed-canvas.mjs argv is not flag/value pairs');
  }
  return argv;
}

function runHelper(argv) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    let proc;
    try {
      proc = spawn(process.execPath, argv, {
        // cwd is the BUILD dir, never `dir`: belt-and-braces so even a relative
        // write inside the child could not land in the user's files.
        cwd: buildDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: 'cannot spawn ' + process.execPath + ': ' + ((e && e.message) || e) });
      return;
    }
    child = proc;

    const cap = (buf, add) => (buf.length >= MAX_CAPTURE_BYTES ? buf : buf + add);
    proc.stdout.on('data', (d) => { out = cap(out, d.toString('utf8')); });
    proc.stderr.on('data', (d) => { err = cap(err, d.toString('utf8')); });

    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child === proc) child = null;
      resolve(r);
    };

    timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      done({ code: -1, stdout: out, stderr: err || ('seed-canvas.mjs did not finish within ' + Math.round(SEED_TIMEOUT_MS / 1000) + 's') });
    }, SEED_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    proc.on('error', (e) => done({ code: -1, stdout: out, stderr: err || String((e && e.message) || e) }));
    proc.on('close', (code) => done({ code: code == null ? -1 : code, stdout: out, stderr: err }));
  });
}

// Read the seeded page's state block the way the helper's own recognizer does,
// rather than regexing the whole 2.4 MB file for `"store":"db"` — a whole-file
// scan can false-positive on the editor's own minified JS, and a false
// `live-store` would refuse a canvas that is perfectly fine. Exactly one
// server-added attribute is tolerated: a 16-char `data-id` that may not start
// with `-` or contain `--` (FINDINGS §2). KEEP IN SYNC with seed-canvas.mjs.
const DOC_OPEN_RE = /<script type="application\/json" id="appifact-doc"(?: data-id="(?!-)(?:(?!--)[A-Za-z0-9_-]){16}")?>\n/;
function readStateBlock(page) {
  const m = page.match(DOC_OPEN_RE);
  if (!m) return { ok: false, reason: 'no state block opener' };
  const start = m.index + m[0].length;
  // The serialiser escapes every "<" inside the block, so the first literal
  // newline + closer after the opener is the block's own.
  const end = page.indexOf('\n</script>', start);
  if (end === -1) return { ok: false, reason: 'unterminated state block' };
  try { return { ok: true, state: JSON.parse(page.slice(start, end)) }; }
  catch (e) { return { ok: false, reason: 'state block does not parse: ' + String((e && e.message) || e).slice(0, 120) }; }
}

// Diagnostics: everything goes to stderr, `design canvas: ` for fatal and
// `design canvas: warning — ` for advisory; only the one-line success summary
// goes to stdout (FINDINGS §2).
function splitWarnings(stderr) {
  return String(stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^design canvas: warning — /, '').replace(/^design canvas: /, ''));
}

// `force` skips the unchanged-files short circuit. The watcher never forces —
// that short circuit is what keeps a burst of save events from becoming a
// re-seed storm — but an explicit `dsn_ctl {op:'reseed'}` MUST genuinely re-run
// the helper (CONTRACT §2.3: "Re-run the helper against the current files"),
// because the user reaches for it precisely when the canvas looks wrong.
async function seedNow(force) {
  if (stopped) return;

  const listing = scanDir();
  if (listing.error) {
    publish('bad-dir', { ok: false, warnings: [], error: listing.error, hint: 'Check that ' + dirAbs + ' still exists and is readable.' });
    publishFiles(null);
    return;
  }
  if (!listing.artboards.length) {
    publish('bad-dir', {
      ok: false,
      warnings: [],
      error: dirAbs + ' contains no <Name>.dc.html artboard.',
      hint: 'Put at least one artboard named like `Main.dc.html` in ' + dirAbs + '. `canvas.json` and images are optional.',
    });
    publishFiles(listing);
    return;
  }

  // Which canvas.json this seed will pass, and the artboard view that goes with
  // it (§8c). Cached on the listing fingerprint, so the short circuit below and
  // the `seeding` publish cost one plan, not three.
  const plan = planFor(listing);

  // Nothing on disk changed since the last successful seed — the carrier is
  // still correct. This is what stops a burst of fs.watch events (an editor
  // writing a file three times per save) from becoming a re-seed storm.
  if (!force && haveSeeded && lastFingerprint === listing.fingerprint && fs.existsSync(path.join(carrierDir, 'component.html'))) {
    // The attempt that actually seeded, not necessarily the preferred one.
    publish('ready', viewOf(plan.attempts[plan.used] || plan.attempts[0]));
    publishFiles(listing);
    return;
  }

  if (!haveSeeded) {
    publish('seeding', viewOf(plan.attempts[0]));
    publishFiles(listing);
  }

  // The helper's ONE write in seeding mode. Asserted before the child is
  // spawned, so §6.4 holds for the child's write as well as for ours.
  const outFile = assertWritable(path.join(buildDir, outName));
  try { fs.mkdirSync(assertWritable(buildDir), { recursive: true }); } catch { /* reported below */ }
  // Seed mode writes --out without the `wx` flag, so a stale output from a
  // previous run is simply replaced rather than refused.

  /* ---- run the plan ----------------------------------------------------
   * Attempt 0 is the manifest we want. When it is one WE built, attempt 1 is
   * the status quo ante — the user's own canvas.json, or no `--canvas` at all.
   * So a manifest this pack generated can never turn a canvas that used to seed
   * into a `seed-failed`: if the helper refuses ours, the canvas still comes up
   * and `warnings` says what was dropped. And because the fallback re-runs
   * against the USER'S file, the stderr behind a real failure still names their
   * path and their rule, which is what the `seed-failed` hint shows (§3). */
  let res = null;
  let att = plan.attempts[0];
  const refused = [];
  for (let i = 0; i < plan.attempts.length; i++) {
    att = plan.attempts[i];
    const last = i === plan.attempts.length - 1;
    // A re-seed against the same files must not pay for a manifest the helper
    // has already refused once — that would be a second 2.4 MB spawn per
    // reseed, forever. The mark lives on the cached plan, so it is forgotten
    // the moment anything on disk changes; the note it carries is re-published
    // each time, so the explanation does not evaporate on the second seed.
    if (att.refused && !last) { if (att.refused_note) refused.push(att.refused_note); continue; }

    if (att.manifestJson) {
      // Into the BUILD dir, through assertWritable, which refuses any path
      // under `dir` — the user's folder is never touched (§6.4).
      try {
        writeAtomic(path.join(buildDir, CANVAS_FILE), att.manifestJson);
      } catch (e) {
        const why = 'could not write the generated canvas.json: ' + String((e && e.message) || e);
        if (!last) { refused.push(why); log(why); continue; }
        publish('seed-failed', Object.assign(viewOf(att), {
          ok: false, warnings: refused, error: why, hint: 'Check that ' + buildDir + ' is writable.',
        }));
        publishFiles(listing);
        return;
      }
    }

    let argv;
    try { argv = buildArgv(payloadInfo.helper, payloadInfo.payload, outFile, listing, att.canvasArg); } catch (e) {
      publish('seed-failed', { ok: false, warnings: [], error: 'could not build the seeding command', hint: String((e && e.message) || e) });
      publishFiles(listing);
      return;
    }

    res = await runHelper(argv);
    if (stopped) return;
    if (res.code === 0) { plan.used = i; break; }
    if (!last) {
      att.refused = true;
      const head = splitWarnings(res.stderr)[0] || ('seed-canvas.mjs exited ' + res.code);
      const next = plan.attempts[i + 1];
      att.refused_note = 'seed-canvas.mjs refused the canvas layout this pack derived — ' + truncate(head, 400)
        + '. It was dropped and the seed retried with '
        + (next.layout === 'user' ? 'the canvas.json in your folder, as written'
          : 'no canvas.json, so the artboards keep the editor\'s 800x600 default frame')
        + '.';
      refused.push(att.refused_note);
      log('attempt ' + i + ' (' + att.layout + ') refused: ' + head);
    }
  }

  if (!res) {
    publish('seed-failed', Object.assign(viewOf(att), {
      ok: false, warnings: [], error: 'the seeding command never ran.', hint: refused.join('\n') || 'No attempt could be prepared.',
    }));
    publishFiles(listing);
    return;
  }

  const view = viewOf(att);

  if (res.code !== 0) {
    // CONTRACT §3: the hint is the helper's stderr, VERBATIM — it is written to
    // be read. Only an absurd volume is capped, and the cap says so.
    publish('seed-failed', Object.assign({}, view, {
      ok: false,
      warnings: refused,
      error: 'seed-canvas.mjs exited ' + res.code + '.',
      hint: truncate((res.stderr || res.stdout || '(no output)').replace(/\s+$/, ''), MAX_CAPTURE_BYTES),
    }));
    publishFiles(listing);
    return;
  }

  let seeded;
  try { seeded = fs.readFileSync(outFile, 'utf8'); } catch (e) {
    publish('seed-failed', Object.assign({
      ok: false,
      warnings: [],
      error: 'seed-canvas.mjs reported success but ' + outFile + ' is unreadable.',
      hint: String((e && e.message) || e),
    }, view));
    publishFiles(listing);
    return;
  }

  // Defence in depth for CONTRACT §3 `live-store` / §5.4. Seeding deletes
  // `state.store`, so our own output can never carry `store:"db"` — but a page
  // that does boots read-only no matter what a host provides (FINDINGS §4), and
  // that must be a named state rather than a mysteriously inert canvas. The
  // pane runs its own check on the fetched document; this one catches a payload
  // whose seeding transformation changed under us.
  const block = readStateBlock(seeded);
  if (!block.ok) {
    publish('seed-failed', Object.assign({
      ok: false,
      warnings: [],
      error: 'the seeded page has no readable appifact-doc state block (' + block.reason + ').',
      hint: 'The editor payload on this machine may have changed shape. Re-run `/design` in Claude Code to '
        + 'refresh it, then reseed. If it persists, the payload and this pack have drifted apart.',
    }, view));
    publishFiles(listing);
    return;
  }
  if (block.state && block.state.store === 'db') {
    publish('live-store', Object.assign({
      ok: false,
      warnings: [],
      error: 'The seeded page still carries store:"db" — its design lives in a live store, not in the file.',
      hint: 'Refuse it. A live-store canvas cannot be edited from here; open it in its published Artifact instead.',
    }, view));
    publishFiles(listing);
    return;
  }

  try {
    writeCarrier(seeded);
  } catch (e) {
    publish('seed-failed', Object.assign({
      ok: false,
      warnings: [],
      error: 'could not write the payload carrier component.',
      hint: String((e && e.message) || e) + '\nCheck that ' + componentsDir + ' is writable.',
    }, view));
    publishFiles(listing);
    return;
  }

  haveSeeded = true;
  lastFingerprint = listing.fingerprint;
  seededAt = Date.now();
  seededBytes = Buffer.byteLength(seeded, 'utf8');
  // The helper's own advisory stderr first (it names the file and the rule),
  // then this service's notes about the frames it derived or failed to.
  seedWarnings = splitWarnings(res.stderr).concat(plan.notes, refused);
  publish('ready', view);
  publishFiles(listing);
  log('seeded ' + listing.artboards.length + ' artboard(s) → ' + carrierName + ' (' + seededBytes + ' bytes)');
}

/* ------------------------------------------------------------------ *
 * 10. The carrier component (CONTRACT §6.3.4, §5.3, §7)
 *
 * The pane fetches `GET /api/components/<payload_component>`, which returns
 * `{…meta, source, has_service}` with `source` = this component.html. That
 * route is same-origin, behind requireLocalHost, needs no new listener and no
 * CORS. The components registry does a fresh readdirSync per call
 * (lib/server/components-registry.js), so a component written at runtime is
 * picked up with no restart.
 * ------------------------------------------------------------------ */

// §5.3: this component appears in list_components, the drawer and the ⌘K
// palette, and ONE accidental mount writes 2.4 MB into every committed graph
// node, forever. Two defences, both verified against the 0.7.5 surface:
//
//  - `params_schema.properties` must be NON-EMPTY, because public/app/drawer.js
//    :412-419 mounts immediately when a component has no properties. With
//    properties present the drawer instead spawns `form-renderer` with this
//    schema.
//  - the one required property has `enum: []`, so form-renderer builds a
//    <select> with ZERO options (templates/components/form-renderer/
//    component.html:56-62). Its value is always '', and its submit handler
//    refuses on `'<key>' is required` (same file, :103-121). The form can never
//    be submitted, so the mount can never happen.
//
// The description leads with the words that say what it is, per §5.3.
function carrierMeta() {
  return {
    name: carrierName,
    description:
      'Data carrier, NOT a pane — do not mount this. It holds one seeded Claude Design canvas '
      + '(a ~2.4 MB self-contained HTML document) so the `design-canvas` pane can fetch it from '
      + 'GET /api/components/' + carrierName + ' instead of carrying it in pane html or in the store, '
      + 'either of which would be snapshotted into every committed graph node forever. It is written '
      + 'at runtime by the design-canvas service, is never committed to any repo, and renders nothing '
      + 'on its own. It cannot be spawned: its params_schema requires a field with no satisfiable value.',
    params_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['not_mountable'],
      properties: {
        not_mountable: {
          type: 'string',
          enum: [],
          title: 'This component cannot be mounted',
          description:
            'Deliberately unsatisfiable. This is a data carrier for the design-canvas pane, not a '
            + 'component to spawn. Mount `design-canvas` instead.',
        },
      },
    },
    // Our own marker: the sweep and the stop-time cleanup below refuse to touch
    // any directory that does not carry it.
    wc_design: { carrier: true, mount: mountId, pid: process.pid, at: Date.now() },
  };
}

function writeCarrier(source) {
  fs.mkdirSync(assertWritable(carrierDir), { recursive: true });
  // ORDER MATTERS. meta.json goes first, always. componentsRegistry.load()
  // (components-registry.js:50-52) falls back to `params_schema: {}` when
  // meta.json is missing or unparseable — and an empty params_schema is exactly
  // the case drawer.js:416 mounts IMMEDIATELY. A window in which component.html
  // exists without its meta.json is a window in which one drawer click writes
  // 2.4 MB into the graph. The reverse window is harmless: list() tolerates a
  // directory with no component.html, and the pane only fetches after
  // dsn_canvas says `ready`, which is published after both writes land.
  writeAtomic(path.join(carrierDir, 'meta.json'), JSON.stringify(carrierMeta(), null, 2));
  writeAtomic(path.join(carrierDir, 'component.html'), source);
}

function readCarrierMark(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const mark = meta && meta.wc_design;
    return mark && mark.carrier === true ? mark : null;
  } catch { return null; }
}

// Remove OUR carrier when this service shuts down. Guarded on the pid recorded
// in meta.json: if the pane was re-aimed and a fresh service child already
// rewrote the carrier, that file names the NEW pid and we leave it alone, so a
// stop racing a start can never delete the live payload.
function removeCarrier() {
  if (!carrierDir) return;
  const mark = readCarrierMark(carrierDir);
  if (!mark || mark.pid !== process.pid) return;
  try {
    fs.rmSync(assertWritable(carrierDir), { recursive: true, force: true });
    log('removed carrier ' + carrierName);
  } catch (e) { log('could not remove carrier: ' + ((e && e.message) || e)); }
  try { fs.rmSync(assertWritable(buildDir), { recursive: true, force: true }); } catch { /* ignore */ }
}

// Backstop for a SIGKILLed predecessor: a carrier nobody cleaned up is 2.4 MB
// sitting in the user's project. Only ever touches a directory whose name
// matches our own pattern AND whose meta.json carries our marker AND which is
// at least a week old — a service cannot outlive its daemon, so a week-old
// carrier is certainly dead.
function sweepStaleCarriers() {
  const cutoff = Date.now() - CARRIER_TTL_MS;
  for (const name of safeReaddir(componentsDir)) {
    if (name === carrierName || !CARRIER_RE.test(name)) continue;
    const d = path.join(componentsDir, name);
    const mark = readCarrierMark(d);
    if (!mark || typeof mark.at !== 'number' || mark.at > cutoff) continue;
    try {
      fs.rmSync(assertWritable(d), { recursive: true, force: true });
      log('swept stale carrier ' + name);
    } catch { /* ignore */ }
    try { fs.rmSync(assertWritable(path.join(buildRoot, name)), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ *
 * 11. Serialised work
 * ------------------------------------------------------------------ */

function enqueue(fn) {
  chain = chain.then(() => {
    if (stopped) return undefined;
    try { return fn(); } catch (e) { log('task failed: ' + ((e && e.stack) || e)); return undefined; }
  }).catch((e) => { log('task rejected: ' + ((e && e.stack) || e)); });
  return chain;
}

// EVERY seeding pass ends in a published state. seedNow() names a state on each
// of its own failure paths, but an UNEXPECTED throw — assertWritable refusing a
// write, an EACCES on the build directory, a readdir that raced a delete — would
// otherwise unwind into enqueue()'s .catch, which only logs. The store would
// then keep whatever was published last, which on a first mount is `seeding`:
// the pane sits on a progress bar forever, with `error:null` and `hint:null`.
// CONTRACT §2.1 says dsn_canvas is written in EVERY state including failure, and
// §3 says the pane never shows a spinner with no explanation — neither survives
// a swallowed throw, so this is the backstop that keeps both true.
async function seedGuarded(force) {
  try {
    await seedNow(force);
  } catch (e) {
    if (stopped) return;
    log('seed threw: ' + ((e && e.stack) || e));
    publish('seed-failed', {
      ok: false,
      warnings: [],
      error: 'the seeding pass failed before a canvas could be written.',
      hint: truncate(String((e && e.message) || e), MAX_CAPTURE_BYTES),
    });
    try { const l = scanDir(); publishFiles(l && l.error ? null : l); } catch { publishFiles(null); }
  }
}

// Coalescing seed. A change arriving mid-seed sets a flag instead of spawning a
// second helper; when the running seed finishes it runs exactly once more.
async function requestSeed(force) {
  if (stopped) return;
  // A forced request arriving mid-seed must still force the follow-up run.
  if (force) forcePending = true;
  if (seedInFlight) { reseedPending = true; return; }
  seedInFlight = true;
  try {
    do {
      reseedPending = false;
      const f = forcePending;
      forcePending = false;
      await seedGuarded(f);
    } while (reseedPending && !stopped);
  } finally {
    seedInFlight = false;
    forcePending = false;
  }
}

/* ------------------------------------------------------------------ *
 * 12. Watching (CONTRACT §6.3.6 — debounce 250 ms)
 * ------------------------------------------------------------------ */

function isWatchable(name) {
  if (!name || name.charAt(0) === '.') return false;
  if (isArtboardName(name) || name === CANVAS_FILE) return true;
  return IMAGE_EXT.has(path.extname(name).toLowerCase());
}

/* ── §6.7: watcher suppression ─────────────────────────────────────────────
 *
 * Save writes to `dir`, and the watcher watches `dir`. Without care that is a
 * loop: Save → write → watcher → re-seed → the pane remounts the frame the user
 * is typing in, mid-edit. So saveBack records exactly what it wrote and how it
 * left it, the watcher ignores exactly that for a bounded window, and the save
 * path then re-seeds ONCE, deliberately, so the carrier matches disk.
 *
 * Three things make this precise rather than a blanket mute:
 *
 *  - the window is closed EARLY, the moment that deliberate re-seed lands, and
 *    SAVE_SUPPRESS_MS is only the hard bound if it never does;
 *  - a NAMED event is suppressed only if we wrote that name AND the file still
 *    carries the size and mtime we left it with. Someone else's later write to
 *    the same file has a different mtime, so it is not suppressed;
 *  - nothing is lost even when we suppress wrongly, because the deliberate
 *    re-seed re-reads the directory from scratch — a change that raced the
 *    window is picked up by it, not dropped.
 *
 * A NULL filename (some platforms report one) is suppressed for the window's
 * duration: it means "something under dir changed" with no way to ask what, and
 * during our own write burst that is overwhelmingly us. The re-seed above is
 * what makes that safe.
 */
function saveWindowOpen() {
  if (!saveSuppressUntil) return false;
  if (Date.now() > saveSuppressUntil) { clearSaveSuppression(); return false; }
  return true;
}

function openSaveWindow() {
  saveSuppressUntil = Date.now() + SAVE_SUPPRESS_MS;
  saveSuppressFiles = new Map();
}

// Called after the writes land, with the names saveBack actually replaced.
function recordSaveWindow(names) {
  if (!dirAbs) return;
  saveSuppressUntil = Date.now() + SAVE_SUPPRESS_MS;
  for (const n of names || []) {
    try {
      const st = fs.statSync(path.join(dirAbs, n));
      saveSuppressFiles.set(n, { size: st.size, mtimeMs: Math.round(st.mtimeMs || 0) });
    } catch { /* it went away again; do not suppress it */ }
  }
}

function clearSaveSuppression() {
  saveSuppressUntil = 0;
  saveSuppressFiles = new Map();
}

function saveSuppressed(name) {
  if (!saveWindowOpen()) return false;
  if (name === null) return true;                 // see the header note
  const rec = saveSuppressFiles.get(name);
  if (!rec) return false;
  let st = null;
  try { st = fs.statSync(path.join(dirAbs, name)); } catch { return false; }
  // Coarse-mtime filesystems could in principle let an external write in the
  // same second at the same size pass as ours. The cost is one delayed re-seed:
  // the poll's own fingerprint check (§14) catches it once the window closes.
  return st.size === rec.size && Math.round(st.mtimeMs || 0) === rec.mtimeMs;
}

function queueChange(name) {
  if (stopped || !watchEnabled) return;
  if (saveSuppressed(name === undefined ? null : name)) return;
  if (debTimer) clearTimeout(debTimer);
  debTimer = setTimeout(() => {
    debTimer = null;
    enqueue(requestSeed);
  }, DEBOUNCE_MS);
  if (debTimer.unref) debTimer.unref();
}

function installWatch() {
  if (!watchEnabled) return;
  try {
    // Non-recursive: only the top level of `dir` is ever read, because the
    // helper stores each file under its BASENAME — a nested `img/logo.png` and
    // a top-level `logo.png` would collide as one entry.
    watcher = fs.watch(dirAbs, (evt, fn) => {
      if (stopped) return;
      // A null filename (some platforms) means "something changed" — re-scan.
      if (!fn) { queueChange(null); return; }
      if (isWatchable(String(fn))) queueChange(String(fn));
    });
    watcher.on('error', (e) => { log('watch error, falling back to the poll: ' + ((e && e.message) || e)); });
  } catch (e) {
    watcher = null;
    log('fs.watch unavailable, falling back to the poll: ' + ((e && e.message) || e));
  }
}

/* ------------------------------------------------------------------ *
 * 13. The control key (CONTRACT §2.3)
 *
 * The pane writes dsn_ctl and the service reacts. This is a SERVICE REACTION,
 * not a declared signal: it never wakes Claude.
 * ------------------------------------------------------------------ */

function acceptCtl(v) {
  if (!v || typeof v !== 'object') return null;
  const s = typeof v.seq === 'number' && Number.isFinite(v.seq) ? v.seq : null;
  if (s === null || !(s > lastCtlSeq)) return null;   // repeat or regression
  const op = typeof v.op === 'string' ? v.op : null;
  if (op !== 'reseed' && op !== 'rescan') return null;
  lastCtlSeq = s;
  return { seq: s, op };
}

async function runCtl(cmd) {
  if (stopped || !cmd) return;
  if (cmd.op === 'reseed') { await bootstrapAndSeed(true); return; }
  if (cmd.op === 'rescan') {
    // Directory listing only; do not re-seed.
    if (!dirAbs) return;
    const listing = scanDir();
    publishFiles(listing.error ? null : listing, { bump: true });
  }
}

/* ------------------------------------------------------------------ *
 * 13b. EDIT MODE — the save transport (§6.6) and the write-back (§6.4)
 *
 * Save is REAL (§9.5). The pane installs ONE host member into the canvas frame
 * before the payload's own scripts run:
 *
 *     globalThis.claude = { self: { publish: async (html) => { … } } };
 *
 * and when the user hits Save the editor hands `publish` the COMPLETE document.
 * From there to the user's files:
 *
 *   frame  →  parent.postMessage(the state block)          the shim, in the pane
 *   pane   →  POST http://127.0.0.1:<port>/save/<token>    validated: the pane
 *             {"state": "<block>"}                         checks event.source
 *   here   →  wrap the block in a MINIMAL page             §6.6
 *          →  seed-canvas.mjs --extract <page> --to <fresh dir>
 *          →  validate, back up, write-then-rename, roll back on failure
 *          →  suppress the watcher, then re-seed ONCE      §6.7
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO.
 *
 *  - It does not carry the 2.4 MB document. The state block — the user's actual
 *    content — is under 1% of the page (measured: 19,777 bytes of 2,495,380),
 *    and `--extract` accepts a minimal page carrying only that block. §6.6.
 *  - It does not move the handover through the store. `POST /api/store` puts the
 *    whole patch into the event ring, the WS frame and every SSE subscriber, and
 *    graph.js snapshots the store into every committed node — a canvas with
 *    images would push six figures into every node forever. Hence a listener.
 *  - It never tells the FRAME the endpoint. The frame is same-origin with the
 *    daemon (§9.3) and its content is untrusted; the pane is the only thing that
 *    talks to this listener, and it is the pane that checks the message came
 *    from its own frame.
 *
 * ERROR DISCIPLINE (§9.5) is the pane's to enforce, but it starts here: this
 * endpoint's failure body is prose, and the ONLY thing the pane may reject
 * `publish` with is a plain `Error`. Rejecting with `not_writer`,
 * `not_declared`, `capability_disabled` or `capability_removed` writes a sticky
 * sessionStorage read-only pin that cannot be cleared from the UI, and in a
 * srcdoc frame that key is TAB-GLOBAL — one of them bricks editing for the whole
 * tab. Nothing in this file constructs those strings, and nothing should.
 * ------------------------------------------------------------------ */

/* ── §6.6: the loopback listener ──────────────────────────────────────────── */

// Origins this listener will echo. NEVER '*': a wildcard here would re-introduce
// the regression lib/core/cors.js documents having removed, and this endpoint
// writes to the user's own files. An Origin that is not loopback is refused
// outright and gets no CORS header at all, so a page on another origin can
// neither read the answer nor learn whether the path token was right.
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

function localOrigin(o) { return typeof o === 'string' && LOCAL_ORIGIN_RE.test(o); }

function saveEndpoint() {
  return saveUrl && saveToken ? { url: saveUrl, token: saveToken } : null;
}

function corsHeaders(req, extra) {
  const h = Object.assign({ vary: 'Origin' }, extra || {});
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (localOrigin(origin)) h['access-control-allow-origin'] = origin;
  return h;
}

function sendJson(req, res, code, obj) {
  let body;
  try { body = Buffer.from(JSON.stringify(obj), 'utf8'); }
  catch { body = Buffer.from('{"ok":false,"error":"the save result could not be serialised"}', 'utf8'); }
  try {
    res.writeHead(code, corsHeaders(req, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    }));
    res.end(body);
  } catch { /* the socket went away */ }
}

// The per-spawn path token. Compared in constant time, because a timing oracle
// on a token that authorises writing to the user's files is not a thing to
// leave lying around, however local the listener is.
function savePathToken(url) {
  const p = String(url || '').split('?')[0].split('#')[0];
  if (p.indexOf(SAVE_PATH_PREFIX) !== 0) return null;
  const rest = p.slice(SAVE_PATH_PREFIX.length);
  return /^[0-9a-f]{16,256}$/.test(rest) ? rest : null;
}

function tokenOk(given) {
  if (typeof given !== 'string' || !saveToken) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(saveToken, 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// Read the body with a hard cap. Over the cap we stop buffering immediately and
// answer 413 — the point of the cap is that one POST cannot make this child
// allocate without bound.
function readSaveBody(req, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    req.on('data', (d) => {
      if (done) return;
      n += d.length;
      if (n > cap) { finish({ tooBig: true, bytes: n }); return; }
      chunks.push(d);
    });
    req.on('end', () => finish({ text: Buffer.concat(chunks).toString('utf8') }));
    req.on('aborted', () => finish({ aborted: true }));
    req.on('error', () => finish({ aborted: true }));
  });
}

async function onSaveHttp(req, res) {
  const method = String(req.method || '').toUpperCase();
  const origin = req.headers ? req.headers.origin : undefined;
  if (origin !== undefined && !localOrigin(origin)) {
    sendJson(req, res, 403, { ok: false, error: 'this endpoint answers only same-machine origins.' });
    return;
  }
  const tok = savePathToken(req.url);
  if (!tok || !tokenOk(tok)) {
    sendJson(req, res, 404, { ok: false, error: 'not found' });
    return;
  }
  if (method === 'OPTIONS') {
    // The CORS preflight for the POST below — the only non-POST method answered,
    // and it carries no data. §6.6's "POST only" is about the data path; without
    // this, a pane sending `content-type: application/json` from the surface
    // origin never gets to make the request at all.
    try {
      res.writeHead(204, corsHeaders(req, {
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        'content-length': '0',
      }));
      res.end();
    } catch { /* the socket went away */ }
    return;
  }
  if (method !== 'POST') {
    sendJson(req, res, 405, { ok: false, error: 'POST only.' });
    return;
  }

  const body = await readSaveBody(req, SAVE_BODY_CAP);
  if (body.aborted) return;
  if (body.tooBig) {
    sendJson(req, res, 413, {
      ok: false,
      error: 'the save handover is larger than this listener accepts (' + SAVE_BODY_CAP + ' bytes).',
      hint: 'Nothing was written. An artboard or an image in this canvas is far larger than the '
        + 'editor itself will load — shrink it and save again.',
    });
    // Only once the 413 is on the wire: destroying the request socket first
    // would take the response with it, and the pane would see a bare network
    // error rather than a sentence telling it what happened. Until then the
    // rest of the upload is read and discarded, so memory stays bounded.
    try { res.on('finish', () => { try { req.destroy(); } catch { /* ignore */ } }); }
    catch { /* ignore */ }
    return;
  }

  const out = await runSave(body.text);
  sendJson(req, res, out.status, Object.assign({ ok: out.record.ok }, out.record));
}

async function openSaveListener() {
  if (saveServer) return;
  saveToken = crypto.randomBytes(SAVE_TOKEN_BYTES).toString('hex');
  const server = http.createServer((req, res) => { onSaveHttp(req, res); });
  server.on('connection', (s) => {
    saveSockets.add(s);
    s.on('close', () => saveSockets.delete(s));
  });
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    server.on('error', (e) => {
      log('save listener failed: ' + ((e && e.message) || e));
      saveServer = null; saveUrl = null; saveToken = null; savePort = null;
      done();
    });
    // 127.0.0.1 ONLY, ephemeral port. Not 'localhost' (which can resolve to ::1
    // as well and would bind two families), and never 0.0.0.0.
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      savePort = a && typeof a === 'object' ? a.port : null;
      if (!savePort) { done(); return; }
      saveServer = server;
      saveUrl = 'http://127.0.0.1:' + savePort + SAVE_PATH_PREFIX + saveToken;
      // unref, like every other timer here: the child is held alive by its IPC
      // channel to the supervisor, and a listener must not be what keeps it up.
      if (server.unref) server.unref();
      log('save listener on 127.0.0.1:' + savePort);
      done();
    });
  });
}

function closeSaveListener() {
  if (saveServer) { try { saveServer.close(); } catch { /* ignore */ } }
  for (const s of saveSockets) { try { s.destroy(); } catch { /* ignore */ } }
  saveSockets = new Set();
  saveServer = null; saveUrl = null; saveToken = null; savePort = null;
}

/* ── the handover: a state block, and the minimal page that carries it ────── */

// Accept the state OBJECT, the state-block TEXT, or a whole document carrying
// one. The pane sends the block (§6.6), but a shim that has not been taught to
// slice would hand over the complete 2.4 MB page, and refusing that on a
// technicality would lose the user's work for no reason.
function coerceState(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, state: raw };
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, why: 'the save carried no handover (expected {"doc": …}, the minimal page holding the appifact-doc block, or {"state": …}, the block itself).' };
  }
  const s = raw.trim();
  if (s.charAt(0) === '{') {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, state: v };
      return { ok: false, why: 'the state block parsed to something that is not an object.' };
    } catch (e) {
      return { ok: false, why: 'the state block does not parse (' + String((e && e.message) || e).slice(0, 160) + ') — the handover was cut off.' };
    }
  }
  const b = readStateBlock(raw);
  if (b.ok) return { ok: true, state: b.state };
  return { ok: false, why: 'the save carried neither a parseable state block nor a page containing one (' + b.reason + ').' };
}

// Re-serialised rather than passed through verbatim. JSON.stringify puts the
// whole block on one line, and escaping every "<" to a < escape is exactly
// what the page's own serialiser does — which is what makes the helper's DOC_RE (opener,
// newline, block, newline, closer) match a block we assembled ourselves. It also
// means a block with a literal "\n</script>" in it cannot terminate early.
function wrapStateBlock(state) {
  const block = JSON.stringify(state).replace(/</g, '\\u003c');
  const page = '<!doctype html>\n<html>\n'
    + '<head><meta charset="utf-8"><title>wc-design save handover</title></head>\n'
    + '<body>\n'
    + '<script type="application/json" id="appifact-doc">\n' + block + '\n</script>\n'
    + '</body>\n</html>\n';
  return { page, blockBytes: Buffer.byteLength(block, 'utf8') };
}

/* ── §6.4: saveBack() ─────────────────────────────────────────────────────
 *
 * INLINED from the standalone module this was developed and proven in —
 * `scratch/writeback.mjs`, whose test asserts 26 things about it, including that
 * each of four destructive-input cases leaves the working directory
 * BYTE-IDENTICAL. A component ships exactly four files (§1.2/§9.4), so this file
 * cannot import it; the duplication is the same deliberate one §6.2 already
 * requires for payload discovery. !! KEEP THE TWO IN SYNC !!
 *
 * The seven rules of §6.4, and where each one lives below:
 *   1 extract first, write second        step 1-2: an extract that fails, or
 *                                        returns no artboard, returns before
 *                                        step 3 and nothing is touched
 *   2 back up every file it replaces     step 3, before the first byte
 *   3 write-then-rename, per file        step 4
 *   4 roll back the whole batch          step 4's catch
 *   5 never delete                       step 5: an artboard the extract did not
 *                                        return is reported orphaned, not removed
 *   6 canvas.json by MEANING             step 4, jsonEquivalent()
 *   7 suppress the watcher               the caller: openSaveWindow() /
 *                                        recordSaveWindow() (§6.7)
 *
 * FOUR DELTAS from the proven module, each a narrowing, each deliberate:
 *   a. every write into `dir` goes through assertSaveTarget() — the second write
 *      gate (§5). The module's own filters already make a separator impossible;
 *      this is belt-and-braces at the one place §6.4's licence is exercised.
 *   b. the extract runs through runHelper(), so it inherits the seed path's
 *      timeout, its bounded stdio capture, and its registration in `child` — a
 *      stop() mid-save kills it instead of leaking a process.
 *   c. `minDocBytes` is a parameter (default 1024, the module's fixed floor).
 *      That floor was calibrated for a whole 2.5 MB document; here the document
 *      is a minimal page wrapping just the state block, and a small but
 *      perfectly real canvas can come in under 1 KB. The caller passes 0 because
 *      it has already validated the block STRUCTURALLY — it parses, it is not a
 *      live-store page, and it carries at least one .dc.html entry — which is a
 *      strictly stronger gate than a length.
 *   d. async/await over the same steps, in the same order, with the same abort
 *      points, because this file is CommonJS.
 *   e. the compare/backup order inside steps 3-4 — see the comment there. The
 *      module backs up every candidate and then finds most of them identical;
 *      here the same comparison runs first, so a save backs up only what it
 *      actually replaces and a no-op save reports `backup_dir: null` instead of
 *      copying the whole canvas. Rule 2 is unaffected: every replaced file is
 *      still backed up before the first byte is written.
 * `workRoot` is the build ROOT rather than the per-carrier build dir, so that
 * backups outlive removeCarrier()'s rm of the carrier's own build directory.
 * Still "under the build tree" (§6.4.2) — see sweepStaleSaveWork() for the
 * bound on how long they live.
 */

const stamp2 = (n) => String(n).padStart(2, '0');
function backupName(now) {
  const d = new Date(now);
  return `${d.getFullYear()}${stamp2(d.getMonth() + 1)}${stamp2(d.getDate())}-`
    + `${stamp2(d.getHours())}${stamp2(d.getMinutes())}${stamp2(d.getSeconds())}`;
}

async function pathExists(p) { try { await fsp.stat(p); return true; } catch { return false; } }

// Deep-equal two JSON buffers by value, ignoring formatting AND key order.
// Used only for canvas.json (see the call site). Returns false on unparsable
// input so a corrupt manifest is always replaced rather than silently kept.
function jsonEquivalent(a, b) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((o, k) => (o[k] = norm(v[k]), o), {});
    }
    return v;
  };
  try {
    return JSON.stringify(norm(JSON.parse(a.toString('utf8'))))
      === JSON.stringify(norm(JSON.parse(b.toString('utf8'))));
  } catch { return false; }
}

async function saveBack(o) {
  const helperPath = o.helperPath;
  const docHtml = o.docHtml;
  const dir = o.dir;
  const workRoot = o.workRoot;
  const now = typeof o.now === 'number' ? o.now : 0;
  const knownFiles = Array.isArray(o.knownFiles) ? o.knownFiles : [];
  const minDocBytes = typeof o.minDocBytes === 'number' ? o.minDocBytes : 1024;

  const tag = crypto.randomBytes(6).toString('hex');
  const tmpRoot = path.join(workRoot, 'writeback', tag);
  const pagePath = path.join(tmpRoot, 'edited.html');
  const outDir = path.join(tmpRoot, 'extract');

  const result = {
    ok: false, written: [], unchanged: [], orphaned: [], backupDir: null,
    error: null, hint: null, stderr: '', tmpRoot,
  };

  /* ---- 0. sanity on the handover itself --------------------------------- */
  if (typeof docHtml !== 'string' || docHtml.length < minDocBytes) {
    result.error = 'the editor handed over an empty or implausibly small document';
    result.hint = 'Nothing was written. Your files are untouched.';
    return result;
  }

  await fsp.mkdir(assertWritable(tmpRoot), { recursive: true });
  await fsp.writeFile(assertWritable(pagePath), docHtml, 'utf8');

  /* ---- 1. extract, using upstream's own tool ----------------------------- */
  // --to must be a FRESH directory: the helper writes each file with the `wx`
  // flag unless --force, and fails on EEXIST. `tag` is what makes it fresh.
  const ex = await runHelper([helperPath, '--extract', pagePath, '--to', outDir]);
  result.stderr = String(ex.stderr || '').trim();
  if (ex.code !== 0) {
    result.error = 'could not read the edited canvas back into files';
    result.hint = truncate(result.stderr || 'the extract step failed', MAX_CAPTURE_BYTES);
    return result;                            // nothing written — user's files intact
  }

  /* ---- 2. validate the extracted set BEFORE touching anything ------------ */
  let names;
  try { names = await fsp.readdir(outDir); } catch {
    result.error = 'the extract produced no output directory';
    result.hint = 'Nothing was written. Your files are untouched.';
    return result;
  }
  const artboards = names.filter((n) => HELPER_ARTBOARD_RE.test(n));
  if (artboards.length === 0) {
    result.error = 'the edited canvas came back with no artboards';
    result.hint = 'Refusing to overwrite your files with an empty result. Nothing was written.';
    return result;
  }
  const accept = names.filter((n) =>
    HELPER_ARTBOARD_RE.test(n) || n === CANVAS_FILE || IMAGE_EXT.has(path.extname(n).toLowerCase()));

  /* ---- 3. decide what is actually being replaced, and back up THAT ------- */
  // DELTA (e) from the module, measured rather than assumed. There, every file
  // in `accept` that exists is copied to the backup dir and step 4 then
  // discovers that most of them were identical: an end-to-end save of the
  // fixture backs up four files to write one, and a save that changes NOTHING
  // still produces a full backup and a non-null backup_dir — which the pane
  // would then report to the user as if something had been replaced.
  //
  // So the comparison moves UP here. It is the same comparison, byte-for-byte,
  // that step 4 used to make; only its position changed. §6.4.2 is untouched —
  // every file that IS replaced is still backed up before the first byte is
  // written — and a read that throws now does so before any backup and before
  // any write, which is strictly earlier than it used to.
  const plan = [];    // the files we will actually replace, and their new bytes
  for (const n of accept) {
    const target = assertSaveTarget(n);
    const next = await fsp.readFile(path.join(outDir, n));
    if (!(await pathExists(target))) { plan.push({ name: n, target, next, existed: false }); continue; }
    const cur = await fsp.readFile(target);
    if (cur.equals(next)) { result.unchanged.push(n); continue; }
    // canvas.json round-trips through the helper's own JSON.stringify, so a
    // save re-emits it with the helper's formatting even when nothing about
    // the layout changed. Byte-comparing would rewrite the user's
    // hand-formatted manifest on every single save. Compare MEANING instead
    // and leave their file alone when it says the same thing (§6.4.6).
    if (n === CANVAS_FILE && jsonEquivalent(cur, next)) { result.unchanged.push(n); continue; }
    plan.push({ name: n, target, next, existed: true });
  }

  const backupDir = path.join(workRoot, 'backups', backupName(now) + '-' + tag);
  let backedUp = 0;
  for (const p of plan) {
    if (!p.existed) continue;       // nothing to recover for a file we are creating
    await fsp.mkdir(assertWritable(backupDir), { recursive: true });
    await fsp.copyFile(p.target, assertWritable(path.join(backupDir, p.name)));
    backedUp++;
  }
  if (backedUp) result.backupDir = backupDir;

  /* ---- 4. swap in, atomically per file, rolling back on any failure ------ */
  const done = [];
  try {
    for (const p of plan) {
      // write-then-rename: a crash mid-write cannot leave a half file in place
      const swap = assertSaveTarget(p.name + '.wcdc-' + tag + '.tmp');
      await fsp.writeFile(swap, p.next);
      await fsp.rename(swap, p.target);
      done.push(p.name);
    }
  } catch (e) {
    // roll back everything we replaced in this pass. A file we CREATED has no
    // backup and is left in place: §6.4.5 says never delete, and that holds on
    // the rollback path too.
    for (const n of done) {
      const b = path.join(backupDir, n);
      try { if (await pathExists(b)) await fsp.copyFile(b, assertSaveTarget(n)); } catch { /* ignore */ }
    }
    result.error = 'writing the edited files failed part-way and was rolled back';
    result.hint = String((e && e.message) || e);
    return result;
  }

  /* ---- 5. report, never delete ------------------------------------------ */
  const returned = new Set(accept);
  result.orphaned = knownFiles.filter((n) => !returned.has(n) && HELPER_ARTBOARD_RE.test(n));
  result.written = done;
  result.ok = true;
  return result;
}

/* ── one save, end to end ─────────────────────────────────────────────────── */

function saveRefusal(error, hint, status) {
  return {
    ok: false, written: [], unchanged: [], orphaned: [], backupDir: null,
    error, hint, stderr: '', status: status || 422,
  };
}

// Runs INSIDE the work chain (see runSave), so it can never overlap a seed:
// seeding reads `dir` and this writes it.
async function performSave(bodyText) {
  if (stopped) {
    return saveRefusal('the design-canvas service is shutting down.',
      'Nothing was written. Your files are untouched.', 503);
  }
  if (!payloadInfo || !payloadInfo.ok) {
    return saveRefusal('Claude Design is not available on this machine, so the edit cannot be read back into files.',
      (payloadInfo && payloadInfo.hint) || 'Run `/design` once in Claude Code.', 503);
  }
  if (!dirAbs) {
    return saveRefusal('there is no working directory to save into.',
      'Remount design-canvas with a `dir` that exists and holds the .dc.html artboards.', 503);
  }

  let body = null;
  try { body = JSON.parse(String(bodyText == null ? '' : bodyText)); }
  catch (e) {
    return saveRefusal('the save request body is not JSON (' + String((e && e.message) || e).slice(0, 160) + ').',
      'Nothing was written. Your files are untouched.', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return saveRefusal('the save request body is not a JSON object.',
      'Nothing was written. Your files are untouched.', 400);
  }

  // THE WIRE FORMAT. !! Keep in sync with component.html's postSave() !!
  //
  //   → { token?, mount?, seq?, at?, doc | state, …byte counts }
  //   ← { ok, seq, at, written[], created[], unchanged[], orphaned[],
  //       backup_dir, state_bytes, warnings[], error, hint, reseed_seq }
  //
  // `doc` is what the pane sends: the complete MINIMAL PAGE it wrapped the block
  // in, which is exactly what --extract consumes. `state` is the bare block (or
  // the state object), accepted because a shim that has not been taught to wrap
  // is not a reason to lose the user's work. Anything else in the body — the
  // token, the mount id, the pane's own seq and byte counts — is diagnostic and
  // ignored here: the PATH token is what authorises the write, and re-deriving
  // the sizes ourselves is cheaper than trusting a number.
  const handover = body.doc !== undefined ? body.doc
    : (body.state !== undefined ? body.state : body.block);
  const c = coerceState(handover);
  if (!c.ok) return saveRefusal(c.why, 'Nothing was written. Your files are untouched.', 400);
  const state = c.state;

  // §5.4 / §3, at the one place it can still do damage. seed-canvas.mjs refuses
  // a store:"db" page in --extract too, but a refusal here names the problem in
  // our own words and costs no spawn.
  if (state.store === 'db') {
    return saveRefusal('this canvas keeps its design in a live store, not in the file, so it cannot be written back.',
      'A live-store canvas is not one of yours and cannot be edited from here. Nothing was written.');
  }
  const files = state.content && state.content.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return saveRefusal('the saved state carries no content.files, so there is nothing to write back.',
      'Nothing was written. Your files are untouched.');
  }
  const boards = Object.keys(files).filter((n) => HELPER_ARTBOARD_RE.test(n) && typeof files[n] === 'string');
  if (!boards.length) {
    return saveRefusal('the edited canvas came back with no artboards.',
      'Refusing to overwrite your files with an empty result. Nothing was written.');
  }

  const wrapped = wrapStateBlock(state);
  const listing = scanDir();
  const known = listing && !listing.error ? listing.files.map((f) => f.name) : [];
  const before = new Set(known);

  // §6.7. Opened BEFORE the first write, so the watch events our own writes
  // raise are already inside the window when they arrive. Opening it early costs
  // nothing even when the save then fails: the deliberate re-seed re-reads the
  // directory from scratch, so a genuine change that raced the window is picked
  // up rather than dropped, and the window is bounded either way.
  openSaveWindow();

  let r;
  try {
    // runHelper spawns with cwd: buildDir. Seeding creates it, and a save can
    // only follow a seed — but a `.web-chat` clean-out between the two would
    // turn that into an opaque "cannot spawn node".
    try { fs.mkdirSync(assertWritable(buildDir), { recursive: true }); } catch { /* reported by the spawn */ }
    r = await saveBack({
      helperPath: payloadInfo.helper,
      docHtml: wrapped.page,
      dir: dirAbs,
      workRoot: buildRoot,
      now: Date.now(),
      knownFiles: known,
      minDocBytes: 0,     // see delta (c) above
    });
  } catch (e) {
    r = saveRefusal('writing the edited files failed unexpectedly.',
      truncate(String((e && e.message) || e), 2048));
  }

  recordSaveWindow(r.written);
  r.created = (r.written || []).filter((n) => !before.has(n));
  r.stateBytes = wrapped.blockBytes;

  // The extract output has done its job; the BACKUP is the thing that must
  // survive, and it lives elsewhere under the build root.
  if (r.tmpRoot) { try { fs.rmSync(assertWritable(r.tmpRoot), { recursive: true, force: true }); } catch { /* ignore */ } }

  if (r.ok) {
    log('save wrote ' + r.written.length + ' file(s) [' + r.written.join(', ') + '], '
      + r.unchanged.length + ' unchanged, ' + r.orphaned.length + ' orphaned');
  } else {
    log('save refused: ' + r.error);
  }
  return r;
}

// The HTTP-facing half: serialise the save against seeding, publish the outcome,
// then ask for exactly ONE deliberate re-seed (§6.7).
async function runSave(bodyText) {
  let out = null;
  try { out = await enqueue(() => performSave(bodyText)); }
  catch (e) {
    out = saveRefusal('the save failed unexpectedly.', truncate(String((e && e.message) || e), 2048), 500);
  }
  // enqueue() resolves undefined when the service is stopping or when the task
  // threw; either way the user's editor still holds their work.
  if (!out) {
    out = saveRefusal('the design-canvas service is not accepting saves right now.',
      'The pane was stopped or re-aimed while the save was in flight. Your changes are still in the editor — try again.', 503);
  }

  saveSeq += 1;
  lastSave = {
    seq: saveSeq,
    at: Date.now(),
    ok: !!out.ok,
    written: out.written || [],
    // Files that did not exist in `dir` before this save. Almost always empty;
    // the one real case is a canvas.json for a folder that had none, which the
    // editor now owns the layout of. The pane should SAY so — a file appearing
    // in someone's folder unannounced is exactly the surprise this pack avoids.
    created: out.created || [],
    unchanged: out.unchanged || [],
    // §6.4.5: never deleted, only reported. An artboard removed inside the
    // editor simply does not come back from the extract; the file stays.
    orphaned: out.orphaned || [],
    backup_dir: out.backupDir || null,
    state_bytes: typeof out.stateBytes === 'number' ? out.stateBytes : null,
    warnings: splitWarnings(out.stderr),
    error: out.ok ? null : truncate(out.error || 'the save failed.', 4096),
    hint: out.ok ? null : (truncate(out.hint || '', MAX_CAPTURE_BYTES) || null),
    // Set by publish() when the deliberate re-seed below lands, so the pane can
    // tell its own save coming back from a file someone changed on disk.
    reseed_seq: null,
  };
  republishSave();

  if (out.ok) {
    // §6.7: ONE re-seed, deliberately, so the carrier matches what is now on
    // disk. Not awaited — the pane gets its answer now and the re-seed publishes
    // when it is done. requestSeed() coalesces, so a second save landing during
    // it does not spawn a second helper.
    pendingSaveReseed = true;
    enqueue(async () => {
      try { await requestSeed(true); } finally { clearSaveSuppression(); }
    });
  } else if (!(out.written && out.written.length)) {
    // Nothing was written, so there is nothing for the watcher to ignore and no
    // reason to keep the window open.
    clearSaveSuppression();
  }

  return { status: out.ok ? 200 : (out.status || 422), record: lastSave };
}

// Backstop for the save work tree, the mirror of sweepStaleCarriers(). Backups
// live under the build ROOT so they survive a carrier's own cleanup, which means
// nothing else ever removes them; a week is the same bound a stale carrier gets.
function sweepStaleSaveWork() {
  if (!buildRoot) return;
  const cutoff = Date.now() - CARRIER_TTL_MS;
  for (const bucket of ['backups', 'writeback']) {
    const root = path.join(buildRoot, bucket);
    for (const name of safeReaddir(root)) {
      const d = path.join(root, name);
      let st = null;
      try { st = fs.statSync(d); } catch { continue; }
      if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
      try { fs.rmSync(assertWritable(d), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 14. Resolution and recovery
 *
 * Both resolvers publish their own failure state on the STARTUP pass
 * (`silent === false`) and say nothing on a recovery pass, so the poll can
 * retry every few seconds without spamming the store with seq bumps. `degraded`
 * is the one flag that says "we published a failure and are waiting to heal".
 * ------------------------------------------------------------------ */

function resolveUpstream(silent) {
  payloadInfo = resolvePayload();
  if (payloadInfo.ok) {
    upstream = { version: payloadInfo.version, payload_sha256: payloadInfo.payload_sha256 };
    return true;
  }
  upstream = null;
  degraded = true;
  if (!silent) {
    // A candidate that exists but failed the ownership gate is NOT "not
    // materialised", and telling the user to run `/design` would not fix it —
    // the refused tree would still outrank the real one. Same closed-set state
    // (§3 admits no other), different error and hint, because the hint is
    // defined as the ONE action that fixes what actually happened.
    const bad = Array.isArray(payloadInfo.refused) ? payloadInfo.refused : [];
    if (bad.length) {
      publish('no-payload', {
        ok: false,
        warnings: [],
        error: 'Refused ' + bad.length + ' editor payload'
          + (bad.length === 1 ? '' : 's') + ' that this user does not exclusively own: '
          + bad.slice(0, 3).map((p) => JSON.stringify(p)).join(', ')
          + (bad.length > 3 ? ', …' : '')
          + '. design-canvas runs that helper and mounts its output same-origin with the '
          + 'daemon, so it only ever loads a payload owned by you and writable by nobody else.',
        hint: 'Delete that path (it is not Claude Code\'s — the real one lives under '
          + '`<tmp>/claude-<uid>/bundled-skills/`, mode 0700), then reseed. If it IS yours, '
          + 'remove group and other write permission from it and everything above it.',
      });
      publishFiles(null);
      return false;
    }
    publish('no-payload', {
      ok: false,
      warnings: [],
      error: 'Claude Design has not been materialised on this machine (searched ' + payloadInfo.searched + ').',
      hint: 'Run `/design` once in Claude Code.',
    });
    publishFiles(null);
  }
  return false;
}

// CONTRACT §1.1 / §6.3.2. A path a pane wrote must never escape the project,
// and a `dir` that fences to null is a HARD ERROR STATE, never a silent
// fallback — there is no default directory, and guessing one would read files
// the user never named.
function resolveDir(silent) {
  const bad = (error, hint) => {
    dirAbs = null;
    degraded = true;
    if (!silent) { publish('bad-dir', { ok: false, warnings: [], error, hint }); publishFiles(null); }
    return false;
  };
  const rawDir = paramsIn.dir;
  if (typeof rawDir !== 'string' || !rawDir.trim()) {
    return bad('the `dir` param is missing.',
      'Mount design-canvas with `dir` set to the absolute path of the folder holding the .dc.html artboards.');
  }
  if (!path.isAbsolute(rawDir)) {
    return bad('`dir` is not an absolute path: ' + JSON.stringify(rawDir.slice(0, 200)) + '.',
      'Pass `dir` as an absolute path — the daemon\'s working directory is essentially never the design folder.');
  }
  // Exactly the expression CONTRACT §1.1 specifies.
  const projectRoot = webChatDirParam ? path.dirname(webChatDirParam) : process.cwd();
  const fenced = fenceFn(projectRoot, rawDir);
  if (!fenced) {
    return bad(rawDir + ' is outside this project (' + projectRoot + '), or reaches outside it through a symlink.',
      'Move the design folder inside ' + projectRoot + ', or open web-chat in the project that contains it. '
      + 'design-canvas will not read outside the project.');
  }
  let st = null;
  try { st = fs.statSync(fenced); } catch { st = null; }
  if (!st) return bad(fenced + ' does not exist.', 'Create it and put at least one `<Name>.dc.html` artboard in it.');
  if (!st.isDirectory()) return bad(fenced + ' is a file, not a directory.', 'Pass the folder that CONTAINS the .dc.html artboards, not one of them.');

  // §6.4 is enforced by assertWritable(), which refuses ANY write inside `dir`.
  // A `dir` that CONTAINS this service's own two write roots therefore refuses
  // the service's own build output — and the natural way to reach that is to
  // pass the project root itself, since `<root>/.web-chat` lives inside it.
  // Caught here rather than at the first write, because a refusal from inside
  // seedNow() is not a state the pane can name: this is a `dir` problem and
  // `bad-dir` is what says so (CONTRACT §3). (Edit mode does not change this:
  // saveBack's licence is one file at a time directly inside `dir`, through
  // assertSaveTarget — the SEEDING side still writes only through
  // assertWritable, which refuses everything under `dir`.)
  if (under(fenced, buildRoot) || under(fenced, componentsDir)) {
    return bad(
      fenced + ' contains web-chat\'s own ' + path.basename(webChatDir) + ' directory, which is where this service builds.',
      'Point `dir` at the folder that holds the .dc.html artboards — a subdirectory such as '
      + path.join(fenced, 'design') + ' — rather than at the project root. Seeding writes only to the build '
      + 'directory and refuses any path inside `dir`, so a `dir` that contains that build directory cannot be seeded at all.');
  }

  dirAbs = fenced;
  return true;
}

// Re-resolve whatever is missing, then seed. Used by an explicit `reseed` and
// by the recovery poll, so a service that started degraded can come back
// without a remount.
async function bootstrapAndSeed(force) {
  if (stopped) return;
  let silent = !!degraded && !force;
  if (!payloadInfo || !payloadInfo.ok) {
    if (!resolveUpstream(silent)) return;
    // The payload just appeared under a recovery pass. Whatever we are about to
    // say about `dir` is NEW information rather than the same failure repeating,
    // so say it — otherwise a mount that is BOTH payload-less and dir-less heals
    // the payload silently and leaves the pane showing `no-payload` for a
    // `bad-dir` problem, with the wrong hint. Exactly one such publish can
    // happen: payloadInfo.ok is sticky, so the next poll takes neither branch.
    silent = false;
  }
  if (!dirAbs) { if (!resolveDir(silent)) return; }
  degraded = false;
  if (!watcher) installWatch();
  await requestSeed(force);
}

async function installControlLoop() {
  // Adopt a control write that predates us: a respawn replays nothing, because
  // the seed above already did the work `reseed` would ask for. Recording the
  // seq stops the poll from re-running a stale command.
  try {
    const got = await driver.getStore(['dsn_ctl']);
    const c = got && got.dsn_ctl;
    if (c && typeof c === 'object' && typeof c.seq === 'number' && Number.isFinite(c.seq)) {
      if (c.seq > lastCtlSeq) lastCtlSeq = c.seq;
    }
  } catch { /* first mount, or no store yet */ }

  /* the store stream (CONTRACT §6.3.7) */
  try {
    stream = driver.streamEvents({
      kinds: ['store'],
      onEvent: (e) => {
        if (stopped || !e || !e.patch) return;
        const cmd = acceptCtl(e.patch.dsn_ctl);
        if (cmd) enqueue(() => runCtl(cmd));
      },
      onError: () => {},
      onClose: () => {},
    });
  } catch (e) {
    log('streamEvents unavailable, relying on the poll: ' + ((e && e.message) || e));
  }

  /* the poll: control-key fallback (the SSE stream does not auto-reconnect),
     self-heal, recovery, and anything fs.watch missed */
  pollTimer = setInterval(() => {
    if (stopped) return;
    enqueue(async () => {
      let got = null;
      try { got = await driver.getStore(['dsn_ctl', 'dsn_canvas']); } catch { return; }
      if (stopped) return;

      const cmd = acceptCtl(got && got.dsn_ctl);
      if (cmd) { await runCtl(cmd); return; }

      // RECOVERY. We published no-payload or bad-dir and are waiting for the
      // world to change: retry quietly, and only speak when it works.
      if (degraded) { await bootstrapAndSeed(false); return; }

      // SELF-HEAL. This service is not the store's only writer: a surface wipe
      // or a graph re-aim to a node that predates us leaves our payload gone
      // while nothing on disk changed. The pane is store-driven, so no store
      // means no pane — republish rather than wait for a file to change.
      const cur = got && got.dsn_canvas;
      if (!cur || typeof cur !== 'object') {
        if (lastPublished) {
          seq += 1;
          lastPublished = Object.assign({}, lastPublished, { seq });
          pushStore({ dsn_canvas: lastPublished });
          const listing = dirAbs ? scanDir() : null;
          publishFiles(listing && !listing.error ? listing : null);
        }
        return;
      }

      // The carrier can also vanish underneath us (a `.web-chat` clean-out).
      if (haveSeeded && !fs.existsSync(path.join(carrierDir, 'component.html'))) {
        haveSeeded = false;
        lastFingerprint = null;
        await requestSeed();
        return;
      }

      // Anything fs.watch missed (network mounts, editors that replace the
      // directory entry). Cheap: one readdir + a stat per file.
      //
      // Skipped while a save's suppression window is open (§6.7). This branch
      // is the OTHER half of the re-seed loop a save would otherwise start: a
      // save changes the files, so the fingerprint necessarily differs from the
      // last seed's, and this would re-seed on top of the one the save already
      // asked for. The window closes as soon as that deliberate re-seed lands
      // — which sets `lastFingerprint` to the post-save disk — so by the time
      // this runs again there is nothing to chase.
      if (watchEnabled && haveSeeded && dirAbs && !saveWindowOpen()) {
        const listing = scanDir();
        if (!listing.error && listing.fingerprint !== lastFingerprint) await requestSeed();
      }
    });
  }, POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
}

/* ------------------------------------------------------------------ *
 * 15. start / stop
 * ------------------------------------------------------------------ */

async function start(ctx) {
  stopped = false;
  driver = ctx.driver;
  logFn = ctx.log;
  mountId = ctx.mountId || null;
  paramsIn = ctx.params || {};
  fenceFn = typeof ctx.fence === 'function' ? ctx.fence : () => null;

  seq = 0;
  haveSeeded = false;
  lastFingerprint = null;
  planCache = null;
  planCacheKey = null;
  seededAt = null;
  seededBytes = null;
  seedWarnings = [];
  lastCtlSeq = -Infinity;
  degraded = false;
  seedInFlight = false;
  reseedPending = false;
  forcePending = false;
  saveSeq = 0;
  lastSave = null;
  pendingSaveReseed = false;
  clearSaveSuppression();

  // service-runner.js:50 — `webChatDir: msg.webChatDir || null`; the supervisor
  // passes paths.WEB_CHAT_DIR (services.js:240), so this is set in practice.
  webChatDirParam = ctx.webChatDir || null;
  webChatDir = ctx.webChatDir || path.join(process.cwd(), '.web-chat');
  componentsDir = path.join(webChatDir, 'components');
  buildRoot = path.join(webChatDir, BUILD_DIRNAME);
  carrierName = carrierNameFor(mountId);
  carrierDir = path.join(componentsDir, carrierName);
  buildDir = path.join(buildRoot, carrierName);

  title = String(paramsIn.title == null ? '' : paramsIn.title);
  outName = slugFromTitle(title, mountId);
  watchEnabled = paramsIn.watch !== false;

  try { sweepStaleCarriers(); } catch (e) { log('sweep failed: ' + ((e && e.message) || e)); }
  try { sweepStaleSaveWork(); } catch (e) { log('save-work sweep failed: ' + ((e && e.message) || e)); }

  /* ---- 0. seq floor. MUST run before the first publish, including the failure
   * publishes in resolveUpstream/resolveDir below — see adoptSeqFloor(). The
   * supervisor puts no deadline on the `started` IPC reply (services.js:236-238
   * only flips a status field), so one awaited GET here costs nothing. */
  await adoptSeqFloor();
  if (stopped) return;

  /* ---- 0b. the save listener (§6.6). Opened BEFORE the first publish so that
   * every dsn_canvas this service ever writes carries `save_endpoint` — a pane
   * that has to wait for a later publish to learn whether saving is available
   * has to guess in the meantime, and guessing wrong either hides a working
   * Save or offers one that cannot work. It is opened even in the degraded
   * states: a failure to open is `save_endpoint: null` and the pane simply does
   * not install the host object, which is exactly v0.1.0's read-only canvas. */
  try { await openSaveListener(); } catch (e) { log('save listener failed to open: ' + ((e && e.message) || e)); }
  if (stopped) { closeSaveListener(); return; }

  /* ---- 1-2. resolve the payload and the directory (CONTRACT §6.3.1-2) ----
   * Both live in resolveUpstream()/resolveDir() rather than inline, because the
   * poll re-runs them SILENTLY while the service is degraded. That is what
   * makes the `no-payload` hint honest: it tells the user to run `/design`, and
   * when they do, the pane heals on the next poll instead of needing a remount.
   * The startup path is unchanged — a failure publishes its state and stops
   * seeding — but the control loop is still installed below, so `reseed` and
   * the recovery poll can reach us. */
  if (!resolveUpstream(false) || !resolveDir(false)) {
    await installControlLoop();
    return;
  }

  /* ---- 3. first seed ---- */
  await enqueue(() => requestSeed());
  if (stopped) return;

  /* ---- 4. watch, control key, poll ---- */
  installWatch();
  degraded = false;
  await installControlLoop();
}

async function stop() {
  stopped = true;
  // First, so an in-flight POST cannot start a write against a `dir` we are
  // about to forget. A save already inside performSave finishes or rolls back;
  // `stopped` makes runSave's own guard refuse anything that has not started.
  closeSaveListener();
  if (stream) { try { stream.close(); } catch { /* ignore */ } stream = null; }
  if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (debTimer) { clearTimeout(debTimer); debTimer = null; }
  if (child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } child = null; }
  chain = Promise.resolve();
  seedInFlight = false;
  reseedPending = false;
  forcePending = false;

  try { removeCarrier(); } catch (e) { log('cleanup failed: ' + ((e && e.message) || e)); }

  driver = null; logFn = null; paramsIn = null; fenceFn = null;
  payloadInfo = null; upstream = null; lastPublished = null;
  dirAbs = null; outName = null; title = '';
  haveSeeded = false; lastFingerprint = null; seededAt = null; seededBytes = null;
  planCache = null; planCacheKey = null;
  seedWarnings = [];
  degraded = false;
  webChatDirParam = null;
  saveSeq = 0; lastSave = null; pendingSaveReseed = false;
  clearSaveSuppression();
}

/* ------------------------------------------------------------------ *
 * 16. Export shape — see the header. `start` MUST be a function ON the
 * exported object; a bare exported function is silently ignored by
 * service-runner.js:53 and the pane waits forever.
 * ------------------------------------------------------------------ */

module.exports = {
  name: 'design-canvas',
  start,
  stop,
  // Helpers exported for the test harness only. All are pure except
  // resolvePayload/findCandidates, which READ the local install and write
  // nothing. Nothing here touches the driver or the store.
  __test: {
    cmpVersion,
    slugFromTitle,
    carrierNameFor,
    isArtboardName,
    isImageName,
    saneName,
    splitWarnings,
    readStateBlock,
    truncate,
    num,
    acceptCtl,
    carrierMeta,
    buildArgv,
    resolvePayload,
    findCandidates,
    // Frame derivation (§8b/§8c). All pure: `deriveFrame` takes the artboard
    // SOURCE as a string, so a test needs no files, and nothing here executes
    // the design or touches the driver.
    posNum,
    clampWH,
    deriveFrame,
    buildManifest,
    fillManifest,
    manifestProblems,
    appendOrigin,
    // Read-only against a real directory. `scanDir` and `planAttempts` need
    // `dirAbs`, `buildDir` and `fence` — see __setState below; neither writes
    // anything, and `planAttempts` only PLANS the manifest (seedNow writes it).
    scanDir,
    planAttempts,
    viewOf,
    // Edit mode (§13b). `localOrigin`, `savePathToken`, `coerceState`,
    // `wrapStateBlock`, `jsonEquivalent` and `backupName` are pure.
    // `saveBack` is the write-back itself and needs `dirAbs`/`buildRoot`/
    // `payloadInfo` — the end-to-end test drives it through a real start().
    localOrigin,
    savePathToken,
    coerceState,
    wrapStateBlock,
    jsonEquivalent,
    backupName,
    assertSaveTarget,
    saveBack,
    saveEndpoint,
    // §6.7, so the suppression window can be tested without a filesystem race.
    openSaveWindow,
    recordSaveWindow,
    clearSaveSuppression,
    saveSuppressed,
    saveWindowOpen,
    // Injection points so the harness can drive the pure paths without a daemon.
    __setState: (s) => {
      if (!s || typeof s !== 'object') return;
      if ('title' in s) title = String(s.title == null ? '' : s.title);
      if ('carrierName' in s) carrierName = s.carrierName;
      if ('mountId' in s) mountId = s.mountId;
      if ('lastCtlSeq' in s) lastCtlSeq = s.lastCtlSeq;
      // `fillManifest` consults the `expand` param through paramExpand().
      if ('params' in s) paramsIn = s.params || {};
      // For the read-only helpers above. `buildDir` only ever names the path a
      // generated manifest WOULD be written to; nothing here writes.
      if ('dirAbs' in s) dirAbs = s.dirAbs;
      if ('buildDir' in s) buildDir = s.buildDir;
      if ('buildRoot' in s) buildRoot = s.buildRoot;
      if ('componentsDir' in s) componentsDir = s.componentsDir;
      if ('fence' in s) fenceFn = s.fence;
    },
  },
};
