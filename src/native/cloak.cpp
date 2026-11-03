// In-process DWM cloak. DWM refuses DwmSetWindowAttribute(DWMWA_CLOAK) from a
// foreign process with E_HANDLE/E_ACCESSDENIED, so it has to run inside the app.
// Electron has no FFI, so this is the smallest possible addon: cloak / uncloak.
#include <node_api.h>
#include <dwmapi.h>
#include <windows.h>
#include <string>

#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "user32.lib")

// host.cpp — reparent shim so only an innocuous top-level window is visible
extern HWND hostAttach(HWND child);
extern bool hostSync();
extern void hostDetach();
extern HWND hostHandle();
extern bool hostActive();

#ifndef DWMWA_CLOAK
#define DWMWA_CLOAK 13
#endif

// Candidate DWMWA for a capture exclusion that would leave GetWindowDisplayAffinity
// at 0. Measured on Windows 11 26300: DwmSetWindowAttribute accepts attribute 16
// (S_OK) but neither a GDI BitBlt nor a WGC capture excludes the window, and no
// id in the 16..40 range does, so 16 is kept only because dwmAttr() lets a newer
// build be probed. SetWindowDisplayAffinity (0x11) stays the working mechanism.
#ifndef DWMWA_EXCLUDED_FROM_CAPTURE
#define DWMWA_EXCLUDED_FROM_CAPTURE 16
#endif

static napi_value SetCloak(napi_env env, napi_callback_info info, BOOL on) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value thisArg;
  void* data;
  napi_get_cb_info(env, info, &argc, argv, &thisArg, &data);

  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "expected a window handle");
    return nullptr;
  }

  // accept a JS number or BigInt; take the low 32 bits either way
  napi_valuetype t;
  napi_typeof(env, argv[0], &t);
  HWND hwnd;
  if (t == napi_bigint) {
    uint64_t v = 0;
    bool lossless = false;
    napi_get_value_bigint_uint64(env, argv[0], &v, &lossless);
    hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(v));
  } else {
    uint32_t v = 0;
    napi_get_value_uint32(env, argv[0], &v);
    hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(v));
  }

  if (!IsWindow(hwnd)) {
    napi_throw_error(env, nullptr, "not a valid window handle");
    return nullptr;
  }

  // Electron's handle can be a child; DWM only cloaks top-level windows
  HWND root = GetAncestor(hwnd, GA_ROOT);
  if (root) hwnd = root;

  BOOL value = on ? TRUE : FALSE;
  HRESULT hr = DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, &value, sizeof(value));

  BOOL readback = FALSE;
  DwmGetWindowAttribute(hwnd, DWMWA_CLOAK, &readback, sizeof(readback));

  napi_value result;
  napi_create_object(env, &result);

  napi_value ok, cloaked, handle, hrVal;
  napi_get_boolean(env, SUCCEEDED(hr), &ok);
  napi_get_boolean(env, readback != FALSE, &cloaked);
  napi_create_uint32(env, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(hwnd)), &handle);
  napi_create_int32(env, static_cast<int32_t>(hr), &hrVal);

  napi_set_named_property(env, result, "ok", ok);
  napi_set_named_property(env, result, "cloaked", cloaked);
  napi_set_named_property(env, result, "hwnd", handle);
  napi_set_named_property(env, result, "hr", hrVal);
  return result;
}

static napi_value Cloak(napi_env env, napi_callback_info info) {
  return SetCloak(env, info, TRUE);
}

static napi_value Uncloak(napi_env env, napi_callback_info info) {
  return SetCloak(env, info, FALSE);
}


static uint32_t argHandle(napi_env env, napi_callback_info info, size_t* got) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value t;
  void* d;
  napi_get_cb_info(env, info, &argc, argv, &t, &d);
  uint32_t v = 0;
  if (argc >= 1) {
    napi_valuetype vt;
    napi_typeof(env, argv[0], &vt);
    if (vt == napi_bigint) {
      uint64_t b = 0; bool lossless = false;
      napi_get_value_bigint_uint64(env, argv[0], &b, &lossless);
      v = static_cast<uint32_t>(b);
    } else {
      napi_get_value_uint32(env, argv[0], &v);
    }
  }
  if (got) *got = argc;
  return v;
}

static napi_value AttachHost(napi_env env, napi_callback_info info) {
  uint32_t v = argHandle(env, info, nullptr);
  HWND host = hostAttach(reinterpret_cast<HWND>(static_cast<uintptr_t>(v)));
  napi_value r, ok, h;
  napi_create_object(env, &r);
  napi_get_boolean(env, host != nullptr, &ok);
  napi_create_uint32(env, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(host)), &h);
  napi_set_named_property(env, r, "ok", ok);
  napi_set_named_property(env, r, "host", h);
  return r;
}

static napi_value SyncHost(napi_env env, napi_callback_info info) {
  napi_value r, moved, active;
  napi_create_object(env, &r);
  napi_get_boolean(env, hostSync(), &moved);
  napi_get_boolean(env, hostActive(), &active);
  napi_set_named_property(env, r, "moved", moved);
  napi_set_named_property(env, r, "active", active);
  return r;
}

static napi_value DetachHost(napi_env env, napi_callback_info info) {
  hostDetach();
  napi_value r;
  napi_get_boolean(env, true, &r);
  return r;
}

static napi_value HostHandle(napi_env env, napi_callback_info info) {
  napi_value r;
  napi_create_uint32(env, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(hostHandle())), &r);
  return r;
}


static napi_value SetAffinity(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_value t;
  void* d;
  napi_get_cb_info(env, info, &argc, argv, &t, &d);
  uint32_t h32 = 0, flag = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &h32);
  if (argc >= 2) napi_get_value_uint32(env, argv[1], &flag);
  HWND h = reinterpret_cast<HWND>(static_cast<uintptr_t>(h32));
  BOOL ok = FALSE;
  if (IsWindow(h)) ok = SetWindowDisplayAffinity(h, flag);
  napi_value r;
  napi_get_boolean(env, ok != FALSE, &r);
  return r;
}


static napi_value DwmExclude(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_value t;
  void* d;
  napi_get_cb_info(env, info, &argc, argv, &t, &d);
  uint32_t h32 = 0, on = 1;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &h32);
  if (argc >= 2) napi_get_value_uint32(env, argv[1], &on);
  HWND h = reinterpret_cast<HWND>(static_cast<uintptr_t>(h32));
  BOOL value = on ? TRUE : FALSE;
  HRESULT hr = E_FAIL;
  if (IsWindow(h)) hr = DwmSetWindowAttribute(h, DWMWA_EXCLUDED_FROM_CAPTURE, &value, sizeof(value));
  napi_value r;
  napi_get_boolean(env, SUCCEEDED(hr), &r);
  return r;
}

// Generic DWMWA setter. Exists because the DWMWA numbers used for the capture
// exclusion are not all in the SDK this repo compiles against, and a wrong
// number is silently accepted by DWM (it sets an unrelated attribute and
// returns S_OK), so the only way to identify the right one is to try it.
static napi_value DwmAttr(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_value t;
  void* d;
  napi_get_cb_info(env, info, &argc, argv, &t, &d);
  uint32_t h32 = 0, id = 0, on = 1;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &h32);
  if (argc >= 2) napi_get_value_uint32(env, argv[1], &id);
  if (argc >= 3) napi_get_value_uint32(env, argv[2], &on);
  HWND h = reinterpret_cast<HWND>(static_cast<uintptr_t>(h32));
  BOOL value = on ? TRUE : FALSE;
  HRESULT hr = E_FAIL;
  if (IsWindow(h)) hr = DwmSetWindowAttribute(h, static_cast<DWORD>(id), &value, sizeof(value));
  napi_value r;
  napi_get_boolean(env, SUCCEEDED(hr), &r);
  return r;
}

// Read back what GetWindowDisplayAffinity reports for a window. The Ghost check
// needs this: comparing captured pixels proves the exclusion works, and this
// proves *which* mechanism produced it (0x11 rather than a silent no-op).
static napi_value GetAffinity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value t;
  void* d;
  napi_get_cb_info(env, info, &argc, argv, &t, &d);
  uint32_t h32 = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &h32);
  HWND h = reinterpret_cast<HWND>(static_cast<uintptr_t>(h32));
  DWORD flag = 0;
  BOOL ok = FALSE;
  if (IsWindow(h)) ok = GetWindowDisplayAffinity(h, &flag);
  napi_value r;
  napi_create_int32(env, ok ? static_cast<int32_t>(flag) : -1, &r);
  return r;
}

// ---- read-only probes used by the stealth report ----
// The report has to show what a detector actually reads, so these return the
// real values rather than a restatement of what the app believes it set.

static napi_value ClassName(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], t;
  void* d;
  napi_get_cb_info(env, info, &argc, argv, &t, &d);
  uint32_t h32 = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &h32);
  wchar_t buf[256] = {};
  int n = 0;
  HWND h = reinterpret_cast<HWND>(static_cast<uintptr_t>(h32));
  if (IsWindow(h)) n = GetClassNameW(h, buf, 256);
  napi_value r;
  std::wstring w(buf, n > 0 ? n : 0);
  std::string s(w.begin(), w.end());
  napi_create_string_utf8(env, s.c_str(), s.size(), &r);
  return r;
}

static napi_value ExStyle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], t;
  void* d;
  napi_get_cb_info(env, info, &argc, argv, &t, &d);
  uint32_t h32 = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &h32);
  HWND h = reinterpret_cast<HWND>(static_cast<uintptr_t>(h32));
  LONG_PTR v = IsWindow(h) ? GetWindowLongPtrW(h, GWL_EXSTYLE) : 0;
  napi_value r;
  napi_create_double(env, static_cast<double>(v), &r);
  return r;
}

static napi_value Title(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], t;
  void* d;
  napi_get_cb_info(env, info, &argc, argv, &t, &d);
  uint32_t h32 = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &h32);
  wchar_t buf[512] = {};
  int n = 0;
  HWND h = reinterpret_cast<HWND>(static_cast<uintptr_t>(h32));
  if (IsWindow(h)) n = GetWindowTextW(h, buf, 512);
  std::wstring w(buf, n > 0 ? n : 0);
  std::string s(w.begin(), w.end());
  napi_value r;
  napi_create_string_utf8(env, s.c_str(), s.size(), &r);
  return r;
}

// Child windows whose class still says Chromium. The host hides the Electron
// window from the top-level enumeration; a detector that walks children finds
// these, so the report states how many exist instead of hiding the fact.
static BOOL CALLBACK countChromiumChildren(HWND h, LPARAM param) {
  wchar_t buf[256] = {};
  if (GetClassNameW(h, buf, 256) > 0) {
    std::wstring c(buf);
    if (c.find(L"Chrome_WidgetWin") != std::wstring::npos) (*(int*)param)++;
  }
  return TRUE;
}

static napi_value ChildChromiumClasses(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], t;
  void* d;
  napi_get_cb_info(env, info, &argc, argv, &t, &d);
  uint32_t h32 = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &h32);
  HWND h = reinterpret_cast<HWND>(static_cast<uintptr_t>(h32));
  int n = 0;
  if (IsWindow(h)) EnumChildWindows(h, countChromiumChildren, reinterpret_cast<LPARAM>(&n));
  napi_value r;
  napi_create_int32(env, n, &r);
  return r;
}

// The host is a colour-keyed layered window; re-apply the key and the layered flag.
// After a show the layered surface can come back without its key, and with it gone
// the exclusion stops taking effect even though GetWindowDisplayAffinity still
// answers 0x11.
static napi_value Rekey(napi_env env, napi_callback_info info) {
  uint32_t h32 = argHandle(env, info, nullptr);
  HWND h = reinterpret_cast<HWND>(static_cast<uintptr_t>(h32));
  BOOL ok = FALSE;
  if (IsWindow(h)) {
    LONG_PTR ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
    SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_LAYERED);
    ok = SetLayeredWindowAttributes(h, RGB(255, 0, 255), 0, LWA_COLORKEY);
    SetWindowPos(h, nullptr, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }
  napi_value r;
  napi_get_boolean(env, ok != FALSE, &r);
  return r;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "rekey", NAPI_AUTO_LENGTH, Rekey, nullptr, &fn);
  napi_set_named_property(env, exports, "rekey", fn);
  napi_create_function(env, "className", NAPI_AUTO_LENGTH, ClassName, nullptr, &fn);
  napi_set_named_property(env, exports, "className", fn);
  napi_create_function(env, "exStyle", NAPI_AUTO_LENGTH, ExStyle, nullptr, &fn);
  napi_set_named_property(env, exports, "exStyle", fn);
  napi_create_function(env, "title", NAPI_AUTO_LENGTH, Title, nullptr, &fn);
  napi_set_named_property(env, exports, "title", fn);
  napi_create_function(env, "childChromiumClasses", NAPI_AUTO_LENGTH, ChildChromiumClasses, nullptr, &fn);
  napi_set_named_property(env, exports, "childChromiumClasses", fn);
  napi_create_function(env, "getAffinity", NAPI_AUTO_LENGTH, GetAffinity, nullptr, &fn);
  napi_set_named_property(env, exports, "getAffinity", fn);
  napi_create_function(env, "dwmAttr", NAPI_AUTO_LENGTH, DwmAttr, nullptr, &fn);
  napi_set_named_property(env, exports, "dwmAttr", fn);
  napi_create_function(env, "cloak", NAPI_AUTO_LENGTH, Cloak, nullptr, &fn);
  napi_set_named_property(env, exports, "cloak", fn);
  napi_create_function(env, "uncloak", NAPI_AUTO_LENGTH, Uncloak, nullptr, &fn);
  napi_set_named_property(env, exports, "uncloak", fn);
  napi_create_function(env, "dwmExclude", NAPI_AUTO_LENGTH, DwmExclude, nullptr, &fn);
  napi_set_named_property(env, exports, "dwmExclude", fn);
  napi_create_function(env, "setAffinity", NAPI_AUTO_LENGTH, SetAffinity, nullptr, &fn);
  napi_set_named_property(env, exports, "setAffinity", fn);
  napi_create_function(env, "attachHost", NAPI_AUTO_LENGTH, AttachHost, nullptr, &fn);
  napi_set_named_property(env, exports, "attachHost", fn);
  napi_create_function(env, "syncHost", NAPI_AUTO_LENGTH, SyncHost, nullptr, &fn);
  napi_set_named_property(env, exports, "syncHost", fn);
  napi_create_function(env, "detachHost", NAPI_AUTO_LENGTH, DetachHost, nullptr, &fn);
  napi_set_named_property(env, exports, "detachHost", fn);
  napi_create_function(env, "hostHandle", NAPI_AUTO_LENGTH, HostHandle, nullptr, &fn);
  napi_set_named_property(env, exports, "hostHandle", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
