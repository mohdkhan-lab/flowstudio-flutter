#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <flutter_windows.h>
#include <windows.h>

#include "flutter_window.h"
#include "utils.h"

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  // PUBLIC v1.0.6 (F4 — owner's order): the app OPENS as a small
  // entry panel — 640x520 logical, centered on the primary
  // monitor's work area, FIXED size — while the splash / entry
  // gate is up. Only after the entry check passes does the app
  // take its real studio size (1280x800, resizable); that switch
  // is driven from the engine (engine/windowStyle.js phases,
  // POST /api/entry/window-phase). Create() below scales the
  // logical origin/size by the monitor DPI, so the centering is
  // computed in logical units from the physical work area.
  Win32Window::Size size(640, 520);
  Win32Window::Point origin(0, 0);
  {
    HMONITOR monitor = ::MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO info{};
    info.cbSize = sizeof(info);
    if (monitor && ::GetMonitorInfo(monitor, &info)) {
      const double scale = FlutterDesktopGetDpiForMonitor(monitor) / 96.0;
      const double work_w = (info.rcWork.right - info.rcWork.left) / scale;
      const double work_h = (info.rcWork.bottom - info.rcWork.top) / scale;
      const double left = info.rcWork.left / scale;
      const double top = info.rcWork.top / scale;
      origin = Win32Window::Point(
          static_cast<unsigned int>(left + (work_w > size.width ? (work_w - size.width) / 2 : 0)),
          static_cast<unsigned int>(top + (work_h > size.height ? (work_h - size.height) / 2 : 0)));
    }
  }
  if (!window.Create(L"FlowStudio", origin, size)) {
    return EXIT_FAILURE;
  }
  // Fixed size during the gate phase: no sizing border, no
  // maximize box. The engine restores both when the studio phase
  // begins (and removes them again if the gate returns).
  if (HWND hwnd = window.GetHandle()) {
    const LONG style = ::GetWindowLong(hwnd, GWL_STYLE);
    ::SetWindowLong(hwnd, GWL_STYLE, style & ~(WS_THICKFRAME | WS_MAXIMIZEBOX));
    ::SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                   SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
