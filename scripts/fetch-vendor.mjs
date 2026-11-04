// vendor/ にライブラリを取得し、版とハッシュを vendor/VERSIONS.json に記録する。
// ネットにつながる PC で、版を上げるときだけ実行する。ビルドはネットを使わない。
//
//   node scripts/fetch-vendor.mjs          取得して VERSIONS.json を書き直す
//   node scripts/fetch-vendor.mjs --check  手元の vendor/ が VERSIONS.json と一致するか確かめる（ネット不要）
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
const MANIFEST = join(VENDOR, 'VERSIONS.json');

// 版を上げるときはここを書き換える。
const LIBS = [
  {
    name: 'jszip',
    version: '3.10.1',
    file: 'jszip.min.js',
    url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    license: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/LICENSE.markdown',
  },
  {
    // marked は v5 以降 marked.min.js が無く、UMD ビルドは lib/marked.umd.js。
    name: 'marked',
    version: '18.0.11',
    file: 'marked.umd.js',
    url: 'https://cdn.jsdelivr.net/npm/marked@18.0.11/lib/marked.umd.js',
    license: 'https://cdn.jsdelivr.net/npm/marked@18.0.11/LICENSE',
  },
  {
    name: 'mermaid',
    version: '11.17.2',
    file: 'mermaid.min.js',
    url: 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js',
    license: 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/LICENSE',
  },
  {
    name: 'dompurify',
    version: '3.4.17',
    file: 'purify.min.js',
    url: 'https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.min.js',
    license: 'https://cdn.jsdelivr.net/npm/dompurify@3.4.17/LICENSE',
  },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchAll() {
  await mkdir(join(VENDOR, 'licenses'), { recursive: true });
  const manifest = [];
  for (const lib of LIBS) {
    const body = await download(lib.url);
    const license = await download(lib.license);
    await writeFile(join(VENDOR, lib.file), body);
    await writeFile(join(VENDOR, 'licenses', `${lib.name}.txt`), license);
    manifest.push({ name: lib.name, version: lib.version, file: lib.file, url: lib.url, bytes: body.length, sha256: sha256(body) });
    console.log(`${lib.name}@${lib.version}  ${body.length} bytes`);
  }
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function check() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  let ok = true;
  for (const lib of manifest) {
    const actual = sha256(await readFile(join(VENDOR, lib.file)));
    const same = actual === lib.sha256;
    if (!same) ok = false;
    console.log(`${same ? 'OK ' : 'NG '} ${lib.name}@${lib.version}`);
  }
  if (!ok) process.exit(1);
}

await (process.argv.includes('--check') ? check() : fetchAll());
