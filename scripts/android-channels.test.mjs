// An Android app's notification resources (LLP 1133.004.000 D1, D3; `android-channels.mjs`): the channel list, its
// strings per table, its sounds, and the small icon's pixels.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { androidNotificationResources, resourceText, valuesDirectory } from './android-channels.mjs';
import { readPng } from './app-icons.mjs';
import { encodePng } from './png.mjs';

const inDir = (body) => { const dir = mkdtempSync(resolve(tmpdir(), 'exact-android-channels-')); try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const files = (res) => existsSync(res) ? readdirSync(res, { recursive: true }).filter((path) => statSync(resolve(res, path)).isFile()).sort() : [];
const pixel = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

test('declared channels become a list, strings per table and raw sounds, with the default table as values', () => inDir((dir) => {
  mkdirSync(resolve(dir, 'assets'));
  writeFileSync(resolve(dir, 'assets/Alert.WAV'), 'RIFF');
  const res = resolve(dir, 'res');
  const channels = [
    { id: 'urgencies', name: { en: 'Urgencies', 'pt-BR': 'Urgências' }, description: { en: "Alerts 'now'", 'pt-BR': 'Alertas' }, importance: 'high', sound: 'assets/Alert.WAV' },
    { id: 'news', name: { en: '@news' }, description: null, importance: 'low', sound: null },
  ];
  assert.deepEqual(androidNotificationResources({}, dir, res, { channels, locales: ['en', 'pt-BR'], base: 'en' }), { icon: false });
  assert.deepEqual(files(res), ['raw/exact_channel_urgencies.wav', 'values-b+pt+BR/exact_channels.xml', 'values/exact_channels.xml', 'xml/exact_channels.xml']);
  assert.equal(readFileSync(resolve(res, 'xml/exact_channels.xml'), 'utf8'), [
    '<channels>',
    '    <channel id="urgencies" importance="high" name="@string/exact_channel_urgencies_name" description="@string/exact_channel_urgencies_description" sound="@raw/exact_channel_urgencies" />',
    '    <channel id="news" importance="low" name="@string/exact_channel_news_name" />',
    '</channels>', ''].join('\n'));
  assert.equal(readFileSync(resolve(res, 'values/exact_channels.xml'), 'utf8'), [
    '<resources>',
    '    <string name="exact_channel_urgencies_name">Urgencies</string>',
    '    <string name="exact_channel_urgencies_description">Alerts \\\'now\\\'</string>',
    '    <string name="exact_channel_news_name">\\@news</string>',
    '</resources>', ''].join('\n'));
  // A table that lacks a text has the base table's.
  assert.match(readFileSync(resolve(res, 'values-b+pt+BR/exact_channels.xml'), 'utf8'), /exact_channel_news_name">\\@news</);

  // An app that grants no notifications has none of it, and what a previous build wrote is gone.
  assert.equal(androidNotificationResources({}, dir, res, { channels: undefined }), null);
  assert.deepEqual(files(res), []);
}));

test('the small icon is the monochrome glyph trimmed into 22 of 24 dp per density, drawn white by its alpha', () => inDir((dir) => {
  // A 432 px glyph whose opaque part is a 100 × 50 bar off centre, half transparent at its right end.
  const [w, h] = [432, 432], data = Buffer.alloc(w * h * 4);
  for (let y = 300; y < 350; y++) for (let x = 20; x < 120; x++) data.set([10, 20, 30, x >= 110 ? 128 : 255], (y * w + x) * 4);
  mkdirSync(resolve(dir, 'assets'));
  writeFileSync(resolve(dir, 'assets/mono.png'), encodePng({ width: w, height: h, data }));
  const res = resolve(dir, 'res');
  const manifest = { icons: [{ src: 'assets/mono.png', sizes: '432x432', purpose: 'monochrome' }] };
  assert.deepEqual(androidNotificationResources(manifest, dir, res, { channels: [], base: 'en' }), { icon: true });
  assert.deepEqual(files(res), ['drawable-hdpi/exact_notification.png', 'drawable-mdpi/exact_notification.png', 'drawable-xhdpi/exact_notification.png',
    'drawable-xxhdpi/exact_notification.png', 'drawable-xxxhdpi/exact_notification.png', 'xml/exact_channels.xml']);
  const icon = readPng(resolve(res, 'drawable-xxxhdpi/exact_notification.png'));
  assert.deepEqual([icon.width, icon.height], [96, 96]);
  // 88 px wide (22 of 24 dp), 44 tall, centred: columns 4 to 91, rows 26 to 69.
  assert.deepEqual([pixel(icon, 3, 48)[3], pixel(icon, 4, 48), pixel(icon, 48, 25)[3], pixel(icon, 48, 26)], [0, [255, 255, 255, 255], 0, [255, 255, 255, 255]]);
  assert.ok(pixel(icon, 90, 48)[3] < 255 && pixel(icon, 90, 48)[3] > 0);
}));

test('a strings table goes to its resource directory, and its text escapes as the resource compiler reads it', () => {
  assert.deepEqual(['en', 'es', 'pt-BR', 'zh-Hant-TW'].map((t) => valuesDirectory(t, 'en')), ['values', 'values-es', 'values-b+pt+BR', 'values-b+zh+Hant+TW']);
  assert.equal(resourceText(`<a & "b"> \\ ?q`), '&lt;a &amp; \\"b\\"> \\\\ ?q');
  assert.equal(resourceText('?q'), '\\?q');
});
