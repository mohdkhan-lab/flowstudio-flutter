import 'package:flutter/foundation.dart';
import '../services/automation_bridge.dart';

/// v2.48.82 (live PC-stats pill — owner order 2026-11-10): the
/// engine's real, live PC stats for the top strip. The Node engine
/// samples this PC every ~2s (CPU from os.cpus() time deltas, RAM
/// from os total/free) and pushes a 'system-stats' SSE event; this
/// provider simply holds the latest sample. Nothing here is
/// estimated or placeholder — a field the platform could not
/// supply stays null and the UI leaves that part out.
class SystemStatsProvider with ChangeNotifier {
  Map<String, dynamic>? _stats;

  SystemStatsProvider() {
    AutomationBridge.instance.onSystemStats = _onSystemStats;
    _loadInitial();
  }

  Map<String, dynamic>? get stats => _stats;

  int? get cpuPercent => _asInt(_stats?['cpuPercent']);
  int? get ramPercent => _asInt(_stats?['ramPercent']);

  static int? _asInt(dynamic v) {
    if (v is num) return v.round();
    return null;
  }

  void _onSystemStats(Map<String, dynamic> data) {
    _stats = data;
    notifyListeners();
  }

  Future<void> _loadInitial() async {
    final s = await AutomationBridge.instance.getSystemStats();
    if (s != null) {
      _stats = s;
      notifyListeners();
    }
  }
}
