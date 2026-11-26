// stealth.cpp — in-process hardening for the overlay.
//
// Everything here runs inside the Electron main process, so it needs no helper
// executable, no child process and no file on disk. That matters twice over: the
// techniques only work from inside the target process (DWM/PEB/ETW are per
// process), and a spawned helper is itself a fingerprint (csc.exe, tasklist.exe,
// %TEMP%\dxva_143.exe are all visible to process-creation telemetry).
//
// Exports:
//   sealProcess()                       — DACL that denies memory read/thread
//                                         creation/duplication to every caller
//   sanitizePeb({commandLine,...})      — rewrite the command line / image path
//                                         the OS and WMI report for this process
//   hideModules(names[])                — unlink loaded modules from the PEB
//                                         loader lists and blank their names
//   suppressEtw()                       — silence in-process user-mode ETW writes
//   scanInspectors(names[])             — Toolhelp snapshot, exact image names,
//                                         no child process
//   blendTitles(pid, title)             — retitle a process's windows in-process
//   pebInfo()                           — readback for the self-test
//
// Residue this cannot touch (kernel, not user mode): the process image name in
// NtQuerySystemInformation, kernel ETW image/process events, and the kernel-side
// display-affinity read. See HARDENING.md.

#include <node_api.h>
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <tlhelp32.h>

#include <string>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "user32.lib")

// winternl.h in the 10.0.19041 SDK stubs these to the minimum it needs to keep
// the exposed offsets; the fields used here (CurrentDirectory, WindowTitle, the
// three loader lists) are not in the stub, so the real layout is declared
// locally and the PEB pointers are cast onto it.
typedef struct _MY_CURDIR {
  UNICODE_STRING DosPath;
  HANDLE Handle;
} MY_CURDIR;

typedef struct _MY_RTL_USER_PROCESS_PARAMETERS {
  ULONG MaximumLength;
  ULONG Length;
  ULONG Flags;
  ULONG DebugFlags;
  HANDLE ConsoleHandle;
  ULONG ConsoleFlags;
  HANDLE StandardInput;
  HANDLE StandardOutput;
  HANDLE StandardError;
  MY_CURDIR CurrentDirectory;
  UNICODE_STRING DllPath;
  UNICODE_STRING ImagePathName;
  UNICODE_STRING CommandLine;
  PVOID Environment;
  ULONG StartingX;
  ULONG StartingY;
  ULONG CountX;
  ULONG CountY;
  ULONG CountCharsX;
  ULONG CountCharsY;
  ULONG FillAttribute;
  ULONG WindowFlags;
  ULONG ShowWindowFlags;
  UNICODE_STRING WindowTitle;
} MY_RTL_USER_PROCESS_PARAMETERS;

typedef struct _MY_PEB_LDR_DATA {
  ULONG Length;
  BOOLEAN Initialized;
  PVOID SsHandle;
  LIST_ENTRY InLoadOrderModuleList;
  LIST_ENTRY InMemoryOrderModuleList;
  LIST_ENTRY InInitializationOrderModuleList;
} MY_PEB_LDR_DATA;

typedef struct _MY_LDR_ENTRY {
  LIST_ENTRY InLoadOrderLinks;
  LIST_ENTRY InMemoryOrderLinks;
  LIST_ENTRY InInitializationOrderLinks;
  PVOID DllBase;
  PVOID EntryPoint;
  ULONG SizeOfImage;
  UNICODE_STRING FullDllName;
  UNICODE_STRING BaseDllName;
} MY_LDR_ENTRY;

static PPEB selfPeb() {
  return reinterpret_cast<PPEB>(NtCurrentTeb()->ProcessEnvironmentBlock);
}

// ---------------------------------------------------------------- PEB rewrite

static bool overwriteUnicodeString(UNICODE_STRING* dst, const std::wstring& want) {
  if (!dst) return false;
  size_t wantBytes = want.size() * sizeof(wchar_t);
  if (wantBytes > 0xFFFC) wantBytes = 0xFFFC; // UNICODE_STRING length is USHORT
  // The process parameter buffers are only as long as the original string, so a
  // longer replacement (a different image path) needs its own allocation. The
  // block is process-lifetime and deliberately never freed.
  if (!dst->Buffer || wantBytes > dst->MaximumLength) {
    void* mem = VirtualAlloc(nullptr, wantBytes + sizeof(wchar_t),
                             MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!mem) return false;
    dst->Buffer = reinterpret_cast<PWSTR>(mem);
    dst->MaximumLength = static_cast<USHORT>(wantBytes + sizeof(wchar_t));
  }
  memcpy(dst->Buffer, want.data(), wantBytes);
  dst->Length = static_cast<USHORT>(wantBytes);
  size_t used = wantBytes;
  if (dst->MaximumLength > used + sizeof(wchar_t)) {
    memset(reinterpret_cast<BYTE*>(dst->Buffer) + used, 0, dst->MaximumLength - used);
  } else if (dst->MaximumLength >= used + sizeof(wchar_t)) {
    dst->Buffer[want.size()] = L'\0';
  }
  return true;
}

static std::wstring fromUtf8(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &len) != napi_ok) return L"";
  std::string s(len, '\0');
  napi_get_value_string_utf8(env, v, &s[0], len + 1, &len);
  if (len == 0) return L"";
  int wlen = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(len), nullptr, 0);
  std::wstring w(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(len), &w[0], wlen);
  return w;
}

static napi_value strProp(napi_env env, napi_value obj, const char* key) {
  napi_value v;
  napi_get_named_property(env, obj, key, &v);
  return v;
}

static napi_value SanitizePeb(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  bool ok = false;
  if (argc >= 1) {
    napi_valuetype t;
    napi_typeof(env, argv[0], &t);
    if (t == napi_object) {
      PPEB peb = selfPeb();
      if (peb && peb->ProcessParameters) {
        auto* params = reinterpret_cast<MY_RTL_USER_PROCESS_PARAMETERS*>(peb->ProcessParameters);
        napi_value v;
        napi_valuetype vt;

        v = strProp(env, argv[0], "commandLine");
        napi_typeof(env, v, &vt);
        if (vt == napi_string) overwriteUnicodeString(&params->CommandLine, fromUtf8(env, v));

        v = strProp(env, argv[0], "imagePath");
        napi_typeof(env, v, &vt);
        if (vt == napi_string) overwriteUnicodeString(&params->ImagePathName, fromUtf8(env, v));

        v = strProp(env, argv[0], "windowTitle");
        napi_typeof(env, v, &vt);
        if (vt == napi_string) overwriteUnicodeString(&params->WindowTitle, fromUtf8(env, v));

        v = strProp(env, argv[0], "currentDirectory");
        napi_typeof(env, v, &vt);
        if (vt == napi_string) overwriteUnicodeString(&params->CurrentDirectory.DosPath, fromUtf8(env, v));

        ok = true;
      }
    }
  }
  napi_value r;
  napi_get_boolean(env, ok, &r);
  return r;
}

// ------------------------------------------------------- remote PEB rewrite
//
// Chromium's renderer/GPU/utility helpers are separate processes. Their PEB is
// theirs to edit, but the browser process is their parent and can write into it
// from outside: the child's command line is the one string a same-user scanner
// reads to fingerprint Electron (`--type=renderer --user-data-dir=…`). The main
// process rewrites it once per child PID. Same-arch only — offsets are the
// x64/arm64 process-parameters layout, and a WOW64 child (none exist under one
// Electron) would be corrupted, so it is refused instead.

static bool sameArch(HANDLE target) {
  BOOL targetWow = FALSE, selfWow = FALSE;
  if (!IsWow64Process(target, &targetWow) || !IsWow64Process(GetCurrentProcess(), &selfWow)) return false;
  return targetWow == selfWow;
}

// Read the process-parameters pointer out of a remote PEB.
static PVOID remoteParams(HANDLE proc) {
  PROCESS_BASIC_INFORMATION pbi = {};
  NTSTATUS st = NtQueryInformationProcess(proc, ProcessBasicInformation, &pbi, sizeof(pbi), nullptr);
  if (st < 0 || !pbi.PebBaseAddress) return nullptr;
  PVOID params = nullptr;
  SIZE_T got = 0;
  auto* slot = reinterpret_cast<BYTE*>(pbi.PebBaseAddress) + offsetof(PEB, ProcessParameters);
  if (!ReadProcessMemory(proc, slot, &params, sizeof(params), &got) || got != sizeof(params)) return nullptr;
  return params;
}

static bool readRemoteUnicode(HANDLE proc, BYTE* base, size_t offset, std::wstring* out) {
  UNICODE_STRING u = {};
  SIZE_T got = 0;
  if (!ReadProcessMemory(proc, base + offset, &u, sizeof(u), &got) || got != sizeof(u)) return false;
  if (!u.Buffer || u.Length < sizeof(wchar_t)) { out->clear(); return true; }
  size_t chars = u.Length / sizeof(wchar_t);
  if (chars > 0x8000) chars = 0x8000; // garbage guard
  out->assign(chars, L'\0');
  if (!ReadProcessMemory(proc, u.Buffer, &(*out)[0], chars * sizeof(wchar_t), &got)) { out->clear(); return false; }
  return true;
}

// Replace one UNICODE_STRING inside the target's process parameters. The
// replacement buffer is a fresh remote allocation: the original lives inside
// the parameters block and is sized for the original argv.
static bool writeRemoteUnicode(HANDLE proc, BYTE* base, size_t offset, const std::wstring& want) {
  size_t bytes = want.size() * sizeof(wchar_t);
  if (bytes > 0xFFFC) bytes = 0xFFFC;
  LPVOID remote = VirtualAllocEx(proc, nullptr, bytes + sizeof(wchar_t), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (!remote) return false;
  if (bytes && !WriteProcessMemory(proc, remote, want.data(), bytes, nullptr)) {
    VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
    return false;
  }
  UNICODE_STRING repl = {};
  repl.Length = static_cast<USHORT>(bytes);
  repl.MaximumLength = static_cast<USHORT>(bytes + sizeof(wchar_t));
  repl.Buffer = reinterpret_cast<PWSTR>(remote);
  if (!WriteProcessMemory(proc, base + offset, &repl, sizeof(repl), nullptr)) {
    VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
    return false;
  }
  return true;
}

static HANDLE openForPeb(DWORD pid, DWORD* err) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION,
                            FALSE, pid);
  if (!proc && err) *err = GetLastError();
  return proc;
}

static napi_value SanitizeRemotePeb(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  uint32_t pid = 0;
  DWORD err = ERROR_INVALID_PARAMETER;
  bool ok = false;
  int wrote = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &pid);
  napi_valuetype t = napi_undefined;
  if (argc >= 2) napi_typeof(env, argv[1], &t);

  if (pid && pid != GetCurrentProcessId() && t == napi_object) {
    HANDLE proc = openForPeb(pid, &err);
    if (proc) {
      if (!sameArch(proc)) {
        err = ERROR_NOT_SUPPORTED;
      } else if (PVOID params = remoteParams(proc)) {
        auto* base = reinterpret_cast<BYTE*>(params);
        struct { const char* key; size_t offset; } fields[] = {
          { "commandLine", offsetof(MY_RTL_USER_PROCESS_PARAMETERS, CommandLine) },
          { "imagePath", offsetof(MY_RTL_USER_PROCESS_PARAMETERS, ImagePathName) },
          { "windowTitle", offsetof(MY_RTL_USER_PROCESS_PARAMETERS, WindowTitle) },
          { "currentDirectory", offsetof(MY_RTL_USER_PROCESS_PARAMETERS, CurrentDirectory) + offsetof(MY_CURDIR, DosPath) },
        };
        for (auto& f : fields) {
          napi_value v = strProp(env, argv[1], f.key);
          napi_valuetype vt;
          napi_typeof(env, v, &vt);
          if (vt == napi_string && writeRemoteUnicode(proc, base, f.offset, fromUtf8(env, v))) wrote++;
        }
        ok = wrote > 0;
        err = ok ? 0 : GetLastError();
      } else {
        err = GetLastError();
      }
      CloseHandle(proc);
    }
  }

  napi_value r, okVal, errVal, wroteVal, pidVal;
  napi_create_object(env, &r);
  napi_get_boolean(env, ok, &okVal);
  napi_create_uint32(env, err, &errVal);
  napi_create_int32(env, wrote, &wroteVal);
  napi_create_uint32(env, pid, &pidVal);
  napi_set_named_property(env, r, "ok", okVal);
  napi_set_named_property(env, r, "error", errVal);
  napi_set_named_property(env, r, "wrote", wroteVal);
  napi_set_named_property(env, r, "pid", pidVal);
  return r;
}

// Readback of another process's command line / image path through its PEB.
// Used by the hardening probe to prove the remote write landed; a scanner that
// opens the child with VM_READ gets the same answer.
static napi_value RemotePebInfo(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  uint32_t pid = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &pid);

  napi_value r, cmd, img, cwd, okVal, errVal;
  napi_create_object(env, &r);
  std::wstring commandLine, imagePath, currentDirectory;
  DWORD err = ERROR_INVALID_PARAMETER;
  bool ok = false;
  if (pid) {
    HANDLE proc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (proc) {
      if (!sameArch(proc)) {
        err = ERROR_NOT_SUPPORTED;
      } else if (PVOID params = remoteParams(proc)) {
        auto* base = reinterpret_cast<BYTE*>(params);
        bool a = readRemoteUnicode(proc, base, offsetof(MY_RTL_USER_PROCESS_PARAMETERS, CommandLine), &commandLine);
        bool b = readRemoteUnicode(proc, base, offsetof(MY_RTL_USER_PROCESS_PARAMETERS, ImagePathName), &imagePath);
        bool c = readRemoteUnicode(proc, base,
                                   offsetof(MY_RTL_USER_PROCESS_PARAMETERS, CurrentDirectory) + offsetof(MY_CURDIR, DosPath),
                                   &currentDirectory);
        ok = a && b && c;
        err = ok ? 0 : GetLastError();
      } else {
        err = GetLastError();
      }
      CloseHandle(proc);
    } else {
      err = GetLastError();
    }
  }

  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(commandLine.c_str()), commandLine.size(), &cmd);
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(imagePath.c_str()), imagePath.size(), &img);
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(currentDirectory.c_str()), currentDirectory.size(), &cwd);
  napi_get_boolean(env, ok, &okVal);
  napi_create_uint32(env, err, &errVal);
  napi_set_named_property(env, r, "ok", okVal);
  napi_set_named_property(env, r, "error", errVal);
  napi_set_named_property(env, r, "commandLine", cmd);
  napi_set_named_property(env, r, "imagePath", img);
  napi_set_named_property(env, r, "currentDirectory", cwd);
  return r;
}

static napi_value PebInfo(napi_env env, napi_callback_info) {
  napi_value r, cmd, img, count;
  napi_create_object(env, &r);

  std::wstring commandLine, imagePath;
  int modules = 0;
  PPEB peb = selfPeb();
  if (peb && peb->ProcessParameters) {
    auto* p = reinterpret_cast<MY_RTL_USER_PROCESS_PARAMETERS*>(peb->ProcessParameters);
    commandLine.assign(p->CommandLine.Buffer ? p->CommandLine.Buffer : L"",
                       p->CommandLine.Length / sizeof(wchar_t));
    imagePath.assign(p->ImagePathName.Buffer ? p->ImagePathName.Buffer : L"",
                     p->ImagePathName.Length / sizeof(wchar_t));
  }
  if (peb && peb->Ldr) {
    auto* ldr = reinterpret_cast<MY_PEB_LDR_DATA*>(peb->Ldr);
    LIST_ENTRY* head = &ldr->InLoadOrderModuleList;
    for (LIST_ENTRY* it = head->Flink; it != head; it = it->Flink) modules++;
  }

  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(commandLine.c_str()), commandLine.size(), &cmd);
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(imagePath.c_str()), imagePath.size(), &img);
  napi_create_int32(env, modules, &count);
  napi_set_named_property(env, r, "commandLine", cmd);
  napi_set_named_property(env, r, "imagePath", img);
  napi_set_named_property(env, r, "modules", count);
  return r;
}

// ------------------------------------------------------------ module hiding

static bool nameEquals(const UNICODE_STRING& u, const std::wstring& want) {
  if (!u.Buffer || u.Length == 0) return false;
  size_t chars = u.Length / sizeof(wchar_t);
  if (chars != want.size()) return false;
  return _wcsnicmp(u.Buffer, want.c_str(), chars) == 0;
}

static bool unlinkOne(LIST_ENTRY* link) {
  if (!link || !link->Flink || !link->Blink) return false;
  link->Blink->Flink = link->Flink;
  link->Flink->Blink = link->Blink;
  link->Flink = link;
  link->Blink = link;
  return true;
}

static int hideModules(const std::vector<std::wstring>& names) {
  PPEB peb = selfPeb();
  if (!peb || !peb->Ldr) return -1;
  int hidden = 0;

  for (const std::wstring& want : names) {
    // Re-walk per name: the list mutates as entries leave.
    auto* ldr = reinterpret_cast<MY_PEB_LDR_DATA*>(peb->Ldr);
    LIST_ENTRY* head = &ldr->InLoadOrderModuleList;
    for (LIST_ENTRY* it = head->Flink; it != head;) {
      LIST_ENTRY* next = it->Flink;
      auto* e = CONTAINING_RECORD(it, MY_LDR_ENTRY, InLoadOrderLinks);
      if (nameEquals(e->BaseDllName, want) || nameEquals(e->FullDllName, want)) {
        unlinkOne(&e->InLoadOrderLinks);
        unlinkOne(&e->InMemoryOrderLinks);
        unlinkOne(&e->InInitializationOrderLinks);
        // Blank the names in the (now unreachable) entry: a memory scanner that
        // already cached the list address still finds no string.
        if (e->BaseDllName.Buffer) {
          memset(e->BaseDllName.Buffer, 0, e->BaseDllName.MaximumLength);
          e->BaseDllName.Length = 0;
        }
        if (e->FullDllName.Buffer) {
          memset(e->FullDllName.Buffer, 0, e->FullDllName.MaximumLength);
          e->FullDllName.Length = 0;
        }
        hidden++;
        break;
      }
      it = next;
    }
  }
  return hidden;
}

static napi_value HideModules(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  std::vector<std::wstring> names;
  if (argc >= 1) {
    napi_valuetype t;
    napi_typeof(env, argv[0], &t);
    if (t == napi_string) {
      names.push_back(fromUtf8(env, argv[0]));
    } else if (t == napi_object) {
      uint32_t n = 0;
      napi_get_array_length(env, argv[0], &n);
      for (uint32_t i = 0; i < n; i++) {
        napi_value item;
        napi_get_element(env, argv[0], i, &item);
        napi_valuetype vt;
        napi_typeof(env, item, &vt);
        if (vt == napi_string) names.push_back(fromUtf8(env, item));
      }
    }
  }
  napi_value r;
  napi_create_int32(env, hideModules(names), &r);
  return r;
}

// ------------------------------------------------------------------ DACL seal

static napi_value SealProcess(napi_env env, napi_callback_info) {
  napi_value r, okVal, errVal;
  napi_create_object(env, &r);

  PSID everyone = nullptr;
  PSID systemSid = nullptr;
  SID_IDENTIFIER_AUTHORITY worldAuth = SECURITY_WORLD_SID_AUTHORITY;
  SID_IDENTIFIER_AUTHORITY ntAuth = SECURITY_NT_AUTHORITY;

  bool ok = false;
  DWORD err = 0;
  PACL acl = nullptr;

  if (AllocateAndInitializeSid(&worldAuth, 1, SECURITY_WORLD_RID, 0, 0, 0, 0, 0, 0, 0, &everyone) &&
      AllocateAndInitializeSid(&ntAuth, 1, SECURITY_LOCAL_SYSTEM_RID, 0, 0, 0, 0, 0, 0, 0, &systemSid)) {
    EXPLICIT_ACCESS_W ea[3] = {};
    ea[0].grfAccessPermissions = PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION |
                                 PROCESS_CREATE_THREAD | PROCESS_DUP_HANDLE;
    ea[0].grfAccessMode = DENY_ACCESS;
    ea[0].grfInheritance = NO_INHERITANCE;
    ea[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea[0].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    ea[0].Trustee.ptstrName = reinterpret_cast<LPWSTR>(everyone);

    ea[1].grfAccessPermissions = PROCESS_ALL_ACCESS;
    ea[1].grfAccessMode = GRANT_ACCESS;
    ea[1].grfInheritance = NO_INHERITANCE;
    ea[1].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea[1].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    ea[1].Trustee.ptstrName = reinterpret_cast<LPWSTR>(systemSid);

    ea[2].grfAccessPermissions = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION |
                                 PROCESS_QUERY_INFORMATION | SYNCHRONIZE | PROCESS_SET_QUOTA;
    ea[2].grfAccessMode = GRANT_ACCESS;
    ea[2].grfInheritance = NO_INHERITANCE;
    ea[2].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea[2].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    ea[2].Trustee.ptstrName = reinterpret_cast<LPWSTR>(everyone);

    err = SetEntriesInAclW(3, ea, nullptr, &acl);
    if (err == ERROR_SUCCESS && acl) {
      err = SetSecurityInfo(GetCurrentProcess(), SE_KERNEL_OBJECT,
                            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                            nullptr, nullptr, acl, nullptr);
      ok = (err == ERROR_SUCCESS);
    }
  } else {
    err = GetLastError();
  }

  if (acl) LocalFree(acl);
  if (everyone) FreeSid(everyone);
  if (systemSid) FreeSid(systemSid);

  napi_get_boolean(env, ok, &okVal);
  napi_create_uint32(env, err, &errVal);
  napi_set_named_property(env, r, "ok", okVal);
  napi_set_named_property(env, r, "error", errVal);
  return r;
}

// ----------------------------------------------------------------- ETW patch

static int patchRetZero(const char* module, const char* name) {
  HMODULE mod = GetModuleHandleA(module);
  if (!mod) return 0;
  auto fn = reinterpret_cast<BYTE*>(GetProcAddress(mod, name));
  if (!fn) return 0;
  // xor eax, eax ; ret  -> the call reports success and emits nothing.
  static const BYTE code[3] = { 0x33, 0xC0, 0xC3 };
  DWORD old = 0;
  if (!VirtualProtect(fn, sizeof(code), PAGE_EXECUTE_READWRITE, &old)) return 0;
  memcpy(fn, code, sizeof(code));
  VirtualProtect(fn, sizeof(code), old, &old);
  FlushInstructionCache(GetCurrentProcess(), fn, sizeof(code));
  return 1;
}

static napi_value SuppressEtw(napi_env env, napi_callback_info) {
  int n = 0;
  n += patchRetZero("ntdll.dll", "EtwEventWrite");
  n += patchRetZero("ntdll.dll", "EtwEventWriteEx");
  n += patchRetZero("ntdll.dll", "EtwEventWriteFull");
  n += patchRetZero("ntdll.dll", "EtwEventWriteString");
  n += patchRetZero("ntdll.dll", "EtwEventWriteTransfer");
  napi_value r;
  napi_create_int32(env, n, &r);
  return r;
}

// --------------------------------------------------------- process scanning

static napi_value ScanInspectors(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  std::vector<std::wstring> names;
  if (argc >= 1) {
    uint32_t n = 0;
    if (napi_get_array_length(env, argv[0], &n) == napi_ok) {
      for (uint32_t i = 0; i < n; i++) {
        napi_value item;
        napi_get_element(env, argv[0], i, &item);
        napi_valuetype vt;
        napi_typeof(env, item, &vt);
        if (vt == napi_string) names.push_back(fromUtf8(env, item));
      }
    }
  }

  std::wstring hit;
  DWORD hitPid = 0;
  if (!names.empty()) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap != INVALID_HANDLE_VALUE) {
      PROCESSENTRY32W pe = {};
      pe.dwSize = sizeof(pe);
      if (Process32FirstW(snap, &pe)) {
        do {
          std::wstring exe(pe.szExeFile);
          for (const std::wstring& want : names) {
            if (_wcsicmp(exe.c_str(), want.c_str()) == 0) {
              hit = want;
              hitPid = pe.th32ProcessID;
              break;
            }
          }
          if (!hit.empty()) break;
        } while (Process32NextW(snap, &pe));
      }
      CloseHandle(snap);
    }
  }

  if (hit.empty()) {
    napi_value nullv;
    napi_get_null(env, &nullv);
    return nullv;
  }
  napi_value r, name, pid;
  napi_create_object(env, &r);
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(hit.c_str()), hit.size(), &name);
  napi_create_uint32(env, hitPid, &pid);
  napi_set_named_property(env, r, "name", name);
  napi_set_named_property(env, r, "pid", pid);
  return r;
}

// Full process list for the detector watch: ~1 ms, no child process, so the
// 250 ms poll does not itself become a process-creation signal (tasklist.exe in
// a loop is a better fingerprint than the window it is looking for).
static napi_value ListProcesses(napi_env env, napi_callback_info) {
  napi_value arr;
  napi_create_array(env, &arr);
  uint32_t idx = 0;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap != INVALID_HANDLE_VALUE) {
    PROCESSENTRY32W pe = {};
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(snap, &pe)) {
      do {
        napi_value item, pid, name;
        napi_create_object(env, &item);
        napi_create_uint32(env, pe.th32ProcessID, &pid);
        napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(pe.szExeFile),
                                 wcslen(pe.szExeFile), &name);
        napi_set_named_property(env, item, "pid", pid);
        napi_set_named_property(env, item, "name", name);
        napi_set_element(env, arr, idx++, item);
      } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
  }
  return arr;
}

// --------------------------------------------------------------- title blend

struct TitleJob {
  DWORD pid;
  const wchar_t* title;
  int count;
};

static BOOL CALLBACK retitle(HWND h, LPARAM param) {
  auto* job = reinterpret_cast<TitleJob*>(param);
  DWORD pid = 0;
  GetWindowThreadProcessId(h, &pid);
  if (pid == job->pid && IsWindowVisible(h)) {
    if (SetWindowTextW(h, job->title)) job->count++;
  }
  return TRUE;
}

static napi_value BlendTitles(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  uint32_t pid = 0;
  std::wstring title;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &pid);
  if (argc >= 2) title = fromUtf8(env, argv[1]);

  TitleJob job = { pid, title.c_str(), 0 };
  if (pid && !title.empty()) EnumWindows(retitle, reinterpret_cast<LPARAM>(&job));

  napi_value r;
  napi_create_int32(env, job.count, &r);
  return r;
}

// -------------------------------------------------------------------- init

static napi_value Init(napi_env env, napi_value exports) {
  struct { const char* name; napi_callback fn; } fns[] = {
    { "sanitizePeb", SanitizePeb },
    { "sanitizeRemotePeb", SanitizeRemotePeb },
    { "remotePebInfo", RemotePebInfo },
    { "pebInfo", PebInfo },
    { "hideModules", HideModules },
    { "sealProcess", SealProcess },
    { "suppressEtw", SuppressEtw },
    { "scanInspectors", ScanInspectors },
    { "listProcesses", ListProcesses },
    { "blendTitles", BlendTitles },
  };
  for (auto& f : fns) {
    napi_value fn;
    napi_create_function(env, f.name, NAPI_AUTO_LENGTH, f.fn, nullptr, &fn);
    napi_set_named_property(env, exports, f.name, fn);
  }
  return exports;
}

// One .node per target: cloak.cpp owns NAPI_MODULE and calls this to add the
// stealth surface to the same exports object.
bool stealthInit(napi_env env, napi_value exports) {
  Init(env, exports);
  return true;
}
