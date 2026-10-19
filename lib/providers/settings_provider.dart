import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import '../models/app_settings.dart';
import '../services/automation_bridge.dart';

class SettingsProvider with ChangeNotifier {
  String _currentView = 'generate'; // 'generate' or 'settings'
  final AppSettings _settings = AppSettings();
  bool _isCheckingUpdates = false;
  String _updateStatusMessage = 'Updates are checked on the official release page.';
  int _totalVideosSaved = 0;
  int _totalAccounts = 0;

  // v2.23.0: in-app updater — the app downloads the new Setup itself and
  // runs it; the user never has to visit GitHub or download by hand.
  bool _updateAvailable = false;
  String _latestVersion = '';
  String _updateDownloadUrl = '';
  int _updateSizeBytes = 0;
  bool _isDownloadingUpdate = false;
  double _updateDownloadProgress = 0;
  String _downloadedSetupPath = '';

  String get currentView => _currentView;
  AppSettings get settings => _settings;
  bool get isCheckingUpdates => _isCheckingUpdates;
  String get updateStatusMessage => _updateStatusMessage;
  int get totalVideosSaved => _totalVideosSaved;
  int get totalAccounts => _totalAccounts;
  bool get updateAvailable => _updateAvailable;
  String get latestVersion => _latestVersion;
  bool get isDownloadingUpdate => _isDownloadingUpdate;
  double get updateDownloadProgress => _updateDownloadProgress;
  String get downloadedSetupPath => _downloadedSetupPath;
  String get updateSizeLabel => _updateSizeBytes > 0
      ? '${(_updateSizeBytes / (1024 * 1024)).toStringAsFixed(1)} MB'
      : '';

  SettingsProvider() {
    loadSettingsFromEngine();
  }

  Future<void> loadSettingsFromEngine() async {
    try {
      final data = await AutomationBridge.instance.loadSettings();
      if (data != null) {
        if (data['appearance'] != null) _settings.appearance = data['appearance'].toString();
        if (data['default_model'] != null) _settings.model = data['default_model'].toString();
        if (data['default_duration'] != null) _settings.duration = data['default_duration'].toString();
        if (data['default_aspect'] != null) _settings.aspectRatio = data['default_aspect'].toString();
        if (data['default_naming'] != null) _settings.namingPattern = data['default_naming'].toString();
        if (data['download_folder'] != null) _settings.outputDirectory = data['download_folder'].toString();
        if (data['chrome_path'] != null) _settings.chromePath = data['chrome_path'].toString();
        // v2.22.0 fix: browser visibility is the engine's
        // 'browser_background' setting ('1' = background/hidden,
        // '0' = browsers visible). The old 'show_browsers' key was read by
        // the Flutter UI but the engine never used it the same way.
        if (data['browser_background'] != null) {
          _settings.showBrowsers = data['browser_background'].toString() == '0';
        }
        if (data['default_quality'] != null) _settings.quality = data['default_quality'].toString();
        if (data['preview_autoplay'] != null) _settings.previewAutoplay = data['preview_autoplay'] != '0';
        if (data['auto_verify_start'] != null) _settings.autoVerifyOnStart = data['auto_verify_start'] == '1';
        if (data['auto_check_updates'] != null) _settings.autoCheckUpdates = data['auto_check_updates'] != '0';
        
        if (data['custom_tags'] != null) {
          try {
            final tags = json.decode(data['custom_tags'].toString());
            if (tags is List) {
              _settings.customTags = List<String>.from(tags);
              if (!_settings.customTags.contains('None')) {
                _settings.customTags.insert(0, 'None');
              }
            }
          } catch (_) {}
        }

        if (data['social_links'] != null) {
          try {
            final links = json.decode(data['social_links'].toString());
            if (links is Map) {
              if (links['whatsapp'] != null) _settings.whatsAppLink = links['whatsapp'].toString();
              if (links['chat'] != null) _settings.chatLink = links['chat'].toString();
              if (links['support'] != null) _settings.supportLink = links['support'].toString();
            }
          } catch (_) {}
        }
      }

      final statsData = await AutomationBridge.instance.getStats();
      if (statsData['stats'] != null && statsData['stats']['total'] != null) {
        _totalVideosSaved = int.tryParse(statsData['stats']['total'].toString()) ?? 0;
      }
      if (statsData['accountCount'] != null) {
        _totalAccounts = int.tryParse(statsData['accountCount'].toString()) ?? 0;
      }

      notifyListeners();
    } catch (_) {}
  }

  void setNavView(String view) {
    _currentView = view;
    if (view == 'settings') {
      loadSettingsFromEngine();
    }
    notifyListeners();
  }

  void updateAppearance(String val) {
    _settings.appearance = val;
    AutomationBridge.instance.saveSetting('appearance', val);
    notifyListeners();
  }

  void updateModel(String val) {
    _settings.model = val;
    AutomationBridge.instance.saveSetting('default_model', val);
    notifyListeners();
  }

  void updateDuration(String duration) {
    _settings.duration = duration;
    AutomationBridge.instance.saveSetting('default_duration', duration);
    notifyListeners();
  }

  void updateAspectRatio(String ratio) {
    _settings.aspectRatio = ratio;
    AutomationBridge.instance.saveSetting('default_aspect', ratio);
    notifyListeners();
  }

  void updateQuality(String quality) {
    _settings.quality = quality;
    AutomationBridge.instance.saveSetting('default_quality', quality);
    notifyListeners();
  }

  void updateNamingPattern(String pattern) {
    _settings.namingPattern = pattern;
    AutomationBridge.instance.saveSetting('default_naming', pattern);
    notifyListeners();
  }

  void updateParallelBrowsers(int count) {
    _settings.parallelBrowsers = count;
    notifyListeners();
  }

  void setOutputDirectory(String dir) {
    _settings.outputDirectory = dir;
    AutomationBridge.instance.saveSetting('download_folder', dir);
    notifyListeners();
  }

  void setChromePath(String path) {
    _settings.chromePath = path;
    AutomationBridge.instance.saveSetting('chrome_path', path);
    notifyListeners();
  }

  void toggleShowBrowsers(bool val) {
    _settings.showBrowsers = val;
    // Engine semantics: browser_background '1' = run browsers in the
    // background (hidden, off-screen), '0' = browsers visible.
    AutomationBridge.instance.saveSetting('browser_background', val ? '0' : '1');
    notifyListeners();
  }

  void togglePreviewAutoplay(bool val) {
    _settings.previewAutoplay = val;
    AutomationBridge.instance.saveSetting('preview_autoplay', val ? '1' : '0');
    notifyListeners();
  }

  void toggleAutoVerify(bool val) {
    _settings.autoVerifyOnStart = val;
    AutomationBridge.instance.saveSetting('auto_verify_start', val ? '1' : '0');
    notifyListeners();
  }

  void toggleAutoUpdate(bool val) {
    _settings.autoCheckUpdates = val;
    AutomationBridge.instance.saveSetting('auto_check_updates', val ? '1' : '0');
    notifyListeners();
  }

  void updateSocialLinks({String? whatsapp, String? chat, String? support}) {
    if (whatsapp != null) _settings.whatsAppLink = whatsapp;
    if (chat != null) _settings.chatLink = chat;
    if (support != null) _settings.supportLink = support;

    final map = {
      'whatsapp': _settings.whatsAppLink,
      'chat': _settings.chatLink,
      'support': _settings.supportLink,
    };
    AutomationBridge.instance.saveSetting('social_links', json.encode(map));
    notifyListeners();
  }

  void addCustomTag(String tag) {
    final clean = tag.trim();
    if (clean.isNotEmpty && !_settings.customTags.contains(clean)) {
      _settings.customTags.add(clean);
      _persistCustomTags();
      notifyListeners();
    }
  }

  void removeCustomTag(String tag) {
    if (tag != 'None') {
      _settings.customTags.remove(tag);
      _persistCustomTags();
      notifyListeners();
    }
  }

  void _persistCustomTags() {
    final listToSave = _settings.customTags.where((t) => t != 'None').toList();
    AutomationBridge.instance.saveSetting('custom_tags', json.encode(listToSave));
  }

  bool _isNewerVersion(String latest, String current) {
    List<int> parts(String v) => v
        .replaceFirst('v', '')
        .split('.')
        .map((p) => int.tryParse(p.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0)
        .toList();
    final a = parts(latest);
    final b = parts(current);
    for (int i = 0; i < a.length || i < b.length; i++) {
      final av = i < a.length ? a[i] : 0;
      final bv = i < b.length ? b[i] : 0;
      if (av != bv) return av > bv;
    }
    return false;
  }

  Future<void> checkForUpdates() async {
    // v2.22.0 fix: REAL update check against the GitHub releases of the
    // Flutter app. v2.23.0: the check now also captures the Setup's
    // direct download URL, so the app itself can download and install
    // the update — no manual trip to GitHub.
    _isCheckingUpdates = true;
    _updateStatusMessage = 'Checking for the latest version...';
    notifyListeners();

    try {
      final res = await http
          .get(
            Uri.parse(
              'https://api.github.com/repos/mohdkhan-lab/flowstudio-flutter/releases/latest',
            ),
            headers: {
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'FlowStudioLite',
            },
          )
          .timeout(const Duration(seconds: 10));
      if (res.statusCode == 200) {
        final data = json.decode(res.body) as Map<String, dynamic>;
        final tag = (data['tag_name']?.toString() ?? '');
        if (tag.isNotEmpty && _isNewerVersion(tag, _settings.currentVersion)) {
          _updateAvailable = true;
          _latestVersion = tag;
          _downloadedSetupPath = '';
          _updateDownloadUrl = '';
          _updateSizeBytes = 0;
          final assets = data['assets'];
          if (assets is List) {
            for (final a in assets) {
              final name = a['name']?.toString() ?? '';
              if (name.toLowerCase().endsWith('.exe')) {
                _updateDownloadUrl = a['browser_download_url']?.toString() ?? '';
                _updateSizeBytes = (a['size'] as num?)?.toInt() ?? 0;
                break;
              }
            }
          }
          _updateStatusMessage = _updateDownloadUrl.isNotEmpty
              ? 'New version available: $tag. Press "Download update" — the app will download and install it here itself.'
              : 'New version available: $tag — but no Setup file was attached to it.';
        } else {
          _updateAvailable = false;
          _updateStatusMessage =
              'You are on the latest version (${_settings.currentVersion}).';
        }
      } else {
        _updateStatusMessage =
            'Update check failed (GitHub answered ${res.statusCode}). Try again later.';
      }
    } catch (_) {
      _updateStatusMessage =
          'Update check failed — could not reach GitHub. Check your internet connection.';
    }

    _isCheckingUpdates = false;
    notifyListeners();
  }

  /// v2.23.0: download the new Setup inside the app, with progress.
  Future<void> downloadUpdate() async {
    if (_updateDownloadUrl.isEmpty || _isDownloadingUpdate) return;
    _isDownloadingUpdate = true;
    _updateDownloadProgress = 0;
    _updateStatusMessage = 'Downloading $_latestVersion...';
    notifyListeners();

    HttpClient? client;
    try {
      final dir = await Directory.systemTemp.createTemp('fslite_update');
      final fileName = 'FlowStudio_Lite_${_latestVersion}_Setup.exe';
      final file = File('${dir.path}${Platform.pathSeparator}$fileName');

      client = HttpClient();
      client.userAgent = 'FlowStudioLite';
      final request = await client.getUrl(Uri.parse(_updateDownloadUrl));
      final response = await request.close();
      if (response.statusCode != 200) {
        throw 'GitHub download answered ${response.statusCode}';
      }
      final total = response.contentLength > 0 ? response.contentLength : _updateSizeBytes;
      int received = 0;
      final sink = file.openWrite();
      await for (final chunk in response) {
        sink.add(chunk);
        received += chunk.length;
        if (total > 0) {
          _updateDownloadProgress = received / total;
          notifyListeners();
        }
      }
      await sink.flush();
      await sink.close();

      if (received < 1024 * 1024) {
        throw 'The downloaded file looks incomplete';
      }
      _downloadedSetupPath = file.path;
      _updateStatusMessage =
          'Download complete ($_latestVersion, ${updateSizeLabel.isNotEmpty ? updateSizeLabel : '${(received / (1024 * 1024)).toStringAsFixed(1)} MB'}). Press "Install update" — the app will close and the new version will install itself.';
    } catch (e) {
      _updateStatusMessage =
          'Download failed — check your internet connection and try again.';
    } finally {
      client?.close();
      _isDownloadingUpdate = false;
      notifyListeners();
    }
  }

  /// v2.23.0: run the downloaded Setup silently and close this app so
  /// the installer can replace its files. Accounts and settings live in
  /// %APPDATA% and are not touched by the installer.
  Future<void> installDownloadedUpdate() async {
    if (_downloadedSetupPath.isEmpty) return;
    _updateStatusMessage = 'Installing $_latestVersion — the app will close now...';
    notifyListeners();
    try {
      await Process.start(
        _downloadedSetupPath,
        ['/SILENT'],
        mode: ProcessStartMode.detached,
      );
    } catch (_) {
      try {
        await Process.start(
          _downloadedSetupPath,
          [],
          mode: ProcessStartMode.detached,
          runInShell: true,
        );
      } catch (_) {
        _updateStatusMessage =
            'The installer could not be started. The Setup file is at: $_downloadedSetupPath';
        notifyListeners();
        return;
      }
    }
    await Future.delayed(const Duration(milliseconds: 1500));
    exit(0);
  }

  Future<void> openSocial(String network) async {
    String url = '';
    switch (network) {
      case 'whatsapp':
        url = _settings.whatsAppLink;
        break;
      case 'chat':
        url = _settings.chatLink;
        break;
      case 'support':
        url = _settings.supportLink;
        break;
    }
    if (url.isNotEmpty && url.startsWith('http')) {
      await AutomationBridge.instance.openUrl(url);
    }
  }
}
