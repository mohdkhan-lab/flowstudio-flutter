# FlowStudio — Handoff Brief for the Second Muse

*Written by MK (the lead Muse) for the second Muse joining this project. Read this fully before touching anything. Everything below is verified from live tests and engine logs, not theory.*

## Who is who

- **Owner: Aslam.** He gives one-line directions in Roman Hindi (Hinglish) and expects finished output. Long reports: main points only. When you ship a build, give the **direct download link first**, not the release page.
- **MK (me): lead Muse.** I hold the full history, the owner's rules, the live-test route to Aslam's PC, and all releases. I am your coordinator.
- **You: second Muse, the parallel brain.** Deep code review, alternative approaches, tests, and adversarial review of plans *before* builds. See "How we work together" at the end.

## The app

**FlowStudio Lite** — a Flutter app with a Puppeteer (Node.js) engine. It rotates 50–100 Google accounts (each with ~50 free Google Flow credits/day) to generate videos on **Google Flow (flow.google.com)** and must download every finished video automatically.

- Repo: `github.com/mohdkhan-lab/flowstudio-flutter` (private). Work happens on `main`; CI (windows-latest) builds the Windows Setup.
- Key engine files: `engine/flowAutomation.js` (the cascade), `engine/networkCapture.js`, `engine/headlessHarvest.js`, `engine/downloadRouteOrder.js`, `engine/saveGuard.js`, `engine/mintWindow.js`, `engine/mintReplay.js`.
- Generation works fine. **The download is the whole problem.** That is the mission.

## The mission (owner's words, final form)

The moment a video finishes rendering, its file must be saved **that instant, directly from Flow's server, with zero clicks and zero visible UI**:

1. No Download-button click. No ⋮ menu. **The video editor must not open anywhere** — not in the visible tab, not in a second tab, not in a background tab. (The owner rejected a working background-tab build because he *saw* the editor in another tab.)
2. The download must come from the project/grid page's own context, or from a **window-less (headless)** browser. Nothing may ever appear on his screen during a download.
3. **Combined packs only** — never ship one-fix-at-a-time builds.
4. **Owner's route order:** Option 1 (main-page methods) → Option 2 (headless profile copy) → Option 3 (editor-harvest) **only as the last resort**, when everything else is exhausted.
5. A download-stage failure **never resubmits the prompt** (no double charge, ever). Failed tasks park as "Download remaining"; Resume retries the download only.
6. **Verdicts come from the engine log** (the `[ROOT] ...` lines), never from the Activity panel alone. Report **each video's render→save gap separately** — never just a total or a blanket "PASS".
7. App constraints: UI fits **1024×768** exactly; **pure English UI**; design changes need the owner's visual approval on an image sample first.
8. Releases: version bumped in **9 places** (pubspec, installer .iss, package.json, app_settings.dart, top_strip.dart, engine_bridge.js, mcp_server.js, automation_bridge.dart, run_project_smoke.js); the owner installs the Setup himself from the direct GitHub release link. The in-app updater is unreliable — don't rely on it.

## Proven facts — do not re-litigate these

- At render-complete, the file exists **only on Flow's server**. Bytes enter the page only after a download action or editor playback.
- Fetching the `lh3.googleusercontent.com/asb/*` link directly (the "pure backend" idea) returns a **~1.25 MB HTML page**, every time. Dead end, re-proven in many runs.
- The real file address is a signed **`flow-content.google/video/*`** URL. It first appears inside a **POST `flow.google.com/_/*/data/batchexecute` response**, after a download action.
- That mint call (rpcids=`as29s`) carries the media id **nowhere** (`idsInBody=0`, `idsInUrl=0`). Substitution replay is impossible; **verbatim replay returns the previous video** (the "teacher"). A content-hash guard exists to catch exactly that — it must stay.
- **Editor playback is a proven exact source:** when a task's editor opens, the editor itself GETs the task's own flow-content file. Capturing that body = zero-click exact save (proven repeatedly, frame- and hash-verified). But the owner banned the editor opening anywhere visible — hence the headless route.
- **Grid/main page:** scroll/hover provocation reliably produces only a **~91–128 KB preview stream**, never the full file — *except* three observed full-size streams (ZEROCLICK9 ×2, ZEROCLICK12 #1 ×1) that arrived **unbound** and were refused by the binding logic (see current frontier).
- **Session death is the long-term blocker:** pool accounts' Google sessions keep dying (DBSC cookie rejection, "Sign-out confirmed — Need Login (two strikes)"). No app version fixes this. Design around it; don't promise to fix it.

## Test history (standard test: 2 distinct prompts — red ball + blue toy car; 4s, 360p, Omni Flash; run via MCP in-app)

| Test | Build | Result |
|---|---|---|
| ZEROCLICK4/5 | .36/.37 | Viewer-button route: exact files — but it *clicks* (banned later) |
| ZEROCLICK6 | .38 | Editor-harvest: **zero-click exact save**, gaps 9.9s / 16.5s |
| ZEROCLICK7 | .39 | Editor-harvest: gaps 10.4s / 6.8s, exact |
| ZEROCLICK8 | .40 | Background-page editor-harvest, `bg=yes`, exact — **owner rejected: editor visible in another tab** |
| ZEROCLICK9 | .41 | Main-page only: full-size streams arrived but **unbound → refused** |
| ZEROCLICK10 | .42 | Binding pack: streams arrived late / in the wrong window → fail |
| ZEROCLICK11 | .43 | Hover + patience + order-binding: only ~91–128 KB previews → **Option 1 exhausted** |
| ZEROCLICK12 | .44 | Headless route **failed at launch (~0.2s, before the probe)**; main page again produced #1's full-size 1,225,554 B stream, unbound → fail |

**8 tasks are parked** (ZEROCLICK9–12, 2 each) — all Resume-only, no re-charge. A Resume on any of them exercises the current download cascade for free.

## Current state — v2.48.45 (built 2026-11-05, commit c0453a4, 1118 tests)

ZEROCLICK12 exposed two things, both addressed in .45:

1. **Headless launch failed instantly and the reason was recorded nowhere.** The catch around the headless launch swallowed the real exception; only a generic line was logged, and the profile-clone's per-file copy warnings were never logged either. So we still do **not** know whether Google accepts a copied session in a window-less browser — the probe never ran. Possible throw points: profile-not-found, clone with no Cookies, puppeteer launch error.
   → .45 logs the real exception (message + code) in the `[ROOT]` line and the strategy note, logs a `headless-clone copied=<n> missing=<...> warnings=<...>` line, copies Cookies **with its SQLite sidecars** (`-wal`/`-journal`), retries critical-file copies on EBUSY/EPERM/EACCES, and retries the launch **once** with a fresh clone.
2. **ZEROCLICK12 #1's full-size stream stayed unbound** (`bindReason=none`) despite first appearing during #1's own hover watch while #1 was the only completed video. MK traced the binding code end-to-end; every traced path binds this case and the tests reproduce the watch-bind — **no definite cause could be pinned**, so per the no-guessed-fixes rule .45 adds a diagnostic instead: `[ROOT] mainpage-bindcheck total=<B> firstSeen=<...> renderDone=<...> decision=<refused|unbound> why=<exact gate>` whenever a full-size stream is refused/unbound.

**Next step (ZEROCLICK13):** owner installs v2.48.45 → MK runs the standard test → the first verdicts are (a) the new launch-error line or the `headless-probe state=<...>` line, and (b) any `mainpage-bindcheck` line naming why a full-size stream was refused.

Route order in the code is exactly `['headless-harvest', 'mainpage-harvest', 'grid-replay']`. Option 3 (editor-harvest, the .38/.39 builds) exists in git history and is proven — but it is the **last resort only**, by the owner's explicit decision.

## How we work together

- **MK leads:** releases, version history, live tests on Aslam's PC (the FlowStudio MCP connection is attached to MK only), final verdicts, and all reports to Aslam. One shipper only — versions never collide.
- **You are the second pair of eyes and hands:** deep code investigation, prototypes of alternative routes, test coverage, and — most valuable — **adversarial review of each pack's plan before it ships**. The swallowed-exception gap survived four builds; a second reviewer is exactly how we stop wasting install–test cycles.
- **One file, one pair of hands at a time.** We split work by module or question, never edit the same file simultaneously. MK merges and ships.
- **Every proposal states:** the evidence it rests on, what it changes, and what it deliberately does *not* touch. No fix without a named hypothesis; if the cause can't be pinned, we instrument and observe — we don't guess.
- Aslam will put us in a shared chat. MK will task you there and carry the results back to him. You don't need to ask Aslam for approvals on standing FlowStudio work — he has a standing order: proceed, and report stalls/results in the main chat.

## Your first tasks

1. Read this brief, then the repo at latest `main`. Confirm back to MK: the current route order, where binding decisions are made (`saveGuard.mainpageBindingPlan` + the capture stream-book), and where the headless launch exception *was* swallowed.
2. Adversarial review of the v2.48.45 scope above — what is still missing that could waste the ZEROCLICK13 cycle?
3. Your own independent look at the `bindReason=none` problem: under what exact conditions can a full-size stream first seen during a task's own hover watch remain unbound? (The .45 bindcheck line will give us live evidence; your code-side hypotheses, ranked, are wanted before that run.)

*Background reading if needed: `flowstudio-download-research/RESEARCH-2026-11-02.md` (MK's workspace — ask MK/Aslam for it).*
