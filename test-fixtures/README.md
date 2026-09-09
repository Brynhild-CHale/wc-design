# test-fixtures

Hand-authored inputs for the `wc-design` test harness (CONTRACT §8.1). Nothing
here is upstream: every byte is our own (§9.1).

## `canvas/` — the fixture canvas

A small, real two-artboard canvas: the settings pane of a fictional snapshot
agent, plus the restore-point detail screen it opens.

| file | what it is | why it is in the fixture |
|---|---|---|
| `Main.dc.html` | Backup-schedule pane, 560×720 | the entry artboard. Exercises the parts of the Design Component format that bite: `<script data-dc-script>` with `data-props` tweaks (a `color`, an `enum`, `$preview`), `renderVals()`, `{{dotted.holes}}`, `<sc-for>`, nested `<sc-if>`, an `onClick` handler bound per loop item, and an `<img>` referencing the fixture image by filename. |
| `Detail.dc.html` | Restore-point detail, 480×620 | a **static** sibling artboard with **no** `<script data-dc-script>` at all — an empty one is an error, and the harness must keep proving the no-script path seeds. |
| `canvas.json` | layout manifest | two frames 120 px apart (the helper warns below 80), per-artboard `title` and `is_interactive`, one `annotations` sticky note, and a `launch` view — so the manifest validator is exercised, not just the artboards. |
| `ridge-mark.svg` | 388-byte product mark | the image path: stored as bare base64 under its basename, referenced from **both** artboards as `src="ridge-mark.svg"`. |

Everything is inline `style="…"` with flex/grid and `gap`, icons are inline SVG
(never emoji), and the `<script src="./support.js"></script>` head line is
present verbatim in both artboards.

## The standard this fixture must keep meeting

**It must seed and `--check` clean — exit 0 with *nothing* on stderr.** The
helper writes every diagnostic to stderr, so one warning line is a regression
even though the exit code stays 0.

Against the helper from a local Claude Code install (never a committed copy),
seeding into a scratch directory — **never into this repo**, since a seeded file
carries the 2.4 MB payload inline:

```sh
node <payload dir>/seed-canvas.mjs \
  --template <payload dir>/payload.template.html \
  --out <scratch dir>/ridgeline-backup-schedule.html \
  --title "Ridgeline Backup Schedule" \
  --artboard test-fixtures/canvas/Main.dc.html \
  --artboard test-fixtures/canvas/Detail.dc.html \
  --canvas test-fixtures/canvas/canvas.json \
  --image test-fixtures/canvas/ridge-mark.svg

node <payload dir>/seed-canvas.mjs --check <scratch dir>/ridgeline-backup-schedule.html
```

`scripts/find-payload.mjs` resolves `<payload dir>`. With no payload on the
machine the tests **skip with a clear message** — they do not fail; CI has no
Claude Code install.

The fixture also round-trips: `--extract` of the seeded page returns all four
files byte-identical to the sources here.

## Changing the fixture

Re-run both commands above and read stderr before committing. Keep the fixture
small (each file well under the 256 KB tripwire ceiling and the image under
20 KB), keep it free of absolute home paths, usernames and emails (§9.6), and
keep `Detail.dc.html` script-free — that absence is the thing under test.
