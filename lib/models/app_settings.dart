class AppSettings {
  String appearance; // 'dark', 'white', 'system'
  String theme; // v2.26.0: colour theme id (see AppTheme.themeIds)
  String model; // 'Omni Flash' (1.1, default), 'Omni 1.2 Flash', 'Veo 3.1 Fast', 'Veo 3.1 Lite', 'Veo 3.1 Quality'
  String duration; // '4s', '6s', '8s', '10s', '15s' (15s = Omni 1.2 only)
  String aspectRatio; // '9:16', '16:9', '1:1'
  String quality; // '360p', '720p', '1080p' (1080p = Flow's enhanced download)
  String downloadMode; // v2.48.74: 'original' (backend file as generated, default), 'enhanced' (editor Download menu → one-step-up Upscaled)
  String namingPattern; // 'tag' (00-01.mp4), 'scene' (scene001.mp4)
  List<String> customTags;
  int parallelBrowsers; // 1, 2, 3, 4
  String outputDirectory;
  String chromePath;
  bool showBrowsers; // Show Puppeteer browsers on screen
  bool headlessGeneration; // Headless mode: generation workers run true headless Chrome (no window at all)
  bool onlyRunLiveAccounts; // v2.27.0: moved here from the sidebar (Settings → Automation)
  bool previewAutoplay;
  bool autoVerifyOnStart;
  bool autoCheckUpdates;
  String currentVersion;
  String whatsAppLink;
  String chatLink;
  String supportLink;

  AppSettings({
    this.appearance = 'dark',
    this.theme = 'gold',
    this.model = 'Omni Flash',
    this.duration = '4s',
    this.aspectRatio = '9:16',
    this.quality = '720p',
    this.downloadMode = 'original',
    this.namingPattern = 'tag',
    List<String>? customTags,
    this.parallelBrowsers = 4,
    this.outputDirectory = 'C:\\FlowStudio\\Videos',
    this.chromePath = '',
    this.showBrowsers = false,
    this.headlessGeneration = false,
    this.onlyRunLiveAccounts = false,
    this.previewAutoplay = true,
    this.autoVerifyOnStart = false,
    this.autoCheckUpdates = true,
    this.currentVersion = 'v2.48.90',
    // v2.34.0 (Problem 12): no placeholder social links ship any
    // more — an unconfigured service shows NO icon (top strip /
    // About) instead of an icon that opens a dead page. The owner
    // sets real links in Settings → Created By; values stored in
    // the engine still load over these defaults exactly as before.
    this.whatsAppLink = '',
    this.chatLink = '',
    this.supportLink = '',
  }) : customTags = customTags ?? ['None', 'Cinematic', 'Anime', 'Drone', '4K'];

  AppSettings copyWith({
    String? appearance,
    String? theme,
    String? model,
    String? duration,
    String? aspectRatio,
    String? quality,
    String? downloadMode,
    String? namingPattern,
    List<String>? customTags,
    int? parallelBrowsers,
    String? outputDirectory,
    String? chromePath,
    bool? showBrowsers,
    bool? headlessGeneration,
    bool? onlyRunLiveAccounts,
    bool? previewAutoplay,
    bool? autoVerifyOnStart,
    bool? autoCheckUpdates,
    String? currentVersion,
    String? whatsAppLink,
    String? chatLink,
    String? supportLink,
  }) {
    return AppSettings(
      appearance: appearance ?? this.appearance,
      theme: theme ?? this.theme,
      model: model ?? this.model,
      duration: duration ?? this.duration,
      aspectRatio: aspectRatio ?? this.aspectRatio,
      quality: quality ?? this.quality,
      downloadMode: downloadMode ?? this.downloadMode,
      namingPattern: namingPattern ?? this.namingPattern,
      customTags: customTags ?? List.from(this.customTags),
      parallelBrowsers: parallelBrowsers ?? this.parallelBrowsers,
      outputDirectory: outputDirectory ?? this.outputDirectory,
      chromePath: chromePath ?? this.chromePath,
      showBrowsers: showBrowsers ?? this.showBrowsers,
      headlessGeneration: headlessGeneration ?? this.headlessGeneration,
      onlyRunLiveAccounts: onlyRunLiveAccounts ?? this.onlyRunLiveAccounts,
      previewAutoplay: previewAutoplay ?? this.previewAutoplay,
      autoVerifyOnStart: autoVerifyOnStart ?? this.autoVerifyOnStart,
      autoCheckUpdates: autoCheckUpdates ?? this.autoCheckUpdates,
      currentVersion: currentVersion ?? this.currentVersion,
      whatsAppLink: whatsAppLink ?? this.whatsAppLink,
      chatLink: chatLink ?? this.chatLink,
      supportLink: supportLink ?? this.supportLink,
    );
  }
}
