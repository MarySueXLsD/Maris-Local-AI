// bin\maris.exe: the `maris` terminal command on Windows.
// Starts Maris.exe as a plain Node.js runtime (ELECTRON_RUN_AS_NODE) with resources\cli\maris.cjs,
// hands it this console's output, and returns its exit code. A real console program (instead of a
// .cmd file) means no "Terminate batch job (Y/N)?" after Ctrl+C.
//
// Keyboard: Maris.exe is a window program, and Windows lets only console programs read a console's
// keys as a terminal. So in a console this program switches the keyboard to raw keys (arrows and
// Ctrl+C arrive as terminal sequences), reads them and passes them on through a pipe, and sets
// MARIS_TTY=1 so the command treats that pipe as its terminal. Piped input is passed on unchanged.
//
// Two helper modes, for Maris itself (no PowerShell needed, which security software rightly watches):
//   maris.exe --maris-start <program> [args]   starts a program with nothing inherited from this console
//   maris.exe --maris-path add|remove <folder> adds or removes a folder in the user's PATH
// Built by scripts/build-cli.cjs with the C# compiler that ships with Windows (.NET Framework 4).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

[assembly: AssemblyTitle("Maris terminal command")]
[assembly: AssemblyDescription("The maris command: chat with Maris, the local AI assistant, from a terminal")]
[assembly: AssemblyProduct("Maris")]
[assembly: AssemblyCompany("MarySue")]
[assembly: AssemblyCopyright("Copyright © 2026 MarySue")]
[assembly: AssemblyVersion(MarisVersion.Value)]
[assembly: AssemblyFileVersion(MarisVersion.Value)]
[assembly: AssemblyInformationalVersion(MarisVersion.Value)]

static class MarisLauncher
{
    const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    const uint HANDLE_FLAG_INHERIT = 1, STARTF_USESTDHANDLES = 0x100, INFINITE = 0xFFFFFFFF;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint ENABLE_PROCESSED_INPUT = 0x1, ENABLE_LINE_INPUT = 0x2, ENABLE_ECHO_INPUT = 0x4, ENABLE_VIRTUAL_TERMINAL_INPUT = 0x200;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    delegate bool ConsoleCtrlHandler(int type);

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr a, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler h, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleMode(IntPtr h, out uint mode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleMode(IntPtr h, uint mode);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ReadConsoleW(IntPtr h, [Out] char[] buf, uint n, out uint read, IntPtr reserved);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr h, byte[] buf, uint n, out uint written, IntPtr overlapped);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);

    // Kept in a field so the garbage collector does not free the callback while Windows holds it.
    static readonly ConsoleCtrlHandler IgnoreCtrlC = type => type == 0 || type == 1;

    static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--maris-start") return StartDetached(args);
        if (args.Length == 3 && args[0] == "--maris-path") return EditPath(args[1] == "add", args[2]);

        string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
        string exe = Path.Combine(root, "Maris.exe");
        string script = Path.Combine(root, "resources", "cli", "maris.cjs");
        if (!File.Exists(exe) || !File.Exists(script))
        {
            Console.Error.WriteLine("maris: this copy of Maris looks incomplete (" + (File.Exists(exe) ? script : exe) + " is missing). Reinstall Maris.");
            return 1;
        }

        var cmd = new StringBuilder();
        cmd.Append(Quote(exe)).Append(' ').Append(Quote(script));
        foreach (string a in args) cmd.Append(' ').Append(Quote(a));

        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1");
        Environment.SetEnvironmentVariable("MARIS_CLI_LAUNCHER", Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "maris.exe"));

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = Inheritable(STD_INPUT_HANDLE);
        si.hStdOutput = Inheritable(STD_OUTPUT_HANDLE);
        si.hStdError = Inheritable(STD_ERROR_HANDLE);

        // A console keyboard: pass the keys on through a pipe (see the note at the top).
        IntPtr console = GetStdHandle(STD_INPUT_HANDLE);
        uint savedMode;
        bool relay = GetConsoleMode(console, out savedMode);
        IntPtr pipeRead = IntPtr.Zero, pipeWrite = IntPtr.Zero;
        if (relay)
        {
            var sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            sa.bInheritHandle = true;
            if (CreatePipe(out pipeRead, out pipeWrite, ref sa, 0))
            {
                SetHandleInformation(pipeWrite, HANDLE_FLAG_INHERIT, 0);
                si.hStdInput = pipeRead;
                SetConsoleMode(console, (savedMode & ~(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT)) | ENABLE_VIRTUAL_TERMINAL_INPUT);
                Environment.SetEnvironmentVariable("MARIS_TTY", "1");
            }
            else relay = false;
        }

        // Closing the terminal window ends Maris's runtime too.
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            // Only the command itself: a Maris it starts in the background keeps running afterwards.
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        }

        // Ctrl+C belongs to the chat (it stops an answer); this program just waits.
        SetConsoleCtrlHandler(IgnoreCtrlC, true);

        PROCESS_INFORMATION pi;
        if (!CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref si, out pi))
        {
            Console.Error.WriteLine("maris: could not start Maris: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
            return 1;
        }
        if (job != IntPtr.Zero) AssignProcessToJobObject(job, pi.hProcess);
        if (relay)
        {
            CloseHandle(pipeRead);
            IntPtr w = pipeWrite;
            var pump = new System.Threading.Thread(() => Pump(console, w));
            pump.IsBackground = true;
            pump.Start();
        }
        WaitForSingleObject(pi.hProcess, INFINITE);
        if (relay) SetConsoleMode(console, savedMode);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return unchecked((int)code);
    }

    // Start a program (Maris in the background) without handing it any of this process's handles, so it
    // never keeps the command's output pipes open. Exit code 9: it quit within 6 seconds (Maris was
    // already running for this profile); 0: it is running; 1: it could not start.
    static int StartDetached(string[] args)
    {
        var cmd = new StringBuilder(Quote(args[1]));
        for (int i = 2; i < args.Length; i++) cmd.Append(' ').Append(Quote(args[i]));
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null);
        Environment.SetEnvironmentVariable("MARIS_TTY", null);
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;
        const uint DETACHED_PROCESS = 0x8, CREATE_NEW_PROCESS_GROUP = 0x200;
        if (!CreateProcessW(args[1], cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, IntPtr.Zero, null, ref si, out pi))
        {
            Console.Error.WriteLine("maris: could not start " + args[1] + ": " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
            return 1;
        }
        uint waited = WaitForSingleObject(pi.hProcess, 6000);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return waited == 0 ? 9 : 0;
    }

    // Add or remove a folder in the user's PATH. The value stays REG_EXPAND_SZ so %VARIABLES% in it keep
    // working, and every window hears about the change (new terminals see it at once).
    static int EditPath(bool add, string folder)
    {
        try
        {
            // Tests point this at a scratch key (never the real PATH).
            string keyName = Environment.GetEnvironmentVariable("MARIS_TEST_ENV_KEY") ?? "Environment";
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(keyName))
            {
                bool exists = key.GetValue("Path") != null;
                RegistryValueKind kind = exists ? key.GetValueKind("Path") : RegistryValueKind.ExpandString;
                string raw = (key.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string) ?? "";
                string want = Normal(folder);
                var parts = new List<string>();
                bool found = false;
                foreach (string p in raw.Split(';'))
                {
                    if (p.Trim().Length == 0) continue;
                    if (Normal(p) == want) { found = true; if (!add) continue; }
                    parts.Add(p);
                }
                if (add && !found) parts.Add(folder);
                string next = string.Join(";", parts.ToArray());
                if (next != raw) key.SetValue("Path", next, kind == RegistryValueKind.String ? RegistryValueKind.String : RegistryValueKind.ExpandString);
            }
            IntPtr result;
            SendMessageTimeoutW(new IntPtr(0xFFFF), 0x1A, IntPtr.Zero, "Environment", 2, 5000, out result);
            Console.WriteLine("done");
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("maris: could not change PATH: " + e.Message);
            return 1;
        }
    }

    static string Normal(string p)
    {
        return Environment.ExpandEnvironmentVariables(p.Trim()).TrimEnd('\\').ToLowerInvariant();
    }

    // Keys from the console to the pipe, as UTF-8 (a stateful encoder keeps emoji whole across reads).
    static void Pump(IntPtr console, IntPtr pipe)
    {
        var buf = new char[512];
        var bytes = new byte[2048];
        Encoder utf8 = new UTF8Encoding(false).GetEncoder();
        for (;;)
        {
            uint n;
            if (!ReadConsoleW(console, buf, (uint)buf.Length, out n, IntPtr.Zero) || n == 0) return;
            int len = utf8.GetBytes(buf, 0, (int)n, bytes, 0, false);
            uint written;
            if (len > 0 && !WriteFile(pipe, bytes, (uint)len, out written, IntPtr.Zero)) return;
        }
    }

    static IntPtr Inheritable(int which)
    {
        IntPtr h = GetStdHandle(which);
        if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        return h;
    }

    // Quote one argument so CommandLineToArgvW (and Node) read it back exactly.
    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        for (int i = 0; i < arg.Length; i++)
        {
            int slashes = 0;
            while (i < arg.Length && arg[i] == '\\') { slashes++; i++; }
            if (i == arg.Length) { sb.Append('\\', slashes * 2); break; }
            if (arg[i] == '"') sb.Append('\\', slashes * 2 + 1).Append('"');
            else sb.Append('\\', slashes).Append(arg[i]);
        }
        return sb.Append('"').ToString();
    }
}
