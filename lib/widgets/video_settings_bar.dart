import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../providers/settings_provider.dart';
import '../providers/generator_provider.dart';
import '../providers/accounts_provider.dart';
import '../providers/activity_provider.dart';

class VideoSettingsBar extends StatelessWidget {
  const VideoSettingsBar({super.key});

  @override
  Widget build(BuildContext context) {
    final settingsProv = context.watch<SettingsProvider>();
    final settings = settingsProv.settings;
    final generator = context.watch<GeneratorProvider>();
    final accounts = context.watch<AccountsProvider>();
    final activity = context.watch<ActivityProvider>();

    final isRunning = generator.isRunning;
    final isPaused = generator.isPaused;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: AppTheme.borderSoft),
        boxShadow: const [
          BoxShadow(color: Colors.black26, blurRadius: 10, offset: Offset(0, 4)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header: VIDEO SETTINGS
          const Text(
            'VIDEO SETTINGS',
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.8,
              color: AppTheme.textFaint,
            ),
          ),
          const SizedBox(height: 8),

          // 2x2 Grid of Dropdowns
          Row(
            children: [
              // Model
              Expanded(
                child: _buildSettingField(
                  label: 'Model',
                  value: settings.model,
                  items: ['Omni Flash', 'Veo 3.1 Fast', 'Veo 3.1 Lite', 'Veo 3.1 Quality'],
                  onChanged: (val) {
                    if (val != null) settingsProv.updateModel(val);
                  },
                ),
              ),
              const SizedBox(width: 8),
              // Duration
              Expanded(
                child: _buildSettingField(
                  label: 'Duration',
                  value: settings.duration,
                  items: ['4s', '6s', '8s', '10s'],
                  onChanged: (val) {
                    if (val != null) settingsProv.updateDuration(val);
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              // Aspect
              Expanded(
                child: _buildSettingField(
                  label: 'Aspect',
                  value: settings.aspectRatio,
                  items: ['9:16', '16:9', '1:1'],
                  onChanged: (val) {
                    if (val != null) settingsProv.updateAspectRatio(val);
                  },
                ),
              ),
              const SizedBox(width: 8),
              // Browsers
              Expanded(
                child: _buildSettingField(
                  label: 'Browsers',
                  value: '${settings.parallelBrowsers}',
                  items: ['1', '2', '3', '4'],
                  onChanged: (val) {
                    if (val != null) settingsProv.updateParallelBrowsers(int.tryParse(val) ?? 1);
                  },
                ),
              ),
            ],
          ),

          const SizedBox(height: 12),

          // Actions Row: Pause/Resume | Stop | Generate | Running...
          Row(
            children: [
              // Pause / Resume Button
              InkWell(
                onTap: isRunning
                    ? () => generator.pauseGeneration(activity)
                    : isPaused
                        ? () => generator.resumeGeneration(
                              accounts: accounts,
                              activity: activity,
                              settings: settingsProv,
                            )
                        : null,
                borderRadius: BorderRadius.circular(6),
                child: Container(
                  height: 30,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  decoration: BoxDecoration(
                    color: const Color(0x10FFFFFF),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppTheme.borderSoft),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: isPaused ? AppTheme.accentGold : AppTheme.blue,
                          borderRadius: BorderRadius.circular(1.5),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        isPaused ? 'Resume' : 'Pause',
                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.textMain),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),

              // Stop Button
              InkWell(
                onTap: (isRunning || isPaused) ? () => generator.stopGeneration(activity) : null,

                borderRadius: BorderRadius.circular(6),
                child: Container(
                  height: 30,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  decoration: BoxDecoration(
                    color: const Color(0x10FFFFFF),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppTheme.borderSoft),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: AppTheme.blue,
                          borderRadius: BorderRadius.circular(1.5),
                        ),
                      ),
                      const SizedBox(width: 6),
                      const Text(
                        'Stop',
                        style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.textMain),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),

              // Generate Button (Gold Gradient)
              InkWell(
                onTap: !isRunning
                    ? () => generator.startGeneration(
                          accounts: accounts,
                          activity: activity,
                          settings: settingsProv,
                        )
                    : null,
                borderRadius: BorderRadius.circular(6),
                child: Container(
                  height: 30,
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  decoration: BoxDecoration(
                    gradient: AppTheme.accentGrad,
                    borderRadius: BorderRadius.circular(6),
                    boxShadow: const [
                      BoxShadow(
                        color: Colors.black38,
                        blurRadius: 4,
                        offset: Offset(0, 2),
                      ),
                    ],
                  ),
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.play_arrow, size: 14, color: Color(0xFF1A1405)),
                      SizedBox(width: 4),
                      Text(
                        'Generate',
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w800,
                          color: Color(0xFF1A1405),
                        ),
                      ),
                    ],
                  ),
                ),
              ),

              const SizedBox(width: 12),
              if (isRunning) ...[
                const Text(
                  'Running...',
                  style: TextStyle(
                    fontSize: 11,
                    fontStyle: FontStyle.italic,
                    color: AppTheme.accentText,
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildSettingField({
    required String label,
    required String value,
    required List<String> items,
    required ValueChanged<String?> onChanged,
  }) {
    return Container(
      height: 34,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
        color: AppTheme.inputBg,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: AppTheme.borderSoft),
      ),
      child: Row(
        children: [
          Text(
            label,
            style: const TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.bold,
              color: AppTheme.textDim,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                value: items.contains(value) ? value : items.first,
                dropdownColor: AppTheme.surfaceElevated,
                isDense: true,
                style: const TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textMain,
                ),
                icon: const Icon(Icons.keyboard_arrow_down, size: 14, color: AppTheme.textDim),
                items: items.map((String item) {
                  return DropdownMenuItem<String>(
                    value: item,
                    child: Text(item),
                  );
                }).toList(),
                onChanged: onChanged,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
