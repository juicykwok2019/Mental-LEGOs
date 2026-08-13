using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class BashProxy
{
    private const int BrokerTimeoutSeconds = 120;
    private const long MaximumResponseBytes = 12L * 1024L * 1024L;

    private static string Encode(string value)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    }

    private static string Decode(string value)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }

    private static bool IsValidToken(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length != 64) return false;
        foreach (char character in value)
        {
            bool digit = character >= '0' && character <= '9';
            bool lowerHex = character >= 'a' && character <= 'f';
            if (!digit && !lowerHex) return false;
        }
        return true;
    }

    private static void DeleteIfPresent(string filePath)
    {
        try
        {
            if (File.Exists(filePath)) File.Delete(filePath);
        }
        catch
        {
            // The broker owns final cleanup if the sandbox loses access.
        }
    }

    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        string ipcDirectory = Environment.GetEnvironmentVariable("MENTAL_LEGOS_BASH_IPC_DIR");
        string token = Environment.GetEnvironmentVariable("MENTAL_LEGOS_BASH_PROXY_TOKEN");
        if (
            String.IsNullOrWhiteSpace(ipcDirectory)
            || !Path.IsPathRooted(ipcDirectory)
            || !Directory.Exists(ipcDirectory)
            || !IsValidToken(token)
        )
        {
            Console.Error.WriteLine("Mental LEGOs Bash broker is unavailable.");
            return 125;
        }

        string requestId = Process.GetCurrentProcess().Id + "-" + Guid.NewGuid().ToString("N");
        string temporaryRequest = Path.Combine(ipcDirectory, requestId + ".request.tmp");
        string request = Path.Combine(ipcDirectory, requestId + ".request");
        string response = Path.Combine(ipcDirectory, requestId + ".response");
        try
        {
            string[] lines = new string[args.Length + 2];
            lines[0] = "MLB2";
            lines[1] = token;
            for (int index = 0; index < args.Length; index++)
            {
                lines[index + 2] = Encode(args[index]);
            }
            File.WriteAllLines(temporaryRequest, lines, new UTF8Encoding(false));
            File.Move(temporaryRequest, request);

            Stopwatch timeout = Stopwatch.StartNew();
            while (!File.Exists(response))
            {
                if (timeout.Elapsed > TimeSpan.FromSeconds(BrokerTimeoutSeconds))
                {
                    Console.Error.WriteLine("Mental LEGOs Bash broker timed out.");
                    return 124;
                }
                Thread.Sleep(20);
            }

            FileInfo responseInfo = new FileInfo(response);
            if (responseInfo.Length > MaximumResponseBytes)
            {
                Console.Error.WriteLine("Mental LEGOs Bash broker response was too large.");
                return 125;
            }
            string responseText = File.ReadAllText(response, Encoding.UTF8).Replace("\r\n", "\n");
            string[] result = responseText.Split(new char[] { '\n' });
            if (result.Length != 4 || result[0] != "MLR2")
            {
                Console.Error.WriteLine("Mental LEGOs Bash broker returned an invalid response.");
                return 125;
            }
            int exitCode;
            if (!Int32.TryParse(result[1], out exitCode)) exitCode = 125;
            Console.Out.Write(Decode(result[2]));
            Console.Error.Write(Decode(result[3]));
            return exitCode;
        }
        catch
        {
            Console.Error.WriteLine("Mental LEGOs Bash broker request failed.");
            return 125;
        }
        finally
        {
            DeleteIfPresent(temporaryRequest);
            DeleteIfPresent(request);
            DeleteIfPresent(response);
        }
    }
}
