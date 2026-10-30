; Script generated for FlowStudio Lite Inno Setup Installer
#define MyAppName "FlowStudio Lite"
#define MyAppVersion "2.46.5"
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
; v2.43.0 (owner order 2026-10-29): the v2.42.0 "autostart" task is
; REMOVED again. The owner found the app opening itself at every
; sign-in put load on his PC and asked for the previous behaviour
; back: the app starts only when he opens it himself. The MCP server
; is unchanged - it answers while the app is open, as before v2.42.0.
; The Run value a v2.42.0 install may have written is deleted by the
; cleanup entry in [Run] below, so upgrading is enough - the owner
; does not have to remove anything by hand.

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
; v2.43.0: the v2.42.0 watchdog scripts are no longer shipped (the
; Scheduled Task a v2.42.0 install registered is removed by the
; cleanup entry in [Run] below, and copies already sitting in {app}
; are deleted by [InstallDelete]).
; v2.22.0 fix: NO pre-seeded database is shipped any more. The old script
; bundled the developer's own data\ folder — including a real account
; database — into every installer. The engine creates a fresh database
; in %APPDATA%\google-flow-studio-lite on first run instead.

[InstallDelete]
; v2.43.0 cleanup: remove the v2.42.0 watchdog scripts if an earlier
; install left them in the app folder. (Files not listed in [Files]
; are otherwise never removed by an upgrade.)
Type: files; Name: "{app}\watchdog.ps1"
Type: files; Name: "{app}\register-watchdog.ps1"

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\app_icon.ico"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\app_icon.ico"; Tasks: desktopicon; WorkingDir: "{app}"

[Run]
; v2.43.0 cleanup (owner reversal of v2.42.0): delete the two things a
; v2.42.0 install put on the PC - the HKCU Run value "FlowStudio"
; (start-with-Windows) and the Scheduled Task "FlowStudio Watchdog"
; (reopened the app every 5 minutes). Without this entry a plain
; revert would leave both behind and the app would keep opening
; itself. It deliberately has NO skipifsilent flag, so it also runs
; on /SILENT installs driven by the app's own updater. Best effort:
; SilentlyContinue covers PCs that never had either artifact, and a
; failure here can never fail the install.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'FlowStudio' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'FlowStudio Watchdog' -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden waituntilterminated
; Launch entry restored to the pre-v2.42.0 form (owner order
; 2026-10-29: previous behaviour back) - the wizard's "launch
; program" checkbox, interactive installs only; silent installs
; leave the app closed until the owner opens it himself.
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Legacy cleanup (kept in v2.43.0): remove the v2.42.0-era watchdog
; task on uninstall, in case an install skipped the [Run] cleanup
; above (SilentlyContinue inside the command: the task may not
; exist if registration was skipped/failed).
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""Unregister-ScheduledTask -TaskName 'FlowStudio Watchdog' -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden; RunOnceId: "DelFlowStudioWatchdogTask"
