// Notification Center: one stored notification — the unit the
// top-strip bell badge, the transient popup card and the panel
// list all read. Persisted as JSON inside the engine settings
// store (see NotificationsProvider) so the list survives restarts.

enum NotificationType { success, error, warning, login, download }

class AppNotification {
  final String id;
  final NotificationType type;
  final String title;
  final String message;
  final DateTime time;
  bool read;

  // The output file this notification is about, when it is about
  // one specific video — drives the panel row's "View video"
  // action (switches to History and opens that file's player).
  final String? fileName;

  AppNotification({
    required this.id,
    required this.type,
    required this.title,
    required this.message,
    required this.time,
    this.read = false,
    this.fileName,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'type': type.name,
        'title': title,
        'message': message,
        'time': time.millisecondsSinceEpoch,
        'read': read,
        if (fileName != null) 'fileName': fileName,
      };

  static AppNotification? fromJson(Map<String, dynamic> j) {
    try {
      final ms = (j['time'] as num?)?.toInt() ?? 0;
      return AppNotification(
        id: j['id']?.toString() ?? '',
        type: NotificationType.values.firstWhere(
          (t) => t.name == j['type']?.toString(),
          orElse: () => NotificationType.success,
        ),
        title: j['title']?.toString() ?? '',
        message: j['message']?.toString() ?? '',
        time: DateTime.fromMillisecondsSinceEpoch(ms),
        read: j['read'] == true,
        fileName: j['fileName']?.toString(),
      );
    } catch (_) {
      return null;
    }
  }
}
