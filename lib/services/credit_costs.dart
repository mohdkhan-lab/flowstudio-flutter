// FlowStudio Lite — real per-video credit costs (owner's own
// Flow panel, verified 2026-10-27).
//
// The Generate bar used to estimate `promptCount × 7` — a
// hardcoded multiplier the owner correctly called fake. The
// v2.34.0 model+duration table was no better: its Omni row
// claimed "1 credit per second" (4/6/8/10) and its Veo rows
// (Fast 15/20/25/30, Lite 7/10/12/15) matched nothing real —
// the owner proved it with screenshots of Flow's own panel
// (CREDIT-RATES-REAL-2026-10-27.md). The REAL cost of one video
// depends on the MODEL, the DURATION and the generation
// RESOLUTION, which follows the Quality setting:
//
//   Quality setting -> generation resolution
//     '360p' -> 360p · '720p' -> 720p · '1080p' -> 720p
//     (1080p is an enhanced DOWNLOAD of a 720p generation,
//     never a generation resolution)
//
//   Omni Flash, 360p ... 4s=4, 6s=5, 8s=6, 10s=7
//   Omni Flash, 720p ... 4s=7, 6s=10, 8s=12, 10s=15
//   Veo 3.1 Lite ....... 10 per video (Veo is always 8s —
//   Veo 3.1 Fast ....... 20 per video  Flow offers no Veo
//   Veo 3.1 Quality .... 100 per video duration choice)
//
// Evidence: the owner's screenshots of the live Flow generation
// panel (Ingredients mode, 9:16, x1 output), 2026-10-27. The
// same table lives in the engine (engine/flowAutomation.js
// getRequiredCredits — the table the run's own credit checks
// use). Any combination NOT in this table returns null — the
// bar then shows the prompt count with NO estimate rather than
// printing a confident fake number.

/// The resolution Flow will actually generate at for a Quality
/// setting: 1080p is an enhanced download, never a generation
/// resolution, so the '1080p' setting generates at 720p.
String generationResolution(String quality) {
  final q = quality.trim().toLowerCase();
  return (q.contains('720') || q.contains('1080')) ? '720p' : '360p';
}

/// Credits for ONE video of [model] at [duration] (e.g. '4s')
/// under the Quality setting [quality], or null when the
/// combination has no evidenced rate.
int? creditCostPerVideo(String model, String duration, String quality) {
  final m = model.toLowerCase();
  final d = duration.trim().toLowerCase();
  // Veo models have no duration choice — a Veo video is always
  // 8s — so their rates are flat per video, at any duration.
  if (m.contains('quality')) return 100;
  if (m.contains('fast')) return 20;
  if (m.contains('lite')) return 10;
  if (m.contains('omni') || m.contains('flash')) {
    if (generationResolution(quality) == '720p') {
      return switch (d) {
        '4s' => 7,
        '6s' => 10,
        '8s' => 12,
        '10s' => 15,
        _ => null,
      };
    }
    return switch (d) {
      '4s' => 4,
      '6s' => 5,
      '8s' => 6,
      '10s' => 7,
      _ => null,
    };
  }
  return null;
}

/// The estimate fragment for the Generate bar —
/// "est. N credits" — or null when the rate is unknown (the bar
/// prints no estimate at all in that case; never a fake number).
String? creditEstimateText({
  required String model,
  required String duration,
  required String quality,
  required int promptCount,
}) {
  final per = creditCostPerVideo(model, duration, quality);
  if (per == null) return null;
  final total = per * promptCount;
  return 'est. $total credit${total == 1 ? '' : 's'}';
}
