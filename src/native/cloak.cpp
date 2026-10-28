// In-process DWM cloak. DWM refuses DwmSetWindowAttribute(DWMWA_CLOAK) from a
// foreign process with E_HANDLE/E_ACCESSDENIED, so it has to run inside the app.
// Electron has no FFI, so this is the smallest possible addon: cloak / uncloak.
#include <node_api.h>
#include <dwmapi.h>
#include <windows.h>

#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "user32.lib")

#ifndef DWMWA_CLOAK
#define DWMWA_CLOAK 13
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

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "cloak", NAPI_AUTO_LENGTH, Cloak, nullptr, &fn);
  napi_set_named_property(env, exports, "cloak", fn);
  napi_create_function(env, "uncloak", NAPI_AUTO_LENGTH, Uncloak, nullptr, &fn);
  napi_set_named_property(env, exports, "uncloak", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
