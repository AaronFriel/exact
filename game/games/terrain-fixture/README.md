# Terrain fixture

This fixture exercises hook readiness and frame counters end to end with a
seeded heightfield and a fixed camera (LLP 1182.000 D4a). The render hook meshes
up to 64 of the window's 2,312 section addresses per prepare call and submits one
indexed draw per visible section with exposed terrain. The logic test counts
those sections independently by testing each section's eight corners.

On a Mac with Metal and Chrome with WebGPU, record the first tick and save
baseline from the repository root with `bun game/prove.mjs terrain-fixture --hosts linux,web`.
Check the recorded baseline with `bun game/games/terrain-fixture/proof.mjs web`
and `bun game/games/terrain-fixture/proof.mjs linux`.

Both proofs use the shared game harness and a 1280 × 720 viewport. The Linux
leg enables the GPU-backed agent and reads the bake's shader pack. Each leg
allows up to 45 clock advances for the terrain to present, then resets perf
and advances once. The hook must report at least one sample, with `itemsDrawn`
maximum and mean both equal to the 823 sections pinned in the logic crate.

The fixture decides nothing in LLP 1182.000 §6.
