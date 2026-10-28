// In-process DWM cloak. DWM refuses DwmSetWindowAttribute(DWMWA_CLOAK) from a
// foreign process with E_HANDLE/E_ACCESSDENIED, so it has to run inside the app.
// Electron has no FFI, so this is the smallest possible addon: cloak / uncloak.
#include <node_api.h>
#include <dwmapi.h>
#include <windows.h>

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

// Not in older SDK headers (added after 19041). Excludes a window from capture
// WITHOUT touching SetWindowDisplayAffinity, so GetWindowDisplayAffinity still
// answers 0 and the "deliberately hidden" flag never shows up.
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

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
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
