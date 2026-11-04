// ヘッドレス Edge でページを開き、ページ内の #smoke-result に書かれた JSON を受け取る。
// Windows の msedge.exe は起動後すぐに制御を返し、--dump-dom の結果も標準出力に出ない。
// そのため DevTools プロトコルでつなぎ、ページの中の結果を直接読む。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runInEdge(url) {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) throw new Error('Edge が見つかりません');
  const profile = mkdtempSync(join(tmpdir(), 'mdv-smoke-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  spawn(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      // 名前解決をすべて失敗させる＝ネットにつながらない環境と同じ状態
      '--host-resolver-rules=MAP * ~NOTFOUND',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  ).unref();

  let cdp;
  try {
    const version = await retry(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), 30000);
    cdp = await connect(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const raw = await retry(async () => {
      const { result } = await cdp.send(
        'Runtime.evaluate',
        { expression: "(document.getElementById('smoke-result') || {}).textContent", returnByValue: true },
        sessionId,
      );
      if (!result.value || result.value === 'pending') throw new Error('まだ終わっていない');
      return result.value;
    }, 90000);
    return JSON.parse(raw);
  } finally {
    if (cdp) await cdp.send('Browser.close').catch(() => {});
    if (cdp) cdp.close();
    // Edge が閉じきるまでプロファイルは消せない。消せなくても一時フォルダなので先へ進む
    await sleep(1500);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (e) {
      console.warn(`一時プロファイルを消せませんでした: ${profile}`);
    }
  }
}

async function retry(fn, timeoutMs) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      await sleep(200);
    }
  }
  throw new Error(`時間切れ: ${lastError && lastError.message}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { ok, ng } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) ng(new Error(msg.error.message));
        else ok(msg.result);
      }
    };
    ws.onerror = () => reject(new Error('DevTools に接続できません'));
    ws.onopen = () =>
      resolve({
        send(method, params, sessionId) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
          return new Promise((ok, ng) => pending.set(id, { ok, ng }));
        },
        close: () => ws.close(),
      });
  });
}

