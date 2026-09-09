# dev-notes

Maintainer notes for `wc-design`. Nothing in this folder is normative — these files explain
why the code has the shape it has, what will bite you, and where the seams are. Where a note
and the contract disagree, the contract wins.

| file | who it is for | what is in it |
|---|---|---|
| [`architecture.md`](architecture.md) | you have cloned the repo and are about to change the code | how the machine actually works end to end — payload discovery and the ownership gate, seeding through the helper, the carrier component, mounting the frame, the pin round trip, service lifecycle — with `file:line` into this repo |
| [`extending.md`](extending.md) | you want to take it to v0.2, fork it, or apply the same technique to a different application | the element-precise pin upgrade and what it would take, the three things deliberately *not* built and why, the traps ranked by how much time they cost, the seams worth cutting along |
| [`web-chat-notes.md`](web-chat-notes.md) | anyone writing a `claude-web-chat` pack, not only this one | 18 findings about the platform itself — no CSP, pane compilation, per-node snapshots, services and trust, comment pins, the version floor — each with a claim, a `path:line` and the consequence |

Start with `architecture.md`. Read `web-chat-notes.md` first if the behaviour surprising you
looks like the platform's rather than this pack's.

Elsewhere in the repo:

- [`../CONTRACT.md`](../CONTRACT.md) — the **normative spec**: params, store keys, states, the
  anchor grammar, the invariants. Every other file is written against it.
- [`../README.md`](../README.md) — the **entry point**: what the pack is, install, first run,
  limitations, the security note.
- [`../FINDINGS.md`](../FINDINGS.md) — the verified research the contract rests on.

These notes were written against `claude-web-chat` 0.7.5 and v0.1.0 of this pack, and cite line
numbers that drift. Grep the quoted phrase rather than trusting the number.
