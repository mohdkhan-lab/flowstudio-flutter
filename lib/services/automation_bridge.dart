import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import '../models/activity_log.dart';
import '../models/account.dart';

class AutomationBridge {
  static const int port = 48190;
  static const String baseUrl = 'http://127.0.0.1:$port';
  
  static AutomationBridge? _instance;
  static AutomationBridge get instance => _instance ??= AutomationBridge._();

  Process? _nodeProcess;
  bool _isConnecting = false;
  StreamSubscription? _sseSubscription;

  // Callbacks
  Function(String message, LogLevel level)? onLog;
  Function(GoogleAccount account)? onAccountUpdated;
  Function(Map<String, dynamic> data)? onProgress;
  Function(Map<String, dynamic> data)? onVideoCompleted;

  AutomationBridge._();

  /// Starts the Node.js bridge server if not already running, and connects to SSE stream
  Future<void> ensureEngineRunning() async {
    if (await checkHealth()) {
      _listenToSse();
      return;
    }
    if (_isConnecting) {
      for (int i = 0; i < 20; i++) {
        await Future.delayed(const Duration(milliseconds: 250));
        if (await checkHealth()) {
          _listenToSse();
          return;
        }
      }
    }
    _isConnecting = true;

    try {
      if (await checkHealth()) {
        _listenToSse();
        return;
      }

      final exeFile = File(Platform.resolvedExecutable);
      final exeDir = exeFile.parent.path;

      // 1. Locate workDir where engine_bridge.js lives
      String workDir = exeDir;
      if (!File(p.join(workDir, 'engine_bridge.js')).existsSync()) {
        if (File(p.join(Directory.current.path, 'engine_bridge.js')).existsSync()) {
          workDir = Directory.current.path;
        }
      }

      // 2. Locate node.exe
      String nodeCmd = 'node';
      bool useShell = true;
      final candidateNodes = [
        p.join(exeDir, 'node.exe'),
        p.join(workDir, 'node.exe'),
        r'C:\Program Files\nodejs\node.exe',
        r'C:\Program Files (x86)\nodejs\node.exe',
      ];
      for (final n in candidateNodes) {
        if (File(n).existsSync()) {
          nodeCmd = n;
          useShell = false; // direct executable, avoids cmd.exe quoting bugs with spaces
          break;
        }
      }

      debugPrint('[AutomationBridge] Spawning engine: $nodeCmd in $workDir (useShell: $useShell)');

      _nodeProcess = await Process.start(
        nodeCmd,
        ['engine_bridge.js'],
        workingDirectory: workDir,
        runInShell: useShell,
        mode: ProcessStartMode.normal,
      );

      _nodeProcess?.stdout.transform(utf8.decoder).listen((data) {
        debugPrint('[Node Engine] $data');
      });
      _nodeProcess?.stderr.transform(utf8.decoder).listen((err) {
        debugPrint('[Node Engine ERR] $err');
      });

      // Wait up to 10 seconds for it to start
      for (int i = 0; i < 25; i++) {
        await Future.delayed(const Duration(milliseconds: 400));
        if (await checkHealth()) break;
      }

      _listenToSse();
    } catch (e) {
      debugPrint('[AutomationBridge] Init error: $e');
    } finally {
      _isConnecting = false;
    }
  }

  Future<bool> checkHealth() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/status')).timeout(const Duration(seconds: 1));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Maps one raw account JSON object from the engine to a GoogleAccount,
  /// preserving the REAL status and credits the engine reported.
  /// (v2.22.0 fix: the old code forced every account to status=ready and
  /// invented 50 credits whenever the real value was missing.)
  static GoogleAccount accountFromJson(Map<String, dynamic> a) {
    final statusStr = (a['status']?.toString() ?? '').toLowerCase();
    AccountStatus status;
    if (statusStr.contains('login')) {
      status = AccountStatus.loginRequired;
    } else if (statusStr.contains('check')) {
      status = AccountStatus.checking;
    } else if (statusStr.contains('fail') ||
        statusStr.contains('error') ||
        statusStr.contains('dead') ||
        statusStr.contains('dbcs') ||
        statusStr.contains('dbcs'.toLowerCase())) {
      status = AccountStatus.error;
    } else {
      status = AccountStatus.ready;
    }
    final cr = a['credits'];
    return GoogleAccount(
      id: a['id']?.toString() ?? '',
      name: a['name']?.toString() ?? 'Google Account',
      email: a['email']?.toString() ?? '',
      credits: cr is num ? cr.toInt() : 0,
      status: status,
      isChecked: a['selected'] == true || a['selected'] == 1,
      reason: a['status']?.toString(),
    );
  }

  void _listenToSse() {
    _sseSubscription?.cancel();

    final client = http.Client();
    final request = http.Request('GET', Uri.parse('$baseUrl/events'));

    client.send(request).then((response) {
      var currentEvent = '';
      _sseSubscription = response.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen((line) {
        // SSE frames are "event: <name>" followed by "data: <json>".
        // v2.22.0 fix: route by the event name — the old parser ignored the
        // event name entirely, so progress and video-completed events from
        // the engine never reached the UI at all.
        if (line.startsWith('event: ')) {
          currentEvent = line.substring(7).trim();
          return;
        }
        if (line.startsWith('data: ')) {
          try {
            final jsonStr = line.substring(6);
            final data = json.decode(jsonStr) as Map<String, dynamic>;

            switch (currentEvent) {
              case 'video-completed':
                onVideoCompleted?.call(data);
                break;
              case 'automation-progress':
                onProgress?.call(data);
                break;
              case 'account-updated':
                if (data['account'] is Map) {
                  onAccountUpdated?.call(
                    accountFromJson(
                      Map<String, dynamic>.from(data['account'] as Map),
                    ),
                  );
                }
                break;
              default:
                // 'automation-log' and any unnamed frame carrying a message
                if (data.containsKey('message')) {
                  final levelStr = data['level'] as String? ?? 'info';
                  final level = switch (levelStr) {
                    'success' => LogLevel.success,
                    'warn' => LogLevel.warning,
                    'warning' => LogLevel.warning,
                    'error' => LogLevel.error,
                    _ => LogLevel.info,
                  };
                  onLog?.call(data['message'].toString(), level);
                }
                if (data['account'] is Map) {
                  onAccountUpdated?.call(
                    accountFromJson(
                      Map<String, dynamic>.from(data['account'] as Map),
                    ),
                  );
                }
            }
          } catch (e) {
            debugPrint('[SSE Parse Error] $e');
          }
        }
      }, onError: (err) {
        debugPrint('[SSE Stream Error] $err');
      });
    }).catchError((err) {
      debugPrint('[SSE Connection Error] $err');
    });
  }

  Future<List<GoogleAccount>> getAccounts() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/accounts'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true && data['accounts'] is List) {
          return (data['accounts'] as List)
              .map((a) => accountFromJson(Map<String, dynamic>.from(a as Map)))
              .toList();
        }
      }
    } catch (e) {
      debugPrint('[getAccounts Error] $e');
    }
    return [];
  }

  Future<List<Map<String, dynamic>>> getInstalledChromeProfiles() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/chrome-profiles'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true && data['profiles'] is List) {
          return List<Map<String, dynamic>>.from(data['profiles']);
        }
      }
    } catch (e) {
      debugPrint('[getInstalledChromeProfiles Error] $e');
    }
    return [];
  }

  Future<bool> importChromeProfile(String dirName) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/chrome-profiles/import'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'dirName': dirName}),
      );
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('[importChromeProfile Error] $e');
      return false;
    }
  }

  Future<bool> addAccount(String name, String email) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/accounts/add'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'name': name, 'email': email}),
      );
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('[addAccount Error] $e');
      return false;
    }
  }

  Future<bool> deleteAccount(String id) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/accounts/delete'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'id': id}),
      );
      return res.statusCode == 200;
    } catch (e) {
      return false;
    }
  }

  Future<void> syncAllAccounts() async {
    try {
      await http.post(Uri.parse('$baseUrl/api/accounts/sync-all'));
    } catch (e) {
      debugPrint('[syncAllAccounts Error] $e');
    }
  }

  Future<Map<String, dynamic>> importAccountFromCookieFile(String filePath, {String? label}) async {
    await ensureEngineRunning();
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/cookies/import-file'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'filePath': filePath, 'label': label}),
      );
      final data = json.decode(res.body);
      if (res.statusCode == 200 && data['ok'] == true) {
        return {'ok': true, 'account': data['account'], 'message': data['message'], 'duplicate': data['duplicate'] == true};
      }
      return {'ok': false, 'error': data['error'] ?? 'Cookie import failed'};
    } catch (e) {
      debugPrint('[importAccountFromCookieFile Error] $e');
      return {'ok': false, 'error': e.toString()};
    }
  }

  Future<Map<String, dynamic>> importAccountFromCookieText(String label, String text) async {
    await ensureEngineRunning();
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/cookies/import-text'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'label': label, 'text': text}),
      );
      final data = json.decode(res.body);
      if (res.statusCode == 200 && data['ok'] == true) {
        return {'ok': true, 'account': data['account'], 'message': data['message'], 'duplicate': data['duplicate'] == true};
      }
      return {'ok': false, 'error': data['error'] ?? 'Cookie import failed'};
    } catch (e) {
      debugPrint('[importAccountFromCookieText Error] $e');
      return {'ok': false, 'error': e.toString()};
    }
  }

  Future<bool> deleteSelectedAccounts(List<String> ids) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/accounts/delete-selected'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'ids': ids}),
      );
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('[deleteSelectedAccounts Error] $e');
      return false;
    }
  }

  Future<bool> syncSelectedAccounts(List<String> ids) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/accounts/sync-selected'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'ids': ids}),
      );
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('[syncSelectedAccounts Error] $e');
      return false;
    }
  }

  Future<bool> openChromeForAccount(String id) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/accounts/open-chrome'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'id': id}),
      );
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('[openChromeForAccount Error] $e');
      return false;
    }
  }

  Future<Map<String, dynamic>?> loadSettings() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/settings'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true && data['settings'] is Map) {
          return Map<String, dynamic>.from(data['settings']);
        }
      }
    } catch (e) {
      debugPrint('[loadSettings Error] $e');
    }
    return null;
  }

  Future<bool> saveSetting(String key, dynamic value) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/settings'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'key': key, 'value': value}),
      );
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('[saveSetting Error] $e');
      return false;
    }
  }

  Future<Map<String, dynamic>> getStats() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/stats'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true) {
          return data;
        }
      }
    } catch (e) {
      debugPrint('[getStats Error] $e');
    }
    return {'stats': {'total': 0}, 'accountCount': 0};
  }

  Future<void> openUrl(String targetUrl) async {
    try {
      await http.post(
        Uri.parse('$baseUrl/api/open-url'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'url': targetUrl}),
      );
    } catch (_) {
      try {
        await Process.run('cmd', ['/c', 'start', '', targetUrl]);
      } catch (err) {
        debugPrint('[openUrl Error] $err');
      }
    }
  }

  Future<bool> startGeneration({
    required List<String> prompts,
    required String downloadFolder,
    required int parallelBrowsers,
    required String duration,
    required String aspectRatio,
    required String quality,
    String tag = '',
  }) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/generation/start'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({
          'prompts': prompts,
          'downloadFolder': downloadFolder,
          'parallelBrowsers': parallelBrowsers,
          'duration': duration,
          'aspectRatio': aspectRatio,
          'quality': quality,
          'tag': tag,
        }),
      );
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('[startGeneration Error] $e');
      return false;
    }
  }

  Future<void> pauseGeneration() async {
    try {
      await http.post(Uri.parse('$baseUrl/api/generation/pause'));
    } catch (_) {}
  }

  Future<void> resumeGeneration() async {
    try {
      await http.post(Uri.parse('$baseUrl/api/generation/resume'));
    } catch (_) {}
  }

  Future<void> stopGeneration() async {
    try {
      await http.post(Uri.parse('$baseUrl/api/generation/stop'));
    } catch (_) {}
  }

  void dispose() {
    _sseSubscription?.cancel();
    _nodeProcess?.kill();
  }
}

