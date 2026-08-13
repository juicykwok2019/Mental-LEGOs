using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

internal static class CredentialVault
{
    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;
    private static readonly Regex TargetPattern = new Regex(
        @"^MentalLEGOs/[a-z0-9-]{1,32}/[a-f0-9-]{36}$",
        RegexOptions.CultureInvariant);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(
        string targetName,
        uint type,
        uint flags,
        out IntPtr credentialPointer);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string targetName, uint type, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2) throw new ArgumentException("A command and target are required.");
            string command = args[0];
            string target = args[1];
            if (!TargetPattern.IsMatch(target)) throw new ArgumentException("Invalid credential target.");

            if (command == "write")
            {
                Write(target, Console.In.ReadToEnd().TrimEnd('\r', '\n'));
                return 0;
            }
            if (command == "read")
            {
                Console.Out.Write(Read(target));
                return 0;
            }
            if (command == "exists")
            {
                Console.Out.Write(Exists(target) ? "true" : "false");
                return 0;
            }
            if (command == "delete")
            {
                Delete(target);
                return 0;
            }
            throw new ArgumentException("Unknown credential command.");
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine("Mental LEGOs credential vault failed: " + exception.Message);
            return 1;
        }
    }

    private static void Write(string target, string secret)
    {
        if (String.IsNullOrEmpty(secret)) throw new ArgumentException("Credential value cannot be empty.");
        byte[] bytes = Encoding.Unicode.GetBytes(secret);
        if (bytes.Length > 2560) throw new ArgumentException("Credential value is too long.");

        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            Credential credential = new Credential();
            credential.Type = CredTypeGeneric;
            credential.TargetName = target;
            credential.CredentialBlobSize = (uint)bytes.Length;
            credential.CredentialBlob = blob;
            credential.Persist = CredPersistLocalMachine;
            credential.UserName = "Mental LEGOs local user";
            if (!CredWrite(ref credential, 0))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            for (int index = 0; index < bytes.Length; index++) bytes[index] = 0;
            for (int index = 0; index < bytes.Length; index++) Marshal.WriteByte(blob, index, 0);
            Marshal.FreeHGlobal(blob);
        }
    }

    private static string Read(string target)
    {
        IntPtr pointer;
        if (!CredRead(target, CredTypeGeneric, 0, out pointer))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try
        {
            Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0)
            {
                throw new InvalidOperationException("Credential value is empty.");
            }
            byte[] bytes = new byte[credential.CredentialBlobSize];
            try
            {
                Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
                return Encoding.Unicode.GetString(bytes);
            }
            finally
            {
                for (int index = 0; index < bytes.Length; index++) bytes[index] = 0;
            }
        }
        finally
        {
            CredFree(pointer);
        }
    }

    private static bool Exists(string target)
    {
        IntPtr pointer;
        if (CredRead(target, CredTypeGeneric, 0, out pointer))
        {
            CredFree(pointer);
            return true;
        }
        int error = Marshal.GetLastWin32Error();
        if (error == ErrorNotFound) return false;
        throw new Win32Exception(error);
    }

    private static void Delete(string target)
    {
        if (CredDelete(target, CredTypeGeneric, 0)) return;
        int error = Marshal.GetLastWin32Error();
        if (error != ErrorNotFound) throw new Win32Exception(error);
    }
}
