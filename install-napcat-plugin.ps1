[CmdletBinding()]
param(
  [string]$NapCatRoot = $env:NAPCAT_ROOT
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $NapCatRoot) { $NapCatRoot = "D:\lyp-soft\NapCat" }
if (-not (Test-Path -LiteralPath $NapCatRoot -PathType Container)) {
  throw "NapCat directory not found: $NapCatRoot. Run with -NapCatRoot <NapCat directory>."
}

# This installer deliberately touches NapCat only. It never changes QQ's
# resources/app/package.json or installs a separate main-process loader.
$qqProcesses = Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction SilentlyContinue
if ($qqProcesses) { throw "QQ is running. Close QQ/NapCat completely, then rerun this script. No files were changed." }

$pluginId = "qq-miniapp-openauth"
$pluginSourceDir = Join-Path $projectRoot "napcat-openauth-plugin"
$pluginDir = Join-Path $NapCatRoot "plugins\$pluginId"
$pluginConfigDir = Join-Path $NapCatRoot "config\plugins\$pluginId"
$pluginConfigPath = Join-Path $pluginConfigDir "config.json"
$napcatMainPath = Join-Path $NapCatRoot "napcat.mjs"
$pluginsConfigPath = Join-Path $NapCatRoot "config\plugins.json"
$envPath = Join-Path $projectRoot ".env"

if (-not (Test-Path -LiteralPath $pluginSourceDir -PathType Container)) { throw "Plugin source directory is missing: $pluginSourceDir" }
if (-not (Test-Path -LiteralPath $napcatMainPath -PathType Leaf)) { throw "NapCat main file not found: $napcatMainPath" }
New-Item -ItemType Directory -Force -Path (Split-Path $pluginDir) | Out-Null
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
# Remove the nested layout produced by older versions of this installer.
$legacyNestedPluginDir = Join-Path $pluginDir "napcat-openauth-plugin"
if (Test-Path -LiteralPath $legacyNestedPluginDir -PathType Container) {
  Remove-Item -LiteralPath $legacyNestedPluginDir -Recurse -Force
}
# Copy the source contents into the plugin root. Using the source directory
# itself as the destination would create a nested `napcat-openauth-plugin`
# directory when reinstalling over an existing plugin.
Copy-Item -Path (Join-Path $pluginSourceDir '*') -Destination $pluginDir -Recurse -Force
New-Item -ItemType Directory -Force -Path $pluginConfigDir | Out-Null

$pluginToken = ""
if (Test-Path -LiteralPath $envPath -PathType Leaf) {
  $existing = Select-String -LiteralPath $envPath -Pattern '^NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=(.*)$' | Select-Object -First 1
  if ($existing) { $pluginToken = [string]$existing.Matches[0].Groups[1].Value.Trim() }
}
if (-not $pluginToken) {
  $random = [byte[]]::new(32)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($random) } finally { $rng.Dispose() }
  $pluginToken = [Convert]::ToBase64String($random)
}
[System.IO.File]::WriteAllText($pluginConfigPath, (@{ token = $pluginToken } | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))

# NapCat's current plugin loader requires third-party IDs to be explicitly
# whitelisted. Add only this plugin ID when it is not already present.
$napcatSource = [System.IO.File]::ReadAllText($napcatMainPath)
if ($napcatSource -notmatch '"qq-miniapp-openauth"') {
  $marker = '"napcat-plugin-qce"'
  if (-not $napcatSource.Contains($marker)) { throw "NapCat plugin whitelist marker not found; refusing to modify napcat.mjs." }
  $replacement = $marker + ",`r`n  " + [char]34 + $pluginId + [char]34
  $napcatSource = $napcatSource.Replace($marker, $replacement)
  [System.IO.File]::WriteAllText($napcatMainPath, $napcatSource, [System.Text.UTF8Encoding]::new($false))
}

$pluginsConfig = @{}
if (Test-Path -LiteralPath $pluginsConfigPath -PathType Leaf) {
  try { $pluginsConfig = Get-Content -LiteralPath $pluginsConfigPath -Raw | ConvertFrom-Json -AsHashtable } catch { $pluginsConfig = @{} }
}
$pluginsConfig[$pluginId] = $true
[System.IO.File]::WriteAllText($pluginsConfigPath, ($pluginsConfig | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))

if (Test-Path -LiteralPath $envPath -PathType Leaf) {
  $lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $envPath)
  $updated = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=') { $lines[$i] = "NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=$pluginToken"; $updated = $true }
  }
  if (-not $updated) { $lines.Add("NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=$pluginToken") }
  [System.IO.File]::WriteAllLines($envPath, $lines, [System.Text.UTF8Encoding]::new($false))
}

Write-Host "Installed NapCat plugin: $pluginId"
Write-Host "No QQ files were modified."
Write-Host "No project backup or restart-delete registration was created."
Write-Host "Plugin route: http://127.0.0.1:6099/plugin/$pluginId/api/miniapp"
Write-Host "Logout route: http://127.0.0.1:6099/plugin/$pluginId/api/logout (NapCat offline)"
Write-Host "Restart NapCat, then check the route from the bridge."
