# 下载并安装便携版 Node.js 运行时（含 npm），下载时显示进度条；node.exe 已存在时直接返回。
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File packaging\bootstrap-runtime.ps1 -Destination <runtime 目录>
# 兼容 Windows PowerShell 5.1 与 PowerShell 7。
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$TempDirectory,
    [string]$Mirror = 'https://nodejs.org/dist',
    [string]$MajorVersion = '24'
)
$ErrorActionPreference = 'Stop'
$nodeExe = Join-Path $Destination 'node.exe'
if (Test-Path $nodeExe) { return }

if (-not $TempDirectory) {
    $TempDirectory = Join-Path ([IO.Path]::GetTempPath()) ('cw-runtime-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
}
New-Item -ItemType Directory -Force $TempDirectory | Out-Null

# 官方 Windows x64 发行版，SHASUMS256.txt 里的 SHA-256 校验后才解压。
$checksumsUrl = "$Mirror/latest-v$MajorVersion.x/SHASUMS256.txt"
Write-Host "正在获取 Node.js 版本信息： $checksumsUrl"
$checksums = (Invoke-WebRequest -UseBasicParsing $checksumsUrl).Content
$match = [regex]::Match($checksums, "(?m)^([a-f0-9]{64})\s+(node-v(\d+\.\d+\.\d+)-win-x64\.zip)\s*$")
if (-not $match.Success) { throw '无法定位官方 Node.js Windows x64 ZIP 下载地址' }
$expected = $match.Groups[1].Value
$nodeFile = $match.Groups[2].Value
$nodeVersion = 'v' + $match.Groups[3].Value
$nodeZip = Join-Path $TempDirectory $nodeFile
$url = "$Mirror/$nodeVersion/$nodeFile"

# 手写分块下载：Invoke-WebRequest 只有在 $ProgressPreference 非 SilentlyContinue 时才有进度条，
# 而那会显著拖慢 PS5.1 的下载；分块 + Write-Progress 在 5.1/7 下都快且有进度条。
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Net.Http | Out-Null
$client = New-Object System.Net.Http.HttpClient
try {
    $response = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw ('下载失败： HTTP ' + [int]$response.StatusCode) }
    $total = $response.Content.Headers.ContentLength
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $fileStream = [IO.File]::Create($nodeZip)
    $buffer = New-Object byte[] 262144
    try {
        $done = [long]0
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $fileStream.Write($buffer, 0, $read)
            $done += $read
            if ($total -and $total -gt 0) {
                $percent = [int](100 * $done / $total)
                Write-Progress -Activity "下载 Node.js $nodeVersion (win-x64)" -Status "$([math]::Round($done / 1MB, 1)) MB / $([math]::Round($total / 1MB, 1)) MB" -PercentComplete $percent
            } else {
                Write-Progress -Activity "下载 Node.js $nodeVersion (win-x64)" -Status "$([math]::Round($done / 1MB, 1)) MB"
            }
        }
    } finally {
        $fileStream.Dispose()
        $stream.Dispose()
    }
} finally {
    $client.Dispose()
}
Write-Progress -Activity "下载 Node.js $nodeVersion (win-x64)" -Completed

$hash = (Get-FileHash $nodeZip -Algorithm SHA256).Hash
if ($hash -ne $expected) { throw "Node.js ZIP 校验失败： SHA-256 不匹配" }
Write-Host '校验通过，正在解压...'

$tar = $null
if ($env:SystemRoot) {
    $candidate = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $candidate) { $tar = $candidate }
}
if (-not $tar) {
    $command = Get-Command tar -ErrorAction SilentlyContinue
    if ($command) { $tar = $command.Source }
}
if (-not $tar) { throw '未找到可用的 tar（Windows 需要 10 1803 或更高版本，或安装 tar 并加入 PATH）' }
& $tar -xf $nodeZip -C $TempDirectory
$extracted = Join-Path $TempDirectory ([IO.Path]::GetFileNameWithoutExtension($nodeFile))
if (-not (Test-Path (Join-Path $extracted 'node.exe'))) { throw '解压结果中缺少 node.exe' }
if (Test-Path $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
New-Item -ItemType Directory -Force (Split-Path $Destination -Parent) | Out-Null
Move-Item $extracted $Destination
Remove-Item -LiteralPath $TempDirectory -Recurse -Force
Write-Host "Node.js $nodeVersion 已就绪： $nodeExe"
