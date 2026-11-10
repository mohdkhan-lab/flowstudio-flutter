import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../providers/accounts_provider.dart';
import '../providers/settings_provider.dart';
import '../providers/system_stats_provider.dart';

/// v2.48.86 (owner-approved Design B, 2026-11-10): the bottom
/// status bar. TOTAL CREDITS and the live PC stats used to sit
/// in the top strip; the owner ordered them to the very BOTTOM
/// of the window, in this exact arrangement —
///   LEFT:  gold star motif + the total-credits number (large,
///          bold, gold) + the word "Credits" (muted).
///   RIGHT: THREE separate chips — [CPU n%] [RAM n%]
///          [Active a/b] — bold text, hairline borders; the
///          chips carry the 'About this PC' tap/hover, exactly
///          as the old single pill did.
/// Everything is painted from AppTheme tokens, so the bar
/// follows the active palette: the owner's LIGHT theme shows a
/// white bar with a slate hairline and a thin gold accent line
/// on top, light slate chips with dark text; dark palettes show
/// the sampled dark look. The bar is a fixed layout row (the
/// centre's flexible area absorbs its height), so the FIT LAW
/// holds at 1024×768 — nothing new scrolls.
class BottomStatusBar extends StatelessWidget {
  const BottomStatusBar({super.key});

  @override
  Widget build(BuildContext context) {
    // Watch SettingsProvider so a theme/appearance change
    // rebuilds the bar (same reason as the TopStrip's watch:
    // AppTheme tokens are read at build time).
    context.watch<SettingsProvider>();
    final accounts = context.watch<AccountsProvider>();
    final pcStats = context.watch<SystemStatsProvider>();

    return Container(
      margin: const EdgeInsets.fromLTRB(14, 0, 14, 12),
      decoration: BoxDecoration(
        gradient: AppTheme.panelGrad,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: AppTheme.borderSoft),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(13),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // The thin gold accent line along the bar's top edge.
            Container(
              height: 2,
              color: AppTheme.accentGold.withValues(alpha: 0.55),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
              child: Row(
                children: [
                  // LEFT — Design B: star + number + "Credits".
                  Icon(
                    Icons.auto_awesome,
                    size: 17,
                    color: AppTheme.accentGold,
                  ),
                  const SizedBox(width: 7),
                  Text(
                    '${accounts.totalCredits}',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w900,
                      color: AppTheme.accentGold,
                      height: 1,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    'Credits',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: AppTheme.textDim,
                    ),
                  ),
                  const Spacer(),
                  // RIGHT — the three live-stats chips.
                  _buildStatsChips(context, pcStats, accounts),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // The three chips ride on the engine's REAL ~2s samples; until
  // the first sample lands they are simply absent — no
  // placeholder numbers, ever (the rule the old pill kept).
  // Tapping (or hovering, via the tooltip) opens About this PC.
  Widget _buildStatsChips(
    BuildContext context,
    SystemStatsProvider pcStats,
    AccountsProvider accounts,
  ) {
    final cpu = pcStats.cpuPercent;
    final ram = pcStats.ramPercent;
    if (cpu == null || ram == null) return const SizedBox.shrink();
    final active = accounts.accounts.where((a) => a.isActive).length;
    final total = accounts.accounts.length;
    return Tooltip(
      message: 'About this PC',
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => _showAboutPc(context, pcStats.stats),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _chip('CPU $cpu%'),
            const SizedBox(width: 6),
            _chip('RAM $ram%'),
            const SizedBox(width: 6),
            _chip('Active $active/$total'),
          ],
        ),
      ),
    );
  }

  Widget _chip(String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: AppTheme.dark ? AppTheme.overlay08 : AppTheme.overlay10,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(
          color: AppTheme.dark ? AppTheme.borderSoft : AppTheme.border,
        ),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          color: AppTheme.textMain,
          height: 1,
        ),
      ),
    );
  }

  // About this PC — every value is the engine's real sample for
  // this machine; a field the platform could not supply is left
  // out rather than filled in. (Moved from the top strip with
  // the stats in v2.48.86; the dialog itself is unchanged.)
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
}
