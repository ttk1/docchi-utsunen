// 起動、画面遷移、入力、毎フレームの更新と描画（仕様書 6.6 節・6.8 節・8.2 節）。
import { Synth } from '../audio/synth.ts';
import { AIM, B, RUSH_START } from '../core/balance.ts';
import { socialPower, waveOf, weaponName } from '../core/formulas.ts';
import type { GameEvent } from '../core/state.ts';
import { drawHud } from '../render/hud.ts';
import { CENTER_X, H, HALF_ROAD, W } from '../render/projection.ts';
import { drawScene, initScene } from '../render/scene.ts';
import { initSprites } from '../render/sprites.ts';
import {
  CAPTION_SECONDS,
  FAIL_SECONDS,
  drawBanner,
  drawPause,
  drawResult,
  drawTitle,
  pauseButtons,
  playButtons,
  resultButtons,
  resultText,
  shareText,
  titleButtons,
  type ResultStats,
} from './screens.ts';
import { reviewPlay } from './review.ts';
import { Session } from './session.ts';
import { CONTINUE_COST, GEM, PACKS, PAYING_SECONDS, drawShop, shopButtons, type ShopStep } from './shop.ts';
import { loadGems, loadHighScore, loadSound, loadSpent, saveGems, saveHighScore, saveSound, saveSpent } from './storage.ts';
import { drawButton, hitButton, type Button } from './ui.ts';

type Mode = 'title' | 'play' | 'paused' | 'result' | 'shop';

/** ゲームオーバーからリザルトを出すまでの秒数（7 章） */
const RESULT_DELAY = 1.5;
/** リザルトが出てから、ボタンが押せるようになるまでの秒数。負ける間際に画面を連打していた指で、うっかり押さないように */
const RESULT_LOCK = 0.5;
/** 画面が切り替わったあと、明るくなるまでの秒数 */
const FADE_SECONDS = 0.35;
/** 実解像度を上げる上限。高すぎると描画が重くなる */
const MAX_PIXEL_RATIO = 2;
/** 指で操作する端末か（タッチが主な入力）。指を置く場所をあけるかどうかに使う */
const FINGER_INPUT = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** 指を置く場所の高さ。画面の高さに対する割合と、最低限の px */
const FINGER_AREA_RATIO = 0.1;
const FINGER_AREA_MIN = 64;
/**
 * 余白に敷く、ぼかした背景。小さく描いて CSS で引き伸ばすので、粗い絵で足りる。
 * 毎フレーム写す必要はないので、間をあける（秒）
 */
const BACKDROP_WIDTH = 48;
const BACKDROP_INTERVAL = 0.1;
/** 背景を暗くする濃さ。ゲームの画面より目立たせない */
const BACKDROP_DIM = 0.5;
/** 1 フレームの経過時間の上限（秒）。タブが戻った直後などの飛びを捨てる */
const MAX_FRAME = 0.1;
/** 「X にポスト」で開く投稿画面 */
const SHARE_URL = 'https://x.com/intent/post';
/**
 * 指を離したときに実行するボタン。別のタブを開く・クリップボードに書くといった操作は、
 * ブラウザが「利用者の操作」と認めたときしか通らず、指で触れた瞬間（pointerdown）はまだ認められないため
 */
const ON_RELEASE: readonly string[] = ['copy', 'share'];
/** デモの字幕「あああああ」を出す埋まり度の割合 */
const DEMO_PANIC_RATIO = 0.9;

function newSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0;
}

/** OS で「視差効果を減らす」を選んでいる人には、画面の揺れと、画面全体が光る演出を出さない */
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function createSession(demo: boolean, sfx: Synth | null): Session {
  const session = new Session(newSeed(), demo, sfx);
  session.view.calm = REDUCED_MOTION;
  return session;
}

class App {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** 余白（PC の左右、縦長のスマホの上下）に敷く、ゲームの画面をぼかした背景 */
  private readonly backdrop: HTMLCanvasElement;
  private backdropAt = -1;
  private readonly synth = new Synth(loadSound());
  private highScore = loadHighScore();
  private mode: Mode = 'title';
  private session = createSession(true, null);
  /** 論理解像度（540×960）から、キャンバスの実際の画素への拡大率。横と縦で別に持つ（下の resize を参照） */
  private scaleX = 1;
  private scaleY = 1;
  private time = 0;
  private last = 0;
  /** キーボードで選んでいるボタンの番号。操作するまでは -1（決定キーは主ボタンに効く） */
  private focus = -1;
  private overAge = 0;
  private caption: { label: string; until: number } | null = null;
  /** 押されたあと、指を離すのを待っているボタン（ON_RELEASE） */
  private pressOnRelease: string | null = null;
  private demoPanicked = false;
  private closePressedAt = -10;
  private result: ResultStats | null = null;
  private resultAt = 0;
  /** ネタのショップ。やる気（gems）と気持ち課金額は、ゲームの強さに影響しない */
  private gems = loadGems();
  private spent = loadSpent();
  private shopStep: ShopStep = { at: 'list', notice: '' };
  /** ショップを閉じたら戻る画面 */
  private shopFrom: 'title' | 'result' = 'title';
  /** 本編の開始直後に、画面の上のほうへ出すひとこと */
  private banner: { label: string; until: number } | null = null;
  /** 画面が切り替わった時刻。切り替わった直後は、黒から明るくなる */
  private fadeAt = -10;
  private readonly held = { left: false, right: false };
  /** キーで動いている最中か（離した瞬間に止めるために覚えておく） */
  private keyMoving = false;
  /** 今のキャンバスの置き方が、タイトル以外（指を置く場所をあける）向けか */
  private inGameLayout = false;
  private message: { label: string; until: number } | null = null;

  constructor(canvas: HTMLCanvasElement, backdrop: HTMLCanvasElement) {
    this.canvas = canvas;
    this.backdrop = backdrop;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.releaseKeys());
    // マウスは動かすだけで、指は触れている間、その横位置を狙う
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    // 余白（キャンバスの外の黒い部分）に触れても狙えるよう、画面全体で受ける
    window.addEventListener('pointerdown', (e) => this.onPointer(e));
    // iOS は指を離したときの操作でないと音を出せないことがあるので、離したときにも有効化を試みる
    for (const type of ['pointerup', 'touchend'] as const) window.addEventListener(type, () => this.onRelease());
    // ページの拡大・スクロール・長押しメニューを止める
    for (const type of ['touchstart', 'touchmove', 'gesturestart', 'dblclick', 'contextmenu'] as const) {
      // 取り消せない出来事（画面の置き方が変わった直後のタッチなど）で preventDefault を呼ぶと、ブラウザがエラーを出すので確かめてから呼ぶ
      document.addEventListener(
        type,
        (e) => {
          if (e.cancelable) e.preventDefault();
        },
        { passive: false },
      );
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.mode === 'play') this.pause();
        this.synth.suspend();
      } else if (this.mode !== 'paused') {
        this.synth.resume();
      }
    });
    requestAnimationFrame((now) => this.frame(now));
  }

  // ---------------------------------------------------------------- 画面遷移

  private toTitle(): void {
    this.fadeAt = this.time;
    this.mode = 'title';
    this.focus = -1;
    this.synth.stopBgm();
    this.synth.resume();
    this.startDemo();
  }

  /** 後ろでデモが流れている画面か（タイトルと、タイトルから開いたショップ）。表示類とキャンバスの置き方を、タイトルのものにする */
  private get onTitle(): boolean {
    return this.mode === 'title' || (this.mode === 'shop' && this.shopFrom === 'title');
  }

  private startDemo(): void {
    this.session = createSession(true, null);
    this.overAge = 0;
    this.caption = null;
    this.demoPanicked = false;
  }

  private startGame(): void {
    this.fadeAt = this.time;
    this.mode = 'play';
    this.focus = -1;
    this.overAge = 0;
    this.result = null;
    this.message = null;
    this.banner = null;
    this.session = createSession(false, this.synth);
    this.session.view.recordToBeat = this.highScore;
    this.synth.resume();
    this.synth.startBgm();
  }

  private pause(): void {
    if (this.mode !== 'play' || this.session.state.over) return;
    this.releaseKeys();
    this.mode = 'paused';
    this.focus = -1;
    this.synth.suspend();
  }

  private resume(): void {
    this.mode = 'play';
    this.focus = -1;
    this.synth.resume();
  }

  private showResult(): void {
    const s = this.session.state;
    const score = Math.floor(s.score);
    const newRecord = score > this.highScore;
    if (newRecord) {
      this.highScore = score;
      saveHighScore(score);
    }
    const review = reviewPlay(s, this.session.blockShare, this.session.nearMisses);
    this.result = { score, highScore: this.highScore, newRecord, wave: waveOf(s.t), weapon: weaponName(s.player.rank), power: socialPower(score), review };
    this.resultAt = this.time;
    if (newRecord) this.synth.newRecord();
    this.mode = 'result';
    this.focus = -1;
  }

  private toggleSound(): void {
    const on = !this.synth.isEnabled;
    this.synth.setEnabled(on);
    saveSound(on);
    this.synth.click();
  }

  /** 結果を貼るときに添える、このページの URL */
  private pageUrl(): string {
    return `${location.origin}${location.pathname}`;
  }

  private copyResult(): void {
    if (!this.result) return;
    const show = (m: string): void => {
      this.message = { label: m, until: this.time + 2.5 };
    };
    // クリップボードが使えない環境では、結果そのものを画面に出す
    const fallback = resultText(this.result);
    const clip = navigator.clipboard;
    if (!clip) {
      show(fallback);
      return;
    }
    clip.writeText(`${shareText(this.result)}
${this.pageUrl()}`).then(
      () => show('コピーしました'),
      () => show(fallback),
    );
  }

  /** 結果を書き込んだ投稿画面を、別のタブで開く。投稿するかどうかは、開いた先で本人が決める */
  private shareResult(): void {
    if (!this.result) return;
    const query = `text=${encodeURIComponent(shareText(this.result))}&url=${encodeURIComponent(this.pageUrl())}`;
    window.open(`${SHARE_URL}?${query}`, '_blank', 'noopener,noreferrer');
  }

  // ---------------------------------------------------------------- 入力

  private buttons(): Button[] {
    switch (this.mode) {
      case 'title':
        return titleButtons(this.synth.isEnabled);
      case 'play':
        return this.session.state.over ? [] : playButtons();
      case 'paused':
        return pauseButtons(this.synth.isEnabled);
      case 'result':
        return this.time - this.resultAt < RESULT_LOCK ? [] : resultButtons();
      case 'shop':
        return shopButtons(this.shopStep);
    }
  }

  private press(id: string): void {
    if (id !== 'sound') this.synth.click();
    switch (id) {
      case 'play':
      case 'retry':
        this.startGame();
        break;
      case 'sound':
        this.toggleSound();
        break;
      case 'close':
        this.closePressedAt = this.time;
        break;
      case 'pause':
        this.pause();
        break;
      case 'resume':
        this.resume();
        break;
      case 'title':
        this.toTitle();
        break;
      case 'shop':
        this.openShop('');
        break;
      case 'continue':
        this.fakeContinue();
        break;
      case 'shopClose':
      case 'cancel':
      case 'ok':
      case 'pay':
      case 'refund':
        this.shopAction(id);
        break;
      case 'copy':
        this.copyResult();
        break;
      case 'share':
        this.shareResult();
        break;
      default:
        if (id.startsWith('buy')) this.shopAction(id);
    }
  }

  // ---------------------------------------------------------------- ネタのショップ

  private openShop(notice: string): void {
    this.shopFrom = this.mode === 'result' ? 'result' : 'title';
    this.shopStep = { at: 'list', notice };
    this.mode = 'shop';
    this.focus = -1;
  }

  private shopAction(id: string): void {
    const step = this.shopStep;
    if (id.startsWith('buy') && step.at === 'list') {
      this.shopStep = { at: 'confirm', pack: Number(id.slice(3)) };
    } else if (id === 'pay' && step.at === 'confirm') {
      this.shopStep = { at: 'paying', pack: step.pack, since: this.time };
    } else if (id === 'cancel' || id === 'ok') {
      this.shopStep = { at: 'list', notice: '' };
    } else if (id === 'refund') {
      // もともと 0 円なので、返すものは気持ちだけ
      this.spent = 0;
      this.gems = 0;
      saveSpent(0);
      saveGems(0);
      this.shopStep = { at: 'list', notice: '返金しました（もともと ¥0 です）。やる気も元に戻りました' };
    } else if (id === 'shopClose') {
      this.mode = this.shopFrom;
    }
    this.focus = -1;
  }

  /** 「決済」が終わったら、やる気を足す。請求は 0 円 */
  private finishPayment(pack: number): void {
    const p = PACKS[pack]!;
    this.gems += p.gems;
    this.spent += p.yen;
    saveGems(this.gems);
    saveSpent(this.spent);
    this.shopStep = { at: 'done', pack };
    this.synth.purchase();
  }

  /**
   * リザルトの「コンティニュー」。やる気を払うと続きから…とはならず、気持ちだけ続けて最初から始まる。
   * 本当に続きから遊べると、払った人だけが有利になってしまうため。
   */
  private fakeContinue(): void {
    if (this.gems < CONTINUE_COST) {
      this.openShop(`やる気が足りません（コンティニューには ${GEM}${CONTINUE_COST}必要です）`);
      return;
    }
    this.gems -= CONTINUE_COST;
    saveGems(this.gems);
    this.startGame();
    this.banner = { label: 'コンティニュー！…は気持ちだけ。WAVE 1 からどうぞ', until: this.time + 3.5 };
  }

  /** 画面の x（論理解像度）を、立ちたい横位置にする */
  private aimAt(x: number): void {
    if (this.mode === 'play') this.session.aim = (x - CENTER_X) / HALF_ROAD;
  }

  private logicalX(e: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * W;
  }

  private onPointerMove(e: PointerEvent): void {
    // マウスがボタンの上にあるときは、押せることをカーソルで示す
    if (e.pointerType === 'mouse') {
      const rect = this.canvas.getBoundingClientRect();
      const y = ((e.clientY - rect.top) / rect.height) * H;
      document.body.style.cursor = hitButton(this.buttons(), this.logicalX(e), y) ? 'pointer' : '';
    }
    if (e.pointerType === 'mouse' || e.buttons > 0 || e.pressure > 0) this.aimAt(this.logicalX(e));
  }

  private releaseKeys(): void {
    this.held.left = false;
    this.held.right = false;
  }

  private onKeyUp(e: KeyboardEvent): void {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'ArrowLeft' || key === 'a') this.held.left = false;
    else if (key === 'ArrowRight' || key === 'd') this.held.right = false;
  }

  /** キーを押している間はその向きへ動き続け、離したらその場で止まる */
  private applyKeys(): void {
    if (this.held.left !== this.held.right) {
      this.session.aim = this.held.left ? AIM.minX : AIM.maxX;
      this.keyMoving = true;
    } else if (this.keyMoving) {
      this.session.aim = this.session.state.player.x;
      this.keyMoving = false;
    }
  }

  private onRelease(): void {
    this.synth.unlock();
    const id = this.pressOnRelease;
    this.pressOnRelease = null;
    if (id) this.press(id);
  }

  private onPointer(e: PointerEvent): void {
    e.preventDefault();
    // 指で触れた瞬間は、ブラウザがまだ「利用者の操作」と認めないので、音の有効化は離したとき（pointerup）に任せる。
    // 触れた瞬間に試みると、有効化できないうえにコンソールへ警告が出る
    if (e.pointerType !== 'touch') this.synth.unlock();
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const y = ((e.clientY - rect.top) / rect.height) * H;
    const b = hitButton(this.buttons(), x, y);
    if (b) {
      this.focus = -1;
      if (ON_RELEASE.includes(b.id)) {
        this.pressOnRelease = b.id;
      } else {
        this.press(b.id);
      }
    } else {
      // ボタン以外は、押した横位置を狙う
      this.aimAt(x);
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    this.synth.unlock();
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;
    if (this.mode === 'play') {
      if (key === 'ArrowLeft' || key === 'a') this.held.left = true;
      else if (key === 'ArrowRight' || key === 'd') this.held.right = true;
      else if (key === 'Escape' || key === 'p') this.pause();
      else handled = false;
    } else {
      const buttons = this.buttons();
      const n = buttons.length;
      if (this.mode === 'paused' && (key === 'Escape' || key === 'p')) this.resume();
      else if (this.mode === 'shop' && key === 'Escape') this.shopAction(this.shopStep.at === 'list' ? 'shopClose' : 'cancel');
      else if (n === 0) handled = false;
      else if (key === 'ArrowDown' || key === 'ArrowRight' || (key === 'Tab' && !e.shiftKey)) this.focus = (this.focus + 1) % n;
      else if (key === 'ArrowUp' || key === 'ArrowLeft' || key === 'Tab') this.focus = (Math.max(this.focus, 0) + n - 1) % n;
      else if (key === 'Enter' || key === ' ') this.press(buttons[Math.max(this.focus, 0)]!.id);
      else handled = false;
    }
    if (handled) e.preventDefault();
  }

  // ---------------------------------------------------------------- 更新

  private say(label: string): void {
    this.caption = { label, until: this.time + CAPTION_SECONDS };
  }

  /** デモの出来事に合わせて字幕を出す（仕様書 5.3 節） */
  private demoCaptions(events: readonly GameEvent[], demoQuit: boolean): void {
    if (demoQuit) this.say('なぜそっちを撃つ！？');
    for (const e of events) {
      if (e.type === 'blockBreak' && e.kind === 'trap') this.say('それは罠！！');
      else if (e.type === 'blockBreak' && e.kind === 'hat') this.say('帽子はいらない');
      else if (e.type === 'blockPass' && e.kind === 'bomb') this.say('一斉削除を取れ！！');
    }
    const s = this.session.state;
    const panic = s.fill / s.capacity > DEMO_PANIC_RATIO;
    if (panic && !this.demoPanicked) this.say('あああああ');
    this.demoPanicked = panic;
  }

  private update(dt: number): void {
    this.time += dt;
    const s = this.session.state;
    if (this.mode === 'title') {
      const { events, demoQuit } = this.session.advance(dt);
      this.demoCaptions(events, demoQuit);
      if (s.over) {
        this.overAge += dt;
        if (this.overAge >= FAIL_SECONDS) this.startDemo();
      }
    } else if (this.mode === 'play') {
      this.applyKeys();
      this.session.advance(dt);
      const rush = s.t % B.waveLength >= RUSH_START;
      this.synth.update(waveOf(s.t), rush, s.fill / s.capacity);
      if (s.over) {
        this.overAge += dt;
        if (this.overAge >= RESULT_DELAY) this.showResult();
      }
    } else if (this.mode === 'shop') {
      // タイトルから開いたときは、後ろでデモを流し続ける
      if (this.shopFrom === 'title') {
        this.session.advance(dt);
        if (s.over && (this.overAge += dt) >= FAIL_SECONDS) this.startDemo();
      }
      const step = this.shopStep;
      if (step.at === 'paying' && this.time - step.since >= PAYING_SECONDS) this.finishPayment(step.pack);
    }
  }

  // ---------------------------------------------------------------- 描画

  private resize(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 指で遊ぶ縦長の画面では、キャンバスを上に寄せて、下に指を置く場所をあける
    // （真ん中に置くと、指がプレイヤーと武器の表示を隠してしまう）。余りが少なければ、キャンバスを少し縮めて確保する
    // タイトルでは指を置く場所は要らないので、PC と同じく真ん中に置く
    this.inGameLayout = !this.onTitle;
    const finger = FINGER_INPUT && vh > vw && this.inGameLayout;
    const reserve = finger ? Math.max(FINGER_AREA_MIN, Math.round(vh * FINGER_AREA_RATIO)) : 0;
    const scale = Math.min(vw / W, (vh - reserve) / H);
    const cssW = Math.floor(W * scale);
    const cssH = Math.floor(H * scale);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    document.body.classList.toggle('finger', finger);
    document.body.style.setProperty('--finger-area', `${Math.max(0, vh - cssH)}px`);
    // 指を置く場所の幅は、キャンバスの幅に合わせる（キャンバスを縮めた端末で、足場だけが左右にはみ出さないように）
    document.body.style.setProperty('--game-width', `${cssW}px`);
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.canvas.width = Math.round(cssW * ratio);
    this.canvas.height = Math.round(cssH * ratio);
    // 横と縦を別々に合わせる。大きさを整数に丸めるので、片方の拡大率だけで描くと、
    // もう片方が 1 画素ぶん足りず、端の 1 行が塗られないまま残る（差は 0.2% 未満で、見た目には分からない）
    this.scaleX = this.canvas.width / W;
    this.scaleY = this.canvas.height / H;
    // 背景は、画面と同じ縦横比の小さな絵にする
    // キャンバスと足場で画面が埋まっているとき（スマホで遊んでいる最中）は、見えないので描かない
    this.backdrop.hidden = cssW >= vw && (finger || cssH >= vh);
    this.backdrop.width = BACKDROP_WIDTH;
    this.backdrop.height = Math.max(1, Math.round((BACKDROP_WIDTH * vh) / vw));
    this.backdropAt = -1;
  }

  /**
   * 余白に、ゲームの画面を引き伸ばして暗くした絵を敷く（縦長の動画を横長の画面で流すときの、あの見た目）。
   * 真っ暗な余白より画面になじみ、時間帯や危険の赤も余白に映る。ぼかしは CSS で掛ける
   */
  private drawBackdrop(): void {
    if (this.backdrop.hidden || this.time - this.backdropAt < BACKDROP_INTERVAL) return;
    this.backdropAt = this.time;
    const { width: bw, height: bh } = this.backdrop;
    const { width: gw, height: gh } = this.canvas;
    const g = this.backdrop.getContext('2d');
    if (!g || gw === 0 || gh === 0) return;
    // 余白を残さないよう、はみ出す向きに合わせて引き伸ばす
    const scale = Math.max(bw / gw, bh / gh);
    g.drawImage(this.canvas, (bw - gw * scale) / 2, (bh - gh * scale) / 2, gw * scale, gh * scale);
    g.fillStyle = `rgba(5,7,15,${BACKDROP_DIM})`;
    g.fillRect(0, 0, bw, bh);
  }

  private render(): void {
    // 指を置く場所の「なぞる溝」は、遊んでいる間だけ出す（CSS の body.finger.playing）
    document.body.classList.toggle('playing', this.mode === 'play');
    // タイトルとそれ以外で、キャンバスの置き方が変わる（指を置く場所をあけるかどうか）
    if (!this.onTitle !== this.inGameLayout) this.resize();
    this.renderScreen();
    // 画面が切り替わった直後は、暗いところから明るくする
    const fade = 1 - (this.time - this.fadeAt) / FADE_SECONDS;
    if (fade > 0) {
      this.ctx.fillStyle = `rgba(8,10,24,${fade})`;
      this.ctx.fillRect(0, 0, W, H);
    }
    this.drawBackdrop();
  }

  private renderScreen(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.scaleX, 0, 0, this.scaleY, 0, 0);
    const { state, view } = this.session;
    drawScene(ctx, state, view);
    drawHud(ctx, state, view, { demo: this.onTitle });
    const drawButtons = (): void => {
      const closeAge = this.time - this.closePressedAt;
      this.buttons().forEach((b, i) => {
        // 「今すぐプレイ」は脈打って光の帯が横切り、「✕」は押すと震える
        const play = b.id === 'play';
        drawButton(ctx, b, {
          focused: i === this.focus,
          scale: play ? 1 + 0.05 * Math.sin(this.time * 7) : 1,
          dx: b.id === 'close' && closeAge < 0.4 ? Math.sin(closeAge * 80) * 4 : 0,
          shine: play ? (this.time * 0.6) % 1.6 : -1,
        });
      });
    };
    if (this.mode === 'title') {
      // タイトルの飾り（つつく手）はボタンの上に重ねる
      drawButtons();
      drawTitle(ctx, {
        time: this.time,
        highScore: this.highScore,
        caption: this.caption && this.time < this.caption.until ? this.caption.label : null,
        failAge: state.over ? this.overAge : -1,
        closeAge: this.time - this.closePressedAt,
      });
      return;
    }
    if (this.mode === 'paused') {
      drawPause(ctx);
    } else if (this.mode === 'result' && this.result) {
      drawResult(ctx, this.result, this.message && this.time < this.message.until ? this.message.label : null, this.time - this.resultAt, this.gems);
    } else if (this.mode === 'shop') {
      if (this.shopFrom === 'result' && this.result) drawResult(ctx, this.result, null, 99, this.gems);
      drawShop(ctx, { time: this.time, step: this.shopStep, gems: this.gems, spent: this.spent });
    } else if (this.mode === 'play' && this.banner && this.time < this.banner.until) {
      drawBanner(ctx, this.banner.label, this.banner.until - this.time);
    }
    drawButtons();
  }

  private frame(now: number): void {
    const dt = Math.min(MAX_FRAME, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.update(dt);
    this.render();
    requestAnimationFrame((t) => this.frame(t));
  }
}

initSprites();
initScene();
const app = new App(document.getElementById('game') as HTMLCanvasElement, document.getElementById('backdrop') as HTMLCanvasElement);
// 開発時だけ、ブラウザのコンソールや確認用スクリプトから状態を触れるようにする
if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;
