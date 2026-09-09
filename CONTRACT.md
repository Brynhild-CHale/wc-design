# wc-design — normative contract

The authoritative interface between the pack's pieces. `service.js`,
`component.html`, `SKILL.md` and the test harness are all written against **this
file**; where an implementation and this document disagree, this document is
wrong and must be changed deliberately, not worked around.

Companion: `FINDINGS.md` (the research this rests on). A bare `§N` or `§N.M`
is a section of **this** file; a reference to the research is written out —
`FINDINGS §6`.

Target: `claude-web-chat` **>= 0.7.0** (see §9.4), Node **>= 20** — the floor
`package.json` declares and CI tests.

> An earlier draft of this document required Node 20.13.0, because `fs.watch`
> with `recursive: true` only landed on **Linux** in that release and throws
> `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` below it — a service that dies at start
> rather than a pane that degrades, the worst failure shape. That note offered
> two ways out and the implementation took the second: the service watches
> **non-recursively**, because the helper stores every file under its basename,
> so only the top level of `dir` is ever read (`installWatch`, `service.js`).
> Nothing else in the service needs 20.13, so the floor is `>= 20`. If a
> recursive watch is ever reintroduced, move the floor back to 20.13.0 in the
> same commit — in `package.json` and here.

---

## 1. Component: `design-canvas`

One pane. Shows a live Claude Design canvas seeded from `.dc.html` files on disk.
Service-backed: the service owns seeding and file watching, the pane owns
rendering and pins.

### 1.1 Params

| param | type | required | default | meaning |
|---|---|---|---|---|
| `dir` | string | **yes** | — | Absolute path to the working directory holding the artboards. |
| `title` | string | **yes** | — | What the design is CALLED. Content-named. The helper refuses generic titles. |
| `isolate` | boolean | no | `false` | Sandbox the canvas frame to an opaque origin. Safe for viewing anything not locally authored. **Disables pins** (§4.6). |
| `watch` | boolean | no | `true` | Re-seed when files under `dir` change. |
| `routing` | `"none"` | no | `"none"` | Set `none`. The comment path has its own first-class wake; activity items would be noise. |

`dir` must contain at least one `<Name>.dc.html`. `canvas.json` is optional.
Images (`.png .jpg .jpeg .gif .webp .avif .bmp .svg`) are picked up automatically.

**`dir` is fenced.** The service resolves it through `ctx.fence(ctx.webChatDir ?
path.dirname(ctx.webChatDir) : process.cwd(), dir)` — a path a pane wrote must
never escape the project. A `dir` that fences to `null` is the `bad-dir` error
state (§3), never a silent fallback.

### 1.2 The four files

`component.html`, `meta.json`, `seed.js`, `service.js`. Nothing else installs
(§9.4). `meta.json`'s `name` must be exactly `design-canvas`.

---

## 2. Store keys

Prefix `dsn_`. Service writes, pane reads, except `dsn_ctl` which is the reverse.

> **`set_store` takes a patch wrapper** — `set_store({ patch: { k: v } })`. The
> unwrapped form merges nothing and still returns `ok:true`. The service uses
> `ctx.driver.setStore(patch)`, which takes the patch directly.

### 2.1 `dsn_canvas` — service → pane

The pane's whole world. Always written, in every state, including failure.

```jsonc
{
  "seq": 7,                       // monotonic, bumped on every write
  "ok": true,
  "state": "ready",               // see §3
  "payload_component": "design-canvas-payload-a1b2c3d4",  // fetch GET /api/components/<this>
  "title": "Spring Menu Poster",
  "artboards": [
    { "file": "Main.dc.html", "x": 0, "y": 0, "w": 880, "h": 560 }
  ],
  "seeded_at": 1789000000000,
  "bytes": 2477094,
  "upstream": { "version": "2.1.263", "payload_sha256": "76a2b0a4…" },
  "error": null,                  // human-readable, when ok:false
  "hint": null                    // the ONE action that fixes it
}
```

- `payload_component` is the name of a **local component the service writes at
  runtime** into `<webChatDir>/components/`. It is never shipped in this repo
  (§9.1) and never mounted (§5.3).
  **The name is per-mount** — `design-canvas-payload-<8 hex of mountId>` — so two
  design-canvas panes on one node cannot clobber each other's 2.4 MB carrier.
  The pane MUST read it from here and must never hardcode it.
- `seeded_file` (string) — the basename the service actually wrote. The frozen-export
  screen (§5.2) names the real file with this instead of re-deriving a slug from the
  title; the two slug functions agree in the ordinary case but diverge on NFKD input,
  on titles over 60 chars, and whenever the service appends a hash to dodge the
  helper's generic-name list.
- `warnings` (string[], may be empty) — non-fatal helper diagnostics worth showing.
- `artboards` comes from `canvas.json` when present, else one entry per
  `.dc.html` with `x`/`y`/`w`/`h` null. The pane uses it for pin labels and the
  artboard index; it must tolerate nulls.

### 2.2 `dsn_files` — service → pane

What is actually on disk. Lets the pane show a file list without a second read.

```jsonc
{ "seq": 7, "dir": "/abs/path",
  "files": [ { "name": "Main.dc.html", "bytes": 1840, "mtime": 1789000000000 } ],
  "has_canvas_json": true,
  "skipped": [ { "name": "notes.txt", "why": "not an artboard or a supported image" } ] }
```

`skipped` earns its place: "this file is in your folder but not on the canvas" is
exactly the question a user asks when an artboard does not appear.

### 2.3 `dsn_ctl` — pane → service

Control key. The service watches it over SSE and reacts. **This does not wake
Claude** — it is a service reaction, not a declared signal.

```jsonc
{ "seq": 3, "op": "reseed" }
```

| op | effect |
|---|---|
| `reseed` | Re-run the helper against the current files. Always safe. |
| `rescan` | Re-read the directory listing only; do not re-seed. |

`seq` must strictly increase; the service ignores a repeat or a regression.

### 2.4 `dsn_ask` — pane → Claude (**declared signal**)

The only declared wake. Bound to one deliberate affordance ("Ask Claude about
this canvas"), `wake: "queue"`.

```jsonc
{ "seq": 2, "note": "the pricing artboard's CTA is too quiet", "artboard": "Pricing.dc.html" }
```

Declare it on every `use_component`/`render` of this pane. It is NOT declared
`immediate` — the user decides when to hand off.

---

## 3. States

`dsn_canvas.state` is a closed set. The pane renders a distinct, useful screen
for each — never a spinner with no explanation.

| state | `ok` | meaning | `hint` |
|---|---|---|---|
| `ready` | true | Canvas seeded and fetchable. | — |
| `seeding` | true | First seed in flight. | — |
| `no-payload` | false | Claude Design not materialised on this machine. | ``Run `/design` once in Claude Code.`` |
| `bad-dir` | false | `dir` missing, empty of artboards, or fenced out. | Names the path and what was expected. |
| `seed-failed` | false | The helper exited non-zero. | The helper's **stderr, verbatim** — it is written to be read. |
| `live-store` | false | The page carries `store:"db"` — a claude.ai/design canvas, not ours. | Refuse. Cannot be edited from here (§5.4). |

`error` carries prose; `hint` carries the single action that fixes it. The pane
shows both.

For `seed-failed` the hint is the helper's stderr verbatim, with trailing whitespace
trimmed and a **16 KB cap that announces its own truncation** (`… (N more characters)`).
The cap is contractual, not a deviation: a store value is snapshotted into every
committed graph node, so an unbounded hint would be copied forever.

---

## 4. Pins

**v0.1.0 is stance B: artboard-fraction anchors, no capability injection, no
web-chat core change.** The canvas's own comment layer never mounts, because we
serve no `globalThis.claude` — that is the payload's designed fallback
(FINDINGS §6).

### 4.1 What web-chat stores

Unchanged shape (FINDINGS §7):

```jsonc
{ "id": "c12", "seq": 12, "created_at": 0, "shared": true, "text": "…",
  "anchor": { "mount": "<mountId>", "selector": "<canvas anchor>", "text": "<label>", "ordinal": 0 } }
```

### 4.2 Anchor encoding — the payload's own grammar

Mint anchors in Claude Design's **own** artboard-fraction grammar, even though
v0.1.0 does not use the capability:

```
dca<fileHash12><fx4><fy4>:nth-of-type(1)
```

- `fileHash12` — 12-hex hash of the artboard **file path**, produced by a
  verified port of the payload's `Uc`. The port MUST be proven byte-identical
  against the payload's own implementation over a sample set before use, and the
  test kept (§8.2).
- `fx4`/`fy4` — `String(Math.round(clamp01(v) * 9999)).padStart(4, '0')`, where a
  **non-finite value is replaced by 0.5 (the artboard centre) BEFORE clamping**.
  That guard is not optional: taken literally the formula yields `'0NaN'` for `NaN`
  (`Math.round(NaN)` → `NaN` → `'NaN'` → padded to 4), which the payload's own parser
  then rejects — so an anchor minted from a missing measurement would be silently
  unreadable. Note `Number.isFinite` does not coerce, so the numeric *string* `'0.5'`
  also falls through to the 0.5 default. Both behaviours mirror the payload exactly.

**Why this grammar and not our own:** it is forward-compatible. When v0.2 injects
`claude.comments.customAnchors`, these exact strings hand straight to
`handlers.threads([{ id, anchor }])` with zero migration.

It is also safe under an unmodified web-chat: the string is syntactically valid
CSS, so `querySelectorAll` returns zero matches and the marker is skipped rather
than throwing (FINDINGS §7).

### 4.3 Validation — both directions

Any anchor string, whether minted here or read back, must satisfy **all** of:

- length <= 1024
- <= 10 `" > "` segments
- final segment matches `/^dc([eanc])([0-9a-z]*):nth-of-type\(([1-9][0-9]{0,3})\)$/`

The implementation narrows the last rule further, accepting only `:nth-of-type(1)`.
That is deliberate: the payload's own mint site hardcodes index 1, so any other index
is something we did not write. The narrowing applies in the READ-BACK direction too,
so an anchor this contract calls valid may be dropped — accepted, because loosening a
validator to match a permissive spec is the wrong direction.

The web-chat server stores `anchor` **verbatim with zero validation**, and
`describeAnchor` does not truncate `selector` (FINDINGS §7). An invalid anchor
is dropped, not stored.

### 4.4 `anchor.text` — the label

`"<artboard file> · <x>%,<y>%"`, e.g. `"Pricing.dc.html · 42%,77%"`. It flows
into `anchor_label` and into my prompt, so:

- Derive the artboard name from the pane's **own** artboard index, never from
  frame DOM text.
- **Cap it at 60 characters** before it becomes an anchor. Any value read out of
  the frame (e.g. a `data-mega-artboard` attribute) is influenceable by canvas
  content and must be bounded and sanitised (§9.3).
- If the artboard cannot be identified, use `"on the canvas"`. Never a guess.

### 4.5 Anchor drift

A fraction anchor survives an artboard rewrite and then points *confidently* at
whatever moved into that spot. At pin time record a cheap fingerprint —
artboard box `w`x`h` plus a hash of the artboard's serialised source — inside
the pin's own `anchor` object. On re-projection, a changed fingerprint renders the
marker as **"may have moved"**, not as healthy.

### 4.6 What v0.1.0 does not do

- No element-level precision (needs the capability object — v0.2).
- No `reveal()` — clicking a pin whose artboard is off-screen cannot recentre the
  canvas. The pane must say so rather than dead-clicking (§5.2).
- No pins at all when `isolate: true` — an opaque-origin frame cannot be read.
- **Claude cannot create a pin.** There is no `add_comment` MCP tool; only
  `get_comments` and `reply_comment` exist.

---

## 5. Pane requirements

### 5.1 Execution context

Pane scripts are compiled as `new Function('store','root','params','mountId', body)`.

- **No top-level `await`** — it is a SyntaxError, the script never compiles, and
  the failure is near-silent. Wrap the body in an async IIFE.
- Query via `root` (the shadow root). **Never `document.querySelector`/
  `getElementById`** — they cannot see into the shadow DOM. `document.createElement`
  is fine and is preferred over `innerHTML` for anything data-derived.

### 5.2 Every degraded context renders something useful

| context | detection | render |
|---|---|---|
| node preview / glance card | `location.pathname.startsWith('/preview/')` | Static placeholder. The preview CSP is `default-src 'none'` with no `frame-src` and `connect-src 'none'` — both the frame and the fetch are dead. |
| frozen export | the payload fetch rejects | "This canvas exports as its own file — see `<title>.html`". Never an empty box. |
| non-secure context | `!window.isSecureContext` | Warn **before** mounting the frame. The canvas hangs on a permanent spinner off a secure origin (FINDINGS §5). |
| pin whose artboard is not in view | absent from the projection | Dock the marker to the pane corner with its label. Never drop it. |

### 5.3 The payload carrier must not be mountable

The runtime-written `design-canvas-payload` component appears in
`list_components`, the drawer and the command palette. One accidental mount
writes 2.4 MB into every committed graph node, forever. Its `meta.json` must
carry a `params_schema` that cannot be satisfied from the drawer and a
description that says, first word, that it is a data carrier and not a pane.

### 5.4 Refuse a live-store page

Before mounting, confirm the fetched document's `appifact-doc` block does **not**
carry `store:"db"`. Such a page boots read-only no matter what (§4 of FINDINGS),
and is not ours. Render state `live-store`.

---

## 6. Service requirements

### 6.1 Shape

```js
module.exports = { name: 'design-canvas', async start(ctx) { … }, async stop() { … } };
```

The runner tests `typeof svc.start === 'function'` and **silently no-ops
otherwise** — a bare exported function means the service never starts and the
pane waits forever. `ctx` provides `{ driver, params, mountId, name, log, diff, webChatDir, fence }`.

### 6.2 Self-contained

A component ships exactly four files, so `service.js` **cannot import a helper
module** from this repo. The payload-discovery logic in `scripts/find-payload.mjs`
must be duplicated inline. That duplication is deliberate; keep the two in sync
and say so in a comment at both sites.

### 6.3 What it does

1. Resolve the payload (§1 of FINDINGS). Missing → state `no-payload`, stop seeding.
2. Fence and validate `dir`. Bad → state `bad-dir`, stop seeding.
   `dir` must not CONTAIN either write root (the build tree or the components dir) —
   pointing it at the project root is the natural mistake and must be refused up front
   as `bad-dir`, not discovered as a throw mid-seed.

"Stop seeding" is not "stop". In both degraded states the service still installs the
`dsn_ctl` stream and a quiet recovery poll, because the pane's Reseed button is dead
without them and the fix (running `/design`, creating the directory) happens outside
this process. The poll must not churn: publish only when the state actually changes,
and exactly once per change. Every seed path must be wrapped so that ANY unexpected
throw still publishes a named `seed-failed` — a pane stuck on `seeding` with
`error:null` is the precise failure §3 exists to forbid.
3. Seed: spawn `node <helper> --template <payload> --out <build>/<slug>.html
   --title <title> --artboard … [--canvas canvas.json] [--image …]`.
   - Never pass a flag in final argv position — a trailing flag reads as absent.
   - `--out` must not be a generic name (`design.html`, `index.html`, `main.html`,
     `page.html`, `canvas.html`, `output.html`). Derive a slug from `title`.
   - Non-zero exit → state `seed-failed` with stderr verbatim.
4. Write the seeded file as `<webChatDir>/components/<payload_component>/component.html`
   plus a `meta.json` per §5.3. The registry does a fresh `readdirSync` per call,
   so it is picked up with no restart.
5. Publish `dsn_canvas` + `dsn_files`.
6. If `watch`, watch `dir` for `*.dc.html`, `canvas.json` and image changes;
   debounce **250 ms**; re-seed; bump `seq`.
7. Watch `dsn_ctl` over SSE for `reseed` / `rescan`.

### 6.4 It never writes to `dir`

The working files are the user's. The service reads them and writes only to its
build directory and the carrier component. Any code path that creates, modifies
or deletes a file under `dir` is a bug, not a tradeoff.

### 6.5 Trust

A service is host code and does not start until the user runs
`claude-web-chat trust design-canvas`. Consent is keyed on (project root,
`service.js` contents, params) — so editing the service or changing params asks
again. `SKILL.md` must tell Claude to say that command in chat when mounting the
pane; the pane cannot grant it.

---

## 7. Delivery

The pane fetches `GET /api/components/<payload_component>`, which returns
`{ …meta, source, has_service }` where `source` is the 2.4 MB canvas HTML. It is
same-origin, gated by `requireLocalHost`, needs no new listener and no CORS.

**Forbidden alternatives**, and why:

- Putting the canvas in the pane's own `html` — it is snapshotted into every
  committed graph node.
- Putting it in the store — `POST /api/store` puts the whole patch into the event
  ring, the WS frame and every SSE subscriber, and `get_store` would hand it to me.
- A second loopback HTTP server with `access-control-allow-origin: '*'` — this
  re-introduces a regression `lib/core/cors.js` documents having removed.
- `iframe src=file://` — browsers block http→file frame navigation.

Mount by writing `srcdoc`. `srcdoc` inherits the surface origin, which is what
makes §4 possible and is also the security exposure §9.3 governs.

---

## 8. Test harness

### 8.1 Fixture

`test-fixtures/canvas/` — a small, real, hand-authored canvas: `Main.dc.html`,
one sibling artboard, `canvas.json`, and one small image. It must seed and
`--check` clean. It is the input to every test.

### 8.2 `Uc` port proof

`test/uc-port.test.mjs` must demonstrate our `fileHash12` is byte-identical to
the payload's own `Uc` over a sample of at least 20 paths, by extracting the
payload's implementation at test time from the **local** install (never a
committed copy). Skips with a clear message when the payload is absent.

### 8.3 Pack lint

`npm run lint:pack` drives web-chat's own pack validator against this directory
without pushing (`pack get`/`pack review` need a pushed repo; this must not).

### 8.4 The tripwire

`npm test` runs `scripts/check-no-vendored.mjs`. It fails if any tracked file
matches a hash in `upstream.lock.json`, carries an upstream marker, or exceeds
256 KB.

---

## 9. Invariants

These are not preferences. Breaking one is a defect.

### 9.1 Ship zero upstream bytes
The payload and helper are read from the user's own install at runtime and are
never committed, vendored, or fetched from a network. The repo carries
fingerprints only. No code in this repo extracts assets from the Claude Code
executable.

### 9.2 Only ever display locally-authored canvases
The pane shows canvases seeded from files under `dir`. **Never** a published
Artifact URL, never someone else's canvas, and the service never serves
`claude.db` or `claude.use` — so the payload boots from its embedded seed and
never fetches cross-user content.

### 9.3 The same-origin frame is inside the trust boundary
`srcdoc` inherits the surface origin, and the whole daemon API sits behind only a
Host header. That realm can read private pins **with their text**, forge pins into
my context (the `comment` branch of `policy.classify` has no source gate and
`routing:'none'` does not suppress it), and reach `POST /api/packs/install`.
§9.2 is what makes this acceptable; treat every value read out of the frame as
untrusted input (§4.4).

### 9.4 Pack conventions
- `requires."web-chat"` is `">=0.7.0"`, **not** `>=0.6.0`: `use_component` only
  gained `signals`/`force` in 0.7.0, so a pack declaring a signal at spawn time
  installs happily on 0.6.x and silently loses its wake path.
- A component directory's name is its identity and must equal `meta.json`'s `name`.
- Exactly four files per component install.
- `components` in the manifest is an explicit allowlist.

### 9.5 No `claude.self.publish` stand-in, and the pipeline is ONE-WAY
v0.1.0 does not emulate the artifact-publish capability. Because the pane serves
no `globalThis.claude` at all, **the editor boots read-only** — pan, zoom, look.
There is no Save button to press and nothing on screen to extract.

So the data flow is one-way: **`.dc.html` files → canvas.** The files on disk are
the only source of truth. You change a design by editing them and letting the
service re-seed. The service never writes under `dir` (§6.4), so nothing can
travel back the other way, by construction.

`--extract` is NOT part of this loop. It is the helper's way back into files from
a canvas that was edited *somewhere else* — a published Artifact someone saved —
and it is run by the user, never by this pack. For real WYSIWYG Save, hand off to
a published Artifact via the bundled `design` skill.

> Earlier drafts of this document, the README and the manifest described an
> "edit round trip" through `--extract`. That was wrong and is corrected here;
> if you find that phrasing anywhere else, this section wins.

### 9.6 No personal data
No absolute home paths, usernames, emails or account names in any tracked file.
Examples use `/path/to/…` or `~`.
