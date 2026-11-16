# Dot-source before running npm run android from a Windows PowerShell terminal:
# . ./scripts/android-env.ps1
$toolchainRoot = Join-Path $PSScriptRoot '../../.android-tools'
$localJdk = Get-ChildItem (Join-Path $toolchainRoot 'java') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'bin/java.exe') } |
    Select-Object -First 1
if ($localJdk) { $env:JAVA_HOME = $localJdk.FullName }
if (Test-Path (Join-Path $toolchainRoot 'sdk/platform-tools/adb.exe')) {
    $env:ANDROID_HOME = (Resolve-Path (Join-Path $toolchainRoot 'sdk')).Path
}
if (-not $env:JAVA_HOME -or -not (Test-Path "$env:JAVA_HOME/bin/java.exe")) {
    throw 'Install JDK 17 and set JAVA_HOME to its directory.'
}
if (-not $env:ANDROID_HOME -or -not (Test-Path "$env:ANDROID_HOME/platform-tools/adb.exe")) {
    throw 'Install the Android SDK and set ANDROID_HOME to its directory.'
}
$env:Path = "$env:JAVA_HOME/bin;$env:ANDROID_HOME/platform-tools;$env:ANDROID_HOME/emulator;$env:ANDROID_HOME/cmdline-tools/latest/bin;$env:Path"
Write-Host "JAVA_HOME=$env:JAVA_HOME"
Write-Host "ANDROID_HOME=$env:ANDROID_HOME"
