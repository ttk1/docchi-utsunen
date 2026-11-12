// npm run sim: 自動プレイヤーに 100 回ずつ遊ばせて、仕様書 9.2 節の合格基準を確かめる。不合格なら終了コード 1。
//   --seeds  各ボットの種 0〜9 の生存時間も出す（reference/golden.json の first10_seeds と見比べる用）
import { BOT_NAMES, type BotName } from '../bots/index.ts';
import { runBot, type RunResult } from './run.ts';

// 型定義の依存（@types/node）を足さないため、使う分だけ宣言する
declare const process: { argv: string[]; exitCode?: number };

const RUNS = 100;

/** 9.2 節: 生存時間の中央値（秒）の合格範囲 */
const PASS: Record<BotName, readonly [number, number]> = {
  demo: [50, 80],
  enemy_only: [100, 130],
  block_only: [30, 110],
  timid: [120, 170],
  casual: [205, 285],
  good: [295, 375],
  expert: [335, 420],
};
/** 9.2 節: 全試行を通して、これを超える生存がないこと（秒） */
const LONGEST_ALLOWED = 600;
/** 9.2 節: demo は 100 回中 90 回以上がこの範囲（秒）で終わること */
const DEMO_RANGE = [35, 100] as const;
const DEMO_MIN_RATIO = 0.9;

function median(sorted: number[]): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const pad = (v: string | number, n: number) => String(v).padStart(n);

function main(): void {
  const showSeeds = process.argv.includes('--seeds');
  let ok = true;
  const med = {} as Record<BotName, number>;
  let longest = 0;
  console.log(`${'bot'.padEnd(11)} ${pad('min', 5)} ${pad('p10', 5)} ${pad('med', 5)} ${pad('p90', 5)} ${pad('max', 5)} ${pad('rank', 5)} ${pad('wave', 4)} ${pad('score', 8)}  判定`);
  for (const name of BOT_NAMES) {
    const rs: RunResult[] = [];
    for (let seed = 0; seed < RUNS; seed++) rs.push(runBot(name, seed));
    const ts = rs.map((r) => r.t).sort((a, b) => a - b);
    const n = ts.length;
    const m = median(ts);
    med[name] = m;
    longest = Math.max(longest, ts[n - 1]!);
    const [lo, hi] = PASS[name];
    const good = lo <= m && m <= hi;
    ok &&= good;
    const wave = median(rs.map((r) => r.wave).sort((a, b) => a - b));
    const score = median(rs.map((r) => r.score).sort((a, b) => a - b));
    console.log(
      `${name.padEnd(11)} ${pad(ts[0]!.toFixed(0), 5)} ${pad(ts[Math.floor(n / 10)]!.toFixed(0), 5)} ${pad(m.toFixed(0), 5)} ${pad(ts[n - Math.floor(n / 10) - 1]!.toFixed(0), 5)} ${pad(ts[n - 1]!.toFixed(0), 5)} ${pad(mean(rs.map((r) => r.rank)).toFixed(1), 5)} ${pad(wave.toFixed(0), 4)} ${pad(score.toFixed(0), 8)}  ${good ? 'OK' : 'NG'} (${lo}-${hi})`,
    );
    if (name === 'demo') {
      const inRange = rs.filter((r) => DEMO_RANGE[0] <= r.t && r.t <= DEMO_RANGE[1]).length;
      const demoOk = inRange >= DEMO_MIN_RATIO * RUNS;
      ok &&= demoOk;
      console.log(`            demo が ${DEMO_RANGE[0]}-${DEMO_RANGE[1]} 秒で終わった回数: ${inRange}/${RUNS} ${demoOk ? 'OK' : 'NG'}`);
    }
    if (showSeeds) console.log(`            種 0〜9: ${rs.slice(0, 10).map((r) => r.t.toFixed(2)).join(', ')}`);
  }
  const order = med.timid < med.casual && med.casual < med.good && med.good <= med.expert;
  const longestOk = longest < LONGEST_ALLOWED;
  console.log(`順序 timid<casual<good<=expert: ${order ? 'OK' : 'NG'} / 最長 ${longest.toFixed(0)} 秒 (<${LONGEST_ALLOWED}): ${longestOk ? 'OK' : 'NG'}`);
  const pass = ok && order && longestOk;
  console.log(`総合: ${pass ? '合格' : '不合格'}`);
  if (!pass) process.exitCode = 1;
}

main();
