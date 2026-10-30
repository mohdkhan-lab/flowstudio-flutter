import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import '../models/account.dart';
import '../models/activity_log.dart';
import '../models/app_notification.dart';
import '../services/automation_bridge.dart';
import '../services/credit_costs.dart';
import 'notifications_provider.dart';

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

  // v2.30.2 (bulk cookie add): account ids whose cookie check was
  // deferred at add time and is queued for / still running in the
  // batch's phase-2 check. Like _activeShown, this is the source of
  // truth for the runtime pendingCheck flag, so wholesale refreshes
  // re-apply it instead of wiping it. An id leaves the set when its
  // check's final account state arrives (see onAccountUpdated) or
  // when the phase-2 call ends (see _runCookieChecks).
  final Set<String> _pendingCheckIds = {};

  // v2.30.2: pending ids whose phase-2 check has actually STARTED
  // (a 'Checking…' state was seen for them). A pending id may only
  // leave _pendingCheckIds after its check has started — the bridge
  // also broadcasts the deferred ADD itself (a plain 'Need Login'
  // object), and that early broadcast must not clear the flag
  // before the account's own check has even run.
  final Set<String> _checkSeenIds = {};

  // v2.29.0 (source numbering): accountId -> {alias, source}, the
  // display-alias store. Persisted in the engine settings under
  // 'account_aliases' (it lives in %APPDATA% with the database, so
  // it survives app updates). Entries are NEVER removed — a deleted
  // account's number is not reused, so Cookie/Account numbering is
  // stable for the life of the install. Display layer only: engine
  // names/emails are never renamed.
  final Map<String, Map<String, String>> _aliasStore = {};

  // Notification Center: per-account alert bookkeeping. The last
  // status seen per account id (login alerts fire on the
  // TRANSITION into a fail state, never on every repeat event),
  // and the ids already warned about low credits (warned once
  // until the balance rises back above the threshold).
  final Map<String, AccountStatus> _alertStatusById = {};
  final Set<String> _lowCreditWarnedIds = {};

  AccountsProvider() {
    _initEngine();
  }

  /// Notification Center: the name the sidebar shows for an
  /// account — alias when assigned, else the engine name.
  String _displayName(GoogleAccount acc) =>
      acc.alias.isNotEmpty ? acc.alias : acc.name;

  /// Notification Center: evaluate the two account alerts for one
  /// account from its CURRENT state:
  ///  - Login problem: the account's status moved INTO error /
  ///    loginRequired from any other state (a check reported
  ///    Fail). The first sight of an account only seeds the
  ///    baseline — a fail state already present at startup or add
  ///    time is not a fresh event.
  ///  - Credits low: a READY account's credits fell below the
  ///    cheapest per-video cost (credit_costs table), so it cannot
  ///    afford even one more video. Fires once per account; the
  ///    warning re-arms only when the balance rises back above
  ///    the threshold.
  void _evaluateAccountAlerts(GoogleAccount acc) {
    final prev = _alertStatusById[acc.id];
    _alertStatusById[acc.id] = acc.status;
    final cheapest = creditCostPerVideo('Omni Flash', '4s', '360p');
    if (prev == null) {
      // First sight: seed the low-credit warned state so an
      // already-low balance does not "newly" warn on load.
      if (cheapest != null && acc.credits < cheapest) {
        _lowCreditWarnedIds.add(acc.id);
      }
      return;
    }
    final notif = NotificationsProvider.shared;
    final isFail = acc.status == AccountStatus.error ||
        acc.status == AccountStatus.loginRequired;
    final wasFail = prev == AccountStatus.error ||
        prev == AccountStatus.loginRequired;
    if (notif != null && isFail && !wasFail) {
      notif.add(
        type: NotificationType.login,
        title: 'Login problem — ${_displayName(acc)}',
        message: 'Account check failed — sign-in is needed.',
      );
    }
    if (cheapest != null) {
      if (acc.status == AccountStatus.ready && acc.credits < cheapest) {
        if (_lowCreditWarnedIds.add(acc.id) && notif != null) {
          notif.add(
            type: NotificationType.warning,
            title: 'Credits low — ${_displayName(acc)}',
            message:
                'Only ${acc.credits} credits left — not enough for another video.',
          );
        }
      } else if (acc.credits >= cheapest) {
        _lowCreditWarnedIds.remove(acc.id);
      }
    }
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

  /// Push the runtime pendingCheck flags from [_pendingCheckIds]
  /// onto the account objects. Returns true when anything changed.
  bool _applyPendingFlags() {
    var changed = false;
    for (final acc in _accounts) {
      final pending = _pendingCheckIds.contains(acc.id);
      if (acc.pendingCheck != pending) {
        acc.pendingCheck = pending;
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
    _applyPendingFlags();
    _ensureAliases(hints: hints);
    // Notification Center: a wholesale refresh (sync / import)
    // is where fresh credits and check results land — evaluate
    // the account alerts against the new state.
    for (final acc in _accounts) {
      _evaluateAccountAlerts(acc);
    }
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
      // Notification Center: seed the alert baselines from the
      // loaded state — nothing present at startup is a new event.
      for (final acc in _accounts) {
        _evaluateAccountAlerts(acc);
      }
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
      // v2.30.2: a phase-2 check streams a 'Checking…' object first
      // and then the FINAL account. Only once the check has been
      // seen running does a final (non-checking) state clear the
      // pending flag — the deferred add's own broadcast also
      // carries a non-checking state and must not clear it early.
      if (_pendingCheckIds.contains(acc.id)) {
        if (acc.status == AccountStatus.checking) {
          _checkSeenIds.add(acc.id);
        } else if (_checkSeenIds.remove(acc.id)) {
          _pendingCheckIds.remove(acc.id);
        }
      }
      _applyPendingFlags();
      // v2.29.0: same for the display alias.
      _ensureAliases();
      // Notification Center: per-account check results stream in
      // through this event — evaluate the login / credits alerts
      // against the account's new state (alias is set by now, so
      // the notification names the account as the sidebar does).
      _evaluateAccountAlerts(acc);
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

  // v2.45.0 (honest totals): true when at least one account's
  // balance is only an estimate — the header total then wears a
  // '~' so the sum never poses as fully live-verified.
  bool get anyEstimateCredits =>
      _accounts.any((a) => a.creditsSource == 'estimate');

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
    // v2.30.3: purge the runtime check sets too — a leaked id
    // would resurrect a phantom "Waiting" on any later account
    // that reuses it, with no check running and no exit.
    _pendingCheckIds.remove(id);
    _checkSeenIds.remove(id);
    // Notification Center: drop the alert bookkeeping too.
    _alertStatusById.remove(id);
    _lowCreditWarnedIds.remove(id);
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
      // Notification Center: a direct credit change is evaluated
      // for the low-credits warning like any other.
      _evaluateAccountAlerts(_accounts[index]);
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

    // v2.30.3: same pending-set purge as removeAccount.
    _pendingCheckIds.removeAll(selectedIds);
    _checkSeenIds.removeAll(selectedIds);
    // Notification Center: same alert-bookkeeping purge.
    _alertStatusById.removeWhere((id, _) => selectedIds.contains(id));
    _lowCreditWarnedIds.removeAll(selectedIds);
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

  /// v2.30.2 (bulk cookie add): with [deferVerify] the account is
  /// added WITHOUT its check — it joins the pending set (its line
  /// shows "Waiting") and its id is the caller's to pass to
  /// _runCookieChecks once every add is in. A deferred duplicate
  /// ('needsCheck') joins the pending set the same way: the existing
  /// account is re-checked in phase 2, never re-added.
  Future<Map<String, dynamic>> importCookiesFromFile(String filePath, {String? label, bool deferVerify = false}) async {
    final res = await AutomationBridge.instance.importAccountFromCookieFile(filePath, label: label, deferVerify: deferVerify);
    if (res['ok'] == true) {
      // v2.29.0: record the add route exactly — cookies.
      final accId = (res['account'] is Map) ? res['account']['id']?.toString() : null;
      if (accId != null && (deferVerify || res['needsCheck'] == true)) {
        _pendingCheckIds.add(accId);
      }
      final remote = await AutomationBridge.instance.getAccounts();
      _replaceAccounts(
        remote,
        hints: accId != null ? {accId: 'cookie'} : const {},
      );
    }
    return res;
  }

  /// v2.30.2: paste-text import runs the same two-phase path as a
  /// batch of one — add (deferred) first, then its check right
  /// after, so there is only ONE add→check code path in the app.
  Future<Map<String, dynamic>> importCookies(String label, String text) async {
    final res = await AutomationBridge.instance.importAccountFromCookieText(label, text, deferVerify: true);
    if (res['ok'] == true) {
      final accId = (res['account'] is Map) ? res['account']['id']?.toString() : null;
      if (accId != null) {
        _pendingCheckIds.add(accId);
      }
      final remote = await AutomationBridge.instance.getAccounts();
      _replaceAccounts(
        remote,
        hints: accId != null ? {accId: 'cookie'} : const {},
      );
      if (accId != null) {
        await _runCookieChecks([accId]);
      }
    }
    return res;
  }

  /// v2.30.2 (bulk cookie add — PHASE 2): run the deferred checks
  /// for exactly [ids]. The bridge drives each account's check in
  /// order and streams its states through account-updated, so every
  /// line flips Waiting → Checking… → Live/Fail as its own result
  /// lands. When the call ends, no id may stay "Waiting": anything
  /// the events did not already clear is cleared here and the list
  /// is re-read fresh.
  Future<void> _runCookieChecks(List<String> ids) async {
    if (ids.isEmpty) return;
    await AutomationBridge.instance.checkCookieAccounts(ids);
    _pendingCheckIds.removeAll(ids);
    _checkSeenIds.removeAll(ids);
    // v2.30.3: clear the visible flag HERE, not only through the
    // re-read below — _replaceAccounts returns early on an empty
    // engine response, which used to leave the surviving account
    // objects showing "Waiting" with the pending set already
    // emptied and no exit left.
    if (_applyPendingFlags()) notifyListeners();
    final remote = await AutomationBridge.instance.getAccounts();
    _replaceAccounts(remote);
  }

  /// v2.29.0: the sidebar's top "+ Add Cookies" button — opens the
  /// file picker and imports every picked cookie file through the
  /// engine (the behaviour the old sidebar-local helper had, now
  /// in the provider where the rest of the account actions live).
  /// Results are reported in the Activity log.
  ///
  /// v2.30.2 (owner's explicit order): TWO PHASES — every picked
  /// file is ADDED first (verification deferred, lines appear at
  /// once in a "Waiting" state), and only when all adds are in do
  /// the CHECKS run, one batch call for exactly the new (+duplicate)
  /// accounts. Adds and checks no longer interleave one-by-one.
  Future<void> pickAndImportCookieFiles() async {
    // v2.30.3: the phase bookkeeping lives OUTSIDE the try — an
    // exception partway through phase 1 used to skip phase 2
    // entirely, stranding every already-added account on "Waiting"
    // with no check ever running and no cleanup. Now whatever was
    // added always reaches phase 2 below.
    final toCheck = <String>[];
    var added = 0;
    var duplicates = 0;
    String? lastError;
    try {
      final picked = await FilePickerPlatform.instance.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['json', 'txt'],
      );
      if (picked.isEmpty) return;

      // PHASE 1 — add ALL first.
      for (final file in picked) {
        final path = file.path;
        if (path == null) continue;
        final res = await importCookiesFromFile(path, deferVerify: true);
        if (res['ok'] == true) {
          final accId = (res['account'] is Map) ? res['account']['id']?.toString() : null;
          if (res['duplicate'] == true) {
            duplicates++;
          } else {
            added++;
          }
          if (accId != null && accId.isNotEmpty && !toCheck.contains(accId)) {
            toCheck.add(accId);
          }
        } else {
          lastError = res['error']?.toString() ?? 'Unknown error';
        }
      }

    } catch (e) {
      AutomationBridge.instance.onLog?.call(
        'Cookie file error: $e',
        LogLevel.error,
        false,
      );
    }

    if (toCheck.isEmpty) {
      if (lastError != null) {
        AutomationBridge.instance.onLog?.call(
          'Cookie import failed: $lastError',
          LogLevel.error,
          false,
        );
      }
      return;
    }

    AutomationBridge.instance.onLog?.call(
      added == 0 && duplicates > 0
          ? 'Those cookies were already added — re-checking the existing account(s) now, no duplicate made.'
          : '$added account(s) added from cookies — checking ${toCheck.length} account(s) now…',
      LogLevel.success,
      false,
    );
    if (lastError != null) {
      AutomationBridge.instance.onLog?.call(
        'Some cookie files could not be added: $lastError',
        LogLevel.error,
        false,
      );
    }

    // PHASE 2 — check ALL (exactly the newly added + duplicates).
    // Runs even when phase 1 threw partway (v2.30.3, see above).
    await _runCookieChecks(toCheck);
  }
}

