class SrtParser {
  /// Parses an SRT file content or TXT content into a list of prompt strings
  static List<String> parseContent(String rawContent, String filename) {
    if (filename.toLowerCase().endsWith('.srt')) {
      return parseSrt(rawContent);
    } else {
      return parseTxt(rawContent);
    }
  }

  /// Parses SRT format:
  /// 1
  /// 00:00:01,000 --> 00:00:04,000
  /// Subtitle text line
  static List<String> parseSrt(String srtContent) {
    final List<String> prompts = [];
    final lines = srtContent.replaceAll('\r\n', '\n').split('\n');
    
    StringBuffer currentText = StringBuffer();
    bool readingText = false;

    for (final line in lines) {
      final trimmed = line.trim();
      
      if (trimmed.isEmpty) {
        if (currentText.isNotEmpty) {
          final text = currentText.toString().trim();
          if (text.isNotEmpty) prompts.add(text);
          currentText.clear();
        }
        readingText = false;
        continue;
      }

      // Check if it's index line (digits only)
      if (RegExp(r'^\d+$').hasMatch(trimmed) && !readingText) {
        continue;
      }

      // Check if it's timecode line (00:00:00,000 --> 00:00:00,000)
      if (trimmed.contains('-->')) {
        readingText = true;
        continue;
      }

      if (readingText) {
        if (currentText.isNotEmpty) currentText.write(' ');
        currentText.write(trimmed);
      }
    }

    if (currentText.isNotEmpty) {
      final text = currentText.toString().trim();
      if (text.isNotEmpty) prompts.add(text);
    }

    return prompts;
  }

  /// Parses TXT format: each non-empty line is a prompt
  static List<String> parseTxt(String txtContent) {
    return txtContent
        .replaceAll('\r\n', '\n')
        .split('\n')
        .map((l) => l.trim())
        .where((l) => l.isNotEmpty)
        .toList();
  }
}
