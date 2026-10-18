import 'dart:convert';
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

  String get currentView => _currentView;
  AppSettings get settings => _settings;
  bool get isCheckingUpdates => _isCheckingUpdates;
  String get updateStatusMessage => _updateStatusMessage;
  int get totalVideosSaved => _totalVideosSaved;
  int get totalAccounts => _totalAccounts;

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

  Future<void> checkForUpdates() async {
    // v2.22.0 fix: REAL update check against the GitHub releases of the
    // Flutter app. The old code waited 2 seconds and always claimed
    // "You are on the latest version" without checking anything.
    _isCheckingUpdates = true;
    _updateStatusMessage = 'Checking the official GitHub release page...';
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
        final tag = (data['tag_name']?.toString() ?? '').replaceFirst('v', '');
        final current = _settings.currentVersion.replaceFirst('v', '');
        if (tag.isNotEmpty && tag != current) {
          _updateStatusMessage =
              'Update available: v$tag — download the new Setup from the GitHub releases page.';
        } else {
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
