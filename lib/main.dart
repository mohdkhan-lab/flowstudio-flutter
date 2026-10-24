import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'theme/app_theme.dart';
import 'providers/accounts_provider.dart';
import 'providers/activity_provider.dart';
import 'providers/settings_provider.dart';
import 'providers/generator_provider.dart';
import 'widgets/top_strip.dart';
import 'widgets/sidebar_accounts.dart';
import 'widgets/prompts_editor.dart';
import 'widgets/video_settings_bar.dart';
import 'widgets/progress_panel.dart';
import 'widgets/activity_stream.dart';
import 'widgets/settings_view.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
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

class MainStudioScreen extends StatelessWidget {
  const MainStudioScreen({super.key});

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
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Left Sidebar: Accounts & Filters
                  const SidebarAccounts(),

                  // Center & Right Area
                  Expanded(
                    child: Consumer<SettingsProvider>(
                      builder: (context, settingsProv, _) {
                        if (settingsProv.currentView == 'settings') {
                          return const SettingsView();
                        }
                        return Padding(
                          padding: const EdgeInsets.fromLTRB(10, 12, 14, 12),
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
              ),
            ),
          ],
        ),
      ),
    );
  }
}
