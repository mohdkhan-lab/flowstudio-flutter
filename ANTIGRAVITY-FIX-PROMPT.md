# ANTIGRAVITY PROMPT — FlowStudio Lite Flutter: fix it so it does REAL work

Copy everything below the line into Antigravity, opened on this project folder.

---

You are working on **FlowStudio Lite (Flutter edition)** — a Windows desktop app in this workspace. It is a Flutter frontend (Dart, in `lib/`) talking over HTTP/SSE to an embedded Node.js automation engine (`engine_bridge.js` + the `engine/` folder) that drives Google Flow in Chrome via Puppeteer to generate videos across multiple Google accounts.

The app was delivered broken: it does not do real work. Your job is to fix it end-to-end so that **every button performs the real action against the real engine**, and prove it with the verification steps at the end. Read `README_FOR_AI.md` first — but note it contains errors (wrong engine file names, a non-existent `/api/health` endpoint); trust the code, not that file, and correct the file when you are done.

## ABSOLUTE RULE — REAL WORK ONLY

Never write, keep, or reintroduce mock/demo/simulated behaviour of any kind:

- No fake generation progress, timers, or "completed" states that are not backed by a real file the engine actually downloaded.
- No hard-coded accounts, credit balances, log lines, or statistics.
- No fake "Check for Updates" that always answers "latest version".
- When a real operation fails, the UI must show the real error and stop — never silently fall back to pretending.

## KNOWN DEFECTS — FIX ALL OF THEM

1. **Fake generation simulation (worst defect).** In `lib/providers/generator_provider.dart`, if the engine bridge call fails, a `Timer`-based fallback (`_processNextPrompt`) pretends to generate: it animates progress, marks prompts completed, deducts a credit, and logs `Saved: video_N.mp4`. Delete this completely. If the engine does not respond, set the state back to idle and log a clear error. A prompt may only become "completed" when the engine's `video-completed` event for it arrives with a real `filePath`.

2. **Fake data on startup.** `lib/providers/accounts_provider.dart` pre-loads a hard-coded account ("M. Aslam, m.aslam@gmail.com, 50 credits"). `lib/providers/activity_provider.dart` prints invented lines ("Live balance: M. Aslam — 50 credits (previously 43)", "Engine bridge connected…") whether or not anything connected. `lib/providers/settings_provider.dart` → `checkForUpdates()` waits 2 seconds and always claims the latest version. Remove all of these. Startup state must come from the engine (`GET /api/accounts`), the Activity log must report the engine health check truthfully, and Check for Updates must make a real request to `https://api.github.com/repos/mohdkhan837218-spec/flowstudio-flutter/releases/latest` and compare the tag with the app's current version.

3. **Live events never reach the UI.** `engine_bridge.js` broadcasts SSE frames with event names (`event: automation-log`, `event: automation-progress`, `event: video-completed`, `event: account-updated`), but the parser in `lib/services/automation_bridge.dart` (`_listenToSse`) ignores the `event:` line and only reacts to payloads containing `message` or `account` keys. Engine progress and video-completed payloads contain neither, so real runs never update the Progress panel. Fix the parser to track the current event name and dispatch: `automation-log` → log callback, `account-updated` → account callback, `video-completed` → completion callback, `automation-progress` → progress callback.

4. **Completion matching is impossible.** The engine's video-completed payload is `{id, prompt, accountName, status, filePath, error, type, timestamp}` — there is **no `promptIndex` field**, but `generator_provider.dart` looks for one and defaults everything to the first prompt. Match by `promptIndex` if present, else by exact prompt text (`data['prompt']`), else by the first item still in a generating state. If `error` is set or `status` indicates a violation/failure, mark the item **failed** with that error — not completed.

5. **Account status and credits are fabricated in the UI.** In `automation_bridge.dart`, `getAccounts()` maps every account to `status: AccountStatus.ready` and substitutes **50** when credits are missing. The engine database reports the real status string (e.g. `"Need Login"`, `"Ready"`, `"Checking…"`, `"Fail — …"`) and real credits (possibly `null`). Map them honestly: status string → enum (contains "login" → loginRequired, "check" → checking, "fail"/"error" → error, otherwise ready), credits `null` → 0, `selected` → isChecked, keep the raw status as the reason text. Use the same mapping for SSE account updates.

6. **Browser-visibility wiring is inverted.** `engine_bridge.js` decides the WorkerPool background mode from a `show_browsers` setting. The engine's real setting is **`browser_background`** ('1' or unset = background ON, '0' = visible) — the same key the original Electron `main.js` reads via `engine/browserMode.js`. Note the WorkerPool option is *named* `headless` but means "background mode": headed Chrome parked off-screen with anti-throttling flags — never true headless (Google Flow breaks in headless Chrome). Make the bridge read `browser_background`, and make the Dart Settings "Show browsers" toggle save that key with the correct polarity (show = '0', hide = '1'). Add `browser_background` and `default_quality` to the key list returned by `GET /api/settings`.

7. **Packaging traps.**
   - The repo ships **no `node_modules`** and `package-lock.json` is an empty stub (and misnamed). Regenerate a real lockfile (`npm install --package-lock-only`) so `npm install` is reproducible.
   - `installer.iss` points shortcuts and the post-install Run entry at `FlowStudio Lite.exe`, but the Flutter Windows build produces **`flutter_flow.exe`** (`BINARY_NAME` in `windows/CMakeLists.txt`). Point the installer at the real file name.
   - `installer.iss` copies `node.exe` from a hard-coded `C:\Program Files\nodejs\` path on the build PC. Stage `node.exe` next to the script in a documented build step instead (`Copy-Item (Get-Command node).Source .\node.exe`).
   - `installer.iss` bundles the developer's `data\` folder — including a real account database — into every installer. Remove that. The engine creates a fresh database in `%APPDATA%\google-flow-studio-lite` on first run.

8. **Version hygiene.** Bump the version everywhere it appears to **2.22.0**: `pubspec.yaml`, `package.json`, `engine_bridge.js` (`/api/status`), the strip pill in `lib/widgets/top_strip.dart`, `AppSettings.currentVersion`, `installer.iss` (`MyAppVersion`, and make `OutputBaseFilename` use it).

## VERIFY BEFORE YOU SAY "DONE" — RUN ALL OF THESE

1. `flutter pub get` succeeds and `flutter analyze` reports **zero errors** (warnings you introduced must also be fixed).
2. `npm install` from a clean checkout (no node_modules), then `node engine_bridge.js` starts and `curl http://127.0.0.1:48190/api/status` returns `{"ok":true,"version":"2.22.0",...}`; `GET /api/accounts`, `/api/settings`, `/api/stats` all return `ok:true`.
3. Grep the whole `lib/` tree for the removed fake behaviours: no `Timer.periodic` driving generation, no hard-coded account, no "50 credits" fallback, no unconditional "latest version" message. The grep must come back clean.
4. `flutter build windows --release` succeeds and produces `flutter_flow.exe`; Inno Setup compiles `installer.iss` without missing-source errors.
5. Write a short `FIX-REPORT.md` listing each defect above, the file(s) you changed, and the evidence (command output) that it is fixed.

## DO NOT TOUCH

- The `engine/` folder's logic — it is byte-identical to the proven Electron v2.21 engine and it works. Your fixes are in the Flutter layer, `engine_bridge.js` wiring, and packaging only.
- Never commit or ship `node_modules/`, `build/`, `data/*.db`, `profiles/`, or `node.exe`.
- Keep the app UI text in English only.

If any verification step fails, fix the cause — do not weaken the test, and do not report success for anything you have not actually run.
