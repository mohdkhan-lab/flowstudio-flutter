# FlowStudio Lite v2.22.0 (Flutter) — AI & Developer Guide

> Corrected in v2.22.0. The previous edition of this file described files
> and endpoints that do not exist (engine/automator.js, engine/googleAuth.js,
> GET /api/health). Everything below was verified against the actual code.

## 1. Project Overview
FlowStudio Lite is a multi-account Windows desktop application for Google
Flow video generation. **Flutter frontend (Dart)** + an embedded **Node.js
automation engine** (Puppeteer + sql.js SQLite) — the same engine that
powers the Electron v2.21 app, copied unchanged into `engine/`.

## 2. Architecture & File Structure
```
flowstudio-flutter/
├── lib/                             # Flutter Dart source
│   ├── main.dart                    # Entrypoint, multi-provider setup, layout
│   ├── models/                      # account.dart, app_settings.dart,
│   │                                # activity_log.dart, prompt_item.dart
│   ├── providers/                   # accounts / activity / generator / settings
│   ├── services/
│   │   ├── automation_bridge.dart   # Spawns node engine_bridge.js, REST + SSE client
│   │   └── srt_parser.dart
│   ├── theme/app_theme.dart
│   └── widgets/                     # sidebar, prompts, settings bar, progress, …
├── engine/                          # Node automation engine (DO NOT rename files)
│   ├── accountStore.js  db.js  workerPool.js  flowAutomation.js
│   ├── cookieImport.js  cookieStore.js  cookieParser.js
│   ├── creditService.js creditWatch.js  networkCapture.js
│   └── … (tile binding, failover, download orchestrator, etc.)
├── engine_bridge.js                 # HTTP REST + SSE server on 127.0.0.1:48190
├── installer.iss                    # Inno Setup 6 script (Windows installer)
├── package.json / package-lock.json # Node deps: puppeteer-core, sql.js
└── pubspec.yaml                     # Flutter deps (file_picker 13.x etc.)
```

## 3. Communication Bridge (`engine_bridge.js` <-> `automation_bridge.dart`)
1. On start, `automation_bridge.dart` checks `GET /api/status`; if the
   engine is down it spawns `node engine_bridge.js` (node.exe next to the
   app exe first, then PATH) with the app folder as working directory.
2. Data persists in `%APPDATA%\google-flow-studio-lite\` (database +
   profiles). The bridge sets FLOW_LITE_DATA_DIR / FLOW_LITE_PROFILES_DIR.
3. REST endpoints (all under 127.0.0.1:48190):
   - `GET  /api/status` — health + version
   - `GET  /api/accounts` · `POST /api/accounts/add|delete|delete-selected`
   - `POST /api/accounts/sync-all|sync-selected|open-chrome|complete-login`
   - `GET  /api/chrome-profiles` · `POST /api/chrome-profiles/import`
   - `POST /api/cookies/import-file|import-text`
   - `POST /api/generation/start|pause|resume|stop`
   - `GET  /api/settings` · `POST /api/settings`
   - `GET  /api/stats` · `GET /api/activity` · `POST /api/open-url`
4. Live events: `GET /events` (SSE). Event names: `automation-log`,
   `automation-progress`, `video-completed`, `account-updated`,
   `cookie-phase`. The Dart client routes by the `event:` line — keep the
   names in sync on both sides.

## 4. Development & Running
```bash
npm install            # REQUIRED — node_modules is not in the repo
flutter pub get
flutter run -d windows
```
Smoke-test the engine alone:
```bash
node engine_bridge.js  # then: curl http://127.0.0.1:48190/api/status
```

## 5. Production Build & Installer
```powershell
flutter build windows --release        # produces flutter_flow.exe
npm install --omit=dev
Copy-Item (Get-Command node).Source .\node.exe -Force
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss
# Output: dist\FlowStudio_Lite_v2.22.0_Setup.exe
```
GitHub releases are built by `.github/workflows/release.yml` on `v*` tags.

## 6. Hard Rules for AI Assistants Working on This App
- **REAL WORK ONLY.** Never add mock/demo/simulated behaviour: no fake
  generation timers, no hard-coded accounts, balances or log lines, no
  fake "update available / latest version" answers. If a real call fails,
  surface the real error to the user.
- Browser visibility is the engine setting **`browser_background`**
  ('1' = background/off-screen, '0' = visible). The WorkerPool option is
  named `headless` but means this background flag — generation is never
  true-headless (Google Flow breaks in headless Chrome).
- Account status and credits shown in the UI must be exactly what the
  engine database reports — never invent defaults like 50 credits.
- file_picker is **13.x**: `pickFiles()` returns `List<PlatformFile>`.
- Never ship a database or profiles in the installer/repo.
- Windows path escaping: when spawning processes from Dart, do not use
  `runInShell: true` for paths with spaces.
