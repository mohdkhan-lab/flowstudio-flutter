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
  AccountStatus status;
  bool isChecked;
  // v2.25.0 (parked browser): RUNTIME state only — never persisted.
  // isActive: this account has a live generation browser right now.
  // browserShown: that browser's window is on screen (not parked).
  // Both are driven by the engine's 'active-browsers' events.
  bool isActive;
  bool browserShown;
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
    this.status = AccountStatus.ready,
    this.isChecked = true,
    this.isActive = false,
    this.browserShown = false,
    this.profilePath,
    this.reason,
    DateTime? lastUsed,
  }) : lastUsed = lastUsed ?? DateTime.now();

  GoogleAccount copyWith({
    String? id,
    String? name,
    String? email,
    int? credits,
    AccountStatus? status,
    bool? isChecked,
    bool? isActive,
    bool? browserShown,
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
      status: status ?? this.status,
      isChecked: isChecked ?? this.isChecked,
      isActive: isActive ?? this.isActive,
      browserShown: browserShown ?? this.browserShown,
      profilePath: profilePath ?? this.profilePath,
      reason: reason ?? this.reason,
      lastUsed: lastUsed ?? this.lastUsed,
    );
  }
}
