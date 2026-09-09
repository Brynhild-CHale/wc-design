# Reverse-engineering Claude Design — findings

Research notes for `wc-design`, a web-chat component pack that wraps Claude
Design's canvas editor. **No implementation yet.** This file records what was
established, how, and what it forces. Everything here was verified against a
local install rather than inferred; where something is unverified it says so.

Established against: Claude Code **2.1.263**, `claude-web-chat` **0.7.5**, Node 24.

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
  — a hardcoded literal. On macOS `/tmp` → `/private/tmp` through a symlink, which
  is the only reason the observed path looks like `/private/tmp/...`. `$TMPDIR`
  (`/var/folders/…`) is never consulted.
- **The 32-hex segment is not a content hash.** It is `randomBytes(16).toString("hex")`,
  a fresh per-process nonce. It is unpredictable, differs every run, and sibling
  nonce directories accumulate. Never treat it as a stable key — enumerate and
  rank by version then mtime.
- **There is a `claude-<uid>` segment** between the temp root and `bundled-skills`.

All four installed Claude Code versions (2.1.252 / 259 / 260 / 263) carry
byte-identical design assets.

`scripts/find-payload.mjs` implements this discovery and is verified working.

---

## 2. The helper is the reuse surface

`seed-canvas.mjs` is 464 lines, zero dependencies, and heavily commented — it is
by far the best documentation of the payload's contract. **Program against the
helper, not the editor.**

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
`split/join` of `APPIFACT-TITLE-PLACEHOLDER`, then parse/mutate/re-serialize of
the state block — set `title`, replace `content` with `{files}`, **`delete state.store`**
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
escapes every `<` inside the payload.

### Diagnostics

Everything goes to **stderr** prefixed `design canvas: ` (fatal) or
`design canvas: warning — `; only the one-line success summary goes to stdout.
Exit codes are exactly 0 / 1. Seed-time problems are fatal; the same problems at
`--check`/`--extract` time are advisory.

---

## 3. The editor's host contract

The page is an "appifact" and expects exactly one host global, `globalThis.claude`,
with capabilities resolved two ways — direct property `claude.<name>`, or
`await claude.use("<name>")`. Detection is pure duck-typing:

```js
function DI(){ return globalThis.claude }
function NI(){ return typeof DI()?.use == "function" }
function NR(e){ return DI()?.[e] }
```

**There is no token, no origin assertion, no parent-frame gate, and no integrity
check anywhere in the capability path.**

Capabilities declared in the head meta: `self`, `downloads`, `comments`, `room`,
`db`, `assets`, `user`.

Writability is decided by: `n0()` (either `claude.self.publish` is a function or
`claude.use` is a function) **and** no sticky read-only flag in sessionStorage
**and** (`user.canEdit() === true` **or** the `assets` capability being present).
Note the quirk — `assets` presence alone grants write even when `canEdit()`
returns false.

**With no host globals the page does not crash.** It renders the embedded
`appifact-doc` seed and sits read-only. The only hard boot throw is on the manual
path if `#appifact-app` / `#appifact-style` were stripped.

---

## 4. Two save paths, chosen by DOM inspection

Boot dispatches on the document, not on the host:

```js
if (getElementById("appifact-doc") === null) return { mode: "files" }
return block.store === "db" ? { mode: "db", block } : { mode: "legacy", block }
```

- **`db` mode** — what the *pristine template* boots, because its own state block
  begins `{"store":"db","title":"APPIFACT-TITLE-PLACEHOLDER",…}`. The design lives
  in a Firestore-shaped live store reached via `claude.db`. `saveMode` is `"auto"`
  — no Save button. Without a `db` capability it pins read-only with
  *"Viewing the published snapshot. Live content isn't available in this view."*
- **`legacy` / manual mode** — what a **seeded** canvas boots, because seeding
  deletes `state.store`. The whole page re-serialises itself and calls
  `claude.self.publish(htmlString)` — one argument, the complete new HTML
  document, 16 MiB cap enforced client-side. This is the path with the Save
  button and Cmd+S.

There is **no version/CAS token on the publish call**. The host performs the CAS
and throws `{code:"conflict"}`; the page stashes to sessionStorage and reloads.
(`baseVersion`/`occToken` in the bundle belong to a separate local-dev filesystem
driver, not the artifact publish path.)

> **Gate on seeded output, never the raw template.** A page whose `appifact-doc`
> block still has `store:"db"` will boot read-only no matter what a host provides.

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

### It needs a SECURE CONTEXT, not "any local origin"

This corrects an earlier assumption. Working: `file://`, `http://127.0.0.1`,
`http://localhost`, `http://*.localhost`, any `https://`. **Broken:** any other
host over plain http — a LAN IP, a bare hostname, an mDNS `.local` name. In a
non-secure context `crypto.randomUUID` is undefined, the unguarded artboard
handshake throws, and the canvas hangs on a permanent spinner with the toolbar
rendered. This must become an enforced, documented invariant, because the obvious
next steps (bind `0.0.0.0` so a phone can view it; share over a LAN) all break it
silently.

---

## 6. The comment subsystem — the central finding

**The canvas has no pin UI of its own.** Its entire visible comment surface is
two things: `data-testid="mega-comment-layer"` (an `absolute inset-0 z-[48]`
crosshair overlay whose only child is a coral hover-highlight box) and
`data-testid="mega-sel-comment"` (a toolbar button). It renders **no pins, no
bubbles, no threads, no composer**. `controller.placed(map)` exists *precisely
because the host is expected to draw the pins*.

So there is no second pin system to shim over or suppress. The canvas is a
geometry engine with no comment UI; web-chat is a comment UI with no canvas
geometry.

### It is capability-driven, not store-driven

```js
async function Tie(e){
  let n = globalThis.claude?.comments, r = n?.customAnchors;
  if (typeof r !== "function") return console.warn("[design] comments capability not served; artboard comments stay off"), null;
  …
}
```

- **Not gated on hosting mode** (files / legacy / db). The React component mounts
  unconditionally; the only gate is capability presence.
- Absent capability → early return, layer never mounts. That is the payload's own
  designed fallback, and it means *suppression is absence, not removal*.
- **No postMessage host protocol exists.** All postMessage traffic in the payload
  goes *downward* into artboard iframes. The sole host link is the JS capability
  object. **This forces same-origin — cross-origin is structurally impossible, not
  merely degraded.**

### The canvas reads only two fields per thread

`{ id, anchor }`. Text, author, replies, resolved state — all live host-side and
are never seen by the canvas. It hands back `{ id: {x, y} }`.

### Anchor grammar

A synthetic CSS-selector string, minted by `dE(spec)` and parsed by `fE(string)`:

```
QP = (kind, payload) => "dc" + kind + payload + ":nth-of-type(1)"
Die = /^dc([eanc])([0-9a-z]*):nth-of-type\(([1-9][0-9]{0,3})\)$/
```

| kind | shape | durability |
|---|---|---|
| element | `<domPath> > [dct:nth-of-type(tid+1) > ]dce<fileHash12><fx4><fy4>:nth-of-type(1)` | dies on any artboard HTML rewrite |
| artboard | `dca<fileHash12><fx4><fy4>:nth-of-type(1)` | survives element edits, dies on rename |
| note | `dcn<idHash12>:nth-of-type(1)` | — |
| canvas point | `dcp<pageHash12>:nth-of-type(1) > dcc<x8><y8>:nth-of-type(1)` | — |

`fileHash` is a 12-hex hash of the artboard **file path**; `fx`/`fy` are fractions
encoded as `round(clamp01(v) * 9999)` zero-padded to 4 digits.

### The `comments` store collection is inert

Separate feature, shared with other appifact editors, shape
`comments/<id> {text, author, at, elementKey?, elementLabel?}`, validated and
capped at 200. **Zero consumers in this build** — `addComment`, `removeComment`,
`commentSync`, `pendingCommentIds`, `retryCommentPublish` are each 3 definitions
in 3 runtime adapters with 0 call sites; `elementKey`/`elementLabel` appear only
in the validator and the README. Writing it persists, validates, counts against
the 2 MB live-sync budget, and **renders nothing**.

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
  ≤10 `" > "` segments, final segment matching `Die`) — the server validates
  nothing and `describeAnchor` does not truncate `selector`.
- An `isolate` mode that sandboxes the frame to an opaque origin is the safe
  default for viewing anything not locally authored. It costs element-level pins.

---

## 10. Design stances and how they scored

Three stances were designed and judged on three lenses.

| | feasibility | isolation | UX coherence |
|---|---|---|---|
| **A** canvas owns pin placement | 5 | **7** | 4 |
| **B** web-chat owns pin placement | **8** | 5 | **7** |
| **C** hybrid | 7 | 3 | 6 |

**All three judges independently killed stance A's headline constraint.** A
claimed comment mode "cannot be pinned on", and built a whole product compromise
on it. In fact the setter for `d` (comment mode) has **exactly one call site** —
inside the host-supplied `mode` handler — and `controller.exitMode()` is a
*request the host may ignore*. So comment mode can be held on indefinitely, and a
`pointer-events` gate on the overlay unlocks pins that stay glued while the canvas
stays editable. That is C's insight and it is correct.

Net: **B is what ships first** — it needs no capability injection, no core change,
and nothing an upgrade can wipe. **C is the better end state** once its defects
are fixed, because it is the only stance that gets element precision, `reveal()`,
and live geometry during editing.

### Defects found in the candidate designs (fix before building)

- **B / Tier 2 is non-functional as sketched.** `onClickTier2` is a window-capture
  listener that calls `stopPropagation()` — killing web-chat's own document-capture
  handler — then dispatches a synthetic click that re-enters itself. Infinite
  recursion, composer never opens. Needs `if (!e.isTrusted) return`, a re-entrancy
  flag, and no `stopPropagation` on the replay. Until then: artboard-fraction
  anchors only.
- **B: an armed overlay makes the canvas unusable** — `pointerEvents:'auto'` means
  no pan, no zoom, no selection while pin mode is on. Never mentioned by B.
- **C: top-level `await` in the pane script.** SyntaxError under `new Function`;
  the bridge silently never exists.
- **C: `dc_anchors` in the store leaks private pin locations to Claude** via
  `get_store`. Fix by hex-encoding the canvas anchor into the proxy's own class
  list so it rides inside `anchor.selector` and inherits the pin's own
  shared/private filtering.
- **A: `service.js` export shape is wrong.** The runner tests
  `typeof svc.start === 'function'`; the sketch exports a bare async function, so
  the service silently never starts. Correct shape is
  `module.exports = { name, async start(ctx), async stop() }`.
- **A: an `access-control-allow-origin: '*'` loopback server** re-introduces the
  exact regression `lib/core/cors.js` documents having removed — any page the user
  visits could scan loopback and read their design content. Use the
  `/api/components/:name` route instead.
- **A: the 90-line patch to `public/app/comments.js` is a fork of the release
  tarball**, not a pack. The next `claude-web-chat` upgrade discards it and every
  canvas pin silently goes invisible-but-live.
- **All: anchor drift is unhandled.** A fraction anchor survives an artboard
  rewrite and then points *confidently* at whatever moved into 42%,77%. Record a
  cheap fingerprint (artboard box dimensions + a hash of serialised content) at
  pin time and mark the marker "may have moved".

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
  hash, carries an upstream marker, or exceeds a 256 KB ceiling.

### Scrub before anything goes public

`wc-design` itself is clean (verified: no username, email, account name or
absolute home path in any file).

The sibling packs are not. **3 files, 14 occurrences**, all real absolute vault
paths used as worked examples:

| file | occurrences |
|---|---|
| `wc-learn/CONTRACT.md` | 6 |
| `wc-obsidian/CONTRACT.md` | 5 |
| `wc-obsidian/SKILL.md` | 3 |

e.g. a `vault` param holding an absolute home-directory path. Harmless
locally, a personal-data leak the moment any of those packs is pushed public.
Replace with a placeholder path before publishing anything from this folder.
(An earlier research pass reported "~10 files" and a compliance-project tree —
that was wrong; the verified figure is the table above.)

---

## 12. What exists on disk

| file | state |
|---|---|
| `scripts/find-payload.mjs` | written, **verified working** — resolves the local payload, ranks candidates, reports drift |
| `scripts/check-no-vendored.mjs` | written, degrades correctly outside a git repo |
| `scripts/relock.mjs` | written, untested |
| `upstream.lock.json` | generated from the local install |
| `.gitignore` | written — blocks payload, helper, seeded canvases |
| `LICENSE` | MIT for wrapper code, with an explicit non-affiliation notice |
| components, `SKILL.md`, `web-chat-pack.json`, `README.md` | **not started** |

---

## 13. Open decisions

1. **How edits persist.** File round-trip via the supported `--extract` → edit →
   re-seed loop; or hand off to a real published Artifact for genuine WYSIWYG
   Save; or a local `claude.self.publish` stand-in (technically ~20 lines, but the
   design skill says in as many words *"never add a stand-in for it"*, and two
   research agents were blocked by the safety classifier for pursuing exactly
   that — not recommended for a public repo).
2. **Comment tier.** Ship B (artboard-fraction, no capability injection, no core
   change) first, or go straight to C (element-precise, needs the capability
   object and a core patch that upgrades would discard).
3. **Default isolation.** Sandboxed opaque-origin frame (safe, viewer-only,
   whole-pane pins) versus same-origin (needed for any pin precision, but inside
   the daemon trust boundary).
4. **Pack conventions to confirm:** `requires."web-chat"` floor must be `>=0.7.0`,
   not `>=0.6.0` — `use_component` only gained `signals`/`force` in 0.7.0, and a
   pack declaring a signal at spawn time on 0.6.x silently loses its wake path.
   `set_store` takes a `patch` wrapper. Components ship exactly four files, so two
   services in one pack cannot share a helper module.
