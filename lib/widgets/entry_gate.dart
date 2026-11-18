import 'dart:async';
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
///   password action). Phase 2 (v1.0.2): the account backend is
///   live (Firebase) and sign-in is real. v1.0.5: THE ACCOUNT IS
///   NOT AN ENTRY any more — the "Get my free key" section below
///   the divider signs the user in ONLY to fetch their license
///   key from the key service. v1.0.6: the key is never shown in
///   the app — the service EMAILS the account's short key
///   (FS-XXXX-XXXX-XXXX), the card shows a "Check your email"
///   state, and the user pastes the key from the email into
///   Door B. An email user whose address is not verified yet gets
///   the verification card instead: a verification LINK
///   (Firebase's email) and, as the second route, a 6-digit email
///   CODE (the key service's — which honestly reports itself
///   unavailable until its sender is set up). If the backend were
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
/// v1.0.4: the gate and the startup screen were redesigned as ONE
/// dark, professional entry (the owner's reference: a competitor
/// activation card) — a Machine ID box with Copy at the top, the
/// license-key door FIRST, then the account doors below an "or"
/// divider. A user who signs in with Google but has no active
/// plan lands back on this same card, signed-in line showing,
/// with the key section right there to paste into. The palette
/// below is deliberately local to this screen: the entry is dark
/// even though the studio behind it is not.
///
/// v1.0.6: the look is the owner's approved "Midnight Gold"
/// design (live sample, picked 2026-11-18): deep charcoal-black,
/// gold accent, white Google button, radius 16 card. The window
/// itself is the small fixed 420×620 panel during this phase
/// (see the engine's window phases) — the card is sized for it,
/// with a scroll fallback so no state can overflow.
///
/// STARTUP: while the engine starts and the first entry answer is
/// on its way, a splash screen shows instead of the gate card
/// (see _buildStartupScreen). v1.0.6 (F5): its progress is the
/// provider's determinate engineStage (start → process up → port
/// answering → entry answer), never a fake bar.

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

  // Machine ID copy feedback (the chip reads "Copied" briefly).
  bool _idCopied = false;
  Timer? _copiedTimer;

  // v1.0.5: the verification card's code (the six boxes render
  // this string; the hidden field behind them owns the keyboard).
  String _otpCode = '';

  @override
  void dispose() {
    _copiedTimer?.cancel();
    _emailController.dispose();
    _passwordController.dispose();
    _keyController.dispose();
    _otpController.dispose();
    super.dispose();
  }

  void _copyMachineId(String machineId) {
    if (machineId.isEmpty) return;
    Clipboard.setData(ClipboardData(text: machineId));
    setState(() => _idCopied = true);
    _copiedTimer?.cancel();
    _copiedTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _idCopied = false);
    });
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
          contentPadding: const EdgeInsets.symmetric(vertical: 10),
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
        minimumSize: const Size(0, 26),
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

  /// v1.0.4 — the Machine ID box at the top of the card: the
  /// label and a Copy chip on one row, this PC's identity in a
  /// clean FS-XXXX-XXXX-XXXX format (the engine derives it
  /// deterministically from the one-device fingerprint), and the
  /// binding line underneath.
  Widget _machineIdBox(EntryProvider entry) {
    final machineId = entry.machineId;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 10, 11),
      decoration: BoxDecoration(
        color: _entryPanel,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _entryBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Expanded(
                child: Text(
                  'YOUR MACHINE ID',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 1.0,
                    color: _entryGold,
                  ),
                ),
              ),
              Material(
                color: _entryBtn,
                borderRadius: BorderRadius.circular(6),
                child: InkWell(
                  onTap: machineId.isEmpty
                      ? null
                      : () => _copyMachineId(machineId),
                  borderRadius: BorderRadius.circular(6),
                  child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    decoration: BoxDecoration(
                      border: Border.all(color: _entryBorder),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      _idCopied ? 'Copied' : 'Copy',
                      style: const TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.bold,
                        color: _entryText,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 7),
          Text(
            machineId.isEmpty ? '—' : machineId,
            style: const TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.bold,
              letterSpacing: 1.4,
              color: _entryText,
              fontFamily: 'Consolas',
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'Your license key will be locked to this computer.',
            style: TextStyle(fontSize: 10.5, color: _entryFaint),
          ),
        ],
      ),
    );
  }

  /// v1.0.6 — the CHECK-YOUR-EMAIL block: the key service has
  /// emailed this sign-in's short key. The key is NEVER shown in
  /// the app (the owner's order) — the user pastes it into the
  /// key box above. "Resend key email" re-sends the SAME key;
  /// Sign out drops the pending sign-in.
  Widget _checkEmailBlock(EntryProvider entry) {
    final enabled = entry.loaded && !entry.busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _sectionLabel('YOUR LICENSE KEY'),
        const SizedBox(height: 7),
        Container(
          padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
          decoration: BoxDecoration(
            color: _entryPanel,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: _entryBorder),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Your license key has been sent to ${entry.accountEmail}. '
                'Paste it above to activate.',
                style: const TextStyle(fontSize: 12, color: _entryText),
              ),
              const SizedBox(height: 5),
              Text(
                entry.keyEmailedReused
                    ? 'It is the same key as before — one key for this account.'
                    : 'Plan: ${entry.keyEmailedPlan} · valid until ${entry.keyEmailedExp}',
                style: const TextStyle(fontSize: 10.5, color: _entryFaint),
              ),
            ],
          ),
        ),
        const SizedBox(height: 4),
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
  Widget _otpCodeInput(EntryProvider entry) {
    return Stack(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: List.generate(6, (i) {
            final filled = i < _otpCode.length;
            final active = i == _otpCode.length;
            return Container(
              width: 52,
              height: 48,
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
                  fontSize: 19,
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

  /// v1.0.5 — the VERIFICATION CARD: an email user whose address
  /// is not verified yet cannot be handed a key. Both routes are
  /// here: the Firebase verification LINK, and a 6-digit CODE by
  /// email instead. Either one, once done, unlocks the key fetch.
  Widget _verificationCard(EntryProvider entry) {
    final enabled = entry.loaded && !entry.busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _sectionLabel('VERIFY YOUR EMAIL'),
        const SizedBox(height: 6),
        Text(
          'Your key is ready once ${entry.accountEmail} is verified. '
          'Choose either way:',
          style: const TextStyle(fontSize: 11.5, color: _entryDim),
        ),
        const SizedBox(height: 9),
        _btn(
          height: 36,
          enabled: enabled,
          label: 'Send verification link',
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
        const SizedBox(height: 8),
        if (!entry.otpSent)
          _btn(
            height: 36,
            enabled: enabled,
            label: 'Send code',
            onTap: () {
              context.read<EntryProvider>().sendOtp();
            },
          ),
        if (entry.otpSent) ...[
          _otpCodeInput(entry),
          const SizedBox(height: 9),
          _btn(
            gold: true,
            height: 38,
            enabled: enabled && _otpCode.length == 6,
            label: entry.busy ? 'Working…' : 'Verify code',
            onTap: () {
              context.read<EntryProvider>().verifyOtp(_otpCode);
            },
          ),
        ],
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
              'v1.0.6',
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
    // signed-in strip at the top — the sign-in's only job is the
    // key step, and the strip carries that step. It hides while
    // the check-email block or the verification card is on show
    // (both name the email themselves). v1.0.6: the strip's
    // action asks the service to EMAIL the key.
    final signedIn = entry.accountEmail.isNotEmpty;
    final showStrip =
        signedIn && !entry.keyEmailed && !entry.needsVerification;
    return Scaffold(
      backgroundColor: _entryBg,
      body: Center(
        // v1.0.6: the window is the small 420×620 panel in this
        // phase — the scroll view is only a safety net so no card
        // state can ever overflow it; at the designed sizes the
        // card fits whole and nothing scrolls.
        child: SingleChildScrollView(
          child: Container(
          width: 392,
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
          decoration: BoxDecoration(
            color: _entryCard,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: _entryBorder),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Image.asset(
                  'assets/icon.png',
                  width: 40,
                  height: 40,
                  errorBuilder: (_, _, _) => const Icon(
                    Icons.auto_awesome,
                    size: 40,
                    color: _entryGold,
                  ),
                ),
              ),
              const SizedBox(height: 7),
              const Text(
                'FlowStudio',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 21,
                  fontWeight: FontWeight.bold,
                  color: _entryText,
                ),
              ),
              const SizedBox(height: 3),
              const Text(
                'Multi-Account AI Video Engine',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 11.5, color: _entryDim),
              ),
              if (showStrip) ...[
                const SizedBox(height: 10),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: _entryPanel,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: _entryBorder),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Signed in as ${entry.accountEmail} — your '
                          'license key comes by email.',
                          style: const TextStyle(
                              fontSize: 11, color: _entryDim),
                        ),
                      ),
                      _linkButton(
                        'Email my key',
                        entry.busy
                            ? null
                            : () =>
                                context.read<EntryProvider>().fetchMyKey(),
                      ),
                      _linkButton(
                        'Sign out',
                        entry.busy
                            ? null
                            : () =>
                                context.read<EntryProvider>().signOut(),
                      ),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 11),
              _machineIdBox(entry),
              const SizedBox(height: 11),
              _sectionLabel('LICENSE KEY'),
              const SizedBox(height: 5),
              // The activation notice comes FIRST, above the field,
              // before any activation is attempted.
              const Text(
                'Internet is required to activate your license key.',
                style: TextStyle(fontSize: 11, color: _entryDim),
              ),
              const SizedBox(height: 7),
              _field(
                controller: _keyController,
                hint: 'Paste your license key — FS-XXXX-XXXX-XXXX',
                enabled: entry.loaded && !entry.busy,
                maxLines: 2,
                onChanged: _onKeyChanged,
              ),
              const SizedBox(height: 9),
              _btn(
                gold: true,
                height: 42,
                label: entry.busy ? 'Working…' : 'Activate',
                enabled: entry.loaded && !entry.busy,
                onTap: () {
                  context
                      .read<EntryProvider>()
                      .activateKey(_keyController.text);
                },
              ),
              const SizedBox(height: 11),
              const Row(
                children: [
                  Expanded(child: Divider(height: 1, color: _entryBorder)),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 10),
                    child: Text(
                      'or',
                      style: TextStyle(fontSize: 11, color: _entryFaint),
                    ),
                  ),
                  Expanded(child: Divider(height: 1, color: _entryBorder)),
                ],
              ),
              const SizedBox(height: 9),
              // v1.0.5: below the divider the card is in exactly
              // one of three states — the fetched key, the
              // verification card, or the get-my-key sign-in.
              // v1.0.6: the first state is now the check-email
              // block (the key arrives by email, never in-app).
              if (entry.keyEmailed)
                _checkEmailBlock(entry)
              else if (entry.needsVerification)
                _verificationCard(entry)
              else ...[
                _sectionLabel('GET MY FREE KEY'),
                const SizedBox(height: 8),
                _btn(
                  white: true,
                  height: 38,
                  enabled: doorAEnabled,
                  label: 'Continue with Google',
                  onTap: () async {
                    final url =
                        await AutomationBridge.instance.getGoogleAuthUrl();
                    if (url != null && url.isNotEmpty) {
                      await AutomationBridge.instance.openUrl(url);
                      // The sign-in finishes in the browser; watch
                      // the entry status so the pending sign-in —
                      // and then its key — lands here on its own.
                      if (context.mounted) {
                        context.read<EntryProvider>().startAccountWatch();
                      }
                    }
                  },
                ),
                const SizedBox(height: 8),
                _field(
                  controller: _emailController,
                  hint: 'Email address',
                  enabled: doorAEnabled,
                ),
                const SizedBox(height: 7),
                _field(
                  controller: _passwordController,
                  hint: 'Password',
                  enabled: doorAEnabled,
                  obscureText: true,
                ),
                const SizedBox(height: 8),
                _btn(
                  gold: true,
                  height: 38,
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
              if (entry.notice.isNotEmpty) ...[
                const SizedBox(height: 3),
                Text(
                  entry.notice,
                  style: const TextStyle(fontSize: 10.5, color: _entryDim),
                ),
              ],
              if (!entry.doorAConfigured) ...[
                const SizedBox(height: 6),
                Text(
                  entry.doorAMessage,
                  style: const TextStyle(fontSize: 10.5, color: _entryFaint),
                ),
              ],
              if (entry.error.isNotEmpty) ...[
                const SizedBox(height: 8),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  decoration: BoxDecoration(
                    color: _entryRedBg,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: _entryRed),
                  ),
                  child: Text(
                    entry.error,
                    style: const TextStyle(fontSize: 11, color: _entryRed),
                  ),
                ),
              ],
              const SizedBox(height: 10),
              const Text(
                'No license key? Sign in above to get your free trial key.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 10.5, color: _entryFaint),
              ),
            ],
          ),
          ),
        ),
      ),
    );
  }
}
