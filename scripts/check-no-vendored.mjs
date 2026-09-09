#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-no-vendored — the tripwire that keeps this repo publishable.
//
// This pack wraps Anthropic's Claude Design canvas editor but must never
// redistribute it. That is easy to say and easy to break by accident: a stray
// `cp` while debugging, an over-eager `git add -A`, a test fixture that happens
// to be a seeded canvas. So it is enforced mechanically rather than by care.
//
// Fails if any git-TRACKED file:
//   * matches a sha256 recorded in upstream.lock.json, or
//   * contains the editor's template marker or its state-block signature, or
//   * is implausibly large for a repo that ships only text.
//
// Run in CI and from `npm test`.
//
// NAMING A MARKER IS NOT CARRYING ONE
// Detection code has to spell the marker out — that is how it recognises the
// payload — and CONTRACT §6.2 *requires* that logic to be duplicated inline in
// every component's seed.js/service.js, because a component ships exactly four
// files and cannot import a helper. A path-based exemption list would go stale
// the moment a file is renamed, so the exemption is a pragma the file declares
// about itself, in its own header:
//
//   check-no-vendored: names upstream markers for detection, ships none
//
// It must appear within the first PRAGMA_WINDOW bytes, i.e. in the header, not
// buried in pasted content. It fails closed: a new file that carries a marker
// without the declaration is a hard failure, and the size and hash rules still
// apply to a file that declares it, so a pasted 2.4 MB payload is still caught.
// Markdown is exempt outright — the docs exist to describe this format.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(REPO, 'upstream.lock.json'), 'utf8'));

const BANNED_HASHES = new Set([lock.payload_sha256, lock.helper_sha256]);
// Markers that betray upstream content even if it was edited (so the hash moved).
const BANNED_MARKERS = [
  'APPIFACT-TITLE-PLACEHOLDER',
  'id="appifact-doc"',
  'appifact-capabilities',
];
// Nothing we author comes close. The payload is 2.4 MB.
const MAX_TRACKED_BYTES = 256 * 1024;

// A file declaring this in its header may name the markers above. See the
// header comment for why this is a pragma and not a list of paths.
const PRAGMA = 'check-no-vendored: names upstream markers for detection, ships none';
const PRAGMA_WINDOW = 4096;

let files;
try {
  // git writes its own "fatal: not a git repository" to stderr; we report that
  // ourselves in a form a reader can act on, so drop git's copy.
  files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString('utf8').split('\0').filter(Boolean);
} catch {
  console.error('check-no-vendored: not a git repository — nothing to check.');
  console.error('  NOTHING WAS VERIFIED. This is a no-op, not a pass: the tripwire reads');
  console.error('  `git ls-files`, so it can only assert inside a git checkout. CI requires');
  console.error('  the "check-no-vendored ok" line precisely so this cannot pass vacuously.');
  process.exit(0);
}

const problems = [];
const declared = [];

for (const rel of files) {
  const abs = join(REPO, rel);
  let buf;
  let size;
  try { size = statSync(abs).size; buf = readFileSync(abs); } catch { continue; }

  if (size > MAX_TRACKED_BYTES) {
    problems.push(`${rel}: ${size} bytes exceeds the ${MAX_TRACKED_BYTES}-byte ceiling for tracked files`);
  }

  const hash = createHash('sha256').update(buf).digest('hex');
  if (BANNED_HASHES.has(hash)) {
    problems.push(`${rel}: sha256 matches an upstream artefact recorded in upstream.lock.json — this is Anthropic's code and must not be committed`);
  }

  // Only sniff text; a binary that reached here is already caught by size.
  if (size <= MAX_TRACKED_BYTES) {
    const text = buf.toString('utf8');
    // The docs exist to describe this format, and detection code has to name
    // what it detects — but only when it says so in its own header.
    const exempt = rel.endsWith('.md') || text.slice(0, PRAGMA_WINDOW).includes(PRAGMA);
    const hits = BANNED_MARKERS.filter((m) => text.includes(m));
    if (hits.length && exempt && !rel.endsWith('.md')) declared.push(rel);
    if (hits.length && !exempt) {
      for (const marker of hits) {
        problems.push(
          `${rel}: contains the upstream marker ${JSON.stringify(marker)} — looks like vendored payload content.\n` +
          '      If this file only NAMES the marker in order to detect the payload (CONTRACT §6.2\n' +
          '      makes that duplication mandatory in a component\'s seed.js/service.js), declare it\n' +
          `      by putting this comment in the file's first ${PRAGMA_WINDOW} bytes:\n` +
          `        // ${PRAGMA}`,
        );
      }
    }
  }
}

if (problems.length) {
  console.error('check-no-vendored FAILED\n');
  for (const p of problems) console.error('  ' + p);
  console.error('\nThis repository must ship zero upstream bytes. If the file really does carry');
  console.error('upstream content, delete it and let scripts/find-payload.mjs read the local');
  console.error('install at runtime instead.');
  process.exit(1);
}

const suffix = declared.length
  ? ` (${declared.length} file${declared.length === 1 ? '' : 's'} declare the detection pragma: ${declared.join(', ')})`
  : '';
console.log(`check-no-vendored ok — ${files.length} tracked files, no upstream content${suffix}`);
