import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
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

  // v2.29.0 (source numbering): accountId -> {alias, source}, the
  // display-alias store. Persisted in the engine settings under
  // 'account_aliases' (it lives in %APPDATA% with the database, so
  // it survives app updates). Entries are NEVER removed — a deleted
  // account's number is not reused, so Cookie/Account numbering is
  // stable for the life of the install. Display layer only: engine
  // names/emails are never renamed.
  final Map<String, Map<String, String>> _aliasStore = {};

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

  /// v2.29.0: load the persisted alias store from the engine
  /// settings (best-effort — an unreachable engine just means
  /// aliases are (re)assigned and persisted on the first refresh).
  Future<void> _loadAliasStore() async {
    try {
      final data = await AutomationBridge.instance.loadSettings();
      final raw = data?['account_aliases']?.toString();
      if (raw != null && raw.isNotEmpty) {
        final decoded = json.decode(raw);
        if (decoded is Map) {
          decoded.forEach((k, v) {
            if (v is Map) {
              _aliasStore[k.toString()] = {
                'alias': v['alias']?.toString() ?? '',
                'source': v['source']?.toString() ?? 'account',
              };
            }
          });
        }
      }
    } catch (_) {}
  }

  void _persistAliasStore() {
    AutomationBridge.instance.saveSetting(
      'account_aliases',
      json.encode(_aliasStore),
    );
  }

  /// v2.29.0: source inference for accounts that predate the alias
  /// store, from the engine's own fields (inspected in
  /// engine/db.js + engine/cookieImport.js): a cookie import saves
  /// cookies (has_cookies = 1) and never sets a Chrome profile dir;
  /// a profile import always carries chromeProfileDir. Anything
  /// ambiguous counts as the account route.
  String _inferSource(GoogleAccount acc) =>
      (acc.hasCookies && acc.chromeProfileDir.isEmpty) ? 'cookie' : 'account';

  /// v2.29.0: give every current account its alias, assigning new
  /// ones in list order (= engine creation order). [hints] maps
  /// account id → source for adds whose route is known exactly
  /// (this session's cookie imports / profile imports / logins).
  void _ensureAliases({Map<String, String> hints = const {}}) {
    var changed = false;
    for (final acc in _accounts) {
      var entry = _aliasStore[acc.id];
      if (entry == null) {
        final source = hints[acc.id] ?? _inferSource(acc);
        final n =
            _aliasStore.values.where((e) => e['source'] == source).length + 1;
        entry = {
          'alias': source == 'cookie' ? 'Cookie $n' : 'Account $n',
          'source': source,
        };
        _aliasStore[acc.id] = entry;
        changed = true;
      }
      acc.alias = entry['alias'] ?? '';
    }
    if (changed) _persistAliasStore();
  }

  /// v2.29.0: one refresh path for every wholesale account reload —
  /// re-applies the runtime ACTIVE flags and the aliases, so neither
  /// is ever wiped by a sync/import refresh.
  void _replaceAccounts(
    List<GoogleAccount> remote, {
    Map<String, String> hints = const {},
  }) {
    if (remote.isEmpty) return;
    _accounts = remote;
    _applyActiveFlags();
    _ensureAliases(hints: hints);
    notifyListeners();
  }

  Future<void> _initEngine() async {
    await AutomationBridge.instance.ensureEngineRunning();
    await _loadAliasStore();
    final healthy = await AutomationBridge.instance.checkHealth();
    final remoteAccounts = await AutomationBridge.instance.getAccounts();
    if (remoteAccounts.isNotEmpty) {
      _accounts = remoteAccounts;
      _ensureAliases();
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
        false,
      );
    } else {
      AutomationBridge.instance.onLog?.call(
        'Engine NOT reachable — accounts and generation will not work until the Node engine starts.',
        LogLevel.error,
        false,
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
      // v2.29.0: same for the display alias.
      _ensureAliases();
      notifyListeners();
    };
  }

  List<GoogleAccount> get accounts => List.unmodifiable(_accounts);

  // v2.29.1: TOTAL CREDITS is the pool's real total — the sum of
  // ALL accounts' credits, ticked or not. It used to count only
  // ticked accounts, so it disagreed with the settings-bar estimate
  // (which counts Live accounts) on the same screen.
  int get totalCredits =>
      _accounts.fold(0, (sum, a) => sum + a.credits);

  int get activeAccountsCount =>
      _accounts.where((a) => a.isChecked && a.status == AccountStatus.ready).length;

  void toggleAccount(String id) {
    final index = _accounts.indexWhere((a) => a.id == id);
    if (index != -1) {
      _accounts[index].isChecked = !_accounts[index].isChecked;
      notifyListeners();
    }
  }

  /// v2.29.0 (direct Gmail login): the popup's "+ Add Account" card.
  /// The engine creates the account via its login route and opens
  /// the real Google sign-in window at once; the account's real
  /// name/email/credits arrive through account-updated events after
  /// the owner signs in.
  ///
  /// This REPLACES the old addAccount(name, email, credits) — the
  /// audit's "ghost account": it first added a LOCAL fake account
  /// (invented id/email/credits, shown as LIVE) and only then told
  /// the engine, so the fake line vanished on restart and its
  /// Chrome button targeted a non-existent id. That path is gone.
  Future<void> startGmailLogin() async {
    final created = await AutomationBridge.instance.startGmailLogin();
    if (created == null) return;
    final hints = {created.id: 'account'};
    final remote = await AutomationBridge.instance.getAccounts();
    if (remote.isNotEmpty) {
      _replaceAccounts(remote, hints: hints);
    } else if (!_accounts.any((a) => a.id == created.id)) {
      _accounts.add(created);
      _ensureAliases(hints: hints);
      notifyListeners();
    }
  }

  Future<void> importChromeProfile(String dirName) async {
    // v2.29.0: snapshot the known ids so the NEW account this import
    // creates is recorded with its exact source ('account' route).
    final beforeIds = _accounts.map((a) => a.id).toSet();
    await AutomationBridge.instance.importChromeProfile(dirName);
    final remote = await AutomationBridge.instance.getAccounts();
    final hints = <String, String>{
      for (final a in remote)
        if (!beforeIds.contains(a.id)) a.id: 'account',
    };
    _replaceAccounts(remote, hints: hints);
  }

  Future<void> removeAccount(String id) async {
    _accounts.removeWhere((a) => a.id == id);
    notifyListeners();
    await AutomationBridge.instance.deleteAccount(id);
  }

  Future<void> syncAll() async {
    await AutomationBridge.instance.syncAllAccounts();
    // v2.29.0 (bulk sync refresh): re-read the accounts so the
    // sidebar shows the FRESH credits/chips right away — before
    // this, a bulk sync left the pre-sync numbers on screen until
    // the app was restarted (single-account sync already refreshed).
    final remote = await AutomationBridge.instance.getAccounts();
    _replaceAccounts(remote);
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

  /// v2.27.0: sync ONE account (the Add Account popup's per-card Sync
  /// button). Uses the same engine route as sync-selected, then
  /// refreshes the list exactly like syncSelected() does.
  Future<void> syncAccountById(String id) async {
    if (id.isEmpty) return;
    await AutomationBridge.instance.syncSelectedAccounts([id]);
    final remote = await AutomationBridge.instance.getAccounts();
    _replaceAccounts(remote);
  }

  Future<void> syncSelected() async {
    final selectedIds = _accounts.where((a) => a.isChecked).map((a) => a.id).toList();
    if (selectedIds.isEmpty) return;

    await AutomationBridge.instance.syncSelectedAccounts(selectedIds);
    final remote = await AutomationBridge.instance.getAccounts();
    _replaceAccounts(remote);
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
      // v2.29.0: record the add route exactly — cookies.
      final accId = (res['account'] is Map) ? res['account']['id']?.toString() : null;
      final remote = await AutomationBridge.instance.getAccounts();
      _replaceAccounts(
        remote,
        hints: accId != null ? {accId: 'cookie'} : const {},
      );
    }
    return res;
  }

  Future<Map<String, dynamic>> importCookies(String label, String text) async {
    final res = await AutomationBridge.instance.importAccountFromCookieText(label, text);
    if (res['ok'] == true) {
      final accId = (res['account'] is Map) ? res['account']['id']?.toString() : null;
      final remote = await AutomationBridge.instance.getAccounts();
      _replaceAccounts(
        remote,
        hints: accId != null ? {accId: 'cookie'} : const {},
      );
    }
    return res;
  }

  /// v2.29.0: the sidebar's top "+ Add Cookies" button — opens the
  /// file picker and imports every picked cookie file through the
  /// engine (the behaviour the old sidebar-local helper had, now
  /// in the provider where the rest of the account actions live).
  /// Results are reported in the Activity log.
  Future<void> pickAndImportCookieFiles() async {
    try {
      final picked = await FilePickerPlatform.instance.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['json', 'txt'],
      );
      if (picked.isEmpty) return;
      var success = 0;
      var duplicates = 0;
      String? lastError;
      for (final file in picked) {
        final path = file.path;
        if (path == null) continue;
        final res = await importCookiesFromFile(path);
        if (res['ok'] == true) {
          success++;
          if (res['duplicate'] == true) duplicates++;
        } else {
          lastError = res['error']?.toString() ?? 'Unknown error';
        }
      }
      if (success > 0) {
        AutomationBridge.instance.onLog?.call(
          duplicates > 0 && duplicates == success
              ? 'Those cookies were already added — the existing account was re-checked, no duplicate made.'
              : success == 1
                  ? 'Account added from cookies successfully!'
                  : '$success accounts added from cookies!',
          LogLevel.success,
          false,
        );
      } else if (lastError != null) {
        AutomationBridge.instance.onLog?.call(
          'Cookie import failed: $lastError',
          LogLevel.error,
          false,
        );
      }
    } catch (e) {
      AutomationBridge.instance.onLog?.call(
        'Cookie file error: $e',
        LogLevel.error,
        false,
      );
    }
  }
}

