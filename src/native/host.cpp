// Host-window shim.
//
// A detector finds the overlay by enumerating top-level windows, then reads the
// class name and GetWindowDisplayAffinity from whatever it found. Both are
// giveaways: the class is Chrome_WidgetWin_1 (says "Electron") and the affinity
// is 0x11 (says "deliberately hidden from capture").
//
// Fix: create our own top-level window with an innocuous class, and reparent the
// Electron window into it. Child windows are not returned by EnumWindows, so the
// detector only ever sees the host: our class, and no affinity flag at all.
// The exclusion still lives on the child, and capture still excludes.
//
// Coordinate trap: once reparented, positions become parent-client relative, but
// Electron still calls SetWindowPos with what it believes are screen coords. So
// the host is kept exactly the child's size and the child's client origin is
// pinned to (0,0); a poll turns any client offset (Electron moving the window)
// into the host's new screen position. Keeping host == child size also means the
// host's own painting is fully covered, so it needs no transparency of its own
// beyond a colour-key as a safety net.

#include <windows.h>

static const wchar_t* HOST_CLASS = L"WinUIDesktopWin32WindowClass";
static const COLORREF HOST_KEY = RGB(255, 0, 255); // colour-key, never visible

static HWND g_host = nullptr;
static HWND g_child = nullptr;
static LONG_PTR g_childStyle = 0;

static LRESULT CALLBACK HostProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_ERASEBKGND: {
      HDC dc = (HDC)w;
      RECT r;
      GetClientRect(h, &r);
      HBRUSH b = CreateSolidBrush(HOST_KEY);
      FillRect(dc, &r, b);
      DeleteObject(b);
      return 1;
    }
    case WM_CLOSE:
      return 0; // the app owns the lifecycle
    default:
      return DefWindowProcW(h, m, w, l);
  }
}

static bool ensureClass() {
  static bool done = false;
  if (done) return true;
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = HostProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursorW(nullptr, reinterpret_cast<LPCWSTR>(IDC_ARROW));
  wc.hbrBackground = nullptr; // WM_ERASEBKGND paints
  wc.lpszClassName = HOST_CLASS;
  // registering in our own module is enough; a name clash with a real WinUI
  // class is invisible to GetClassNameW and therefore harmless
  if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;
  done = true;
  return true;
}

// Returns the host hwnd, or nullptr. Safe to call twice.
HWND hostAttach(HWND child) {
  if (g_host && IsWindow(g_host)) return g_host;
  if (!child || !IsWindow(child)) return nullptr;
  if (!ensureClass()) return nullptr;

  RECT r;
  if (!GetWindowRect(child, &r)) return nullptr;
  int w = r.right - r.left;
  int h = r.bottom - r.top;

  HWND host = CreateWindowExW(
    WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
    HOST_CLASS, L"", WS_POPUP | WS_VISIBLE,
    r.left, r.top, w, h, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!host) return nullptr;

  SetLayeredWindowAttributes(host, HOST_KEY, 0, LWA_COLORKEY);

  // make it a genuine child, remembering the original style for detach
  g_childStyle = GetWindowLongPtrW(child, GWL_STYLE);
  LONG_PTR st = (g_childStyle & ~WS_POPUP) | WS_CHILD;
  SetWindowLongPtrW(child, GWL_STYLE, st);

  SetParent(child, host);
  ShowWindow(child, SW_SHOW); // SetParent hides a visible child
  SetWindowPos(child, nullptr, 0, 0, w, h,
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  ShowWindow(host, SW_SHOWNOACTIVATE);

  g_host = host;
  g_child = child;
  return host;
}

// Keep host == child. Returns true when anything was adjusted.
bool hostSync() {
  if (!g_host || !g_child || !IsWindow(g_host) || !IsWindow(g_child)) return false;

  RECT rc, rh;
  if (!GetWindowRect(g_child, &rc)) return false;
  if (!GetWindowRect(g_host, &rh)) return false;

  // child client offset = Electron's intended screen delta (it still thinks it
  // is top-level). Non-zero means Electron moved or resized the window.
  int ox = rc.left - rh.left;
  int oy = rc.top - rh.top;
  int w = rc.right - rc.left;
  int h = rc.bottom - rc.top;
  int hw = rh.right - rh.left;
  int hh = rh.bottom - rh.top;

  if (ox == 0 && oy == 0 && w == hw && h == hh) return false;

  // The client offset IS Electron's intended screen position (it still believes
  // it owns a top-level window). Pin the child to the host origin and put the
  // host exactly there — not at host+offset, which compounds every poll.
  SetWindowPos(g_child, nullptr, 0, 0, w, h,
    SWP_NOZORDER | SWP_NOACTIVATE);
  SetWindowPos(g_host, nullptr, ox, oy, w, h,
    SWP_NOZORDER | SWP_NOACTIVATE);
  return true;
}

void hostDetach() {
  if (!g_host || !g_child) return;
  if (IsWindow(g_child) && IsWindow(g_host)) {
    SetParent(g_child, nullptr);
    SetWindowLongPtrW(g_child, GWL_STYLE, g_childStyle);
    ShowWindow(g_child, SW_SHOW);
    SetWindowPos(g_child, nullptr, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }
  if (IsWindow(g_host)) DestroyWindow(g_host);
  g_host = nullptr;
  g_child = nullptr;
}

HWND hostHandle() { return (g_host && IsWindow(g_host)) ? g_host : nullptr; }
bool hostActive() { return g_host != nullptr && IsWindow(g_host); }
