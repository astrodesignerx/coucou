// Runs the production embedded helper without a microphone or a model process.
public static class WhisperSchedulerTests {
  static readonly System.Reflection.BindingFlags PrivateStatic = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
  static void Set(string field, object value) { typeof(ChoomWhisper).GetField(field, PrivateStatic).SetValue(null, value); }
  static void Check(bool value, string message) { if (!value) throw new System.Exception(message); }
  static void Until(System.Func<bool> predicate, string message) {
    var clock = System.Diagnostics.Stopwatch.StartNew();
    while (!predicate() && clock.ElapsedMilliseconds < 3000) System.Threading.Thread.Sleep(5);
    Check(predicate(), message);
  }
  static void Begin(bool continuous) {
    lock (ChoomWhisper.Gate) {
      ChoomWhisper.ActiveGen = 701;
      ChoomWhisper.ActiveInst = 1;
      ChoomWhisper.Recording = true;
      ChoomWhisper.BeginContinuousSessionLocked(701, 1, 700, continuous, false);
    }
  }
  static void Enqueue(bool final, long sequence, int bytes = 32000) {
    var plan = new ChoomWhisper.SealPlan();
    plan.Pcm = new byte[bytes];
    plan.HadSpeech = true;
    plan.Utterance = 1;
    plan.Sequence = sequence;
    plan.Final = final;
    plan.SealedAtMs = System.Diagnostics.Stopwatch.GetTimestamp() * 1000 / System.Diagnostics.Stopwatch.Frequency;
    typeof(ChoomWhisper).GetMethod("EnqueueDecode", PrivateStatic).Invoke(null,
      new object[] { plan, 701L, 1L, ChoomWhisper.SessionId });
  }
  static void Drained() {
    Until(delegate { lock (ChoomWhisper.Gate) { return ChoomWhisper.DecodeThread == null; } }, "decoder did not retire");
  }
  sealed class Server : System.IDisposable {
    readonly System.Net.Sockets.TcpListener listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
    readonly System.Threading.ManualResetEvent release = new System.Threading.ManualResetEvent(false);
    readonly System.Threading.Thread accept;
    readonly bool holdFirst;
    public readonly System.Collections.Concurrent.ConcurrentQueue<string> Bodies = new System.Collections.Concurrent.ConcurrentQueue<string>();
    public readonly System.Threading.ManualResetEvent Entered = new System.Threading.ManualResetEvent(false);
    public int Requests;
    public string Url;
    public Server(bool hold = true) {
      holdFirst = hold;
      listener.Start();
      Url = "http://127.0.0.1:" + ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
      accept = new System.Threading.Thread(delegate() {
        try {
          while (true) {
            var client = listener.AcceptTcpClient();
            var worker = new System.Threading.Thread(delegate() { Handle(client); });
            worker.IsBackground = true;
            worker.Start();
          }
        } catch (System.Net.Sockets.SocketException) { }
      });
      accept.IsBackground = true;
      accept.Start();
    }
    void Handle(System.Net.Sockets.TcpClient client) {
      try {
        using (client)
        using (var stream = client.GetStream()) {
          stream.ReadTimeout = 3000;
          var header = new System.Text.StringBuilder();
          while (!header.ToString().EndsWith("\r\n\r\n")) {
            int b = stream.ReadByte();
            if (b < 0) return;
            header.Append((char)b);
          }
          var match = System.Text.RegularExpressions.Regex.Match(header.ToString(), "Content-Length: ([0-9]+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
          int remaining = int.Parse(match.Groups[1].Value);
          var bytes = new byte[8192];
          using (var body = new System.IO.MemoryStream()) {
            while (remaining > 0) {
              int n = stream.Read(bytes, 0, System.Math.Min(bytes.Length, remaining));
              if (n == 0) return;
              body.Write(bytes, 0, n);
              remaining -= n;
            }
            Bodies.Enqueue(System.Text.Encoding.UTF8.GetString(body.ToArray()));
          }
          int request = System.Threading.Interlocked.Increment(ref Requests);
          if (request == 1 && holdFirst) { Entered.Set(); release.WaitOne(5000); }
          byte[] response = System.Text.Encoding.UTF8.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nOpen Notes.");
          stream.Write(response, 0, response.Length);
        }
      } catch (System.IO.IOException) { } catch (System.ObjectDisposedException) { }
    }
    public void Dispose() { release.Set(); listener.Stop(); accept.Join(1000); }
  }
  static void Use(Server server) {
    Set("ServerProcess", System.Diagnostics.Process.GetCurrentProcess());
    Set("ServerModel", "scheduler-test");
    Set("ServerUrl", server.Url);
    ChoomWhisper.BinaryPath = "unused-whisper-cli.exe";
    ChoomWhisper.ModelBasePath = "scheduler-test";
  }
  public static int Main() {
    var original = System.Console.Out;
    var events = new System.IO.StringWriter();
    System.Console.SetOut(System.IO.TextWriter.Synchronized(events));
    try {
      // Finding 8: ordinary listens never create a continuous decoder.
      Begin(false);
      Check(ChoomWhisper.DecodeThread == null, "ordinary listen created a decoder");
      using (var server = new Server(false)) {
        Use(server);
        string wav = (string)typeof(ChoomWhisper).GetMethod("WriteWavFile", PrivateStatic).Invoke(null,
          new object[] { 701L, 1L, 1L, new byte[96000] });
        try {
          var args = new object[] { wav, ChoomWhisper.BinaryPath, ChoomWhisper.ModelBasePath, 701L, 1L, 384, "", -1L, 5000, null };
          Check((bool)typeof(ChoomWhisper).GetMethod("TryServer", PrivateStatic).Invoke(null, args), "ordinary server request failed");
          Check(!server.Bodies.ToArray()[0].Contains("name=\"temperature\""), "ordinary transcription settings changed");
          Check(ChoomWhisper.DecodeThread == null, "ordinary transcription created a decoder");
        } finally { System.IO.File.Delete(wav); }
      }
      ChoomWhisper.Cancel();
      for (int i = 0; i < 3; i++) {
        Begin(true);
        Until(delegate { return ChoomWhisper.DecodeThread != null && (ChoomWhisper.DecodeThread.ThreadState & System.Threading.ThreadState.WaitSleepJoin) != 0; }, "idle decoder did not block");
        ChoomWhisper.Cancel();
        Drained();
      }
      // Finding 3: aborting a warm request must never fall through to CLI.
      using (var server = new Server()) {
        Use(server);
        Begin(true);
        int starts = ChoomWhisper.DecodeCliStarts;
        long session = ChoomWhisper.SessionId;
        Enqueue(false, 1);
        Check(server.Entered.WaitOne(3000), "provisional request did not start");
        ChoomWhisper.Cancel();
        Drained();
        Check(ChoomWhisper.SessionId > session, "cancel did not invalidate capture session");
        Check(ChoomWhisper.DecodeCliStarts == starts, "cancelled request started a CLI decode");
      }
      events.GetStringBuilder().Clear();
      // Finding 9: a final bypasses an indefinitely held provisional request.
      using (var server = new Server()) {
        Use(server);
        Begin(true);
        Enqueue(false, 1);
        Check(server.Entered.WaitOne(3000), "provisional request did not start");
        for (int i = 2; i < 8; i++) Enqueue(false, i);
        Check(server.Requests == 1, "concurrent provisional requests were started");
        var clock = System.Diagnostics.Stopwatch.StartNew();
        lock (ChoomWhisper.Gate) { ChoomWhisper.SealedThrough = 1; }
        Enqueue(true, 8, 96000);
        Enqueue(false, 9);
        Until(delegate { return events.ToString().Contains("\"type\":\"final\""); }, "final waited behind provisional work");
        Check(clock.ElapsedMilliseconds < 1000, "final did not preempt provisional within 1000ms");
        Check(server.Requests == 2, "sealed provisional audio was decoded again");
        var bodies = server.Bodies.ToArray();
        Check(!bodies[0].Contains("name=\"temperature\""), "short continuous request changed greedy decoding");
        Check(bodies[1].Contains("name=\"temperature\"\r\n\r\n0.2\r\n"), "long continuous request did not bypass repetitive greedy decoding");
        Check(!events.ToString().Contains("\"type\":\"partial\""), "sealed provisional published late captions");
        lock (ChoomWhisper.Gate) { ChoomWhisper.Recording = false; }
        ChoomWhisper.DecodeWake.Set();
        Drained();
        original.WriteLine("PASS: final preemption: " + clock.ElapsedMilliseconds + "ms; one provisional in flight; no sealed replay");
      }
      original.WriteLine("PASS: cancelled server request never starts CLI; ordinary listens start no decoder; continuous decoder retires");
      return 0;
    } catch (System.Exception error) { original.WriteLine(error); return 1; }
    finally {
      ChoomWhisper.Cancel();
      ChoomWhisper.StopDecoder();
      Set("ServerProcess", null);
      System.Console.SetOut(original);
    }
  }
}
