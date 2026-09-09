# Claude Design — the findings `wc-design` is built on

> **This is the trimmed public record.** It documents what the shipped code
> actually rests on: where Claude Code materialises the Claude Design assets, the
> CLI of the seeding helper the service spawns, the shape of a seeded page, the
> boot requirements of one, the anchor grammar the pane mints and validates, and
> everything about **web-chat** itself.
>
> Analysis of Claude Design internals this pack does not touch was deliberately
> left out — the publish/save call path, how a host capability is served and how
> writability is decided, live-store dispatch mechanics. None of it is something
> the code depends on, so none of it is here; it stays in a local, untracked
> research archive and is not part of this repository.
>
> **Section numbers are load-bearing.** `CONTRACT.md`, `service.js` and
> `component.html` cite this file by number. Where a section was removed its
> number is kept as a short stub rather than reused, so every existing citation
> still resolves.

Everything below was verified against a local install rather than inferred; where
something is unverified it says so. Established against Claude Code **2.1.263**,
`claude-web-chat` **0.7.5**, Node 24. Implemented by v0.1.0 in
`components/design-canvas/`; `CONTRACT.md` is the normative interface, this is the
evidence under it.

---

## 1. What "the Claude Design app" actually is

Two files, materialised on demand out of the Claude Code binary the first time
the bundled `design` skill runs in a session:

```
<tmp>/claude-<uid>/bundled-skills/<claude-version>/<nonce>/design/
├─ payload.template.html    2,488,483 B   the precompiled canvas editor
└─ seed-canvas.mjs             40,699 B   seeding / extract / check helper
```

| | sha256 |
|---|---|
| `payload.template.html` | `76a2b0a4e5d4efccc9b8c825ed70aa320179cbc95541755be2af50bfd6d36196` |
| `seed-canvas.mjs` | `31a2a1528c7a30b624b7370cc542d8378a3643d97cc14ff3e6a4bce842878cd8` |

Three things about that path that are easy to get wrong, and were:

- **The temp root is not `$TMPDIR`.** It is `process.env.CLAUDE_CODE_TMPDIR || "/tmp"`
  — a hardcoded literal. On macOS `/tmp` resolves through a symlink into
  `/private/…`, which is the only reason an observed path looks the way it does.
  `$TMPDIR` (`/var/folders/…`) is never consulted.
- **The 32-hex segment is not a content hash.** It is `randomBytes(16).toString("hex")`,
  a fresh per-process nonce. It is unpredictable, differs every run, and sibling
  nonce directories accumulate. Never treat it as a stable key — enumerate and
  rank by version then mtime.
- **There is a `claude-<uid>` segment** between the temp root and `bundled-skills`.

All four installed Claude Code versions (2.1.252 / 259 / 260 / 263) carry
byte-identical design assets, so the assets are stable across patch releases even
though their path is not.

`scripts/find-payload.mjs` implements this discovery and is verified working; the
same logic is duplicated inline in `service.js`, because a component installs
exactly four files and cannot import a helper (CONTRACT §6.2).

---

## 2. The helper is the reuse surface

`seed-canvas.mjs` is 464 lines, zero dependencies, and heavily commented — it
ships in the clear on every machine that has run `/design`, and it is by far the
best documentation of the payload's contract. **Program against the helper, not
the editor.**

Three modes, dispatched in a fixed order that a caller cannot override:
`--extract` → `--check` → seed (the fall-through default). Passing `--extract`
and `--check` together silently runs extract only.

| flag | mode | semantics |
|---|---|---|
| `--template` `--out` `--title` | seed | required |
| `--artboard` | seed | **repeatable**, order preserved, at least one required |
| `--image` | seed | repeatable; stored as bare base64 under the file's basename |
| `--canvas` | seed | optional layout manifest |
| `--extract` + `--to` | extract | reads a canvas back out to working files |
| `--check` | check | pre-publish validation |
| `--force` | extract | allow writing into a non-empty dir |

**Argument parsing is hand-rolled and has a real trap.** The scan loop is bounded
by `process.argv.length - 1`, so *a flag that is the final argv token contributes
no value and reads as absent*. There is no `=` form, no short flags, no `--`
terminator, and unknown flags are ignored silently. Repeated single-valued flags
are last-wins.

### The seeding transformation

Purely textual, eight steps over `payload.template.html`: three head-scoped regex
replacements (README comment, README meta, capabilities meta), a global literal
`split/join` of the title placeholder, then parse/mutate/re-serialize of the
state block — set `title`, replace `content` with `{files}`, **`delete state.store`**
— with every `<` escaped, spliced back byte-exactly. A final invariant check
(unchanged `<script` count, no surviving placeholder) aborts before any write.

That `delete state.store` is load-bearing; see §4.

### State block shape

The state block is the first `application/json` script in the body:

```html
<script type="application/json" id="appifact-doc"> … </script>
```

After seeding it holds:

```jsonc
{ "title": "…", "content": { "files": { … } }, "comments": [] }
```

`files` is a flat `Record<string,string>`:

- `*.dc.html` → raw source, CRLF-normalised
- `canvas.json` → `JSON.stringify(clean, null, 2)`
- images → **bare base64, no `data:` prefix** (a stored data-URI double-wraps into
  a broken image)

Editor load-time limits, silently enforced: ≤200 entries, ≤2 MiB per value,
≤300-char names.

### Recognising a page

```js
DATA_ID = '(?: data-id="(?!-)(?:(?!--)[A-Za-z0-9_-]){16}")?'
DOC_RE  = new RegExp('(<script type="application/json" id="appifact-doc"' + DATA_ID + '>\n)([\s\S]*?)(\n</script>)')
```

Exactly one optional server-added attribute is tolerated — a 16-char `data-id`
that may not start with `-` and may not contain `--`. A 15- or 17-char id makes
the page unrecognisable. The lazy match is safe only because the serialiser
escapes every `<` inside the payload. `service.js` reimplements this to find the
state block of a page it seeded; the two must be kept in sync.

### Diagnostics

Everything goes to **stderr** prefixed `design canvas: ` (fatal) or
`design canvas: warning — `; only the one-line success summary goes to stdout.
Exit codes are exactly 0 / 1. Seed-time problems are fatal; the same problems at
`--check`/`--extract` time are advisory. This is why the `seed-failed` state
carries the helper's stderr **verbatim** (CONTRACT §3) — it is written to be read
by a person, and paraphrasing it loses the fix.

---

## 3. Serving no host object — the one fact the pack uses

*(The rest of the editor's host contract is not published; see the header note.
This number is retained because later sections are cited by number.)*

`wc-design` serves no `globalThis.claude` at all. What that produces is the only
part of the host contract anything in this repository depends on:

**With no host object the page does not crash.** It renders the `appifact-doc`
seed embedded in its own body and sits read-only — pan, zoom, export. There is no
Save button to press and nothing on screen to extract. That is the payload's own
designed fallback, and it is what CONTRACT §9.5 rests on.

One operational corollary: the seeded document is served to the frame **verbatim**.
The only hard boot throw on this path is a document whose `#appifact-app` /
`#appifact-style` elements were stripped, so nothing may rewrite the seeded file
between the helper and the `srcdoc`.

---

## 4. Gate on seeded output, never the raw template

A seeded canvas differs from the raw template in exactly the way that matters
here: seeding **deletes `state.store`** (§2). The pristine template's own state
block still carries `store:"db"`, so a check that passes against the template
proves nothing about a page.

The operational rule, and the whole of what the code does with it:

> **Refuse a page whose `appifact-doc` block still carries `store:"db"`.** It will
> boot read-only no matter what a host provides, and it is not one of ours. The
> pane renders state `live-store` and stops before mounting the frame
> (CONTRACT §5.4, §3).

Not published here: the anatomy of the publish/save call path, its conflict
handling and its client-side stash. v0.1.0 serves no publish capability
(CONTRACT §9.5) and never travels that path, so nothing in this repository
depends on how it works.

---

## 5. Standalone boot — verified in a real browser

A seeded canvas is genuinely self-contained. Driven in Chromium over CDP: zero
page errors, zero failed subresource requests, canvas rendered.

- **No CSP in its own head.** The single `Content-Security-Policy` occurrence in
  the 2.4 MB file is a JS *string constant* the editor injects into artboard
  preview frames (`frame-src 'none'; object-src 'none'`).
- Zero `integrity=` attributes, zero `serviceWorker`, zero
  `XMLHttpRequest`/`WebSocket`/`EventSource`.
- Absolute URLs are namespace URIs (`http://www.w3.org`) and doc-string hosts.
  Nothing is fetched.
- The nested artboard iframe is `<iframe sandbox="allow-scripts" srcDoc={…}>` —
  **`allow-same-origin` appears zero times in the payload.** That isolation cannot
  be weakened by a host, which is a useful safety property.

This is why the right way to share a canvas is to hand over the seeded `.html`
file: it opens from disk with no server and no network.

### It needs a SECURE CONTEXT, not "any local origin"

This corrects an earlier assumption. Working: `file://`, `http://127.0.0.1`,
`http://localhost`, `http://*.localhost`, any `https://`. **Broken:** any other
host over plain http — a LAN IP, a bare hostname, an mDNS `.local` name. In a
non-secure context `crypto.randomUUID` is undefined, the unguarded artboard
handshake throws, and the canvas hangs on a permanent spinner with the toolbar
rendered. This is an enforced, documented invariant, because the obvious next
steps (bind `0.0.0.0` so a phone can view it; share over a LAN) all break it
silently and it looks like a slow load rather than a failure. The pane checks
`window.isSecureContext` and warns **before** the frame is ever created
(CONTRACT §5.2).

---

## 6. The comment layer, and the anchor grammar

Three facts, and they are the ones v0.1.0 rests on.

**The canvas draws no pins of its own.** Its entire visible comment surface is a
full-bleed crosshair overlay (`data-testid="mega-comment-layer"`) plus one toolbar
button (`data-testid="mega-sel-comment"`) — the two handles to check this against
a canvas of your own. It renders no pins, no bubbles, no threads, no composer: a
host is expected to draw them. So there is no second
pin system to shim over or suppress: the canvas is a geometry engine with no
comment UI, and web-chat is a comment UI with no canvas geometry.

**The layer stays dormant when no capability is served.** Mounting the comment
layer is gated on a host-served comments capability; absent, it early-returns
before mounting anything, warns once to the console, and the canvas behaves as if
the feature did not exist. That is the payload's own designed fallback, and it is
what makes v0.1.0's stance possible: **suppression is absence, not removal.** The
pack serves no host object (§3), so it gets a canvas with its comment layer
switched off without patching a byte.

**The host link is a JavaScript object, and there is no postMessage protocol for
it.** All postMessage traffic in the payload runs *downward*, into artboard
preview frames. The consequence is hard and permanent: any capability injection
**forces same-origin** — cross-origin is structurally impossible, not merely
degraded. That is why the frame is mounted by writing `srcdoc` (CONTRACT §7), and
why §9 exists.

### Anchor grammar

The pane mints and validates anchors in Claude Design's **own** grammar even
though v0.1.0 serves no capability, because those exact strings hand straight to a
capability-driven host later with zero migration (CONTRACT §4.2). An anchor is a
synthetic CSS-selector string:

```
dc<kind><payload>:nth-of-type(1)
```

parsed back by

```
/^dc([eanc])([0-9a-z]*):nth-of-type\(([1-9][0-9]{0,3})\)$/
```

| kind | shape | durability |
|---|---|---|
| element | `<domPath> > [dct:nth-of-type(tid+1) > ]dce<fileHash12><fx4><fy4>:nth-of-type(1)` | dies on any artboard HTML rewrite |
| artboard | `dca<fileHash12><fx4><fy4>:nth-of-type(1)` | survives element edits, dies on rename |
| note | `dcn<idHash12>:nth-of-type(1)` | — |
| canvas point | `dcp<pageHash12>:nth-of-type(1) > dcc<x8><y8>:nth-of-type(1)` | — |

`fileHash12` is a 12-hex hash of the artboard **file path**; `fx`/`fy` are
fractions encoded as `round(clamp01(v) * 9999)` zero-padded to 4 digits.

v0.1.0 mints the **artboard** form only. `scratch/anchor-lib.js` is the
implementation (inlined verbatim into the pane, since a component ships four
files), and `test/uc-port.test.mjs` proves our hash agrees with the payload's own
over a sample of paths — extracting the reference at test time from the *local*
install, never a committed copy, and skipping cleanly when the payload is absent
(CONTRACT §8.2).

The grammar is also safe under an **unmodified** web-chat: the string is
syntactically valid CSS, so `querySelectorAll` returns zero matches rather than
throwing, and the marker is skipped rather than breaking the pin layer (§7).

**Not published:** the `customAnchors` controller contract — what a host hands
the canvas, what the canvas hands back, and how comment mode is held on. v0.1.0
serves no capability, so nothing here speaks that interface and nothing in this
repository depends on it. `dev-notes/extending.md` §1.3 records the shape of the
seam and says to read the interface itself off a local install.

---

## 7. web-chat's pin model

```js
// lib/server/routes/comments.js:1
// A pin: { id, seq, created_at, shared, text, anchor:{mount, selector, text, ordinal} }
```

- Pins live in `state.comments`, **deliberately not the store** — the header
  comment says why: the store is exposed to Claude via `get_store`/`diff_nodes`,
  so private pins kept there would leak.
- `POST/GET/PATCH/DELETE /api/comments` are ordinary routes. The server stores
  `anchor` **verbatim with zero validation** (`anchor && typeof anchor === 'object' ? anchor : null`).
- `redactPin()` keeps a private pin's body out of the event ring.
- Pins persist via a `comments` field on each committed node and survive restart.

**An unmodded web-chat degrades safely on a canvas anchor.** `dce…:nth-of-type(1)`
is *syntactically valid CSS*, so `querySelectorAll` returns zero matches rather
than throwing — the marker is skipped, not broken.

---

## 8. Embedding a 2.4 MB document in a pane

- **The surface serves no CSP at all** (verified in source and by curl against the
  live daemon).
- **No sanitisation on the render path.** `public/mount-runtime.js:75-83` does
  `tpl.innerHTML = html` then removes only `<script>`. `<iframe>`, its `src` and
  its `sandbox` survive verbatim. The iframe-stripping lists that do exist are in
  the *capture* pipeline, never the render path.
- **No size cap anywhere** — express body limit is 200 MB.

The real constraint is amplification, not gates: `lib/server/graph.js:448`
snapshots the whole store into every committed node, and pane `html` is likewise
a per-node snapshot field. **A 2.4 MB pane or store value would be copied into
every node on disk, forever.** It must arrive as a file and never enter the graph,
the store, or a tool argument.

**Delivery that works:** `GET /api/components/:name` returns `{…meta, source, has_service}`
where `source` is the component's `component.html` — same-origin, behind
`requireLocalHost`, no new listener, no wildcard CORS, no trust gate. The
components registry does a fresh `readdirSync` per call with no caching, so **a
component written at runtime is picked up**, which is how the payload can reach
that route without ever being committed.

Two gotchas for the build:

- **Pane scripts are compiled as `new Function('store','root','params','mountId', body)`**
  (`mount-runtime.js:95-105`). Top-level `await` is a SyntaxError — the script
  never compiles and fails silently into `onError`. Use an async IIFE.
- **A frozen export will show an empty frame too, and silently.** `lib/server/export.js`
  runs pane scripts in the exported file (`runScripts(r.root, r.scripts, store, m.params, m.id)`),
  so a loader pane's `fetch('/api/components/…')` executes against no server and
  fails. The pane must catch that and render "this canvas exports as its own
  file" rather than an empty box. Note also that a graph node is
  `{mounts, store, comments}` but the assembler is
  `assembleExport({mounts, store, page, meta})` — **comments are on the node and
  dropped on the way out**, so pin threads never survive an export.
  The right export for a canvas is the seeded `.html` itself, which is already
  self-contained and interactive (§5).

- **Node previews will show an empty frame.** `lib/server/routes/graph.js:330`
  applies `PREVIEW_CSP` from `lib/core/cors.js:258-264` — `default-src 'none'`
  with no `frame-src`, and `connect-src 'none'`. Both the frame and the fetch die
  in `/preview/node/:id`, glance cards and graph thumbnails. Needs a static
  placeholder keyed on `location.pathname.startsWith('/preview/')`.

---

## 9. The security finding — read this before building

The comment capability is a **JS object**, so the canvas frame must be
**same-origin** with the daemon. That places untrusted content inside the daemon's
trust boundary, behind nothing but a Host header (`app.use(requireLocalHost)` is
the only gate on the whole API). That realm gets:

1. **Read of every private pin.** `GET /api/comments` without `shared_only`
   returns unshared pins **with their text** — exactly what the routes file says
   pins live outside the store to prevent.
2. **Forged pins into Claude's context.** The `comment` branch of
   `policy.classify` reads only `event.op`, `event.pin.shared`, `event.author` —
   **no source gate and no routing gate**, unlike the `dom` branch two blocks
   above which has both. `commentItem` hardcodes `source:'browser'`, and
   `params.routing:'none'` does not suppress it.
3. **`POST /api/packs/install`.**

This is inherent to the capability path, not to any one design. The invariants
that make it survivable:

- **Only ever display canvases seeded from the user's own local `.dc.html` files.**
  Never someone else's published canvas, never an Artifact URL. Then the content
  in the frame is Anthropic's editor plus the user's own design — not untrusted
  cross-user input.
- **Never serve `claude.db` or `claude.use`**, so the payload boots read-only from
  its embedded seed and never fetches cross-user published content.
- Validate any canvas-minted anchor before it becomes durable data (≤1024 chars,
  ≤10 `" > "` segments, final segment matching the grammar of §6) — the server
  validates nothing and `describeAnchor` does not truncate `selector`.
- An `isolate` mode that sandboxes the frame to an opaque origin is the safe
  default for viewing anything not locally authored. It costs element-level pins.

These are CONTRACT §9.2 and §9.3, and they are contractual rather than advisory
precisely because the exposure above cannot be engineered away.

---

## 10. Design stances — not published

*(Number retained so later citations resolve.)*

Three candidate designs were compared before v0.1.0, and the outcome is what
CONTRACT §4 specifies — artboard-fraction anchors, no capability injection, no
web-chat core change — with the element-precise tier deferred to v0.2. The
comparison itself was internal process; the defects it turned up are recorded
where they belong, as rules in `CONTRACT.md` (§4.5 anchor drift, §5.1 the
`new Function` compile shape, §6.1 the service export shape, §7 the forbidden
delivery alternatives).

---

## 11. Legal position and repo boundary

- **No LICENSE, NOTICE or COPYING file exists anywhere** in the Claude Code
  install, the app bundle, or the bundled-skills directory. The two design files
  carry no copyright header of their own; the payload's only banners are MIT
  React/Meta. The notice lives on the *binary* that embeds them:
  `(c) Anthropic PBC. All rights reserved.` (~1650 occurrences), pointing at
  code.claude.com/docs/en/legal-and-compliance.
- Absence of a per-file header is **not a grant**. Copyright attaches
  automatically and the linked terms retain all rights. **Do not vendor.**
- **The extraction method is itself a risk, not just the bytes.** The payload is
  also recoverable directly from the Claude Code executable, and a research pass
  confirmed that path works and is byte-identical. The method is deliberately
  **not recorded here and not implemented anywhere in this repository**: the terms
  prohibit reducing the Services to human-readable form, and publishing a tool —
  or a recipe — that does it is worse than doing it privately.
- **Supported path:** read the copy Claude Code itself wrote to the user's temp
  directory. If it is absent, the remedy is "run `/design` once" — a first-class
  answer, not a fallback.
- Provenance rides in `upstream.lock.json` as fingerprints only, and
  `scripts/check-no-vendored.mjs` fails CI if any tracked file matches a locked
  hash, carries an upstream marker, or exceeds a 256 KB ceiling. The rule is
  mechanical because "don't `cp` that file into the repo while debugging" is
  exactly the kind of rule care does not keep.

### No personal data, enforced the same way

No absolute home path, username, email or account name appears in any tracked
file, and that is a CI gate (`leak-scan`, alongside the tripwire) rather than a
habit — CONTRACT §9.6. Examples use `/path/to/…` or `~`, and the materialisation
path is written `<tmp>/claude-<uid>/…` because a real one names a user. The gate
matters most for files added later, which is why it self-tests: the scanner proves
its rules still catch a planted leak before it certifies the tree clean.

---

## 12. What exists on disk

v0.1.0 is feature-complete against `CONTRACT.md`. Floors: `claude-web-chat`
**>= 0.7.0**, Node **>= 20** (the note at the top of `CONTRACT.md` records why
the 20.13.0 floor an earlier draft required no longer applies — the watch is
non-recursive by design).

| path | what it is |
|---|---|
| `components/design-canvas/component.html` | the pane — chrome, frame, pin overlay, one screen per state; held well under a self-imposed 128 KB budget (half the tripwire ceiling), and it never carries canvas bytes |
| `components/design-canvas/service.js` | the host service — payload discovery (§1), seeding through the helper (§2), the runtime-written carrier, `fs.watch` + the `dsn_ctl` control loop; never writes under `dir` |
| `components/design-canvas/seed.js` | browser-side spawn seed for the drawer and command palette; offers back a canvas this surface already seeded, and otherwise offers nothing |
| `components/design-canvas/meta.json` | params schema; `name` must equal the directory |
| `scratch/anchor-lib.js` | the anchor grammar of §6 — source, not scratch: inlined into the pane and the subject of the port proof |
| `test/uc-port.test.mjs` | the hash-port proof against the local payload; skips with a clear message when it is absent |
| `test-fixtures/canvas/` | a small hand-authored canvas (`Main.dc.html`, `Detail.dc.html`, `canvas.json`, one SVG) that must seed and `--check` clean |
| `scripts/find-payload.mjs` | discovery; `--json`, `--verify` against the lock |
| `scripts/check-no-vendored.mjs` | the tripwire (§11) |
| `scripts/lint-pack.mjs` | drives web-chat's own pack validator against this directory without pushing |
| `scripts/relock.mjs` | regenerate `upstream.lock.json` after a verified upgrade |
| `upstream.lock.json` | fingerprints only — versions, sha256s, byte counts |
| `.github/workflows/ci.yml` | three gates: tripwire, leak scan, tests on Node 20 and 22 — and it asserts the payload is *absent* on the runner, so the skip paths are really exercised |
| `dev-notes/` | maintainer notes: `architecture.md` (how the four files fit together), `extending.md` (v0.2, forks, the traps), `web-chat-notes.md` (platform findings); `dev-notes/README.md` indexes them |
| `web-chat-pack.json`, `SKILL.md`, `README.md`, `CONTRACT.md`, `LICENSE` | the pack manifest, the agent-facing guide, the human entry point, the normative interface, and MIT-for-the-wrapper with the non-affiliation notice |

---

## 13. What was decided

The open questions this research left are closed, and each answer is now
contractual.

1. **How edits persist — one-way, files → canvas.** No `claude.self.publish`
   stand-in, and none is coming: the pane serves no host object, so the editor
   boots read-only (§3) and the `.dc.html` files stay the only source of truth.
   The service never writes under `dir`, so nothing can travel back the other way
   by construction. `--extract` is the helper's way back into files from a canvas
   edited *somewhere else* and is run by the user, never by this pack. For real
   WYSIWYG Save, hand off to a published Artifact via the bundled `design` skill.
   (CONTRACT §9.5.)
2. **Comment tier — artboard-fraction anchors, no capability injection, no
   web-chat core change** (CONTRACT §4). Anchors are nonetheless minted in the
   payload's own grammar (§6), so the element-precise tier is a v0.2 upgrade
   rather than a migration. The costs are stated plainly in the README's
   limitations rather than hidden.
3. **Default isolation — same-origin `srcdoc`, with `isolate: true` available and
   pin-free.** Same-origin is not a preference: the host link is a JS object and
   there is no postMessage protocol, so nothing else can ever work (§6). What
   makes it acceptable is §9's invariants, which is why they are contractual.
4. **Pack conventions — confirmed and encoded.** `requires."web-chat"` is
   `">=0.7.0"`, because `use_component` only gained `signals`/`force` in 0.7.0 and
   a pack declaring a signal on 0.6.x installs happily and silently loses its wake
   path. The MCP `set_store` takes a `patch` wrapper while `ctx.driver.setStore`
   takes the patch directly. A component installs exactly four files, so payload
   discovery is duplicated inline in `service.js` instead of imported —
   deliberate, and flagged in a comment at both sites.
