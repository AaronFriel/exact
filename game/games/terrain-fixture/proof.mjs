#!/usr/bin/env bun
import { resolve } from 'node:path';
import { proof } from '../../proof.mjs';
import logic from './logic/src/lib.rs' with { type: 'text' };

const [, width, height] = logic.match(/^pub const VIEWPORT: \[u32; 2\] = \[(\d+), (\d+)\];$/m);
export const sectionsDrawn = Number(logic.match(/^pub const SECTIONS_DRAWN: usize = (\d+);$/m)[1]);
const advanceLimit = 45;

export async function proveTerrain(session, check) {
  const request = { op: 'state', ...await session.target('world'), world: true };
  for (let advances = 0; await session.find('terrain-pending', false, false); advances++) {
    if (advances === advanceLimit) {
      const { world } = await session.op(request);
      const pending = world?.readyReasons?.join(', ') || 'section backlog unavailable';
      throw new Error(`Terrain did not present after ${advanceLimit} advances: ${pending}`);
    }
    await session.clock('+16');
  }
  check(`terrain presents within ${advanceLimit} advances`, true);
  await session.op({ ...request, perf_reset: true });
  await session.clock('+16');
  const { world } = await session.op(request);
  const frame = world?.renderHooks?.frame;
  const samples = frame?.itemsDrawn;
  check('the hook frame report names sections', frame?.items === 'sections', frame?.items);
  check('at least one itemsDrawn sample after perf reset', samples?.count > 0, samples);
  check(`itemsDrawn maximum is ${sectionsDrawn} sections`, samples?.max === sectionsDrawn, samples?.max);
  check(`itemsDrawn mean is ${sectionsDrawn} sections`, samples?.mean === sectionsDrawn, samples?.mean);
}

if (import.meta.main) await proof(import.meta, async ({ pin, pinSave, open, check, host, out }) => {
  const env = { EXACT_SCALE: '1' };
  if (host === 'linux') {
    env.EXACT_GPU_RENDER = '1';
    // The bake joins shader preludes under .shells/shaders, where the host can verify the packaged bytes.
    env.EXACT_ASSETS = resolve(process.env.EXACT_APP_DIR, '.shells');
  }
  const session = await open({ size: [Number(width), Number(height)], env });
  await session.tap('play');
  const { clock } = await session.clock('+0');
  await proveTerrain(session, check);

  // Presentation can finish after a different number of advances on each host.
  await session.clock(clock + 1000);
  const world = session.world('world');
  pin(60, await world.snapshot());
  const save = resolve(out, 'terrain-60.world');
  await world.save(save);
  pinSave('continuation', save);
});
