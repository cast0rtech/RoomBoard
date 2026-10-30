#define AppName "RoomBoard"
#define AppVersion "0.1.0"
#define AppPublisher "RoomBoard"
#define AppExeName "roomboard_app.exe"

[Setup]
AppId={{C824CF37-D20A-4C25-A081-6DD8C2789B07}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\RoomBoard
DefaultGroupName=RoomBoard
DisableProgramGroupPage=yes
OutputDir=..\build\installer
OutputBaseFilename=RoomBoard-Setup-{#AppVersion}-x64
ArchitecturesInstallIn64BitMode=x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
UninstallDisplayIcon={app}\{#AppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "..\build\windows\x64\runner\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\RoomBoard"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\RoomBoard"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch RoomBoard"; Flags: postinstall nowait skipifsilent
