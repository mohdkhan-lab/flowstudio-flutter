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

  @override
  Widget build(BuildContext context) {
    final accountsProv = context.watch<AccountsProvider>();
    final settingsProv = context.watch<SettingsProvider>();
    // v2.27.0: the History view belongs to the Generate side — its tab
    // stays highlighted there (the design's History page shows the same
    // sidebar with Generate active).
    final isGenerate = settingsProv.currentView != 'settings';
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
                      color: isGenerate ? const Color(0x150A84FF) : AppTheme.overlay08,
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
                      color: !isGenerate ? const Color(0x150A84FF) : AppTheme.overlay08,
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
              child: Text(
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

          // v2.27.0 (design): ONE full-width blue "+ Add Account" button.
          // ("Add Cookies" moved to the bottom of the sidebar, above the
          // action grid — exactly where the approved design puts it.)
          InkWell(
            onTap: () => _showAddAccountDialog(context),
            borderRadius: BorderRadius.circular(8),
            child: Container(
              height: 34,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF1A94FF), Color(0xFF0066D6)],
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                ),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Text(
                '+ Add Account',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Colors.white),
              ),
            ),
          ),

          const SizedBox(height: 8),

          // v2.27.0 (design): filter boxes — label on top, big count below.
          Row(
            children: [
              _buildFilterBtn('All', allAccounts.length, 'all'),
              const SizedBox(width: 5),
              _buildFilterBtn('Checking', checkingCount, 'checking'),
              const SizedBox(width: 5),
              _buildFilterBtn('Live', liveCount, 'live'),
              const SizedBox(width: 5),
              _buildFilterBtn('Fail', failCount, 'fail'),
            ],
          ),

          const SizedBox(height: 8),

          // Accounts List
          Expanded(
            child: Container(
              padding: const EdgeInsets.all(6),
              decoration: BoxDecoration(
                color: AppTheme.overlay08,
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
                        style: TextStyle(fontSize: 11, color: AppTheme.textFaint),
                      ),
                    )
                  : ListView.separated(
                      itemCount: visibleAccounts.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 5),
                      itemBuilder: (context, index) {
                        final acc = visibleAccounts[index];
                        final chip = _statusChip(acc);

                        return Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
                          decoration: BoxDecoration(
                            color: AppTheme.overlay08,
                            borderRadius: BorderRadius.circular(8),
                            // v2.25.0 (parked browser): the generating
                            // account's row carries a gold border.
                            border: Border.all(
                              color: acc.isActive ? AppTheme.activeGold : AppTheme.borderSoft,
                              width: acc.isActive ? 1.2 : 1.0,
                            ),
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
                              const SizedBox(width: 6),
                              // v2.27.0 (design): avatar circle with the
                              // account's initial, coloured per account.
                              Container(
                                width: 24,
                                height: 24,
                                decoration: BoxDecoration(
                                  color: _avatarColor(acc),
                                  shape: BoxShape.circle,
                                ),
                                alignment: Alignment.center,
                                child: Text(
                                  _initialOf(acc),
                                  style: const TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w800,
                                    color: Colors.white,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 7),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      acc.name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 11.5,
                                        fontWeight: FontWeight.bold,
                                        color: AppTheme.textMain,
                                      ),
                                    ),
                                    Text(
                                      _subLineOf(acc),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 10,
                                        color: AppTheme.textFaint,
                                      ),
                                    ),
                                    // v2.25.0 (parked browser): gold
                                    // ACTIVE text under the credits —
                                    // ONLY on the account that is
                                    // generating right now.
                                    if (acc.isActive)
                                      Padding(
                                        padding: const EdgeInsets.only(top: 1),
                                        child: Text(
                                          '● ACTIVE',
                                          style: TextStyle(
                                            fontSize: 10,
                                            fontWeight: FontWeight.w800,
                                            color: AppTheme.activeGold,
                                            letterSpacing: 0.4,
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                              // v2.27.0 (design): status chip — LIVE
                              // (green) / CHECKING (amber) / FAIL (red).
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color: chip.$2.withValues(alpha: 0.15),
                                  borderRadius: BorderRadius.circular(4),
                                  border: Border.all(color: chip.$2.withValues(alpha: 0.4)),
                                ),
                                child: Text(
                                  chip.$1,
                                  style: TextStyle(
                                    fontSize: 9,
                                    fontWeight: FontWeight.w800,
                                    color: chip.$2,
                                    letterSpacing: 0.5,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 6),
                              // Chrome button. v2.25.0 (parked browser):
                              // on a GENERATING account this is a
                              // Show/Hide toggle for the working
                              // browser itself — a filled blue circle
                              // with a white eye while its window is on
                              // screen. On any other account it keeps
                              // opening the account's own Chrome.
                              InkWell(
                                onTap: () => acc.isActive
                                    ? accountsProv.toggleBrowser(acc.id)
                                    : accountsProv.openChrome(acc.id),
                                borderRadius: BorderRadius.circular(11),
                                child: Container(
                                  width: 22,
                                  height: 22,
                                  decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    color: (acc.isActive && acc.browserShown)
                                        ? const Color(0xFF0A84FF)
                                        : const Color(0x1A0A84FF),
                                  ),
                                  child: Icon(
                                    (acc.isActive && acc.browserShown)
                                        ? Icons.visibility
                                        : Icons.arrow_outward,
                                    size: 12,
                                    color: (acc.isActive && acc.browserShown)
                                        ? Colors.white
                                        : AppTheme.accentGold,
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

          // v2.27.0 (design): full-width "Add Cookies" button below the
          // accounts list (it was the top row's second button before).
          InkWell(
            onTap: () => pickAndImportCookieFiles(context),
            borderRadius: BorderRadius.circular(7),
            child: Container(
              height: 30,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: AppTheme.overlay08,
                borderRadius: BorderRadius.circular(7),
                border: Border.all(color: AppTheme.borderSoft),
              ),
              child: Text(
                'Add Cookies',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppTheme.textMain),
              ),
            ),
          ),

          const SizedBox(height: 6),

          // Action Grid: 2x2
          Column(
            children: [
              Row(
                children: [
                  Expanded(
                    child: _buildActionGridBtn(
                      'Sync Selected',
                      isDim: selectedCount == 0,
                      onTap: selectedCount > 0 ? () => accountsProv.syncSelected() : null,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: _buildActionGridBtn(
                      'Delete Selected',
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
                      'Verify All',
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

          // v2.27.0 (design): status line from the REAL counts. (The
          // "Only run live accounts" toggle that used to sit under this
          // line moved to Settings → Automation.)
          Center(
            child: Text(
              allAccounts.isEmpty
                  ? 'No accounts yet'
                  : '$liveCount Live · $checkingCount Checking · $failCount Fail — ready to generate',
              style: TextStyle(
                fontSize: 9.5,
                color: AppTheme.textFaint,
              ),
            ),
          ),
        ],
      ),
    );
  }

  // v2.27.0 (design): filter box — small label on top, big count below;
  // the selected box carries the accent border + a tinted background.
  Widget _buildFilterBtn(String label, int count, String key) {
    final isActive = _selectedFilter == key;
    return Expanded(
      child: InkWell(
        onTap: () => setState(() => _selectedFilter = key),
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 5),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: isActive
                ? AppTheme.accentGold.withValues(alpha: 0.12)
                : AppTheme.overlay08,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: isActive ? AppTheme.accentGold : AppTheme.borderSoft,
              width: isActive ? 1.2 : 1.0,
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 9,
                  fontWeight: FontWeight.w700,
                  color: isActive ? AppTheme.accentText : AppTheme.textDim,
                ),
              ),
              const SizedBox(height: 1),
              Text(
                '$count',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  color: isActive ? AppTheme.textMain : AppTheme.textDim,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // v2.27.0 (design): the sidebar status chip — (text, colour). Status
  // colours stay fixed in every theme: LIVE green, CHECKING amber,
  // FAIL red.
  (String, Color) _statusChip(GoogleAccount acc) {
    if (acc.status == AccountStatus.checking) {
      return ('CHECKING', const Color(0xFFF5B301));
    }
    final isLive = acc.status == AccountStatus.running ||
        (acc.status == AccountStatus.ready && acc.credits > 0);
    if (isLive) return ('LIVE', AppTheme.green);
    return ('FAIL', AppTheme.red);
  }

  // v2.27.0 (design): the line under the account name — "Checking…"
  // while checking, the failure reason when failed, else the credits.
  String _subLineOf(GoogleAccount acc) {
    if (acc.status == AccountStatus.checking) return 'Checking…';
    final chip = _statusChip(acc);
    if (chip.$1 == 'FAIL' && acc.reason != null && acc.reason!.trim().isNotEmpty) {
      return acc.reason!.trim();
    }
    return '${acc.credits} credits';
  }

  static const List<Color> _avatarPalette = [
    Color(0xFF0A84FF), // blue
    Color(0xFF30D158), // green
    Color(0xFFF5B301), // amber
    Color(0xFFBF5AF2), // purple
    Color(0xFFFF6961), // red
    Color(0xFF2DD4BF), // teal
    Color(0xFFFF8A3D), // orange
    Color(0xFF64D2FF), // sky
  ];

  Color _avatarColor(GoogleAccount acc) {
    final seed = (acc.email.isNotEmpty ? acc.email : acc.name).toLowerCase();
    var h = 0;
    for (final c in seed.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return _avatarPalette[h % _avatarPalette.length];
  }

  String _initialOf(GoogleAccount acc) {
    final src = acc.name.trim().isNotEmpty ? acc.name.trim() : acc.email.trim();
    return src.isEmpty ? '?' : src[0].toUpperCase();
  }

  Widget _buildActionGridBtn(String label, {bool isDim = false, bool isRed = false, VoidCallback? onTap}) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        height: 30,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: AppTheme.overlay08,
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
        title: Text('Delete Selected Accounts', style: TextStyle(fontSize: 14, color: AppTheme.textMain)),
        content: Text('Are you sure you want to delete all selected accounts from FlowStudio?', style: TextStyle(fontSize: 12, color: AppTheme.textDim)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('Cancel', style: TextStyle(color: AppTheme.textDim)),
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

// v2.27.0 (design): the Add Account popup matches the approved sample —
// title "Add Account", a segmented routes row on top (Gmail Login ·
// Add Cookies · Chrome Profiles, Chrome Profiles selected by default)
// and, on the Profiles route, a simple CARD GRID: a dashed
// "+ Add Account" card first, then one card per installed Chrome
// profile. A profile whose email already has an account shows
// ALREADY IMPORTED + credits + Sync; any other shows
// "Import this profile". No search box / filter chips (owner: simple).
class _AddAccountDialogState extends State<_AddAccountDialog> {
  // 0 = Gmail Login, 1 = Add Cookies, 2 = Chrome Profiles (design default)
  int _route = 2;
  final nameCtrl = TextEditingController();
  final creditsCtrl = TextEditingController(text: '50');
  List<Map<String, dynamic>> _profiles = [];
  bool _loadingProfiles = true;

  static const Color _blue = Color(0xFF0A84FF);
  static const List<Color> _cardPalette = [
    Color(0xFF0A84FF),
    Color(0xFF30D158),
    Color(0xFFF5B301),
    Color(0xFFBF5AF2),
    Color(0xFFFF6961),
    Color(0xFF2DD4BF),
    Color(0xFFFF8A3D),
    Color(0xFF64D2FF),
  ];

  @override
  void initState() {
    super.initState();
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
    nameCtrl.dispose();
    creditsCtrl.dispose();
    super.dispose();
  }

  Color _colorFor(String seed) {
    var h = 0;
    for (final c in seed.toLowerCase().codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return _cardPalette[h % _cardPalette.length];
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppTheme.surfaceElevated,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      title: Row(
        children: [
          Text('Add Account', style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppTheme.textMain)),
          const Spacer(),
          InkWell(
            onTap: () => Navigator.pop(context),
            borderRadius: BorderRadius.circular(12),
            child: Container(
              width: 24,
              height: 24,
              decoration: BoxDecoration(
                color: AppTheme.overlay10,
                shape: BoxShape.circle,
                border: Border.all(color: AppTheme.borderSoft),
              ),
              child: Icon(Icons.close, size: 13, color: AppTheme.textDim),
            ),
          ),
        ],
      ),
      content: SizedBox(
        width: 540,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Segmented routes row (design)
            Container(
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: AppTheme.overlay08,
                borderRadius: BorderRadius.circular(9),
                border: Border.all(color: AppTheme.borderSoft),
              ),
              child: Row(
                children: [
                  _routeTab('Gmail Login', 0),
                  _routeTab('Add Cookies', 1),
                  _routeTab('Chrome Profiles', 2),
                ],
              ),
            ),
            const SizedBox(height: 12),
            SizedBox(
              height: 300,
              child: switch (_route) {
                0 => _buildGmailLoginTab(context),
                1 => _buildCookiesTab(context),
                _ => _buildProfilesTab(context),
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _routeTab(String label, int route) {
    final selected = _route == route;
    return Expanded(
      child: InkWell(
        onTap: () => setState(() => _route = route),
        borderRadius: BorderRadius.circular(7),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 7),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected ? AppTheme.surfaceElevated : Colors.transparent,
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: selected ? AppTheme.borderSoft : Colors.transparent),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: selected ? FontWeight.bold : FontWeight.w600,
              color: selected ? AppTheme.textMain : AppTheme.textDim,
            ),
          ),
        ),
      ),
    );
  }

  // Route: Chrome Profiles — the design's card grid.
  Widget _buildProfilesTab(BuildContext context) {
    if (_loadingProfiles) {
      return const Center(child: CircularProgressIndicator(color: _blue));
    }
    final accounts = context.watch<AccountsProvider>().accounts;

    GoogleAccount? importedFor(String email) {
      if (email.trim().isEmpty) return null;
      for (final a in accounts) {
        if (a.email.trim().toLowerCase() == email.trim().toLowerCase()) return a;
      }
      return null;
    }

    return GridView.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        mainAxisSpacing: 10,
        crossAxisSpacing: 10,
        childAspectRatio: 1.9,
      ),
      itemCount: _profiles.length + 1,
      itemBuilder: (context, idx) {
        if (idx == 0) return _buildAddCard();
        final p = _profiles[idx - 1];
        final dir = p['dirName']?.toString() ?? '';
        final email = p['email']?.toString() ?? '';
        final gaia = p['gaiaName']?.toString() ?? '';
        final name = gaia.isNotEmpty ? gaia : (p['name']?.toString() ?? dir);
        final imported = importedFor(email);
        return _buildProfileCard(
          context,
          name: name,
          email: email.isNotEmpty ? email : dir,
          dir: dir,
          imported: imported,
        );
      },
    );
  }

  // First grid cell: dashed "+ Add Account" card → Gmail Login route.
  Widget _buildAddCard() {
    return InkWell(
      onTap: () => setState(() => _route = 0),
      borderRadius: BorderRadius.circular(10),
      child: CustomPaint(
        painter: _DashedBorderPainter(color: _blue.withValues(alpha: 0.7)),
        child: Container(
          decoration: BoxDecoration(
            color: _blue.withValues(alpha: 0.07),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.add, size: 22, color: _blue),
              const SizedBox(height: 4),
              Text('Add Account', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold, color: AppTheme.textMain)),
              const SizedBox(height: 2),
              Text('Login directly with any Gmail ID', style: TextStyle(fontSize: 10, color: AppTheme.textFaint)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildProfileCard(
    BuildContext context, {
    required String name,
    required String email,
    required String dir,
    required GoogleAccount? imported,
  }) {
    final initial = name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase();
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppTheme.inputBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.borderSoft),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(color: _colorFor(email.isNotEmpty ? email : name), shape: BoxShape.circle),
            alignment: Alignment.center,
            child: Text(initial, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: Colors.white)),
          ),
          const SizedBox(height: 5),
          Text(
            name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppTheme.textMain),
          ),
          Text(
            email,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 10, color: AppTheme.textFaint),
          ),
          const SizedBox(height: 6),
          if (imported != null) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(
                color: AppTheme.green.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppTheme.green.withValues(alpha: 0.4)),
              ),
              child: Text(
                'ALREADY IMPORTED',
                style: TextStyle(fontSize: 8.5, fontWeight: FontWeight.w800, color: AppTheme.green, letterSpacing: 0.4),
              ),
            ),
            const SizedBox(height: 6),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text('${imported.credits} credits', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: AppTheme.textDim)),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  onPressed: () => context.read<AccountsProvider>().syncAccountById(imported.id),
                  icon: const Icon(Icons.sync, size: 12),
                  label: const Text('Sync', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold)),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppTheme.textMain,
                    side: BorderSide(color: AppTheme.borderSoft),
                    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                    visualDensity: VisualDensity.compact,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
                  ),
                ),
              ],
            ),
          ] else
            ElevatedButton(
              onPressed: () async {
                await context.read<AccountsProvider>().importChromeProfile(dir);
                if (context.mounted) Navigator.pop(context);
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: _blue,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                visualDensity: VisualDensity.compact,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
              ),
              child: const Text('Import this profile', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
            ),
        ],
      ),
    );
  }

  // Route: Add Cookies — the existing cookie-file import, styled to
  // this dialog (same engine flow as before).
  Widget _buildCookiesTab(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 56,
            height: 56,
            decoration: BoxDecoration(
              color: _blue.withValues(alpha: 0.12),
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.cookie_outlined, size: 32, color: _blue),
          ),
          const SizedBox(height: 14),
          Text(
            'Import Cookies File from PC',
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: AppTheme.textMain),
          ),
          const SizedBox(height: 6),
          Text(
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
              backgroundColor: _blue,
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
            ),
          ),
        ],
      ),
    );
  }

  // Route: Gmail Login. NOTE: the app has no separate Gmail sign-in API
  // — the existing route is this direct-add form (the engine creates
  // the account as "Need Login"), after which the account's own Chrome
  // button in the sidebar opens the real Google sign-in window
  // (engine openLoginWindow). The form is labelled honestly as such.
  Widget _buildGmailLoginTab(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Add the account here — then press its Chrome button in the sidebar to finish the Google sign-in in Chrome.',
            style: TextStyle(fontSize: 11, color: AppTheme.textDim, height: 1.4),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: nameCtrl,
            style: TextStyle(fontSize: 12.5, color: AppTheme.textMain),
            decoration: const InputDecoration(labelText: 'Name (e.g. M. Aslam)'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: creditsCtrl,
            keyboardType: TextInputType.number,
            style: TextStyle(fontSize: 12.5, color: AppTheme.textMain),
            decoration: const InputDecoration(labelText: 'Credits (e.g. 50)'),
          ),
          const Spacer(),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: _blue,
              foregroundColor: Colors.white,
              minimumSize: const Size.fromHeight(38),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
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
    );
  }
}

// Dashed border for the popup's "+ Add Account" card (design).
class _DashedBorderPainter extends CustomPainter {
  final Color color;
  const _DashedBorderPainter({required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1.2
      ..style = PaintingStyle.stroke;
    final rect = RRect.fromRectAndRadius(
      Offset.zero & size,
      const Radius.circular(10),
    );
    final path = Path()..addRRect(rect);
    const dash = 6.0;
    const gap = 4.0;
    for (final metric in path.computeMetrics()) {
      var dist = 0.0;
      while (dist < metric.length) {
        final end = (dist + dash).clamp(0.0, metric.length);
        canvas.drawPath(metric.extractPath(dist, end), paint);
        dist += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DashedBorderPainter oldDelegate) => oldDelegate.color != color;
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
      title: Text('Add Account from Cookies', style: TextStyle(fontSize: 15, color: AppTheme.textMain)),
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
            Text('Cookies Preview (JSON or Netscape format):', style: TextStyle(fontSize: 11, color: AppTheme.textDim)),
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
                style: TextStyle(fontSize: 11, color: AppTheme.textMain),
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
          child: Text('Cancel', style: TextStyle(color: AppTheme.textDim)),
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
