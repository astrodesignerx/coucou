# Choom voice runtime helper (Windows PowerShell 5.1 + System.Speech + Whisper).
# Single hidden helper process owned by Rust. JSON lines on stdin/stdout.
# No console flash: Rust spawns powershell with CREATE_NO_WINDOW.
# Real microphone capture via System.Speech.Recognition, real local speech
# via System.Speech.Synthesis. Bounded buffers, no disk recordings.
# Local Whisper dictation captures bounded PCM audio via waveIn (16kHz mono
# 16-bit) into an app-private session directory, with silence detection on
# the endpoint delay from settings and a 30s absolute bound, then
# transcribes offline with a warm whisper-server.exe (6 threads, names-only
# prompt), falling back to whisper-cli.exe when the server is unavailable.
# Standby stays with the lightweight keyword recognizer. Temp WAVs are
# removed on completion, cancellation and age-gated startup cleanup.
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
#   {"cmd":"listen","backend":"whisper","model":"base","endpointMs":900,
#    "generation":N,"instance":M}                         -> whisper capture,
#      binary and model resolve to trusted local paths inside the helper
#   {"cmd":"whisper_finish","generation":N,"instance":M}  -> stop capture, transcribe
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
# Test-only commands (no mic, no speaker). They work only when this
# process starts with CHOOM_VOICE_TEST=1; production never sets it, so a
# test command can never be selected by accident:
#   {"cmd":"test_listen","wav":"C:\\...\\in.wav","generation":N,"instance":M}
#   {"cmd":"test_speak","text":"...","wav":"C:\\...\\out.wav",
#    "generation":N,"instance":M}
#   {"cmd":"test_whisper","wav":"C:\\...\\in.wav","model":"base",
#    "generation":N,"instance":M}                          -> transcribe file, no mic
#   {"cmd":"test_transcribe","wav":"C:\\...\\in.wav","model":"base",
#    "generation":N,"instance":M}                          -> text plus timing
#   {"cmd":"test_audio_ctx"}                              -> pure sizing assertions
#   {"cmd":"test_endpoint","wav":"C:\\...\\in.wav","endpointMs":500,
#    "generation":N,"instance":M}                          -> endpoint decision, no mic
#   {"cmd":"test_capture","source":"synth-silence","seconds":2,
#    "endpointMs":500,"model":"base",
#    "generation":N,"instance":M}                          -> full pipeline on
#      synthesized PCM without a microphone: detector, WAV, finalizer,
#      worker when speech is present, empty when it is not
#
# Protocol (stdout, one JSON object per line):
#   {"type":"ready","instance":0}
#   {"type":"capability","recognizers":[...],"voices":[...]}
#   {"type":"partial","text":"...","generation":N,"instance":M}
#   {"type":"final","text":"...","generation":N,"instance":M}
#   {"type":"transcribing","generation":N,"instance":M}
#   {"type":"empty","generation":N,"instance":M}           -> silence, no submit
#   {"type":"endpoint_test","hadSpeech":true,"reason":"endpoint",
#    "onsetMs":0,"endMs":1300,"frames":13,
#    "generation":N,"instance":M}                          -> test probe only
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
  public static long SynthGen = -1, SynthInst = -1;
  static int PendingSpeech = 0;

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
    lock (Gate) {
      if (!object.ReferenceEquals(s, OwnedSynth)) {
        OwnedSynth = s;
        SynthGen = gen;
        SynthInst = inst;
        PendingSpeech = 0;
        s.SpeakCompleted += (sender, e) => {
          try {
            lock (Gate) {
              if (!object.ReferenceEquals(sender, OwnedSynth)) return;
              PendingSpeech = Math.Max(0, PendingSpeech - 1);
              if (e.Error != null) Error("Speech failed: " + e.Error.Message, true, gen, inst);
              else if (PendingSpeech == 0) Simple("speech_ended", gen, inst);
            }
          } catch {}
        };
      }
      PendingSpeech++;
      try { s.SpeakAsync(text); } catch { PendingSpeech--; throw; }
    }
  }

  public static void StopAudio() {
    var s = OwnedSynth;
    if (s == null) return;
    try { s.SpeakAsyncCancelAll(); } catch {}
  }

  public static void DisposeAudio() {
    SpeechSynthesizer s;
    lock (Gate) {
      s = OwnedSynth;
      OwnedSynth = null;
      PendingSpeech = 0;
      SynthGen = -1;
      SynthInst = -1;
    }
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
  public static bool Recording = false;
  public static System.Diagnostics.Process ActiveProcess = null;
  public static System.Threading.CancellationTokenSource ActiveCts = null;
  static System.Net.HttpWebRequest ActiveRequest = null;
  static readonly object ServerGate = new object();
  static System.Diagnostics.Process ServerProcess = null;
  static string ServerModel = null;
  static string ServerUrl = null;
  static string ServerPidPath = null;
  static bool ServerClosed = false;
  static IntPtr ServerJob = IntPtr.Zero;

  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  struct JobLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ProcessCount;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, uint size);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  // Kill-on-close also covers the parent being terminated by Rust.
  static bool OwnServer(System.Diagnostics.Process process) {
    if (ServerJob == IntPtr.Zero) {
      ServerJob = CreateJobObject(IntPtr.Zero, null);
      JobLimits limits = new JobLimits();
      limits.Flags = 0x2000;
      if (ServerJob == IntPtr.Zero || !SetInformationJobObject(ServerJob, 9, ref limits,
          (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(JobLimits)))) {
        if (ServerJob != IntPtr.Zero) CloseHandle(ServerJob);
        ServerJob = IntPtr.Zero;
        return false;
      }
    }
    return AssignProcessToJobObject(ServerJob, process.Handle);
  }

  static void StopServerLocked() {
    if (ServerProcess != null) {
      try { if (!ServerProcess.HasExited) ServerProcess.Kill(); } catch {}
      try { ServerProcess.Dispose(); } catch {}
    }
    ServerProcess = null;
    ServerModel = null;
    ServerUrl = null;
    DeleteQuiet(ServerPidPath);
    ServerPidPath = null;
  }

  public static bool CleanupOrphanServer(string binary, string image, int pid, int parentPid) {
    try {
      string trusted = Path.Combine(Path.GetDirectoryName(binary), "whisper-server.exe");
      if (!IsTrusted(binary, "whisper-cli.exe") || !IsTrusted(trusted, "whisper-server.exe")) return false;
      if (!string.Equals(Path.GetFullPath(image), Path.GetFullPath(trusted), StringComparison.OrdinalIgnoreCase)) return false;
      try {
        using (var parent = System.Diagnostics.Process.GetProcessById(parentPid)) {
          if (!parent.HasExited) return false;
        }
      } catch (ArgumentException) {} catch { return false; }
      using (var process = System.Diagnostics.Process.GetProcessById(pid)) {
        if (!string.Equals(process.MainModule.FileName, trusted, StringComparison.OrdinalIgnoreCase)) return false;
        process.Kill();
      }
      return true;
    } catch { return false; }
  }

  public static void ShutdownServer() {
    lock (ServerGate) {
      ServerClosed = true;
      StopServerLocked();
      if (ServerJob != IntPtr.Zero) CloseHandle(ServerJob);
      ServerJob = IntPtr.Zero;
    }
  }

  static string EnsureServer(string binary, string modelPath) {
    lock (ServerGate) {
      if (ServerClosed) return null;
      if (ServerProcess != null && string.Equals(ServerModel, modelPath, StringComparison.OrdinalIgnoreCase)) {
        try { if (!ServerProcess.HasExited) return ServerUrl; } catch {}
      }
      StopServerLocked();
      string server = Path.Combine(Path.GetDirectoryName(binary), "whisper-server.exe");
      if (!IsTrusted(binary, "whisper-cli.exe") || !IsTrusted(server, "whisper-server.exe")) return null;
      try {
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        int port;
        try {
          listener.Start();
          port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        } finally { listener.Stop(); }
        var psi = new System.Diagnostics.ProcessStartInfo();
        psi.FileName = server;
        psi.Arguments = "-m \"" + modelPath.Replace("\"", "") + "\" --host 127.0.0.1 --port " + port + " -t 6 -l en -nt";
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        ServerProcess = new System.Diagnostics.Process();
        ServerProcess.StartInfo = psi;
        ServerProcess.OutputDataReceived += (sender, e) => {};
        ServerProcess.ErrorDataReceived += (sender, e) => {};
        Directory.CreateDirectory(SessionDir());
        ServerPidPath = Path.Combine(SessionDir(), "whisper-server.pid");
        if (!ServerProcess.Start()) throw new IOException("Could not start Whisper server.");
        File.WriteAllText(ServerPidPath, ServerProcess.Id.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (!OwnServer(ServerProcess)) throw new IOException("Could not own Whisper server.");
        ServerProcess.BeginOutputReadLine();
        ServerProcess.BeginErrorReadLine();
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (timer.ElapsedMilliseconds < 3000 && !ServerProcess.HasExited) {
          try {
            using (var socket = new System.Net.Sockets.TcpClient()) { socket.Connect("127.0.0.1", port); }
            ServerModel = modelPath;
            ServerUrl = "http://127.0.0.1:" + port;
            return ServerUrl;
          } catch { System.Threading.Thread.Sleep(25); }
        }
      } catch {}
      StopServerLocked();
      return null;
    }
  }

  public static void Prewarm(string binary, string modelPath) {
    System.Threading.Tasks.Task.Run(new Action(delegate() { EnsureServer(binary, modelPath); }));
  }

  public static int AudioContext(long wavBytes) {
    double seconds = Math.Max(0, wavBytes - 44) / 32000.0;
    return (int)Math.Max(384, Math.Min(1500, Math.Ceiling(seconds * 50) + 64));
  }

  static bool TryServer(string wav, string binary, string modelPath, long gen, long inst, int audioContext, out string output) {
    output = "";
    string url = EnsureServer(binary, modelPath);
    if (url == null) return false;
    System.Net.HttpWebRequest request = null;
    try {
      string boundary = "choom-" + Guid.NewGuid().ToString("N");
      byte[] payload;
      using (var body = new MemoryStream()) {
        string fields = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\ntext\r\n"
          + "--" + boundary + "\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\nChoom, Spotify, Visual Studio Code.\r\n"
          + "--" + boundary + "\r\nContent-Disposition: form-data; name=\"audio_ctx\"\r\n\r\n" + audioContext + "\r\n"
          + "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n";
        byte[] head = System.Text.Encoding.UTF8.GetBytes(fields);
        body.Write(head, 0, head.Length);
        using (var file = File.OpenRead(wav)) { file.CopyTo(body); }
        byte[] tail = System.Text.Encoding.UTF8.GetBytes("\r\n--" + boundary + "--\r\n");
        body.Write(tail, 0, tail.Length);
        payload = body.ToArray();
      }
      request = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(url + "/inference");
      request.Method = "POST";
      request.Proxy = null;
      request.Timeout = 5000;
      request.ReadWriteTimeout = 5000;
      request.ServicePoint.Expect100Continue = false;
      request.ContentType = "multipart/form-data; boundary=" + boundary;
      request.ContentLength = payload.Length;
      lock (Gate) {
        if (gen != ActiveGen || inst != ActiveInst) return false;
        ActiveRequest = request;
      }
      using (var stream = request.GetRequestStream()) { stream.Write(payload, 0, payload.Length); }
      using (var response = request.GetResponse())
      using (var reader = new StreamReader(response.GetResponseStream(), System.Text.Encoding.UTF8)) {
        output = reader.ReadToEnd();
      }
      return true;
    } catch { return false; }
    finally {
      lock (Gate) { if (ActiveRequest == request) ActiveRequest = null; }
      if (request != null) request.Abort();
    }
  }
  // Bounded PCM capture owns one open input device at a time. Buffers are
  // 100ms of 16kHz mono 16-bit audio, the same frames the detector reads.
  public static System.IntPtr WaveHandle = System.IntPtr.Zero;
  public static System.Collections.Generic.List<System.IntPtr> WaveHeaders = null;
  public static System.Collections.Generic.List<System.IntPtr> WaveBuffers = null;
  public static System.IO.FileStream WaveStream = null;
  public static ChoomEndpoint ActiveDetector = null;
  static WaveCallback waveCallback = null;

  const int WAVE_MAPPER = -1;
  const int CALLBACK_FUNCTION = 0x30000;
  const int WIM_DATA = 0x3C0;
  const int WAVE_BUFFER_BYTES = 3200;
  const int WAVE_BUFFER_COUNT = 4;

  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  struct WAVEFORMATEX {
    public short wFormatTag;
    public short nChannels;
    public int nSamplesPerSec;
    public int nAvgBytesPerSec;
    public short nBlockAlign;
    public short wBitsPerSample;
    public short cbSize;
  }

  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  struct WAVEHDR {
    public System.IntPtr lpData;
    public int dwBufferLength;
    public int dwBytesRecorded;
    public System.IntPtr dwUser;
    public int dwFlags;
    public int dwLoops;
    public System.IntPtr lpNext;
    public System.IntPtr reserved;
  }

  [System.Runtime.InteropServices.UnmanagedFunctionPointer(System.Runtime.InteropServices.CallingConvention.Winapi)]
  delegate void WaveCallback(System.IntPtr hwi, int uMsg, System.IntPtr dwInstance, System.IntPtr dwParam1, System.IntPtr dwParam2);

  [System.Runtime.InteropServices.DllImport("winmm.dll")]
  static extern int waveInGetNumDevs();
  [System.Runtime.InteropServices.DllImport("winmm.dll")]
  static extern int waveInOpen(out System.IntPtr phwi, int uDeviceID, ref WAVEFORMATEX pwfx, WaveCallback dwCallback, System.IntPtr dwInstance, int fdwOpen);
  [System.Runtime.InteropServices.DllImport("winmm.dll")]
  static extern int waveInPrepareHeader(System.IntPtr hwi, System.IntPtr pwh, int cbwh);
  [System.Runtime.InteropServices.DllImport("winmm.dll")]
  static extern int waveInUnprepareHeader(System.IntPtr hwi, System.IntPtr pwh, int cbwh);
  [System.Runtime.InteropServices.DllImport("winmm.dll")]
  static extern int waveInAddBuffer(System.IntPtr hwi, System.IntPtr pwh, int cbwh);
  [System.Runtime.InteropServices.DllImport("winmm.dll")]
  static extern int waveInStart(System.IntPtr hwi);
  [System.Runtime.InteropServices.DllImport("winmm.dll")]
  static extern int waveInStop(System.IntPtr hwi);
  [System.Runtime.InteropServices.DllImport("winmm.dll")]
  static extern int waveInReset(System.IntPtr hwi);
  [System.Runtime.InteropServices.DllImport("winmm.dll")]
  static extern int waveInClose(System.IntPtr hwi);

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

  // App-private session directory for this helper process. Temp WAVs live
  // here, never loose in the shared temp root.
  public static string SessionDir() {
    string pid = "";
    try { pid = System.Diagnostics.Process.GetCurrentProcess().Id.ToString(); } catch { pid = "0"; }
    return System.IO.Path.Combine(System.IO.Path.GetTempPath(), "choom-whisper-" + pid);
  }

  // Startup and crash-recovery cleanup with ownership and age protection.
  // Own session dir: remove every non-active file (they are ours). Anything
  // else is removed only when older than 24 hours, so another live helper
  // instance's active recording is never deleted. Young files always stay.
  public static void CleanupStaleTemps() {
    string own = null;
    try { own = SessionDir(); } catch {}
    try {
      if (own != null && System.IO.Directory.Exists(own)) {
        string[] mine = System.IO.Directory.GetFiles(own);
        foreach (string f in mine) {
          try {
            if (ActiveTempWav == null || !string.Equals(f, ActiveTempWav, System.StringComparison.OrdinalIgnoreCase)) {
              System.IO.File.Delete(f);
            }
          } catch {}
        }
      }
    } catch {}
    System.DateTime cut;
    try { cut = System.DateTime.UtcNow.AddHours(-24); } catch { return; }
    string tmp = null;
    try { tmp = System.IO.Path.GetTempPath(); } catch { return; }
    try {
      // Old-scheme loose files from earlier builds: age-gated only.
      string[] loose = System.IO.Directory.GetFiles(tmp, "choom-whisper-*.wav");
      foreach (string f in loose) {
        try { if (System.IO.File.GetLastWriteTimeUtc(f) < cut) System.IO.File.Delete(f); } catch {}
      }
    } catch {}
    try {
      string[] dirs = System.IO.Directory.GetDirectories(tmp, "choom-whisper-*");
      foreach (string d in dirs) {
        try {
          if (own != null && string.Equals(d, own, System.StringComparison.OrdinalIgnoreCase)) continue;
          if (System.IO.Directory.GetLastWriteTimeUtc(d) < cut) System.IO.Directory.Delete(d, true);
        } catch {}
      }
    } catch {}
  }

  static void DeleteQuiet(string path) {
    try { if (path != null && System.IO.File.Exists(path)) System.IO.File.Delete(path); } catch {}
  }

  static void WriteWavHeader(System.IO.FileStream fs, int dataLen) {
    byte[] h = new byte[44];
    h[0] = (byte)'R'; h[1] = (byte)'I'; h[2] = (byte)'F'; h[3] = (byte)'F';
    byte[] total = System.BitConverter.GetBytes(36 + dataLen);
    System.Array.Copy(total, 0, h, 4, 4);
    h[8] = (byte)'W'; h[9] = (byte)'A'; h[10] = (byte)'V'; h[11] = (byte)'E';
    h[12] = (byte)'f'; h[13] = (byte)'m'; h[14] = (byte)'t'; h[15] = (byte)' ';
    byte[] sixteen = System.BitConverter.GetBytes(16);
    System.Array.Copy(sixteen, 0, h, 16, 4);
    byte[] one = System.BitConverter.GetBytes((short)1);
    System.Array.Copy(one, 0, h, 20, 2);
    System.Array.Copy(one, 0, h, 22, 2);
    byte[] rate = System.BitConverter.GetBytes(16000);
    System.Array.Copy(rate, 0, h, 24, 4);
    byte[] bytesPerSec = System.BitConverter.GetBytes(32000);
    System.Array.Copy(bytesPerSec, 0, h, 28, 4);
    byte[] block = System.BitConverter.GetBytes((short)2);
    System.Array.Copy(block, 0, h, 32, 2);
    byte[] bits = System.BitConverter.GetBytes((short)16);
    System.Array.Copy(bits, 0, h, 34, 2);
    h[36] = (byte)'d'; h[37] = (byte)'a'; h[38] = (byte)'t'; h[39] = (byte)'a';
    byte[] data = System.BitConverter.GetBytes(dataLen);
    System.Array.Copy(data, 0, h, 40, 4);
    try { fs.Seek(0, System.IO.SeekOrigin.Begin); fs.Write(h, 0, 44); fs.Flush(); } catch {}
  }

  static string CleanOutput(string raw) {
    if (raw == null) return "";
    string[] lines = raw.Split(new char[] { '\r', '\n' }, System.StringSplitOptions.RemoveEmptyEntries);
    System.Text.StringBuilder sb = new System.Text.StringBuilder();
    foreach (string ln in lines) {
      string t = ln.Trim();
      if (t.Length == 0) continue;
      // Only valid whisper timestamp prefixes are stripped, of the form
      // [00:00:00.000 --> 00:00:04.000]. Any other leading bracket token
      // (markers, hallucinated labels) is kept so blank checks still see it.
      if (t.Length > 0 && t[0] == '[') {
        int close = t.IndexOf(']');
        if (close > 0 && close < 64) {
          string head = t.Substring(1, close - 1);
          if (IsTimestampHead(head)) {
            t = t.Substring(close + 1).Trim();
            if (t.Length == 0) continue;
          }
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

  static bool IsTimestampHead(string head) {
    string[] parts = null;
    try { parts = head.Split(new string[] { "-->" }, System.StringSplitOptions.None); } catch { return false; }
    if (parts == null || parts.Length != 2) return false;
    return IsStamp(parts[0].Trim()) && IsStamp(parts[1].Trim());
  }

  static bool IsStamp(string s) {
    // HH:MM:SS.mmm, fixed positions, digits only around separators.
    if (s == null || s.Length != 12) return false;
    if (s[2] != ':' || s[5] != ':' || s[8] != '.') return false;
    for (int i = 0; i < 12; i++) {
      if (i == 2 || i == 5 || i == 8) continue;
      char c = s[i];
      if (c < '0' || c > '9') return false;
    }
    return true;
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
    if (collapsed.Length > 0 && System.Text.RegularExpressions.Regex.IsMatch(collapsed, "^(choom|spotify|visual|studio|code)( (choom|spotify|visual|studio|code))*$")) return true;
    return false;
  }

  static void EmitEmpty(long gen, long inst) {
    ChoomVoiceSink.Emit("{\"type\":\"empty\",\"generation\":" + gen + ",\"instance\":" + inst + "}");
  }

  // Pure per-utterance endpoint detector over 16kHz mono 16-bit frames.
  // One implementation only: the live waveIn driver and the test file
  // driver both feed this class, so tests exercise production logic.
  // Frame energy contract (the fixture generator uses the same arithmetic
  // to validate its inputs): rms is sqrt(sum(s*s)/n) over 100ms frames;
  // speech starts a frame at rms 350 or above. Silence below that never
  // starts speech, and trailing silence of endpointMs after onset ends the
  // utterance. The 30s bound always wins. Finalization fires exactly once.
  public class ChoomEndpoint {
    public const int FrameSamples = 1600;
    public const int FrameMs = 100;
    public const double SpeechRms = 350.0;
    public const int TrimPadMs = 300;
    int endpointMs;
    int maxMs;
    System.Collections.Generic.List<short> pending;
    public int TotalFrames;
    public bool HadSpeech;
    public int OnsetFrame;
    public int TrailingSilenceFrames;
    public bool Finished;
    public string Reason;
    public int FinishFrame;

    public ChoomEndpoint(int endpointMs, int maxMs) {
      if (endpointMs < 300) endpointMs = 300;
      if (endpointMs > 3000) endpointMs = 3000;
      if (maxMs < 5000) maxMs = 5000;
      if (maxMs > 60000) maxMs = 60000;
      this.endpointMs = endpointMs;
      this.maxMs = maxMs;
      this.pending = new System.Collections.Generic.List<short>();
      this.TotalFrames = 0;
      this.HadSpeech = false;
      this.OnsetFrame = -1;
      this.TrailingSilenceFrames = 0;
      this.Finished = false;
      this.Reason = "";
      this.FinishFrame = -1;
    }

    public static double FrameRms(short[] frame, int count) {
      if (frame == null || count <= 0) return 0.0;
      double sum = 0.0;
      for (int i = 0; i < count; i++) {
        double s = (double)frame[i];
        sum += s * s;
      }
      return System.Math.Sqrt(sum / (double)count);
    }

    public void Push(short[] samples, int count) {
      if (samples == null || count <= 0) return;
      if (Finished) return;
      for (int i = 0; i < count; i++) {
        pending.Add(samples[i]);
        while (pending.Count >= FrameSamples && !Finished) {
          short[] frame = new short[FrameSamples];
          for (int k = 0; k < FrameSamples; k++) frame[k] = pending[k];
          pending.RemoveRange(0, FrameSamples);
          Classify(frame);
        }
        if (Finished) return;
      }
    }

    void Classify(short[] frame) {
      if (Finished) return;
      double rms = FrameRms(frame, FrameSamples);
      TotalFrames++;
      if (TotalFrames * FrameMs >= maxMs) {
        Finish("max");
        return;
      }
      if (rms >= SpeechRms) {
        if (!HadSpeech) {
          HadSpeech = true;
          OnsetFrame = TotalFrames - 1;
        }
        TrailingSilenceFrames = 0;
      } else if (HadSpeech) {
        TrailingSilenceFrames++;
        if (TrailingSilenceFrames * FrameMs >= endpointMs) {
          Finish("endpoint");
          return;
        }
      }
    }

    void Finish(string reason) {
      if (Finished) return;
      Finished = true;
      Reason = reason;
      FinishFrame = TotalFrames;
    }

    public void Eof() {
      if (Finished) return;
      if (!HadSpeech) Finish("none");
      else Finish("eof");
    }

    public int TrailingSilenceMs() {
      return TrailingSilenceFrames * FrameMs;
    }

    public int OnsetMs() {
      if (OnsetFrame < 0) return -1;
      return OnsetFrame * FrameMs;
    }

    public int EndMs() {
      if (FinishFrame < 0) return -1;
      return FinishFrame * FrameMs;
    }
  }

  public static bool StartRecording(long gen, long inst, string binary, string modelPath, string modelId, int endpointMs) {
    // Validate before touching any live job: a bad request never kills audio.
    // Trusted paths only, endpoint delay clamped to settings bounds.
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
    if (endpointMs < 300) endpointMs = 300;
    if (endpointMs > 3000) endpointMs = 3000;
    Prewarm(binary, modelPath);
    // Bounded single owner: the previous job dies outside Gate, so driver
    // reset can never wait on a lock this thread holds.
    TeardownBundle stale = null;
    lock (Gate) { stale = CancelPreviousLocked(); }
    TeardownBundleNow(stale);
    lock (Gate) {
      string session = null;
      try { session = SessionDir(); } catch { session = null; }
      if (session == null || session.Length == 0) {
        ChoomVoiceSink.Error("Microphone unavailable: could not prepare the session directory.", true, gen, inst);
        return false;
      }
      try { System.IO.Directory.CreateDirectory(session); } catch {
        ChoomVoiceSink.Error("Microphone unavailable: could not prepare the session directory.", true, gen, inst);
        return false;
      }
      string tmp = System.IO.Path.Combine(session, "utt-" + gen + ".wav");
      DeleteQuiet(tmp);
      if (waveInGetNumDevs() <= 0) {
        ChoomVoiceSink.Error("Microphone unavailable: no input device found.", true, gen, inst);
        return false;
      }
      WAVEFORMATEX fmt = new WAVEFORMATEX();
      fmt.wFormatTag = 1;
      fmt.nChannels = 1;
      fmt.nSamplesPerSec = 16000;
      fmt.nAvgBytesPerSec = 32000;
      fmt.nBlockAlign = 2;
      fmt.wBitsPerSample = 16;
      fmt.cbSize = 0;
      System.IntPtr h = System.IntPtr.Zero;
      WaveCallback cb = null;
      try { cb = new WaveCallback(WaveCallbackProc); } catch {
        ChoomVoiceSink.Error("Microphone unavailable: could not start capture.", true, gen, inst);
        return false;
      }
      int rc = waveInOpen(out h, WAVE_MAPPER, ref fmt, cb, System.IntPtr.Zero, CALLBACK_FUNCTION);
      if (rc != 0 || h == System.IntPtr.Zero) {
        ChoomVoiceSink.Error("Microphone unavailable: could not open the input device.", true, gen, inst);
        return false;
      }
      System.Collections.Generic.List<System.IntPtr> headers = new System.Collections.Generic.List<System.IntPtr>();
      System.Collections.Generic.List<System.IntPtr> buffers = new System.Collections.Generic.List<System.IntPtr>();
      bool prepared = false;
      try {
        int hdrSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(WAVEHDR));
        for (int i = 0; i < WAVE_BUFFER_COUNT; i++) {
          System.IntPtr data = System.Runtime.InteropServices.Marshal.AllocHGlobal(WAVE_BUFFER_BYTES);
          buffers.Add(data);
          WAVEHDR hdr = new WAVEHDR();
          hdr.lpData = data;
          hdr.dwBufferLength = WAVE_BUFFER_BYTES;
          hdr.dwBytesRecorded = 0;
          hdr.dwFlags = 0;
          hdr.dwLoops = 0;
          System.IntPtr pwh = System.Runtime.InteropServices.Marshal.AllocHGlobal(hdrSize);
          headers.Add(pwh);
          System.Runtime.InteropServices.Marshal.StructureToPtr(hdr, pwh, false);
          rc = waveInPrepareHeader(h, pwh, hdrSize);
          if (rc != 0) break;
          rc = waveInAddBuffer(h, pwh, hdrSize);
          if (rc != 0) break;
        }
        prepared = (headers.Count == WAVE_BUFFER_COUNT && rc == 0);
      } catch { prepared = false; }
      if (!prepared) {
        TeardownDevice(h, headers, buffers);
        ChoomVoiceSink.Error("Microphone unavailable: could not start capture.", true, gen, inst);
        return false;
      }
      System.IO.FileStream stream = null;
      try {
        stream = new System.IO.FileStream(tmp, System.IO.FileMode.Create, System.IO.FileAccess.ReadWrite, System.IO.FileShare.None);
        WriteWavHeader(stream, 0);
      } catch {
        TeardownDevice(h, headers, buffers);
        DeleteQuiet(tmp);
        ChoomVoiceSink.Error("Microphone unavailable: could not record audio.", true, gen, inst);
        return false;
      }
      rc = waveInStart(h);
      if (rc != 0) {
        try { stream.Close(); } catch {}
        TeardownDevice(h, headers, buffers);
        DeleteQuiet(tmp);
        ChoomVoiceSink.Error("Microphone unavailable: recording did not start.", true, gen, inst);
        return false;
      }
      ActiveGen = gen;
      ActiveInst = inst;
      ActiveTempWav = tmp;
      ActiveModel = mid;
      BinaryPath = binary;
      if (mid == "small") ModelSmallPath = modelPath; else ModelBasePath = modelPath;
      WaveHandle = h;
      WaveHeaders = headers;
      WaveBuffers = buffers;
      WaveStream = stream;
      waveCallback = cb;
      ActiveDetector = new ChoomEndpoint(endpointMs, 30000);
      Recording = true;
      try { if (ActiveCts != null) ActiveCts.Dispose(); } catch {}
      ActiveCts = new System.Threading.CancellationTokenSource();
      System.Threading.CancellationToken token = ActiveCts.Token;
      long autoGen = gen;
      long autoInst = inst;
      // Wall-clock backstop for a stalled device: the detector's own 30s
      // bound fires on audio, this fires when no audio arrives at all.
      System.Threading.Tasks.Task.Delay(35000, token).ContinueWith(delegate(System.Threading.Tasks.Task t) {
        if (t.IsCanceled) return;
        try { lock (Gate) { if (!Recording || ActiveGen != autoGen || ActiveInst != autoInst) return; } Cancel(); ChoomVoiceSink.Error("Microphone device stopped delivering audio. Recover and try again.", true, autoGen, autoInst); } catch {}
      });
      ChoomVoiceSink.Simple("listening", gen, inst);
      return true;
    }
  }

  static void WaveCallbackProc(System.IntPtr hwi, int uMsg, System.IntPtr dwInstance, System.IntPtr dwParam1, System.IntPtr dwParam2) {
    if (uMsg != WIM_DATA) return;
    long cGen = 0;
    long cInst = 0;
    bool finished = false;
    lock (Gate) {
      if (!Recording || WaveHandle == System.IntPtr.Zero || dwParam1 == System.IntPtr.Zero) return;
      if (hwi != WaveHandle) return;
      int recorded = 0;
      System.IntPtr data = System.IntPtr.Zero;
      try {
        recorded = System.Runtime.InteropServices.Marshal.ReadInt32(dwParam1, 12);
        data = System.Runtime.InteropServices.Marshal.ReadIntPtr(dwParam1, 0);
      } catch { return; }
      if (recorded <= 0 || data == System.IntPtr.Zero) {
        try { waveInAddBuffer(WaveHandle, dwParam1, System.Runtime.InteropServices.Marshal.SizeOf(typeof(WAVEHDR))); } catch {}
        return;
      }
      if (recorded > WAVE_BUFFER_BYTES) recorded = WAVE_BUFFER_BYTES;
      int samples = recorded / 2;
      short[] pcm = new short[samples];
      try { System.Runtime.InteropServices.Marshal.Copy(data, pcm, 0, samples); } catch { return; }
      try {
        if (WaveStream != null && WaveStream.CanWrite) WaveStream.Write(SystemToBytes(pcm, samples), 0, samples * 2);
      } catch {}
      try {
        if (ActiveDetector != null) ActiveDetector.Push(pcm, samples);
      } catch {}
      cGen = ActiveGen;
      cInst = ActiveInst;
      finished = (ActiveDetector != null && ActiveDetector.Finished);
      if (!finished) {
        try { waveInAddBuffer(WaveHandle, dwParam1, System.Runtime.InteropServices.Marshal.SizeOf(typeof(WAVEHDR))); } catch {}
      }
    }
    if (finished) {
      long fGen = cGen;
      long fInst = cInst;
      try {
        System.Threading.Tasks.Task.Run(new System.Action(delegate() {
          try { StopAndTranscribe(fGen, fInst); } catch {}
        }));
      } catch {}
    }
  }

  static byte[] SystemToBytes(short[] pcm, int count) {
    byte[] out_ = new byte[count * 2];
    for (int i = 0; i < count; i++) {
      byte[] b = System.BitConverter.GetBytes(pcm[i]);
      out_[i * 2] = b[0];
      out_[i * 2 + 1] = b[1];
    }
    return out_;
  }

  // Stops one detached device and releases its headers and buffers. Never
  // runs under Gate: reset can wait for a returning callback, and callbacks
  // never wait on a teardown. Headers free only after reset and unprepare;
  // a header that reports still-playing across retries is leaked rather
  // than freed live: kilobytes lost, never memory the driver still owns.
  static void TeardownDevice(System.IntPtr h, System.Collections.Generic.List<System.IntPtr> headers, System.Collections.Generic.List<System.IntPtr> buffers) {
    if (h != System.IntPtr.Zero) {
      try { waveInStop(h); } catch (System.Exception) {}
      try { waveInReset(h); } catch (System.Exception) {}
    }
    // Headers and buffers share list order: a leaked header keeps its
    // buffer too, so the driver never loses memory it still references.
    System.Collections.Generic.List<System.IntPtr> liveBuffers = buffers;
    if (headers != null) {
      int hdrSize = 0;
      try { hdrSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(WAVEHDR)); } catch (System.Exception) {}
      System.Collections.Generic.List<int> leaked = new System.Collections.Generic.List<int>();
      for (int i = 0; i < headers.Count; i++) {
        System.IntPtr pwh = (System.IntPtr)headers[i];
        if (pwh == System.IntPtr.Zero) continue;
        bool unprepared = false;
        if (h != System.IntPtr.Zero && hdrSize > 0) {
          for (int attempt = 0; attempt < 5 && !unprepared; attempt++) {
            int rc = 0;
            try { rc = waveInUnprepareHeader(h, pwh, hdrSize); } catch (System.Exception) { rc = 0; }
            if (rc == 0) unprepared = true;
            else {
              try { System.Threading.Thread.Sleep(20); } catch (System.Exception) {}
            }
          }
        } else {
          unprepared = true;
        }
        // Still playing after retries: leak this header and its buffer
        // instead of freeing memory the driver may still reference.
        if (!unprepared) {
          leaked.Add(i);
          continue;
        }
        try { System.Runtime.InteropServices.Marshal.FreeHGlobal(pwh); } catch (System.Exception) {}
      }
      if (buffers != null && leaked.Count > 0) {
        System.Collections.Generic.List<System.IntPtr> kept = new System.Collections.Generic.List<System.IntPtr>();
        for (int i = 0; i < buffers.Count; i++) {
          if (leaked.Contains(i)) continue;
          kept.Add((System.IntPtr)buffers[i]);
        }
        liveBuffers = kept;
      }
    }
    if (liveBuffers != null) {
      foreach (System.IntPtr data in liveBuffers) {
        if (data == System.IntPtr.Zero) continue;
        try { System.Runtime.InteropServices.Marshal.FreeHGlobal(data); } catch (System.Exception) {}
      }
    }
    if (h != System.IntPtr.Zero) {
      try { waveInClose(h); } catch (System.Exception) {}
    }
  }

  // Detached device handles for two-phase teardown. Gate holders never call
  // the driver: TakeDeviceLocked detaches statics without blocking, and the
  // caller runs the bundle outside Gate. waveInReset can wait for a
  // returning callback, and callbacks never wait on a teardown, so the two
  // can no longer deadlock. Headers are freed only after reset and
  // unprepare succeed or fail fast, tolerating WAVERR_STILLPLAYING noise.
  public class TeardownBundle {
    public System.IntPtr h;
    public System.Collections.Generic.List<System.IntPtr> headers;
    public System.Collections.Generic.List<System.IntPtr> buffers;
  }

  // Gate held. Detaches the open device so pending callbacks bail, without
  // touching the driver.
  static TeardownBundle TakeDeviceLocked() {
    TeardownBundle bundle = new TeardownBundle();
    bundle.h = WaveHandle;
    bundle.headers = WaveHeaders;
    bundle.buffers = WaveBuffers;
    Recording = false;
    WaveHandle = System.IntPtr.Zero;
    WaveHeaders = null;
    WaveBuffers = null;
    return bundle;
  }

  // No lock held. Stops, resets, unprepares, frees and closes one device.
  static void TeardownBundleNow(TeardownBundle bundle) {
    if (bundle == null) return;
    TeardownDevice(bundle.h, bundle.headers, bundle.buffers);
  }

  // Gate held. Cancels the current job without touching the driver and
  // returns its device for outside-Gate teardown. Kill and dispose are
  // non-blocking signals; only driver reset can wait.
  static TeardownBundle CancelPreviousLocked() {
    TeardownBundle bundle = TakeDeviceLocked();
    try {
      if (WaveStream != null) WaveStream.Close();
    } catch (System.Exception) {}
    WaveStream = null;
    if (ActiveDetector != null) ActiveDetector.Finished = true;
    ActiveDetector = null;
    try { if (ActiveRequest != null) ActiveRequest.Abort(); } catch {}
    ActiveRequest = null;
    try { if (ActiveCts != null) ActiveCts.Cancel(); } catch (System.Exception) {}
    try { if (ActiveCts != null) ActiveCts.Dispose(); } catch (System.Exception) {}
    ActiveCts = null;
    try {
      if (ActiveProcess != null) {
        bool live = false;
        try { live = !ActiveProcess.HasExited; } catch (System.Exception) { live = false; }
        if (live) {
          try { ActiveProcess.Kill(); } catch (System.Exception) {}
        }
      }
    } catch (System.Exception) {}
    try { if (ActiveProcess != null) ActiveProcess.Dispose(); } catch (System.Exception) {}
    ActiveProcess = null;
    DeleteQuiet(ActiveTempWav);
    ActiveTempWav = null;
    ActiveGen = -1;
    ActiveInst = -1;
    return bundle;
  }

  // Stops PCM capture and finalizes the session WAV. The device shuts down
  // outside Gate while the WAV stream stays owned here: closing the stream
  // first and reading it after always produced empty, so ownership now
  // transfers before teardown. Silence with no speech onset emits empty
  // directly: the worker never runs, so hallucinated vocabulary hints can
  // never execute. Finalization fires exactly once per utterance: second
  // calls find Recording already false and return.
  public static void StopAndTranscribe(long gen, long inst) {
    string wav = null;
    string binary = null;
    string modelPath = null;
    bool hadSpeech = false;
    bool endpointTrim = false;
    int trailingMs = 0;
    System.IO.FileStream stream = null;
    TeardownBundle bundle = null;
    lock (Gate) {
      if (!Recording || ActiveTempWav == null) return;
      if (gen != ActiveGen || inst != ActiveInst) return;
      wav = ActiveTempWav;
      binary = BinaryPath;
      modelPath = (ActiveModel == "small") ? ModelSmallPath : ModelBasePath;
      endpointTrim = (ActiveDetector != null && ActiveDetector.Finished && ActiveDetector.Reason == "endpoint");
      trailingMs = (ActiveDetector != null) ? ActiveDetector.TrailingSilenceMs() : 0;
      hadSpeech = (ActiveDetector != null && ActiveDetector.HadSpeech);
      stream = WaveStream;
      WaveStream = null;
      bundle = TakeDeviceLocked();
    }
    TeardownBundleNow(bundle);
    int dataLen = 0;
    try {
      if (stream != null) {
        dataLen = (int)(stream.Length - 44);
        if (dataLen < 0) dataLen = 0;
        // Auto endpoint trims trailing silence past a short pad, so the
        // worker hears speech, not a silence bed that invites hallucination.
        // Manual finish and the max bound keep the full utterance instead.
        if (endpointTrim && hadSpeech) {
          int trimMs = trailingMs - ChoomEndpoint.TrimPadMs;
          if (trimMs > 0) {
            int trimBytes = trimMs * 32;
            int keep = dataLen - trimBytes;
            if (keep < 3200) keep = dataLen < 3200 ? dataLen : 3200;
            try { stream.SetLength(44 + keep); } catch (System.Exception) {}
            dataLen = keep;
          }
        }
        WriteWavHeader(stream, dataLen);
      }
    } catch (System.Exception) { dataLen = 0; }
    try { if (stream != null) stream.Close(); } catch (System.Exception) {}
    if (!hadSpeech || dataLen <= 0) {
      DeleteQuiet(wav);
      lock (Gate) {
        if (gen == ActiveGen && inst == ActiveInst) {
          ActiveTempWav = null;
          ActiveGen = -1;
          ActiveInst = -1;
        }
      }
      EmitEmpty(gen, inst);
      return;
    }
    lock (Gate) {
      // A discard that landed during teardown owns the turn now: stay silent.
      if (gen != ActiveGen || inst != ActiveInst) {
        DeleteQuiet(wav);
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

  static bool IsOwner(System.Diagnostics.Process proc, long gen, long inst) {
    // Ownership is the process reference plus the generation: completion
    // clears and emits only for the worker that still owns the turn.
    return (proc != null && ActiveProcess == proc && gen == ActiveGen && inst == ActiveInst);
  }

  static void ReleaseOwner(System.Diagnostics.Process proc, long gen, long inst) {
    if (proc != null && ActiveProcess == proc && gen == ActiveGen && inst == ActiveInst) {
      ActiveProcess = null;
      ActiveTempWav = null;
      ActiveGen = -1;
      ActiveInst = -1;
    }
  }

  static void TranscribeFile(string wav, string binary, string modelPath, long gen, long inst, bool deleteInput) {
    var timer = System.Diagnostics.Stopwatch.StartNew();
    lock (Gate) {
      if (gen != ActiveGen || inst != ActiveInst) {
        if (deleteInput) DeleteQuiet(wav);
        return;
      }
    }
    int audioContext = 1500;
    try { audioContext = AudioContext(new FileInfo(wav).Length); } catch {}
    string serverOutput;
    if (TryServer(wav, binary, modelPath, gen, inst, audioContext, out serverOutput)) {
      bool mine;
      lock (Gate) {
        mine = gen == ActiveGen && inst == ActiveInst;
        if (mine) { ActiveTempWav = null; ActiveGen = -1; ActiveInst = -1; }
      }
      if (deleteInput) DeleteQuiet(wav);
      if (!mine) return;
      string cleanServer = CleanOutput(serverOutput);
      if (IsBlank(serverOutput) || IsBlank(cleanServer)) EmitEmpty(gen, inst);
      else ChoomVoiceSink.Final(cleanServer, gen, inst);
      return;
    }
    System.Diagnostics.Process proc = null;
    bool started = false;
    lock (Gate) {
      if (gen != ActiveGen || inst != ActiveInst) {
        if (deleteInput) DeleteQuiet(wav);
        return;
      }
      System.Diagnostics.ProcessStartInfo psi = new System.Diagnostics.ProcessStartInfo();
      psi.FileName = binary;
      // Trusted args only: English CPU mode matching the measured benchmark.
      // Speech text is output only, never an arg.
      psi.Arguments = "-m \"" + modelPath.Replace("\"", "") + "\" -f \"" + wav.Replace("\"", "") + "\" -ac " + audioContext + " -t 6 -l en --prompt \"Choom, Spotify, Visual Studio Code.\" --no-prints --no-timestamps -ng";
      psi.UseShellExecute = false;
      psi.RedirectStandardOutput = true;
      psi.RedirectStandardError = false;
      psi.CreateNoWindow = true;
      proc = new System.Diagnostics.Process();
      proc.StartInfo = psi;
      // Startup and ownership are fenced atomically: a Cancel racing here
      // either lands before Start (guarded below) or kills a live process
      // (owned completion path). No orphan can start unowned.
      try { started = proc.Start(); } catch (System.Exception) { started = false; }
      if (!started) {
        try { proc.Dispose(); } catch {}
        proc = null;
      } else {
        ActiveProcess = proc;
      }
    }
    if (!started) {
      bool mine = false;
      lock (Gate) {
        mine = (gen == ActiveGen && inst == ActiveInst && ActiveProcess == null);
        if (mine) {
          ActiveTempWav = null;
          ActiveGen = -1;
          ActiveInst = -1;
        }
      }
      if (deleteInput) DeleteQuiet(wav);
      // A racing Cancel clears ownership first: stay silent, never emit stale errors.
      if (mine) ChoomVoiceSink.Error("Transcription failed: could not start Whisper.", true, gen, inst);
      return;
    }
    // Drain stdout concurrently with the bounded wait, then kill first on
    // timeout and drain boundedly after. The 120s bound always holds.
    System.Threading.Tasks.Task<string> reader = null;
    try {
      System.Diagnostics.Process rProc = proc;
      reader = System.Threading.Tasks.Task.Run(new System.Func<string>(delegate() {
        try { return rProc.StandardOutput.ReadToEnd(); } catch (System.Exception) { return ""; }
      }));
    } catch (System.Exception) { reader = null; }
    bool exited = false;
    try { exited = proc.WaitForExit((int)Math.Max(1, 120000 - timer.ElapsedMilliseconds)); } catch (System.Exception) { exited = false; }
    if (!exited) {
      try { proc.Kill(); } catch (System.Exception) {}
      try { proc.WaitForExit(5000); } catch (System.Exception) {}
    }
    string output = "";
    try {
      if (reader != null) {
        if (reader.Wait(10000)) {
          try { output = reader.Result; } catch (System.Exception) { output = ""; }
          if (output == null) output = "";
        }
      }
    } catch (System.Exception) {}
    int code = -1;
    try { code = proc.ExitCode; } catch (System.Exception) {}
    bool mine2 = false;
    lock (Gate) {
      mine2 = IsOwner(proc, gen, inst);
      if (mine2) ReleaseOwner(proc, gen, inst);
    }
    if (deleteInput) DeleteQuiet(wav);
    try { proc.Dispose(); } catch (System.Exception) {}
    // Cancelled or superseded while waiting: silent, never a stale emit.
    if (!mine2) return;
    if (!exited) {
      ChoomVoiceSink.Error("Transcription timed out. Try a shorter utterance.", true, gen, inst);
      return;
    }
    // Any nonzero exit fails, even when partial stdout exists.
    if (code != 0) {
      ChoomVoiceSink.Error("Transcription failed. Check the microphone and try again.", true, gen, inst);
      return;
    }
    // Noise markers are checked before cleaning, so stripping can never
    // hide them. Silence still emits empty, never a hallucinated final.
    if (IsBlank(output)) {
      EmitEmpty(gen, inst);
      return;
    }
    string clean = CleanOutput(output);
    if (IsBlank(clean)) {
      EmitEmpty(gen, inst);
      return;
    }
    ChoomVoiceSink.Final(clean, gen, inst);
  }

  public static bool TestTranscribe(string wav, string binary, string modelPath, string modelId, long gen, long inst, bool measure) {
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
      var timer = System.Diagnostics.Stopwatch.StartNew();
      TranscribeFile(cWav, cBin, cModel, cGen, cInst, false);
      if (measure) ChoomVoiceSink.Emit("{\"type\":\"transcription_test\",\"milliseconds\":" + timer.ElapsedMilliseconds + ",\"generation\":" + cGen + ",\"instance\":" + cInst + "}");
    }));
    return true;
  }

  // File-driven endpoint probe for tests: runs the production detector over
  // a 16-bit PCM mono 16kHz WAV and reports its decision. No microphone, no
  // worker, no temp audio. Test mode only.
  public static bool TestEndpoint(string wav, int endpointMs, long gen, long inst) {
    if (wav == null || wav.Length == 0 || !System.IO.File.Exists(wav)) {
      ChoomVoiceSink.Error("Test WAV not found.", true, gen, inst);
      return false;
    }
    short[] pcm = null;
    try { pcm = ReadMono16Wav(wav); } catch (System.Exception) { pcm = null; }
    if (pcm == null) {
      ChoomVoiceSink.Error("Test WAV must be 16-bit PCM mono at 16kHz.", true, gen, inst);
      return false;
    }
    ChoomEndpoint detector = new ChoomEndpoint(endpointMs, 30000);
    int total = pcm.Length;
    int at = 0;
    while (at < total && !detector.Finished) {
      int n = total - at;
      if (n > ChoomEndpoint.FrameSamples) n = ChoomEndpoint.FrameSamples;
      short[] frame = new short[ChoomEndpoint.FrameSamples];
      for (int i = 0; i < n; i++) frame[i] = pcm[at + i];
      for (int i = n; i < ChoomEndpoint.FrameSamples; i++) frame[i] = 0;
      detector.Push(frame, ChoomEndpoint.FrameSamples);
      at += n;
    }
    detector.Eof();
    string json = "{\"type\":\"endpoint_test\",\"hadSpeech\":"
      + (detector.HadSpeech ? "true" : "false")
      + ",\"reason\":\"" + detector.Reason
      + "\",\"onsetMs\":" + detector.OnsetMs()
      + ",\"endMs\":" + detector.EndMs()
      + ",\"frames\":" + detector.TotalFrames
      + ",\"generation\":" + gen + ",\"instance\":" + inst + "}";
    ChoomVoiceSink.Emit(json);
    return true;
  }

  // Strict WAV reader for the test probe: 16-bit PCM, mono, 16kHz.
  // Anything else is rejected so fixtures stay honest.
  static short[] ReadMono16Wav(string path) {
    byte[] all = System.IO.File.ReadAllBytes(path);
    if (all == null || all.Length < 44) return null;
    if (all[0] != (byte)'R' || all[1] != (byte)'I' || all[2] != (byte)'F' || all[3] != (byte)'F') return null;
    if (all[8] != (byte)'W' || all[9] != (byte)'A' || all[10] != (byte)'V' || all[11] != (byte)'E') return null;
    int audioFormat = (int)all[20] | ((int)all[21] << 8);
    int channels = (int)all[22] | ((int)all[23] << 8);
    int rate = (int)all[24] | ((int)all[25] << 8) | ((int)all[26] << 16) | ((int)all[27] << 24);
    int bits = (int)all[34] | ((int)all[35] << 8);
    if (audioFormat != 1 || channels != 1 || rate != 16000 || bits != 16) return null;
    // The data chunk may follow fmt extras or a fact chunk: scan for it.
    int at = 12;
    int dataAt = -1;
    int dataLen = 0;
    while (at + 8 <= all.Length) {
      bool isData = (all[at] == (byte)'d' && all[at + 1] == (byte)'a' && all[at + 2] == (byte)'t' && all[at + 3] == (byte)'a');
      int chunkLen = (int)all[at + 4] | ((int)all[at + 5] << 8) | ((int)all[at + 6] << 16) | ((int)all[at + 7] << 24);
      if (chunkLen < 0 || at + 8 + chunkLen > all.Length) return null;
      if (isData) {
        dataAt = at + 8;
        dataLen = chunkLen;
        break;
      }
      at += 8 + chunkLen;
    }
    if (dataAt < 0) return null;
    int count = dataLen / 2;
    short[] pcm = new short[count];
    for (int i = 0; i < count; i++) {
      pcm[i] = (short)((int)all[dataAt + i * 2] | ((int)all[dataAt + i * 2 + 1] << 8));
    }
    return pcm;
  }

  // Test-only pipeline driver: synthesizes PCM (speech sine or silence)
  // through the production detector, WAV writer, finalizer and worker. It
  // exercises the real start, finish and discard cycle without a
  // microphone; the detector and finalizer are the live code paths.
  public static bool TestCapture(string source, int seconds, int endpointMs, string binary, string modelPath, string modelId, long gen, long inst) {
    if (source != "synth-speech" && source != "synth-silence") {
      ChoomVoiceSink.Error("Unknown test capture source.", true, gen, inst);
      return false;
    }
    if (seconds < 1) seconds = 1;
    if (seconds > 5) seconds = 5;
    string expected = (modelId == "small") ? "ggml-small.bin" : "ggml-base.bin";
    string mid = (modelId == "small") ? "small" : "base";
    if (!IsTrusted(binary, "whisper-cli.exe")) {
      ChoomVoiceSink.Error("Whisper binary missing. Reinstall Choom with the voice runtime.", true, gen, inst);
      return false;
    }
    if (!IsTrusted(modelPath, expected)) {
      ChoomVoiceSink.Error("Model file missing for the test capture.", true, gen, inst);
      return false;
    }
    if (endpointMs < 300) endpointMs = 300;
    if (endpointMs > 3000) endpointMs = 3000;
    TeardownBundle stale = null;
    lock (Gate) { stale = CancelPreviousLocked(); }
    TeardownBundleNow(stale);
    string session = null;
    try { session = SessionDir(); } catch { session = null; }
    if (session == null || session.Length == 0) {
      ChoomVoiceSink.Error("Microphone unavailable: could not prepare the session directory.", true, gen, inst);
      return false;
    }
    string tmp = null;
    lock (Gate) {
      try { System.IO.Directory.CreateDirectory(session); } catch {
        ChoomVoiceSink.Error("Microphone unavailable: could not prepare the session directory.", true, gen, inst);
        return false;
      }
      tmp = System.IO.Path.Combine(session, "utt-" + gen + ".wav");
      DeleteQuiet(tmp);
      System.IO.FileStream stream = null;
      try {
        stream = new System.IO.FileStream(tmp, System.IO.FileMode.Create, System.IO.FileAccess.ReadWrite, System.IO.FileShare.None);
        WriteWavHeader(stream, 0);
      } catch (System.Exception) {
        try { if (stream != null) stream.Close(); } catch (System.Exception) {}
        DeleteQuiet(tmp);
        ChoomVoiceSink.Error("Microphone unavailable: could not record audio.", true, gen, inst);
        return false;
      }
      ActiveGen = gen;
      ActiveInst = inst;
      ActiveTempWav = tmp;
      ActiveModel = mid;
      BinaryPath = binary;
      if (mid == "small") ModelSmallPath = modelPath; else ModelBasePath = modelPath;
      WaveStream = stream;
      ActiveDetector = new ChoomEndpoint(endpointMs, 30000);
      Recording = true;
      try { if (ActiveCts != null) ActiveCts.Dispose(); } catch (System.Exception) {}
      ActiveCts = new System.Threading.CancellationTokenSource();
      ChoomVoiceSink.Simple("listening", gen, inst);
    }
    string cSource = source;
    int cSeconds = seconds;
    long cGen = gen;
    long cInst = inst;
    try {
      System.Threading.Tasks.Task.Run(new System.Action(delegate() {
        try { SynthFeed(cSource, cSeconds, cGen, cInst); } catch (System.Exception) {}
      }));
    } catch (System.Exception) {
      try { StopAndTranscribe(cGen, cInst); } catch (System.Exception) {}
    }
    return true;
  }

  // Feeds synthesized frames in realtime slices, then finishes exactly like
  // a microphone utterance. Any discard in between bails silently.
  static void SynthFeed(string source, int seconds, long gen, long inst) {
    int totalFrames = seconds * 10;
    for (int f = 0; f < totalFrames; f++) {
      bool mine = false;
      lock (Gate) {
        mine = (Recording && gen == ActiveGen && inst == ActiveInst && WaveStream != null && ActiveDetector != null);
      }
      if (!mine) return;
      short[] pcm = new short[ChoomEndpoint.FrameSamples];
      if (source == "synth-speech") {
        for (int i = 0; i < ChoomEndpoint.FrameSamples; i++) {
          double t = (double)(f * ChoomEndpoint.FrameSamples + i) / 16000.0;
          double s = 12000.0 * System.Math.Sin(2.0 * System.Math.PI * 440.0 * t)
            + 3600.0 * System.Math.Sin(2.0 * System.Math.PI * 880.0 * t);
          if (s > 32767.0) s = 32767.0;
          if (s < -32768.0) s = -32768.0;
          pcm[i] = (short)s;
        }
      }
      lock (Gate) {
        if (!Recording || gen != ActiveGen || inst != ActiveInst || WaveStream == null || ActiveDetector == null) return;
        try { WaveStream.Write(SystemToBytes(pcm, ChoomEndpoint.FrameSamples), 0, ChoomEndpoint.FrameSamples * 2); } catch (System.Exception) { return; }
        try { ActiveDetector.Push(pcm, ChoomEndpoint.FrameSamples); } catch (System.Exception) {}
        if (ActiveDetector.Finished) break;
      }
      try { System.Threading.Thread.Sleep(100); } catch (System.Exception) {}
    }
    try { StopAndTranscribe(gen, inst); } catch (System.Exception) {}
  }

  public static void Cancel() {
    TeardownBundle bundle = null;
    lock (Gate) { bundle = CancelPreviousLocked(); }
    TeardownBundleNow(bundle);
  }

  static void CancelLocked() {
    TeardownBundle bundle = null;
    lock (Gate) { bundle = CancelPreviousLocked(); }
    TeardownBundleNow(bundle);
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
$script:whisperEndpointMs = 900

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

function Get-WhisperPaths($modelId) {
  $mid = "base"
  if ($modelId -eq "small") { $mid = "small" }
  $expected = "ggml-base.bin"
  if ($mid -eq "small") { $expected = "ggml-small.bin" }
  $dirs = @()
  if ($PSScriptRoot -ne $null -and $PSScriptRoot -ne "") { $dirs += (Join-Path $PSScriptRoot "whisper"); $dirs += (Join-Path $PSScriptRoot "resources/whisper") }
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

function Start-WhisperListen($modelId, $gen, $inst, $binPath, $modelPath, $endpointMs) {
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
  $ems = 900
  try { if ($endpointMs -ne $null) { $ems = [int]$endpointMs } } catch { $ems = 900 }
  if ($ems -lt 300) { $ems = 300 }
  if ($ems -gt 3000) { $ems = 3000 }
  $script:whisperEndpointMs = $ems
  try { $ok = [ChoomWhisper]::StartRecording($gen, $inst, $bin, $mod, $mid, $ems) } catch {
    [ChoomVoiceSink]::Error(("Whisper capture failed: " + $_.Exception.Message), $true, $gen, $inst)
    $script:mode = "idle"
    return $false
  }
  if (-not $ok) { $script:mode = "idle"; return $false }
  return $true
}

function Remove-OrphanWhisperServers {
  $resolved = Get-WhisperPaths "base"
  if ($resolved -eq $null) { $resolved = Get-WhisperPaths "small" }
  if ($resolved -eq $null) { return }
  try {
    $servers = @(Get-CimInstance Win32_Process -Filter "Name='whisper-server.exe'" -ErrorAction Stop)
    foreach ($server in $servers) {
      [ChoomWhisper]::CleanupOrphanServer($resolved.binary, $server.ExecutablePath, [int]$server.ProcessId, [int]$server.ParentProcessId) | Out-Null
    }
  } catch {}
}

function Invoke-WhisperFinish($gen, $inst) {
  if ($script:mode -ne "whisper_listen" -and $script:mode -ne "whisper_transcribing") {
    Emit-Stopped $inst
    return
  }
  # A superseded finish is ignored: cancellation and newer turns own the job.
  if ($gen -ne $script:generation -or $inst -ne $script:instance) { return }
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
    $ok = Start-WhisperListen $mid $gen $inst $script:whisperBinary $script:whisperModelPath $script:whisperEndpointMs
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
  $queued = ($testWav -eq $null -or $testWav -eq "") -and [ChoomVoiceSink]::OwnedSynth -ne $null -and [ChoomVoiceSink]::SynthGen -eq $gen -and [ChoomVoiceSink]::SynthInst -eq $inst
  if (-not $queued) { [ChoomVoiceSink]::DisposeAudio() }
  try {
    if ($queued) {
      [ChoomVoiceSink]::Simple("speech_started", $gen, $inst)
      [ChoomVoiceSink]::SpeakAsyncWithDone([ChoomVoiceSink]::OwnedSynth, $t, $gen, $inst)
      return
    }
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

Remove-OrphanWhisperServers
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
      $ems = $cmd.endpointMs
      Start-WhisperListen $model $gen $inst "" "" $ems | Out-Null
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
  elseif ($name -eq "test_audio_ctx") {
    if (-not $testMode) { [ChoomVoiceSink]::Error("Test input is not enabled in production.", $false, $gen, $inst); continue }
    $cases = @(@(0, 384), @(44, 384), @(118444, 384), @(320044, 564), @(320045, 565), @(960044, 1500))
    foreach ($case in $cases) {
      if ([ChoomWhisper]::AudioContext([long]$case[0]) -ne $case[1]) { throw "audio_ctx sizing failed" }
    }
    [ChoomVoiceSink]::Simple("audio_ctx_pass", $gen, $inst)
  }
  elseif ($name -eq "test_whisper" -or $name -eq "test_transcribe") {
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
    try { [ChoomWhisper]::TestTranscribe($cmd.wav, $resolved.binary, $resolved.modelPath, $model, $gen, $inst, ($name -eq "test_transcribe")) | Out-Null } catch {
      [ChoomVoiceSink]::Error(("Test transcription failed: " + $_.Exception.Message), $true, $gen, $inst)
      $script:mode = "idle"
    }
  }
  elseif ($name -eq "test_endpoint") {
    if (-not $testMode) { [ChoomVoiceSink]::Error("Test input is not enabled in production.", $false, $gen, $inst); continue }
    $ems = $cmd.endpointMs
    if ($ems -eq $null -or $ems -eq "") { $ems = 500 }
    try { [ChoomWhisper]::TestEndpoint($cmd.wav, [int]$ems, $gen, $inst) | Out-Null } catch {
      [ChoomVoiceSink]::Error(("Test endpoint failed: " + $_.Exception.Message), $true, $gen, $inst)
    }
  }
  elseif ($name -eq "test_capture") {
    if (-not $testMode) { [ChoomVoiceSink]::Error("Test input is not enabled in production.", $false, $gen, $inst); continue }
    $model = $cmd.model
    if ($model -eq $null -or $model -eq "") { $model = "base" }
    if ($model -ne "base" -and $model -ne "small") { $model = "base" }
    $resolved = Get-WhisperPaths $model
    if ($resolved -eq $null) {
      [ChoomVoiceSink]::Error("Whisper binary or model missing for the test capture.", $true, $gen, $inst)
      continue
    }
    $src = $cmd.source
    if ($src -eq $null -or $src -eq "") { $src = "synth-silence" }
    $secs = 2
    try { if ($cmd.seconds -ne $null) { $secs = [int]$cmd.seconds } } catch { $secs = 2 }
    $ems = $cmd.endpointMs
    if ($ems -eq $null -or $ems -eq "") { $ems = 500 }
    $script:mode = "whisper_listen"
    $script:generation = $gen
    $script:instance = $inst
    try { [ChoomWhisper]::TestCapture($src, $secs, [int]$ems, $resolved.binary, $resolved.modelPath, $model, $gen, $inst) | Out-Null } catch {
      [ChoomVoiceSink]::Error(("Test capture failed: " + $_.Exception.Message), $true, $gen, $inst)
      $script:mode = "idle"
    }
  }
  elseif ($name -eq "shutdown") { try { [ChoomWhisper]::Cancel() } catch {}; Stop-Recognition; Stop-Audio $gen $inst; break }
  else { [ChoomVoiceSink]::Error(("Unknown command: " + $name), $true, $gen, $inst) }
}
try { [ChoomWhisper]::Cancel(); [ChoomWhisper]::ShutdownServer() } catch {}
[ChoomVoiceSink]::DisposeAudio()
