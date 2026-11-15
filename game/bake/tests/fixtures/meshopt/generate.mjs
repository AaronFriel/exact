// Run with Bun; the second argument is a node_modules directory containing the pinned tools.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const modules = resolve(process.argv[2] || 'node_modules');
const { MeshoptEncoder: encoder, MeshoptDecoder: decoder } = await import(pathToFileURL(resolve(modules, 'meshoptimizer/index.module.js')));
await Promise.all([encoder.ready, decoder.ready]);
const work = resolve('target/issue660');
mkdirSync(work, { recursive: true });
const source = JSON.parse(readFileSync(resolve(here, '../crate.gltf')));
for (const key of ['materials', 'textures', 'images', 'samplers']) delete source[key];
for (const mesh of source.meshes) for (const p of mesh.primitives) delete p.material;
const input = resolve(work, 'cube.gltf');
writeFileSync(input, JSON.stringify(source));
const optimized = resolve(here, 'optimized.glb');
const cli = resolve(modules, '@gltf-transform/cli/bin/cli.js');
const run = spawnSync(process.execPath, [cli, 'optimize', input, optimized], { stdio: 'inherit' });
if (run.status !== 0) throw new Error(`optimize exited ${run.status}`);
const glb = readFileSync(optimized);
const jsonSize = glb.readUInt32LE(12);
const doc = JSON.parse(glb.subarray(20, 20 + jsonSize));
const bin = glb.subarray(28 + jsonSize);
if (!['EXT_meshopt_compression', 'KHR_mesh_quantization'].every(e => doc.extensionsRequired.includes(e))) throw new Error('fixture must require both extensions');
const cases = [];
function record(name, count, stride, mode, filter, encoded) {
  const expected = new Uint8Array(count * stride);
  decoder.decodeGltfBuffer(expected, count, stride, encoded, mode, filter);
  cases.push({ name, count, stride, mode, filter, encoded: Buffer.from(encoded).toString('hex'), expected: Buffer.from(expected).toString('hex') });
}
for (const [i, view] of doc.bufferViews.entries()) {
  const ext = view.extensions?.EXT_meshopt_compression;
  if (ext) record(`optimized-view-${i}`, ext.count, ext.byteStride, ext.mode, ext.filter || 'NONE', bin.subarray(ext.byteOffset || 0, (ext.byteOffset || 0) + ext.byteLength));
}
// Cross block and partial-group boundaries, with smooth, constant and noisy channels.
let seed = 660;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
for (const stride of [4, 12, 32, 256]) {
  const count = 273;
  const raw = new Uint8Array(count * stride);
  for (let i = 0; i < raw.length; i++) raw[i] = i % 4 === 0 ? random() >>> 24 : i % 4 === 1 ? (i / stride) & 255 : i % 4 === 2 ? 0 : i & 255;
  for (const version of [0, 1]) record(`vertex-v${version}-${stride}`, count, stride, 'ATTRIBUTES', 'NONE', encoder.encodeVertexBufferLevel(raw, count, stride, 3, version));
}
const vectors = new Float32Array(257 * 4);
for (let i = 0; i < vectors.length; i += 4) {
  const v = [0, 1, 2, 3].map(() => (random() / 0xffffffff) * 2 - 1);
  const length = Math.hypot(...v);
  vectors.set(v.map(x => x / length), i);
}
for (const stride of [4, 8]) {
  const raw = encoder.encodeFilterOct(vectors, 257, stride, stride === 4 ? 8 : 12);
  record(`oct-${stride}`, 257, stride, 'ATTRIBUTES', 'OCTAHEDRAL', encoder.encodeVertexBuffer(raw, 257, stride));
}
for (const [filter, raw, stride] of [
  ['QUATERNION', encoder.encodeFilterQuat(vectors, 257, 8, 12), 8],
  ['EXPONENTIAL', encoder.encodeFilterExp(vectors, 257, 16, 20), 16],
]) record(filter, 257, stride, 'ATTRIBUTES', filter, encoder.encodeVertexBuffer(raw, 257, stride));
for (const stride of [2, 4]) {
  const list = [];
  for (let i = 0; i < 90; i++) list.push(i, i + 1, i + 2, i + 2, i + 1, i + 3);
  list.push(400, 100, 900, 0, 1, 2, 9, 8, 7, 0, 1, 700);
  const indices = stride === 2 ? new Uint16Array(list) : new Uint32Array(list);
  const raw = new Uint8Array(indices.buffer);
  record(`triangles-${stride}`, list.length, stride, 'TRIANGLES', 'NONE', encoder.encodeIndexBuffer(raw, list.length, stride));
  record(`sequence-${stride}`, list.length, stride, 'INDICES', 'NONE', encoder.encodeIndexSequence(raw, list.length, stride));
}
const shorts = new Uint16Array(273 * 2);
for (let i = 0; i < shorts.length; i++) shorts[i] = (30000 + i * 7) & 65535;
record('vertex-v1-shorts', 273, 4, 'ATTRIBUTES', 'NONE', encoder.encodeVertexBufferLevel(new Uint8Array(shorts.buffer), 273, 4, 3, 1));
// meshoptimizer v0.25's upstream test vector for the older triangle codec.
const triangleV0 = new Uint8Array([0xe0, 0xf0, 0x10, 0xfe, 0xff, 0xf0, 0x0c, 0xff, 0x02, 0x02, 0x02, 0x00, 0x76, 0x87, 0x56, 0x67, 0x78, 0xa9, 0x86, 0x65, 0x89, 0x68, 0x98, 0x01, 0x69, 0x00, 0x00]);
record('triangles-v0', 12, 4, 'TRIANGLES', 'NONE', triangleV0);
writeFileSync(resolve(here, 'buffers.json'), JSON.stringify(cases) + '\n');
console.log(`${cases.length} npm decoder byte goldens written`);
