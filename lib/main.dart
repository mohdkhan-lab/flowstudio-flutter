import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:media_kit/media_kit.dart';
import 'theme/app_theme.dart';
import 'providers/accounts_provider.dart';
import 'providers/activity_provider.dart';
import 'providers/settings_provider.dart';
import 'providers/generator_provider.dart';
import 'providers/notifications_provider.dart';
import 'services/automation_bridge.dart';
import 'widgets/top_strip.dart';
import 'widgets/notification_center.dart';
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
        // Notification Center: registered first — the other
        // providers publish events to it through its static
        // `shared` reference, set in its constructor.
        ChangeNotifierProvider(create: (_) => NotificationsProvider()),
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
            // Ease ThemeData-driven surfaces (framework widgets,
            // dialogs, menus — and the Scaffold backdrop, which
            // reads its colour from Theme.of) between palettes
            // instead of snapping. The app's own panels read
            // AppTheme statics at build time and still switch
            // instantly by design.
            themeAnimationDuration: const Duration(milliseconds: 250),
            themeAnimationCurve: Curves.easeInOut,
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
  // v2.34.0 (Problem 9): watch the Settings custom-tag list — when
  // it changes (a tag deleted in Settings, or a fresh list loaded
  // from the engine), the GeneratorProvider's selected tag is
  // reconciled against it, so a removed tag is never silently used
  // for file naming. Only a tag-LIST change triggers this: an MCP
  // run tag (set programmatically, not a custom tag) is untouched.
  SettingsProvider? _tagsSettingsProv;
  GeneratorProvider? _tagsGeneratorProv;
  List<String> _lastKnownTags = const [];

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final settingsProv = context.read<SettingsProvider>();
    if (!identical(settingsProv, _tagsSettingsProv)) {
      _tagsSettingsProv?.removeListener(_onSettingsTagsChanged);
      _tagsSettingsProv = settingsProv;
      _lastKnownTags = List.of(settingsProv.settings.customTags);
      settingsProv.addListener(_onSettingsTagsChanged);
    }
    _tagsGeneratorProv = context.read<GeneratorProvider>();
  }

  void _onSettingsTagsChanged() {
    final settingsProv = _tagsSettingsProv;
    final generatorProv = _tagsGeneratorProv;
    if (settingsProv == null || generatorProv == null) return;
    final tags = settingsProv.settings.customTags;
    if (tags.length == _lastKnownTags.length &&
        tags.every(_lastKnownTags.contains)) {
      return;
    }
    _lastKnownTags = List.of(tags);
    generatorProv.reconcileSelectedTag(tags);
  }

  @override
  void dispose() {
    _tagsSettingsProv?.removeListener(_onSettingsTagsChanged);
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    // v2.32.2: an MCP "generate in app" request arrives over the
    // bridge's SSE stream. This screen is the composition root that
    // can reach every provider the Generate flow needs, so it owns
    // the consumption (the update-request callback could live in
    // SettingsProvider because that flow is self-contained; this
    // one spans four providers, like the Generate button itself).
    AutomationBridge.instance.onMcpUiGenerateRequest =
        _handleMcpUiGenerateRequest;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _runStartupActions();
    });
  }

  /// v2.32.2: Muse (through the MCP connector) asked for a run to
  /// start from THIS screen. The prompts land in the Prompts box
  /// exactly as if pasted — GeneratorProvider.setRawText is the
  /// box's own text state, and the join is the blank-line join
  /// appendPrompts uses (Bulk mode parses blank-line-separated
  /// blocks; Agent mode takes the whole text as one prompt, exactly
  /// as a paste would). A sent tag becomes the selected TAG, a sent
  /// project becomes the Project field's value (through the same
  /// setter the field itself uses, so the run saves into that
  /// project's folder and History groups it there), and the run
  /// starts through the very handler the Generate button invokes —
  /// no duplicated generation logic anywhere.
  void _handleMcpUiGenerateRequest(Map<String, dynamic> data) {
    if (!mounted) return;
    final raw = data['prompts'];
    final prompts = raw is List
        ? raw
            .map((e) => e.toString())
            .where((s) => s.trim().isNotEmpty)
            .toList()
        : <String>[];
    if (prompts.isEmpty) return;
    final generator = context.read<GeneratorProvider>();
    generator.setRawText(prompts.join('\n\n'));
    final tag = data['tag']?.toString().trim() ?? '';
    if (tag.isNotEmpty) {
      generator.setSelectedTag(tag);
    }
    // v2.41.0 (Fix list C, item 1): an absent/empty project leaves
    // the field exactly as the user left it.
    final project = data['project']?.toString().trim() ?? '';
    if (project.isNotEmpty) {
      generator.setProjectName(project);
    }
    generator.startGeneration(
      accounts: context.read<AccountsProvider>(),
      activity: context.read<ActivityProvider>(),
      settings: context.read<SettingsProvider>(),
    );
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

  /// Switching between the three centre views cross-fades
  /// (~200ms) instead of hard-cutting. The KeyedSubtree gives
  /// AnimatedSwitcher a stable identity per view; the sizes and
  /// layout of every view are untouched.
  Widget _switchView(String view, Widget child) {
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 200),
      switchInCurve: Curves.easeOut,
      switchOutCurve: Curves.easeIn,
      child: KeyedSubtree(key: ValueKey<String>(view), child: child),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // The backdrop colour comes from ThemeData (whose
      // scaffoldBackgroundColor IS AppTheme.bgBody) instead of the
      // static token directly: reading Theme.of registers a
      // rebuild dependency, so the colour behind the panels
      // FOLLOWS the palette — the static read left the old
      // palette's dark bgBody sitting behind fresh light panels
      // in Light mode — and it cross-fades via the theme
      // animation set on MaterialApp.
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      body: SafeArea(
        // Notification Center: the bell's popup + panel live in an
        // overlay layer above the untouched Column layout, so no
        // existing size on the main screen changes.
        child: Stack(
          children: [
            Column(
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
            // NOTE: v2.46.3 me sidebar 25px patla (190/225/255) kiya
            // gaya tha — owner ne live dekh kar usi din wapas pehle
            // jaisa karne ka order diya (v2.46.4).
            // v2.46.6 (owner-approved Design A / Sample 5): Cookies
            // section ab 285 hai taaki Cookie Line ke beech me
            // proper space rahe aur sab text (ek size = 9) apne
            // pure size par dikhe, koi attach/cut na ho.
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final winW = constraints.maxWidth;
                  final compact = winW < 1150;
                  // v2.46.7: owner ne HTML tuner par khud numbers
                  // chune — section 330 (wide par 350).
                  final sidebarWidth = compact
                      ? 260.0
                      : (winW > 1500 ? 280.0 : 260.0);
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // Left Sidebar: Accounts & Filters
                      SidebarAccounts(width: sidebarWidth),

                      // Center & Right Area
                      Expanded(
                        child: Consumer<SettingsProvider>(
                          builder: (context, settingsProv, _) {
                            final view = settingsProv.currentView;
                            if (view == 'settings') {
                              return _switchView(view, const SettingsView());
                            }
                            // v2.27.0: History view (Activity → Previous videos)
                            if (view == 'history') {
                              return _switchView(view, const HistoryView());
                            }
                            return _switchView(
                              view,
                              Padding(
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
            const Positioned.fill(child: NotificationOverlay()),
          ],
        ),
      ),
    );
  }
}
