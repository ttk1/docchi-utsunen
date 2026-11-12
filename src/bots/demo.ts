// デモプレイ AI（仕様書 5.1 節）。わざと下手に遊ぶ。上から順に判定し、最初に当てはまった規則に従う。
import { AIM, type BlockKind } from '../core/balance.ts';
import type { Block, GameState } from '../core/state.ts';
import { BLOCK_PRIORITY, ENEMY_HOME, TIME_EPSILON, aimOldest, botRandom, type Bot } from './bot.ts';

export const DEMO = {
  interval: 0.3,
  /** 狙う敵を決め直す間隔。反応が遅い */
  aimInterval: 0.6,
  /** 狙いのぶれ。会心はめったに出ない */
  aimError: 0.12,
  /** 敵を狙い直すたびに、この確率で、敵のすぐ横を狙って空振りする。missGap は、弾の列と敵のあいだにあける幅 */
  missRate: 0.3,
  missGap: 0.04,
  /** 規則 1: ブロックがないとき、埋まり度の割合がこれ未満なら、何もない強化の帯で空撃ちする */
  idleFill: 0.2,
  /** 規則 5: 狙ったブロックの残り HP がこの割合を切ったら離れる */
  quitRatio: 0.12,
  /** 規則 6: 埋まり度の割合がこれを超えたら右往左往する */
  panicFill: 0.75,
  /** 規則 7 */
  normalFill: 0.45,
} as const;

export interface DemoBot extends Bot {
  /** 直近の判断で当てはまった規則の番号（1〜7）。字幕を出すのに使う */
  readonly rule: number;
  /** 今、敵のすぐ横を狙って空振りしているか。字幕を出すのに使う */
  readonly missing: boolean;
}

function isJunk(kind: BlockKind): boolean {
  return kind === 'trap' || kind === 'hat';
}

/** 通過の早い段から、優先順で 1 個選ぶ */
function firstOf(blocks: readonly Block[], ok: (b: Block) => boolean): Block | undefined {
  let best: Block | undefined;
  let bestRank = Infinity;
  for (const b of blocks) {
    if (!ok(b)) continue;
    const rank = b.row * 100 + BLOCK_PRIORITY.indexOf(b.kind);
    if (rank < bestRank) {
      bestRank = rank;
      best = b;
    }
  }
  return best;
}

export function createDemoBot(seed: number): DemoBot {
  const rnd = botRandom(seed);
  let rule = 0;
  let nextDecide = 0;
  let nextAim = 0;
  /** 行き先。ブロックの ID、または決まった横位置、または「敵を狙う」 */
  let target: { block: number } | { x: number } | 'enemy' = 'enemy';
  let enemyAim = ENEMY_HOME;
  let missing = false;
  /** あと少しで見捨てたブロック。二度と狙わない */
  const quit = new Set<number>();

  const decide = (s: GameState): void => {
    const f = s.fill / s.capacity;
    const set = (n: number, to: typeof target): void => {
      rule = n;
      target = to;
    };
    if (s.blocks.length === 0) return set(1, f < DEMO.idleFill ? { x: AIM.blockCols[1] } : 'enemy');
    // 規則 2: 最初のランクアップだけは普通に取る
    const firstRank = s.player.rank === 0 && s.missed.rank === 0 ? s.blocks.find((b) => b.kind === 'rank') : undefined;
    if (firstRank) return set(2, { block: firstRank.id });
    // 同じ列の手前に別のブロックがあるものは選ばない（撃つと手前のほうに当たり、取るつもりのない強化を取ってしまう）
    const front = (b: Block): boolean => !s.blocks.some((o) => o.col === b.col && o.passAt < b.passAt);
    // 規則 3: 罠と帽子は必ず壊す
    const junk = firstOf(s.blocks, (b) => isJunk(b.kind) && front(b));
    if (junk) return set(3, { block: junk.id });
    // 規則 4・5: ボムは無視し、あと少しのブロックは見捨てる
    for (const b of s.blocks) if (b.hp / b.maxHp < DEMO.quitRatio) quit.add(b.id);
    const wanted = firstOf(s.blocks, (b) => b.kind !== 'bomb' && !quit.has(b.id) && front(b));
    const current = typeof target === 'object' && 'block' in target ? target.block : 0;
    if (quit.has(current)) return set(5, 'enemy');
    if (!wanted) return set(4, 'enemy');
    // 規則 6: 埋まると右往左往する
    if (f > DEMO.panicFill) return set(6, { x: AIM.enemyMin + (AIM.enemyMax - AIM.enemyMin) * rnd() });
    set(7, f < DEMO.normalFill ? { block: wanted.id } : 'enemy');
  };

  return {
    act(s) {
      if (s.t >= nextDecide - TIME_EPSILON) {
        nextDecide += DEMO.interval;
        decide(s);
      }
      if (target === 'enemy') {
        if (s.t >= nextAim - TIME_EPSILON) {
          nextAim = s.t + DEMO.aimInterval;
          enemyAim = aimOldest(s) + (rnd() * 2 - 1) * DEMO.aimError;
          // ときどき、いちばん古い敵のすぐ横を狙って空振りする
          const oldest = s.enemies[0];
          missing = oldest !== undefined && rnd() < DEMO.missRate;
          if (oldest && missing) {
            const side = rnd() < 0.5 ? -1 : 1;
            enemyAim = oldest.u + side * (oldest.halfWidth + AIM.beamHalf + DEMO.missGap);
          }
        }
        return enemyAim;
      }
      missing = false;
      if ('x' in target) return target.x;
      const id = target.block;
      const b = s.blocks.find((o) => o.id === id);
      return b ? b.u : s.player.x;
    },
    get rule() {
      return rule;
    },
    get missing() {
      return missing;
    },
  };
}
