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
