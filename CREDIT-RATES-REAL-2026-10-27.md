# REAL Flow credit rates — owner's live Flow panel screenshots, 2026-10-27

Source: 11 screenshots Aslam took himself from the Google Flow generation
panel (Ingredients mode, 9:16, x1 output). These are Flow's own prices,
not estimates.

## Omni 1.1 Flash — Ingredients mode
| Duration | 360p | 720p |
|----------|------|------|
| 4s       | 4    | 7    |
| 6s       | 5    | 10   |
| 8s       | 6    | 12   |
| 10s      | 7    | 15   |

## Veo 3.1 — 720p · 8s (panel locks these for Veo in his UI)
| Model        | Credits |
|--------------|---------|
| Veo 3.1 Lite | 10      |
| Veo 3.1 Fast | 20      |
| Veo 3.1 Quality | 100  |

## What the app currently believes (BOTH wrong — verified 2026-10-27)
- `lib/services/credit_costs.dart` (Generate-bar estimate, v2.34.0):
  Quality 100 ✓ · Fast 15/20/**25**/30 (real 8s = 20) · Lite 7/10/**12**/15
  (real 8s = 10 — this row is actually Omni's 720p row) · Omni 4/6/8/10
  ("1 credit/second" — matches NO real row; real 360p is 4/5/6/7).
  The table has NO resolution dimension at all, but real cost depends
  on 360p vs 720p.
- `engine/flowAutomation.js getRequiredCredits()` mirrors the same
  numbers; its Omni "premium/Ingredients" row (7/10/12/15) is really
  the 720p row, and its plain row (4/6/8/10) is extrapolated from a
  single verified 4s=4 data point (2026-10-11).

## Owner clarification (2026-10-27 15:58)
- **Veo models have NO duration choice — Veo videos are always 8s.**
  Only Omni offers 4s/6s/8s/10s. So Veo = flat per-video rates at
  720p·8s: Lite 10 · Fast 20 · Quality 100. No missing Veo data.

## Still missing (do NOT invent)
- Omni plain text-to-video (no Ingredients) at 6s/8s/10s, both resolutions
- 16:9 rates (screenshots were 9:16; assumed same until evidenced)

## Quality behavior (owner, 2026-10-27 16:03) + verified gap
- Flow rule (owner's words, matches the panel): the generation choice
  fixes the ORIGINAL quality — 360p generation = 360p original file;
  downloading "enhanced" steps it up once (360p→720p, 720p→1080p).
  Higher options beyond that are paid-plan only.
- VERIFIED GAP in the app: `configureGenerationSettings()` applies
  mode → sub-mode → model → aspect → duration → outputs, but NEVER
  selects the panel's 360p/720p resolution. The panel keeps whatever
  was last clicked manually, so generations (and real credit charges)
  can run at 720p while the app setting says 360p. The app's Quality
  setting today steers ONLY the download-menu pick
  (`_nativePickResolution`: 360p→"360p", 720p→"720p"/"original",
  1080p→"1080p").
- Fix: Quality drives all three together — (1) engine selects the
  panel resolution before generating (same verified-click pattern as
  model/duration), (2) the credit estimate/total uses that resolution,
  (3) download follows: 360p→360p original, 720p→720p original,
  1080p (enhanced)→generate 720p, download the enhanced 1080p item
  (warn, never silently substitute, if the item is plan-gated/absent).

## Fix spec (next version)
Replace both tables with the real one, keyed by model × resolution ×
duration; Generate bar shows the exact total for N prompts
(per-video × count); engine ledger/rotation uses the same table.
Combos with no evidenced rate show NO estimate (never a fake number).
