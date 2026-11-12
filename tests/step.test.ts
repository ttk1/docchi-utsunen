import { describe, expect, it } from 'vitest';
import { AIM, B, DT, type BlockKind, type EnemyKind } from '../src/core/balance.ts';
import { baseHp, bossHp, dpsOf } from '../src/core/formulas.ts';
import { mulberry32 } from '../src/core/rng.ts';
import { createGame, isCritical, sideOf, weakPointOf, type GameEvent, type GameState } from '../src/core/state.ts';
import { step } from '../src/core/step.ts';

const LEFT = AIM.blockCols[0];
const RIGHT = AIM.blockCols[1];

/** 敵もブロックも自然には出てこない、効果の確認用の状態 */
function quietGame(): GameState {
  const s = createGame(1);
  s.vacationUntil = 1e9;
  s.nextRowAt = 1e9;
  return s;
}

function putEnemy(s: GameState, kind: EnemyKind | 'boss', size: number, hp = 1e9, u = 0, halfWidth = 0.1): void {
  s.enemies.push({ id: s.nextId++, kind, hp, hp0: hp, size, born: s.t, bossIndex: kind === 'boss' ? 1 : 0, u, halfWidth });
  s.fill += size;
}

/** 次の 1 刻みで壊れるブロックを置き、その列に立たせる */
function putBlock(s: GameState, kind: BlockKind, col = 1, row = 100 + s.nextId): void {
  const u = AIM.blockCols[col]!;
  s.blocks.unshift({ id: s.nextId++, kind, hp: 1e-6, maxHp: 100, passAt: s.t + 5, row, col, u });
  s.player.x = u;
}

const types = (ev: GameEvent[]) => ev.map((e) => e.type);

describe('再現性', () => {
  it('同じ種・同じ入力列なら状態が完全に一致する', () => {
    const play = () => {
      const s = createGame(20261111);
      const rnd = mulberry32(99);
      let aim = 0;
      const log: GameEvent[] = [];
      for (let i = 0; i < 60 * 150 && !s.over; i++) {
        if (i % 20 === 0) aim = rnd() * 2 - 1;
        log.push(...step(s, aim));
      }
      return JSON.stringify({ s, log });
    };
    const a = play();
    expect(play()).toBe(a);
    expect(a.length).toBeGreaterThan(10000);
  });

  it('種が違えば展開が変わる', () => {
    const play = (seed: number) => {
      const s = createGame(seed);
      for (let i = 0; i < 60 * 30; i++) step(s, RIGHT);
      return JSON.stringify(s.enemies);
    };
    expect(play(1)).not.toBe(play(2));
  });

  it('経過時間は刻み数 ÷ 60 で求める', () => {
    const s = createGame(0);
    for (let i = 0; i < 60 * 20; i++) step(s, 0);
    expect(s.tick).toBe(1200);
    expect(s.t).toBe(20);
  });
});

describe('位置取り', () => {
  it('立ちたい位置へ毎秒 3 の速さで近づき、動ける範囲の外へは出ない', () => {
    const s = quietGame();
    for (let i = 0; i < 6; i++) step(s, 1);
    expect(s.player.x).toBeCloseTo(AIM.moveSpeed * 6 * DT, 9);
    for (let i = 0; i < 120; i++) step(s, 5);
    expect(s.player.x).toBe(AIM.maxX);
    for (let i = 0; i < 240; i++) step(s, -5);
    expect(s.player.x).toBe(AIM.minX);
  });

  it('立ちたい位置に着いたら、行き過ぎずに止まる', () => {
    const s = quietGame();
    for (let i = 0; i < 60; i++) step(s, 0.333);
    expect(s.player.x).toBeCloseTo(0.333, 9);
  });

  it('真ん中は敵の帯、両端は強化の帯', () => {
    expect(sideOf(0)).toBe('enemy');
    expect(sideOf(-0.54)).toBe('enemy');
    expect(sideOf(LEFT)).toBe('block');
    expect(sideOf(RIGHT)).toBe('block');
  });
});

describe('射撃', () => {
  it('弾は、立っている列に重なる敵にだけ当たる', () => {
    const s = quietGame();
    putEnemy(s, 'notice', 1, 1000, -0.4);
    putEnemy(s, 'notice', 1, 1000, 0.1);
    step(s, 0);
    expect(s.enemies[0]!.hp).toBe(1000);
    expect(s.enemies[1]!.hp).toBeLessThan(1000);
  });

  it('列に重なる敵が複数いれば、古い（手前の）敵から当たる', () => {
    const s = quietGame();
    putEnemy(s, 'notice', 1, 1000, 0.05);
    putEnemy(s, 'notice', 1, 1000, -0.05);
    step(s, 0);
    expect(s.enemies[0]!.hp).toBeLessThan(1000);
    expect(s.enemies[1]!.hp).toBe(1000);
  });

  it('余ったダメージは、同じ列の次の敵へ持ち越す。列の外の敵は飛ばす', () => {
    const s = quietGame();
    const dmg = dpsOf(0) * DT;
    // 弱点を外した位置に置く（会心にならない）
    putEnemy(s, 'notice', 1, dmg * 0.25, 0.1);
    putEnemy(s, 'notice', 1, 1000, 0.45);
    putEnemy(s, 'notice', 1, dmg * 0.25, 0.12);
    putEnemy(s, 'notice', 1, dmg, 0.08);
    const ev = step(s, 0);
    expect(ev.filter((e) => e.type === 'enemyKill')).toHaveLength(2);
    expect(s.enemies.map((e) => e.u)).toEqual([0.45, 0.08]);
    expect(s.enemies[0]!.hp).toBe(1000);
    expect(s.enemies[1]!.hp).toBeCloseTo(dmg * 0.5, 9);
    expect(s.fill).toBe(2);
    // サイズ 1 × WAVE 1 × 10 が 2 体分
    expect(s.score).toBe(20);
  });

  it('幅の広い敵は、後ろの敵の盾になる', () => {
    const s = quietGame();
    putEnemy(s, 'boss', B.bossSize, 1000, AIM.bossU, AIM.bossHalf);
    putEnemy(s, 'notice', 1, 1000, 0.3);
    s.player.x = 0.3;
    step(s, 0.3);
    expect(s.enemies[0]!.hp).toBeLessThan(1000);
    expect(s.enemies[1]!.hp).toBe(1000);
  });

  it('強化の帯では、その列でいちばん手前のブロックだけを撃つ。余りは持ち越さない', () => {
    const s = quietGame();
    s.blocks.push({ id: s.nextId++, kind: 'rank', hp: 50, maxHp: 50, passAt: s.t + 9, row: 2, col: 1, u: RIGHT });
    s.blocks.push({ id: s.nextId++, kind: 'gold', hp: 50, maxHp: 50, passAt: s.t + 4, row: 1, col: 0, u: LEFT });
    putBlock(s, 'hat', 1, 1);
    step(s, RIGHT);
    expect(s.player.hats).toBe(1);
    expect(s.blocks.map((b) => b.hp)).toEqual([50, 50]);
  });

  it('強化の帯にいる間は、敵に当たらない', () => {
    const s = quietGame();
    putEnemy(s, 'notice', 1, 1000, AIM.enemyMax - 0.1);
    s.player.x = RIGHT;
    step(s, RIGHT);
    expect(s.enemies[0]!.hp).toBe(1000);
  });

  it('相棒は列に関係なく、プレイヤーの 10% × 台数の火力で敵の先頭を撃つ', () => {
    const s = quietGame();
    s.player.buddies = 2;
    s.player.x = RIGHT;
    putEnemy(s, 'notice', 1, 1000, -0.4);
    step(s, RIGHT);
    expect(s.enemies[0]!.hp).toBeCloseTo(1000 - dpsOf(0) * 0.1 * 2 * DT, 9);
  });
});

describe('入力なし（道の真ん中に立ったまま）', () => {
  it('ランク 0 のまま、2 分もたずに終わる', () => {
    const s = createGame(0);
    while (!s.over && s.t < 300) step(s, 0);
    expect(s.over).toBe(true);
    expect(s.player.rank).toBe(0);
    expect(s.t).toBeLessThan(120);
  });
});

describe('ブロック', () => {
  it('開始 3 秒後に最初の rank が 1 個出て、以後 5 秒おきに 2 個 1 組で出る', () => {
    const s = createGame(0);
    const spawned: { t: number; hp: number; kind: string }[] = [];
    while (s.t < 14) {
      const t = s.t;
      for (const e of step(s, 0)) if (e.type === 'blockSpawn') spawned.push({ t, hp: e.hp, kind: e.kind });
    }
    expect(spawned.map((b) => b.t)).toEqual([3, 8, 8, 13, 13]);
    expect(spawned[0]).toMatchObject({ kind: 'rank', hp: 3.5 * 40 });
    // 同じ段の 2 個は左右の列に分かれ、同じ時刻に通過する
    const second = s.blocks.filter((b) => b.row === 1);
    expect(second.map((b) => b.u)).toEqual([LEFT, RIGHT]);
    expect(second.map((b) => b.passAt)).toEqual([18, 18]);
  });

  it('通過時刻になっても壊れていなければ消え、取り逃した数に入る', () => {
    const s = createGame(0);
    let passed: GameEvent | undefined;
    while (s.t < 13.1) for (const e of step(s, 0)) if (e.type === 'blockPass') passed = e;
    expect(passed).toMatchObject({ kind: 'rank', damaged: false, left: 1 });
    expect(s.missed.rank).toBe(1);
    expect(s.player.rank).toBe(0);
  });

  it('rank は +1、gold は +2。壊すと 100 × WAVE のスコア', () => {
    const s = quietGame();
    putBlock(s, 'rank');
    expect(types(step(s, RIGHT))).toEqual(['blockBreak', 'rankUp']);
    expect(s.player.rank).toBe(1);
    expect(s.score).toBe(100);
    putBlock(s, 'gold', 0);
    step(s, LEFT);
    expect(s.player.rank).toBe(3);
    expect(s.got).toMatchObject({ rank: 1, gold: 1 });
  });

  it('同じ段の 2 個を両方壊すと「両取り」。片方が通過したら数えない', () => {
    const s = quietGame();
    putBlock(s, 'rank', 1, 7);
    s.blocks.push({ id: s.nextId++, kind: 'buddy', hp: 1e-6, maxHp: 100, passAt: s.t + 5, row: 7, col: 0, u: LEFT });
    expect(step(s, RIGHT)).toContainEqual(expect.objectContaining({ type: 'blockBreak', double: false }));
    s.player.x = LEFT;
    expect(step(s, LEFT)).toContainEqual(expect.objectContaining({ type: 'blockBreak', kind: 'buddy', double: true }));
    expect(s.doubles).toBe(1);
    expect(s.halfRows).toEqual([]);

    putBlock(s, 'rank', 1, 8);
    s.blocks.push({ id: s.nextId++, kind: 'hat', hp: 50, maxHp: 50, passAt: s.t + 0.1, row: 8, col: 0, u: LEFT });
    s.blocks.sort((a, b) => a.passAt - b.passAt);
    step(s, RIGHT);
    expect(s.halfRows).toEqual([8]);
    for (let i = 0; i < 10; i++) step(s, RIGHT);
    expect(s.halfRows).toEqual([]);
    expect(s.doubles).toBe(1);
  });

  it('武器の段階が変わるランクアップには印が付く', () => {
    const s = quietGame();
    s.player.rank = 3;
    putBlock(s, 'rank');
    expect(step(s, RIGHT)).toContainEqual({ type: 'rankUp', rank: 4, stageChanged: true });
  });

  it('相棒は 3 台まで、キャパ拡張は容量 +10 を 3 回まで', () => {
    const s = quietGame();
    for (let i = 0; i < 5; i++) {
      putBlock(s, 'buddy');
      step(s, RIGHT);
      putBlock(s, 'expand');
      step(s, RIGHT);
    }
    expect(s.player.buddies).toBe(3);
    expect(s.capacity).toBe(130);
    expect(s.expands).toBe(3);
  });

  it('罠は未読通知 8 体を、その時点の HP で、敵の帯の中に出す', () => {
    const s = quietGame();
    putEnemy(s, 'deadline', 6);
    putBlock(s, 'trap');
    const t = s.t;
    step(s, RIGHT);
    expect(s.enemies).toHaveLength(1 + B.trapCount);
    expect(s.enemies[0]!.kind).toBe('deadline');
    const added = s.enemies.slice(1);
    expect(added.every((e) => e.kind === 'notice' && e.size === 2.5 && e.hp === baseHp(t) * 2.5)).toBe(true);
    expect(added.every((e) => e.u - e.halfWidth >= AIM.enemyMin - 1e-9 && e.u + e.halfWidth <= AIM.enemyMax + 1e-9)).toBe(true);
    expect(s.fill).toBe(6 + 2.5 * B.trapCount);
  });

  it('有給休暇の効果中でも、罠で湧く未読通知と、ボスは出る（止まるのは通常の出現だけ）', () => {
    const s = createGame(3);
    s.nextRowAt = 1e9;
    // ボス戦のウェーブ（WAVE 5）のラッシュ直前まで進める
    s.tick = Math.round((4 * B.waveLength + 14.5) / DT);
    s.t = s.tick * DT;
    putBlock(s, 'vacation');
    step(s, RIGHT);
    expect(s.t).toBeLessThan(s.vacationUntil);
    const before = s.enemies.length;
    putBlock(s, 'trap');
    const trapEvents = step(s, RIGHT);
    expect(trapEvents.some((e) => e.type === 'enemySpawn' && e.kind === 'notice')).toBe(true);
    expect(s.enemies.length).toBe(before + B.trapCount);
    // 効果が続いているあいだに、ボスが出る
    const events: GameEvent[] = [];
    while (s.t < 4 * B.waveLength + 15.2) events.push(...step(s, 0));
    expect(s.t).toBeLessThan(s.vacationUntil);
    expect(events.some((e) => e.type === 'bossSpawn')).toBe(true);
    // 通常の出現は、そのあいだ 1 回もない
    expect(events.some((e) => e.type === 'enemySpawn')).toBe(false);
  });

  it('有給休暇は 6 秒間敵を止め、効果中に重ねると 6 秒延びる', () => {
    const s = createGame(3);
    s.nextRowAt = 1e9;
    for (let i = 0; i < 60; i++) step(s, 0);
    putBlock(s, 'vacation');
    const t0 = s.t;
    step(s, RIGHT);
    expect(s.vacationUntil).toBe(t0 + 6);
    putBlock(s, 'vacation');
    step(s, RIGHT);
    expect(s.vacationUntil).toBe(t0 + 12);
    // 効果中は出現しない（予算も貯めない）
    const budget = s.budget;
    let spawns = 0;
    while (s.t < t0 + 12) spawns += step(s, 0).filter((e) => e.type === 'enemySpawn').length;
    expect(spawns).toBe(0);
    expect(s.budget).toBe(budget);
    while (s.t < t0 + 14) spawns += step(s, 0).filter((e) => e.type === 'enemySpawn').length;
    expect(spawns).toBeGreaterThan(0);
  });
});

describe('一斉削除', () => {
  it('先頭からサイズ 35 まで消す。収まらない敵は飛ばして次を見る。スコアは入らない', () => {
    const s = quietGame();
    putEnemy(s, 'deadline', 6);
    putEnemy(s, 'boss', B.bossSize, 100);
    for (let i = 0; i < 10; i++) putEnemy(s, 'notice', 2.5);
    putEnemy(s, 'deadline', 6);
    putEnemy(s, 'spam', 0.5);
    putEnemy(s, 'notice', 2.5);
    putEnemy(s, 'spam', 0.5);
    putEnemy(s, 'spam', 0.5);
    putBlock(s, 'bomb');
    const ev = step(s, RIGHT);
    // 6 + 25 = 31 を消し、残り 4 に収まらない締切を飛ばして、その後ろの迷惑メール 3 通と未読通知 1 体（計 4）を消す
    expect(s.enemies.map((e) => e.kind)).toEqual(['boss', 'deadline']);
    expect(s.enemies[0]!.hp).toBe(85);
    expect(s.fill).toBe(B.bossSize + 6);
    expect(s.score).toBe(100);
    expect(ev.filter((e) => e.type === 'enemyKill' && e.byBomb)).toHaveLength(15);
  });

  it('ボスには最大 HP の 15% のダメージ。それで倒れたらボス撃破として扱う', () => {
    const s = quietGame();
    putEnemy(s, 'boss', B.bossSize, 100);
    s.enemies[0]!.hp = 10;
    putBlock(s, 'bomb');
    const ev = step(s, RIGHT);
    expect(s.enemies).toHaveLength(0);
    expect(s.bossesKilled).toBe(1);
    expect(types(ev)).toContain('bossKill');
    // ブロック 100 + サイズ 20 × WAVE 1 × 10 + ボス 1 体目 5,000
    expect(s.score).toBe(100 + 200 + 5000);
  });
});

describe('敵', () => {
  it('敵は敵の帯の中に出る。迷惑メール 8 通はひとかたまりで出る', () => {
    const s = createGame(4);
    s.nextRowAt = 1e9;
    s.capacity = 1e9;
    const groups: number[][] = [];
    while (s.t < 120) {
      const before = s.enemies.length;
      for (const e of step(s, RIGHT)) {
        if (e.type === 'enemySpawn' && e.kind === 'spam') groups.push(s.enemies.slice(before, before + 8).map((x) => x.u));
      }
    }
    expect(s.enemies.every((e) => e.u - e.halfWidth >= AIM.enemyMin - 1e-9 && e.u + e.halfWidth <= AIM.enemyMax + 1e-9)).toBe(true);
    expect(groups.length).toBeGreaterThan(3);
    for (const g of groups) expect(Math.max(...g) - Math.min(...g)).toBeLessThanOrEqual(AIM.groupSpread + 1e-9);
  });

  it('リボ払いは 20 秒間、毎秒「出現時 HP の 10%」ずつ増え、最大で 3 倍になる', () => {
    const s = quietGame();
    s.player.x = RIGHT;
    putEnemy(s, 'revolving', 3, 100);
    s.growing.push(s.enemies[0]!);
    for (let i = 0; i < 60 * 10; i++) step(s, RIGHT);
    expect(s.enemies[0]!.hp).toBeCloseTo(200, 6);
    for (let i = 0; i < 60 * 30; i++) step(s, RIGHT);
    expect(s.enemies[0]!.hp).toBeCloseTo(300, 6);
  });

  it('WAVE 5 の τ = 15 でボスが 1 体だけ出て、ラッシュ中は通常の敵が出ない。ボスは敵の帯を覆う', () => {
    const s = createGame(0);
    s.capacity = 1e9;
    const log: { t: number; e: GameEvent }[] = [];
    while (s.t < 100) {
      const t = s.t;
      for (const e of step(s, RIGHT)) log.push({ t, e });
    }
    const bosses = log.filter((x) => x.e.type === 'bossSpawn');
    expect(bosses).toHaveLength(1);
    expect(bosses[0]!.t).toBe(95);
    const boss = s.enemies.find((e) => e.kind === 'boss')!;
    expect(boss.hp0).toBe(bossHp(95));
    expect(boss).toMatchObject({ size: B.bossSize, u: AIM.bossU, halfWidth: AIM.bossHalf });
    expect(log.filter((x) => x.e.type === 'enemySpawn' && x.t >= 95)).toHaveLength(0);
  });

  it('τ = 13 で警告が出る。通常はラッシュ警告、ボス戦のウェーブではボス警告', () => {
    const s = createGame(0);
    s.capacity = 1e9;
    const warns: { t: number; type: string }[] = [];
    while (s.t < 100) {
      const t = s.t;
      for (const e of step(s, RIGHT)) if (e.type === 'rushWarning' || e.type === 'bossWarning') warns.push({ t, type: e.type });
    }
    expect(warns).toEqual([
      { t: 13, type: 'rushWarning' },
      { t: 33, type: 'rushWarning' },
      { t: 53, type: 'rushWarning' },
      { t: 73, type: 'rushWarning' },
      { t: 93, type: 'bossWarning' },
    ]);
  });

  it('ボスを倒すと 5,000 × 倒した数のボーナスが入る', () => {
    const s = quietGame();
    s.bossesKilled = 2;
    putEnemy(s, 'boss', B.bossSize, 1e-6, AIM.bossU, AIM.bossHalf);
    step(s, 0);
    expect(s.score).toBe(B.bossSize * 1 * 10 + 5000 * 3);
  });

  it('埋まり度が容量に達したらゲームオーバーになり、以後は進まない', () => {
    const s = quietGame();
    s.player.x = RIGHT;
    putEnemy(s, 'boss', 99.5);
    expect(types(step(s, RIGHT))).not.toContain('gameOver');
    putEnemy(s, 'spam', 0.5);
    expect(types(step(s, RIGHT))).toContain('gameOver');
    expect(s.over).toBe(true);
    const tick = s.tick;
    expect(step(s, RIGHT)).toEqual([]);
    expect(s.tick).toBe(tick);
  });
});

describe('会心', () => {
  it('弾の列が敵の真ん中を捉えると、ダメージが 2 倍になる', () => {
    const s = quietGame();
    const dmg = dpsOf(0) * DT;
    putEnemy(s, 'notice', 1, 1000, AIM.critHalf - 0.001);
    step(s, 0);
    expect(s.enemies[0]!.hp).toBeCloseTo(1000 - dmg * AIM.critMult, 9);
    expect([s.hitTicks, s.critTicks]).toEqual([1, 1]);
  });

  it('真ん中を外すと、当たっても等倍', () => {
    const s = quietGame();
    const dmg = dpsOf(0) * DT;
    putEnemy(s, 'notice', 1, 1000, AIM.critHalf + 0.01);
    step(s, 0);
    expect(s.enemies[0]!.hp).toBeCloseTo(1000 - dmg, 9);
    expect([s.hitTicks, s.critTicks]).toEqual([1, 0]);
  });

  it('会心で倒した余りは、等倍に戻して次の敵へ持ち越す', () => {
    const s = quietGame();
    const dmg = dpsOf(0) * DT;
    // 1 体目は会心で、弾の半分を使って倒れる。残りの半分が、弱点を外した 2 体目に等倍で入る
    putEnemy(s, 'notice', 1, dmg, 0);
    putEnemy(s, 'notice', 1, 1000, 0.1);
    step(s, 0);
    expect(s.enemies).toHaveLength(1);
    expect(s.enemies[0]!.hp).toBeCloseTo(1000 - dmg * 0.5, 9);
  });

  it('何にも当たっていない刻みは、当てた時間に数えない', () => {
    const s = quietGame();
    putEnemy(s, 'notice', 1, 1000, 0.5);
    step(s, 0);
    expect([s.hitTicks, s.critTicks]).toEqual([0, 0]);
  });

  it('ボスの弱点は、出現時は真ん中にあり、周期の 1/4 で端、半分で真ん中、3/4 で反対の端に来る', () => {
    const s = quietGame();
    putEnemy(s, 'boss', B.bossSize, 1e9, AIM.bossU, AIM.bossHalf);
    const boss = s.enemies[0]!;
    const at = (phase: number) => weakPointOf(boss, boss.born + AIM.bossWeakPeriod * phase) - boss.u;
    expect(at(0)).toBeCloseTo(0, 9);
    expect(Math.abs(at(0.25))).toBeCloseTo(AIM.bossWeakSwing, 9);
    expect(at(0.5)).toBeCloseTo(0, 9);
    expect(at(0.75)).toBeCloseTo(-at(0.25), 9);
    expect(at(1)).toBeCloseTo(0, 9);
  });

  it('ボスは、真ん中ではなく動く弱点に合わせたときだけ会心になる', () => {
    const s = quietGame();
    putEnemy(s, 'boss', B.bossSize, 1e9, AIM.bossU, AIM.bossHalf);
    const boss = s.enemies[0]!;
    const t = boss.born + AIM.bossWeakPeriod * 0.25;
    expect(isCritical(boss, weakPointOf(boss, t), t)).toBe(true);
    expect(isCritical(boss, boss.u, t)).toBe(false);
  });

  it('ふつうの敵の弱点は、いつも真ん中', () => {
    const s = quietGame();
    putEnemy(s, 'deadline', 6, 1000, 0.3, 0.21);
    expect(weakPointOf(s.enemies[0]!, 123.4)).toBe(0.3);
  });
});
