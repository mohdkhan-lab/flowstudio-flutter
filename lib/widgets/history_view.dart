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
class HistoryView extends StatefulWidget {
  const HistoryView({super.key});

  @override
  State<HistoryView> createState() => _HistoryViewState();
}

class _HistoryViewState extends State<HistoryView> {
  List<Map<String, dynamic>> _files = [];
  bool _loading = true;
  String _query = '';

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
      // only when the file really is in the output folder.
      final pending =
          context.read<SettingsProvider>().takePendingHistoryFile();
      if (pending != null &&
          pending.isNotEmpty &&
          files.any((f) => f['name']?.toString() == pending)) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) {
            showInAppPlayer(context, title: pending, fileName: pending);
          }
        });
      }
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

    final visible = _files.where((f) {
      final name = f['name']?.toString() ?? '';
      if (cleared.contains(name)) return false;
      if (_query.isEmpty) return true;
      return name.toLowerCase().contains(_query.toLowerCase());
    }).toList();

    // v2.30.0: files an earlier "Clear History (records only)" hid.
    // They still exist in the output folder — the page must SAY so
    // (with a way back), never just look empty.
    final hiddenCount =
        _files.where((f) => cleared.contains(f['name']?.toString() ?? '')).length;

    // Stat cards derive from the real (uncleared) file list.
    final allFiles = _files.where((f) => !cleared.contains(f['name']?.toString() ?? '')).toList();
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

    return Padding(
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
                    color: const Color(0x120A84FF),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: AppTheme.accentGold.withValues(alpha: 0.55)),
                  ),
                  child: Text(
                    '← Back to Generate',
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

          const SizedBox(height: 12),

          // Stat cards (design)
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

          // List header row (design)
          Row(
            children: [
              Text(
                'ALL VIDEOS',
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
              OutlinedButton(
                onPressed: allFiles.isEmpty
                    ? null
                    : () {
                        context.read<SettingsProvider>().clearHistoryRecords(
                              allFiles.map((f) => f['name']?.toString() ?? ''),
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
                  backgroundColor: const Color(0xFF0A84FF),
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
                  visualDensity: VisualDensity.compact,
                ),
                        child: const Text('Open Output Folder', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),

          const SizedBox(height: 10),

          // v2.30.0: hidden-by-Clear-History notice + recovery.
          if (hiddenCount > 0) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              decoration: BoxDecoration(
                color: const Color(0x14FFB340),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0x66FFB340)),
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

          // The list
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : visible.isEmpty
                    ? Center(
                        child: Text(
                          // v2.30.0: an empty page must say WHY —
                          // truly no files, everything hidden by a
                          // past Clear, or just no search match.
                          _files.isEmpty
                              ? 'No videos yet — generated videos will appear here.'
                              : (hiddenCount == _files.length && _query.isEmpty)
                                  ? 'All videos are hidden by an earlier Clear History — tap "Show them" above to bring them back.'
                                  : 'No videos match your search.',
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 12, color: AppTheme.textFaint),
                        ),
                      )
                    : ListView.separated(
                        itemCount: visible.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 7),
                        itemBuilder: (context, index) {
                          final f = visible[index];
                          return _buildRow(f, index);
                        },
                      ),
          ),
        ],
      ),
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
          // Name + real meta line (folder · date · size)
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
                  'Output folder · ${_dateLabel(date)} · ${_sizeLabel(size)}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 10.5, color: AppTheme.textFaint),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          _metaColumn('FOLDER', 'Output'),
          const SizedBox(width: 18),
          _metaColumn('SIZE', _sizeLabel(size)),
          const SizedBox(width: 12),
          _rowIconButton(
            icon: Icons.play_arrow,
            accent: true,
            // v2.29.0: Play opens the IN-APP player (it used to
            // hand the file to the OS video player).
            onTap: () => showInAppPlayer(context, title: name, fileName: name),
          ),
          const SizedBox(width: 6),
          _rowIconButton(
            icon: Icons.folder_open_outlined,
            accent: false,
            onTap: () => AutomationBridge.instance.openOutputFolder(),
          ),
        ],
      ),
    );
  }

  // v2.34.0 (Problem 7): the origin pill — "Flow" in the app's
  // blue chip language for app-generated files, "Local" in a
  // muted grey for the owner's own files. Anything that is not an
  // explicit "flow" (including a missing field from an older
  // engine) reads as Local — never the other way round.
  Widget _originPill(String? origin) {
    final isFlow = origin == 'flow';
    final fg = isFlow ? const Color(0xFF6DB3FF) : AppTheme.textDim;
    final bg = isFlow ? const Color(0x1464A0FF) : AppTheme.overlay08;
    final border = isFlow ? const Color(0xFF2F6FB4) : AppTheme.borderSoft;
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
        Text(
          value,
          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppTheme.textDim),
        ),
      ],
    );
  }

  Widget _rowIconButton({
    required IconData icon,
    required bool accent,
    required VoidCallback onTap,
  }) {
    final color = accent ? const Color(0xFF409CFF) : AppTheme.textDim;
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
