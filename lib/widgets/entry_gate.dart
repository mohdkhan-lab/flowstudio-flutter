import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../providers/entry_provider.dart';
import '../services/automation_bridge.dart';

/// PUBLIC v1.0.0: the ENTRY GATE screen — the only screen the app
/// shows before entry is granted (see EntryProvider). Two doors:
///
///   DOOR A — ACCOUNT: "Continue with Google", or an email address
///   plus a password (Sign in / Create account, with a Forgot
///   password action). The account is NOT an entry — signing in
///   exists only so the key service can EMAIL the account's
///   license key (v1.0.6: the key is never shown in the app; the
///   service emails the short FS-XXXX-XXXX-XXXX key and the user
///   pastes it from the email into Door B). v1.0.7 (A2): the key
///   email is AUTOMATIC — one attempt the moment a sign-in
///   completes, its state shown on the signed-in strip (sending /
///   sent / could-not-send, with a manual retry). v1.0.7 (A3):
///   email sign-up is verify-first and says so in plain words —
///   account created → verification link by email → sign in →
///   key by email; an unverified sign-in lands on the same
///   verification state with its own wording. An email user
///   whose address is not verified yet gets the verification
///   state: the verification LINK (Firebase's email) and, as the
///   second route, a 6-digit email CODE. If the backend were
///   ever unconfigured, the door would show the honest
///   not-available message and stay disabled — no mock sign-in.
///
///   DOOR B — LICENSE KEY: a short key (exchanged with the key
///   service for the signed token it holds — the redeem step in
///   the bridge) or a legacy long signed key (checked by the
///   engine offline), bound to this one device on activation.
///   The notice above the field — "Internet is required to
///   activate your license key." — is shown BEFORE the first
///   activation attempt, so nobody is surprised by it (the
///   owner's explicit order).
///
/// v1.0.7 (C2 + A1): the gate window is a wide, low 640×520
/// panel and the card is a TWO-ZONE layout that fits it whole —
/// NO scrolling at 100% Windows scaling in any state. Left zone:
/// logo, app name, tagline, the free-trial note. Right zone: the
/// signed-in strip (when a sign-in is pending), the key door,
/// then exactly one of the check-email block / the verification
/// state / the get-my-key sign-in form. FIT BUDGET (line height
/// counted conservatively at 1.25× font size): card padding
/// 18+14; right zone's tallest state (sign-up form) = key
/// section 113 + divider 29 + form 232 = 374; card total ≈ 406
/// of the 520 window height — and the other states are shorter
/// (strip ≈ 247, check-email ≈ 285, verification ≈ 395). A
/// scroll view remains ONLY as a fallback for viewport heights
/// below the design viewport (see _gateScrollFallbackHeight).
///
/// v1.0.7 (C3): there is NO Machine ID box on the gate any more
/// (owner's order). The machine fingerprint still exists inside
/// the engine — the one-device binding is unchanged — it is
/// simply never displayed here.
///
/// STARTUP: while the engine starts and the first entry answer
/// is on its way, a splash screen shows instead of the gate card
/// (see _buildStartupScreen); its progress is the provider's
/// determinate engineStage (start → process up → port answering
/// → entry answer), never a fake bar.

// The entry's own dark palette — "Midnight Gold" (v1.0.6) —
// splash + gate card.
const Color _entryBg = Color(0xFF0B0B10);
const Color _entryCard = Color(0xFF14141C);
const Color _entryPanel = Color(0xFF1B1B25);
const Color _entryBorder = Color(0xFF26262F);
const Color _entryText = Color(0xFFF2F2F5);
const Color _entryDim = Color(0xFF9A9AAD);
const Color _entryFaint = Color(0xFF6D6D80);
const Color _entryGold = Color(0xFFF5B83D);
const Color _entryGoldText = Color(0xFF221500);
const Color _entryBtn = Color(0xFF1A1A23);
const Color _entryWhite = Color(0xFFF7F5F0);
const Color _entryWhiteText = Color(0xFF1C1C22);
const Color _entryRed = Color(0xFFFF8585);
const Color _entryRedBg = Color(0xFF2A1215);

/// v1.0.7 (A1): the design viewport is the 640×520 gate window's
/// client area (≈485 tall at 100% scaling, window chrome
/// included in the 520). The gate renders statically at that
/// size; only a viewport shorter than this falls back to
/// scrolling, so content can never be trapped off-screen.
const double _gateScrollFallbackHeight = 460;

class EntryGateScreen extends StatefulWidget {
  const EntryGateScreen({super.key});

  @override
  State<EntryGateScreen> createState() => _EntryGateScreenState();
}

class _EntryGateScreenState extends State<EntryGateScreen> {
  final TextEditingController _emailController = TextEditingController();
  final TextEditingController _passwordController = TextEditingController();
  final TextEditingController _keyController = TextEditingController();
  final TextEditingController _otpController = TextEditingController();

  // Door A mode: false = Sign in, true = Create account.
  bool _signUpMode = false;

  // v1.0.5: the verification state's code (the six boxes render
  // this string; the hidden field behind them owns the keyboard).
  String _otpCode = '';

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _keyController.dispose();
    _otpController.dispose();
    super.dispose();
  }

  /// v1.0.6: keep a SHORT key tidy while it is typed or pasted —
  /// uppercase, grouped FS-XXXX-XXXX-XXXX. Only input that is
  /// short-key shaped is touched (an FS-prefixed entry, or a bare
  /// 12-hex paste); a long legacy key is left exactly as typed.
  void _onKeyChanged(String value) {
    final compact =
        value.toUpperCase().replaceAll(RegExp(r'[^0-9A-Z]'), '');
    String hex;
    if (compact.startsWith('FS')) {
      hex = compact.substring(2);
    } else if (compact.length == 12) {
      hex = compact;
    } else {
      return;
    }
    if (hex.isEmpty || hex.length > 12) return;
    if (!RegExp(r'^[0-9A-F]+$').hasMatch(hex)) return;
    final buf = StringBuffer('FS');
    for (var i = 0; i < hex.length; i++) {
      if (i % 4 == 0) buf.write('-');
      buf.write(hex[i]);
    }
    final formatted = buf.toString();
    if (formatted != value) {
      _keyController.value = TextEditingValue(
        text: formatted,
        selection: TextSelection.collapsed(offset: formatted.length),
      );
    }
  }

  Widget _field({
    required TextEditingController controller,
    required String hint,
    bool enabled = true,
    int maxLines = 1,
    bool obscureText = false,
    ValueChanged<String>? onChanged,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: _entryPanel,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _entryBorder),
      ),
      child: TextField(
        controller: controller,
        enabled: enabled,
        maxLines: maxLines,
        obscureText: obscureText,
        onChanged: onChanged,
        style: const TextStyle(fontSize: 12.5, color: _entryText),
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: const TextStyle(fontSize: 12, color: _entryFaint),
          border: InputBorder.none,
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(vertical: 9),
        ),
      ),
    );
  }

  Widget _btn({
    required String label,
    required bool enabled,
    required VoidCallback onTap,
    bool gold = false,
    bool white = false,
    double height = 38,
  }) {
    // Midnight Gold: gold buttons carry the sample's vertical
    // gold gradient; the Google button is white; the rest are
    // quiet dark buttons with the hairline border.
    final BoxDecoration decoration = gold
        ? BoxDecoration(
            gradient: const LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [Color(0xFFF2B544), Color(0xFFDD941F)],
            ),
            borderRadius: BorderRadius.circular(12),
          )
        : white
            ? BoxDecoration(
                color: _entryWhite,
                borderRadius: BorderRadius.circular(12),
              )
            : BoxDecoration(
                color: _entryBtn,
                border: Border.all(color: _entryBorder),
                borderRadius: BorderRadius.circular(12),
              );
    return Opacity(
      opacity: enabled ? 1 : 0.45,
      child: Container(
        decoration: decoration,
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            onTap: enabled ? onTap : null,
            borderRadius: BorderRadius.circular(12),
            child: Container(
              height: height,
              alignment: Alignment.center,
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.bold,
                  color: gold
                      ? _entryGoldText
                      : (white ? _entryWhiteText : _entryText),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _sectionLabel(String text) {
    return Text(
      text,
      style: const TextStyle(
        fontSize: 10,
        fontWeight: FontWeight.bold,
        letterSpacing: 1.0,
        color: _entryGold,
      ),
    );
  }

  Widget _linkButton(String label, VoidCallback? onTap) {
    return TextButton(
      onPressed: onTap,
      style: TextButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        minimumSize: const Size(0, 24),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.bold,
          color: _entryGold,
        ),
      ),
    );
  }

  /// v1.0.7 (C2): the LEFT zone — the brand block of the
  /// two-zone card: logo, app name, tagline, the free-trial chip
  /// and the note that replaces the old footer line.
  Widget _brandZone() {
    return SizedBox(
      width: 176,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Image.asset(
            'assets/icon.png',
            width: 46,
            height: 46,
            errorBuilder: (_, _, _) => const Icon(
              Icons.auto_awesome,
              size: 46,
              color: _entryGold,
            ),
          ),
          const SizedBox(height: 9),
          const Text(
            'FlowStudio',
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: _entryText,
            ),
          ),
          const SizedBox(height: 3),
          const Text(
            'Multi-Account AI Video Engine',
            style: TextStyle(fontSize: 11, color: _entryDim),
          ),
          const SizedBox(height: 16),
          Container(
            padding:
                const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: _entryGold),
            ),
            child: const Text(
              '7-DAY FREE TRIAL',
              style: TextStyle(
                fontSize: 9.5,
                fontWeight: FontWeight.bold,
                letterSpacing: 0.8,
                color: _entryGold,
              ),
            ),
          ),
          const SizedBox(height: 9),
          const Text(
            'No license key? Sign in with Google or email — your '
            'free trial key arrives by email.',
            style: TextStyle(fontSize: 10.5, color: _entryFaint),
          ),
        ],
      ),
    );
  }

  /// DOOR B — the license-key section, shared by every state:
  /// label, the internet notice (before the field, always), the
  /// key field and the Activate button.
  Widget _keySection(EntryProvider entry) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _sectionLabel('LICENSE KEY'),
        const SizedBox(height: 4),
        const Text(
          'Internet is required to activate your license key.',
          style: TextStyle(fontSize: 11, color: _entryDim),
        ),
        const SizedBox(height: 5),
        _field(
          controller: _keyController,
          hint: 'Paste your license key — FS-XXXX-XXXX-XXXX',
          enabled: entry.loaded && !entry.busy,
          maxLines: 2,
          onChanged: _onKeyChanged,
        ),
        const SizedBox(height: 6),
        _btn(
          gold: true,
          height: 38,
          label: entry.busy ? 'Working…' : 'Activate',
          enabled: entry.loaded && !entry.busy,
          onTap: () {
            context.read<EntryProvider>().activateKey(_keyController.text);
          },
        ),
      ],
    );
  }

  /// v1.0.7 (A2) — the SIGNED-IN STRIP as a STATUS LINE. The key
  /// email fires automatically when a sign-in completes; the
  /// strip reports it: sending → "Sending your license key to
  /// <email>…"; sender failure → "We could not email your key
  /// yet." with the "Email my key" button as the manual retry;
  /// success leaves this strip for the check-email block below.
  /// The neutral line covers the moment before the automatic
  /// attempt starts.
  Widget _signedInStrip(EntryProvider entry) {
    final status = entry.keyEmailSending
        ? 'Sending your license key to ${entry.accountEmail}…'
        : entry.keyEmailFailed
            ? 'We could not email your key yet.'
            : 'Signed in as ${entry.accountEmail} — your license '
                'key comes by email.';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: _entryPanel,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _entryBorder),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              status,
              style: const TextStyle(fontSize: 11, color: _entryDim),
            ),
          ),
          if (!entry.keyEmailSending)
            _linkButton(
              'Email my key',
              entry.busy
                  ? null
                  : () => context.read<EntryProvider>().fetchMyKey(),
            ),
          _linkButton(
            'Sign out',
            entry.busy
                ? null
                : () => context.read<EntryProvider>().signOut(),
          ),
        ],
      ),
    );
  }

  /// v1.0.6 — the CHECK-YOUR-EMAIL block: the key service has
  /// emailed this sign-in's short key. The key is NEVER shown in
  /// the app (the owner's order) — the user pastes it into the
  /// key box above. "Resend key email" re-sends the SAME key;
  /// Sign out drops the pending sign-in. v1.0.7 (A2): the
  /// wording is the automatic-email success line.
  Widget _checkEmailBlock(EntryProvider entry) {
    final enabled = entry.loaded && !entry.busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _sectionLabel('YOUR LICENSE KEY'),
        const SizedBox(height: 6),
        Container(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
          decoration: BoxDecoration(
            color: _entryPanel,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: _entryBorder),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Your license key has been sent to ${entry.accountEmail} '
                '— check your inbox, then paste it above to activate.',
                style: const TextStyle(fontSize: 12, color: _entryText),
              ),
              const SizedBox(height: 4),
              Text(
                entry.keyEmailedReused
                    ? 'It is the same key as before — one key for this account.'
                    : 'Plan: ${entry.keyEmailedPlan} · valid until ${entry.keyEmailedExp}',
                style: const TextStyle(fontSize: 10.5, color: _entryFaint),
              ),
            ],
          ),
        ),
        const SizedBox(height: 3),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            _linkButton(
              'Resend key email',
              enabled
                  ? () => context.read<EntryProvider>().fetchMyKey()
                  : null,
            ),
            _linkButton(
              'Sign out',
              entry.busy
                  ? null
                  : () => context.read<EntryProvider>().signOut(),
            ),
          ],
        ),
      ],
    );
  }

  /// v1.0.5 — the six code boxes: a hidden text field owns the
  /// keyboard; the boxes only render the digits typed so far.
  /// v1.0.7: the boxes are sized for the two-zone card's right
  /// zone.
  Widget _otpCodeInput(EntryProvider entry) {
    return Stack(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: List.generate(6, (i) {
            final filled = i < _otpCode.length;
            final active = i == _otpCode.length;
            return Container(
              width: 46,
              height: 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: _entryPanel,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: active ? _entryGold : _entryBorder,
                  width: active ? 1.4 : 1,
                ),
              ),
              child: Text(
                filled ? _otpCode[i] : '',
                style: const TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: _entryText,
                  fontFamily: 'Consolas',
                ),
              ),
            );
          }),
        ),
        Positioned.fill(
          child: Opacity(
            opacity: 0,
            child: TextField(
              controller: _otpController,
              enabled: entry.loaded && !entry.busy,
              keyboardType: TextInputType.number,
              maxLength: 6,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: const InputDecoration(
                border: InputBorder.none,
                counterText: '',
              ),
              onChanged: (v) => setState(() => _otpCode = v),
            ),
          ),
        ),
      ],
    );
  }

  /// v1.0.7 (A3) — the VERIFICATION STATE, verify-first and
  /// written plainly. A fresh sign-up opens with "Account
  /// created" + the three steps; a sign-in that lands
  /// unverified opens with the "not verified yet" line. Both
  /// carry the Resend verification link button. The CODE route
  /// stays as the second way: once a code is asked for, the
  /// state focuses on the code (boxes + Verify + a way back to
  /// the link).
  Widget _verificationCard(EntryProvider entry) {
    final enabled = entry.loaded && !entry.busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _sectionLabel('VERIFY YOUR EMAIL'),
        const SizedBox(height: 5),
        if (!entry.otpSent) ...[
          if (entry.accountJustCreated) ...[
            Text(
              'Account created. We sent a verification link to '
              '${entry.accountEmail}.',
              style: const TextStyle(fontSize: 11.5, color: _entryDim),
            ),
            const SizedBox(height: 6),
            const Text(
              '1 — Open the link in your email to verify.\n'
              '2 — Come back and sign in.\n'
              '3 — Your license key will be emailed to you.',
              style: TextStyle(fontSize: 11, color: _entryDim),
            ),
          ] else
            Text(
              'Your email is not verified yet. Please click the verification link we sent to ${entry.accountEmail} first.',
              style: const TextStyle(fontSize: 11.5, color: _entryDim),
            ),
          const SizedBox(height: 8),
          _btn(
            height: 34,
            enabled: enabled,
            label: 'Resend verification link',
            onTap: () {
              context.read<EntryProvider>().sendVerificationLink();
            },
          ),
          const SizedBox(height: 3),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Opened the link already?',
                style: TextStyle(fontSize: 11, color: _entryFaint),
              ),
              _linkButton(
                'Fetch my key',
                enabled
                    ? () => context.read<EntryProvider>().fetchMyKey()
                    : null,
              ),
            ],
          ),
          const SizedBox(height: 5),
          const Text(
            'Or get a code by email instead:',
            style: TextStyle(fontSize: 11.5, color: _entryDim),
          ),
          const SizedBox(height: 6),
          _btn(
            height: 34,
            enabled: enabled,
            label: 'Send code',
            onTap: () {
              context.read<EntryProvider>().sendOtp();
            },
          ),
        ] else ...[
          Text(
            'Enter the 6-digit code we sent to ${entry.accountEmail}.',
            style: const TextStyle(fontSize: 11.5, color: _entryDim),
          ),
          const SizedBox(height: 7),
          _otpCodeInput(entry),
          const SizedBox(height: 7),
          _btn(
            gold: true,
            height: 36,
            enabled: enabled && _otpCode.length == 6,
            label: entry.busy ? 'Working…' : 'Verify code',
            onTap: () {
              context.read<EntryProvider>().verifyOtp(_otpCode);
            },
          ),
          const SizedBox(height: 4),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'No code?',
                style: TextStyle(fontSize: 11, color: _entryFaint),
              ),
              _linkButton(
                'Use the verification link instead',
                enabled
                    ? () => context
                        .read<EntryProvider>()
                        .backToVerificationLink()
                    : null,
              ),
            ],
          ),
        ],
      ],
    );
  }

  /// DOOR A — the GET MY FREE KEY sign-in form (Google + email).
  /// v1.0.7 (A3): in Create-account mode the form carries the
  /// three-step explainer above its button, so the verify-first
  /// flow is written down before the user even starts it.
  Widget _signInForm(EntryProvider entry, bool doorAEnabled) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _sectionLabel('GET MY FREE KEY'),
        const SizedBox(height: 6),
        _btn(
          white: true,
          height: 36,
          enabled: doorAEnabled,
          label: 'Continue with Google',
          onTap: () async {
            final url = await AutomationBridge.instance.getGoogleAuthUrl();
            if (url != null && url.isNotEmpty) {
              await AutomationBridge.instance.openUrl(url);
              // The sign-in finishes in the browser; watch the
              // entry status so the pending sign-in — and then
              // its automatic key email — lands here on its own.
              if (context.mounted) {
                context.read<EntryProvider>().startAccountWatch();
              }
            }
          },
        ),
        const SizedBox(height: 6),
        _field(
          controller: _emailController,
          hint: 'Email address',
          enabled: doorAEnabled,
        ),
        const SizedBox(height: 6),
        _field(
          controller: _passwordController,
          hint: 'Password',
          enabled: doorAEnabled,
          obscureText: true,
        ),
        if (_signUpMode) ...[
          const SizedBox(height: 5),
          const Text(
            'Create account → Verify your email → Sign in and get your key by email.',
            style: TextStyle(fontSize: 10, color: _entryFaint),
          ),
        ],
        const SizedBox(height: 6),
        _btn(
          gold: true,
          height: 36,
          enabled: doorAEnabled,
          label: entry.busy
              ? 'Working…'
              : (_signUpMode ? 'Create account' : 'Sign in'),
          onTap: () {
            final provider = context.read<EntryProvider>();
            if (_signUpMode) {
              provider.signUp(
                  _emailController.text, _passwordController.text);
            } else {
              provider.signIn(
                  _emailController.text, _passwordController.text);
            }
          },
        ),
        const SizedBox(height: 2),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            _linkButton(
              _signUpMode
                  ? 'Already have an account? Sign in'
                  : 'New here? Create account',
              doorAEnabled
                  ? () => setState(() => _signUpMode = !_signUpMode)
                  : null,
            ),
            if (!_signUpMode)
              _linkButton(
                'Forgot password?',
                doorAEnabled
                    ? () => context
                        .read<EntryProvider>()
                        .forgotPassword(_emailController.text)
                    : null,
              ),
          ],
        ),
      ],
    );
  }

  /// v1.0.4 — the STARTUP SCREEN, rebuilt dark and centred like
  /// a market app's splash: big logo, the app name, the tagline,
  /// a progress bar that fills with the real engine state, a
  /// status line that follows it, and the version at the bottom.
  /// The watchdog's engineFailed state lives here too, with its
  /// Retry button (v1.0.1 behaviour, kept).
  /// v1.0.6 (F5): the progress is DETERMINATE — the provider's
  /// engineStage (0 start requested → 1 process up → 2 port
  /// answering → 3 entry answer in) over 3, with a status line
  /// per stage. The old two hard-coded steps made the whole
  /// engine-start wait look like one frozen bar.
  Widget _buildStartupScreen(BuildContext context, EntryProvider entry) {
    final double progress =
        entry.engineFailed ? 0 : entry.engineStage / 3;
    final String status = entry.loaded
        ? 'Workspace ready!'
        : entry.engineStage >= 2
            ? 'Checking your entry…'
            : entry.engineStage >= 1
                ? 'Engine is up — waiting for it to answer…'
                : 'Starting the engine…';
    return Scaffold(
      backgroundColor: _entryBg,
      body: Stack(
        children: [
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Image.asset(
                  'assets/icon.png',
                  width: 96,
                  height: 96,
                  errorBuilder: (_, _, _) => const Icon(
                    Icons.auto_awesome,
                    size: 96,
                    color: _entryGold,
                  ),
                ),
                const SizedBox(height: 18),
                const Text(
                  'FlowStudio',
                  style: TextStyle(
                    fontSize: 34,
                    fontWeight: FontWeight.bold,
                    color: _entryText,
                  ),
                ),
                const SizedBox(height: 5),
                const Text(
                  'Multi-Account AI Video Engine',
                  style: TextStyle(fontSize: 13, color: _entryDim),
                ),
                const SizedBox(height: 30),
                SizedBox(
                  width: 340,
                  child: LinearProgressIndicator(
                    value: progress,
                    minHeight: 4,
                    color: _entryGold,
                    backgroundColor: _entryBorder,
                  ),
                ),
                const SizedBox(height: 14),
                if (!entry.engineFailed)
                  Text(
                    status,
                    style: const TextStyle(fontSize: 12, color: _entryDim),
                  ),
                if (entry.engineFailed) ...[
                  Container(
                    width: 340,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 9),
                    decoration: BoxDecoration(
                      color: _entryRedBg,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: _entryRed),
                    ),
                    child: Row(
                      children: [
                        const Expanded(
                          child: Text(
                            'The engine could not start.',
                            style: TextStyle(fontSize: 11, color: _entryRed),
                          ),
                        ),
                        const SizedBox(width: 8),
                        SizedBox(
                          width: 96,
                          child: _btn(
                            label: 'Retry',
                            height: 28,
                            enabled: true,
                            onTap: () {
                              context.read<EntryProvider>().retryEngine();
                            },
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
          const Positioned(
            left: 0,
            right: 0,
            bottom: 18,
            child: Text(
              'v1.0.7',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 10.5, color: _entryFaint),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final entry = context.watch<EntryProvider>();
    // v1.0.2: before the first entry answer the STARTUP SCREEN
    // shows (splash), not the gate card.
    if (!entry.loaded && !entry.engineFailed) {
      return _buildStartupScreen(context, entry);
    }
    if (!entry.loaded && entry.engineFailed) {
      return _buildStartupScreen(context, entry);
    }
    // v1.0.1: every control waits for the engine's first answer
    // (entry.loaded), not just for !busy — in v1.0.0 the key field
    // and Activate were live against a dead port and could only
    // fail with "The engine is not answering".
    final doorAEnabled =
        entry.loaded && entry.doorAConfigured && !entry.busy;
    // v1.0.5: a landed sign-in (Google watch, email sign-in, or
    // a legacy account adopted by the bridge) shows as the
    // signed-in strip — the sign-in's only job is the key step,
    // and the strip carries that step's status (v1.0.7 A2). It
    // hides while the check-email block or the verification
    // state is on show (both name the email themselves).
    final signedIn = entry.accountEmail.isNotEmpty;
    final showStrip =
        signedIn && !entry.keyEmailed && !entry.needsVerification;
    final card = Container(
      width: 608,
      padding: const EdgeInsets.fromLTRB(22, 18, 22, 14),
      decoration: BoxDecoration(
        color: _entryCard,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _entryBorder),
      ),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _brandZone(),
            const SizedBox(width: 18),
            const VerticalDivider(
              width: 1,
              thickness: 1,
              color: _entryBorder,
            ),
            const SizedBox(width: 18),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (showStrip) ...[
                    _signedInStrip(entry),
                    const SizedBox(height: 12),
                  ],
                  _keySection(entry),
                  if (!showStrip) ...[
                    const SizedBox(height: 9),
                    const Row(
                      children: [
                        Expanded(
                            child: Divider(height: 1, color: _entryBorder)),
                        Padding(
                          padding: EdgeInsets.symmetric(horizontal: 10),
                          child: Text(
                            'or',
                            style:
                                TextStyle(fontSize: 11, color: _entryFaint),
                          ),
                        ),
                        Expanded(
                            child: Divider(height: 1, color: _entryBorder)),
                      ],
                    ),
                    const SizedBox(height: 7),
                    // Below the divider the card is in exactly
                    // one of three states — the check-email
                    // block, the verification state, or the
                    // get-my-key sign-in form.
                    if (entry.keyEmailed)
                      _checkEmailBlock(entry)
                    else if (entry.needsVerification)
                      _verificationCard(entry)
                    else
                      _signInForm(entry, doorAEnabled),
                  ],
                  if (entry.notice.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(
                      entry.notice,
                      style:
                          const TextStyle(fontSize: 10.5, color: _entryDim),
                    ),
                  ],
                  if (!entry.doorAConfigured) ...[
                    const SizedBox(height: 6),
                    Text(
                      entry.doorAMessage,
                      style: const TextStyle(
                          fontSize: 10.5, color: _entryFaint),
                    ),
                  ],
                  if (entry.error.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 8),
                      decoration: BoxDecoration(
                        color: _entryRedBg,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: _entryRed),
                      ),
                      child: Text(
                        entry.error,
                        style:
                            const TextStyle(fontSize: 11, color: _entryRed),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
    return Scaffold(
      backgroundColor: _entryBg,
      body: LayoutBuilder(
        builder: (context, constraints) {
          // v1.0.7 (A1): at the design size the card is static —
          // nothing scrolls. The scroll view is a fallback for
          // viewport heights below the design viewport only.
          if (constraints.maxHeight < _gateScrollFallbackHeight) {
            return SingleChildScrollView(
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: constraints.maxHeight),
                child: Center(child: card),
              ),
            );
          }
          return Center(child: card);
        },
      ),
    );
  }
}
