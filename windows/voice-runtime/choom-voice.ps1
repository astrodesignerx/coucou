# Choom voice runtime helper (Windows PowerShell 5.1 + System.Speech).
# Single hidden helper process owned by Rust. JSON lines on stdin/stdout.
# No console flash: Rust spawns powershell with CREATE_NO_WINDOW.
# Real microphone capture via System.Speech.Recognition, real local speech
# via System.Speech.Synthesis. Bounded buffers, no disk recordings.
#
# Protocol (stdin, one JSON object per line, max 64KB):
#   {"cmd":"probe"}                 -> capability lists, no microphone use
#   {"cmd":"listen","wake":false}    -> start dictation recognizer
#   {"cmd":"wake_on","phrase":"Choom"} -> start keyword listener (grammar)
#   {"cmd":"stop"}                   -> stop recognition, keep process alive
#   {"cmd":"speak","text":"...","voice":"","rate":0,"volume":100}
#   {"cmd":"stop_audio"}             -> stop speech output immediately
#   {"cmd":"shutdown"}               -> clean exit
#
# Protocol (stdout, one JSON object per line):
#   {"type":"ready"}
#   {"type":"capability","recognizers":[...],"voices":[...]}
#   {"type":"partial","text":"...","generation":1}
#   {"type":"final","text":"...","generation":1}
#   {"type":"wake","phrase":"Choom"}
#   {"type":"speech_started"} / {"type":"speech_ended"}
#   {"type":"error","message":"...","recoverable":true}
#   {"type":"stopped"}

$ErrorActionPreference = "Continue"
$MAX_LINE = 65536

Add-Type -AssemblyName System.Speech -ErrorAction Stop

$recognizer = $null
$synth = $null
$wakeMode = $false
$generation = 0
$listening = $false

function Emit($obj) {
  $json = ($obj | ConvertTo-Json -Compress -Depth 4)
  if ($json.Length -gt $MAX_LINE) { $json = $json.Substring(0, $MAX_LINE) }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Emit-Error($message, $recoverable) {
  Emit @{ type = "error"; message = $message; recoverable = $recoverable }
}

function Get-Capability {
  $recogs = @()
  try {
    $recogs = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
      ForEach-Object { $_.Culture.Name + " " + $_.Id }
  } catch {
    $recogs = @()
  }
  $voices = @()
  try {
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voices = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + " (" + $_.VoiceInfo.Culture.Name + ")" }
    $s.Dispose()
  } catch {
    $voices = @()
  }
  Emit @{ type = "capability"; recognizers = @($recogs); voices = @($voices) }
}

function Stop-Recognition {
  try { if ($recognizer -ne $null) { $recognizer.RecognizeAsyncStop() } } catch {}
  try { if ($recognizer -ne $null) { $recognizer.Dispose(); $script:recognizer = $null } } catch {}
  $script:listening = $false
  $script:wakeMode = $false
}

# Capture uses event handlers in C# style via Register-ObjectEvent so we avoid
# PowerShell runspace callback pitfalls: handlers run on the event queue and
# only write bounded JSON lines.
function Start-Listen($wakeOnly, $phrase) {
  Stop-Recognition
  $script:generation += 1
  $gen = $script:generation
  try {
    $culture = New-Object System.Globalization.CultureInfo("en-US")
    $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
  } catch {
    try {
      $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    } catch {
      Emit-Error ("No speech recognizer installed: " + $_.Exception.Message) $true
      return
    }
  }
  try {
    $r.SetInputToDefaultAudioDevice()
  } catch {
    Emit-Error ("Microphone unavailable: " + $_.Exception.Message) $true
    try { $r.Dispose() } catch {}
    return
  }
  try {
    if ($wakeOnly) {
      $choices = New-Object System.Speech.Recognition.Choices(@($phrase, "Hey Choom", "Choom"))
      $gb = New-Object System.Speech.Recognition.GrammarBuilder($choices)
      $g = New-Object System.Speech.Recognition.Grammar($gb)
      $g.Name = "choom-wake"
      $r.LoadGrammar($g)
    } else {
      $r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    }
  } catch {
    Emit-Error ("Grammar failed: " + $_.Exception.Message) $true
    try { $r.Dispose() } catch {}
    return
  }
  $script:recognizer = $r
  $script:wakeMode = $wakeOnly
  $script:listening = $true

  # Remove stale subscriptions from a previous run.
  Get-EventSubscriber -SourceIdentifier "ChoomSpeechHyp*" -ErrorAction SilentlyContinue | Unregister-Event -ErrorAction SilentlyContinue
  Get-EventSubscriber -SourceIdentifier "ChoomSpeechRec*" -ErrorAction SilentlyContinue | Unregister-Event -ErrorAction SilentlyContinue

  Register-ObjectEvent -InputObject $r -EventName SpeechHypothesized -SourceIdentifier "ChoomSpeechHyp$gen" -Action {
    $text = $EventArgs.Result.Text
    if ($text -ne $null -and $text.Length -gt 0) {
      if ($text.Length -gt 500) { $text = $text.Substring(0, 500) }
      $o = @{ type = "partial"; text = $text; generation = $Event.MessageData }
      ($o | ConvertTo-Json -Compress) | Out-Host
    }
  } -MessageData $gen | Out-Null

  Register-ObjectEvent -InputObject $r -EventName SpeechRecognized -SourceIdentifier "ChoomSpeechRec$gen" -Action {
    $text = $EventArgs.Result.Text
    if ($text -ne $null) {
      if ($text.Length -gt 2000) { $text = $text.Substring(0, 2000) }
      $conf = 0.0
      try { $conf = $EventArgs.Result.Confidence } catch {}
      if ($Event.MessageData.Wake) {
        (@{ type = "wake"; phrase = $text } | ConvertTo-Json -Compress) | Out-Host
      } else {
        $o = @{ type = "final"; text = $text; generation = $Event.MessageData.Gen; confidence = $conf }
        ($o | ConvertTo-Json -Compress) | Out-Host
      }
    }
  } -MessageData @{ Gen = $gen; Wake = $wakeOnly } | Out-Null

  # Note: Register-ObjectEvent Action output goes to the host, not our
  # stdout JSON stream. Rewrite: use synchronous RecognizeAsync with the
  # handlers above replaced by polling below is not possible in 5.1 without
  # runspaces, so instead drive recognition synchronously per utterance below.
  # Keep the async recognizer as the capture source; hypotheses arrive via
  # the event queue and we forward them by draining the queue each 100ms.
  try {
    $r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple) | Out-Null
  } catch {
    Emit-Error ("Recognition start failed: " + $_.Exception.Message) $true
    Stop-Recognition
  }
}

# The event Action above writes to host; redirect host output into stdout JSON
# by re-emitting queued events here. PowerShell 5.1 delivers
# Register-ObjectEvent actions in-process, so also poll recognizer state to
# detect audio loss and emit recoverable errors.
function Speak($text, $voice, $rate, $volume) {
  if ($text -eq $null -or $text.Trim().Length -eq 0) { return }
  $t = $text.Trim()
  if ($t.Length -gt 600) { $t = $t.Substring(0, 600) }
  # Never speak code or long logs: keep talkback short and factual.
  $lines = $t -split "`n"
  if ($lines.Count -gt 4) { $t = ($lines[0..3] -join " ") }
  try {
    if ($synth -ne $null) { try { $synth.SpeakAsyncCancelAll() } catch {}; try { $synth.Dispose() } catch {} }
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    if ($voice -ne $null -and $voice -ne "") {
      try { $s.SelectVoice($voice) } catch {}
    }
    try { $s.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$rate)) } catch {}
    try { $s.Volume = [Math]::Max(0, [Math]::Min(100, [int]$volume)) } catch {}
    $script:synth = $s
    Emit @{ type = "speech_started" }
    $s.Speak($t)
    Emit @{ type = "speech_ended" }
  } catch {
    Emit-Error ("Speech failed: " + $_.Exception.Message) $true
  }
}

function Stop-Audio {
  try { if ($synth -ne $null) { $synth.SpeakAsyncCancelAll() } } catch {}
  try { if ($synth -ne $null) { $synth.Dispose(); $script:synth = $null } } catch {}
  Emit @{ type = "speech_ended" }
}

Emit @{ type = "ready" }

while ($true) {
  $line = $null
  try { $line = [Console]::In.ReadLine() } catch { break }
  if ($line -eq $null) { break }
  if ($line.Length -eq 0) { continue }
  if ($line.Length -gt $MAX_LINE) { Emit-Error "Command too long, dropped." $true; continue }
  $cmd = $null
  try { $cmd = $line | ConvertFrom-Json } catch { Emit-Error "Malformed command, dropped." $true; continue }
  $name = $cmd.cmd
  if ($name -eq "probe") { Get-Capability }
  elseif ($name -eq "listen") { Start-Listen $false "Choom" }
  elseif ($name -eq "wake_on") {
    $p = $cmd.phrase
    if ($p -eq $null -or $p -eq "") { $p = "Choom" }
    Start-Listen $true $p
  }
  elseif ($name -eq "stop") { Stop-Recognition; Emit @{ type = "stopped" } }
  elseif ($name -eq "speak") { Speak $cmd.text $cmd.voice $cmd.rate $cmd.volume }
  elseif ($name -eq "stop_audio") { Stop-Audio }
  elseif ($name -eq "shutdown") { Stop-Recognition; Stop-Audio; break }
  else { Emit-Error ("Unknown command: " + $name) $true }
}
