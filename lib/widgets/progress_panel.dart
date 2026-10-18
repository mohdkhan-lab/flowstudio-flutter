import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../providers/generator_provider.dart';
import '../models/prompt_item.dart';

class ProgressPanel extends StatelessWidget {
  const ProgressPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final generator = context.watch<GeneratorProvider>();
    final items = generator.items;

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
          // Header
          const Text(
            'Progress',
            style: TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.bold,
              color: AppTheme.textMain,
            ),
          ),
          const SizedBox(height: 10),

          // Content
          Expanded(
            child: items.isEmpty
                ? const SizedBox.shrink()
                : ListView.separated(
                    itemCount: items.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 6),
                    itemBuilder: (context, index) {
                      final item = items[index];
                      final isGenerating = item.status == PromptStatus.generating ||
                          item.status == PromptStatus.downloading;

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
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Text(
                                  'Prompt #${item.index}',
                                  style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.bold,
                                    color: isGenerating ? AppTheme.accentText : AppTheme.textMain,
                                  ),
                                ),
                                Text(
                                  item.status.name.toUpperCase(),
                                  style: TextStyle(
                                    fontSize: 9.5,
                                    fontWeight: FontWeight.bold,
                                    color: item.status == PromptStatus.completed
                                        ? AppTheme.green
                                        : isGenerating
                                            ? AppTheme.accentGold
                                            : AppTheme.textFaint,
                                  ),
                                ),
                              ],
                            ),
                            if (isGenerating) ...[
                              const SizedBox(height: 6),
                              LinearProgressIndicator(
                                value: item.progress,
                                backgroundColor: const Color(0x20FFFFFF),
                                valueColor: const AlwaysStoppedAnimation(AppTheme.accentGold),
                                minHeight: 3,
                              ),
                            ],
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
}
