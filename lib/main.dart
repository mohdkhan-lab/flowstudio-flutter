import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:media_kit/media_kit.dart';
import 'theme/app_theme.dart';
import 'providers/accounts_provider.dart';
import 'providers/activity_provider.dart';
import 'providers/settings_provider.dart';
import 'providers/generator_provider.dart';
import 'services/automation_bridge.dart';
import 'widgets/top_strip.dart';
import 'widgets/sidebar_accounts.dart';
import 'widgets/prompts_editor.dart';
import 'widgets/video_settings_bar.dart';
import 'widgets/progress_panel.dart';
import 'widgets/activity_stream.dart';
import 'widgets/settings_view.dart';
import 'widgets/history_view.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // v2.29.0: the in-app video player (media_kit) needs its native
  // libraries initialised before any Player is created.
  MediaKit.ensureInitialized();
  runApp(const FlowStudioApp());
}

class FlowStudioApp extends StatelessWidget {
  const FlowStudioApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AccountsProvider()),
        ChangeNotifierProvider(create: (_) => SettingsProvider()),
        ChangeNotifierProvider(create: (_) => ActivityProvider()),
        ChangeNotifierProvider(create: (_) => GeneratorProvider()),
      ],
      child: Consumer<SettingsProvider>(
        builder: (context, settingsProv, _) {
          // v2.24.0: real appearance switching — 'dark' = Soft Charcoal,
          // 'white' = Creamy light, 'system' follows Windows.
          // v2.26.0: the colour theme is independent of the mode —
          // applyTheme picks the selected theme's palette for this mode.
          final appearance = settingsProv.settings.appearance;
          final platformDark =
              WidgetsBinding.instance.platformDispatcher.platformBrightness ==
                  Brightness.dark;
          final useDark =
              appearance == 'dark' || (appearance == 'system' && platformDark);
          AppTheme.applyTheme(settingsProv.settings.theme, useDark);
          return MaterialApp(
            title: 'FlowStudio Lite',
            debugShowCheckedModeBanner: false,
            theme: AppTheme.lightTheme,
            darkTheme: AppTheme.darkTheme,
            themeMode: useDark ? ThemeMode.dark : ThemeMode.light,
            home: const MainStudioScreen(),
          );
        },
      ),
    );
  }
}

class MainStudioScreen extends StatefulWidget {
  const MainStudioScreen({super.key});

  @override
  State<MainStudioScreen> createState() => _MainStudioScreenState();
}

class _MainStudioScreenState extends State<MainStudioScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _runStartupActions();
    });
  }

  // v2.29.0 (F4): the two startup Settings toggles, for real —
  // "Check automatically" runs the update check once at startup
  // and "Run Verify All when the app starts" triggers the bridge
  // verify-all once the engine answers. Both were save-only
  // toggles before. Everything is guarded: if the engine is not
  // up yet, nothing happens (and nothing crashes).
  Future<void> _runStartupActions() async {
    try {
      final bridge = AutomationBridge.instance;
      var healthy = false;
      for (var i = 0; i < 30 && !healthy; i++) {
        healthy = await bridge.checkHealth();
        if (!healthy) {
          await Future.delayed(const Duration(milliseconds: 500));
        }
      }
      if (!healthy || !mounted) return;
      final settings = context.read<SettingsProvider>();
      await settings.loadSettingsFromEngine();
      if (!mounted) return;
      await settings.runStartupActions(
        verifyAll: () => context.read<AccountsProvider>().syncAll(),
      );
    } catch (_) {
      // Startup actions are best-effort by design.
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.bgBody,
      body: SafeArea(
        child: Column(
          children: [
            // Top Strip Header Bar
            const TopStrip(),

            // Main Body Content
            // Responsive pass (post-v2.28.0): LayoutBuilder breakpoints
            // on the WINDOW width — compact <1150 (sidebar 215, tighter
            // centre padding), standard 1150–1500 (sidebar 250, the
            // tuned 1024×768 fit lives here and is unchanged), wide
            // >1500 (sidebar 280; the centre panels are all Expanded/
            // flex so they simply get proportionally more room).
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final winW = constraints.maxWidth;
                  final compact = winW < 1150;
                  final sidebarWidth = compact
                      ? 215.0
                      : (winW > 1500 ? 280.0 : 250.0);
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // Left Sidebar: Accounts & Filters
                      SidebarAccounts(width: sidebarWidth),

                      // Center & Right Area
                      Expanded(
                        child: Consumer<SettingsProvider>(
                          builder: (context, settingsProv, _) {
                            if (settingsProv.currentView == 'settings') {
                              return const SettingsView();
                            }
                            // v2.27.0: History view (Activity → Previous videos)
                            if (settingsProv.currentView == 'history') {
                              return const HistoryView();
                            }
                            return Padding(
                              padding: compact
                                  ? const EdgeInsets.fromLTRB(8, 10, 10, 10)
                                  : const EdgeInsets.fromLTRB(10, 12, 14, 12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              // Top section: Prompts + Video Settings (Left) & Progress (Right)
                              Expanded(
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.stretch,
                                  children: [
                                    // Prompts & Video Settings
                                    const Expanded(
                                      flex: 6,
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.stretch,
                                        children: [
                                          Expanded(child: PromptsEditor()),
                                          SizedBox(height: 10),
                                          VideoSettingsBar(),
                                        ],
                                      ),
                                    ),
                                    const SizedBox(width: 10),
                                    // Progress Panel
                                    const Expanded(
                                      flex: 4,
                                      child: ProgressPanel(),
                                    ),
                                  ],
                                ),
                              ),

                              const SizedBox(height: 10),

                              // Bottom Activity Console Panel
                              const ActivityStream(),
                            ],
                          ),
                        );
                          },
                        ),
                      ),
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
