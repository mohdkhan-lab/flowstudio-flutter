import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/entry_provider.dart';
import '../services/automation_bridge.dart';
import '../theme/app_theme.dart';
import 'tactile_components.dart';

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
/// STARTUP: while the engine starts and the first entry answer is
/// on its way, a splash screen shows instead of the gate card
/// (see _buildStartupScreen).
///
/// FIT LAW: the whole gate fits 1024×768 — one centered card, no
/// scrolling at that size.
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

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _keyController.dispose();
    super.dispose();
  }

  Widget _field({
    required TextEditingController controller,
    required String hint,
    bool enabled = true,
    int maxLines = 1,
    bool obscureText = false,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: AppTheme.inputBg,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: AppTheme.borderSoft),
      ),
      child: TextField(
        controller: controller,
        enabled: enabled,
        maxLines: maxLines,
        obscureText: obscureText,
        style: TextStyle(fontSize: 12, color: AppTheme.textMain),
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: TextStyle(fontSize: 11.5, color: AppTheme.textFaint),
          border: InputBorder.none,
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(vertical: 9),
        ),
      ),
    );
  }

  Widget _doorLabel(String text) {
    return Text(
      text,
      style: TextStyle(
        fontSize: 10,
        fontWeight: FontWeight.bold,
        letterSpacing: 0.8,
        color: AppTheme.textFaint,
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
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.bold,
          color: AppTheme.accentGold,
        ),
      ),
    );
  }

  /// v1.0.2 — the STARTUP SCREEN: while the engine starts and
  /// the first entry answer is on its way (entry.loaded false),
  /// the app shows a proper splash — logo mark, name, an animated
  /// progress bar and a status line that follows the real state
  /// (Starting engine… → Checking your entry…) — instead of the
  /// bare line the gate card used to carry. The watchdog's
  /// engineFailed state lives here too, with its Retry button.
  /// The version sits at the bottom.
  Widget _buildStartupScreen(BuildContext context, EntryProvider entry) {
    return Scaffold(
      backgroundColor: AppTheme.bgBody,
      body: Stack(
        children: [
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Image.asset(
                  'assets/icon.png',
                  width: 84,
                  height: 84,
                  errorBuilder: (_, _, _) => Icon(
                    Icons.auto_awesome,
                    size: 84,
                    color: AppTheme.accentGold,
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  'FlowStudio',
                  style: TextStyle(
                    fontSize: 26,
                    fontWeight: FontWeight.bold,
                    color: AppTheme.textMain,
                  ),
                ),
                const SizedBox(height: 26),
                SizedBox(
                  width: 220,
                  child: LinearProgressIndicator(
                    minHeight: 3,
                    color: AppTheme.accentGold,
                    backgroundColor: AppTheme.borderSoft,
                  ),
                ),
                const SizedBox(height: 14),
                if (!entry.engineFailed)
                  Text(
                    entry.engineStarted
                        ? 'Checking your entry…'
                        : 'Starting the engine…',
                    style:
                        TextStyle(fontSize: 11.5, color: AppTheme.textFaint),
                  ),
                if (entry.engineFailed) ...[
                  Container(
                    width: 320,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 10, vertical: 8),
                    decoration: BoxDecoration(
                      color: AppTheme.redBg,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: AppTheme.red),
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            'The engine could not start.',
                            style:
                                TextStyle(fontSize: 11, color: AppTheme.red),
                          ),
                        ),
                        const SizedBox(width: 8),
                        TactileButton(
                          type: TactileType.secondary,
                          height: 28,
                          borderRadius: 6,
                          bevelDepth: 2.0,
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          enabled: true,
                          label: 'Retry',
                          onTap: () {
                            context.read<EntryProvider>().retryEngine();
                          },
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 18,
            child: Text(
              'v1.0.2',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 10.5, color: AppTheme.textFaint),
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
    return Scaffold(
      backgroundColor: AppTheme.bgBody,
      body: Center(
        child: Container(
          width: 470,
          padding: const EdgeInsets.fromLTRB(26, 20, 26, 18),
          decoration: BoxDecoration(
            color: AppTheme.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: AppTheme.border),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'FlowStudio',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textMain,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'Sign in or activate to continue',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 11.5, color: AppTheme.textDim),
              ),
              const SizedBox(height: 16),
              _doorLabel('ACCOUNT'),
              const SizedBox(height: 8),
              TactileButton(
                type: TactileType.secondary,
                height: 34,
                borderRadius: 6,
                bevelDepth: 2.0,
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
              const SizedBox(height: 8),
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
              const SizedBox(height: 10),
              TactileButton(
                type: TactileType.gold,
                height: 34,
                borderRadius: 6,
                bevelDepth: 2.0,
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
                const SizedBox(height: 4),
                Text(
                  entry.notice,
                  style: TextStyle(fontSize: 10.5, color: AppTheme.textDim),
                ),
              ],
              if (!entry.doorAConfigured) ...[
                const SizedBox(height: 8),
                Text(
                  entry.doorAMessage,
                  style: TextStyle(fontSize: 10.5, color: AppTheme.textFaint),
                ),
              ],
              const SizedBox(height: 12),
              Divider(height: 1, color: AppTheme.borderSoft),
              const SizedBox(height: 12),
              _doorLabel('LICENSE KEY'),
              const SizedBox(height: 6),
              // The activation notice comes FIRST, above the field,
              // before any activation is attempted.
              Text(
                'Internet is required to activate your license key.',
                style: TextStyle(fontSize: 11, color: AppTheme.textDim),
              ),
              const SizedBox(height: 8),
              _field(
                controller: _keyController,
                hint: 'Paste your license key',
                enabled: entry.loaded && !entry.busy,
                maxLines: 3,
              ),
              const SizedBox(height: 10),
              TactileButton(
                type: TactileType.gold,
                height: 34,
                borderRadius: 6,
                bevelDepth: 2.0,
                enabled: entry.loaded && !entry.busy,
                label: entry.busy ? 'Working…' : 'Activate',
                onTap: () {
                  context
                      .read<EntryProvider>()
                      .activateKey(_keyController.text);
                },
              ),
              const SizedBox(height: 6),
              Text(
                'A license key works on one device only.',
                style: TextStyle(fontSize: 10, color: AppTheme.textFaint),
              ),
              if (entry.error.isNotEmpty) ...[
                const SizedBox(height: 10),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  decoration: BoxDecoration(
                    color: AppTheme.redBg,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppTheme.red),
                  ),
                  child: Text(
                    entry.error,
                    style: TextStyle(fontSize: 11, color: AppTheme.red),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
