enum LogLevel {
  info,
  success,
  warning,
  error,
}

class ActivityLog {
  final DateTime timestamp;
  final String message;
  final LogLevel level;
  final String? account;
  final bool isDetail;

  ActivityLog({
    required this.message,
    this.level = LogLevel.info,
    this.account,
    this.isDetail = false,
    DateTime? timestamp,
  }) : timestamp = timestamp ?? DateTime.now();
}
