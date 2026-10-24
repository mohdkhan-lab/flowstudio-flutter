enum PromptStatus {
  pending,
  queued,
  generating,
  downloading,
  completed,
  failed,
}

class PromptItem {
  final int index;
  final String text;
  PromptStatus status;
  double progress;
  String? videoUrl;
  String? localFilePath;
  String? assignedAccountId;
  // v2.27.0: display name of the account that made this video (from the
  // engine's video-completed event) + the real saved file name, so the
  // Progress cards can show them like the approved design does.
  String? accountName;
  String? outputFileName;
  String? error;
  // v2.29.0: the REAL credit cost of this video, from the engine's
  // video-completed payload (the card hardcoded "7 credits" before).
  // Null when the engine did not report one — the card then shows no
  // credit figure at all instead of an invented one.
  int? creditsUsed;

  PromptItem({
    required this.index,
    required this.text,
    this.status = PromptStatus.pending,
    this.progress = 0.0,
    this.videoUrl,
    this.localFilePath,
    this.assignedAccountId,
    this.accountName,
    this.outputFileName,
    this.error,
    this.creditsUsed,
  });

  PromptItem copyWith({
    int? index,
    String? text,
    PromptStatus? status,
    double? progress,
    String? videoUrl,
    String? localFilePath,
    String? assignedAccountId,
    String? accountName,
    String? outputFileName,
    String? error,
    int? creditsUsed,
  }) {
    return PromptItem(
      index: index ?? this.index,
      text: text ?? this.text,
      status: status ?? this.status,
      progress: progress ?? this.progress,
      videoUrl: videoUrl ?? this.videoUrl,
      localFilePath: localFilePath ?? this.localFilePath,
      assignedAccountId: assignedAccountId ?? this.assignedAccountId,
      accountName: accountName ?? this.accountName,
      outputFileName: outputFileName ?? this.outputFileName,
      error: error ?? this.error,
      creditsUsed: creditsUsed ?? this.creditsUsed,
    );
  }
}
