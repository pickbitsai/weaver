# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
#Requires -Version 5.1
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$ToolFolder,
    [string]$BookFolder,
    [string]$Source,
    [string]$Title,
    [string]$Id,
    [switch]$Help,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'

function Stop-Setup([string]$Problem, [string]$Fix) {
    Write-Host ''
    Write-Host "Setup stopped: $Problem"
    Write-Host "What to do: $Fix"
    exit 1
}

function Show-Usage {
    Write-Host @'
Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File setup-book.ps1 -Source <package> -Id <book-id> -Title "<Book Title>" [-ToolFolder <folder>] [-BookFolder <folder>]

  -Source      Where to get Weaver: a .tgz file, a GitHub release address, or @pickbitsai/weaver.
               Can be left out when Weaver is already installed in the tool folder.
  -Id          A new book's id: lowercase letters, numbers and hyphens, like the-salt-road.
  -Title       A new book's title.
  -ToolFolder  Where Weaver is installed. Default: a folder called Weaver in your home folder.
  -BookFolder  The book's folder, inside the tool folder. Default: the tool folder plus the id.
               Give an existing book's folder to keep using that book.

Setup is safe to run again. It never deletes your work and never changes your AI's own settings.
'@
}

function Convert-NativeArgument([string]$Value) {
    $passing = Get-Variable PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue
    if ($PSVersionTable.PSVersion.Major -lt 7 -or $null -eq $passing -or $passing.Value -eq 'Legacy') {
        $Value = [regex]::Replace($Value, '(\\*)"', [System.Text.RegularExpressions.MatchEvaluator]{
            param($match)
            return $match.Groups[1].Value + $match.Groups[1].Value + '\"'
        })
        if ($Value -match '\s') {
            $Value = [regex]::Replace($Value, '(\\+)$', '$1$1')
        }
    }
    return $Value
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $escaped = @($Arguments | ForEach-Object { Convert-NativeArgument $_ })
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $FilePath @escaped | Out-Host
        return $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
}

function Get-NativeOutput([string]$FilePath, [string[]]$Arguments) {
    $escaped = @($Arguments | ForEach-Object { Convert-NativeArgument $_ })
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $FilePath @escaped
        $code = $LASTEXITCODE
        return @{ Code = $code; Text = ($output -join "`n").Trim() }
    } finally { $ErrorActionPreference = $savedPreference }
}

function Find-Application([string]$Name) {
    return Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-FullPath([string]$Value) {
    if ($Value -eq '~') { $Value = $script:SetupHome }
    elseif ($Value.StartsWith('~\') -or $Value.StartsWith('~/')) { $Value = Join-Path $script:SetupHome $Value.Substring(2) }
    $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PWD.ProviderPath, $Value))
    if ($full.Length -gt [System.IO.Path]::GetPathRoot($full).Length) { $full = $full.TrimEnd('\') }
    return $full
}

function Test-SamePath([string]$First, [string]$Second) {
    return [string]::Equals($First, $Second, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-Inside([string]$Parent, [string]$Child) {
    return $Child.StartsWith($Parent.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-SyncProvider([string]$Folder) {
    foreach ($segment in ($Folder -split '[\\/]')) {
        switch -Regex ($segment) {
            '^onedrive' { return 'OneDrive' }
            '^dropbox( \(.+\))?$' { return 'Dropbox' }
            '^(icloud drive|iclouddrive)$' { return 'iCloud Drive' }
            '^(google drive|googledrive|my drive)$' { return 'Google Drive' }
        }
    }
    foreach ($name in @('OneDrive', 'OneDriveConsumer', 'OneDriveCommercial')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) {
            $syncRoot = Get-FullPath $value
            if ((Test-SamePath $syncRoot $Folder) -or (Test-Inside $syncRoot $Folder)) { return 'OneDrive' }
        }
    }
    return $null
}

$savedEncoding = $null
try {
    try {
        $savedEncoding = [Console]::OutputEncoding
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    } catch { }
    if ($Help) { Show-Usage; exit 0 }
    if ($Rest.Count -gt 0) {
        Stop-Setup ('Setup does not understand "' + $Rest[0] + '".') 'Check the spelling. Run setup with -Help to see the options.'
    }
    $environment = [Environment]::GetEnvironmentVariables()
    foreach ($name in @('CLAUDECODE', 'CODEX_CI', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID')) {
        if ($environment.Contains($name)) {
            Stop-Setup 'Setup must be run by you in your own terminal, not by an AI.' 'Setup installs Weaver itself, and Weaver does not let the AI change its own tool. Open PowerShell yourself and run setup there.'
        }
    }
    if ($PSBoundParameters.ContainsKey('Id') -and -not ($Id -cmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$')) {
        Stop-Setup ('The book id "' + $Id + '" can only use lowercase letters, numbers and hyphens.') 'Use something like the-salt-road.'
    }
    if ($Id -match '^(con|prn|aux|nul|com[0-9]|lpt[0-9])$') {
        Stop-Setup ('The book id "' + $Id + '" is a name Windows keeps for its own use.') 'Choose another id, like the-salt-road.'
    }
    if ($PSBoundParameters.ContainsKey('Title') -and [string]::IsNullOrWhiteSpace($Title)) {
        Stop-Setup 'The book title is empty.' "Add -Title with your book's title."
    }
    Write-Host 'PickBits Weaver setup'
    Write-Host ''
    Write-Host 'Checking this computer...'
    $nodeFix = 'Install Node.js 22 or newer (choose the LTS version) from https://nodejs.org, then open a new PowerShell window and run setup again.'
    $node = Find-Application 'node'
    if (-not $node) { Stop-Setup 'Node.js is not installed on this computer.' $nodeFix }
    $nodeVersion = Get-NativeOutput $node.Source @('--version')
    if ($nodeVersion.Code -ne 0 -or -not ($nodeVersion.Text -match '^v?(\d+)\.\d+\.\d+') -or [int]$Matches[1] -lt 22) {
        Stop-Setup "Node.js 22 or newer is needed, but this computer has Node.js $($nodeVersion.Text)." $nodeFix
    }
    $npm = Find-Application 'npm'
    $npmFix = 'Reinstall Node.js 22 or newer from https://nodejs.org, then open a new PowerShell window and run setup again.'
    if (-not $npm) { Stop-Setup 'npm, which comes with Node.js, is missing or does not start.' $npmFix }
    $npmVersion = Get-NativeOutput $npm.Source @('--version')
    if ($npmVersion.Code -ne 0) { Stop-Setup 'npm, which comes with Node.js, is missing or does not start.' $npmFix }
    $git = Find-Application 'git'
    $gitFix = 'Install Git for Windows from https://git-scm.com/download/win (the default choices are fine), then open a new PowerShell window and run setup again.'
    if (-not $git) { Stop-Setup 'Git is not installed or does not start.' $gitFix }
    $gitVersion = Get-NativeOutput $git.Source @('--version')
    if ($gitVersion.Code -ne 0) { Stop-Setup 'Git is not installed or does not start.' $gitFix }
    Write-Host "Node.js $($nodeVersion.Text), npm $($npmVersion.Text), Git $($gitVersion.Text -replace '^git version\s+', ''): OK"
    $codex = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
    $claude = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($codex -and $claude) { Write-Host 'Found: Codex and Claude Code' }
    elseif ($codex) { Write-Host 'Found: Codex' }
    elseif ($claude) { Write-Host 'Found: Claude Code' }
    else {
        Write-Host 'Warning: neither Codex nor Claude Code was found on this computer.'
        Write-Host "Setup will continue, but you need at least one of them to work on your book. At the end, setup shows where to find the author's guide, which explains how to get them."
    }
    foreach ($item in @(@{ Label = 'tool'; Folder = $ToolFolder }, @{ Label = 'book'; Folder = $BookFolder })) {
        foreach ($segment in ($item.Folder -split '[\\/]')) {
            if ($segment -and $segment -ne '.' -and $segment -ne '..' -and ($segment -split '\.', 2)[0] -match '^(con|prn|aux|nul|com[0-9]|lpt[0-9])$') {
                Stop-Setup ('The ' + $item.Label + ' folder uses "' + $segment + '", a name Windows keeps for its own use: ' + $item.Folder) 'Choose a folder without that name.'
            }
        }
    }
    $script:SetupHome = $env:USERPROFILE
    if (-not $script:SetupHome) { $script:SetupHome = $HOME }
    $script:SetupHome = Get-FullPath $script:SetupHome
    $example = Join-Path $script:SetupHome 'Weaver'
    $newBookFix = 'For a new book, add -Id and -Title (for example -Id the-salt-road -Title "The Salt Road"). For a book that already exists, add -BookFolder with its folder.'
    if (-not $ToolFolder) { $ToolFolder = $example }
    $tool = Get-FullPath $ToolFolder
    if (-not $BookFolder) {
        if (-not $Id) { Stop-Setup 'Setup needs to know which book to use.' $newBookFix }
        $BookFolder = Join-Path $tool $Id
    }
    $book = Get-FullPath $BookFolder
    if ((Test-SamePath $tool $script:SetupHome) -or (Test-SamePath $tool ([System.IO.Path]::GetPathRoot($tool)))) {
        Stop-Setup "The tool folder cannot be your whole home folder or the top of a drive: $tool" "Choose a folder inside it, for example $example."
    }
    if (Test-SamePath $tool $book) {
        $exampleId = if ($Id) { $Id } else { 'my-book' }
        Stop-Setup 'The book needs its own folder inside the tool folder.' "For example: $(Join-Path $tool $exampleId)"
    }
    if (-not (Test-Inside $tool $book)) {
        Stop-Setup 'The book folder must be inside the tool folder.' "Weaver's safety checks look for Weaver in the folders above your book. Use a book folder inside $tool, or choose a tool folder that contains $book."
    }
    $safeExample = $example
    if ($safeExample -match '[&^]') { $safeExample = Join-Path ([System.IO.Path]::GetPathRoot($script:SetupHome)) 'Weaver' }
    foreach ($item in @(@{ Label = 'tool'; Folder = $tool }, @{ Label = 'book'; Folder = $book })) {
        if (($item.Folder -split '[\\/]') -contains 'node_modules') {
            $folderExample = if ($item.Label -eq 'book') { Join-Path $tool $(if ($Id) { $Id } else { 'my-book' }) } else { $example }
            Stop-Setup "The $($item.Label) folder is inside a node_modules folder: $($item.Folder)" "node_modules holds installed packages, and installing or updating Weaver replaces everything in it, so your book could be deleted. Choose a folder outside node_modules, for example $folderExample."
        }
        if ($item.Folder -match '[&^]') {
            Stop-Setup "The $($item.Label) folder's name has & or ^ in it, which Windows tools that Weaver uses can't handle: $($item.Folder)" "Choose a folder without & or ^ in its name, for example $safeExample."
        }
    }
    foreach ($item in @(@{ Label = 'tool'; Folder = $tool }, @{ Label = 'book'; Folder = $book })) {
        $provider = Get-SyncProvider $item.Folder
        if ($provider) {
            Stop-Setup "The $($item.Label) folder is inside ${provider}: $($item.Folder)" "$provider copies files while Weaver saves your book's history, and that can damage the history. Choose a normal folder on this computer, for example $example."
        }
    }
    foreach ($item in @(@{ Label = 'tool'; Folder = $tool }, @{ Label = 'book'; Folder = $book })) {
        if ((Test-Path -LiteralPath $item.Folder) -and -not (Test-Path -LiteralPath $item.Folder -PathType Container)) {
            Stop-Setup "The $($item.Label) folder is a file, not a folder: $($item.Folder)" 'Choose a folder.'
        }
    }
    $existing = Test-Path -LiteralPath (Join-Path $book 'project.json') -PathType Leaf
    if (-not $existing -and (Test-Path -LiteralPath $book) -and @(Get-ChildItem -LiteralPath $book -Force | Where-Object { $_.PSIsContainer -or $_.Name -notin @('.DS_Store', 'desktop.ini', 'Thumbs.db') }).Count -gt 0) {
        Stop-Setup "The book folder already has files in it, but it is not a Weaver book: $book" 'Choose a new or empty folder for the book. PickBits can bring in a finished manuscript after setup.'
    }
    if (-not $existing -and (-not $Id -or [string]::IsNullOrWhiteSpace($Title))) {
        Stop-Setup 'To create a new book, setup needs both an id and a title.' $newBookFix
    }
    if ($existing -and ($PSBoundParameters.ContainsKey('Title') -or ($PSBoundParameters.ContainsKey('Id') -and $PSBoundParameters.ContainsKey('BookFolder')))) {
        Write-Host 'Note: this folder already holds a book, so the id and title you gave are not used.'
    }
    $cli = Join-Path $tool 'node_modules\@pickbitsai\weaver\scripts\weaver.mjs'
    if ($Source) {
        $candidate = $null
        try { $candidate = Get-FullPath $Source } catch { }
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $Source = $candidate }
        elseif ($Source -match '\.(tgz|tar\.gz)$' -and $Source -notmatch '://' -and $Source -notmatch '^(github:|git\+)') {
            Stop-Setup "Can't find the Weaver package file: $Source" 'Check the file name and where you saved it, then run setup again. To keep the Weaver that is already installed, leave out -Source.'
        }
    } elseif (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        Stop-Setup 'Setup needs to know where to get Weaver.' 'Add -Source with the package PickBits gave you: a .tgz file, a GitHub release address, or @pickbitsai/weaver.'
    }
    Write-Host "Tool folder: $tool"
    Write-Host "Book folder: $book"
    [void][System.IO.Directory]::CreateDirectory($tool)
    $package = Join-Path $tool 'package.json'
    if (-not (Test-Path -LiteralPath $package)) {
        $text = "{`n  `"name`": `"weaver-tool`",`n  `"private`": true,`n  `"description`": `"PickBits Weaver for the books in this folder. Created by setup-book.`"`n}`n"
        [System.IO.File]::WriteAllText($package, $text, (New-Object System.Text.UTF8Encoding $false))
    }
    if (-not $Source) { Write-Host 'Keeping the Weaver already installed in the tool folder.' }
    else {
        $installedPackage = Join-Path $tool 'node_modules\@pickbitsai\weaver'
        $integrity = Join-Path $installedPackage 'scripts\integrity.mjs'
        if ((Test-Path -LiteralPath $integrity -PathType Leaf) -and -not ((Get-Item -LiteralPath $installedPackage -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            $savedPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                & $node.Source (Convert-NativeArgument $integrity) --check > $null 2>&1
                $integrityCode = $LASTEXITCODE
            } finally { $ErrorActionPreference = $savedPreference }
            if ($integrityCode -ne 0) {
                Write-Host "Weaver's own files in the tool folder were changed, so setup puts back the released files."
                Remove-Item -LiteralPath $installedPackage -Recurse -Force
            }
        }
        Write-Host "Installing Weaver from $Source ..."
        Push-Location -LiteralPath $tool
        try { $installCode = Invoke-Native $npm.Source @('install', '--save-exact', '--no-audit', '--no-fund', '--no-update-notifier', $Source) }
        finally { Pop-Location }
        if ($installCode -ne 0) {
            Stop-Setup "Weaver could not be installed from $Source." 'Check the internet connection and the package name or address, then run setup again. If it keeps failing, contact PickBits.'
        }
    }
    if ($existing -and -not (Test-Path -LiteralPath (Join-Path $book 'project.json') -PathType Leaf)) {
        Stop-Setup "The book's files disappeared from $book while Weaver was being installed." 'Contact PickBits before doing anything else. If you turned on backup, your book is safe on GitHub.'
    }
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        Stop-Setup 'Weaver was installed, but its files are not where setup expects them.' 'Contact PickBits.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $tool 'node_modules\@pickbitsai\weaver\scripts\setup-guide.mjs') -PathType Leaf)) {
        Stop-Setup "The Weaver in the tool folder is an older version that this setup script can't finish with." 'Run setup again with -Source and the newest Weaver package from PickBits.'
    }
    $version = Get-NativeOutput $node.Source @($cli, 'version')
    if ($version.Code -ne 0) { Stop-Setup 'Weaver could not report its version.' 'Run setup again. If it keeps happening, contact PickBits.' }
    Write-Host "Installed $($version.Text)."
    if (-not $existing) {
        foreach ($name in @('.DS_Store', 'desktop.ini', 'Thumbs.db')) {
            $metadata = Join-Path $book $name
            if (Test-Path -LiteralPath $metadata -PathType Leaf) { Remove-Item -LiteralPath $metadata -Force }
        }
        $initCode = Invoke-Native $node.Source @($cli, 'init', $book, '--id', $Id, '--title', $Title, '--empty')
        if ($initCode -ne 0) { Stop-Setup 'Weaver could not create the book.' 'Read the message above, then run setup again. If it keeps failing, contact PickBits.' }
        Write-Host ('Created your book "' + $Title + '" in ' + $book + '.')
    } else { Write-Host "Using the book that is already in $book." }
    Write-Host "Installing Weaver's safety checks for Claude Code and Codex..."
    $hooksCode = Invoke-Native $node.Source @($cli, 'hooks', 'install', '--host', 'both', '--root', $book)
    if ($hooksCode -ne 0) { Write-Host 'Weaver could not finish installing its safety checks. The check below explains why.' }
    Write-Host ''
    $guide = Join-Path $tool 'node_modules\@pickbitsai\weaver\scripts\setup-guide.mjs'
    $guideCode = Invoke-Native $node.Source @($guide, '--root', $book, '--tool', $tool)
    if ($hooksCode -ne 0) { exit 1 }
    exit $guideCode
} catch {
    Stop-Setup "something unexpected went wrong: $($_.Exception.Message)" 'Run setup again. If it keeps happening, contact PickBits and send them this message.'
} finally {
    if ($null -ne $savedEncoding) { try { [Console]::OutputEncoding = $savedEncoding } catch { } }
}
