import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../models/account.dart';
import '../providers/settings_provider.dart';
import '../providers/generator_provider.dart';
import '../providers/accounts_provider.dart';
import '../providers/activity_provider.dart';
import '../services/credit_costs.dart';
import 'tactile_components.dart';

// v2.27.0 (design): ONE row of labelled dropdowns
// (MODEL / DURATION / ASPECT / BROWSERS, labels above), then a row
// with Stop + Pause on the left, the estimate text and the big blue
// Generate button on the right. The engine values behind the dropdowns
// are unchanged — only their display labels match the design.
// v2.48.74 (owner): the same single row gains RESOLUTION (360p/720p —
// the EXISTING quality setting the engine already applies in Flow,
// surfaced here as the owner asked) and DOWNLOAD (Original/Enhanced —
// the download_mode setting). Still ONE row: every field is Expanded
// and labels scale down (the v2.28.0 FittedBox pattern), so the bar
// fits 1024×768 with no overflow and no new scroll area.
// v2.48.75 (owner): the DOWNLOAD selector leaves the bar — the
// download mode is a Settings-only choice now (Settings → Defaults →
// DOWNLOAD MODE, the same default_download_mode binding; runs keep
// honouring it). The five remaining selectors get sized flex widths
// (MODEL widest) and every selector label renders on ONE line via
// the FittedBox pattern — the owner's .74 screenshot showed labels
// breaking mid-word ("RESOLUTI ON" / "DOWNLOA D") in the
// overcrowded 6-field row.
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

    return TactileSectionContainer(
      padding: const EdgeInsets.all(12),
      child: LayoutBuilder(
        builder: (context, constraints) {
          // v2.30.0: compact mode for the narrow right column (the
          // bar sits in a ~390px pane at 950px windows) — button
          // paddings/gaps tighten so Stop/Pause/Generate always fit
          // inside the bar, in every state (incl. "Running...").
          final compact = constraints.maxWidth < 450;
          return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // One row of 5 labelled dropdowns (design; v2.48.75:
          // flex widths sized to each field's content — MODEL
          // widest — so no label or value is squeezed).
          Row(
            children: [
              Expanded(
                flex: 3,
                child: _buildSettingField(
                  label: 'MODEL',
                  value: settings.model,
                  items: const ['Omni Flash', 'Omni 1.2 Flash', 'Veo 3.1 Fast', 'Veo 3.1 Lite', 'Veo 3.1 Quality'],
                  display: const {'Omni Flash': 'Omni 1.1 Flash', 'Omni 1.2 Flash': 'Omni 1.2 Flash'},
                  onChanged: (val) {
                    if (val != null) settingsProv.updateModel(val);
                  },
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                flex: 2,
                child: _buildSettingField(
                  label: 'DURATION',
                  value: settings.duration,
                  items: const ['4s', '6s', '8s', '10s', '15s'],
                  display: const {
                    '4s': '4 seconds',
                    '6s': '6 seconds',
                    '8s': '8 seconds',
                    '10s': '10 seconds',
                    '15s': '15 seconds',
                  },
                  onChanged: (val) {
                    if (val != null) settingsProv.updateDuration(val);
                  },
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                flex: 3,
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
              const SizedBox(width: 6),
              Expanded(
                flex: 2,
                child: _buildSettingField(
                  // v2.48.74 (Item A): generation resolution —
                  // bound to the EXISTING settings.quality the
                  // engine already applies (stored '1080p' means
                  // a 720p generation, so the bar shows 720p).
                  label: 'RESOLUTION',
                  value: settings.quality == '360p' ? '360p' : '720p',
                  items: const ['360p', '720p'],
                  onChanged: (val) {
                    if (val != null) settingsProv.updateQuality(val);
                  },
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                flex: 2,
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
              // v2.48.75 (owner): NO download selector here —
              // the download mode lives in Settings only
              // (Settings → Defaults → DOWNLOAD MODE).
            ],
          ),

          const SizedBox(height: 12),

          // Actions Row (design): Stop | Pause ... estimate | Generate
          Row(
            children: [
              // Stop Button (Tactile 3D)
              Tooltip(
                message: 'Stop generation',
                child: TactileButton(
                  type: TactileType.stop,
                  height: 32,
                  padding: EdgeInsets.symmetric(horizontal: compact ? 8 : 12),
                  borderRadius: 7,
                  bevelDepth: 2.5,
                  enabled: isRunning || isPaused,
                  onTap: (isRunning || isPaused) ? () => generator.stopGeneration(activity) : null,
                  icon: Icons.stop,
                  label: 'Stop',
                ),
              ),
              SizedBox(width: compact ? 6 : 8),

              // Pause / Resume Button (Tactile 3D)
              Tooltip(
                message: isPaused ? 'Resume generation' : 'Pause generation',
                child: TactileButton(
                  type: TactileType.pause,
                  height: 32,
                  padding: EdgeInsets.symmetric(horizontal: compact ? 8 : 12),
                  borderRadius: 7,
                  bevelDepth: 2.5,
                  enabled: isRunning || isPaused,
                  onTap: isRunning
                      ? () => generator.pauseGeneration(activity)
                      : isPaused
                          ? () => generator.resumeGeneration(
                                accounts: accounts,
                                activity: activity,
                                settings: settingsProv,
                              )
                          : null,
                  icon: isPaused ? Icons.play_arrow : Icons.pause,
                  label: isPaused ? 'Resume' : 'Pause',
                ),
              ),

              SizedBox(width: compact ? 6 : 8),

              // Estimate (design): "N prompts · est. X credits · Y Live accounts"
              Expanded(
                child: Text(
                  () {
                    final est = creditEstimateText(
                      model: settings.model,
                      duration: settings.duration,
                      quality: settings.quality,
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

              // Generate Button — Tactile 3D (Mechanical Bevel + 2.0px Lift)
              Tooltip(
                message: isRunning ? 'Generation in progress...' : 'Start generation (Ctrl + Enter)',
                child: TactileButton(
                  type: TactileType.primary,
                  height: 38,
                  padding: EdgeInsets.symmetric(horizontal: compact ? 12 : 20),
                  borderRadius: 8,
                  bevelDepth: 3.5,
                  enabled: !isRunning,
                  onTap: !isRunning
                      ? () => generator.startGeneration(
                            accounts: accounts,
                            activity: activity,
                            settings: settingsProv,
                          )
                      : null,
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
        // v2.48.75: the label NEVER wraps or breaks mid-word —
        // softWrap off, one line, and the FittedBox scales it
        // down to the field width (the same pattern the values
        // below have used since v2.28.0).
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            label,
            maxLines: 1,
            softWrap: false,
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.8,
              color: AppTheme.textFaint,
            ),
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
            boxShadow: const [
              BoxShadow(
                color: Color(0xFF0F172A),
                offset: Offset(0, 2.0),
                blurRadius: 0,
              ),
            ],
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
