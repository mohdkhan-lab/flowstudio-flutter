class AppSettings {
  String appearance; // 'dark', 'white', 'system'
  String model; // 'Omni Flash', 'Veo 3.1 Fast', 'Veo 3.1 Lite', 'Veo 3.1 Quality'
  String duration; // '4s', '6s', '8s', '10s'
  String aspectRatio; // '9:16', '16:9', '1:1'
  String quality; // '720p', '1080p'
  String namingPattern; // 'tag' (00-01.mp4), 'scene' (scene001.mp4)
  List<String> customTags;
  int parallelBrowsers; // 1, 2, 3, 4
  String outputDirectory;
  String chromePath;
  bool showBrowsers; // Show Puppeteer browsers on screen
  bool previewAutoplay;
  bool autoVerifyOnStart;
  bool autoCheckUpdates;
  String currentVersion;
  String whatsAppLink;
  String chatLink;
  String supportLink;

  AppSettings({
    this.appearance = 'dark',
    this.model = 'Omni Flash',
    this.duration = '4s',
    this.aspectRatio = '9:16',
    this.quality = '720p',
    this.namingPattern = 'tag',
    List<String>? customTags,
    this.parallelBrowsers = 4,
    this.outputDirectory = 'C:\\FlowStudio\\Videos',
    this.chromePath = '',
    this.showBrowsers = false,
    this.previewAutoplay = true,
    this.autoVerifyOnStart = false,
    this.autoCheckUpdates = true,
    this.currentVersion = 'v2.25.0',
    this.whatsAppLink = 'https://wa.me/',
    this.chatLink = 'https://flowstudio.chat/',
    this.supportLink = 'https://flowstudio.support/',
  }) : customTags = customTags ?? ['None', 'Cinematic', 'Anime', 'Drone', '4K'];

  AppSettings copyWith({
    String? appearance,
    String? model,
    String? duration,
    String? aspectRatio,
    String? quality,
    String? namingPattern,
    List<String>? customTags,
    int? parallelBrowsers,
    String? outputDirectory,
    String? chromePath,
    bool? showBrowsers,
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
      model: model ?? this.model,
      duration: duration ?? this.duration,
      aspectRatio: aspectRatio ?? this.aspectRatio,
      quality: quality ?? this.quality,
      namingPattern: namingPattern ?? this.namingPattern,
      customTags: customTags ?? List.from(this.customTags),
      parallelBrowsers: parallelBrowsers ?? this.parallelBrowsers,
      outputDirectory: outputDirectory ?? this.outputDirectory,
      chromePath: chromePath ?? this.chromePath,
      showBrowsers: showBrowsers ?? this.showBrowsers,
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
