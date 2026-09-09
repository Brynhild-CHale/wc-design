# wc-design

A `claude-web-chat` component pack that puts a live Claude Design canvas on the web-chat surface,
seeded from `.dc.html` working files on your own disk. A host-side service watches those files and
re-seeds when they change, so the pane tracks your edits instead of showing a snapshot from ten
minutes ago.

**Status:** v0.1.0 · unreleased  ·  **Components:** one — `design-canvas`, service-backed  ·  **Ships zero upstream bytes**

---

## What you get

One pane, `design-canvas`.

- **A live, file-backed canvas.** Point it at a directory of `.dc.html` artboards (plus an optional
  `canvas.json` layout and any images beside them). The service seeds a real canvas from them and
  publishes it to the pane. Edit an artboard in your editor and the pane re-seeds — `fs.watch`,
  debounced 250 ms — with no turn of Claude's involved.
- **Comment pins over the canvas.** Pin a note to a spot on an artboard the same way you pin one to
  any other pane, and it reaches Claude through the ordinary `get_comments` path, with the ordinary
  shared/private distinction. Pins carry a label like `Pricing.dc.html · 42%,77%`, which is what Claude
  sees. Read the precision caveats in [Limitations](#limitations-in-v010) before you rely on it.
- **The files are the source of truth.** The canvas is a viewer here, not an editor of record. Nothing
  you do in the pane changes a file — the editor boots read-only, so there is nothing on screen to save
  and nothing in the pane to extract. You change a design by editing the `.dc.html` files (by hand, or
  with Claude) and letting the pane re-seed. Claude Design's helper does have a way back into files,
  `--extract`, but it is for pulling down a canvas that was edited *somewhere else* — a published
  Artifact you saved — and you run it yourself; this pack never does.

```js
use_component({
  name: 'design-canvas',
  id: 'design-canvas-main',
  params: { dir: '/path/to/design-work', title: 'Spring Menu Poster', watch: true, routing: 'none' },
  signals: [{ key: 'dsn_ask', wake: 'queue' }],
})
```

| param | required | meaning |
|---|---|---|
| `dir` | **yes** | Absolute path to the directory holding the artboards. Must contain at least one `<Name>.dc.html`. Fenced to the project. |
| `title` | **yes** | What the design is called. Content-named — generic titles are refused. |
| `isolate` | no | Sandbox the canvas frame to an opaque origin. Safer for anything you did not author. **Disables pins.** |
| `watch` | no | Re-seed when files under `dir` change. Default `true`. |
| `routing` | no | Set `'none'`. Comment pins have their own wake path; activity items would be noise. |

Store keys, states and the pin grammar are specified in [`CONTRACT.md`](CONTRACT.md); the research
behind all of it is in [`FINDINGS.md`](FINDINGS.md).

---

## Its relationship to Claude Design

**This is a wrapper. It is not Claude Design, and it contains none of Claude Design.**

Claude Design is Anthropic's canvas editor, shipped inside Claude Code as a bundled skill. When that
skill first runs in a session, Claude Code materialises two files onto your disk: the precompiled
editor (`payload.template.html`, about 2.4 MB) and its seeding helper (`seed-canvas.mjs`). This pack
**reads that copy, at runtime, from your own machine** and serves it to the pane. That is all it does
with it.

Concretely:

- **No Anthropic code is committed to this repository, ever.** Not vendored, not minified, not
  base64'd into a fixture. What is committed is fingerprints — `upstream.lock.json` holds sha256 hashes
  and byte counts, nothing else.
- **Nothing is downloaded.** The pack never fetches the editor from a network, a mirror, or a CDN. If
  the copy is not on your disk, the answer is to run `/design` once in Claude Code so Claude Code writes
  it there itself.
- **Nothing is extracted from the Claude Code binary.** The assets are also embedded in the executable
  and can be decompressed out of it. This repository does not do that and will not carry code that
  does: Anthropic's terms prohibit reducing the Services to human-readable form, and publishing a tool
  that does it is worse than doing it privately.
- **A tripwire enforces it.** `scripts/check-no-vendored.mjs` fails if any tracked file matches a hash
  in `upstream.lock.json`, carries an upstream marker string, or exceeds 256 KB. It runs in CI and from
  `npm test`. The rule is mechanical rather than a matter of care, because "don't `cp` that file into
  the repo while debugging" is exactly the kind of rule care does not keep.

**Not affiliated with, endorsed by, or supported by Anthropic.** The MIT license in
[`LICENSE`](LICENSE) covers the wrapper code in this repository *only*. It does not cover, and this
repository does not redistribute, any part of Claude Design, Claude Code, or the canvas editor
payload those products ship — those remain © Anthropic PBC, all rights reserved, and are used here
only as already installed on your machine. If Claude Design breaks, changes, or goes away, this pack
breaks with it, and no one at Anthropic owes you anything about that.

---

## Requirements

| | |
|---|---|
| **Claude Code** | with the bundled `design` skill available, and run at least once so the payload exists on disk (see [First run](#first-run)). |
| **claude-web-chat** | **`>= 0.7.0`.** Not 0.6.x — see below. |
| **Node** | **`>= 20`.** The service watches `dir` with `node:fs.watch`, non-recursively. |
| **A secure context** | Open the surface on `localhost`, `127.0.0.1`, `*.localhost`, or any `https://` origin. See below — this one bites. |

**Why the 0.7.0 floor and not 0.6.0.** `use_component` only gained the `signals` (and `force`)
parameters in 0.7.0. On 0.6.x a top-level `signals` array is *silently discarded*, so the pack installs
happily, the pane mounts, the "Ask Claude about this canvas" button appears — and the wake never
registers. A silent loss of the handoff path is worse than a refused install, so the floor is 0.7.0.

**The secure-context requirement is not "any local origin".** The canvas editor calls
`crypto.randomUUID` in its artboard handshake, which is undefined outside a secure context. Off one,
the handshake throws, and the canvas hangs on a permanent spinner with the toolbar rendered — it looks
like a slow load rather than a failure. Verified working: `file://`, `http://127.0.0.1`,
`http://localhost`, `http://*.localhost`, any `https://`. Verified broken: every other host over plain
http — a LAN IP, a bare hostname, an mDNS `.local` name. So the obvious next steps (bind `0.0.0.0` so a
phone on the couch can see it, share the surface across the LAN) break the canvas and only the canvas.
The pane detects a non-secure context and warns *before* it mounts the frame rather than letting you
watch a spinner, but the fix is to open the surface on localhost.

---

## Install

```sh
claude-web-chat pack get     https://github.com/<owner>/wc-design   # download for review
claude-web-chat pack review  wc-design                              # read it before you commit
claude-web-chat pack approve wc-design                              # install it
```

`pack install <url>` skips straight to the end if you already know what is in it. Pin with
`--ref <tag-or-sha>`; add `--global` to install for every project instead of this one.

Then mount a canvas, and **approve the service in your terminal**:

```sh
claude-web-chat trust                 # what is waiting, with its params
claude-web-chat trust design-canvas   # approve it
claude-web-chat trust design-canvas --deny
```

The pane cannot grant this and no button on the surface can, by design: pane scripts run in the
surface's own realm, so anything delivered to the page is readable by the very code the gate exists to
gate. Only a real shell writes the approval.

Consent is keyed on **(project root, `service.js` bytes, params)**. Practical consequences:

- every project asks separately, including after a `--global` install;
- any edit to `service.js` — including a version bump of this pack — asks again;
- **changing `dir` asks again**, because `dir` is what the service is allowed to read. Approving one
  directory must not silently approve another.

What you are approving: a Node process that reads `.dc.html` files, `canvas.json` and images under
`dir`, spawns Claude Code's own `seed-canvas.mjs` against them, and writes the result into
`.web-chat/`. **It never writes to `dir`.** The working files are yours; any code path that creates,
modifies or deletes a file under `dir` is a bug, not a tradeoff.

---

## First run

The editor payload does not exist on a fresh machine. Claude Code writes it out the first time the
bundled `design` skill runs in a session, so:

```
Run /design once in Claude Code.
```

That is the supported path and the whole of it. After that:

```sh
node scripts/find-payload.mjs            # human-readable report
node scripts/find-payload.mjs --json     # machine-readable
node scripts/find-payload.mjs --verify   # also diff against upstream.lock.json
```

It enumerates every design directory the local install has materialised and reports the one it picked.
The `other copies` row appears only when there is more than one; the `lock` row only under `--verify`:

```
claude code   2.1.263
design dir    <tmp>/claude-<uid>/bundled-skills/2.1.263/<nonce>/design
payload       76a2b0a4e5d4efcc…
helper        31a2a1528c7a30b6…
other copies  3 (older or superseded)
lock          matches upstream.lock.json
```

Two details worth knowing, because both are easy to get wrong by guessing: the temp root is
`CLAUDE_CODE_TMPDIR` or the hardcoded literal `/tmp`, never `$TMPDIR`; and the 32-hex path segment is a
fresh per-process nonce, not a content hash, so sibling directories accumulate and none of them is a
stable key. `find-payload` enumerates and ranks by version then mtime instead of predicting a path. If
it finds nothing it exits non-zero and tells you to run `/design`.

### What `upstream.lock.json` is for

Provenance, and only provenance. It records the Claude Code version, the sha256 and byte count of the
payload and helper this pack was last verified against, and the web-chat and Node versions it was
tested on. It holds **no upstream bytes**.

It has two consumers:

- `find-payload --verify` compares it against what is installed and prints `DRIFT` when the local
  install has moved ahead. **Drift is informational, not fatal** — the service seeds against whatever
  is actually installed and never consults the lock. It just means "nobody has confirmed the pane still
  mounts against this payload yet."
- `check-no-vendored.mjs` uses its hashes as the banned list for the tripwire.

After a Claude Code upgrade: mount a canvas, confirm it still works, then `node scripts/relock.mjs` to
re-record. In that order — relocking first records a payload nobody has tested.

---

## Limitations in v0.1.0

Stated plainly, because every one of them is a thing the pane looks like it should do.

- **No in-pane save, and no in-pane editing.** Claude Design's WYSIWYG Save path needs a
  `claude.self.publish` host capability; this pack deliberately serves no host object at all, so the
  editor boots read-only — pan, zoom, look. There is no Save button to press and nothing on screen to
  extract. You change the design by editing the `.dc.html` files and letting the pane re-seed. If you
  want real visual editing with a Save button, publish the canvas as an Artifact and edit it there.
- **Pins are artboard-fraction precise, not element precise.** A pin lands at "42%, 77% of
  `Pricing.dc.html`", not "this heading". Element-level anchoring needs a capability object injected
  into the frame; that is v0.2.
- **No `reveal()`.** Clicking a pin whose artboard is scrolled off-screen cannot recentre the canvas.
  Such a pin docks to the pane corner with its label rather than dead-clicking — but you still have to
  pan there yourself.
- **Anchors can drift.** A fraction anchor survives an artboard rewrite and then points confidently at
  whatever moved into that spot. The pane fingerprints the artboard at pin time and marks a marker
  **"may have moved"** when the fingerprint changed, which is honest but is not a fix.
- **`isolate: true` means no pins at all.** An opaque-origin frame cannot be read from the pane. It is
  the right setting for viewing something you did not author, and it costs the entire comment feature.
- **Claude cannot create a pin.** There is no `add_comment` tool — only `get_comments` and
  `reply_comment`. Pins are yours to place; Claude reads and replies.
- **Node previews and glance cards show a placeholder, not the canvas.** The preview CSP is
  `default-src 'none'` with `connect-src 'none'`, so both the frame and the fetch die there. The pane
  detects `/preview/` and renders a static card instead of an empty box.
- **A frozen `export` shows a placeholder too, and drops the pins.** See below — for a canvas it is the
  wrong export.

---

## Sharing a canvas

**Send the seeded `.html` file.** Not a web-chat export.

A seeded canvas is genuinely self-contained — verified in a real browser over CDP: zero page errors,
zero failed subresource requests, nothing fetched. Every absolute URL in the 2.4 MB file is an XML
namespace or a doc-string host. It has no service worker, no `XMLHttpRequest`, no `WebSocket`, no
`EventSource`. Open it from disk and the canvas renders, pans, zooms and exports to PNG/PDF, with no
server and no network. `file://` is a secure context, so the requirement above is satisfied for free.

web-chat's own `export` is the wrong tool for this pane, for two independent reasons:

1. **It drops the comments.** A graph node is `{ mounts, store, comments }`, but the export assembler
   takes `{ mounts, store, page, meta }` — pin threads do not survive the trip.
2. **The frame comes up empty.** The export runs pane scripts inside the exported file, so the pane's
   `fetch('/api/components/…')` executes against no server and fails. The pane catches that and says
   *"this canvas exports as its own file"* rather than rendering a blank box — which is the best it can
   do, and is still not a canvas.

Use `export` for the rest of a node if you want the surrounding panes. For the design itself, hand over
the file.

---

## A note on security

The canvas is mounted by writing `srcdoc`, which means the frame **inherits the surface's origin**.
That is not incidental — the editor's host contract is a plain JavaScript object on `globalThis`, with
no postMessage protocol anywhere, so a cross-origin frame is structurally impossible rather than merely
degraded. Same-origin is the only way this works at all.

It also means the frame sits inside the daemon's trust boundary, and the whole daemon API is behind
nothing but a Host header. Code running in that realm can read every private pin *with its text*, forge
a pin into Claude's context, and reach `POST /api/packs/install`. That is inherent to the capability
path, not to any choice made here.

Two invariants are what make it acceptable, and they are non-negotiable ([`CONTRACT.md`](CONTRACT.md)
§9.2, §9.3):

1. **Only ever display canvases seeded from your own local files.** Never a published Artifact URL,
   never someone else's canvas, never a design that arrived over a network. The content in that frame is
   then Anthropic's editor plus your own design — not untrusted cross-user input. The pack has no code
   path that loads a canvas from anywhere but `dir`, and `dir` itself is fenced to the project so a
   value written by a pane cannot escape it.
2. **The service never serves `claude.db` or `claude.use`.** With no host capabilities the editor boots
   read-only from its own embedded seed and never fetches published content. This is the payload's own
   designed fallback, not a hack: absence is the off switch.

On top of those, everything read *out* of the frame is treated as hostile input — anchors are validated
against a grammar (≤ 1024 chars, ≤ 10 selector segments, final segment matching the payload's own
pattern) before they become durable data, and any label read from canvas content is capped at 60
characters and sanitised. The web-chat server stores an anchor verbatim with zero validation, so that
check has to happen here.

If you want to look at a canvas you did not author, use `isolate: true` and accept losing pins. That is
what it is for.

---

## Repository layout

```
wc-design/
├─ web-chat-pack.json          manifest; `components` is an explicit allowlist
├─ SKILL.md                    agent-facing: when to mount this and how to drive it
├─ README.md                   this file
├─ CONTRACT.md                 the normative interface — params, store keys, states, invariants
├─ FINDINGS.md                 the verified research the contract rests on
├─ LICENSE                     MIT, wrapper code only, with the non-affiliation notice
├─ upstream.lock.json          fingerprints of the payload this was verified against
├─ components/design-canvas/   component.html · meta.json · seed.js · service.js
├─ dev-notes/                  maintainer notes — architecture, extending, web-chat platform
├─ scratch/anchor-lib.js       the anchor grammar; source, inlined into the pane, under test
├─ test/                       the Uc anchor-port proof; skips when no payload is installed
├─ test-fixtures/canvas/       a small hand-authored canvas that must seed and --check clean
└─ scripts/
   ├─ find-payload.mjs         locate the local Claude Design install; --json, --verify
   ├─ check-no-vendored.mjs    the tripwire; fails if upstream bytes are ever tracked
   ├─ lint-pack.mjs            drive web-chat's own pack validator against this directory
   └─ relock.mjs               regenerate upstream.lock.json after an upgrade
```

A component ships exactly four files — `component.html`, `meta.json`, `seed.js`, `service.js` — so
`service.js` cannot import a helper from this repository. The payload-discovery logic is therefore
duplicated inline in the service and in `scripts/find-payload.mjs`. That duplication is deliberate and
flagged in a comment at both sites; keep the two in sync.
