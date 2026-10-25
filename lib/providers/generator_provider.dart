import 'package:flutter/material.dart';
import '../models/prompt_item.dart';
import '../models/activity_log.dart';
import '../services/automation_bridge.dart';
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
  // v2.27.0: the TAG chosen in the Prompts header lives here so the
  // Progress cards can name queued files like the design ("#<tag>-<nn>.mp4").
  String _selectedTag = 'None';
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
      final item = _matchTaskItem(data);
      if (item == null) return;
      final statusStr = data['status']?.toString() ?? '';
      if (statusStr == 'generating') {
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
  }

  /// v2.30.1: match an engine task-update to its prompt item by
  /// promptIndex, else by exact prompt text. Unlike
  /// [_matchCompletedItem] there is deliberately NO "first generating"
  /// fallback — a task update that matches nothing changes nothing.
  PromptItem? _matchTaskItem(Map<String, dynamic> data) {
    final idxRaw = data['promptIndex'] ?? data['prompt_index'];
    if (idxRaw is int) {
      for (final i in _items) {
        if (i.index == idxRaw) return i;
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
      for (final i in _items) {
        if (i.index == idxRaw) return i;
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
    return _items.isNotEmpty ? _items.first : null;
  }

  String get promptsRawText => _promptsRawText;
  List<PromptItem> get items => List.unmodifiable(_items);
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
    _state = GenerationState.idle;
    notifyListeners();
  }

  void _reparseItems() {
    // v2.29.0 (prompt splitting fix): the old parser made EVERY
    // non-empty line its own prompt, so one multi-line episode
    // prompt was counted and queued as several fragments.
    // Bulk mode: prompts are BLOCKS separated by blank lines; the
    // lines inside a block stay together as one prompt.
    // Agent mode: the entire text is ONE prompt.
    final normalized = _promptsRawText.replaceAll('\r\n', '\n').trim();
    final List<String> blocks;
    if (normalized.isEmpty) {
      blocks = const [];
    } else if (!_isBulkMode) {
      blocks = [normalized];
    } else {
      blocks = normalized
          .split(RegExp(r'\n[ \t]*\n'))
          .map((b) => b.trim())
          .where((b) => b.isNotEmpty)
          .toList();
    }

    _items = List.generate(
      blocks.length,
      (i) => PromptItem(
        index: i + 1,
        text: blocks[i],
        status: PromptStatus.pending,
      ),
    );
  }

  Future<void> startGeneration({
    required AccountsProvider accounts,
    required ActivityProvider activity,
    required SettingsProvider settings,
  }) async {
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
    final success = await AutomationBridge.instance.startGeneration(
      prompts: _items.map((i) => i.text).toList(),
      downloadFolder: settings.settings.outputDirectory,
      parallelBrowsers: settings.settings.parallelBrowsers,
      duration: settings.settings.duration,
      aspectRatio: settings.settings.aspectRatio,
      quality: settings.settings.quality,
      tag: _selectedTag == 'None' ? '' : _selectedTag,
      accountIds: tickedIds,
      model: settings.settings.model,
      namingPattern: settings.settings.namingPattern,
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
    for (final item in _items) {
      if (item.status == PromptStatus.pending) {
        item.status = PromptStatus.generating;
      }
    }
    notifyListeners();
  }

  void pauseGeneration(ActivityProvider activity) {
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
      AutomationBridge.instance.resumeGeneration();
      activity.addLog('Generation resumed.', level: LogLevel.info);
      notifyListeners();
    }
  }

  void stopGeneration(ActivityProvider activity) {
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

  // v2.22.0: the old fake-simulation queue (_processNextPrompt + Timer)
  // was removed completely. Generation state changes ONLY from real
  // engine events (video-completed / automation-progress over SSE).

  @override
  void dispose() {
    super.dispose();
  }
}
