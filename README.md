# wc-design

> [!WARNING]
> ## ⚠️ Currently broken on Claude Code 2.1.278
>
> **Claude Code 2.1.278 introduced a breaking change:** `/design` no longer writes the canvas editor
> onto your disk, so this pack has nothing to mount. The pane reports `no-payload`, and the
> "run `/design` once" step under [Setup](#setup) does not bring it back.
>
> **We are exploring a fix.** Your `.dc.html` files are not affected.

A `claude-web-chat` component pack that wraps **Claude Design's canvas editor** and runs it locally,
against the `.dc.html` files in a directory on your own disk. The canvas mounts in a web-chat pane, so
you edit with the tools you already know — click-to-select, properties panel, inline text, undo/redo —
and **Save writes back to your files.** Nothing is published; nothing leaves your machine.

## What you get

- **A live canvas from files on disk.** Point it at a directory of `.dc.html` artboards (plus an
  optional `canvas.json` layout and any images beside them). Edit a file by hand and the pane re-seeds,
  with no turn of Claude's involved.
- **Edit in place, and Save is real.** The document goes back through Claude Design's own `--extract`
  and lands in your `.dc.html` files: backed up first, written-then-renamed per file, rolled back as a
  batch if any file fails, and never deleted.
- **Comment pins that reach Claude.** Pin a note to a spot on an artboard like you would on any other
  pane; it arrives by the ordinary `get_comments` path, with the ordinary shared/private distinction.

```js
use_component({
  name: 'design-canvas',
  id: 'design-canvas-main',
  params: { dir: '/path/to/design-work', title: 'Spring Menu Poster', routing: 'none' },
  signals: [{ key: 'dsn_ask', wake: 'queue' }],
})
```

`dir` and `title` are required; the other params, store keys and pin grammar are in [`CONTRACT.md`](CONTRACT.md).

## Setup

Needs Claude Code with its bundled `design` skill, `claude-web-chat >= 0.7.0` (0.6.x silently discards
`signals`), and Node >= 20. **Open the surface on `localhost`, `127.0.0.1` or an `https://` origin** —
the editor needs a secure context, and on a LAN IP the canvas hangs on a spinner forever.

```sh
claude-web-chat pack get     https://github.com/<owner>/wc-design   # download for review
claude-web-chat pack review  wc-design                              # read it before you commit
claude-web-chat pack approve wc-design                              # install it
```

Mount the pane, then **approve the service from a real shell** — the pane cannot grant this, and no
button on the surface can. Consent is keyed on (project root, `service.js` bytes, params), so
changing `dir` asks again:

```sh
claude-web-chat trust                 # what is waiting, with its params
claude-web-chat trust design-canvas   # approve it
```

If the pane reports no payload: **run `/design` once in Claude Code.** Claude Code writes the editor
onto your disk the first time that bundled skill runs in a session; this pack never downloads it.

## Its relationship to Claude Design

This is a wrapper around Anthropic's canvas editor — it ships none of Anthropic's code, fetches
nothing, and reads the copy Claude Code already wrote onto your own machine (a tripwire in `npm test`
fails the build if an upstream byte is ever tracked). It is **not affiliated with, endorsed by, or
supported by Anthropic**: the MIT license here covers this wrapper only, and if Claude Design changes
or goes away, this pack breaks with it.

## A note on security

The canvas frame is mounted with `srcdoc`, so it is same-origin with the daemon and sits inside its
trust boundary — code in that realm can read your private pins and reach the daemon API. **Only ever
point it at canvases seeded from your own local files**, never a published Artifact and never someone
else's design; the reasoning and the invariants are in [`CONTRACT.md`](CONTRACT.md) §9.

## Rough edges worth knowing

- Pins are artboard-fraction precise (`Pricing.dc.html · 42%,77%`), not element precise — and
  `isolate: true` disables them entirely.
- Node previews and web-chat's own `export` show a placeholder rather than the canvas. To share a
  design, send the seeded `.html` file itself; it opens standalone with no server.

## Going deeper

[`CONTRACT.md`](CONTRACT.md) is the normative interface — params, store keys, states, invariants —
[`FINDINGS.md`](FINDINGS.md) the research under it, and `dev-notes/` the maintainer notes.
