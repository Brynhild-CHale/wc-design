---
name: wc-design
description: A live, EDITABLE Claude Design canvas on the web-chat surface, seeded from .dc.html
  working files on disk and re-seeded by a host service every time one changes — so the user
  watches the layout change as you write it, then clicks in and changes it themselves. Use when
  the ask is visual and the answer is a layout rather than a paragraph — "mock this up", "show me
  the design", "design a poster / landing page / one-pager", "iterate on this layout", "what
  would that actually look like" — and reach for it unprompted whenever you are about to describe
  a screen you could put on screen instead. Comment pins land on the artboards and come back
  through the normal `get_comments` path. One pane, `design-canvas`, service-backed — an absolute
  `dir` of artboards inside the project plus a content-named `title` — and it does not start
  until the user runs `claude-web-chat trust design-canvas` in their terminal, so say that
  command in chat in the same turn you mount it or it sits empty and nobody knows why. EDITING
  AND SAVE ARE REAL: click-to-select, a properties menu, inline rich text, undo/redo, and a Save
  that writes the user's edits back into the very .dc.html files you author — so those files
  CHANGE UNDER YOU. Re-read before assuming what is on disk; never blind-overwrite a file the
  user may just have edited on the canvas. Editing needs the trust-approved service running, and
  `isolate: true` turns it off. Ships none of Anthropic's code — the editor payload is read from
  the local Claude Code install, so when it is missing the fix is to run `/design` once.
  KNOWN BREAK: Claude Code 2.1.278 no longer writes that payload, so on that build the pane
  reports `no-payload` and `/design` does NOT fix it — tell the user the pack is broken on this
  build and a fix is being explored, rather than mounting it and sending them round that loop.
---

# wc-design

> **⚠️ KNOWN BREAK — Claude Code 2.1.278. A fix is being explored.** On 2.1.278 `/design` only
> manages agent access to hosted Claude Design projects (`/design consent` / `/design revoke`)
> and no longer writes the editor payload this pack reads, so `dsn_canvas.state` is `no-payload`
> and the "run `/design` once" remedy below CANNOT work. **Alert the user the first time this
> skill comes up:** check `claude --version`; if it is 2.1.278 or later and the state is
> `no-payload`, say the pack is broken on this build pending a fix, do not send them to `/design`,
> and work in the `.dc.html` files directly (render them as plain panes if they need to see
> them). Their files are not affected.

One component, `design-canvas`. It shows a live Claude Design canvas on the web-chat surface,
seeded from `.dc.html` working files on disk. A host-side service watches those files and
re-seeds when they change, so the pane tracks your edits without a turn of yours in the loop.
Comment pins work over the canvas and reach you through the normal `get_comments` path. The pack
ships none of Anthropic's code — the editor payload is read at runtime from the local Claude Code
install.

**The canvas is editable, and Save is real.** The pane installs the editor's host object, so the
user gets the actual editing chrome — click-to-select, the quick menu, inline rich text,
undo/redo, Save — and hitting Save writes their edits back into the `.dc.html` files under `dir`,
through the seeding helper's own `--extract`. This pack runs on the user's own machine against
the user's own files; that is what makes writing to them the right behaviour rather than a
liberty.

**So the shape of the work is a loop with two writers in it: you write files, the user watches,
pins and edits, and the files come back changed.** Two consequences you must actually act on:

- **Re-read before you assume.** A `.dc.html` you wrote three turns ago may not be the one on
  disk. `Read` it before you reason about it, quote it, or diff against it.
- **Never blind-overwrite.** Do not `Write` a whole artboard from memory or from your own earlier
  draft. Read first, then `Edit` the part you mean to change — a full-file `Write` silently
  discards whatever the user just did on the canvas, and their Save is not in your context.

`dsn_files[].mtime` and a bumped `dsn_canvas.seq` are the cheap tell that a save happened while
you were away.

## Mounting it

```js
use_component({
  name: 'design-canvas',
  id: 'design-canvas-main',
  params: {
    dir: '/path/to/project/design/spring-menu',  // absolute, and INSIDE the project root
    title: 'Spring Menu Poster',                 // what the design is CALLED — content, not "Design"
    watch: true,                                 // default: re-seed when a file under dir changes
    isolate: false,                              // default. true sandboxes the frame — kills editing AND pins
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

Four more optional params — `frame_w`, `frame_h`, `expand`, `wide_scan` — control how big the
artboards are framed when `dir` has no `canvas.json`. They matter more often than they look:
get them wrong and the design is drawn at the editor's 800 x 600 default. See
**How big an artboard is** below before reaching for them.

That is the whole param list — there is no `edit` switch. A mounted canvas is editable whenever
the service is running and `isolate` is off, and that is the intended default.

## Say the trust command. In chat. In the same turn.

`design-canvas` carries host code — a service that reads the working files and runs the seeding
helper — so **it does not start until the user runs this in their terminal**:

```sh
claude-web-chat trust design-canvas
```

**This is the single most common way this pack fails.** The pane can *name* the command but
cannot grant it, because the pane's own script runs in the page the gate exists to gate. Mount it
and stay silent and the user gets an empty panel, no canvas, and no idea why.

Say the command, and say what it grants while you are there, accurately — it is a write grant
now, not a read grant. The service reads the artboard files under `dir`, runs the local seeding
helper, and **writes back into `dir` when the user hits Save in the canvas, and only then**.
Nothing else about it touches those files: seeding, watching, the derived `canvas.json` and every
diagnostic go to its own build directory under `.web-chat/`. Say that plainly rather than letting
the user find out from a changed file.

**Trust is also what makes editing work at all.** Save has nowhere to go without the service: the
pane hands the document to a loopback listener the service owns, so an untrusted (or stopped)
service means the canvas still edits on screen but the Save fails. Same for the two lifetime
rules below — off the active node, or with no browser watching, the service is not running and a
Save cannot land.

Bare `claude-web-chat trust` lists what is waiting; `--deny` refuses. Consent is keyed to
(project root, `service.js` bytes, params), so a new project, a pack bump, or a changed `dir` or
`title` asks again. That is correct, and more obviously correct now that Save writes: `dir` names
the files this service may read *and* rewrite, so it is exactly the thing the user should be
asked about again when it changes.

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
the trust boundary; "these are the user's own design files" is what makes that acceptable, and it
is doubly load-bearing now that Save writes back into `dir`. For anything you did not author
here, pass `isolate: true` and accept losing both pins and editing.

**`dir` is a two-way door.** Pick a folder that holds *this design* and nothing else. Do not
point it at a folder that also holds source you would mind the canvas rewriting, and never at the
project root (it is refused as `bad-dir` anyway, because it would contain the service's own write
roots).

## The authoring loop

1. `Write` / `Edit` the `.dc.html` files (and `canvas.json`) under `dir`.
2. The service's watcher fires, debounces 250 ms, and re-runs the seeding helper.
3. `dsn_canvas.seq` bumps and the pane re-fetches the canvas.

That is the whole loop, and you are not in step 2 or 3. Write the file and tell the user to look;
do not re-render the pane to "refresh" it.

**And it runs backwards too.** The user selects an element, retypes a headline, nudges a colour,
hits Save — and steps 1 to 3 happen without you: the service extracts their edits back into the
same `.dc.html` files and re-seeds once. Nothing wakes you. See **Edit mode** below before you
next touch those files.

If you need to force it — you touched something the watcher does not cover, or `watch: false` —
write the control key. **`set_store` takes a `patch` wrapper**; without it the write merges
nothing and still returns `ok: true`:

```js
set_store({ patch: { dsn_ctl: { seq: Date.now(), op: 'reseed' } } })
```

## Edit mode — the canvas writes back

The pane installs the editor's host object before the canvas boots, so the canvas comes up
**editable**, not as a viewer. What the user actually gets, all of it verified in a browser
against a real seeded canvas:

- a **Save** button, undo/redo and zoom in the editor chrome
- **click-to-select** on any element, with the quick menu — font family, size, colour, Properties
- **inline rich-text editing** with the B / *i* / U / Link toolbar

Hitting Save hands the complete edited document to the host object, and from there:

1. The pane passes it to a **loopback listener the service owns** — `127.0.0.1`, ephemeral port,
   POST only, per-spawn path token. The document does not travel through the store, so it never
   lands in the event ring or in a committed graph node; only the page's state block makes the
   hop, which is under 1% of the ~2.5 MB page.
2. The service writes it to a temp file and runs the seeding helper's own **`--extract`**.
3. Only if that exits clean **and** returns at least one artboard does anything under `dir` get
   touched. Every file about to be replaced is copied into the service's build tree under
   `.web-chat/.wc-design-build/` first; each file is written-then-renamed; a failure part-way
   rolls the whole batch back.
4. The watcher ignores exactly those writes, then the service re-seeds **once**, deliberately, so
   the canvas matches what is now on disk. `dsn_canvas.seq` bumps.

Properties of that path worth knowing before you promise anything:

- **It never deletes.** An artboard the user removed inside the editor just does not come back
  from the extract; it is reported as orphaned and the file is left alone. If the user wants it
  gone, delete the file yourself after they say so.
- **`canvas.json` is compared by meaning, not bytes.** A save re-emits it through the helper's own
  `JSON.stringify`, so byte-comparing would reformat a hand-written manifest every single time.
  Same layout, same file, untouched. A layout the user actually changed on the canvas — a moved or
  resized artboard — does get written, so `canvas.json` is one of the files that can change under
  you.
- **A failed save is recoverable and says so.** The user sees *"Saving failed (…). Your changes
  are kept — try again."*, the document stays editable and dirty, and nothing under `dir` moved.
  The most likely cause is simply that the service is not running.
- **No save wakes you.** It is not a declared signal and not a store write you will be pushed.
  You find out by reading — `dsn_files[].mtime`, `dsn_canvas.seq`, or the file itself — or because
  the user tells you.

### What this changes about how you work

- **`Read` before you reason.** Treat every `.dc.html` under `dir` as a file with another author.
- **`Edit`, don't `Write`.** Re-emitting a whole artboard from your own draft is how you throw
  away a user's afternoon. Read the current file and change the part you mean.
- **Say what Save does, once, when they first get an editable canvas.** "Edit it in place and hit
  Save — that rewrites the `.dc.html` files under `<dir>`, and I read them from there." Users who
  believe the pane is a preview will not expect a Save to reach their working tree.
- **Pre-save copies are in the build tree** under `.web-chat/.wc-design-build/`, timestamped, if a
  save ever goes somewhere the user did not want.

### When to turn editing off

`isolate: true` sandboxes the frame to an opaque origin. That means **no host object, so no
editing and no Save** — and no pins either. It is the right trade in exactly one situation: the
canvas is not the user's own work and you are showing it anyway. For anything authored in this
project, leave it off; you are giving up the whole point of the pane otherwise.

Editing also needs the service alive — trust-approved, pane on the active node, a browser
watching. It is not a property of the file on disk; it is a property of the session.

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

The things authors actually trip over:

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
  Windows device names, and unique **case-insensitively**.
- **Name the entry artboard `Main.dc.html`.** Not a convention — the entry board is chosen by
  that exact name, and without one the editor promotes whichever `.dc.html` sorts first and the
  helper warns about it. The warning lands in `dsn_canvas.warnings` and the pane shows it, and
  **a real user read it and did not act on it**, so do not rely on the warning: name the file
  `Main.dc.html` when you create it. The only reason to leave it unnamed is re-seeding a canvas
  whose `Main` was deliberately deleted elsewhere.
- **Declare `$preview` in `data-props` on anything taller than its frame.** It sizes the artboard
  *and* it is the only thing that lets the document scroll. Without it the artboard is pinned to
  its frame and the rest of the design is unreachable — a real user hit exactly that. The next
  section is the whole story; write the `$preview` as you write the file, not after someone
  reports the design is cut off.

Caps that bite when you generate content: **2 MiB per file entry**, **200 entries total**, and
images are stored as bare base64, so keep each image under ~70 KB (the helper warns past 96 KB of
base64 and refuses past 2 MiB). Over the per-file cap the editor drops the entry at load, so it
renders missing rather than erroring.

**The `title` is gated on purpose.** No `< > & "` backslash or control characters, at most 120
characters, and generic names are refused outright — `design`, `canvas`, `design canvas`,
`new design`, `untitled`, `appifact`, `artifact`. Name it from what the user asked for; the
service derives the seeded filename from it and generic filenames are refused the same way.

### How big an artboard is — frames, fit and fill

Every artboard is drawn inside a **frame** of a fixed `w` x `h`, and the frame comes from
`canvas.json`. **With no `canvas.json` the editor frames every artboard at 800 x 600** — a number
with nothing to do with your design — and nothing tells you: the helper only complains about
`w`/`h` values that are present and non-numeric, never about ones that are simply missing. A
1288-wide layout in an 800 x 600 frame is drawn small in the canvas view and cut off at the frame
edge, and that reads to the user as "the pane is broken".

The service derives a frame per artboard from the source — `$preview`, then a fixed px box on the
root element, then the `frame_w`/`frame_h` params, then a 1440-wide default — and writes the
manifest into its own build directory, never into `dir`. It uses that to build the whole
`canvas.json` when there is none, and to fill in **only the keys you left out** when there is one.
Anything you wrote is passed through untouched, wrong values included. `dsn_canvas.layout` says
which happened (`user` / `user-filled` / `synthesised` / `none`) and `dsn_canvas.frames[]` reports
each size and which rung it came from. **Treat it as a safety net, not as the answer.** It is a
guess made by reading your markup.

In order of what to actually do:

1. **Declare the size in the artboard itself** — a `$preview` in `data-props`. Most reliable,
   travels with the file, and does a second job (below):

   ```html
   <script data-dc-script data-props='{"$preview":{"width":1288,"height":1600},"headline":{"editor":"text","default":"Spring, on a plate"}}'>
   ```

2. **Write a `canvas.json` with real `w`/`h`** whenever the canvas is more than one throwaway
   board (next section). An explicit manifest always wins — the service fills in only the keys you
   leave out, and never touches one you set.
3. **Pass `frame_w` / `frame_h`** at mount time for boards that declare nothing.

**`$preview` is also what makes an artboard scrollable, and this is a bug a real user hit.**
The mechanism is exact: when an artboard declares no `$preview`, `support.js` injects

```css
html,body{height:100%;margin:0}#dc-root,#dc-root>.sc-host{height:100%}
```

into it. That pins the document to its frame, so it **cannot scroll at all** — no wheel, no
trackpad, no scrollbar — and the wheel event chains out to the surface page instead, which reads
as the pane ignoring the user. Declare a `$preview` and that CSS is not injected, and the frame
scrolls natively.

**So: author `$preview` whenever the design is taller than its frame.** A one-page poster sized
to its frame does not need it. A memo, a report, a long landing page, anything that flows past the
bottom edge — it is not optional there, and nothing warns you. Either declare `$preview`, or give
the overflowing region its own explicit `overflow: auto`. The canvas provides no scroll container
of its own.

**`fit` vs `fill`** — per artboard, set in `canvas.json` (or forced for all of them with the
`expand` param):

| | what it does | right when |
| --- | --- | --- |
| `fit` (the default) | the frame stays `w` x `h`; with the artboard focused, the view scales **down** to fit the window, never up | the design has an intrinsic size — a poster, a fixed-width screen, anything you gave a px width |
| `fill` | the frame is **resized to the window** and drawn at scale 1 | the root is fluid-width **and** the document can scroll |

Two things about `expand` that are easy to get backwards:

- **It only applies while an artboard is focused.** Zoomed out on the canvas an artboard is always
  drawn at its `w` x `h`, so `expand` cannot rescue a wrong frame — only `w`/`h` can.
- **`fill` is not "make it bigger".** It sizes the frame to the pane and shows whatever fits. A
  `height:100%` design with no internal scroller **clips** in fill, permanently, with no way to
  reach the rest; the same design in fit merely shrinks, which the user can recover by zooming.
  Author for fill deliberately: a fluid-width root (%, `vw`, flex/grid — no fixed px width on the
  root), content that reflows, and a real scroll container so the document can scroll past the
  frame edge.

Mount-time knobs. None of them can override a value you wrote in `canvas.json` — they only feed
frames the service has to derive — and all of them are part of the trust fingerprint, so changing
one re-asks `claude-web-chat trust design-canvas`:

| param | effect |
| --- | --- |
| `frame_w`, `frame_h` | px for artboards whose own source declares no size. Clamped to 120–8000. |
| `expand` | `'auto'` (default — decided per artboard from the evidence above), or `'fit'` / `'fill'` to force one on every artboard |
| `wide_scan` | `true` lets the deriver fall back to the widest declared px width found anywhere in the source — useful for a fluid design with one wide shell, but a heuristic. Any frame that rests on it says `wide-scan` in `dsn_canvas.frames[].source`, so a guess can always be told from a declaration. |

### `canvas.json`, when you want a layout

Optional in the sense that the seed succeeds without one — but **write one for anything past a
single throwaway artboard**, because it is the only place the real frame sizes live (above). When
you write one, the loader reads a **closed set of keys** and the helper refuses anything else
rather than letting the editor drop it silently:

| level | keys |
| --- | --- |
| top | `artboards`, `annotations`, `pages`, `launch` — nothing else |
| an artboard entry | `file`, `x`, `y`, `w`, `h`, `title?`, `expand?`, `print?`, `page?`, `is_interactive?` |
| an annotation (sticky note) | `id`, `x`, `y`, `w`, `text`, `page?`, plus `kind`/`size`/`bold`/`italic`/`color` |
| `launch` | `{view:"canvas", page?}` or `{view:"focused", file}` |

Every listed `file` must be a real `.dc.html` beside it, listed once. `expand` is `fit`|`fill`,
`print` is `fixed`|`flow`.

```json
{
  "artboards": [
    { "file": "Main.dc.html",    "x": 0,    "y": 0, "w": 1288, "h": 1600 },
    { "file": "Pricing.dc.html", "x": 1368, "y": 0, "w": 1288, "h": 1600 }
  ],
  "launch": { "view": "focused", "file": "Main.dc.html" }
}
```

Four rules that are easy to get wrong and impossible to see afterwards:

- **Write `w` and `h` on every entry**, and make them the design's real size. Omitting them is not
  "use a sensible default" — it is 800 x 600, silently, with no warning from anything.
- **Write `x` and `y` whenever you write `w`/`h`.** The overlap check only looks at entries where
  all four are numbers, so `w`/`h` alone stacks every artboard at the origin and nothing says so.
  Lay them left to right and leave at least **80 px between frames** — the name strip and tweak
  chips sit above each one, and overlapping boxes get a warning.
- **List every artboard.** An unlisted one is appended at 800 x 600, so a partial manifest fixes
  the boards it names and leaves the rest wrong.
- **`launch` is worth setting.** With none, the canvas opens zoomed out, which is half of what a
  user means by "the page is shrunk". `{"view":"focused","file":"Main.dc.html"}` opens straight on
  one design, fit to the pane. A focused launch carries no `page`; a canvas launch carries no
  `file`; either mistake is fatal at seed.

**A `canvas.json` under `dir` is also a file Save can rewrite** — moving or resizing an artboard
on the canvas is a layout change, and it comes back through the extract. Formatting alone does
not: the service compares the manifest by meaning, so a save that changed nothing about the
layout leaves your hand-written file byte-identical. Read it before you rewrite it, same as an
artboard.

### When a seed fails

`dsn_canvas.state` goes `seed-failed` and `hint` carries the helper's **stderr, verbatim**. That
text is written to be read — it names the file, the key and the consequence. Quote it to the user
and fix the file; do not guess, and do not hand-edit the seeded page (the service owns it and the
next re-seed overwrites it).

## Store keys

Prefix `dsn_`. The service writes, the pane reads — except `dsn_ctl`, which is the reverse.

| key | direction | shape |
| --- | --- | --- |
| `dsn_canvas` | service → pane | `{ seq, ok, state, payload_component, title, artboards:[{file,x,y,w,h,w_source,h_source,expand}], layout, frames:[{file,w,h,source,expand}], warnings, seeded_at, bytes, upstream:{version,payload_sha256}, save_endpoint, error, hint }` — written in **every** state, including failure |
| `dsn_files` | service → pane | `{ seq, dir, files:[{name,bytes,mtime}], has_canvas_json }` — what is actually on disk |
| `dsn_ctl` | pane → service | `{ seq, op }`, `op` ∈ `reseed` \| `rescan` — **control key**, never a signal |
| `dsn_ask` | pane → Claude | `{ seq, note, artboard }` — **declared signal**, `wake: 'queue'` |

Every payload carries a monotonically increasing `seq`; compare it against the last one you
handled to tell a fresh state from a replay. `artboards[]` is the layout the canvas actually
loaded — the entries of whichever `canvas.json` was seeded, the user's or the derived one — plus a
null-geometry entry for any `.dc.html` that manifest does not list, so tolerate the nulls.

`frames[]` is the one to read when a design looks wrong on screen: `{file, w, h, source, expand}`,
where `source` says which rung the size came from — `canvas.json`, `$preview`, `root-style`,
`param`, `wide-scan`, `default`, or **`null` for a board nothing framed**, which means the editor's
own 800 x 600. `source` naming anything but `canvas.json` or `$preview` means the frame is
inferred, and the fix is to declare the size (above) rather than to argue with the deriver.
`layout` says where the manifest came from: `user` (yours, as written), `user-filled` (yours, with
omitted keys filled in), `synthesised` (there was none), `none` (no manifest at all — everything is
800 x 600), or `null` before the first seed. `warnings[]` carries the helper's own non-fatal
diagnostics — including "no artboard is `Main.dc.html`" — plus notes from the service, such as a
derived manifest the helper refused and the fallback that ran instead; show them to the user rather
than sitting on them.

`save_endpoint` is `{ url, token }` for the service's loopback save listener. **It is the pane's,
not yours** — do not POST to it, and do not repeat the token to the user. It is worth one glance
for one reason: missing or empty while the state is `ready` means the canvas is on screen but a
Save has nowhere to land.

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

The pane writes it, the service watches it over SSE and reacts. **A user panning, zooming,
re-seeding — or editing and saving — starts no Claude turn and produces no queue item.** `seq`
must strictly increase; a repeat or a regression is dropped in silence. Both ops are reads —
`reseed` re-runs the helper, `rescan` re-reads the directory listing only — so there is nothing
here you must keep your hands off. It is also not a way to fetch data: you will not see the result
until your next turn. If you need to know what is in an artboard *now*, `Read` the file — which is
also the only way to see edits the user saved since you last looked.

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

## What it still cannot do

State these plainly rather than letting the user discover them.

- **Editing needs the service running.** Not the pane, not the file — the service. It is host code
  behind `claude-web-chat trust design-canvas`, it runs only while the pane is on the active node
  with a browser watching, and Save posts to a loopback listener it owns. No service, no Save:
  the canvas still edits on screen and the failure is the recoverable kind ("your changes are
  kept"), but nothing reaches disk. Do not describe editing as a property of the canvas; it is a
  property of the running session.
- **No element-level pin precision, and no `reveal()`** (above).
- **No pins and no editing under `isolate: true`.** An opaque-origin frame can neither be read
  from nor be handed a host object.
- **Save never deletes.** An artboard the user removes inside the editor leaves its file on disk,
  reported as orphaned. Deleting it is a separate, explicit act.
- **Save is not a version history.** There is one timestamped pre-save copy per save under
  `.web-chat/.wc-design-build/`, which is a safety net, not a VCS. If the design matters, it wants
  a real commit.
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
- **The design has to go to other people.** This canvas is local, single-user and unshared: no
  URL, no collaborators, no published version. When the point is to send it round, publish an
  Artifact via the `design` skill — and say plainly that you are switching surfaces because of
  sharing, not because this one cannot be edited.
- **The pane is already mounted and nothing changed.** Mounts persist and the service keeps them
  current — reference `design-canvas-main` by what is on screen instead of re-rendering.
- **The canvas is not the user's own.** Never point `dir` at someone else's canvas or a published
  page; if you must show one at all, `isolate: true` and no pins.
- **There is no payload and the user does not want to run `/design`.** Say so and work in files;
  do not leave a dead pane sitting on a `no-payload` refusal.
