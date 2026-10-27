; Script generated for FlowStudio Lite Inno Setup Installer
#define MyAppName "FlowStudio Lite"
#define MyAppVersion "2.35.0"
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
; v2.22.0 fix: NO pre-seeded database is shipped any more. The old script
; bundled the developer's own data\ folder — including a real account
; database — into every installer. The engine creates a fresh database
; in %APPDATA%\google-flow-studio-lite on first run instead.

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\app_icon.ico"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\app_icon.ico"; Tasks: desktopicon; WorkingDir: "{app}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
