import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:file_picker/file_picker.dart';
import '../theme/app_theme.dart';
import '../providers/accounts_provider.dart';
import '../providers/settings_provider.dart';
import '../models/account.dart';
import '../services/automation_bridge.dart';

class SidebarAccounts extends StatefulWidget {
  const SidebarAccounts({super.key});

  @override
  State<SidebarAccounts> createState() => _SidebarAccountsState();
}

class _SidebarAccountsState extends State<SidebarAccounts> {
  String _selectedFilter = 'all'; // all, checking, live, fail
  bool _onlyRunLive = true;

  @override
  Widget build(BuildContext context) {
    final accountsProv = context.watch<AccountsProvider>();
    final settingsProv = context.watch<SettingsProvider>();
    final isGenerate = settingsProv.currentView == 'generate';
    final allAccounts = accountsProv.accounts;

    final checkingCount = allAccounts.where((a) => a.status == AccountStatus.checking).length;
    final liveCount = allAccounts.where((a) => a.credits > 0 && a.status == AccountStatus.ready).length;
    final failCount = allAccounts.where((a) => a.credits <= 0 || a.status == AccountStatus.outOfCredits || a.status == AccountStatus.error).length;

    final visibleAccounts = allAccounts.where((acc) {
      if (_selectedFilter == 'checking') return acc.status == AccountStatus.checking;
      if (_selectedFilter == 'live') return acc.credits > 0 && acc.status == AccountStatus.ready;
      if (_selectedFilter == 'fail') return acc.credits <= 0 || acc.status == AccountStatus.outOfCredits || acc.status == AccountStatus.error;
      return true;
    }).toList();

    final selectedCount = allAccounts.where((a) => a.isChecked).length;

    return Container(
      width: 250,
      margin: const EdgeInsets.fromLTRB(14, 12, 0, 12),
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
          // Nav Tabs: Generate | Settings
          Row(
            children: [
              Expanded(
                child: InkWell(
                  onTap: () => context.read<SettingsProvider>().setNavView('generate'),
                  borderRadius: BorderRadius.circular(8),
                  child: Container(
                    height: 32,
                    decoration: BoxDecoration(
                      color: isGenerate ? const Color(0x15EAB308) : const Color(0x0AFFFFFF),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: isGenerate ? AppTheme.accentGold.withValues(alpha: 0.6) : AppTheme.borderSoft,
                      ),
                    ),
                    child: Center(
                      child: Text(
                        '🎬 Generate',
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: isGenerate ? FontWeight.bold : FontWeight.w600,
                          color: isGenerate ? AppTheme.accentText : AppTheme.textDim,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: InkWell(
                  onTap: () => context.read<SettingsProvider>().setNavView('settings'),
                  borderRadius: BorderRadius.circular(8),
                  child: Container(
                    height: 32,
                    decoration: BoxDecoration(
                      color: !isGenerate ? const Color(0x15EAB308) : const Color(0x0AFFFFFF),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: !isGenerate ? AppTheme.accentGold.withValues(alpha: 0.6) : AppTheme.borderSoft,
                      ),
                    ),
                    child: Center(
                      child: Text(
                        '⚙ Settings',
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: !isGenerate ? FontWeight.bold : FontWeight.w600,
                          color: !isGenerate ? AppTheme.accentText : AppTheme.textDim,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),

          const SizedBox(height: 8),

          // Select All link
          Align(
            alignment: Alignment.centerRight,
            child: InkWell(
              onTap: () => accountsProv.selectAll(),
              child: const Text(
                'Select all',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: AppTheme.accentText,
                ),
              ),
            ),
          ),

          const SizedBox(height: 6),

          // + Add Account & Add Cookies
          Row(
            children: [
              Expanded(
                child: ElevatedButton(
                  onPressed: () => _showAddAccountDialog(context),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.accentGold,
                    foregroundColor: const Color(0xFF1A1405),
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    elevation: 0,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
                    visualDensity: VisualDensity.compact,
                  ),
                  child: const Text(
                    '+ Add Account',
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: OutlinedButton(
                  onPressed: () => pickAndImportCookieFiles(context),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppTheme.textMain,
                    backgroundColor: const Color(0x10FFFFFF),
                    side: const BorderSide(color: AppTheme.borderSoft),
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
                    visualDensity: VisualDensity.compact,
                  ),
                  child: const Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.cookie_outlined, size: 12, color: AppTheme.accentGold),
                      SizedBox(width: 4),
                      Text(
                        'Add Cookies',
                        style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),

          const SizedBox(height: 8),

          // Filter Segmented Row
          Row(
            children: [
              _buildFilterBtn('All (${allAccounts.length})', 'all'),
              const SizedBox(width: 4),
              _buildFilterBtn('Checking ($checkingCount)', 'checking'),
              const SizedBox(width: 4),
              _buildFilterBtn('Live ($liveCount)', 'live'),
              const SizedBox(width: 4),
              _buildFilterBtn('Fail ($failCount)', 'fail'),
            ],
          ),

          const SizedBox(height: 8),

          // Accounts List
          Expanded(
            child: Container(
              padding: const EdgeInsets.all(6),
              decoration: BoxDecoration(
                color: const Color(0x0AFFFFFF),
                borderRadius: BorderRadius.circular(9),
                border: Border.all(color: AppTheme.borderSoft),
              ),
              child: visibleAccounts.isEmpty
                  ? Center(
                      child: Text(
                        allAccounts.isEmpty
                            ? 'No accounts yet — press "+ Add Account" to sign in, or "Add Cookies".'
                            : 'No accounts in this state.',
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontSize: 11, color: AppTheme.textFaint),
                      ),
                    )
                  : ListView.separated(
                      itemCount: visibleAccounts.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 5),
                      itemBuilder: (context, index) {
                        final acc = visibleAccounts[index];
                        final isLive = acc.credits > 0 && acc.status == AccountStatus.ready;

                        return Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
                          decoration: BoxDecoration(
                            color: const Color(0x08FFFFFF),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: AppTheme.borderSoft),
                          ),
                          child: Row(
                            children: [
                              // Square Checkbox
                              SizedBox(
                                width: 18,
                                height: 18,
                                child: Checkbox(
                                  value: acc.isChecked,
                                  activeColor: AppTheme.accentGold,
                                  checkColor: Colors.black,
                                  side: const BorderSide(color: Colors.white70, width: 1.5),
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2)),
                                  onChanged: (_) => accountsProv.toggleAccount(acc.id),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      acc.name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 11.5,
                                        fontWeight: FontWeight.bold,
                                        color: AppTheme.textMain,
                                      ),
                                    ),
                                    Text(
                                      '${acc.credits} credits',
                                      style: const TextStyle(
                                        fontSize: 10,
                                        color: AppTheme.textFaint,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              // READY / STATUS chip
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color: isLive ? AppTheme.greenBg : AppTheme.redBg,
                                  borderRadius: BorderRadius.circular(4),
                                ),
                                child: Text(
                                  isLive ? 'READY' : acc.status.name.toUpperCase(),
                                  style: TextStyle(
                                    fontSize: 9,
                                    fontWeight: FontWeight.w800,
                                    color: isLive ? AppTheme.green : AppTheme.red,
                                    letterSpacing: 0.5,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 6),
                              // Chrome launch button
                              InkWell(
                                onTap: () => accountsProv.openChrome(acc.id),
                                borderRadius: BorderRadius.circular(11),
                                child: Container(
                                  width: 22,
                                  height: 22,
                                  decoration: const BoxDecoration(
                                    shape: BoxShape.circle,
                                    color: Color(0x1AEAB308),
                                  ),
                                  child: const Icon(
                                    Icons.arrow_outward,
                                    size: 12,
                                    color: AppTheme.accentGold,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        );
                      },
                    ),
            ),
          ),

          const SizedBox(height: 8),

          // Action Grid: 2x2
          Column(
            children: [
              Row(
                children: [
                  Expanded(
                    child: _buildActionGridBtn(
                      '✓ Sync Selected',
                      isDim: selectedCount == 0,
                      onTap: selectedCount > 0 ? () => accountsProv.syncSelected() : null,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: _buildActionGridBtn(
                      '🗑 Delete Selected',
                      isDim: selectedCount == 0,
                      isRed: true,
                      onTap: selectedCount > 0 ? () => _confirmDeleteSelected(context) : null,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Row(
                children: [
                  Expanded(
                    child: _buildActionGridBtn(
                      '✓ Verify All',
                      isDim: false,
                      onTap: () => accountsProv.syncAll(),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: _buildActionGridBtn(
                      'Clear Selection',
                      isDim: false,
                      onTap: () => accountsProv.clearSelection(),
                    ),
                  ),
                ],
              ),
            ],
          ),

          const SizedBox(height: 6),

          // Status hint
          Center(
            child: Text(
              '$selectedCount of ${allAccounts.length} selected • ${accountsProv.activeAccountsCount} live ready • 0 not confirmed',
              style: const TextStyle(
                fontSize: 9.5,
                color: AppTheme.textFaint,
              ),
            ),
          ),

          const SizedBox(height: 6),
          const Divider(color: AppTheme.borderSoft, height: 1),
          const SizedBox(height: 6),

          // Only run live accounts toggle
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Only run live accounts',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textMain,
                ),
              ),
              Transform.scale(
                scale: 0.7,
                child: Switch(
                  value: _onlyRunLive,
                  activeThumbColor: AppTheme.accentGold,
                  activeTrackColor: const Color(0x40EAB308),
                  inactiveTrackColor: AppTheme.borderSoft,
                  onChanged: (val) {
                    setState(() => _onlyRunLive = val);
                    AutomationBridge.instance.saveSetting('live_only_accounts', val ? '1' : '0');
                  },
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildFilterBtn(String label, String key) {
    final isActive = _selectedFilter == key;
    return Expanded(
      child: InkWell(
        onTap: () => setState(() => _selectedFilter = key),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 4),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            gradient: isActive ? AppTheme.accentGrad : null,
            color: isActive ? null : const Color(0x08FFFFFF),
            borderRadius: BorderRadius.circular(6),
            border: Border.all(
              color: isActive ? Colors.transparent : AppTheme.borderSoft,
            ),
          ),
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              label,
              style: TextStyle(
                fontSize: 9.5,
                fontWeight: isActive ? FontWeight.w800 : FontWeight.w600,
                color: isActive ? const Color(0xFF1A1405) : AppTheme.textDim,
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildActionGridBtn(String label, {bool isDim = false, bool isRed = false, VoidCallback? onTap}) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        height: 30,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: const Color(0x0AFFFFFF),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: AppTheme.borderSoft),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w600,
            color: isRed
                ? (isDim ? const Color(0x80F87171) : AppTheme.red)
                : (isDim ? AppTheme.textFaint : AppTheme.textMain),
          ),
        ),
      ),
    );
  }

  void _confirmDeleteSelected(BuildContext context) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppTheme.surfaceElevated,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        title: const Text('Delete Selected Accounts', style: TextStyle(fontSize: 14, color: AppTheme.textMain)),
        content: const Text('Are you sure you want to delete all selected accounts from FlowStudio?', style: TextStyle(fontSize: 12, color: AppTheme.textDim)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel', style: TextStyle(color: AppTheme.textDim)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppTheme.red, foregroundColor: Colors.white),
            onPressed: () {
              Navigator.pop(ctx);
              context.read<AccountsProvider>().deleteSelected();
            },
            child: const Text('Delete'),
          ),
        ],
      ),
    );
  }

  void _showAddAccountDialog(BuildContext context) {
    showDialog(
      context: context,
      builder: (ctx) => const _AddAccountDialog(),
    );
  }
}

/// Directly opens Windows File Explorer to pick cookie files (.json or .txt) and import into FlowStudio Lite
Future<void> pickAndImportCookieFiles(BuildContext context) async {
  try {
    final result = await FilePickerPlatform.instance.pickFiles(
      dialogTitle: 'Select Cookie File (.json / .txt)',
      type: FileType.custom,
      allowedExtensions: ['json', 'txt'],
    );

    if (result.isEmpty) return;

    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Row(
          children: [
            const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
            ),
            const SizedBox(width: 10),
            Text('Importing ${result.length} cookie file(s)...'),
          ],
        ),
        duration: const Duration(seconds: 10),
      ),
    );

    final accountsProv = context.read<AccountsProvider>();
    int successCount = 0;
    int duplicateCount = 0;
    String lastError = '';

    for (final f in result) {
      if (f.path != null) {
        final fileName = f.name.replaceAll(RegExp(r'\.[^.]+$'), '');
        final res = await accountsProv.importCookiesFromFile(f.path!, label: fileName);
        if (res['ok'] == true) {
          successCount++;
          if (res['duplicate'] == true) duplicateCount++;
        } else {
          lastError = res['error']?.toString() ?? 'Cookie check failed';
        }
      }
    }

    if (context.mounted) {
      ScaffoldMessenger.of(context).hideCurrentSnackBar();
      if (successCount > 0) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              duplicateCount == successCount
                  ? 'Those cookies were already added — the existing account was re-checked, no duplicate made.'
                  : successCount == 1
                      ? 'Account added from cookies successfully!'
                      : '$successCount accounts added from cookies!',
            ),
            backgroundColor: AppTheme.green,
            duration: const Duration(seconds: 4),
          ),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Cookie import failed: $lastError'),
            backgroundColor: AppTheme.red,
            duration: const Duration(seconds: 5),
          ),
        );
      }
    }
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('File error: $e'),
          backgroundColor: AppTheme.red,
        ),
      );
    }
  }
}

class _AddAccountDialog extends StatefulWidget {
  const _AddAccountDialog();

  @override
  State<_AddAccountDialog> createState() => _AddAccountDialogState();
}

class _AddAccountDialogState extends State<_AddAccountDialog> with SingleTickerProviderStateMixin {
  late TabController _tabController;
  final nameCtrl = TextEditingController();
  final creditsCtrl = TextEditingController(text: '50');
  List<Map<String, dynamic>> _profiles = [];
  bool _loadingProfiles = true;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _loadProfiles();
  }

  Future<void> _loadProfiles() async {
    final list = await AutomationBridge.instance.getInstalledChromeProfiles();
    if (mounted) {
      setState(() {
        _profiles = list;
        _loadingProfiles = false;
      });
    }
  }

  @override
  void dispose() {
    _tabController.dispose();
    nameCtrl.dispose();
    creditsCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppTheme.surfaceElevated,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      title: Column(
        children: [
          const Text('Add Google Flow Account', style: TextStyle(fontSize: 15, color: AppTheme.textMain)),
          const SizedBox(height: 8),
          TabBar(
            controller: _tabController,
            indicatorColor: AppTheme.accentGold,
            labelColor: AppTheme.accentText,
            unselectedLabelColor: AppTheme.textDim,
            tabs: const [
              Tab(text: 'Chrome Profiles'),
              Tab(text: 'Add Cookies'),
              Tab(text: 'Manual Add'),
            ],
          ),
        ],
      ),
      content: SizedBox(
        width: 380,
        height: 290,
        child: TabBarView(
          controller: _tabController,
          children: [
            // Tab 1: Chrome Profiles
            _loadingProfiles
                ? const Center(child: CircularProgressIndicator(color: AppTheme.accentGold))
                : _profiles.isEmpty
                    ? const Center(
                        child: Text(
                          'No Chrome profiles found.\nUse "Add Cookies" to import from file.',
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 12, color: AppTheme.textDim),
                        ),
                      )
                    : ListView.separated(
                        itemCount: _profiles.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 6),
                        itemBuilder: (context, idx) {
                          final p = _profiles[idx];
                          final dir = p['dirName'] ?? '';
                          final email = p['email'] ?? '';
                          final name = p['name'] ?? dir;

                          return Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                            decoration: BoxDecoration(
                              color: AppTheme.inputBg,
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: AppTheme.borderSoft),
                            ),
                            child: Row(
                              children: [
                                const Icon(Icons.account_circle, size: 24, color: AppTheme.accentGold),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        name,
                                        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppTheme.textMain),
                                      ),
                                      Text(
                                        email.isNotEmpty ? email : dir,
                                        style: const TextStyle(fontSize: 10, color: AppTheme.textFaint),
                                      ),
                                    ],
                                  ),
                                ),
                                ElevatedButton(
                                  onPressed: () async {
                                    await context.read<AccountsProvider>().importChromeProfile(dir);
                                    if (context.mounted) Navigator.pop(context);
                                  },
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: AppTheme.accentGold,
                                    foregroundColor: Colors.black,
                                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                    visualDensity: VisualDensity.compact,
                                  ),
                                  child: const Text('Import', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                                ),
                              ],
                            ),
                          );
                        },
                      ),

            // Tab 2: Add Cookies File (Directly opens PC files)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Container(
                    width: 56,
                    height: 56,
                    decoration: BoxDecoration(
                      color: AppTheme.accentGold.withValues(alpha: 0.12),
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(Icons.cookie_outlined, size: 32, color: AppTheme.accentGold),
                  ),
                  const SizedBox(height: 14),
                  const Text(
                    'Import Cookies File from PC',
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: AppTheme.textMain),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Select a Netscape cookies.txt or JSON cookie file exported from your browser.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 11, color: AppTheme.textDim, height: 1.4),
                  ),
                  const SizedBox(height: 20),
                  ElevatedButton.icon(
                    onPressed: () async {
                      Navigator.pop(context);
                      await pickAndImportCookieFiles(context);
                    },
                    icon: const Icon(Icons.folder_open, size: 16),
                    label: const Text('Select Cookie File from PC', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppTheme.accentGold,
                      foregroundColor: Colors.black,
                      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                  ),
                ],
              ),
            ),

            // Tab 3: Manual Add
            Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: nameCtrl,
                  decoration: const InputDecoration(labelText: 'Name (e.g. M. Aslam)'),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: creditsCtrl,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Credits (e.g. 50)'),
                ),
                const Spacer(),
                ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.accentGold,
                    foregroundColor: Colors.black,
                    minimumSize: const Size.fromHeight(36),
                  ),
                  onPressed: () {
                    if (nameCtrl.text.isNotEmpty) {
                      final credits = int.tryParse(creditsCtrl.text) ?? 50;
                      context.read<AccountsProvider>().addAccount(
                            name: nameCtrl.text,
                            email: '${nameCtrl.text.toLowerCase().replaceAll(' ', '')}@gmail.com',
                            credits: credits,
                          );
                      Navigator.pop(context);
                    }
                  },
                  child: const Text('Add Account', style: TextStyle(fontWeight: FontWeight.bold)),
                ),
              ],
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Close', style: TextStyle(color: AppTheme.textDim)),
        ),
      ],
    );
  }
}

class _AddCookiesDialog extends StatefulWidget {
  const _AddCookiesDialog();

  @override
  State<_AddCookiesDialog> createState() => _AddCookiesDialogState();
}

class _AddCookiesDialogState extends State<_AddCookiesDialog> {
  final labelCtrl = TextEditingController(text: 'Cookie Account');
  final cookieCtrl = TextEditingController();
  String? _selectedFilePath;
  bool _importing = false;

  @override
  void dispose() {
    labelCtrl.dispose();
    cookieCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickCookieFile() async {
    final result = await FilePickerPlatform.instance.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['json', 'txt'],
    );
    if (result.isNotEmpty && result.first.path != null) {
      final path = result.first.path!;
      final fileName = result.first.name.replaceAll(RegExp(r'\.[^.]+$'), '');
      if (labelCtrl.text.trim().isEmpty || labelCtrl.text == 'Cookie Account') {
        labelCtrl.text = fileName;
      }
      final file = File(path);
      final content = await file.readAsString();
      setState(() {
        _selectedFilePath = path;
        cookieCtrl.text = content;
      });
    }
  }

  Future<void> _submit() async {
    if (cookieCtrl.text.trim().isEmpty && _selectedFilePath == null) return;
    setState(() => _importing = true);

    final accounts = context.read<AccountsProvider>();
    final Map<String, dynamic> res;
    if (_selectedFilePath != null) {
      res = await accounts.importCookiesFromFile(
        _selectedFilePath!,
        label: labelCtrl.text.trim().isEmpty ? null : labelCtrl.text.trim(),
      );
    } else {
      res = await accounts.importCookies(
        labelCtrl.text.trim().isEmpty ? 'Cookie Account' : labelCtrl.text.trim(),
        cookieCtrl.text.trim(),
      );
    }

    if (mounted) {
      setState(() => _importing = false);
      final ok = res['ok'] == true;
      Navigator.pop(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(ok ? 'Account cookies imported successfully!' : 'Cookie import failed: ${res['error'] ?? "check format"}'),
          backgroundColor: ok ? AppTheme.green : AppTheme.red,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppTheme.surfaceElevated,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      title: const Text('Add Account from Cookies', style: TextStyle(fontSize: 15, color: AppTheme.textMain)),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ElevatedButton.icon(
              onPressed: _pickCookieFile,
              icon: const Icon(Icons.folder_open, size: 16),
              label: const Text('Browse Cookie File from PC', style: TextStyle(fontWeight: FontWeight.bold)),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.accentGold,
                foregroundColor: Colors.black,
                padding: const EdgeInsets.symmetric(vertical: 10),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: labelCtrl,
              decoration: const InputDecoration(
                labelText: 'Account Label (Auto-filled from file)',
                hintText: 'e.g. Account 2 (Google Flow)',
              ),
            ),
            const SizedBox(height: 10),
            const Text('Cookies Preview (JSON or Netscape format):', style: TextStyle(fontSize: 11, color: AppTheme.textDim)),
            const SizedBox(height: 4),
            Container(
              height: 100,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              decoration: BoxDecoration(
                color: AppTheme.inputBg,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppTheme.borderSoft),
              ),
              child: TextField(
                controller: cookieCtrl,
                maxLines: null,
                style: const TextStyle(fontSize: 11, color: AppTheme.textMain),
                decoration: const InputDecoration(
                  hintText: 'Cookies file content or paste cookies here...',
                  border: InputBorder.none,
                ),
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel', style: TextStyle(color: AppTheme.textDim)),
        ),
        ElevatedButton(
          onPressed: _importing ? null : _submit,
          style: ElevatedButton.styleFrom(
            backgroundColor: AppTheme.accentGold,
            foregroundColor: Colors.black,
          ),
          child: _importing
              ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black))
              : const Text('Import Cookies', style: TextStyle(fontWeight: FontWeight.bold)),
        ),
      ],
    );
  }
}
