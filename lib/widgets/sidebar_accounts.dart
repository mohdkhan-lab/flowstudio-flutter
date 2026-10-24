import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../providers/accounts_provider.dart';
import '../providers/settings_provider.dart';
import '../models/account.dart';
import '../services/automation_bridge.dart';

class SidebarAccounts extends StatefulWidget {
  // Responsive pass: the main layout drives the width by breakpoint
  // (215 compact / 250 standard / 280 wide); 250 stays the default.
  final double width;

  const SidebarAccounts({super.key, this.width = 250});

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
    // v2.29.0: a "Need Login" account is NOT a failure — it is
    // excluded from the Fail count/filter and gets its own amber
    // LOGIN chip (it used to be lumped into FAIL by its 0 credits).
    bool isFail(GoogleAccount a) =>
        a.status == AccountStatus.outOfCredits ||
        a.status == AccountStatus.error ||
        (a.credits <= 0 && a.status != AccountStatus.loginRequired);
    final failCount = allAccounts.where(isFail).length;

    final visibleAccounts = allAccounts.where((acc) {
      if (_selectedFilter == 'checking') return acc.status == AccountStatus.checking;
      if (_selectedFilter == 'live') return acc.credits > 0 && acc.status == AccountStatus.ready;
      if (_selectedFilter == 'fail') return isFail(acc);
      return true;
    }).toList();

    final selectedCount = allAccounts.where((a) => a.isChecked).length;

    return Container(
      width: widget.width,
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
          // v2.29.0 (owner-approved v3 layout): the top tab row
          // shows ONLY "Generate" — the Settings tab left the top;
          // Settings now lives in the bottom bar (see
          // _buildBottomBar). Tapping Generate from the Settings
          // view is the way back.
          InkWell(
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

          const SizedBox(height: 8),

          // v2.29.0 (owner revision + final spec): the TOP of the
          // sidebar has ONLY this one action — a full-width
          // OUTLINE PILL "+ Add Cookies" (flat, big-platform
          // style; the cookie import flow moved up here from
          // below the account list). "+ Add Account" sits in the
          // bottom bar instead.
          InkWell(
            onTap: () => accountsProv.pickAndImportCookieFiles(),
            borderRadius: BorderRadius.circular(17),
            child: Container(
              height: 34,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: Colors.transparent,
                borderRadius: BorderRadius.circular(17),
                border: Border.all(color: AppTheme.blue.withValues(alpha: 0.65), width: 1.2),
              ),
              child: Text(
                '+ Add Cookies',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppTheme.accentText),
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
                            ? 'No accounts yet — press "+ Add Cookies" above, or "+ Add Account" below to sign in.'
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
                                      // v2.29.0 (B): the row TITLE is
                                      // the source alias ("Cookie N" /
                                      // "Account N"); the real name /
                                      // email stay in the popup cards.
                                      acc.alias.isNotEmpty ? acc.alias : acc.name,
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

          // (v2.29.0: the old "Add Cookies" button that sat below the
          // accounts list is GONE — the cookie flow lives at the TOP
          // of the sidebar now, per the owner's revision.)

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
            // Responsive pass: one line at every sidebar width — the
            // full text scales down slightly in the compact sidebar
            // instead of wrapping under the action grid.
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                allAccounts.isEmpty
                    ? 'No accounts yet'
                    : '$liveCount Live · $checkingCount Checking · $failCount Fail — ready to generate',
                maxLines: 1,
                softWrap: false,
                style: TextStyle(
                  fontSize: 9.5,
                  color: AppTheme.textFaint,
                ),
              ),
            ),
          ),

          const SizedBox(height: 8),

          // v2.29.0 (owner final): the sidebar BOTTOM BAR — one row
          // of two equal-width buttons, "⚙ Settings" on the LEFT
          // and the blue "+ Add Account" on the RIGHT.
          _buildBottomBar(context, isGenerate: isGenerate),
        ],
      ),
    );
  }

  // v2.29.0: the sidebar bottom bar as ONE isolated builder so its
  // styling can be re-skinned in a single place. Owner-FINAL spec:
  // ONE ROW on the sidebar's own Soft Charcoal surface (NO black
  // anywhere); LEFT = "⚙ Settings" quiet/flat like a YouTube
  // Studio menu item; RIGHT = blue PILL "+ Add Account"; equal
  // widths.
  Widget _buildBottomBar(BuildContext context, {required bool isGenerate}) {
    return Row(
      children: [
        Expanded(
          child: InkWell(
            onTap: () => context.read<SettingsProvider>().setNavView('settings'),
            borderRadius: BorderRadius.circular(8),
            child: Container(
              height: 32,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: !isGenerate ? AppTheme.overlay10 : Colors.transparent,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                '⚙ Settings',
                style: TextStyle(
                  fontSize: 11.5,
                  fontWeight: !isGenerate ? FontWeight.bold : FontWeight.w600,
                  color: !isGenerate ? AppTheme.textMain : AppTheme.textDim,
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: InkWell(
            onTap: () => _showAddAccountDialog(context),
            borderRadius: BorderRadius.circular(16),
            child: Container(
              height: 32,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF1A94FF), Color(0xFF0066D6)],
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                ),
                borderRadius: BorderRadius.circular(16),
              ),
              child: const Text(
                '+ Add Account',
                style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: Colors.white),
              ),
            ),
          ),
        ),
      ],
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
    // v2.29.0: "Need Login" is an amber LOGIN chip, not red FAIL.
    if (acc.status == AccountStatus.loginRequired) {
      return ('LOGIN', const Color(0xFFF5B301));
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
    if ((chip.$1 == 'FAIL' || chip.$1 == 'LOGIN') && acc.reason != null && acc.reason!.trim().isNotEmpty) {
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
    // v2.29.0: the avatar initial follows the row title (the alias).
    final src = acc.alias.trim().isNotEmpty
        ? acc.alias.trim()
        : (acc.name.trim().isNotEmpty ? acc.name.trim() : acc.email.trim());
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

class _AddAccountDialog extends StatefulWidget {
  const _AddAccountDialog();

  @override
  State<_AddAccountDialog> createState() => _AddAccountDialogState();
}

// v2.29.0 (owner-approved v3 sample): the Add Account popup has
// NO tab row anymore — it is ONLY the Chrome Profiles card grid:
// a dashed "+ Add Account" card first (it starts the DIRECT Gmail
// login flow — the real Google sign-in window, no form), then one
// card per installed Chrome profile. A profile whose email already
// has an account shows ALREADY IMPORTED + credits + Sync; any other
// shows "Import this profile". Add Cookies is NOT here anymore —
// it lives at the top of the sidebar. (The old Gmail-Login tab's
// manual name/credits form is GONE: it created a local fake
// "ghost" account with an invented email that showed LIVE and
// vanished on restart.)
class _AddAccountDialogState extends State<_AddAccountDialog> {
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
        // Responsive pass: the dialog widens on big windows (720,
        // profiles grid goes 3-across there); 540 + 2-across stays
        // the standard/compact form.
        width: MediaQuery.of(context).size.width >= 1400 ? 720 : 540,
        // v2.29.0: profiles grid ONLY — no routes row.
        child: SizedBox(
          height: 300,
          child: _buildProfilesTab(context),
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

    // Responsive pass: 3 columns when the dialog is wide enough
    // (the 720-wide form), 2 otherwise; the 3-across cells are
    // shorter, so their aspect ratio steps down to keep the card
    // content (avatar + name + email + pill/button) fully inside.
    return LayoutBuilder(
      builder: (context, constraints) {
        final threeAcross = constraints.maxWidth >= 660;
        return GridView.builder(
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: threeAcross ? 3 : 2,
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            childAspectRatio: threeAcross ? 1.55 : 1.9,
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
      },
    );
  }

  // First grid cell: dashed "+ Add Account" card → the DIRECT
  // Gmail login flow (v2.29.0): the engine creates the account and
  // immediately opens the real Google sign-in window; after the
  // owner finishes the login there, the engine fills in the real
  // name, email and credits. NO form anywhere.
  Widget _buildAddCard() {
    return InkWell(
      onTap: () async {
        final messenger = ScaffoldMessenger.of(context);
        final prov = context.read<AccountsProvider>();
        Navigator.pop(context);
        await prov.startGmailLogin();
        messenger.showSnackBar(
          const SnackBar(
            content: Text('Sign-in window opened — finish the Google login in Chrome; the account details fill in automatically.'),
            duration: Duration(seconds: 6),
          ),
        );
      },
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
              Text('Opens the Gmail login page directly', style: TextStyle(fontSize: 10, color: AppTheme.textFaint)),
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

  // v2.29.0: the old _buildCookiesTab and _buildGmailLoginTab are
  // DELETED — cookies live on the sidebar, and the manual
  // name/credits form (the ghost-account path) is gone entirely.
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

