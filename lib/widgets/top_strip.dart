import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../providers/notifications_provider.dart';
import '../providers/settings_provider.dart';
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
    final notif = context.watch<NotificationsProvider>();

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
                        // v2.48.86: accentText, not accentAmber —
                        // accentText is the palette's text-tuned
                        // accent (readable on the light theme);
                        // accentAmber is a decorative gradient
                        // companion and washes out as small text
                        // on white.
                        color: AppTheme.accentText,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
                const SizedBox(width: 10),
                // Version Pill — Tactile 3D
                TactileChip(
                  color: AppTheme.accentText,
                  label: 'v2.48.86',
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

          // v2.48.86 (owner-approved Design B): the credits total
          // and the live PC-stats pill have LEFT the top strip — they
          // live in the new BottomStatusBar at the very bottom of
          // the window (credits left, three stats chips right,
          // About this PC on the chips). The strip keeps the
          // brand, the social icons and the bell.
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

