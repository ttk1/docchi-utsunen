// 1 回分のゲーム。本編もデモも同じ core を使い、違うのは入力の出どころだけ（仕様書 5 章・8 章）。
import { createDemoBot, type DemoBot } from '../bots/demo.ts';
import { DT } from '../core/balance.ts';
import { createGame, sideOf, type GameEvent, type GameState } from '../core/state.ts';
import { step } from '../core/step.ts';
import { View, isNearMiss, type Sfx } from '../render/view.ts';

/** 1 フレームで回す step の上限。それ以上の遅れは捨てる（仕様書 8.2 節） */
const MAX_STEPS_PER_FRAME = 5;

export interface Advance {
  events: GameEvent[];
  /** デモ AI が「あと少し」でブロックを離れた（規則 5） */
  demoQuit: boolean;
  /** デモ AI が、敵のすぐ横を狙って空振りし始めた */
  demoMiss: boolean;
}

export class Session {
  readonly state: GameState;
  readonly view: View;
  /** 人が遊ぶときの、立ちたい横位置（u）。入力のたびに書き換わる */
  aim = 0;
  /** 半分以上削ったのに壊し切れず通過させた、役に立つブロックの数（リザルトのひとこと用） */
  nearMisses = 0;
  private readonly bot: DemoBot | null;
  private acc = 0;
  private blockTicks = 0;
  private lastRule = 0;
  private lastMissing = false;

  constructor(seed: number, demo: boolean, sfx: Sfx | null) {
    this.state = createGame(seed);
    this.view = new View(seed, sfx);
    this.bot = demo ? createDemoBot(seed) : null;
    this.view.tips = !demo;
    if (!demo) this.view.announce('スタート！');
  }

  /** 強化の帯にいた時間の割合（0〜1） */
  get blockShare(): number {
    return this.state.tick > 0 ? this.blockTicks / this.state.tick : 0;
  }

  /** 実時間 dt 秒ぶん進める。経過時間を貯めて 1/60 秒ずつ step を回す */
  advance(dt: number): Advance {
    const events: GameEvent[] = [];
    let demoQuit = false;
    let demoMiss = false;
    this.acc = Math.min(this.acc + dt, MAX_STEPS_PER_FRAME * DT);
    while (this.acc >= DT) {
      this.acc -= DT;
      if (this.state.over) continue;
      if (this.bot) {
        this.aim = this.bot.act(this.state);
        if (this.bot.rule === 5 && this.lastRule !== 5) demoQuit = true;
        this.lastRule = this.bot.rule;
        if (this.bot.missing && !this.lastMissing) demoMiss = true;
        this.lastMissing = this.bot.missing;
      }
      for (const e of step(this.state, this.aim)) {
        events.push(e);
        if (e.type === 'blockPass' && isNearMiss(e.kind, e.left)) this.nearMisses++;
      }
      if (sideOf(this.state.player.x) === 'block') this.blockTicks++;
    }
    this.view.handle(events);
    this.view.update(dt, this.state);
    return { events, demoQuit, demoMiss };
  }
}
