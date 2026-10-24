import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import '../theme/app_theme.dart';
import '../models/activity_log.dart';
import '../providers/activity_provider.dart';
import '../providers/generator_provider.dart';
import '../providers/settings_provider.dart';

class ActivityStream extends StatefulWidget {
  const ActivityStream({super.key});

  @override
  State<ActivityStream> createState() => _ActivityStreamState();
}

class _ActivityStreamState extends State<ActivityStream> {
  final ScrollController _scrollController = ScrollController();

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final activity = context.watch<ActivityProvider>();
    final generator = context.watch<GeneratorProvider>();
    final settingsProv = context.watch<SettingsProvider>();
    final logs = activity.visibleLogs;
    _scrollToBottom();

    // v2.27.0 (design): log lines start with the time, "13:02".
    final timeFormatter = DateFormat('HH:mm');

    // v2.27.0 (design) stats: All-time / Today / Spent today. The
    // engine's usage stats are the real record (one count per saved
    // video); this session's real completions are the fallback while
    // the engine stats are still empty.
    final allTime = settingsProv.totalVideosSaved > 0
        ? settingsProv.totalVideosSaved
        : generator.completedCount;
    final today = settingsProv.videosToday > 0
        ? settingsProv.videosToday
        : generator.completedTodayCount;
    final spentToday = today * 7;

    return Container(
      height: 150,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: AppTheme.borderSoft),
        boxShadow: const [
          BoxShadow(color: Colors.black26, blurRadius: 10, offset: Offset(0, 4)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header Row: Activity | Generation started... | Ready | Previous videos
          Row(
            children: [
              Text(
                'Activity',
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textMain,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  generator.isRunning
                      ? 'Generation started: ${generator.totalPrompts} prompt(s) • 1 worker(s) in parallel'
                      : 'Ready for generation',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    color: AppTheme.textDim,
                  ),
                ),
              ),
              const SizedBox(width: 8),

              // Ready Pill
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: AppTheme.greenBg,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  'Ready',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                    color: AppTheme.green,
                  ),
                ),
              ),
              const SizedBox(width: 8),

              // Previous videos button — v2.27.0: opens the History
              // view (it was an empty onPressed before).
              OutlinedButton(
                onPressed: () => context.read<SettingsProvider>().setNavView('history'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppTheme.accentText,
                  side: const BorderSide(color: Color(0x600A84FF)),
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  visualDensity: VisualDensity.compact,
                ),
                child: const Text(
                  'Previous videos',
                  style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold),
                ),
              ),
            ],
          ),

          const SizedBox(height: 8),

          // Subheader Row (design): All-time: N videos · Today: M videos
          // · Spent today: C credits | Simple/Details | Copy log/Clear log
          Row(
            children: [
              // Responsive pass: the stats text flexes + ellipsizes —
              // the two pill groups keep their full size at any width
              // instead of being pushed off the panel.
              Expanded(
                child: Text(
                  'All-time: $allTime videos · Today: $today videos · Spent today: $spentToday credits',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 10.5,
                    color: AppTheme.textFaint,
                  ),
                ),
              ),
              const SizedBox(width: 8),

              // Simple | Details Pill
              Container(
                height: 24,
                decoration: BoxDecoration(
                  color: AppTheme.overlay10,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppTheme.borderSoft),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _buildPillToggle(
                      label: 'Simple',
                      isSelected: !activity.isDetailsMode,
                      onTap: () => activity.setDetailsMode(false),
                    ),
                    _buildPillToggle(
                      label: 'Details',
                      isSelected: activity.isDetailsMode,
                      onTap: () => activity.setDetailsMode(true),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),

              // Copy log | Clear log Pill
              Container(
                height: 24,
                decoration: BoxDecoration(
                  color: AppTheme.overlay10,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppTheme.borderSoft),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _buildPillAction(
                      label: 'Copy log',
                      onTap: () async {
                        await activity.copyLogsToClipboard();
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                              content: Text('Logs copied to clipboard'),
                              duration: Duration(seconds: 2),
                            ),
                          );
                        }
                      },
                    ),
                    Container(width: 1, height: 12, color: AppTheme.borderSoft),
                    _buildPillAction(
                      label: 'Clear log',
                      onTap: () => activity.clearLogs(),
                    ),
                  ],
                ),
              ),
            ],
          ),

          const SizedBox(height: 8),

          // Console Log Lines
          Expanded(
            child: ListView.builder(
              controller: _scrollController,
              padding: EdgeInsets.zero,
              itemCount: logs.length,
              itemBuilder: (context, index) {
                final log = logs[index];
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2.5),
                  child: Row(
                    children: [
                      // v2.27.0 (design): the TIME starts each line
                      // ("13:02 • message").
                      Text(
                        timeFormatter.format(log.timestamp),
                        style: TextStyle(
                          fontSize: 10.5,
                          fontWeight: FontWeight.w600,
                          color: AppTheme.textFaint,
                        ),
                      ),
                      const SizedBox(width: 8),
                      // Bullet dot
                      Container(
                        width: 5,
                        height: 5,
                        decoration: BoxDecoration(
                          color: _getDotColor(log.level),
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 8),
                      // Message
                      Expanded(
                        child: Text(
                          log.message,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11,
                            color: _getMessageColor(log.level),
                          ),
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPillToggle({
    required String label,
    required bool isSelected,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
        decoration: BoxDecoration(
          gradient: isSelected ? AppTheme.accentGrad : null,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 10,
            fontWeight: isSelected ? FontWeight.w800 : FontWeight.w600,
            color: isSelected ? AppTheme.onAccent : AppTheme.textDim,
          ),
        ),
      ),
    );
  }

  Widget _buildPillAction({
    required String label,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w600,
            color: AppTheme.textDim,
          ),
        ),
      ),
    );
  }

  Color _getDotColor(LogLevel level) {
    return switch (level) {
      LogLevel.success => AppTheme.green,
      LogLevel.warning => AppTheme.accentGold,
      LogLevel.error => AppTheme.red,
      LogLevel.info => AppTheme.textDim,
    };
  }

  Color _getMessageColor(LogLevel level) {
    return switch (level) {
      LogLevel.success => AppTheme.textMain,
      LogLevel.warning => AppTheme.accentText,
      LogLevel.error => AppTheme.red,
      LogLevel.info => AppTheme.textMain,
    };
  }
}
