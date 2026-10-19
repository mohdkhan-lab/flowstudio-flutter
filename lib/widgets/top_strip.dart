import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../providers/accounts_provider.dart';
import '../providers/settings_provider.dart';

class TopStrip extends StatelessWidget {
  const TopStrip({super.key});

  @override
  Widget build(BuildContext context) {
    final accounts = context.watch<AccountsProvider>();

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
              color: const Color(0x08FFFFFF),
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
                      errorBuilder: (_, __, ___) => const Center(
                        child: Icon(
                          Icons.play_arrow_rounded,
                          size: 22,
                          color: Color(0xFF1A1405),
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
                      text: const TextSpan(
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
                    const Text(
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
                    color: const Color(0x1AEAB308),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppTheme.accentGold.withValues(alpha: 0.5)),
                  ),
                  child: const Text(
                    'v2.23.0',
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

          const Spacer(),

          // Created by MK
          RichText(
            text: const TextSpan(
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

          // Social Icons (WhatsApp, Chat, Support)
          _buildCircleIcon(
            icon: Icons.chat_bubble,
            color: AppTheme.whatsApp,
            tooltip: 'WhatsApp',
            onTap: () => context.read<SettingsProvider>().openSocial('whatsapp'),
          ),
          const SizedBox(width: 6),
          _buildCircleIcon(
            icon: Icons.message_outlined,
            color: AppTheme.textDim,
            tooltip: 'Chat',
            onTap: () => context.read<SettingsProvider>().openSocial('chat'),
          ),
          const SizedBox(width: 6),
          _buildCircleIcon(
            icon: Icons.headphones_outlined,
            color: AppTheme.textDim,
            tooltip: 'Support',
            onTap: () => context.read<SettingsProvider>().openSocial('support'),
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
            children: const [
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
            '${accounts.totalCredits}',
            style: const TextStyle(
              fontSize: 26,
              fontWeight: FontWeight.w900,
              color: AppTheme.accentGold,
              height: 1,
            ),
          ),
          const SizedBox(width: 12),
          // Sync Button
          OutlinedButton.icon(
            onPressed: () => context.read<AccountsProvider>().syncAll(),
            style: OutlinedButton.styleFrom(
              foregroundColor: AppTheme.accentText,
              side: const BorderSide(color: Color(0x8CEAB308)),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              visualDensity: VisualDensity.compact,
            ),
            icon: const Icon(Icons.sync, size: 14, color: AppTheme.accentText),
            label: const Text(
              'Sync',
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold),
            ),
          ),
        ],
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
            color: const Color(0x10FFFFFF),
            shape: BoxShape.circle,
            border: Border.all(color: AppTheme.borderSoft),
          ),
          child: Icon(icon, size: 14, color: color),
        ),
      ),
    );
  }
}

