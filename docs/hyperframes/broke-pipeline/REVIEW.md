# Review: Drop the baggage — Precision Telemetry Edition

## Creative decisions

- Upgraded the 3-act problem → physical compression → measured proof film into
  a tactile **Precision Telemetry** instrument sequence aligned with `DESIGN.md`:
  - **Act I (`hook.html`, 0–3.2 s):** Opens on a readable first frame ("Your AI
    has baggage.") with a framed context payload stack (`351,403 CHARS QUEUED` on
    Turn #67). Recognizable coral bloat slabs (`test output · 48 KB`,
    `compiler log · 64 KB`, `old tool output · 82 KB`) slam in with horizontal
    motion blur (`expo.out`) and drive the bottom pressure gauge before clamping
    into the compression chamber at 2.95–3.2 s.
  - **Act II (`pipeline.html`, 3.2–8.2 s):** Demonstrates the `01 Clean → 02 Trim · default`
    pipeline and protection boundary. `✓ First request · PROTECTED` and
    `✓ Recent turns · PROTECTED` hold their exact dimensions while only the
    older-context core crushes vertically (`scaleY: 1 → 0.46`, `-32.2%`) and
    flips from coral to mint. Stored task history stays explicitly unchanged.
    At 8.02–8.2 s, a solid mint radial iris flood expands directly out of the
    compressed block to form the ground of Act III.
  - **Act III (`proof.html`, 8.2–14 s):** Lands on the full-bleed mint proof
    stage (`32.2% less context.`) with an explicit `Synthetic benchmark · default mode`
    qualifier (`351,403 → 238,333 characters`) and a self-explanatory evidence
    card showing three labeled proportional comparison bars:
    `BEFORE (351,403 chars)`, `DEFAULT (-32.2%, 238,333 chars)`, and
    `OLLAMA OPT (-89.7%, 36,140 chars)`.
- Kept the landscape 1920 × 1080 format and silent 14-second loop. No product
  interface is fabricated, and no speculative billing-savings claims are made.

## Evidence, 2026-10-29

- `npm run bench`: deterministic 67-message synthetic session (351,403 input
  characters):
  - Default `truncate` mode: 238,333 output characters (113,070 removed, 32.2%).
  - Optional `summarize` mode: 36,140 output characters (315,263 removed, 89.7%).
- HyperFrames 0.8.185 full check: zero lint, runtime, layout, motion, contrast
  or craft findings across 9 layout samples, 281 motion samples, 112 craft
  samples, and 76/76 passing WCAG AA contrast checks.
- Visually reviewed all six beat frames, both five-frame cut strips, and the
  360-pixel-wide phone contact sheet (`snapshot --review`). Every comparison bar
  carries its own label and character count; no P0 or P1 visual issues remain.
- Repository documentation (`npm run check:docs`) and tracked-file
  (`npm run check:files`) gates pass.

## Intentional limits

- The protected-message compression chamber in Act II is schematic; the three
  horizontal bars in Act III use the exact measured character ratios (`1.0`,
  `238333 / 351403`, and `36140 / 351403`).
- Sound is intentionally absent for a 14-second README loop.

## Reproduce the delivery

From this directory, use the pinned project script:

```powershell
npm run check
npx --yes hyperframes@0.8.185 snapshot --review
npm run render -- --quality delivery --fps 30 --workers 2 --output ../../assets/broke-pipeline.mp4
ffmpeg -y -i ../../assets/broke-pipeline.mp4 -filter_complex "fps=15,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" -loop 0 ../../assets/broke-pipeline.gif
ffmpeg -y -ss 11.1 -i ../../assets/broke-pipeline.mp4 -frames:v 1 -update 1 ../../assets/broke-pipeline-poster.png
```
