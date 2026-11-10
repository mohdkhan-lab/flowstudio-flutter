import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../providers/accounts_provider.dart';
import '../providers/notifications_provider.dart';
import '../providers/settings_provider.dart';
import '../providers/system_stats_provider.dart';
import 'tactile_components.dart';

class TopStrip extends StatelessWidget {
  const TopStrip({super.key});

  @override
  Widget build(BuildContext context) {
    // (Fix list 2026-10-27, item 8): watch SettingsProvider so a
    // theme or appearance change REBUILDS this strip. It used to
    // watch only Accounts/Notifications, so after a theme change
    // the strip kept painting the OLD palette (AppTheme tokens
    // are read at build time) until an account or notification
    // event happened to rebuild it — the owner's "the theme does
    // not change the whole interface". The value itself is unused.
    context.watch<SettingsProvider>();
    final accounts = context.watch<AccountsProvider>();
    final notif = context.watch<NotificationsProvider>();
    final pcStats = context.watch<SystemStatsProvider>();

    return TactileSectionContainer(
      margin: const EdgeInsets.fromLTRB(14, 12, 14, 0),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      child: Row(
        children: [
          // Left Brand Pill Box
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
            decoration: BoxDecoration(
              color: AppTheme.overlay08,
              borderRadius: BorderRadius.circular(11),
              border: Border.all(color: AppTheme.borderSoft),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Logo Comet Star / Official Logo
                Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    gradient: AppTheme.accentGrad,
                    borderRadius: BorderRadius.circular(8),
                    boxShadow: const [
                      BoxShadow(
                        color: Colors.black45,
                        blurRadius: 4,
                        offset: Offset(0, 2),
                      ),
                    ],
                  ),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: Image.asset(
                      'assets/icon.png',
                      width: 32,
                      height: 32,
                      fit: BoxFit.contain,
                      errorBuilder: (_, _, _) => Center(
                        child: Icon(
                          Icons.play_arrow_rounded,
                          size: 22,
                          color: AppTheme.onAccent,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 9),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    RichText(
                      text: TextSpan(
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.bold,
                          color: AppTheme.textMain,
                        ),
                        children: const [
                          TextSpan(text: 'FlowStudio'),
                        ],
                      ),
                    ),
                    Text(
                      'By MK',
                      style: TextStyle(
                        fontSize: 9.5,
                        color: AppTheme.accentAmber,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
                const SizedBox(width: 10),
                // Version Pill — Tactile 3D
                TactileChip(
                  color: AppTheme.accentText,
                  label: 'v2.48.83',
                  height: 22,
                  borderRadius: 11,
                  bevelDepth: 1.5,
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                ),
              ],
            ),
          ),

          // Responsive pass: everything right of the brand pill is
          // ONE scale-down cluster — at narrow widths it shrinks as a
          // unit instead of overflowing the strip (the old all-fixed
          // row overflowed by a few px at 1024 and more below it).
          const SizedBox(width: 10),
          Expanded(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerRight,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Social Icons (Chat, Support)
          Consumer<SettingsProvider>(
            builder: (context, settingsProv, _) {
              final s = settingsProv.settings;
              final icons = <Widget>[];
              if (isUsableSocialLink(s.chatLink)) {
                icons.add(_buildCircleIcon(
                  icon: Icons.message_outlined,
                  color: AppTheme.textDim,
                  tooltip: 'Chat',
                  onTap: () => context.read<SettingsProvider>().openSocial('chat'),
                ));
              }
              if (isUsableSocialLink(s.supportLink)) {
                if (icons.isNotEmpty) icons.add(const SizedBox(width: 6));
                icons.add(_buildCircleIcon(
                  icon: Icons.headphones_outlined,
                  color: AppTheme.textDim,
                  tooltip: 'Support',
                  onTap: () => context.read<SettingsProvider>().openSocial('support'),
                ));
              }
              return Row(mainAxisSize: MainAxisSize.min, children: icons);
            },
          ),

          const SizedBox(width: 14),
          // Vertical Separator
          Container(
            width: 1,
            height: 24,
            color: AppTheme.borderSoft,
          ),
          const SizedBox(width: 14),

          // Total Credits & Sync
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'TOTAL CREDITS',
                style: TextStyle(
                  fontSize: 8.5,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.8,
                  color: AppTheme.textFaint,
                ),
              ),
            ],
          ),
          const SizedBox(width: 8),
          Text(
            // v2.46.3 (owner ka order): kul yog par bhi koi '~'
            // nahi — sirf asal number dikhega (v2.45.0 ka estimate
            // nishan owner ne hatane ko kaha).
            '${accounts.totalCredits}',
            style: TextStyle(
              fontSize: 26,
              fontWeight: FontWeight.w900,
              color: AppTheme.accentGold,
              height: 1,
            ),
          ),
          // v2.30.0 (owner): the Sync button that sat next to TOTAL
          // CREDITS is REMOVED — the top shows only the label and the
          // number. Syncing lives in the sidebar (Sync Selected /
          // Verify All), where it always also worked.
          _buildPcStatsSegment(context, pcStats, accounts),
          const SizedBox(width: 14),
          // Notification Center: the bell — red badge with the
          // unread count; tapping toggles the panel overlay
          // (NotificationOverlay in main.dart).
          _buildBellButton(notif),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  // v2.48.83 (live PC-stats pill — owner order 2026-11-10): the
  // engine's REAL, live PC stats in the owner's exact format —
  // 'CPU 56% · RAM 89% · Active 1/1'. CPU/RAM come from the
  // engine's ~2s system-stats samples of this very PC; Active is
  // the accounts with a live generation browser right now, of all
  // accounts. Until the first real sample lands the segment is
  // simply absent — no placeholder numbers, ever. The whole
  // segment rides inside the strip's scale-down cluster, so the
  // FIT LAW holds (nothing overflows; the cluster shrinks as a
  // unit). Tapping the pill opens About this PC.
  Widget _buildPcStatsSegment(
    BuildContext context,
    SystemStatsProvider pcStats,
    AccountsProvider accounts,
  ) {
    final cpu = pcStats.cpuPercent;
    final ram = pcStats.ramPercent;
    if (cpu == null || ram == null) return const SizedBox.shrink();
    final active = accounts.accounts.where((a) => a.isActive).length;
    final total = accounts.accounts.length;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(width: 14),
        Container(width: 1, height: 24, color: AppTheme.borderSoft),
        const SizedBox(width: 14),
        Tooltip(
          message: 'About this PC',
          child: InkWell(
            borderRadius: BorderRadius.circular(11),
            onTap: () => _showAboutPc(context, pcStats.stats),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: AppTheme.overlay08,
                borderRadius: BorderRadius.circular(11),
                border: Border.all(color: AppTheme.borderSoft),
              ),
              child: Text(
                'CPU $cpu% · RAM $ram% · Active $active/$total',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.textMain,
                  height: 1,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  // About this PC — every value is the engine's real sample for
  // this machine; a field the platform could not supply is left
  // out rather than filled in.
  void _showAboutPc(BuildContext context, Map<String, dynamic>? stats) {
    if (stats == null) return;
    String gb(dynamic bytes) {
      if (bytes is num) return (bytes / 1073741824).toStringAsFixed(1);
      return '';
    }

    final rows = <MapEntry<String, String>>[];
    final hostname = stats['hostname']?.toString() ?? '';
    if (hostname.isNotEmpty) rows.add(MapEntry('PC name', hostname));
    final os = stats['os']?.toString() ?? '';
    if (os.isNotEmpty) rows.add(MapEntry('OS', os));
    final cpuModel = stats['cpuModel']?.toString() ?? '';
    if (cpuModel.isNotEmpty) {
      final cores = stats['cpuCores'];
      rows.add(MapEntry(
        'CPU',
        cores is num ? '$cpuModel · ${cores.round()} cores' : cpuModel,
      ));
    }
    if (stats['ramTotalBytes'] is num) {
      rows.add(MapEntry('RAM', '${gb(stats['ramTotalBytes'])} GB total'));
    }
    if (stats['diskFreeBytes'] is num && stats['diskTotalBytes'] is num) {
      final path = stats['diskPath']?.toString() ?? '';
      rows.add(MapEntry(
        'Disk free',
        '${gb(stats['diskFreeBytes'])} GB free of ${gb(stats['diskTotalBytes'])} GB'
        '${path.isNotEmpty ? ' — $path' : ''}',
      ));
    }
    if (rows.isEmpty) return;
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('About this PC'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final row in rows)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 76,
                      child: Text(
                        row.key,
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          color: AppTheme.textDim,
                        ),
                      ),
                    ),
                    Expanded(
                      child: Text(
                        row.value,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: AppTheme.textMain,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  // Notification Center: bell button with the unread badge,
  // tactile 3D 28px circular button.
  Widget _buildBellButton(NotificationsProvider notif) {
    final unread = notif.unreadCount;
    return Tooltip(
      message: 'Notifications',
      child: TactileButton(
        type: TactileType.icon,
        shape: BoxShape.circle,
        width: 28,
        height: 28,
        bevelDepth: 1.8,
        padding: EdgeInsets.zero,
        onTap: notif.togglePanel,
        child: Stack(
          clipBehavior: Clip.none,
          alignment: Alignment.center,
          children: [
            Icon(Icons.notifications_none_rounded,
                size: 15, color: AppTheme.textDim),
            if (unread > 0)
              Positioned(
                top: -4,
                right: -4,
                child: Container(
                  constraints: const BoxConstraints(minWidth: 15),
                  height: 15,
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  decoration: BoxDecoration(
                    color: AppTheme.red,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Center(
                    child: Text(
                      unread > 99 ? '99+' : '$unread',
                      style: const TextStyle(
                        fontSize: 8.5,
                        fontWeight: FontWeight.w800,
                        color: Colors.white,
                        height: 1,
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildCircleIcon({
    required IconData icon,
    required Color color,
    required String tooltip,
    VoidCallback? onTap,
  }) {
    return Tooltip(
      message: tooltip,
      child: TactileButton(
        type: TactileType.icon,
        shape: BoxShape.circle,
        width: 28,
        height: 28,
        bevelDepth: 1.8,
        padding: EdgeInsets.zero,
        onTap: onTap,
        child: Icon(icon, size: 14, color: color),
      ),
    );
  }

}

