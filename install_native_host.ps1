[CmdletBinding()]
param(
  [string[]]$ChromeExtensionId = @(),
  [string[]]$EdgeExtensionId = @(),
  [ValidateSet('Chrome', 'Edge', 'Both')]
  [string]$Browser = 'Both',
  [switch]$SkipAutoDetect
)

$ErrorActionPreference = 'Stop'

$HostName = 'com.aipromptqueue.transcription'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LauncherPath = Join-Path $ScriptDir 'run_host.bat'
$ManifestPath = Join-Path $ScriptDir 'native_host.json'

function Test-ExtensionId {
  param([string]$Id)
  return $Id -match '^[a-p]{32}$'
}

function Add-Unique {
  param(
    [string[]]$Existing,
    [string[]]$Next
  )
  $set = [ordered]@{}
  foreach ($item in @($Existing + $Next)) {
    if ($item -and -not $set.Contains($item)) {
      $set[$item] = $true
    }
  }
  return @($set.Keys)
}

function Get-ProfileExtensionIds {
  param(
    [string]$BrowserName,
    [string]$UserDataRoot,
    [string]$ExtensionPath
  )

  if (-not (Test-Path -LiteralPath $UserDataRoot)) {
    return @()
  }

  $ids = @()
  $resolvedExtensionPath = (Resolve-Path -LiteralPath $ExtensionPath).Path
  Get-ChildItem -LiteralPath $UserDataRoot -Directory | ForEach-Object {
    $prefsPath = Join-Path $_.FullName 'Preferences'
    if (-not (Test-Path -LiteralPath $prefsPath)) {
      return
    }
    try {
      $prefs = Get-Content -Raw -LiteralPath $prefsPath | ConvertFrom-Json
      $settings = $prefs.extensions.settings
      if (-not $settings) {
        return
      }
      foreach ($prop in $settings.PSObject.Properties) {
        $path = $prop.Value.path
        if (-not $path) {
          continue
        }
        $resolvedPath = (Resolve-Path -LiteralPath $path -ErrorAction SilentlyContinue).Path
        if ($resolvedPath -eq $resolvedExtensionPath -and (Test-ExtensionId $prop.Name)) {
          Write-Host "Detected $BrowserName extension id $($prop.Name) in profile $($_.Name)"
          $ids += $prop.Name
        }
      }
    } catch {
      Write-Verbose "Skipped unreadable $BrowserName profile $($_.Name): $($_.Exception.Message)"
    }
  }
  return @($ids | Select-Object -Unique)
}

if (-not (Test-Path -LiteralPath $LauncherPath)) {
  throw "Missing launcher: $LauncherPath"
}

if (-not $SkipAutoDetect) {
  if ($Browser -in @('Chrome', 'Both')) {
    $detectedChrome = Get-ProfileExtensionIds `
      -BrowserName 'Chrome' `
      -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data') `
      -ExtensionPath $ScriptDir
    $ChromeExtensionId = Add-Unique $ChromeExtensionId $detectedChrome
  }
  if ($Browser -in @('Edge', 'Both')) {
    $detectedEdge = Get-ProfileExtensionIds `
      -BrowserName 'Edge' `
      -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data') `
      -ExtensionPath $ScriptDir
    $EdgeExtensionId = Add-Unique $EdgeExtensionId $detectedEdge
  }
}

$allIds = Add-Unique $ChromeExtensionId $EdgeExtensionId
$badIds = @($allIds | Where-Object { -not (Test-ExtensionId $_) })
if ($badIds.Count -gt 0) {
  throw "Invalid extension id(s): $($badIds -join ', ')"
}
if ($allIds.Count -eq 0) {
  throw "No extension IDs provided or auto-detected. Pass -ChromeExtensionId <id> or -EdgeExtensionId <id> from chrome://extensions or edge://extensions."
}

$manifest = [ordered]@{
  name = $HostName
  description = 'AI Prompt Queue Transcription Monitor and Read-Only Memory Bridge'
  path = $LauncherPath
  type = 'stdio'
  allowed_origins = @($allIds | ForEach-Object { "chrome-extension://$_/" })
}

$manifestJson = $manifest | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ManifestPath, $manifestJson, $utf8NoBom)

if ($Browser -in @('Chrome', 'Both')) {
  $chromeKey = "HKCU:\SOFTWARE\Google\Chrome\NativeMessagingHosts\$HostName"
  New-Item -Path $chromeKey -Force | Out-Null
  Set-Item -Path $chromeKey -Value $ManifestPath
}
if ($Browser -in @('Edge', 'Both')) {
  $edgeKey = "HKCU:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\$HostName"
  New-Item -Path $edgeKey -Force | Out-Null
  Set-Item -Path $edgeKey -Value $ManifestPath
}

Write-Host "Native host installed: $HostName"
Write-Host "Manifest: $ManifestPath"
Write-Host "Launcher: $LauncherPath"
Write-Host "Allowed origins:"
$manifest.allowed_origins | ForEach-Object { Write-Host "  $_" }
