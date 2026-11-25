param(
  [string]$ProjectsDir = $(Join-Path $HOME 'OverleafProjects'),
  [string]$Port = '80',
  [string]$Image = 'codemolabs/overleaf:latest'
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker Desktop CLI not found in PATH.'
}
$null = docker info 2>$null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Desktop daemon is not running.'
}
$null = docker compose version 2>$null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Compose v2 (docker compose) is required.'
}

$subdirs = @(
  'data\overleaf',
  'data\mongo',
  'data\redis',
  'data\texlive-local',
  'data\backups\hibernate'
)
foreach ($sub in $subdirs) {
  $p = Join-Path $RootDir $sub
  if (-not (Test-Path $p)) {
    New-Item -ItemType Directory -Path $p -Force | Out-Null
  }
}
$defaultProjectsSub = Join-Path $ProjectsDir 'OverleafProjects'
if (-not (Test-Path $defaultProjectsSub)) {
  New-Item -ItemType Directory -Path $defaultProjectsSub -Force | Out-Null
}

# Normalize Windows backslashes to forward slashes for Docker Desktop Compose bind mounts
$DockerProjectsPath = ($ProjectsDir -replace '\\', '/')
$EnvFile = Join-Path $RootDir '.env'
$Existing = if (Test-Path $EnvFile) { Get-Content $EnvFile } else { @() }
$Vars = [ordered]@{}
foreach ($line in $Existing) {
  if ($line -match '^\s*([^#=]+)=(.*)$') {
    $Vars[$Matches[1].Trim()] = $Matches[2]
  }
}
$Vars['OVERLEAF_IMAGE_NAME'] = $Image
$Vars['OVERLEAF_PORT'] = $Port
$Vars['OVERLEAF_PROJECTS_HOST_DIR'] = $DockerProjectsPath

$Lines = foreach ($k in $Vars.Keys) { "$k=$($Vars[$k])" }
$Lines | Set-Content -Path $EnvFile -Encoding UTF8

Write-Host '=== Starting Overleaf: COSL Edition for Enterprises ==='
Write-Host "  Workspace sync root : $ProjectsDir"
Write-Host "  Web URL             : http://localhost:${Port}"
Write-Host "  Docker image        : $Image"

$ComposeFile = Join-Path $RootDir 'docker-compose.yml'
docker compose -f $ComposeFile up -d
& (Join-Path $ScriptDir 'overleaf-ctl.ps1') -Action on

Write-Host ''
Write-Host "[ok] Installation complete. Open http://localhost:${Port} to finish /launchpad setup."
Write-Host "     Pause / OFF : $ScriptDir\overleaf-ctl.cmd off"
Write-Host "     Resume / ON : $ScriptDir\overleaf-ctl.cmd on"
