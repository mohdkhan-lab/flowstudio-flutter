import 'dart:async';
import 'package:flutter/foundation.dart';
import '../services/automation_bridge.dart';

/// PUBLIC v1.0.0: state for the ENTRY GATE — the app's front door.
///
/// The app opens on the gate and shows nothing else until the
/// engine's gate decision (engine/entryGate.js, served by the
/// bridge at /api/entry/status) says entry is allowed. Two doors:
///   A — an account (Google sign-in, or email + password).
///       Phase 2 (v1.0.2): the backend is LIVE (Firebase) —
///       sign-in is real, a first sign-in starts a 7-day trial,
///       and the engine refreshes the session and honours a
///       3-day offline grace from the last successful check.
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
  String _notice = '';
  Timer? _poll;

  // Phase 2: the account side of the current decision, for the
  // Settings account card (signed-in email, plan, trial days).
  String _email = '';
  String _plan = '';
  int _daysLeft = 0;
  bool _trial = false;
  bool _isAccount = false;
  Timer? _accountWatch;

  // PUBLIC v1.0.1: the engine-start watchdog. If the engine has
  // not answered within this window the gate stops polling and
  // shows its engineFailed state (with a Retry button) instead of
  // sitting on "Starting the engine…" forever.
  static const Duration _engineWatchdog = Duration(seconds: 20);
  bool _engineFailed = false;

  // v1.0.2 (startup screen): true once the engine PROCESS is up
  // (ensureEngineRunning has completed) — the splash's status
  // line moves from "Starting engine…" to "Checking your entry…"
  // on it, while the first entry answer is still on its way.
  bool _engineStarted = false;
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
    final started = AutomationBridge.instance.ensureEngineRunning();
    started.then((_) {
      _engineStarted = true;
      notifyListeners();
    });
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
    _engineStarted = false;
    notifyListeners();
    final started = AutomationBridge.instance.ensureEngineRunning();
    started.then((_) {
      _engineStarted = true;
      notifyListeners();
    });
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
  String get notice => _notice;
  bool get engineFailed => _engineFailed;

  /// v1.0.2: true once the engine process is up (the entry
  /// answer may still be on its way) — the startup screen's
  /// status line keys off this.
  bool get engineStarted => _engineStarted;

  /// Phase 2: the signed-in account's email ('' for key entry).
  String get email => _email;

  /// Phase 2: the account's plan name ('' for key entry).
  String get plan => _plan;

  /// Phase 2: whole days left on the trial (0 when not trialing).
  int get daysLeft => _daysLeft;

  /// Phase 2: true while the entry is a trial.
  bool get trial => _trial;

  /// Phase 2: true when the current entry is an account session
  /// (Settings shows the account card instead of the license card).
  bool get isAccount => _isAccount;

  Future<void> refresh() async {
    final data = await AutomationBridge.instance.getEntryStatus();
    if (data == null) return;
    final entry = data['entry'];
    if (entry is Map) {
      _allowed = entry['allowed'] == true;
      _statusText = entry['statusText']?.toString() ?? '';
      _isAccount = entry['reason']?.toString() == 'account';
      _email = entry['email']?.toString() ?? '';
      _plan = entry['plan']?.toString() ?? '';
      _trial = entry['trial'] == true;
      final dl = entry['daysLeft'];
      _daysLeft = dl is num ? dl.toInt() : 0;
      if (_allowed) _stopAccountWatch();
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

  /// Door A: sign in with email + password.
  Future<bool> signIn(String email, String password) async {
    if (_busy) return false;
    _busy = true;
    _error = '';
    _notice = '';
    notifyListeners();
    final res = await _callWithEngineRetry(() => AutomationBridge.instance
        .signInAccount(email.trim(), password));
    _busy = false;
    if (res['ok'] == true) {
      await refresh();
      return true;
    }
    _error = res['error']?.toString() ?? 'Sign-in failed — try again.';
    notifyListeners();
    return false;
  }

  /// Door A: create an account with email + password.
  Future<bool> signUp(String email, String password) async {
    if (_busy) return false;
    _busy = true;
    _error = '';
    _notice = '';
    notifyListeners();
    final res = await _callWithEngineRetry(() => AutomationBridge.instance
        .signUpAccount(email.trim(), password));
    _busy = false;
    if (res['ok'] == true) {
      await refresh();
      return true;
    }
    _error = res['error']?.toString() ?? 'Sign-up failed — try again.';
    notifyListeners();
    return false;
  }

  /// Door A: email a password-reset link. The bridge answers the
  /// same way whether or not the email has an account; the gate
  /// shows that sentence as a notice, not an error.
  Future<bool> forgotPassword(String email) async {
    if (_busy) return false;
    _busy = true;
    _error = '';
    _notice = '';
    notifyListeners();
    final res = await _callWithEngineRetry(() =>
        AutomationBridge.instance.forgotEntryPassword(email.trim()));
    _busy = false;
    if (res['ok'] == true) {
      _notice = res['message']?.toString() ??
          'If that email has an account, a password reset email is on its way.';
      notifyListeners();
      return true;
    }
    _error = res['error']?.toString() ?? 'The reset email could not be sent.';
    notifyListeners();
    return false;
  }

  /// Phase 2: while the Google sign-in runs in the system
  /// browser, watch the entry status — when the browser flow
  /// stores the session on the bridge's callback, the next poll
  /// flips the gate open on its own. The watch gives up after
  /// about three minutes; the gate's own controls stay live.
  void startAccountWatch() {
    _stopAccountWatch();
    var ticks = 0;
    _accountWatch = Timer.periodic(const Duration(seconds: 2), (_) {
      ticks++;
      if (_allowed || ticks > 90) {
        _stopAccountWatch();
      } else {
        refresh();
      }
    });
  }

  void _stopAccountWatch() {
    _accountWatch?.cancel();
    _accountWatch = null;
  }

  /// Settings → Sign out (account sessions). The bridge clears
  /// the local session; the gate comes back on the next refresh.
  Future<void> signOut() async {
    await AutomationBridge.instance.signOutAccount();
    _allowed = false;
    _statusText = '';
    _email = '';
    _plan = '';
    _isAccount = false;
    await refresh();
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
    _stopAccountWatch();
    super.dispose();
  }
}
