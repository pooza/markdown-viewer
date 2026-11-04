// Codex のレビューを 4 経路で待つ（ginseng-style codex-review の待機ループ）。
//   node scripts/codex-wait.mjs <repo> <pr> [基点JSON]
// jq・bc の無い Windows でも動くよう Node で書いた（上流への提案: pooza/ginseng-style#139）。
// 基点: {"reviews":n,"inline":n,"issue":n,"plusOne":"ISO時刻"} — 巡を起こす前（自分の返信より前）に採る。
// 出力の最後の行が DONE / TIMEOUT。gh が失敗したら結果を信用せず exit 2。
import { execFileSync } from 'node:child_process';

const [repo, pr, baseArg] = process.argv.slice(2);
if (!repo || !pr) {
  console.log('使い方: node scripts/codex-wait.mjs <owner/repo> <PR 番号> [基点JSON]');
  process.exit(2);
}
const base = {
  reviews: 0,
  inline: 0,
  issue: 0,
  plusOne: '',
  ...(baseArg ? JSON.parse(baseArg) : {}),
};
const BOT = 'chatgpt-codex-connector[bot]';
const SUMMARY = '<!-- codex-pull-request-review-summary -->';

function api(path, paginate = true) {
  const args = ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path];
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const data = JSON.parse(out);
  return paginate ? data.flat() : data;
}

export function snapshot() {
  const sha = api(`repos/${repo}/pulls/${pr}`, false).head.sha;
  const reviews = api(`repos/${repo}/pulls/${pr}/reviews`).filter((r) => r.user.login === BOT);
  const inline = api(`repos/${repo}/pulls/${pr}/comments`).filter((c) => c.user.login === BOT);
  const issueAll = api(`repos/${repo}/issues/${pr}/comments`).filter((c) => c.user.login === BOT);
  const issue = issueAll.filter((c) => !c.body.startsWith(SUMMARY));
  const summary = issueAll.find((c) => c.body.startsWith(SUMMARY));
  const reactions = api(`repos/${repo}/issues/${pr}/reactions`).filter((r) => r.user.login === BOT);
  const plusOne =
    reactions
      .filter((r) => r.content === '+1')
      .map((r) => r.created_at)
      .sort()
      .pop() || '';
  const eyes = reactions.some((r) => r.content === 'eyes');
  let state = '';
  const m = summary?.body.match(/codex-review-state:v1 (\{.*?\})\s*-->/s);
  if (m) {
    try {
      const s = JSON.parse(m[1]).code_review;
      state = s?.commit_sha === sha ? s.status : `other(${s?.status})`;
    } catch {
      state = 'unparsable';
    }
  }
  return {
    sha,
    reviews: reviews.length,
    inline: inline.length,
    issue: issue.length,
    plusOne,
    eyes,
    state,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 90; i++) {
  let s;
  try {
    s = snapshot();
  } catch (e) {
    console.log(`走査失敗。結果を信用しないこと: ${e.message}`);
    process.exit(2);
  }
  console.log(`${new Date().toTimeString().slice(0, 8)} ${JSON.stringify(s)}`);
  if (
    s.reviews > base.reviews ||
    s.inline > base.inline ||
    s.issue > base.issue ||
    (s.plusOne && s.plusOne > base.plusOne) ||
    s.state === 'completed'
  ) {
    console.log('DONE');
    process.exit(0);
  }
  await sleep(30000);
}
console.log(
  'TIMEOUT（45 分）: まだ来ていないのか、拾えない形で来たのかを 4 経路を手で見て確かめること',
);
process.exit(1);
