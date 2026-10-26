import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../providers/accounts_provider.dart';
import '../providers/activity_provider.dart';
import '../providers/generator_provider.dart';
import '../providers/settings_provider.dart';
import '../models/prompt_item.dart';
import '../services/automation_bridge.dart';
import '../services/prompt_parser.dart';
import 'video_player_dialog.dart';

// v2.27.0 (design): PROGRESS header with Rendering / Done / Queued
// count chips, and task cards that always show the progress bar, the
// percent at the left under the bar, and Play + Folder outline icon
// buttons at the right end of the bar line. No file paths anywhere.
class ProgressPanel extends StatelessWidget {
  const ProgressPanel({super.key});

  static String _baseName(String path) {
    final parts = path.replaceAll('\\', '/').split('/');
    return parts.isNotEmpty ? parts.last : path;
  }

  // The file name shown on a card: the real saved file when known,
  // else the name the engine will give this prompt's own label
  // (v2.33.0: EVERY label family — "Scene 1" → "Scene001.mp4",
  // "#00-01" → "#00-01.mp4" — via the exact mirror of the engine's
  // naming), else "#<selected tag>-<nn>.mp4", else "Prompt #n".
  static String _fileNameFor(PromptItem item, String selectedTag) {
    if (item.localFilePath != null && item.localFilePath!.isNotEmpty) {
      return _baseName(item.localFilePath!);
    }
    if (item.outputFileName != null && item.outputFileName!.isNotEmpty) {
      return item.outputFileName!;
    }
    final label = item.label;
    if (label != null && label.isNotEmpty) {
      final base = labelFileBase(label);
      if (base.isNotEmpty) return '$base.mp4';
    }
    final text = item.text.trim();
    if (text.startsWith('#')) {
      final token = text.split(RegExp(r'\s+')).first;
      if (token.length > 1) return '$token.mp4';
    }
    if (selectedTag != 'None' && selectedTag.isNotEmpty) {
      final nn = item.index.toString().padLeft(2, '0');
      return '#$selectedTag-$nn.mp4';
    }
    return 'Prompt #${item.index}';
  }

  static (String, Color) _pillFor(PromptStatus status) {
    switch (status) {
      case PromptStatus.generating:
      case PromptStatus.downloading:
        return ('RENDERING', const Color(0xFFF5B301));
      case PromptStatus.completed:
        return ('DONE', const Color(0xFF409CFF));
      case PromptStatus.failed:
        return ('FAILED', const Color(0xFFFF6961));
      case PromptStatus.pending:
      case PromptStatus.queued:
        return ('QUEUED', const Color(0xFF9A9AA0));
    }
  }

  @override
  Widget build(BuildContext context) {
    final generator = context.watch<GeneratorProvider>();
    final items = generator.items;

    // v2.30.3 (phantom progress fix — owner's rule): run cards
    // exist ONLY for a run that has actually been started for the
    // current prompt set. Merely typing prompts used to materialise
    // QUEUED "waiting for account" cards here before Generate was
    // ever pressed; now the panel shows its empty state until a
    // run starts, and any prompt edit returns it to that state.
    // The header counts follow the same rule (all zero pre-run).
    final showRunCards = generator.runStarted && items.isNotEmpty;
    final visibleItems = showRunCards ? items : const <PromptItem>[];

    final rendering = visibleItems
        .where((i) => i.status == PromptStatus.generating || i.status == PromptStatus.downloading)
        .length;
    final done = visibleItems.where((i) => i.status == PromptStatus.completed).length;
    final queued = visibleItems
        .where((i) => i.status == PromptStatus.pending || i.status == PromptStatus.queued)
        .length;

    // v2.33.0 (missing-scene protection): once a run has settled,
    // its failed cards ARE the missing scenes — they get a visible
    // banner naming them plus a one-tap redo of ONLY those scenes
    // (see _incompleteBanner). A missing scene is never silent.
    final missingItems =
        showRunCards && generator.state == GenerationState.idle
            ? visibleItems
                .where((i) => i.status == PromptStatus.failed)
                .toList()
            : const <PromptItem>[];

    return Container(
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: AppTheme.borderSoft),
        boxShadow: const [
          BoxShadow(color: Colors.black26, blurRadius: 10, offset: Offset(0, 4)),
        ],
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header (design): PROGRESS + count chips on the right
          Row(
            children: [
              Text(
                'PROGRESS',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.2,
                  color: AppTheme.textFaint,
                ),
              ),
              // Responsive pass: the chips sit in a scale-down
              // FittedBox — at narrow panel widths they shrink a
              // touch instead of overflowing the header row.
              Expanded(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerRight,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _countChip('$rendering Rendering', const Color(0xFFF5B301)),
                      const SizedBox(width: 5),
                      _countChip('$done Done', const Color(0xFF409CFF)),
                      const SizedBox(width: 5),
                      _countChip('$queued Queued', const Color(0xFF9A9AA0)),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),

          if (missingItems.isNotEmpty) ...[
            _incompleteBanner(context, missingItems),
            const SizedBox(height: 8),
          ],

          // Content
          Expanded(
            child: !showRunCards
                ? Center(
                    child: Text(
                      'No prompts yet — paste prompts on the left,\nthen press Generate.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 11, color: AppTheme.textFaint, height: 1.5),
                    ),
                  )
                : ListView.separated(
                    itemCount: items.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 6),
                    itemBuilder: (context, index) {
                      final item = items[index];
                      return _buildCard(context, item, generator.selectedTag);
                    },
                  ),
          ),
        ],
      ),
    );
  }

  // v2.33.0: the incomplete banner — which scenes are missing (by
  // their own labels) and the Redo Missing action that remakes
  // ONLY those, into the same folder. Download-failed scenes are
  // re-downloaded by the engine with no new charge; generation-
  // failed scenes re-run as that single prompt.
  Widget _incompleteBanner(BuildContext context, List<PromptItem> missing) {
    final names = missing
        .take(6)
        .map((i) => i.label ?? '#${i.index}')
        .join(', ');
    final more = missing.length > 6 ? ' +${missing.length - 6} more' : '';
    const red = Color(0xFFFF6961);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      decoration: BoxDecoration(
        color: red.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: red.withValues(alpha: 0.5)),
      ),
      child: Row(
        children: [
          const Icon(Icons.warning_amber_rounded, size: 14, color: red),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              'Incomplete — ${missing.length} scene(s) missing: $names$more',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w700,
                color: red,
                height: 1.3,
              ),
            ),
          ),
          const SizedBox(width: 6),
          InkWell(
            onTap: () => context.read<GeneratorProvider>().redoMissingItems(
                  accounts: context.read<AccountsProvider>(),
                  activity: context.read<ActivityProvider>(),
                  settings: context.read<SettingsProvider>(),
                ),
            borderRadius: BorderRadius.circular(7),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(7),
                border: Border.all(color: red),
              ),
              child: Text(
                'Redo missing (${missing.length})',
                style: const TextStyle(
                  fontSize: 9.5,
                  fontWeight: FontWeight.w800,
                  color: red,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _countChip(String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: color.withValues(alpha: 0.45)),
      ),
      child: Text(
        label,
        style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w800, color: color),
      ),
    );
  }

  Widget _buildCard(BuildContext context, PromptItem item, String selectedTag) {
    final isGenerating =
        item.status == PromptStatus.generating || item.status == PromptStatus.downloading;
    final isDone = item.status == PromptStatus.completed;
    final pill = _pillFor(item.status);
    final fileName = _fileNameFor(item, selectedTag);

    final String percentText;
    final double? barValue;
    if (isDone) {
      // v2.29.0: the REAL cost from the completion payload — the
      // hardcoded "7 credits" lied whenever another model/duration
      // was used. No figure at all when the engine reported none.
      percentText = item.creditsUsed != null
          ? '100% · ${item.creditsUsed} credits'
          : '100%';
      barValue = 1.0;
    } else if (isGenerating) {
      if (item.progress > 0) {
        percentText = '${(item.progress * 100).round()}%';
        barValue = item.progress;
      } else {
        // The engine does not stream a numeric percent for a rendering
        // task — show the bar as working instead of inventing a number.
        percentText = 'Working…';
        barValue = null;
      }
    } else if (item.status == PromptStatus.failed) {
      percentText = 'Failed';
      barValue = 0.0;
    } else {
      percentText = '0%';
      barValue = 0.0;
    }

    final accountLabel = item.accountName ??
        ((item.status == PromptStatus.pending || item.status == PromptStatus.queued)
            ? 'waiting for account'
            : '');

    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: AppTheme.inputBg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: isGenerating ? AppTheme.accentGold : AppTheme.borderSoft,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // File name + account + status pill
          Row(
            children: [
              // Responsive pass: a long saved file name ellipsizes
              // instead of pushing the status pill off the card.
              Flexible(
                child: Text(
                  fileName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                    color: isGenerating ? AppTheme.accentText : AppTheme.textMain,
                  ),
                ),
              ),
              if (accountLabel.isNotEmpty) ...[
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    accountLabel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 10, color: AppTheme.textFaint),
                  ),
                ),
              ] else
                const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: pill.$2.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: pill.$2.withValues(alpha: 0.45)),
                ),
                child: Text(
                  pill.$1,
                  style: TextStyle(fontSize: 8.5, fontWeight: FontWeight.w800, color: pill.$2, letterSpacing: 0.4),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          // Progress bar — always visible (design)
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              value: barValue,
              backgroundColor: AppTheme.overlay20,
              valueColor: AlwaysStoppedAnimation(
                isDone ? const Color(0xFF409CFF) : AppTheme.accentGold,
              ),
              minHeight: 5,
            ),
          ),
          const SizedBox(height: 5),
          // Percent at left; Play + Folder at the right end (design)
          Row(
            children: [
              Text(
                percentText,
                style: TextStyle(fontSize: 10, color: AppTheme.textDim),
              ),
              const Spacer(),
              _barIconButton(
                icon: Icons.play_arrow,
                enabled: isDone,
                accent: true,
                // v2.29.0: Play opens the IN-APP player (it used to
                // hand the file to the OS video player).
                onTap: isDone
                    ? () => showInAppPlayer(
                          context,
                          title: fileName,
                          filePath: item.localFilePath,
                          fileName: item.outputFileName ??
                              (item.localFilePath != null &&
                                      item.localFilePath!.isNotEmpty
                                  ? _baseName(item.localFilePath!)
                                  : null),
                        )
                    : null,
              ),
              const SizedBox(width: 5),
              _barIconButton(
                icon: Icons.folder_open_outlined,
                enabled: true,
                dimmed: !isDone,
                onTap: () => AutomationBridge.instance.openOutputFolder(),
              ),
            ],
          ),
          // v2.30.3: a FAILED card shows WHY. The engine's concrete
          // reason (and the settle/watchdog reasons) already land in
          // item.error — until now nothing rendered it, so a failed
          // card was a dead end the owner could not act on.
          if (item.status == PromptStatus.failed &&
              item.error != null &&
              item.error!.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              item.error!,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 9.5,
                color: Color(0xFFFF6961),
                height: 1.35,
              ),
            ),
          ],
        ],
      ),
    );
  }

  // Rounded-square outline icon button (design). Play on a Done card
  // carries the blue/accent outline; otherwise light/disabled.
  Widget _barIconButton({
    required IconData icon,
    required bool enabled,
    bool accent = false,
    bool dimmed = false,
    VoidCallback? onTap,
  }) {
    final activeColor = accent ? const Color(0xFF409CFF) : AppTheme.textDim;
    final color = enabled ? activeColor : AppTheme.textFaint.withValues(alpha: 0.55);
    return InkWell(
      onTap: enabled ? onTap : null,
      borderRadius: BorderRadius.circular(7),
      child: Container(
        width: 26,
        height: 26,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(7),
          border: Border.all(
            color: enabled && accent
                ? activeColor
                : AppTheme.borderSoft.withValues(alpha: dimmed ? 0.6 : 1.0),
          ),
        ),
        child: Icon(icon, size: 14, color: color),
      ),
    );
  }
}
