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
  String _selectedTag = 'None';
  bool _isBulkPrompt = true;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController();
  }

  @override
  void dispose() {
    _controller.dispose();
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
          // Header Row: Prompts | TAG None ▾ | + Add Tag
          Row(
            children: [
              Text(
                'Prompts',
                style: TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textMain,
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
              Container(
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
                    final currentVal = tags.contains(_selectedTag) ? _selectedTag : (tags.isNotEmpty ? tags.first : 'None');

                    return DropdownButtonHideUnderline(
                      child: DropdownButton<String>(
                        value: currentVal,
                        dropdownColor: AppTheme.surfaceElevated,
                        style: TextStyle(fontSize: 11, color: AppTheme.textMain),
                        icon: Icon(Icons.keyboard_arrow_down, size: 14, color: AppTheme.textDim),
                        items: tags.map((t) => DropdownMenuItem(value: t, child: Text(t))).toList(),
                        onChanged: (val) {
                          if (val != null) setState(() => _selectedTag = val);
                        },
                      ),
                    );
                  },
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
            ],
          ),

          const SizedBox(height: 10),

          // Sub-Bar: Bulk Prompt | Agent Prompt | Prompts: X
          Row(
            children: [
              // Bulk Prompt Pill
              InkWell(
                onTap: () => setState(() => _isBulkPrompt = true),
                borderRadius: BorderRadius.circular(12),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    gradient: _isBulkPrompt ? AppTheme.accentGrad : null,
                    color: _isBulkPrompt ? null : AppTheme.overlay08,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    'Bulk Prompt',
                    style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.bold,
                      color: _isBulkPrompt ? AppTheme.onAccent : AppTheme.textDim,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              // Agent Prompt Pill
              InkWell(
                onTap: () => setState(() => _isBulkPrompt = false),
                borderRadius: BorderRadius.circular(12),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    gradient: !_isBulkPrompt ? AppTheme.accentGrad : null,
                    color: !_isBulkPrompt ? null : AppTheme.overlay08,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    'Agent Prompt',
                    style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.bold,
                      color: !_isBulkPrompt ? AppTheme.onAccent : AppTheme.textDim,
                    ),
                  ),
                ),
              ),
              const Spacer(),
              // Prompts Counter Pill
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: const Color(0x120A84FF),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppTheme.accentGold.withValues(alpha: 0.5)),
                ),
                child: Text(
                  'Prompts: ${generator.totalPrompts}',
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

          // Textarea Container
          Expanded(
            child: Stack(
              children: [
                Container(
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

                // txt/srt button on bottom right
                Positioned(
                  bottom: 8,
                  right: 8,
                  child: InkWell(
                    onTap: () => _handleFileImport(context),
                    borderRadius: BorderRadius.circular(6),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: AppTheme.inputBg,
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: AppTheme.borderSoft),
                      ),
                      child: Text(
                        'txt/srt',
                        style: TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                          color: AppTheme.textMain,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
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
                setState(() => _selectedTag = newTag);
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

