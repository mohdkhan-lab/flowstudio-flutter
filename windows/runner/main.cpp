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
  // PUBLIC v1.0.8 (F2 — owner's order): ONE window size for the
  // whole app, from the very first frame — the studio's own
  // default 1280x800, centered on the primary monitor's work
  // area and clamped to it, resizable like any normal window
  // (maximize allowed). The entry gate is an overlay INSIDE
  // this window (a popup portal over the blurred studio); the
  // window itself never resizes or re-styles between the gate
  // and the studio — the v1.0.6/v1.0.7 two-size phase switch is
  // gone. Create() below scales the logical origin/size by the
  // monitor DPI, so the size and centering are computed in
  // logical units from the physical work area.
  Win32Window::Size size(1280, 800);
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
      if (work_w > 0 && size.width > work_w) size.width = static_cast<unsigned int>(work_w);
      if (work_h > 0 && size.height > work_h) size.height = static_cast<unsigned int>(work_h);
      origin = Win32Window::Point(
          static_cast<unsigned int>(left + (work_w > size.width ? (work_w - size.width) / 2 : 0)),
          static_cast<unsigned int>(top + (work_h > size.height ? (work_h - size.height) / 2 : 0)));
    }
  }
  if (!window.Create(L"FlowStudio", origin, size)) {
    return EXIT_FAILURE;
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
