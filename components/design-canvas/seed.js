// check-no-vendored: names upstream markers for detection, ships none
// (the placeholder title below is one of the strings the seeding helper's own
// `--title` gate refuses; naming it is how this file MIRRORS that gate, and it
// is a fingerprint rather than payload content — see scripts/check-no-vendored.mjs,
// which fails any tracked file carrying a marker without this pragma in its
// first 4096 bytes. CONTRACT §8.4 / §9.1.)
//
// Seed for design-canvas. Runs in the BROWSER when the drawer or the command
// palette spawns this component: `public/app/drawer.js` fetches this file from
// GET /api/components/design-canvas/seed and hands it to
// `window.__wcMount.runSeed(code, store, onError)`, which compiles it as
// `new AsyncFunction('store', <this file>)` and calls it with the surface's
// store (public/mount-runtime.js:139-151). Whatever it returns becomes the
// mount's params.
//
// Three facts about that runtime shape everything below.
//
// 1. It MAY await - the constructor is the AsyncFunction one. But when the
//    engine has no async support, mount-runtime.js:123-135 silently falls back
//    to plain `Function`, where an `await` is a SyntaxError and the whole seed
//    degrades to "no defaults". `store.get` is synchronous, so nothing here
//    awaits and that edge never applies.
//
// 2. If every key in the schema's `required` comes back non-empty, the drawer
//    mounts IMMEDIATELY and never shows the spawn form (drawer.js:410-416,
//    `isParamsComplete`). POST /api/components/:name/use then passes the params
//    through verbatim and applies NO params_schema defaults
//    (lib/server/routes/components.js). So a COMPLETE return has to spell out
//    `watch`, `isolate` and `routing` itself; a PARTIAL one gets the schema's
//    defaults filled in by form-renderer and can leave them out.
//
// 3. This file has no filesystem. It cannot stat a directory, list `*.dc.html`
//    or expand `~` - that is service.js's job on the host, and the service
//    refuses a bad directory loudly on `dsn_canvas.state:'bad-dir'` rather than
//    showing an empty frame.
//
// Hence the rule: offer back a canvas THIS surface has already seeded, and
// otherwise offer nothing. Inventing a plausible absolute path would only turn
// the drawer's question into a wrong answer the user has to notice.
//
// It reads only the two keys CONTRACT §2 defines as service->pane (`dsn_canvas`,
// `dsn_files`). There is deliberately no private "last dir" memory key: nothing
// in the contract writes one, so nothing here may depend on one.

// An absolute path, or ''. The service fences `dir` against the project root and
// would resolve a relative path somewhere the user did not mean, so a value that
// is not unambiguous is not worth proposing.
const absPath = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 4096) return '';
  return /^(\/|[A-Za-z]:[\\/])/.test(s) ? s : '';
};

// A mirror of the seeding helper's own `--title` gate. The helper is the
// authority and fails loudly (exit 1 -> state `seed-failed`); this copy exists
// only so the drawer never seeds a value already known to be refused. Keep the
// two in sync - the helper checks the raw string for length and characters, and
// the trimmed lower-cased string against the generic set.
const GENERIC_TITLES = [
  'design', 'canvas', 'design canvas', 'new design',
  'untitled', 'appifact', 'new appifact', 'artifact',
];
const safeTitle = (v) => {
  const s = typeof v === 'string' ? v : '';
  if (!s || s.length > 120) return '';
  if (/[<>&"\\]/.test(s) || /[\u0000-\u001f]/.test(s)) return '';
  if (s.indexOf('APPIFACT-TITLE-PLACEHOLDER') !== -1) return '';
  const t = s.trim();
  if (!t || GENERIC_TITLES.indexOf(t.toLowerCase()) !== -1) return '';
  return t;
};

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

const canvas = obj(store.get('dsn_canvas'));
const files = obj(store.get('dsn_files'));

// The directory the service actually RESOLVED, not the raw string somebody
// typed at it. Worth proposing even out of a failed state: a partial return
// always shows the form, so a path that just failed arrives as a prefill the
// user can correct rather than as a mystery empty field.
const dir = files ? absPath(files.dir) : '';

// A title is only worth proposing off a canvas that actually seeded. Every
// failure state - bad-dir, seed-failed, no-payload, live-store - still carries a
// `title`, and pairing one of those with its `dir` would satisfy `required`,
// skip the form, and reproduce the same failure with nothing to correct it.
let title = canvas && canvas.ok === true && canvas.state === 'ready'
  ? safeTitle(canvas.title)
  : '';

// Only pair a title with a directory when both came from the SAME publish. Both
// keys carry the service's monotonic `seq` (CONTRACT §2.1, §2.2), so a mismatch
// means they describe different moments - which is reachable, because the store
// keys are not namespaced per mount and two design-canvas panes on one node
// write the same two keys. Dropping the title (rather than returning both) is
// what makes the form appear and ask for it: returning both would satisfy
// `required`, skip the form, and mount one canvas's title against another's
// directory. `undefined !== undefined` is false, so a service that omits `seq`
// still pairs.
if (title && dir && files.seq !== canvas.seq) title = '';

// Nothing known: hand back nothing and let the form ask. Never guess a path.
if (!dir && !title) return {};

// Both known - and this is the ONLY branch that returns a complete param set,
// which is deliberate: `isParamsComplete` (drawer.js) will skip the form here,
// so this is the one place that has to spell the control params out, and having
// exactly one such place is what stops a future edit from leaking a complete
// return that forgot them.
if (dir && title) {
  return {
    dir,
    title,
    // Spelled out because a complete return skips the form, and nothing
    // downstream applies the schema's defaults (see note 2 above). These are the
    // documented defaults AND the exact shape SKILL.md tells Claude to mount
    // with, which matters: the service's consent identity is (project root,
    // service.js contents, params-minus-render-control), so matching that shape
    // means a drawer spawn reuses the approval Claude's own mount already got
    // instead of asking for a second one.
    isolate: false,
    // `dsn_canvas` records no `isolate`, so a pane that WAS spawned with
    // isolate:true cannot be reproduced here - it comes back at the documented
    // default, which is the safe direction only because §9.2 limits this
    // component to locally-authored canvases in the first place.
    watch: true,
    routing: 'none',
    // CONTRACT §2.4: `dsn_ask` is the pane's ONE declared wake, and the wake
    // registry is derived from `mount.params.signals`
    // (lib/server/domain/signals.js parseSignals) - so a mount that does not
    // carry it has no handoff path at all. That is worse here than elsewhere
    // because `routing:'none'` above also turns OFF the activity safety net
    // (deriveRouting, same file): an undeclared write would reach nothing, and
    // the pane would be sitting there offering an "Ask Claude" button wired to
    // a key nobody listens to.
    //
    // Safe to add on this branch: `signals` is a RENDER-CONTROL param
    // (lib/server/domain/mounts.js:169 RENDER_CONTROL_PARAMS), stripped by
    // `serviceParams` before the trust key is minted (lib/server/services.js:57-61),
    // so it does not change the service's consent identity and cannot trigger a
    // second `claude-web-chat trust design-canvas` prompt.
    //
    // Only THIS branch can carry it. A spawn that goes through the form gets
    // exactly the form's values (drawer.js:440 `mountComponent(name, id, vals)`),
    // and `signals` is not a params_schema property because form-renderer has no
    // way to render one - so a form spawn is signal-less no matter what is
    // written here. The pane detects that case and says so rather than promising
    // a handoff it cannot make.
    signals: [{ key: 'dsn_ask', wake: 'queue' }],
  };
}

// Partial: prefill what is known, leave the rest to the form, which supplies
// `isolate:false`, `watch:true` and `routing:'none'` from params_schema.
const out = {};
if (dir) out.dir = dir;
if (title) out.title = title;
return out;
