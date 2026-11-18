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
///   plus a 6-digit code. While no account backend is configured
///   the whole door shows the honest not-available message and its
///   controls stay disabled — there is no mock sign-in.
///
///   DOOR B — LICENSE KEY: a signed key, checked by the engine,
///   bound to this one device on activation. The notice above the
///   field — "Internet is required to activate your license key."
///   — is shown BEFORE the first activation attempt, so nobody is
///   surprised by it (the owner's explicit order).
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
  final TextEditingController _codeController = TextEditingController();
  final TextEditingController _keyController = TextEditingController();

  @override
  void dispose() {
    _emailController.dispose();
    _codeController.dispose();
    _keyController.dispose();
    super.dispose();
  }

  Widget _field({
    required TextEditingController controller,
    required String hint,
    bool enabled = true,
    int maxLines = 1,
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

  @override
  Widget build(BuildContext context) {
    final entry = context.watch<EntryProvider>();
    final doorAEnabled = entry.doorAConfigured && !entry.busy;
    return Scaffold(
      backgroundColor: AppTheme.bgBody,
      body: Center(
        child: Container(
          width: 470,
          padding: const EdgeInsets.fromLTRB(26, 22, 26, 20),
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
              if (!entry.loaded) ...[
                const SizedBox(height: 10),
                Text(
                  'Starting the engine…',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 10.5, color: AppTheme.textFaint),
                ),
              ],
              const SizedBox(height: 18),
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
                  }
                },
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: _field(
                      controller: _emailController,
                      hint: 'Email address',
                      enabled: doorAEnabled,
                    ),
                  ),
                  const SizedBox(width: 8),
                  TactileButton(
                    type: TactileType.secondary,
                    height: 32,
                    borderRadius: 6,
                    bevelDepth: 2.0,
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    enabled: doorAEnabled,
                    label: 'Send code',
                    onTap: () {
                      context
                          .read<EntryProvider>()
                          .sendCode(_emailController.text);
                    },
                  ),
                ],
              ),
              if (entry.codeSent) ...[
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: _field(
                        controller: _codeController,
                        hint: '6-digit code from your email',
                        enabled: doorAEnabled,
                      ),
                    ),
                    const SizedBox(width: 8),
                    TactileButton(
                      type: TactileType.secondary,
                      height: 32,
                      borderRadius: 6,
                      bevelDepth: 2.0,
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      enabled: doorAEnabled,
                      label: 'Verify',
                      onTap: () {
                        context.read<EntryProvider>().verifyCode(
                              _emailController.text,
                              _codeController.text,
                            );
                      },
                    ),
                  ],
                ),
              ],
              if (!entry.doorAConfigured) ...[
                const SizedBox(height: 8),
                Text(
                  entry.doorAMessage,
                  style: TextStyle(fontSize: 10.5, color: AppTheme.textFaint),
                ),
              ],
              const SizedBox(height: 16),
              Divider(height: 1, color: AppTheme.borderSoft),
              const SizedBox(height: 14),
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
                enabled: !entry.busy,
                maxLines: 3,
              ),
              const SizedBox(height: 10),
              TactileButton(
                type: TactileType.gold,
                height: 34,
                borderRadius: 6,
                bevelDepth: 2.0,
                enabled: !entry.busy,
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
