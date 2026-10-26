import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:file_picker/file_picker.dart';
import '../theme/app_theme.dart';
import '../models/activity_log.dart';
import '../providers/generator_provider.dart';
import '../providers/activity_provider.dart';
import '../providers/settings_provider.dart';
import '../services/srt_parser.dart';

class PromptsEditor extends StatefulWidget {
  const PromptsEditor({super.key});

  @override
  State<PromptsEditor> createState() => _PromptsEditorState();
}

class _PromptsEditorState extends State<PromptsEditor> {
  late TextEditingController _controller;
  late TextEditingController _projectController;
  // v2.29.0: the Bulk/Agent mode lives in GeneratorProvider now
  // (it drives the real parsing) — this widget only renders it.
  // v2.34.0 (Problem 9): the selected TAG lives in
  // GeneratorProvider ONLY — this widget used to keep a private
  // copy that diverged from the provider's (a tag deleted in
  // Settings stayed silently in use; an MCP run's tag never
  // showed here). The dropdown below displays and edits the
  // provider's value directly.

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController();
    _projectController = TextEditingController();
  }

  @override
  void dispose() {
    _controller.dispose();
    _projectController.dispose();
    super.dispose();
  }

  Future<void> _handleFileImport(BuildContext context) async {
    try {
      final result = await FilePickerPlatform.instance.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['txt', 'srt'],
      );

      if (result.isNotEmpty && result.first.path != null) {
        final selectedFile = result.first;
        final file = File(selectedFile.path!);
        final content = await file.readAsString();
        final prompts = SrtParser.parseContent(content, selectedFile.name);

        if (context.mounted) {
          context.read<GeneratorProvider>().appendPrompts(prompts);
          _controller.text = context.read<GeneratorProvider>().promptsRawText;

          context.read<ActivityProvider>().addLog(
                'Imported ${prompts.length} prompts from [${selectedFile.name}]',
                level: LogLevel.success,
              );
        }
      }
    } catch (e) {
      if (context.mounted) {
        context.read<ActivityProvider>().addLog('File import failed: $e', level: LogLevel.error);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final generator = context.watch<GeneratorProvider>();

    if (_controller.text != generator.promptsRawText) {
      _controller.text = generator.promptsRawText;
    }
    if (_projectController.text != generator.projectName) {
      _projectController.text = generator.projectName;
    }

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: AppTheme.borderSoft),
        boxShadow: const [
          BoxShadow(color: Colors.black26, blurRadius: 10, offset: Offset(0, 4)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header Row (design): PROMPTS | TAG ▾ | + Add Tag | "N prompts"
          Row(
            children: [
              Text(
                'PROMPTS',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.2,
                  color: AppTheme.textFaint,
                ),
              ),
              const Spacer(),
              Text(
                'TAG',
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.6,
                  color: AppTheme.textFaint,
                ),
              ),
              const SizedBox(width: 6),
              // Responsive pass: a long custom tag name can shrink
              // (loose Flexible + expanded dropdown) instead of
              // overflowing the header row.
              Flexible(
                child: Container(
                  height: 26,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  decoration: BoxDecoration(
                    color: AppTheme.inputBg,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppTheme.borderSoft),
                  ),
                  child: Consumer<SettingsProvider>(
                    builder: (context, settingsProv, _) {
                      final tags = settingsProv.settings.customTags;
                      // v2.34.0 (Problem 9): the value IS the
                      // provider's selected tag (this widget is
                      // rebuilt by the watch on GeneratorProvider
                      // above, so a programmatic set — e.g. an MCP
                      // in-app run — reflects here immediately).
                      // When the provider holds a tag that is not
                      // in the list (a fresh MCP run tag), the
                      // display falls back to 'None' honestly
                      // instead of inventing a selection.
                      final selected = generator.selectedTag;
                      final currentVal = tags.contains(selected)
                          ? selected
                          : (tags.isNotEmpty ? tags.first : 'None');

                      return DropdownButtonHideUnderline(
                        child: DropdownButton<String>(
                          value: currentVal,
                          isExpanded: true,
                          dropdownColor: AppTheme.surfaceElevated,
                          style: TextStyle(fontSize: 11, color: AppTheme.textMain),
                        icon: Icon(Icons.keyboard_arrow_down, size: 14, color: AppTheme.textDim),
                        items: tags.map((t) => DropdownMenuItem(value: t, child: Text(t))).toList(),
                        onChanged: (val) {
                          if (val != null) {
                            // v2.27.0: Progress cards name queued
                            // files from the selected tag.
                            context.read<GeneratorProvider>().setSelectedTag(val);
                          }
                          },
                        ),
                      );
                    },
                  ),
                ),
              ),
              const SizedBox(width: 6),
              InkWell(
                onTap: () => _showAddTagDialog(context),
                borderRadius: BorderRadius.circular(6),
                child: Container(
                  height: 26,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: const Color(0x1A0A84FF),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppTheme.accentGold.withValues(alpha: 0.5)),
                  ),
                  child: Text(
                    '+ Add Tag',
                    style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.accentText,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              // Count pill (design: "6 prompts")
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: const Color(0x120A84FF),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppTheme.accentGold.withValues(alpha: 0.5)),
                ),
                child: Text(
                  '${generator.totalPrompts} prompts',
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.bold,
                    color: AppTheme.accentText,
                  ),
                ),
              ),
            ],
          ),

          const SizedBox(height: 8),

          // v2.33.0 (project folder): one slim row under the header.
          // When a project name is set, the run's videos save into a
          // folder of that name inside the output folder instead of
          // mixing with the general downloads. Empty = no project,
          // exactly the old behaviour. The height comes out of the
          // flexible textarea, so the FIT LAW sizes are untouched.
          Row(
            children: [
              Text(
                'PROJECT',
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.6,
                  color: AppTheme.textFaint,
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Container(
                  height: 24,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  decoration: BoxDecoration(
                    color: AppTheme.inputBg,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppTheme.borderSoft),
                  ),
                  child: TextField(
                    controller: _projectController,
                    style: TextStyle(fontSize: 11, color: AppTheme.textMain),
                    onChanged: (text) =>
                        context.read<GeneratorProvider>().setProjectName(text),
                    decoration: InputDecoration(
                      hintText:
                          'Optional — e.g. My Short Film (videos save into this project folder)',
                      hintStyle: TextStyle(
                        color: AppTheme.textFaint,
                        fontSize: 10.5,
                        fontStyle: FontStyle.italic,
                      ),
                      border: InputBorder.none,
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(vertical: 5),
                    ),
                  ),
                ),
              ),
              if (generator.projectName.isNotEmpty) ...[
                const SizedBox(width: 6),
                InkWell(
                  onTap: () =>
                      context.read<GeneratorProvider>().setProjectName(''),
                  borderRadius: BorderRadius.circular(10),
                  child: Icon(Icons.close, size: 13, color: AppTheme.textDim),
                ),
              ],
            ],
          ),

          const SizedBox(height: 10),

          // Textarea (design: the only flexible/scrolling part)
          Expanded(
            child: Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppTheme.inputBg,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppTheme.borderSoft),
              ),
              child: TextField(
                controller: _controller,
                maxLines: null,
                expands: true,
                style: TextStyle(
                  fontSize: 11.5,
                  height: 1.5,
                  color: AppTheme.textMain,
                  fontFamily: 'Consolas',
                ),
                onChanged: (text) => context.read<GeneratorProvider>().setRawText(text),
                decoration: InputDecoration(
                  hintText: '#00-01 A cinematic shot of a lighthouse during a storm, waves crashing...\n#00-02 A drone flyover of a green valley at sunrise, mist lifting...',
                  hintStyle: TextStyle(
                    color: AppTheme.textFaint,
                    fontSize: 11,
                    fontStyle: FontStyle.italic,
                  ),
                  border: InputBorder.none,
                  contentPadding: EdgeInsets.zero,
                ),
              ),
            ),
          ),

          const SizedBox(height: 8),

          // v2.27.0 (design): Bulk / Agent Prompt toggle at the
          // BOTTOM-LEFT under the textarea; txt/srt at bottom-right.
          // v2.29.0: the toggle is REAL — it switches the provider's
          // parsing mode (Bulk = blank-line blocks; Agent = the
          // whole text is one prompt) and the count/estimate update
          // with it. It was a visual-only pill before.
          Row(
            children: [
              // Bulk Prompt Pill
              InkWell(
                onTap: () => context.read<GeneratorProvider>().setPromptMode(true),
                borderRadius: BorderRadius.circular(12),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    gradient: generator.isBulkMode ? AppTheme.accentGrad : null,
                    color: generator.isBulkMode ? null : AppTheme.overlay08,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    'Bulk Prompt',
                    style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.bold,
                      color: generator.isBulkMode ? AppTheme.onAccent : AppTheme.textDim,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              // Agent Prompt Pill
              InkWell(
                onTap: () => context.read<GeneratorProvider>().setPromptMode(false),
                borderRadius: BorderRadius.circular(12),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    gradient: !generator.isBulkMode ? AppTheme.accentGrad : null,
                    color: !generator.isBulkMode ? null : AppTheme.overlay08,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    'Agent Prompt',
                    style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.bold,
                      color: !generator.isBulkMode ? AppTheme.onAccent : AppTheme.textDim,
                    ),
                  ),
                ),
              ),
              const Spacer(),
              // txt/srt import button
              InkWell(
                onTap: () => _handleFileImport(context),
                borderRadius: BorderRadius.circular(6),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: AppTheme.inputBg,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppTheme.borderSoft),
                  ),
                  child: Text(
                    'txt/srt',
                    style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.w700,
                      color: AppTheme.textMain,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  void _showAddTagDialog(BuildContext context) {
    final tagCtrl = TextEditingController();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppTheme.surfaceElevated,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        title: Text('+ Add Tag', style: TextStyle(fontSize: 14, color: AppTheme.textMain)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Write the tag name. Videos saved with this tag carry its name (e.g. Scene1.mp4).',
              style: TextStyle(fontSize: 11, color: AppTheme.textFaint),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: tagCtrl,
              autofocus: true,
              style: TextStyle(fontSize: 12, color: AppTheme.textMain),
              decoration: InputDecoration(
                hintText: 'e.g. Scene1',
                hintStyle: TextStyle(fontSize: 11, color: AppTheme.textFaint),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('Cancel', style: TextStyle(color: AppTheme.textDim)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppTheme.accentGold,
              foregroundColor: Colors.black,
            ),
            onPressed: () {
              final newTag = tagCtrl.text.trim();
              if (newTag.isNotEmpty) {
                context.read<SettingsProvider>().addCustomTag(newTag);
                // v2.34.0 (Problem 9): the provider is the only
                // place the selection lives — no widget copy.
                context.read<GeneratorProvider>().setSelectedTag(newTag);
                Navigator.pop(ctx);
              }
            },
            child: const Text('Add Tag', style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }
}
