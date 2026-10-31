import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../providers/accounts_provider.dart';
import '../providers/notifications_provider.dart';
import '../providers/settings_provider.dart';

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

    return Container(
      margin: const EdgeInsets.fromLTRB(14, 12, 14, 0),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: AppTheme.borderSoft),
        boxShadow: const [
          BoxShadow(
            color: Colors.black26,
            blurRadius: 10,
            offset: Offset(0, 4),
          ),
        ],
      ),
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
                        children: [
                          TextSpan(text: 'FlowStudio '),
                          TextSpan(
                            text: 'Lite',
                            style: TextStyle(
                              color: AppTheme.accentText,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Text(
                      'Multi-Account Flow Studio',
                      style: TextStyle(
                        fontSize: 9.5,
                        color: AppTheme.accentAmber,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
                const SizedBox(width: 10),
                // Version Pill
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: AppTheme.accentGold.withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppTheme.accentGold.withValues(alpha: 0.5)),
                  ),
                  child: Text(
                    'v2.47.6',
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.accentText,
                    ),
                  ),
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
                  // Created by MK
                  RichText(
            text: TextSpan(
              style: TextStyle(fontSize: 13, color: AppTheme.textDim),
              children: [
                TextSpan(text: 'Created by '),
                TextSpan(
                  text: 'MK',
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    color: AppTheme.textMain,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 14),

          // Social Icons (WhatsApp, Chat, Support) — v2.34.0
          // (Problem 12): an icon renders ONLY when its saved link
          // is usable; an unconfigured or placeholder link shows
          // nothing instead of opening a dead page.
          Consumer<SettingsProvider>(
            builder: (context, settingsProv, _) {
              final s = settingsProv.settings;
              final icons = <Widget>[];
              if (isUsableSocialLink(s.whatsAppLink)) {
                icons.add(_buildCircleIcon(
                  icon: Icons.chat_bubble,
                  color: AppTheme.whatsApp,
                  tooltip: 'WhatsApp',
                  onTap: () => context.read<SettingsProvider>().openSocial('whatsapp'),
                ));
              }
              if (isUsableSocialLink(s.chatLink)) {
                if (icons.isNotEmpty) icons.add(const SizedBox(width: 6));
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

  // Notification Center: bell button with the unread badge,
  // same 28px circle language as the social icons.
  Widget _buildBellButton(NotificationsProvider notif) {
    final unread = notif.unreadCount;
    return Tooltip(
      message: 'Notifications',
      child: InkWell(
        onTap: notif.togglePanel,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          width: 28,
          height: 28,
          decoration: BoxDecoration(
            color: AppTheme.overlay10,
            shape: BoxShape.circle,
            border: Border.all(color: AppTheme.borderSoft),
          ),
          child: Stack(
            clipBehavior: Clip.none,
            alignment: Alignment.center,
            children: [
              Icon(Icons.notifications_none_rounded,
                  size: 15, color: AppTheme.textDim),
              if (unread > 0)
                Positioned(
                  top: -6,
                  right: -6,
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
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          width: 28,
          height: 28,
          decoration: BoxDecoration(
            color: AppTheme.overlay10,
            shape: BoxShape.circle,
            border: Border.all(color: AppTheme.borderSoft),
          ),
          child: Icon(icon, size: 14, color: color),
        ),
      ),
    );
  }
}

