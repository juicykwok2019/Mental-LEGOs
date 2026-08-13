using System;
using System.IO;
using System.Net.Sockets;
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

    public static int Main(string[] args)
    {
        if (args.Length != 6)
        {
            Console.Error.WriteLine("Expected five file paths and one loopback port.");
            return 2;
        }

        bool isAppContainer = IsAppContainer();
        bool allowedRead = CanRead(args[0]);
        bool allowedWrite = CanWrite(args[1]);
        bool readOnlyWrite = CanWrite(args[2]);
        bool forbiddenRead = CanRead(args[3]);
        bool forbiddenWrite = CanWrite(args[4]);
        bool loopbackConnect = CanConnectLoopback(Int32.Parse(args[5]));

        Console.WriteLine("is_app_container=" + isAppContainer.ToString().ToLowerInvariant());
        Console.WriteLine("allowed_read=" + allowedRead.ToString().ToLowerInvariant());
        Console.WriteLine("allowed_write=" + allowedWrite.ToString().ToLowerInvariant());
        Console.WriteLine("readonly_write=" + readOnlyWrite.ToString().ToLowerInvariant());
        Console.WriteLine("forbidden_read=" + forbiddenRead.ToString().ToLowerInvariant());
        Console.WriteLine("forbidden_write=" + forbiddenWrite.ToString().ToLowerInvariant());
        Console.WriteLine("loopback_connect=" + loopbackConnect.ToString().ToLowerInvariant());

        return isAppContainer
            && allowedRead
            && allowedWrite
            && !readOnlyWrite
            && !forbiddenRead
            && !forbiddenWrite
            && !loopbackConnect
            ? 0
            : 1;
    }
}
