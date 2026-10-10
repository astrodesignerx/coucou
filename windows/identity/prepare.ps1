param([string]$SdkBin)
$ErrorActionPreference = 'Stop'
# Project-local preparation only. No signing, registration or certificate changes.
if (-not $SdkBin) {
    $sdkBase = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
    $SdkBin = Get-ChildItem -LiteralPath $sdkBase -Directory |
        Where-Object { $_.Name -match '^10\.0\.\d+\.0$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64' } |
        Where-Object { Test-Path -LiteralPath (Join-Path $_ 'makeappx.exe') } |
        Select-Object -First 1
}
if (-not $SdkBin) { throw 'Install the Windows SDK with MakeAppx before preparing identity.' }
$output = Join-Path $PSScriptRoot '../../.scratch/identity'
$stage = Join-Path $output 'stage'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Choom.Identity.appxmanifest') -Destination (Join-Path $stage 'AppxManifest.xml')
$package = Join-Path $output 'Choom.Identity.msix'
& (Join-Path $SdkBin 'makeappx.exe') pack /o /d $stage /nv /p $package
if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed with exit code $LASTEXITCODE" }
Get-FileHash -LiteralPath $package -Algorithm SHA256 | Format-List
Write-Output 'Prepared unsigned identity package. Windows setup remains a separate approval step.'
