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
| `frame_w` | number | no | — | Frame width in px for an artboard whose own source declares no size. Clamped to 120–8000 (§6.3.8). |
| `frame_h` | number | no | — | Frame height in px, same rule. |
| `expand` | `"auto"` \| `"fit"` \| `"fill"` | no | `"auto"` | Per-artboard fit/fill in the synthesised manifest. `auto` decides per artboard from the same evidence that decided its size; `fit`/`fill` force that value on **every** artboard (§6.3.8). |
| `wide_scan` | boolean | no | `false` | Permit the weakest derivation rung — the widest declared px width anywhere in the source. Off by default because it is a heuristic, not a declaration (§6.3.8). |
| `routing` | `"none"` | no | `"none"` | Set `none`. The comment path has its own first-class wake; activity items would be noise. |

`dir` must contain at least one `<Name>.dc.html`. `canvas.json` is optional.
Images (`.png .jpg .jpeg .gif .webp .avif .bmp .svg`) are picked up automatically.

**The four frame params never override a value the user set.** They feed the
frame the service *derives* for an artboard (§6.3.8): the whole manifest when
`dir` has no `canvas.json`, and otherwise only the keys the user's own manifest
leaves out. A `w` they wrote — including a wrong one — is passed through
untouched. They are part of the trust fingerprint (§6.5), like `dir`, `title`,
`isolate` and `watch`, so setting or changing one re-asks
`claude-web-chat trust design-canvas`. Only `routing` is exempt, being read by
the shell rather than by the service.

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
    { "file": "Main.dc.html", "x": 0, "y": 0, "w": 880, "h": 560,
      "w_source": "canvas.json", "h_source": "canvas.json", "expand": "fit",
      "widest_px": null, "can_scroll": null }
  ],
  "layout": "user",              // where that layout came from — see below
  "frames": [
    { "file": "Main.dc.html", "w": 880, "h": 560, "source": "canvas.json",
      "expand": "fit", "widest_px": null, "can_scroll": null }
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
- `warnings` (string[], may be empty) — non-fatal diagnostics worth showing: the
  helper's own stderr warnings, and service-derived notes of the same kind (that
  the frame sizes were synthesised, that a synthesised manifest was withdrawn —
  §6.3.8). Both are prose for a person; neither is machine-read by the pane.
- `save_endpoint` — `{ url, token }`, or `null`. The loopback save listener (§6.6).
  `url` is `http://127.0.0.1:<ephemeral>/save/<64 hex>`. **`null` means the listener
  could not be opened, and the pane MUST NOT install the host object** — that is
  v0.1.0's read-only canvas, a correct degraded state rather than a failure.
  Written in EVERY state, including failure states, so the pane never has to guess.
- `last_save` — the outcome of the most recent Save, or `null` if none has happened
  in this service's lifetime:

  ```jsonc
  { "seq": 3, "at": 1789000000000, "ok": true,
    "written": ["Main.dc.html"], "created": [], "unchanged": ["canvas.json"],
    "orphaned": [],                   // §6.4.5 — removed in the editor, left on disk
    "backup_dir": "/…/backups/…",     // null when nothing was replaced
    "state_bytes": 21057, "warnings": [], "error": null, "hint": null,
    "reseed_seq": 4 }                 // the deliberate post-save re-seed (§6.7)
  ```

  The pane knows the post-save re-seed has landed when
  `dsn_canvas.seq === dsn_canvas.last_save.reseed_seq`.
- `artboards` describes the layout the canvas actually loaded: the entries of the
  `canvas.json` that was seeded — the user's own, that file with omitted keys
  filled in, or one the service synthesised (§6.3.8) — plus one entry per
  `.dc.html` that manifest does not list, mirroring the editor's own auto-append.
  The pane uses it for pin labels and the artboard index; **it must still tolerate
  nulls** on every field but `file`, because a user's manifest may list some boards
  and not others, or omit geometry on the ones it lists.
  Each entry is `{ file, x, y, w, h, w_source, h_source, expand, widest_px,
  can_scroll }` — `x`/`y`/`w`/`h` are numbers or null, the next three are the
  provenance §6.3.8 defines, and the last two are the same evidence fields
  `frames[]` carries below.
- `layout` (string or null) — **where that layout came from**, so the pane can
  explain itself instead of presenting a derived frame as a choice the user made:

  | `layout` | meaning |
  |---|---|
  | `"user"` | `dir`'s own `canvas.json`, passed to the helper exactly as written |
  | `"user-filled"` | their `canvas.json` with keys they **omitted** filled in (§6.3.8) |
  | `"synthesised"` | no `canvas.json` on disk; the service generated the whole manifest |
  | `"none"` | no manifest at all — every artboard gets the editor's 800 x 600 default |
  | `null` | no seed has happened yet (`seeding`, or a failure state) |

- `frames` (array, may be empty) — one entry per artboard the pane can show,
  carrying the frame the editor will use and where that number came from. Empty
  when no artboards are known (`bad-dir`, `no-payload`).
  - `w`/`h` — the px the editor frames the artboard at, **already clamped to
    120–8000**, so what the pane displays is what the canvas uses. `null` when no
    manifest sizes this artboard, which means the editor's own 800 x 600.
  - `source` — `"canvas.json"` (the user's own manifest said so), or one of the
    ladder rungs of §6.3.8, best first: `"$preview"`, `"root-style"`, `"param"`,
    `"wide-scan"`, `"default"`. **`null` means nothing sized it** — the manifest
    was passed verbatim and carries no `w` for this artboard, or there is no
    manifest — so the editor frames it at 800 x 600. When `w` and `h` came from
    different rungs, `source` names the rung that produced **`w`**: width is what
    the ladder ranks on and height follows from it. `artboards[]` carries both
    halves as `w_source` / `h_source` for a pane that wants to show them apart.
  - `expand` — the **effective** value, `"fit"` or `"fill"`, never `"auto"`; `null`
    when nothing sized the artboard. It is reported even when the manifest omits
    it, because `fit` is written by omission.
  - `widest_px` (number or null) — the widest px width declared anywhere in the
    artboard's source: the value rung B2 *would* have used. Reported **even when
    `wide_scan` is off**, so a pane can offer it ("this design declares 1288px —
    remount with `wide_scan`") instead of leaving the user to guess. `null` when
    the source was never scanned (an entry from the user's own manifest) or
    declares no px width.
  - `can_scroll` (boolean or null) — whether the artboard document has a scroller
    of its own (a `$preview`, an `overflow:auto|scroll` container, or its own
    canvas surface). This is what makes `fill` survivable rather than clipping,
    and it is why a wheel over an artboard without one chains out to the surface
    page (§6.3.8). `null` when the source was never scanned.
  - The pane MUST surface `source` next to the size. A frame that is a guess has
    to look like a guess; a design framed wrong looks broken, and the whole point
    of the ladder is that the user can tell which rung they landed on and reach
    for `frame_w`/`frame_h` or a real `canvas.json` when it is the wrong one.

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
   - `--canvas` names the user's own `canvas.json`, or a manifest the service
     writes **into the build directory** — synthesised when `dir` has none, or
     their file with the keys they omitted filled in — so the artboards are framed
     at their real size instead of the editor's 800 x 600 default. See §6.3.8;
     `dsn_canvas.layout` reports which of those actually seeded.
   - Non-zero exit → state `seed-failed` with stderr verbatim.
4. Write the seeded file as `<webChatDir>/components/<payload_component>/component.html`
   plus a `meta.json` per §5.3. The registry does a fresh `readdirSync` per call,
   so it is picked up with no restart.
5. Publish `dsn_canvas` + `dsn_files`.
6. If `watch`, watch `dir` for `*.dc.html`, `canvas.json` and image changes;
   debounce **250 ms**; re-seed; bump `seq`.
7. Watch `dsn_ctl` over SSE for `reseed` / `rescan`.

#### 6.3.8 `canvas.json` synthesis — the frame-size ladder

> Numbered **8** because §6.3.1–§6.3.7 are the steps above and are cited by
> number from `service.js`. This is the detail behind step 3, not a ninth step.

**Why this exists.** With no `canvas.json` the editor frames **every** artboard at
its own default — **800 x 600 px**, then clamped to **120–8000**, silently. The
helper never warns about it either: its numeric check only reports `x`/`y`/`w`/`h`
that are *present and non-numeric*, so an omitted `w`/`h` passes `--check` clean
and arrives as 800 x 600 with nothing said. A 1288-wide design in an 800 x 600
frame is the bug this section exists to prevent — in the canvas view it is drawn
small (the default opening view is zoomed out as well), and content past the frame
edge is unreachable, because a seeded artboard document is pinned to its frame and
the canvas provides no scroll container.

**Two mechanism facts that constrain the fix.** Both verified against the payload;
neither is inferred.

- `expand` is read **only** while an artboard is focused/fullscreen. The
  un-focused canvas view always frames an artboard at its `w` x `h`.
  **No value of `expand` can correct a wrong frame — only `w`/`h` can.**
- `fit` (the default) keeps the frame at `w` x `h` and scales the *view* down to
  fit, **never up**. `fill` resizes the *frame* to the surface box at scale 1 — so
  a design that cannot reflow or scroll is **clipped**, permanently, with no way
  to reach the rest. Correct frames make `fit` right; they do not make `fill` right.

**When it happens.** Whenever at least one `.dc.html` was found, in one of two
shapes, reported as `dsn_canvas.layout`:

- **`"synthesised"`** — `dsn_files.has_canvas_json` is `false`. The service builds
  the whole manifest, listing every artboard.
- **`"user-filled"`** — `dir` has a `canvas.json` and it leaves keys out. The
  service fills **only** keys that are `undefined`, and only on entries naming an
  artboard that is present.

Otherwise nothing is written and `layout` reports the status quo: `"user"` (their
manifest, passed as written, because it has no gaps or the service must not touch
it) or `"none"` (no manifest at all — every frame is the editor's 800 x 600).

**An explicit `canvas.json` always wins.** Filling a gap is a *repair*, never a
rewrite. Precisely:

- A key the user wrote is passed through untouched — **including a wrong one**, so
  the helper's own refusal still names the value they wrote.
- `x`/`y` are filled only alongside a `w`/`h` the service filled, and are placed
  clear of every box the user positioned (the editor's own append origin: to the
  right of the rightmost frame, 80 px on, at the topmost `y`). A filled entry
  never lands on top of one they placed.
- `expand` is filled only when the size was the service's to derive — an entry
  whose `w` **they** set is a box they chose, and `fit` shows all of it — or when
  the `expand` param explicitly asks for `fill` everywhere.
- Artboards their manifest does not list are **not added**. Adding entries the
  user did not write is the rewrite half; those boards keep the loader's own
  behaviour (appended at 800 x 600) and their `frames[].source` is `null`.
- The user's manifest is filled **only if it already parses, is the right shape,
  and passes the mirror of the helper's own validation** below. Anything else is
  handed to the helper untouched, so the fatal `--canvas <path>: …` names *their*
  file and the rule it broke — that stderr is the `seed-failed` hint (§3), and it
  has to point at a file they can open.

**Where the file goes** — synthesised or filled, it is the same path:
`path.join(buildDir, 'canvas.json')`, written through `assertWritable`, where
`buildDir` is `<webChatDir>/.wc-design-build/<carrier>`.
**Never under `dir`** — §6.4 is unconditional and this is not an exception to it.
`payload.template.html` and `seed-canvas.mjs` are used 1:1 and are never modified.

**The ladder.** Per artboard, best signal first. All of it is **bounded string
parsing of untrusted content** (§9.3): the design is never executed, the source
scan is capped at 512 KB, a `data-props` attribute at 64 KB, and every global
regex has a bounded iteration count.

| rung | `source` | signal | how it is read |
|---|---|---|---|
| A | `"$preview"` | `$preview: {width, height}` inside the artboard's `data-props` | The format's own size hint, and the strongest one: an artboard carrying it is declaring an intrinsic size. Parse the attribute, un-escape it, `JSON.parse`, and **validate the numbers yourself** (finite and > 0) — the runtime accepts any object there. |
| B | `"root-style"` | an explicit px box in the `style` of the artboard's root element | The first element inside `<x-dc>` that is not `<helmet>`. `width` › `max-width` › `min-width`; `height` › `min-height` › `max-height`. **`px` only.** |
| C | `"param"` | `frame_w` / `frame_h` | Exact by definition, but canvas-wide, so it ranks *below* A and B: a per-artboard declaration in the file beats a param that applies to all of them. To override a declaring artboard, change the artboard or write a `canvas.json`. |
| B2 | `"wide-scan"` | the widest `width:`/`max-width:` px value anywhere in the source, 320–8000 | Weak: a heuristic, not a declaration. **Only used when `wide_scan` is true**, and a frame that rests on it reports `source: "wide-scan"`, so it can never pass for a declaration. |
| D | `"default"` | the documented fallback | **1440** wide. Height, whenever it is not otherwise known, is `max(1024, round(w × 0.75))`. |

**Refuse, never coerce.** A candidate value containing `{{` or `}}` is a template
hole, not a number, and is rejected outright — the helper warns about holes in
style attributes for exactly this reason, and a coerced `NaN` would land straight
back on 800.

**The height bias is deliberate, not taste.** An over-tall frame costs blank
canvas; an under-tall frame destroys content, because the document is pinned to
its frame and nothing inside can reach the rest. `fit` never scales up, so
over-tall is cheap.

**Rules a manifest the service writes must satisfy.** Each one is a failure mode
of the loader or the helper, not a style preference. Rules 1 and 5 apply to a
**`"synthesised"`** manifest only — a `"user-filled"` one adds no entry and no
top-level key the user did not write.

1. **List every `.dc.html`.** An unlisted artboard is appended by the editor at
   the 800 x 600 default with an 80 px gap — a partial manifest leaves the bug
   in place for exactly the boards it omits.
2. **Always emit `x` and `y` alongside `w`/`h`.** The helper's overlap check only
   scans entries where all four are numeric, so `w`/`h` without `x`/`y` stacks
   every artboard at the origin and says nothing. Lay them out left to right with
   an **80 px** gap, mirroring the editor's own auto-append.
3. **Clamp `w`/`h` to 120–8000 before writing**, so the stored value and the
   editor's value agree.
4. **Emit only the keys an artboard entry may carry** — `file`, `x`, `y`, `w`,
   `h`, and optionally `title`, `expand`, `print`, `page`, `is_interactive`. A
   stray key at any level is **fatal** at seed time. Omit `expand` when it would
   be `"fit"`: the default loads as exactly the default it names, so writing it
   is legal but noise.
5. **Single-artboard canvases get `launch: {view: "focused", file: <that board>}`.**
   It opens on the design at fit-to-pane instead of the zoomed-out canvas view,
   which is most of the felt "the page is shrunk". `file` must be a listed
   artboard and a focused launch must carry no `page`. **Multi-artboard canvases
   leave `launch` absent** — choosing one board's view for the user is not ours to
   do.
6. **A manifest costs one of the editor's 200 file entries**, and the helper
   refuses a 201st. When the artboards and images already fill the budget, add no
   manifest, say so in `warnings`, and let the frames stay at the default.
7. **A generated manifest must never turn a working canvas into `seed-failed`.**
   Every `canvas.json` problem is fatal at seed time, so a manifest the helper
   refuses would break a canvas over a file the user never wrote. Two defences,
   both required:
   - **Self-check first** against a mirror of the helper's fatal `canvas.json`
     rules — closed key sets, every listed file present and listed once, numeric
     `x`/`y`/`w`/`h`, the `expand`/`print` vocabularies, `launch` shape, no
     overlap. On failure, do not pass it at all.
   - **Then fall back.** Seeding is an ordered list of attempts: the manifest the
     service wants, then the *status quo ante* — the user's own file, or no
     `--canvas` at all. If the helper refuses ours, re-run with the fallback and
     record a `warnings` note saying so. `layout` then reports what actually
     seeded, not what was attempted.

**`expand`, resolved per artboard.** With `expand: "auto"`, from the same evidence
that decided the size:

| evidence | `expand` |
|---|---|
| any rung produced a width — `$preview`, a fixed-px root box, `frame_w`, or the wide scan | `"fit"` — the frame is a definite box, and `fit` shows all of it |
| no size signal, **and** the source has its own `overflow:auto\|scroll` container or declares its own canvas surface | `"fill"` — genuinely fluid and scrollable, which is what `fill` is for |
| no size signal and no scroller | `"fit"` — `fill` would resize the frame to the pane and clip a document that cannot scroll |

`expand: "fit"` or `"fill"` forces that value on every artboard and skips the
table. `fill` is not the safe blanket default: it is right only for a fluid-width
root that can scroll, and wrong — irreversibly, by clipping — for anything else.
The editor's own Fit/Fill toggle still flips it live either way, so the user is
never locked in.

**The frame is baked at seed time** and does not track the pane's size. Resizing
the browser re-lays-out the *view*, not the frames; only a re-seed changes them.

### 6.4 It writes to `dir` ONLY through the save path

> **Reversed in v0.2, deliberately.** This section used to read "It never writes
> to `dir`", and that was the right rule while the pipeline was one-way. Edit
> mode (§9.5) makes Save write the user's own edits back to their own files, so
> the rule is now a narrow licence rather than a prohibition. Nothing else about
> the service may write there.

The working files are the user's. The ONLY code path permitted to modify them is
`saveBack()` (§6.6). Seeding, watching, the carrier and every diagnostic write to
the build directory or the carrier component and never to `dir`.

`saveBack()` must satisfy all of:

1. **Extract first, write second.** Nothing under `dir` is touched until
   `--extract` has exited 0 AND returned at least one `<Name>.dc.html`. An empty
   or failed extract aborts with the user's files bit-identical.
2. **Back up every file it replaces**, under the build tree, before the first
   byte is written. A bad save must be recoverable.
3. **Write-then-rename**, per file, so a crash cannot leave a half-written file.
4. **Roll back the whole batch** if any file fails mid-way.
5. **Never delete.** An artboard removed inside the editor simply will not come
   back from the extract; report it as orphaned and leave the file alone.
6. **Compare `canvas.json` by meaning, not bytes.** It round-trips through the
   helper's own `JSON.stringify`, so byte-comparing would rewrite the user's
   hand-formatted manifest on every save.
7. **Suppress the watcher** for its own writes, or Save triggers a re-seed that
   fights the editor (§6.7).

### 6.5 Trust

A service is host code and does not start until the user runs
`claude-web-chat trust design-canvas`. Consent is keyed on (project root,
`service.js` contents, params) — so editing the service or changing params asks
again. `SKILL.md` must tell Claude to say that command in chat when mounting the
pane; the pane cannot grant it.

### 6.6 The save transport

The edited document is ~2.5 MB, but its state block — the user's actual content —
is under 1% of that (measured: 19,777 bytes of a 2,495,380-byte page), and
`--extract` accepts a minimal page carrying only that block. **Only the state
block travels.**

It must NOT travel through the store: `POST /api/store` puts the whole patch into
the event ring, the WS frame and every SSE subscriber, and `graph.js` snapshots
the store into every committed node. A canvas with images would push six figures
into every node forever.

So the service opens a **loopback save listener**:

- bound `127.0.0.1` on an ephemeral port, POST only, body capped
- a per-spawn random path token
- `Access-Control-Allow-Origin` echoing the request's Origin **only** when it is a
  `localhost` / `127.0.0.1` origin. Never `*` — a wildcard here would re-introduce
  the regression `lib/core/cors.js` documents having removed.
- published to the pane as `dsn_canvas.save_endpoint = { url, token }`

**The frame never learns the endpoint.** The shim posts to the PANE with
`parent.postMessage`; the pane validates `event.source === frame.contentWindow`
and forwards. The pane is the only thing that talks to the listener.

### 6.7 Watcher suppression

The service watches `dir` and re-seeds on change, and Save now writes to `dir`.
Without care that is a loop: Save → write → watcher → re-seed → pane reload,
fighting the editor and discarding in-flight work.

`saveBack()` must record the paths and mtimes it wrote and have the watcher ignore
exactly those for a bounded window, then re-seed **once**, deliberately, so the
carrier matches what is now on disk.

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

### 9.5 Edit mode: one host member, and Save is REAL

> **Reversed in v0.2 by the repository owner**, who runs this on their own
> hardware against their own files. v0.1.0 served no host object at all, so the
> editor booted read-only. That was a deliberate choice and it is now a different
> deliberate choice. The reasoning is recorded here rather than left implicit.

The pane defines exactly ONE host member before the payload's scripts run:

```js
globalThis.claude = { self: { publish: async (html) => { /* … */ } } };
```

- **One member only.** `use()` is deliberately NOT defined: it is not required,
  and defining it switches on presence probing a single-user local host has no
  business doing. Nothing remote-only is ever served (§9.2 still holds — no `db`,
  no `room`, no published-Artifact URLs).
- **Injection is a splice after `<head>`**, not a rewrite. The payload's `<head>`
  opens at byte 33 and its first `<script>` is ~490 KB in, so one `<script>`
  spliced at the head boundary runs before anything and touches nothing else.
  Verified: script-tag count goes 22 → 23 and the state block is untouched.
- **Save is real.** The handover is written back to the user's own `.dc.html`
  files through the helper's own `--extract` (§6.4, §6.6). A Save that did not
  durably persist would be the genuinely harmful design and is not what this is.

#### Error discipline — the part that can brick a tab

The host's rejection value decides what the editor tells the user, and one class
of value is unrecoverable:

| reject with | editor behaviour |
|---|---|
| a plain `Error` | normalises to a recoverable failure: one automatic retry, then *"Saving failed (…). Your changes are kept — try again."* The document stays editable and dirty. **This is the only failure we may emit.** |
| `not_writer`, `not_declared`, `capability_disabled`, `capability_removed` | writes a **sticky `sessionStorage` read-only pin that cannot be cleared from the UI**. In a `srcdoc` frame that key is tab-global, so one of these bricks editing for the whole tab. **Never construct these values.** |

`publish` takes one argument — the complete document — is awaited, and its return
value is discarded. There is no version token on the call; a single-user local
host has no compare-and-set to perform.

### 9.6 No personal data
No absolute home paths, usernames, emails or account names in any tracked file.
Examples use `/path/to/…` or `~`.
