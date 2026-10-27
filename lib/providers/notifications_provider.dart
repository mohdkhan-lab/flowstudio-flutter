import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import '../models/app_notification.dart';
import '../services/automation_bridge.dart';

/// Notification Center: the store behind the top-strip bell.
///
/// Holds the notification list (newest first, capped at 100),
/// the unread count, the panel open/closed state and the
/// transient popup card. Event sources (GeneratorProvider,
/// AccountsProvider) reach it through [shared] — a static
/// reference set on construction — so they degrade to a no-op
/// when the center is absent instead of crashing.
///
/// Persistence rides the engine settings store, the same route
/// account_aliases / history_cleared already use: the list lives
/// under the 'notifications_list' JSON key and the ON/OFF toggle
/// under 'notifications_enabled' ('1'/'0', default ON).
/// Settings → "Notifications" reads and writes [enabled] /
/// [setEnabled] here — this provider is the toggle's only owner.
class NotificationsProvider with ChangeNotifier {
  static NotificationsProvider? shared;

  static const int maxItems = 100;

  final List<AppNotification> _items = [];
  bool _enabled = true;
  bool _panelOpen = false;
  bool _loaded = false;
  AppNotification? _popup;
  Timer? _popupTimer;

  NotificationsProvider() {
    shared = this;
    _load();
  }

  List<AppNotification> get items => List.unmodifiable(_items);
  bool get enabled => _enabled;
  bool get panelOpen => _panelOpen;
  AppNotification? get popup => _popup;
  int get unreadCount => _items.where((n) => !n.read).length;

  /// The engine may still be starting when this provider is
  /// created, so wait for its health (like the main screen's
  /// startup does) before reading the stored list — otherwise a
  /// restart would silently lose every saved notification.
  Future<void> _load() async {
    try {
      var healthy = await AutomationBridge.instance.checkHealth();
      for (var i = 0; i < 30 && !healthy; i++) {
        await Future.delayed(const Duration(milliseconds: 500));
        healthy = await AutomationBridge.instance.checkHealth();
      }
      if (!healthy) return;
      final data = await AutomationBridge.instance.loadSettings();
      if (data == null) return;
      if (data['notifications_enabled'] != null) {
        _enabled = data['notifications_enabled'].toString() != '0';
      }
      final raw = data['notifications_list']?.toString();
      if (raw != null && raw.isNotEmpty) {
        final decoded = json.decode(raw);
        if (decoded is List) {
          final stored = decoded
              .whereType<Map>()
              .map((e) => AppNotification.fromJson(
                  Map<String, dynamic>.from(e)))
              .whereType<AppNotification>()
              .toList();
          // Merge with anything that arrived while loading (a run
          // can finish in the first seconds) instead of dropping it.
          final storedIds = stored.map((n) => n.id).toSet();
          final fresh =
              _items.where((n) => !storedIds.contains(n.id)).toList();
          _items
            ..clear()
            ..addAll([...fresh, ...stored]);
          _items.sort((a, b) => b.time.compareTo(a.time));
          if (_items.length > maxItems) {
            _items.removeRange(maxItems, _items.length);
          }
        }
      }
      _loaded = true;
      notifyListeners();
    } catch (_) {
      // A store that cannot be read is not fatal — the center
      // simply starts empty for this session.
    }
  }

  void _persist() {
    AutomationBridge.instance.saveSetting(
      'notifications_list',
      json.encode(_items.map((n) => n.toJson()).toList()),
    );
  }

  /// Record one notification. When the panel is closed it also
  /// shows as a small popup card near the bell for ~2 seconds;
  /// the stored entry and the badge stay behind after it fades.
  /// When OFF (Settings → Notifications) nothing is stored and
  /// nothing pops up.
  void add({
    required NotificationType type,
    required String title,
    required String message,
    String? fileName,
  }) {
    if (!_enabled) return;
    final n = AppNotification(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      type: type,
      title: title,
      message: message,
      time: DateTime.now(),
      fileName: fileName,
    );
    _items.insert(0, n);
    if (_items.length > maxItems) {
      _items.removeRange(maxItems, _items.length);
    }
    _persist();
    if (!_panelOpen) {
      _popup = n;
      _popupTimer?.cancel();
      _popupTimer = Timer(const Duration(seconds: 2), () {
        if (_popup?.id == n.id) {
          _popup = null;
          notifyListeners();
        }
      });
    }
    notifyListeners();
  }

  void togglePanel() {
    _panelOpen = !_panelOpen;
    if (_panelOpen) {
      // The list is now on screen — the popup card has no job.
      _popup = null;
      _popupTimer?.cancel();
    }
    notifyListeners();
  }

  void closePanel() {
    if (!_panelOpen) return;
    _panelOpen = false;
    notifyListeners();
  }

  void markRead(String id) {
    for (final n in _items) {
      if (n.id == id && !n.read) {
        n.read = true;
        _persist();
        notifyListeners();
        return;
      }
    }
  }

  void markAllRead() {
    if (unreadCount == 0) return;
    for (final n in _items) {
      n.read = true;
    }
    _persist();
    notifyListeners();
  }

  void clearAll() {
    if (_items.isEmpty && _popup == null) return;
    _items.clear();
    _popup = null;
    _popupTimer?.cancel();
    _persist();
    notifyListeners();
  }

  /// Settings toggle ('notifications_enabled'). OFF hides the
  /// current popup and stops new notifications being stored.
  void setEnabled(bool value) {
    _enabled = value;
    if (!value) {
      _popup = null;
      _popupTimer?.cancel();
    }
    AutomationBridge.instance
        .saveSetting('notifications_enabled', value ? '1' : '0');
    notifyListeners();
  }

  @override
  void dispose() {
    _popupTimer?.cancel();
    if (shared == this) shared = null;
    super.dispose();
  }

  // Kept for symmetry with other providers that gate work on the
  // initial load; the center is fully usable before it completes.
  bool get loaded => _loaded;
}
