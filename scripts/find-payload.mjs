#!/usr/bin/env node
// ---------------------------------------------------------------------------
// find-payload — locate the Claude Design canvas editor on THIS machine.
//
// check-no-vendored: names upstream markers for detection, ships none
// (TEMPLATE_MARKER below is how we RECOGNISE the payload. The string is a
// fingerprint, not payload content — see scripts/check-no-vendored.mjs.)
//
// This pack is a wrapper. It ships none of Anthropic's code. The editor payload
// (payload.template.html, ~2.4 MB) and its seeding helper (seed-canvas.mjs) are
// read from the copy Claude Code itself writes to the user's temp directory when
// the bundled `design` skill runs. That is ordinary use of installed software:
// we read files the user's own tools put on the user's own disk.
//
// WHAT WE DELIBERATELY DO NOT DO
// The same assets are also embedded in the Claude Code executable as compressed
// frames, and pulling them out of it works. We do not do that and this repo will
// not carry code that does: Anthropic's terms prohibit reducing the Services to
// human-readable form, and shipping a tool that does it publicly is worse than
// doing it privately. If the temp copy is absent, the remedy is to run `/design`
// once in Claude Code so it materialises the copy in the supported way.
//
// Usage:
//   node scripts/find-payload.mjs             # human-readable report
//   node scripts/find-payload.mjs --json      # machine-readable
//   node scripts/find-payload.mjs --verify    # also check against upstream.lock.json
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// Claude Code's temp root is NOT $TMPDIR. It is `CLAUDE_CODE_TMPDIR` or the
// hardcoded literal "/tmp" (which macOS resolves through a symlink to
// /private/tmp — the only reason the observed path looks like that).
const TMP_ROOT = process.env.CLAUDE_CODE_TMPDIR || '/tmp';
// Under that root the tree is uid-scoped: /tmp/claude-<uid>/bundled-skills/...
// Older/other builds have been seen without the claude-<uid> segment, so try
// both rather than hardcoding one shape.
const BUNDLED_ROOTS = [
  join(TMP_ROOT, `claude-${typeof process.getuid === 'function' ? process.getuid() : ''}`, 'bundled-skills'),
  join(TMP_ROOT, 'bundled-skills'),
];

const PAYLOAD = 'payload.template.html';
const HELPER = 'seed-canvas.mjs';
// The one string that proves a file is an unseeded editor template.
const TEMPLATE_MARKER = 'APPIFACT-TITLE-PLACEHOLDER';

function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// Compare two version strings ("2.1.263") numerically, descending.
function cmpVersion(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/* ── OWNERSHIP GATE ─────────────────────────────────────────────────────────
 *
 * !! DUPLICATED IN components/design-canvas/service.js — KEEP THE TWO IN SYNC !!
 *
 * The second search root, the bare `<tmp>/bundled-skills`, sits directly under a
 * world-writable sticky directory (`/private/tmp` is `drwxrwxrwt`), so ANY local
 * principal can create it. `findCandidates` ranks by version string and the only
 * content test is a 25-byte marker, so a planted `<tmp>/bundled-skills/99.0.0/`
 * would outrank the real install — and the service SPAWNS the helper it finds
 * and mounts the result same-origin with the daemon (CONTRACT §9.2/§9.3).
 *
 * So: every level from the search root down to `design/`, plus both files in it,
 * must be owned by this uid, must not be a symlink, and must not be group- or
 * world-writable. The supported tree passes untouched (`drwx------` throughout,
 * `-rw-------` on both files). No-op where POSIX ownership does not apply.
 */
const TRUST_UID = typeof process.getuid === 'function' ? process.getuid() : null;

function trustedEntry(p, wantDir) {
  if (TRUST_UID === null) return true;      // non-POSIX: no ownership model
  let st;
  // lstat, never stat: a symlink in this chain is an attacker redirect, never
  // something the design skill writes.
  try { st = lstatSync(p); } catch { return false; }
  if (st.isSymbolicLink()) return false;
  if (wantDir ? !st.isDirectory() : !st.isFile()) return false;
  if (st.uid !== TRUST_UID) return false;
  return (st.mode & 0o022) === 0;           // no group / other write
}

// Returns null when the candidate is trustworthy, else the first path that is not.
function untrustedPath(bundled, version, nonce, dir, payload, helper) {
  const dirs = [bundled, join(bundled, version), join(bundled, version, nonce), dir];
  for (const d of dirs) if (!trustedEntry(d, true)) return d;
  if (!trustedEntry(payload, false)) return payload;
  if (!trustedEntry(helper, false)) return helper;
  return null;
}

// Enumerate every design skill directory the local install has materialised.
//
// Layout: <tmp>/bundled-skills/<claude-version>/<nonce>/design/
// The 32-hex segment is NOT a content hash — it is randomBytes(16).toString('hex'),
// a fresh per-process nonce. Sibling nonce dirs accumulate and are unpredictable,
// so never treat one as a stable key: enumerate, then rank.
export function findCandidates() {
  const out = [];
  for (const bundled of BUNDLED_ROOTS) {
    for (const version of safeReaddir(bundled)) {
      const vDir = join(bundled, version);
      for (const nonce of safeReaddir(vDir)) {
        const dir = join(vDir, nonce, 'design');
        const payload = join(dir, PAYLOAD);
        const helper = join(dir, HELPER);
        if (!existsSync(payload) || !existsSync(helper)) continue;
        let mtime = 0;
        try { mtime = statSync(payload).mtimeMs; } catch { continue; }
        const untrusted = untrustedPath(bundled, version, nonce, dir, payload, helper);
        out.push({ version, nonce, dir, payload, helper, mtime, untrusted });
      }
    }
  }
  // Newest version wins; within a version, the most recently written nonce.
  out.sort((a, b) => cmpVersion(a.version, b.version) || b.mtime - a.mtime);
  return out;
}

// Resolve the single best candidate, verified.
export function resolvePayload() {
  const candidates = findCandidates();
  const refused = [];
  for (const c of candidates) {
    // Enforced before any read: this decides whose code the service spawns.
    if (c.untrusted) { refused.push(c); continue; }
    let head;
    try {
      // Read only the first 64 KB to sniff the marker — the file is 2.4 MB and
      // nothing downstream needs it in memory here.
      const fd = readFileSync(c.payload);
      head = fd.subarray(0, 65536).toString('utf8');
      if (!head.includes(TEMPLATE_MARKER)) continue;
      return {
        ok: true,
        ...c,
        payload_sha256: sha256(c.payload),
        helper_sha256: sha256(c.helper),
        others: candidates.length - 1,
        refused: refused.map((r) => r.untrusted),
      };
    } catch {
      continue;
    }
  }
  return {
    ok: false,
    reason: refused.length
      ? 'untrusted-candidate'
      : candidates.length ? 'no-valid-template' : 'not-materialised',
    searched: BUNDLED_ROOTS.join(' , '),
    refused: refused.map((r) => r.untrusted),
    hint:
      'Run `/design` once in Claude Code. The design skill materialises the canvas ' +
      'editor into the temp directory on first use; this pack reads that copy and ' +
      'never ships one of its own.',
  };
}

export function readLock() {
  const p = join(REPO, 'upstream.lock.json');
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function main() {
  const json = process.argv.includes('--json');
  const verify = process.argv.includes('--verify');
  const found = resolvePayload();

  const refused = Array.isArray(found.refused) ? found.refused : [];

  if (!found.ok) {
    if (json) { console.log(JSON.stringify(found, null, 2)); process.exit(1); }
    if (refused.length) {
      console.error(`design payload REFUSED — ${refused.length} candidate(s) this user does not exclusively own:`);
      for (const r of refused) console.error(`  ${r}`);
      console.error('That path is not Claude Code\'s: the real one lives under');
      console.error('  <tmp>/claude-<uid>/bundled-skills/  (mode 0700, owned by you)');
      console.error('Delete it, or if it is yours, strip group and other write permission from it');
      console.error('and everything above it. design-canvas runs that helper and mounts its output');
      console.error('same-origin with the daemon, so it will not load a payload anyone else can write.');
      process.exit(1);
    }
    console.error(`design payload not found under ${found.searched}`);
    console.error(found.hint);
    process.exit(1);
  }

  const lock = verify ? readLock() : null;
  let drift = null;
  if (lock) {
    drift = {
      version: lock.claude_code_version !== found.version,
      payload: lock.payload_sha256 !== found.payload_sha256,
      helper: lock.helper_sha256 !== found.helper_sha256,
    };
  }

  if (json) {
    console.log(JSON.stringify({ ...found, lock, drift }, null, 2));
    return;
  }

  console.log(`claude code   ${found.version}`);
  console.log(`design dir    ${found.dir}`);
  console.log(`payload       ${found.payload_sha256.slice(0, 16)}…`);
  console.log(`helper        ${found.helper_sha256.slice(0, 16)}…`);
  if (found.others) console.log(`other copies  ${found.others} (older or superseded)`);
  if (refused.length) {
    console.log(`REFUSED       ${refused.length} candidate(s) this user does not exclusively own — NOT used:`);
    for (const r of refused) console.log(`              ${r}`);
    console.log('              Nothing is broken, but that path should not exist; delete it.');
  }
  if (drift) {
    const changed = Object.entries(drift).filter(([, v]) => v).map(([k]) => k);
    console.log(
      changed.length
        ? `DRIFT         ${changed.join(', ')} differ from upstream.lock.json — ` +
          'the local install moved ahead. Re-run with `npm run relock` after checking the pane still works.'
        : 'lock          matches upstream.lock.json',
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
