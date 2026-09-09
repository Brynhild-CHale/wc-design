---
name: wc-design
description: A live Claude Design canvas on the web-chat surface, seeded from .dc.html working
  files on disk and re-seeded by a host service every time one of them changes — so the user
  watches the layout change as you write it, instead of reading you describe it. Use when the
  ask is visual and the answer is a layout rather than a paragraph — "mock this up", "show me
  the design", "let me see the artboards", "design a poster / landing page / flyer / one-pager",
  "iterate on this layout", "what would that actually look like" — and reach for it unprompted
  whenever you are about to describe a screen you could put on screen instead. The user drops
  comment pins straight onto the canvas and they come back to you through the normal
  `get_comments` path, which is what makes this a loop rather than a screenshot. One pane,
  `design-canvas`, service-backed — it takes an absolute `dir` of artboards inside the project
  and a content-named `title`, and it does not start until the user runs
  `claude-web-chat trust design-canvas` in their terminal — say that command in chat in the same
  turn you mount the pane, or it sits empty and nobody knows why. v0.1.0 is a viewer plus pins —
  no in-pane Save, no element-level pin precision, and the .dc.html files are the only source of
  truth. Ships none of Anthropic's code — the editor payload is read from the local Claude Code
  install, so when it is missing the fix is to run `/design` once.
---

# wc-design

One component, `design-canvas`. It shows a live Claude Design canvas on the web-chat surface,
seeded from `.dc.html` working files on disk. A host-side service watches those files and
re-seeds when they change, so the pane tracks your edits without a turn of yours in the loop.
Comment pins work over the canvas and reach you through the normal `get_comments` path. The pack
ships none of Anthropic's code — the editor payload is read at runtime from the local Claude Code
install.

**The shape of the work is: you write files, the user watches and pins, you write files again.**
The pane is where the design is *seen* and *annotated*; `Write` and `Edit` on the `.dc.html`
files are where it is *changed*. Nothing about the pane edits anything for you.

## Mounting it

```js
use_component({
  name: 'design-canvas',
  id: 'design-canvas-main',
  params: {
    dir: '/path/to/project/design/spring-menu',  // absolute, and INSIDE the project root
    title: 'Spring Menu Poster',                 // what the design is CALLED — content, not "Design"
    watch: true,                                 // default: re-seed when a file under dir changes
    isolate: false,                              // default. true sandboxes the frame AND kills pins
    routing: 'none'                              // INSIDE params — see below
  },
  signals: [{ key: 'dsn_ask', wake: 'queue' }]   // TOP-LEVEL — not inside params
})
```

**`signals` is top-level, `routing` goes inside `params`.** That asymmetry is the easiest thing
to get wrong. `use_component` destructures `name`, `params`, `id`, `target`, `force` and
`signals` and nothing else, so a top-level `routing: 'none'` is dropped on the floor with no
error. Pass `signals` at the top level and let the tool fold it into `params.signals` — that
nested shape is what the daemon derives its wake registry from, so writing it there by hand also
works, but the top-level form is the documented one and the one the tool schema advertises.

Declaring signals at spawn time is why this pack requires web-chat **>= 0.7.0**: on 0.6.x
`use_component` destructures only `name`, `params`, `id` and `target`, so the array is dropped and
`dsn_ask` is never declared — and because `routing: 'none'` also suppresses the
undeclared-activity fallback, the user's Ask Claude payload then reaches you as nothing at all.

`routing: 'none'` is deliberate here — the pin path has its own first-class wake, and per-mount
activity items for pan/zoom would be pure noise. It does **not** suppress `dsn_ask`; the queue
classifier tests declared keys before it tests the routing opt-out.

Use a stable mount id (`design-canvas-main`) and re-render it to replace in place. A random id
stacks a second 2.4 MB canvas frame onto the surface.

## Say the trust command. In chat. In the same turn.

`design-canvas` carries host code — a service that reads the working files and runs the seeding
helper — so **it does not start until the user runs this in their terminal**:

```sh
claude-web-chat trust design-canvas
```

**This is the single most common way this pack fails.** The pane can *name* the command but
cannot grant it, because the pane's own script runs in the page the gate exists to gate. Mount it
and stay silent and the user gets an empty panel, no canvas, and no idea why. Say the command,
and say what it grants while you are there: the service reads the artboard files under `dir`,
runs the local seeding helper, and **never writes to `dir`** — the working files are the user's.

Bare `claude-web-chat trust` lists what is waiting; `--deny` refuses. Consent is keyed to
(project root, `service.js` bytes, params), so a new project, a pack bump, or a changed `dir` or
`title` asks again. That is correct — `dir` is exactly what widens the service's reach.

Two lifetime facts before you promise the user anything: the service runs **only while its pane
is on the active node with a browser watching** (navigate away and it stops; navigate back and it
respawns and re-seeds), and on a first spawn — which is also waiting on the trust command — the
canvas lands in the store for your *next* turn, not this one.

## Setup: the editor payload

The canvas editor is read from the copy Claude Code writes to disk when its bundled `design`
skill runs. When it is not there, `dsn_canvas.state` is `no-payload` and the fix is one line:
**ask the user to run `/design` once in Claude Code.** Say that; do not narrate the machinery
behind it.

## `dir` — the param that matters

Pass it **absolute**, and put it **inside the project root**. The service fences `dir` against
the project, and a path that escapes is a hard `bad-dir`, never a quiet fallback to somewhere
else. `/path/to/project/design/<slug>/` is the shape that works.

`dir` must hold at least one `<Name>.dc.html`. `canvas.json` is optional; images
(`.png .jpg .jpeg .gif .webp .avif .bmp .svg`) beside the artboards are picked up automatically.

**Only ever point it at the user's own locally-authored files.** Not a published Artifact URL,
not someone else's canvas. The frame is same-origin with the daemon, so what is in it is inside
the trust boundary; "these are the user's own design files" is what makes that acceptable. For
anything you did not author here, pass `isolate: true` and accept losing pins.

## The authoring loop

1. `Write` / `Edit` the `.dc.html` files (and `canvas.json`) under `dir`.
2. The service's watcher fires, debounces 250 ms, and re-runs the seeding helper.
3. `dsn_canvas.seq` bumps and the pane re-fetches the canvas.

That is the whole loop, and you are not in step 2 or 3. Write the file and tell the user to look;
do not re-render the pane to "refresh" it.

If you need to force it — you touched something the watcher does not cover, or `watch: false` —
write the control key. **`set_store` takes a `patch` wrapper**; without it the write merges
nothing and still returns `ok: true`:

```js
set_store({ patch: { dsn_ctl: { seq: Date.now(), op: 'reseed' } } })
```

## Authoring a `.dc.html` artboard

An artboard is one self-contained HTML file whose name is its identity. This is the skeleton, and
the head line is not decorative:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
  <helmet><style>body { margin: 0; font-family: system-ui, sans-serif }</style></helmet>
  <section style="position: relative; width: 880px; height: 560px; background: #141413">
    <div style="position: absolute; left: 48px; top: 96px; color: #faf9f5; font-size: 44px">{{headline}}</div>
    <sc-for list="{{dishes}}" as="d">
      <div style="color: {{d.color}}">{{d.name}} — {{d.price}}</div>
    </sc-for>
    <sc-if value="{{hasSpecial}}">
      <button onClick="{{showSpecial}}" style="border: 0; padding: 12px 18px">Today's special</button>
    </sc-if>
  </section>
</x-dc>
<script data-dc-script data-props='{"headline":{"editor":"text","default":"Spring, on a plate"}}'>
class Component extends DCLogic {
  renderVals() {
    const dishes = (this.state.dishes ?? []).map(d => ({ ...d, color: d.sold ? '#8a857c' : '#faf9f5' }));
    return {
      headline: this.props.headline ?? 'Spring, on a plate',
      dishes,
      hasSpecial: dishes.length > 0,
      showSpecial: () => this.setState({ open: true })
    };
  }
}
</script>
</body>
</html>
```

The five things authors actually trip over:

- **`<script src="./support.js"></script>` must be kept verbatim**, in the head, exactly as
  written. The editor needs that exact line; the helper only *warns* when it is missing, so a
  broken artboard seeds happily and renders wrong.
- **A hole is a dotted lookup and nothing else.** `{{headline}}`, `{{d.color}}`, `{{t.label}}`.
  It is **not an expression language**: everything outside `{{ }}` is plain text, so
  `style="color: {{x}} ? a : b"` is not a ternary — it is an invalid CSS declaration that gets
  dropped. The helper has a warning for exactly this shape (`}} ?` inside a style attribute).
  Compute the value in `renderVals()` and bind the result.
- **Events are camelCase attributes whose whole value is one hole.** `onClick="{{add}}"`,
  `onInput="{{setDraft}}"`, `onKeyDown="{{onEnter}}"`. Not `onclick`, and never inline JS.
- **`sc-for` / `sc-if` are the only control flow.** `<sc-for list="{{items}}" as="x">` binds `x`
  for the subtree; `<sc-if value="{{flag}}">` shows or hides it. Loop data and booleans are
  computed in `renderVals()`, not in the markup.
- **The filename is the artboard's identity.** `<Name>.dc.html`, starting with a letter, digit or
  underscore, then letters/digits/spaces/dots/hyphens/underscores; no `..`, no slashes, no
  Windows device names, and unique **case-insensitively**. Name the entry artboard
  `Main.dc.html` — without one the editor silently promotes the first `.dc.html` by name.

Caps that bite when you generate content: **2 MiB per file entry**, **200 entries total**, and
images are stored as bare base64, so keep each image under ~70 KB (the helper warns past 96 KB of
base64 and refuses past 2 MiB). Over the per-file cap the editor drops the entry at load, so it
renders missing rather than erroring.

**The `title` is gated on purpose.** No `< > & "` backslash or control characters, at most 120
characters, and generic names are refused outright — `design`, `canvas`, `design canvas`,
`new design`, `untitled`, `appifact`, `artifact`. Name it from what the user asked for; the
service derives the seeded filename from it and generic filenames are refused the same way.

### `canvas.json`, when you want a layout

Optional. Omit it and the artboards lay out in a row. When you write one, the loader reads a
**closed set of keys** and the helper refuses anything else rather than letting the editor drop it
silently:

| level | keys |
| --- | --- |
| top | `artboards`, `annotations`, `pages`, `launch` — nothing else |
| an artboard entry | `file`, `x`, `y`, `w`, `h`, `title?`, `expand?`, `print?`, `page?`, `is_interactive?` |
| an annotation (sticky note) | `id`, `x`, `y`, `w`, `text`, `page?`, plus `kind`/`size`/`bold`/`italic`/`color` |
| `launch` | `{view:"canvas", page?}` or `{view:"focused", file}` |

Every listed `file` must be a real `.dc.html` beside it, listed once. `expand` is `fit`|`fill`,
`print` is `fixed`|`flow`. Leave at least **80 px between frames** — the name strip sits above
each one, and overlapping boxes get a warning. Unlisted artboards are appended automatically, so
a partial manifest is fine.

### When a seed fails

`dsn_canvas.state` goes `seed-failed` and `hint` carries the helper's **stderr, verbatim**. That
text is written to be read — it names the file, the key and the consequence. Quote it to the user
and fix the file; do not guess, and do not hand-edit the seeded page (the service owns it and the
next re-seed overwrites it).

## Store keys

Prefix `dsn_`. The service writes, the pane reads — except `dsn_ctl`, which is the reverse.

| key | direction | shape |
| --- | --- | --- |
| `dsn_canvas` | service → pane | `{ seq, ok, state, payload_component, title, artboards:[{file,x,y,w,h}], seeded_at, bytes, upstream:{version,payload_sha256}, error, hint }` — written in **every** state, including failure |
| `dsn_files` | service → pane | `{ seq, dir, files:[{name,bytes,mtime}], has_canvas_json }` — what is actually on disk |
| `dsn_ctl` | pane → service | `{ seq, op }`, `op` ∈ `reseed` \| `rescan` — **control key**, never a signal |
| `dsn_ask` | pane → Claude | `{ seq, note, artboard }` — **declared signal**, `wake: 'queue'` |

Every payload carries a monotonically increasing `seq`; compare it against the last one you
handled to tell a fresh state from a replay. `artboards[]` comes from `canvas.json` when there is
one and otherwise carries null geometry — tolerate the nulls.

**Read `dsn_canvas.state` before concluding anything.** It is a closed set, and collapsing any
two of these re-creates the silent failure the pack exists to avoid:

| state | means | what you do |
| --- | --- | --- |
| `ready` | seeded and on screen | talk about the design |
| `seeding` | first seed in flight | wait a turn |
| `no-payload` | the editor is not on this machine | ask the user to run `/design` once in Claude Code |
| `bad-dir` | `dir` missing, empty of artboards, or fenced out | fix the path — it names what it expected |
| `seed-failed` | the helper exited non-zero | read `hint` (its stderr, verbatim) and fix the file |
| `live-store` | the page keeps its design in a live store — a claude.ai canvas, not ours | refuse; it cannot be edited from here |

### `dsn_ctl` does not wake you

The pane writes it, the service watches it over SSE and reacts. **A user panning, zooming and
re-seeding starts no Claude turn and produces no queue item.** `seq` must strictly increase; a
repeat or a regression is dropped in silence. Both ops are reads — `reseed` re-runs the helper,
`rescan` re-reads the directory listing only — so there is nothing here you must keep your hands
off. It is also not a way to fetch data: you will not see the result until your next turn. If you
need to know what is in an artboard *now*, `Read` the file.

### `dsn_ask` is the wake path

One deliberate affordance on the pane ("Ask Claude about this canvas") writes it, `wake: 'queue'`.
It is not `immediate` — the user decides when to hand off. Declare it on **every** mount, and
tell the user the key in chat in the same turn:

> "Hit **Ask Claude** on the canvas and it writes `dsn_ask` with whatever you type — then
> **Push → Claude** and I'll pick it up."

The `<channel>` tag carries a summary only. Fetch the payload:

```js
get_store({ keys: ['dsn_ask', 'dsn_canvas', 'dsn_files'] })
```

Then edit the artboard the note names and let the re-seed carry it back to the pane. Re-mounting
is not part of that loop.

## Pins

**Pins work over the canvas and arrive through the ordinary path** — `get_comments` to read them,
`reply_comment` to answer in-thread, and the `respond-to-comment` skill when a wake points you at
one. A shared pin reaches you on the user's Push like any other pin.

What a pin on this canvas is, precisely:

- **Artboard-fraction precision, not element precision.** A pin anchors to a point on an
  artboard, and its label reads `Pricing.dc.html · 42%,77%`. It does not know which element it
  landed on. Treat the label as *where on the board*, and read the artboard source to work out
  what is actually there.
- **A pin can go stale confidently.** A fraction anchor survives an artboard rewrite and then
  points at whatever moved into that spot, so the pane fingerprints the artboard at pin time and
  renders a marker whose board has since changed as **"may have moved"**. Never quote such a
  pin's position as authoritative — reread the current source before you act on it.
- **No `reveal()`.** Clicking a pin whose artboard is off-screen cannot recentre the canvas; the
  pane docks that marker to the corner with its label instead of dead-clicking. Say "it's on
  `Pricing.dc.html`" rather than "click through to it".
- **`isolate: true` means no pins at all.** An opaque-origin frame cannot be read from.
- **You cannot create a pin.** There is no `add_comment` tool — only `get_comments` and
  `reply_comment`. Point at an artboard by name in chat instead.

## What v0.1.0 cannot do

State these plainly rather than letting the user discover them.

- **No in-pane save, and no WYSIWYG editing.** The pane serves no host object to the canvas, so
  the editor boots read-only: pan, zoom, look. Anything nudged on screen is gone on the next
  re-seed or reload. **The `.dc.html` files under `dir` are the only source of truth.** When the
  user wants real click-to-edit-and-Save, that is a published Artifact — hand off to the `design`
  skill and say why you are switching surfaces.
- **No element-level pin precision, and no `reveal()`** (above).
- **No pins under `isolate: true`.**
- **The pane is empty in a node preview and in a frozen export.** Both are expected: the preview
  CSP kills the frame and the fetch, and an exported page has no server to fetch from. `export`
  also drops pin threads. The right shareable artefact for a canvas is the **seeded `.html`
  itself** — it is already self-contained and interactive.
- **The canvas needs a secure context.** `localhost` / `127.0.0.1` / `https` are fine; a LAN IP
  or a bare hostname over plain http hangs the canvas on a permanent spinner. Do not suggest
  binding the daemon wide so a phone can view it.

## When not to use the pane

- **A one-line answer does not need a panel.** "The CTA is the only thing below the fold" is a
  sentence.
- **A single static image does not need a canvas.** One diagram, one chart, one illustration —
  render SVG on the surface, or reach for the pictorial pack. A canvas earns its cost when there
  are multiple artboards, a layout, and iteration.
- **You need the design source for yourself, right now.** `Read` the `.dc.html`. The pane is for
  the user's eyes and its data reaches you next turn.
- **The user wants the real editor with Save.** Publish an Artifact via the `design` skill.
- **The pane is already mounted and nothing changed.** Mounts persist and the service keeps them
  current — reference `design-canvas-main` by what is on screen instead of re-rendering.
- **The canvas is not the user's own.** Never point `dir` at someone else's canvas or a published
  page; if you must show one at all, `isolate: true` and no pins.
- **There is no payload and the user does not want to run `/design`.** Say so and work in files;
  do not leave a dead pane sitting on a `no-payload` refusal.
