import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import '../theme/app_theme.dart';
import '../providers/settings_provider.dart';
import '../services/automation_bridge.dart';

// v2.27.0: the History view from the approved design ("Previous
// Videos"). DATA IS REAL: the engine's GET /api/output-files lists
// the actual video files in the configured output folder (name, size,
// mtime). The app has no prompt metadata per saved file, so the line
// under a file name shows its real folder/date/size — nothing is
// invented. "Clear History (records only)" hides names in this app
// (persisted via the 'history_cleared' setting); files stay on disk.
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
  }

  Future<void> _load() async {
    final files = await AutomationBridge.instance.getOutputFiles();
    if (mounted) {
      setState(() {
        _files = files;
        _loading = false;
      });
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

    // Stat cards derive from the real (uncleared) file list.
    final allFiles = _files.where((f) => !cleared.contains(f['name']?.toString() ?? '')).toList();
    final total = allFiles.length;
    final todayCount = allFiles.where((f) => _isToday(_mtimeOf(f))).length;
    final weekAgo = DateTime.now().subtract(const Duration(days: 7));
    final last7 = allFiles.where((f) => _mtimeOf(f).isAfter(weekAgo)).length;
    final spendToday = todayCount * 7;

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
                    style: TextStyle(fontSize: 11.5, color: AppTheme.textMain),
                    decoration: InputDecoration(
                      hintText: 'Search by video name or prompt...',
                      hintStyle: TextStyle(fontSize: 11, color: AppTheme.textFaint),
                      border: InputBorder.none,
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
              _statCard('$spendToday', "TODAY'S SPEND (ESTIMATED)"),
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
              // Responsive pass: the folder dropdown + the two
              // buttons form ONE scale-down cluster (same treatment
              // as the top strip) — at narrow widths they shrink as a
              // unit instead of overflowing the header row.
              Flexible(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerRight,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      // Folder filter — the app tracks one output folder, so
                      // this stays a single-option dropdown like the design.
                      Container(
                height: 28,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                decoration: BoxDecoration(
                  color: AppTheme.inputBg,
                  borderRadius: BorderRadius.circular(7),
                  border: Border.all(color: AppTheme.borderSoft),
                ),
                child: DropdownButtonHideUnderline(
                  child: DropdownButton<String>(
                    value: 'All Folders',
                    dropdownColor: AppTheme.surfaceElevated,
                    style: TextStyle(fontSize: 11, color: AppTheme.textMain),
                    icon: Icon(Icons.keyboard_arrow_down, size: 14, color: AppTheme.textDim),
                    items: const [
                      DropdownMenuItem(value: 'All Folders', child: Text('All Folders')),
                    ],
                    onChanged: (_) {},
                  ),
                ),
              ),
              const SizedBox(width: 8),
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

          // The list
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : visible.isEmpty
                    ? Center(
                        child: Text(
                          'No videos yet — generated videos will appear here.',
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
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppTheme.textMain),
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
            onTap: () => AutomationBridge.instance.openOutputFile(name),
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
