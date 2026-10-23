import 'package:flutter/material.dart';
import '../models/account.dart';
import '../models/activity_log.dart';
import '../services/automation_bridge.dart';

class AccountsProvider with ChangeNotifier {
  // v2.22.0 fix: NO hard-coded starter account. The old code pre-loaded a
  // fake "M. Aslam — 50 credits" account that stayed on screen whenever
  // the engine was unreachable, inventing state that did not exist.
  List<GoogleAccount> _accounts = [];

  // v2.25.0 (parked browser): accountId -> windowShown for every
  // account with a live generation browser, as last reported by the
  // engine. This map is the source of truth for the runtime isActive /
  // browserShown flags, so wholesale account refreshes (sync, import,
  // account-updated events) can re-apply them instead of wiping them.
  final Map<String, bool> _activeShown = {};

  AccountsProvider() {
    _initEngine();
  }

  /// Push the runtime ACTIVE flags from [_activeShown] onto the
  /// account objects. Returns true when anything actually changed.
  bool _applyActiveFlags() {
    var changed = false;
    for (final acc in _accounts) {
      final shown = _activeShown[acc.id];
      final active = shown != null;
      final shownFlag = shown ?? false;
      if (acc.isActive != active || acc.browserShown != shownFlag) {
        acc.isActive = active;
        acc.browserShown = shownFlag;
        changed = true;
      }
    }
    return changed;
  }

  /// One 'active-browsers' payload from the engine: the COMPLETE list
  /// of accounts generating right now (absent = not generating).
  void _onActiveBrowsers(List<Map<String, dynamic>> list) {
    _activeShown.clear();
    for (final entry in list) {
      final id = entry['id']?.toString() ?? '';
      if (id.isNotEmpty) {
        _activeShown[id] = entry['windowShown'] == true;
      }
    }
    if (_applyActiveFlags()) {
      notifyListeners();
    }
  }

  Future<void> _initEngine() async {
    await AutomationBridge.instance.ensureEngineRunning();
    final healthy = await AutomationBridge.instance.checkHealth();
    final remoteAccounts = await AutomationBridge.instance.getAccounts();
    if (remoteAccounts.isNotEmpty) {
      _accounts = remoteAccounts;
      notifyListeners();
    }

    // v2.25.0 (parked browser): live ACTIVE state for the sidebar.
    AutomationBridge.instance.onActiveBrowsers = _onActiveBrowsers;
    _onActiveBrowsers(await AutomationBridge.instance.getActiveBrowsers());
    // Report the engine state truthfully in the Activity log (when the
    // activity provider has registered its callback yet).
    if (healthy) {
      AutomationBridge.instance.onLog?.call(
        'Engine connected — ${_accounts.length} account(s) loaded.',
        LogLevel.success,
      );
    } else {
      AutomationBridge.instance.onLog?.call(
        'Engine NOT reachable — accounts and generation will not work until the Node engine starts.',
        LogLevel.error,
      );
    }

    AutomationBridge.instance.onAccountUpdated = (acc) {
      final index = _accounts.indexWhere((a) => a.id == acc.id);
      if (index != -1) {
        _accounts[index] = acc;
      } else {
        _accounts.add(acc);
      }
      // v2.25.0: a fresh account object arrives without the runtime
      // ACTIVE flags — re-apply them from the engine-reported map.
      _applyActiveFlags();
      notifyListeners();
    };
  }

  List<GoogleAccount> get accounts => List.unmodifiable(_accounts);

  int get totalCredits => _accounts
      .where((a) => a.isChecked && a.status != AccountStatus.outOfCredits)
      .fold(0, (sum, a) => sum + a.credits);

  int get activeAccountsCount =>
      _accounts.where((a) => a.isChecked && a.status == AccountStatus.ready).length;

  void toggleAccount(String id) {
    final index = _accounts.indexWhere((a) => a.id == id);
    if (index != -1) {
      _accounts[index].isChecked = !_accounts[index].isChecked;
      notifyListeners();
    }
  }

  Future<void> addAccount({
    required String name,
    required String email,
    int credits = 50,
    String? profilePath,
  }) async {
    _accounts.add(
      GoogleAccount(
        id: 'acc_${DateTime.now().millisecondsSinceEpoch}',
        name: name,
        email: email,
        credits: credits,
        profilePath: profilePath,
      ),
    );
    notifyListeners();

    await AutomationBridge.instance.addAccount(name, email);
  }

  Future<void> importChromeProfile(String dirName) async {
    await AutomationBridge.instance.importChromeProfile(dirName);
    final remote = await AutomationBridge.instance.getAccounts();
    if (remote.isNotEmpty) {
      _accounts = remote;
      _applyActiveFlags();
      notifyListeners();
    }
  }

  Future<void> removeAccount(String id) async {
    _accounts.removeWhere((a) => a.id == id);
    notifyListeners();
    await AutomationBridge.instance.deleteAccount(id);
  }

  Future<void> syncAll() async {
    await AutomationBridge.instance.syncAllAccounts();
  }

  void updateCredits(String id, int credits) {
    final index = _accounts.indexWhere((a) => a.id == id);
    if (index != -1) {
      _accounts[index].credits = credits;
      if (credits <= 0) {
        _accounts[index].status = AccountStatus.outOfCredits;
      }
      notifyListeners();
    }
  }

  GoogleAccount? getNextAvailableAccount() {
    try {
      return _accounts.firstWhere(
        (a) => a.isChecked && a.status == AccountStatus.ready && a.credits > 0,
      );
    } catch (_) {
      return null;
    }
  }

  void selectAll() {
    for (int i = 0; i < _accounts.length; i++) {
      _accounts[i].isChecked = true;
    }
    notifyListeners();
  }

  void clearSelection() {
    for (int i = 0; i < _accounts.length; i++) {
      _accounts[i].isChecked = false;
    }
    notifyListeners();
  }

  Future<void> deleteSelected() async {
    final selectedIds = _accounts.where((a) => a.isChecked).map((a) => a.id).toList();
    if (selectedIds.isEmpty) return;

    _accounts.removeWhere((a) => selectedIds.contains(a.id));
    notifyListeners();

    await AutomationBridge.instance.deleteSelectedAccounts(selectedIds);
  }

  Future<void> syncSelected() async {
    final selectedIds = _accounts.where((a) => a.isChecked).map((a) => a.id).toList();
    if (selectedIds.isEmpty) return;

    await AutomationBridge.instance.syncSelectedAccounts(selectedIds);
    final remote = await AutomationBridge.instance.getAccounts();
    if (remote.isNotEmpty) {
      _accounts = remote;
      _applyActiveFlags();
      notifyListeners();
    }
  }

  Future<void> openChrome(String id) async {
    await AutomationBridge.instance.openChromeForAccount(id);
  }

  /// v2.25.0 (parked browser): for a GENERATING account, the line's
  /// Chrome button shows/hides the working browser itself instead of
  /// opening a separate window. The engine's answer carries the new
  /// state; the 'active-browsers' event confirms it right after.
  Future<void> toggleBrowser(String id) async {
    final shown = await AutomationBridge.instance.toggleAccountBrowser(id);
    if (shown != null && _activeShown.containsKey(id)) {
      _activeShown[id] = shown;
      if (_applyActiveFlags()) {
        notifyListeners();
      }
    }
  }

  Future<Map<String, dynamic>> importCookiesFromFile(String filePath, {String? label}) async {
    final res = await AutomationBridge.instance.importAccountFromCookieFile(filePath, label: label);
    if (res['ok'] == true) {
      final remote = await AutomationBridge.instance.getAccounts();
      if (remote.isNotEmpty) {
        _accounts = remote;
        _applyActiveFlags();
        notifyListeners();
      }
    }
    return res;
  }

  Future<Map<String, dynamic>> importCookies(String label, String text) async {
    final res = await AutomationBridge.instance.importAccountFromCookieText(label, text);
    if (res['ok'] == true) {
      final remote = await AutomationBridge.instance.getAccounts();
      if (remote.isNotEmpty) {
        _accounts = remote;
        _applyActiveFlags();
        notifyListeners();
      }
    }
    return res;
  }
}

