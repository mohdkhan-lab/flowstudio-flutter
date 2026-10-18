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
      profilePath: profilePath ?? this.profilePath,
      reason: reason ?? this.reason,
      lastUsed: lastUsed ?? this.lastUsed,
    );
  }
}
