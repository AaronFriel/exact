import { expect, test } from 'bun:test';
import { proveTerrain, sectionsDrawn } from './proof.mjs';

test('a terrain timeout names the remaining sections', async () => {
  let advances = 0;
  await expect(proveTerrain({
    async target() { return { id: 1, world: true }; },
    async find() { return { id: 2 }; },
    async clock(step) {
      expect(step).toBe('+16');
      advances++;
    },
    async op() { return { world: { readyReasons: ['72 sections pending'] } }; },
  }, () => {})).rejects.toThrow('Terrain did not present after 45 advances: 72 sections pending');
  expect(advances).toBe(45);
});

test('all sampled frames must draw the pinned sections', async () => {
  const run = async (itemsDrawn) => {
    const steps = [];
    const failures = [];
    await proveTerrain({
      async target() { return { id: 1 }; },
      async find() { return null; },
      async clock(step) { steps.push(step); },
      async op(request) {
        expect(request.world).toBe(true);
        steps.push(request.perf_reset ? 'reset' : 'sample');
        return { world: { renderHooks: { frame: { items: 'sections', itemsDrawn } } } };
      },
    }, (label, ok) => {
      if (!ok) failures.push(label);
    });
    expect(steps).toEqual(['reset', '+16', 'sample']);
    return failures;
  };
  const pinned = { max: sectionsDrawn, mean: sectionsDrawn };
  expect(await run({ count: 1, ...pinned })).toEqual([]);
  expect(await run({ count: 3, ...pinned })).toEqual([]);
  expect(await run({ count: 0, max: 0, mean: 0 })).toContain('at least one itemsDrawn sample after perf reset');
  expect(await run({ count: 2, ...pinned, max: sectionsDrawn + 1 })).toEqual([`itemsDrawn maximum is ${sectionsDrawn} sections`]);
  expect(await run({ count: 2, ...pinned, mean: sectionsDrawn - 0.5 })).toEqual([`itemsDrawn mean is ${sectionsDrawn} sections`]);
});
