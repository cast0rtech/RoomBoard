param(
    [ValidateSet('all', 'windows', 'android')]
    [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
Push-Location $appDir
try {
    if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) {
        $managedFlutterBin = Join-Path $env:USERPROFILE '.puro\envs\stable\flutter\bin'
        if (Test-Path (Join-Path $managedFlutterBin 'flutter.bat')) {
            $env:Path = "$managedFlutterBin;$env:Path"
        }
    }
    if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) {
        throw 'Flutter no está instalado o no está en PATH. Instala Flutter 3.x y vuelve a ejecutar este script.'
    }

    & (Join-Path $appDir 'prepare-platforms.ps1')

    if ($Target -in @('all', 'android')) {
        $windowsDir = Join-Path $appDir 'windows'
        $windowsHold = Join-Path $appDir '.windows-build-hold'
        if ((Test-Path $windowsDir) -and (Test-Path $windowsHold)) {
            throw "No se puede preparar Android porque existe el temporal $windowsHold"
        }
        $windowsMoved = $false
        if (Test-Path $windowsDir) {
            Move-Item -LiteralPath $windowsDir -Destination $windowsHold
            $windowsMoved = $true
        }
        try {
            flutter pub get
            if ($LASTEXITCODE -ne 0) { throw 'flutter pub get terminó con error.' }
            flutter build apk --release
            if ($LASTEXITCODE -ne 0) { throw 'Falló la compilación de Android APK.' }
        }
        finally {
            if ($windowsMoved -and (Test-Path $windowsHold)) {
                Move-Item -LiteralPath $windowsHold -Destination $windowsDir
            }
        }
    }

    if ($Target -in @('all', 'windows')) {
        flutter pub get
        if ($LASTEXITCODE -ne 0) { throw 'flutter pub get falló para Windows.' }
        flutter build windows --release
        if ($LASTEXITCODE -ne 0) { throw 'Falló la compilación de Windows.' }
        $releaseDir = Join-Path $appDir 'build\windows\x64\runner\Release'
        if (-not (Test-Path (Join-Path $releaseDir 'roomboard_app.exe'))) {
            throw "No se encontró el ejecutable de Windows en $releaseDir"
        }
        $iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
        $isccPath = if ($iscc) { $iscc.Source } else { $null }
        if (-not $isccPath) {
            $defaultIscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
            if (Test-Path $defaultIscc) { $isccPath = $defaultIscc }
        }
        if (-not $isccPath) {
            $userIscc = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
            if (Test-Path $userIscc) { $isccPath = $userIscc }
        }
        if (-not $isccPath) { throw 'Falta Inno Setup 6 (ISCC.exe). Instálalo para crear RoomBoard-Setup.exe.' }
        New-Item -ItemType Directory -Path (Join-Path $appDir 'build\installer') -Force | Out-Null
        & $isccPath (Join-Path $appDir 'installer\RoomBoard.iss')
        if ($LASTEXITCODE -ne 0) { throw 'Inno Setup no pudo crear el instalador.' }
    }

    Write-Host 'Compilación terminada.'
    if ($Target -in @('all', 'windows')) { Write-Host 'Windows: app/build/installer/RoomBoard-Setup-0.1.0-x64.exe' }
    if ($Target -in @('all', 'android')) { Write-Host 'Android: app/build/app/outputs/flutter-apk/app-release.apk' }
}
finally {
    Pop-Location
}
