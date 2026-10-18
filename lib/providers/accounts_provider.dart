import 'package:flutter/material.dart';
import '../models/account.dart';
import '../models/activity_log.dart';
import '../services/automation_bridge.dart';

class AccountsProvider with ChangeNotifier {
  // v2.22.0 fix: NO hard-coded starter account. The old code pre-loaded a
  // fake "M. Aslam — 50 credits" account that stayed on screen whenever
  // the engine was unreachable, inventing state that did not exist.
  List<GoogleAccount> _accounts = [];

  AccountsProvider() {
    _initEngine();
  }

  Future<void> _initEngine() async {
    await AutomationBridge.instance.ensureEngineRunning();
    final healthy = await AutomationBridge.instance.checkHealth();
    final remoteAccounts = await AutomationBridge.instance.getAccounts();
    if (remoteAccounts.isNotEmpty) {
      _accounts = remoteAccounts;
      notifyListeners();
    }
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
      notifyListeners();
    }
  }

  Future<void> openChrome(String id) async {
    await AutomationBridge.instance.openChromeForAccount(id);
  }

  Future<Map<String, dynamic>> importCookiesFromFile(String filePath, {String? label}) async {
    final res = await AutomationBridge.instance.importAccountFromCookieFile(filePath, label: label);
    if (res['ok'] == true) {
      final remote = await AutomationBridge.instance.getAccounts();
      if (remote.isNotEmpty) {
        _accounts = remote;
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
        notifyListeners();
      }
    }
    return res;
  }
}

