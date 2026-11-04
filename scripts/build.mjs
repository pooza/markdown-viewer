// src/viewer.html の <script src> をすべて中身に置き換え、1 枚の dist/markdown-viewer.html を作る。
// ネットは使わない。ライブラリは vendor/（scripts/fetch-vendor.mjs で取得済みのもの）を使う。
//
//   node scripts/build.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const VENDOR = join(ROOT, 'vendor');
export const OUTPUT = join(ROOT, 'dist', 'markdown-viewer.html');

// インラインの <script> の中に現れると HTML の解析が壊れる文字列
const UNSAFE_IN_SCRIPT = /<\/?script/i;

function gitRevision() {
  try {
    return execFileSync('git', ['describe', '--always', '--dirty'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch (_e) {
    return 'unknown';
  }
}

async function loadVendor() {
  const manifest = JSON.parse(await readFile(join(VENDOR, 'VERSIONS.json'), 'utf8'));
  for (const lib of manifest) {
    const body = await readFile(join(VENDOR, lib.file));
    const hash = createHash('sha256').update(body).digest('hex');
    if (hash !== lib.sha256)
      throw new Error(
        `vendor/${lib.file} が VERSIONS.json と一致しません（${lib.name}@${lib.version}）`,
      );
  }
  return manifest;
}

function assertSafe(text, label) {
  if (UNSAFE_IN_SCRIPT.test(text))
    throw new Error(
      `${label} に "<script" または "</script" が含まれていて、そのままでは埋め込めません`,
    );
}

// 埋め込んだライブラリの中にも "</body>" という文字列があるので、必ず最後のものの前に差し込む
export function insertBeforeBodyEnd(html, text) {
  const at = html.lastIndexOf('</body>');
  if (at < 0) throw new Error('</body> がありません');
  return html.slice(0, at) + text + html.slice(at);
}

export async function build() {
  const manifest = await loadVendor();
  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  const libs = manifest.map((l) => `${l.name} ${l.version}`).join(', ');
  const buildInfo = `v${version} ${today} (${gitRevision()}) / ${libs}`;

  let html = await readFile(join(SRC, 'viewer.html'), 'utf8');
  html = html.replaceAll('{{BUILD}}', buildInfo);

  // 置き換えはテンプレートに対して一度に行う（埋め込んだ中身を再び検索しないように）
  const SCRIPT_TAG = /<script src="([^"]+)"><\/script>/g;
  const bodies = new Map();
  for (const [, src] of html.matchAll(SCRIPT_TAG)) {
    const body = (await readFile(resolve(SRC, src), 'utf8')).replace(
      /\n\/\/# sourceMappingURL=\S+\s*$/,
      '\n',
    );
    assertSafe(body, src);
    bodies.set(src, body);
  }
  html = html.replace(
    SCRIPT_TAG,
    (_tag, src) => `<script>\n/* ${src.replace(/^\.\.\//, '')} */\n${bodies.get(src)}\n</script>`,
  );

  const licenseTexts = [];
  for (const lib of manifest) {
    const text = await readFile(join(VENDOR, 'licenses', `${lib.name}.txt`), 'utf8');
    licenseTexts.push(`==== ${lib.name} ${lib.version} ====\n\n${text.trim()}\n`);
  }
  const licenses = licenseTexts.join('\n');
  assertSafe(licenses, 'ライセンス文');
  html = insertBeforeBodyEnd(
    html,
    `    <script type="text/plain" id="third-party-licenses">\n${licenses}</script>\n`,
  );

  // 外へ取りに行く参照が残っていないこと（オフラインで動くこと）を確かめる
  if (/<script[^>]*\ssrc=/i.test(html)) throw new Error('外部 script の参照が残っています');
  if (/<link[^>]*\shref=/i.test(html)) throw new Error('外部 link の参照が残っています');

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, html);
  return { output: OUTPUT, bytes: Buffer.byteLength(html), buildInfo };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { output, bytes, buildInfo } = await build();
  console.log(`${output}  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(buildInfo);
}
