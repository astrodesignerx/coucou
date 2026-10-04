# update-coucou.ps1
# Pulls the latest Coucou from the original repo (upstream), tries it on top of
# your tweaks in a throwaway test branch, builds it, and lets you keep or
# discard the result. Your working build on my-tweaks is never touched unless
# you choose "keep".
#
# Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File C:\Users\ether\Documents\Coucou\update-coucou.ps1
# Add -Force to rebuild even when there is nothing new upstream.

param([switch]$Force)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
$lockfile = "windows/package-lock.json"
$goodDir = Join-Path $repo "good-builds"
$installer = Join-Path $repo "windows\release\Coucou-Windows-setup.exe"
Set-Location $repo

function Say($msg, $color = "Cyan") { Write-Host ""; Write-Host $msg -ForegroundColor $color }
function Fail($msg) { Write-Host ""; Write-Host $msg -ForegroundColor Red; exit 1 }
function Git { & git @args; if ($LASTEXITCODE -ne 0) { Fail "git $args failed." } }

# npm rewrites the lockfile's version number on every install. Throw that away
# so it never blocks a branch switch.
function Reset-Lockfile { & git checkout -- $lockfile 2>$null }

# Go back to my-tweaks and delete the test branch, leaving everything as it was.
function Undo-Test($branch) {
    Reset-Lockfile
    & git checkout my-tweaks | Out-Null
    & git branch -D $branch | Out-Null
}

# 1. Safety checks.
Reset-Lockfile
$current = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($current -ne "my-tweaks") { Fail "You are on '$current'. Switch to my-tweaks first: git checkout my-tweaks" }
if (& git status --porcelain) { Fail "You have unsaved (uncommitted) changes. Commit them on my-tweaks first, then run this again." }

# 2. Fetch upstream and move main forward. main only ever mirrors upstream, so
#    this is always a fast-forward. If it is not, someone edited main by hand.
Say "Checking the original repo for updates..."
Git fetch upstream --tags
& git fetch upstream main:main
if ($LASTEXITCODE -ne 0) { Fail "main has changes that are not in upstream. main must stay a clean copy; ask for help before continuing." }

$new = & git log --oneline my-tweaks..main
if (-not $new -and -not $Force) { Say "Already up to date. Nothing new upstream." "Green"; exit 0 }
if ($new) {
    Say "New upstream changes:"
    $new | ForEach-Object { Write-Host "  $_" }
}

# 3. Try the update on a throwaway test branch.
$test = "test-" + (Get-Date -Format "yyyyMMdd-HHmm")
Say "Merging them into test branch '$test'..."
Git checkout -b $test my-tweaks
& git merge main --no-edit
if ($LASTEXITCODE -ne 0) {
    $conflicts = & git diff --name-only --diff-filter=U
    & git merge --abort
    Undo-Test $test
    Write-Host ""
    Write-Host "Your tweaks clash with the update in these files:" -ForegroundColor Red
    $conflicts | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Fail "Nothing was changed. Ask Claude to help resolve the clash."
}

# 4. Build it.
Say "Building (this takes a few minutes)..."
Push-Location (Join-Path $repo "windows")
& npm install
$ok = ($LASTEXITCODE -eq 0)
if ($ok) { & npm run pack; $ok = ($LASTEXITCODE -eq 0) }
Pop-Location
if (-not $ok) {
    Undo-Test $test
    Fail "The build failed, so the update was thrown away. Your my-tweaks branch is unchanged."
}

# 5. You try it, then decide.
Say "Build done. Install and try it:" "Green"
Write-Host "  $installer"
Write-Host "  (Windows may warn that the installer is unsigned: More info > Run anyway.)"
do { $answer = (Read-Host "`nKeep this update? [k]eep / [d]iscard").Trim().ToLower() } until ($answer -in "k", "d")

if ($answer -eq "d") {
    Undo-Test $test
    Say "Discarded. my-tweaks is unchanged." "Yellow"
    $last = Get-ChildItem $goodDir -Filter *.exe -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
    if ($last) { Write-Host "  If you installed the new build, reinstall your last good one: $($last.FullName)" }
    exit 0
}

# 6. Keep: move my-tweaks forward, tag it, save the installer, push to your fork.
Reset-Lockfile
Git checkout my-tweaks
Git merge --ff-only $test
Git branch -d $test
$tag = "good-" + (Get-Date -Format "yyyy-MM-dd")
if (& git tag --list $tag) { $tag = "good-" + (Get-Date -Format "yyyy-MM-dd-HHmm") }
Git tag $tag
New-Item -ItemType Directory -Force $goodDir | Out-Null
Copy-Item $installer (Join-Path $goodDir "$tag-setup.exe")
Git push origin main my-tweaks $tag
Say "Kept. Tagged '$tag', installer saved in good-builds\, pushed to your fork." "Green"
