enum AccountStatus {
  ready,
  running,
  checking,
  outOfCredits,
  loginRequired,
  disabled,
  error,
}


class GoogleAccount {
  final String id;
  final String name;
  final String email;
  // v2.29.0 (source numbering): display alias by ADD ROUTE —
  // "Cookie 1", "Cookie 2"… for cookie imports, "Account 1",
  // "Account 2"… for the account route (profile import / direct
  // Gmail login). Assigned and persisted by AccountsProvider, keyed
  // by engine account id; the engine's own name/email are NOT
  // renamed (fingerprint matching depends on them). Empty until the
  // provider has assigned one.
  String alias = '';
  // Engine source hints (from the account JSON): a cookie-imported
  // account has saved cookies and no Chrome profile dir; a
  // profile-imported one carries chromeProfileDir. Used only to
  // infer the source of accounts that predate the alias store.
  final bool hasCookies;
  final String chromeProfileDir;
  int credits;
  // v2.45.0 (honest totals): where the number came from — 'live'
  // when the engine actually read it on Flow's page, 'estimate'
  // when it is only a post-submission guess (last known minus the
  // charge). The UI marks estimates with '~' so a guess never
  // poses as a live fact.
  String creditsSource;
  AccountStatus status;
  bool isChecked;
  // v2.25.0 (parked browser): RUNTIME state only — never persisted.
  // isActive: this account has a live generation browser right now.
  // browserShown: that browser's window is on screen (not parked).
  // Both are driven by the engine's 'active-browsers' events.
  bool isActive;
  bool browserShown;
  // v2.30.2 (bulk cookie add): RUNTIME only — this account was
  // added with its verification deferred and is queued for the
  // batch's phase-2 check. The row shows a faint "Waiting" until
  // the check lands. Driven by AccountsProvider's pending set.
  bool pendingCheck;
  final String? profilePath;
  final String? reason;
  DateTime lastUsed;

  GoogleAccount({
    required this.id,
    required this.name,
    required this.email,
    this.hasCookies = false,
    this.chromeProfileDir = '',
    this.credits = 30,
    this.creditsSource = 'live',
    this.status = AccountStatus.ready,
    this.isChecked = true,
    this.isActive = false,
    this.browserShown = false,
    this.pendingCheck = false,
    this.profilePath,
    this.reason,
    DateTime? lastUsed,
  }) : lastUsed = lastUsed ?? DateTime.now();

  GoogleAccount copyWith({
    String? id,
    String? name,
    String? email,
    int? credits,
    String? creditsSource,
    AccountStatus? status,
    bool? isChecked,
    bool? isActive,
    bool? browserShown,
    bool? pendingCheck,
    String? profilePath,
    String? reason,
    DateTime? lastUsed,
  }) {
    return GoogleAccount(
      id: id ?? this.id,
      name: name ?? this.name,
      email: email ?? this.email,
      hasCookies: hasCookies,
      chromeProfileDir: chromeProfileDir,
      credits: credits ?? this.credits,
      creditsSource: creditsSource ?? this.creditsSource,
      status: status ?? this.status,
      isChecked: isChecked ?? this.isChecked,
      isActive: isActive ?? this.isActive,
      browserShown: browserShown ?? this.browserShown,
      pendingCheck: pendingCheck ?? this.pendingCheck,
      profilePath: profilePath ?? this.profilePath,
      reason: reason ?? this.reason,
      lastUsed: lastUsed ?? this.lastUsed,
    );
  }
}
