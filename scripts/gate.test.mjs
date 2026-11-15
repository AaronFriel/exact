import { expect, test } from 'bun:test';
import { runGate } from './gate.mjs';

test('all parts run after command failures, including a missing executable', async () => {
  const parts = [['fmt', 'sh', ['-c', 'echo first; exit 3']], ['caps', '/no/such/exact-gate-command', []],
    ['check', 'sh', ['-c', 'echo checked; exit 4']], ['unit', 'sh', ['-c', 'echo tested']]];
  const lines = [], result = await runGate({ parts, budget: 30, report: line => lines.push(line) });
  expect(result.status).toBe(1);
  expect(result.parts.map(p => p.name).sort()).toEqual(['caps', 'check', 'fmt', 'unit']);
  expect(result.failed.sort()).toEqual(['caps', 'check', 'fmt']);
  expect(lines.join('\n')).toContain('tested');
});

test('a slow run reports every part and a budget failure without cutting off tests', async () => {
  let elapsed = 0;
  const result = await runGate({ parts: [['check', 'cargo', []], ['unit', 'cargo', []]], budget: 30, now: () => elapsed,
    run: async () => { elapsed += 16000; return { status: 0 }; }, report: () => {} });
  expect(result.seconds).toBe(32);
  expect(result.failed).toEqual([]);
  expect(result.over).toBe(true);
  expect(result.status).toBe(1);
});
