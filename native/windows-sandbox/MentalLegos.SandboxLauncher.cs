using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

internal static class SandboxLauncher
{
    private const int ErrorAlreadyExistsHResult = unchecked((int)0x800700B7);
    private const int ErrorInsufficientBuffer = 122;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint ProcThreadAttributeHandleList = 0x00020002;
    private const uint ProcThreadAttributeSecurityCapabilities = 0x00020009;
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint StdInputHandle = unchecked((uint)-10);
    private const uint StdOutputHandle = unchecked((uint)-11);
    private const uint StdErrorHandle = unchecked((uint)-12);
    private const uint HandleFlagInherit = 0x00000001;

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityCapabilities
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(
        string appContainerName,
        string displayName,
        string description,
        IntPtr capabilities,
        uint capabilityCount,
        out IntPtr appContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(
        string appContainerName,
        out IntPtr appContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(string appContainerName);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(uint stdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        uint informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private sealed class RunArguments
    {
        public string ProfileName;
        public string Workspace;
        public string Target;
        public readonly List<string> ReadOnlyPaths = new List<string>();
        public readonly List<string> WritablePaths = new List<string>();
        public readonly List<string> TargetArguments = new List<string>();
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) throw new ArgumentException("A command is required.");
            if (String.Equals(args[0], "run", StringComparison.Ordinal))
            {
                return Run(ParseRunArguments(args));
            }
            if (String.Equals(args[0], "delete-profile", StringComparison.Ordinal))
            {
                if (args.Length != 2) throw new ArgumentException("delete-profile requires a profile name.");
                int result = DeleteAppContainerProfile(args[1]);
                if (result < 0) Marshal.ThrowExceptionForHR(result);
                return 0;
            }
            throw new ArgumentException("Unknown sandbox command.");
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine("Mental LEGOs sandbox launcher failed: " + exception);
            return 125;
        }
    }

    private static RunArguments ParseRunArguments(string[] args)
    {
        RunArguments parsed = new RunArguments();
        int index = 1;
        while (index < args.Length)
        {
            string current = args[index++];
            if (current == "--")
            {
                while (index < args.Length) parsed.TargetArguments.Add(args[index++]);
                break;
            }
            if (index >= args.Length) throw new ArgumentException("Missing value for " + current + ".");
            string value = Path.GetFullPath(args[index++]);
            if (current == "--profile") parsed.ProfileName = args[index - 1];
            else if (current == "--workspace") parsed.Workspace = value;
            else if (current == "--target") parsed.Target = value;
            else if (current == "--read-only") parsed.ReadOnlyPaths.Add(value);
            else if (current == "--writable") parsed.WritablePaths.Add(value);
            else throw new ArgumentException("Unknown option " + current + ".");
        }

        if (String.IsNullOrWhiteSpace(parsed.ProfileName)) throw new ArgumentException("--profile is required.");
        if (String.IsNullOrWhiteSpace(parsed.Workspace)) throw new ArgumentException("--workspace is required.");
        if (String.IsNullOrWhiteSpace(parsed.Target)) throw new ArgumentException("--target is required.");
        if (!Directory.Exists(parsed.Workspace)) throw new DirectoryNotFoundException(parsed.Workspace);
        if (!File.Exists(parsed.Target)) throw new FileNotFoundException("Sandbox target not found.", parsed.Target);
        return parsed;
    }

    private static IntPtr CreateOrDeriveProfile(string profileName)
    {
        IntPtr sid;
        int result = CreateAppContainerProfile(
            profileName,
            "Mental LEGOs Agent Session",
            "Per-session isolation for the local Claude Agent SDK runtime.",
            IntPtr.Zero,
            0,
            out sid);
        if (result == ErrorAlreadyExistsHResult)
        {
            result = DeriveAppContainerSidFromAppContainerName(profileName, out sid);
        }
        if (result < 0) Marshal.ThrowExceptionForHR(result);
        return sid;
    }

    private static void GrantDirectory(
        string path,
        SecurityIdentifier sid,
        FileSystemRights rights,
        InheritanceFlags inheritanceFlags)
    {
        try
        {
            DirectoryInfo directory = new DirectoryInfo(path);
            if (!directory.Exists) throw new DirectoryNotFoundException(path);
            DirectorySecurity security = directory.GetAccessControl(AccessControlSections.Access);
            security.AddAccessRule(new FileSystemAccessRule(
                sid,
                rights,
                inheritanceFlags,
                PropagationFlags.None,
                AccessControlType.Allow));
            directory.SetAccessControl(security);
        }
        catch (Exception exception)
        {
            throw new InvalidOperationException("Could not grant sandbox directory access to " + path, exception);
        }
    }

    private static void GrantFile(string path, SecurityIdentifier sid, FileSystemRights rights)
    {
        try
        {
            FileInfo file = new FileInfo(path);
            if (!file.Exists) throw new FileNotFoundException("ACL target not found.", path);
            FileSecurity security = file.GetAccessControl(AccessControlSections.Access);
            security.AddAccessRule(new FileSystemAccessRule(sid, rights, AccessControlType.Allow));
            file.SetAccessControl(security);
        }
        catch (Exception exception)
        {
            throw new InvalidOperationException("Could not grant sandbox file access to " + path, exception);
        }
    }

    private static void GrantSandboxAccess(RunArguments args, SecurityIdentifier sid)
    {
        GrantDirectory(
            args.Workspace,
            sid,
            FileSystemRights.ReadAndExecute | FileSystemRights.ListDirectory,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit);
        foreach (string path in args.ReadOnlyPaths)
        {
            if (Directory.Exists(path))
            {
                GrantDirectory(
                    path,
                    sid,
                    FileSystemRights.ReadAndExecute | FileSystemRights.ListDirectory,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit);
            }
            else
            {
                GrantFile(path, sid, FileSystemRights.ReadAndExecute);
            }
        }
        foreach (string path in args.WritablePaths)
        {
            GrantDirectory(
                path,
                sid,
                FileSystemRights.Modify | FileSystemRights.Synchronize,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit);
        }
        GrantDirectory(
            Path.GetDirectoryName(args.Target),
            sid,
            FileSystemRights.ReadAndExecute | FileSystemRights.ListDirectory,
            InheritanceFlags.None);
        GrantFile(args.Target, sid, FileSystemRights.ReadAndExecute);
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }
        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            result.Append(character);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static StringBuilder BuildCommandLine(RunArguments args)
    {
        StringBuilder commandLine = new StringBuilder(QuoteArgument(args.Target));
        foreach (string argument in args.TargetArguments)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        return commandLine;
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

        ExtendedLimitInformation limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
        return job;
    }

    private static int Run(RunArguments args)
    {
        IntPtr sidPointer = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr capabilitiesPointer = IntPtr.Zero;
        IntPtr handlesPointer = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        ProcessInformation process = new ProcessInformation();

        try
        {
            sidPointer = CreateOrDeriveProfile(args.ProfileName);
            SecurityIdentifier sid = new SecurityIdentifier(sidPointer);
            GrantSandboxAccess(args, sid);

            IntPtr stdin = GetStdHandle(StdInputHandle);
            IntPtr stdout = GetStdHandle(StdOutputHandle);
            IntPtr stderr = GetStdHandle(StdErrorHandle);
            IntPtr[] inheritedHandles = new IntPtr[] { stdin, stdout, stderr };
            foreach (IntPtr handle in inheritedHandles)
            {
                if (handle != IntPtr.Zero && handle != new IntPtr(-1))
                {
                    if (!SetHandleInformation(handle, HandleFlagInherit, HandleFlagInherit))
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    }
                }
            }

            IntPtr attributeBytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
            if (Marshal.GetLastWin32Error() != ErrorInsufficientBuffer)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            attributeList = Marshal.AllocHGlobal(attributeBytes);
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeBytes))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            SecurityCapabilities capabilities = new SecurityCapabilities();
            capabilities.AppContainerSid = sidPointer;
            capabilitiesPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
            Marshal.StructureToPtr(capabilities, capabilitiesPointer, false);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(ProcThreadAttributeSecurityCapabilities),
                capabilitiesPointer,
                new IntPtr(Marshal.SizeOf(typeof(SecurityCapabilities))),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            handlesPointer = Marshal.AllocHGlobal(IntPtr.Size * inheritedHandles.Length);
            Marshal.Copy(inheritedHandles, 0, handlesPointer, inheritedHandles.Length);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(ProcThreadAttributeHandleList),
                handlesPointer,
                new IntPtr(IntPtr.Size * inheritedHandles.Length),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            StartupInfoEx startup = new StartupInfoEx();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.dwFlags = StartfUseStdHandles;
            startup.StartupInfo.hStdInput = stdin;
            startup.StartupInfo.hStdOutput = stdout;
            startup.StartupInfo.hStdError = stderr;
            startup.lpAttributeList = attributeList;

            uint flags = CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfoPresent;
            if (!CreateProcess(
                null,
                BuildCommandLine(args),
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                flags,
                IntPtr.Zero,
                args.Workspace,
                ref startup,
                out process))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess could not launch the AppContainer target");
            }

            job = CreateKillOnCloseJob();
            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                TerminateProcess(process.hProcess, 125);
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (ResumeThread(process.hThread) == 0xFFFFFFFF)
            {
                TerminateProcess(process.hProcess, 125);
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            WaitForSingleObject(process.hProcess, Infinite);
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return unchecked((int)exitCode);
        }
        finally
        {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (capabilitiesPointer != IntPtr.Zero) Marshal.FreeHGlobal(capabilitiesPointer);
            if (handlesPointer != IntPtr.Zero) Marshal.FreeHGlobal(handlesPointer);
            if (sidPointer != IntPtr.Zero) FreeSid(sidPointer);
        }
    }
}
