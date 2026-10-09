# Choom voice runtime helper (Windows PowerShell 5.1 + System.Speech + Whisper).
# Single hidden helper process owned by Rust. JSON lines on stdin/stdout.
# No console flash: Rust spawns powershell with CREATE_NO_WINDOW.
# Real microphone capture via System.Speech.Recognition, real local speech
# via System.Speech.Synthesis. Bounded buffers, no disk recordings.
# Local Whisper dictation captures bounded microphone audio via WinMM to a
# temporary WAV, then transcribes offline with whisper-cli.exe (6 threads,
# names-only prompt). Standby stays with the lightweight keyword recognizer.
# Temp WAVs are removed on completion, cancellation and startup.
#
# Recognition and synthesis callbacks live in embedded C# so they serialize
# synchronized bounded JSON straight to stdout from any thread. No
# Register-ObjectEvent, no Out-Host: event output can never land on the
# wrong stream or die in a runspace. Whisper capture and transcription also
# run in C# background tasks, so the stdin loop stays responsive to stop,
# mute, pause, lock and shutdown while transcribing.
#
# Protocol (stdin, one JSON object per line, max 64KB). Every command carries
# the Rust-owned "instance" epoch, echoed unchanged on every event:
#   {"cmd":"probe"}                                      -> capability lists
#   {"cmd":"listen","generation":N,"instance":M}          -> system dictation
#   {"cmd":"listen","backend":"whisper","model":"base",
#    "binary":"C:\\...\\whisper-cli.exe",
#    "modelPath":"C:\\...\\ggml-base.bin",
#    "generation":N,"instance":M}                         -> whisper capture
#   {"cmd":"whisper_finish","instance":M}                 -> stop capture, transcribe
#   {"cmd":"wake_on","phrase":"Choom","generation":N,"instance":M}
#                                                        -> keyword listener
#   {"cmd":"stop","instance":M}                           -> stop recognition,
#      for whisper: cancel capture/transcription and clean temp, no final
#   {"cmd":"recover","generation":N,"instance":M}         -> recreate recognizer
#   {"cmd":"speak","text":"...","voice":"","rate":0,"volume":100,
#    "generation":N,"instance":M}                         -> async talkback
#   {"cmd":"stop_audio","generation":N,"instance":M}      -> stop speech now
#   {"cmd":"whisper_status"}                              -> whisper availability
#   {"cmd":"shutdown"}                                    -> clean exit, clean temp
# Test-only WAV commands (no mic, no speaker). They work only when this
# process starts with CHOOM_VOICE_TEST=1; production never sets it, so a
# test command can never be selected by accident:
#   {"cmd":"test_listen","wav":"C:\\...\\in.wav","generation":N,"instance":M}
#   {"cmd":"test_speak","text":"...","wav":"C:\\...\\out.wav",
#    "generation":N,"instance":M}
#   {"cmd":"test_whisper","wav":"C:\\...\\in.wav","model":"base",
#    "generation":N,"instance":M}                          -> transcribe file, no mic
#
# Protocol (stdout, one JSON object per line):
#   {"type":"ready","instance":0}
#   {"type":"capability","recognizers":[...],"voices":[...]}
#   {"type":"partial","text":"...","generation":N,"instance":M}
#   {"type":"final","text":"...","generation":N,"instance":M}
#   {"type":"transcribing","generation":N,"instance":M}
#   {"type":"empty","generation":N,"instance":M}           -> silence, no submit
#   {"type":"wake","phrase":"Choom","generation":N,"instance":M}
#   {"type":"speech_started","generation":N,"instance":M}
#   {"type":"speech_ended","generation":N,"instance":M}
#   {"type":"recovered","generation":N,"instance":M}
#   {"type":"error","message":"...","recoverable":true,
#    "generation":N,"instance":M}
#   {"type":"stopped","generation":0,"instance":M}
# Whisper provides final transcription only, no live provisional captions.

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

  public static void Attach(SpeechRecognitionEngine r, long gen, long inst, bool wake, bool testInput) {
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
        if (wake) {
          if (e.Result.Confidence >= 0.55f) Wake(e.Result.Text, gen, inst);
        }
        else Final(e.Result.Text, gen, inst);
      } catch {}
    };
    r.RecognizeCompleted += (sender, e) => {
      try {
        if (!object.ReferenceEquals(sender, OwnedRecognizer)) return;
        if (testInput) Simple("input_completed", gen, inst);
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

public static class ChoomWhisper {
  public static readonly object Gate = new object();
  public static long ActiveGen = -1;
  public static long ActiveInst = -1;
  public static string ActiveTempWav = null;
  public static string ActiveModel = "base";
  public static string BinaryPath = null;
  public static string ModelBasePath = null;
  public static string ModelSmallPath = null;
  public static int Threads = 6;
  public static int MaxSeconds = 30;
  public static bool Recording = false;
  public static System.Diagnostics.Process ActiveProcess = null;
  public static System.Threading.CancellationTokenSource ActiveCts = null;

  [System.Runtime.InteropServices.DllImport("winmm.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
  static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int retLen, System.IntPtr hwnd);

  static bool IsTrusted(string path, string expectedFile) {
    try {
      if (path == null || path.Length == 0) return false;
      if (path.IndexOf('"') >= 0 || path.IndexOf('\n') >= 0 || path.IndexOf('\r') >= 0) return false;
      string file = System.IO.Path.GetFileName(path);
      if (!string.Equals(file, expectedFile, System.StringComparison.OrdinalIgnoreCase)) return false;
      if (!System.IO.Path.IsPathRooted(path)) return false;
      return System.IO.File.Exists(path);
    } catch { return false; }
  }

  public static void CleanupStaleTemps() {
    try {
      string tmp = System.IO.Path.GetTempPath();
      string[] files = System.IO.Directory.GetFiles(tmp, "choom-whisper-*.wav");
      foreach (string f in files) {
        try { System.IO.File.Delete(f); } catch {}
      }
    } catch {}
  }

  static string CleanOutput(string raw) {
    if (raw == null) return "";
    string[] lines = raw.Split(new char[] { '\r', '\n' }, System.StringSplitOptions.RemoveEmptyEntries);
    System.Text.StringBuilder sb = new System.Text.StringBuilder();
    foreach (string ln in lines) {
      string t = ln.Trim();
      if (t.Length == 0) continue;
      // Strip timestamp prefixes like [00:00:00.000 --> 00:00:04.000] when present.
      if (t.Length > 0 && t[0] == '[') {
        int close = t.IndexOf(']');
        if (close > 0 && close < 60) {
          t = t.Substring(close + 1).Trim();
          if (t.Length == 0) continue;
        }
      }
      if (sb.Length > 0) sb.Append(" ");
      sb.Append(t);
      if (sb.Length > 4000) break;
    }
    string out_ = sb.ToString().Trim();
    if (out_.Length > 2000) out_ = out_.Substring(0, 2000);
    return out_;
  }

  static bool IsBlank(string text) {
    if (text == null) return true;
    string clean = text.Trim();
    if (clean.Length == 0) return true;
    string lower = clean.ToLowerInvariant();
    if (lower == "[blank_audio]" || lower == "[blank audio]" || lower == "[silence]"
      || lower == "(silence)" || lower == "*silence*" || lower == "[no speech]" || lower == "(no speech)") return true;
    System.Text.StringBuilder sb = new System.Text.StringBuilder();
    foreach (char c in lower) {
      if ((c >= 'a' && c <= 'z') || c == ' ') sb.Append(c);
    }
    string collapsed = System.Text.RegularExpressions.Regex.Replace(sb.ToString(), "\\s+", " ").Trim();
    if (collapsed == "silence" || collapsed == "blank audio" || collapsed == "no speech") return true;
    return false;
  }

  static void EmitEmpty(long gen, long inst) {
    ChoomVoiceSink.Emit("{\"type\":\"empty\",\"generation\":" + gen + ",\"instance\":" + inst + "}");
  }

  public static bool StartRecording(long gen, long inst, string binary, string modelPath, string modelId, int maxSeconds) {
    lock (Gate) {
      CancelLocked();
      string expected = (modelId == "small") ? "ggml-small.bin" : "ggml-base.bin";
      string mid = (modelId == "small") ? "small" : "base";
      if (!IsTrusted(binary, "whisper-cli.exe")) {
        ChoomVoiceSink.Error("Whisper binary missing. Reinstall Choom with the voice runtime.", true, gen, inst);
        return false;
      }
      if (!IsTrusted(modelPath, expected)) {
        if (mid == "small") ChoomVoiceSink.Error("Small model is not installed. Place ggml-small.bin in the whisper folder, or switch to Base.", true, gen, inst);
        else ChoomVoiceSink.Error("Base model missing. Reinstall Choom with the voice runtime.", true, gen, inst);
        return false;
      }
      int secs = maxSeconds;
      if (secs < 5) secs = 5;
      if (secs > 60) secs = 60;
      string tmp = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "choom-whisper-" + gen + "-" + System.Diagnostics.Process.GetCurrentProcess().Id + ".wav");
      try { if (System.IO.File.Exists(tmp)) System.IO.File.Delete(tmp); } catch {}
      int rc = mciSendString("open new Type waveaudio Alias choom_whisper", null, 0, System.IntPtr.Zero);
      if (rc != 0) {
        ChoomVoiceSink.Error("Microphone unavailable: could not open the recorder.", true, gen, inst);
        return false;
      }
      mciSendString("set choom_whisper time format ms", null, 0, System.IntPtr.Zero);
      mciSendString("set choom_whisper bitspersample 16", null, 0, System.IntPtr.Zero);
      mciSendString("set choom_whisper channels 1", null, 0, System.IntPtr.Zero);
      mciSendString("set choom_whisper samplespersec 16000", null, 0, System.IntPtr.Zero);
      rc = mciSendString("record choom_whisper", null, 0, System.IntPtr.Zero);
      if (rc != 0) {
        try { mciSendString("close choom_whisper", null, 0, System.IntPtr.Zero); } catch {}
        ChoomVoiceSink.Error("Microphone unavailable: recording did not start.", true, gen, inst);
        return false;
      }
      ActiveGen = gen;
      ActiveInst = inst;
      ActiveTempWav = tmp;
      ActiveModel = mid;
      BinaryPath = binary;
      if (mid == "small") ModelSmallPath = modelPath; else ModelBasePath = modelPath;
      if (mid == "small" && ModelBasePath == null) { }
      MaxSeconds = secs;
      Recording = true;
      try { if (ActiveCts != null) ActiveCts.Dispose(); } catch {}
      ActiveCts = new System.Threading.CancellationTokenSource();
      System.Threading.CancellationToken token = ActiveCts.Token;
      long autoGen = gen;
      long autoInst = inst;
      System.Threading.Tasks.Task.Delay(secs * 1000, token).ContinueWith(delegate(System.Threading.Tasks.Task t {
        if (t.IsCanceled) return;
        try { StopAndTranscribe(autoGen, autoInst); } catch {}
      });
      ChoomVoiceSink.Simple("listening", gen, inst);
      return true;
    }
  }

  public static void StopAndTranscribe(long gen, long inst) {
    string wav = null;
    string binary = null;
    string modelPath = null;
    lock (Gate) {
      if (!Recording || ActiveTempWav == null) return;
      if (gen != ActiveGen || inst != ActiveInst) return;
      Recording = false;
      wav = ActiveTempWav;
      binary = BinaryPath;
      modelPath = (ActiveModel == "small") ? ModelSmallPath : ModelBasePath;
      try { mciSendString("stop choom_whisper", null, 0, System.IntPtr.Zero); } catch {}
      string saveCmd = "save choom_whisper \"" + wav.Replace("\"", "") + "\"";
      int rc = mciSendString(saveCmd, null, 0, System.IntPtr.Zero);
      try { mciSendString("close choom_whisper", null, 0, System.IntPtr.Zero); } catch {}
      if (rc != 0) {
        try { if (System.IO.File.Exists(wav)) System.IO.File.Delete(wav); } catch {}
        ActiveTempWav = null;
        ActiveGen = -1;
        ActiveInst = -1;
        ChoomVoiceSink.Error("Microphone unavailable: could not save the recording.", true, gen, inst);
        return;
      }
      ChoomVoiceSink.Simple("transcribing", gen, inst);
    }
    string cWav = wav;
    string cBin = binary;
    string cModel = modelPath;
    long cGen = gen;
    long cInst = inst;
    System.Threading.Tasks.Task.Run(new System.Action(delegate() {
      TranscribeFile(cWav, cBin, cModel, cGen, cInst, true);
    }));
  }

  static void TranscribeFile(string wav, string binary, string modelPath, long gen, long inst, bool deleteInput) {
    System.Diagnostics.Process proc = null;
    try {
      lock (Gate) {
        if (gen != ActiveGen || inst != ActiveInst) {
          if (deleteInput) { try { if (System.IO.File.Exists(wav)) System.IO.File.Delete(wav); } catch {} }
          return;
        }
        System.Diagnostics.ProcessStartInfo psi = new System.Diagnostics.ProcessStartInfo();
        psi.FileName = binary;
        // Trusted args only: model, wav, threads, names-only prompt. Speech text is output only, never an arg.
        psi.Arguments = "-m \"" + modelPath.Replace("\"", "") + "\" -f \"" + wav.Replace("\"", "") + "\" -t 6 -l auto --prompt \"Choom, Spotify, Visual Studio Code\" --no-prints --no-timestamps";
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = false;
        psi.CreateNoWindow = true;
        proc = new System.Diagnostics.Process();
        proc.StartInfo = psi;
        ActiveProcess = proc;
      }
      bool started = false;
      try { started = proc.Start(); } catch (System.Exception) { started = false; }
      if (!started) {
        lock (Gate) { ActiveProcess = null; }
        if (deleteInput) { try { if (System.IO.File.Exists(wav)) System.IO.File.Delete(wav); } catch {} }
        ChoomVoiceSink.Error("Transcription failed: could not start Whisper.", true, gen, inst);
        lock (Gate) { if (gen == ActiveGen && inst == ActiveInst) { ActiveTempWav = null; ActiveGen = -1; ActiveInst = -1; } }
        return;
      }
      bool exited = proc.WaitForExit(120000);
      string output = "";
      try { output = proc.StandardOutput.ReadToEnd(); } catch {}
      lock (Gate) { ActiveProcess = null; }
      if (deleteInput) { try { if (System.IO.File.Exists(wav)) System.IO.File.Delete(wav); } catch {} }
      lock (Gate) {
        if (gen != ActiveGen || inst != ActiveInst) return;
        ActiveTempWav = null;
        ActiveGen = -1;
        ActiveInst = -1;
      }
      if (!exited) {
        try { proc.Kill(); } catch {}
        ChoomVoiceSink.Error("Transcription timed out. Try a shorter utterance.", true, gen, inst);
        return;
      }
      int code = 0;
      try { code = proc.ExitCode; } catch {}
      if (code != 0 && (output == null || output.Trim().Length == 0)) {
        ChoomVoiceSink.Error("Transcription failed. Check the microphone and try again.", true, gen, inst);
        return;
      }
      string clean = CleanOutput(output);
      if (IsBlank(clean)) {
        EmitEmpty(gen, inst);
        return;
      }
      ChoomVoiceSink.Final(clean, gen, inst);
    } catch (System.Exception) {
      try { if (deleteInput && System.IO.File.Exists(wav)) System.IO.File.Delete(wav); } catch {}
      try { ChoomVoiceSink.Error("Transcription failed. Check the microphone and try again.", true, gen, inst); } catch {}
      lock (Gate) { if (gen == ActiveGen && inst == ActiveInst) { ActiveTempWav = null; ActiveGen = -1; ActiveInst = -1; } }
    } finally {
      try { if (proc != null) proc.Dispose(); } catch {}
    }
  }

  public static bool TestTranscribe(string wav, string binary, string modelPath, string modelId, long gen, long inst) {
    lock (Gate) {
      CancelLocked();
      string expected = (modelId == "small") ? "ggml-small.bin" : "ggml-base.bin";
      if (!IsTrusted(binary, "whisper-cli.exe")) {
        ChoomVoiceSink.Error("Whisper binary missing. Reinstall Choom with the voice runtime.", true, gen, inst);
        return false;
      }
      if (!IsTrusted(modelPath, expected)) {
        ChoomVoiceSink.Error("Model file missing for the test transcription.", true, gen, inst);
        return false;
      }
      if (wav == null || wav.Length == 0 || !System.IO.File.Exists(wav)) {
        ChoomVoiceSink.Error("Test WAV not found.", true, gen, inst);
        return false;
      }
      ActiveGen = gen;
      ActiveInst = inst;
      ActiveTempWav = null;
      BinaryPath = binary;
      if (modelId == "small") ModelSmallPath = modelPath; else ModelBasePath = modelPath;
      ActiveModel = (modelId == "small") ? "small" : "base";
      ChoomVoiceSink.Simple("transcribing", gen, inst);
    }
    string cWav = wav;
    string cBin = binary;
    string cModel = modelPath;
    long cGen = gen;
    long cInst = inst;
    System.Threading.Tasks.Task.Run(new System.Action(delegate() {
      TranscribeFile(cWav, cBin, cModel, cGen, cInst, false);
    }));
    return true;
  }

  public static void Cancel() {
    lock (Gate) { CancelLocked(); }
  }

  static void CancelLocked() {
    try { if (Recording) { mciSendString("stop choom_whisper", null, 0, System.IntPtr.Zero); } } catch {}
    try { mciSendString("close choom_whisper", null, 0, System.IntPtr.Zero); } catch {}
    Recording = false;
    try { if (ActiveCts != null) ActiveCts.Cancel(); } catch {}
    try { if (ActiveCts != null) ActiveCts.Dispose(); } catch {}
    ActiveCts = null;
    try { if (ActiveProcess != null && !ActiveProcess.HasExited) ActiveProcess.Kill(); } catch {}
    try { if (ActiveProcess != null) ActiveProcess.Dispose(); } catch {}
    ActiveProcess = null;
    try { if (ActiveTempWav != null && System.IO.File.Exists(ActiveTempWav)) System.IO.File.Delete(ActiveTempWav); } catch {}
    ActiveTempWav = null;
    ActiveGen = -1;
    ActiveInst = -1;
  }
}
"@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies @("System.Speech") -ErrorAction Stop

$script:instance = 0
$script:mode = "idle"
$script:phrase = "Choom"
$script:generation = 0
$script:whisperModel = "base"
$script:whisperBinary = ""
$script:whisperModelPath = ""

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
  try { [ChoomWhisper]::Cancel() } catch {}
  [ChoomVoiceSink]::Detach()
  $script:mode = "idle"
}

function Get-WhisperDir {
  $candidates = @()
  if ($PSScriptRoot -ne $null -and $PSScriptRoot -ne "") {
    $candidates += (Join-Path $PSScriptRoot "whisper")
  }
  try {
    $scriptPath = $MyInvocation.PSScriptRoot
    if ($scriptPath -ne $null -and $scriptPath -ne "" -and $candidates -notcontains (Join-Path $scriptPath "whisper")) {
      $candidates += (Join-Path $scriptPath "whisper")
    }
  } catch {}
  if ($env:LOCALAPPDATA -ne $null -and $env:LOCALAPPDATA -ne "") {
    $candidates += (Join-Path (Join-Path $env:LOCALAPPDATA "Coucou") "whisper")
  }
  foreach ($d in $candidates) {
    if ($d -ne $null -and $d -ne "" -and (Test-Path $d)) { return $d }
  }
  if ($candidates.Count -gt 0) { return $candidates[0] }
  return $null
}

function Get-WhisperPaths($modelId) {
  $mid = "base"
  if ($modelId -eq "small") { $mid = "small" }
  $expected = "ggml-base.bin"
  if ($mid -eq "small") { $expected = "ggml-small.bin" }
  $dirs = @()
  if ($PSScriptRoot -ne $null -and $PSScriptRoot -ne "") { $dirs += (Join-Path $PSScriptRoot "whisper") }
  if ($env:LOCALAPPDATA -ne $null -and $env:LOCALAPPDATA -ne "") {
    $dirs += (Join-Path (Join-Path $env:LOCALAPPDATA "Coucou") "whisper")
  }
  foreach ($d in $dirs) {
    $bin = Join-Path $d "whisper-cli.exe"
    $mod = Join-Path $d $expected
    if ((Test-Path $bin) -and (Test-Path $mod)) {
      return @{ binary = $bin; modelPath = $mod; model = $mid }
    }
  }
  return $null
}

function Start-WhisperListen($modelId, $gen, $inst, $binPath, $modelPath) {
  try { [ChoomWhisper]::Cancel() } catch {}
  [ChoomVoiceSink]::Detach()
  $mid = "base"
  if ($modelId -eq "small") { $mid = "small" }
  $bin = $binPath
  $mod = $modelPath
  if (($bin -eq $null -or $bin -eq "") -or ($mod -eq $null -or $mod -eq "")) {
    $resolved = Get-WhisperPaths $mid
    if ($resolved -eq $null) {
      if ($mid -eq "small") {
        [ChoomVoiceSink]::Error("Small model is not installed. Place ggml-small.bin in the whisper folder, or switch to Base.", $true, $gen, $inst)
      } else {
        [ChoomVoiceSink]::Error("Whisper binary missing. Reinstall Choom with the voice runtime.", $true, $gen, $inst)
      }
      return $false
    }
    $bin = $resolved.binary
    $mod = $resolved.modelPath
  }
  $script:mode = "whisper_listen"
  $script:phrase = "Choom"
  $script:generation = $gen
  $script:instance = $inst
  $script:whisperModel = $mid
  $script:whisperBinary = $bin
  $script:whisperModelPath = $mod
  $ok = $false
  try { $ok = [ChoomWhisper]::StartRecording($gen, $inst, $bin, $mod, $mid, 30) } catch {
    [ChoomVoiceSink]::Error(("Whisper capture failed: " + $_.Exception.Message), $true, $gen, $inst)
    $script:mode = "idle"
    return $false
  }
  if (-not $ok) { $script:mode = "idle"; return $false }
  return $true
}

function Invoke-WhisperFinish($gen, $inst) {
  if ($script:mode -ne "whisper_listen" -and $script:mode -ne "whisper_transcribing") {
    Emit-Stopped $inst
    return
  }
  $script:mode = "whisper_transcribing"
  try { [ChoomWhisper]::StopAndTranscribe($script:generation, $script:instance) } catch {
    [ChoomVoiceSink]::Error(("Transcription failed: " + $_.Exception.Message), $true, $gen, $inst)
    $script:mode = "idle"
  }
}

function Cancel-Whisper {
  try { [ChoomWhisper]::Cancel() } catch {}
  if ($script:mode -like "whisper*") { $script:mode = "idle" }
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
      # Explicit pronunciation avoids guessing an invented dictionary word.
      $doc = New-Object System.Speech.Recognition.SrgsGrammar.SrgsDocument
      $doc.Culture = $r.RecognizerInfo.Culture
      $doc.PhoneticAlphabet = [System.Speech.Recognition.SrgsGrammar.SrgsPhoneticAlphabet]::Sapi
      $rule = New-Object System.Speech.Recognition.SrgsGrammar.SrgsRule("wake")
      $prefix = New-Object System.Speech.Recognition.SrgsGrammar.SrgsItem(0, 1)
      $prefix.Add((New-Object System.Speech.Recognition.SrgsGrammar.SrgsToken("hey")))
      $rule.Add($prefix)
      $token = New-Object System.Speech.Recognition.SrgsGrammar.SrgsToken($phrase)
      if ($phrase -ieq "Choom") { $token.Pronunciation = "ch uw m" }
      $rule.Add($token)
      # A command immediately after the name still wakes the island.
      $tail = New-Object System.Speech.Recognition.SrgsGrammar.SrgsItem(0, 1)
      $tail.Add([System.Speech.Recognition.SrgsGrammar.SrgsRuleRef]::Garbage)
      $rule.Add($tail)
      $doc.Rules.Add($rule)
      $doc.Root = $rule
      $g = New-Object System.Speech.Recognition.Grammar($doc)
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
  [ChoomVoiceSink]::Attach($r, $gen, $inst, $wakeOnly, [bool]($testWav))
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
  [ChoomVoiceSink]::Simple($(if ($wakeOnly) { "wake_on" } else { "listening" }), $gen, $inst)
  return $true
}

function Invoke-Recover($gen, $inst) {
  # Default-device failure recovery recreates the recognizer in the mode it
  # died in, bounded Rust side. Errors stay visible, never fake standby.
  if ($script:mode -eq "wake") {
    $ok = Start-Listen $true $script:phrase $gen $inst $null
  } elseif ($script:mode -eq "listen") {
    $ok = Start-Listen $false "Choom" $gen $inst $null
  } elseif ($script:mode -eq "whisper_listen" -or $script:mode -eq "whisper_transcribing") {
    try { [ChoomWhisper]::Cancel() } catch {}
    $mid = "base"
    if ($script:whisperModel -eq "small") { $mid = "small" }
    $ok = Start-WhisperListen $mid $gen $inst $script:whisperBinary $script:whisperModelPath
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
try { [ChoomWhisper]::CleanupStaleTemps() } catch {}

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
  elseif ($name -eq "whisper_status") {
    $st = Get-WhisperPaths "base"
    $small = Get-WhisperPaths "small"
    $hasBin = $false
    $hasBase = $false
    $hasSmall = $false
    if ($st -ne $null) { $hasBin = $true; $hasBase = $true }
    if ($small -ne $null) { $hasSmall = $true }
    [ChoomVoiceSink]::Emit((@{ type = "capability"; whisperBinary = $hasBin; whisperBase = $hasBase; whisperSmall = $hasSmall; generation = $gen; instance = $inst } | ConvertTo-Json -Compress -Depth 4))
  }
  elseif ($name -eq "listen") {
    $backend = $cmd.backend
    if ($backend -eq $null) { $backend = "" }
    $model = $cmd.model
    if ($model -eq $null -or $model -eq "") { $model = "base" }
    if ($model -ne "base" -and $model -ne "small") { $model = "base" }
    if ($backend -eq "whisper") {
      $bin = $cmd.binary
      $modPath = $cmd.modelPath
      if ($bin -eq $null) { $bin = "" }
      if ($modPath -eq $null) { $modPath = "" }
      Start-WhisperListen $model $gen $inst $bin $modPath | Out-Null
    } else {
      Start-Listen $false "Choom" $gen $inst $null | Out-Null
    }
  }
  elseif ($name -eq "whisper_finish") {
    Invoke-WhisperFinish $gen $inst
  }
  elseif ($name -eq "wake_on") {
    $p = $cmd.phrase
    if ($p -eq $null -or $p -eq "") { $p = "Choom" }
    Start-Listen $true $p $gen $inst $null | Out-Null
  }
  elseif ($name -eq "stop") {
    if ($script:mode -like "whisper*") { Cancel-Whisper; Emit-Stopped $inst }
    else { Stop-Recognition; Emit-Stopped $inst }
  }
  elseif ($name -eq "recover") {
    Invoke-Recover $gen $inst
  }
  elseif ($name -eq "speak") { Invoke-Speak $cmd.text $cmd.voice $cmd.rate $cmd.volume $gen $inst $null }
  elseif ($name -eq "stop_audio") { Stop-Audio $gen $inst }
  elseif ($name -eq "test_listen") {
    if (-not $testMode) { [ChoomVoiceSink]::Error("Test input is not enabled in production.", $false, $gen, $inst); continue }
    Start-Listen $false "Choom" $gen $inst $cmd.wav | Out-Null
  }
  elseif ($name -eq "test_wake") {
    if (-not $testMode) { [ChoomVoiceSink]::Error("Test input is not enabled in production.", $false, $gen, $inst); continue }
    Start-Listen $true "Choom" $gen $inst $cmd.wav | Out-Null
  }
  elseif ($name -eq "test_speak") {
    if (-not $testMode) { [ChoomVoiceSink]::Error("Test output is not enabled in production.", $false, $gen, $inst); continue }
    Invoke-Speak $cmd.text "" 0 100 $gen $inst $cmd.wav
  }
  elseif ($name -eq "test_whisper") {
    if (-not $testMode) { [ChoomVoiceSink]::Error("Test input is not enabled in production.", $false, $gen, $inst); continue }
    $model = $cmd.model
    if ($model -eq $null -or $model -eq "") { $model = "base" }
    if ($model -ne "base" -and $model -ne "small") { $model = "base" }
    $resolved = Get-WhisperPaths $model
    if ($resolved -eq $null) {
      [ChoomVoiceSink]::Error("Whisper binary or model missing for the test transcription.", $true, $gen, $inst)
      continue
    }
    $script:mode = "whisper_transcribing"
    $script:generation = $gen
    $script:instance = $inst
    try { [ChoomWhisper]::TestTranscribe($cmd.wav, $resolved.binary, $resolved.modelPath, $model, $gen, $inst) | Out-Null } catch {
      [ChoomVoiceSink]::Error(("Test transcription failed: " + $_.Exception.Message), $true, $gen, $inst)
      $script:mode = "idle"
    }
  }
  elseif ($name -eq "shutdown") { try { [ChoomWhisper]::Cancel() } catch {}; Stop-Recognition; Stop-Audio $gen $inst; break }
  else { [ChoomVoiceSink]::Error(("Unknown command: " + $name), $true, $gen, $inst) }
}
