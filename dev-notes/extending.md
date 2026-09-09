# Extending wc-design

Notes for three kinds of reader:

- you want to push this pack forward — the next thing it should do is element-precise pins;
- you want to fork it and point it at something else;
- you want to apply the same technique to a completely different application.

Everything normative is in [`CONTRACT.md`](../CONTRACT.md); this file is the reasoning around
it — why the shape is what it is, what was deliberately left out, and where the seams are.
When this file and the contract disagree, the contract wins.

---

## 1. The v0.2 path: element-precise pins

### 1.1 The thing to understand first

**The canvas draws no pins.** Its entire visible comment surface is a full-bleed crosshair
overlay and one toolbar button. No pins, no bubbles, no threads, no composer. That is not a
gap in the product — the host is expected to draw them, which is why the integration hands
back placement coordinates at all.

This is the single fact that makes v0.2 tractable, and it is worth stating plainly because
it inverts the obvious assumption. There is no second pin system to suppress, shim over or
reconcile with web-chat's own. The canvas is a geometry engine with no comment UI; web-chat
is a comment UI with no canvas geometry. They are complements, not rivals.

So v0.1.0 already draws the markers, the composer, the pop-up and the off-screen dock, in
`component.html` under `PINS`. **v0.2 does not replace any of that.** It replaces exactly one
thing: where the marker positions come from.

### 1.2 What the upgrade actually is

v0.1.0 serves **no** `globalThis.claude` inside the frame at all. The canvas's comment layer
gates on a host-served comments capability, so with nothing served the layer never mounts.
That is the payload's own designed fallback, not a workaround: suppression is absence
(`CONTRACT` §9.2).

The upgrade is therefore purely additive. Serve exactly one capability,
`claude.comments.customAnchors`, and:

| v0.1.0 | v0.2 |
|---|---|
| fraction anchors — "42%, 77% of `Pricing.dc.html`" | element anchors — "this heading" |
| positions computed by the pane from frame rects | positions handed back by the canvas |
| pin mode freezes pan and zoom | pin mode co-exists with pan and zoom |
| an off-screen pin docks to the corner and you pan there yourself | the canvas can recentre on the pin |

### 1.3 What the integration is, at the level this repo can vouch for

v0.1.0 serves nothing, so nothing in the shipped code speaks this interface and this note
does not transcribe it. What is worth writing down is the shape of the seam and how to read
the rest off your own machine.

- **The gate is capability presence, and absence is silent from the pane's side.** With no
  capability served the layer never mounts and the canvas logs one `[design]`-prefixed
  warning into the *frame's* console. That warning is your ground truth for whether the
  object was seen at all — nothing crosses back out to the pane, and there is no
  `script-error` event, because nothing threw.
- **The canvas needs to locate a thread, not to read it.** Thread text, author, replies and
  resolved state never have to cross into the frame. That matters more than it looks: it is
  exactly where web-chat already keeps them — pins live in `state.comments`, deliberately
  outside the store, so `get_store` and `diff_nodes` cannot see a private pin's body — so the
  integration does not force private text through the trust boundary of §3.3.
- **Placement inverts.** Today the pane computes marker positions from frame rects; under
  v0.2 the canvas reports them, which is what retires `geometry()` + `correctBox()` + the
  fraction projection in `layoutMarkers()`.
- **Mode stops being the pane's to own.** v0.1.0 has to arm a full-bleed overlay to catch the
  click, and an armed overlay swallows every gesture; v0.2 does not need one, which is the
  whole of the "pin mode co-exists with pan and zoom" row above.

**Read the exact interface off the payload on your own machine before writing against it,**
and treat what you find as version-local: it is minifier output and will churn between Claude
Code releases. `test/uc-port.test.mjs` demonstrates the technique this repo considers
acceptable — locate an implementation **by shape**, at test time, from the local install,
never by name and never from a committed copy.

### 1.4 Where the wiring goes

| what | where | change |
|---|---|---|
| install the capability | `mountFrame()` | new — see the timing note below |
| artboard rect reading | `geometry()`, `artboardEls()` | delete, or keep only for the artboard index |
| the header-hoist correction | `correctBox()` | **delete** — this is the most fragile code in the pane and v0.2 is what retires it |
| hit-testing a click | `hitTest()`, `onOverlayClick()` | delete; the canvas reports the target |
| the armed overlay | `setArmed()`, `paintArmbar()`, `onArmedKey()` | delete; mode is negotiated instead |
| minting | `mint()` | add kind `e`; keep the label rules of `CONTRACT` §4.4 unchanged |
| read-back | `decorate()` | **unchanged** |
| marker drawing, dock, pop-up | `layoutMarkers()`, `paintDock()`, `openPinPop()` | position source changes; nothing else |

**The timing note.** The object has to be in place before the canvas looks for it, and from
outside the frame you do not control when that is. Treat the sequencing as the first thing
you prototype, not the last, because getting it wrong is silent from the pane's side: a
warning inside the frame, a layer that never mounts, no error, no `script-error` event,
nothing in the pane's own console.

### 1.5 Why v0.1.0 minted anchors in the payload's own grammar

This is the decision the whole upgrade path rests on, and it cost nothing to make.

A pin's `anchor` is **durable data**. It is stored on the committed graph node, survives
restart, travels with the node, and the web-chat server stores it verbatim with zero
validation. So whatever grammar v0.1.0 chose, v0.2 would have to keep reading forever — or
silently orphan every pin anyone had ever placed. There is no version field on a pin and no
migration hook in the host to hang one off.

So v0.1.0 mints in Claude Design's own artboard-fraction form rather than in a scheme of its
own:

```
dca<fileHash12><fx4><fy4>:nth-of-type(1)
```

Three properties fall out of that choice:

1. **The upgrade needs no migration.** Those exact strings are already valid input to the
   canvas's own parser, and the canvas already knows how to place kind `a`. Every pin placed
   by v0.1.0 hands straight into the thread list on the day the capability is served. The
   v0.2 change is *additive at the mint site* (new pins get kind `e`) and *nothing at all at
   the read-back site*.
2. **It costs nothing today.** The string is syntactically valid CSS that matches no element,
   so an unmodified web-chat's own marker layer runs `querySelectorAll`, gets zero hits and
   skips the marker rather than throwing. The pane draws it instead.
3. **Both directions were validated from day one** (`CONTRACT` §4.3, `A.isValidAnchor` at
   both `mint()` and `decorate()`). That is what makes it safe to accept an anchor a *stranger*
   minted later — a v0.2 build, a fork, the canvas itself — rather than only the ones we wrote.

The generalisable rule: **when you must invent an identifier that will outlive the code
writing it, mint it in the grammar of the system you intend to integrate with, even if you
are not integrating yet.** You pay nothing now and you buy the migration for free.

And the claim is *checkable*, which is the other half of it. `test/uc-port.test.mjs` proves
our `fileHash12` byte-identical to the payload's own implementation over at least 20 paths,
by extracting the payload's version at test time from the local install. If upstream ever
changes that hash, the test goes red and you find out before the anchors quietly stop
matching. **Keep that test.** It is what makes forward compatibility a fact rather than a
hope.

### 1.6 What v0.2 must not drag in

Serving one capability is not serving a host object. Hold these:

- **`claude.db`, `claude.use` and `claude.self.publish` stay unserved** (`CONTRACT` §9.2,
  §9.5). The v0.2 object should be `{ comments: { customAnchors } }` and nothing else. Serving
  `use` in particular changes what the page believes about itself, for a feature nobody asked
  for.
- **Keep the `live-store` refusal.** A page whose state block carries `store:"db"` boots
  read-only against a live store no matter what a host provides — it is not a canvas this
  pack seeded, and the operational rule is to refuse it, not to try to make it work.
- **Everything read out of the frame stays untrusted.** A placement map is frame-supplied
  data: match returned ids against pins you already hold rather than trusting them as keys,
  and bound and finite-check coordinates before they become `style.left`. `CONTRACT` §9.3
  does not get weaker because you now have a nicer channel into the frame — if anything it
  gets sharper, because there is now a channel at all.

---

## 2. What deliberately is not built

Each of these is a thing a reasonable person would try. The reasoning matters more than the
verdict, because the reasoning is what tells you whether it applies to *your* fork.

### 2.1 No capability emulation for persistence

The WYSIWYG Save path needs a `claude.self.publish` stand-in. In principle it is small. It is
not built, for reasons that compound:

- **The bundled `design` skill says, in as many words, never to add a stand-in for it.** A
  wrapper that overrides an explicit instruction from the thing it wraps is not a wrapper.
- **There is already a real answer.** Publish the canvas as an Artifact through the `design`
  skill and edit it there, with a Save backed by something that actually persists.
- **It would destroy the property that makes the rest of the pack simple.** Today the
  pipeline is one-way by *construction*: the service reads `dir` and writes only to its build
  directory and the carrier, so nothing can travel back. That is verifiable by reading the
  service. The moment you serve a publish stand-in, the pack owns a write path into 2.4 MB
  documents plus a conflict model, and "it never writes your files" degrades from a
  construction to a promise you have to test.

Note the shape of the refusal that is kept instead. With **no** host object at all, the
editor boots read-only from its embedded seed — there is no Save button to disable and
nothing on screen to extract. **Absence is the off switch.** You never have to defend a gate
you did not open. That is a much stronger position than a served-but-neutered capability, and
it is available here only because the app degrades gracefully; see FINDINGS §3.

### 2.2 No binary extraction

The payload is also recoverable directly from the Claude Code executable, byte-identically.
This repository does not do that and will not carry code that does. The terms prohibit
reducing the Services to human-readable form, and publishing a *tool* — or a recipe — that
does it is worse than doing it privately.

The supported path is to read the copy Claude Code itself wrote to a temp directory. When
that copy is absent, the remedy is `run /design once` — a first-class answer surfaced as its
own pane state (`no-payload`), not a fallback.

This is enforced mechanically rather than by care: `scripts/check-no-vendored.mjs` plus the
fingerprints in `upstream.lock.json`. **If you fork this, keep the tripwire pointed at your
fork's lock file.** A fork that vendors the payload is a redistribution whatever its README
says, and the failure mode is that nobody notices until it is public.

### 2.3 No core patches to web-chat

The tempting version: patch `public/app/comments.js` so the shell's own marker layer
understands canvas anchors, and the pane stops needing to draw markers at all. It is about
ninety lines and it works.

It is still wrong, because **web-chat installs as a release tarball**. A patch to it is a fork
of that tarball, and the next upgrade discards it — *silently*. Every canvas pin stays live in
`state.comments` and simply goes invisible. Data intact, feature gone, no error anywhere. That
is the worst failure shape on the menu.

The rule this generalises to, and the one worth copying into any pack:

> **A pack may only use the extension points the host gives packs.** If a feature needs a
> core change, it either goes upstream or it is done inside the pane.

Here that means the pane draws its own markers. More code, but it survives every upgrade.
The same reasoning ruled out a second loopback HTTP server with a wildcard CORS header (it
would re-introduce a regression the host documents having removed) in favour of the
`/api/components/:name` route that already exists.

---

## 3. Applying the technique elsewhere

The generalisable pattern:

> **A large, self-contained HTML application, delivered to a pane out-of-band so it never
> enters the graph, mounted same-origin so the host can integrate with it, with the host
> supplying the capabilities the app expects.**

Four moving parts. Each has a question to answer about *your* app before you write anything.

### 3.1 Self-contained — verify it, do not assume it

Open the file from `file://` with devtools and the network panel recording. You want zero
page errors and zero failed subresource requests. Then grep the source for `serviceWorker`,
`XMLHttpRequest`, `WebSocket`, `EventSource`, and look at what its absolute URLs actually
are — XML namespace URIs and hostnames inside doc-strings are fine, a CDN is not.

An app that fetches at runtime will half-work and mislead you for a day before you find out.

### 3.2 Out-of-band delivery — the cost model, not a gate

Nothing stops you putting 2.4 MB in the pane's `html` or in the store. The surface serves no
CSP on the render path, does not sanitise it, and has no size cap.

The reason not to is that **a committed graph node snapshots the whole store and every pane's
`html`.** A big value is copied into every node on disk, forever, and you discover it weeks
later as a slow, fat `.web-chat/`.

So the delivery channel needs three properties: same-origin, already authenticated, and *not*
part of anything the host snapshots. `GET /api/components/:name` has all three, and it works
for a component written at runtime because the registry re-reads the directory per call, so
nothing needs restarting.

Porting to another host, the question is **"what does this host already serve, same-origin,
that I can write to at runtime?"** — not "how do I add an endpoint". An endpoint you add is an
endpoint you have to secure.

### 3.3 Same-origin — a cost, paid only when nothing else works

Go same-origin **only** because the app's host contract is an in-page JavaScript object. Here
it is: all `postMessage` traffic in the payload goes *downward* into its own artboard
iframes, and the only link to a host is the capability object, so cross-origin is
structurally impossible rather than merely degraded.

**If your app talks `postMessage`, do not do this.** Sandbox it to an opaque origin, keep it
outside the trust boundary, and you lose nothing.

When you do pay the cost, pay the whole bill:

- Constrain **what may go into the frame** — here, only canvases seeded from the user's own
  local files — rather than trying to constrain what it can do once it is there. Provenance is
  the invariant that carries the risk.
- Treat everything read **out of** the frame as hostile input: bounded, sanitised, validated
  before it becomes durable data or reaches a prompt.
- Assume the frame can reach every host API that a same-origin page can, including the ones
  that read private data and the ones that install things.

### 3.4 Host-supplied capabilities — serve the minimum

Enumerate what the app checks for and what each capability unlocks. Then serve only the ones
whose feature you actually want.

The question to answer on **day one**: *what does this app do with nothing served?* Here it
degrades to a read-only viewer — pan, zoom, look, export to PNG/PDF — which is a genuinely
useful product on its own. That is unusually lucky, and it is what made a small v0.1 possible.
If your app *crashes* with no capabilities, the whole "serve nothing, ship a viewer" tier does
not exist and your first release is much larger. Find that out before you plan, not after.

### 3.5 Good fit / bad fit

**Good fit**

- One file, no network, no service worker.
- Degrades to something useful with no host object.
- A host contract that is an in-page object — or nothing at all, in which case you do not even
  need same-origin: sandbox it and you are done.
- Content you or the user authored, so the same-origin exposure is bounded by provenance.
- Already on the user's machine, so you never ship or fetch it. Easy to overlook, and it is
  what makes the legal position clean.

**Bad fit**

- Fetches at runtime. A sandboxed opaque origin can reach nothing, and a same-origin frame
  reaching out is a bigger exposure than you meant to take.
- Needs a service worker. That needs a real origin and a scope; `srcdoc` has neither.
- Has a `postMessage` host protocol — then same-origin buys you nothing and costs you the
  isolation.
- Shows content that arrives over a network or from other people. Provenance is what carries
  the same-origin risk; without it the stance collapses back to "sandbox it and lose the
  integration".
- Would have to be redistributed to work at all.
- Only becomes useful if you can write back into the app's own store. That is where a wrapper
  stops being a wrapper.

One more that generalises: **anything relying on `crypto.randomUUID`, `crypto.subtle`, or the
clipboard needs a secure context**, with the consequences in §4.1.

---

## 4. The traps, ranked by how much time they cost

### 4.1 The secure-context requirement — the most expensive one

It is not "any local origin". Outside a secure context `crypto.randomUUID` is undefined, the
canvas's unguarded artboard handshake throws, and you get a **permanent spinner with the
toolbar rendered** — it looks like a slow load, not a failure.

Works: `file://`, `http://127.0.0.1`, `http://localhost`, `http://*.localhost`, any `https://`.
Broken: every other host over plain http — a LAN IP, a bare hostname, an mDNS `.local` name.

It costs the most because every reasonable next step breaks it — bind `0.0.0.0` so a phone can
see the surface, share it across the LAN — and it breaks *only* the canvas, so you will spend
the afternoon blaming your own code. Detect `!window.isSecureContext` and warn **before**
mounting the frame, which is what the pane does.

### 4.2 The graph-snapshot cost model

Covered in §3.2 and worth restating as a trap, because it is silent and permanent: every
committed node snapshots the store and every pane's `html`.

The same bug in miniature is why `seed-failed`'s hint carries a **16 KB cap that announces its
own truncation**. The helper's stderr is written to be read, so it goes into the store
verbatim — but an unbounded value in a store key is copied into every node from then on. The
rule: anything large arrives as a file, out of band; anything unbounded gets a cap *before* it
goes near the store.

### 4.3 Near-silent pane failures

Three distinct ones. All three look identical from outside: the pane renders its markup and
then does nothing.

- **Top-level `await` in a pane script is a SyntaxError.** Pane scripts compile as
  `new Function('store','root','params','mountId', body)`. The script never compiles and the
  failure goes to the mount's error path rather than to you. Wrap the whole body in an async
  IIFE — `run()` at the bottom of `component.html` is the shape.
- **`document.querySelector` cannot see into the shadow root.** Query through the injected
  `root`. `document.createElement` is fine, and is preferable to `innerHTML` for anything
  data-derived anyway.
- **`seed.js` runs under a different constructor** — the async one, with a plain-`Function`
  fallback when the engine has no async support. In that fallback an `await` does not throw;
  it degrades the seed to "no defaults" and the drawer just shows an empty form. So a seed
  *may* await in principle and should not in practice.

Your instrument for all of these: a pane script that throws at mount lands in the event log
as `kind:'script-error'` with the mount id and the head of the stack. **Check `get_events`
before you start bisecting the pane.**

The related family: a pane that only works against a live daemon renders an empty box in a
node preview (`default-src 'none'` with no `frame-src` and `connect-src 'none'` — both the
frame and the fetch are dead) and in a frozen export (pane scripts run, but there is no
server behind them). Both are detectable up front, and `CONTRACT` §5.2 requires a real screen
for each rather than a blank.

### 4.4 The service seq hazard

Symptom: a canvas that looks perfectly fine, ignores the disk, and answers Reseed with
nothing. Cause: a monotonic counter that crosses a process boundary.

The supervisor stops a service child when the last browser stops watching and respawns one
when a browser returns. The reconnect handshake keeps a pane whose spec is unchanged
**mounted**. So the pane outlives its own service. A fresh child that starts counting at 1
publishes *below* the pane's high-water mark, and a strict "seq must increase" guard drops
every write from that child forever.

Both halves are needed, and both are in the code with comments saying so:

- the **service** adopts a seq floor from the store before its first publish — including the
  failure publishes, which is why the floor step runs before any state is chosen;
- the **pane** treats a strict *regression* as "a new writer started counting again" and
  adopts it, while still refusing an exact *repeat*, which is what a replayed snapshot looks
  like.

Generalised: **any monotonic counter crossing a process boundary must be seeded from shared
state at startup, and the reader must be able to tell a replay from a restart.** Two
different symptoms, opposite fixes, and only one of them is the one you will think of.

### 4.5 The trust gate

A service is host code, so it does not start until the user runs
`claude-web-chat trust <name>` **in a terminal**. Consent is keyed on **(project root,
`service.js` contents, params)**.

Three consequences to design for:

- **The pane must name the command, not offer a button.** It cannot grant the approval, and
  the reason is not policy: pane scripts run in the surface's own realm, so anything delivered
  to the page is readable by exactly the code the gate exists to gate. Say the command in chat
  in the same breath as mounting the pane, or the pane sits there empty and the user has no
  idea why.
- **Params are part of the identity**, so make the documented mount shape and the drawer's
  spawn shape *identical* — otherwise the same canvas asks for approval twice. This is why
  `seed.js` spells out `isolate`, `watch` and `routing` explicitly on its one complete-return
  branch rather than letting defaults fill in: a complete return skips the form, and nothing
  downstream applies the schema defaults.
- **Render-control params (`signals`, `routing`, `form_reset`) are stripped before the
  fingerprint**, which is what makes it safe for the seed to attach `signals` without
  triggering a second approval.

Editing `service.js` at all — including a version bump of the pack — asks again. Budget for
that during development: you will be re-approving constantly, and that is the gate working.

### 4.6 The tripwire pragma — the repo rule worth copying

The tripwire fails any tracked file that matches a locked upstream hash, carries an upstream
marker string, or exceeds 256 KB. The interesting part is the exemption.

**Detection code has to name the thing it detects.** And because a component installs exactly
four files, that detection logic cannot be imported — it is duplicated inline in the
component's `seed.js` and `service.js` by contract. So the tripwire needs a way to say "this
file names a marker on purpose".

A path-based allowlist would go stale the moment a file is renamed. So the exemption is a
**pragma the file declares about itself, in its own header**:

```
// check-no-vendored: names upstream markers for detection, ships none
```

It must appear within the first 4096 bytes — in the header, not buried in pasted content —
and it **fails closed**: a new file carrying a marker without the declaration is a hard
failure, and the hash and size rules still apply to a file that declares it, so a pasted 2.4 MB
payload is caught regardless. Markdown is exempt outright, because the docs exist to describe
the format.

The pane goes one better and never writes the marker at all, splitting the literal at the
point of use. It has to do that anyway — a literal `<script` inside a pane script would end
the script early in the HTML parser — but the two constraints happen to agree.

Copy the shape, not the string:

> **A scanner must give code a way to say "I name this deliberately", and that way must live
> in the file, not in the scanner.**

Two smaller pieces of the same job are also worth lifting: the CI step that asserts the
tripwire had *something* to check (`git ls-files` returning nothing would make it pass
vacuously), and the not-a-git-repository path that exits 0 while printing, in as many words,
that nothing was verified. A checker that can pass without checking is worse than no checker.

### 4.7 Smaller ones that still cost an hour

- **The seeding helper's argument parser drops a trailing flag.** Its scan loop is bounded so
  that a flag in final argv position contributes no value and reads as *absent*. There is no
  `=` form, no short flags, no `--` terminator, and unknown flags are ignored in silence. Never
  build an argv whose last token is a flag.
- **`set_store` needs its patch wrapper** — `set_store({ patch: { k: v } })`. The unwrapped form
  merges nothing and still returns `ok: true`.
- **`signals` goes at the top level of `use_component`; `routing` goes inside `params`.** Each
  is dropped silently in the other position.
- **Re-parenting an iframe reloads it.** A repaint that calls `replaceChildren` over a wrap
  that is already in place re-parses 2.4 MB and throws away the user's pan and zoom.
- **The armed pin overlay swallows every gesture** while it is on — no pan, no zoom, no
  selection. v0.1.0 says so on screen rather than letting it read as a hang. v0.2 removes the
  overlay entirely (§1.2).

---

## 5. Where the seams are

### 5.1 To change delivery

**Service side:** `carrierNameFor()`, `carrierMeta()`, `writeCarrier()`, `removeCarrier()`,
`sweepStaleCarriers()`, and the `payload_component` field of `dsn_canvas`.
**Pane side:** `ensureLoad()` — the fetch, the name-grammar check and the `loadState` machine
it drives.

Whatever replaces the carrier component must keep all five properties:

1. **Same-origin**, or §1 becomes impossible.
2. **Outside anything the host snapshots** (§4.2).
3. **A handle the pane validates against a grammar before it fetches.** `payload_component` is
   an ordinary store value, and the store is writable by anything that can reach the store
   API — including, same-origin, the canvas frame itself. Unchecked, one store write points the
   pane at any component in the registry and gets its source executed in the daemon's trust
   realm. The name regex in `ensureLoad()` is the containment rule, and it is duplicated in
   `service.js` with a keep-in-sync marker at both sites.
4. **Per-mount**, so two panes cannot clobber each other's 2.4 MB.
5. **Cleaned up**, with the write order preserved: `meta.json` **before** `component.html`.
   The registry falls back to an empty `params_schema` when `meta.json` is missing, and an
   empty schema is exactly the case the drawer mounts *immediately* — so a window in which the
   carrier exists without its meta is a window in which one stray click writes 2.4 MB into the
   graph, forever. The reverse window is harmless.

The cheapest real change is not to replace the route but to change what you write into it.

### 5.2 To change the anchor scheme

One file is the source of truth: **`scratch/anchor-lib.js`**. It is *inlined, not imported* —
four files per component, and the pane script has no module system — so the loop is: edit
there, run `node --test test/uc-port.test.mjs`, re-inline into `component.html`.

It is written so the copy is mechanical: no `import`/`export`, no top-level `await`, no
`document.*`, exactly one identifier (`DsnAnchor`) leaking into pane scope, and a guarded
`module.exports` that is inert inside a pane. Keep those constraints or the copy stops being
mechanical and starts being a merge.

(It lives under `scratch/` and is re-included by an explicit negation in `.gitignore` —
`scratch/*` rather than `scratch/`, because git cannot re-include a file whose parent
directory is excluded. Worth knowing before you reorganise: ignored, a fresh clone fails
seven tests instead of running them.)

Call sites: `mint()` (write) and `decorate()` (read). Both go through `A.isValidAnchor`, and
validating in **both** directions is deliberate — the server stores `anchor` verbatim with
zero validation and does not truncate `selector` when it describes a pin, so this is the only
gate there is.

Two rules if you touch the grammar:

- **Prefer adding a kind to the payload's grammar over inventing one of your own** (§1.5). If
  you invent one anyway, you own the migration for every pin already sitting on a committed
  node, and there is no version field on a pin to help you.
- **The validator narrowing to `:nth-of-type(1)` is not an oversight.** The payload's mint site
  hardcodes index 1, so any other index is something we did not write. Loosening a validator to
  match a more permissive spec is the wrong direction to move.
- `fileHash12` is byte-load-bearing — the 32-bit multiplies, the finalisation order, the
  low-12-hex truncation, iteration over UTF-16 code units. Do not tidy it. The test is what
  tells you.

### 5.3 To support a second canvas per node

Most of it is already done, on purpose:

- the carrier name is per-mount (`design-canvas-payload-<8 hex of mount id>`);
- every anchor carries `anchor.mount`, and `decorate()` drops any pin that is not this mount's;
- the marker layer, the dock and the composer are per-pane.

**What is not per-mount: the store keys.** `dsn_canvas`, `dsn_files`, `dsn_ctl` and `dsn_ask`
are flat, so two panes on one node write the same four keys. The consequence is already
visible in `seed.js`, which refuses to pair a `title` with a `dir` unless both carry the same
`seq` — precisely because they can have come from different panes. Today, two panes means the
second one's publishes fight the first's and `dsn_ctl` is ambiguous about who should react.

The change is to suffix the keys per mount, and it touches: `publish()` / `publishFiles()` in
the service; the two `store.subscribe` calls, `sendCtl()` and `nextSeq()` in the pane; the
`signals` array in `seed.js`; the mount recipe in `SKILL.md`; and every key name in `CONTRACT`
§2.

The awkward part is the **signal key**, because it is declared at mount time in the
`use_component` call — so a per-mount signal key means the caller has to compute the same
suffix the service does. That argues for deriving the suffix from something the caller already
knows (the mount id it chose) rather than from something the service picks.

Or: do not. Two canvases on one node is a rare want. Two nodes is free.

---

## 6. If I were starting again

The thing that went right was accidental discipline: I asked *what does this app do with no
host object at all* very early, found "it boots a usable read-only viewer", and that answer
sized the entire first release. Everything else in v0.1.0 — no capability injection, no core
patch, nothing an upgrade can wipe — follows from being able to ship the degraded tier as the
product. If I have one transferable habit from this project, it is that question, asked on day
one.

What I would do differently is mostly about ordering.

I designed three stances for the comment feature and scored them against each other — who
owns pin placement, canvas or host — before I had established that **the canvas draws no pins
at all**. That single fact collapsed the design space: there was no second pin system, so the
question I had spent the effort on was never a real question. I would go looking for the
*shape of the seam* before designing against it. The cheap version: enumerate what the app
actually renders for the feature you want, before you enumerate your options.

I would test on a deliberately non-secure origin on day one instead of meeting §4.1 as a
surprise, and I would write the tripwire before the first line of implementation rather than
alongside it — the entire publishability of this repo rests on it and it is the cheapest thing
in the tree.

Writing `CONTRACT.md` first paid for itself and I would do it again. Where it failed is
instructive though: an early draft described an "edit round trip" through the helper's
`--extract`, which is wrong — that flag is for pulling a canvas back into files when it was
edited *somewhere else*. The error had already propagated into the README and the manifest
before it was caught. A normative document only helps if it is the thing that gets corrected
first, and the correction has to be a note *inside* it saying which text wins; anything else
leaves two plausible readings in the repo.

The code I am least happy with is `correctBox()`, the header-hoist correction that reconciles
the frame's reported rects against our own artboard index. It is a numeric heuristic with a
tolerance in it, and it exists only because v0.1.0 has to place pins itself. v0.2 deletes it.
I considered dropping projected pins entirely for v0.1 and shipping only the labelled dock —
honest, and much less code — but projection is what makes the feature feel real rather than
like a list of coordinates. I would make the same call, and I would keep the `exact: false`
flag that records when the heuristic fell back, because knowing *which* pins were placed by
guess is what makes the guess acceptable.

Starting again on a different application entirely, the first three questions, in order:
**does it work from `file://` with the network off; what does it do with no host object; and
what does it render for the feature I want to integrate with.** Everything in this document is
downstream of those three answers.
