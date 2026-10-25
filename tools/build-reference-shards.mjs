// Keep the source JSON for export; runtime readers load only one small shard.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'data/references.json'));
const references = JSON.parse(source.toString('utf8').replace(/^\uFEFF/, ''));
const shards = Array.from({ length: 256 }, () => ({}));
for (const [lawId, value] of Object.entries(references)) {
  let hash = 2166136261;
  for (let i = 0; i < lawId.length; i++) hash = Math.imul(hash ^ lawId.charCodeAt(i), 16777619);
  shards[(hash >>> 0) & 255][lawId] = value;
}
const destination = path.join(root, 'data/reference-shards');
await fs.mkdir(destination, { recursive: true });
const manifest = { sourceSha256: createHash('sha256').update(source).digest('hex'), shards: {} };
for (let i = 0; i < shards.length; i++) {
  const name = i.toString(16).padStart(2, '0');
  const text = JSON.stringify(shards[i]);
  await fs.writeFile(path.join(destination, `${name}.json`), text);
  manifest.shards[name] = createHash('sha256').update(text).digest('hex');
}
await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built 256 reference shards for ${Object.keys(references).length} laws.`);
