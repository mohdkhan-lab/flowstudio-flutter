import 'dart:async';
import 'package:flutter/material.dart';
import '../models/prompt_item.dart';
import '../models/activity_log.dart';
import '../services/automation_bridge.dart';
import '../services/prompt_parser.dart';
import 'accounts_provider.dart';
import 'activity_provider.dart';
import 'settings_provider.dart';

enum GenerationState {
  idle,
  running,
  paused,
}

class GeneratorProvider with ChangeNotifier {
  String _promptsRawText = '';
  List<PromptItem> _items = [];
  GenerationState _state = GenerationState.idle;
  int _currentIndex = 0;
  // v2.30.3 (phantom progress fix): true only once a run has
  // actually been started for the CURRENT item set. The Progress
  // panel renders run cards only while this is set — prompts that
  // were merely typed show the panel's empty state, never QUEUED
  // "waiting for account" cards. Any edit re-parses the items and
  // resets this, returning the panel to its pre-run display.
  bool _runStarted = false;
  // v2.30.3 (run heartbeat watchdog): the engine streams events
  // (progress / task updates / completions) throughout a healthy
  // run. If a run hears NOTHING for over 10 minutes, the engine
  // or the event stream is dead — the run is settled with that
  // concrete reason instead of the cards spinning forever.
  Timer? _runWatchdog;
  DateTime? _lastEngineEventAt;
  static const Duration _engineSilenceLimit = Duration(minutes: 10);
  // v2.27.0: the TAG chosen in the Prompts header lives here so the
  // Progress cards can name queued files like the design ("#<tag>-<nn>.mp4").
  String _selectedTag = 'None';
  // v2.33.0: the optional PROJECT name from the Prompts header. When
  // set, the run's downloads land in a subfolder of the output
  // folder named for the project; empty = today's flat behaviour.
  // It is a property of the RUN, not of the prompt text — editing
  // prompts never clears it.
  String _projectName = '';
  // v2.27.0: real completion times of THIS session, for the Activity
  // stats line ("Today: M videos · Spent today: C credits").
  final List<DateTime> _completionTimes = [];
  // v2.29.0: the engine's REAL credits-spent-today (usage stats),
  // refreshed at start and on every completion. Null until the
  // engine answers — the Activity line must not invent a figure.
  int? _engineSpentToday;
  // v2.29.0 (prompt modes): the Bulk/Agent Prompt toggle is REAL
  // now. Bulk = prompts are BLOCKS separated by blank lines (lines
  // inside a block belong to one prompt). Agent = the entire text
  // is ONE prompt, no splitting.
  bool _isBulkMode = true;

  GeneratorProvider() {
    _refreshEngineStats();
    // v2.22.0 fix: the engine's video-completed payload carries
    // {id, prompt, accountName, status, filePath, error} — there is NO
    // promptIndex field. Match the finished video to its prompt item by
    // promptIndex when present, else by exact prompt text, else by the
    // first item still generating.
    AutomationBridge.instance.onVideoCompleted = (data) {
      _stampEngineEvent();
      final item = _matchCompletedItem(data);
      if (item == null) return;
      final err = data['error']?.toString();
      final statusStr = data['status']?.toString() ?? '';
      final failed = (err != null && err.isNotEmpty) ||
          statusStr.toLowerCase().startsWith('violation') ||
          statusStr.toLowerCase().contains('fail');
      // v2.27.0: keep the real account + file name for the Progress cards.
      final accName = data['accountName']?.toString();
      if (accName != null && accName.isNotEmpty) item.accountName = accName;
      final fileName = data['fileName']?.toString();
      if (fileName != null && fileName.isNotEmpty) item.outputFileName = fileName;
      // v2.29.0: the run's real per-video credit cost rides the
      // completion payload (WorkerPool) — the Progress card shows
      // this instead of the old hardcoded "7 credits".
      final creditsRaw = data['creditsUsed'];
      if (creditsRaw is num) item.creditsUsed = creditsRaw.toInt();
      if (failed) {
        item.status = PromptStatus.failed;
        item.error = err ?? statusStr;
      } else {
        item.status = PromptStatus.completed;
        item.progress = 1.0;
        item.localFilePath = data['filePath']?.toString();
        _completionTimes.add(DateTime.now());
        _refreshEngineStats();
      }
      notifyListeners();
    };
    AutomationBridge.instance.onProgress = (data) {
      _stampEngineEvent();
      final statusStr = data['status']?.toString() ?? '';
      // v2.30.1 (terminal settling): the engine's terminal progress
      // statuses are 'Completed', 'NoAccounts', 'Stopped' and
      // 'Error: <reason>'. v2.30.0 idled only on Completed/NoAccounts
      // AND only when every item was already completed/failed — but
      // in the no-eligible-account path the items sit in `generating`
      // (their per-task failure updates never reached the app), so
      // the guard never passed and the UI stayed on "Running..."
      // forever (owner's v2.30.0 field test, 2026-10-25). Now ANY
      // terminal status settles the run: every item that never
      // finished is failed with the concrete reason, then idle.
      // 'Completed' with all items done settles nothing and idles,
      // exactly as before.
      if (statusStr == 'Completed' ||
          statusStr == 'NoAccounts' ||
          statusStr == 'Stopped' ||
          statusStr.startsWith('Error:')) {
        final reason = statusStr.startsWith('Error:')
            ? statusStr.substring('Error:'.length).trim()
            : statusStr == 'NoAccounts'
                ? 'No account was available — no Live account with enough credits was found for this prompt.'
                : statusStr == 'Stopped'
                    ? 'Stopped by user'
                    : 'Run ended before this prompt finished';
        _settleRun(reason);
      }
    };
    // v2.30.1: the engine's per-task updates (WorkerPool.onTaskUpdate)
    // reach the app as 'task-updated' SSE events — until now the
    // bridge never wired that callback, so every per-task failure,
    // with its concrete reason, was silently dropped and the card
    // span as RENDERING until the queue ended. Consume the two
    // updates that change what a card shows mid-run: 'generating'
    // (the real account name) and 'failed' (final for that task —
    // a failover re-emits 'pending' instead, which the app ignores
    // on purpose: it models engine-queued as generating). 'done' is
    // already covered by the video-completed event.
    AutomationBridge.instance.onTaskUpdated = (data) {
      _stampEngineEvent();
      final item = _matchTaskItem(data);
      if (item == null) return;
      final statusStr = data['status']?.toString() ?? '';
      if (statusStr == 'done') {
        // v2.30.3: 'done' used to be ignored on the assumption that
        // video-completed always covers it — false on two paths:
        // restart-recovery completions emit ONLY this update, and a
        // download-retry success (after the card was already marked
        // failed by the 'Download failed' completion event) had no
        // signal that could flip the card back. A 'done' update is
        // final: the file exists, so complete the card with it.
        if (item.status != PromptStatus.completed) {
          item.status = PromptStatus.completed;
          item.progress = 1.0;
          item.error = null;
          final fp = data['filePath']?.toString();
          if (fp != null && fp.isNotEmpty) item.localFilePath = fp;
          final fn = data['fileName']?.toString();
          if (fn != null && fn.isNotEmpty) item.outputFileName = fn;
          final accName = data['accountName']?.toString();
          if (accName != null && accName.isNotEmpty) item.accountName = accName;
          _completionTimes.add(DateTime.now());
          _refreshEngineStats();
          notifyListeners();
        }
      } else if (statusStr == 'generating') {
        final accName = data['accountName']?.toString();
        if (accName != null && accName.isNotEmpty) {
          item.accountName = accName;
        }
        if (item.status == PromptStatus.pending ||
            item.status == PromptStatus.queued) {
          item.status = PromptStatus.generating;
        }
        notifyListeners();
      } else if (statusStr == 'failed') {
        // Only settle an item this run actually started — a stray
        // update for a never-started prompt must not fail its card.
        if (item.status == PromptStatus.generating ||
            item.status == PromptStatus.downloading) {
          item.status = PromptStatus.failed;
          item.error = data['reason']?.toString() ?? 'Generation failed';
          notifyListeners();
        }
      }
    };
    // v2.30.3: live render progress from the engine (the bridge
    // forwards WorkerPool.onVideoProgress as 'video-progress').
    // Until now that callback was dropped at the bridge, so the
    // app never saw a percentage and item.progress stayed 0 — the
    // panel's percent branch was unreachable and every rendering
    // card could only say "Working…". These events also feed the
    // run heartbeat (a generating tile reports every few seconds).
    AutomationBridge.instance.onVideoProgress = (data) {
      _stampEngineEvent();
      final item = _matchTaskItem(data);
      if (item == null) return;
      var changed = false;
      final accName = data['accountName']?.toString();
      if (accName != null && accName.isNotEmpty && item.accountName != accName) {
        item.accountName = accName;
        changed = true;
      }
      final pctRaw = data['percentage']?.toString() ?? '';
      final pct = double.tryParse(pctRaw.replaceAll('%', '').trim());
      if (pct != null &&
          (item.status == PromptStatus.generating ||
              item.status == PromptStatus.downloading)) {
        final v = (pct / 100).clamp(0.0, 1.0);
        if (v != item.progress) {
          item.progress = v;
          changed = true;
        }
      }
      if (changed) notifyListeners();
    };
  }

  // v2.30.3: every engine event of any kind proves the run is
  // alive; the watchdog below only fires on TOTAL silence.
  void _stampEngineEvent() {
    _lastEngineEventAt = DateTime.now();
  }

  void _armRunWatchdog() {
    _runWatchdog?.cancel();
    _stampEngineEvent();
    _runWatchdog = Timer.periodic(const Duration(seconds: 30), (_) {
      if (_state != GenerationState.running) {
        _disarmRunWatchdog();
        return;
      }
      final last = _lastEngineEventAt;
      if (last != null && DateTime.now().difference(last) > _engineSilenceLimit) {
        _settleRun(
          'The engine stopped responding — no update arrived for over 10 minutes, so this run was ended here. Check the Activity log; press Generate to run the unfinished prompts again.',
        );
      }
    });
  }

  void _disarmRunWatchdog() {
    _runWatchdog?.cancel();
    _runWatchdog = null;
  }

  /// v2.30.1: match an engine task-update to its prompt item by
  /// promptIndex, else by exact prompt text. Unlike
  /// [_matchCompletedItem] there is deliberately NO "first generating"
  /// fallback — a task update that matches nothing changes nothing.
  ///
  /// v2.30.3 (index-base fix): engine promptIndex values are
  /// 0-based (DB queue_tasks.prompt_index), while PromptItem.index
  /// is 1-based. The old direct comparison never matched index 0
  /// and matched the WRONG card for every later prompt (an update
  /// for prompt #2 hit prompt #1's card whenever the text fallback
  /// was not reached first). Convert before comparing.
  PromptItem? _matchTaskItem(Map<String, dynamic> data) {
    final idxRaw = data['promptIndex'] ?? data['prompt_index'];
    if (idxRaw is int) {
      for (final i in _items) {
        if (i.index == idxRaw + 1) return i;
      }
    }
    final promptText = (data['promptText'] ?? data['prompt'])?.toString();
    if (promptText != null && promptText.isNotEmpty) {
      for (final i in _items) {
        if (i.text == promptText) return i;
      }
    }
    return null;
  }

  /// v2.30.1: end the run in the UI. Every item that never reached a
  /// final state is failed with [reason] (completed/failed items keep
  /// their real outcome), the run state goes idle, and the Progress
  /// header counts — which derive from item statuses — stop claiming
  /// anything is still rendering.
  void _settleRun(String reason) {
    _disarmRunWatchdog();
    for (final item in _items) {
      if (item.status == PromptStatus.pending ||
          item.status == PromptStatus.queued ||
          item.status == PromptStatus.generating ||
          item.status == PromptStatus.downloading) {
        item.status = PromptStatus.failed;
        item.error ??= reason;
      }
    }
    _state = GenerationState.idle;
    notifyListeners();
  }

  PromptItem? _matchCompletedItem(Map<String, dynamic> data) {
    final idxRaw = data['promptIndex'] ?? data['prompt_index'];
    if (idxRaw is int) {
      // v2.30.3: engine indices are 0-based, item indices 1-based
      // (see _matchTaskItem).
      for (final i in _items) {
        if (i.index == idxRaw + 1) return i;
      }
    }
    final promptText = data['prompt']?.toString();
    if (promptText != null && promptText.isNotEmpty) {
      for (final i in _items) {
        if (i.text == promptText) return i;
      }
    }
    for (final i in _items) {
      if (i.status == PromptStatus.generating ||
          i.status == PromptStatus.downloading) {
        return i;
      }
    }
    // v2.30.3: the last-resort "first item" fallback may only fire
    // while a run is actually live — a stray/late completion that
    // matches nothing must not settle a never-started item after
    // the run has ended or the text was edited.
    if (_state == GenerationState.running && _items.isNotEmpty) {
      return _items.first;
    }
    return null;
  }

  String get promptsRawText => _promptsRawText;
  List<PromptItem> get items => List.unmodifiable(_items);

  /// v2.30.3: whether a run has been started for the current item
  /// set (see _runStarted). The Progress panel shows run cards only
  /// when this is true.
  bool get runStarted => _runStarted;
  GenerationState get state => _state;
  bool get isRunning => _state == GenerationState.running;
  bool get isPaused => _state == GenerationState.paused;
  int get currentIndex => _currentIndex;

  int get totalPrompts => _items.length;
  int get completedCount => _items.where((i) => i.status == PromptStatus.completed).length;

  String get selectedTag => _selectedTag;

  void setSelectedTag(String tag) {
    if (_selectedTag == tag) return;
    _selectedTag = tag;
    notifyListeners();
  }

  String get projectName => _projectName;

  void setProjectName(String name) {
    if (_projectName == name) return;
    _projectName = name;
    notifyListeners();
  }

  /// v2.29.0: the engine's real credits-spent-today, or null while
  /// unknown (the Activity line shows the engine figure only).
  int? get engineSpentToday => _engineSpentToday;

  Future<void> _refreshEngineStats() async {
    try {
      final data = await AutomationBridge.instance.getStats();
      final stats = data['stats'];
      if (stats is Map && stats['creditsToday'] != null) {
        final v = int.tryParse(stats['creditsToday'].toString());
        if (v != null && v != _engineSpentToday) {
          _engineSpentToday = v;
          notifyListeners();
        }
      }
    } catch (_) {}
  }

  bool get isBulkMode => _isBulkMode;

  /// v2.29.0: switch the prompt parsing mode (Bulk blocks / Agent
  /// single) and re-count at once, so the count pill, the estimate
  /// and the generate request always agree with the selected mode.
  void setPromptMode(bool bulk) {
    if (_isBulkMode == bulk) return;
    _isBulkMode = bulk;
    _reparseItems();
    notifyListeners();
  }

  /// Videos completed today in this session (real engine completions
  /// only — see onVideoCompleted above).
  int get completedTodayCount {
    final now = DateTime.now();
    return _completionTimes
        .where((t) => t.year == now.year && t.month == now.month && t.day == now.day)
        .length;
  }

  void setRawText(String text) {
    _promptsRawText = text;
    _reparseItems();
    notifyListeners();
  }

  void appendPrompts(List<String> newPrompts) {
    // v2.29.0: imported prompts join with a BLANK line between
    // them — under the Bulk block rule each import stays its own
    // prompt (they used to merge into one block). SRT cues keep
    // their one-prompt-per-cue behaviour through the same path.
    final existing = _promptsRawText.trim();
    if (existing.isEmpty) {
      _promptsRawText = newPrompts.join('\n\n');
    } else {
      _promptsRawText = '$existing\n\n${newPrompts.join('\n\n')}';
    }
    _reparseItems();
    notifyListeners();
  }

  void clearPrompts() {
    _promptsRawText = '';
    _items.clear();
    _runStarted = false;
    _disarmRunWatchdog();
    _state = GenerationState.idle;
    notifyListeners();
  }

  void _reparseItems() {
    // v2.29.0 (prompt splitting fix): the old parser made EVERY
    // non-empty line its own prompt, so one multi-line episode
    // prompt was counted and queued as several fragments.
    // v2.33.0 (prompt syntax): Bulk mode now runs the full syntax
    // parser (lib/services/prompt_parser.dart — one spec with the
    // engine's engine/promptParser.js, pinned by the shared fixture
    // suite). Every label family the owner pastes (1. / (1) /
    // PROMPT_001: / Scene 1: / #00-01 / separators / JSON / YAML /
    // CSV / XML / Markdown headings) splits into its own item AND
    // keeps its label as the item's identity — the label rides to
    // the engine as the task tag, so the count shown here is exactly
    // what the engine queues and each file is named by its label.
    // Plain blank-line pastes parse exactly as before.
    // Agent mode: the entire text is still ONE prompt; its label
    // (first line) is still detected so its file is named by it.
    final normalized = _promptsRawText.replaceAll('\r\n', '\n').trim();
    final List<ParsedPrompt> parsed;
    if (normalized.isEmpty) {
      parsed = const [];
    } else if (!_isBulkMode) {
      parsed = [
        ParsedPrompt(PromptParser.extractLabel(normalized), normalized),
      ];
    } else {
      parsed = PromptParser.parse(_promptsRawText);
    }

    // v2.30.3: a fresh item set has had no run started for it —
    // the Progress panel returns to its pre-run (empty) display
    // until Generate is pressed for THIS set.
    _runStarted = false;
    _items = List.generate(
      parsed.length,
      (i) => PromptItem(
        index: i + 1,
        text: parsed[i].text,
        label: parsed[i].label,
        status: PromptStatus.pending,
      ),
    );
  }

  Future<void> startGeneration({
    required AccountsProvider accounts,
    required ActivityProvider activity,
    required SettingsProvider settings,
  }) async {
    // v2.30.3: re-entry guard. The Generate button stays enabled
    // while paused, and a second start used to re-submit EVERY
    // prompt (including finished ones) to the engine. A run must
    // be stopped (or settled) before another can start.
    if (_state != GenerationState.idle) {
      activity.addLog(
        'A run is already in progress — stop it before starting another.',
        level: LogLevel.warning,
      );
      return;
    }
    if (_items.isEmpty) {
      activity.addLog('No prompts found. Paste prompts or import TXT/SRT file.', level: LogLevel.warning);
      return;
    }

    // v2.29.0 (checkbox truth): generation runs ONLY on the
    // sidebar's ticked accounts — the IDs ride this request to the
    // engine, and the pool refuses every other account.
    final tickedIds = accounts.accounts
        .where((a) => a.isChecked)
        .map((a) => a.id)
        .toList();
    if (tickedIds.isEmpty) {
      activity.addLog(
        'No account is ticked in the sidebar — generation uses only ticked accounts. Tick at least one account, then press Generate again.',
        level: LogLevel.warning,
      );
      return;
    }

    _state = GenerationState.running;
    notifyListeners();

    activity.addLog(
      'Generation started: ${_items.length} prompt(s) • ${settings.settings.parallelBrowsers} worker(s) in parallel',
      level: LogLevel.info,
    );

    // Call real Node.js automation engine.
    // v2.29.0: the selected TAG, the model and the file-naming
    // pattern finally ride along — they used to be dropped here,
    // so saved files fell back to scene001-style names while the
    // UI promised tag names.
    // v2.33.0: each prompt now rides in the engine's canonical
    // object form {text, index, tag} — the item's OWN label is its
    // tag (the bridge falls back to the run's selected tag when an
    // item has none), and the index is the item's fixed slot, so
    // the engine queues exactly the items counted here, each bound
    // to its identity. The optional project name rides along too.
    final success = await AutomationBridge.instance.startGeneration(
      prompts: _items
          .map((i) => <String, dynamic>{
                'text': i.text,
                'index': i.index - 1,
                'tag': i.label ?? '',
              })
          .toList(),
      downloadFolder: settings.settings.outputDirectory,
      parallelBrowsers: settings.settings.parallelBrowsers,
      duration: settings.settings.duration,
      aspectRatio: settings.settings.aspectRatio,
      quality: settings.settings.quality,
      tag: _selectedTag == 'None' ? '' : _selectedTag,
      accountIds: tickedIds,
      model: settings.settings.model,
      namingPattern: settings.settings.namingPattern,
      project: _projectName.trim(),
    );

    if (!success) {
      // v2.22.0 fix: NO fake simulation. The old code silently ran a timer
      // that marked prompts "completed" and deducted credits without the
      // engine generating anything. If the engine does not answer, say so
      // honestly and stop — a video is only "completed" when the engine
      // reports a real downloaded file.
      _state = GenerationState.idle;
      activity.addLog(
        'Generation could NOT start — the automation engine did not respond. Nothing was generated. Make sure the engine is running, then press Generate again.',
        level: LogLevel.error,
      );
      notifyListeners();
      return;
    }

    // Mark the queued items as generating; real per-video completion
    // arrives through the engine's video-completed events.
    // v2.30.3: only NOW has a run actually been started for this
    // item set — the Progress panel may show its cards, and the
    // heartbeat watchdog starts watching for engine silence.
    _runStarted = true;
    _armRunWatchdog();
    for (final item in _items) {
      if (item.status == PromptStatus.pending) {
        item.status = PromptStatus.generating;
      }
    }
    notifyListeners();
  }

  void pauseGeneration(ActivityProvider activity) {
    // v2.30.3: only a running run can pause (this used to flip the
    // state even from idle). Pausing also suspends the heartbeat
    // watchdog — a paused run is SUPPOSED to be silent.
    if (_state != GenerationState.running) return;
    _disarmRunWatchdog();
    _state = GenerationState.paused;
    AutomationBridge.instance.pauseGeneration();
    activity.addLog('Generation paused by user.', level: LogLevel.warning);
    notifyListeners();
  }

  void resumeGeneration({
    required AccountsProvider accounts,
    required ActivityProvider activity,
    required SettingsProvider settings,
  }) {
    if (_state == GenerationState.paused) {
      _state = GenerationState.running;
      // v2.30.3: resume re-arms the heartbeat watchdog with a
      // fresh silence window.
      _armRunWatchdog();
      AutomationBridge.instance.resumeGeneration();
      activity.addLog('Generation resumed.', level: LogLevel.info);
      notifyListeners();
    }
  }

  void stopGeneration(ActivityProvider activity) {
    _disarmRunWatchdog();
    // v2.30.1: settle in-flight items too — v2.30.0 only flipped the
    // run state, so cards whose videos were mid-generation kept
    // rendering RENDERING forever after Stop (owner's field test).
    // Never-started items stay pending/queued: they do not render as
    // Rendering and the header counts derive from item statuses.
    for (final item in _items) {
      if (item.status == PromptStatus.generating ||
          item.status == PromptStatus.downloading) {
        item.status = PromptStatus.failed;
        item.error = 'Stopped by user';
      }
    }
    _state = GenerationState.idle;
    AutomationBridge.instance.stopGeneration();
    activity.addLog('Generation stopped.', level: LogLevel.warning);
    notifyListeners();
  }

  /// v2.33.0 (missing-scene redo): ask the engine to make ONLY the
  /// scenes this item set is missing — the failed cards. The
  /// engine decides per scene (bridge /api/generation/redo-missing):
  /// a scene that only failed to DOWNLOAD is downloaded again with
  /// no new charge; a scene whose generation failed is re-run as
  /// that one prompt with its original number. Finished scenes are
  /// never touched. The redo run streams the same events as any
  /// run, so the cards flip as each missing scene lands.
  Future<void> redoMissingItems({
    required AccountsProvider accounts,
    required ActivityProvider activity,
    required SettingsProvider settings,
  }) async {
    if (_state != GenerationState.idle) {
      activity.addLog(
        'A run is already in progress — the missing scenes can be redone once it settles.',
        level: LogLevel.warning,
      );
      return;
    }
    final missing =
        _items.where((i) => i.status == PromptStatus.failed).toList();
    if (missing.isEmpty) return;
    final tickedIds = accounts.accounts
        .where((a) => a.isChecked)
        .map((a) => a.id)
        .toList();
    if (tickedIds.isEmpty) {
      activity.addLog(
        'No account is ticked in the sidebar — tick at least one account, then press Redo Missing again.',
        level: LogLevel.warning,
      );
      return;
    }
    final result = await AutomationBridge.instance.redoMissing(
      accountIds: tickedIds,
      parallelBrowsers: settings.settings.parallelBrowsers,
    );
    if (result['ok'] == true && result['started'] == true) {
      for (final item in missing) {
        item.status = PromptStatus.generating;
        item.error = null;
        item.progress = 0;
      }
      _state = GenerationState.running;
      _runStarted = true;
      _armRunWatchdog();
      activity.addLog(
        'Redo started: making only the ${result['missing'] ?? missing.length} missing scene(s) — finished scenes are not touched and their credits are not spent again.',
        level: LogLevel.info,
      );
      notifyListeners();
    } else if (result['ok'] == true) {
      activity.addLog(
        result['message']?.toString() ??
            'Nothing is missing — every scene of the last run is already saved.',
        level: LogLevel.success,
      );
    } else {
      activity.addLog(
        'Redo could not start: ${result['error']?.toString() ?? 'the engine did not respond.'}',
        level: LogLevel.error,
      );
    }
  }

  // v2.22.0: the old fake-simulation queue (_processNextPrompt + Timer)
  // was removed completely. Generation state changes ONLY from real
  // engine events (video-completed / automation-progress over SSE).

  @override
  void dispose() {
    _disarmRunWatchdog();
    super.dispose();
  }
}
