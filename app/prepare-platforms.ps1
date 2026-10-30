$ErrorActionPreference = 'Stop'
$appDir = (Resolve-Path $PSScriptRoot).Path
$androidDir = Join-Path $appDir 'android'
$windowsDir = Join-Path $appDir 'windows'
$backupDir = Join-Path $appDir '.platform-scaffold-backup'

if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) {
    $managedFlutterBin = Join-Path $env:USERPROFILE '.puro\envs\stable\flutter\bin'
    if (Test-Path (Join-Path $managedFlutterBin 'flutter.bat')) {
        $env:Path = "$managedFlutterBin;$env:Path"
    }
}
if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) {
    throw 'Flutter no está instalado o no está en PATH.'
}

# Los directorios nativos entregados con este proyecto solo contienen archivos
# parciales. Si ya hay un scaffold Flutter completo, no se modifica.
if ((Test-Path (Join-Path $androidDir 'gradlew.bat')) -and
    (Test-Path (Join-Path $windowsDir 'runner\CMakeLists.txt'))) {
    Write-Host 'Los proyectos nativos de Android y Windows ya están completos.'
    return
}
if (Test-Path $backupDir) {
    throw "Existe $backupDir. Revisa la copia previa antes de volver a preparar los proyectos nativos."
}

New-Item -ItemType Directory -Path $backupDir | Out-Null
Copy-Item -LiteralPath (Join-Path $appDir 'pubspec.yaml') -Destination (Join-Path $backupDir 'pubspec.yaml')
Copy-Item -LiteralPath (Join-Path $appDir 'lib') -Destination (Join-Path $backupDir 'lib') -Recurse
Copy-Item -LiteralPath (Join-Path $androidDir 'app\build.gradle') -Destination (Join-Path $backupDir 'android-app-build.gradle')
Move-Item -LiteralPath $androidDir -Destination (Join-Path $backupDir 'android-original')
Move-Item -LiteralPath $windowsDir -Destination (Join-Path $backupDir 'windows-original')

try {
    & flutter create --platforms=android,windows --project-name=app --org=com.roomboard --no-pub $appDir
    if ($LASTEXITCODE -ne 0) { throw 'flutter create no pudo generar los proyectos nativos.' }

    Copy-Item -LiteralPath (Join-Path $backupDir 'pubspec.yaml') -Destination (Join-Path $appDir 'pubspec.yaml') -Force
    Copy-Item -LiteralPath (Join-Path $backupDir 'lib') -Destination $appDir -Recurse -Force

    $oldManifest = Join-Path $backupDir 'android-original\app\src\main\AndroidManifest.xml'
    $newManifest = Join-Path $androidDir 'app\src\main\AndroidManifest.xml'
    Copy-Item -LiteralPath $oldManifest -Destination $newManifest -Force
    $oldNetworkConfig = Join-Path $backupDir 'android-original\app\src\main\res\xml\network_security_config.xml'
    if (Test-Path $oldNetworkConfig) {
        $newXmlDir = Join-Path $androidDir 'app\src\main\res\xml'
        New-Item -ItemType Directory -Path $newXmlDir -Force | Out-Null
        Copy-Item -LiteralPath $oldNetworkConfig -Destination (Join-Path $newXmlDir 'network_security_config.xml') -Force
    }
    $androidGradleKts = Join-Path $androidDir 'app\build.gradle.kts'
    if (Test-Path $androidGradleKts) {
        $gradleContent = Get-Content -Raw $androidGradleKts
        $gradleContent = $gradleContent.Replace('compileSdk = flutter.compileSdkVersion', 'compileSdk = 36')
        $gradleContent = $gradleContent.Replace('minSdk = flutter.minSdkVersion', 'minSdk = 21')
        $gradleContent = $gradleContent.Replace('targetSdk = flutter.targetSdkVersion', 'targetSdk = 36')
        Set-Content -LiteralPath $androidGradleKts -Value $gradleContent
    }
    $windowsCmake = Join-Path $windowsDir 'CMakeLists.txt'
    $cmakeContent = Get-Content -Raw $windowsCmake
    $cmakeContent = $cmakeContent -replace 'set\(BINARY_NAME\s+"app"\)', 'set(BINARY_NAME "roomboard_app")'
    Set-Content -LiteralPath $windowsCmake -Value $cmakeContent
    Write-Host 'Se generaron los scaffolds nativos. Los archivos originales están en .platform-scaffold-backup.'
}
catch {
    Write-Error $_
    throw 'Preparación incompleta. Los archivos nativos originales se conservan en .platform-scaffold-backup para restaurarlos o revisar el error.'
}
