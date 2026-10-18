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

  GeneratorProvider() {
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
      if (failed) {
        item.status = PromptStatus.failed;
        item.error = err ?? statusStr;
      } else {
        item.status = PromptStatus.completed;
        item.progress = 1.0;
        item.localFilePath = data['filePath']?.toString();
      }
      notifyListeners();
    };
    AutomationBridge.instance.onProgress = (data) {
      final statusStr = data['status']?.toString() ?? '';
      if (statusStr == 'Completed' || statusStr == 'NoAccounts') {
        if (_items.every((i) =>
            i.status == PromptStatus.completed ||
            i.status == PromptStatus.failed)) {
          _state = GenerationState.idle;
          notifyListeners();
        }
      }
    };
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

  void setRawText(String text) {
    _promptsRawText = text;
    _reparseItems();
    notifyListeners();
  }

  void appendPrompts(List<String> newPrompts) {
    final existing = _promptsRawText.trim();
    if (existing.isEmpty) {
      _promptsRawText = newPrompts.join('\n');
    } else {
      _promptsRawText = '$existing\n${newPrompts.join('\n')}';
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
    final lines = _promptsRawText
        .replaceAll('\r\n', '\n')
        .split('\n')
        .map((l) => l.trim())
        .where((l) => l.isNotEmpty)
        .toList();

    _items = List.generate(
      lines.length,
      (i) => PromptItem(
        index: i + 1,
        text: lines[i],
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

    _state = GenerationState.running;
    notifyListeners();

    activity.addLog(
      'Generation started: ${_items.length} prompt(s) • ${settings.settings.parallelBrowsers} worker(s) in parallel',
      level: LogLevel.info,
    );

    // Call real Node.js automation engine
    final success = await AutomationBridge.instance.startGeneration(
      prompts: _items.map((i) => i.text).toList(),
      downloadFolder: settings.settings.outputDirectory,
      parallelBrowsers: settings.settings.parallelBrowsers,
      duration: settings.settings.duration,
      aspectRatio: settings.settings.aspectRatio,
      quality: settings.settings.quality,
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
