# Choom voice runtime helper (Windows PowerShell 5.1 + System.Speech).
# Single hidden helper process owned by Rust. JSON lines on stdin/stdout.
# No console flash: Rust spawns powershell with CREATE_NO_WINDOW.
# Real microphone capture via System.Speech.Recognition, real local speech
# via System.Speech.Synthesis. Bounded buffers, no disk recordings.
#
# Recognition and synthesis callbacks live in embedded C# so they serialize
# synchronized bounded JSON straight to stdout from any thread. No
# Register-ObjectEvent, no Out-Host: event output can never land on the
# wrong stream or die in a runspace.
#
# Protocol (stdin, one JSON object per line, max 64KB). Every command carries
# the Rust-owned "instance" epoch, echoed unchanged on every event:
#   {"cmd":"probe"}                                      -> capability lists
#   {"cmd":"listen","generation":N,"instance":M}          -> dictation
#   {"cmd":"wake_on","phrase":"Choom","generation":N,"instance":M}
#                                                        -> keyword listener
#   {"cmd":"stop","instance":M}                           -> stop recognition
#   {"cmd":"recover","generation":N,"instance":M}         -> recreate recognizer
#   {"cmd":"speak","text":"...","voice":"","rate":0,"volume":100,
#    "generation":N,"instance":M}                         -> async talkback
#   {"cmd":"stop_audio","generation":N,"instance":M}      -> stop speech now
#   {"cmd":"shutdown"}                                    -> clean exit
# Test-only WAV commands (no mic, no speaker). They work only when this
# process starts with CHOOM_VOICE_TEST=1; production never sets it, so a
# test command can never be selected by accident:
#   {"cmd":"test_listen","wav":"C:\\...\\in.wav","generation":N,"instance":M}
#   {"cmd":"test_speak","text":"...","wav":"C:\\...\\out.wav",
#    "generation":N,"instance":M}
#
# Protocol (stdout, one JSON object per line):
#   {"type":"ready","instance":0}
#   {"type":"capability","recognizers":[...],"voices":[...]}
#   {"type":"partial","text":"...","generation":N,"instance":M}
#   {"type":"final","text":"...","generation":N,"instance":M}
#   {"type":"wake","phrase":"Choom","generation":N,"instance":M}
#   {"type":"speech_started","generation":N,"instance":M}
#   {"type":"speech_ended","generation":N,"instance":M}
#   {"type":"recovered","generation":N,"instance":M}
#   {"type":"error","message":"...","recoverable":true,
#    "generation":N,"instance":M}
#   {"type":"stopped","generation":0,"instance":M}

$ErrorActionPreference = "Continue"
$MAX_LINE = 65536

# Explicit UTF8 both ways: the JSON protocol must round-trip accents and
# non-Latin text identically on every PC.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Speech -ErrorAction Stop

$testMode = ($env:CHOOM_VOICE_TEST -eq "1")

$csharp = @"
using System;
using System.IO;
using System.Speech.Recognition;
using System.Speech.Synthesis;

public static class ChoomVoiceSink {
  public static readonly object Gate = new object();
  // Currently owned sources. Callbacks reject any sender that is not the
  // owned recognizer or synth, so an old source can never be relabeled as
  // a new turn through mutable globals.
  public static SpeechRecognitionEngine OwnedRecognizer;
  public static SpeechSynthesizer OwnedSynth;

  static string Clip(string s, int max) {
    if (s == null) return "";
    return s.Length <= max ? s : s.Substring(0, max);
  }

  static string Esc(string s) {
    var sb = new System.Text.StringBuilder(s.Length + 8);
    foreach (char c in s) {
      switch (c) {
        case '"': sb.Append("\\\""); break;
        case '\\': sb.Append("\\\\"); break;
        case '\n': sb.Append("\\n"); break;
        case '\r': sb.Append("\\r"); break;
        case '\t': sb.Append("\\t"); break;
        default:
          if (c < 0x20) { sb.Append("\\u"); sb.Append(((int)c).ToString("x4")); }
          else sb.Append(c);
          break;
      }
    }
    return sb.ToString();
  }

  public static void Emit(string json) {
    // No raw JSON clipping: over-long values are truncated before
    // serialization, so every line stays complete and parseable.
    lock (Gate) {
      try { Console.Out.WriteLine(json); Console.Out.Flush(); } catch {}
    }
  }

  public static void Partial(string text, long gen, long inst) {
    Emit("{\"type\":\"partial\",\"text\":\"" + Esc(Clip(text, 500)) + "\",\"generation\":" + gen + ",\"instance\":" + inst + "}");
  }

  public static void Final(string text, long gen, long inst) {
    Emit("{\"type\":\"final\",\"text\":\"" + Esc(Clip(text, 2000)) + "\",\"generation\":" + gen + ",\"instance\":" + inst + "}");
  }

  public static void Wake(string text, long gen, long inst) {
    Emit("{\"type\":\"wake\",\"phrase\":\"" + Esc(Clip(text, 64)) + "\",\"generation\":" + gen + ",\"instance\":" + inst + "}");
  }

  public static void Error(string message, bool recoverable, long gen, long inst) {
    Emit("{\"type\":\"error\",\"message\":\"" + Esc(Clip(message, 500)) + "\",\"recoverable\":" + (recoverable ? "true" : "false") + ",\"generation\":" + gen + ",\"instance\":" + inst + "}");
  }

  public static void Simple(string typeName, long gen, long inst) {
    Emit("{\"type\":\"" + typeName + "\",\"generation\":" + gen + ",\"instance\":" + inst + "}");
  }

  public static void Attach(SpeechRecognitionEngine r, long gen, long inst, bool wake) {
    OwnedRecognizer = r;
    r.SpeechHypothesized += (sender, e) => {
      try {
        if (!object.ReferenceEquals(sender, OwnedRecognizer)) return;
        if (e.Result == null || string.IsNullOrEmpty(e.Result.Text)) return;
        if (wake) return;
        Partial(e.Result.Text, gen, inst);
      } catch {}
    };
    r.SpeechRecognized += (sender, e) => {
      try {
        if (!object.ReferenceEquals(sender, OwnedRecognizer)) return;
        if (e.Result == null || e.Result.Text == null) return;
        if (wake) Wake(e.Result.Text, gen, inst);
        else Final(e.Result.Text, gen, inst);
      } catch {}
    };
    r.RecognizeCompleted += (sender, e) => {
      try {
        if (!object.ReferenceEquals(sender, OwnedRecognizer)) return;
        if (e.Error != null) {
          Error("Recognition failed: " + e.Error.Message, true, gen, inst);
        }
      } catch {}
    };
  }

  public static void Detach() {
    var r = OwnedRecognizer;
    OwnedRecognizer = null;
    if (r == null) return;
    try { r.RecognizeAsyncStop(); } catch {}
    try { r.Dispose(); } catch {}
  }

  public static void SpeakAsyncWithDone(SpeechSynthesizer s, string text, long gen, long inst) {
    OwnedSynth = s;
    s.SpeakCompleted += (sender, e) => {
      try {
        if (!object.ReferenceEquals(sender, OwnedSynth)) return;
        if (e.Error != null) Error("Speech failed: " + e.Error.Message, true, gen, inst);
        else Simple("speech_ended", gen, inst);
      } catch {}
    };
    s.SpeakAsync(text);
  }

  public static void StopAudio() {
    var s = OwnedSynth;
    if (s == null) return;
    try { s.SpeakAsyncCancelAll(); } catch {}
  }

  public static void DisposeAudio() {
    var s = OwnedSynth;
    OwnedSynth = null;
    if (s == null) return;
    try { s.SpeakAsyncCancelAll(); } catch {}
    try { s.Dispose(); } catch {}
  }
}
"@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies @("System.Speech") -ErrorAction Stop

$script:instance = 0
$script:mode = "idle"
$script:phrase = "Choom"
$script:generation = 0

function Emit-Ready {
  [ChoomVoiceSink]::Emit('{"type":"ready","instance":0}')
}

function Emit-Stopped($inst) {
  [ChoomVoiceSink]::Simple("stopped", 0, $inst)
}

function Get-Capability {
  $recogs = @()
  try {
    $recogs = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
      ForEach-Object { $_.Culture.Name + " " + $_.Id }
  } catch {
    $recogs = @()
  }
  # Voice names match SelectVoice exactly: bare VoiceInfo.Name only.
  $voices = @()
  try {
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voices = @($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
    $s.Dispose()
  } catch {
    $voices = @()
  }
  [ChoomVoiceSink]::Emit((@{ type = "capability"; recognizers = @($recogs); voices = @($voices) } | ConvertTo-Json -Compress -Depth 4))
}

function Stop-Recognition {
  [ChoomVoiceSink]::Detach()
  $script:mode = "idle"
}

function New-Recognizer($cultureName) {
  try {
    $culture = New-Object System.Globalization.CultureInfo($cultureName)
    return New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
  } catch {
    return New-Object System.Speech.Recognition.SpeechRecognitionEngine
  }
}

function Start-Listen($wakeOnly, $phrase, $gen, $inst, $testWav) {
  Stop-Recognition
  $r = $null
  try {
    $r = New-Recognizer "en-US"
  } catch {
    [ChoomVoiceSink]::Error(("No speech recognizer installed: " + $_.Exception.Message), $true, $gen, $inst)
    return $false
  }
  try {
    if ($testWav -ne $null -and $testWav -ne "") {
      $r.SetInputToWaveFile($testWav)
    } else {
      $r.SetInputToDefaultAudioDevice()
    }
  } catch {
    [ChoomVoiceSink]::Error(("Microphone unavailable: " + $_.Exception.Message), $true, $gen, $inst)
    try { $r.Dispose() } catch {}
    return $false
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
    [ChoomVoiceSink]::Error(("Grammar failed: " + $_.Exception.Message), $true, $gen, $inst)
    try { $r.Dispose() } catch {}
    return $false
  }
  [ChoomVoiceSink]::Attach($r, $gen, $inst, $wakeOnly)
  $script:mode = if ($wakeOnly) { "wake" } else { "listen" }
  $script:phrase = $phrase
  $script:generation = $gen
  $script:instance = $inst
  try {
    $r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple) | Out-Null
  } catch {
    [ChoomVoiceSink]::Error(("Recognition start failed: " + $_.Exception.Message), $true, $gen, $inst)
    Stop-Recognition
    return $false
  }
  return $true
}

function Invoke-Recover($gen, $inst) {
  # Default-device failure recovery recreates the recognizer in the mode it
  # died in, bounded Rust side. Errors stay visible, never fake standby.
  if ($script:mode -eq "wake") {
    $ok = Start-Listen $true $script:phrase $gen $inst $null
  } elseif ($script:mode -eq "listen") {
    $ok = Start-Listen $false "Choom" $gen $inst $null
  } else {
    [ChoomVoiceSink]::Error("Nothing to recover. Start listening first.", $true, $gen, $inst)
    return
  }
  if ($ok) { [ChoomVoiceSink]::Simple("recovered", $gen, $inst) }
}

function Invoke-Speak($text, $voice, $rate, $volume, $gen, $inst, $testWav) {
  if ($text -eq $null -or $text.Trim().Length -eq 0) { return }
  $t = $text.Trim()
  if ($t.Length -gt 600) { $t = $t.Substring(0, 600) }
  # Never speak code or long logs: keep talkback short and factual.
  $lines = $t -split "`n"
  if ($lines.Count -gt 4) { $t = ($lines[0..3] -join " ") }
  # Stop recognition before synthesis so talkback never feeds itself.
  # The follow-up turn starts fresh capture after speech_ended.
  Stop-Recognition
  [ChoomVoiceSink]::DisposeAudio()
  try {
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    if ($voice -ne $null -and $voice -ne "") {
      try { $s.SelectVoice($voice) } catch {}
    }
    try { $s.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$rate)) } catch {}
    try { $s.Volume = [Math]::Max(0, [Math]::Min(100, [int]$volume)) } catch {}
    if ($testWav -ne $null -and $testWav -ne "") {
      $s.SetOutputToWaveFile($testWav)
    } else {
      $s.SetOutputToDefaultAudioDevice()
    }
    [ChoomVoiceSink]::Simple("speech_started", $gen, $inst)
    # One asynchronous path for real playback and WAV verification alike,
    # so stop_audio and completion behave identically in both.
    [ChoomVoiceSink]::SpeakAsyncWithDone($s, $t, $gen, $inst)
  } catch {
    [ChoomVoiceSink]::Error(("Speech failed: " + $_.Exception.Message), $true, $gen, $inst)
  }
}

function Stop-Audio($gen, $inst) {
  [ChoomVoiceSink]::StopAudio()
  [ChoomVoiceSink]::DisposeAudio()
  [ChoomVoiceSink]::Simple("speech_ended", $gen, $inst)
}

Emit-Ready

while ($true) {
  $line = $null
  try { $line = [Console]::In.ReadLine() } catch { break }
  if ($line -eq $null) { break }
  if ($line.Length -eq 0) { continue }
  if ($line.Length -gt $MAX_LINE) { [ChoomVoiceSink]::Error("Command too long, dropped.", $true, $script:generation, $script:instance); continue }
  $cmd = $null
  try { $cmd = $line | ConvertFrom-Json } catch { [ChoomVoiceSink]::Error("Malformed command, dropped.", $true, $script:generation, $script:instance); continue }
  $name = $cmd.cmd
  $inst = 0
  try { if ($cmd.instance -ne $null) { $inst = [long]$cmd.instance } } catch {}
  $gen = 0
  try { if ($cmd.generation -ne $null) { $gen = [long]$cmd.generation } } catch {}
  if ($name -eq "probe") { Get-Capability }
  elseif ($name -eq "listen") {
    Start-Listen $false "Choom" $gen $inst $null | Out-Null
  }
  elseif ($name -eq "wake_on") {
    $p = $cmd.phrase
    if ($p -eq $null -or $p -eq "") { $p = "Choom" }
    Start-Listen $true $p $gen $inst $null | Out-Null
  }
  elseif ($name -eq "stop") { Stop-Recognition; Emit-Stopped $inst }
  elseif ($name -eq "recover") {
    Invoke-Recover $gen $inst
  }
  elseif ($name -eq "speak") { Invoke-Speak $cmd.text $cmd.voice $cmd.rate $cmd.volume $gen $inst $null }
  elseif ($name -eq "stop_audio") { Stop-Audio $gen $inst }
  elseif ($name -eq "test_listen") {
    if (-not $testMode) { [ChoomVoiceSink]::Error("Test input is not enabled in production.", $false, $gen, $inst); continue }
    Start-Listen $false "Choom" $gen $inst $cmd.wav | Out-Null
  }
  elseif ($name -eq "test_speak") {
    if (-not $testMode) { [ChoomVoiceSink]::Error("Test output is not enabled in production.", $false, $gen, $inst); continue }
    Invoke-Speak $cmd.text "" 0 100 $gen $inst $cmd.wav
  }
  elseif ($name -eq "shutdown") { Stop-Recognition; Stop-Audio $gen $inst; break }
  else { [ChoomVoiceSink]::Error(("Unknown command: " + $name), $true, $gen, $inst) }
}
