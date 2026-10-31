import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import '../theme/app_theme.dart';
import '../providers/settings_provider.dart';
import '../services/automation_bridge.dart';
import 'video_player_dialog.dart';

// v2.27.0: the History view from the approved design ("Previous
// Videos"). DATA IS REAL: the engine's GET /api/output-files lists
// the actual video files in the configured output folder (name, size,
// mtime). The app has no prompt metadata per saved file, so the line
// under a file name shows its real folder/date/size — nothing is
// invented. "Clear History (records only)" hides names in this app
// (persisted via the 'history_cleared' setting); files stay on disk.
// v2.34.0 (Problem 7): each file also carries an ORIGIN from the
// engine — "flow" when a queue_tasks record proves this app
// generated it, "local" for files the owner dropped into the
// folder himself — rendered as a small pill next to the name, so
// the two kinds no longer mix invisibly.
// (Fix list 2026-10-27, item 1): the engine listing now covers the
// whole output tree — every file carries its PROJECT (the output
// folder's subfolder it lives in, '' for the base folder) and its
// `rel` reference ("Project/name.mp4"). This page groups by
// project under project headers.
// v2.39.0 (owner's corrected spec, FIX-LIST-2026-10-27-B): the
// v2.36.0 "Add Local Videos" file-picker model is REMOVED (the
// owner rejected adding files one by one; the old
// 'history_local_files' picks are simply no longer read or
// written by this view — the stored key itself is left alone).
// The page now has two modes: [App Videos] — the engine's own
// output as before, plus a projects strip where every project
// shows its video count and an Open button that filters the
// list to only that project — and [Local PC], which scans the
// PC's Videos / Downloads / Desktop folders (recursively) for
// video files and lists them, playable in-app. Local PC results
// are session-only scans: they never enter the App Videos stat
// cards and are never written to the engine or the history data.
class HistoryView extends StatefulWidget {
  const HistoryView({super.key});

  @override
  State<HistoryView> createState() => _HistoryViewState();
}

class _HistoryViewState extends State<HistoryView> {
  List<Map<String, dynamic>> _files = [];
  // v2.39.0: the two History modes. App Videos (default) is the
  // engine's output; Local PC holds the latest folder scan —
  // same entry shape as the engine's, plus the absolute 'path'
  // and the containing 'folder'. Session-only; the files
  // themselves are never touched.
  bool _localMode = false;
  List<Map<String, dynamic>> _pcFiles = [];
  bool _scanning = false;
  bool _scanned = false;
  bool _loading = true;
  String _query = '';
  // Item 1: '' shows everything (grouped); a project name filters
  // the list to that project only.
  String _projectFilter = '';

  // v2.46.1: projects strip ka scroll controller — dono-taraf
  // wale ‹ › buttons ke liye (owner-approved Sample 2, 2026-10-30).
  // v2.46.0 ki scrollbar + mouse-wheel wali soorat owner ne REJECT
  // kar di thi ("scroll nahi dalna tha, ek button dalni thi") —
  // strip wapas apni saaf soorat me hai, aana-jaana sirf in do
  // buttons se hota hai.
  final ScrollController _projectsScrollController = ScrollController();
  bool _stripCanPrev = false;
  bool _stripCanNext = false;

  // Buttons ki haalat asal scroll position se: shuru par ‹ halka
  // (band), aakhir par › halka. Har scroll/animation par taza.
  void _syncStripArrows() {
    final c = _projectsScrollController;
    if (!c.hasClients || !mounted) return;
    final pos = c.position;
    final prev = pos.pixels > 0.5;
    final next = pos.pixels < pos.maxScrollExtent - 0.5;
    if (prev != _stripCanPrev || next != _stripCanNext) {
      setState(() {
        _stripCanPrev = prev;
        _stripCanNext = next;
      });
    }
  }

  // Ek click = patti ek screen bhar aage/peeche — agle folders
  // saamne aa jate hain; click karte raho, folders aate rahenge
  // (owner ki asal baat, 2026-10-30).
  void _pageStrip(bool forward) {
    final c = _projectsScrollController;
    if (!c.hasClients) return;
    final pos = c.position;
    final step = pos.viewportDimension;
    final target =
        (c.offset + (forward ? step : -step)).clamp(0.0, pos.maxScrollExtent);
    c.animateTo(target.toDouble(),
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut);
  }

  Widget _stripArrow(bool left, bool enabled, VoidCallback onTap) {
    return Opacity(
      opacity: enabled ? 1 : 0.3,
      child: InkWell(
        onTap: enabled ? onTap : null,
        customBorder: const CircleBorder(),
        child: Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(
            color: AppTheme.surface,
            shape: BoxShape.circle,
            border: Border.all(color: AppTheme.borderSoft),
          ),
          child: Icon(
            left ? Icons.chevron_left : Icons.chevron_right,
            size: 20,
            color: AppTheme.textMain,
          ),
        ),
      ),
    );
  }

  // v2.46.3: videos wali list ka controller — poore page ka
  // wheel isi ko chalata hai (neeche _onPageWheel dekho).
  final ScrollController _listScrollController = ScrollController();

  // v2.46.3 (owner ki shikayat, 2026-10-30): pehle wheel sirf
  // videos wali list ke upar chalta tha — cards/patti/headings
  // ke upar ghumane se kuch nahi hota tha, kyunki page ka upar
  // wala hissa fixed hai aur asal scroll area sirf neeche wali
  // list hai. Ab wheel page par KAHIN se bhi chale, wohi list
  // scroll hogi — bilkul pehle ki tarah. pointerSignalResolver
  // ki wajah se jab pointer khud list ke upar ho to list apna
  // asal scroll khud karti hai (dohra scroll kabhi nahi).
  void _onPageWheel(PointerSignalEvent event) {
    if (event is! PointerScrollEvent) return;
    final c = _listScrollController;
    if (!c.hasClients) return;
    GestureBinding.instance.pointerSignalResolver
        .register(event, (PointerSignalEvent resolved) {
      if (!c.hasClients) return;
      final pos = c.position;
      final target =
          (pos.pixels + event.scrollDelta.dy).clamp(0.0, pos.maxScrollExtent);
      c.jumpTo(target.toDouble());
    });
  }

  @override
  void dispose() {
    _projectsScrollController.dispose();
    _listScrollController.dispose();
    super.dispose();
  }

  static const List<Color> _tilePalette = [
    Color(0xFF24406B), // navy
    Color(0xFF7A3B2E), // rust
    Color(0xFF2E5E3A), // green
    Color(0xFF5B2A6E), // purple
    Color(0xFF6E5322), // brown-gold
    Color(0xFF7A2430), // deep red
    Color(0xFF1F5E6E), // teal
    Color(0xFF3A3A72), // indigo
  ];

  @override
  void initState() {
    super.initState();
    _projectsScrollController.addListener(_syncStripArrows);
    _load();
    // v2.29.0: refresh the engine usage stats so the spend card
    // below shows the real credits figure, not a stale one.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<SettingsProvider>().loadSettingsFromEngine();
      }
    });
  }

  Future<void> _load() async {
    final files = await AutomationBridge.instance.getOutputFiles();
    if (mounted) {
      setState(() {
        _files = files;
        _loading = false;
      });
      // Notification Center: a "View video" action may have asked
      // for one file's player — open it now the list is in, and
      // only when the file really is in the output folder. The
      // match is by name or by `rel` (a project file is opened
      // through its project-qualified reference).
      final pending =
          context.read<SettingsProvider>().takePendingHistoryFile();
      if (pending != null && pending.isNotEmpty) {
        Map<String, dynamic>? match;
        for (final f in files) {
          if (f['name']?.toString() == pending || _relOf(f) == pending) {
            match = f;
            break;
          }
        }
        if (match != null) {
          final rel = _relOf(match);
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) {
              showInAppPlayer(context, title: pending, fileName: rel);
            }
          });
        }
      }
    }
  }

  // --- Item 1/2 entry helpers -------------------------------------
  static String _projectOf(Map<String, dynamic> f) =>
      f['project']?.toString() ?? '';

  // The reference the bridge's path endpoints accept: the bare
  // name for base-folder files, "Project/name" for project files.
  static String _relOf(Map<String, dynamic> f) =>
      f['rel']?.toString() ?? (f['name']?.toString() ?? '');

  // The identity used by the Clear History records — `rel`, so two
  // projects can hold same-named files without hiding each other.
  static String _keyOf(Map<String, dynamic> f) => _relOf(f);

  // A Local PC scan entry (it carries its own absolute path,
  // unlike an engine entry, which resolves through its `rel`).
  static bool _isLocalPick(Map<String, dynamic> f) =>
      (f['path']?.toString() ?? '').isNotEmpty;

  static String _baseNameOf(String path) =>
      path.replaceAll('\\', '/').split('/').last;

  static String _folderNameOf(Map<String, dynamic> f) {
    final folder = f['folder']?.toString() ?? '';
    if (folder.isEmpty) return 'This PC';
    return _baseNameOf(folder);
  }

  bool _matchesQuery(Map<String, dynamic> f) {
    if (_query.isEmpty) return true;
    final name = f['name']?.toString() ?? '';
    return name.toLowerCase().contains(_query.toLowerCase());
  }

  // --- v2.39.0: Local PC scan ---------------------------------------
  // One click on [Local PC] scans the standard video folders —
  // %USERPROFILE%\Videos, \Downloads, \Desktop — recursively for
  // video files. Missing or unreadable folders are skipped, a
  // file that cannot be stat'ed is skipped, and results are
  // deduped by full path (Windows paths are case-insensitive, so
  // the dedupe key is the lowercased path). Nothing is persisted:
  // the scan is this session's view of the PC, refreshed by the
  // Rescan button.
  static const Set<String> _videoExtensions = {'.mp4', '.mov', '.webm', '.mkv'};

  void _showLocalPc() {
    setState(() => _localMode = true);
    if (!_scanned && !_scanning) _scanPc();
  }

  Future<void> _scanPc() async {
    setState(() => _scanning = true);
    final results = <Map<String, dynamic>>[];
    final seen = <String>{};
    try {
      final home = Platform.environment['USERPROFILE'] ?? '';
      if (home.isNotEmpty) {
        for (final name in const ['Videos', 'Downloads', 'Desktop']) {
          final dir = Directory('$home\\$name');
          try {
            if (!await dir.exists()) continue;
            await for (final ent in dir
                .list(recursive: true, followLinks: false)
                .handleError((_) {})) {
              if (ent is! File) continue;
              final lower = ent.path.toLowerCase();
              final dot = lower.lastIndexOf('.');
              if (dot < 0 || !_videoExtensions.contains(lower.substring(dot))) {
                continue;
              }
              if (!seen.add(lower)) continue; // dedupe by full path
              try {
                final st = await ent.stat();
                results.add({
                  'name': _baseNameOf(ent.path),
                  'size': st.size,
                  'mtime': st.modified.millisecondsSinceEpoch,
                  'origin': 'local',
                  'project': '',
                  'path': ent.path,
                  'folder': ent.parent.path,
                });
              } catch (_) {
                // One unstat-able file never sinks the scan.
              }
            }
          } catch (_) {
            // A missing/unreadable folder is skipped; the
            // remaining folders still scan.
          }
        }
      }
    } catch (_) {
      // A scan that cannot run at all just yields an empty list.
    }
    results.sort((a, b) =>
        ((b['mtime'] as num?) ?? 0).compareTo((a['mtime'] as num?) ?? 0));
    if (mounted) {
      setState(() {
        _pcFiles = results;
        _scanning = false;
        _scanned = true;
      });
    } else {
      _pcFiles = results;
      _scanning = false;
      _scanned = true;
    }
  }

  // A Local PC row's folder button: open the file's own folder
  // in Explorer (the engine's folder opener is confined to the
  // output folder, so this goes through the OS directly).
  void _openContainingFolder(Map<String, dynamic> f) {
    final p = f['path']?.toString() ?? '';
    if (p.isEmpty || !Platform.isWindows) return;
    try {
      Process.start('explorer', [File(p).parent.path]);
    } catch (_) {
      // No Explorer, no action — Play still works.
    }
  }

  DateTime _mtimeOf(Map<String, dynamic> f) {
    final ms = (f['mtime'] as num?)?.toInt() ?? 0;
    return DateTime.fromMillisecondsSinceEpoch(ms);
  }

  bool _isToday(DateTime d) {
    final now = DateTime.now();
    return d.year == now.year && d.month == now.month && d.day == now.day;
  }

  bool _isYesterday(DateTime d) {
    final y = DateTime.now().subtract(const Duration(days: 1));
    return d.year == y.year && d.month == y.month && d.day == y.day;
  }

  String _dateLabel(DateTime d) {
    final time = DateFormat('h:mm a').format(d);
    if (_isToday(d)) return 'Today · $time';
    if (_isYesterday(d)) return 'Yesterday · $time';
    return '${DateFormat('MMM d').format(d)} · $time';
  }

  static String _sizeLabel(num bytes) {
    if (bytes >= 1024 * 1024) {
      return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
    }
    if (bytes >= 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
    return '$bytes B';
  }

  @override
  Widget build(BuildContext context) {
    final settingsProv = context.watch<SettingsProvider>();
    final cleared = settingsProv.historyCleared;

    // (Fix list item 1): a file is hidden when its Clear-History
    // record names it — by `rel` (its identity now, so same-named
    // files in different projects hide independently) or, for
    // records written before projects existed, by plain name.
    bool isHidden(Map<String, dynamic> f) =>
        cleared.contains(_keyOf(f)) ||
        cleared.contains(f['name']?.toString() ?? '');

    final visible = _files.where((f) {
      if (isHidden(f)) return false;
      return _matchesQuery(f);
    }).toList();
    // v2.39.0: Local PC scan results live apart from the engine
    // list (see _buildLocalList), so they can never reach the
    // stat cards below.

    // v2.30.0: files an earlier "Clear History (records only)" hid.
    // They still exist in the output folder — the page must SAY so
    // (with a way back), never just look empty.
    final hiddenCount = _files.where(isHidden).length;

    // Stat cards derive from the real (uncleared) ENGINE file list
    // only — Local PC scan results never inflate these numbers.
    final allFiles = _files.where((f) => !isHidden(f)).toList();

    // Item 1 + v2.39.0: the projects strip lists every project
    // that has videos, newest project first (the engine list is
    // mtime-sorted, so first occurrence order is newest-first),
    // with each project's video count. The strip is derived from
    // the uncleared list so a project never vanishes just
    // because a search is typed; the list itself still filters.
    // A filter naming a project that no longer exists simply
    // falls back to All.
    final projects = <String>[];
    final projectCounts = <String, int>{};
    for (final f in allFiles) {
      final p = _projectOf(f);
      if (p.isEmpty) continue;
      if (!projects.contains(p)) projects.add(p);
      projectCounts[p] = (projectCounts[p] ?? 0) + 1;
    }
    final activeFilter =
        projects.contains(_projectFilter) ? _projectFilter : '';

    // The list body: section headers (String) and file rows (Map).
    // Filtered → just that project's files. Unfiltered → grouped:
    // one header per project, the base folder's files under
    // OUTPUT FOLDER (only when projects exist — with no projects
    // the list is exactly the old flat one).
    final entries = <Object>[];
    if (activeFilter.isNotEmpty) {
      entries.addAll(visible.where((f) => _projectOf(f) == activeFilter));
    } else {
      for (final p in projects) {
        final inProject = visible.where((f) => _projectOf(f) == p).toList();
        if (inProject.isEmpty) continue;
        entries.add('PROJECT — $p');
        entries.addAll(inProject);
      }
      final baseFiles = visible.where((f) => _projectOf(f).isEmpty);
      if (projects.isNotEmpty && baseFiles.isNotEmpty) {
        entries.add('OUTPUT FOLDER');
      }
      entries.addAll(baseFiles);
    }
    // v2.29.1: "TOTAL VIDEOS (ALL TIME)" is the engine's real
    // all-time usage total (the same figure Settings → About
    // shows), not the output-folder file count — the folder count
    // drops whenever old files are moved/deleted. The folder count
    // stays as the fallback until the engine stats arrive. (Today /
    // Last 7 Days below remain folder-based, by design.)
    final total = settingsProv.totalVideosSaved > 0
        ? settingsProv.totalVideosSaved
        : allFiles.length;
    final todayCount = allFiles.where((f) => _isToday(_mtimeOf(f))).length;
    final weekAgo = DateTime.now().subtract(const Duration(days: 7));
    final last7 = allFiles.where((f) => _mtimeOf(f).isAfter(weekAgo)).length;
    // v2.29.0: TODAY'S SPEND is the engine's REAL recorded credits
    // for today (usage stats) — it was `todayCount × 7` before,
    // which invented a figure whenever another model was used.
    final spendToday = settingsProv.spentCreditsToday;

    return Listener(
      onPointerSignal: _onPageWheel,
      child: Padding(
      padding: const EdgeInsets.fromLTRB(10, 12, 14, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Top row (design): Back chip + title + search
          Row(
            children: [
              InkWell(
                onTap: () => context.read<SettingsProvider>().setNavView('generate'),
                borderRadius: BorderRadius.circular(14),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(
                    color: AppTheme.accentGold.withValues(alpha: 0.07),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: AppTheme.accentGold.withValues(alpha: 0.55)),
                  ),
                  child: Text(
                    '← Back to Studio',
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppTheme.accentText),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Text(
                'Previous Videos',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppTheme.textMain),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Container(
                  height: 32,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  decoration: BoxDecoration(
                    color: AppTheme.inputBg,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppTheme.borderSoft),
                  ),
                  child: TextField(
                    // v2.30.0: text vertically centred in its box.
                    textAlignVertical: TextAlignVertical.center,
                    style: TextStyle(fontSize: 11.5, color: AppTheme.textMain),
                    decoration: InputDecoration(
                      // v2.29.0: the search only ever matched file
                      // NAMES (no per-file prompt is stored) — the
                      // hint no longer promises prompt search.
                      hintText: 'Search by video name...',
                      hintStyle: TextStyle(fontSize: 11, color: AppTheme.textFaint),
                      border: InputBorder.none,
                      isDense: true,
                      contentPadding: EdgeInsets.zero,
                    ),
                    onChanged: (v) => setState(() => _query = v),
                  ),
                ),
              ),
            ],
          ),

          const SizedBox(height: 10),

          // v2.39.0: the two History modes. [App Videos] is the
          // app's own generated output; [Local PC] scans the PC's
          // Videos / Downloads / Desktop folders — clicking it IS
          // the scan (nothing is picked or added by hand).
          Row(
            children: [
              _modeButton('App Videos', !_localMode,
                  () => setState(() => _localMode = false)),
              const SizedBox(width: 6),
              _modeButton('Local PC', _localMode, _showLocalPc),
              if (_localMode) ...[
                const SizedBox(width: 10),
                Text(
                  _scanning
                      ? 'Scanning…'
                      : _scanned
                          ? '${_pcFiles.length} video${_pcFiles.length == 1 ? '' : 's'} found on this PC'
                          : '',
                  style: TextStyle(fontSize: 11, color: AppTheme.textFaint),
                ),
              ],
            ],
          ),

          const SizedBox(height: 12),

          // Stat cards (design) — App Videos only: they count the
          // engine's output, and Local PC results never enter them.
          if (!_localMode) ...[
            Row(
              children: [
                _statCard('$total', 'TOTAL VIDEOS (ALL TIME)'),
                const SizedBox(width: 10),
                _statCard('$todayCount', "TODAY'S VIDEOS"),
                const SizedBox(width: 10),
                _statCard('$last7', 'LAST 7 DAYS'),
                const SizedBox(width: 10),
                _statCard('$spendToday', "TODAY'S SPEND (CREDITS)"),
              ],
            ),
            const SizedBox(height: 14),
          ],

          // List header row (design)
          Row(
            children: [
              Text(
                _localMode
                    ? 'VIDEOS ON THIS PC'
                    : activeFilter.isEmpty
                        ? 'ALL VIDEOS'
                        : 'PROJECT VIDEOS',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.1,
                  color: AppTheme.textFaint,
                ),
              ),
              const SizedBox(width: 8),
              // Responsive pass: the two buttons form ONE
              // scale-down cluster (same treatment as the top
              // strip) — at narrow widths they shrink as a unit
              // instead of overflowing the header row.
              // v2.29.0: the "All Folders" dropdown is GONE — it had
              // a single option and a no-op onChanged (the app has
              // exactly one output folder, so there was nothing to
              // filter).
              Flexible(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerRight,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
              // v2.39.0: Local PC mode's only header action is a
              // fresh scan; the App Videos actions (Clear History,
              // Open Output Folder) belong to the app's own list.
              if (_localMode)
              OutlinedButton(
                onPressed: _scanning ? null : _scanPc,
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppTheme.textMain,
                  side: BorderSide(color: AppTheme.borderSoft),
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
                  visualDensity: VisualDensity.compact,
                ),
                child: const Text('Rescan', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600)),
              ),
              if (!_localMode) ...[
              OutlinedButton(
                onPressed: allFiles.isEmpty
                    ? null
                    : () {
                        context.read<SettingsProvider>().clearHistoryRecords(
                              allFiles.map(_keyOf),
                            );
                      },
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppTheme.textMain,
                  side: BorderSide(color: AppTheme.borderSoft),
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
                  visualDensity: VisualDensity.compact,
                ),
                child: const Text('Clear History (records only)', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600)),
              ),
              const SizedBox(width: 8),
              ElevatedButton(
                onPressed: () => AutomationBridge.instance.openOutputFolder(),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.accentGold,
                  foregroundColor: AppTheme.onAccent,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
                  visualDensity: VisualDensity.compact,
                ),
                        child: const Text('Open Output Folder', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                      ),
              ],
                    ],
                  ),
                ),
              ),
            ],
          ),

          const SizedBox(height: 10),

          // v2.39.0 (owner's spec): the projects strip — every
          // project that has videos, with its video COUNT (so the
          // owner can see how many projects exist) and an Open
          // button that filters the list to ONLY that project.
          // New projects appear here on their own as their first
          // video is saved. While a project is open, a
          // "← All videos" chip leads back. (Supersedes the
          // v2.36.0 filter chips.)
          if (!_localMode && projects.isNotEmpty) ...[
            // v2.46.1 (owner-approved Sample 2): patti apni saaf
            // soorat me hai — koi scrollbar, koi wheel nahi. Dono
            // taraf gol ‹ › button hain; › par click karte raho,
            // agle folders aate rahenge; ‹ se peeche. Jo taraf
            // khatam ho jaye, us ka button halka pad jata hai.
            Builder(builder: (context) {
              WidgetsBinding.instance
                  .addPostFrameCallback((_) => _syncStripArrows());
              return Row(
                children: [
                  _stripArrow(true, _stripCanPrev, () => _pageStrip(false)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: SingleChildScrollView(
                      controller: _projectsScrollController,
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: [
                          if (activeFilter.isNotEmpty) ...[
                            _projectChip('← All videos', false,
                                () => setState(() => _projectFilter = '')),
                            const SizedBox(width: 6),
                          ],
                          for (var i = 0; i < projects.length; i++) ...[
                            if (i > 0) const SizedBox(width: 6),
                            _projectCard(
                              projects[i],
                              projectCounts[projects[i]] ?? 0,
                              activeFilter == projects[i],
                              () => setState(() => _projectFilter = projects[i]),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  _stripArrow(false, _stripCanNext, () => _pageStrip(true)),
                ],
              );
            }),
            const SizedBox(height: 10),
          ],

          // v2.30.0: hidden-by-Clear-History notice + recovery.
          if (!_localMode && hiddenCount > 0) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              decoration: BoxDecoration(
                color: AppTheme.activeGold.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppTheme.activeGold.withValues(alpha: 0.4)),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '$hiddenCount video${hiddenCount == 1 ? '' : 's'} hidden — an earlier "Clear History" hid the records. The files are still in the output folder.',
                      style: TextStyle(fontSize: 11, color: AppTheme.textDim),
                    ),
                  ),
                  const SizedBox(width: 8),
                  TextButton(
                    onPressed: () =>
                        context.read<SettingsProvider>().restoreHistoryRecords(),
                    style: TextButton.styleFrom(
                      foregroundColor: AppTheme.accentText,
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      visualDensity: VisualDensity.compact,
                    ),
                    child: const Text(
                      'Show them',
                      style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],

          // The list — App mode: (fix list item 1) `entries` mixes
          // section headers (String) with file rows (Map); the
          // row index counts files only, so tile colours stay
          // stable. Local mode: the scan list (own builder).
          Expanded(
            child: _localMode
                ? _buildLocalList()
                : _loading
                ? const Center(child: CircularProgressIndicator())
                : entries.isEmpty
                    ? Center(
                        child: Text(
                          // v2.30.0: an empty page must say WHY —
                          // truly no files, everything hidden by a
                          // past Clear, or just no search match.
                          _files.isEmpty
                              ? 'No videos yet — generated videos will appear here.'
                              : activeFilter.isNotEmpty
                                  ? 'No videos of this project are showing — pick "← All videos" above or open another project.'
                                  : (hiddenCount == _files.length && _query.isEmpty)
                                      ? 'All videos are hidden by an earlier Clear History — tap "Show them" above to bring them back.'
                                      : 'No videos match your search.',
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 12, color: AppTheme.textFaint),
                        ),
                      )
                    : ListView.builder(
                        controller: _listScrollController,
                        itemCount: entries.length,
                        itemBuilder: (context, index) {
                          final e = entries[index];
                          // Same 7px rhythm the separated list had.
                          final topGap = index == 0 ? 0.0 : 7.0;
                          if (e is String) {
                            return Padding(
                              padding: EdgeInsets.only(top: topGap),
                              child: _sectionHeader(e),
                            );
                          }
                          final f = e as Map<String, dynamic>;
                          // Tile colours count FILES only, so a
                          // header never shifts a row's colour.
                          final fileIndex = entries
                                  .take(index + 1)
                                  .whereType<Map<String, dynamic>>()
                                  .length -
                              1;
                          return Padding(
                            padding: EdgeInsets.only(top: topGap),
                            child: _buildRow(f, fileIndex),
                          );
                        },
                      ),
          ),
        ],
      ),
      ),
    );
  }

  // v2.39.0: one History mode button — the selected mode takes
  // the accent chip language, the other stays quiet.
  Widget _modeButton(String label, bool selected, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        decoration: BoxDecoration(
          color: selected
              ? AppTheme.accentGold.withValues(alpha: 0.12)
              : AppTheme.overlay08,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: selected
                ? AppTheme.accentGold.withValues(alpha: 0.55)
                : AppTheme.borderSoft,
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w800,
            color: selected ? AppTheme.accentText : AppTheme.textDim,
          ),
        ),
      ),
    );
  }

  // v2.39.0: the Local PC list — a brief "Scanning…" state, an
  // honest empty state, otherwise the scan's rows (same row
  // builder as App Videos; the rows carry their own paths).
  Widget _buildLocalList() {
    if (_scanning) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 12),
            Text(
              'Scanning this PC for videos…',
              style: TextStyle(fontSize: 12, color: AppTheme.textFaint),
            ),
          ],
        ),
      );
    }
    final files = _pcFiles.where(_matchesQuery).toList();
    if (files.isEmpty) {
      return Center(
        child: Text(
          _query.isNotEmpty
              ? 'No videos on this PC match your search.'
              : 'No videos found in Videos, Downloads or Desktop.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 12, color: AppTheme.textFaint),
        ),
      );
    }
    return ListView.builder(
      controller: _listScrollController,
      itemCount: files.length,
      itemBuilder: (context, index) {
        return Padding(
          padding: EdgeInsets.only(top: index == 0 ? 0.0 : 7.0),
          child: _buildRow(files[index], index),
        );
      },
    );
  }

  Widget _statCard(String value, String label) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: AppTheme.surface,
          borderRadius: BorderRadius.circular(11),
          border: Border.all(color: AppTheme.borderSoft),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              value,
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: AppTheme.textMain),
            ),
            const SizedBox(height: 2),
            // Responsive pass: the longest label ("TODAY'S SPEND
            // (ESTIMATED)") scales down to the card instead of
            // wrapping at narrow widths.
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(
                label,
                maxLines: 1,
                softWrap: false,
                style: TextStyle(fontSize: 9, fontWeight: FontWeight.w700, letterSpacing: 0.6, color: AppTheme.textFaint),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRow(Map<String, dynamic> f, int index) {
    final name = f['name']?.toString() ?? '';
    final size = (f['size'] as num?) ?? 0;
    final date = _mtimeOf(f);
    final tileColor = _tilePalette[index % _tilePalette.length];
    final project = _projectOf(f);
    final local = _isLocalPick(f);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: AppTheme.borderSoft),
      ),
      child: Row(
        children: [
          // Coloured tile with a Play triangle (design)
          Container(
            width: 62,
            height: 40,
            decoration: BoxDecoration(
              color: tileColor,
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Icon(Icons.play_arrow, size: 20, color: Colors.white),
          ),
          const SizedBox(width: 12),
          // Name + real meta line (folder · date · size). The
          // folder wording follows WHERE the file lives — a
          // project folder, the output folder, or (Local PC
          // mode) the folder on this PC it was found in.
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppTheme.textMain),
                      ),
                    ),
                    const SizedBox(width: 8),
                    _originPill(f['origin']?.toString()),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  // v2.39.0: a Local PC row names the folder the
                  // file actually sits in; engine rows keep the
                  // project/output wording.
                  '${local ? _folderNameOf(f) : project.isNotEmpty ? 'Project folder' : 'Output folder'} · ${_dateLabel(date)} · ${_sizeLabel(size)}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 10.5, color: AppTheme.textFaint),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          _metaColumn('FOLDER', local ? _folderNameOf(f) : project.isNotEmpty ? project : 'Output'),
          const SizedBox(width: 18),
          _metaColumn('SIZE', _sizeLabel(size)),
          const SizedBox(width: 12),
          _rowIconButton(
            icon: Icons.play_arrow,
            accent: true,
            // v2.29.0: Play opens the IN-APP player (it used to
            // hand the file to the OS video player).
            // (Fix list item 1): engine files resolve through their
            // `rel` reference, so a project file plays too — the
            // bare name alone could not reach inside its folder.
            // v2.39.0: a Local PC file plays from its own path
            // directly (the same route the old picks used).
            onTap: () => local
                ? showInAppPlayer(context,
                    title: name, filePath: f['path']?.toString())
                : showInAppPlayer(context, title: name, fileName: _relOf(f)),
          ),
          const SizedBox(width: 6),
          // Engine rows open the output folder; a Local PC row
          // opens the folder that file actually lives in.
          local
              ? _rowIconButton(
                  icon: Icons.folder_open_outlined,
                  accent: false,
                  onTap: () => _openContainingFolder(f),
                )
              : _rowIconButton(
                  icon: Icons.folder_open_outlined,
                  accent: false,
                  onTap: () => AutomationBridge.instance.openOutputFolder(),
                ),
        ],
      ),
    );
  }

  // (Fix list 2026-10-27, item 1): a list section header — the
  // project name (or OUTPUT FOLDER) in the page's
  // small caps label language, with a folder glyph.
  Widget _sectionHeader(String label) {
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 1),
      child: Row(
        children: [
          Icon(Icons.folder_outlined, size: 13, color: AppTheme.textFaint),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 10.5,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.0,
                color: AppTheme.textFaint,
              ),
            ),
          ),
        ],
      ),
    );
  }

  // v2.39.0: one projects-strip card — project name, its video
  // count, and an Open button. Open (or tapping the card) filters
  // the list to ONLY this project; the strip's "← All videos"
  // chip is the way back.
  Widget _projectCard(String name, int count, bool active, VoidCallback onOpen) {
    return InkWell(
      onTap: onOpen,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.fromLTRB(10, 6, 4, 6),
        decoration: BoxDecoration(
          color: active
              ? AppTheme.accentGold.withValues(alpha: 0.10)
              : AppTheme.surface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: active
                ? AppTheme.accentGold.withValues(alpha: 0.55)
                : AppTheme.borderSoft,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.folder_outlined,
                size: 15,
                color: active ? AppTheme.accentText : AppTheme.textDim),
            const SizedBox(width: 7),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 150),
                  child: Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w800,
                      color: AppTheme.textMain,
                    ),
                  ),
                ),
                Text(
                  '$count video${count == 1 ? '' : 's'}',
                  style: TextStyle(fontSize: 9.5, color: AppTheme.textFaint),
                ),
              ],
            ),
            const SizedBox(width: 4),
            TextButton(
              onPressed: onOpen,
              style: TextButton.styleFrom(
                foregroundColor: AppTheme.accentText,
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                visualDensity: VisualDensity.compact,
              ),
              child: const Text(
                'Open',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // (Fix list 2026-10-27, item 1): one project filter chip —
  // same selected/unselected language as the sidebar's filters.
  // (v2.39.0: still used for the strip's "← All videos" way back.)
  Widget _projectChip(String label, bool selected, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(999),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: selected
              ? AppTheme.accentGold.withValues(alpha: 0.12)
              : AppTheme.overlay08,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: selected
                ? AppTheme.accentGold.withValues(alpha: 0.55)
                : AppTheme.borderSoft,
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w700,
            color: selected ? AppTheme.accentText : AppTheme.textDim,
          ),
        ),
      ),
    );
  }

  // v2.34.0 (Problem 7): the origin pill — "Flow" in the app's
  // accent chip language for app-generated files, "Local" in a
  // muted grey for the owner's own files. Anything that is not an
  // explicit "flow" (including a missing field from an older
  // engine) reads as Local — never the other way round.
  // (Fix list 2026-10-27, item 8): the accent colours come from
  // the active theme now, so the pill recolors with the app.
  Widget _originPill(String? origin) {
    final isFlow = origin == 'flow';
    final fg = isFlow ? AppTheme.accentText : AppTheme.textDim;
    final bg = isFlow ? AppTheme.accentGold.withValues(alpha: 0.08) : AppTheme.overlay08;
    final border = isFlow ? AppTheme.accentGold.withValues(alpha: 0.55) : AppTheme.borderSoft;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: border),
      ),
      child: Text(
        isFlow ? 'FLOW' : 'LOCAL',
        style: TextStyle(
          fontSize: 8.5,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.6,
          color: fg,
        ),
      ),
    );
  }

  Widget _metaColumn(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(fontSize: 8.5, fontWeight: FontWeight.w700, letterSpacing: 0.7, color: AppTheme.textFaint),
        ),
        const SizedBox(height: 2),
        // (Fix list item 1): a FOLDER value can now be a project
        // name — cap its width and ellipsize so a long project
        // never pushes the row's buttons off the edge.
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 96),
          child: Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppTheme.textDim),
          ),
        ),
      ],
    );
  }

  Widget _rowIconButton({
    required IconData icon,
    required bool accent,
    required VoidCallback onTap,
  }) {
    final color = accent ? AppTheme.accentText : AppTheme.textDim;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(7),
      child: Container(
        width: 28,
        height: 28,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(7),
          border: Border.all(color: accent ? color : AppTheme.borderSoft),
        ),
        child: Icon(icon, size: 15, color: color),
      ),
    );
  }
}
