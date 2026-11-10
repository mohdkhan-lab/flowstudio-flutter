import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import 'tactile_components.dart';
import '../providers/accounts_provider.dart';
import '../providers/settings_provider.dart';
import '../models/account.dart';
import '../services/automation_bridge.dart';
import '../services/credit_costs.dart';

// v2.46.0 (status imaandari): sab se saste video ki cost — is se
// kam credits wala account koi video bana hi nahi sakta, is liye
// use "Live" kehna jhooth hota. Teen pehchan file bhar me ek hi
// jagah se banti hain (ginati, filter aur status lafz teeno ke
// liye): Live = Ready + kam se kam itne credits; No Credits = 0
// (ya engine ka Exhausted); Low Credits = kuch hain, video ke
// liye na-kaafi. FAIL in teeno se alag, sirf asal problem hai.
final int _minVideoCredits = creditCostPerVideo('Omni Flash', '4s', '360p') ?? 4;

bool _isLiveAcc(GoogleAccount a) =>
    a.status == AccountStatus.running ||
    (a.status == AccountStatus.ready && a.credits >= _minVideoCredits);

bool _isNoCredits(GoogleAccount a) =>
    a.status == AccountStatus.outOfCredits ||
    (a.credits <= 0 &&
        (a.status == AccountStatus.ready ||
            a.status == AccountStatus.lowCredits));

bool _isLowCredits(GoogleAccount a) =>
    (a.status == AccountStatus.lowCredits && a.credits > 0) ||
    (a.status == AccountStatus.ready &&
        a.credits > 0 &&
        a.credits < _minVideoCredits);

class SidebarAccounts extends StatefulWidget {
  // Responsive pass: the main layout drives the width by breakpoint
  // (v2.46.6 se: 285 har size par, wide par 300); 285 default hai.
  final double width;

  const SidebarAccounts({super.key, this.width = 230});

  @override
  State<SidebarAccounts> createState() => _SidebarAccountsState();
}

class _SidebarAccountsState extends State<SidebarAccounts> {
  final ScrollController _accountsScrollController = ScrollController();

  @override
  void dispose() {
    _accountsScrollController.dispose();
    super.dispose();
  }

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
    // v2.46.0: Live ki ginati bhi file-scope wali asal pehchan se.
    final liveCount = allAccounts.where(_isLiveAcc).length;
    final loginRequiredCount = allAccounts.where((a) => a.status == AccountStatus.loginRequired).length;
    bool isFail(GoogleAccount a) => a.status == AccountStatus.error || a.status == AccountStatus.disabled;
    final failCount = allAccounts.where(isFail).length;

    // v2.49.0 (Option 2: Smart Dynamic Adaptive Filter):
    // Verification ke dauran checkingCount > 0 ➔ 3rd box "Checking" (Pulse 🔵) dikhata hai.
    // Idle time par ➔ 3rd box "Expired" (Login Required 🟡) dikhata hai.
    final isCheckingNow = checkingCount > 0;
    final thirdKey = isCheckingNow ? 'checking' : 'login';
    final thirdLabel = isCheckingNow ? 'Checking' : 'Expired';
    final thirdCount = isCheckingNow ? checkingCount : loginRequiredCount;
    final selectedFilter = settingsProv.selectedAccountFilter;

    final visibleAccounts = allAccounts.where((acc) {
      if (selectedFilter == 'checking') return acc.status == AccountStatus.checking;
      if (selectedFilter == 'live') return _isLiveAcc(acc);
      if (selectedFilter == 'login' || selectedFilter == 'expired') {
        return acc.status == AccountStatus.loginRequired;
      }
      if (selectedFilter == 'fail') return isFail(acc);
      return true;
    }).toList();

    final allSelected = allAccounts.isNotEmpty && allAccounts.every((a) => a.isChecked);
    final selectedCount = allAccounts.where((a) => a.isChecked).length;

    return TactileSectionContainer(
      width: widget.width,
      margin: const EdgeInsets.fromLTRB(14, 12, 0, 12),
      // v2.30.0: 8 (was 10) — two of the pixels the account row's
      // name column needed at the compact width.
      padding: const EdgeInsets.all(8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // v2.47.6 (Design 10: Pure Zero-Tab Architecture): no redundant
          // "Generate" button cluttering the sidebar top. The sidebar starts
          // directly with "+ Add Cookies" pill and "(+)" Add Account button.

          // v2.47.5: Option 2 — top row has "+ Add Cookies" pill plus
          // a circular "(+)" Add Account button beside it.
          // v2.48.2: Soft hover lift and blue glow bloom.
          Row(
            children: [
              Expanded(
                child: _HoverPillBtn(
                  label: '+ Add Cookies',
                  onTap: () => accountsProv.pickAndImportCookieFiles(),
                ),
              ),
              const SizedBox(width: 6),
              _HoverRoundAddBtn(
                onTap: () => _showAddAccountDialog(context),
              ),
            ],
          ),

          const SizedBox(height: 4),

          // v2.49.0 (Option 2: Smart Dynamic Adaptive Filter Grid):
          // Order: All | Live | Checking (in-flight) / Expired (idle) | Fail
          Row(
            children: [
              _buildFilterBtn(
                context,
                'All',
                allAccounts.length,
                'all',
                tooltip: 'Show all ${allAccounts.length} cookies',
              ),
              const SizedBox(width: 5),
              _buildFilterBtn(
                context,
                'Live',
                liveCount,
                'live',
                accentColor: AppTheme.green,
                tooltip: 'Show $liveCount generation-ready cookies',
              ),
              const SizedBox(width: 5),
              _buildFilterBtn(
                context,
                thirdLabel,
                thirdCount,
                thirdKey,
                // v2.48.88: the checking accent is sky blue on dark
                // palettes only — in the white theme it is the
                // fixed ACTIVE gold (no blue in light mode).
                // v2.48.89: in light mode the idle accent is the
                // deepened ACTIVE gold token too — the fixed bright
                // #F5B301 measured ~1.9:1 as the tab's count text.
                accentColor: isCheckingNow ? (AppTheme.dark ? const Color(0xFF38BDF8) : AppTheme.activeGold) : (AppTheme.dark ? const Color(0xFFF5B301) : AppTheme.activeGold),
                tooltip: isCheckingNow
                    ? '$checkingCount cookies currently verifying'
                    : '$loginRequiredCount expired cookies requiring login',
              ),
              const SizedBox(width: 5),
              _buildFilterBtn(
                context,
                'Fail',
                failCount,
                'fail',
                accentColor: AppTheme.red,
                tooltip: 'Show $failCount failed or invalid cookies',
              ),
            ],
          ),

          const SizedBox(height: 4),

          // Accounts List
          // v2.46.8 (owner: "exact tuner jaisa"): list wala hissa
          // ab lines ke hisaab se sikudta hai (Flexible +
          // shrinkWrap) — lines khatam, hissa khatam; pehle
          // Expanded ki wajah se ye hissa poori unchaai tak
          // phaila rehta tha aur lines ke neeche bari khaali
          // jagah dikhti thi. Zyada accounts hon to hissa
          // uplabdh jagah par ruk kar andar scroll karta hai.
          Expanded(
            child: Container(
              // v2.30.0: 4 (was 6) — more of the row's width budget
              // goes to the account name column (see the row below).
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                color: AppTheme.overlay08,
                borderRadius: BorderRadius.circular(9),
                border: Border.all(color: AppTheme.borderSoft),
              ),
              child: visibleAccounts.isEmpty
                  ? (allAccounts.isEmpty
                      ? _buildEmptyAccountsState(context, accountsProv)
                      : _buildEmptyFilterState(context, settingsProv, selectedFilter))
                  : RawScrollbar(
                      controller: _accountsScrollController,
                      thumbVisibility: true,
                      thickness: 3.5,
                      radius: const Radius.circular(3),
                      thumbColor: AppTheme.accentGold.withValues(alpha: 0.45),
                      minThumbLength: 30,
                      child: ListView.separated(
                        controller: _accountsScrollController,
                        shrinkWrap: false,
                        itemCount: visibleAccounts.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 6),
                        itemBuilder: (context, index) {
                        final acc = visibleAccounts[index];
                        final word = _statusWord(acc);
                        final browserOn = acc.isActive && acc.browserShown;

                        // v2.30.2 (owner-approved sample v3, FINAL):
                        // the account row is rebuilt to the sample —
                        // NO avatar before the text; checkbox, then
                        // the left-aligned text block (alias 13px
                        // bold / sub-line 11px / ● ACTIVE 12px gold
                        // in an ALWAYS-RESERVED slot); open space in
                        // the middle; on the right the status as
                        // plain coloured text in a fixed-width slot
                        // and a proper "Chrome" button. The row
                        // height is FIXED (74) for every state, so
                        // nothing resizes or shifts when a status
                        // changes.
                        return _HoverableAccountCard(
                          key: ValueKey('acc_${acc.id}'),
                          isActive: acc.isActive,
                          child: FittedBox(
                            // The row's inner layout is built ONCE
                            // at its full-scale natural width (238 —
                            // the wide sidebar's inner width, the
                            // sample's geometry) and scale-down
                            // fitted, the app's established fit
                            // mechanism: at compact widths everything
                            // shrinks a hair, but no word is ever cut
                            // or ellipsized and no element ever
                            // changes position.
                            fit: BoxFit.scaleDown,
                            child: SizedBox(
                              width: 255,
                              // v2.46.9 (owner: "50x50 karo"): andar
                              // wala hisa 54 -> 50 — Text Block ki
                              // unchaai 50 ke saath barabar.
                              height: 65,
                              child: Row(
                                children: [
                                  // Square Checkbox
                                  SizedBox(
                                    width: 20,
                                    height: 20,
                                    child: Checkbox(
                                      value: acc.isChecked,
                                      activeColor: AppTheme.accentGold,
                                      checkColor: Colors.black,
                                      // v2.48.88: white70 is invisible on
                                      // the white theme's white rows — the
                                      // unchecked box edge is the strong
                                      // border token in light mode.
                                      side: BorderSide(color: AppTheme.dark ? Colors.white70 : AppTheme.border, width: 1.5),
                                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2)),
                                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                      onChanged: (_) => accountsProv.toggleAccount(acc.id),
                                    ),
                                  ),
                                  const SizedBox(width: 10),
                                  // Left text block (sample v3): the
                                  // alias, the sub-line, and the
                                  // ● ACTIVE slot — the slot is ALWAYS
                                  // here (empty when not generating),
                                  // so the block's height is constant.
                                  // The block takes the row's flexible
                                  // share and is scale-down fitted
                                  // (the v2.30.0 pattern): its words
                                  // are never cut or ellipsized, in
                                  // any font or sidebar width.
                                  // v2.46.9 (owner: "50x50 karo"):
                                  // Text Block fixed 50 chauda;
                                  // beech ki space neeche wala
                                  // spacer leta hai.
                                  SizedBox(
                                    width: 76,
                                    child: FittedBox(
                                      fit: BoxFit.scaleDown,
                                      alignment: Alignment.centerLeft,
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        mainAxisAlignment: MainAxisAlignment.center,
                                        children: [
                                      SizedBox(
                                        // v2.46.6 (Sample 5): sab text
                                        // ek size = 9; box 11.
                                        height: 13,
                                        child: Text(
                                          // v2.29.0 (B): the row TITLE
                                          // is the source alias
                                          // ("Cookie N" / "Account N");
                                          // the real name / email stay
                                          // in the popup cards.
                                          acc.alias.isNotEmpty ? acc.alias : acc.name,
                                          maxLines: 1,
                                          softWrap: false,
                                          style: TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.bold,
                                            color: AppTheme.textMain,
                                            height: 1.0,
                                          ),
                                        ),
                                      ),
                                      const SizedBox(height: 1),
                                      SizedBox(
                                        // v2.46.6 (Sample 5): box 11,
                                        // font 9 (sab text ek size).
                                        height: 13,
                                        child: Text(
                                          _subLineOf(acc),
                                          maxLines: 1,
                                          softWrap: false,
                                          style: TextStyle(
                                            fontSize: 12,
                                            // v2.48.89 (owner): the
                                            // credits sub-line reads at
                                            // textDim minimum in the
                                            // white theme — textFaint
                                            // was one of the pale lines
                                            // in his .88 screenshot.
                                            // Dark keeps textFaint.
                                            color: AppTheme.dark ? AppTheme.textFaint : AppTheme.textDim,
                                            height: 1.0,
                                          ),
                                        ),
                                      ),
                                      const SizedBox(height: 1),
                                      SizedBox(
                                        // v2.46.6 (Sample 5): slot 11,
                                        // font 9 (sab text ek size).
                                        height: 13,
                                        // v2.25.0 (parked browser): gold
                                        // ● ACTIVE under the credits —
                                        // ONLY on the account that is
                                        // generating right now; the
                                        // slot stays reserved either way.
                                        child: acc.isActive
                                            ? Text(
                                                '● ACTIVE',
                                                maxLines: 1,
                                                softWrap: false,
                                                style: TextStyle(
                                                  fontSize: 12,
                                                  fontWeight: FontWeight.w800,
                                                  color: AppTheme.activeGold,
                                                  letterSpacing: 0.5,
                                                  height: 1.0,
                                                ),
                                              )
                                            : null,
                                      ),
                                        ],
                                      ),
                                    ),
                                  ),
                                  // v2.46.9: beech ki khaali space —
                                  // Text Block 50 par fixed hai, baaki
                                  // saari darmiyani jagah ye spacer
                                  // leta hai; dayein taraf (word +
                                  // button) apni jagah pin rehta hai.
                                  const Expanded(child: SizedBox.shrink()),
                                  // Right side (sample v3): the status
                                  // as plain coloured TEXT in a
                                  // FIXED-WIDTH slot — no chip.
                                  // Scale-down fitted like the text
                                  // block, so the longest word
                                  // always fits its slot.
                                  // v2.46.2: slot 58 -> 70. v2.46.0 ke
                                  // naye lafz "Low Credits" / "No
                                  // Credits" purane sab se lambe lafz
                                  // ("Checking") se lambe hain — 58 me
                                  // wo sikud kar credits wali line se
                                  // takrane lagte the (owner ka
                                  // screenshot, Cookie 6, 2026-10-30).
                                  // 70 me dono pure size par padhe
                                  // jate hain; scale-down hifazat
                                  // ke tor par barkarar hai.
                                  SizedBox(
                                    width: 70,
                                    child: FittedBox(
                                      fit: BoxFit.scaleDown,
                                      child: Text(
                                        word.$1,
                                        textAlign: TextAlign.center,
                                        maxLines: 1,
                                        softWrap: false,
                                        style: TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.w700,
                                          color: word.$2,
                                          height: 1.0,
                                        ),
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  // Chrome kholne wala button.
                                  // v2.46.2 (owner ka order + approved
                                  // Sample A, 2026-10-30): "Chrome"
                                  // likhi hui 76px pill (sample v3)
                                  // khatam — us ki jagah sirf 34px ka
                                  // GOL button neele ↗ arrow ke
                                  // saath; naam ki zaroorat nahi aur
                                  // jagah aadhi se kam (76 -> 34),
                                  // isiliye credits line aur status
                                  // lafz ko saans mil gayi. Kaam
                                  // bilkul wahi: generating account
                                  // par parked browser ka Show/Hide
                                  // toggle, baaki par Chrome kholna;
                                  // parked browser screen par ho to
                                  // kinara neela ("on" look).
                                  Tooltip(
                                    message: acc.isActive
                                        ? 'Toggle Chrome window'
                                        : 'Open Chrome profile in browser',
                                    child: InkWell(
                                      onTap: () => acc.isActive
                                          ? accountsProv.toggleBrowser(acc.id)
                                          : accountsProv.openChrome(acc.id),
                                      customBorder: const CircleBorder(),
                                      child: Container(
                                        // v2.46.7 (owner ke tuner
                                        // numbers): button 34 -> 26.
                                        width: 26,
                                        height: 26,
                                        alignment: Alignment.center,
                                        decoration: BoxDecoration(
                                          color: AppTheme.surfaceElevated,
                                          shape: BoxShape.circle,
                                          border: Border.all(
                                            color: browserOn ? AppTheme.accentGold : AppTheme.borderSoft,
                                          ),
                                        ),
                                        child: Icon(
                                          Icons.north_east,
                                          size: 12,
                                          color: AppTheme.accentText,
                                        ),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        );
                      },
                    ),
                  ),
            ),
          ),

          const SizedBox(height: 4),

          // (v2.29.0: the old "Add Cookies" button that sat below the
          // accounts list is GONE — the cookie flow lives at the TOP
          // of the sidebar now, per the owner's revision.)

          // Action Grid: 2x2 with soft hover lift
          Column(
            children: [
              Row(
                children: [
                  Expanded(
                    child: _HoverActionGridBtn(
                      label: 'Sync Selected',
                      tooltip: 'Sync cookies and credits for selected accounts',
                      isDim: selectedCount == 0,
                      onTap: selectedCount > 0 ? () => accountsProv.syncSelected() : null,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: _HoverActionGridBtn(
                      label: 'Delete Selected',
                      tooltip: 'Delete selected accounts from storage',
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
                    child: _HoverActionGridBtn(
                      label: 'Verify All',
                      tooltip: 'Check status and credits of all accounts in parallel',
                      isDim: false,
                      onTap: () => accountsProv.syncAll(),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: _HoverActionGridBtn(
                      label: allSelected ? 'Deselect All' : 'Select All',
                      tooltip: allSelected ? 'Deselect all accounts' : 'Select all accounts',
                      isDim: allAccounts.isEmpty,
                      onTap: allAccounts.isEmpty
                          ? null
                          : () {
                              if (allSelected) {
                                accountsProv.clearSelection();
                              } else {
                                accountsProv.selectAll();
                              }
                            },
                    ),
                  ),
                ],
              ),
            ],
          ),

          // (Fix list 2026-10-27, item 10): the live-counts status
          // line that used to sit here ("N Live · N Checking · N
          // Fail — ready to generate") is REMOVED on the owner's
          // word — the filter boxes above already carry those
          // counts. Nothing else read the line, so no code goes
          // with it beyond the widget itself.

          const SizedBox(height: 4),

          // v2.29.0 (owner final): the sidebar BOTTOM BAR — one row
          // of two equal-width buttons, "⚙ Settings" on the LEFT
          // and the Add Account button on the RIGHT (icon-only
          // since fix list item 9).
          _buildBottomBar(context, isGenerate: isGenerate),
        ],
      ),
    );
  }

  // v2.29.0: the sidebar bottom bar as ONE isolated builder so its
  // styling can be re-skinned in a single place. Owner-FINAL spec:
  // ONE ROW on the sidebar's own Soft Charcoal surface (NO black
  // anywhere); LEFT = "⚙ Settings" quiet/flat like a YouTube
  // Studio menu item; RIGHT = "+ Add Account"; equal widths.
  // v2.34.0 (Problem 14, Sample B): the right button's loud
  // solid-blue pill became a muted dark face with a blue "+".
  // v2.47.6 (Design 10): "⚙ Settings" full-width button. In Studio mode,
  // it opens Settings; in Settings mode, it displays "← Back to Studio"
  // allowing instant round-trip toggle from the exact same position.
  Widget _buildBottomBar(BuildContext context, {required bool isGenerate}) {
    return _HoverBottomSettingsBtn(
      isGenerate: isGenerate,
      onTap: () {
        final prov = context.read<SettingsProvider>();
        if (prov.currentView == 'settings') {
          prov.setNavView('generate');
        } else {
          prov.setNavView('settings');
        }
      },
    );
  }

  // v2.27.0 (design): filter box — small label on top, big count below;
  // the selected box carries the accent border + a tinted background.
  Widget _buildFilterBtn(
    BuildContext context,
    String label,
    int count,
    String key, {
    Color? accentColor,
    String? tooltip,
  }) {
    final settingsProv = context.watch<SettingsProvider>();
    final isActive = settingsProv.selectedAccountFilter == key;
    return _HoverFilterBtn(
      label: label,
      count: count,
      isActive: isActive,
      accentColor: accentColor,
      tooltip: tooltip,
      onTap: () => context.read<SettingsProvider>().setSelectedAccountFilter(key),
    );
  }

  // v2.49.0: Modern Aesthetic Empty-State Card when 0 accounts exist
  Widget _buildEmptyAccountsState(BuildContext context, AccountsProvider accountsProv) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: AppTheme.accentGold.withValues(alpha: 0.12),
                border: Border.all(color: AppTheme.borderHighlight),
              ),
              child: Icon(
                Icons.cookie_outlined,
                size: 22,
                color: AppTheme.accentGold,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              'No Accounts Loaded',
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w800,
                color: AppTheme.textMain,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'Import JSON or Netscape cookies to begin generating.',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 10.5,
                color: AppTheme.textFaint,
                height: 1.4,
              ),
            ),
            const SizedBox(height: 14),
            TactileButton(
              type: TactileType.primary,
              height: 32,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              label: '+ Import Cookies',
              onTap: () => accountsProv.pickAndImportCookieFiles(),
            ),
          ],
        ),
      ),
    );
  }

  // v2.49.0: Modern Aesthetic Empty-State Card when a filter has 0 matches
  Widget _buildEmptyFilterState(BuildContext context, SettingsProvider settingsProv, String filterName) {
    final displayFilter = filterName.toUpperCase();
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: AppTheme.overlay10,
                border: Border.all(color: AppTheme.borderSoft),
              ),
              child: Icon(
                Icons.filter_list_off_rounded,
                size: 20,
                color: AppTheme.textDim,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              'No $displayFilter Accounts',
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: AppTheme.textMain,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'No accounts currently match this filter.',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 10,
                color: AppTheme.textFaint,
              ),
            ),
            const SizedBox(height: 12),
            TactileButton(
              type: TactileType.secondary,
              height: 28,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              label: 'Show All Accounts',
              onTap: () => settingsProv.setSelectedAccountFilter('all'),
            ),
          ],
        ),
      ),
    );
  }

  // v2.27.0 (design): the sidebar status chip — (text, colour). Status
  // colours stay fixed in every theme: LIVE green, CHECKING amber,
  // FAIL red.
  // v2.48.89: in LIGHT mode the amber status TEXT deepens to
  // amber-800 #92400E (~7.1:1 on white) — the fixed bright golds
  // are small-text pale offenders in the white theme. Dark keeps
  // the fixed brights byte-identical.
  // v2.48.90: #92400E measures ~6.9:1 on the warm cream card,
  // so the light amber deepens one more step to #854008
  // (~7.5:1) — the same value as the palette's accentText.
  // v2.48.91: the owner's "Warm Sand" spec sets accentText to
  // #92400E, so the light amber returns to #92400E — again the
  // same value as the palette's accentText (~7.0:1 on the Warm
  // Sand card #FFFDF6).
  (String, Color) _statusChip(GoogleAccount acc) {
    if (acc.status == AccountStatus.checking) {
      return ('CHECKING', AppTheme.dark ? const Color(0xFFF5B301) : const Color(0xFF92400E));
    }
    // v2.29.0: "Need Login" is an amber LOGIN chip, not red FAIL.
    if (acc.status == AccountStatus.loginRequired) {
      return ('LOGIN', AppTheme.dark ? const Color(0xFFF5B301) : const Color(0xFF92400E));
    }
    // v2.46.0: credits khatam/kam FAIL nahi hai — apne lafz, apne
    // rang (grey / amber). FAIL sirf asal problem ke liye bacha.
    if (_isNoCredits(acc)) return ('NO CREDITS', AppTheme.textDim);
    if (_isLowCredits(acc)) return ('LOW CREDITS', AppTheme.dark ? const Color(0xFFF5B301) : const Color(0xFF92400E));
    if (_isLiveAcc(acc)) return ('LIVE', AppTheme.green);
    return ('FAIL', AppTheme.red);
  }

  // v2.30.2 (owner-approved sample v3): the row's right-side status
  // as plain coloured TEXT (no chip box). Colours are the sample's
  // fixed status colours: Live green, Checking amber, Login orange,
  // Fail red. An account added with its check deferred (bulk-add
  // phase 1) shows a faint "Waiting" until its check lands; a check
  // in flight reads "Checking" from the account state itself.
  (String, Color) _statusWord(GoogleAccount acc) {
    if (acc.status == AccountStatus.checking) {
      return ('Checking', AppTheme.dark ? const Color(0xFFF5B301) : const Color(0xFF92400E));
    }
    if (acc.pendingCheck) {
      return ('Waiting', AppTheme.textFaint);
    }
    if (acc.status == AccountStatus.loginRequired) {
      // v2.48.89: light mode wears deep orange-800 #9A3412
      // (~7.3:1) instead of the bright #FF9F0A (~2.2:1).
      return ('Login', AppTheme.dark ? const Color(0xFFFF9F0A) : const Color(0xFF9A3412));
    }
    // v2.46.0: credits wali haalat apne lafz se — Fail sirf asal
    // problem (cookie/login/error) ke liye.
    if (_isNoCredits(acc)) return ('No Credits', AppTheme.textDim);
    if (_isLowCredits(acc)) return ('Low Credits', AppTheme.dark ? const Color(0xFFF5B301) : const Color(0xFF92400E));
    if (_isLiveAcc(acc)) return ('Live', AppTheme.green);
    return ('Fail', AppTheme.red);
  }

  // v2.27.0 (design): the line under the account name — "Checking…"
  // while checking, the failure reason when failed, else the credits.
  String _subLineOf(GoogleAccount acc) {
    if (acc.status == AccountStatus.checking) return 'Checking…';
    final chip = _statusChip(acc);
    if ((chip.$1 == 'FAIL' || chip.$1 == 'LOGIN') && acc.reason != null && acc.reason!.trim().isNotEmpty) {
      return acc.reason!.trim();
    }
    // v2.46.3 (owner ka order, 2026-10-30): screen par koi
    // estimate nahi dikhega — na '~', na '(estimate)'. Sirf asal
    // number. (Andar credits_source ki pehchan apni jagah hai;
    // live check hote hi number khud asal ho jata hai — sirf
    // dikhawa saaf kar diya gaya hai.)
    return '${acc.credits} credits';
  }

  // v2.30.2: the row's avatar helpers (_avatarColor / _initialOf /
  // _avatarPalette) are GONE with the avatar itself (sample v3: "no
  // logo before the cookies text"). The Add Account popup keeps its
  // own separate card colour/initial helpers below.

  
  void _confirmDeleteSelected(BuildContext context) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppTheme.surfaceElevated,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        title: Text('Delete Selected Accounts', style: TextStyle(fontSize: 14, color: AppTheme.textMain)),
        content: Text('Are you sure you want to delete all selected accounts from FlowStudio?', style: TextStyle(fontSize: 12, color: AppTheme.textDim)),
        actions: [
          TactileButton(
            type: TactileType.secondary,
            height: 32,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            label: 'Cancel',
            onTap: () => Navigator.pop(ctx),
          ),
          const SizedBox(width: 8),
          TactileButton(
            type: TactileType.danger,
            height: 32,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            label: 'Delete',
            onTap: () {
              Navigator.pop(ctx);
              context.read<AccountsProvider>().deleteSelected();
            },
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

  // Dark palettes: the original vivid identity discs (unchanged).
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

  // v2.48.88: in the white theme the avatar discs wear the
  // theme's own family — deep slate / gold / stone tones, all
  // dark enough for the white initial, no blue/purple/teal.
  static const List<Color> _cardPaletteLight = [
    Color(0xFFB45309),
    Color(0xFF475569),
    Color(0xFF334155),
    Color(0xFF78716C),
    Color(0xFF64748B),
    Color(0xFF92400E),
    Color(0xFF3F4A5A),
    Color(0xFF57534E),
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
    final palette = AppTheme.dark ? _cardPalette : _cardPaletteLight;
    return palette[h % palette.length];
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
      return Center(child: CircularProgressIndicator(color: AppTheme.accentGold));
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
        painter: _DashedBorderPainter(color: AppTheme.accentGold.withValues(alpha: 0.7)),
        child: Container(
          decoration: BoxDecoration(
            color: AppTheme.accentGold.withValues(alpha: 0.07),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.add, size: 22, color: AppTheme.accentGold),
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
                TactileButton(
                  type: TactileType.secondary,
                  height: 24,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  icon: Icons.sync,
                  iconSize: 12,
                  label: 'Sync',
                  onTap: () => context.read<AccountsProvider>().syncAccountById(imported.id),
                ),
              ],
            ),
          ] else
            TactileButton(
              type: TactileType.primary,
              height: 28,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              label: 'Import this profile',
              onTap: () async {
                await context.read<AccountsProvider>().importChromeProfile(dir);
                if (context.mounted) Navigator.pop(context);
              },
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

// ---------------------------------------------------------------------------
// v2.48.2: Luxury Soft Hover Components
// ---------------------------------------------------------------------------

class _HoverPillBtn extends StatefulWidget {
  final String label;
  final VoidCallback onTap;

  const _HoverPillBtn({required this.label, required this.onTap});

  @override
  State<_HoverPillBtn> createState() => _HoverPillBtnState();
}

class _HoverPillBtnState extends State<_HoverPillBtn> {
  bool _hovered = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final double translateY = _pressed ? 1.5 : (_hovered ? -2.5 : 0.0);
    final double bevel = _pressed ? 0.8 : (_hovered ? 3.7 : 2.5);

    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() {
        _hovered = false;
        _pressed = false;
      }),
      cursor: SystemMouseCursors.click,
      child: Tooltip(
        message: 'Import cookies from file or clipboard',
        child: GestureDetector(
          onTapDown: (_) => setState(() => _pressed = true),
          onTapUp: (_) => setState(() => _pressed = false),
          onTapCancel: () => setState(() => _pressed = false),
          onTap: widget.onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOutCubic,
            height: 34,
            alignment: Alignment.center,
            transform: Matrix4.translationValues(0, translateY, 0),
            decoration: BoxDecoration(
              // v2.48.89: light mode rests on inputBg — the
              // near-clear overlay08 read as a dark slate slab in
              // the owner's .88 screenshot.
              // v2.48.90: light mode rests on buttonBg — the ONE
              // uniform warm-tan button face (see AppPalette).
              color: _hovered ? AppTheme.accentGold.withValues(alpha: 0.18) : (AppTheme.dark ? AppTheme.overlay08 : AppTheme.buttonBg),
              borderRadius: BorderRadius.circular(17),
              border: Border.all(
                color: _hovered ? AppTheme.accentGold : AppTheme.borderHighlight,
                width: 1.2,
              ),
              boxShadow: [
                // Style 6: 3D mechanical bevel
                BoxShadow(
                  color: AppTheme.bevelPrimary,
                  offset: Offset(0, bevel),
                  blurRadius: 0,
                ),
                if (_hovered)
                  BoxShadow(
                    color: AppTheme.glowPrimary.withValues(alpha: 0.35),
                    blurRadius: 14,
                    spreadRadius: 0.5,
                    offset: const Offset(0, 3.5),
                  ),
              ],
            ),
            child: Text(
              widget.label,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.bold,
                // v2.48.88: hover lifts the pill on a pale gold
                // tint — white text vanishes on it in light mode;
                // the hover label is the dark-gold accentText
                // there (dark keeps its white-on-tint).
                color: _hovered
                    ? (AppTheme.dark ? Colors.white : AppTheme.accentText)
                    : AppTheme.accentText,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _HoverRoundAddBtn extends StatefulWidget {
  final VoidCallback onTap;

  const _HoverRoundAddBtn({required this.onTap});

  @override
  State<_HoverRoundAddBtn> createState() => _HoverRoundAddBtnState();
}

class _HoverRoundAddBtnState extends State<_HoverRoundAddBtn> {
  bool _hovered = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final double translateY = _pressed ? 1.5 : (_hovered ? -2.5 : 0.0);
    final double bevel = _pressed ? 0.8 : (_hovered ? 3.7 : 2.5);

    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() {
        _hovered = false;
        _pressed = false;
      }),
      cursor: SystemMouseCursors.click,
      child: Tooltip(
        message: 'Add Account',
        child: GestureDetector(
          onTapDown: (_) => setState(() => _pressed = true),
          onTapUp: (_) => setState(() => _pressed = false),
          onTapCancel: () => setState(() => _pressed = false),
          onTap: widget.onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOutCubic,
            width: 34,
            height: 34,
            alignment: Alignment.center,
            transform: Matrix4.translationValues(0, translateY, 0),
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              // v2.48.90: in light mode the resting face joins
              // the uniform button design (buttonBg warm tan);
              // the hover keeps its gold tint. Dark keeps the
              // gold-tint fills in both states, byte-identical.
              color: _hovered
                  ? AppTheme.accentGold.withValues(alpha: 0.25)
                  : (AppTheme.dark
                      ? AppTheme.accentGold.withValues(alpha: 0.12)
                      : AppTheme.buttonBg),
              border: Border.all(
                color: _hovered ? AppTheme.accentGold : AppTheme.borderHighlight,
                width: 1.2,
              ),
              boxShadow: [
                BoxShadow(
                  color: AppTheme.bevelPrimary,
                  offset: Offset(0, bevel),
                  blurRadius: 0,
                ),
                if (_hovered)
                  BoxShadow(
                    color: AppTheme.glowPrimary.withValues(alpha: 0.35),
                    blurRadius: 14,
                    spreadRadius: 0.5,
                    offset: const Offset(0, 3.5),
                  ),
              ],
            ),
            child: Icon(
              Icons.add,
              size: 18,
              // v2.48.88: same light-hover rule as _HoverPillBtn.
              color: _hovered
                  ? (AppTheme.dark ? Colors.white : AppTheme.accentText)
                  : AppTheme.accentText,
            ),
          ),
        ),
      ),
    );
  }
}

class _HoverFilterBtn extends StatefulWidget {
  final String label;
  final int count;
  final bool isActive;
  final VoidCallback onTap;
  final Color? accentColor;
  final String? tooltip;

  const _HoverFilterBtn({
    required this.label,
    required this.count,
    required this.isActive,
    required this.onTap,
    this.accentColor,
    this.tooltip,
  });

  @override
  State<_HoverFilterBtn> createState() => _HoverFilterBtnState();
}

class _HoverFilterBtnState extends State<_HoverFilterBtn> {
  bool _hovered = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final isActive = widget.isActive;
    final double translateY = _pressed ? 1.5 : (_hovered ? -2.5 : 0.0);
    final double bevel = _pressed ? 0.8 : (_hovered ? 3.7 : 2.5);
    final bevelColor = isActive ? AppTheme.bevelPrimary : AppTheme.bevelSecondary;
    final activeTint = widget.accentColor ?? AppTheme.accentGold;

    return Expanded(
      child: Tooltip(
        message: widget.tooltip ?? widget.label,
        waitDuration: const Duration(milliseconds: 350),
        child: MouseRegion(
          onEnter: (_) => setState(() => _hovered = true),
          onExit: (_) => setState(() {
            _hovered = false;
            _pressed = false;
          }),
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            onTapDown: (_) => setState(() => _pressed = true),
            onTapUp: (_) => setState(() => _pressed = false),
            onTapCancel: () => setState(() => _pressed = false),
            onTap: widget.onTap,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              curve: Curves.easeOutCubic,
              padding: const EdgeInsets.symmetric(vertical: 5),
              alignment: Alignment.center,
              transform: Matrix4.translationValues(0, translateY, 0),
              decoration: BoxDecoration(
                // v2.48.89: inactive light tabs rest on inputBg
                // (the overlay08 fill read dark-slab in the
                // owner's .88 screenshot).
                // v2.48.90: inactive light tabs rest on buttonBg,
                // the uniform warm-tan button face.
                color: isActive
                    ? activeTint.withValues(alpha: _hovered ? 0.25 : 0.16)
                    : (_hovered ? AppTheme.surfaceElevated : (AppTheme.dark ? AppTheme.overlay08 : AppTheme.buttonBg)),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: isActive
                      ? activeTint
                      : (_hovered ? (widget.accentColor ?? AppTheme.accentAmber) : AppTheme.borderSoft),
                  width: isActive ? 1.2 : 1.0,
                ),
                boxShadow: [
                  BoxShadow(
                    color: bevelColor,
                    offset: Offset(0, bevel),
                    blurRadius: 0,
                  ),
                  if (_hovered)
                    BoxShadow(
                      color: isActive
                          ? activeTint.withValues(alpha: 0.35)
                          : (widget.accentColor ?? AppTheme.glowPrimary).withValues(alpha: 0.25),
                      blurRadius: 14,
                      spreadRadius: 0.5,
                      offset: const Offset(0, 3.5),
                    ),
                ],
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    widget.label,
                    style: TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w700,
                      // v2.48.88: the active/hover fills are pale
                      // alpha tints — white text reads on them in
                      // dark mode only. In the white theme the
                      // label wears the tint colour itself (or
                      // textMain on hover), never white-on-tint.
                      color: isActive
                          ? (AppTheme.dark ? Colors.white : activeTint)
                          : (_hovered ? (AppTheme.dark ? Colors.white : AppTheme.textMain) : AppTheme.textDim),
                    ),
                  ),
                  const SizedBox(height: 1),
                  Text(
                    '${widget.count}',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                      color: isActive
                          ? (AppTheme.dark ? Colors.white : activeTint)
                          : (_hovered ? (AppTheme.dark ? Colors.white : (widget.accentColor ?? AppTheme.textDim)) : (widget.accentColor ?? AppTheme.textDim)),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _HoverableAccountCard extends StatefulWidget {
  final bool isActive;
  final Widget child;

  const _HoverableAccountCard({
    super.key,
    required this.isActive,
    required this.child,
  });

  @override
  State<_HoverableAccountCard> createState() => _HoverableAccountCardState();
}

class _HoverableAccountCardState extends State<_HoverableAccountCard> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final active = widget.isActive;
    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOutCubic,
        margin: const EdgeInsets.symmetric(vertical: 3),
        transform: Matrix4.translationValues(0, _hovered ? -2.5 : 0.0, 0),
        decoration: BoxDecoration(
          color: active
              ? AppTheme.accentGold.withValues(alpha: _hovered ? 0.20 : 0.12)
              : (_hovered ? AppTheme.surfaceElevated : AppTheme.surfaceElevated),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: active
                ? AppTheme.activeGold
                : (_hovered ? AppTheme.borderHighlight : AppTheme.borderSoft),
            width: active ? 1.3 : 1.0,
          ),
          boxShadow: [
            BoxShadow(
              color: active ? AppTheme.bevelPrimary : AppTheme.bevelSecondary,
              offset: Offset(0, _hovered ? 3.4 : 2.2),
              blurRadius: 0,
            ),
            if (_hovered)
              BoxShadow(
                color: active
                    ? AppTheme.activeGold.withValues(alpha: 0.35)
                    : AppTheme.glowPrimary.withValues(alpha: 0.20),
                blurRadius: 14,
                spreadRadius: 0.5,
                offset: const Offset(0, 3.5),
              ),
          ],
        ),
        child: widget.child,
      ),
    );
  }
}

class _HoverActionGridBtn extends StatefulWidget {
  final String label;
  final String? tooltip;
  final bool isDim;
  final bool isRed;
  final VoidCallback? onTap;

  const _HoverActionGridBtn({
    required this.label,
    this.tooltip,
    this.isDim = false,
    this.isRed = false,
    this.onTap,
  });

  @override
  State<_HoverActionGridBtn> createState() => _HoverActionGridBtnState();
}

class _HoverActionGridBtnState extends State<_HoverActionGridBtn> {
  bool _hovered = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    final double translateY = (_pressed && enabled) ? 1.5 : ((_hovered && enabled) ? -2.5 : 0.0);
    final double bevel = (_pressed && enabled) ? 0.8 : ((_hovered && enabled) ? 3.7 : 2.5);
    final bevelColor = AppTheme.bevelSecondary;

    return MouseRegion(
      onEnter: (_) {
        if (enabled) setState(() => _hovered = true);
      },
      onExit: (_) {
        if (enabled) {
          setState(() {
            _hovered = false;
            _pressed = false;
          });
        }
      },
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      child: Tooltip(
        message: widget.tooltip ?? widget.label,
        child: GestureDetector(
          onTapDown: (_) {
            if (enabled) setState(() => _pressed = true);
          },
          onTapUp: (_) {
            if (_pressed) setState(() => _pressed = false);
          },
          onTapCancel: () {
            if (_pressed) setState(() => _pressed = false);
          },
          onTap: widget.onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOutCubic,
            height: 30,
            alignment: Alignment.center,
            transform: Matrix4.translationValues(0, translateY, 0),
            decoration: BoxDecoration(
              // Clean dark slate background — NO red fill brick!
              // v2.48.88: light fill = the inputBg token, not a slab.
              // v2.48.90: light fill = buttonBg, the uniform
              // warm-tan button face shared by every button.
              color: _hovered && enabled
                  ? AppTheme.surfaceElevated
                  : (AppTheme.dark ? AppTheme.overlay08 : AppTheme.buttonBg),
              borderRadius: BorderRadius.circular(6),
              border: Border.all(
                color: _hovered && enabled
                    ? (widget.isRed ? AppTheme.red : AppTheme.accentAmber)
                    : AppTheme.borderSoft,
              ),
              boxShadow: [
                BoxShadow(
                  color: enabled
                      ? (widget.isRed ? AppTheme.red.withValues(alpha: 0.3) : bevelColor)
                      : (AppTheme.dark ? Colors.black26 : AppTheme.borderSoft),
                  offset: Offset(0, bevel),
                  blurRadius: 0,
                ),
                if (_hovered && enabled)
                  BoxShadow(
                    color: widget.isRed
                        ? AppTheme.red.withValues(alpha: 0.30)
                        : AppTheme.glowPrimary.withValues(alpha: 0.25),
                    blurRadius: 14,
                    spreadRadius: 0.5,
                    offset: const Offset(0, 3.5),
                  ),
              ],
            ),
            child: Text(
              widget.label,
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w600,
                color: widget.isRed
                    // v2.48.89: the half-alpha pale red is a dark-mode
                    // dim only — in light mode the dim red label wears
                    // the deepened red token at full strength.
                    ? (widget.isDim ? (AppTheme.dark ? const Color(0x80F87171) : AppTheme.red) : AppTheme.red)
                    : (widget.isDim
                        ? AppTheme.textFaint
                        : (_hovered
                            ? (AppTheme.dark ? Colors.white : AppTheme.textMain)
                            : AppTheme.textMain)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _HoverBottomSettingsBtn extends StatefulWidget {
  final bool isGenerate;
  final VoidCallback onTap;

  const _HoverBottomSettingsBtn({required this.isGenerate, required this.onTap});

  @override
  State<_HoverBottomSettingsBtn> createState() => _HoverBottomSettingsBtnState();
}

class _HoverBottomSettingsBtnState extends State<_HoverBottomSettingsBtn> {
  bool _hovered = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final active = !widget.isGenerate;
    final double translateY = _pressed ? 1.5 : (_hovered ? -2.5 : 0.0);
    final double bevel = _pressed ? 0.8 : (_hovered ? 3.7 : 2.5);

    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() {
        _hovered = false;
        _pressed = false;
      }),
      cursor: SystemMouseCursors.click,
      child: Tooltip(
        message: active ? 'Return to Main Studio Screen (Esc)' : 'Open Settings & Appearance (Ctrl + ,)',
        child: GestureDetector(
          onTapDown: (_) => setState(() => _pressed = true),
          onTapUp: (_) => setState(() => _pressed = false),
          onTapCancel: () => setState(() => _pressed = false),
          onTap: widget.onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOutCubic,
            height: 31,
            alignment: Alignment.center,
            transform: Matrix4.translationValues(0, translateY, 0),
            decoration: BoxDecoration(
              // Clean dark slate background — NO brown fill brick!
              color: _hovered
                  ? AppTheme.surfaceElevated
                  : (AppTheme.dark ? AppTheme.overlay08 : AppTheme.buttonBg),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: active
                    ? AppTheme.accentGold.withValues(alpha: _hovered ? 0.8 : 0.5)
                    : (_hovered ? AppTheme.accentAmber : AppTheme.borderSoft),
              ),
              boxShadow: [
                BoxShadow(
                  color: AppTheme.bevelSecondary,
                  offset: Offset(0, bevel),
                  blurRadius: 0,
                ),
                if (_hovered)
                  BoxShadow(
                    color: active
                        ? AppTheme.accentGold.withValues(alpha: 0.30)
                        : AppTheme.glowPrimary.withValues(alpha: 0.25),
                    blurRadius: 14,
                    spreadRadius: 0.5,
                    offset: const Offset(0, 3.5),
                  ),
              ],
            ),
            child: Text(
              active ? '← Back to Studio' : '⚙ Settings',
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: active ? FontWeight.bold : FontWeight.w600,
                color: active
                    ? AppTheme.accentText
                    : (_hovered
                        ? (AppTheme.dark ? Colors.white : AppTheme.textMain)
                        : AppTheme.textDim),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
