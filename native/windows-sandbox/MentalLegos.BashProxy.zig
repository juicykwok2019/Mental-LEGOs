const Handle = ?*anyopaque;
const Bool = i32;
const Dword = u32;
const InvalidHandle: Handle = @ptrFromInt(~@as(usize, 0));
const FileAttributeNormal: Dword = 0x00000080;
const FileShareRead: Dword = 0x00000001;
const GenericRead: Dword = 0x80000000;
const GenericWrite: Dword = 0x40000000;
const CreateNew: Dword = 1;
const OpenExisting: Dword = 3;
const MoveFileWriteThrough: Dword = 0x00000008;
const InvalidFileAttributes: Dword = 0xffffffff;
const BCryptUseSystemPreferredRng: Dword = 0x00000002;
const CpUtf8: Dword = 65001;
const WcErrInvalidChars: Dword = 0x00000080;
const MemCommitReserve: Dword = 0x00003000;
const MemRelease: Dword = 0x00008000;
const PageReadWrite: Dword = 0x00000004;
const StdOutputHandle: Dword = @bitCast(@as(i32, -11));
const StdErrorHandle: Dword = @bitCast(@as(i32, -12));
const BrokerTimeoutMs: u64 = 120_000;
const MaximumResponseBytes: u64 = 12 * 1024 * 1024;
const MaximumArguments: usize = 128;
const MaximumPathUnits: usize = 4096;
const MaximumCommandLineUnits: usize = 32768;
const MaximumArgumentUtf8Bytes: usize = 64 * 1024;
const base64_alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

extern "kernel32" fn CloseHandle(object: Handle) callconv(.winapi) Bool;
extern "kernel32" fn CreateFileW(
    file_name: [*:0]const u16,
    desired_access: Dword,
    share_mode: Dword,
    security_attributes: ?*anyopaque,
    creation_disposition: Dword,
    flags_and_attributes: Dword,
    template_file: Handle,
) callconv(.winapi) Handle;
extern "kernel32" fn DeleteFileW(file_name: [*:0]const u16) callconv(.winapi) Bool;
extern "kernel32" fn GetCommandLineW() callconv(.winapi) [*:0]const u16;
extern "kernel32" fn GetCurrentProcessId() callconv(.winapi) Dword;
extern "kernel32" fn GetEnvironmentVariableW(
    name: [*:0]const u16,
    buffer: [*]u16,
    buffer_units: Dword,
) callconv(.winapi) Dword;
extern "kernel32" fn GetFileAttributesW(file_name: [*:0]const u16) callconv(.winapi) Dword;
extern "kernel32" fn GetFileSizeEx(file: Handle, size: *i64) callconv(.winapi) Bool;
extern "kernel32" fn GetStdHandle(std_handle: Dword) callconv(.winapi) Handle;
extern "kernel32" fn GetTickCount64() callconv(.winapi) u64;
extern "kernel32" fn MoveFileExW(
    existing_file_name: [*:0]const u16,
    new_file_name: [*:0]const u16,
    flags: Dword,
) callconv(.winapi) Bool;
extern "kernel32" fn ReadFile(
    file: Handle,
    buffer: [*]u8,
    bytes_to_read: Dword,
    bytes_read: *Dword,
    overlapped: ?*anyopaque,
) callconv(.winapi) Bool;
extern "kernel32" fn Sleep(milliseconds: Dword) callconv(.winapi) void;
extern "kernel32" fn VirtualAlloc(
    address: ?*anyopaque,
    bytes: usize,
    allocation_type: Dword,
    protection: Dword,
) callconv(.winapi) ?[*]u8;
extern "kernel32" fn VirtualFree(
    address: ?*anyopaque,
    bytes: usize,
    free_type: Dword,
) callconv(.winapi) Bool;
extern "kernel32" fn WideCharToMultiByte(
    code_page: Dword,
    flags: Dword,
    wide: [*]const u16,
    wide_units: i32,
    output: [*]u8,
    output_bytes: i32,
    default_character: ?*const u8,
    used_default_character: ?*Bool,
) callconv(.winapi) i32;
extern "kernel32" fn WriteFile(
    file: Handle,
    buffer: [*]const u8,
    bytes_to_write: Dword,
    bytes_written: *Dword,
    overlapped: ?*anyopaque,
) callconv(.winapi) Bool;
extern "bcrypt" fn BCryptGenRandom(
    algorithm: Handle,
    buffer: [*]u8,
    buffer_bytes: Dword,
    flags: Dword,
) callconv(.winapi) i32;

const ProxyError = error{
    ArgumentLimitExceeded,
    BrokerUnavailable,
    InvalidResponse,
    IoFailure,
    PathTooLong,
    RandomFailure,
    ResponseTooLarge,
    Timeout,
};

const WidePath = struct {
    units: [MaximumPathUnits:0]u16 = [_:0]u16{0} ** MaximumPathUnits,

    fn ptr(self: *const WidePath) [*:0]const u16 {
        return &self.units;
    }
};

const CommandLineIterator = struct {
    source: [*:0]const u16,
    index: usize = 0,
    output: [MaximumCommandLineUnits]u16 = undefined,

    fn next(self: *CommandLineIterator) ProxyError!?[]const u16 {
        while (self.source[self.index] == ' ' or self.source[self.index] == '\t') {
            self.index += 1;
        }
        if (self.source[self.index] == 0) return null;

        var destination: usize = 0;
        var inside_quotes = false;
        while (true) {
            var backslashes: usize = 0;
            while (self.source[self.index] == '\\') {
                backslashes += 1;
                self.index += 1;
            }
            if (self.source[self.index] == '"') {
                var remaining = backslashes / 2;
                while (remaining > 0) : (remaining -= 1) {
                    if (destination >= self.output.len) return error.ArgumentLimitExceeded;
                    self.output[destination] = '\\';
                    destination += 1;
                }
                if (backslashes % 2 == 1) {
                    if (destination >= self.output.len) return error.ArgumentLimitExceeded;
                    self.output[destination] = '"';
                    destination += 1;
                    self.index += 1;
                } else if (inside_quotes and self.source[self.index + 1] == '"') {
                    if (destination >= self.output.len) return error.ArgumentLimitExceeded;
                    self.output[destination] = '"';
                    destination += 1;
                    self.index += 2;
                } else {
                    inside_quotes = !inside_quotes;
                    self.index += 1;
                }
                continue;
            }
            while (backslashes > 0) : (backslashes -= 1) {
                if (destination >= self.output.len) return error.ArgumentLimitExceeded;
                self.output[destination] = '\\';
                destination += 1;
            }
            const character = self.source[self.index];
            if (character == 0 or (!inside_quotes and (character == ' ' or character == '\t'))) {
                return self.output[0..destination];
            }
            if (destination >= self.output.len) return error.ArgumentLimitExceeded;
            self.output[destination] = character;
            destination += 1;
            self.index += 1;
        }
    }
};

fn makeWideLiteral(comptime text: []const u8) [text.len + 1]u16 {
    var result = [_]u16{0} ** (text.len + 1);
    for (text, 0..) |character, index| result[index] = character;
    return result;
}

const ipc_environment_name = makeWideLiteral("MENTAL_LEGOS_BASH_IPC_DIR");
const token_environment_name = makeWideLiteral("MENTAL_LEGOS_BASH_PROXY_TOKEN");

fn writeAll(file: Handle, bytes: []const u8) ProxyError!void {
    var remaining = bytes;
    while (remaining.len > 0) {
        const batch: Dword = @intCast(@min(remaining.len, 0xffffffff));
        var written: Dword = 0;
        if (WriteFile(file, remaining.ptr, batch, &written, null) == 0 or written == 0) {
            return error.IoFailure;
        }
        remaining = remaining[written..];
    }
}

fn writeStderr(message: []const u8) void {
    writeAll(GetStdHandle(StdErrorHandle), message) catch {};
}

fn validToken(value: []const u16) bool {
    if (value.len != 64) return false;
    for (value) |character| {
        if (!((character >= '0' and character <= '9') or
            (character >= 'a' and character <= 'f'))) return false;
    }
    return true;
}

fn appendAscii(target: []u16, position: *usize, source: []const u8) ProxyError!void {
    if (position.* + source.len >= target.len) return error.PathTooLong;
    for (source) |character| {
        target[position.*] = character;
        position.* += 1;
    }
}

fn buildPath(destination: *WidePath, directory: []const u16, name: []const u8) ProxyError!void {
    if (directory.len + 1 + name.len >= destination.units.len) return error.PathTooLong;
    @memcpy(destination.units[0..directory.len], directory);
    var position = directory.len;
    if (position > 0 and destination.units[position - 1] != '\\') {
        destination.units[position] = '\\';
        position += 1;
    }
    try appendAscii(&destination.units, &position, name);
    destination.units[position] = 0;
}

fn writeBase64(file: Handle, input: []const u8) ProxyError!void {
    var source: usize = 0;
    var output: [4096]u8 = undefined;
    var destination: usize = 0;
    while (source < input.len) {
        const remaining = input.len - source;
        const first: u32 = input[source];
        const second: u32 = if (remaining > 1) input[source + 1] else 0;
        const third: u32 = if (remaining > 2) input[source + 2] else 0;
        const triple = (first << 16) | (second << 8) | third;
        output[destination] = base64_alphabet[(triple >> 18) & 63];
        output[destination + 1] = base64_alphabet[(triple >> 12) & 63];
        output[destination + 2] = if (remaining > 1) base64_alphabet[(triple >> 6) & 63] else '=';
        output[destination + 3] = if (remaining > 2) base64_alphabet[triple & 63] else '=';
        source += @min(remaining, 3);
        destination += 4;
        if (destination == output.len) {
            try writeAll(file, &output);
            destination = 0;
        }
    }
    if (destination > 0) try writeAll(file, output[0..destination]);
}

fn base64Value(character: u8) ?u8 {
    if (character >= 'A' and character <= 'Z') return character - 'A';
    if (character >= 'a' and character <= 'z') return character - 'a' + 26;
    if (character >= '0' and character <= '9') return character - '0' + 52;
    if (character == '+') return 62;
    if (character == '/') return 63;
    return null;
}

fn writeDecodedBase64(file: Handle, input: []const u8) ProxyError!void {
    if (input.len % 4 != 0) return error.InvalidResponse;
    var source: usize = 0;
    var output: [4095]u8 = undefined;
    var destination: usize = 0;
    while (source < input.len) : (source += 4) {
        const is_last = source + 4 == input.len;
        const third_padding = input[source + 2] == '=';
        const fourth_padding = input[source + 3] == '=';
        if ((!is_last and (third_padding or fourth_padding)) or (third_padding and !fourth_padding)) {
            return error.InvalidResponse;
        }
        const a = base64Value(input[source]) orelse return error.InvalidResponse;
        const b = base64Value(input[source + 1]) orelse return error.InvalidResponse;
        const c = if (third_padding) 0 else base64Value(input[source + 2]) orelse return error.InvalidResponse;
        const d = if (fourth_padding) 0 else base64Value(input[source + 3]) orelse return error.InvalidResponse;
        const triple: u32 = (@as(u32, a) << 18) | (@as(u32, b) << 12) | (@as(u32, c) << 6) | d;
        output[destination] = @truncate(triple >> 16);
        destination += 1;
        if (!third_padding) {
            output[destination] = @truncate(triple >> 8);
            destination += 1;
        }
        if (!fourth_padding) {
            output[destination] = @truncate(triple);
            destination += 1;
        }
        if (is_last) {
            if (third_padding and (b & 0x0f) != 0) return error.InvalidResponse;
            if (fourth_padding and !third_padding and (c & 0x03) != 0) return error.InvalidResponse;
        }
        if (destination >= output.len - 3) {
            try writeAll(file, output[0..destination]);
            destination = 0;
        }
    }
    if (destination > 0) try writeAll(file, output[0..destination]);
}

fn parseExitCode(value: []const u8) ProxyError!u8 {
    if (value.len == 0 or value.len > 3) return error.InvalidResponse;
    var result: u16 = 0;
    for (value) |character| {
        if (character < '0' or character > '9') return error.InvalidResponse;
        result = result * 10 + character - '0';
        if (result > 255) return error.InvalidResponse;
    }
    return @intCast(result);
}

fn nextLine(content: []const u8, position: *usize) ProxyError![]const u8 {
    const start = position.*;
    var index = start;
    while (index < content.len and content[index] != '\n') : (index += 1) {}
    if (index >= content.len) return error.InvalidResponse;
    position.* = index + 1;
    return content[start..index];
}

fn execute() ProxyError!u8 {
    var ipc_directory: [MaximumPathUnits]u16 = undefined;
    const ipc_units = GetEnvironmentVariableW(
        @ptrCast(&ipc_environment_name),
        &ipc_directory,
        ipc_directory.len,
    );
    if (ipc_units == 0 or ipc_units >= ipc_directory.len) return error.BrokerUnavailable;
    var token: [65]u16 = undefined;
    const token_units = GetEnvironmentVariableW(
        @ptrCast(&token_environment_name),
        &token,
        token.len,
    );
    if (token_units != 64 or !validToken(token[0..token_units]) or
        GetFileAttributesW(@ptrCast(&ipc_directory)) == InvalidFileAttributes) {
        return error.BrokerUnavailable;
    }

    var random_id: [16]u8 = undefined;
    if (BCryptGenRandom(null, &random_id, random_id.len, BCryptUseSystemPreferredRng) < 0) {
        return error.RandomFailure;
    }
    var request_name_buffer: [96]u8 = undefined;
    var request_name_length: usize = 0;
    var process_id = GetCurrentProcessId();
    var digits: [10]u8 = undefined;
    var digit_count: usize = 0;
    while (process_id > 0) : (process_id /= 10) {
        digits[digit_count] = @intCast('0' + process_id % 10);
        digit_count += 1;
    }
    if (digit_count == 0) {
        digits[0] = '0';
        digit_count = 1;
    }
    while (digit_count > 0) {
        digit_count -= 1;
        request_name_buffer[request_name_length] = digits[digit_count];
        request_name_length += 1;
    }
    request_name_buffer[request_name_length] = '-';
    request_name_length += 1;
    const hex = "0123456789abcdef";
    for (random_id) |byte| {
        request_name_buffer[request_name_length] = hex[byte >> 4];
        request_name_buffer[request_name_length + 1] = hex[byte & 0x0f];
        request_name_length += 2;
    }
    const request_name = request_name_buffer[0..request_name_length];

    var temporary_name: [112]u8 = undefined;
    @memcpy(temporary_name[0..request_name.len], request_name);
    @memcpy(temporary_name[request_name.len..][0..12], ".request.tmp");
    var final_name: [112]u8 = undefined;
    @memcpy(final_name[0..request_name.len], request_name);
    @memcpy(final_name[request_name.len..][0..8], ".request");
    var response_name: [112]u8 = undefined;
    @memcpy(response_name[0..request_name.len], request_name);
    @memcpy(response_name[request_name.len..][0..9], ".response");

    var temporary_path: WidePath = .{};
    var request_path: WidePath = .{};
    var response_path: WidePath = .{};
    try buildPath(&temporary_path, ipc_directory[0..ipc_units], temporary_name[0 .. request_name.len + 12]);
    try buildPath(&request_path, ipc_directory[0..ipc_units], final_name[0 .. request_name.len + 8]);
    try buildPath(&response_path, ipc_directory[0..ipc_units], response_name[0 .. request_name.len + 9]);
    defer _ = DeleteFileW(temporary_path.ptr());
    defer _ = DeleteFileW(request_path.ptr());
    defer _ = DeleteFileW(response_path.ptr());

    var request_file = CreateFileW(
        temporary_path.ptr(),
        GenericWrite,
        0,
        null,
        CreateNew,
        FileAttributeNormal,
        null,
    );
    if (request_file == InvalidHandle) return error.IoFailure;
    defer {
        if (request_file != InvalidHandle) _ = CloseHandle(request_file);
    }
    try writeAll(request_file, "MLB2\n");
    var token_utf8: [64]u8 = undefined;
    for (token[0..64], 0..) |character, index| token_utf8[index] = @intCast(character);
    try writeAll(request_file, &token_utf8);
    try writeAll(request_file, "\n");

    var iterator: CommandLineIterator = .{ .source = GetCommandLineW() };
    _ = try iterator.next();
    var argument_count: usize = 0;
    var utf8: [MaximumArgumentUtf8Bytes]u8 = undefined;
    while (try iterator.next()) |argument| {
        argument_count += 1;
        if (argument_count > MaximumArguments or argument.len > 32767) {
            return error.ArgumentLimitExceeded;
        }
        const utf8_bytes = WideCharToMultiByte(
            CpUtf8,
            WcErrInvalidChars,
            argument.ptr,
            @intCast(argument.len),
            &utf8,
            utf8.len,
            null,
            null,
        );
        if (utf8_bytes <= 0) return error.ArgumentLimitExceeded;
        try writeBase64(request_file, utf8[0..@intCast(utf8_bytes)]);
        try writeAll(request_file, "\n");
    }
    _ = CloseHandle(request_file);
    request_file = InvalidHandle;
    const move_started = GetTickCount64();
    while (MoveFileExW(temporary_path.ptr(), request_path.ptr(), MoveFileWriteThrough) == 0) {
        if (GetTickCount64() - move_started > 2_000) return error.IoFailure;
        Sleep(20);
    }

    const started = GetTickCount64();
    while (GetFileAttributesW(response_path.ptr()) == InvalidFileAttributes) {
        if (GetTickCount64() - started > BrokerTimeoutMs) return error.Timeout;
        Sleep(20);
    }

    var response_file: Handle = InvalidHandle;
    const open_started = GetTickCount64();
    while (response_file == InvalidHandle) {
        response_file = CreateFileW(
            response_path.ptr(),
            GenericRead,
            FileShareRead,
            null,
            OpenExisting,
            FileAttributeNormal,
            null,
        );
        if (response_file != InvalidHandle) break;
        if (GetTickCount64() - open_started > 2_000) return error.IoFailure;
        Sleep(20);
    }
    defer {
        if (response_file != InvalidHandle) _ = CloseHandle(response_file);
    }
    var response_size: i64 = 0;
    if (GetFileSizeEx(response_file, &response_size) == 0 or response_size < 8 or
        response_size > MaximumResponseBytes) return error.ResponseTooLarge;
    const allocation = VirtualAlloc(null, @intCast(response_size), MemCommitReserve, PageReadWrite) orelse {
        return error.ResponseTooLarge;
    };
    defer _ = VirtualFree(allocation, 0, MemRelease);
    const content = allocation[0..@intCast(response_size)];
    var bytes_read: Dword = 0;
    if (ReadFile(response_file, content.ptr, @intCast(content.len), &bytes_read, null) == 0 or
        bytes_read != content.len) return error.IoFailure;
    _ = CloseHandle(response_file);
    response_file = InvalidHandle;

    var position: usize = 0;
    const marker = try nextLine(content, &position);
    const exit_text = try nextLine(content, &position);
    const stdout_text = try nextLine(content, &position);
    const stderr_text = content[position..];
    if (marker.len != 4 or marker[0] != 'M' or marker[1] != 'L' or
        marker[2] != 'R' or marker[3] != '2') return error.InvalidResponse;
    for (stderr_text) |character| {
        if (character == '\n') return error.InvalidResponse;
    }
    const exit_code = try parseExitCode(exit_text);
    try writeDecodedBase64(GetStdHandle(StdOutputHandle), stdout_text);
    try writeDecodedBase64(GetStdHandle(StdErrorHandle), stderr_text);
    return exit_code;
}

pub fn main() u8 {
    return execute() catch |err| {
        switch (err) {
            error.BrokerUnavailable => writeStderr("Mental LEGOs Bash broker is unavailable.\n"),
            error.Timeout => writeStderr("Mental LEGOs Bash broker timed out.\n"),
            error.IoFailure => writeStderr("Mental LEGOs Bash broker I/O failed.\n"),
            error.InvalidResponse => writeStderr("Mental LEGOs Bash broker response was invalid.\n"),
            else => writeStderr("Mental LEGOs Bash broker request failed.\n"),
        }
        return if (err == error.Timeout) 124 else 125;
    };
}
