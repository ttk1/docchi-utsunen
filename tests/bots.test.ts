import { describe, expect, it } from 'vitest';
import golden from '../reference/golden.json';
import { aimBest, aimOldest, timeToBreak } from '../src/bots/bot.ts';
import { DEMO, createDemoBot } from '../src/bots/demo.ts';
import { BOT_NAMES } from '../src/bots/index.ts';
import { SKILL_BOTS, createSkillBot } from '../src/bots/skill.ts';
import { AIM, type BlockKind, type EnemyKind } from '../src/core/balance.ts';
import { createGame, type GameState } from '../src/core/state.ts';
import { runBot } from '../src/sim/run.ts';

const LEFT = AIM.blockCols[0];
const RIGHT = AIM.blockCols[1];

function addBlock(s: GameState, kind: BlockKind, col: number, opts: { hpRatio?: number; row?: number; passAt?: number } = {}): number {
  const id = s.nextId++;
  s.blocks.push({ id, kind, hp: 100 * (opts.hpRatio ?? 1), maxHp: 100, passAt: opts.passAt ?? 8, row: opts.row ?? 1, col, u: AIM.blockCols[col]! });
  s.blocks.sort((a, b) => a.passAt - b.passAt);
  return id;
}

function addEnemy(s: GameState, kind: EnemyKind | 'boss', u: number, hp: number, size = 2.5, halfWidth = 0.13): void {
  s.enemies.push({ id: s.nextId++, kind, hp, hp0: hp, size, born: 0, bossIndex: 0, u, halfWidth });
  s.fill += size;
}

function withFill(ratio: number): GameState {
  const s = createGame(1);
  s.fill = s.capacity * ratio;
  return s;
}

describe('敵の狙い方', () => {
  it('単純な狙い方は、いちばん古い敵を狙う。敵がいなければ真ん中', () => {
    const s = createGame(1);
    expect(aimOldest(s)).toBe(0);
    addEnemy(s, 'deadline', -0.2, 400, 6, 0.21);
    addEnemy(s, 'notice', 0.3, 100);
    expect(aimOldest(s)).toBe(-0.2);
  });

  it('うまい狙い方は、時間あたりに減らせるサイズが大きい敵を選ぶ', () => {
    const s = createGame(1);
    // 締切は硬いわりにサイズが小さい。未読通知のほうが割がよい
    addEnemy(s, 'deadline', -0.2, 400, 6, 0.21);
    addEnemy(s, 'notice', 0.3, 100);
    expect(aimBest(s)).toBe(0.3);
  });

  it('手前の敵にふさがれている敵は選ばない', () => {
    const s = createGame(1);
    addEnemy(s, 'deadline', 0.2, 4000, 6, 0.21);
    addEnemy(s, 'notice', 0.3, 1);
    addEnemy(s, 'notice', -0.4, 100);
    expect(aimBest(s)).toBe(-0.4);
  });

  it('遠い敵より、近くて同じ割のよさの敵を選ぶ', () => {
    const s = createGame(1);
    s.player.x = -0.3;
    addEnemy(s, 'notice', 0.35, 100);
    addEnemy(s, 'notice', -0.35, 100);
    expect(aimBest(s)).toBe(-0.35);
  });

  it('壊し切るのに必要な時間は、撃つ時間と移動の時間の和', () => {
    const s = createGame(1);
    const id = addBlock(s, 'rank', 1);
    const b = s.blocks.find((o) => o.id === id)!;
    b.hp = 40 * 3;
    expect(timeToBreak(s, b)).toBeCloseTo(3 + RIGHT / AIM.moveSpeed, 9);
  });
});

describe('デモ AI の 7 つの規則', () => {
  // 敵を狙うときは、狙いがぶれる（真ん中の敵でも、ぴったり 0 にはならない）
  const nearCentre = expect.closeTo(0, 0);
  const decide = (s: GameState, seed = 7) => {
    const bot = createDemoBot(seed);
    return { aim: bot.act(s), rule: bot.rule };
  };

  it('1: ブロックがなければ、埋まり度 20% 未満で何もない強化の帯を空撃ちする', () => {
    expect(decide(createGame(1))).toEqual({ aim: RIGHT, rule: 1 });
    expect(decide(withFill(0.2))).toEqual({ aim: nearCentre, rule: 1 });
  });

  it('2: 最初のランクアップだけは、埋まっていても取りに行く', () => {
    const s = withFill(0.9);
    addBlock(s, 'rank', 0, { hpRatio: 0.05 });
    expect(decide(s)).toEqual({ aim: LEFT, rule: 2 });
  });

  it('3: 罠と帽子は必ず壊す（ランクアップより優先する）', () => {
    const s = withFill(0.9);
    s.player.rank = 1;
    addBlock(s, 'rank', 0);
    addBlock(s, 'trap', 1);
    expect(decide(s)).toEqual({ aim: RIGHT, rule: 3 });
  });

  it('4: ボムしかなければ無視する', () => {
    const s = withFill(0.9);
    s.player.rank = 1;
    addBlock(s, 'bomb', 0);
    expect(decide(s)).toEqual({ aim: nearCentre, rule: 4 });
  });

  it('5: 狙っていたブロックが残り 12% を切ると見捨て、二度と狙わない', () => {
    const s = withFill(0.1);
    s.player.rank = 1;
    const id = addBlock(s, 'rank', 1);
    const bot = createDemoBot(7);
    expect(bot.act(s)).toBe(RIGHT);
    expect(bot.rule).toBe(7);
    s.blocks.find((b) => b.id === id)!.hp = 11;
    s.t = 0.3;
    expect(Math.abs(bot.act(s))).toBeLessThanOrEqual(DEMO.aimError);
    expect(bot.rule).toBe(5);
    s.t = 0.6;
    bot.act(s);
    expect(bot.rule).toBe(4);
  });

  it('6: 埋まり度 75% 超で、敵の帯の中を右往左往する', () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 20; seed++) {
      const s = withFill(0.8);
      s.player.rank = 1;
      addBlock(s, 'gold', 0);
      const r = decide(s, seed);
      expect(r.rule).toBe(6);
      expect(Math.abs(r.aim)).toBeLessThanOrEqual(AIM.enemyMax);
      seen.add(r.aim);
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  it('7: それ以外は埋まり度 45% を境に決める', () => {
    const lowFill = withFill(0.3);
    lowFill.player.rank = 1;
    addBlock(lowFill, 'gold', 0);
    expect(decide(lowFill)).toEqual({ aim: LEFT, rule: 7 });
    const highFill = withFill(0.5);
    highFill.player.rank = 1;
    addBlock(highFill, 'gold', 0);
    expect(decide(highFill)).toEqual({ aim: nearCentre, rule: 7 });
  });

  it('同じ列の手前に別のブロックがある罠・帽子は選ばない（撃つと、手前の強化を取ってしまう）', () => {
    const s = withFill(0.1);
    s.player.rank = 1;
    addBlock(s, 'rank', 0, { passAt: 5, row: 1 });
    addBlock(s, 'hat', 0, { passAt: 8, row: 2 });
    // 帽子はランクアップの後ろなので、規則 3 にはならない。手前のランクアップを、ふつうに狙う（そして、あと少しで見捨てる）
    expect(decide(s)).toEqual({ aim: LEFT, rule: 7 });
    // 手前に何もない列の帽子は、これまでどおり最優先で壊す
    addBlock(s, 'hat', 1, { passAt: 8, row: 2 });
    expect(decide(s)).toEqual({ aim: RIGHT, rule: 3 });
  });

  it('見捨てたブロックの後ろにあるブロックは狙わない（撃つと、見捨てたほうが壊れてしまう）', () => {
    const s = withFill(0.1);
    s.player.rank = 1;
    addBlock(s, 'rank', 0, { passAt: 5, row: 1, hpRatio: 0.05 });
    addBlock(s, 'gold', 0, { passAt: 8, row: 2 });
    expect(decide(s)).toEqual({ aim: nearCentre, rule: 4 });
  });

  it('敵を狙うとき、ときどき敵のすぐ横を狙って空振りする', () => {
    const offset = 0.13 + AIM.beamHalf + DEMO.missGap;
    let misses = 0;
    const runs = 200;
    for (let seed = 0; seed < runs; seed++) {
      const s = withFill(0.5);
      addEnemy(s, 'notice', 0.1, 100);
      const bot = createDemoBot(seed);
      const aim = bot.act(s);
      if (bot.missing) {
        misses++;
        // 弾の列が、敵にぎりぎり当たらない位置
        expect(Math.abs(aim - 0.1)).toBeCloseTo(offset, 9);
        expect(Math.abs(aim - 0.1)).toBeGreaterThan(0.13 + AIM.beamHalf);
      } else {
        expect(Math.abs(aim - 0.1)).toBeLessThanOrEqual(DEMO.aimError);
      }
    }
    expect(misses / runs).toBeGreaterThan(DEMO.missRate - 0.1);
    expect(misses / runs).toBeLessThan(DEMO.missRate + 0.1);
  });

  it('敵がいなければ、空振りはしない', () => {
    for (let seed = 0; seed < 50; seed++) {
      const bot = createDemoBot(seed);
      bot.act(withFill(0.5));
      expect(bot.missing).toBe(false);
    }
  });

  it('0.3 秒ごとにしか決め直さない', () => {
    const s = createGame(1);
    const bot = createDemoBot(7);
    expect(bot.act(s)).toBe(RIGHT);
    s.fill = 50;
    s.t = 0.2;
    expect(bot.act(s)).toBe(RIGHT);
    s.t = 0.3;
    expect(Math.abs(bot.act(s))).toBeLessThanOrEqual(DEMO.aimError);
  });
});

describe('腕前ボット', () => {
  const steady = { ...SKILL_BOTS.casual, lapse: 0, avoid: 1, aimError: 0 };

  it('最初は敵を狙う。lo 未満で強化へ行き、hi を超えるまで戻らない', () => {
    const bot = createSkillBot(1, steady);
    const s = withFill(0.4);
    addBlock(s, 'rank', 1);
    expect(bot.act(s)).toBe(0);
    s.t = 1;
    s.fill = 20;
    expect(bot.act(s)).toBe(RIGHT);
    s.t = 2;
    s.fill = 55;
    expect(bot.act(s)).toBe(RIGHT);
    s.t = 3;
    s.fill = 65;
    expect(bot.act(s)).toBe(0);
  });

  it('同じ段ではランクアップを優先し、埋まってきたらボムを優先する', () => {
    const calm = withFill(0.1);
    addBlock(calm, 'bomb', 0);
    addBlock(calm, 'rank', 1);
    expect(createSkillBot(1, steady).act(calm)).toBe(RIGHT);
    const crowded = withFill(0.55);
    addBlock(crowded, 'bomb', 0);
    addBlock(crowded, 'rank', 1);
    expect(createSkillBot(1, { ...steady, lo: 0.9 }).act(crowded)).toBe(LEFT);
  });

  it('罠と帽子は、避けるボットなら狙わない', () => {
    const s = withFill(0.1);
    addBlock(s, 'trap', 0);
    addBlock(s, 'hat', 1);
    expect(createSkillBot(1, steady).act(s)).toBe(0);
  });

  it('同じ列の手前に別のブロックがあると、後ろのブロックは狙わない', () => {
    const s = withFill(0.1);
    addBlock(s, 'trap', 1, { row: 1, passAt: 6 });
    addBlock(s, 'rank', 1, { row: 2, passAt: 11 });
    expect(createSkillBot(1, steady).act(s)).toBe(0);
  });

  it('狙っていたブロックがなくなったら、続けて取れるものへ向かう', () => {
    const s = withFill(0.1);
    const first = addBlock(s, 'rank', 1);
    addBlock(s, 'buddy', 0);
    const bot = createSkillBot(1, steady);
    expect(bot.act(s)).toBe(RIGHT);
    s.blocks = s.blocks.filter((b) => b.id !== first);
    s.t = 0.1;
    expect(bot.act(s)).toBe(LEFT);
  });

  it('check ありのボットは、壊し切れないブロックと、空いているときのボムを取りに行かない', () => {
    const p = { ...SKILL_BOTS.expert, aimError: 0 };
    const far = createGame(1);
    far.blocks.push({ id: 1, kind: 'rank', hp: 40 * 10, maxHp: 400, passAt: 8, row: 1, col: 1, u: RIGHT });
    expect(createSkillBot(1, p).act(far)).toBe(0);
    const near = createGame(1);
    near.blocks.push({ id: 1, kind: 'rank', hp: 40 * 3, maxHp: 120, passAt: 8, row: 1, col: 1, u: RIGHT });
    expect(createSkillBot(1, p).act(near)).toBe(RIGHT);
    const emptyBomb = withFill(0.2);
    addBlock(emptyBomb, 'bomb', 1, { hpRatio: 0.1 });
    expect(createSkillBot(1, p).act(emptyBomb)).toBe(0);
    const usefulBomb = withFill(0.3);
    addBlock(usefulBomb, 'bomb', 1, { hpRatio: 0.1 });
    expect(createSkillBot(1, p).act(usefulBomb)).toBe(RIGHT);
  });
});

describe('参照シミュレータとの一致', () => {
  // 浮動小数点の違いで個々の試行はずれうるので、完全一致までは求めない（仕様書 11.4 節）。
  // ただし今の実装では種 0〜4 が小数第 2 位まで一致しているので、ずれたら実装の食い違いを疑う
  for (const name of BOT_NAMES) {
    it(`${name} の種 0〜4 の生存時間が参照と一致する`, () => {
      const ref = golden.sim_reference[name].first10_seeds;
      for (let seed = 0; seed < 5; seed++) expect(runBot(name, seed).t).toBeCloseTo(ref[seed]!, 1);
    });
  }
});

describe('急ぎのボム', () => {
  const steady = { ...SKILL_BOTS.casual, lapse: 0, avoid: 1, aimError: 0 };

  it('埋まり度 50% 超のボムは、敵を撃つのをやめてでも取りに行く', () => {
    const s = withFill(0.7);
    addBlock(s, 'bomb', 0);
    expect(createSkillBot(1, steady).act(s)).toBe(LEFT);
    // 50% 以下なら、ふつうのブロックと同じ扱い（hi を超えているので取りに行かない）
    const calm = withFill(0.45);
    addBlock(calm, 'bomb', 0);
    expect(createSkillBot(1, { ...steady, lo: 0.3 }).act(calm)).toBe(0);
  });

  it('急ぎのボムは、手前の段のランクアップより優先する', () => {
    const s = withFill(0.7);
    addBlock(s, 'rank', 1, { row: 1, passAt: 6 });
    addBlock(s, 'bomb', 0, { row: 2, passAt: 11 });
    expect(createSkillBot(1, steady).act(s)).toBe(LEFT);
  });

  it('check ありのボットは、急ぎのボムなら溢れそうでも取りに行く。間に合わないなら行かない', () => {
    const p = { ...SKILL_BOTS.expert, aimError: 0 };
    const s = withFill(0.93);
    addBlock(s, 'bomb', 0, { hpRatio: 0.1 });
    expect(createSkillBot(1, p).act(s)).toBe(LEFT);
    const late = withFill(0.93);
    addBlock(late, 'bomb', 0, { passAt: 0.3 });
    expect(createSkillBot(1, p).act(late)).toBe(0);
  });
});

describe('狙いのぶれ', () => {
  it('腕前ボットは、aimError の幅の中で狙いがぶれる。うまいボットほどぶれが小さい', () => {
    const spread = (name: keyof typeof SKILL_BOTS): number => {
      let worst = 0;
      for (let seed = 0; seed < 40; seed++) {
        const s = createGame(1);
        addEnemy(s, 'notice', 0.2, 100);
        const aim = createSkillBot(seed, { ...SKILL_BOTS[name], lapse: 0 }).act(s);
        expect(Math.abs(aim - 0.2)).toBeLessThanOrEqual(SKILL_BOTS[name].aimError + 1e-12);
        worst = Math.max(worst, Math.abs(aim - 0.2));
      }
      return worst;
    };
    expect(spread('expert')).toBeLessThan(spread('good'));
    expect(spread('good')).toBeLessThan(spread('casual'));
    expect(spread('casual')).toBeLessThan(spread('timid'));
  });

  it('うまいボットのぶれは会心の幅に収まり、デモ AI のぶれは収まらない', () => {
    expect(SKILL_BOTS.expert.aimError).toBeLessThan(AIM.critHalf);
    expect(SKILL_BOTS.good.aimError).toBeLessThan(AIM.critHalf);
    expect(DEMO.aimError).toBeGreaterThan(AIM.critHalf);
  });
});
