import 'dart:async';
import 'package:flutter/foundation.dart';
import '../services/automation_bridge.dart';

/// PUBLIC v1.0.0: state for the ENTRY GATE — the app's front door.
///
/// The app opens on the gate and shows nothing else until the
/// engine's gate decision (engine/entryGate.js, served by the
/// bridge at /api/entry/status) says entry is allowed. Two doors:
///   A — an account (Google sign-in, or email + a 6-digit code).
///       The backend behind it is a later phase; while it is not
///       configured the bridge answers with an honest
///       not-available message and this provider simply shows it —
///       there is no fake sign-in anywhere in this flow.
///   B — a license key: signed, checked by the engine offline,
///       bound to this one device on activation.
/// The plan line for the top strip comes from the same decision
/// (statusText), so what the user sees always matches the engine.
class EntryProvider extends ChangeNotifier {
  bool _loaded = false;
  bool _allowed = false;
  String _statusText = '';
  bool _doorAConfigured = false;
  String _doorAMessage =
      'Account sign-in is not available yet — please use a license key';
  bool _busy = false;
  String _error = '';
  bool _codeSent = false;
  Timer? _poll;

  // PUBLIC v1.0.1: the engine-start watchdog. If the engine has
  // not answered within this window the gate stops polling and
  // shows its engineFailed state (with a Retry button) instead of
  // sitting on "Starting the engine…" forever.
  static const Duration _engineWatchdog = Duration(seconds: 20);
  bool _engineFailed = false;
  DateTime _pollStartedAt = DateTime.now();

  EntryProvider() {
    // PUBLIC v1.0.1 — THE v1.0.0 BUG FIX: the gate itself starts
    // its engine. In v1.0.0 the only engine spawn lived in
    // AccountsProvider's constructor, and while gated the studio
    // (and that provider) is never built — so nothing ever
    // listened on the bridge port, this provider polled a dead
    // port forever, and every gate action failed with "The
    // engine is not answering". Fire-and-forget: ensureEngine-
    // Running adopts a healthy engine or spawns one, and the
    // poll below picks up its first answer.
    AutomationBridge.instance.ensureEngineRunning();
    refresh();
    _startPoll();
  }

  /// The engine takes a few seconds to come up after launch; keep
  /// asking until it answers once, then stop polling. If it never
  /// answers within the watchdog window, flip to the failed state
  /// instead of polling forever.
  void _startPoll() {
    _poll?.cancel();
    _pollStartedAt = DateTime.now();
    _poll = Timer.periodic(const Duration(seconds: 2), (_) {
      if (_loaded) {
        _poll?.cancel();
      } else if (DateTime.now().difference(_pollStartedAt) >=
          _engineWatchdog) {
        _engineFailed = true;
        _poll?.cancel();
        notifyListeners();
      } else {
        refresh();
      }
    });
  }

  /// The gate's Retry button (engineFailed state): start the
  /// engine again and resume polling for its first answer.
  void retryEngine() {
    _engineFailed = false;
    notifyListeners();
    AutomationBridge.instance.ensureEngineRunning();
    refresh();
    _startPoll();
  }

  bool get loaded => _loaded;
  bool get allowed => _allowed;
  String get statusText => _statusText;
  bool get doorAConfigured => _doorAConfigured;
  String get doorAMessage => _doorAMessage;
  bool get busy => _busy;
  String get error => _error;
  bool get codeSent => _codeSent;
  bool get engineFailed => _engineFailed;

  Future<void> refresh() async {
    final data = await AutomationBridge.instance.getEntryStatus();
    if (data == null) return;
    final entry = data['entry'];
    if (entry is Map) {
      _allowed = entry['allowed'] == true;
      _statusText = entry['statusText']?.toString() ?? '';
    }
    final doorA = data['doorA'];
    if (doorA is Map) {
      _doorAConfigured = doorA['configured'] == true;
      final msg = doorA['message']?.toString() ?? '';
      if (msg.isNotEmpty) _doorAMessage = msg;
    }
    _loaded = true;
    _engineFailed = false;
    notifyListeners();
  }

  /// PUBLIC v1.0.1: one automatic recovery for a "the engine is
  /// not answering" answer — make sure the engine is started,
  /// then run the same call once more before surfacing the error.
  Future<Map<String, dynamic>> _callWithEngineRetry(
    Future<Map<String, dynamic>> Function() call,
  ) async {
    var res = await call();
    if (res['ok'] != true &&
        res['error']?.toString() ==
            AutomationBridge.engineNotAnsweringError) {
      await AutomationBridge.instance.ensureEngineRunning();
      res = await call();
    }
    return res;
  }

  /// Door B: activate the typed license key on this device.
  Future<bool> activateKey(String key) async {
    if (_busy) return false;
    _busy = true;
    _error = '';
    notifyListeners();
    final res = await _callWithEngineRetry(
        () => AutomationBridge.instance.activateLicenseKey(key.trim()));
    _busy = false;
    if (res['ok'] == true) {
      await refresh();
      return true;
    }
    _error = res['error']?.toString() ?? 'Activation failed — try again.';
    notifyListeners();
    return false;
  }

  /// Door A: email the 6-digit sign-in code.
  Future<bool> sendCode(String email) async {
    if (_busy) return false;
    _busy = true;
    _error = '';
    notifyListeners();
    final res = await _callWithEngineRetry(
        () => AutomationBridge.instance.sendEntryCode(email.trim()));
    _busy = false;
    if (res['ok'] == true) {
      _codeSent = true;
      notifyListeners();
      return true;
    }
    _error = res['error']?.toString() ?? 'The code could not be sent.';
    notifyListeners();
    return false;
  }

  /// Door A: verify the emailed code and store the session.
  Future<bool> verifyCode(String email, String code) async {
    if (_busy) return false;
    _busy = true;
    _error = '';
    notifyListeners();
    final res = await _callWithEngineRetry(() => AutomationBridge.instance
        .verifyEntryCode(email.trim(), code.trim()));
    _busy = false;
    if (res['ok'] == true) {
      await refresh();
      return true;
    }
    _error = res['error']?.toString() ?? 'That code was not accepted.';
    notifyListeners();
    return false;
  }

  /// Settings → "Remove license key from this app". Clears the
  /// local credential only — it does NOT unbind this device.
  Future<void> removeKey() async {
    await AutomationBridge.instance.removeLicenseKey();
    _allowed = false;
    _statusText = '';
    await refresh();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }
}
