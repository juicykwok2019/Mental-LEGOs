using System;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Text;

internal static class ProviderClientProbe
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2) throw new ArgumentException();
            int port = Int32.Parse(args[0], CultureInfo.InvariantCulture);
            string token = args[1];
            if (port < 1024 || port > 65535 || token.Length != 64) throw new ArgumentException();

            byte[] body = Utf8.GetBytes("{\"model\":\"synthetic\"}");
            string head = "POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                + "Anthropic-Version: 2023-06-01\r\nContent-Type: application/json\r\n"
                + "X-Api-Key: " + token + "\r\nContent-Length: "
                + body.Length.ToString(CultureInfo.InvariantCulture)
                + "\r\nConnection: close\r\n\r\n";

            using (TcpClient client = new TcpClient())
            {
                client.ReceiveTimeout = 10000;
                client.SendTimeout = 10000;
                client.Connect("127.0.0.1", port);
                NetworkStream stream = client.GetStream();
                byte[] headerBytes = Encoding.ASCII.GetBytes(head);
                stream.Write(headerBytes, 0, headerBytes.Length);
                stream.Write(body, 0, body.Length);
                stream.Flush();

                using (MemoryStream response = new MemoryStream())
                {
                    byte[] buffer = new byte[4096];
                    int read;
                    while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                        response.Write(buffer, 0, read);
                    string text = Utf8.GetString(response.ToArray());
                    if (!text.StartsWith("HTTP/1.1 200 ", StringComparison.Ordinal)
                        || text.IndexOf("same-container-provider-ok", StringComparison.Ordinal) < 0)
                        throw new InvalidDataException();
                }
            }

            Console.WriteLine("same-container-provider-ok");
            return 0;
        }
        catch
        {
            Console.Error.WriteLine("Provider client isolation probe failed.");
            return 1;
        }
    }
}
