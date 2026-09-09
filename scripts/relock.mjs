#!/usr/bin/env node
// Regenerate upstream.lock.json from the payload currently installed on this
// machine. Run after a Claude Code upgrade, once you have confirmed the canvas
// pane still mounts against the new payload.
import { resolvePayload, readLock } from './find-payload.mjs';
import { statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const found = resolvePayload();
if (!found.ok) { console.error(found.hint || found.reason); process.exit(1); }

const prev = readLock();
const lock = {
  _comment: prev?._comment ?? [],
  claude_code_version: found.version,
  payload_file: 'payload.template.html',
  payload_sha256: found.payload_sha256,
  payload_bytes: statSync(found.payload).size,
  helper_file: 'seed-canvas.mjs',
  helper_sha256: found.helper_sha256,
  helper_bytes: statSync(found.helper).size,
  tested_against: prev?.tested_against ?? {},
  notes: prev?.notes ?? '',
};
writeFileSync(join(REPO, 'upstream.lock.json'), JSON.stringify(lock, null, 2) + '\n');

if (prev && prev.payload_sha256 !== lock.payload_sha256) {
  console.log(`payload changed: ${prev.claude_code_version} -> ${lock.claude_code_version}`);
  console.log(`  ${prev.payload_sha256.slice(0, 16)}… -> ${lock.payload_sha256.slice(0, 16)}…`);
} else {
  console.log('lock refreshed (payload unchanged)');
}
