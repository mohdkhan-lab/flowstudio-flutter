import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:file_picker/file_picker.dart';
import '../theme/app_theme.dart';
import '../models/app_settings.dart';
import '../providers/settings_provider.dart';

class SettingsView extends StatefulWidget {
  const SettingsView({super.key});

  @override
  State<SettingsView> createState() => _SettingsViewState();
}

class _SettingsViewState extends State<SettingsView> {
  final TextEditingController _customTagController = TextEditingController();
  final TextEditingController _folderController = TextEditingController();
  final TextEditingController _chromeController = TextEditingController();
  final TextEditingController _whatsappController = TextEditingController();
  final TextEditingController _chatController = TextEditingController();
  final TextEditingController _supportController = TextEditingController();

  @override
  void initState() {
    super.initState();
    final s = context.read<SettingsProvider>().settings;
    _folderController.text = s.outputDirectory;
    _chromeController.text = s.chromePath;
    _whatsappController.text = s.whatsAppLink;
    _chatController.text = s.chatLink;
    _supportController.text = s.supportLink;
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

  @override
  Widget build(BuildContext context) {
    final prov = context.watch<SettingsProvider>();
    final s = prov.settings;

    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 1. Appearance Panel
          _buildPanel(
            title: '🎨 Appearance',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Your chosen appearance is kept even after the app restarts.',
                  style: TextStyle(fontSize: 11, color: AppTheme.textFaint),
                ),
                const SizedBox(height: 10),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _buildAppearanceBtn(
                      '🌙 Dark',
                      'dark',
                      s.appearance == 'dark',
                      () => prov.updateAppearance('dark'),
                    ),
                    const SizedBox(width: 8),
                    _buildAppearanceBtn(
                      '☀️ Light',
                      'white',
                      s.appearance == 'white',
                      () => prov.updateAppearance('white'),
                    ),
                    const SizedBox(width: 8),
                    _buildAppearanceBtn(
                      '💻 System',
                      'system',
                      s.appearance == 'system',
                      () => prov.updateAppearance('system'),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                Text(
                  'THEME',
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.8, color: AppTheme.textFaint),
                ),
                const SizedBox(height: 3),
                Text(
                  'Every theme comes in Dark and Light — switching the mode keeps your theme.',
                  style: TextStyle(fontSize: 11, color: AppTheme.textFaint),
                ),
                const SizedBox(height: 8),
                _buildThemeGrid(prov, s),
              ],
            ),
          ),

          const SizedBox(height: 12),

          // 2. Defaults Panel
          _buildPanel(
            title: '⚙ Defaults',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // 4 Dropdowns
                Row(
                  children: [
                    Expanded(
                      child: _buildDropdown(
                        label: 'Default Model',
                        value: s.model,
                        items: ['Omni Flash', 'Veo 3.1 Fast', 'Veo 3.1 Lite', 'Veo 3.1 Quality'],
                        onChanged: (v) => prov.updateModel(v!),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _buildDropdown(
                        label: 'Default Duration',
                        value: s.duration,
                        items: ['4s', '6s', '8s', '10s'],
                        onChanged: (v) => prov.updateDuration(v!),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _buildDropdown(
                        label: 'Default Aspect',
                        value: s.aspectRatio,
                        items: ['9:16', '16:9', '1:1'],
                        onChanged: (v) => prov.updateAspectRatio(v!),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _buildDropdown(
                        label: 'Default File Name',
                        value: s.namingPattern,
                        items: ['tag', 'scene'],
                        labels: {'tag': 'By tag name (00-01.mp4)', 'scene': 'Old way (scene001.mp4)'},
                        onChanged: (v) => prov.updateNamingPattern(v!),
                      ),
                    ),
                  ],
                ),

                const SizedBox(height: 14),

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
                        color: const Color(0x1A0A84FF),
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
                          style: TextStyle(fontSize: 11.5, color: AppTheme.textMain),
                          decoration: InputDecoration(
                            hintText: 'Type a new tag name...',
                            hintStyle: TextStyle(fontSize: 11, color: AppTheme.textFaint),
                            border: InputBorder.none,
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

                const SizedBox(height: 14),

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
              ],
            ),
          ),

          const SizedBox(height: 12),

          // 3. Automation Panel
          _buildPanel(
            title: '🤖 Automation',
            child: Column(
              children: [
                _buildToggleRow(
                  title: 'Show Browsers',
                  subtitle: 'ON = browsers open on screen while generating, so you can watch the work. OFF = they work hidden in the background.',
                  value: s.showBrowsers,
                  onChanged: (v) => prov.toggleShowBrowsers(v),
                ),
                Divider(color: AppTheme.borderSoft, height: 16),
                _buildToggleRow(
                  title: 'Preview autoplay',
                  subtitle: 'The video starts playing as soon as the preview window opens',
                  value: s.previewAutoplay,
                  onChanged: (v) => prov.togglePreviewAutoplay(v),
                ),
                Divider(color: AppTheme.borderSoft, height: 16),
                _buildToggleRow(
                  title: 'Run Verify All when the app starts',
                  subtitle: 'Checks every account live in the background (this can take a little time)',
                  value: s.autoVerifyOnStart,
                  onChanged: (v) => prov.toggleAutoVerify(v),
                ),
              ],
            ),
          ),

          const SizedBox(height: 12),

          // 4. Updates Panel
          _buildPanel(
            title: '🔔 Updates',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: const Color(0x1A0A84FF),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AppTheme.accentGold.withValues(alpha: 0.5)),
                      ),
                      child: Text(
                        s.currentVersion,
                        style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.accentText),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text('— current version', style: TextStyle(fontSize: 11, color: AppTheme.textFaint)),
                    const Spacer(),
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
                  ElevatedButton.icon(
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
          ),

          const SizedBox(height: 12),

          // 5. About Panel (Replicated 1:1 from original FlowStudio Lite source)
          _buildPanel(
            title: '📋 About',
            child: Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppTheme.overlay08,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppTheme.borderSoft),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildAboutRow('Version', 'FlowStudio Lite ${s.currentVersion}'),
                  const SizedBox(height: 4),
                  _buildAboutRow('Accounts', '${prov.totalAccounts}'),
                  const SizedBox(height: 4),
                  _buildAboutRow('Total videos saved', '${prov.totalVideosSaved}'),
                  const SizedBox(height: 4),
                  _buildAboutRow('Design', 'macOS style — Soft Charcoal (Dark) + Creamy (Light) — change it above'),
                ],
              ),
            ),
          ),

          const SizedBox(height: 12),

          // 6. Created By & Links (Replicated 1:1 from original source)
          _buildPanel(
            title: 'CREATED BY',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text('MK', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w900, color: AppTheme.textMain)),
                    const SizedBox(width: 14),
                    InkWell(
                      onTap: () => prov.openSocial('whatsapp'),
                      borderRadius: BorderRadius.circular(12),
                      child: Padding(
                        padding: EdgeInsets.all(4),
                        child: Icon(Icons.chat_bubble, size: 18, color: AppTheme.whatsApp),
                      ),
                    ),
                    const SizedBox(width: 8),
                    InkWell(
                      onTap: () => prov.openSocial('chat'),
                      borderRadius: BorderRadius.circular(12),
                      child: Padding(
                        padding: EdgeInsets.all(4),
                        child: Icon(Icons.message_outlined, size: 18, color: AppTheme.textDim),
                      ),
                    ),
                    const SizedBox(width: 8),
                    InkWell(
                      onTap: () => prov.openSocial('support'),
                      borderRadius: BorderRadius.circular(12),
                      child: Padding(
                        padding: EdgeInsets.all(4),
                        child: Icon(Icons.headphones_outlined, size: 18, color: AppTheme.textDim),
                      ),
                    ),
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
          ),
          const SizedBox(height: 20),
        ],
      ),
    );
  }

  Widget _buildAboutRow(String label, String value) {
    return Row(
      children: [
        Text(
          '$label: ',
          style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.textMain),
        ),
        Text(
          value,
          style: TextStyle(fontSize: 11, color: AppTheme.textDim),
        ),
      ],
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
          Text(title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppTheme.textMain)),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }

  // v2.26.0: the 10-theme grid. Previews are drawn from each family's
  // palette for the CURRENTLY APPLIED mode (AppTheme.dark), so flipping
  // Dark/Light re-renders every card in that mode's colours.
  Widget _buildThemeGrid(SettingsProvider prov, AppSettings s) {
    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 5,
        mainAxisSpacing: 8,
        crossAxisSpacing: 8,
        childAspectRatio: 1.05,
      ),
      itemCount: AppTheme.themeIds.length,
      itemBuilder: (context, i) {
        final id = AppTheme.themeIds[i];
        return _buildThemeCard(prov, s, id);
      },
    );
  }

  Widget _buildThemeCard(SettingsProvider prov, AppSettings s, String id) {
    final pal = AppTheme.paletteFor(id, AppTheme.dark);
    final selected = s.theme == id;
    return InkWell(
      onTap: () => prov.setTheme(id),
      borderRadius: BorderRadius.circular(9),
      child: Container(
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          color: AppTheme.surfaceElevated,
          borderRadius: BorderRadius.circular(9),
          border: Border.all(
            color: selected ? pal.accentGold : AppTheme.borderSoft,
            width: selected ? 2 : 1,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: _buildThemePreview(pal, selected)),
            const SizedBox(height: 5),
            Row(
              children: [
                Expanded(
                  child: Text(
                    AppTheme.themeNames[id] ?? id,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: selected ? FontWeight.bold : FontWeight.w600,
                      color: selected ? AppTheme.textMain : AppTheme.textDim,
                    ),
                  ),
                ),
                if (id == 'macos') ...[
                  const SizedBox(width: 4),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                    decoration: BoxDecoration(
                      color: AppTheme.activeGold,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: const Text(
                      'Best',
                      style: TextStyle(fontSize: 8, fontWeight: FontWeight.w900, color: Color(0xFF231A00)),
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  // Mini app-window preview drawn purely from the palette: gradient body,
  // surface sidebar with an accent bar and the fixed gold ACTIVE dot,
  // an input box and an accent progress bar with fixed green/red dots.
  Widget _buildThemePreview(AppPalette pal, bool selected) {
    return Stack(
      children: [
        Container(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              colors: [pal.bg2, pal.bgBody],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: pal.border),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(7),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  width: 26,
                  color: pal.surface,
                  padding: const EdgeInsets.fromLTRB(5, 6, 5, 6),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Container(height: 4, decoration: BoxDecoration(color: pal.accentGold, borderRadius: BorderRadius.circular(2))),
                      const SizedBox(height: 4),
                      Container(height: 4, decoration: BoxDecoration(color: pal.textDim.withValues(alpha: 0.55), borderRadius: BorderRadius.circular(2))),
                      const SizedBox(height: 4),
                      Container(height: 4, decoration: BoxDecoration(color: pal.textDim.withValues(alpha: 0.35), borderRadius: BorderRadius.circular(2))),
                      const Spacer(),
                      Container(
                        width: 7,
                        height: 7,
                        decoration: BoxDecoration(color: pal.activeGold, shape: BoxShape.circle),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.all(6),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Container(
                          height: 15,
                          decoration: BoxDecoration(
                            color: pal.inputBg,
                            borderRadius: BorderRadius.circular(4),
                            border: Border.all(color: pal.borderSoft),
                          ),
                        ),
                        const SizedBox(height: 5),
                        Row(
                          children: [
                            Expanded(
                              child: Container(
                                height: 6,
                                decoration: BoxDecoration(color: pal.surfaceElevated, borderRadius: BorderRadius.circular(3)),
                                child: FractionallySizedBox(
                                  alignment: Alignment.centerLeft,
                                  widthFactor: 0.64,
                                  child: Container(
                                    decoration: BoxDecoration(color: pal.accentGold, borderRadius: BorderRadius.circular(3)),
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 5),
                            Container(
                              width: 16,
                              height: 8,
                              decoration: BoxDecoration(color: pal.accentGold, borderRadius: BorderRadius.circular(4)),
                            ),
                          ],
                        ),
                        const SizedBox(height: 5),
                        Row(
                          children: [
                            Container(width: 6, height: 6, decoration: BoxDecoration(color: pal.green, shape: BoxShape.circle)),
                            const SizedBox(width: 5),
                            Expanded(
                              child: Container(
                                height: 4,
                                decoration: BoxDecoration(color: pal.textDim.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(2)),
                              ),
                            ),
                            const SizedBox(width: 5),
                            Container(width: 6, height: 6, decoration: BoxDecoration(color: pal.red, shape: BoxShape.circle)),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        if (selected)
          Positioned(
            top: 3,
            right: 3,
            child: Container(
              width: 15,
              height: 15,
              decoration: BoxDecoration(color: pal.accentGold, shape: BoxShape.circle),
              child: const Icon(Icons.check, size: 10, color: Colors.white),
            ),
          ),
      ],
    );
  }

  Widget _buildAppearanceBtn(String label, String key, bool isActive, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          gradient: isActive ? AppTheme.accentGrad : null,
          color: isActive ? null : AppTheme.overlay08,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: isActive ? Colors.transparent : AppTheme.borderSoft),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11,
            fontWeight: isActive ? FontWeight.bold : FontWeight.w600,
            color: isActive ? AppTheme.onAccent : AppTheme.textDim,
          ),
        ),
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
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.textMain),
              icon: Icon(Icons.keyboard_arrow_down, size: 14, color: AppTheme.textDim),
              items: items.map((item) {
                return DropdownMenuItem(
                  value: item,
                  child: Text(labels != null && labels.containsKey(item) ? labels[item]! : item),
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
                  style: TextStyle(fontSize: 11, color: AppTheme.textMain),
                  decoration: InputDecoration(
                    hintText: placeholder,
                    hintStyle: TextStyle(fontSize: 11, color: AppTheme.textFaint),
                    border: InputBorder.none,
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
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
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
            activeTrackColor: const Color(0x400A84FF),
            inactiveTrackColor: AppTheme.borderSoft,
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
              style: TextStyle(fontSize: 10.5, color: AppTheme.textMain),
              decoration: const InputDecoration(border: InputBorder.none, contentPadding: EdgeInsets.zero),
              onChanged: onChanged,
            ),
          ),
        ),
      ],
    );
  }
}
