# 在桌面创建「MoonBit IDE」快捷方式
#
# 用法（在项目根或任意位置）：
#   powershell -ExecutionPolicy Bypass -File deploy/create-desktop-shortcut.ps1
#
# 说明：快捷方式直接指向 electron.exe（GUI 程序），
#       所以双击**不会闪出黑色控制台窗口**。

$ErrorActionPreference = 'Stop'

# 定位项目根（本脚本在 <root>/deploy 下）
$root = Split-Path -Parent $PSScriptRoot
$desktopDir = Join-Path $root 'desktop'
$electron = Join-Path $desktopDir 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $electron)) {
    Write-Host "找不到 electron.exe：$electron" -ForegroundColor Red
    Write-Host "请先在 desktop 目录执行：npm install" -ForegroundColor Yellow
    exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'MoonBit IDE.lnk'

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $electron
# "." 表示用 WorkingDirectory 作为要加载的应用目录
$lnk.Arguments = '.'
$lnk.WorkingDirectory = $desktopDir
# 用 Electron 自带图标（无自定义图标资源时最省事且不丑）
$lnk.IconLocation = "$electron,0"
$lnk.Description = 'MoonBit 后端一站式开发平台（IDE）'
$lnk.Save()

# 顺手放一个到开始菜单，方便搜索启动
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'MoonBit IDE.lnk'
try {
    Copy-Item $lnkPath $startMenu -Force
    Write-Host "已创建开始菜单项：$startMenu" -ForegroundColor Green
} catch {
    Write-Host "开始菜单项创建失败（不影响桌面快捷方式）" -ForegroundColor Yellow
}


# ---------------------------------------------------------------- 项目文件夹入口
# 为什么不做「复制到桌面」：项目 2.2G（含 _build / node_modules），
# 且复制后会与原件脱节（改一处要同步两处）。快捷方式指向同一份代码。
$projLnk = Join-Path $desktop 'MoonBit 后端项目.lnk'
$plnk = $ws.CreateShortcut($projLnk)
$plnk.TargetPath = $root              # 目录 → 资源管理器打开
$plnk.Description = 'MoonBit 后端一站式开发平台 —— 项目源码（conduit 后端 / 平台库 / 部署脚本）'
$plnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,3"   # 文件夹图标
$plnk.Save()
Write-Host "已创建桌面项目入口：$projLnk" -ForegroundColor Green

Write-Host ""
Write-Host "已创建桌面快捷方式：$lnkPath" -ForegroundColor Green
Write-Host "目标：$electron" -ForegroundColor Gray
Write-Host "工作目录：$desktopDir" -ForegroundColor Gray

Write-Host ""
Write-Host "桌面现在有：" -ForegroundColor Cyan
Write-Host "  • MoonBit IDE      —— 双击启动 IDE，打开后到「后端」面板点「启动后端」" -ForegroundColor Gray
Write-Host "  • MoonBit 后端项目 —— 双击进入项目源码目录" -ForegroundColor Gray
