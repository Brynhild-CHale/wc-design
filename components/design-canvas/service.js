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
 * ── ABSOLUTE INVARIANT (CONTRACT §6.4) ──────────────────────────────────────
 * THIS SERVICE NEVER WRITES TO `dir`. The working design files are the user's.
 * The only two places anything is created, modified or deleted are
 *
 *     <webChatDir>/.wc-design-build/<carrier>/     the seed output
 *     <webChatDir>/components/<carrier>/           the delivery carrier
 *
 * and that is ENFORCED, not merely asserted. Grep this file for
 *   fs\.(writeFileSync|renameSync|rmSync|mkdirSync|copyFileSync|unlinkSync)
 * — there are nine hits, in exactly five functions (`writeAtomic`,
 * `writeCarrier`, `removeCarrier`, `sweepStaleCarriers`, and the one mkdir of
 * the build dir in `seedNow`), and every PATH any of them touches is the return
 * value of `assertWritable()`, which throws for anything outside those two
 * roots and, belt-and-braces, for anything inside `dir`. The spawned helper is
 * likewise write-bounded: in seeding mode
 * seed-canvas.mjs performs exactly one write, to `--out`, which is always under
 * the build dir (`--extract`, the helper's only other writing mode, is never
 * invoked here). `dir` is opened read-only, and even the child is spawned with
 * cwd set to the build dir so a relative write could not land in `dir` either.
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
 * ── Store keys (CONTRACT §2) ────────────────────────────────────────────────
 *   dsn_canvas  service → pane   the pane's whole world; written in EVERY state
 *   dsn_files   service → pane   what is actually on disk
 *   dsn_ctl     pane → service   { seq, op: 'reseed' | 'rescan' }  (read only)
 * `dsn_ask` is the pane's declared wake signal and is never read or written here.
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
    // exit-0 stderr, which is advisory rather than fatal and is worth showing.
    warnings: seedWarnings,
  }, extra || {});
  lastPublished = canvas;
  pushStore({ dsn_canvas: canvas });
  return canvas;
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
  // overflow here instead, preferring artboards, and say so.
  let budget = MAX_FILES - (canvasJson ? 1 : 0) - artboards.length;
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

// dsn_canvas.artboards: from canvas.json when present, else one entry per
// .dc.html with x/y/w/h null. Tolerant by design — the pane must tolerate nulls
// (CONTRACT §2.1), and canvas.json is a file on disk we do not control.
function artboardIndex(listing) {
  const present = listing.artboards.map((a) => a.name);
  const out = [];
  const seen = new Set();
  if (listing.canvasJson) {
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(listing.canvasJson.abs, 'utf8')); } catch { manifest = null; }
    const entries = manifest && Array.isArray(manifest.artboards) ? manifest.artboards : [];
    for (const a of entries.slice(0, MAX_FILES)) {
      if (!a || typeof a !== 'object') continue;
      const file = typeof a.file === 'string' ? a.file : null;
      if (!file || !present.includes(file) || seen.has(file)) continue;
      seen.add(file);
      out.push({
        file,
        x: num(a.x), y: num(a.y), w: num(a.w), h: num(a.h),
      });
    }
  }
  // The editor appends unlisted artboards automatically; mirror that.
  for (const name of present) {
    if (seen.has(name)) continue;
    out.push({ file: name, x: null, y: null, w: null, h: null });
  }
  return out;
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

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
function buildArgv(helper, payload, outFile, listing) {
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
  if (listing.canvasJson) pairs.push(['--canvas', listing.canvasJson.abs]);
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

  // Nothing on disk changed since the last successful seed — the carrier is
  // still correct. This is what stops a burst of fs.watch events (an editor
  // writing a file three times per save) from becoming a re-seed storm.
  if (!force && haveSeeded && lastFingerprint === listing.fingerprint && fs.existsSync(path.join(carrierDir, 'component.html'))) {
    publish('ready', { artboards: artboardIndex(listing) });
    publishFiles(listing);
    return;
  }

  if (!haveSeeded) {
    publish('seeding', { artboards: artboardIndex(listing) });
    publishFiles(listing);
  }

  // The helper's ONE write in seeding mode. Asserted before the child is
  // spawned, so §6.4 holds for the child's write as well as for ours.
  const outFile = assertWritable(path.join(buildDir, outName));
  try { fs.mkdirSync(assertWritable(buildDir), { recursive: true }); } catch { /* reported below */ }
  // Seed mode writes --out without the `wx` flag, so a stale output from a
  // previous run is simply replaced rather than refused.

  let argv;
  try { argv = buildArgv(payloadInfo.helper, payloadInfo.payload, outFile, listing); } catch (e) {
    publish('seed-failed', { ok: false, warnings: [], error: 'could not build the seeding command', hint: String((e && e.message) || e) });
    publishFiles(listing);
    return;
  }

  const res = await runHelper(argv);
  if (stopped) return;

  if (res.code !== 0) {
    // CONTRACT §3: the hint is the helper's stderr, VERBATIM — it is written to
    // be read. Only an absurd volume is capped, and the cap says so.
    publish('seed-failed', {
      ok: false,
      warnings: [],
      error: 'seed-canvas.mjs exited ' + res.code + '.',
      hint: truncate((res.stderr || res.stdout || '(no output)').replace(/\s+$/, ''), MAX_CAPTURE_BYTES),
      artboards: artboardIndex(listing),
    });
    publishFiles(listing);
    return;
  }

  let seeded;
  try { seeded = fs.readFileSync(outFile, 'utf8'); } catch (e) {
    publish('seed-failed', {
      ok: false,
      warnings: [],
      error: 'seed-canvas.mjs reported success but ' + outFile + ' is unreadable.',
      hint: String((e && e.message) || e),
      artboards: artboardIndex(listing),
    });
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
    publish('seed-failed', {
      ok: false,
      warnings: [],
      error: 'the seeded page has no readable appifact-doc state block (' + block.reason + ').',
      hint: 'The editor payload on this machine may have changed shape. Re-run `/design` in Claude Code to '
        + 'refresh it, then reseed. If it persists, the payload and this pack have drifted apart.',
      artboards: artboardIndex(listing),
    });
    publishFiles(listing);
    return;
  }
  if (block.state && block.state.store === 'db') {
    publish('live-store', {
      ok: false,
      warnings: [],
      error: 'The seeded page still carries store:"db" — its design lives in a live store, not in the file.',
      hint: 'Refuse it. A live-store canvas cannot be edited from here; open it in its published Artifact instead.',
      artboards: artboardIndex(listing),
    });
    publishFiles(listing);
    return;
  }

  try {
    writeCarrier(seeded);
  } catch (e) {
    publish('seed-failed', {
      ok: false,
      warnings: [],
      error: 'could not write the payload carrier component.',
      hint: String((e && e.message) || e) + '\nCheck that ' + componentsDir + ' is writable.',
      artboards: artboardIndex(listing),
    });
    publishFiles(listing);
    return;
  }

  haveSeeded = true;
  lastFingerprint = listing.fingerprint;
  seededAt = Date.now();
  seededBytes = Buffer.byteLength(seeded, 'utf8');
  seedWarnings = splitWarnings(res.stderr);
  publish('ready', { artboards: artboardIndex(listing) });
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

function queueChange() {
  if (stopped || !watchEnabled) return;
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
      if (!fn || isWatchable(String(fn))) queueChange();
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
  // `bad-dir` is what says so (CONTRACT §3).
  if (under(fenced, buildRoot) || under(fenced, componentsDir)) {
    return bad(
      fenced + ' contains web-chat\'s own ' + path.basename(webChatDir) + ' directory, which is where this service writes.',
      'Point `dir` at the folder that holds the .dc.html artboards — a subdirectory such as '
      + path.join(fenced, 'design') + ' — rather than at the project root. The service never writes inside `dir`, '
      + 'so a `dir` that contains its build directory cannot be seeded at all.');
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
      if (watchEnabled && haveSeeded && dirAbs) {
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
  seededAt = null;
  seededBytes = null;
  seedWarnings = [];
  lastCtlSeq = -Infinity;
  degraded = false;
  seedInFlight = false;
  reseedPending = false;
  forcePending = false;

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

  /* ---- 0. seq floor. MUST run before the first publish, including the failure
   * publishes in resolveUpstream/resolveDir below — see adoptSeqFloor(). The
   * supervisor puts no deadline on the `started` IPC reply (services.js:236-238
   * only flips a status field), so one awaited GET here costs nothing. */
  await adoptSeqFloor();
  if (stopped) return;

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
  seedWarnings = [];
  degraded = false;
  webChatDirParam = null;
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
    // Injection points so the harness can drive the pure paths without a daemon.
    __setState: (s) => {
      if (!s || typeof s !== 'object') return;
      if ('title' in s) title = String(s.title == null ? '' : s.title);
      if ('carrierName' in s) carrierName = s.carrierName;
      if ('mountId' in s) mountId = s.mountId;
      if ('lastCtlSeq' in s) lastCtlSeq = s.lastCtlSeq;
    },
  },
};
