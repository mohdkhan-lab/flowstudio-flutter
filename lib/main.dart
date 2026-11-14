import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:media_kit/media_kit.dart';
import 'theme/app_theme.dart';
import 'providers/accounts_provider.dart';
import 'providers/activity_provider.dart';
import 'providers/settings_provider.dart';
import 'providers/generator_provider.dart';
import 'providers/notifications_provider.dart';
import 'services/automation_bridge.dart';
import 'models/activity_log.dart';
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
            // v2.48.104: UI zoom (owner's order — top-strip
            // − / % / + buttons). The whole interface is laid
            // out at window÷scale and painted scaled, so panels,
            // text and buttons grow/shrink as ONE unit.
            // MediaQuery reports the divided size too, so
            // MediaQuery-driven widgets agree with the layout
            // they see. At 100% the child passes through
            // untouched — the tuned 1024×768 fit is unchanged.
            // v2.48.105: ZOOM FIX — the .104 structure put the
            // divided-size SizedBox under the Align's normal
            // window constraints, so w/h were CLAMPED back to
            // the window size: the layout still built at the
            // real window size and Transform.scale only shrank
            // the PAINT (owner's live proof at 70%: the whole
            // app became a small box in the top-left corner,
            // the rest of the window empty black; above 100%
            // the paint cropped instead of reflowing). An
            // OverflowBox now sits between the Align and the
            // Transform: it hands the divided size (w×h) to its
            // child regardless of the window constraint while
            // sizing itself to the window, so the layout
            // genuinely happens at w×h and the scaled paint
            // fills the window exactly — full-bleed at every
            // zoom level, browser-style.
            builder: (context, child) {
              final scale = settingsProv.settings.uiScale;
              if (child == null) return const SizedBox.shrink();
              if (scale == 1.0) return child;
              return LayoutBuilder(
                builder: (context, constraints) {
                  final w = constraints.maxWidth / scale;
                  final h = constraints.maxHeight / scale;
                  return MediaQuery(
                    data: MediaQuery.of(context)
                        .copyWith(size: Size(w, h)),
                    child: Align(
                      alignment: Alignment.topLeft,
                      child: OverflowBox(
                        alignment: Alignment.topLeft,
                        minWidth: w,
                        maxWidth: w,
                        minHeight: h,
                        maxHeight: h,
                        child: Transform.scale(
                          scale: scale,
                          alignment: Alignment.topLeft,
                          child:
                              SizedBox(width: w, height: h, child: child),
                        ),
                      ),
                    ),
                  );
                },
              );
            },
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
  /// exactly as if pasted, and the run starts through the very
  /// handler the Generate button invokes — no duplicated
  /// generation logic anywhere. A sent tag becomes the selected
  /// TAG, a sent project becomes the Project field's value (through
  /// the same setter the field itself uses, so the run saves into
  /// that project's folder and History groups it there).
  /// v2.48.103 (the agent-batch fix): the intake is now
  /// GeneratorProvider.setMcpPrompts — the prompts are kept as a
  /// DISCRETE list, so each one queues as its own task (its own
  /// Agent conversation in Agent mode) in Bulk and Agent mode
  /// alike. The old setRawText intake let Agent mode's
  /// whole-text-as-one-prompt rule collapse an MCP batch of N
  /// prompts into ONE mashed prompt — the run "started: 1
  /// prompt(s)", spent one video's credits and ended, prompts
  /// 2–N never running. The box still displays the joined text.
  /// The request's agentClips list (Bulk Mode, parallel to the
  /// prompts; a bare number applies to all) rides along per
  /// prompt.
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
    // v2.48.103: per-prompt agentClips — a parallel list, or a
    // single number for every prompt; anything unreadable is 1.
    final rawClips = data['agentClips'];
    int clipsAt(int i) {
      final v = rawClips is List
          ? (i < rawClips.length ? rawClips[i] : null)
          : rawClips;
      final n = v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 1;
      return n >= 1 ? n : 1;
    }

    final generator = context.read<GeneratorProvider>();
    generator.setMcpPrompts(
      prompts,
      List.generate(prompts.length, clipsAt),
    );
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
    // v2.48.62 (ZC30 TEST FLAG): arm the one-shot skip-first-
    // download flag for THIS run only — startGeneration
    // captures and clears it before anything else.
    if (data['skipFirstTaskDownload'] == true) {
      generator.armSkipFirstTaskDownloadOnce();
    }
    // v2.48.70 (Item E — one settings truth, fallback route):
    // the bridge pushes the CURRENT engine-side settings
    // (the same store MCP writes go to) with the request.
    // Apply them to SettingsProvider BEFORE the run starts,
    // through the provider's own updaters (they also persist
    // back to the engine store), so an MCP-started in-app
    // run uses the settings MCP last wrote — not whatever
    // the app happened to hold in memory. Absent/empty
    // fields leave the app's values exactly as they were.
    final pushed = data['settings'];
    if (pushed is Map) {
      final settings = context.read<SettingsProvider>();
      final model = pushed['model']?.toString().trim() ?? '';
      if (model.isNotEmpty) settings.updateModel(model);
      final duration = pushed['duration']?.toString().trim() ?? '';
      if (duration.isNotEmpty) settings.updateDuration(duration);
      final aspect = pushed['aspectRatio']?.toString().trim() ?? '';
      if (aspect.isNotEmpty) settings.updateAspectRatio(aspect);
      final quality = pushed['quality']?.toString().trim() ?? '';
      if (quality.isNotEmpty) settings.updateQuality(quality);
    }
    // v2.48.83 (P1 — progress visibility): a run started
    // from MCP must SAY so. Mark its source for the
    // Progress cards and leave an Activity line naming
    // MCP, so the owner can always tell who started the
    // run he is watching — a run never appears from
    // nowhere.
    generator.markNextRunSource('MCP');
    context.read<ActivityProvider>().addLog(
      'MCP (flowstudio_generate_in_app): ${prompts.length} prompt(s) received — this run was started from MCP; watch it in Progress.',
      level: LogLevel.info,
    );
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

  /// Desktop Keyboard Shortcuts
  void _handleKeyboardGenerate(BuildContext context) {
    final gen = context.read<GeneratorProvider>();
    final accounts = context.read<AccountsProvider>();
    final activity = context.read<ActivityProvider>();
    final settingsProv = context.read<SettingsProvider>();
    if (!gen.isRunning) {
      gen.startGeneration(
        accounts: accounts,
        activity: activity,
        settings: settingsProv,
      );
    } else {
      gen.stopGeneration(activity);
    }
  }

  void _handleEscape(BuildContext context) {
    final settingsProv = context.read<SettingsProvider>();
    if (settingsProv.currentView != 'generate') {
      settingsProv.setNavView('generate');
    }
    final notifProv = context.read<NotificationsProvider>();
    if (notifProv.panelOpen) {
      notifProv.closePanel();
    }
  }

  void _handleToggleSettings(BuildContext context) {
    final settingsProv = context.read<SettingsProvider>();
    final next = settingsProv.currentView == 'settings' ? 'generate' : 'settings';
    settingsProv.setNavView(next);
  }

  void _handleToggleSelectAll(BuildContext context) {
    final focusWidget = FocusManager.instance.primaryFocus?.context?.widget;
    if (focusWidget is EditableText) {
      return; // Keep standard text selection inside textfields
    }
    final accountsProv = context.read<AccountsProvider>();
    final allSelected = accountsProv.accounts.isNotEmpty &&
        accountsProv.accounts.every((a) => a.isChecked);
    if (allSelected) {
      accountsProv.clearSelection();
    } else {
      accountsProv.selectAll();
    }
  }

  @override
  Widget build(BuildContext context) {
    return CallbackShortcuts(
      bindings: <ShortcutActivator, VoidCallback>{
        const SingleActivator(LogicalKeyboardKey.enter, control: true): () => _handleKeyboardGenerate(context),
        const SingleActivator(LogicalKeyboardKey.enter, meta: true): () => _handleKeyboardGenerate(context),
        const SingleActivator(LogicalKeyboardKey.comma, control: true): () => _handleToggleSettings(context),
        const SingleActivator(LogicalKeyboardKey.comma, meta: true): () => _handleToggleSettings(context),
        const SingleActivator(LogicalKeyboardKey.keyA, control: true): () => _handleToggleSelectAll(context),
        const SingleActivator(LogicalKeyboardKey.keyA, meta: true): () => _handleToggleSelectAll(context),
        const SingleActivator(LogicalKeyboardKey.escape): () => _handleEscape(context),
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
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
                  final isUltraWide = winW >= 2000;
                  // Section size tuned for standard & 2560x1080 UltraWide:
                  // compact <1150: 240.0, standard: 260.0, wide >1500: 285.0, ultrawide >=2000: 310.0
                  final sidebarWidth = compact
                      ? 240.0
                      : (isUltraWide ? 310.0 : (winW > 1500 ? 285.0 : 260.0));
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
                                  : (isUltraWide
                                      ? const EdgeInsets.fromLTRB(14, 12, 16, 12)
                                      : const EdgeInsets.fromLTRB(10, 12, 14, 12)),
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
    ),
      ),
    );
  }
}
