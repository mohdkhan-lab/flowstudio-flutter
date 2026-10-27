; Script generated for FlowStudio Lite Inno Setup Installer
#define MyAppName "FlowStudio Lite"
#define MyAppVersion "2.42.0"
#define MyAppPublisher "MK"
; v2.22.0 fix: the Flutter Windows build produces "flutter_flow.exe"
; (BINARY_NAME in windows/CMakeLists.txt). The old script pointed the
; shortcuts and the post-install Run entry at "FlowStudio Lite.exe",
; a file that does not exist unless someone renamed it by hand — so a
; fresh install could not be launched from its own shortcuts.
#define MyAppExeName "flutter_flow.exe"
#define MyAppIcon "assets\app_icon.ico"

[Setup]
AppId={{9F7B12C8-356A-4A73-B28E-692B8851410D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=FlowStudio_Lite_v{#MyAppVersion}_Setup
SetupIconFile={#MyAppIcon}
Compression=lzma/fast
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
; v2.42.0 resilience: start-with-Windows is default ON (no "unchecked"
; flag) so the app - and with it MK's only remote route - comes back on
; its own after every reboot/sign-in. The user can untick it here.
Name: "autostart"; Description: "Start {#MyAppName} when I sign in to Windows"; GroupDescription: "Startup:"

[Files]
; Flutter Release Binaries & Assets
Source: "build\windows\x64\runner\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Node Automation Engine
Source: "engine\*"; DestDir: "{app}\engine"; Flags: ignoreversion recursesubdirs createallsubdirs
; Engine Node Modules (Excluding bulky devDependencies like electron & electron-builder)
Source: "node_modules\*"; DestDir: "{app}\node_modules"; Excludes: "*electron*,*app-builder-bin*,*dmg-builder*,*7zip-bin*"; Flags: ignoreversion recursesubdirs createallsubdirs
; Assets & Icons
Source: "assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs
; Root Engine Bridge & Config
Source: "engine_bridge.js"; DestDir: "{app}"; Flags: ignoreversion
; v2.31.0: the MCP server module the bridge requires at startup.
Source: "mcp_server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "package.json"; DestDir: "{app}"; Flags: ignoreversion
; Embedded Node Runtime (self-contained, no external dependencies required)
; v2.22.0 fix: node.exe is staged NEXT TO this script before compiling
; (build step: Copy-Item (Get-Command node).Source .\node.exe). The old
; script copied it from a hard-coded "C:\Program Files\nodejs" path on
; the build PC, which silently breaks the installer build on any PC
; whose Node lives somewhere else.
Source: "node.exe"; DestDir: "{app}"; Flags: ignoreversion
; v2.42.0 resilience: self-healing scripts (app relaunch watchdog +
; its one-time Scheduled Task registration), run from the app folder.
Source: "tools\watchdog.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "tools\register-watchdog.ps1"; DestDir: "{app}"; Flags: ignoreversion
; v2.22.0 fix: NO pre-seeded database is shipped any more. The old script
; bundled the developer's own data\ folder — including a real account
; database — into every installer. The engine creates a fresh database
; in %APPDATA%\google-flow-studio-lite on first run instead.

[Registry]
; v2.42.0 resilience (start with Windows): HKCU Run entry, only when
; the "autostart" task above is ticked. uninsdeletevalue removes it on
; uninstall, so no orphan autostart survives a removal.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "FlowStudio"; ValueData: """{app}\{#MyAppExeName}"""; Tasks: autostart; Flags: uninsdeletevalue

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\app_icon.ico"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\app_icon.ico"; Tasks: desktopicon; WorkingDir: "{app}"

[Run]
; v2.42.0 resilience (self-relaunch after install): the launch entry
; deliberately drops "postinstall" and "skipifsilent". The old entry
; only ran for interactive wizard installs, so a /SILENT install
; launched by the app's own updater (settings_provider's PowerShell
; waiter runs Setup /SILENT -Wait and then exits) left the app closed
; for good - killing MK's only route until someone reopened it by
; hand. Without those two flags this entry runs at the end of EVERY
; install, silent or not, exactly once (it replaces the wizard's
; "launch program" checkbox, which was this same entry - there is no
; second launch path). runasoriginaluser is a safeguard in case the
; installer is ever elevated; today PrivilegesRequired=lowest means
; setup already runs as the installing user.
Filename: "{app}\{#MyAppExeName}"; Flags: nowait runasoriginaluser
; v2.42.0 resilience (watchdog registration): registers the per-user
; Scheduled Task "FlowStudio Watchdog" (see register-watchdog.ps1).
; Best effort by design: the script swallows every error and exits 0,
; so a registration failure can never fail the install.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\register-watchdog.ps1"""; Flags: runhidden waituntilterminated

[UninstallRun]
; Remove the watchdog task on uninstall (SilentlyContinue inside the
; command: the task may not exist if registration was skipped/failed).
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""Unregister-ScheduledTask -TaskName 'FlowStudio Watchdog' -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden; RunOnceId: "DelFlowStudioWatchdogTask"
