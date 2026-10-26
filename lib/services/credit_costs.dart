// FlowStudio Lite — real per-video credit costs (v2.34.0,
// owner's Problem 10).
//
// The Generate bar used to estimate `promptCount × 7` — a
// hardcoded multiplier the owner correctly called fake: the real
// cost of one video depends on the MODEL and the DURATION. This
// table mirrors the engine's own per-video cost knowledge
// (engine/flowAutomation.js getRequiredCredits — the same table
// the run's Progress cards charge by):
//
//   Veo 3.1 Quality .... 100 per video (flat, any duration)
//   Veo 3.1 Fast ....... 4s=15, 6s=20, 8s=25, 10s=30
//   Veo 3.1 Lite ....... 4s=7, 6s=10, 8s=12, 10s=15
//   Omni Flash ......... 4s=4, 6s=6, 8s=8, 10s=10  (1 credit/second)
//
// Omni Flash live evidence: the owner's runs at 4s charge exactly
// 4 credits per video (verified across many live runs and the
// stats ledger). Any model/duration combination NOT in this
// table returns null — the bar then shows the prompt count with
// NO estimate rather than printing a confident fake number.

/// Credits for ONE video of [model] at [duration] (e.g. '4s'),
/// or null when the combination has no evidenced rate.
int? creditCostPerVideo(String model, String duration) {
  final m = model.toLowerCase();
  final d = duration.trim().toLowerCase();
  if (m.contains('quality')) return 100;
  if (m.contains('fast')) {
    return switch (d) {
      '4s' => 15,
      '6s' => 20,
      '8s' => 25,
      '10s' => 30,
      _ => null,
    };
  }
  if (m.contains('lite')) {
    return switch (d) {
      '4s' => 7,
      '6s' => 10,
      '8s' => 12,
      '10s' => 15,
      _ => null,
    };
  }
  if (m.contains('omni') || m.contains('flash')) {
    // Omni Flash bills 1 credit per second of video.
    return switch (d) {
      '4s' => 4,
      '6s' => 6,
      '8s' => 8,
      '10s' => 10,
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
  required int promptCount,
}) {
  final per = creditCostPerVideo(model, duration);
  if (per == null) return null;
  final total = per * promptCount;
  return 'est. $total credit${total == 1 ? '' : 's'}';
}
