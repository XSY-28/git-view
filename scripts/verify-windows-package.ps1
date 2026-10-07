$ErrorActionPreference = 'Stop'
$install = Join-Path $env:RUNNER_TEMP 'Git View 中文 安装'
if (Test-Path $install) { throw "Verification directory already exists: $install" }
$packages = @(Get-ChildItem 'dist/installers/*-setup.exe')
if ($packages.Count -ne 1) { throw 'Expected exactly one NSIS installer' }
try {
    $installer = Start-Process -FilePath $packages[0].FullName -ArgumentList "/S /D=$install" -PassThru -Wait
    if ($installer.ExitCode -ne 0) { throw "NSIS installer failed: $($installer.ExitCode)" }
    $app = Join-Path $install 'git-view-desktop.exe'
    if (-not (Test-Path $app)) { throw 'NSIS did not install the desktop executable' }
    node scripts/verify-installed.mjs --app $install --output dist/installers/windows-package-verification.json
    if ($LASTEXITCODE -ne 0) { throw 'Installed payload verification failed' }
    node scripts/verify-windows-ui.mjs $app
    if ($LASTEXITCODE -ne 0) { throw 'Installed native window verification failed' }
} finally {
    $uninstaller = Join-Path $install 'uninstall.exe'
    if (Test-Path $uninstaller) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "NSIS uninstall failed: $($process.ExitCode)" }
        # NSIS uninstall may hand off to a temporary process before returning.
        for ($i = 0; $i -lt 30 -and (Test-Path (Join-Path $install 'git-view-desktop.exe')); $i++) { Start-Sleep -Milliseconds 500 }
        if (Test-Path (Join-Path $install 'git-view-desktop.exe')) { throw 'Uninstall left the desktop executable installed' }
    }
    if (Test-Path $install) { Remove-Item $install -Recurse -Force }
}
$reportPath = 'dist/installers/windows-package-verification.json'
$report = Get-Content $reportPath -Raw | ConvertFrom-Json
$report.checks | Add-Member -NotePropertyName nsisInstalledAndUninstalled -NotePropertyValue $true
$report | ConvertTo-Json -Depth 20 | Set-Content $reportPath -Encoding utf8NoBOM
