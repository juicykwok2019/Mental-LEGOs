using System;
using System.IO;
using System.Net.Sockets;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class SandboxProbe
{
    private const uint TokenQuery = 0x0008;
    private const int TokenIsAppContainer = 29;

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        IntPtr token,
        int informationClass,
        out int information,
        int informationLength,
        out int returnLength);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static bool IsAppContainer()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TokenQuery, out token)) return false;
        try
        {
            int value;
            int returned;
            return GetTokenInformation(token, TokenIsAppContainer, out value, sizeof(int), out returned)
                && value != 0;
        }
        finally
        {
            CloseHandle(token);
        }
    }

    private static bool CanRead(string path)
    {
        try
        {
            File.ReadAllText(path, Encoding.UTF8);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool CanWrite(string path)
    {
        try
        {
            File.WriteAllText(path, "sandbox-probe", Encoding.UTF8);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool CanConnectLoopback(int port)
    {
        try
        {
            using (TcpClient client = new TcpClient())
            {
                IAsyncResult result = client.BeginConnect("127.0.0.1", port, null, null);
                if (!result.AsyncWaitHandle.WaitOne(TimeSpan.FromSeconds(2))) return false;
                client.EndConnect(result);
                return true;
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool CanLaunchContainedChild(string forbiddenPath)
    {
        try
        {
            ProcessStartInfo start = new ProcessStartInfo(
                Process.GetCurrentProcess().MainModule.FileName,
                "--child " + QuoteArgument(forbiddenPath));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            using (Process child = Process.Start(start))
            {
                string output = child.StandardOutput.ReadToEnd();
                child.WaitForExit(5000);
                return child.ExitCode == 0 && output.Trim() == "contained-child=true";
            }
        }
        catch
        {
            return false;
        }
    }

    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    public static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--child")
        {
            bool contained = IsAppContainer()
                && !CanRead(args[1])
                && !CanWrite(args[1] + ".child-escape");
            Console.WriteLine("contained-child=" + contained.ToString().ToLowerInvariant());
            return contained ? 0 : 1;
        }

        if (args.Length != 10)
        {
            Console.Error.WriteLine("Expected nine paths and one loopback port.");
            return 2;
        }

        bool isAppContainer = IsAppContainer();
        bool allowedRead = CanRead(args[0]);
        bool allowedWrite = CanWrite(args[1]);
        bool readOnlyWrite = CanWrite(args[2]);
        bool forbiddenRead = CanRead(args[3]);
        bool forbiddenWrite = CanWrite(args[4]);
        bool junctionRead = CanRead(args[5]);
        bool otherSessionRead = CanRead(args[6]);
        bool repositoryRead = CanRead(args[7]);
        bool installWrite = CanWrite(args[8]);
        bool loopbackConnect = CanConnectLoopback(Int32.Parse(args[9]));
        bool containedChild = CanLaunchContainedChild(args[3]);
        bool secretVisible = !String.IsNullOrEmpty(
            Environment.GetEnvironmentVariable("MENTAL_LEGOS_PROBE_SECRET"));

        Console.WriteLine("is_app_container=" + isAppContainer.ToString().ToLowerInvariant());
        Console.WriteLine("allowed_read=" + allowedRead.ToString().ToLowerInvariant());
        Console.WriteLine("allowed_write=" + allowedWrite.ToString().ToLowerInvariant());
        Console.WriteLine("readonly_write=" + readOnlyWrite.ToString().ToLowerInvariant());
        Console.WriteLine("forbidden_read=" + forbiddenRead.ToString().ToLowerInvariant());
        Console.WriteLine("forbidden_write=" + forbiddenWrite.ToString().ToLowerInvariant());
        Console.WriteLine("junction_read=" + junctionRead.ToString().ToLowerInvariant());
        Console.WriteLine("other_session_read=" + otherSessionRead.ToString().ToLowerInvariant());
        Console.WriteLine("repository_read=" + repositoryRead.ToString().ToLowerInvariant());
        Console.WriteLine("install_write=" + installWrite.ToString().ToLowerInvariant());
        Console.WriteLine("loopback_connect=" + loopbackConnect.ToString().ToLowerInvariant());
        Console.WriteLine("contained_child=" + containedChild.ToString().ToLowerInvariant());
        Console.WriteLine("secret_visible=" + secretVisible.ToString().ToLowerInvariant());

        return isAppContainer
            && allowedRead
            && allowedWrite
            && !readOnlyWrite
            && !forbiddenRead
            && !forbiddenWrite
            && !junctionRead
            && !otherSessionRead
            && !repositoryRead
            && !installWrite
            && !loopbackConnect
            && containedChild
            && !secretVisible
            ? 0
            : 1;
    }
}
