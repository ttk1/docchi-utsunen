// 効果音と BGM（仕様書 7 章）。すべて Web Audio の発振器とノイズで合成し、音声ファイルは持たない。
import { B } from '../core/balance.ts';
import type { Sfx } from '../render/view.ts';

/** 音の終わりを、プチッと切れないようゼロへ落とす時間（秒） */
const TAIL = 0.015;

/** 1 秒あたりに鳴らす回数の上限 */
const LIMIT = { shot: 12, kill: 10, blockHit: 8, pickup: 6, crit: 10 } as const;

/** 音量の配分。効果音と BGM を別の系統にまとめ、最後に圧縮して音割れを防ぐ */
const MIX = {
  master: 0.9,
  sfx: 0.9,
  bgm: 0.55,
  /** 埋まり度が危険域のあいだ、BGM を下げて心拍を目立たせる */
  bgmDanger: 0.3,
} as const;

/** 武器の段階ごとの発射音。[波形, 始まりの高さ, 終わりの高さ, 長さ, ノイズの量] */
const SHOTS: readonly (readonly [OscillatorType, number, number, number, number])[] = [
  ['sine', 900, 500, 0.06, 0], // 水鉄砲
  ['triangle', 520, 260, 0.07, 0], // 輪ゴム鉄砲
  ['square', 1200, 900, 0.03, 0.2], // 節分の豆
  ['square', 700, 300, 0.05, 0.3], // エアガン
  ['square', 420, 120, 0.07, 0.5], // ピストル
  ['sawtooth', 260, 60, 0.12, 0.9], // ショットガン
  ['square', 360, 140, 0.04, 0.5], // マシンガン
  ['sawtooth', 240, 90, 0.05, 0.7], // ガトリング砲
  ['sawtooth', 160, 40, 0.18, 0.8], // バズーカ
  ['sawtooth', 1500, 1300, 0.06, 0], // レーザー
  ['sawtooth', 300, 700, 0.09, 0.1], // 波動砲
  ['triangle', 1047, 1319, 0.07, 0], // 回転寿司レーン砲
  ['square', 1568, 2093, 0.06, 0], // 課金砲
  ['sine', 1319, 988, 0.08, 0], // 既読スルー光線
  ['triangle', 784, 1175, 0.09, 0], // 定時退社ビーム
  ['sine', 620, 880, 0.1, 0], // ねこ
];

/** 1 小節ぶんの和音。root はベースの高さ、tones はメロディが使う 4 音（Hz） */
interface Chord {
  root: number;
  tones: readonly [number, number, number, number];
}

/** ふだんの進行（Am → F → C → G） */
const CHORDS: readonly Chord[] = [
  { root: 55, tones: [440, 523.25, 659.25, 880] },
  { root: 43.65, tones: [440, 523.25, 698.46, 880] },
  { root: 65.41, tones: [392, 523.25, 659.25, 783.99] },
  { root: 49, tones: [392, 493.88, 587.33, 783.99] },
];
/** ボス戦のウェーブの進行（Am → Dm → E → Am）。半音ぶつかる音で緊張させる */
const BOSS_CHORDS: readonly Chord[] = [
  { root: 55, tones: [440, 523.25, 659.25, 880] },
  { root: 73.42, tones: [440, 587.33, 698.46, 880] },
  { root: 82.41, tones: [415.3, 493.88, 659.25, 830.61] },
  { root: 55, tones: [440, 523.25, 659.25, 880] },
];

/** BGM の 1 小節 = 8 分音符 8 個 */
const BGM = {
  baseBpm: 104,
  bpmPerWave: 4,
  maxBpm: 168,
  /** 何秒先まで音を予約するか */
  lookahead: 0.25,
  /** ベースの高さ（root に掛ける倍率）。0 は休み */
  bass: [1, 0, 1, 2, 0, 1, 1.5, 2],
  /** メロディが和音のどの音を弾くか */
  lead: [0, 1, 2, 1, 3, 2, 1, 2],
  /** メロディが入り始める WAVE */
  leadFromWave: 2,
} as const;

/** 心拍の間隔（秒）。埋まり度 70% で slow、100% で fast */
const HEARTBEAT = { from: 0.7, slow: 0.95, fast: 0.38 } as const;

export class Synth implements Sfx {
  private ctx: BaseAudioContext | null = null;
  private sfxBus: GainNode | null = null;
  private bgmBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled: boolean;
  private readonly last = new Map<string, number>();
  private bgmOn = false;
  private bgmStep = 0;
  private bgmNext = 0;
  private heartNext = 0;

  /** context を渡すと、その上で音を組む（音量を測る確認用。ふだんは渡さない） */
  constructor(enabled: boolean, context?: BaseAudioContext) {
    this.enabled = enabled;
    if (context) this.build(context);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private build(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = MIX.master;
    const squash = ctx.createDynamicsCompressor();
    squash.threshold.value = -16;
    squash.knee.value = 12;
    squash.ratio.value = 6;
    squash.attack.value = 0.003;
    squash.release.value = 0.15;
    squash.connect(master).connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = MIX.sfx;
    this.sfxBus.connect(squash);
    this.bgmBus = ctx.createGain();
    this.bgmBus.gain.value = MIX.bgm;
    this.bgmBus.connect(squash);
    const len = ctx.sampleRate;
    this.noiseBuffer = ctx.createBuffer(1, len, len);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  /**
   * 実際に音を出している context（確認用に渡された context では null）。
   * `instanceof AudioContext` では見分けない。音の機能がないブラウザや、接頭辞つきの名前（webkitAudioContext）しかない
   * 古いブラウザでは、AudioContext という名前そのものがなく、触れただけで例外になるため
   */
  private live: AudioContext | null = null;

  /** 最初のタップやキー入力で呼ぶ。ブラウザは操作があるまで音を出せない */
  unlock(): void {
    if (!this.enabled) return;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.live = new AC();
      this.build(this.live);
    }
    if (this.live?.state === 'suspended') void this.live.resume();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.unlock();
    else void this.live?.suspend();
  }

  /** 一時停止やタブが隠れたときに止める */
  suspend(): void {
    void this.live?.suspend();
  }

  resume(): void {
    if (this.enabled) void this.live?.resume();
  }

  private get ready(): boolean {
    if (!this.enabled || !this.ctx) return false;
    return this.live ? this.live.state === 'running' : true;
  }

  private allow(key: string, perSecond: number): boolean {
    const now = this.ctx!.currentTime;
    if (now - (this.last.get(key) ?? -1) < 1 / perSecond) return false;
    this.last.set(key, now);
    return true;
  }

  /**
   * 音量の山。すばやく立ち上がり、dur 秒かけて 3% まで減り、最後は短くゼロへ落とす。
   * いきなりゼロ近くまで減らすと一瞬の「チッ」という音にしかならず、聞こえにくい。
   */
  private envelope(gain: AudioParam, t: number, dur: number, peak: number): void {
    gain.setValueAtTime(0.0001, t);
    gain.linearRampToValueAtTime(peak, t + 0.004);
    gain.exponentialRampToValueAtTime(peak * 0.03, t + Math.max(dur, 0.01));
    gain.linearRampToValueAtTime(0, t + Math.max(dur, 0.01) + TAIL);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0, bus = this.sfxBus!): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    this.envelope(g.gain, t, dur, gain);
    osc.connect(g).connect(bus);
    osc.start(t);
    osc.stop(t + dur + TAIL + 0.01);
  }

  private noise(dur: number, gain: number, f0: number, f1: number, type: BiquadFilterType = 'lowpass', delay = 0, bus = this.sfxBus!): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    const g = ctx.createGain();
    this.envelope(g.gain, t, dur, gain);
    src.connect(filter).connect(g).connect(bus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + TAIL + 0.01);
  }

  /** 同じ音が続いても機械的に聞こえないよう、高さを少しだけ揺らす */
  private jitter(amount = 0.05): number {
    return 1 + (Math.random() * 2 - 1) * amount;
  }

  // ---------------------------------------------------------------- 効果音

  shot(stage: number): void {
    if (!this.ready || !this.allow('shot', LIMIT.shot)) return;
    const [type, f0, f1, dur, n] = SHOTS[stage] ?? SHOTS[0]!;
    const j = this.jitter();
    this.tone(type, f0 * j, f1 * j, dur, 0.26);
    if (n > 0) this.noise(dur, 0.28 * n, 3000, 600);
  }

  /** 壊れる間際ほど高い音にして、「あと少し」を耳でも分かるようにする */
  blockHit(progress: number): void {
    if (!this.ready || !this.allow('blockHit', LIMIT.blockHit)) return;
    const f = 170 * 2 ** (progress * 1.6);
    this.tone('square', f, f * 0.7, 0.045, 0.3);
    this.noise(0.03, 0.2, 2500, 1200, 'bandpass');
  }

  /** 会心の弾が当たった。ふつうの命中と聞き分けられる、高く澄んだ短い音 */
  crit(): void {
    if (!this.ready || !this.allow('crit', LIMIT.crit)) return;
    const j = this.jitter(0.03);
    this.tone('triangle', 1760 * j, 2217 * j, 0.06, 0.3);
  }

  kill(): void {
    if (!this.ready || !this.allow('kill', LIMIT.kill)) return;
    const j = this.jitter(0.18);
    this.noise(0.07, 0.4, 1800, 300);
    this.tone('triangle', 560 * j, 200 * j, 0.08, 0.32);
  }

  blockBreak(): void {
    if (!this.ready) return;
    [523, 659, 784].forEach((f, i) => this.tone('triangle', f, f, 0.1, 0.3, i * 0.05));
    this.noise(0.14, 0.25, 4500, 700);
  }

  pickup(): void {
    if (!this.ready || !this.allow('pickup', LIMIT.pickup)) return;
    this.tone('square', 1319, 1319, 0.05, 0.2);
    this.tone('square', 1760, 1760, 0.09, 0.2, 0.05);
  }

  /** ランクが上がるほど半音ずつ高くなる。武器の段階が変わったら長いファンファーレ */
  rankUp(rank: number, stageChanged: boolean): void {
    if (!this.ready) return;
    const base = 440 * 2 ** ((rank % 12) / 12);
    const steps = stageChanged ? [0, 4, 7, 12, 7, 12, 16] : [0, 4, 7];
    steps.forEach((s, i) => this.tone('square', base * 2 ** (s / 12), base * 2 ** (s / 12), stageChanged ? 0.14 : 0.09, 0.2, 0.1 + i * (stageChanged ? 0.085 : 0.055)));
    if (stageChanged) this.noise(0.5, 0.08, 6000, 2000, 'highpass', 0.1);
  }

  miss(): void {
    if (!this.ready) return;
    this.tone('triangle', 440, 415, 0.14, 0.3);
    this.tone('triangle', 311, 262, 0.22, 0.3, 0.14);
  }

  trap(): void {
    if (!this.ready) return;
    for (const f of [185, 196, 277]) this.tone('sawtooth', f, f * 0.94, 0.5, 0.2, 0.1);
  }

  bomb(): void {
    if (!this.ready) return;
    this.noise(0.6, 0.5, 900, 60);
    this.tone('sine', 110, 30, 0.5, 0.4);
  }

  rushWarning(): void {
    if (!this.ready) return;
    for (let i = 0; i < 2; i++) this.tone('square', 880, 880, 0.14, 0.25, i * 0.28);
  }

  bossWarning(): void {
    if (!this.ready) return;
    for (let i = 0; i < 3; i++) this.tone('sawtooth', 196, 147, 0.3, 0.3, i * 0.45);
  }

  bossSpawn(): void {
    if (!this.ready) return;
    this.tone('sine', 90, 28, 0.7, 0.5);
    this.tone('sawtooth', 110, 55, 0.5, 0.18);
    this.noise(0.5, 0.3, 500, 60);
  }

  bossKill(): void {
    if (!this.ready) return;
    this.noise(1.3, 0.6, 2400, 50);
    this.tone('sine', 150, 25, 1.1, 0.5);
    [523, 659, 784, 1047].forEach((f, i) => this.tone('square', f, f, 0.16, 0.1, 0.5 + i * 0.1));
  }

  /** 「両取り！」「ギリギリ！」「持ち直した！」「なぎ倒し！」に添える、短く明るい 2 音 */
  praise(): void {
    if (!this.ready) return;
    this.tone('triangle', 988, 988, 0.08, 0.28);
    this.tone('triangle', 1319, 1319, 0.14, 0.28, 0.08);
  }

  gameOver(): void {
    if (!this.ready) return;
    this.stopBgm();
    this.tone('sawtooth', 440, 55, 1.4, 0.25);
    this.tone('triangle', 330, 41, 1.4, 0.2, 0.05);
  }

  /** リザルトでハイスコアを更新したとき */
  newRecord(): void {
    if (!this.ready) return;
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone('square', f, f, 0.18, 0.22, i * 0.11));
    this.tone('triangle', 1568, 1568, 0.5, 0.25, 0.6);
  }

  click(): void {
    if (!this.ready) return;
    this.tone('triangle', 660, 880, 0.06, 0.4);
  }

  /** ネタのショップで「購入」したとき。レジの音 */
  purchase(): void {
    if (!this.ready) return;
    this.noise(0.05, 0.25, 6000, 3000, 'highpass');
    this.tone('square', 1568, 1568, 0.07, 0.22, 0.05);
    this.tone('square', 2093, 2093, 0.22, 0.22, 0.13);
  }

  // ---------------------------------------------------------------- BGM と心拍

  startBgm(): void {
    this.bgmOn = true;
    this.bgmStep = 0;
    this.bgmNext = 0;
    this.heartNext = 0;
  }

  stopBgm(): void {
    this.bgmOn = false;
  }

  /** BGM の 8 分音符 1 個ぶんを予約する */
  private bgmNote(step: number, delay: number, eighth: number, wave: number, rush: boolean): void {
    const boss = wave % B.bossEvery === 0;
    const chord = (boss ? BOSS_CHORDS : CHORDS)[Math.floor(step / 8) % 4]!;
    const i = step % 8;
    const bus = this.bgmBus!;
    // ベース
    const bass = BGM.bass[i]!;
    if (bass > 0) {
      this.tone('sawtooth', chord.root * bass, chord.root * bass, eighth * 0.9, 0.2, delay, bus);
      this.tone('square', chord.root * bass * 2, chord.root * bass * 2, eighth * 0.5, 0.04, delay, bus);
    }
    // ドラム: キックは 1・3 拍、スネアは 2・4 拍、ハイハットは 8 分（ラッシュ中は 16 分）
    if (i % 4 === 0) this.tone('sine', 130, 42, 0.13, 0.45, delay, bus);
    if (i % 4 === 2) {
      this.noise(0.11, 0.2, 2200, 900, 'bandpass', delay, bus);
      this.tone('triangle', 190, 120, 0.07, 0.1, delay, bus);
    }
    this.noise(0.03, i % 2 ? 0.08 : 0.04, 9000, 7000, 'highpass', delay, bus);
    if (rush) this.noise(0.02, 0.05, 9000, 7000, 'highpass', delay + eighth / 2, bus);
    // メロディ。ボス戦は硬い音色で、1 オクターブ下も重ねる
    if (wave >= BGM.leadFromWave) {
      const f = chord.tones[BGM.lead[i]!]!;
      this.tone(boss ? 'square' : 'triangle', f, f, eighth * 0.8, boss ? 0.06 : 0.085, delay, bus);
      if (boss) this.tone('sawtooth', f / 2, f / 2, eighth * 0.8, 0.04, delay, bus);
    }
  }

  /** 今から horizon 秒先までの BGM を予約する */
  private scheduleBgm(horizon: number, wave: number, rush: boolean): void {
    const now = this.ctx!.currentTime;
    if (this.bgmNext < now) this.bgmNext = now + 0.05;
    while (this.bgmNext < now + horizon) {
      const bpm = Math.min(BGM.maxBpm, BGM.baseBpm + (wave - 1) * BGM.bpmPerWave);
      const eighth = 60 / bpm / 2;
      this.bgmNote(this.bgmStep, this.bgmNext - now, eighth, wave, rush);
      this.bgmNext += eighth;
      this.bgmStep++;
    }
  }

  /**
   * 毎フレーム呼ぶ。少し先までの音を予約する。
   * WAVE が進むごとにテンポを上げ、ラッシュ中はハイハットを倍に刻み、ボス戦のウェーブは進行を変える。
   */
  update(wave: number, rush: boolean, fillRatio: number): void {
    if (!this.ready || !this.bgmOn) return;
    const now = this.ctx!.currentTime;
    this.scheduleBgm(BGM.lookahead, wave, rush);
    const danger = fillRatio >= HEARTBEAT.from;
    this.bgmBus!.gain.setTargetAtTime(danger ? MIX.bgmDanger : MIX.bgm, now, 0.2);
    // 心拍のような低音。割合が上がるほど速く
    if (danger) {
      if (this.heartNext < now) {
        const d = Math.min(1, (fillRatio - HEARTBEAT.from) / (1 - HEARTBEAT.from));
        this.tone('sine', 70, 40, 0.12, 0.55);
        this.tone('sine', 60, 36, 0.12, 0.4, 0.14);
        this.heartNext = now + HEARTBEAT.slow + (HEARTBEAT.fast - HEARTBEAT.slow) * d;
      }
    } else {
      this.heartNext = 0;
    }
  }

  /** 確認用: BGM を seconds 秒ぶんまとめて予約する（音量を測るときに使う） */
  renderBgm(seconds: number, wave: number, rush: boolean): void {
    if (!this.ready) return;
    this.scheduleBgm(seconds, wave, rush);
  }
}
