# Sets Tapu up from a fresh copy of the code.
#
#   .\setup.ps1            build the app (needed once, and after every update)
#   .\setup.ps1 -Media     also fetch FFmpeg: screen recording, video and audio tools, dictation
#   .\setup.ps1 -Voice     also fetch whisper.cpp and its small model (about 470 MB): dictation
#   .\setup.ps1 -CutBg     also fetch the background-removal model (about 170 MB)
#   .\setup.ps1 -All       everything above
#
# The optional pieces are downloaded from their own projects' release pages into
# the vendor folder. Nothing is installed outside this folder.
param([switch]$Media, [switch]$Voice, [switch]$CutBg, [switch]$All)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes downloads many times faster in Windows PowerShell
Set-Location $PSScriptRoot

function Need($command, $what) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$what is not installed (could not find '$command'). See the README for where to get it." }
}
function Fetch($url, $to) {
  if (Test-Path $to) { Write-Host "  already here: $to"; return }
  Write-Host "  downloading $url"
  New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
  Invoke-WebRequest -Uri $url -OutFile "$to.part" -UseBasicParsing
  Move-Item "$to.part" $to
}

Need node 'Node.js 20 or newer'
Need npm 'Node.js 20 or newer'
Need dotnet 'The .NET 9 SDK'

Write-Host 'Installing packages...'
npm install --no-audit --no-fund
if ($LASTEXITCODE) { throw 'npm install failed' }

Write-Host 'Building the helper...'
dotnet build helper/IslandHelper.csproj -c Release -nologo -v q
if ($LASTEXITCODE) { throw 'The helper did not build' }

Write-Host 'Building the island...'
npm run build
if ($LASTEXITCODE) { throw 'The island did not build' }

$tmp = Join-Path $env:TEMP 'tapu-setup'
New-Item -ItemType Directory -Force $tmp, vendor | Out-Null

if ($Media -or $Voice -or $All) {
  Write-Host 'FFmpeg...'
  if (-not (Test-Path vendor\ffmpeg.exe)) {
    Fetch 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' "$tmp\ffmpeg.zip"
    Expand-Archive "$tmp\ffmpeg.zip" "$tmp\ffmpeg" -Force
    Copy-Item (Get-ChildItem "$tmp\ffmpeg" -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName vendor\ffmpeg.exe
  }
}
if ($Voice -or $All) {
  Write-Host 'whisper.cpp...'
  if (-not (Test-Path vendor\whisper\whisper-cli.exe)) {
    Fetch 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip' "$tmp\whisper.zip"
    Expand-Archive "$tmp\whisper.zip" "$tmp\whisper" -Force
    New-Item -ItemType Directory -Force vendor\whisper | Out-Null
    $from = (Get-ChildItem "$tmp\whisper" -Recurse -Filter whisper-cli.exe | Select-Object -First 1).DirectoryName
    Copy-Item "$from\whisper-cli.exe", "$from\*.dll" vendor\whisper
  }
  Fetch 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin' "$PSScriptRoot\vendor\models\ggml-small.bin"
}
if ($CutBg -or $All) {
  Write-Host 'Background-removal model...'
  Fetch 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx' "$PSScriptRoot\vendor\models\isnet-general-use.onnx"
}

Write-Host ''
Write-Host 'Done. Start it with:  npm start'
