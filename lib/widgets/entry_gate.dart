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
///   live (Firebase) and sign-in is real — a first sign-in starts
///   a 7-day trial. If the backend were ever unconfigured, the
///   door would show the honest not-available message and stay
///   disabled — no mock sign-in. (Firebase's free tier has no
///   email sign-in codes, so the email door is a password door —
///   the copy says exactly that, nothing about codes.)
///
///   DOOR B — LICENSE KEY: a signed key, checked by the engine,
///   bound to this one device on activation. The notice above the
///   field — "Internet is required to activate your license key."
///   — is shown BEFORE the first activation attempt, so nobody is
///   surprised by it (the owner's explicit order).
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
/// STARTUP: while the engine starts and the first entry answer is
/// on its way, a splash screen shows instead of the gate card
/// (see _buildStartupScreen).
///
/// FIT LAW: the whole gate fits 1024×768 — one centered card, no
/// scrolling at that size.

// The entry's own dark palette (v1.0.4) — splash + gate card.
const Color _entryBg = Color(0xFF07070C);
const Color _entryCard = Color(0xFF101016);
const Color _entryPanel = Color(0xFF17171F);
const Color _entryBorder = Color(0xFF262633);
const Color _entryText = Color(0xFFF2F2F5);
const Color _entryDim = Color(0xFF9A9AAD);
const Color _entryFaint = Color(0xFF6D6D80);
const Color _entryGold = Color(0xFFF0A832);
const Color _entryGoldText = Color(0xFF1C1503);
const Color _entryBtn = Color(0xFF1B1B24);
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

  // Door A mode: false = Sign in, true = Create account.
  bool _signUpMode = false;

  // Machine ID copy feedback (the chip reads "Copied" briefly).
  bool _idCopied = false;
  Timer? _copiedTimer;

  @override
  void dispose() {
    _copiedTimer?.cancel();
    _emailController.dispose();
    _passwordController.dispose();
    _keyController.dispose();
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

  Widget _field({
    required TextEditingController controller,
    required String hint,
    bool enabled = true,
    int maxLines = 1,
    bool obscureText = false,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: _entryPanel,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: _entryBorder),
      ),
      child: TextField(
        controller: controller,
        enabled: enabled,
        maxLines: maxLines,
        obscureText: obscureText,
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
    double height = 38,
  }) {
    return Opacity(
      opacity: enabled ? 1 : 0.45,
      child: Material(
        color: gold ? _entryGold : _entryBtn,
        borderRadius: BorderRadius.circular(9),
        child: InkWell(
          onTap: enabled ? onTap : null,
          borderRadius: BorderRadius.circular(9),
          child: Container(
            height: height,
            alignment: Alignment.center,
            decoration: gold
                ? null
                : BoxDecoration(
                    border: Border.all(color: _entryBorder),
                    borderRadius: BorderRadius.circular(9),
                  ),
            child: Text(
              label,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.bold,
                color: gold ? _entryGoldText : _entryText,
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
        borderRadius: BorderRadius.circular(10),
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

  /// v1.0.4 — the STARTUP SCREEN, rebuilt dark and centred like
  /// a market app's splash: big logo, the app name, the tagline,
  /// a progress bar that fills with the real engine state
  /// (starting → checking → ready), a status line that follows
  /// it, and the version at the bottom. The watchdog's
  /// engineFailed state lives here too, with its Retry button
  /// (v1.0.1 behaviour, kept).
  Widget _buildStartupScreen(BuildContext context, EntryProvider entry) {
    final double progress =
        entry.engineFailed ? 0 : (entry.engineStarted ? 0.65 : 0.25);
    final String status = entry.loaded
        ? 'Workspace ready!'
        : entry.engineStarted
            ? 'Checking your entry…'
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
              'v1.0.4',
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
    // v1.0.4: a Google/email sign-in that carries no active plan
    // lands back on this card — say so at the top, with the key
    // door right below it.
    final signedInNoPlan = entry.isAccount && entry.email.isNotEmpty;
    return Scaffold(
      backgroundColor: _entryBg,
      body: Center(
        child: Container(
          width: 470,
          padding: const EdgeInsets.fromLTRB(26, 20, 26, 16),
          decoration: BoxDecoration(
            color: _entryCard,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: _entryBorder),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Image.asset(
                  'assets/icon.png',
                  width: 48,
                  height: 48,
                  errorBuilder: (_, _, _) => const Icon(
                    Icons.auto_awesome,
                    size: 48,
                    color: _entryGold,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'FlowStudio',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 23,
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
              if (signedInNoPlan) ...[
                const SizedBox(height: 12),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: _entryPanel,
                    borderRadius: BorderRadius.circular(9),
                    border: Border.all(color: _entryBorder),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Signed in as ${entry.email} — this account has '
                          'no active plan. Paste a license key below to '
                          'continue.',
                          style: const TextStyle(
                              fontSize: 11, color: _entryDim),
                        ),
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
              const SizedBox(height: 14),
              _machineIdBox(entry),
              const SizedBox(height: 14),
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
                hint: 'Paste your license key',
                enabled: entry.loaded && !entry.busy,
                maxLines: 2,
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
              const SizedBox(height: 13),
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
              const SizedBox(height: 13),
              _btn(
                height: 38,
                enabled: doorAEnabled,
                label: 'Continue with Google',
                onTap: () async {
                  final url =
                      await AutomationBridge.instance.getGoogleAuthUrl();
                  if (url != null && url.isNotEmpty) {
                    await AutomationBridge.instance.openUrl(url);
                    // Phase 2: the sign-in finishes in the browser;
                    // watch the entry status so the gate opens by
                    // itself when the session lands.
                    if (context.mounted) {
                      context.read<EntryProvider>().startAccountWatch();
                    }
                  }
                },
              ),
              const SizedBox(height: 9),
              _field(
                controller: _emailController,
                hint: 'Email address',
                enabled: doorAEnabled,
              ),
              const SizedBox(height: 8),
              _field(
                controller: _passwordController,
                hint: 'Password',
                enabled: doorAEnabled,
                obscureText: true,
              ),
              const SizedBox(height: 9),
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
                'No license key? Google sign-in starts a free 7-day trial.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 10.5, color: _entryFaint),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
