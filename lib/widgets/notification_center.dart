import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../models/app_notification.dart';
import '../providers/notifications_provider.dart';
import '../providers/settings_provider.dart';
import '../theme/app_theme.dart';

// Notification Center: the bell's overlay layer — a small popup
// card that appears near the bell for ~2 seconds when a new
// notification arrives (panel closed), and the panel itself,
// anchored top-right under the TopStrip. The panel is capped at
// ~430 x ~520 and only its list scrolls, so the rest of the main
// screen never changes size (1024x768 fit law).
class NotificationOverlay extends StatefulWidget {
  const NotificationOverlay({super.key});

  @override
  State<NotificationOverlay> createState() => _NotificationOverlayState();
}

class _NotificationOverlayState extends State<NotificationOverlay> {
  // 'all' | 'errors' | 'warnings' | 'success'
  String _filter = 'all';

  bool _matches(AppNotification n) {
    switch (_filter) {
      case 'errors':
        return n.type == NotificationType.error ||
            n.type == NotificationType.login;
      case 'warnings':
        return n.type == NotificationType.warning;
      case 'success':
        return n.type == NotificationType.success ||
            n.type == NotificationType.download;
      default:
        return true;
    }
  }

  IconData _typeIcon(NotificationType t) {
    switch (t) {
      case NotificationType.success:
        return Icons.check;
      case NotificationType.error:
        return Icons.close;
      case NotificationType.warning:
        return Icons.priority_high;
      case NotificationType.login:
        return Icons.warning_amber_rounded;
      case NotificationType.download:
        return Icons.arrow_downward;
    }
  }

  Color _typeColor(NotificationType t) {
    switch (t) {
      case NotificationType.success:
        return AppTheme.green;
      case NotificationType.error:
        return AppTheme.red;
      case NotificationType.warning:
        return AppTheme.activeGold;
      case NotificationType.login:
        // AppTheme has no purple token; a muted violet that reads
        // on both palettes (same family as History's file tiles).
        return const Color(0xFF9B7EDE);
      case NotificationType.download:
        return AppTheme.blue;
    }
  }

  Color _typeBg(NotificationType t) {
    switch (t) {
      case NotificationType.success:
        return AppTheme.greenBg;
      case NotificationType.error:
        return AppTheme.redBg;
      case NotificationType.warning:
        return AppTheme.activeGold.withValues(alpha: 0.16);
      case NotificationType.login:
        return const Color(0xFF9B7EDE).withValues(alpha: 0.16);
      case NotificationType.download:
        return AppTheme.blue.withValues(alpha: 0.15);
    }
  }

  bool _isToday(DateTime t) {
    final now = DateTime.now();
    return t.year == now.year && t.month == now.month && t.day == now.day;
  }

  bool _isYesterday(DateTime t) {
    final y = DateTime.now().subtract(const Duration(days: 1));
    return t.year == y.year && t.month == y.month && t.day == y.day;
  }

  String _timeLabel(DateTime t) {
    final diff = DateTime.now().difference(t);
    if (diff.inMinutes < 1) return 'Just now';
    if (_isToday(t)) {
      if (diff.inMinutes < 60) return '${diff.inMinutes} min';
      return '${diff.inHours} hr';
    }
    if (_isYesterday(t)) return 'Yesterday';
    return DateFormat('MMM d').format(t);
  }

  @override
  Widget build(BuildContext context) {
    // (Fix list 2026-10-27, item 8): same rebuild gap as the top
    // strip — this overlay is persistent and watched only its own
    // provider, so a theme change left its panel and popup on the
    // old palette. Watching SettingsProvider rebuilds it with the
    // rest of the app; the value itself is unused.
    context.watch<SettingsProvider>();
    final notif = context.watch<NotificationsProvider>();
    final popup = notif.popup;
    return Stack(
      children: [
        if (notif.panelOpen)
          Positioned.fill(
            child: GestureDetector(
              onTap: notif.closePanel,
              child: Container(color: Colors.transparent),
            ),
          ),
        if (popup != null && !notif.panelOpen)
          Positioned(top: 78, right: 14, child: _popupCard(popup)),
        if (notif.panelOpen)
          Positioned(top: 78, right: 14, child: _panel(notif)),
      ],
    );
  }

  Widget _popupCard(AppNotification n) {
    return IgnorePointer(
      child: Container(
        width: 330,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
        decoration: BoxDecoration(
          color: AppTheme.surfaceElevated,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppTheme.border),
          boxShadow: const [
            BoxShadow(
              color: Colors.black45,
              blurRadius: 16,
              offset: Offset(0, 6),
            ),
          ],
        ),
        child: Row(
          children: [
            _iconCircle(n.type, 30, 15),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    n.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: AppTheme.textMain,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    n.message,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style:
                        TextStyle(fontSize: 11, color: AppTheme.textDim),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _iconCircle(NotificationType t, double size, double iconSize) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: _typeBg(t),
        shape: BoxShape.circle,
      ),
      child: Icon(_typeIcon(t), size: iconSize, color: _typeColor(t)),
    );
  }

  Widget _panel(NotificationsProvider notif) {
    final filtered = notif.items.where(_matches).toList();
    final today = filtered.where((n) => _isToday(n.time)).toList();
    final earlier = filtered.where((n) => !_isToday(n.time)).toList();
    final unread = notif.unreadCount;

    final entries = <Widget>[];
    if (today.isNotEmpty) {
      entries.add(_groupHeader('TODAY'));
      entries.addAll(today.map((n) => _row(notif, n)));
    }
    if (earlier.isNotEmpty) {
      entries.add(_groupHeader('EARLIER'));
      entries.addAll(earlier.map((n) => _row(notif, n)));
    }

    return Container(
      width: 430,
      decoration: BoxDecoration(
        color: AppTheme.surfaceElevated,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppTheme.border),
        boxShadow: const [
          BoxShadow(
            color: Colors.black54,
            blurRadius: 24,
            offset: Offset(0, 10),
          ),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 520),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Header: title + "N new" pill + actions.
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 12, 10),
                child: Row(
                  children: [
                    Icon(Icons.notifications_none_rounded,
                        size: 18, color: AppTheme.textDim),
                    const SizedBox(width: 7),
                    Text(
                      'Notifications',
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w800,
                        color: AppTheme.textMain,
                      ),
                    ),
                    if (unread > 0) ...[
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(
                          color: AppTheme.red,
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          '$unread new',
                          style: const TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            color: Colors.white,
                          ),
                        ),
                      ),
                    ],
                    const Spacer(),
                    TextButton(
                      onPressed: unread > 0 ? notif.markAllRead : null,
                      style: TextButton.styleFrom(
                        foregroundColor: AppTheme.accentText,
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                        minimumSize: const Size(0, 30),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        textStyle: const TextStyle(
                            fontSize: 11.5, fontWeight: FontWeight.w600),
                      ),
                      child: const Text('Mark all read'),
                    ),
                    const SizedBox(width: 4),
                    ElevatedButton(
                      onPressed:
                          notif.items.isNotEmpty ? notif.clearAll : null,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppTheme.accentGold,
                        foregroundColor: AppTheme.onAccent,
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 6),
                        minimumSize: const Size(0, 30),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        elevation: 0,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                        textStyle: const TextStyle(
                            fontSize: 11.5, fontWeight: FontWeight.w700),
                      ),
                      child: const Text('Clear All'),
                    ),
                  ],
                ),
              ),
              // Filter chips.
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                child: Row(
                  children: [
                    _chip('all', 'All'),
                    const SizedBox(width: 6),
                    _chip('errors', 'Errors'),
                    const SizedBox(width: 6),
                    _chip('warnings', 'Warnings'),
                    const SizedBox(width: 6),
                    _chip('success', 'Success'),
                  ],
                ),
              ),
              Divider(height: 1, color: AppTheme.borderSoft),
              if (filtered.isEmpty)
                _emptyState()
              else
                Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    padding: const EdgeInsets.only(bottom: 8),
                    children: entries,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _chip(String value, String label) {
    final selected = _filter == value;
    return InkWell(
      onTap: () => setState(() => _filter = value),
      borderRadius: BorderRadius.circular(999),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
        decoration: BoxDecoration(
          color: selected ? AppTheme.textMain : Colors.transparent,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
              color: selected ? AppTheme.textMain : AppTheme.borderSoft),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            color: selected ? AppTheme.surface : AppTheme.textDim,
          ),
        ),
      ),
    );
  }

  Widget _groupHeader(String label) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 2),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w700,
          letterSpacing: 1.1,
          color: AppTheme.textFaint,
        ),
      ),
    );
  }

  Widget _emptyState() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 30),
      child: Column(
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              color: AppTheme.greenBg,
              shape: BoxShape.circle,
            ),
            child: Icon(Icons.check, size: 26, color: AppTheme.green),
          ),
          const SizedBox(height: 10),
          Text(
            "You're all caught up",
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: AppTheme.textMain,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            'No new notifications',
            style: TextStyle(fontSize: 11.5, color: AppTheme.textFaint),
          ),
        ],
      ),
    );
  }

  Widget _row(NotificationsProvider notif, AppNotification n) {
    final fileName = n.fileName;
    final hasFile = fileName != null && fileName.isNotEmpty;
    return InkWell(
      onTap: () => notif.markRead(n.id),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _iconCircle(n.type, 34, 17),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Text(
                          n.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: n.read
                                ? AppTheme.textDim
                                : AppTheme.textMain,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        _timeLabel(n.time),
                        style: TextStyle(
                            fontSize: 10.5, color: AppTheme.textFaint),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    n.message,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11.5,
                      color:
                          n.read ? AppTheme.textFaint : AppTheme.textDim,
                    ),
                  ),
                  if (hasFile) ...[
                    const SizedBox(height: 7),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: OutlinedButton(
                        onPressed: () => _viewVideo(notif, n),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: AppTheme.accentText,
                          side: BorderSide(color: AppTheme.border),
                          padding: const EdgeInsets.symmetric(
                              horizontal: 10, vertical: 4),
                          minimumSize: const Size(0, 26),
                          tapTargetSize:
                              MaterialTapTargetSize.shrinkWrap,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(7),
                          ),
                          textStyle: const TextStyle(
                              fontSize: 11, fontWeight: FontWeight.w600),
                        ),
                        child: const Text('View video →'),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (!n.read) ...[
              const SizedBox(width: 8),
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: AppTheme.blue,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  // "View video": mark the row read, close the panel and hand the
  // file name to History via SettingsProvider — History opens the
  // file's player once its list has loaded (a file that is not in
  // the output folder simply lands the user on History).
  void _viewVideo(NotificationsProvider notif, AppNotification n) {
    final fileName = n.fileName;
    if (fileName == null || fileName.isEmpty) return;
    notif.markRead(n.id);
    notif.closePanel();
    context.read<SettingsProvider>().openHistoryFile(fileName);
  }
}
