# Folia SMTC 控制代理
#
# DSH 的 Host 进程长期持有这个 PowerShell 子进程，用一行一条 JSON 的方式
# 读写 Windows 的 SystemMediaTransportControls（SMTC）。
#
# 为什么走 SMTC 而不是 Folia 自己的接口：Folia 的渲染层通过
# navigator.mediaSession.setActionHandler 注册了 play / pause / previoustrack /
# nexttrack，并持续 setPositionState()。这些注册在系统层面就是 SMTC 会话，
# 所以 DSH 用系统 API 就能控制播放，不需要改 Folia、不需要额外装软件、
# 也不会和 Folia 自己的 UI 抢状态。
#
# 协议：
#   输入（stdin，每行一个 JSON）：{"id":1,"action":"status"}
#     action ∈ status | play | pause | toggle | next | prev | seek
#     seek 需要 "positionMs"（整数，毫秒）
#   输出（stdout，每行一个 JSON）：{"id":1,"ok":true,"session":{...}}
#     session 为 null 表示没找到 Folia 的媒体会话。
#
# 只在首次命中时抓封面，之后按「标题+歌手+专辑」缓存，避免每次轮询都做一次
# WinRT 流读取。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

$coverCache = @{}
$coverKey = $null
$coverUrl = $null

function Find-FoliaSession {
  $sessions = $manager.GetSessions()
  if (-not $sessions) { return $null }
  foreach ($s in $sessions) {
    if ($s.SourceAppUserModelId -like '*folia*') { return $s }
  }
  return $null
}

function Read-Cover($info, $key) {
  if ($key -eq $script:coverKey) { return $script:coverUrl }
  $script:coverKey = $key
  $script:coverUrl = $null
  try {
    $ref = $info.Thumbnail
    if (-not $ref) { return $null }
    $stream = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $size = [int]$stream.Size
    if ($size -le 0 -or $size -gt 4194304) { return $null }
    $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
    Await ($reader.LoadAsync([uint32]$size)) ([uint32]) | Out-Null
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    $mime = $stream.ContentType
    if (-not $mime) { $mime = 'image/jpeg' }
    $script:coverUrl = "data:$mime;base64,$([Convert]::ToBase64String($bytes))"
  } catch {
    $script:coverUrl = $null
  }
  return $script:coverUrl
}

function Build-Session {
  $s = Find-FoliaSession
  if (-not $s) {
    $script:coverKey = $null
    $script:coverUrl = $null
    return $null
  }

  $info = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $playback = $s.GetPlaybackInfo()
  $timeline = $s.GetTimelineProperties()

  $title = $info.Title
  $artist = $info.Artist
  $album = $info.AlbumTitle
  $key = "$title|$artist|$album"
  $cover = $null
  try { $cover = Read-Cover $info $key } catch { $cover = $null }

  $controls = $playback.Controls
  $position = [math]::Round($timeline.Position.TotalMilliseconds, 0)
  $duration = [math]::Round($timeline.EndTime.TotalMilliseconds, 0)
  if ($duration -lt 0) { $duration = 0 }

  return [ordered]@{
    appId     = $s.SourceAppUserModelId
    title     = $title
    artist    = $artist
    album     = $album
    status    = [string]$playback.PlaybackStatus
    positionMs = [long]$position
    durationMs = [long]$duration
    sampledAtMs = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    cover     = $cover
    canPlay   = [bool]$controls.IsPlayEnabled
    canPause  = [bool]$controls.IsPauseEnabled
    canNext   = [bool]$controls.IsNextEnabled
    canPrev   = [bool]$controls.IsPreviousEnabled
    canSeek   = [bool]$controls.IsSeekEnabled
  }
}

function Invoke-Action($action, $positionMs) {
  $s = Find-FoliaSession
  if (-not $s) { return $false }
  switch ($action) {
    'play'   { return [bool](Await ($s.TryPlayAsync()) ([bool])) }
    'pause'  { return [bool](Await ($s.TryPauseAsync()) ([bool])) }
    'toggle' {
      $st = [string]$s.GetPlaybackInfo().PlaybackStatus
      if ($st -eq 'Playing') { return [bool](Await ($s.TryPauseAsync()) ([bool])) }
      return [bool](Await ($s.TryPlayAsync()) ([bool]))
    }
    'next'   { return [bool](Await ($s.TrySkipNextAsync()) ([bool])) }
    'prev'   { return [bool](Await ($s.TrySkipPreviousAsync()) ([bool])) }
    'seek'   {
      $tl = $s.GetTimelineProperties()
      $target = [long]$positionMs * 10000 + [long]$tl.StartTime.Ticks
      return [bool](Await ($s.TryChangePlaybackPositionAsync($target)) ([bool]))
    }
    default  { return $false }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  $response = $null
  try {
    $request = $line | ConvertFrom-Json
    $action = [string]$request.action
    if ($action -eq 'ping') {
      $response = [ordered]@{ id = $request.id; ok = $true; pong = $true }
    } else {
      $changed = $true
      if ($action -ne 'status') {
        $positionMs = 0
        if ($null -ne $request.positionMs) { $positionMs = [long]$request.positionMs }
        $changed = Invoke-Action $action $positionMs
        Start-Sleep -Milliseconds 90
      }
      $response = [ordered]@{
        id = $request.id
        ok = $true
        changed = [bool]$changed
        session = Build-Session
      }
    }
  } catch {
    $response = [ordered]@{ id = 0; ok = $false; error = [string]$_.Exception.Message; session = $null }
  }

  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
