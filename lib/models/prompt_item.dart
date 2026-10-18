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
  String? error;

  PromptItem({
    required this.index,
    required this.text,
    this.status = PromptStatus.pending,
    this.progress = 0.0,
    this.videoUrl,
    this.localFilePath,
    this.assignedAccountId,
    this.error,
  });

  PromptItem copyWith({
    int? index,
    String? text,
    PromptStatus? status,
    double? progress,
    String? videoUrl,
    String? localFilePath,
    String? assignedAccountId,
    String? error,
  }) {
    return PromptItem(
      index: index ?? this.index,
      text: text ?? this.text,
      status: status ?? this.status,
      progress: progress ?? this.progress,
      videoUrl: videoUrl ?? this.videoUrl,
      localFilePath: localFilePath ?? this.localFilePath,
      assignedAccountId: assignedAccountId ?? this.assignedAccountId,
      error: error ?? this.error,
    );
  }
}
