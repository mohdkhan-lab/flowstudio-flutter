import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:file_picker/file_picker.dart';
import '../theme/app_theme.dart';
import '../models/app_settings.dart';
import '../providers/notifications_provider.dart';
import '../providers/settings_provider.dart';
import 'package:flutter/services.dart';
import '../services/automation_bridge.dart';

class SettingsView extends StatefulWidget {
  const SettingsView({super.key});

  @override
  State<SettingsView> createState() => _SettingsViewState();
}

class _SettingsViewState extends State<SettingsView> {
  // (Fix list 2026-10-27, item 6): ONE vertical rhythm for the
  // whole page — the gap between every pair of panels (and the
  // page's own top/bottom padding) is this value, so no section
  // sits closer or farther than any other.
  static const double _sectionGap = 12;
  final TextEditingController _customTagController = TextEditingController();
  final TextEditingController _folderController = TextEditingController();
  final TextEditingController _chromeController = TextEditingController();
  final TextEditingController _whatsappController = TextEditingController();
  final TextEditingController _chatController = TextEditingController();
  final TextEditingController _supportController = TextEditingController();

  // v2.31.0: MCP connector state (Settings → Muse AI — MCP).
  Map<String, dynamic>? _mcpStatus;
  bool _mcpBusy = false;
  String _mcpFeedback = '';

  @override
  void initState() {
    super.initState();
    final s = context.read<SettingsProvider>().settings;
    _folderController.text = s.outputDirectory;
    _chromeController.text = s.chromePath;
    _whatsappController.text = s.whatsAppLink;
    _chatController.text = s.chatLink;
    _supportController.text = s.supportLink;
    _loadMcpStatus();
  }

  @override
  void dispose() {
    _customTagController.dispose();
    _folderController.dispose();
    _chromeController.dispose();
    _whatsappController.dispose();
    _chatController.dispose();
    _supportController.dispose();
    super.dispose();
  }

  Future<void> _pickOutputFolder() async {
    final dir = await FilePickerPlatform.instance.getDirectoryPath();
    if (dir != null && mounted) {
      context.read<SettingsProvider>().setOutputDirectory(dir);
      _folderController.text = dir;
    }
  }

  Future<void> _pickChromeFile() async {
    final result = await FilePickerPlatform.instance.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['exe'],
    );
    if (result.isNotEmpty && result.first.path != null && mounted) {
      final path = result.first.path!;
      context.read<SettingsProvider>().setChromePath(path);
      _chromeController.text = path;
    }
  }


  // --- v2.31.0: MCP connector (approved design Option 2 — grid card) ---

  Future<void> _loadMcpStatus() async {
    final st = await AutomationBridge.instance.getMcpStatus();
    if (mounted && st != null) setState(() => _mcpStatus = st);
  }

  void _mcpSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 3)),
    );
  }

  Future<void> _toggleMcp(bool v) async {
    if (_mcpBusy) return;
    setState(() => _mcpBusy = true);
    final st = await AutomationBridge.instance.setMcpEnabled(v);
    if (!mounted) return;
    setState(() {
      if (st != null) _mcpStatus = st;
      _mcpBusy = false;
      _mcpFeedback = v ? 'MCP server is running — Muse can connect now.' : 'MCP server stopped.';
    });
  }

  Future<void> _regenMcpToken() async {
    if (_mcpBusy) return;
    setState(() => _mcpBusy = true);
    final st = await AutomationBridge.instance.regenerateMcpToken();
    if (!mounted) return;
    setState(() {
      if (st != null) _mcpStatus = st;
      _mcpBusy = false;
      _mcpFeedback = 'New token generated — copy the new Muse config for Muse.';
    });
    _mcpSnack('New MCP token generated');
  }

  Future<void> _copyMcpUrl() async {
    final url = _mcpStatus?['url']?.toString() ?? '';
    if (url.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: url));
    _mcpSnack('Connection URL copied');
  }

  Future<void> _copyMcpToken() async {
    final token = await AutomationBridge.instance.getMcpToken();
    if (token == null || token.isEmpty) {
      _mcpSnack('Could not load the token — is the engine running?');
      return;
    }
    await Clipboard.setData(ClipboardData(text: token));
    _mcpSnack('Access token copied');
  }

  Future<void> _copyMcpConfig() async {
    final json = await AutomationBridge.instance.getMcpConfigJson();
    if (json == null) {
      _mcpSnack('Could not load the config — is the engine running?');
      return;
    }
    await Clipboard.setData(ClipboardData(text: json));
    _mcpSnack('Muse config copied — paste it into Muse to connect');
  }

  String _mcpLastConnectedText() {
    final raw = _mcpStatus?['lastConnectedAt'];
    final client = _mcpStatus?['lastClient']?.toString() ?? '';
    if (raw == null) return 'Not connected yet';
    final ms = raw is num ? raw.toInt() : int.tryParse(raw.toString()) ?? 0;
    if (ms <= 0) return 'Not connected yet';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    var hour = dt.hour % 12;
    if (hour == 0) hour = 12;
    final ampm = dt.hour >= 12 ? 'PM' : 'AM';
    final minute = dt.minute.toString().padLeft(2, '0');
    final who = client.isEmpty ? 'Muse (MK)' : client;
    return 'Last connected: ${dt.day}/${dt.month}, $hour:$minute $ampm · $who';
  }

  Widget _buildMcpPanel() {
    final st = _mcpStatus;
    final enabled = st == null ? true : st['enabled'] == true;
    final running = st != null && st['running'] == true;
    final url = st?['url']?.toString() ?? 'http://127.0.0.1:48191/mcp';
    final tokenMasked = st?['tokenMasked']?.toString() ?? '••••••••••••';
    const toolLabels = [
      'Status', 'Accounts', 'Credits', 'History', 'Outputs',
      'Generate', 'Pause / Resume', 'Stop', 'Sync Credits', 'Check Cookies',
      'Update App',
    ];
    return _buildPanel(
      title: '🔌 MCP CONNECTION',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: running ? AppTheme.green.withValues(alpha: 0.16) : AppTheme.overlay08,
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: running ? AppTheme.green : AppTheme.borderSoft),
                ),
                child: Text(
                  running ? '● RUNNING' : '○ STOPPED',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                    color: running ? AppTheme.green : AppTheme.textFaint,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _mcpLastConnectedText(),
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 10.5, color: AppTheme.textFaint),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          _buildToggleRow(
            title: 'Enable MCP Server',
            subtitle: 'Port 48191 · Muse can use 27 tools',
            value: enabled,
            onChanged: _toggleMcp,
          ),
          const SizedBox(height: 10),
          Text('CONNECTION URL (TAILSCALE)', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.8, color: AppTheme.textFaint)),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(
                child: Container(
                  height: 32,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  decoration: BoxDecoration(
                    color: AppTheme.inputBg,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppTheme.borderSoft),
                  ),
                  alignment: Alignment.centerLeft,
                  child: Text(url, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: AppTheme.textMain)),
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: _copyMcpUrl,
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppTheme.textMain,
                  backgroundColor: AppTheme.overlay10,
                  side: BorderSide(color: AppTheme.borderSoft),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                  visualDensity: VisualDensity.compact,
                ),
                child: const Text('Copy', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text('ACCESS TOKEN', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.8, color: AppTheme.textFaint)),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(
                child: Container(
                  height: 32,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  decoration: BoxDecoration(
                    color: AppTheme.inputBg,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppTheme.borderSoft),
                  ),
                  alignment: Alignment.centerLeft,
                  child: Text(tokenMasked, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: AppTheme.textMain)),
                ),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: _copyMcpToken,
                child: Text('Copy Token', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.accentText)),
              ),
              TextButton(
                onPressed: _mcpBusy ? null : _regenMcpToken,
                child: Text('Regenerate', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.accentText)),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: toolLabels.map((t) {
              return Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: AppTheme.accentGold.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppTheme.borderSoft),
                ),
                child: Text(t, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: AppTheme.accentText)),
              );
            }).toList(),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _copyMcpConfig,
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.accentGold,
                foregroundColor: Colors.black,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                visualDensity: VisualDensity.compact,
              ),
              child: const Text('Copy Muse Config', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold)),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            _mcpFeedback.isNotEmpty
                ? _mcpFeedback
                : 'Cookies & passwords are never shared. Starting a generation always asks for approval.',
            style: TextStyle(fontSize: 9.5, color: AppTheme.textFaint),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final prov = context.watch<SettingsProvider>();
    // Notification Center: the ON/OFF toggle lives in the
    // Automation panel and is owned by NotificationsProvider.
    final notifProv = context.watch<NotificationsProvider>();
    final s = prov.settings;

    // v2.27.0 (design): TWO-COLUMN settings layout — Appearance +
    // Defaults on the left, Updates + Automation on the right, then
    // the full-width About strip and the Created By panel. Every
    // existing control is kept, only redistributed.
    // v2.34.0 (Problem 13, owner-FINAL Sample A): the grid is now
    // Appearance | Defaults, Automation | Files & Paths, Updates |
    // MCP Connection, with an About BAR along the bottom — each
    // row's two cards share one height and one heading style.
    final appearancePanel = _buildPanel(
            title: '🎨 APPEARANCE',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // v2.31.2 (owner-approved design Option A, Compact
                // Cards): one slim segmented mode row, a compact 5×2
                // theme grid and a single closing note, so this panel
                // is finally the same height class as the other
                // Settings boxes instead of towering over them.
                _buildModeSegment(prov, s),
                const SizedBox(height: 10),
                Text(
                  'THEME',
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.8, color: AppTheme.textFaint),
                ),
                const SizedBox(height: 6),
                _buildThemeGrid(prov, s),
                const SizedBox(height: 8),
                Text(
                  'Your choice is saved and kept after the app restarts.',
                  style: TextStyle(fontSize: 10.5, color: AppTheme.textFaint),
                ),
              ],
            ),
          );

    final defaultsPanel = _buildPanel(
            title: '⚙ DEFAULTS',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Dropdown grid (Sample A): MODEL | DURATION,
                // ASPECT | QUALITY, FILE NAMING — v2.34.0 adds the
                // Quality control (Problem 11): the setting existed
                // and was sent on every run, but no control anywhere
                // could change it.
                Column(
                  children: [
                    Row(
                      children: [
                        Expanded(
                      child: _buildDropdown(
                        label: 'MODEL',
                        value: s.model,
                        items: ['Omni Flash', 'Veo 3.1 Fast', 'Veo 3.1 Lite', 'Veo 3.1 Quality'],
                        onChanged: (v) => prov.updateModel(v!),
                      ),
                    ),
                        const SizedBox(width: 8),
                        Expanded(
                      child: _buildDropdown(
                        label: 'DURATION',
                        value: s.duration,
                        items: ['4s', '6s', '8s', '10s'],
                        onChanged: (v) => prov.updateDuration(v!),
                      ),
                    ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                      child: _buildDropdown(
                        label: 'ASPECT',
                        value: s.aspectRatio,
                        items: ['9:16', '16:9', '1:1'],
                        onChanged: (v) => prov.updateAspectRatio(v!),
                      ),
                    ),
                        const SizedBox(width: 8),
                        Expanded(
                      child: _buildDropdown(
                        label: 'QUALITY',
                        value: s.quality,
                        // (Fix list 2026-10-27, item 7): mirror
                        // Flow — 360p and 720p are the generation
                        // qualities; 1080p is Flow's ENHANCED
                        // (upscaled) variant, chosen in the
                        // download menu, never a generation
                        // resolution. The engine's native download
                        // path now honours exactly this split.
                        items: const ['360p', '720p', '1080p'],
                        labels: const {'1080p': '1080p (enhanced)'},
                        onChanged: (v) => prov.updateQuality(v!),
                      ),
                    ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                      child: _buildDropdown(
                        label: 'FILE NAMING',
                        value: s.namingPattern,
                        items: ['tag', 'scene'],
                        labels: {'tag': 'By tag name (00-01.mp4)', 'scene': 'Old way (scene001.mp4)'},
                        onChanged: (v) => prov.updateNamingPattern(v!),
                      ),
                    ),
                        const SizedBox(width: 8),
                        const Expanded(child: SizedBox()),
                      ],
                    ),
                  ],
                ),

                const SizedBox(height: 6),
                // Item 7: say plainly what the quality choice does,
                // so the 1080p entry never reads as a generation
                // resolution it is not.
                Text(
                  '360p and 720p download the video as generated; 1080p picks Flow\'s enhanced (upscaled) download when Flow offers it.',
                  style: TextStyle(fontSize: 9.5, color: AppTheme.textFaint),
                ),

                const SizedBox(height: _sectionGap),

                // Custom Tags
                Text(
                  'CUSTOM TAGS',
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.8, color: AppTheme.textFaint),
                ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: s.customTags.map((t) {
                    final isDefaultNone = t == 'None';
                    return Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: AppTheme.accentGold.withValues(alpha: 0.10),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppTheme.borderSoft),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(t, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: AppTheme.accentText)),
                          if (!isDefaultNone) ...[
                            const SizedBox(width: 4),
                            InkWell(
                              onTap: () => prov.removeCustomTag(t),
                              child: Icon(Icons.close, size: 12, color: AppTheme.textFaint),
                            ),
                          ],
                        ],
                      ),
                    );
                  }).toList(),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: Container(
                        height: 32,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        decoration: BoxDecoration(
                          color: AppTheme.inputBg,
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: AppTheme.borderSoft),
                        ),
                        child: TextField(
                          controller: _customTagController,
                          textAlignVertical: TextAlignVertical.center,
                          style: TextStyle(fontSize: 11.5, color: AppTheme.textMain),
                          decoration: InputDecoration(
                            hintText: 'Type a new tag name...',
                            hintStyle: TextStyle(fontSize: 11, color: AppTheme.textFaint),
                            border: InputBorder.none,
                            isDense: true,
                            contentPadding: EdgeInsets.zero,
                          ),
                          onSubmitted: (val) {
                            if (val.trim().isNotEmpty) {
                              prov.addCustomTag(val.trim());
                              _customTagController.clear();
                            }
                          },
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    ElevatedButton(
                      onPressed: () {
                        if (_customTagController.text.trim().isNotEmpty) {
                          prov.addCustomTag(_customTagController.text.trim());
                          _customTagController.clear();
                        }
                      },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppTheme.accentGold,
                        foregroundColor: Colors.black,
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                        visualDensity: VisualDensity.compact,
                      ),
                      child: const Text('Add', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  'These tags appear in the TAG list at the top of the Generate page. A video is saved with its tag as the file name; a prompt with no tag is saved by its number (01.mp4, 02.mp4...).',
                  style: TextStyle(fontSize: 9.5, color: AppTheme.textFaint),
                ),
              ],
            ),
          );

    // v2.34.0 (Problem 13, Sample A): the two path pickers move out
    // of Defaults into their own Files & Paths card, paired with
    // Automation in the grid.
    final filesPathsPanel = _buildPanel(
            title: '🗂 FILES & PATHS',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Output Folder
                _buildPathPicker(
                  label: 'Output folder',
                  controller: _folderController,
                  buttonText: 'Browse...',
                  onBrowse: _pickOutputFolder,
                ),

                const SizedBox(height: 10),

                // Chrome Path
                _buildPathPicker(
                  label: 'Chrome path (leave empty = auto-detect)',
                  controller: _chromeController,
                  placeholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                  buttonText: 'Browse...',
                  onBrowse: _pickChromeFile,
                ),

                const SizedBox(height: 8),
                Text(
                  'Project runs save into their own subfolder inside the output folder.',
                  style: TextStyle(fontSize: 9.5, color: AppTheme.textFaint),
                ),
              ],
            ),
          );

    // The four Automation toggles, stacked in the half-width panel
    // (Sample A's grid pairs Automation with Files & Paths).
    final tglShowBrowsers = _buildToggleRow(
      title: 'Show Browsers',
      subtitle: 'ON = browsers open on screen while generating, so you can watch the work. OFF = they work hidden in the background.',
      value: s.showBrowsers,
      onChanged: (v) => prov.toggleShowBrowsers(v),
    );
    final tglPreviewAutoplay = _buildToggleRow(
      title: 'Preview autoplay',
      subtitle: 'The video starts playing as soon as the preview window opens',
      value: s.previewAutoplay,
      onChanged: (v) => prov.togglePreviewAutoplay(v),
    );
    final tglAutoVerify = _buildToggleRow(
      title: 'Run Verify All when the app starts',
      subtitle: 'Checks every account live in the background (this can take a little time)',
      value: s.autoVerifyOnStart,
      onChanged: (v) => prov.toggleAutoVerify(v),
    );
    // v2.27.0: moved here from the sidebar (design).
    final tglOnlyLive = _buildToggleRow(
      title: 'Only run live accounts',
      subtitle: 'Only Live accounts take part in generation; other accounts are skipped.',
      value: s.onlyRunLiveAccounts,
      onChanged: (v) => prov.toggleOnlyRunLiveAccounts(v),
    );
    // Notification Center: master switch for the bell, the popup
    // and storing — OFF means nothing is shown and nothing is
    // saved (NotificationsProvider, engine key
    // 'notifications_enabled').
    final tglNotifications = _buildToggleRow(
      title: 'Notifications',
      subtitle: 'Bell, popup and list for run results, errors, low credits and login problems. OFF = nothing is shown or stored.',
      value: notifProv.enabled,
      onChanged: (v) => notifProv.setEnabled(v),
    );

    final automationPanel = _buildPanel(
            title: '🤖 AUTOMATION',
            child: Column(
              children: [
                tglShowBrowsers,
                Divider(color: AppTheme.borderSoft, height: 16),
                tglPreviewAutoplay,
                Divider(color: AppTheme.borderSoft, height: 16),
                tglAutoVerify,
                Divider(color: AppTheme.borderSoft, height: 16),
                tglOnlyLive,
                Divider(color: AppTheme.borderSoft, height: 16),
                tglNotifications,
              ],
            ),
          );

    final updatesPanel = _buildPanel(
            title: '🔔 UPDATES',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: AppTheme.accentGold.withValues(alpha: 0.10),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AppTheme.accentGold.withValues(alpha: 0.5)),
                      ),
                      child: Text(
                        s.currentVersion,
                        style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.accentText),
                      ),
                    ),
                    const SizedBox(width: 8),
                    // v2.27.0: Flexible instead of Spacer so this row
                    // also fits the narrower two-column panel.
                    Expanded(
                      child: Text('— current version', overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: AppTheme.textFaint)),
                    ),
                    ElevatedButton.icon(
                      onPressed: prov.isCheckingUpdates ? null : () => prov.checkForUpdates(),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppTheme.accentGold,
                        foregroundColor: Colors.black,
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                        visualDensity: VisualDensity.compact,
                      ),
                      icon: prov.isCheckingUpdates
                          ? const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black))
                          : const Icon(Icons.refresh, size: 14),
                      label: const Text('Check for Updates', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(prov.updateStatusMessage, style: TextStyle(fontSize: 10.5, color: AppTheme.textDim)),
                // v2.23.0: in-app updater controls — download + install
                // happen right here; no manual GitHub trip.
                if (prov.updateAvailable && prov.downloadedSetupPath.isEmpty) ...[
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      ElevatedButton.icon(
                        onPressed: prov.isDownloadingUpdate ? null : () => prov.downloadUpdate(),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppTheme.accentGold,
                          foregroundColor: Colors.black,
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                          visualDensity: VisualDensity.compact,
                        ),
                        icon: const Icon(Icons.download, size: 14),
                        label: Text(
                          prov.isDownloadingUpdate
                              ? 'Downloading...'
                              : 'Download update${prov.updateSizeLabel.isNotEmpty ? ' (${prov.updateSizeLabel})' : ''}',
                          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold),
                        ),
                      ),
                      if (prov.isDownloadingUpdate) ...[
                        const SizedBox(width: 10),
                        Expanded(
                          child: LinearProgressIndicator(
                            value: prov.updateDownloadProgress > 0 ? prov.updateDownloadProgress : null,
                            color: AppTheme.accentGold,
                            backgroundColor: AppTheme.borderSoft,
                            minHeight: 5,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          '${(prov.updateDownloadProgress * 100).toStringAsFixed(0)}%',
                          style: TextStyle(fontSize: 11, color: AppTheme.textDim),
                        ),
                      ],
                    ],
                  ),
                ],
                if (prov.downloadedSetupPath.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  // v2.27.0: FittedBox so the long install label also
                  // fits the narrower two-column Updates panel.
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: ElevatedButton.icon(
                    onPressed: () => prov.installDownloadedUpdate(),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppTheme.accentGold,
                      foregroundColor: Colors.black,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                      visualDensity: VisualDensity.compact,
                    ),
                    icon: const Icon(Icons.system_update, size: 14),
                    label: const Text('Install update — the app will close & update itself', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                    ),
                  ),
                ],
                const SizedBox(height: 8),
                _buildToggleRow(
                  title: 'Check automatically',
                  subtitle: 'The app checks for updates on its own when it starts, and tells you when a new version is ready',
                  value: s.autoCheckUpdates,
                  onChanged: (v) => prov.toggleAutoUpdate(v),
                ),
              ],
            ),
          );

    final mcpPanel = _buildMcpPanel();

    // v2.34.0 (Problem 13, Sample A): About is a full-width BAR
    // along the bottom — logo + version on the left, the account /
    // video stats and the social icons on the right — not another
    // tall card. (The old card's "Design" row is gone: themes live
    // in the Appearance card directly above.)
    final aboutPanel = Container(
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
          Text(
            '📋 ABOUT',
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.3,
              color: AppTheme.textDim,
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                  gradient: AppTheme.accentGrad,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Image.asset(
                    'assets/icon.png',
                    width: 30,
                    height: 30,
                    fit: BoxFit.contain,
                    errorBuilder: (ctx, err, st) => Center(
                      child: Icon(Icons.play_arrow_rounded, size: 20, color: AppTheme.onAccent),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    'FlowStudio Lite ${s.currentVersion}',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppTheme.textMain),
                  ),
                  Text(
                    'Multi-Account Flow Studio — About',
                    style: TextStyle(fontSize: 10.5, color: AppTheme.textFaint),
                  ),
                ],
              ),
              const Spacer(),
              Flexible(
                child: Text(
                  '${prov.totalAccounts} account${prov.totalAccounts == 1 ? '' : 's'} · ${prov.totalVideosSaved} videos all-time · Created by MK',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.right,
                  style: TextStyle(fontSize: 11, color: AppTheme.textDim),
                ),
              ),
              // v2.34.0 (Problem 12): the About social icons render
              // only for usable links — same rule as the top strip.
              if (isUsableSocialLink(s.whatsAppLink)) ...[
                const SizedBox(width: 10),
                InkWell(
                  onTap: () => prov.openSocial('whatsapp'),
                  borderRadius: BorderRadius.circular(12),
                  child: Padding(
                    padding: const EdgeInsets.all(4),
                    child: Icon(Icons.chat_bubble, size: 18, color: AppTheme.whatsApp),
                  ),
                ),
              ],
              if (isUsableSocialLink(s.chatLink)) ...[
                const SizedBox(width: 6),
                InkWell(
                  onTap: () => prov.openSocial('chat'),
                  borderRadius: BorderRadius.circular(12),
                  child: Padding(
                    padding: const EdgeInsets.all(4),
                    child: Icon(Icons.message_outlined, size: 18, color: AppTheme.textDim),
                  ),
                ),
              ],
              if (isUsableSocialLink(s.supportLink)) ...[
                const SizedBox(width: 6),
                InkWell(
                  onTap: () => prov.openSocial('support'),
                  borderRadius: BorderRadius.circular(12),
                  child: Padding(
                    padding: const EdgeInsets.all(4),
                    child: Icon(Icons.headphones_outlined, size: 18, color: AppTheme.textDim),
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );

    final createdByPanel = _buildPanel(
            title: 'CREATED BY',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text('MK', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w900, color: AppTheme.textMain)),
                    // v2.34.0 (Problem 12): these icons render only
                    // when the link saved below is usable — the
                    // editors stay, so a real link can always be
                    // typed in and the icon then appears.
                    if (isUsableSocialLink(s.whatsAppLink)) ...[
                      const SizedBox(width: 14),
                      InkWell(
                        onTap: () => prov.openSocial('whatsapp'),
                        borderRadius: BorderRadius.circular(12),
                        child: Padding(
                          padding: const EdgeInsets.all(4),
                          child: Icon(Icons.chat_bubble, size: 18, color: AppTheme.whatsApp),
                        ),
                      ),
                    ],
                    if (isUsableSocialLink(s.chatLink)) ...[
                      const SizedBox(width: 8),
                      InkWell(
                        onTap: () => prov.openSocial('chat'),
                        borderRadius: BorderRadius.circular(12),
                        child: Padding(
                          padding: const EdgeInsets.all(4),
                          child: Icon(Icons.message_outlined, size: 18, color: AppTheme.textDim),
                        ),
                      ),
                    ],
                    if (isUsableSocialLink(s.supportLink)) ...[
                      const SizedBox(width: 8),
                      InkWell(
                        onTap: () => prov.openSocial('support'),
                        borderRadius: BorderRadius.circular(12),
                        child: Padding(
                          padding: const EdgeInsets.all(4),
                          child: Icon(Icons.headphones_outlined, size: 18, color: AppTheme.textDim),
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 10),
                _buildTextInputRow('WhatsApp link', _whatsappController, onChanged: (v) {
                  prov.updateSocialLinks(whatsapp: v);
                }),
                const SizedBox(height: 6),
                _buildTextInputRow('Chat link', _chatController, onChanged: (v) {
                  prov.updateSocialLinks(chat: v);
                }),
                const SizedBox(height: 6),
                _buildTextInputRow('Support link', _supportController, onChanged: (v) {
                  prov.updateSocialLinks(support: v);
                }),
                const SizedBox(height: 6),
                Text(
                  'These links open from the icons — in the top strip on a big screen, and in this box on a small (mobile-size) screen.',
                  style: TextStyle(fontSize: 9.5, color: AppTheme.textFaint),
                ),
              ],
            ),
          );

    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: _sectionGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // (Fix list 2026-10-27, item 5): a clear way BACK — the
          // settings page used to be a one-way door (only the
          // sidebar could leave it). Same chip as History's back
          // control, returning to the Generate view through the
          // app's existing view switching.
          Row(
            children: [
              InkWell(
                onTap: () => prov.setNavView('generate'),
                borderRadius: BorderRadius.circular(7),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(
                    color: AppTheme.accentGold.withValues(alpha: 0.07),
                    borderRadius: BorderRadius.circular(7),
                    border: Border.all(color: AppTheme.accentGold.withValues(alpha: 0.55)),
                  ),
                  child: Text(
                    '← Back to Generate',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.accentText,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Text(
                'Settings',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textMain,
                ),
              ),
            ],
          ),
          const SizedBox(height: _sectionGap),
          // Responsive pass: the two columns stack into ONE column
          // when the content area is narrow (<700) so no panel is
          // ever squeezed; the page scrolls, as it already could.
          LayoutBuilder(
            builder: (context, constraints) {
              // v2.34.0 (Problem 13, owner-FINAL Sample A): the
              // wide layout is a strict two-column GRID —
              // Appearance | Defaults, Automation | Files & Paths,
              // Updates | MCP Connection — and each row's two cards
              // share the SAME height, with identical
              // padding/radius/heading style and aligned tops.
              // v2.34.1 HOTFIX: the equal height comes from a
              // one-row Table with intrinsicHeight cells. The
              // v2.34.0 version used fill cells, but a RenderTable
              // row's height accumulates only from NON-fill cells,
              // so every all-fill row collapsed to height 0 and the
              // whole grid rendered invisible (only About +
              // Created By showed). intrinsicHeight is safe now
              // because the Appearance card's theme grid no longer
              // contains a shrink-wrapping GridView (it is plain
              // Rows of cards — see _buildThemeGrid), so every
              // cell can answer intrinsic heights. Below 700 the
              // panels stack in that same reading order and the
              // page scrolls (as it already could).
              Widget pair(Widget a, Widget b) => Table(
                    columnWidths: const {
                      0: FlexColumnWidth(1),
                      1: FixedColumnWidth(12),
                      2: FlexColumnWidth(1),
                    },
                    defaultVerticalAlignment:
                        TableCellVerticalAlignment.intrinsicHeight,
                    children: [
                      TableRow(children: [a, const SizedBox(), b]),
                    ],
                  );
              if (constraints.maxWidth < 700) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    appearancePanel,
                    const SizedBox(height: _sectionGap),
                    defaultsPanel,
                    const SizedBox(height: _sectionGap),
                    automationPanel,
                    const SizedBox(height: _sectionGap),
                    filesPathsPanel,
                    const SizedBox(height: _sectionGap),
                    updatesPanel,
                    const SizedBox(height: _sectionGap),
                    mcpPanel,
                  ],
                );
              }
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  pair(appearancePanel, defaultsPanel),
                  const SizedBox(height: _sectionGap),
                  pair(automationPanel, filesPathsPanel),
                  const SizedBox(height: _sectionGap),
                  pair(updatesPanel, mcpPanel),
                ],
              );
            },
          ),
          const SizedBox(height: _sectionGap),
          aboutPanel,
          const SizedBox(height: _sectionGap),
          createdByPanel,
          const SizedBox(height: _sectionGap),
        ],
      ),
    );
  }

  Widget _buildPanel({required String title, required Widget child}) {
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
          // v2.34.0 (Problem 13, Sample A): ONE heading style for
          // every section — small-caps, letter-spaced, dim — so no
          // card shouts louder than its neighbour.
          Text(
            title,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.3,
              color: AppTheme.textDim,
            ),
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }

  // v2.31.2 (owner-approved design Option A): the 10 themes in a
  // compact 5×2 grid of small cards at a FIXED row height, so the
  // grid is always two short rows whatever width the panel gets.
  // Previews are still drawn from each family's palette for the
  // CURRENTLY APPLIED mode (AppTheme.dark), so flipping Dark/Light
  // re-renders every card in that mode's colours.
  // v2.34.1 HOTFIX: the grid is built from plain Rows of Expanded
  // cards instead of a shrink-wrapping GridView. A viewport widget
  // cannot answer intrinsic heights, and the Settings pair() rows
  // now size themselves intrinsically (see build) — a GridView
  // inside a cell was the poison that forced the broken Table in
  // v2.34.0. Same look: 5 cards per row, 48px row height, 6px
  // gaps, identical cards.
  Widget _buildThemeGrid(SettingsProvider prov, AppSettings s) {
    final ids = AppTheme.themeIds;
    final rows = <Widget>[];
    for (var start = 0; start < ids.length; start += 5) {
      if (rows.isNotEmpty) rows.add(const SizedBox(height: 6));
      final end = start + 5 > ids.length ? ids.length : start + 5;
      final rowIds = ids.sublist(start, end);
      rows.add(
        SizedBox(
          height: 48,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < rowIds.length; i++) ...[
                if (i > 0) const SizedBox(width: 6),
                Expanded(child: _buildThemeCardCompact(prov, s, rowIds[i])),
              ],
            ],
          ),
        ),
      );
    }
    return Column(mainAxisSize: MainAxisSize.min, children: rows);
  }

  // v2.31.2 compact theme card (approved Option A): a 20px palette
  // preview chip with the theme name in ONE line under it (ellipsis
  // at the narrowest widths), and the family's accent ring when
  // selected — same tap behaviour as the old tall card.
  Widget _buildThemeCardCompact(SettingsProvider prov, AppSettings s, String id) {
    final pal = AppTheme.paletteFor(id, AppTheme.dark);
    final selected = s.theme == id;
    return InkWell(
      onTap: () => prov.setTheme(id),
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: AppTheme.surfaceElevated,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: selected ? pal.accentGold : AppTheme.borderSoft,
            width: selected ? 2 : 1,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(height: 20, child: _buildThemePreviewCompact(pal)),
            const SizedBox(height: 3),
            Text(
              AppTheme.themeNames[id] ?? id,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: TextStyle(
                // 9px (inside the approved 8.5–10 range) so even the
                // longest names ("Graphite + White") show in full in
                // the ~87px cells of the 1024-wide two-column layout;
                // the ellipsis only bites at far narrower widths.
                fontSize: 9,
                fontWeight: selected ? FontWeight.bold : FontWeight.w600,
                color: selected ? AppTheme.textMain : AppTheme.textDim,
              ),
            ),
          ],
        ),
      ),
    );
  }

  // Compact preview chip for the v2.31.2 theme cards: the same
  // palette story as the old full preview (gradient body, surface
  // sidebar strip with the accent bar and gold ACTIVE dot, an input
  // box and an accent bar) drawn at a fixed 20px height.
  Widget _buildThemePreviewCompact(AppPalette pal) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [pal.bg2, pal.bgBody],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(5),
        border: Border.all(color: pal.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: 14,
            color: pal.surface,
            padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 2),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(height: 3, decoration: BoxDecoration(color: pal.accentGold, borderRadius: BorderRadius.circular(2))),
                const SizedBox(height: 3),
                Center(
                  child: Container(
                    width: 5,
                    height: 5,
                    decoration: BoxDecoration(color: pal.activeGold, shape: BoxShape.circle),
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Container(
                    height: 5,
                    decoration: BoxDecoration(
                      color: pal.inputBg,
                      borderRadius: BorderRadius.circular(2),
                      border: Border.all(color: pal.borderSoft),
                    ),
                  ),
                  const SizedBox(height: 3),
                  Container(
                    height: 3,
                    decoration: BoxDecoration(color: pal.accentGold.withValues(alpha: 0.8), borderRadius: BorderRadius.circular(2)),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  // v2.31.2 (approved Option A): the Dark/Light/System mode picker
  // as ONE slim segmented row — a rounded track with three equal
  // segments; the selected segment lifts on a solid elevated
  // surface with a soft shadow. Same values and provider call as
  // the old mode buttons ('dark', 'white', 'system').
  Widget _buildModeSegment(SettingsProvider prov, AppSettings s) {
    Widget segment(String label, String value) {
      final isActive = s.appearance == value;
      return Expanded(
        child: InkWell(
          onTap: () => prov.updateAppearance(value),
          borderRadius: BorderRadius.circular(7),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 5),
            decoration: BoxDecoration(
              color: isActive ? AppTheme.surfaceElevated : null,
              borderRadius: BorderRadius.circular(7),
              boxShadow: isActive
                  ? [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: AppTheme.dark ? 0.4 : 0.14),
                        blurRadius: 4,
                        offset: const Offset(0, 1),
                      ),
                    ]
                  : null,
            ),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 11,
                fontWeight: isActive ? FontWeight.bold : FontWeight.w600,
                color: isActive ? AppTheme.textMain : AppTheme.textDim,
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: AppTheme.overlay08,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.borderSoft),
      ),
      child: Row(
        children: [
          segment('🌙 Dark', 'dark'),
          segment('☀️ Light', 'white'),
          segment('💻 System', 'system'),
        ],
      ),
    );
  }

  Widget _buildDropdown({
    required String label,
    required String value,
    required List<String> items,
    Map<String, String>? labels,
    required ValueChanged<String?> onChanged,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppTheme.textFaint)),
        const SizedBox(height: 4),
        Container(
          height: 32,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          decoration: BoxDecoration(
            color: AppTheme.inputBg,
            borderRadius: BorderRadius.circular(6),
            border: Border.all(color: AppTheme.borderSoft),
          ),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<String>(
              value: items.contains(value) ? value : items.first,
              dropdownColor: AppTheme.surfaceElevated,
              isExpanded: true,
              // v2.30.0: dense + left-aligned so the value sits on
              // the box's vertical centre (it rode high in its 32px
              // box before), and long values clip with an ellipsis
              // INSIDE the box instead of pushing out of it.
              isDense: true,
              alignment: Alignment.centerLeft,
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.textMain),
              icon: Icon(Icons.keyboard_arrow_down, size: 14, color: AppTheme.textDim),
              items: items.map((item) {
                return DropdownMenuItem(
                  value: item,
                  child: Text(
                    labels != null && labels.containsKey(item) ? labels[item]! : item,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
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

  Widget _buildPathPicker({
    required String label,
    required TextEditingController controller,
    required String buttonText,
    required VoidCallback onBrowse,
    String placeholder = '',
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppTheme.textFaint)),
        const SizedBox(height: 4),
        Row(
          children: [
            Expanded(
              child: Container(
                height: 32,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                decoration: BoxDecoration(
                  color: AppTheme.inputBg,
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: AppTheme.borderSoft),
                ),
                child: TextField(
                  controller: controller,
                  readOnly: true,
                  // v2.30.0: centre the text in its 32px box (it
                  // sat high before — "upar-nicha" in the owner's
                  // words).
                  textAlignVertical: TextAlignVertical.center,
                  style: TextStyle(fontSize: 11, color: AppTheme.textMain),
                  decoration: InputDecoration(
                    hintText: placeholder,
                    hintStyle: TextStyle(fontSize: 11, color: AppTheme.textFaint),
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            OutlinedButton(
              onPressed: onBrowse,
              style: OutlinedButton.styleFrom(
                foregroundColor: AppTheme.textMain,
                backgroundColor: AppTheme.overlay10,
                side: BorderSide(color: AppTheme.borderSoft),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                visualDensity: VisualDensity.compact,
              ),
              child: Text(buttonText, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildToggleRow({
    required String title,
    required String subtitle,
    required bool value,
    required ValueChanged<bool> onChanged,
  }) {
    // v2.30.0 (owner: "text upar-nicha ho raha hai"): the row is
    // CENTER-aligned now — the title/subtitle block and the switch
    // share one vertical centre instead of the text starting at the
    // top while the switch floated lower. The switch also gets
    // shrinkWrap tap targets so its layout height matches its
    // visible size.
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(title, style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.textMain)),
              const SizedBox(height: 2),
              Text(subtitle, style: TextStyle(fontSize: 9.5, color: AppTheme.textFaint)),
            ],
          ),
        ),
        Transform.scale(
          scale: 0.7,
          child: Switch(
            value: value,
            activeThumbColor: AppTheme.accentGold,
            activeTrackColor: AppTheme.accentGold.withValues(alpha: 0.25),
            inactiveTrackColor: AppTheme.borderSoft,
            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            onChanged: onChanged,
          ),
        ),
      ],
    );
  }

  Widget _buildTextInputRow(String label, TextEditingController controller, {ValueChanged<String>? onChanged}) {
    return Row(
      children: [
        SizedBox(
          width: 90,
          child: Text(label, style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppTheme.textFaint)),
        ),
        Expanded(
          child: Container(
            height: 28,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            decoration: BoxDecoration(
              color: AppTheme.inputBg,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: AppTheme.borderSoft),
            ),
            child: TextField(
              controller: controller,
              textAlignVertical: TextAlignVertical.center,
              style: TextStyle(fontSize: 10.5, color: AppTheme.textMain),
              decoration: const InputDecoration(border: InputBorder.none, isDense: true, contentPadding: EdgeInsets.zero),
              onChanged: onChanged,
            ),
          ),
        ),
      ],
    );
  }
}
