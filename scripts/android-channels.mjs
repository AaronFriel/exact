// An Android app's notification resources (LLP 1133.004.000 D1, D3), written under `res` for the Gradle shell: the
// channels the bake resolved (`reach.androidChannels`, `bake/src/channels.rs`) as a list the host reads
// (`xml/exact_channels.xml`, `Channels.kt`), their names and descriptions as string resources per strings table,
// their sounds in `res/raw`, and the status bar's small icon from the manifest's `monochrome` icon.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { pickIcon, placeRgba, readPng, resize } from './app-icons.mjs';
import { encodePng } from './png.mjs';

/** The small icon's densities: 24 dp at each, as Material sizes a status bar icon. */
const DENSITIES = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };

/** The resource directory a strings table's BCP 47 tag goes to: the base table is the default (`values`), a bare
 * language its own (`values-es`), and anything more Android's BCP 47 form (`values-b+pt+BR`). */
export function valuesDirectory(tag, base) {
  if (tag === base) return 'values';
  return /^[a-z]{2,3}$/.test(tag) ? `values-${tag}` : `values-b+${tag.split('-').join('+')}`;
}

/** A string resource's text: XML's escapes, then the resource compiler's own (a backslash, quotes, `@` or `?`
 * leading). */
export const resourceText = (v) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('\\', '\\\\')
  .replaceAll("'", "\\'").replaceAll('"', '\\"').replace(/^([@?])/, '\\$1');

/** The small icon (D3): the `monochrome` glyph, its transparent margin trimmed, fitted into Material's 22 dp live
 * area of a 24 dp square at each density. Null when the manifest has none. */
export function notificationIcon(manifest, dir) {
  const glyph = pickIcon(manifest, dir, { formats: ['png'], native: false, purposes: ['monochrome'], px: 96, glyph: true, name: "Android's notification icon" });
  if (!glyph) return null;
  const image = readPng(glyph.path);
  let [left, top, right, bottom] = [image.width, image.height, -1, -1];
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < 0) return null;
  const [w, h] = [right - left + 1, bottom - top + 1], trimmed = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) trimmed.data.set(image.data.subarray(((top + y) * image.width + left) * 4, ((top + y) * image.width + left + w) * 4), y * w * 4);
  return Object.fromEntries(Object.entries(DENSITIES).map(([density, px]) => {
    // Shrunk only: a glyph smaller than the live area keeps its size.
    const live = (px * 22) / 24, scale = Math.min(live / w, live / h, 1);
    const [sw, sh] = [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
    // The glyph's alpha drawn white: Android draws a small icon by its alpha alone.
    const placed = placeRgba(px, px, resize(trimmed, sw, sh), Math.round((px - sw) / 2), Math.round((px - sh) / 2));
    for (let i = 0; i < placed.data.length; i += 4) placed.data.fill(255, i, i + 3);
    return [density, placed];
  }));
}

/** Writes the notification resources under `res` (emptied first) and returns what the build says: `null` when the
 * app grants no notifications (`channels` absent), else `{ icon }`, whether the manifest gave a small icon. `channels`
 * is the bake's `reach.androidChannels`; `locales` and `base` its strings tables'. */
export function androidNotificationResources(manifest, dir, res, { channels, locales, base }) {
  rmSync(res, { recursive: true, force: true });
  if (!Array.isArray(channels)) return null;
  const write = (path, text) => { mkdirSync(dirname(resolve(res, path)), { recursive: true }); writeFileSync(resolve(res, path), text); };
  const strings = new Map();
  const items = channels.map((c) => {
    const name = `exact_channel_${c.id}`;
    for (const [field, texts] of [['name', c.name], ['description', c.description]]) {
      if (!texts) continue;
      for (const locale of locales ?? [base]) {
        const folder = valuesDirectory(locale, base);
        if (!strings.has(folder)) strings.set(folder, []);
        strings.get(folder).push(`    <string name="${name}_${field}">${resourceText(texts[locale] ?? texts[base])}</string>`);
      }
    }
    if (c.sound) {
      const raw = resolve(res, 'raw', `${name}${extname(c.sound).toLowerCase()}`);
      mkdirSync(dirname(raw), { recursive: true });
      copyFileSync(resolve(dir, c.sound), raw);
    }
    return `    <channel id="${c.id}" importance="${c.importance}" name="@string/${name}_name"` +
      (c.description ? ` description="@string/${name}_description"` : '') + (c.sound ? ` sound="@raw/${name}"` : '') + ' />';
  });
  for (const [folder, lines] of strings) write(`${folder}/exact_channels.xml`, `<resources>\n${lines.join('\n')}\n</resources>\n`);
  write('xml/exact_channels.xml', `<channels>\n${items.map((l) => `${l}\n`).join('')}</channels>\n`);
  const icon = notificationIcon(manifest, dir);
  if (icon) for (const [density, image] of Object.entries(icon)) {
    mkdirSync(resolve(res, `drawable-${density}`), { recursive: true });
    writeFileSync(resolve(res, `drawable-${density}`, 'exact_notification.png'), encodePng(image));
  }
  return { icon: !!icon };
}

/** The receiver that makes the channels again when the app is updated, with no session (D1), inside the manifest
 * fragment's `<application>`. */
export const CHANNELS_RECEIVER = [
  '        <receiver android:name="dev.exact.canvas.Channels$Replaced" android:exported="false">',
  '            <intent-filter>', '                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />', '            </intent-filter>',
  '        </receiver>',
];
