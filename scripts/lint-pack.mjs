#!/usr/bin/env node
// ---------------------------------------------------------------------------
// lint-pack — validate THIS directory as a web-chat component pack, locally.
//
// WHY THIS EXISTS
// web-chat's own pack tooling has no local-directory mode. `pack get` and
// `pack review` both fetch a pushed repository first, so the only way to learn
// that a manifest is malformed is to publish the mistake. That is a terrible
// loop for a pack under construction, and it is avoidable: the validation is
// pure and runs BEFORE any network fetch. This script reaches past the CLI and
// calls it directly against the working tree.
//
// It is NOT a reimplementation. The two functions doing the real work are
// web-chat's own, loaded from the install on this machine:
//
//   lib/packs/manifest.js  parseManifest + validateManifest
//                          — the schema pass; every refusal the installer makes
//   lib/packs/plan.js      planInstall + COMPONENT_FILES
//                          — the pure "what would be written" pass the CLI and
//                            the drawer both gate on
//
// So when web-chat changes its rules, this script changes with it for free.
//
// ON TOP OF THAT it enforces the invariants in CONTRACT.md §9.4 and §9.6 that
// web-chat itself does not check, or checks only as a warning. Those are marked
// [wc-design] in the report; web-chat's own findings are marked [web-chat].
// Three matter especially:
//
//   * The manifest's `components` is an explicit ALLOWLIST. web-chat only walks
//     it forwards (listed -> does the directory exist?). It never walks it
//     backwards, so a component directory nobody listed installs nothing, ships
//     nothing, and reports nothing. That is the single easiest way to lose a
//     component, and it is an error here.
//   * A component directory's name IS its identity (the registry resolves by
//     directory; meta.json's `name` is cosmetic). web-chat downgrades a
//     mismatch to a warning; CONTRACT §9.4 makes it a defect, because the
//     component lists under one name and is unspawnable under the other.
//   * `requires."web-chat"` must actually EXCLUDE 0.6.x. `>=0.6.0` installs
//     happily on 0.6.x, where `use_component` ignores `signals` — the pack
//     silently loses its wake path. We probe the range with web-chat's own
//     `satisfies` rather than string-matching it, which also catches ranges its
//     grammar cannot parse (those are treated as satisfied-always, so they
//     enforce nothing).
//
// Usage:
//   node scripts/lint-pack.mjs            # human-readable report
//   node scripts/lint-pack.mjs --json     # machine-readable
//   node scripts/lint-pack.mjs --strict   # warnings are errors, and a missing
//                                         # web-chat install is an error too
//
// Exit 0 clean, 1 on any error. If web-chat is not installed the lint SKIPS
// with a clear message and exits 0 — same stance as check-no-vendored outside a
// git repo — so a CI box without web-chat is not held hostage. `--strict` turns
// that skip into a failure.
//
// Set WEB_CHAT_LIB to point at a specific install's lib/ directory to override
// discovery.
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, delimiter, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const STRICT = argv.includes('--strict');

// --- finding collection ----------------------------------------------------
// Every finding carries WHO said it, so a reader can tell "the installer will
// refuse this" from "our own contract forbids this".
const errors = [];
const warnings = [];
const notes = [];
const err = (source, msg) => errors.push({ source, msg });
const warn = (source, msg) => warnings.push({ source, msg });
const note = (msg) => notes.push(msg);

// --- locating web-chat's own library ---------------------------------------
// Four strategies, most explicit first. No path in this file is hardcoded to a
// home directory (CONTRACT §9.6); the home-relative ones are built at runtime.
function libCandidates() {
  const out = [];
  if (process.env.WEB_CHAT_LIB) out.push(process.env.WEB_CHAT_LIB);

  // The installed CLI on PATH is a symlink into the active version directory,
  // so realpath'ing it is the most reliable answer: it tracks whatever version
  // the user actually runs.
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '', '.js'] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const bin = join(dir, `claude-web-chat${ext}`);
      if (!existsSync(bin)) continue;
      try {
        // <root>/bin/claude-web-chat.js -> <root>/lib
        out.push(join(dirname(dirname(realpathSync(bin))), 'lib'));
      } catch { /* unreadable link; try the next one */ }
    }
  }

  const wc = join(homedir(), '.web-chat');
  out.push(join(wc, 'current', 'lib'));

  // Last resort: every installed version, newest first.
  try {
    const versions = readdirSync(join(wc, 'versions'))
      .filter((v) => /^\d/.test(v))
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
        return 0;
      });
    for (const v of versions) out.push(join(wc, 'versions', v, 'lib'));
  } catch { /* no versions directory */ }

  return out;
}

function resolveWebChatLib() {
  const seen = new Set();
  for (const cand of libCandidates()) {
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);
    if (existsSync(join(cand, 'packs', 'manifest.js')) && existsSync(join(cand, 'packs', 'plan.js'))) return cand;
  }
  return null;
}

// --- helpers ---------------------------------------------------------------
function readJSON(file) {
  try { return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }; }
  catch (e) { return { ok: false, error: e.message, missing: !existsSync(file) }; }
}

function dirsIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch { return null; }
}

// CONTRACT §9.6 — no personal data in a tracked file. Bounded deliberately: the
// pack's own installable surface, where a leaked path would actually be
// published, not the research notes.
const PERSONAL = [
  [/\/Users\/[A-Za-z0-9._-]+/g, 'an absolute macOS home path'],
  [/\/home\/[A-Za-z0-9._-]+/g, 'an absolute Linux home path'],
  [/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, 'an absolute Windows home path'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'an email address'],
];
const PERSONAL_OK = /^(?:.*@(?:example\.(?:com|org|net)|test|localhost)|\/(?:Users|home)\/(?:you|me|user|username|path))$/i;

function scanPersonal(abs, rel) {
  let text;
  try {
    if (statSync(abs).size > 512 * 1024) return;          // the tripwire owns size
    text = readFileSync(abs, 'utf8');
  } catch { return; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const [re, what] of PERSONAL) {
      re.lastIndex = 0;
      for (const m of lines[i].matchAll(re)) {
        if (PERSONAL_OK.test(m[0])) continue;
        err('wc-design', `${rel}:${i + 1}: ${what} (${JSON.stringify(m[0])}) — CONTRACT §9.6 forbids it in a tracked file. Write /path/to/… or ~ instead.`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
function main() {
  const lib = resolveWebChatLib();
  if (!lib) {
    const msg = [
      'lint-pack SKIPPED — claude-web-chat is not installed on this machine, so its',
      'pack validator cannot be called. Install it, or point WEB_CHAT_LIB at an',
      "install's lib/ directory. Re-run with --strict to make this a failure.",
    ].join('\n');
    // A lint that passes because it could not run is the vacuous-check problem.
    // We still exit 0 (a CI box without web-chat must not be held hostage), but
    // on Actions we raise an annotation so the green tick is not mistaken for a
    // clean validation.
    if (process.env.GITHUB_ACTIONS) {
      console.log('::warning title=lint-pack did not run::claude-web-chat is not installed on this runner, so the pack validator was skipped. This step is green but validated nothing.');
    }
    if (JSON_OUT) console.log(JSON.stringify({ ok: !STRICT, skipped: true, reason: 'web-chat not installed' }, null, 2));
    else console.error(msg);
    process.exit(STRICT ? 1 : 0);
  }

  const { parseManifest, validateManifest, satisfies, reservedComponentNames } = require(join(lib, 'packs', 'manifest.js'));
  const { planInstall, COMPONENT_FILES } = require(join(lib, 'packs', 'plan.js'));
  const { packageVersion } = require(join(lib, 'core', 'versions.js'));
  const webChatVersion = packageVersion();

  // --- the manifest exists and is JSON -------------------------------------
  let manifest;
  try {
    manifest = parseManifest(REPO);
  } catch (e) {
    err('web-chat', e.message);
    return report({ lib, webChatVersion, components: [] });
  }

  // The pack's identity is the manifest's `name`, not whatever the checkout
  // directory happens to be called — a clone into `wc-design-2` or a CI
  // workspace named after the branch must still report the pack it is linting.
  const packName = typeof manifest.name === 'string' && manifest.name.trim()
    ? manifest.name.trim()
    : null;

  // --- web-chat's own schema pass ------------------------------------------
  const v = validateManifest(manifest, { stageDir: REPO, webChatVersion });

  const listed = Array.isArray(manifest.components)
    ? manifest.components.filter((c) => typeof c === 'string').map((c) => c.trim()).filter(Boolean)
    : [];
  const componentsDir = join(REPO, 'components');
  const entries = dirsIn(componentsDir);
  const present = entries ? entries.filter((e) => e.isDir).map((e) => e.name) : [];
  const missingDirs = new Set(listed.filter((c) => !present.includes(c)));

  for (const m of v.errors) {
    // A listed component whose DIRECTORY is absent gets a precise error below;
    // web-chat's "component.html is missing" would conflate the two cases.
    const conflated = /^component "([^"]+)": components\/[^/]+\/component\.html is missing$/.exec(m);
    if (conflated && missingDirs.has(conflated[1])) continue;
    err('web-chat', m);
  }
  for (const m of v.warnings) {
    // Re-classified as an error below (CONTRACT §9.4).
    if (/meta\.json says name/.test(m)) continue;
    warn('web-chat', m);
  }

  // --- the allowlist must match the directories present [wc-design §9.4] ----
  if (entries === null) {
    err('wc-design', 'components/ does not exist — a pack with no components/ directory installs only its skill.');
  } else {
    for (const c of missingDirs) {
      err('wc-design', `component "${c}" is in the manifest allowlist but components/${c}/ does not exist.`);
    }
    for (const e of entries) {
      if (!e.isDir) {
        warn('wc-design', `components/${e.name} is a file, not a component directory — it is ignored by the installer.`);
        continue;
      }
      if (!listed.includes(e.name)) {
        err('wc-design',
          `components/${e.name}/ exists but is not listed in the manifest's "components" allowlist — ` +
          'it would install nothing and report nothing. Add it, or delete the directory.');
      }
      // Independent of the allowlist: a builtin-named directory is a refusal no
      // matter how it got there, and there is no override.
      if (reservedComponentNames().includes(e.name)) {
        err('wc-design',
          `components/${e.name}/ collides with a built-in component name. A pack copy would shadow the ` +
          'built-in permanently — web-chat only repairs a component whose meta.json says builtin. Rename it.');
      }
    }
  }

  // --- per-component unit shape [wc-design §9.4] ---------------------------
  const components = [];
  for (const c of listed) {
    if (missingDirs.has(c)) continue;
    const dir = join(componentsDir, c);
    const rec = { name: c, has_service: false, has_seed: false, meta_name: null };

    // A missing component.html is web-chat's own error, already collected
    // above; do not say it twice.

    const meta = readJSON(join(dir, 'meta.json'));
    if (!meta.ok) {
      err('wc-design', meta.missing
        ? `component "${c}": components/${c}/meta.json is missing. Without it the component lists with no description and no params_schema.`
        : `component "${c}": components/${c}/meta.json is not valid JSON — ${meta.error}`);
    } else {
      rec.meta_name = meta.value.name ?? null;
      if (rec.meta_name == null) {
        err('wc-design', `component "${c}": meta.json has no "name". CONTRACT §9.4 — the directory name is the identity and meta.json must agree with it.`);
      } else if (rec.meta_name !== c) {
        err('wc-design',
          `component "${c}": meta.json says name ${JSON.stringify(rec.meta_name)}. The registry resolves by DIRECTORY, ` +
          `so the component would list as one name and be unspawnable under the other (CONTRACT §9.4).`);
      }
      if (!meta.value.description) {
        warn('wc-design', `component "${c}": meta.json has no "description" — it is what Claude reads in list_components to decide the component is relevant.`);
      }
    }

    // Exactly four files install. Anything else in the directory is silently
    // dropped by the installer, which is how a helper module that service.js
    // imports goes missing on someone else's machine (CONTRACT §6.2, §9.4).
    const found = dirsIn(dir) || [];
    const extras = found.filter((f) => !COMPONENT_FILES.includes(f.name)).map((f) => f.name);
    if (extras.length) {
      err('wc-design',
        `component "${c}": ${extras.map((x) => `components/${c}/${x}`).join(', ')} will NOT install. ` +
        `A component is exactly ${COMPONENT_FILES.join(', ')} (CONTRACT §9.4).`);
    }
    rec.has_service = found.some((f) => f.name === 'service.js');
    rec.has_seed = found.some((f) => f.name === 'seed.js');
    components.push(rec);
  }

  // --- the requires range [wc-design §9.4] ---------------------------------
  const req = manifest.requires && manifest.requires['web-chat'];
  if (!req) {
    err('wc-design', 'web-chat-pack.json: requires."web-chat" is missing. CONTRACT §9.4 requires ">=0.7.0" — without it the pack installs on 0.6.x, where use_component ignores `signals` and the pack silently loses its wake path.');
  } else {
    // Probe the range with web-chat's own grammar rather than comparing
    // strings: this also catches a range its parser cannot read, which it
    // treats as satisfied-always and which therefore enforces nothing. Those
    // two failures deserve different sentences, so detect the unparseable
    // shapes the same way lib/packs/manifest.satisfies bails on them.
    const UNPARSEABLE = /[xX*]|\|\||\s-\s/.test(String(req)) || !String(req).trim();
    const CONSEQUENCE =
      'On 0.6.x `use_component` has no `signals`, so this pack would install happily and silently lose its ' +
      'wake path. CONTRACT §9.4 requires ">=0.7.0".';
    if (UNPARSEABLE) {
      err('wc-design',
        `web-chat-pack.json: requires."web-chat" is ${JSON.stringify(req)} — an x-range, disjunction or hyphen range. ` +
        "web-chat's range grammar does not implement those and treats them as SATISFIED BY ANY VERSION, so this " +
        `range enforces nothing at all. ${CONSEQUENCE}`);
    } else if (satisfies('0.6.9', req).ok) {
      err('wc-design',
        `web-chat-pack.json: requires."web-chat" is ${JSON.stringify(req)}, which ADMITS web-chat 0.6.x. ${CONSEQUENCE}`);
    }
    if (!satisfies('0.7.0', req).ok) {
      warn('wc-design', `web-chat-pack.json: requires."web-chat" is ${JSON.stringify(req)}, which excludes 0.7.0. CONTRACT §9.4 specifies ">=0.7.0".`);
    }
  }

  // --- web-chat's own plan pass --------------------------------------------
  // planInstall is pure — it writes nothing — but it resolves against a project
  // root to find collisions. We give it an EMPTY one on purpose: a component
  // that happens to be installed on this machine is an install-time condition,
  // not a defect in the pack, and a lint must give the same answer everywhere.
  let planRoot = null;
  try {
    planRoot = mkdtempSync(join(tmpdir(), 'wc-design-lint-'));
    const plan = planInstall({ stageDir: REPO, manifest: v, tier: 'local', root: planRoot });
    const already = new Set(errors.map((e) => e.msg));
    for (const m of plan.errors) if (!already.has(m)) err('web-chat', m);
    for (const u of plan.units.filter((u) => u.kind === 'component')) {
      note(`would install components/${u.name}/ — ${u.files.map((f) => f.path).join(', ')}`);
    }
    if (plan.skill) note(`would install SKILL.md -> ${plan.skill.dest}`);
    if (plan.services.length) note(`service-backed: ${plan.services.join(', ')} — first mount waits on \`claude-web-chat trust <name>\``);
  } catch (e) {
    err('web-chat', `planInstall failed: ${e.message}`);
  } finally {
    if (planRoot) { try { rmSync(planRoot, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  // --- a service-backed pack must name the trust command [wc-design §6.5] ---
  const services = components.filter((c) => c.has_service).map((c) => c.name);
  if (services.length) {
    const skillFile = join(REPO, 'SKILL.md');
    const skillText = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : null;
    if (skillText == null) {
      err('wc-design',
        `this pack ships host code (${services.join(', ')}/service.js) but has no SKILL.md. ` +
        'Nothing would ever tell Claude to say `claude-web-chat trust` in chat, so the pane mounts and sits empty forever (CONTRACT §6.5).');
    } else if (!/claude-web-chat\s+trust/.test(skillText)) {
      err('wc-design',
        'SKILL.md never mentions `claude-web-chat trust`. A service does not start until the user runs that command ' +
        'in a TERMINAL — the surface cannot grant it — so the pane sits empty until someone guesses (CONTRACT §6.5).');
    }
  }

  // --- CONTRACT §9.6 -------------------------------------------------------
  const personalTargets = [
    'web-chat-pack.json',
    'SKILL.md',
    'package.json',
    ...(entries || []).filter((e) => e.isDir).flatMap((e) => (dirsIn(join(componentsDir, e.name)) || []).map((f) => `components/${e.name}/${f.name}`)),
  ];
  for (const rel of personalTargets) {
    const abs = join(REPO, rel);
    if (existsSync(abs) && statSync(abs).isFile()) scanPersonal(abs, rel);
  }

  return report({ lib, webChatVersion, components, packName });
}

// ---------------------------------------------------------------------------
function report({ lib, webChatVersion, components, packName = null }) {
  const ok = errors.length === 0 && (!STRICT || warnings.length === 0);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok, pack: packName ?? basename(REPO), lib, web_chat_version: webChatVersion,
      errors, warnings, notes, components,
    }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  console.log(`lint-pack   ${packName ?? basename(REPO)}`);
  console.log(`validator   web-chat ${webChatVersion} (${lib})`);
  if (notes.length) {
    console.log('');
    for (const n of notes) console.log(`  · ${n}`);
  }
  if (warnings.length) {
    console.log('');
    for (const w of warnings) console.log(`  warning [${w.source}]  ${w.msg}`);
  }
  if (errors.length) {
    console.error('');
    for (const e of errors) console.error(`  ERROR [${e.source}]  ${e.msg}`);
    console.error(`\nlint-pack FAILED — ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`);
    console.error('[web-chat] findings are refusals its installer would make; [wc-design] findings are CONTRACT.md invariants.');
    process.exit(1);
  }
  if (STRICT && warnings.length) {
    console.error(`\nlint-pack FAILED (--strict) — ${warnings.length} warning${warnings.length === 1 ? ' treated as an error' : 's treated as errors'}.`);
    process.exit(1);
  }
  console.log(`\nlint-pack ok — ${components.length} component${components.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`);
  process.exit(0);
}

main();
