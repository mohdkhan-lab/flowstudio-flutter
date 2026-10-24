import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/activity_log.dart';
import '../services/automation_bridge.dart';

class ActivityProvider with ChangeNotifier {
  final List<ActivityLog> _logs = [];
  bool _isDetailsMode = false;

  ActivityProvider() {
    // v2.22.0 fix: the old constructor printed FAKE lines — a made-up
    // "Live balance: M. Aslam — 50 credits" and "Engine bridge connected"
    // — whether or not the engine had actually connected. Only the plain
    // start line is honest; engine state is logged by the accounts
    // provider after a real health check.
    addLog('FlowStudio Lite v2.29.1 started');

    // v2.29.0: the bridge's DETAIL flag now flows end-to-end into
    // addLog(isDetail:) — before this, no log was ever marked
    // detail, so Simple and Details showed identical lines.
    AutomationBridge.instance.onLog = (msg, level, isDetail) {
      addLog(msg, level: level, isDetail: isDetail);
    };
  }

  List<ActivityLog> get logs => List.unmodifiable(_logs);
  bool get isDetailsMode => _isDetailsMode;

  List<ActivityLog> get visibleLogs {
    if (_isDetailsMode) return _logs;
    // Simple view: milestones only — but errors and warnings are
    // ALWAYS visible, in both modes.
    return _logs
        .where((l) =>
            !l.isDetail ||
            l.level == LogLevel.error ||
            l.level == LogLevel.warning)
        .toList();
  }

  void setDetailsMode(bool value) {
    _isDetailsMode = value;
    notifyListeners();
  }

  void addLog(
    String message, {
    LogLevel level = LogLevel.info,
    String? account,
    bool isDetail = false,
  }) {
    _logs.add(
      ActivityLog(
        message: message,
        level: level,
        account: account,
        isDetail: isDetail,
      ),
    );
    if (_logs.length > 500) {
      _logs.removeAt(0);
    }
    notifyListeners();
  }

  void clearLogs() {
    _logs.clear();
    addLog('Logs cleared.', level: LogLevel.info);
    notifyListeners();
  }

  Future<void> copyLogsToClipboard() async {
    final buffer = StringBuffer();
    for (final log in _logs) {
      buffer.writeln(
        '[${log.timestamp.toIso8601String()}] [${log.level.name.toUpperCase()}] ${log.account != null ? "[${log.account}] " : ""}${log.message}',
      );
    }
    await Clipboard.setData(ClipboardData(text: buffer.toString()));
  }
}
