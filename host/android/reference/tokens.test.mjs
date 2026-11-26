import { expect, test } from 'bun:test';
import { metrics } from '../../../kernel/tables/schema.json';
import { rows } from './rows.json';
import { materialWeight } from './tokens.mjs';

test('only a whole font weight constant supplies a Material weight', () => {
  expect(materialWeight('FontWeight.Normal')).toBe(400);
  expect(materialWeight('FontWeight.Medium')).toBe(500);
  expect(materialWeight('FontWeight.Bold')).toBe(700);
  expect(materialWeight('FontWeight(FontWeight.Medium.weight + 100)')).toBeUndefined();
});

test.each([
  ['grouped-row-inset', 'ListItemStartPadding'],
  ['grouped-row-padding-end', 'ListItemEndPadding'],
])('%s has a Material cell traced to %s', (metric, name) => {
  expect(metrics.find(([key]) => key === metric)?.[6]).toBe(16);
  expect(rows[metric]).toEqual({ source: 'ListItem.kt', name });
});
