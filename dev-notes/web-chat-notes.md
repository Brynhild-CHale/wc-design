# web-chat platform notes

Things about `claude-web-chat` itself that cost time to learn and are not in its
README. Written while building `wc-design`, but almost none of it is specific to
this pack — if you are writing any component pack, this is the file to read first.

> **These notes reflect `claude-web-chat` v0.7.5 and will drift.** Every finding
> below was verified by reading the installed release, not inferred from docs or
> from behaviour. Citations are `path:line` relative to the install root —
> `~/.web-chat/versions/0.7.5/` on the machine this was written on. Line numbers
> move between releases; the surrounding comment usually does not, so grep the
> quoted phrase rather than trusting the number. Where a claim is about a
> *builtin component* rather than the platform, the path starts `templates/`.
>
> A pleasant surprise, and the reason citation is cheap here: web-chat's source
> is heavily commented, and the comments are unusually honest about the failure
> that motivated each rule. Several findings below are just that file's own
> header comment, verified and pointed at.

Contents, roughly in the order they will bite you:

1. [No CSP is served on the live surface](#1-no-csp-is-served-on-the-live-surface)
2. [Pane HTML is not sanitised — only `<script>` is lifted out](#2-pane-html-is-not-sanitised--only-script-is-lifted-out)
3. [Every committed node snapshots pane HTML **and the whole store**](#3-every-committed-node-snapshots-pane-html-and-the-whole-store)
4. [Pane scripts are `new Function` bodies: no top-level `await`](#4-pane-scripts-are-new-function-bodies-no-top-level-await)
5. [`root`, never `document` — and what `document` still reaches](#5-root-never-document--and-what-document-still-reaches)
6. [A dead pane script *is* observable: `kind:'script-error'`](#6-a-dead-pane-script-is-observable-kindscript-error)
7. [`/preview/node/:id` carries a CSP that kills frames and fetches](#7-previewnodeid-carries-a-csp-that-kills-frames-and-fetches)
8. [Exports run pane scripts against no server, and drop comments](#8-exports-run-pane-scripts-against-no-server-and-drop-comments)
9. [The components registry reads disk on every call](#9-the-components-registry-reads-disk-on-every-call)
10. [The service contract is `typeof svc.start === 'function'` — and nothing else](#10-the-service-contract-is-typeof-svcstart--function--and-nothing-else)
11. [What service trust is actually keyed on](#11-what-service-trust-is-actually-keyed-on)
12. [Services die when viewers drop; panes survive the reconnect — the seq hazard](#12-services-die-when-viewers-drop-panes-survive-the-reconnect--the-seq-hazard)
13. [Comment pins: the shape, and the two guarantees around it](#13-comment-pins-the-shape-and-the-two-guarantees-around-it)
14. [`routing:'none'` does not suppress comment items](#14-routingnone-does-not-suppress-comment-items)
15. [The drawer cannot pass `signals` — form-spawned components have no wake](#15-the-drawer-cannot-pass-signals--form-spawned-components-have-no-wake)
16. [`set_store` takes a patch wrapper; the driver's `setStore` does not](#16-set_store-takes-a-patch-wrapper-the-drivers-setstore-does-not)
17. [The floor is `>=0.7.0`, and `>=0.6.0` is a trap](#17-the-floor-is-070-and-060-is-a-trap)
18. [Smaller things worth knowing](#18-smaller-things-worth-knowing)

---

## 1. No CSP is served on the live surface

**Claim.** The surface serves no `Content-Security-Policy` header and carries no
CSP `<meta>`. The only CSP anywhere in the release is `PREVIEW_CSP`, which
applies to one route (finding 7).

**Evidence.** `grep -rn 'Content-Security-Policy' lib public` in v0.7.5 returns
three hits: the `PREVIEW_CSP` definition at `lib/core/cors.js:258`, its single
application at `lib/server/routes/graph.js:330`, and a *description string* in
the browser-extension permission copy at `lib/server/routes/extensions.js:35`.
`public/index.html` has no CSP meta. Two files state the absence in their own
words, as load-bearing reasoning rather than as an aside:

- `lib/server/routes/components.js:112` — "Pane scripts can reach localhost
  endpoints (same origin, no CSP), so any endpoint that granted trust would be
  forgeable by the very code being gated."
- `lib/server/services.js:271-277` — "Pane scripts are compiled with
  `new Function` and run in the main window realm … with `document`, `fetch` and
  `WebSocket`, and no CSP is served. So a pane can synthesise a click on any
  chrome button, open its own same-origin socket and read anything broadcast to
  the shell, and call any localhost HTTP endpoint."

**What it permits.** Inline `<script>` in a pane (that is the whole execution
model). External `<script src>` from any origin. `fetch`/`XHR`/`WebSocket`/`EventSource`
anywhere. `<iframe>` with any `src`. Web fonts, remote images, `data:` and `blob:`
URLs, `eval`. Nothing is blocked at the page level.

**What it does not permit.** Nothing is granted that the browser would not grant
any same-origin page: cross-origin `fetch` still obeys the remote server's CORS,
and an iframe you sandbox stays sandboxed. The absence of CSP is not a capability
grant; it is the absence of a restriction.

**Consequence for a pack author.** Two, pulling opposite ways.

The permissive one: you can load a font, frame a local document, or `fetch` a
same-origin daemon route from inside a pane, and it will just work. Finding 9 is
the useful version of this.

The sharp one: the daemon's entire API is unauthenticated — the bind address is
the access control (`lib/core/cors.js:12-18`) — and a pane script sits inside
that boundary with no page-level restriction on what it may dial. web-chat knows
this and has accepted it deliberately for `/api/packs/install`
(`lib/server/routes/packs.js:7-10`: "the maintainer has accepted it knowingly"),
and it is why service trust is a *filesystem* decision made by the CLI and not
anything the browser can grant (finding 11). So: **anything you render into a
pane is running inside the daemon's trust boundary.** If your component can be
pointed at content the user did not author, that content is not merely displayed
— it is executing next to their surface. Sandboxing such a frame to an opaque
origin is the only structural answer, and it costs you every same-origin
affordance (in `wc-design`'s case, element-level pins). Decide that at design
time, not after.

---

## 2. Pane HTML is not sanitised — only `<script>` is lifted out

**Claim.** The render path applies exactly one transformation to your HTML: it
parses it into a `<template>`, moves every `<script>`'s text into a list, removes
those `<script>` elements, and appends the rest into the shadow root. Nothing
else is inspected, rewritten, or removed. There is no allowlist, no attribute
filter, no size cap.

**Evidence.** `public/mount-runtime.js:75-83`:

```js
function attachAndExtract(host, html) {
  var root = host.attachShadow({ mode: 'open' });
  var tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  var scripts = [];
  tpl.content.querySelectorAll('script').forEach(function (s) { scripts.push(s.textContent); s.remove(); });
  root.appendChild(tpl.content.cloneNode(true));
  return { root: root, scripts: scripts };
}
```

Upstream of that, `POST /api/render` validates only `typeof html === 'string'`
(`lib/server/routes/render.js:16`) and `setMount` never looks at the string at
all (`lib/server/domain/mounts.js:220+`). The Express body limit is 200 MB
(`lib/server/index.js:131`, overridable via `WEB_CHAT_BODY_LIMIT`).

Sanitiser lists *do* exist in this codebase — `lib/capture/profiles/simplify.js:32-36`
drops `iframe`/`object`/`embed`, and `lib/capture/profiles/util.js:14` gates href
schemes — but they belong to the **capture** pipeline, which distils a foreign
web page. They never run on a `render`. That file says so in as many words
(`lib/capture/profiles/util.js:9-13`): simplify's output "is mounted with
`tpl.innerHTML = html` into a shadow root in the SURFACE's own origin … and
nothing downstream sanitizes it — the 'the shadow mount sanitizes too' claim
simplify.js's header used to make was not implemented anywhere."

**Consequence.** `<iframe>`, its `src`, its `sandbox` and `allow` attributes all
survive verbatim, which is what makes an embedded-document component possible at
all. Inline event handlers (`onclick="…"`) survive too — note that they run in
the **main window realm**, not with your pane's injected `store`/`root`, so they
are a different and worse execution context than a `<script>`; prefer
`root.addEventListener`.

The corollary is that **you** are the sanitiser. If your component interpolates
anything it did not author — a filename, a store value another writer set, a
capture excerpt — into `innerHTML`, that is an injection into the surface's own
origin. Build DOM with `document.createElement`/`createTextNode` instead;
`document.createElement` works fine inside a pane script even though
`document.querySelector` does not (finding 5).

---

## 3. Every committed node snapshots pane HTML **and the whole store**

This is the cost model nobody warns you about, and it is the single easiest way
to make a project's `.web-chat/` directory unusable.

**Claim.** When a turn commits a graph node, the node file records every mount's
full `html` string *and* a complete copy of the store. Not a diff, not a
reference — a copy, per node, forever.

**Evidence.**

- `lib/server/domain/turns.js:39` — `const SNAPSHOT_FIELDS = ['html', 'target',
  'params', 'component', 'pane_state', 'form_state', 'theme', 'owner'];`
  `hydrateMount` (`:44-48`) picks exactly these into the persisted record, and
  the file's own header is explicit that this list is "the authority for the
  WRITER as well as the reader".
- `lib/server/graph.js:444-450` — `snapshotLive()` builds
  `{ mounts: [...hydrateMount(m)], store: { ...state.store }, comments, captures }`.
- `lib/server/domain/turns.js:506-518` — `commitNode` puts `snap.mounts`,
  `snap.store`, `snap.comments`, `snap.captures` straight onto the node object.
- `lib/server/graph.js:225-227` — `graph.writeNode` writes that object to
  `.web-chat/graph/<id>.json`.
- And the platform says the quiet part out loud at
  `lib/server/domain/turns.js:189-191`, explaining why the no-change digest is
  hashed rather than kept whole: "the graph holds every node in memory and a
  node's mounts carry full pane HTML: one digest per node costs bytes, the
  projection it stands for costs megabytes."

Note "**in memory**". Every node is loaded and held at boot (`graph.load`,
`lib/server/graph.js:263+`), so the cost is disk *and* resident memory.

**Consequence.** Multiply your largest pane's HTML by the number of turns in a
session. A 2 MB pane over a fifty-turn session is 100 MB of graph, and it will be
100 MB of RSS the next time the daemon boots. The same is true of any large value
you put in the store — `set_store` is not a scratchpad, it is history.

**The rules that follow:**

- **Nothing large may enter the store, a pane's `html`, or a tool argument.**
  Those are the three roads into a node.
- If your component needs a large asset, serve it from disk and have the pane
  fetch it at mount time (finding 9). The pane's committed `html` is then a small
  loader, and the asset lives once on disk instead of once per node.
- `params` are snapshotted too. Pass a path, not a payload.
- A turn that leaves the surface byte-identical commits nothing (`liveIsDirty`,
  `lib/server/domain/turns.js:198-204`), so idle turns are free. It is *changing*
  a big pane that costs, and a pane that re-renders itself on a timer is the
  pathological case.
- `form_state` is in `SNAPSHOT_FIELDS` too, so the user's typed values ride into
  every node. Password, hidden and file inputs are excluded by
  `isValueExcluded` (`public/mount-runtime.js:174-181`) — "never persist secrets
  into graph history" — and `data-no-persist` opts out anything else. Use it for
  any field holding something you would not want in a JSON file on disk.

---

## 4. Pane scripts are `new Function` bodies: no top-level `await`

**Claim.** Each `<script>` extracted from your pane HTML is compiled as
`new Function('store', 'root', 'params', 'mountId', body)` and invoked. That is
an ordinary (non-async) function body, so **top-level `await` is a SyntaxError**
and the script never runs at all.

**Evidence.** `public/mount-runtime.js:95-105`:

```js
function runScripts(root, scripts, store, params, mountId, onError) {
  for (var i = 0; i < scripts.length; i++) {
    try {
      var fn = new Function('store', 'root', 'params', 'mountId', scripts[i]);
      fn(store, root, params || {}, mountId);
    } catch (e) {
      console.error('component script error', mountId, e);
      if (onError) { try { onError(e, i); } catch (e2) {} }
    }
  }
}
```

Verified directly:

```
$ node -e "try{new Function('store','root','params','mountId','const x = await fetch(\"/a\");')}catch(e){console.log(e.constructor.name+': '+e.message)}"
SyntaxError: await is only valid in async functions and the top level bodies of modules

$ node -e "new Function('store','root','params','mountId','(async () => { await 0; })();'); console.log('ok')"
ok
```

The failure happens at **construction**, not at call — so it takes out the entire
script body, including the synchronous setup lines above your `await`. The pane's
declared markup still mounts (it was appended before scripts ran,
`public/mount-runtime.js:81`), so what you see is a rendered-looking pane that
does absolutely nothing. This is the "declared signal that silently never fires"
class of bug, and it is worth internalising that the *markup rendering correctly
tells you nothing about whether the script compiled*.

**Consequence.** Wrap async work in an IIFE, and catch inside it:

```js
(async () => {
  try {
    const r = await fetch('/api/components/my-component');
    // …
  } catch (e) {
    root.querySelector('.status').textContent = 'could not load: ' + e.message;
  }
})();
```

Note also what the four injected names *are*: `store`, `root`, `params`,
`mountId`. There is no module scope, no `import`, no `require`. Each `<script>`
in one pane is a separate function with a separate scope — they do not share
`const`s. A `var` or a bare assignment leaks to `window`, which is shared across
every pane on the surface; name accordingly or keep everything inside one script.

Sibling scripts are isolated for failures too (each is in its own `try`), so a
broken second script does not stop a working first one.

---

## 5. `root`, never `document` — and what `document` still reaches

**Claim.** A pane's markup lives in an **open shadow root**. `document.querySelector`
and `document.getElementById` cannot see into it and return `null`. The very next
line then throws on the null, `runScripts` catches it, and the pane goes inert
with nothing obviously wrong on screen. The platform's own tool description calls
this out: "query the pane's DOM via `root` (an open shadow root), NEVER
`document.querySelector`/`getElementById` (they cannot see into the shadow DOM
and the script dies at mount — `document.createElement` is fine, and is preferred
over `innerHTML`)" (`lib/mcp/tools/render.js`, the `description` field).

**Evidence.** The shadow root is attached at `public/mount-runtime.js:76`
(`host.attachShadow({ mode: 'open' })`) and passed to the script as `root`
(`:99`). Both failures are near-silent by the same mechanism as finding 4 — the
markup is already in the DOM before the script runs, so a dead script leaves a
pane that looks fine.

**The distinction that matters:** it is only the *queries* that break.
`document.createElement`, `document.createTextNode`, `document.addEventListener`
and every other non-query use of `document` work normally, because `document`
itself is perfectly reachable — the pane script runs in the main window realm
(`lib/server/services.js:272-274`). That is why finding 1's security note is
real: a pane script can reach the shell's chrome, `window`, `fetch` and
`WebSocket`. What it *cannot* do is find its own elements through `document`.

**Consequence.** `root.querySelector(...)` everywhere. If you are porting code
that assumed a document, the mechanical fix is a one-line alias at the top of the
script: `const $ = (s) => root.querySelector(s);`.

Two related gotchas:

- **Styles are scoped too.** A `<style>` inside your pane HTML applies only within
  the shadow root, and page-level CSS does not reach in. What *does* cross the
  boundary is CSS custom properties, which is why web-chat's theming is entirely
  `--wc-*` tokens — reference those and your component follows the user's theme
  for free.
- **`getElementById` on the *host* element works**, because the host is in the
  main document (`public/app/mounts.js` gives it `id = mountId` and class
  `mount-host`). That is a real trap: `document.getElementById(mountId)` returns
  something, just not what you wanted. It also means a mount id colliding with a
  shell element id is a genuine hazard, which is why reserved ids are refused
  outright (`isReservedId`, `lib/server/domain/mounts.js`).

---

## 6. A dead pane script *is* observable: `kind:'script-error'`

Findings 4 and 5 both fail near-silently *in the browser*. They are not silent to
you, and this is the single most time-saving fact in this document.

**Claim.** When a pane script throws or fails to compile, the live client
forwards the failure to the daemon, where it lands in the event ring as
`kind:'script-error'` with the mount id, the script index, the message and the
first three stack lines. `get_events` shows it.

**Evidence.** `public/app/mounts.js:619-629` passes an `onError` reporter into
`runScripts` — "Forward the failure to the daemon so it lands in the event ring
(get_events kind:'script-error') — a dead pane script must be observable outside
the browser console." The server side is `lib/server/ws.js:178-192`, which builds
the ring entry and caps `message`/`stack` at 500 characters each: "this exists so
get_events shows the failure to Claude, ending the 'declared signal that silently
never fires' class of archaeology."

**Consequence.** When a pane is unresponsive or a declared signal never arrives,
**check `get_events` before you start bisecting the component.** It will usually
name the line.

Two caveats. Preview renders are deliberately excluded (`public/app/mounts.js:623`
returns early when `view.previewing`), so a thumbnail's broken script is not
reported. And the ring is 1000 entries (`lib/core/bus.js:45`) — on a busy surface
an error can age out, so read it soon after reproducing.

---

## 7. `/preview/node/:id` carries a CSP that kills frames and fetches

**Claim.** Graph thumbnails and the glance card are `<iframe src="/preview/node/:id">`,
and that route sets a strict CSP. Under it, a pane's `fetch` and any nested
`<iframe>` are both dead. So a component that assembles itself at mount time
renders as an **empty box** in every preview — while working perfectly on the
live surface.

**Evidence.** `lib/core/cors.js:258-264`:

```js
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  "connect-src 'none'",
].join('; ');
```

Applied at `lib/server/routes/graph.js:328-330`, before the 404 branch "so every
document this path can produce is under the same policy". The route's own header
(`lib/server/routes/graph.js:2-9`) explains why: the graph viewer "re-executes one
of these documents per visible node every time it draws", so without a policy
those historical scripts could `fetch` `/api/render`, `/api/store` or
`/api/packs/install` against **live** state, unattended.

Read the directives carefully:

- `connect-src 'none'` — every `fetch`/XHR/WebSocket/SSE fails.
- `default-src 'none'` with **no `frame-src`** — nested iframes are blocked. The
  fallback to `default-src` is what does it; there is no separate frame rule to
  relax.
- `img-src data: blob:` — inline images survive; a network image does not.
- `script-src 'unsafe-inline' 'unsafe-eval'` — scripts *do* run, and `new Function`
  works. This is what makes the failure confusing: your script executes, its
  `fetch` rejects, and if you did not handle that you get a blank pane.
- No `font-src` — web fonts fall back.

Consumers: `public/app/graph-view.js:512` (thumbnails), `:721` (glance card), and
`templates/components/node-render/component.html:134,148`.

**Consequence.** Design for it explicitly rather than discovering it. A pane that
loads content at mount time should detect the preview context and render a static
placeholder:

```js
if (location.pathname.startsWith('/preview/')) {
  root.querySelector('.slot').textContent = 'preview — open the node to load';
  return;
}
```

Also note the asymmetry with finding 1: the live surface is **not** under this
policy, and the CSP comment says so directly — "This does NOT make the live
surface's panes any more constrained — that exposure is a standing accepted
decision." Do not read the preview CSP as evidence that the surface is sandboxed.

---

## 8. Exports run pane scripts against no server, and drop comments

Two separate surprises in one file.

**Claim A.** `export` produces a genuinely interactive page — it inlines the same
mount runtime the live client uses and **runs your pane scripts**. But it is a
static file with no daemon behind it, so any `fetch` your script makes fails.
Same visible symptom as finding 7, different cause.

**Evidence A.** `lib/server/export.js:123`, inside `EXPORT_SHELL`:
`window.__wcMount.runScripts(r.root, r.scripts, store, m.params || {}, m.id);`.
The store is built with `createStore(data.store || {})` and **no publish hook**
(`:92`) — writes are local and persist nowhere. The header (`:83-87`) says it
plainly: "No WebSocket, no fetch, no graph/SSE: a frozen, offline page."
`form_state` is rehydrated (`:125`), so typed drafts do travel.

**Claim B.** A graph node carries `comments`, but the export assembler never
receives them. **Pin threads do not survive an export.**

**Evidence B.** The file's own header at `lib/server/export.js:10-11` describes a
node as `{ mounts, store, comments }`. But the signature is
`assembleExport({ mounts = [], store = {}, page = {}, meta = {} })`
(`lib/server/export.js:151`) — no `comments` parameter. `nodeForExport`
(`:208-240`) returns `{ mounts, store, nodeId, label, node }`, and
`buildExportHtml` (`:291-305`) passes only `mounts`, `store`, `page`, `meta`.
The comments are on the node and are dropped on the way out.

**Consequence.** If your component's value is in the discussion pinned to it, an
export is not the artefact to hand someone — it carries the picture and loses the
conversation. Say so in your docs rather than letting a user find out after
emailing it.

And handle the offline case in the pane itself. A loader that catches its failed
`fetch` and renders one honest line ("this canvas exports as its own file") is
worth writing; an empty box in a file someone has already sent to a colleague is
not recoverable. Combined with finding 7, a mount-time loader needs **two**
degraded paths: preview (detect by pathname) and export (detect by the fetch
failing).

---

## 9. The components registry reads disk on every call

**Claim.** There is no component cache on the server. `list()` re-`readdirSync`s
every tier directory per call, and `get()` re-`existsSync`s and re-reads per call.
A component directory written *while the daemon is running* is picked up
immediately — **no restart, no reinstall, no cache bust**.

**Evidence.** `lib/core/resources.js:72-92` — the comment at `:62` states it:
"Reads dirs fresh per call." `get()` at `:49-59` does `existsSync` then `load()`
on every invocation. The components registry is a thin instance of that engine
(`lib/server/components-registry.js:14-74`), and its `load` reads `meta.json`
from disk each time (`:31`). `serviceInfo` (`:85-97`) likewise re-hashes
`service.js` per call, which is how a service edit re-prompts for trust
(finding 11) with no restart.

**Consequence.** Two useful things fall out.

*Development loop.* Editing a component's `component.html` on disk and re-issuing
`use_component` picks up the new source with no daemon restart. (This is not true
of `lib/server/*` — `public/mount-runtime.js:26-29` notes the server memoises the
runtime text at first read, so changes there need `claude-web-chat restart`.)

*Delivery of anything large.* `GET /api/components/:name` returns
`{ ...meta, source, has_service }`, where `source` is the component's
`component.html` read fresh from disk (`lib/server/routes/components.js:73-82`).
That gives you a same-origin route, already behind the daemon's host gate, with
no new listener, no CORS wildcard, and no trust prompt — and because the registry
does not cache, a file a service writes at runtime is served by it on the next
request.

That combination is the escape hatch from finding 3. A pane that is a small
loader fetching its bulk from `/api/components/<name>` commits a small `html`
into every node, while the bulk stays on disk exactly once. It is the only way to
put a large document on the surface without amplifying it across the graph.

Two guards to respect if you use it: the name grammar is the containment rule —
`/api/components/..%2f..%2fx` arrives as the name `../../x`, and
`isComponentName` is what refuses it with a 404 (`lib/server/routes/components.js:51-63`)
— so do not build your own path-joining route beside it. And the same
no-cache property means a component directory that is half-written is a component
that is *served* half-written; write to a temp path and rename.

---

## 10. The service contract is `typeof svc.start === 'function'` — and nothing else

**Claim.** A service-backed component's `service.js` must `module.exports` an
object with a `start` method. Export a bare function, or a default-exported
async function, and the runner **silently does nothing** — no error, no log, and
it still reports `started` to the supervisor. The pane just sits there empty
forever.

**Evidence.** `lib/server/service-runner.js:53-54`:

```js
if (svc && typeof svc.start === 'function') await svc.start(ctx);
if (process.send) process.send({ type: 'started', mountId: msg.mountId });
```

There is no `else`. The `started` message on the next line is unconditional, so
the supervisor marks the child `running` (`lib/server/services.js:235-237`) and
everything downstream looks healthy. Symmetrically, `stop` is optional and
checked the same way (`lib/server/service-runner.js:78`).

The correct shape:

```js
module.exports = {
  name: 'my-service',
  async start(ctx) { /* … */ },
  async stop() { /* … */ },
};
```

**The `ctx` object**, in full, from `lib/server/service-runner.js:33-52`:

| field | what it is |
|---|---|
| `ctx.driver` | The daemon driver, bound to this port and stamped `owner: "service:<name>"`. **Guarded** (`:31`) — a fire-and-forget call cannot kill the child on a transient transport failure; the write is lost and the next push carries the state. Awaited calls still reject into your handling. |
| `ctx.params` | The mount's params, **minus** the shell's render-control keys (finding 11). |
| `ctx.mountId` | The pane this service belongs to. |
| `ctx.name` | The component name. |
| `ctx.log(...)` | Goes to the daemon's log via the child's stdout (`lib/server/services.js:231-232`, prefixed `[<name>]`; stderr is prefixed `[<name>!]`). |
| `ctx.diff(a, b, opts?)` | Unified line diff (`lib/server/diff.js` `lineDiff`). |
| `ctx.webChatDir` | Absolute path to the project's `.web-chat`, for sidecar state. |
| `ctx.fence(parent, child)` | The absolute path of `child` inside `parent`, or **`null`** if it escapes. |

**`ctx.fence` is not optional.** The comment at `:41-48` is emphatic: every path a
service is *handed* — a store value a pane wrote, a control key — goes through it.
It refuses a lexical `../..` **and** a symlink that resolves out of the tree,
"which a `path.relative` check cannot see because reads and writes follow links".
`lib/core/paths.js` is the one containment engine; a service must never hand-roll
a second one. A `null` return is a hard error state to surface in the pane, never
a silent fallback to a default directory.

**Other lifecycle facts worth knowing before you debug them:**

- A crash is not retried. `onChildExit` records the failing `service.js` hash
  (`lib/server/services.js:261-268`) and `reconcile` skips that mount while the
  hash is unchanged (`:176`) — "crashed on this exact version — don't hot-loop".
  Editing `service.js` produces a new hash and clears the block naturally, so
  "why won't my fixed service start" is usually "you have not saved it yet".
- Shutdown is IPC `stop`, then `SIGTERM` after 2 s (`STOP_GRACE_MS`,
  `lib/server/services.js:32,250`). A second signal while a shutdown is in flight
  exits outright (`lib/server/service-runner.js:70`) — there is no SIGKILL above
  it, so a `stop()` that never resolves is exactly the thing that hangs.
- The child `require`s `service.js` as ordinary CommonJS, so it *can* require
  siblings — but a pack install will never put a sibling there (finding 18).
- A **plain `render` over a service-backed pane deliberately drops `component`**
  (`lib/server/domain/mounts.js:217-219`: "Never carried"), which is how the
  supervisor stops the child. If you re-render a service pane with `render`
  instead of `use_component`, you silently kill its service.

---

## 11. What service trust is actually keyed on

**Claim.** Consent is recorded per **(project root, `service.js` contents, params)**,
not per component name — and the params half has three render-control keys
stripped out first. The trust file lives in the **user tier**, never the project.

**Evidence.**

```js
// lib/server/services.js:83-85
function trustKey(hash, root, paramsFp) {
  return crypto.createHash('sha256').update(`${root}\0${hash}\0${paramsFp}`).digest('hex');
}
```

- `hash` is `sha256(service.js)`, re-read from disk per reconcile
  (`lib/server/components-registry.js:91-96`).
- `root` is the project root. The reasoning at `lib/server/services.js:71-73`: a
  service reads and writes the project it is spawned under, so "one approval must
  not become a machine-wide capability that any repo you later clone inherits."
- `paramsFp` is `sha256(JSON.stringify(serviceParams(params))).slice(0,16)`
  (`:65-67`), where `serviceParams` (`:57-62`) drops
  `RENDER_CONTROL_PARAMS = new Set(['form_reset', 'routing', 'signals'])`
  (`lib/server/domain/mounts.js:169`) and sorts the remaining keys.

**That stripping is the finding.** Without it, adding `form_reset: true` to keep
prefills fresh — a purely visual choice — would restart the child and re-ask for
approval under a new identity (`lib/server/services.js:50-53`). With it, **you
can re-render a service pane, change its routing, or declare new signals without
ever re-prompting.** Everything else in `params` is part of the identity, and
deliberately so: `file-editor`'s `unfenced: true` is what lifts its writes out of
the project root, and "approving the fenced form must not silently approve the
unfenced one" (`:74-76`).

**Where the file lives, and why.** `~/.web-chat/services/trusted.json`
(`lib/core/paths.js:236`, via `lib/server/paths.js:16`). The comment at
`lib/core/paths.js:171-176` records the bug that moved it: it used to sit at
`.web-chat/services/trusted.json` inside the project, "which meant a repository
could ship its own pre-approval: clone a hostile repo, open it, and its
service.js ran host code with no prompt. A consent record must never be writable
by the thing asking for consent."

**The flow you must tell the user about.** The browser cannot grant this and
never will — `lib/server/services.js:270-286` explains that pane scripts share
the page's realm and origin, so "nothing delivered to the page — a nonce, a
token, DOM state — is a secret from the very code this gate exists to gate", and
notes that a repo committing `.web-chat/draft.json` plus a component directory is
enough to get its pane script running at daemon boot. What the surface shows is
**informational**: a card naming the command. The decision is a filesystem write
made by the CLI.

So: **if you mount a service-backed pane and do not say the command in chat, the
pane just sits there empty.** The commands:

| command | effect |
|---|---|
| `claude-web-chat trust` | lists every waiting request |
| `claude-web-chat trust <name>` | approves it |
| `claude-web-chat trust <name> --deny` | refuses, and **stops it being asked again** — a deny is recorded like an approval (`lib/server/services.js:105-112`) |
| `claude-web-chat trust <name> --params-fp <fp>` | picks one of several params-variants |
| `claude-web-chat trust <name> --all` | takes every variant of that component |

Two panes of one component with different params are **two** approvals, and the
CLI refuses an ambiguous bare name rather than guessing
(`lib/cli/commands/trust.js:23-25,63-69`). A denied service is silent, not
broken — if a user reports "it never asks me", check whether they denied it once.

---

## 12. Services die when viewers drop; panes survive the reconnect — the seq hazard

**Claim.** A service runs only while its pane is on the active node **and at
least one browser is watching**. Close the tab, sleep the laptop, or lose the
socket, and the child is stopped. When the browser comes back, the reconnect
takes the **reconcile** path: a pane whose spec is unchanged **keeps its live DOM
and its script is not re-run**. So the service restarts from scratch while the
pane does not. Any counter the service keeps in a closure resets; any counter the
pane keeps in a closure does not.

**Evidence.**

- Viewer gate: `lib/server/services.js:133` — `if (shuttingDown || (!ignoreViewers
  && getViewers() < 1)) return out;`, with `getViewers` bound to `wsApi.clients.size`
  (`lib/server/index.js:316`). The file header (`:13-15`) states the lifetime rule:
  "a service runs iff its pane is a live mount on the active node AND a browser is
  watching. Suspend == stop, resume == respawn (v1 has no warm-idle)."
- Reconnect path: `hello` is applied as
  `applySnapshot(msg, { mode: 'reconcile' })` (`public/app/ws.js:137`). In
  reconcile mode (`public/app/mounts.js:746-751`), "panes whose spec is unchanged
  keep their live DOM — including everything the user typed while the socket was
  down — and only pane_state/theme are applied over them." `sameSpec`
  (`:775-781`) compares `html`, `target`, `component` and `params`.
- The store *is* resynced across the gap — `syncStore` (`:787-801`) diffs and
  republishes, including publishing `undefined` for keys that vanished — so your
  pane's `store.subscribe` handlers do fire again. It is the pane's own
  script-local state that is stale.

**The hazard, concretely.** A service that pushes `{ mykey: { seq: ++seq, ...data } }`
from a closure `let seq = 0` restarts at 1. A pane that ignores writes with
`seq <= lastSeen` — where `lastSeen` is a script-local that survived the
reconnect at, say, 42 — will discard everything the respawned service sends. The
pane is live, the service is running, the store is correct, and the screen is
frozen. There is nothing in `get_events` to find.

**The builtins show both halves of the answer, and they differ on purpose.**

- *Service → pane.* `git-dashboard` pushes `{ git: { seq: ++seq, ...g } }` from
  `let seq = 0` (`templates/components/git-dashboard/service.js:120,136`) — and
  its pane does **not** filter on it. It is a plain
  `store.subscribe('git', (g) => render(g))`
  (`templates/components/git-dashboard/component.html:158`). The `seq` is there to
  make the value *change* so subscribers fire, not to be compared.
  **Rule: never gate a re-render on a service-authored `seq`. Render whatever
  arrives.** Make your pushes idempotent instead.
- *Pane → service.* Here a cursor is genuinely needed, so the pane stamps
  wall-clock time rather than a counter: `ctl({ seq: Date.now(), ... })`
  (`templates/components/file-editor/component.html:96,121`), and the service
  starts its cursor at its **own start time**, not zero —
  `let lastCtlSeq = startedAt` (`templates/components/file-editor/service.js:64`).
  The comment (`:57-63`) explains: a write stamped at or before we started "is by
  construction not a click made during our life — it is a persisted one, and a
  persisted `save` or `revert` must never execute."

That last point is a second, sharper hazard. **A control key is in the store, and
the store is snapshotted into every node** (finding 3). So navigating to an older
node hands the live service that node's control write, and a respawn re-reads
whatever is sitting in the key. `file-editor`'s own comment (`:185-199`) is the
cautionary tale: replaying a stale `save` "rewrote the file on disk with a buffer
from another session (edit the file in your IDE, reopen the tab, lose it)". Its
resolution — replay only *view* actions (`open`/`browse`), never mutating ones —
is the pattern to copy. `git-dashboard` can afford `lastCtlSeq = 0` (`:122`)
precisely because its control key only ever selects what to look at.

**Design rules that follow:**

1. A service's store push must be a **full current state**, not a delta. Assume
   the pane may have missed arbitrarily many pushes.
2. Never make the pane gate on a service-side counter.
3. A pane→service control key must be **wall-clock stamped**, and the service's
   cursor must start at its own start time.
4. Replay only idempotent, non-mutating actions on respawn.
5. Any state that must outlive a respawn belongs on disk under `ctx.webChatDir`,
   not in a closure.

---

## 13. Comment pins: the shape, and the two guarantees around it

**Claim.** A pin is a small, stable record; its `anchor` is stored **verbatim
with zero validation**; an anchor that cannot be resolved in the browser
**degrades silently rather than throwing**; and private pins are structurally
kept out of everything Claude reads.

**The shape**, from the route's own header (`lib/server/routes/comments.js:8`):

```js
{ id, seq, created_at, shared, text, anchor: { mount, selector, text, ordinal } }
```

`shared` defaults true. `seq` is a server-global monotonic counter never reset by
node navigation, so ids stay unique and a `get_comments` cursor advances safely
(`:9-11`). Replies ride on the pin as a `replies` array.

**Verbatim anchors.** `POST /api/comments` stores
`anchor && typeof anchor === 'object' ? anchor : null`
(`lib/server/routes/comments.js:95`). That is the entire validation: object or
null. No shape check, no length cap, no selector grammar. What the browser
normally writes is a tag-plus-classes selector built by `selectorFor`
(`public/app/comments.js:97-101`) with an `ordinal` and 120 chars of text
(`captureAnchor`, `:102-107`) — but nothing enforces that, and
`describeAnchor` (`lib/server/routes/comments.js:35-41`) does **not** truncate
`selector` on the way to Claude. If your component mints its own anchors, you own
the bounds: cap the length, cap the structure, and validate before it becomes
durable data that rides into every graph node.

**Degradation is safe.** `resolveAnchorEl` (`public/app/comments.js:317-339`):

```js
let cands = [];
try { cands = [...host.shadowRoot.querySelectorAll(a.selector)]; } catch (_) { return null; }
if (!cands.length) return null;
```

A selector that throws (invalid CSS) returns `null`; one that matches nothing
returns `null`. Callers skip a `null` — `markersSig` (`:356`) and
`rebuildMarkers` (`:383`) both `continue`. So an unresolvable anchor means **no
marker is drawn**, while the pin itself still exists, still persists into nodes,
and still reaches Claude through `get_comments`. Nothing breaks; the pin just
becomes invisible on the surface. That is a real failure mode to design for
(a pin whose target was re-rendered away is a pin the user can no longer find),
but it is not a crash, and a syntactically-valid selector that matches nothing is
handled identically to one that used to match.

**The private-pin boundary** is enforced in three places, and it is worth
understanding because it constrains where you may put pin-adjacent data.

The header states the rule (`lib/server/routes/comments.js:1-4`): pins live in
`state.comments`, "a dedicated array, **NOT** the freeform store — because the
store is exposed to Claude (get_store, diff_nodes) and private pins kept there
would leak."

1. **Read.** `GET /api/comments?shared_only=1` filters to shared pins, and that
   is the MCP boundary (`:57,64,69`). The browser omits it and gets everything,
   because it renders private pins for their author.
2. **Event ring.** `redactPin` (`:27-32`) blanks a private pin's `text` and every
   reply's `text` in the *event* copy, keeping only the fields the dequeue path
   needs. The reason (`:21-23`): "get_events serves the ring unfiltered, so it
   would leak exactly what get_comments withholds."
3. **Queue.** A private pin never enqueues, and a shared→private flip actively
   *dequeues* (`lib/channel/policy.js:246-256`).

**Consequence for a pack author.** If your component computes anything that
describes *where* a pin is — coordinates, a region id, a file offset — do not put
it in the store as a parallel map keyed by pin id. The store is Claude-visible
and node-snapshotted; you would be reconstructing private pin locations outside
the boundary that exists to prevent exactly that. Encode it into the pin's own
`anchor.selector` instead, where it inherits the pin's shared/private filtering
for free.

---

## 14. `routing:'none'` does not suppress comment items

**Claim.** `params.routing:'none'` opts a pane out of **activity** routing —
undeclared store writes and forwarded DOM events. It does **not** suppress
comment pins on that pane. A pin on a `routing:'none'` pane still enqueues.

**Evidence.** `lib/channel/policy.js`, `classify`. The `store` branch checks it
(`:218`: `if (mountId && routing[mountId] === 'none') return null;`) and so does
the `dom` branch (`:234`). The `comment` branch (`:240-266`) checks neither
`routing` nor `source` — it dispatches purely on `event.op`, `event.pin.shared`
and `event.author`.

**Consequence, the useful half.** This is what makes "opt the pane out of
activity noise, keep pins as the wake path" a coherent design: you get a clean
channel where the only thing that reaches Claude from this pane is a deliberate
pin. That is a genuinely good pattern for a pane the user manipulates constantly
(panning, zooming, selecting) where every interaction would otherwise be an
activity item.

**Consequence, the half to be honest about.** `routing:'none'` is not a mute
switch. A user who sets it expecting silence still gets woken by pins. Say which
you mean in your component's docs.

There is a related asymmetry worth recording, since it constrains what you can
promise: the `store` and `dom` branches gate on `event.source !== 'browser'`
(`:206`, `:233`) so that Claude's and drivers' own writes cannot self-wake, and
`commentItem` hardcodes `source:'browser'`. The comment branch has no equivalent
source gate. Combined with finding 1 — the comments API is an ordinary
unauthenticated route reachable from any pane script — this means the pin path is
weaker than the signal path, and a pane's ability to reach `POST /api/comments`
is not distinguishable from a user's click. This is inherent to the
no-CSP/same-origin model rather than a defect in the comments code, and it is a
reason to be conservative about what you render into a pane, not a reason to
avoid pins.

---

## 15. The drawer cannot pass `signals` — form-spawned components have no wake

**This one wants a fix in web-chat core.** It is not a design tradeoff; it is a
gap where two code paths diverged.

**Claim.** When Claude spawns a component via `use_component`, it can declare
wake signals. When the **user** spawns the same component from the drawer — or
when the drawer renders a params form because required params are missing and
spawns on submit — no `signals` are passed. There is no way to pass them. The
component mounts with no declared wake, and the user's deliberate "Apply" button
writes a store key that nobody is listening for.

**Evidence.** Signals ride under `params.signals`, a persisted mount field the
daemon derives its wake registry from — `lib/mcp/tools/use_component.js:30-38`:

```js
async handler({ name, params, id, target, force, signals }) {
  const body = { params, id, target, force };
  if (Array.isArray(signals) && signals.length) {
    body.params = { ...(params || {}), signals };
  }
  return await client.post(`/api/components/${encodeURIComponent(name)}/use`, body);
}
```

The drawer's spawn path posts to the same route and sends only `{ id, params }`
— `public/app/drawer.js:356-359`:

```js
async function mountComponent(name, id, params) {
  const r = await fetch(`/api/components/${encodeURIComponent(name)}/use`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, params: params || {} }),
  });
```

Every drawer caller goes through it, including `spawnComponent`'s form path
(`:412-450`), which mounts `form-renderer`, subscribes to a private
`__spawn_<name>` key, and on submit calls the same `mountComponent(name, id, vals)`.
The form's own submit key is a **client-local `store.subscribe`** closure
(`:428-440`), not a declared signal — it never reaches the daemon's wake
registry, and it is nulled after use.

Nothing in `meta.json` closes the gap either: `params_schema` describes params,
and there is no `signals` field the registry reads
(`lib/server/components-registry.js:41-49` shows the whole record).

**Consequence.** A component whose interaction model depends on a declared signal
is only fully functional when Claude spawns it. Spawned from the drawer, its
Apply button writes to a key that produces — at best — a generic per-mount
activity item (and only when the write is gesture-proximate; see finding 18), and
only if `routing` is not `'none'`. If the component *also* sets `routing:'none'`,
the drawer-spawned instance is silent.

**What to do until it is fixed.** Say in the component's `meta.json` description
that it should be spawned by Claude with a named signal, and have the pane detect
the absence — the pane cannot read its own signal registration, but it *can* read
`params.signals`, since that is where the declaration is stored. If it is absent,
render a one-line notice telling the user to ask Claude to re-open the pane
rather than leaving a dead button on screen.

**What the fix looks like.** `meta.json` gains an optional `signals` array; the
registry surfaces it in the component record (it already surfaces `params_schema`
the same way); `mountComponent` merges it into `params` exactly as
`use_component.js:36-38` does. That is three small changes in files that already
know about each other, and it would make a pack's components behave identically
whichever way they are spawned. Worth filing upstream.

---

## 16. `set_store` takes a patch wrapper; the driver's `setStore` does not

**Claim.** These two are not interchangeable, and getting it wrong is silent.

```js
// MCP tool — the patch is WRAPPED
set_store({ patch: { dsn_state: 'ready' } })

// service / driver — the patch is DIRECT
ctx.driver.setStore({ dsn_state: 'ready' })
```

**Evidence.** `lib/mcp/tools/set_store.js:13-15` posts `args` whole to
`/api/store`, and the route reads `req.body?.patch || {}`
(`lib/server/routes/store.js:11`). The driver wraps for you —
`lib/driver.js:51-53`: `setStore(patch) { return call('POST', '/api/store', { patch }); }`.

**The silent part.** `POST /api/store` with an unwrapped body falls back to `{}`,
`Object.assign`s nothing, emits an empty patch, and returns
`{ ok: true, store: state.store }` (`lib/server/routes/store.js:10-15`). You get
a success response containing the whole store, which reads like it worked. The
only tell is that your key is not in it.

**A second difference that matters more.** Store writes carry a `source`, and it
decides whether anything wakes:

- Browser (pane) writes are `source:'browser'` (`lib/server/ws.js:161-175`) and
  are the only writes that can enqueue or wake (`lib/channel/policy.js:203-206`:
  "Self-wake gate: only a browser (pane) write can be a signal").
- Everything through `POST /api/store` — Claude's `set_store` **and** a driver's
  or service's `setStore` — is `source:'server'` (`lib/server/routes/store.js:13`)
  and never enqueues.

So a service cannot wake Claude by writing a signal key, no matter how the key is
declared. Its writes reach the pane live over the WS broadcast, and Claude sees
them on the next turn via `get_store`/`get_events`. If a service needs to raise
something to Claude's attention, it must go through the pane: the service writes
state, the pane renders an affordance, and the *user* clicks it — which is a
browser write, and which is the deliberate-handoff ritual the whole channels
design is built around. That is not a limitation to work around; it is the
design.

---

## 17. The floor is `>=0.7.0`, and `>=0.6.0` is a trap

**Claim.** Declare `requires["web-chat"] = ">=0.7.0"` in your pack manifest. On
0.6.x, `use_component` **silently drops** `signals` and `force`, so a pack that
declares a wake at spawn time loses its wake path with no error anywhere.

**Evidence.** Side by side.

0.6.0 (`lib/mcp/tools/use_component.js:16-18`) — four params, and the handler
destructures only those four:

```js
async handler({ name, params, id, target }) {
  return await client.post(`/api/components/${encodeURIComponent(name)}/use`, { params, id, target });
}
```

Its `inputSchema` (`:8-13`) lists only `name`, `params`, `id`, `target`. No
`signals`, no `force`.

0.7.0 and later (`lib/mcp/tools/use_component.js:30-39`) has both, and the
handler's own comment records the bug being fixed: "a top-level `signals` array
used to be dropped by this destructuring, so a declared wake silently never
registered."

**Why it is specifically a trap.** `render` had `signals` in **0.6.0 already**
(`0.6.0/lib/mcp/tools/render.js:21-23`). So you can develop a pane with `render`,
watch signals work perfectly, promote it to a saved component, switch to
`use_component`, and lose the wake — with the same MCP server, the same daemon,
and no error message. The two tools were not equivalent until 0.7.0, and the
0.7.0 description now says so explicitly ("Equivalent to `render` — same
mount-set, same ownership guard and `force`, same declared `signals`…").

`force` matters for the same reason: without it you cannot deliberately take over
a pane owned by a driver, and the soft-rejection `{ok:false, owned:true, owner}`
has no escape hatch from `use_component` on 0.6.x.

**Other reasons the floor is 0.7.0**, from the changelog's own upgrade notes
(`CHANGELOG.md:100-125`):

- **Node 22 is a hard floor** from 0.7.0 — a transitive dependency is ESM-only,
  and on Node 18–21 the daemon does not start at all. (`package.json` in 0.7.5
  declares `"engines": { "node": ">=22" }`.)
- The **preview CSP** (finding 7) arrives in 0.7.0. Before it, a preview could
  frame and fetch; a component written against 0.6 behaviour will look broken in
  thumbnails after an upgrade.
- The `Host` header gate arrives in 0.7.0 — anything not `localhost`/`127.0.0.1`
  (or a matching `WEB_CHAT_HOST`) gets `421 Misdirected Request`, for the page as
  well as the API. Tunnels, forwarded ports and container hostnames are refused.
- `file-editor` fences by realpath from 0.7.0, and both builtin services need
  re-trusting because their `service.js` contents changed (finding 11 explains
  why that re-prompts).

---

## 18. Smaller things worth knowing

**A pack installs exactly four files per component.**
`COMPONENT_FILES = ['component.html', 'meta.json', 'seed.js', 'service.js']`
(`lib/packs/plan.js:25`), and `lib/packs/tree.js:4` calls a component "a directory
of four files". A fifth file in your source tree is simply not copied. So **two
services in one pack cannot share a helper module** — each `service.js` must be
self-contained. Plan for duplication or for a single service that serves both
panes.

Removal is per-unit, not per-file (`lib/packs/tree.js:1-16`): if every recorded
file still matches its baseline the whole unit goes; if **any** file differs or
is missing, the whole unit is kept and released to the user as their own. That is
deliberate — deleting three files around one the user edited would leave "a broken
half-component that the registry still lists and `use_component` still resolves".

**The directory name is the component's identity, not `meta.json`'s `name`.**
`lib/server/components-registry.js:32-43`. A mismatch used to make a component
visible in the drawer under a name `use_component` could not resolve — listed but
unspawnable. It now rides along as `meta_name` for the UI to flag. Keep them
equal.

**Builtin names are hard-refused for packs.** No override, either tier, either
actor (`lib/packs/manifest.js:194`). `seedBuiltins` only repairs a directory whose
`meta.json` says `builtin: true`, so a pack shadowing `git-dashboard` would win
*permanently* (`lib/server/builtins.js:13`).

**An undeclared store write only becomes an activity item if it is
gesture-proximate.** The per-pane store facade stamps `gesture: true` when a real
user interaction happened within 1500 ms (`public/app/mounts.js:609-616`,
`GESTURE_WINDOW_MS`), and `classify` drops an ungestured undeclared write
outright (`lib/channel/policy.js:215`): "A pane script's init/tick/reactive writes
carry no gesture and must never masquerade as user activity." So a pane that
writes on a timer produces no queue noise — good — but it also means you cannot
rely on an undeclared write reaching Claude at all. Declare a signal for anything
that carries meaning.

**A pane that grabs `window.store` instead of the injected `store` still works,
just unattributed** (`public/app/mounts.js:605-608`). Its writes carry no `mount`
id, so activity routing cannot attribute them and `routing:'none'` cannot
suppress them. Always use the injected `store`.

**The event ring is 1000 entries** (`lib/core/bus.js:45`) and reports
`gap`/`dropped` when your cursor has fallen off it (`:100-124`). A daemon restart
resets the seq space and reports `gap: true, reset: true` with `dropped: 0`,
because the count is unknowable. Resync from `get_store` and `list_mounts` when
you see either.

**`list_mounts` returns each pane's `form_state`** — what the user has typed even
if they never submitted (`lib/server/routes/render.js:24-36`). This is the answer
to "the user filled in the form but never hit the button", and it works even when
the pane's own script never ran, because the capture is a delegated listener in
the shell rather than in the pane.

**Mount ids that collide with shell chrome are refused** with
`{ok:false, reserved:true, hint}` rather than silently clobbering the surface
(`isReservedId`, `lib/server/domain/mounts.js`). Prefix every mount id with your
pack's name and it never comes up.

**Pane ownership is real and soft-enforced.** A pane belongs to whoever last
rendered it; a different owner re-rendering is rejected with
`{ok:false, owned:true, owner}` unless `force:true`
(`lib/server/domain/mounts.js:238-245`). `clear` is gated identically, and a bulk
clear that would take a foreign pane is rejected **whole** rather than
half-applied (`lib/server/routes/render.js:38-52`).

---

## How to verify any of this yourself

The install is a plain directory tree of readable CommonJS and ES modules — no
build step, no bundling, no minification. Everything above came out of:

```
ls ~/.web-chat/versions/            # which versions are installed
grep -rn '<phrase>' <version>/lib <version>/public
```

Two habits that paid off. First, **read the header comment of the file before the
function** — web-chat's headers routinely name the bug that produced the current
behaviour, which is worth more than the code. Second, **diff two installed
versions** rather than trusting a changelog for a behavioural claim; that is how
finding 17 was pinned down, and it takes one command.
