import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../models/account.dart';
import '../providers/settings_provider.dart';
import '../providers/generator_provider.dart';
import '../providers/accounts_provider.dart';
import '../providers/activity_provider.dart';
import '../services/credit_costs.dart';

// v2.27.0 (design): ONE row of four labelled dropdowns
// (MODEL / DURATION / ASPECT / BROWSERS, labels above), then a row
// with Stop + Pause on the left, the estimate text and the big blue
// Generate button on the right. The engine values behind the dropdowns
// are unchanged — only their display labels match the design.
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

    final liveCount = accounts.accounts
        .where((a) => a.credits > 0 && a.status == AccountStatus.ready)
        .length;
    final promptCount = generator.totalPrompts;

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
      child: LayoutBuilder(
        builder: (context, constraints) {
          // v2.30.0: compact mode for the narrow right column (the
          // bar sits in a ~390px pane at 950px windows) — button
          // paddings/gaps tighten so Stop/Pause/Generate always fit
          // inside the bar, in every state (incl. "Running...").
          final compact = constraints.maxWidth < 430;
          return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // One row of 4 labelled dropdowns (design)
          Row(
            children: [
              Expanded(
                child: _buildSettingField(
                  label: 'MODEL',
                  value: settings.model,
                  items: const ['Omni Flash', 'Veo 3.1 Fast', 'Veo 3.1 Lite', 'Veo 3.1 Quality'],
                  display: const {'Omni Flash': 'Omni 1.1 Flash'},
                  onChanged: (val) {
                    if (val != null) settingsProv.updateModel(val);
                  },
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _buildSettingField(
                  label: 'DURATION',
                  value: settings.duration,
                  items: const ['4s', '6s', '8s', '10s'],
                  display: const {
                    '4s': '4 seconds',
                    '6s': '6 seconds',
                    '8s': '8 seconds',
                    '10s': '10 seconds',
                  },
                  onChanged: (val) {
                    if (val != null) settingsProv.updateDuration(val);
                  },
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _buildSettingField(
                  label: 'ASPECT',
                  value: settings.aspectRatio,
                  items: const ['9:16', '16:9', '1:1'],
                  display: const {
                    '9:16': '9:16 Vertical',
                    '16:9': '16:9 Landscape',
                    '1:1': '1:1 Square',
                  },
                  onChanged: (val) {
                    if (val != null) settingsProv.updateAspectRatio(val);
                  },
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _buildSettingField(
                  label: 'BROWSERS',
                  value: '${settings.parallelBrowsers}',
                  items: const ['1', '2', '3', '4'],
                  display: const {
                    '1': '1 parallel',
                    '2': '2 parallel',
                    '3': '3 parallel',
                    '4': '4 parallel',
                  },
                  onChanged: (val) {
                    if (val != null) settingsProv.updateParallelBrowsers(int.tryParse(val) ?? 1);
                  },
                ),
              ),
            ],
          ),

          const SizedBox(height: 12),

          // Actions Row (design): Stop | Pause ... estimate | Generate
          Row(
            children: [
              // Stop Button
              _actionButton(
                icon: Icons.stop,
                label: 'Stop',
                compact: compact,
                onTap: (isRunning || isPaused) ? () => generator.stopGeneration(activity) : null,
              ),
              SizedBox(width: compact ? 6 : 8),

              // Pause / Resume Button
              _actionButton(
                icon: isPaused ? Icons.play_arrow : Icons.pause,
                label: isPaused ? 'Resume' : 'Pause',
                compact: compact,
                onTap: isRunning
                    ? () => generator.pauseGeneration(activity)
                    : isPaused
                        ? () => generator.resumeGeneration(
                              accounts: accounts,
                              activity: activity,
                              settings: settingsProv,
                            )
                        : null,
              ),

              SizedBox(width: compact ? 6 : 8),

              // Estimate (design): "N prompts · est. X credits · Y Live accounts"
              // v2.28.0: the estimate flexes + ellipsizes — Stop/Pause
              // keep their intrinsic size and the Generate button is
              // NEVER clipped (at 1024 wide the old Spacer row
              // overflowed and cut the button at the right edge).
              // v2.34.0 (Problem 10): the estimate is REAL — the
              // per-model+duration cost table the engine itself
              // charges by (services/credit_costs.dart), updating
              // live with the MODEL/DURATION dropdowns above. The
              // old hardcoded "× 7" printed 14 for two 4-credit
              // Omni videos. A combination with no evidenced rate
              // shows NO estimate at all — never a fake number.
              Expanded(
                child: Text(
                  () {
                    final est = creditEstimateText(
                      model: settings.model,
                      duration: settings.duration,
                      promptCount: promptCount,
                    );
                    return est == null
                        ? '$promptCount prompts · $liveCount Live accounts'
                        : '$promptCount prompts · $est · $liveCount Live accounts';
                  }(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.right,
                  style: TextStyle(fontSize: 10.5, color: AppTheme.textFaint),
                ),
              ),
              SizedBox(width: compact ? 6 : 8),

              // Generate Button — big BLUE gradient (design)
              InkWell(
                onTap: !isRunning
                    ? () => generator.startGeneration(
                          accounts: accounts,
                          activity: activity,
                          settings: settingsProv,
                        )
                    : null,
                borderRadius: BorderRadius.circular(8),
                child: Container(
                  height: 38,
                  padding: EdgeInsets.symmetric(horizontal: compact ? 12 : 20),
                  decoration: BoxDecoration(
                    gradient: AppTheme.accentGrad,
                    borderRadius: BorderRadius.circular(8),
                    boxShadow: const [
                      BoxShadow(
                        color: Colors.black38,
                        blurRadius: 4,
                        offset: Offset(0, 2),
                      ),
                    ],
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.play_arrow, size: 15, color: Colors.white),
                      const SizedBox(width: 4),
                      Text(
                        isRunning ? 'Running...' : 'Generate',
                        style: const TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w800,
                          color: Colors.white,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
          );
        },
      ),
    );
  }

  Widget _actionButton({
    required IconData icon,
    required String label,
    required VoidCallback? onTap,
    bool compact = false,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(7),
      child: Container(
        height: 32,
        padding: EdgeInsets.symmetric(horizontal: compact ? 8 : 12),
        decoration: BoxDecoration(
          color: AppTheme.overlay10,
          borderRadius: BorderRadius.circular(7),
          border: Border.all(color: AppTheme.borderSoft),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 13, color: AppTheme.textMain),
            SizedBox(width: compact ? 4 : 6),
            Text(
              label,
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.textMain),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSettingField({
    required String label,
    required String value,
    required List<String> items,
    Map<String, String> display = const {},
    required ValueChanged<String?> onChanged,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w800,
            letterSpacing: 0.8,
            color: AppTheme.textFaint,
          ),
        ),
        const SizedBox(height: 5),
        Container(
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 6),
          decoration: BoxDecoration(
            color: AppTheme.inputBg,
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: AppTheme.borderSoft),
          ),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<String>(
              value: items.contains(value) ? value : items.first,
              dropdownColor: AppTheme.surfaceElevated,
              isDense: true,
              isExpanded: true,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.bold,
                color: AppTheme.textMain,
              ),
              icon: Icon(Icons.keyboard_arrow_down, size: 14, color: AppTheme.textDim),
              items: items.map((String item) {
                return DropdownMenuItem<String>(
                  value: item,
                  // v2.28.0: ONE line always — FittedBox scales the
                  // label down to the column width instead of letting
                  // it wrap ("Omni 1.1 / Flash" on two lines).
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(
                      display[item] ?? item,
                      maxLines: 1,
                      softWrap: false,
                    ),
                  ),
                );
              }).toList(),
              onChanged: onChanged,
            ),
          ),
        ),
      ],
    );
  }
}
