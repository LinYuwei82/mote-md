; ============================================================
;  Mote Windows 安装包（Inno Setup 6）
;
;  构建方式（先准备绿色版目录 dist\Mote-Windows）：
;    powershell -ExecutionPolicy Bypass -File packaging\build_installer.ps1
;
;  版本号由 build_installer.ps1 从 Mote.pro 的 VERSION 读取，再以 /DMyAppVersion 传入；
;  手工编译时必须自己传：ISCC.exe /DMyAppVersion=0.2.0 packaging\mote.iss
;
;  安装形态：按用户安装（LocalAppData），无需管理员；带卸载程序。
;  .md 关联：独立 ProgID Mote.md + 可选接管默认程序，卸载时只清理自己写入的项。
; ============================================================

#define MyAppName "Mote"
#define MyAppPublisher "Mote"
#define MyAppExeName "Mote.exe"
#define MyAppProgId "Mote.md"
#define MyAppUrl "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

; 文件里不写默认版本：漏传 /DMyAppVersion 时直接编译失败，
; 避免安装包悄悄带上与 Mote.pro 不一致的版本号
#ifndef MyAppVersion
  #error MyAppVersion 未定义：请用 ISCC /DMyAppVersion=x.y.z 编译（build_installer.ps1 会自动读取 Mote.pro 的 VERSION）
#endif

[Setup]
; 固定 AppId：升级安装会识别旧版本并原地覆盖
AppId={{7C3E7A2B-4F6D-4E2A-9B7C-1D5E8F3A6C21}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\Mote
DefaultGroupName={#MyAppName}
UninstallDisplayName={#MyAppName} {#MyAppVersion}
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupIconFile=..\resources\icons\app.ico
OutputDir=..\dist
OutputBaseFilename=Mote-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
AllowNoIcons=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UsePreviousAppDir=yes
; 安装前检测正在运行的 Mote（Restart Manager）并提示关闭
CloseApplications=yes
RestartApplications=no
; 改动注册表关联后通知资源管理器刷新 .md 的图标与右键菜单
; （安装阶段的刷新由本指令负责，卸载阶段的改动由 [Code] 里的 SHChangeNotify 补上）
ChangesAssociations=yes

[Languages]
; 本机 Inno Setup 未附带中文语言文件，向导界面使用内置英文；
; 任务说明与提示文案仍是中文。
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："
Name: "associatemd"; Description: "将 .md 文件关联到 Mote（接管当前默认程序）"; GroupDescription: "文件关联："

[Files]
; 直接使用绿色版目录，安装内容与 zip 完全一致
Source: "..\dist\Mote-Windows\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Registry]
; ---- 独立 ProgID：Mote.md ----
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}"; ValueType: string; ValueName: ""; ValueData: "Mote Markdown 文档"; Flags: uninsdeletekey; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}"; ValueType: string; ValueName: "FriendlyTypeName"; ValueData: "Mote Markdown 文档"; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}\shell\open"; ValueType: string; ValueName: ""; ValueData: "在 Mote 中打开"; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}\shell\open"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "{#MyAppName}"; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Tasks: associatemd

; ---- .md 默认程序（原默认值在 [Code] 里备份，卸载时按需还原）----
Root: HKCU; Subkey: "Software\Classes\.md"; ValueType: string; ValueName: ""; ValueData: "{#MyAppProgId}"; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\.md\OpenWithProgids"; ValueType: string; ValueName: "{#MyAppProgId}"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associatemd

; ---- 右键「用 Mote 打开」（不依赖默认程序，只在本扩展上增加菜单项）----
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.md\shell\Mote"; ValueType: string; ValueName: ""; ValueData: "用 Mote 打开"; Flags: uninsdeletekey; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.md\shell\Mote"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\{#MyAppExeName},0"; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.md\shell\Mote\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Tasks: associatemd

[Code]
const
  MdClassesKey = 'Software\Classes\.md';
  BackupKey = 'Software\Mote\Installer';
  // Windows 10/11 的「默认打开方式」缓存；存在时会优先于 Software\Classes
  FileExtsKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md';
  UserChoiceLatestKey = FileExtsKey + '\UserChoiceLatest';
  UserChoiceLatestProgIdKey = UserChoiceLatestKey + '\ProgId';
  UserChoiceKey = FileExtsKey + '\UserChoice';
  // SHChangeNotify 的事件/标志：关联变化 + 传 PIDL
  SHCNE_ASSOCCHANGED = $08000000;
  SHCNF_IDLIST = $0000;

// 卸载时我们自己改的是注册表，ChangesAssociations 只覆盖安装阶段，
// 这里显式通知一次，让 .md 图标与右键菜单立刻恢复。
procedure SHChangeNotify(wEventId: Integer; uFlags: Cardinal; dwItem1, dwItem2: Cardinal);
  external 'SHChangeNotify@shell32.dll stdcall';

var
  BackupDone: Boolean;

function IsSilentMode(): Boolean;
var
  Tail: String;
begin
  Tail := ' ' + Uppercase(GetCmdTail) + ' ';
  Result := (Pos(' /SILENT ', Tail) > 0) or (Pos(' /VERYSILENT ', Tail) > 0);
end;

function IsWebView2Installed(): Boolean;
var
  Version: String;
  RuntimeId: String;
begin
  RuntimeId := '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + RuntimeId, 'pv', Version) and (Version <> ''))
    or (RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + RuntimeId, 'pv', Version) and (Version <> ''))
    or (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + RuntimeId, 'pv', Version) and (Version <> ''));
end;

procedure BackupMdAssociation();
var
  Current: String;
  Hash: AnsiString;
  Had: Cardinal;
  HadUL: Cardinal;
  HadUC: Cardinal;
begin
  if BackupDone then
    Exit;
  BackupDone := True;

  // ---- Software\Classes\.md 的默认 ProgID ----
  // 升级安装时已经指向本程序：保留首次安装记录的原值
  if RegQueryStringValue(HKCU, MdClassesKey, '', Current) and (Current = '{#MyAppProgId}') then
  begin
    if not RegQueryDWordValue(HKCU, BackupKey, 'HadMdClass', Had) then
      RegWriteDWordValue(HKCU, BackupKey, 'HadMdClass', 0);
  end
  else
  begin
    Had := 0;
    if Current <> '' then
    begin
      Had := 1;
      RegWriteStringValue(HKCU, BackupKey, 'MdClass', Current);
    end;
    RegWriteDWordValue(HKCU, BackupKey, 'HadMdClass', Had);
  end;

  // ---- FileExts\.md\UserChoiceLatest\ProgId（Win11 的默认程序缓存）----
  // 该值存在时会优先于 Software\Classes，必须一并改写。
  if RegQueryStringValue(HKCU, UserChoiceLatestProgIdKey, '', Current) and (Current = '{#MyAppProgId}') then
  begin
    if not RegQueryDWordValue(HKCU, BackupKey, 'HadUserChoiceLatest', HadUL) then
      RegWriteDWordValue(HKCU, BackupKey, 'HadUserChoiceLatest', 0);
  end
  else
  begin
    HadUL := 0;
    if Current <> '' then
    begin
      HadUL := 1;
      RegWriteStringValue(HKCU, BackupKey, 'UserChoiceLatestProgId', Current);
    end;
    RegWriteDWordValue(HKCU, BackupKey, 'HadUserChoiceLatest', HadUL);
    RegWriteStringValue(HKCU, UserChoiceLatestProgIdKey, '', '{#MyAppProgId}');
  end;

  // ---- FileExts\.md\UserChoice（Win10 带 Hash 的默认程序）----
  // 只有删掉这个键，Software\Classes\.md 才会重新成为默认；先备份 ProgID 与 Hash。
  if RegQueryStringValue(HKCU, UserChoiceKey, 'ProgId', Current) then
  begin
    if Current = '{#MyAppProgId}' then
    begin
      if not RegQueryDWordValue(HKCU, BackupKey, 'HadUserChoice', HadUC) then
        RegWriteDWordValue(HKCU, BackupKey, 'HadUserChoice', 0);
    end
    else
    begin
      RegWriteStringValue(HKCU, BackupKey, 'UserChoiceProgId', Current);
      if RegQueryBinaryValue(HKCU, UserChoiceKey, 'Hash', Hash) then
        RegWriteBinaryValue(HKCU, BackupKey, 'UserChoiceHash', Hash);
      RegWriteDWordValue(HKCU, BackupKey, 'HadUserChoice', 1);
      RegDeleteKeyIncludingSubkeys(HKCU, UserChoiceKey);
    end;
  end
  else
  begin
    if not RegQueryDWordValue(HKCU, BackupKey, 'HadUserChoice', HadUC) then
      RegWriteDWordValue(HKCU, BackupKey, 'HadUserChoice', 0);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssInstall) and WizardIsTaskSelected('associatemd') then
    BackupMdAssociation();
  // 关联写完后通知资源管理器，让 .md 图标与右键菜单立即生效
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('associatemd') then
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, 0, 0);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Current: String;
  Previous: String;
  Hash: AnsiString;
  Had: Cardinal;
begin
  if CurUninstallStep = usUninstall then
  begin
    // ---- FileExts\.md\UserChoiceLatest\ProgId ----
    // 只在自己仍是当前值时才处理；用户后来手动换过默认程序就不动
    if RegQueryStringValue(HKCU, UserChoiceLatestProgIdKey, '', Current) and (Current = '{#MyAppProgId}') then
    begin
      if RegQueryDWordValue(HKCU, BackupKey, 'HadUserChoiceLatest', Had) and (Had <> 0)
         and RegQueryStringValue(HKCU, BackupKey, 'UserChoiceLatestProgId', Previous) then
        RegWriteStringValue(HKCU, UserChoiceLatestProgIdKey, '', Previous)
      else
      begin
        RegDeleteValue(HKCU, UserChoiceLatestProgIdKey, '');
        RegDeleteKeyIfEmpty(HKCU, UserChoiceLatestProgIdKey);
        RegDeleteKeyIfEmpty(HKCU, UserChoiceLatestKey);
      end;
    end;

    // ---- FileExts\.md\UserChoice ----
    // 与上面一致：只有当前值仍指向本程序时才处理；用户后来换过默认程序就不碰。
    // 写回 ProgID 失败时不写 Hash，避免留下 ProgID 与 Hash 不匹配的坏键。
    if RegQueryStringValue(HKCU, UserChoiceKey, 'ProgId', Current) and (Current = '{#MyAppProgId}') then
    begin
      if RegQueryDWordValue(HKCU, BackupKey, 'HadUserChoice', Had) and (Had <> 0)
         and RegQueryStringValue(HKCU, BackupKey, 'UserChoiceProgId', Previous) then
      begin
        if RegWriteStringValue(HKCU, UserChoiceKey, 'ProgId', Previous) then
        begin
          if RegQueryBinaryValue(HKCU, BackupKey, 'UserChoiceHash', Hash) then
            RegWriteBinaryValue(HKCU, UserChoiceKey, 'Hash', Hash);
        end;
      end
      else
      begin
        RegDeleteValue(HKCU, UserChoiceKey, 'ProgId');
        RegDeleteKeyIfEmpty(HKCU, UserChoiceKey);
      end;
    end;

    // ---- Software\Classes\.md 默认值 ----
    // 优先还原到安装前的值；若原本没有默认值则删除本程序写入的值
    if RegQueryStringValue(HKCU, MdClassesKey, '', Current) and (Current = '{#MyAppProgId}') then
    begin
      if RegQueryDWordValue(HKCU, BackupKey, 'HadMdClass', Had) and (Had <> 0)
         and RegQueryStringValue(HKCU, BackupKey, 'MdClass', Previous) then
        RegWriteStringValue(HKCU, MdClassesKey, '', Previous)
      else
        RegDeleteValue(HKCU, MdClassesKey, '');
    end;

    RegDeleteKeyIncludingSubkeys(HKCU, BackupKey);
    RegDeleteKeyIfEmpty(HKCU, 'Software\Mote');
    // 关联已还原，通知资源管理器刷新图标与右键菜单
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, 0, 0);
  end;
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if not IsSilentMode() and not IsWebView2Installed() then
  begin
    if MsgBox('未检测到 Microsoft Edge WebView2 Runtime。' + #13#10 + #13#10 +
              'Mote 的编辑界面依赖该系统组件，缺少时只能显示提示页。' + #13#10 +
              '是否现在打开 Evergreen 下载页面？安装完成后重新运行本安装程序即可。',
              mbConfirmation, MB_YESNO) = IDYES then
      if not ShellExec('open', '{#MyAppUrl}', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode) then
        MsgBox('无法自动打开浏览器。请手动访问：' + #13#10 + '{#MyAppUrl}',
               mbInformation, MB_OK);
  end;
end;
