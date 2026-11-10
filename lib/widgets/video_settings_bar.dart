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
// v2.48.86 (owner-approved dropdown Design 1): the selectors'
// open menu is a custom MenuAnchor overlay — field width,
// rounded corners, gold hairline border, soft shadow, gold
// selected row with a ✓ — painted from AppTheme tokens (white
// menu in the light theme). Selection logic is unchanged.
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
          // Design 4: Two-Row Balanced Grid (Spacious 3x2 Layout)
          // Row 1: MODEL (flex 2), RESOLUTION (flex 1), BROWSERS (flex 1)
          Row(
            children: [
              Expanded(
                flex: 2,
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
                child: _buildSettingField(
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

          const SizedBox(height: 8),

          // Row 2: DURATION & ASPECT (9:16 and 16:9 only, no extra words)
          Row(
            children: [
              Expanded(
                child: _buildSettingField(
                  label: 'DURATION',
                  value: settings.duration,
                  items: const ['4s', '6s', '8s', '10s', '15s'],
                  display: const {
                    '4s': '4s',
                    '6s': '6s',
                    '8s': '8s',
                    '10s': '10s',
                    '15s': '15s',
                  },
                  onChanged: (val) {
                    if (val != null) settingsProv.updateDuration(val);
                  },
                ),
              ),
              const SizedBox(width: 6),
              // Aspect Ratio: only 9:16 and 16:9 (no names/words)
              Expanded(
                child: _buildSettingField(
                  label: 'ASPECT',
                  value: (settings.aspectRatio == '9:16' || settings.aspectRatio == '16:9')
                      ? settings.aspectRatio
                      : '9:16',
                  items: const ['9:16', '16:9'],
                  display: const {
                    '9:16': '9:16',
                    '16:9': '16:9',
                  },
                  onChanged: (val) {
                    if (val != null) settingsProv.updateAspectRatio(val);
                  },
                ),
              ),
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
                  height: 30,
                  padding: EdgeInsets.symmetric(horizontal: compact ? 8 : 12),
                  borderRadius: 7,
                  bevelDepth: 2.5,
                  enabled: isRunning || isPaused,
                  onTap: (isRunning || isPaused) ? () => generator.stopGeneration(activity) : null,
                  icon: Icons.stop,
                  label: 'Stop',
                ),
              ),
              SizedBox(width: compact ? 4 : 6),

              // Pause / Resume Button (Tactile 3D)
              Tooltip(
                message: isPaused ? 'Resume generation' : 'Pause generation',
                child: TactileButton(
                  type: TactileType.pause,
                  height: 30,
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

              SizedBox(width: compact ? 4 : 6),

              // Estimate (design): "N prompts · est. X credits · Y Live" (concise, no truncation)
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
                        ? '$promptCount prompts · $liveCount Live'
                        : '$promptCount prompts · $est · $liveCount Live';
                  }(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.right,
                  style: TextStyle(fontSize: 10.5, color: AppTheme.textFaint),
                ),
              ),
              SizedBox(width: compact ? 6 : 8),

              // Generate Button — Tactile 3D (Tuned height 31, disabled on 0 prompts)
              Tooltip(
                message: promptCount == 0
                    ? 'Enter at least 1 prompt to generate'
                    : isRunning
                        ? 'Generation in progress...'
                        : 'Start generation (Ctrl + Enter)',
                child: TactileButton(
                  type: TactileType.primary,
                  height: 31,
                  padding: EdgeInsets.symmetric(horizontal: compact ? 12 : 18),
                  borderRadius: 8,
                  bevelDepth: 2.5,
                  enabled: !isRunning && promptCount > 0,
                  onTap: (!isRunning && promptCount > 0)
                      ? () => generator.startGeneration(
                            accounts: accounts,
                            activity: activity,
                            settings: settingsProv,
                          )
                      : null,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.play_arrow, size: 14, color: Colors.white),
                      const SizedBox(width: 4),
                      Text(
                        isRunning ? 'Running...' : 'Generate',
                        style: const TextStyle(
                          fontSize: 11.5,
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
              fontSize: 8.5,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.8,
              color: AppTheme.textFaint,
            ),
          ),
        ),
        const SizedBox(height: 4),
        // v2.48.86 (owner-approved dropdown Design 1): the open
        // menu is no longer the stock DropdownButton overlay (a
        // flat block, wider than its field, no border, a grey
        // selected band — the owner's screenshot complaint). A
        // MenuAnchor menu in the owner's design language instead:
        //   · menu width == THIS field's width
        //   · rounded corners (10px) + a 1px gold hairline border
        //   · a soft drop shadow over the surface below
        //   · the selected row wears a gold tint, gold bold text
        //     and a ✓ at its right edge
        //   · the hovered row wears a lighter tint
        // All colours come from AppTheme tokens, so the LIGHT
        // theme (the owner's active surface) gets a white menu,
        // gold hairline, light-gold selected tint with dark-gold
        // text, and dark palettes get the sampled dark look.
        // Values, items and the onChanged write path are exactly
        // what the stock dropdown drove — a visual restyle of
        // the menu overlay only.
        LayoutBuilder(
          builder: (context, fieldConstraints) {
            final fieldWidth = fieldConstraints.maxWidth;
            final current = items.contains(value) ? value : items.first;
            final selectedTint = AppTheme.accentGold.withValues(
              alpha: AppTheme.dark ? 0.20 : 0.14,
            );
            final hoverTint = AppTheme.accentGold.withValues(
              alpha: AppTheme.dark ? 0.10 : 0.07,
            );
            final selectedText =
                AppTheme.dark ? AppTheme.accentAmber : AppTheme.accentText;
            return MenuAnchor(
              alignmentOffset: const Offset(0, 2),
              style: MenuStyle(
                backgroundColor:
                    WidgetStatePropertyAll(AppTheme.surfaceElevated),
                elevation: const WidgetStatePropertyAll(8),
                shadowColor: WidgetStatePropertyAll(
                  Colors.black.withValues(alpha: 0.35),
                ),
                padding: const WidgetStatePropertyAll(EdgeInsets.all(4)),
                minimumSize: WidgetStatePropertyAll(Size(fieldWidth, 0)),
                // v2.48.87 (owner field report — .86 menus CLIPPED):
                // the .86 style also capped the menu HEIGHT at
                // 340. That hard clamp, stacked on the overlay's
                // own fit-to-window clamp when the menu opens
                // downward in the window's lower half, sized the
                // panel by the clamp instead of by its content —
                // the last row was sliced mid-height and the
                // panel's bottom border/corner fell outside the
                // painted area (RESOLUTION and BROWSERS shots).
                // The stock DropdownButton imposed no such cap,
                // which is why it rendered fully. The height is
                // now UNBOUNDED (width still pinned to the field):
                // the panel is exactly as tall as its rows — see
                // the fixed row height on the items below.
                maximumSize:
                    WidgetStatePropertyAll(Size(fieldWidth, double.infinity)),
                shape: WidgetStatePropertyAll(
                  RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                    side: BorderSide(
                      color: AppTheme.accentGold.withValues(
                        alpha: AppTheme.dark ? 0.5 : 0.75,
                      ),
                      width: 1,
                    ),
                  ),
                ),
              ),
              menuChildren: [
                for (final item in items)
                  MenuItemButton(
                    closeOnActivate: true,
                    onPressed: () => onChanged(item),
                    style: ButtonStyle(
                      // v2.48.87: the row height is FIXED (min ==
                      // max == 32), so the menu panel's height is
                      // deterministic — padding 8 + rows x 32 —
                      // and always renders completely.
                      minimumSize:
                          const WidgetStatePropertyAll(Size(0, 32)),
                      maximumSize: const WidgetStatePropertyAll(
                          Size(double.infinity, 32)),
                      padding: const WidgetStatePropertyAll(
                        EdgeInsets.symmetric(horizontal: 10),
                      ),
                      textStyle: const WidgetStatePropertyAll(
                        TextStyle(fontSize: 9.5, fontWeight: FontWeight.bold),
                      ),
                      foregroundColor: WidgetStatePropertyAll(
                        item == current ? selectedText : AppTheme.textMain,
                      ),
                      backgroundColor:
                          WidgetStateProperty.resolveWith((states) {
                        if (item == current) return selectedTint;
                        if (states.contains(WidgetState.hovered) ||
                            states.contains(WidgetState.focused)) {
                          return hoverTint;
                        }
                        return null;
                      }),
                    ),
                    trailingIcon: item == current
                        ? Icon(Icons.check, size: 12, color: selectedText)
                        : null,
                    child: SizedBox(
                      width: fieldWidth - 28,
                      // v2.28.0: ONE line always — FittedBox scales
                      // the label down to the column width instead
                      // of letting it wrap ("Omni 1.1 / Flash" on
                      // two lines).
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: Text(
                          display[item] ?? item,
                          maxLines: 1,
                          softWrap: false,
                        ),
                      ),
                    ),
                  ),
              ],
              builder: (context, controller, child) {
                return GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () {
                    if (controller.isOpen) {
                      controller.close();
                    } else {
                      controller.open();
                    }
                  },
                  child: Container(
                    height: 30,
                    padding: const EdgeInsets.symmetric(horizontal: 5),
                    decoration: BoxDecoration(
                      color: AppTheme.inputBg,
                      borderRadius: BorderRadius.circular(7),
                      border: Border.all(color: AppTheme.borderSoft),
                      boxShadow: [
                        BoxShadow(
                          color: AppTheme.dark
                              ? const Color(0xFF0F172A)
                              : AppTheme.borderSoft,
                          offset: const Offset(0, 1.5),
                          blurRadius: AppTheme.dark ? 0 : 1.0,
                        ),
                      ],
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: FittedBox(
                            fit: BoxFit.scaleDown,
                            alignment: Alignment.centerLeft,
                            child: Text(
                              display[current] ?? current,
                              maxLines: 1,
                              softWrap: false,
                              style: TextStyle(
                                fontSize: 9.5,
                                fontWeight: FontWeight.bold,
                                color: AppTheme.textMain,
                              ),
                            ),
                          ),
                        ),
                        Icon(
                          Icons.keyboard_arrow_down,
                          size: 13,
                          color: AppTheme.textDim,
                        ),
                      ],
                    ),
                  ),
                );
              },
            );
          },
        ),
      ],
    );
  }
}
