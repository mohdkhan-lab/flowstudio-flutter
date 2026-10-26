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
  // v2.29.0: log frames carry a DETAIL flag (Simple/Details split) —
  // detail lines are hidden by the Activity "Simple" view.
  Function(String message, LogLevel level, bool isDetail)? onLog;
  Function(GoogleAccount account)? onAccountUpdated;
  Function(Map<String, dynamic> data)? onProgress;
  Function(Map<String, dynamic> data)? onVideoCompleted;
  // v2.30.1: per-task engine updates (WorkerPool.onTaskUpdate),
  // forwarded by the bridge as 'task-updated' SSE events.
  Function(Map<String, dynamic> data)? onTaskUpdated;
  // v2.30.3: live render progress (tile percentage + elapsed),
  // forwarded by the bridge as 'video-progress' SSE events. The
  // generator provider shows the real percentage and uses these
  // events as the run's heartbeat for its no-response watchdog.
  Function(Map<String, dynamic> data)? onVideoProgress;
  // v2.25.0 (parked browser): [{ 'id': ..., 'windowShown': bool }] for
  // every account with a live generation browser right now.
  Function(List<Map<String, dynamic>> accounts)? onActiveBrowsers;
  // v2.31.4: Muse asked (through the MCP connector) for the app to
  // update itself. The bridge broadcasts 'mcp-update-request' after
  // its own guards pass; the settings provider consumes it by
  // running its existing in-app updater end to end.
  Function(Map<String, dynamic> data)? onMcpUpdateRequest;
  // v2.32.2: Muse asked (through the MCP connector) for a run to
  // start FROM this app's own screen. The bridge broadcasts
  // 'mcp-ui-generate-request' ({prompts, tag}) after its guards
  // pass; the main screen consumes it by filling the Prompts box
  // and invoking the same Generate handler the button invokes.
  Function(Map<String, dynamic> data)? onMcpUiGenerateRequest;

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
      // v2.29.0: source hints for the alias store (see account.dart).
      hasCookies: a['hasCookies'] == true,
      chromeProfileDir: a['chromeProfileDir']?.toString() ?? '',
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
              case 'task-updated':
                onTaskUpdated?.call(data);
                break;
              case 'video-progress':
                onVideoProgress?.call(data);
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
              case 'mcp-update-request':
                // v2.31.4: hand the update request to the settings
                // provider, which runs its own updater flow.
                onMcpUpdateRequest?.call(data);
                break;
              case 'mcp-ui-generate-request':
                // v2.32.2: hand the in-app generate request to the
                // main screen, which fills the Prompts box and runs
                // its own Generate flow.
                onMcpUiGenerateRequest?.call(data);
                break;
              case 'active-browsers':
                // v2.25.0 (parked browser): which accounts are
                // generating right now, and whether each working
                // browser is on screen or parked off-screen.
                if (data['accounts'] is List) {
                  onActiveBrowsers?.call(
                    (data['accounts'] as List)
                        .whereType<Map>()
                        .map((a) => Map<String, dynamic>.from(a))
                        .toList(),
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
                  // v2.28.0 (defensive): if a frame ever carries the
                  // log object itself, show its message text — never
                  // the raw Map dump.
                  final rawMessage = data['message'];
                  final messageText = rawMessage is Map
                      ? (rawMessage['message']?.toString() ??
                          rawMessage.toString())
                      : rawMessage.toString();
                  // v2.29.0: the bridge marks WorkerPool lines as
                  // detail (milestones/errors stay simple); frames
                  // without the flag are simple lines.
                  onLog?.call(messageText, level, data['detail'] == true);
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
        _scheduleSseReconnect();
      }, onDone: () {
        // v2.30.3: a dropped SSE stream used to deafen the app for
        // the rest of the session — every later engine event was
        // silently lost. Resubscribe instead.
        _scheduleSseReconnect();
      });
    }).catchError((err) {
      debugPrint('[SSE Connection Error] $err');
      _scheduleSseReconnect();
    });
  }

  bool _disposed = false;
  bool _sseReconnectPending = false;

  /// v2.30.3: re-join the event stream a few seconds after it
  /// drops (engine restart, transient socket error). Guarded so an
  /// error+done pair schedules only one reconnect, and a disposed
  /// bridge never resurrects its stream.
  void _scheduleSseReconnect() {
    if (_disposed || _sseReconnectPending) return;
    _sseReconnectPending = true;
    Future.delayed(const Duration(seconds: 3), () {
      _sseReconnectPending = false;
      if (_disposed) return;
      _listenToSse();
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

  /// v2.29.0 (direct Gmail login): creates the account through the
  /// engine's login route and immediately opens the real Google
  /// sign-in window — no name/email/credits form anywhere. Returns
  /// the created account (real details arrive later via
  /// account-updated events, after the owner signs in).
  /// The old addAccount(name, email) bridge call died with the
  /// manual-add form it served.
  Future<GoogleAccount?> startGmailLogin() async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/accounts/start-login'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({}),
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true && data['account'] is Map) {
          return accountFromJson(Map<String, dynamic>.from(data['account'] as Map));
        }
      }
    } catch (e) {
      debugPrint('[startGmailLogin Error] $e');
    }
    return null;
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

  /// v2.30.2 (bulk cookie add): [deferVerify] asks the bridge to
  /// ADD the account without verifying it — the check runs in
  /// phase 2 via checkCookieAccounts() once every add is in. A
  /// deferred duplicate comes back with 'needsCheck' (the existing
  /// account joins the phase-2 list instead of being re-checked
  /// inside the add).
  Future<Map<String, dynamic>> importAccountFromCookieFile(String filePath, {String? label, bool deferVerify = false}) async {
    await ensureEngineRunning();
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/cookies/import-file'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'filePath': filePath, 'label': label, 'deferVerify': deferVerify}),
      );
      final data = json.decode(res.body);
      if (res.statusCode == 200 && data['ok'] == true) {
        return {
          'ok': true,
          'account': data['account'],
          'message': data['message'],
          'duplicate': data['duplicate'] == true,
          'deferred': data['deferred'] == true,
          'needsCheck': data['needsCheck'] == true,
        };
      }
      return {'ok': false, 'error': data['error'] ?? 'Cookie import failed'};
    } catch (e) {
      debugPrint('[importAccountFromCookieFile Error] $e');
      return {'ok': false, 'error': e.toString()};
    }
  }

  Future<Map<String, dynamic>> importAccountFromCookieText(String label, String text, {bool deferVerify = false}) async {
    await ensureEngineRunning();
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/cookies/import-text'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'label': label, 'text': text, 'deferVerify': deferVerify}),
      );
      final data = json.decode(res.body);
      if (res.statusCode == 200 && data['ok'] == true) {
        return {
          'ok': true,
          'account': data['account'],
          'message': data['message'],
          'duplicate': data['duplicate'] == true,
          'deferred': data['deferred'] == true,
          'needsCheck': data['needsCheck'] == true,
        };
      }
      return {'ok': false, 'error': data['error'] ?? 'Cookie import failed'};
    } catch (e) {
      debugPrint('[importAccountFromCookieText Error] $e');
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// v2.30.2 (bulk cookie add — phase 2): run the deferred checks
  /// for a batch of account ids. The bridge drives each account's
  /// check in order; every state change arrives live through the
  /// account-updated events, so each sidebar line flips
  /// Waiting → Checking… → Live/Fail as its own result lands. The
  /// call returns when the LAST check has finished (same shape as
  /// syncSelectedAccounts' await-the-whole-sync call).
  Future<bool> checkCookieAccounts(List<String> ids) async {
    if (ids.isEmpty) return true;
    try {
      // v2.30.3: this call used to have NO timeout — if it hung,
      // the accounts provider's phase-2 cleanup never ran and the
      // affected lines stayed on "Waiting" for the life of the
      // process. The timeout is a hang-breaker only: the engine
      // checks accounts sequentially with its own per-check bound,
      // so a healthy batch finishes long before this.
      final res = await http
          .post(
            Uri.parse('$baseUrl/api/cookies/check'),
            headers: {'Content-Type': 'application/json'},
            body: json.encode({'ids': ids}),
          )
          .timeout(const Duration(seconds: 900));
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('[checkCookieAccounts Error] $e');
      return false;
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

  /// v2.25.0 (parked browser): the accounts with a live generation
  /// browser right now — [{ 'id': ..., 'windowShown': bool }].
  Future<List<Map<String, dynamic>>> getActiveBrowsers() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/generation/active-browsers'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true && data['accounts'] is List) {
          return (data['accounts'] as List)
              .whereType<Map>()
              .map((a) => Map<String, dynamic>.from(a))
              .toList();
        }
      }
    } catch (e) {
      debugPrint('[getActiveBrowsers Error] $e');
    }
    return [];
  }

  /// v2.25.0 (parked browser): flip a GENERATING account's working
  /// browser between the screen and its off-screen park. Returns the
  /// new windowShown state, or null when the toggle did not happen
  /// (e.g. the account is not generating). Generation is never
  /// interrupted by this — only the window's position changes.
  Future<bool?> toggleAccountBrowser(String id) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/accounts/toggle-browser'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'id': id}),
      );
      final data = json.decode(res.body);
      if (res.statusCode == 200 && data['ok'] == true) {
        return data['windowShown'] == true;
      }
    } catch (e) {
      debugPrint('[toggleAccountBrowser Error] $e');
    }
    return null;
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
    // v2.33.0: prompts ride in the engine's canonical object form
    // {text, index, tag} — each item's own label as its tag and its
    // fixed 0-based slot — so the engine queues exactly the items
    // the app counted, bound to their identities.
    required List<Map<String, dynamic>> prompts,
    required String downloadFolder,
    required int parallelBrowsers,
    required String duration,
    required String aspectRatio,
    required String quality,
    String tag = '',
    // v2.29.0: the sidebar's TICKED account IDs (checkbox truth), the
    // selected model, and the file-naming pattern — all three used to
    // be dropped here, so the engine never saw them.
    List<String>? accountIds,
    String? model,
    String? namingPattern,
    // v2.33.0: the optional project name — when non-empty the run's
    // downloads land in a subfolder of the output folder named for
    // the project.
    String project = '',
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
          'accountIds': accountIds,
          'model': model,
          'namingPattern': namingPattern,
          'project': project,
        }),
      );
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('[startGeneration Error] $e');
      return false;
    }
  }

  /// v2.33.0 (missing-scene redo): ask the engine to make ONLY the
  /// scenes the last run is missing, into the same (project) folder.
  /// Returns the bridge's decoded answer: {ok, started, missing} on
  /// a started redo, {ok, started: false, missing: 0, message} when
  /// nothing is missing, {ok: false, error} otherwise.
  Future<Map<String, dynamic>> redoMissing({
    List<String>? accountIds,
    int? parallelBrowsers,
  }) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/generation/redo-missing'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({
          'accountIds': accountIds,
          'parallelBrowsers': parallelBrowsers,
        }),
      );
      final data = json.decode(res.body);
      if (data is Map) return Map<String, dynamic>.from(data);
    } catch (e) {
      debugPrint('[redoMissing Error] $e');
    }
    return {'ok': false, 'error': 'the engine did not respond.'};
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

  /// v2.27.0 (History view): the real video files in the engine's
  /// configured output folder — [{name, size, mtime}] newest first.
  Future<List<Map<String, dynamic>>> getOutputFiles() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/output-files'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true && data['files'] is List) {
          return (data['files'] as List)
              .whereType<Map>()
              .map((f) => Map<String, dynamic>.from(f))
              .toList();
        }
      }
    } catch (e) {
      debugPrint('[getOutputFiles Error] $e');
    }
    return [];
  }

  /// v2.27.0 (History view): open one output file with the OS default
  /// player. The engine confines this to the output folder by name.
  Future<bool> openOutputFile(String name) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/open-file'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'name': name}),
      );
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('[openOutputFile Error] $e');
      return false;
    }
  }

  /// v2.29.0 (in-app player): resolve one output file's absolute
  /// path (bridge-confined to the output folder, bare name only) so
  /// the app can play it inside FlowStudio.
  Future<String?> getOutputFilePath(String name) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/output-file-path'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'name': name}),
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true) return data['path']?.toString();
      }
    } catch (e) {
      debugPrint('[getOutputFilePath Error] $e');
    }
    return null;
  }

  /// v2.27.0: open the configured output folder in Explorer.
  Future<bool> openOutputFolder() async {
    try {
      final res = await http.post(Uri.parse('$baseUrl/api/open-output-folder'));
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('[openOutputFolder Error] $e');
      return false;
    }
  }

  // --- v2.31.0: MCP connector (Settings → Muse AI — MCP) ---

  /// Current MCP connector state from the bridge: enabled, running,
  /// port, connection URL, masked token, last connection, tool names.
  Future<Map<String, dynamic>?> getMcpStatus() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/mcp/status'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true && data['mcp'] is Map) {
          return Map<String, dynamic>.from(data['mcp'] as Map);
        }
      }
    } catch (e) {
      debugPrint('[getMcpStatus Error] $e');
    }
    return null;
  }

  Future<Map<String, dynamic>?> setMcpEnabled(bool enabled) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/mcp/enable'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'enabled': enabled}),
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true && data['mcp'] is Map) {
          return Map<String, dynamic>.from(data['mcp'] as Map);
        }
      }
    } catch (e) {
      debugPrint('[setMcpEnabled Error] $e');
    }
    return null;
  }

  Future<Map<String, dynamic>?> regenerateMcpToken() async {
    try {
      final res = await http.post(Uri.parse('$baseUrl/api/mcp/regenerate-token'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true && data['mcp'] is Map) {
          return Map<String, dynamic>.from(data['mcp'] as Map);
        }
      }
    } catch (e) {
      debugPrint('[regenerateMcpToken Error] $e');
    }
    return null;
  }

  /// The full ready-to-paste Muse config JSON (contains the access
  /// token — it comes from the bridge on this PC only, for the
  /// Settings "Copy Muse Config" button).
  Future<String?> getMcpConfigJson() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/mcp/config'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['ok'] == true && data['config'] != null) {
          return const JsonEncoder.withIndent('  ').convert(data['config']);
        }
      }
    } catch (e) {
      debugPrint('[getMcpConfigJson Error] $e');
    }
    return null;
  }

  /// v2.31.1: The raw MCP access token only (Settings "Copy Token"
  /// button). Read from the same localhost-only bridge endpoint as
  /// the config JSON — the token never leaves the owner's PC except
  /// into the owner's own clipboard.
  Future<String?> getMcpToken() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/mcp/config'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        final auth = data['config']?['mcpServers']?['flowstudio']?['headers']?['Authorization']?.toString() ?? '';
        if (auth.startsWith('Bearer ') && auth.length > 7) {
          return auth.substring(7);
        }
      }
    } catch (e) {
      debugPrint('[getMcpToken Error] $e');
    }
    return null;
  }

  void dispose() {
    _disposed = true;
    _sseSubscription?.cancel();
    _nodeProcess?.kill();
  }
}

