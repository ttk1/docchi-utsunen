// 見た目だけの状態（敵の位置、弾、ダメージの数字、破片、演出のタイマー）。
// ロジックの状態を読むだけで、ロジックには影響を与えない（仕様書 6 章・7 章）。
import { AIM, B, ENEMIES, VACATION_OVER, type BlockKind, type EnemyKind, type Lane } from '../core/balance.ts';
import { bossLines, bossName, dpsOf, fireRate, rushLine, waveOf, weaponName, weaponStage } from '../core/formulas.ts';
import { mulberry32 } from '../core/rng.ts';
import { isCritical, sideOf, weakPointOf, type Enemy, type GameEvent, type GameState } from '../core/state.ts';
import { clamp } from './draw.ts';
import { formatNumber } from './format.ts';
import { W, kOf, xOf, yOf } from './projection.ts';
import { BLOCK_COLORS, ENEMY_COLORS, NOTICE_VARIANTS, WEAPON_SPRITE, sprite } from './sprites.ts';

/** 効果音の出口。デモ中は null を渡して鳴らさない */
export interface Sfx {
  shot(stage: number): void;
  /** progress は、撃っているブロックの削れ具合（0〜1）。壊れる間際ほど高い音にする */
  blockHit(progress: number): void;
  kill(): void;
  blockBreak(): void;
  /** 壊したブロックの中身が手元に届いた */
  pickup(): void;
  rankUp(rank: number, stageChanged: boolean): void;
  miss(): void;
  trap(): void;
  bomb(): void;
  rushWarning(): void;
  bossWarning(): void;
  bossSpawn(): void;
  bossKill(): void;
  praise(): void;
  /** 会心の弾が当たった */
  crit(): void;
  gameOver(): void;
}

/** 見た目の決まりごと（仕様書 6.2 節・7 章の数値） */
export const LOOK = {
  /** 敵の目標 z = front + span × (前にいる敵のサイズ合計 + 自分の半分) ÷ 容量 */
  enemyFront: 0.03,
  enemySpan: 0.94,
  /** 敵が目標の z に近づく速さ（毎秒） */
  enemySpeed: 0.35,
  /** リボ払いが育ち切ったときの大きさ */
  revolvingMaxScale: 1.4,
  bulletTime: 0.12,
  maxBullets: 100,
  maxNumbers: 60,
  maxParticles: 400,
  maxRings: 40,
  numberLife: 0.6,
  /** 同じ標的への数字は、この秒数のあいだ 1 つにまとめて足し込む */
  numberMerge: 0.22,
  ringLife: 0.28,
  /** 画面が白く光る時間と、次に光るまでの最短間隔（1 秒に 3 回を超えない） */
  flashTime: 0.1,
  flashGap: 0.34,
  flashAlpha: 0.45,
  shakeMax: 6,
  bossShakeTime: 0.3,
  warningTime: 2,
  bossIntroTime: 2,
  bombWaveTime: 0.45,
  /** プレイヤーの足元の y */
  playerBottom: 904,
  /** 武器を持つ手の位置（体の中心からの x、足元からの高さ）。弾の列は武器の位置に合わせる */
  weaponDx: 29,
  weaponUp: 34,
  /** 壊したブロックの中身が、手元まで飛んでくる時間 */
  pickupTime: 0.38,
  /** 通過までこの秒数を切ってから壊すと「ギリギリ！」 */
  closeCall: 0.6,
  /** 埋まり度がこの割合（危険の警告が出る割合と同じ）を超えたあと recoverTo を下回ると「持ち直した！」 */
  recoverFrom: 0.7,
  recoverTo: 0.5,
  /** mowWindow 秒のあいだに mowKills 体以上倒すと「なぎ倒し！」。次に出すまで mowCooldown 秒あける */
  mowWindow: 0.6,
  mowKills: 6,
  mowCooldown: 10,
  /** 初めて出た種類の敵を紹介する札と、その敵の頭上に名前を出す時間 */
  introTime: 3.6,
  /** 開始直後の案内を出しておく時間 */
  guideTime: 10,
  /** 最初の強化を取るまで、ランクアップのブロックに「撃って壊すと強くなる！」と添える。この秒数を過ぎたら出さない。ブロックがこの奥行きより遠いうちは下から、近づいたら上から指す */
  firstBlockHintTime: 45,
  firstBlockHintZ: 0.62,
  /** 敵を倒したときのひとこと（「既読」など）を、次に出すまであける秒数。うるさくならないよう、数の多い敵（未読通知、迷惑メール）は長くあける */
  defeatWordGap: 8,
  defeatWordGapCommon: 20,
  /** 「休暇明け…」を、次に出すまであける秒数 */
  vacationWordGap: 40,
  /** 会心を snipeTime 秒続けると「狙い撃ち！」。snipeGap 秒までの途切れは続きとみなす。次に出すまで snipeCooldown 秒あける */
  snipeTime: 2,
  snipeGap: 0.2,
  snipeCooldown: 15,
  /** これより速く動いている間は、足元に砂ぼこりを出す（px/秒） */
  dustSpeed: 260,
} as const;

/** 敵の種類ごとの絵の倍率。当たり判定の幅（balance.ts の halfWidth）に見た目を合わせる */
const ENEMY_SCALE: Readonly<Record<EnemyKind | 'boss', number>> = {
  notice: 1.3,
  spam: 1,
  deadline: 1.2,
  revolving: 1.2,
  boss: 1,
};

export interface EnemyVis {
  u: number;
  z: number;
  variant: number;
  phase: number;
  /** 直近の描画位置（下端の中央）と倍率。破片と弾の狙いに使う */
  x: number;
  y: number;
  scale: number;
  spriteId: string;
  /** 現れてからの秒数。出現時にふくらむ演出に使う */
  age: number;
  /** 今、目標の位置へ歩いている最中か */
  walking: boolean;
}

export interface Bullet {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 着弾点での縮小率 */
  k1: number;
  age: number;
  stage: number;
  lane: Lane;
  /** 着弾時に出す表示ダメージ。0 なら数字を出さない */
  damage: number;
  /** 狙った標的の通し番号（数字をまとめるのに使う） */
  target: number;
  spin: number;
  /** 会心の弾か */
  crit: boolean;
}

export interface FloatNumber {
  x: number;
  y: number;
  age: number;
  value: number;
  label: string;
  /** 会心のダメージを含むか（金色で大きく出す） */
  crit: boolean;
  /** 強化ブロックへのダメージか（色を変える） */
  block: boolean;
  tilt: number;
  /** 標的の通し番号。同じ標的への数字はまとめる */
  target: number;
  /** 最後に足し込まれた時刻（数字が弾む演出用） */
  bumpedAt: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  age: number;
  life: number;
  size: number;
  color: string;
}

/** 敵を倒したときなどに広がる輪 */
export interface Ring {
  x: number;
  y: number;
  radius: number;
  age: number;
  color: string;
}

/** 壊したブロックの中身。プレイヤーの手元へ飛んでくる */
export interface Pickup {
  kind: BlockKind;
  x0: number;
  y0: number;
  age: number;
}

/** 文字の色。上から下へのグラデーション */
export type Tone = readonly [string, string];
export const TONE = {
  white: ['#ffffff', '#cfe6ff'],
  gold: ['#fff7a8', '#ffb400'],
  red: ['#ff8f8f', '#f01f1f'],
  pink: ['#ffe0f0', '#ff8fc4'],
  green: ['#d8ffd0', '#4fd26b'],
  crit: ['#ffffff', '#ffd000'],
} as const satisfies Record<string, Tone>;

export interface Toast {
  key: string;
  label: string;
  x: number;
  y: number;
  size: number;
  tone: Tone;
  start: number;
  life: number;
}

/** 弾の列が今当たっている先 */
export interface Aim {
  x: number;
  y: number;
  k: number;
  /** 当たっている先の奥行き。何もなければ 1（地平線） */
  z: number;
  /** 標的がある（数字を出す）か、何もない地平線か */
  hit: boolean;
  /** 当たっている敵の通し番号。敵でなければ 0 */
  enemyId: number;
  /** 当たっているブロックの通し番号。ブロックでなければ 0 */
  blockId: number;
  /** 当たっているブロックの削れ具合（0〜1）。ブロックでなければ 0 */
  progress: number;
  /** 当たっている敵の弱点を捉えているか（会心） */
  crit: boolean;
  /** 当たっている敵の弱点の、画面上の x。敵でなければ x と同じ */
  weakX: number;
}

/** ブロックの直近の位置と残り時間（壊れた・通過したときの演出用） */
interface BlockSpot {
  x: number;
  y: number;
  k: number;
  left: number;
}

/** 2 台目の相棒（AI）が来たときの言葉 */
const AI_BUDDY_LABEL = 'AI 相棒 参上！';
const AI_BUDDY_LINE = '「お手伝いできることはありますか？」';
/** エナドリ（金のランクアップ）を取ったときのひとこと */
const ENERGY_LINE = '元気の前借り';
const EFFECT_LABEL: Readonly<Record<BlockKind, string>> = {
  rank: 'ランクアップ！',
  gold: 'エナドリ！ ランク +2',
  buddy: '相棒 参上！',
  bomb: '一斉削除！',
  vacation: '有給休暇！',
  expand: `キャパ拡張！ 容量 +${B.expand}`,
  trap: '通知が止まらない！',
  hat: '帽子ゲット…',
};

const EFFECT_TONE: Readonly<Record<BlockKind, Tone>> = {
  rank: TONE.white,
  gold: TONE.gold,
  buddy: TONE.green,
  bomb: TONE.gold,
  vacation: TONE.white,
  expand: TONE.white,
  trap: TONE.red,
  hat: TONE.pink,
};

/** 「惜しい」取り逃しとみなす、残り HP の割合の上限 */
const NEAR_MISS_LEFT = 0.5;

/** 「惜しい」取り逃しか。罠と帽子は数えず、半分以上削っていたものだけを数える */
export function isNearMiss(kind: BlockKind, left: number): boolean {
  return kind !== 'trap' && kind !== 'hat' && left < NEAR_MISS_LEFT;
}

/** プレイヤーの弾の列の、手前での x */
export function playerX(s: GameState): number {
  return xOf(s.player.x, 0);
}

export function enemySpriteId(kind: EnemyKind | 'boss', variant: number, bossIndex: number): string {
  if (kind === 'boss') return `boss.${(bossIndex - 1) % 4}`;
  return kind === 'notice' ? `enemy.notice.${variant}` : `enemy.${kind}`;
}

/** ブロックの奥行き（0 が手前、1 が地平線） */
export function blockZ(s: GameState, passAt: number): number {
  return clamp((passAt - s.t) / B.blockTravel, 0, 1);
}

export class View {
  time = 0;
  readonly enemies = new Map<number, EnemyVis>();
  bullets: Bullet[] = [];
  numbers: FloatNumber[] = [];
  particles: Particle[] = [];
  rings: Ring[] = [];
  pickups: Pickup[] = [];
  toasts: Toast[] = [];
  flash = 0;
  shakeLeft = 0;
  /** 一斉削除の白い帯が走り始めた時刻。なければ負 */
  bombWaveAt = -1;
  warning: { boss: boolean; name: string; until: number } | null = null;
  bossIntro: { name: string; line: string; start: number } | null = null;
  /** ゲームオーバーになった時刻。なければ負 */
  overAt = -1;
  /** ブロック・敵に最後に弾が当たった時刻 */
  blockHitAt = -1;
  enemyHitAt = -1;
  /** 最後に発射した時刻（武器の反動と銃口の光用） */
  shotAt = -1;
  /** 最後にランクが上がった時刻（プレイヤーが光る） */
  rankUpAt = -10;
  /** 最後にスコアが増えた時刻（スコアの数字が弾む） */
  scoreAt = -10;
  /** 今撃っているか（ゲームオーバー後は偽） */
  shooting = false;
  /** プレイヤーの横の速さ（px/秒。なめらかにした値）。体の傾きと砂ぼこりに使う */
  vx = 0;
  aim: Aim = { x: 0, y: 0, k: 1, z: 1, hit: false, enemyId: 0, blockId: 0, progress: 0, crit: false, weakX: 0 };
  private readonly blockSpots = new Map<number, BlockSpot>();
  private fireAcc = 0;
  private dustAcc = 0;
  private lastFlashAt = -1;
  private lastScore = 0;
  private px = W / 2;
  /** 埋まり度が recoverFrom を超えたまま、まだ持ち直していない */
  private inDanger = false;
  /** 直近に敵を倒した時刻（なぎ倒しの判定用） */
  private killTimes: number[] = [];
  private lastMowAt = -10;
  private lastDefeatWordAt = -10;
  /** この回で取った相棒の数（2 台目は AI なので、出す言葉を変える） */
  private buddiesGot = 0;
  /** スーツ姿か。最初のボス（月曜日）を倒したら、週が始まったのでスーツに着替える。見た目だけ */
  suit = false;
  /** 前のフレームで、有給休暇の効果中だったか（切れた瞬間を知るため） */
  private onVacation = false;
  private lastVacationWordAt = -100;
  /** 会心が続き始めた時刻（続いていなければ負の値）と、最後に会心だった時刻。「狙い撃ち！」の判定用 */
  private critSince = -1;
  private lastCritAt = -10;
  private lastSnipeAt = -10;
  private lastWave = 1;
  /** この回で、まだ会心を出していない（初めての会心で、ひとこと説明する） */
  private noCritYet = true;
  /** この回で、もう出てきた敵の種類 */
  private readonly seenKinds = new Set<EnemyKind>();
  /** 初めて出た種類の敵の紹介（何と戦っているのかを伝える）。出していなければ null */
  enemyIntro: { kind: EnemyKind; start: number } | null = null;
  /** 遊び方のひとこと（会心の説明）を出すか。デモでは出さない（タイトルの文字と重なるため） */
  tips = true;
  /** 抜けば記録更新になるスコア。遊んでいる最中に抜いた瞬間、ひとこと知らせる。0 なら知らせない（まだ記録がない、デモ） */
  recordToBeat = 0;
  /** 画面の揺れと、画面全体が光る演出を止めるか（OS の「視差効果を減らす」に従う） */
  calm = false;
  private readonly rnd: () => number;
  private readonly sfx: Sfx | null;

  constructor(seed: number, sfx: Sfx | null) {
    this.rnd = mulberry32(seed ^ 0x5eed);
    this.sfx = sfx;
  }

  // ---------------------------------------------------------------- 毎フレームの更新

  update(dt: number, s: GameState): void {
    this.time += dt;
    this.updatePlayer(dt, s);
    this.updateEnemies(dt, s);
    this.pruneEnemies(s);
    this.updateBlocks(s);
    this.updateAim(s);
    this.updateSnipe(s);
    this.updateShooting(dt, s);
    this.updateBullets(dt);
    this.updateRecovery(s);
    this.updateVacation(s);
    this.updateWave(s);
    if (s.score > this.lastScore) this.scoreAt = this.time;
    if (this.recordToBeat > 0 && Math.floor(s.score) > this.recordToBeat && !s.over) {
      this.recordToBeat = 0;
      this.toast('praise', 'ハイスコア更新！', W / 2, 300, 40, TONE.gold, 1.2);
      this.sfx?.praise();
    }
    this.lastScore = s.score;
    this.numbers = this.numbers.filter((n) => (n.age += dt) < LOOK.numberLife);
    this.rings = this.rings.filter((r) => (r.age += dt) < LOOK.ringLife);
    for (const p of this.pickups) {
      p.age += dt;
      if (p.age >= LOOK.pickupTime) {
        this.ring(this.bodyX(), LOOK.playerBottom - 50, 60, BLOCK_COLORS[p.kind]);
        this.sfx?.pickup();
      }
    }
    this.pickups = this.pickups.filter((p) => p.age < LOOK.pickupTime);
    for (const p of this.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.gravity * dt;
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
    this.toasts = this.toasts.filter((t) => this.time - t.start < t.life);
    this.flash = Math.max(0, this.flash - (LOOK.flashAlpha / LOOK.flashTime) * dt);
    this.shakeLeft = Math.max(0, this.shakeLeft - dt);
    if (this.calm) {
      this.flash = 0;
      this.shakeLeft = 0;
    }
    if (this.warning && this.time >= this.warning.until) this.warning = null;
    if (this.bossIntro && this.time - this.bossIntro.start >= LOOK.bossIntroTime) this.bossIntro = null;
  }

  /** プレイヤーの体の中心の x（弾の列より少し左） */
  bodyX(): number {
    return this.px - LOOK.weaponDx;
  }

  private updatePlayer(dt: number, s: GameState): void {
    const x = playerX(s);
    if (dt > 0) this.vx += ((x - this.px) / dt - this.vx) * Math.min(1, dt * 18);
    this.px = x;
    // 速く動いている間は、足元から砂ぼこりを上げる
    if (!s.over && Math.abs(this.vx) > LOOK.dustSpeed) {
      this.dustAcc += dt;
      while (this.dustAcc >= 0.04) {
        this.dustAcc -= 0.04;
        this.burst(this.bodyX() - Math.sign(this.vx) * 14, LOOK.playerBottom - 4, 1, 'rgba(235,240,250,0.6)', 50, 0.32, 7, -40);
      }
    }
  }

  private newEnemyVis(e: Enemy): EnemyVis {
    const variant = Math.floor(this.rnd() * NOTICE_VARIANTS.length);
    const spriteId = enemySpriteId(e.kind, variant, e.bossIndex);
    return { u: e.u, z: 1, variant, phase: this.rnd() * Math.PI * 2, x: xOf(e.u, 1), y: yOf(1), scale: kOf(1), spriteId, age: 0, walking: true };
  }

  private updateEnemies(dt: number, s: GameState): void {
    let ahead = 0;
    const move = LOOK.enemySpeed * dt;
    for (const e of s.enemies) {
      let v = this.enemies.get(e.id);
      if (!v) {
        v = this.newEnemyVis(e);
        this.enemies.set(e.id, v);
      }
      v.age += dt;
      const target = Math.min(1, LOOK.enemyFront + (LOOK.enemySpan * (ahead + e.size / 2)) / s.capacity);
      v.walking = Math.abs(v.z - target) > 1e-4;
      v.z = v.z > target ? Math.max(target, v.z - move) : Math.min(target, v.z + move);
      ahead += e.size;
      const grow = e.kind === 'revolving' ? 1 + (LOOK.revolvingMaxScale - 1) * clamp((s.t - e.born) / B.revolvingTime, 0, 1) : 1;
      v.scale = kOf(v.z) * grow * ENEMY_SCALE[e.kind];
      v.x = xOf(v.u, v.z);
      v.y = yOf(v.z);
    }
  }

  /** 列にもういない敵の、見た目の状態を捨てる。ふつうは倒した出来事で消すが、取りこぼしても溜まり続けないようにする */
  private pruneEnemies(s: GameState): void {
    if (this.enemies.size <= s.enemies.length) return;
    const alive = new Set(s.enemies.map((e) => e.id));
    for (const id of this.enemies.keys()) if (!alive.has(id)) this.enemies.delete(id);
  }

  private updateBlocks(s: GameState): void {
    for (const b of s.blocks) {
      const z = blockZ(s, b.passAt);
      const k = kOf(z);
      this.blockSpots.set(b.id, { x: xOf(b.u, z), y: yOf(z) - 48 * k, k, left: b.passAt - s.t });
    }
    // 消えたブロックの位置は、出来事（破壊・通過）で使ったあと handle が捨てる
  }

  /** 弾の列が当たっている先を求める。当たり方はロジック（step の手順 8）と同じ */
  private updateAim(s: GameState): void {
    const u = s.player.x;
    if (sideOf(u) === 'enemy') {
      const e = s.enemies.find((o) => Math.abs(o.u - u) <= o.halfWidth + AIM.beamHalf);
      const vis = e ? this.enemies.get(e.id) : undefined;
      if (e && vis) {
        const h = sprite(vis.spriteId).h * vis.scale;
        const x = xOf(u, vis.z);
        this.aim = { x, y: vis.y - h / 2, k: kOf(vis.z), z: vis.z, hit: true, enemyId: e.id, blockId: 0, progress: 0, crit: isCritical(e, u, s.t), weakX: xOf(weakPointOf(e, s.t), vis.z) };
        return;
      }
    } else {
      const b = s.blocks.find((o) => Math.abs(o.u - u) <= AIM.blockHalf + AIM.beamHalf);
      if (b) {
        const z = blockZ(s, b.passAt);
        const k = kOf(z);
        const x = xOf(u, z);
        this.aim = { x, y: yOf(z) - 48 * k, k, z, hit: true, enemyId: 0, blockId: b.id, progress: clamp(1 - b.hp / b.maxHp, 0, 1), crit: false, weakX: x };
        return;
      }
    }
    // 標的がなければ、弾は地平線まで飛んで消える
    this.aim = { x: xOf(u, 1), y: yOf(1), k: kOf(1), z: 1, hit: false, enemyId: 0, blockId: 0, progress: 0, crit: false, weakX: xOf(u, 1) };
  }

  /** 銃口の位置。弾の列の真下にある */
  muzzle(): { x: number; y: number } {
    return { x: this.px, y: LOOK.playerBottom - LOOK.weaponUp - WEAPON_SPRITE.h + 4 };
  }

  private updateShooting(dt: number, s: GameState): void {
    this.shooting = !s.over;
    if (!this.shooting) {
      this.fireAcc = 0;
      return;
    }
    const rate = fireRate(s.player.rank);
    this.fireAcc += rate * dt;
    const damage = dpsOf(s.player.rank) / rate;
    while (this.fireAcc >= 1) {
      this.fireAcc -= 1;
      this.fire(s, damage);
    }
  }

  private fire(s: GameState, damage: number): void {
    const stage = weaponStage(s.player.rank);
    const lane = sideOf(s.player.x);
    const { x, y } = this.muzzle();
    const a = this.aim;
    const target = a.enemyId || a.blockId;
    // 会心なら、表示する数字も倍にする
    const shown = damage * (a.crit ? AIM.critMult : 1);
    this.shotAt = this.time;
    this.sfx?.shot(stage);
    // ねこ・レーザー・波動砲は弾を飛ばさず、その場で当たる
    if (stage === 15 || stage === 9 || stage === 10) {
      if (a.hit) this.impact(a.x, a.y, a.k, shown, lane, stage === 15, target, a.crit);
      return;
    }
    const add = (dx: number, dmg: number): void => {
      if (this.bullets.length >= LOOK.maxBullets) this.bullets.shift();
      this.bullets.push({ x0: x, y0: y, x1: a.x + dx, y1: a.y, k1: a.k, age: 0, stage, lane, damage: a.hit ? dmg : 0, target, spin: this.rnd() * 6.28, crit: a.crit });
    };
    if (stage === 5) {
      // ショットガンは扇状に 5 発。数字は真ん中の 1 発だけが出す
      for (let i = -2; i <= 2; i++) add(i * 12 * a.k, i === 0 ? shown : 0);
    } else if (stage === 2) {
      add((this.rnd() - 0.5) * 36 * a.k, shown);
    } else {
      add((this.rnd() - 0.5) * 12 * a.k, shown);
    }
  }

  private updateBullets(dt: number): void {
    for (const b of this.bullets) {
      b.age += dt;
      if (b.age >= LOOK.bulletTime && b.damage > 0) this.impact(b.x1, b.y1, b.k1, b.damage, b.lane, false, b.target, b.crit);
    }
    this.bullets = this.bullets.filter((b) => b.age < LOOK.bulletTime);
  }

  /** ウェーブが変わったら、上のほうに小さく知らせる */
  private updateWave(s: GameState): void {
    const wave = waveOf(s.t);
    if (wave === this.lastWave) return;
    this.lastWave = wave;
    if (s.over) return;
    const boss = wave % B.bossEvery === 0;
    this.toast('wave', boss ? `WAVE ${wave}　ボス戦` : `WAVE ${wave}`, W / 2, 124, 26, boss ? TONE.red : TONE.white, 1.3);
  }

  /** 画面の中央に、ひとこと大きく出す（開始の合図など） */
  announce(label: string): void {
    this.toast('praise', label, W / 2, 300, 46, TONE.gold, 1.1);
  }

  /** 会心を続けたら、ひとこと褒める */
  private updateSnipe(s: GameState): void {
    if (this.aim.crit && !s.over) {
      if (this.critSince < 0) this.critSince = this.time;
      this.lastCritAt = this.time;
    } else if (this.time - this.lastCritAt > LOOK.snipeGap) {
      this.critSince = -1;
    }
    if (this.critSince < 0 || this.time - this.critSince < LOOK.snipeTime) return;
    // 続きは数え直す（出しっぱなしにしない）
    this.critSince = this.time;
    if (this.time - this.lastSnipeAt < LOOK.snipeCooldown) return;
    this.lastSnipeAt = this.time;
    this.toast('praise', '狙い撃ち！', W / 2, 300, 38, TONE.gold, 0.9);
    this.sfx?.praise();
  }

  /** 敵を倒したら、ときどき小さくひとこと出す（社会人あるあるの小ネタ。数の多い敵は間引く） */
  private defeatWord(kind: EnemyKind | 'boss', x: number, y: number): void {
    if (kind === 'boss') return;
    const gap = kind === 'notice' || kind === 'spam' ? LOOK.defeatWordGapCommon : LOOK.defeatWordGap;
    if (this.time - this.lastDefeatWordAt < gap) return;
    this.lastDefeatWordAt = this.time;
    const word = ENEMIES.find((d) => d.id === kind)!.defeat;
    // ダメージの数字と重ならないよう、少し右にずらす
    this.toast('defeat', word, clamp(x + 34, 60, W - 60), y - 14, 19, TONE.white, 0.7);
  }

  /** 有給休暇の効果が切れたら、ひとこと出す */
  private updateVacation(s: GameState): void {
    const now = s.t < s.vacationUntil;
    if (this.onVacation && !now && !s.over && this.time - this.lastVacationWordAt >= LOOK.vacationWordGap) {
      this.lastVacationWordAt = this.time;
      this.toast('aside', VACATION_OVER, W / 2, 398, 26, TONE.white, 1.1);
    }
    this.onVacation = now;
  }

  /** 危機から立て直したら、ひとこと褒める */
  private updateRecovery(s: GameState): void {
    const ratio = s.fill / s.capacity;
    if (ratio >= LOOK.recoverFrom) {
      this.inDanger = true;
    } else if (this.inDanger && ratio < LOOK.recoverTo && !s.over) {
      this.inDanger = false;
      this.toast('praise', '持ち直した！', W / 2, 300, 36, TONE.green, 1.0);
      this.sfx?.praise();
    }
  }

  /**
   * 着弾。数字は標的の絵や文字に重ならないよう、少し上に出す。
   * 同じ標的に続けて当たった分は、1 つの数字に足し込んで大きく見せる。
   */
  private impact(x: number, y: number, k: number, damage: number, lane: Lane, sparkle: boolean, target: number, crit: boolean): void {
    const recent = this.numbers.find((n) => n.target === target && n.age < LOOK.numberMerge);
    if (recent) {
      recent.value += damage;
      if (crit) recent.crit = true;
      recent.label = formatNumber(recent.value);
      recent.bumpedAt = this.time;
    } else {
      if (this.numbers.length >= LOOK.maxNumbers) this.numbers.shift();
      this.numbers.push({
        x: x + (this.rnd() - 0.5) * 34,
        y: y - (lane === 'block' ? 66 : 30) * k + (this.rnd() - 0.5) * 12,
        age: 0,
        value: damage,
        label: formatNumber(damage),
        block: lane === 'block',
        crit,
        tilt: (this.rnd() - 0.5) * 0.3,
        target,
        bumpedAt: this.time,
      });
    }
    this.burst(x, y, 2, sparkle ? '#ffb3d9' : '#fff3b0', 90, 0.22, 3.5);
    if (lane === 'block') {
      this.blockHitAt = this.time;
      this.sfx?.blockHit(this.aim.progress);
    } else {
      this.enemyHitAt = this.time;
      if (crit) this.onCrit();
    }
  }

  /** 会心が当たった。初めてのときだけ、何が起きたかをひとこと出す */
  private onCrit(): void {
    this.sfx?.crit();
    // 開始直後は、上の案内に同じこと（真ん中に当てると会心）が書いてあり、敵の紹介も出ているので、説明は案内が消えてからにする
    if (!this.noCritYet || !this.tips || this.time < LOOK.guideTime) return;
    this.noCritYet = false;
    this.toast('praise', `会心！ 真ん中に当てるとダメージ ${AIM.critMult} 倍`, W / 2, 300, 26, TONE.gold, 1.8);
  }

  /** 破片を散らす */
  burst(x: number, y: number, count: number, color: string, speed: number, life: number, size: number, gravity = 500): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= LOOK.maxParticles) this.particles.shift();
      const a = this.rnd() * Math.PI * 2;
      const v = speed * (0.4 + this.rnd() * 0.8);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - speed * 0.5,
        gravity,
        age: 0,
        life: life * (0.7 + this.rnd() * 0.6),
        size: size * (0.6 + this.rnd() * 0.8),
        color,
      });
    }
  }

  private ring(x: number, y: number, radius: number, color: string): void {
    if (this.rings.length >= LOOK.maxRings) this.rings.shift();
    this.rings.push({ x, y, radius, age: 0, color });
  }

  private toast(key: string, label: string, x: number, y: number, size: number, tone: Tone, life: number): void {
    this.toasts = this.toasts.filter((t) => t.key !== key);
    this.toasts.push({ key, label, x, y, size, tone, start: this.time, life });
  }

  private flashScreen(): void {
    if (this.time - this.lastFlashAt < LOOK.flashGap) return;
    this.lastFlashAt = this.time;
    this.flash = LOOK.flashAlpha;
  }

  /** 短いあいだに敵をまとめて倒したら褒める */
  private countKill(): void {
    this.killTimes.push(this.time);
    this.killTimes = this.killTimes.filter((t) => this.time - t <= LOOK.mowWindow);
    if (this.killTimes.length >= LOOK.mowKills && this.time - this.lastMowAt >= LOOK.mowCooldown) {
      this.lastMowAt = this.time;
      this.toast('praise', 'なぎ倒し！', W / 2, 300, 38, TONE.gold, 0.9);
      this.sfx?.praise();
    }
  }

  // ---------------------------------------------------------------- 出来事への反応

  handle(events: readonly GameEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'enemyKill': {
          const v = this.enemies.get(e.id);
          this.enemies.delete(e.id);
          if (!v) break;
          const h = sprite(v.spriteId).h * v.scale;
          const cy = v.y - h / 2;
          if (e.kind === 'boss') {
            this.burst(v.x, cy, 70, ENEMY_COLORS.boss, 420, 0.9, 12 * v.scale + 4);
            this.burst(v.x, cy, 40, '#ff6b3d', 300, 0.7, 10 * v.scale + 3);
            this.ring(v.x, cy, 260 * v.scale + 60, '#fff3b0');
            this.ring(v.x, cy, 160 * v.scale + 40, '#ffffff');
            this.shakeLeft = LOOK.bossShakeTime;
            this.flashScreen();
          } else {
            this.burst(v.x, cy, e.byBomb ? 2 : 6, e.byBomb ? '#ffffff' : ENEMY_COLORS[e.kind], 150 * v.scale + 40, 0.42, 6 * v.scale + 1.5);
            if (!e.byBomb) {
              this.ring(v.x, cy, h * 0.9 + 6, '#ffffff');
              this.sfx?.kill();
              this.countKill();
              this.defeatWord(e.kind, v.x, cy - h / 2);
            }
          }
          break;
        }
        case 'blockBreak': {
          const f = this.blockSpots.get(e.id);
          this.blockSpots.delete(e.id);
          if (f) {
            this.burst(f.x, f.y, 18, BLOCK_COLORS[e.kind], 260 * f.k + 60, 0.6, 12 * f.k + 2);
            this.burst(f.x, f.y, 8, '#ffffff', 200 * f.k + 40, 0.4, 6 * f.k + 2);
            this.ring(f.x, f.y, 150 * f.k + 20, BLOCK_COLORS[e.kind]);
          }
          // 2 台目の相棒は AI（scene.ts の AI_BUDDY と対応）
          if (e.kind === 'buddy') this.buddiesGot++;
          this.toast('effect', e.kind === 'buddy' && this.buddiesGot === 2 ? AI_BUDDY_LABEL : EFFECT_LABEL[e.kind], W / 2, 352, e.kind === 'trap' ? 46 : 38, EFFECT_TONE[e.kind], 0.9);
          if (e.kind === 'buddy' && this.buddiesGot === 2) this.toast('aside', AI_BUDDY_LINE, W / 2, 398, 22, TONE.white, 1.8);
          if (e.kind === 'gold') this.toast('aside', ENERGY_LINE, W / 2, 398, 22, TONE.white, 1.5);
          this.sfx?.blockBreak();
          if (e.kind === 'trap') {
            if (f) this.burst(f.x, f.y, 14, 'rgba(220,40,40,0.8)', 120, 0.9, 16, -60);
            this.burst(xOf(0, 1), yOf(1), 14, 'rgba(220,40,40,0.8)', 70, 1.0, 10, -40);
            this.sfx?.trap();
            break;
          }
          if (f) this.pickups.push({ kind: e.kind, x0: f.x, y0: f.y, age: 0 });
          if (e.kind === 'bomb') {
            this.bombWaveAt = this.time;
            this.shakeLeft = LOOK.bossShakeTime * 0.6;
            this.sfx?.bomb();
          }
          // うまく取れたら褒める（罠は褒めない）。両取りを優先
          if (e.double) {
            this.toast('praise', '両取り！', W / 2, 300, 40, TONE.gold, 1.0);
            this.sfx?.praise();
          } else if (f && f.left < LOOK.closeCall) {
            this.toast('praise', 'ギリギリ！', W / 2, 300, 36, TONE.gold, 0.9);
            this.sfx?.praise();
          }
          break;
        }
        case 'rankUp':
          this.flashScreen();
          this.rankUpAt = this.time;
          this.burst(this.bodyX(), LOOK.playerBottom - 50, 16, '#ffe066', 260, 0.7, 6, -120);
          this.ring(this.bodyX(), LOOK.playerBottom - 46, 110, '#ffe066');
          if (e.stageChanged) this.toast('weapon', weaponName(e.rank), W / 2, 440, 54, TONE.gold, 1.0);
          this.sfx?.rankUp(e.rank, e.stageChanged);
          break;
        case 'blockPass': {
          const f = this.blockSpots.get(e.id);
          this.blockSpots.delete(e.id);
          // 役に立つブロックを半分以上削ってから逃したときだけ「惜しい！」
          if (isNearMiss(e.kind, e.left)) {
            this.toast('miss', '惜しい！', f ? clamp(f.x, 90, W - 90) : W / 2, 790, 36, TONE.red, 0.8);
            this.sfx?.miss();
          }
          break;
        }
        case 'rushWarning':
          this.warning = { boss: false, name: rushLine(e.wave), until: this.time + LOOK.warningTime };
          this.sfx?.rushWarning();
          break;
        case 'bossWarning':
          this.warning = { boss: true, name: bossName(e.index), until: this.time + LOOK.warningTime };
          this.sfx?.bossWarning();
          break;
        case 'bossSpawn':
          this.bossIntro = { name: bossName(e.index), line: bossLines(e.index).intro, start: this.time };
          this.shakeLeft = LOOK.bossShakeTime;
          this.sfx?.bossSpawn();
          break;
        case 'bossKill':
          this.toast('effect', `${bossName(e.index)} 撃破！`, W / 2, 352, 40, TONE.gold, 1.4);
          this.toast('aside', bossLines(e.index).defeat, W / 2, 398, 22, TONE.white, 1.8);
          this.suit = true;
          this.sfx?.bossKill();
          break;
        case 'gameOver':
          this.overAt = this.time;
          this.sfx?.gameOver();
          break;
        case 'enemySpawn':
          if (this.tips && !this.seenKinds.has(e.kind)) {
            this.seenKinds.add(e.kind);
            this.enemyIntro = { kind: e.kind, start: this.time };
          }
          break;
        case 'blockSpawn':
          break;
      }
    }
  }
}
