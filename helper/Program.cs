// Island helper: reports what is playing on this PC (any app that uses the
// Windows media controls) as JSON lines on stdout, and takes simple commands
// on stdin: toggle, play, pause, next, prev.
using System.Text.Json;
using Windows.Media.Control;

var stdout = Console.Out;
var gate = new SemaphoreSlim(1, 1);
// True when the player accepted a control request; false if it refused or the call failed.
async Task<bool> Asked(Windows.Foundation.IAsyncOperation<bool> request)
{
    try { return await request; } catch { return false; }
}

// Nothing is written when nothing changed, so an idle laptop costs the island nothing.
string lastSaid = "";
bool playingNow = false;
void Say(string json)
{
    if (json == lastSaid) return;
    lastSaid = json;
    stdout.WriteLine(json);
    stdout.Flush();
}

string lastArtKey = "";
string lastSite = "";
string pendingKey = "";
int artTries = 0;

// Works out where the sound is coming from: Spotify, or for a browser, which site
// (judged from the browser's window title, since Windows only reports "Chrome").
string SiteOf(string app, string title)
{
    var a = app.ToLowerInvariant();
    if (a.Contains("spotify")) return "spotify";
    try
    {
        foreach (var p in System.Diagnostics.Process.GetProcessesByName("Spotify"))
        {
            string t;
            try { t = p.MainWindowTitle; } catch { continue; } finally { p.Dispose(); }
            if (t.Length > 0 && (t.StartsWith("Spotify") || (title.Length > 0 && t.Contains(title, StringComparison.OrdinalIgnoreCase)))) return "spotify";
        }
    }
    catch { /* cannot list processes: carry on */ }
    bool browser = a.Contains("chromium") || a.Contains("chrome") || a.Contains("msedge") || a.Contains("firefox") || a.Contains("brave") || a.Contains("opera") || a.Contains("vivaldi");
    if (!browser) return "";
    try
    {
        foreach (var p in System.Diagnostics.Process.GetProcesses())
        {
            string t;
            try { t = p.MainWindowTitle; } catch { continue; } finally { p.Dispose(); }
            if (t.Length == 0) continue;
            if (t.Contains("YouTube")) return "youtube";
            if (t.Contains("Spotify")) return "spotify";
        }
    }
    catch { /* cannot list windows: fall through */ }
    return "web";
}

var manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
GlobalSystemMediaTransportControlsSession? hooked = null;

async Task Emit()
{
    await gate.WaitAsync();
    try
    {
        var s = manager.GetCurrentSession();
        if (s is null)
        {
            lastArtKey = "";
            playingNow = false;
            Say(JsonSerializer.Serialize(new { none = true, vol = Native.Volume(), muted = Native.Muted() }));
            return;
        }

        var props = await s.TryGetMediaPropertiesAsync();
        var info = s.GetPlaybackInfo();
        var tl = s.GetTimelineProperties();
        var playing = info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;

        double pos = tl.Position.TotalSeconds;
        if (playing) pos += (DateTimeOffset.UtcNow - tl.LastUpdatedTime).TotalSeconds;
        double dur = (tl.EndTime - tl.StartTime).TotalSeconds;
        if (dur > 0 && pos > dur) pos = dur;
        if (pos < 0) pos = 0;

        string? art = null;
        var key = (props.Title ?? "") + "|" + (props.Artist ?? "") + "|" + s.SourceAppUserModelId;
        bool artChanged = key != lastArtKey;
        if (artChanged)
        {
            try
            {
                if (props.Thumbnail is not null)
                {
                    using var ras = await props.Thumbnail.OpenReadAsync();
                    using var stream = ras.AsStreamForRead();
                    using var ms = new MemoryStream();
                    await stream.CopyToAsync(ms);
                    if (ms.Length > 0 && ms.Length < 4_000_000)
                        art = "data:" + (string.IsNullOrEmpty(ras.ContentType) ? "image/png" : ras.ContentType)
                              + ";base64," + Convert.ToBase64String(ms.ToArray());
                }
            }
            catch { /* some apps expose no readable thumbnail */ }
            // Apps often announce the title first and the cover a moment later, so keep asking for a few seconds.
            artTries = key == pendingKey ? artTries + 1 : 0;
            pendingKey = key;
            if (art is not null || artTries >= 8) lastArtKey = key;
            lastSite = SiteOf(s.SourceAppUserModelId ?? "", props.Title ?? "");
        }

        playingNow = playing;
        Say(JsonSerializer.Serialize(new
        {
            title = props.Title ?? "",
            artist = props.Artist ?? "",
            app = s.SourceAppUserModelId ?? "",
            site = lastSite,
            vol = Native.Volume(),
            muted = Native.Muted(),
            playing,
            pos,
            dur,
            artChanged,
            art,
        }));
    }
    catch { /* the session can vanish mid-read; the next tick recovers */ }
    finally { gate.Release(); }
}

void Hook()
{
    var s = manager.GetCurrentSession();
    if (ReferenceEquals(s, hooked)) return;
    hooked = s;
    if (s is null) return;
    s.MediaPropertiesChanged += (_, _) => _ = Emit();
    s.PlaybackInfoChanged += (_, _) => _ = Emit();
}

manager.CurrentSessionChanged += (_, _) => { Hook(); _ = Emit(); };
manager.SessionsChanged += (_, _) => { Hook(); _ = Emit(); };
Hook();
await Emit();

_ = Task.Run(async () =>
{
    while (true)
    {
        // Every second while something plays (the position moves); otherwise a slow check is enough,
        // because Windows tells us about new songs and pauses by itself.
        await Task.Delay(playingNow ? 1000 : 4000);
        Hook();
        await Emit();
    }
});

async Task Write(object message)
{
    await gate.WaitAsync();
    try { stdout.WriteLine(JsonSerializer.Serialize(message)); stdout.Flush(); }
    finally { gate.Release(); }
}

// Hold-to-talk. The island says "hold" when its shortcut fires; from then on we
// watch Ctrl+Alt+Space only until the keys come up, and report that once.
int holdWatching = 0;
void WatchHold()
{
    if (Interlocked.Exchange(ref holdWatching, 1) == 1) return;
    _ = Task.Run(async () =>
    {
        try
        {
            for (int i = 0; i < 2000; i++) // gives up after a minute
            {
                await Task.Delay(30);
                if (!(Native.Down(0x11) && Native.Down(0x12) && Native.Down(0x20))) break;
            }
            await Write(new { hold = false });
        }
        finally { Interlocked.Exchange(ref holdWatching, 0); }
    });
}

// The clipboard: Windows keeps a counter that goes up with every copy. Reading it is
// nearly free, so the island only opens the clipboard when something was really copied.
_ = Task.Run(async () =>
{
    uint last = Native.ClipboardCount();
    while (true)
    {
        await Task.Delay(400);
        uint now = Native.ClipboardCount();
        if (now == last) continue;
        last = now;
        await Write(new { clip = now });
    }
});

// Notifications from other Windows apps (WhatsApp, Mail, Teams...), read from the
// notification centre. Off until the island asks for it with "notes on".
bool notesOn = false;
int notesRunning = 0;
void WatchNotes()
{
    if (Interlocked.Exchange(ref notesRunning, 1) == 1) return;
    _ = Task.Run(async () =>
    {
        try
        {
            var listener = Windows.UI.Notifications.Management.UserNotificationListener.Current;
            var access = await listener.RequestAccessAsync();
            if (access != Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus.Allowed)
            {
                await Write(new { notes = "denied" });
                return;
            }
            await Write(new { notes = "allowed" });
            var seen = new HashSet<uint>();
            bool first = true;
            while (notesOn)
            {
                var list = await listener.GetNotificationsAsync(Windows.UI.Notifications.NotificationKinds.Toast);
                var current = new HashSet<uint>();
                foreach (var n in list)
                {
                    current.Add(n.Id);
                    if (seen.Contains(n.Id) || first) continue; // what was already waiting is not news
                    string app = "", title = "", text = "";
                    try { app = n.AppInfo.DisplayInfo.DisplayName; } catch { /* some apps have no name */ }
                    try
                    {
                        var lines = n.Notification.Visual.GetBinding(Windows.UI.Notifications.KnownNotificationBindings.ToastGeneric)?.GetTextElements();
                        if (lines is not null)
                        {
                            var all = lines.Select(l => l.Text).Where(t => !string.IsNullOrWhiteSpace(t)).ToList();
                            if (all.Count > 0) title = all[0];
                            if (all.Count > 1) text = string.Join(" ", all.Skip(1));
                        }
                    }
                    catch { /* unreadable: show the app name alone */ }
                    if (app.Length + title.Length + text.Length > 0) await Write(new { note = new { id = n.Id, app, title, text } });
                }
                seen = current;
                first = false;
                await Task.Delay(2500);
            }
        }
        catch { await Write(new { notes = "failed" }); }
        finally { Interlocked.Exchange(ref notesRunning, 0); }
    });
}

string? line;
while ((line = Console.In.ReadLine()) is not null)
{
    try
    {
        // "blur <window handle> [mode]" turns on Windows' blur-behind for the island window.
        if (line.StartsWith("blur "))
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 2 && long.TryParse(parts[1], out var handle))
            {
                int mode = parts.Length >= 3 && int.TryParse(parts[2], out var m) ? m : 4;
                uint tint = parts.Length >= 4 && uint.TryParse(parts[3], out var c) ? c : 0x2014161Eu;
                int ok = Native.Blur(new IntPtr(handle), mode, tint);
                await gate.WaitAsync();
                try { stdout.WriteLine(JsonSerializer.Serialize(new { blur = ok, mode })); stdout.Flush(); }
                finally { gate.Release(); }
            }
            continue;
        }

        // "shape <window handle> x y w h r [x y w h r ...]" cuts the window down to
        // those rounded rectangles (in real pixels, relative to the window).
        if (line.StartsWith("shape "))
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 7 && long.TryParse(parts[1], out var handle))
            {
                var nums = new List<int>();
                for (int i = 2; i < parts.Length; i++) if (int.TryParse(parts[i], out var n)) nums.Add(n);
                Native.Shape(new IntPtr(handle), nums);
            }
            continue;
        }

        if (line.Trim() == "hold") { WatchHold(); continue; }
        if (line.Trim() == "notes on") { notesOn = true; WatchNotes(); continue; }
        if (line.Trim() == "notes off") { notesOn = false; continue; }

        // "night <id> toggle|state" switches Windows' night light, or just reports it. Windows has no
        // official switch for this; the setting lives in one registry value whose layout is checked
        // before anything is written, and left alone if it is not the layout we know.
        if (line.StartsWith("night "))
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 3)
            {
                bool ok = false, on = false; string why = "";
                try
                {
                    const string where = @"Software\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current\default$windows.data.bluelightreduction.bluelightreductionstate\windows.data.bluelightreduction.bluelightreductionstate";
                    bool toggle = parts[2] == "toggle";
                    using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(where, toggle);
                    var data = key?.GetValue("Data") as byte[];
                    if (key is null || data is null || data.Length < 26 || (data[18] != 0x13 && data[18] != 0x15)) why = "unknown";
                    else
                    {
                        on = data[18] == 0x15;
                        if (!toggle) ok = true;
                        else if (on && (data[23] != 0x10 || data[24] != 0x00)) why = "unknown";
                        else
                        {
                            var next = new List<byte>(data);
                            if (on) { next.RemoveRange(23, 2); next[18] = 0x13; }
                            else { next.InsertRange(23, new byte[] { 0x10, 0x00 }); next[18] = 0x15; }
                            // Bytes 10 to 14 are a change stamp; Windows ignores the write unless it moves forward.
                            for (int i = 10; i < 15; i++) { if (next[i] != 0xff) { next[i]++; break; } }
                            key.SetValue("Data", next.ToArray(), Microsoft.Win32.RegistryValueKind.Binary);
                            on = !on; ok = true;
                        }
                    }
                }
                catch { why = "failed"; }
                await Write(new { radio = parts[1], ok, on, why });
            }
            continue;
        }

        // "paste" presses Ctrl+V in whatever app has the keyboard, to drop dictated text at the cursor.
        if (line.Trim() == "paste") { Native.Paste(); continue; }
        // "type <text as base64>" types dictated words into whatever app has the keyboard.
        if (line.StartsWith("type "))
        {
            try { Native.TypeText(System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(line.Substring(5).Trim()))); } catch { /* bad text */ }
            continue;
        }

        // "radio <id> wifi|bluetooth toggle|state" switches Wi-Fi or Bluetooth, or just reports it.
        if (line.StartsWith("radio "))
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 4)
            {
                bool ok = false, on = false; string why = "";
                try
                {
                    var want = parts[2] == "wifi" ? Windows.Devices.Radios.RadioKind.WiFi : Windows.Devices.Radios.RadioKind.Bluetooth;
                    var radio = (await Windows.Devices.Radios.Radio.GetRadiosAsync()).FirstOrDefault(r => r.Kind == want);
                    if (radio is null) why = "none";
                    else
                    {
                        on = radio.State == Windows.Devices.Radios.RadioState.On;
                        if (parts[3] == "toggle")
                        {
                            var access = await Windows.Devices.Radios.Radio.RequestAccessAsync();
                            var done = access == Windows.Devices.Radios.RadioAccessStatus.Allowed
                                ? await radio.SetStateAsync(on ? Windows.Devices.Radios.RadioState.Off : Windows.Devices.Radios.RadioState.On)
                                : Windows.Devices.Radios.RadioAccessStatus.DeniedByUser;
                            ok = done == Windows.Devices.Radios.RadioAccessStatus.Allowed;
                            if (ok) on = !on; else why = "denied";
                        }
                        else ok = true;
                    }
                }
                catch { why = "failed"; }
                await gate.WaitAsync();
                try { stdout.WriteLine(JsonSerializer.Serialize(new { radio = parts[1], ok, on, why })); stdout.Flush(); }
                finally { gate.Release(); }
            }
            continue;
        }

        // "ocr <id> <path as base64>" reads the text in a picture using Windows' built-in recogniser.
        if (line.StartsWith("ocr "))
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 3)
            {
                string id = parts[1], text = ""; bool ok = false;
                try
                {
                    var path = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(parts[2]));
                    using var fileStream = File.OpenRead(path);
                    using var stream = fileStream.AsRandomAccessStream();
                    var decoder = await Windows.Graphics.Imaging.BitmapDecoder.CreateAsync(stream);
                    using var bitmap = await decoder.GetSoftwareBitmapAsync(Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8, Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied);
                    var engine = Windows.Media.Ocr.OcrEngine.TryCreateFromUserProfileLanguages();
                    if (engine is not null)
                    {
                        var result = await engine.RecognizeAsync(bitmap);
                        text = string.Join("\n", result.Lines.Select(l => l.Text));
                        ok = true;
                    }
                }
                catch { /* unreadable picture: reported as not ok */ }
                await gate.WaitAsync();
                try { stdout.WriteLine(JsonSerializer.Serialize(new { ocr = id, ok, text })); stdout.Flush(); }
                finally { gate.Release(); }
            }
            continue;
        }

        // "volume 0.4" sets the laptop's main volume (0 to 1); "mute" flips mute.
        if (line.StartsWith("volume "))
        {
            if (float.TryParse(line.AsSpan(7).Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var level)) Native.SetVolume(level);
            _ = Emit();
            continue;
        }
        if (line.Trim() == "mute") { Native.ToggleMute(); _ = Emit(); continue; }

        var s = manager.GetCurrentSession();
        if (s is null) continue;
        // "seek 73.5" jumps to that many seconds into the track.
        if (line.StartsWith("seek "))
        {
            if (double.TryParse(line.AsSpan(5).Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var seconds))
                await s.TryChangePlaybackPositionAsync((long)(Math.Max(0, seconds) * 10_000_000));
            _ = Emit();
            continue;
        }
        switch (line.Trim())
        {
            case "toggle": if (!await Asked(s.TryTogglePlayPauseAsync())) Native.Tap(0xB3); break;
            case "play": if (!await Asked(s.TryPlayAsync())) Native.Tap(0xB3); break;
            case "pause": if (!await Asked(s.TryPauseAsync())) Native.Tap(0xB3); break;
            case "next": if (!await Asked(s.TrySkipNextAsync())) Native.Tap(0xB0); break;
            case "prev": if (!await Asked(s.TrySkipPreviousAsync())) Native.Tap(0xB1); break;
        }
    }
    catch { /* ignore a command the current app rejects */ }
}

static class Native
{
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct AccentPolicy { public int AccentState; public int AccentFlags; public uint GradientColor; public int AnimationId; }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct CompositionAttributeData { public int Attribute; public IntPtr Data; public int SizeOfData; }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref CompositionAttributeData data);

    [System.Runtime.InteropServices.DllImport("gdi32.dll")]
    static extern IntPtr CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h);
    [System.Runtime.InteropServices.DllImport("gdi32.dll")]
    static extern IntPtr CreateRectRgn(int x1, int y1, int x2, int y2);
    [System.Runtime.InteropServices.DllImport("gdi32.dll")]
    static extern int CombineRgn(IntPtr dst, IntPtr a, IntPtr b, int mode);
    [System.Runtime.InteropServices.DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr obj);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern int SetWindowRgn(IntPtr hwnd, IntPtr rgn, bool redraw);

    /// <summary>nums is groups of five: x, y, width, height, corner radius.</summary>
    public static int Shape(IntPtr hwnd, List<int> nums)
    {
        IntPtr all = CreateRectRgn(0, 0, 0, 0);
        for (int i = 0; i + 4 < nums.Count; i += 5)
        {
            int x = nums[i], y = nums[i + 1], w = nums[i + 2], h = nums[i + 3], r = nums[i + 4];
            if (w <= 0 || h <= 0) continue;
            IntPtr part = CreateRoundRectRgn(x, y, x + w + 1, y + h + 1, r * 2, r * 2);
            CombineRgn(all, all, part, 2 /* RGN_OR */);
            DeleteObject(part);
        }
        // On success Windows owns the region, so it must not be deleted here.
        int ok = SetWindowRgn(hwnd, all, true);
        if (ok == 0) DeleteObject(all);
        return ok;
    }

    /// <summary>mode 3 = plain blur behind, 4 = acrylic blur behind, 0 = off. tint is AABBGGRR.</summary>
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int key);

    public static bool Down(int key) => (GetAsyncKeyState(key) & 0x8000) != 0;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern uint GetClipboardSequenceNumber();
    public static uint ClipboardCount() => GetClipboardSequenceNumber();

    // ---- main volume, through Windows' audio endpoint ----
    static IAudioEndpointVolume? kept;
    static long keptAt;
    // Looking the speaker up is the costly part, so it is kept for a few seconds
    // (not for ever: plugging in headphones changes which one it is).
    static IAudioEndpointVolume? Endpoint()
    {
        long now = Environment.TickCount64;
        if (kept is not null && now - keptAt < 5000) return kept;
        kept = Find();
        keptAt = now;
        return kept;
    }
    static IAudioEndpointVolume? Find()
    {
        try
        {
            var devices = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            if (devices.GetDefaultAudioEndpoint(0 /* playback */, 1 /* multimedia */, out var device) != 0) return null;
            var iid = typeof(IAudioEndpointVolume).GUID;
            if (device.Activate(ref iid, 23 /* any context */, IntPtr.Zero, out var found) != 0) return null;
            return (IAudioEndpointVolume)found;
        }
        catch { return null; }
    }
    public static float Volume() { var e = Endpoint(); if (e is null) return -1; return e.GetMasterVolumeLevelScalar(out var v) == 0 ? v : -1; }
    public static bool Muted() { var e = Endpoint(); if (e is null) return false; return e.GetMute(out var m) == 0 && m; }
    public static void SetVolume(float level) { var e = Endpoint(); if (e is null) return; var none = Guid.Empty; e.SetMasterVolumeLevelScalar(Math.Clamp(level, 0f, 1f), ref none); }
    public static void ToggleMute() { var e = Endpoint(); if (e is null) return; var none = Guid.Empty; if (e.GetMute(out var m) == 0) e.SetMute(!m, ref none); }

    /// <summary>Presses and releases one key, such as a keyboard media key.</summary>
    public static void Tap(byte key) { keybd_event(key, 0, 0, UIntPtr.Zero); keybd_event(key, 0, 2, UIntPtr.Zero); }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit, Size = 40)]
    struct KeyInput
    {
        [System.Runtime.InteropServices.FieldOffset(0)] public uint Type;
        [System.Runtime.InteropServices.FieldOffset(8)] public ushort Key;
        [System.Runtime.InteropServices.FieldOffset(10)] public ushort Scan;
        [System.Runtime.InteropServices.FieldOffset(12)] public uint Flags;
        [System.Runtime.InteropServices.FieldOffset(16)] public uint Time;
        [System.Runtime.InteropServices.FieldOffset(24)] public IntPtr Extra;
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint count, KeyInput[] inputs, int size);

    /// <summary>Types text as if on the keyboard, one character at a time, in any language.</summary>
    public static void TypeText(string text)
    {
        const uint Unicode = 4, Up = 2;
        var keys = new List<KeyInput>();
        foreach (char ch in text)
        {
            if (ch == '\r' || ch == '\n') continue;
            keys.Add(new KeyInput { Type = 1, Scan = ch, Flags = Unicode });
            keys.Add(new KeyInput { Type = 1, Scan = ch, Flags = Unicode | Up });
        }
        if (keys.Count > 0) SendInput((uint)keys.Count, keys.ToArray(), 40);
    }

    public static void Paste()
    {
        const uint Up = 2;
        // Let go of anything left held from the shortcut (Alt, Space), then Ctrl+V.
        keybd_event(0x12, 0, Up, UIntPtr.Zero);
        keybd_event(0x20, 0, Up, UIntPtr.Zero);
        keybd_event(0x11, 0, 0, UIntPtr.Zero);
        keybd_event(0x56, 0, 0, UIntPtr.Zero);
        keybd_event(0x56, 0, Up, UIntPtr.Zero);
        keybd_event(0x11, 0, Up, UIntPtr.Zero);
    }

    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    public static int Blur(IntPtr hwnd, int mode, uint tint)
    {
        // Ask Windows 11 to round this window's corners (33 = corner preference, 2 = round).
        int round = 2;
        DwmSetWindowAttribute(hwnd, 33, ref round, sizeof(int));

        var policy = new AccentPolicy { AccentState = mode, AccentFlags = 2, GradientColor = tint, AnimationId = 0 };
        int size = System.Runtime.InteropServices.Marshal.SizeOf<AccentPolicy>();
        IntPtr mem = System.Runtime.InteropServices.Marshal.AllocHGlobal(size);
        try
        {
            System.Runtime.InteropServices.Marshal.StructureToPtr(policy, mem, false);
            var data = new CompositionAttributeData { Attribute = 19, Data = mem, SizeOfData = size };
            return SetWindowCompositionAttribute(hwnd, ref data);
        }
        finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(mem); }
    }
}

// Windows Core Audio interfaces, declared just far enough to read and set the main volume.
[System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

[System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), System.Runtime.InteropServices.InterfaceType(System.Runtime.InteropServices.ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [System.Runtime.InteropServices.PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("D666063F-1587-4E43-81F1-B948E807363F"), System.Runtime.InteropServices.InterfaceType(System.Runtime.InteropServices.ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    [System.Runtime.InteropServices.PreserveSig] int Activate(ref Guid iid, int context, IntPtr activationParams, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.IUnknown)] out object found);
}

[System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), System.Runtime.InteropServices.InterfaceType(System.Runtime.InteropServices.ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume
{
    // The order below must match Windows' own definition exactly.
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out int count);
    int SetMasterVolumeLevel(float decibels, ref Guid context);
    [System.Runtime.InteropServices.PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
    int GetMasterVolumeLevel(out float decibels);
    [System.Runtime.InteropServices.PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(int channel, float decibels, ref Guid context);
    int SetChannelVolumeLevelScalar(int channel, float level, ref Guid context);
    int GetChannelVolumeLevel(int channel, out float decibels);
    int GetChannelVolumeLevelScalar(int channel, out float level);
    [System.Runtime.InteropServices.PreserveSig] int SetMute([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] bool mute, ref Guid context);
    [System.Runtime.InteropServices.PreserveSig] int GetMute([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] out bool mute);
}