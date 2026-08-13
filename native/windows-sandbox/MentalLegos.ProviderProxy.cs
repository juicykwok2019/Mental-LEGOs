using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class ProviderProxy
{
    private const int MaximumHeaderBytes = 64 * 1024;
    private const int MaximumBodyBytes = 32 * 1024 * 1024;
    private const int BrokerTimeoutMilliseconds = 10 * 60 * 1000;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly HashSet<string> ForwardedHeaders = new HashSet<string>(
        new string[] {
            "accept",
            "anthropic-beta",
            "anthropic-version",
            "content-type",
            "user-agent",
            "x-app",
        },
        StringComparer.OrdinalIgnoreCase);

    private sealed class RequestData
    {
        public string Method;
        public string Path;
        public readonly Dictionary<string, string> Headers = new Dictionary<string, string>(
            StringComparer.OrdinalIgnoreCase);
        public byte[] Body;
    }

    private sealed class ResponseHead
    {
        public int Status;
        public readonly List<KeyValuePair<string, string>> Headers =
            new List<KeyValuePair<string, string>>();
    }

    public static int Main()
    {
        try
        {
            string ipcDirectory = Environment.GetEnvironmentVariable("MENTAL_LEGOS_PROVIDER_IPC_DIR");
            string ipcToken = Environment.GetEnvironmentVariable("MENTAL_LEGOS_PROVIDER_IPC_TOKEN");
            string requestToken = Environment.GetEnvironmentVariable("MENTAL_LEGOS_PROVIDER_REQUEST_TOKEN");
            if (!Directory.Exists(ipcDirectory) || !ValidToken(ipcToken) || !ValidToken(requestToken))
            {
                Console.Error.WriteLine("Mental LEGOs provider broker is unavailable.");
                return 125;
            }

            TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start(8);
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            string readyTemporary = Path.Combine(ipcDirectory, ".ready.tmp");
            string ready = Path.Combine(ipcDirectory, ".ready");
            File.WriteAllText(readyTemporary, port.ToString(CultureInfo.InvariantCulture), Utf8);
            File.Move(readyTemporary, ready);

            while (true)
            {
                using (TcpClient client = listener.AcceptTcpClient())
                {
                    client.ReceiveTimeout = BrokerTimeoutMilliseconds;
                    client.SendTimeout = BrokerTimeoutMilliseconds;
                    HandleClient(client, ipcDirectory, ipcToken, requestToken);
                }
            }
        }
        catch (Exception)
        {
            Console.Error.WriteLine("Mental LEGOs provider proxy failed.");
            return 125;
        }
    }

    private static bool ValidToken(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length != 64) return false;
        foreach (char character in value)
        {
            if (!((character >= '0' && character <= '9')
                || (character >= 'a' && character <= 'f'))) return false;
        }
        return true;
    }

    private static void HandleClient(
        TcpClient client,
        string ipcDirectory,
        string ipcToken,
        string requestToken)
    {
        NetworkStream stream = client.GetStream();
        bool responseStarted = false;
        string requestId = null;
        try
        {
            RequestData request = ReadRequest(stream);
            string suppliedToken;
            if (!request.Headers.TryGetValue("x-api-key", out suppliedToken)
                || !FixedTimeEquals(suppliedToken, requestToken))
            {
                WriteError(stream, 401, "Provider broker authentication failed.");
                return;
            }

            requestId = CreateRequestId();
            WriteBrokerRequest(ipcDirectory, requestId, ipcToken, request);
            ResponseHead head = WaitForResponseHead(ipcDirectory, requestId, ipcToken);
            WriteResponseHead(stream, head);
            responseStarted = true;
            StreamResponseBody(stream, ipcDirectory, requestId);
        }
        catch (Exception)
        {
            if (!responseStarted)
            {
                try { WriteError(stream, 502, "Provider broker request failed."); }
                catch { }
            }
        }
        finally
        {
            if (!String.IsNullOrEmpty(requestId)) DeleteExchangeFiles(ipcDirectory, requestId);
        }
    }

    private static RequestData ReadRequest(NetworkStream stream)
    {
        byte[] headerBuffer = new byte[MaximumHeaderBytes];
        int headerLength = 0;
        int matched = 0;
        byte[] terminator = new byte[] { 13, 10, 13, 10 };
        while (headerLength < headerBuffer.Length)
        {
            int value = stream.ReadByte();
            if (value < 0) throw new EndOfStreamException();
            headerBuffer[headerLength++] = (byte)value;
            if (value == terminator[matched])
            {
                matched++;
                if (matched == terminator.Length) break;
            }
            else
            {
                matched = value == terminator[0] ? 1 : 0;
            }
        }
        if (matched != terminator.Length) throw new InvalidDataException("HTTP headers are too large.");

        string headerText = Encoding.ASCII.GetString(headerBuffer, 0, headerLength - 4);
        string[] lines = headerText.Split(new string[] { "\r\n" }, StringSplitOptions.None);
        if (lines.Length == 0) throw new InvalidDataException("HTTP request line is missing.");
        string[] requestLine = lines[0].Split(' ');
        if (requestLine.Length != 3 || requestLine[2] != "HTTP/1.1")
            throw new InvalidDataException("Unsupported HTTP request line.");
        if (requestLine[0] != "POST" || !requestLine[1].StartsWith("/", StringComparison.Ordinal))
            throw new InvalidDataException("Unsupported provider request.");

        RequestData request = new RequestData();
        request.Method = requestLine[0];
        request.Path = requestLine[1];
        for (int index = 1; index < lines.Length; index++)
        {
            int separator = lines[index].IndexOf(':');
            if (separator <= 0) throw new InvalidDataException("Malformed HTTP header.");
            string name = lines[index].Substring(0, separator).Trim().ToLowerInvariant();
            string value = lines[index].Substring(separator + 1).Trim();
            if (name.Length == 0 || value.IndexOfAny(new char[] { '\r', '\n' }) >= 0)
                throw new InvalidDataException("Unsafe HTTP header.");
            if (request.Headers.ContainsKey(name))
                throw new InvalidDataException("Duplicate HTTP headers are not accepted.");
            request.Headers.Add(name, value);
        }

        string transferEncoding;
        string contentLengthText;
        bool chunked = request.Headers.TryGetValue("transfer-encoding", out transferEncoding);
        bool hasLength = request.Headers.TryGetValue("content-length", out contentLengthText);
        if (chunked && hasLength) throw new InvalidDataException("Ambiguous HTTP framing.");
        if (chunked)
        {
            if (!String.Equals(transferEncoding, "chunked", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Unsupported transfer encoding.");
            request.Body = ReadChunkedBody(stream);
        }
        else
        {
            int contentLength = 0;
            if (hasLength && (!Int32.TryParse(contentLengthText, NumberStyles.None,
                CultureInfo.InvariantCulture, out contentLength) || contentLength < 0))
                throw new InvalidDataException("Invalid content length.");
            if (contentLength > MaximumBodyBytes) throw new InvalidDataException("Request body is too large.");
            request.Body = ReadExactly(stream, contentLength);
        }
        return request;
    }

    private static byte[] ReadChunkedBody(NetworkStream stream)
    {
        using (MemoryStream body = new MemoryStream())
        {
            while (true)
            {
                string sizeLine = ReadAsciiLine(stream, 64);
                int extension = sizeLine.IndexOf(';');
                string sizeText = extension < 0 ? sizeLine : sizeLine.Substring(0, extension);
                int chunkSize;
                if (!Int32.TryParse(sizeText, NumberStyles.AllowHexSpecifier,
                    CultureInfo.InvariantCulture, out chunkSize) || chunkSize < 0)
                    throw new InvalidDataException("Invalid HTTP chunk size.");
                if (body.Length + chunkSize > MaximumBodyBytes)
                    throw new InvalidDataException("Request body is too large.");
                if (chunkSize == 0)
                {
                    if (ReadAsciiLine(stream, MaximumHeaderBytes).Length != 0)
                        throw new InvalidDataException("HTTP trailers are not accepted.");
                    return body.ToArray();
                }
                byte[] chunk = ReadExactly(stream, chunkSize);
                body.Write(chunk, 0, chunk.Length);
                if (stream.ReadByte() != 13 || stream.ReadByte() != 10)
                    throw new InvalidDataException("Malformed HTTP chunk.");
            }
        }
    }

    private static string ReadAsciiLine(NetworkStream stream, int maximumBytes)
    {
        using (MemoryStream line = new MemoryStream())
        {
            while (line.Length < maximumBytes)
            {
                int value = stream.ReadByte();
                if (value < 0) throw new EndOfStreamException();
                if (value == 13)
                {
                    if (stream.ReadByte() != 10) throw new InvalidDataException("Malformed HTTP line.");
                    return Encoding.ASCII.GetString(line.ToArray());
                }
                line.WriteByte((byte)value);
            }
            throw new InvalidDataException("HTTP line is too long.");
        }
    }

    private static byte[] ReadExactly(Stream stream, int bytes)
    {
        byte[] result = new byte[bytes];
        int position = 0;
        while (position < bytes)
        {
            int read = stream.Read(result, position, bytes - position);
            if (read <= 0) throw new EndOfStreamException();
            position += read;
        }
        return result;
    }

    private static bool FixedTimeEquals(string left, string right)
    {
        if (left.Length != right.Length) return false;
        int difference = 0;
        for (int index = 0; index < left.Length; index++) difference |= left[index] ^ right[index];
        return difference == 0;
    }

    private static string CreateRequestId()
    {
        byte[] random = new byte[16];
        using (RandomNumberGenerator generator = RandomNumberGenerator.Create()) generator.GetBytes(random);
        return ProcessId().ToString(CultureInfo.InvariantCulture) + "-" + Hex(random);
    }

    private static int ProcessId()
    {
        return System.Diagnostics.Process.GetCurrentProcess().Id;
    }

    private static string Hex(byte[] bytes)
    {
        StringBuilder result = new StringBuilder(bytes.Length * 2);
        foreach (byte value in bytes) result.Append(value.ToString("x2", CultureInfo.InvariantCulture));
        return result.ToString();
    }

    private static void WriteBrokerRequest(
        string ipcDirectory,
        string requestId,
        string ipcToken,
        RequestData request)
    {
        string temporaryPath = Path.Combine(ipcDirectory, requestId + ".request.tmp");
        string requestPath = Path.Combine(ipcDirectory, requestId + ".request");
        using (FileStream file = new FileStream(
            temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (StreamWriter writer = new StreamWriter(file, Utf8, 4096, true))
        {
            writer.NewLine = "\n";
            writer.WriteLine("MLP1");
            writer.WriteLine(ipcToken);
            writer.WriteLine(Convert.ToBase64String(Utf8.GetBytes(request.Method)));
            writer.WriteLine(Convert.ToBase64String(Utf8.GetBytes(request.Path)));
            List<KeyValuePair<string, string>> forwarded = new List<KeyValuePair<string, string>>();
            foreach (KeyValuePair<string, string> header in request.Headers)
            {
                if (ForwardedHeaders.Contains(header.Key)) forwarded.Add(header);
            }
            writer.WriteLine(forwarded.Count.ToString(CultureInfo.InvariantCulture));
            foreach (KeyValuePair<string, string> header in forwarded)
            {
                writer.Write(Convert.ToBase64String(Utf8.GetBytes(header.Key)));
                writer.Write('\t');
                writer.WriteLine(Convert.ToBase64String(Utf8.GetBytes(header.Value)));
            }
            writer.WriteLine(request.Body.Length.ToString(CultureInfo.InvariantCulture));
            writer.Flush();
            file.Write(request.Body, 0, request.Body.Length);
            file.Flush(true);
        }
        File.Move(temporaryPath, requestPath);
    }

    private static ResponseHead WaitForResponseHead(
        string ipcDirectory,
        string requestId,
        string ipcToken)
    {
        string headPath = Path.Combine(ipcDirectory, requestId + ".response.head");
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(BrokerTimeoutMilliseconds);
        while (!File.Exists(headPath))
        {
            if (DateTime.UtcNow >= deadline) throw new TimeoutException();
            Thread.Sleep(20);
        }
        string[] lines = File.ReadAllLines(headPath, Utf8);
        if (lines.Length < 4 || lines[0] != "MLPR1" || !FixedTimeEquals(lines[1], ipcToken))
            throw new InvalidDataException("Invalid broker response.");
        int status;
        int headerCount;
        if (!Int32.TryParse(lines[2], NumberStyles.None, CultureInfo.InvariantCulture, out status)
            || status < 100 || status > 599
            || !Int32.TryParse(lines[3], NumberStyles.None, CultureInfo.InvariantCulture, out headerCount)
            || headerCount < 0 || headerCount > 32
            || lines.Length != 4 + headerCount)
            throw new InvalidDataException("Invalid broker response head.");
        ResponseHead result = new ResponseHead();
        result.Status = status;
        for (int index = 0; index < headerCount; index++)
        {
            string[] parts = lines[4 + index].Split(new char[] { '\t' }, 2);
            if (parts.Length != 2) throw new InvalidDataException("Invalid broker response header.");
            result.Headers.Add(new KeyValuePair<string, string>(
                Utf8.GetString(Convert.FromBase64String(parts[0])),
                Utf8.GetString(Convert.FromBase64String(parts[1]))));
        }
        return result;
    }

    private static void WriteResponseHead(NetworkStream stream, ResponseHead response)
    {
        StringBuilder head = new StringBuilder();
        head.Append("HTTP/1.1 ");
        head.Append(response.Status.ToString(CultureInfo.InvariantCulture));
        head.Append(' ');
        head.Append(StatusReason(response.Status));
        head.Append("\r\n");
        foreach (KeyValuePair<string, string> header in response.Headers)
        {
            head.Append(header.Key);
            head.Append(": ");
            head.Append(header.Value);
            head.Append("\r\n");
        }
        head.Append("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
        byte[] bytes = Encoding.ASCII.GetBytes(head.ToString());
        stream.Write(bytes, 0, bytes.Length);
    }

    private static string StatusReason(int status)
    {
        if (status == 200) return "OK";
        if (status == 400) return "Bad Request";
        if (status == 401) return "Unauthorized";
        if (status == 403) return "Forbidden";
        if (status == 404) return "Not Found";
        if (status == 429) return "Too Many Requests";
        if (status == 500) return "Internal Server Error";
        if (status == 502) return "Bad Gateway";
        if (status == 503) return "Service Unavailable";
        return "Provider Response";
    }

    private static void StreamResponseBody(NetworkStream output, string ipcDirectory, string requestId)
    {
        string bodyPath = Path.Combine(ipcDirectory, requestId + ".response.body");
        string donePath = Path.Combine(ipcDirectory, requestId + ".response.done");
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(BrokerTimeoutMilliseconds);
        while (!File.Exists(bodyPath))
        {
            if (DateTime.UtcNow >= deadline) throw new TimeoutException();
            Thread.Sleep(10);
        }
        using (FileStream input = new FileStream(
            bodyPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            byte[] buffer = new byte[16 * 1024];
            while (true)
            {
                int read = input.Read(buffer, 0, buffer.Length);
                if (read > 0)
                {
                    WriteChunk(output, buffer, read);
                    deadline = DateTime.UtcNow.AddMilliseconds(BrokerTimeoutMilliseconds);
                    continue;
                }
                if (File.Exists(donePath))
                {
                    string done = File.ReadAllText(donePath, Utf8);
                    if (!done.StartsWith("OK\n", StringComparison.Ordinal))
                        throw new IOException("Provider stream failed.");
                    if (input.Position >= input.Length) break;
                }
                if (DateTime.UtcNow >= deadline) throw new TimeoutException();
                Thread.Sleep(10);
            }
        }
        byte[] terminal = Encoding.ASCII.GetBytes("0\r\n\r\n");
        output.Write(terminal, 0, terminal.Length);
    }

    private static void WriteChunk(NetworkStream output, byte[] buffer, int bytes)
    {
        byte[] prefix = Encoding.ASCII.GetBytes(bytes.ToString("x", CultureInfo.InvariantCulture) + "\r\n");
        output.Write(prefix, 0, prefix.Length);
        output.Write(buffer, 0, bytes);
        output.WriteByte(13);
        output.WriteByte(10);
        output.Flush();
    }

    private static void WriteError(NetworkStream stream, int status, string message)
    {
        string json = "{\"type\":\"error\",\"error\":{\"type\":\"broker_error\",\"message\":\""
            + message.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}}";
        byte[] body = Utf8.GetBytes(json);
        string head = "HTTP/1.1 " + status.ToString(CultureInfo.InvariantCulture) + " "
            + StatusReason(status) + "\r\nContent-Type: application/json\r\nContent-Length: "
            + body.Length.ToString(CultureInfo.InvariantCulture) + "\r\nConnection: close\r\n\r\n";
        byte[] headBytes = Encoding.ASCII.GetBytes(head);
        stream.Write(headBytes, 0, headBytes.Length);
        stream.Write(body, 0, body.Length);
    }

    private static void DeleteExchangeFiles(string ipcDirectory, string requestId)
    {
        foreach (string suffix in new string[] {
            ".request.tmp", ".request", ".processing", ".response.head",
            ".response.body", ".response.done"
        })
        {
            try { File.Delete(Path.Combine(ipcDirectory, requestId + suffix)); }
            catch { }
        }
    }
}
