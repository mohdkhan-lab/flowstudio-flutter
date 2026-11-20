import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

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
/// v1.0.8 (F3 — owner's approved design): the window is ONE size
/// now (the studio's own, from the runner) and the gate is a
/// POPUP PORTAL over the studio: behind the centered single-
/// column card the studio shows as a blurred, darkened,
/// non-interactive shell — visible, beautiful, and unusable
/// until a valid key activates (no entry without a key: the
/// real studio is not even built while gated — the shell behind
/// the blur is a static sketch, never live data). The card
/// keeps every v1.0.7 state and wording — the signed-in strip,
/// the key door, exactly one of the check-email block / the
/// verification state / the get-my-key sign-in form — and adds
/// a WhatsApp support row at its bottom. FIT BUDGET (line
/// height counted conservatively at 1.25× font size): card
/// padding 16+12 = 28; header block 72 (row 36 + note); gap 10;
/// key section 116; divider block 30; the tallest states are
/// the forms (v1.0.9: sign-up form 277, sign-in form 243 —
/// the mode toggle's 30 + gap rides in both, and the sign-up
/// form no longer carries the switch-link row); WhatsApp
/// block 41 — the worst total is 584 of the 800-tall window
/// (sign-in + error), then sign-up 574, verification 519,
/// code 451, check-email 410, strip 325. A scroll view
/// remains ONLY as a fallback for viewport heights below the
/// design viewport (see _gateScrollFallbackHeight).
///
/// v1.0.8 (F4): Create-account mode asks for the user's NAME
/// (the form's first field, required) — the panel shows it and
/// the key email greets with it.
///
/// v1.0.9 (P1 + P2 — the owner's "the portal feels lifeless"
/// order, approved in the live sample): the portal's controls
/// now answer the mouse. Buttons lift on hover (the gold
/// Activate blooms a glow and sweeps a shine, the white Google
/// button grows its shadow and settles its G with a small
/// rotation, dark buttons warm their border toward gold) and
/// settle on press; fields warm their border toward gold on
/// hover and focus; the Sign in / Create account switch is a
/// segmented toggle whose gold pill slides with a spring-lite
/// curve; the WhatsApp glyph bounces once on hover while its
/// row tint deepens; and a NEW error shakes the card once,
/// gently. Icons arrived with it: a key + paste button in the
/// license field, a person in the name field, a mail in the
/// email field, a lock + show/hide eye in the password field,
/// and a shield-check before the internet note. Nothing moved:
/// the icons live INSIDE the fields, the toggle takes the
/// switch link's place in the form, and the fit budget above
/// is re-counted honestly — sign-in form 243, sign-up form 277,
/// the worst state (sign-in + error) 584 of the 800-tall
/// window. Reduced motion (the platform's own setting) stills
/// every flourish; the state changes stay instant.
///
/// v1.0.7 (C3): there is NO Machine ID box on the gate any more
/// (owner's order). The machine fingerprint still exists inside
/// the engine — the one-device binding is unchanged — it is
/// simply never displayed here.
///
/// STARTUP (v1.0.8 F1): while the engine starts and the first
/// entry answer is on its way, an ANIMATED splash shows inside
/// the same full-size window — the logo gently pulses with a
/// gold glow, the determinate progress bar (the provider's real
/// engineStage: start → process up → port answering → entry
/// answer) carries a moving sheen, and the status line shows
/// the real stage text, rotating honest filler lines only while
/// one stage persists. Then the splash crossfades to the
/// portal. The watchdog's engineFailed state lives on the
/// splash too, with its Retry button (v1.0.1 behaviour, kept).

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
const Color _whatsAppGreen = Color(0xFF25D366);

/// v1.0.8: the WhatsApp support link. The number lives ONLY
/// inside this URL — it is never shown as text anywhere in the
/// app (the owner's order).
const String _whatsAppSupportUrl = 'https://wa.me/918198966902';

/// v1.0.8 (F3): the portal's design viewport height — the card
/// (≈564 worst state) renders statically; only a viewport
/// shorter than this falls back to scrolling, so content can
/// never be trapped off-screen.
const double _gateScrollFallbackHeight = 560;

/// The portal card's width — a single centered column.
const double _portalCardWidth = 430;

class EntryGateScreen extends StatefulWidget {
  const EntryGateScreen({super.key});

  @override
  State<EntryGateScreen> createState() => _EntryGateScreenState();
}

class _EntryGateScreenState extends State<EntryGateScreen>
    with SingleTickerProviderStateMixin {
  final TextEditingController _nameController = TextEditingController();
  final TextEditingController _emailController = TextEditingController();
  final TextEditingController _passwordController = TextEditingController();
  final TextEditingController _keyController = TextEditingController();
  final TextEditingController _otpController = TextEditingController();

  // Door A mode: false = Sign in, true = Create account.
  bool _signUpMode = false;

  // v1.0.9 (P2): the password field's show/hide eye — the text
  // is obscured until the eye opens it.
  bool _passwordVisible = false;

  // v1.0.9 (P1): the error shake — a nonce that increments
  // ONLY when a NEW error lands (see _onEntryChanged); the
  // portal card's shake builder animates toward it, so a
  // repeated identical error never re-shakes.
  int _errorShakeNonce = 0;
  String _lastSeenError = '';

  // v1.0.5: the verification state's code (the six boxes render
  // this string; the hidden field behind them owns the keyboard).
  String _otpCode = '';

  // v1.0.8 (F1): the splash's life — one repeating controller
  // drives the logo pulse, the glow, the twinkling stars and
  // the progress bar's sheen. The stage tracker + the 1-second
  // ticker drive the honest filler status lines: while one real
  // stage persists past a few seconds, the line rotates; the
  // moment the stage changes, the real stage text is back.
  late final AnimationController _splashAnim;
  Timer? _splashTicker;
  EntryProvider? _listenedEntry;
  int _lastEngineStage = 0;
  DateTime _stageChangedAt = DateTime.now();
  bool _splashShowing = true;

  @override
  void initState() {
    super.initState();
    _splashAnim = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1800),
    )..repeat();
    _splashTicker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _splashShowing) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final entry = context.read<EntryProvider>();
    if (!identical(entry, _listenedEntry)) {
      _listenedEntry?.removeListener(_onEntryChanged);
      _listenedEntry = entry;
      _lastEngineStage = entry.engineStage;
      _stageChangedAt = DateTime.now();
      entry.addListener(_onEntryChanged);
    }
  }

  void _onEntryChanged() {
    final entry = _listenedEntry;
    if (entry == null) return;
    if (entry.engineStage != _lastEngineStage) {
      _lastEngineStage = entry.engineStage;
      _stageChangedAt = DateTime.now();
    }
    // v1.0.9 (P1): a NEW error shakes the card once — the
    // nonce moves only when the error text itself changes to
    // a fresh non-empty value, and only once the portal is
    // the screen on show (an error that lands during the
    // splash is simply already there when the portal opens).
    final err = entry.error;
    if (err.isNotEmpty && err != _lastSeenError && entry.loaded) {
      _errorShakeNonce++;
      if (mounted) setState(() {});
    }
    _lastSeenError = err;
  }

  @override
  void dispose() {
    _listenedEntry?.removeListener(_onEntryChanged);
    _splashTicker?.cancel();
    _splashAnim.dispose();
    _nameController.dispose();
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
    IconData? prefixIcon,
    Widget? suffix,
  }) {
    // v1.0.9 (P1 + P2): the field is its own widget now — it
    // owns a focus node and a hover flag so its border can
    // warm toward gold, and it carries the prefix icon and
    // the suffix action (paste / eye) INSIDE the same box, so
    // the field's height — and the card's budget — never move.
    return _PortalField(
      controller: controller,
      hint: hint,
      enabled: enabled,
      maxLines: maxLines,
      obscureText: obscureText,
      onChanged: onChanged,
      prefixIcon: prefixIcon,
      suffix: suffix,
    );
  }

  /// v1.0.9 (P2): a compact icon action that lives at a
  /// field's right edge (paste, show/hide) — small enough to
  /// never change the field's height.
  Widget _fieldSuffixIcon(IconData icon, VoidCallback? onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.all(4),
        child: Icon(
          icon,
          size: 15,
          color: onTap == null ? _entryFaint : _entryDim,
        ),
      ),
    );
  }

  /// v1.0.9 (P2): the key field's PASTE button — reads the
  /// clipboard's text into the field (the short-key tidy-up
  /// runs on it, exactly as if it were typed). An empty or
  /// non-text clipboard — or a clipboard the platform refuses
  /// — is a graceful no-op; the field still takes a normal
  /// paste.
  Future<void> _pasteIntoKeyField() async {
    try {
      final data = await Clipboard.getData(Clipboard.kTextPlain);
      final text = data?.text;
      if (text == null || text.isEmpty) return;
      _keyController.text = text;
      _onKeyChanged(text);
    } catch (_) {
      // Clipboard unavailable — nothing to fill.
    }
  }

  Widget _btn({
    required String label,
    required bool enabled,
    required VoidCallback onTap,
    bool gold = false,
    bool white = false,
    double height = 38,
    bool googleMark = false,
  }) {
    // Midnight Gold: gold buttons carry the sample's vertical
    // gold gradient; the Google button is white; the rest are
    // quiet dark buttons with the hairline border. v1.0.9
    // (P1): the button is its own widget now, so it can answer
    // the mouse — hover lift + glow, a shine sweep on the
    // gold, a press settle — without any call site changing.
    return _PortalButton(
      label: label,
      enabled: enabled,
      onTap: onTap,
      gold: gold,
      white: white,
      height: height,
      googleMark: googleMark,
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

  /// v1.0.8: a tappable WhatsApp line — the green glyph plus a
  /// label. Opens the support chat in the user's browser. The
  /// phone number itself is never rendered (see the URL const).
  /// v1.0.9 (P1): the line is its own widget now, so hovering
  /// it can bounce the glyph once and deepen the row's tint.
  Widget _whatsAppLink(String label, {double glyphSize = 15}) {
    return _WhatsAppLink(label: label, glyphSize: glyphSize);
  }

  /// v1.0.8 (F3): the portal's header row — the brand block of
  /// the single-column card: logo, app name, tagline, the
  /// free-trial chip, and the note under it.
  Widget _portalHeader() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Image.asset(
              'assets/icon.png',
              width: 34,
              height: 34,
              errorBuilder: (_, _, _) => const Icon(
                Icons.auto_awesome,
                size: 34,
                color: _entryGold,
              ),
            ),
            const SizedBox(width: 10),
            const Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'FlowStudio',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: _entryText,
                    ),
                  ),
                  Text(
                    'Multi-Account AI Video Engine',
                    style: TextStyle(fontSize: 10, color: _entryDim),
                  ),
                ],
              ),
            ),
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
          ],
        ),
        const SizedBox(height: 8),
        const Text(
          'No license key? Sign in with Google or email — your '
          'free trial key arrives by email.',
          style: TextStyle(fontSize: 10.5, color: _entryFaint),
        ),
      ],
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
        // v1.0.9 (P2): a small shield-check rides before the
        // note — the wording is exactly as it was.
        const Row(
          children: [
            Icon(Icons.verified_user, size: 13, color: _entryGold),
            SizedBox(width: 5),
            Expanded(
              child: Text(
                'Internet is required to activate your license key.',
                style: TextStyle(fontSize: 11, color: _entryDim),
              ),
            ),
          ],
        ),
        const SizedBox(height: 5),
        _field(
          controller: _keyController,
          hint: 'Paste your license key — FS-XXXX-XXXX-XXXX',
          enabled: entry.loaded && !entry.busy,
          maxLines: 2,
          onChanged: _onKeyChanged,
          prefixIcon: Icons.vpn_key,
          suffix: _fieldSuffixIcon(
            Icons.content_paste,
            entry.busy || !entry.loaded ? null : _pasteIntoKeyField,
          ),
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
  /// v1.0.7: the boxes are sized for the card's column.
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
  /// v1.0.8 (F4): Create-account mode opens with the NAME field
  /// — the first field of the form, required.
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
          googleMark: true,
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
        // v1.0.9 (P1): the mode switch is the sample's
        // segmented toggle — its gold pill SLIDES between
        // Sign in and Create account on a spring-lite curve
        // (it takes the old switch link's place; the bottom
        // row now carries only Forgot password?).
        _ModeToggle(
          signUp: _signUpMode,
          onChanged: doorAEnabled
              ? (v) => setState(() => _signUpMode = v)
              : null,
        ),
        const SizedBox(height: 6),
        if (_signUpMode) ...[
          _field(
            controller: _nameController,
            hint: 'Your name',
            enabled: doorAEnabled,
            prefixIcon: Icons.person_outline,
          ),
          const SizedBox(height: 6),
        ],
        _field(
          controller: _emailController,
          hint: 'Email address',
          enabled: doorAEnabled,
          prefixIcon: Icons.mail_outline,
        ),
        const SizedBox(height: 6),
        _field(
          controller: _passwordController,
          hint: 'Password',
          enabled: doorAEnabled,
          obscureText: !_passwordVisible,
          prefixIcon: Icons.lock_outline,
          suffix: _fieldSuffixIcon(
            _passwordVisible ? Icons.visibility_off : Icons.visibility,
            doorAEnabled
                ? () =>
                    setState(() => _passwordVisible = !_passwordVisible)
                : null,
          ),
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
              provider.signUp(_nameController.text,
                  _emailController.text, _passwordController.text);
            } else {
              provider.signIn(
                  _emailController.text, _passwordController.text);
            }
          },
        ),
        // v1.0.9 (P1): the mode switch lives in the toggle
        // above now — this row carries only Forgot password?,
        // in Sign in mode, as before.
        if (!_signUpMode) ...[
          const SizedBox(height: 2),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
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
      ],
    );
  }

  /// v1.0.8 (F3): the LOCKED STUDIO SHELL behind the blur — a
  /// static sketch of the studio (top strip, accounts column,
  /// prompts area, progress column, activity strip) drawn with
  /// plain shapes. It carries NO live data and NO working
  /// control: the real studio is not built while the gate is up
  /// (EntryGateHome), and this whole underlay sits inside an
  /// IgnorePointer under a BackdropFilter — visible, never
  /// usable.
  Widget _lockedStudioShell() {
    Widget bar(double w, double h, [Color c = const Color(0xFF23232E)]) {
      return Container(
        width: w,
        height: h,
        decoration: BoxDecoration(
          color: c,
          borderRadius: BorderRadius.circular(h / 2),
        ),
      );
    }

    Widget panel(List<Widget> children) {
      return Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: const Color(0xFF12121A),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: const Color(0xFF1E1E28)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: children,
        ),
      );
    }

    return Container(
      color: const Color(0xFF0E0E13),
      padding: const EdgeInsets.all(14),
      child: Column(
        children: [
          // Top strip: logo dot, name bar, credits pill, buttons.
          Row(
            children: [
              Container(
                width: 24,
                height: 24,
                decoration: const BoxDecoration(
                  color: Color(0xFF8A6420),
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 10),
              bar(110, 10, const Color(0xFF2C2C38)),
              const Spacer(),
              bar(130, 16, const Color(0xFF3A2E14)),
              const SizedBox(width: 10),
              bar(72, 16),
              const SizedBox(width: 10),
              bar(72, 16),
            ],
          ),
          const SizedBox(height: 14),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Accounts column.
                SizedBox(
                  width: 200,
                  child: panel([
                    bar(70, 8, const Color(0xFF8A6420)),
                    const SizedBox(height: 12),
                    for (var i = 0; i < 5; i++) ...[
                      Row(children: [
                        Container(
                          width: 18,
                          height: 18,
                          decoration: const BoxDecoration(
                            color: Color(0xFF23232E),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 8),
                        bar(96, 8),
                      ]),
                      const SizedBox(height: 12),
                    ],
                  ]),
                ),
                const SizedBox(width: 14),
                // Prompts + settings.
                Expanded(
                  child: Column(
                    children: [
                      Expanded(
                        child: panel([
                          bar(90, 8, const Color(0xFF8A6420)),
                          const SizedBox(height: 12),
                          bar(300, 8),
                          const SizedBox(height: 9),
                          bar(260, 8),
                          const SizedBox(height: 9),
                          bar(280, 8),
                        ]),
                      ),
                      const SizedBox(height: 14),
                      SizedBox(
                        height: 64,
                        child: panel([
                          Row(children: [
                            bar(80, 14),
                            const SizedBox(width: 10),
                            bar(80, 14),
                            const SizedBox(width: 10),
                            bar(80, 14),
                            const Spacer(),
                            bar(110, 18, const Color(0xFF3A2E14)),
                          ]),
                        ]),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 14),
                // Progress column.
                SizedBox(
                  width: 220,
                  child: panel([
                    bar(80, 8, const Color(0xFF8A6420)),
                    const SizedBox(height: 12),
                    bar(150, 8),
                    const SizedBox(height: 9),
                    bar(120, 8),
                    const SizedBox(height: 14),
                    bar(170, 6, const Color(0xFF3A2E14)),
                  ]),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          // Activity strip.
          Row(children: [
            bar(60, 8),
            const SizedBox(width: 10),
            bar(220, 8),
          ]),
        ],
      ),
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
  /// per stage.
  /// v1.0.8 (F1): the splash is ALIVE — the logo gently pulses
  /// inside a breathing gold glow with two twinkling stars, and
  /// the gold bar carries a moving sheen. The fill stays
  /// truthful (stage/3, as before). The status line shows the
  /// REAL stage text; only while one stage persists beyond
  /// ~2.5 s does it rotate honest filler lines ("Preparing your
  /// accounts…", "Warming up the engine…", "Almost there…"),
  /// and a stage change brings the real text straight back.
  Widget _buildStartupScreen(BuildContext context, EntryProvider entry) {
    final double progress =
        entry.engineFailed ? 0 : entry.engineStage / 3;
    String status = entry.loaded
        ? 'Workspace ready!'
        : entry.engineStage >= 2
            ? 'Checking your entry…'
            : entry.engineStage >= 1
                ? 'Engine is up — waiting for it to answer…'
                : 'Starting the engine…';
    if (!entry.engineFailed && !entry.loaded) {
      final idleMs =
          DateTime.now().difference(_stageChangedAt).inMilliseconds;
      if (idleMs > 2500) {
        const fillers = [
          'Preparing your accounts…',
          'Warming up the engine…',
          'Almost there…',
        ];
        status = fillers[((idleMs - 2500) ~/ 2800) % fillers.length];
      }
    }
    return Scaffold(
      backgroundColor: _entryBg,
      body: Stack(
        children: [
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                AnimatedBuilder(
                  animation: _splashAnim,
                  builder: (context, _) {
                    final t = _splashAnim.value;
                    final pulse =
                        (math.sin(t * 2 * math.pi) + 1) / 2;
                    return Stack(
                      alignment: Alignment.center,
                      children: [
                        Container(
                          width: 128,
                          height: 128,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            boxShadow: [
                              BoxShadow(
                                color: _entryGold
                                    .withOpacity(0.16 + 0.22 * pulse),
                                blurRadius: 34 + 30 * pulse,
                                spreadRadius: 2 + 6 * pulse,
                              ),
                            ],
                          ),
                        ),
                        Transform.scale(
                          scale: 1 + 0.045 * pulse,
                          child: Image.asset(
                            'assets/icon.png',
                            width: 96,
                            height: 96,
                            errorBuilder: (_, _, _) => const Icon(
                              Icons.auto_awesome,
                              size: 96,
                              color: _entryGold,
                            ),
                          ),
                        ),
                        Positioned(
                          top: 2,
                          right: 6,
                          child: Opacity(
                            opacity: 0.3 + 0.7 * pulse,
                            child: const Icon(
                              Icons.auto_awesome,
                              size: 16,
                              color: _entryGold,
                            ),
                          ),
                        ),
                        Positioned(
                          bottom: 8,
                          left: 2,
                          child: Opacity(
                            opacity: 0.3 + 0.7 * (1 - pulse),
                            child: const Icon(
                              Icons.auto_awesome,
                              size: 11,
                              color: _entryGold,
                            ),
                          ),
                        ),
                      ],
                    );
                  },
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
                // The determinate bar: the gold fill is the real
                // stage fraction; the sheen band sweeps it while
                // the splash is up (motion only — never progress).
                SizedBox(
                  width: 340,
                  height: 4,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(2),
                    child: Stack(
                      children: [
                        Container(color: _entryBorder),
                        FractionallySizedBox(
                          widthFactor: progress.clamp(0, 1).toDouble(),
                          child: Container(
                            decoration: const BoxDecoration(
                              gradient: LinearGradient(
                                colors: [
                                  Color(0xFFF2B544),
                                  Color(0xFFDD941F),
                                ],
                              ),
                            ),
                          ),
                        ),
                        AnimatedBuilder(
                          animation: _splashAnim,
                          builder: (context, _) {
                            return Positioned(
                              left: -70 + 410 * _splashAnim.value,
                              top: 0,
                              bottom: 0,
                              width: 60,
                              child: Container(
                                decoration: BoxDecoration(
                                  gradient: LinearGradient(
                                    colors: [
                                      Colors.white.withOpacity(0),
                                      Colors.white.withOpacity(0.35),
                                      Colors.white.withOpacity(0),
                                    ],
                                  ),
                                ),
                              ),
                            );
                          },
                        ),
                      ],
                    ),
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
              'v1.0.13',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 10.5, color: _entryFaint),
            ),
          ),
        ],
      ),
    );
  }

  /// v1.0.8 (F3): the PORTAL — the blurred locked studio with
  /// the single-column card floating at its centre (a small
  /// scale + fade entrance, then still). Every state below the
  /// header is one of the v1.0.7 states, unchanged in wording.
  Widget _buildPortal(BuildContext context, EntryProvider entry) {
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
      width: _portalCardWidth,
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
      decoration: BoxDecoration(
        color: _entryCard,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _entryBorder),
        boxShadow: const [
          BoxShadow(
            color: Color(0x99000000),
            blurRadius: 44,
            offset: Offset(0, 18),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _portalHeader(),
          const SizedBox(height: 10),
          if (showStrip) ...[
            _signedInStrip(entry),
            const SizedBox(height: 10),
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
            // Below the divider the card is in exactly one of
            // three states — the check-email block, the
            // verification state, or the get-my-key sign-in form.
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
            const SizedBox(height: 6),
            // The error's own help line (the owner's order):
            // right under the failure, one tap to support.
            _whatsAppLink('Still stuck? Get help on WhatsApp',
                glyphSize: 13),
          ],
          const SizedBox(height: 10),
          const Divider(height: 1, color: _entryBorder),
          const SizedBox(height: 8),
          Center(
            child: _whatsAppLink('Need help? Chat with us on WhatsApp'),
          ),
        ],
      ),
    );
    // The entrance: the card scales 0.96 → 1 and fades in over
    // ~350 ms when the portal first appears, then stays still.
    final enteringCard = TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: 1),
      duration: const Duration(milliseconds: 350),
      curve: Curves.easeOutCubic,
      builder: (context, value, child) {
        return Opacity(
          opacity: value,
          child: Transform.scale(
            scale: 0.96 + 0.04 * value,
            child: child,
          ),
        );
      },
      child: card,
    );
    // v1.0.9 (P1): the ERROR SHAKE — the builder's tween end
    // is the error nonce itself, so a NEW error (the nonce
    // moves, see _onEntryChanged) animates the fractional
    // sweep 0 → 1 exactly once: a gentle ±6px horizontal
    // wobble, decaying over ~400 ms. The widget never changes
    // key, so the card's fields keep their state and focus
    // through the shake. Reduced motion stills it outright.
    final reducedMotion = MediaQuery.of(context).disableAnimations;
    final shakenCard = TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: _errorShakeNonce.toDouble()),
      duration:
          reducedMotion ? Duration.zero : const Duration(milliseconds: 400),
      curve: Curves.linear,
      builder: (context, value, child) {
        final phase = value - value.floorToDouble();
        final dx = _errorShakeNonce == 0
            ? 0.0
            : math.sin(phase * math.pi * 3) * 6 * (1 - phase);
        return Transform.translate(offset: Offset(dx, 0), child: child);
      },
      child: enteringCard,
    );
    return Scaffold(
      backgroundColor: _entryBg,
      body: Stack(
        children: [
          // The locked studio behind: blurred, darkened, and
          // pointer-dead — the portal is the only way in.
          Positioned.fill(
            child: IgnorePointer(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  _lockedStudioShell(),
                  BackdropFilter(
                    filter: ui.ImageFilter.blur(sigmaX: 14, sigmaY: 14),
                    child: Container(
                      color: Colors.black.withOpacity(0.55),
                    ),
                  ),
                ],
              ),
            ),
          ),
          LayoutBuilder(
            builder: (context, constraints) {
              // At the design size the card is static — nothing
              // scrolls. The scroll view is a fallback for
              // viewport heights below the design viewport only.
              if (constraints.maxHeight < _gateScrollFallbackHeight) {
                return SingleChildScrollView(
                  child: ConstrainedBox(
                    constraints:
                        BoxConstraints(minHeight: constraints.maxHeight),
                    child: Center(child: shakenCard),
                  ),
                );
              }
              return Center(child: shakenCard);
            },
          ),
        ],
      ),
    );
  }

  /// v1.0.13: the maintenance view — shown instead of the
  /// portal while the panel's maintenance switch is on for the
  /// app. The words are the operator's own message from the
  /// backend (the provider carries the backend default when the
  /// panel has none). Entry stays blocked until the switch goes
  /// off; the status poll keeps running, so the portal returns
  /// on its own.
  Widget _buildMaintenance(BuildContext context, EntryProvider entry) {
    return Scaffold(
      backgroundColor: _entryBg,
      body: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Image.asset(
                'assets/icon.png',
                width: 72,
                height: 72,
                errorBuilder: (_, _, _) => const Icon(
                  Icons.auto_awesome,
                  size: 72,
                  color: _entryGold,
                ),
              ),
              const SizedBox(height: 20),
              const Text(
                'We\'ll be right back',
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                  color: _entryText,
                ),
              ),
              const SizedBox(height: 10),
              Text(
                entry.maintenanceMessage.isNotEmpty
                    ? entry.maintenanceMessage
                    : 'We are briefly down for maintenance. Please try again shortly.',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 12.5, color: _entryDim),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final entry = context.watch<EntryProvider>();
    // v1.0.2: before the first entry answer the STARTUP SCREEN
    // shows (splash), not the gate card. v1.0.8 (F1): the two
    // crossfade — splash out, portal in.
    final showSplash = !entry.loaded;
    _splashShowing = showSplash;
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 300),
      child: showSplash
          ? KeyedSubtree(
              key: const ValueKey('entry-splash'),
              child: _buildStartupScreen(context, entry),
            )
          : entry.maintenance
              ? KeyedSubtree(
                  key: const ValueKey('entry-maintenance'),
                  child: _buildMaintenance(context, entry),
                )
              : KeyedSubtree(
                  key: const ValueKey('entry-portal'),
                  child: _buildPortal(context, entry),
                ),
    );
  }
}

/// v1.0.9 (P1 + P2): a portal TEXT FIELD that answers the
/// mouse — its border warms toward gold on hover and turns
/// gold on focus (animated), with a faint gold glow while
/// focused. The prefix icon and the suffix action (paste /
/// show-hide eye) live INSIDE the box, so the field's height
/// never changes and the card's fit budget never moves.
class _PortalField extends StatefulWidget {
  const _PortalField({
    required this.controller,
    required this.hint,
    this.enabled = true,
    this.maxLines = 1,
    this.obscureText = false,
    this.onChanged,
    this.prefixIcon,
    this.suffix,
  });

  final TextEditingController controller;
  final String hint;
  final bool enabled;
  final int maxLines;
  final bool obscureText;
  final ValueChanged<String>? onChanged;
  final IconData? prefixIcon;
  final Widget? suffix;

  @override
  State<_PortalField> createState() => _PortalFieldState();
}

class _PortalFieldState extends State<_PortalField> {
  final FocusNode _focusNode = FocusNode();
  bool _hovering = false;

  @override
  void initState() {
    super.initState();
    _focusNode.addListener(_onFocusChange);
  }

  void _onFocusChange() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _focusNode.removeListener(_onFocusChange);
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reducedMotion = MediaQuery.of(context).disableAnimations;
    final focused = _focusNode.hasFocus;
    final borderColor = !widget.enabled
        ? _entryBorder
        : focused
            ? _entryGold
            : _hovering
                ? const Color(0xFF5C4E2A)
                : _entryBorder;
    return MouseRegion(
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      child: AnimatedContainer(
        duration: reducedMotion
            ? Duration.zero
            : const Duration(milliseconds: 200),
        curve: Curves.easeOut,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: _entryPanel,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: borderColor),
          boxShadow: focused && widget.enabled
              ? const [
                  BoxShadow(
                    color: Color(0x1FF5B83D),
                    blurRadius: 10,
                  ),
                ]
              : const [],
        ),
        child: Row(
          children: [
            if (widget.prefixIcon != null) ...[
              Icon(
                widget.prefixIcon,
                size: 16,
                color: !widget.enabled
                    ? _entryFaint
                    : focused
                        ? _entryGold
                        : _entryDim,
              ),
              const SizedBox(width: 8),
            ],
            Expanded(
              child: TextField(
                controller: widget.controller,
                focusNode: _focusNode,
                enabled: widget.enabled,
                maxLines: widget.maxLines,
                obscureText: widget.obscureText,
                onChanged: widget.onChanged,
                style: const TextStyle(fontSize: 12.5, color: _entryText),
                decoration: InputDecoration(
                  hintText: widget.hint,
                  hintStyle:
                      const TextStyle(fontSize: 12, color: _entryFaint),
                  border: InputBorder.none,
                  isDense: true,
                  contentPadding:
                      const EdgeInsets.symmetric(vertical: 9),
                ),
              ),
            ),
            if (widget.suffix != null) widget.suffix!,
          ],
        ),
      ),
    );
  }
}

/// v1.0.9 (P1): a portal BUTTON that answers the mouse —
/// hover lifts it and blooms its shadow (the gold Activate
/// also sweeps a shine across itself once per hover-enter),
/// a press settles it to 0.98, dark buttons warm their border
/// toward gold, and the Google button's G settles with a
/// small rotation. Touch is untouched: every flourish rides
/// the pointer or the highlight, never the tap itself.
class _PortalButton extends StatefulWidget {
  const _PortalButton({
    required this.label,
    required this.enabled,
    required this.onTap,
    this.gold = false,
    this.white = false,
    this.height = 38,
    this.googleMark = false,
  });

  final String label;
  final bool enabled;
  final VoidCallback onTap;
  final bool gold;
  final bool white;
  final double height;
  final bool googleMark;

  @override
  State<_PortalButton> createState() => _PortalButtonState();
}

class _PortalButtonState extends State<_PortalButton> {
  bool _hovering = false;
  bool _pressed = false;
  int _shineNonce = 0;

  @override
  Widget build(BuildContext context) {
    final reducedMotion = MediaQuery.of(context).disableAnimations;
    final active = widget.enabled;
    final dur = reducedMotion
        ? Duration.zero
        : const Duration(milliseconds: 200);
    final lift = active && _hovering
        ? (widget.gold || widget.white ? -2.0 : -1.0)
        : 0.0;
    final List<BoxShadow> shadows;
    if (active && _hovering && widget.gold) {
      shadows = const [
        BoxShadow(
          color: Color(0x61F5B83D),
          blurRadius: 18,
          offset: Offset(0, 6),
        ),
      ];
    } else if (active && _hovering && widget.white) {
      shadows = const [
        BoxShadow(
          color: Color(0x59000000),
          blurRadius: 14,
          offset: Offset(0, 5),
        ),
      ];
    } else if (active && _hovering) {
      shadows = const [
        BoxShadow(
          color: Color(0x29F5B83D),
          blurRadius: 12,
          offset: Offset(0, 4),
        ),
      ];
    } else {
      shadows = const [];
    }
    final BoxDecoration decoration = widget.gold
        ? BoxDecoration(
            gradient: const LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [Color(0xFFF2B544), Color(0xFFDD941F)],
            ),
            borderRadius: BorderRadius.circular(12),
            boxShadow: shadows,
          )
        : widget.white
            ? BoxDecoration(
                color: _entryWhite,
                borderRadius: BorderRadius.circular(12),
                boxShadow: shadows,
              )
            : BoxDecoration(
                color: _entryBtn,
                border: Border.all(
                  color: active && _hovering
                      ? _entryGold.withOpacity(0.75)
                      : _entryBorder,
                ),
                borderRadius: BorderRadius.circular(12),
                boxShadow: shadows,
              );
    return Opacity(
      opacity: active ? 1 : 0.45,
      child: MouseRegion(
        onEnter: active
            ? (_) => setState(() {
                  _hovering = true;
                  _shineNonce++;
                })
            : null,
        onExit: active ? (_) => setState(() => _hovering = false) : null,
        child: AnimatedScale(
          scale: active && _pressed ? 0.98 : 1,
          duration: dur,
          curve: Curves.easeOut,
          child: AnimatedContainer(
            duration: dur,
            curve: Curves.easeOut,
            transform: Matrix4.translationValues(0, lift, 0),
            decoration: decoration,
            child: Material(
              color: Colors.transparent,
              borderRadius: BorderRadius.circular(12),
              child: InkWell(
                onTap: active ? widget.onTap : null,
                onHighlightChanged:
                    active ? (v) => setState(() => _pressed = v) : null,
                borderRadius: BorderRadius.circular(12),
                child: Container(
                  height: widget.height,
                  alignment: Alignment.center,
                  child: Stack(
                    alignment: Alignment.center,
                    children: [
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (widget.googleMark) ...[
                            AnimatedRotation(
                              turns: active && _hovering ? -0.04 : 0,
                              duration: reducedMotion
                                  ? Duration.zero
                                  : const Duration(milliseconds: 300),
                              curve: const Cubic(0.34, 1.3, 0.64, 1),
                              child: const CustomPaint(
                                size: Size(16, 16),
                                painter: _GoogleGPainter(),
                              ),
                            ),
                            const SizedBox(width: 8),
                          ],
                          Text(
                            widget.label,
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.bold,
                              color: widget.gold
                                  ? _entryGoldText
                                  : (widget.white
                                      ? _entryWhiteText
                                      : _entryText),
                            ),
                          ),
                        ],
                      ),
                      if (widget.gold && active && !reducedMotion)
                        Positioned.fill(
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(12),
                            child: TweenAnimationBuilder<double>(
                              key: ValueKey(_shineNonce),
                              tween: Tween<double>(begin: 0, end: 1),
                              duration:
                                  const Duration(milliseconds: 550),
                              curve: Curves.easeOut,
                              builder: (context, t, _) {
                                return LayoutBuilder(
                                  builder: (context, constraints) {
                                    final w = constraints.maxWidth;
                                    return Transform.translate(
                                      offset:
                                          Offset(-70 + (w + 140) * t, 0),
                                      child: Align(
                                        alignment: Alignment.centerLeft,
                                        child: Container(
                                          width: 60,
                                          decoration: BoxDecoration(
                                            gradient: LinearGradient(
                                              colors: [
                                                Colors.white
                                                    .withOpacity(0),
                                                Colors.white
                                                    .withOpacity(0.35),
                                                Colors.white
                                                    .withOpacity(0),
                                              ],
                                            ),
                                          ),
                                        ),
                                      ),
                                    );
                                  },
                                );
                              },
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// v1.0.9 (P1): the Sign in / Create account SEGMENTED
/// TOGGLE — a pill track whose gold thumb SLIDES to the
/// active side on a spring-lite curve (an easeOutBack with
/// the overshoot kept small), instead of the old switch
/// link's instant swap.
class _ModeToggle extends StatelessWidget {
  const _ModeToggle({required this.signUp, required this.onChanged});

  final bool signUp;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final reducedMotion = MediaQuery.of(context).disableAnimations;
    return Opacity(
      opacity: onChanged == null ? 0.45 : 1,
      child: Container(
        height: 30,
        decoration: BoxDecoration(
          color: _entryPanel,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: _entryBorder),
        ),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final thumbW = (constraints.maxWidth - 4) / 2;
            return Stack(
              children: [
                AnimatedPositioned(
                  duration: reducedMotion
                      ? Duration.zero
                      : const Duration(milliseconds: 280),
                  curve: const Cubic(0.34, 1.25, 0.64, 1),
                  left: 2 + (signUp ? thumbW : 0),
                  top: 2,
                  width: thumbW,
                  height: 24,
                  child: Container(
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [Color(0xFFF2B544), Color(0xFFDD941F)],
                      ),
                      borderRadius: BorderRadius.circular(999),
                    ),
                  ),
                ),
                Row(
                  children: [
                    Expanded(
                      child: _tab('Sign in', !signUp, false),
                    ),
                    Expanded(
                      child: _tab('Create account', signUp, true),
                    ),
                  ],
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _tab(String label, bool active, bool value) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onChanged == null ? null : () => onChanged!(value),
      child: Center(
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.bold,
            color: active ? _entryGoldText : _entryDim,
          ),
        ),
      ),
    );
  }
}

/// v1.0.9 (P1): the WhatsApp support line — hovering it
/// bounces the glyph ONCE (a sine pulse) and deepens the
/// row's green tint; the tap still opens the support chat,
/// and the number still lives only inside the URL.
class _WhatsAppLink extends StatefulWidget {
  const _WhatsAppLink({required this.label, this.glyphSize = 15});

  final String label;
  final double glyphSize;

  @override
  State<_WhatsAppLink> createState() => _WhatsAppLinkState();
}

class _WhatsAppLinkState extends State<_WhatsAppLink> {
  bool _hovering = false;
  int _pulseNonce = 0;

  @override
  Widget build(BuildContext context) {
    final reducedMotion = MediaQuery.of(context).disableAnimations;
    return MouseRegion(
      onEnter: (_) => setState(() {
        _hovering = true;
        _pulseNonce++;
      }),
      onExit: (_) => setState(() => _hovering = false),
      child: AnimatedContainer(
        duration: reducedMotion
            ? Duration.zero
            : const Duration(milliseconds: 200),
        curve: Curves.easeOut,
        decoration: BoxDecoration(
          color: _hovering
              ? _whatsAppGreen.withOpacity(0.13)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
        ),
        child: InkWell(
          onTap: () =>
              AutomationBridge.instance.openUrl(_whatsAppSupportUrl),
          borderRadius: BorderRadius.circular(6),
          child: Padding(
            padding:
                const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                TweenAnimationBuilder<double>(
                  key: ValueKey(_pulseNonce),
                  tween: Tween<double>(begin: 0, end: 1),
                  duration: reducedMotion
                      ? Duration.zero
                      : const Duration(milliseconds: 450),
                  builder: (context, t, child) {
                    final scale = _pulseNonce == 0
                        ? 1.0
                        : 1 + 0.25 * math.sin(t * math.pi);
                    return Transform.scale(scale: scale, child: child);
                  },
                  child: CustomPaint(
                    size: Size(widget.glyphSize, widget.glyphSize),
                    painter: const _WhatsAppGlyphPainter(),
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  widget.label,
                  style: const TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.bold,
                    color: _entryText,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// v1.0.9 (P1/P2): the Google "G", drawn (like the WhatsApp
/// glyph, no icon font carries it): four colour arcs — blue
/// at the right, green at the bottom, yellow at the lower
/// left, red across the top — plus the blue crossbar.
class _GoogleGPainter extends CustomPainter {
  const _GoogleGPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width;
    final stroke = s * 0.30;
    final rect = Rect.fromCircle(
      center: Offset(s / 2, s / 2),
      radius: (s - stroke) / 2,
    );
    void arc(Color color, double startDeg, double sweepDeg) {
      final paint = Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..strokeCap = StrokeCap.butt;
      canvas.drawArc(
        rect,
        startDeg * math.pi / 180,
        sweepDeg * math.pi / 180,
        false,
        paint,
      );
    }

    arc(const Color(0xFF4285F4), -52, 104);
    arc(const Color(0xFF34A853), 52, 88);
    arc(const Color(0xFFFBBC05), 140, 76);
    arc(const Color(0xFFEA4335), 216, 92);
    final bar = Paint()..color = const Color(0xFF4285F4);
    canvas.drawRect(
      Rect.fromLTRB(
        s * 0.46,
        s / 2 - stroke * 0.48,
        s,
        s / 2 + stroke * 0.48,
      ),
      bar,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// v1.0.8: the WhatsApp glyph, drawn (no icon font carries it):
/// the green speech bubble with its tail and the white handset
/// inside — WhatsApp green #25D366.
class _WhatsAppGlyphPainter extends CustomPainter {
  const _WhatsAppGlyphPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width;
    final green = Paint()..color = _whatsAppGreen;
    // Speech bubble: a circle with a small tail at bottom-left.
    canvas.drawCircle(
      Offset(s * 0.52, s * 0.46),
      s * 0.42,
      green,
    );
    final tail = Path()
      ..moveTo(s * 0.16, s * 0.78)
      ..lineTo(s * 0.10, s * 0.98)
      ..lineTo(s * 0.34, s * 0.86)
      ..close();
    canvas.drawPath(tail, green);
    // The white handset (simplified silhouette).
    final phone = Paint()..color = Colors.white;
    final handset = Path()
      ..moveTo(s * 0.36, s * 0.28)
      ..cubicTo(s * 0.30, s * 0.34, s * 0.30, s * 0.44, s * 0.36, s * 0.54)
      ..cubicTo(s * 0.44, s * 0.66, s * 0.56, s * 0.74, s * 0.66, s * 0.76)
      ..cubicTo(s * 0.74, s * 0.77, s * 0.78, s * 0.72, s * 0.76, s * 0.66)
      ..lineTo(s * 0.66, s * 0.58)
      ..cubicTo(s * 0.60, s * 0.57, s * 0.55, s * 0.52, s * 0.53, s * 0.46)
      ..lineTo(s * 0.60, s * 0.39)
      ..cubicTo(s * 0.61, s * 0.32, s * 0.56, s * 0.27, s * 0.47, s * 0.25)
      ..cubicTo(s * 0.42, s * 0.24, s * 0.38, s * 0.25, s * 0.36, s * 0.28)
      ..close();
    canvas.drawPath(handset, phone);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
