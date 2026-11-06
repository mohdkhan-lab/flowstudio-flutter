# Omni Flash 1.2 — official credit rates (Google Flow support page, verified 2026-11-06)

Source: Google's official Flow support page (checked directly by MK,
2026-11-06). Omni Flash 1.2 is billed **per second**, unlike Omni 1.1's
flat per-duration table (see CREDIT-RATES-REAL-2026-10-27.md). Clips run
**3–15s in 1s steps** in Flow; the 11–15s segment is billed at a higher
per-second rate (and on Google's side is limited to AI Plus/Pro/Ultra
subscribers — free pool accounts are capped at 10s by Flow itself).

## Omni Flash 1.2 — per-second billing

| Resolution | Seconds 1–10 | Seconds 11–15 |
|------------|--------------|---------------|
| 360p       | 1 credit/sec | 2 credits/sec |
| 720p       | 3 credits/sec | 6 credits/sec |

Totals: total(n) = n × base for n ≤ 10; 10 × base + (n − 10) × extra
for 11 ≤ n ≤ 15.

| Duration | 360p | 720p |
|----------|------|------|
| 4s       | 4    | 12   |
| 8s       | 8    | 24   |
| 10s      | 10   | 30   |
| 15s      | 20   | 60   |

## App wiring (v2.48.59)
- Model added as **'Omni 1.2 Flash'** (selectable everywhere the model
  list lives). The **default stays 'Omni Flash' (Omni 1.1)** — the owner
  keeps testing on 1.1; 1.2 is opt-in per run.
- Duration list gains **'15s'**. Only 1.2 has an evidenced 15s rate —
  the Dart estimate returns null for any other model at 15s (no fake
  numbers); the engine keeps its existing fallback there.
- Both credit tables implement the formula above:
  `lib/services/credit_costs.dart` (`creditCostPerVideo`) and
  `engine/flowAutomation.js` (`getRequiredCredits`, via the pure
  `omni12CreditsPerVideo` helper).
- Note: **Omni Flash 1.1, Veo 3.1 Fast and Veo 3.1 Quality retire on
  5 Dec 2026** (same support page) — after that only 1.2 + Veo Lite
  remain in Flow. No app change needed for that here.
