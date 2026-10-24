import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../providers/generator_provider.dart';
import '../models/prompt_item.dart';
import '../services/automation_bridge.dart';

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
  // else the prompt's own leading tag ("#11-01 …" → "#11-01.mp4" —
  // the engine's own tag naming), else "#<selected tag>-<nn>.mp4",
  // else "Prompt #n".
  static String _fileNameFor(PromptItem item, String selectedTag) {
    if (item.localFilePath != null && item.localFilePath!.isNotEmpty) {
      return _baseName(item.localFilePath!);
    }
    if (item.outputFileName != null && item.outputFileName!.isNotEmpty) {
      return item.outputFileName!;
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

    final rendering = items
        .where((i) => i.status == PromptStatus.generating || i.status == PromptStatus.downloading)
        .length;
    final done = items.where((i) => i.status == PromptStatus.completed).length;
    final queued = items
        .where((i) => i.status == PromptStatus.pending || i.status == PromptStatus.queued)
        .length;

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
              const Spacer(),
              _countChip('$rendering Rendering', const Color(0xFFF5B301)),
              const SizedBox(width: 5),
              _countChip('$done Done', const Color(0xFF409CFF)),
              const SizedBox(width: 5),
              _countChip('$queued Queued', const Color(0xFF9A9AA0)),
            ],
          ),
          const SizedBox(height: 10),

          // Content
          Expanded(
            child: items.isEmpty
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
      percentText = '100% · 7 credits';
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
              Text(
                fileName,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.bold,
                  color: isGenerating ? AppTheme.accentText : AppTheme.textMain,
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
                onTap: isDone
                    ? () {
                        if (item.localFilePath != null && item.localFilePath!.isNotEmpty) {
                          AutomationBridge.instance.openOutputFile(_baseName(item.localFilePath!));
                        } else if (item.outputFileName != null && item.outputFileName!.isNotEmpty) {
                          AutomationBridge.instance.openOutputFile(item.outputFileName!);
                        } else {
                          AutomationBridge.instance.openOutputFolder();
                        }
                      }
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
