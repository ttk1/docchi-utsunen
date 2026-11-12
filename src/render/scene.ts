// 背景・道・敵・ブロック・プレイヤー・弾・エフェクトの描画（仕様書 6 章）。状態を読むだけで書き換えない。
import { AIM, B, ENEMIES, RUSH_START } from '../core/balance.ts';
import { bossName, dpsOf, waveOf, weaponStage } from '../core/formulas.ts';
import { weakPointOf, type Block, type GameState } from '../core/state.ts';
import { INK, circle, clamp, ellipse, fancyText, fillRoundRect, gradV, lerp, poly, text, type Ctx } from './draw.ts';
import { formatHp } from './format.ts';
import { CENTER_X, FRONT_Y, H, HALF_ROAD, HORIZON_Y, W, kOf, xOf, yOf } from './projection.ts';
import { BLOCK_NUMBER, BLOCK_TOP, CRACK_LEVELS, HAT_COLORS, drawSprite, drawSpriteCentered, drawSpriteStretch, sprite } from './sprites.ts';
import { LOOK, TONE, blockZ, type Bullet, type View } from './view.ts';
import { PALETTES, drawWorld, hash, skyPhase } from './world.ts';

/** 帽子は 12 個まで積んで描き、それ以上は「×N」と数字で出す（仕様書 6.7 節） */
const MAX_HATS_DRAWN = 12;
/** 残り HP がこの割合を切ったブロックは赤く震える（7 章） */
const BLOCK_DANGER = 0.15;
/** 相棒を置く横位置（u）。3 台目は真ん中 */
const BUDDY_U = [-0.36, 0.36, 0] as const;
const BUDDY_BOTTOM = 884;
/** 何台目の相棒を AI にするか（0 始まり）。見た目だけの違いで、強さは同じ */
const AI_BUDDY = 1;
/** 橋の縁（道の外側の壁）の外端。u の値 */
const WALL = 1.1;
/** 強化の帯の内側の端（敵の帯との境の少し外） */
const SIDE_INNER = AIM.border + 0.03;
/** 銃口が光る武器の段階（火薬で撃つもの） */
const MUZZLE_STAGES = new Set([3, 4, 5, 6, 7, 8]);
/** 埋まり度がこの割合以上で、画面の縁を赤くし、防衛線の警告灯を回す */
const DANGER_RATIO = 0.7;
/** 埋まり度がこの割合を超えたら、撃てるボムに「今だ！」と目印を付ける */
const BOMB_HINT_RATIO = 0.5;
/** 開始からこの秒数のあいだは、間に合わないブロックに「間に合わない」と添える（赤い数字の意味を覚えてもらう） */
const LATE_HINT_SECONDS = 60;
/** 弾を大きめに描く、序盤の武器の段階の数 */
const EARLY_STAGES = 6;

/** 時間帯ごとの遠景（空、街並み、海）と、その上に重ねる橋 */
let worlds: HTMLCanvasElement[] = [];
let stage: HTMLCanvasElement | null = null;
let vignette: HTMLCanvasElement | null = null;

function offscreen(w: number, h: number, scale: number, draw: (c: Ctx) => void): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const c = canvas.getContext('2d')!;
  c.scale(scale, scale);
  draw(c);
  return canvas;
}

/** 道の上の帯（u の範囲 × z の範囲）を塗る */
function band(c: Ctx, u0: number, u1: number, z0: number, z1: number, color: string | CanvasGradient): void {
  c.beginPath();
  c.moveTo(xOf(u0, z0), yOf(z0));
  c.lineTo(xOf(u1, z0), yOf(z0));
  c.lineTo(xOf(u1, z1), yOf(z1));
  c.lineTo(xOf(u0, z1), yOf(z1));
  c.closePath();
  c.fillStyle = color;
  c.fill();
}

/** 画面の y から、その高さでの縮小率を逆算する */
function kAtY(y: number): number {
  return 0.25 + ((y - HORIZON_Y) * 0.75) / (FRONT_Y - HORIZON_Y);
}


// ---------------------------------------------------------------- 背景（起動時に絵にしておく）

function drawBridge(c: Ctx): void {
  // 橋の側面の影、縁の壁、路面
  band(c, -WALL - 0.05, WALL + 0.05, 0, 1, 'rgba(8,60,90,0.35)');
  band(c, -WALL, WALL, 0, 1, '#c5ccd9');
  band(c, -WALL + 0.035, WALL - 0.035, 0, 1, '#eef1f6');
  band(c, -1, 1, 0, 1, gradV(c, HORIZON_Y, FRONT_Y, '#7b8296', '#454a5c'));
  // 真ん中が敵の帯（赤み）、左右の端が強化の帯（青み）
  band(c, -AIM.border, AIM.border, 0, 1, 'rgba(255,70,70,0.17)');
  for (const side of [-1, 1]) band(c, side * SIDE_INNER, side * 0.95, 0, 1, 'rgba(70,160,255,0.24)');
  // 路面の継ぎ目
  for (let i = 1; i < 12; i++) {
    const z = i / 12;
    c.fillStyle = 'rgba(0,0,0,0.1)';
    c.fillRect(xOf(-1, z), yOf(z), xOf(1, z) - xOf(-1, z), Math.max(1, 2.5 * kOf(z)));
  }
  // 路肩の白線と、帯を分ける黄色い線
  for (const u of [-0.975, 0.975]) band(c, u - 0.01, u + 0.01, 0, 1, 'rgba(255,255,255,0.85)');
  for (const side of [-1, 1]) {
    const u = side * (AIM.border + 0.015);
    band(c, u - 0.022, u + 0.022, 0, 1, '#3a3f4f');
    band(c, u - 0.012, u + 0.012, 0, 1, '#ffd23f');
    for (let i = 0; i < 30; i += 2) band(c, u - 0.012, u + 0.012, i / 30, (i + 1) / 30, '#2b2f3b');
  }
  // 手すり。支柱を立て、上端を横木でつなぐ
  for (const side of [-1, 1]) {
    const u = side * (WALL - 0.02);
    c.strokeStyle = '#f7f9fc';
    c.lineCap = 'round';
    let px = 0;
    let py = 0;
    let pBase = 0;
    for (let i = 0; i <= 16; i++) {
      const z = (i / 16) ** 1.5;
      const k = kOf(z);
      const x = xOf(u, z);
      const y = yOf(z);
      const top = y - 34 * k;
      c.lineWidth = Math.max(1, 4 * k);
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x, top);
      c.stroke();
      if (i > 0) {
        c.beginPath();
        c.moveTo(px, py);
        c.lineTo(x, top);
        c.moveTo(px, (py + pBase) / 2);
        c.lineTo(x, (top + y) / 2);
        c.stroke();
      }
      px = x;
      py = top;
      pBase = y;
    }
  }
}

function drawPlatform(c: Ctx): void {
  c.fillStyle = gradV(c, FRONT_Y, H, '#444b5e', '#222631');
  c.fillRect(0, FRONT_Y, W, H - FRONT_Y);
  c.fillStyle = '#6b7388';
  c.fillRect(0, FRONT_Y, W, 4);
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillRect(0, FRONT_Y + 4, W, 3);
  for (let x = 24; x < W; x += 70) circle(c, x, FRONT_Y + 18, 2.5, 'rgba(255,255,255,0.18)');
  // 強化の帯の通過線（左右）
  for (const side of [-1, 1]) {
    const a = xOf(side * SIDE_INNER, 0);
    const b = xOf(side * 0.95, 0);
    const x0 = Math.min(a, b);
    const cell = Math.abs(b - a) / 6;
    for (let i = 0; i < 6; i++) {
      c.fillStyle = i % 2 ? '#f4f6fa' : '#2a2f3a';
      c.fillRect(x0 + i * cell, FRONT_Y - 9, cell + 0.5, 9);
    }
  }
}

/** 橋・手前の足場（遠景の上に重ねる、透けた絵） */
function drawStage(c: Ctx): void {
  drawBridge(c);
  // 遠くをかすませて奥行きを出す
  const haze = c.createLinearGradient(0, HORIZON_Y, 0, HORIZON_Y + 210);
  haze.addColorStop(0, 'rgba(225,246,255,0.62)');
  haze.addColorStop(1, 'rgba(225,246,255,0)');
  c.fillStyle = haze;
  c.fillRect(0, HORIZON_Y, W, 210);
  drawPlatform(c);
}

/** 画面の縁を赤くする枠。四辺それぞれ、縁から内側へ薄くなる */
function drawVignette(c: Ctx): void {
  const depth = 110;
  const edge = (x0: number, y0: number, x1: number, y1: number): void => {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(255,0,0,0.8)');
    g.addColorStop(1, 'rgba(255,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  };
  edge(0, 0, depth, 0);
  edge(W, 0, W - depth, 0);
  edge(0, 0, 0, depth);
  edge(0, H, 0, H - depth);
}

export function initScene(): void {
  // 遠景はぼかしの多い絵なので等倍で足りる。橋は線が細いので 2 倍で描く
  worlds = PALETTES.map((p) => offscreen(W, H, 1, (c) => drawWorld(c, p)));
  stage = offscreen(W, H, 2, drawStage);
  vignette = offscreen(W, H, 0.5, drawVignette);
}

// ---------------------------------------------------------------- 動く背景

function drawClouds(ctx: Ctx, time: number, alpha: number): void {
  ctx.globalAlpha = alpha;
  for (let i = 0; i < 5; i++) {
    const span = W + 260;
    const x = ((hash(i) * span + time * (5 + i * 2.2)) % span) - 130;
    const scale = 0.55 + hash(i + 9) * 0.6;
    drawSpriteCentered(ctx, `cloud.${i % 3}`, x, 62 + hash(i + 4) * 120, scale);
  }
  ctx.globalAlpha = 1;
}

function drawSparkles(ctx: Ctx, time: number): void {
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 30; i++) {
    const a = Math.sin(time * (1.2 + hash(i) * 1.6) + i * 2.3);
    if (a <= 0) continue;
    const y = HORIZON_Y + 14 + hash(i + 50) ** 1.6 * (FRONT_Y - HORIZON_Y - 20);
    const k = kAtY(y);
    const edge = HALF_ROAD * (WALL + 0.08) * k;
    const room = CENTER_X - edge;
    const x = i % 2 ? hash(i + 20) * room : CENTER_X + edge + hash(i + 20) * room;
    ctx.globalAlpha = a * 0.8;
    ctx.fillRect(x - 9 * k, y, 18 * k, Math.max(1, 2.5 * k));
  }
  ctx.globalAlpha = 1;
}

/** 帯を手前へ流れる矢羽根。敵と強化が「流れてくる」向きを見せる */
function drawChevrons(ctx: Ctx, time: number): void {
  const count = 9;
  const phase = (time / B.blockTravel) % (1 / count);
  const lanes = [
    { center: 0, half: 0.3 },
    { center: -AIM.blockCols[1], half: 0.1 },
    { center: AIM.blockCols[1], half: 0.1 },
  ];
  for (const lane of lanes) {
    for (let i = 0; i <= count; i++) {
      const z = (i + 1) / count - phase;
      if (z <= 0.04 || z >= 1) continue;
      const alpha = Math.min(1, z * 6, (1 - z) * 4) * 0.085;
      const z1 = z + 0.02 + z * 0.035;
      const tip = z - 0.045 - z * 0.06;
      ctx.beginPath();
      ctx.moveTo(xOf(lane.center - lane.half, z), yOf(z));
      ctx.lineTo(xOf(lane.center, tip), yOf(tip));
      ctx.lineTo(xOf(lane.center + lane.half, z), yOf(z));
      ctx.lineTo(xOf(lane.center + lane.half, z1), yOf(z1));
      ctx.lineTo(xOf(lane.center, tip + (z1 - z)), yOf(tip + (z1 - z)));
      ctx.lineTo(xOf(lane.center - lane.half, z1), yOf(z1));
      ctx.closePath();
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------- 道の上のもの

function drawBarricade(ctx: Ctx, time: number, danger: boolean): void {
  const x0 = xOf(-AIM.border + 0.01, 0);
  const x1 = xOf(AIM.border - 0.01, 0);
  const w = x1 - x0;
  const y = FRONT_Y - 24;
  fillRoundRect(ctx, x0 - 2, y - 2, w + 4, 28, 6, INK);
  ctx.fillStyle = gradV(ctx, y, y + 24, '#f4f6fa', '#aab2c2');
  ctx.fillRect(x0, y, w, 24);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y + 4, w, 12);
  ctx.clip();
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(x0, y + 4, w, 12);
  for (let x = x0 - 14; x < x1; x += 26) poly(ctx, [x, y + 16, x + 12, y + 16, x + 24, y + 4, x + 12, y + 4], '#22252c');
  ctx.restore();
  // 警告灯。埋まり度が上がると赤く回る
  for (const x of [x0 + 10, x1 - 10]) {
    const on = danger ? 0.55 + 0.45 * Math.sin(time * 14 + x) : 0.35;
    fillRoundRect(ctx, x - 6, y - 12, 12, 12, 4, INK);
    circle(ctx, x, y - 6, 4.2, danger ? `rgba(255,60,60,${on})` : `rgba(255,190,60,${on})`);
    if (danger) circle(ctx, x, y - 6, 12, `rgba(255,60,60,${on * 0.25})`);
  }
}

/** 弾の列を、プレイヤーから標的まで薄く光らせる。狙いがどこに当たっているかを見せる */

/** 今の塗り（fillStyle）で角丸の四角を塗る */
function fillRoundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fill();
}

/** 撃たれた瞬間に、白い版を重ねて光らせる */
function flashOver(ctx: Ctx, id: string, cx: number, bottom: number, scale: number, alpha: number): void {
  ctx.globalAlpha = alpha;
  drawSprite(ctx, `${id}#flash`, cx, bottom, scale);
  ctx.globalAlpha = 1;
}

function drawEnemies(ctx: Ctx, s: GameState, v: View): void {
  const hit = v.time - v.enemyHitAt < 0.07;
  // 列の後ろほど奥にいるので、後ろから描けば奥から手前の順になる
  for (let i = s.enemies.length - 1; i >= 0; i--) {
    const e = s.enemies[i]!;
    const vis = v.enemies.get(e.id);
    if (!vis) continue;
    // 現れた瞬間は小さく、すぐ元の大きさへふくらむ
    const pop = vis.age < 0.18 ? 0.4 + (vis.age / 0.18) * 0.6 : 1;
    const scale = vis.scale * pop;
    // 歩いている間は大きく跳ね、並んで待っている間は小さく息をする
    const stride = Math.sin(v.time * (vis.walking ? 11 : 4) + vis.phase);
    const bob = vis.walking ? Math.abs(stride) * 5 * scale : 0;
    const target = e.id === v.aim.enemyId;
    const struck = target && hit;
    const push = struck ? -3 * scale : 0;
    // 伸び縮み。撃たれた瞬間は横につぶれる
    const squash = struck ? 0.12 : stride * (vis.walking ? 0.07 : 0.03);
    if (e.kind === 'boss') {
      const sp = sprite(vis.spriteId);
      const top = vis.y - sp.h * scale;
      if (e.bossIndex > 4) ellipse(ctx, vis.x, vis.y - (sp.h * scale) / 2, 120 * scale, 120 * scale, 'rgba(170,60,255,0.35)');
      drawSprite(ctx, vis.spriteId, vis.x, vis.y - bob * 0.5 + push, scale);
      if (target && hit) flashOver(ctx, vis.spriteId, vis.x, vis.y - bob * 0.5 + push, scale, 0.4);
      const bw = 170 * scale;
      const bh = Math.max(5, 13 * scale);
      const by = top - bh - 8 * scale;
      fillRoundRect(ctx, vis.x - bw / 2 - 2, by - 2, bw + 4, bh + 4, bh / 2 + 2, INK);
      const ratio = clamp(e.hp / e.hp0, 0, 1);
      if (ratio > 0) {
        ctx.fillStyle = gradV(ctx, by, by + bh, '#ff8f8f', '#e01f1f');
        fillRoundRectPath(ctx, vis.x - bw / 2, by, bw * ratio, bh, bh / 2);
      }
      fancyText(ctx, bossName(e.bossIndex), vis.x, by - 13 * scale - 3, { size: Math.max(12, 23 * scale), top: '#ffffff', bottom: '#ffd0d0', maxWidth: 240 });
    } else {
      drawSpriteStretch(ctx, vis.spriteId, vis.x, vis.y - bob + push, scale * (1 + squash), scale * (1 - squash));
      if (struck) {
        ctx.globalAlpha = 0.55;
        drawSpriteStretch(ctx, `${vis.spriteId}#flash`, vis.x, vis.y - bob + push, scale * (1 + squash), scale * (1 - squash));
        ctx.globalAlpha = 1;
      }
      // 削れた敵には、残り HP の細いバーを頭の上に出す（どれが倒れかけか分かるように）
      if (e.hp < e.hp0 && e.kind !== 'spam') {
        const sp = sprite(vis.spriteId);
        const bw = sp.w * scale * 0.7;
        const by = vis.y - bob - sp.h * scale - 5 * scale;
        ctx.fillStyle = INK;
        ctx.fillRect(vis.x - bw / 2 - 1, by - 1, bw + 2, 4 * scale + 2);
        ctx.fillStyle = '#ff6b6b';
        ctx.fillRect(vis.x - bw / 2, by, bw * clamp(e.hp / e.hp0, 0, 1), 4 * scale);
      }
    }
  }
}

/** そのブロックを、今から向かって撃ち続ければ壊し切れるか（仕様書 6.5 節）。移動の時間を含む */
export function canBreakInTime(s: GameState, b: Block): boolean {
  const need = b.hp / dpsOf(s.player.rank) + Math.abs(b.u - s.player.x) / AIM.moveSpeed;
  return need <= b.passAt - s.t;
}

function drawBlocks(ctx: Ctx, s: GameState, v: View): void {
  for (let i = s.blocks.length - 1; i >= 0; i--) {
    const b = s.blocks[i]!;
    const z = blockZ(s, b.passAt);
    const k = kOf(z);
    const ratio = clamp(b.hp / b.maxHp, 0, 1);
    // 同じ列でいちばん手前のブロックだけが撃てる
    const front = !s.blocks.some((o) => o.col === b.col && o.passAt < b.passAt);
    const danger = ratio < BLOCK_DANGER;
    const beingHit = b.id === v.aim.blockId && v.time - v.blockHitAt < 0.1;
    const amp = (beingHit ? 2.5 : 0) + (danger ? 3 : 0);
    const cx = xOf(b.u, z) + Math.sin(v.time * 71 + i) * amp * k;
    // 少し浮かせて、ゆっくり上下させる
    const hover = (5 + Math.sin(v.time * 2.4 + b.id) * 3) * k;
    const bottom = yOf(z) - hover + Math.cos(v.time * 83 + i) * amp * 0.5 * k;
    // 足元の光と影
    const glow = sprite(`glow.${b.kind}`).canvas;
    ctx.globalAlpha = 0.55 + 0.15 * Math.sin(v.time * 3 + b.id);
    ctx.drawImage(glow, cx - 115 * k, yOf(z) - 20 * k, 230 * k, 44 * k);
    ctx.globalAlpha = 1;
    ellipse(ctx, cx, yOf(z) + 2 * k, 70 * k, 8 * k, 'rgba(10,14,30,0.35)');
    drawSprite(ctx, `block.${b.kind}`, cx, bottom, k);
    // 削れるほど、ひびが増える
    const crack = Math.min(CRACK_LEVELS, Math.floor((1 - ratio) * (CRACK_LEVELS + 1)));
    if (crack > 0) drawSprite(ctx, `crack.${crack}`, cx, bottom, k);
    // 今撃っているブロックは、輪郭を光らせて分かるようにする
    if (b.id === v.aim.blockId && !s.over) flashOver(ctx, `block.${b.kind}`, cx, bottom, k, 0.1 + 0.06 * Math.sin(v.time * 12));
    if (beingHit && v.time - v.blockHitAt < 0.05) flashOver(ctx, `block.${b.kind}`, cx, bottom, k, 0.3);
    if (danger) {
      ctx.fillStyle = `rgba(255,40,40,${0.25 + 0.2 * Math.sin(v.time * 30)})`;
      ctx.fillRect(cx - 75 * k, bottom - (110 - BLOCK_TOP) * k, 150 * k, (110 - BLOCK_TOP) * k);
    }
    // 敵が溜まってきたら、撃てるボムを目立たせる（逆転の手がかり）
    if (b.kind === 'bomb' && front && !s.over && s.fill / s.capacity > BOMB_HINT_RATIO) {
      const bounce = Math.abs(Math.sin(v.time * 7)) * 10 * k;
      fancyText(ctx, '▼ 今だ！', cx, bottom - 128 * k - bounce, { size: Math.max(13, 30 * k), top: '#fff7a8', bottom: '#ff9d1a', stroke: '#5a0000' });
    }
    // 残り HP の数字。撃てるブロックは、間に合うなら白、間に合わないなら赤。後ろのブロックは灰色
    const inTime = canBreakInTime(s, b);
    const color = front ? (inTime ? '#ffffff' : '#ff5c5c') : '#c9ced8';
    if (front && !inTime && !s.over && s.t < LATE_HINT_SECONDS && b.kind !== 'trap' && b.kind !== 'hat') {
      text(ctx, '間に合わない', cx, bottom - 122 * k, { size: Math.max(10, 18 * k), weight: 900, color: '#ff8f8f', stroke: INK });
    }
    const nx = b.kind === 'trap' ? cx : cx + BLOCK_NUMBER.dx * k;
    const size = (b.kind === 'trap' ? 30 : 36) * k;
    text(ctx, formatHp(b.hp), nx, bottom - (b.kind === 'trap' ? 40 : BLOCK_NUMBER.up) * k, {
      size,
      weight: 900,
      color,
      stroke: INK,
      strokeWidth: Math.max(2, size * 0.22),
      maxWidth: BLOCK_NUMBER.maxWidth * k,
    });
    const bw = 126 * k;
    const bh = 9 * k;
    const bx = cx - bw / 2;
    const by = bottom - 19 * k;
    fillRoundRect(ctx, bx - 1.5 * k, by - 1.5 * k, bw + 3 * k, bh + 3 * k, bh, INK);
    if (ratio > 0) fillRoundRect(ctx, bx, by, bw * ratio, bh, bh / 2, danger ? '#ff5c5c' : '#ffffff');
  }
}

function drawBuddies(ctx: Ctx, s: GameState, v: View): void {
  // 相棒は列に関係なく、いつも敵の先頭を撃っている
  const front = !s.over && s.enemies.length > 0 ? v.enemies.get(s.enemies[0]!.id) : undefined;
  for (let i = 0; i < s.player.buddies; i++) {
    const x = xOf(BUDDY_U[i]!, 0) + Math.sin(v.time * 3 + i * 2.1) * 3;
    if (front) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(${i === AI_BUDDY ? '125,240,255' : '105,240,138'},${0.35 + 0.3 * Math.sin(v.time * 40 + i * 2)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, BUDDY_BOTTOM - 20);
      ctx.lineTo(front.x, front.y - 12 * front.scale);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    // AI の相棒は、ふわふわ浮かせる
    if (i === AI_BUDDY) drawSprite(ctx, 'buddy.ai', x, BUDDY_BOTTOM + 4 + Math.sin(v.time * 2.4) * 3, 1.3);
    else drawSprite(ctx, 'buddy', x, BUDDY_BOTTOM);
  }
}

function drawPlayer(ctx: Ctx, s: GameState, v: View): void {
  const m = v.muzzle();
  const x = v.bodyX();
  const stage = weaponStage(s.player.rank);
  // 動いている間は進む向きへ体を傾け、小刻みに跳ねる
  const speed = clamp(v.vx / 720, -1, 1);
  const bottom = LOOK.playerBottom + Math.sin(v.time * 4) * 1.2 - Math.abs(Math.sin(v.time * 22)) * 4 * Math.abs(speed);
  ctx.save();
  ctx.translate(x, bottom);
  ctx.rotate(speed * 0.16);
  ctx.translate(-x, -bottom);
  // ランクが上がった直後は足元から光る
  const glowAge = v.time - v.rankUpAt;
  if (glowAge < 0.5) {
    ctx.globalAlpha = 1 - glowAge / 0.5;
    drawSpriteCentered(ctx, 'glow.gold', x, bottom - 48, 1.6 + glowAge * 2);
    ctx.globalAlpha = 1;
  }
  drawSprite(ctx, v.suit ? 'player.suit' : 'player', x, bottom);
  const hats = Math.min(s.player.hats, MAX_HATS_DRAWN);
  for (let i = 0; i < hats; i++) drawSprite(ctx, `hat.${i % HAT_COLORS.length}`, x, bottom - 89 - i * 8);
  if (s.player.hats > MAX_HATS_DRAWN) {
    text(ctx, `×${s.player.hats}`, x - 40, bottom - 95 - hats * 8, { size: 18, stroke: INK });
  }
  const sinceShot = v.time - v.shotAt;
  const recoil = v.shooting ? clamp(1 - sinceShot / 0.06, 0, 1) * 3.5 : 0;
  drawSprite(ctx, `weapon.${stage}`, m.x, bottom - LOOK.weaponUp + recoil);
  ctx.restore();
  if (v.shooting && sinceShot < 0.05 && MUZZLE_STAGES.has(stage)) {
    ctx.globalCompositeOperation = 'lighter';
    drawSpriteCentered(ctx, 'muzzle', m.x, m.y - 6, 0.5 + (stage - 3) * 0.07, v.time * 40);
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawBeam(ctx: Ctx, s: GameState, v: View): void {
  const stage = weaponStage(s.player.rank);
  if (!v.shooting || (stage !== 9 && stage !== 10)) return;
  const m = v.muzzle();
  const flicker = 0.75 + 0.25 * Math.sin(v.time * 90);
  const wide = stage === 10;
  ctx.lineCap = 'round';
  ctx.globalCompositeOperation = 'lighter';
  const pass = (width: number, color: string): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(v.aim.x, v.aim.y);
    ctx.stroke();
  };
  pass((wide ? 30 : 12) * flicker, wide ? 'rgba(90,170,255,0.35)' : 'rgba(255,40,40,0.35)');
  pass((wide ? 15 : 5) * flicker, wide ? 'rgba(170,225,255,0.85)' : 'rgba(255,90,80,0.95)');
  ctx.globalCompositeOperation = 'source-over';
  pass(wide ? 5 : 1.8, '#ffffff');
  circle(ctx, v.aim.x, v.aim.y, (wide ? 16 : 9) * flicker * Math.max(0.5, v.aim.k), wide ? 'rgba(200,235,255,0.8)' : 'rgba(255,200,190,0.8)');
}

function drawBullet(ctx: Ctx, b: Bullet): void {
  const t = clamp(b.age / LOOK.bulletTime, 0, 1);
  const x = lerp(b.x0, b.x1, t);
  const y = lerp(b.y0, b.y1, t);
  // 序盤の武器は弾が小さくて見えにくいので、少し大きく描く
  const k = lerp(1, b.k1, t) * (b.stage < EARLY_STAGES ? 1.35 : 1);
  const dx = b.x1 - b.x0;
  const dy = b.y1 - b.y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len;
  const ny = dy / len;
  const tracer = (length: number, width: number, color: string): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width * k;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - nx * length * k, y - ny * length * k);
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const dot = (r: number, color: string): void => circle(ctx, x, y, r * k, color);
  switch (b.stage) {
    case 0:
      tracer(16, 5, 'rgba(111,216,255,0.55)');
      dot(6, '#9be8ff');
      dot(2.5, '#ffffff');
      break;
    case 1:
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5 * k;
      ctx.beginPath();
      ctx.ellipse(x, y, 9 * k, 5.5 * k, b.spin + t * 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#d99a52';
      ctx.lineWidth = 2.6 * k;
      ctx.stroke();
      break;
    case 2:
      dot(5.5, INK);
      dot(4, '#ecc973');
      break;
    case 3:
      tracer(10, 3, 'rgba(255,255,255,0.4)');
      dot(4, '#ffffff');
      break;
    case 4:
      tracer(18, 6, 'rgba(255,190,60,0.45)');
      tracer(8, 5, '#ffe066');
      break;
    case 5:
      tracer(10, 3, 'rgba(255,220,100,0.5)');
      dot(3.8, '#fff3a0');
      break;
    case 6:
      tracer(34, 5, 'rgba(255,200,80,0.35)');
      tracer(30, 2.2, '#fff8c4');
      break;
    case 7:
      tracer(40, 9, 'rgba(255,150,60,0.35)');
      tracer(34, 5, '#ffb347');
      tracer(14, 2, '#ffffff');
      break;
    case 8:
      for (let i = 1; i <= 4; i++) circle(ctx, x - nx * i * 11 * k, y - ny * i * 11 * k, (5 + i * 1.8) * k, `rgba(235,235,235,${0.55 - i * 0.11})`);
      tracer(12, 10, '#ff7a1a');
      tracer(16, 8, '#5d7a3a');
      break;
    case 11:
      ellipse(ctx, x, y + 3 * k, 13 * k, 6.5 * k, INK);
      ellipse(ctx, x, y + 3 * k, 11.5 * k, 5.5 * k, '#ffffff');
      fillRoundRect(ctx, x - 8 * k, y - 5 * k, 16 * k, 7 * k, 3 * k, '#e8452f');
      break;
    case 12:
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(b.spin + t * 8);
      fillRoundRect(ctx, -12.5 * k, -8.5 * k, 25 * k, 17 * k, 3 * k, INK);
      fillRoundRect(ctx, -11 * k, -7 * k, 22 * k, 14 * k, 2.5 * k, '#f5b800');
      ctx.fillStyle = '#7a4b00';
      ctx.fillRect(-11 * k, -3 * k, 22 * k, 3 * k);
      ctx.restore();
      break;
    case 13:
      text(ctx, '既読', x, y, { size: 21 * k, color: '#d7f5d9', stroke: '#1f6f3a' });
      break;
    case 14:
      text(ctx, 'お先に失礼します', x, y, { size: 16 * k, color: '#fff3bf', stroke: '#8a5a00' });
      break;
  }
}

function drawEffects(ctx: Ctx, v: View): void {
  ctx.globalCompositeOperation = 'lighter';
  for (const b of v.bullets) if (b.stage >= 3 && b.stage <= 7) drawBullet(ctx, b);
  ctx.globalCompositeOperation = 'source-over';
  for (const b of v.bullets) if (b.stage < 3 || b.stage > 7) drawBullet(ctx, b);
  for (const r of v.rings) {
    const t = r.age / LOOK.ringLife;
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = Math.max(1, 5 * (1 - t));
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.radius * (0.25 + 0.75 * t * (2 - t)), 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const p of v.particles) {
    ctx.globalAlpha = clamp(1 - p.age / p.life, 0, 1);
    ctx.fillStyle = p.color;
    if (p.size < 5) {
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (const n of v.numbers) {
    const t = n.age / LOOK.numberLife;
    // 足し込まれるたびに弾む
    const since = v.time - n.bumpedAt;
    const pop = since < 0.08 ? 1.45 - (since / 0.08) * 0.45 : 1;
    // 会心は金色で大きく、強化ブロックへのダメージは金色、ふつうは白
    const tone = n.crit ? TONE.crit : n.block ? TONE.gold : TONE.white;
    ctx.globalAlpha = clamp(1.7 - t * 1.7, 0, 1);
    ctx.save();
    ctx.translate(n.x, n.y - t * 38);
    ctx.rotate(n.tilt);
    fancyText(ctx, n.label, 0, 0, { size: (n.crit ? 30 : 22) * pop, top: tone[0], bottom: tone[1], strokeWidth: n.crit ? 5.5 : 4.5, shadow: 1.5 });
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  // 壊したブロックの中身が、弧を描いて手元へ飛んでくる
  for (const p of v.pickups) {
    const t = clamp(p.age / LOOK.pickupTime, 0, 1);
    const e = t * t;
    const x = lerp(p.x0, v.bodyX(), e);
    const y = lerp(p.y0, LOOK.playerBottom - 50, e) - Math.sin(t * Math.PI) * 70;
    ctx.globalCompositeOperation = 'lighter';
    drawSpriteCentered(ctx, `glow.${p.kind}`, x, y, 0.7);
    ctx.globalCompositeOperation = 'source-over';
    drawSpriteCentered(ctx, `icon.${p.kind}`, x, y, 0.9 + 0.3 * Math.sin(t * Math.PI), t * 5);
  }
}

/** ゲームオーバー: 敵が防衛線を越えて画面を覆う */
function drawFlood(ctx: Ctx, v: View): void {
  const t = v.time - v.overAt;
  const ids = ['enemy.notice.0', 'enemy.notice.3', 'enemy.spam', 'enemy.deadline', 'enemy.notice.5', 'enemy.revolving'];
  for (let i = 0; i < 64; i++) {
    const p = clamp((t - hash(i + 100) * 0.6) / 0.9, 0, 1);
    if (p <= 0) continue;
    const x = CENTER_X + (hash(i) - 0.5) * 600;
    const y = 800 + p * p * 420 + hash(i + 200) * 60;
    drawSprite(ctx, ids[i % ids.length]!, x, y, 1.2 + p * 3.2);
  }
  ctx.fillStyle = `rgba(120,0,0,${clamp(t / 1.5, 0, 1) * 0.5})`;
  ctx.fillRect(0, 0, W, H);
}

function drawLaneOverlays(ctx: Ctx, s: GameState, v: View): void {
  if (s.t < s.vacationUntil) {
    band(ctx, -AIM.border, AIM.border, 0, 1, 'rgba(120,220,255,0.22)');
    const left = s.vacationUntil - s.t;
    // 止まるのは新しく来る敵だけで、道に残っている敵はそのまま、と分かるように書く
    fancyText(ctx, `有給休暇中（新着なし） あと ${left.toFixed(1)} 秒`, CENTER_X, 610, { size: 19, top: '#ffffff', bottom: '#bff4ff', stroke: '#0b5e78' });
  }
  if (v.bombWaveAt >= 0) {
    const p = (v.time - v.bombWaveAt) / LOOK.bombWaveTime;
    if (p < 1) band(ctx, -AIM.border, AIM.border, Math.max(0, p - 0.12), Math.min(1, p + 0.04), `rgba(255,255,255,${0.9 * (1 - p * 0.5)})`);
  }
}

export function drawScene(ctx: Ctx, s: GameState, v: View): void {
  const ratio = s.fill / s.capacity;
  const danger = ratio >= DANGER_RATIO && v.overAt < 0;
  ctx.save();
  if (v.shakeLeft > 0) {
    const amp = LOOK.shakeMax * clamp(v.shakeLeft / LOOK.bossShakeTime, 0, 1);
    ctx.translate(Math.sin(v.time * 97) * amp, Math.cos(v.time * 113) * amp);
  }
  // 遠景は、今の時間帯の絵に次の時間帯の絵を重ねて、ゆっくり移り変わらせる
  const phase = skyPhase(s.t);
  const tint = PALETTES[phase.from]!;
  const next = PALETTES[phase.to]!;
  ctx.drawImage(worlds[phase.from]!, 0, 0, W, H);
  if (phase.mix > 0) {
    ctx.globalAlpha = phase.mix;
    ctx.drawImage(worlds[phase.to]!, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  drawClouds(ctx, v.time, tint.clouds + (next.clouds - tint.clouds) * phase.mix);
  drawSparkles(ctx, v.time);
  drawRushGlow(ctx, s, v);
  ctx.drawImage(stage!, 0, 0, W, H);
  drawChevrons(ctx, v.time);
  drawLaneOverlays(ctx, s, v);
  drawAimColumn(ctx, s, v);
  drawBlocks(ctx, s, v);
  drawEnemies(ctx, s, v);
  drawEnemyNameTag(ctx, s, v);
  drawWeakPoints(ctx, s, v);
  drawBarricade(ctx, v.time, danger);
  drawBuddies(ctx, s, v);
  drawPlayer(ctx, s, v);
  drawBeam(ctx, s, v);
  drawEffects(ctx, v);
  // 時間帯の光を、道の上のもの全体に薄く重ねる
  for (const [p, a] of [[tint, 1 - phase.mix], [next, phase.mix]] as const) {
    if (a <= 0) continue;
    ctx.globalAlpha = a;
    ctx.fillStyle = p.tint;
    ctx.fillRect(-10, HORIZON_Y, W + 20, H - HORIZON_Y + 10);
  }
  ctx.globalAlpha = 1;
  if (v.overAt >= 0) drawFlood(ctx, v);
  ctx.restore();

  if (danger) {
    // 割合が上がるほど濃く、速く脈打つ
    const d = clamp((ratio - DANGER_RATIO) / (1 - DANGER_RATIO), 0, 1);
    ctx.globalAlpha = (0.35 + 0.45 * d) * (0.6 + 0.4 * Math.sin(v.time * (5 + d * 7)));
    ctx.drawImage(vignette!, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  if (v.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${v.flash})`;
    ctx.fillRect(0, 0, W, H);
  }
}

/** ラッシュ中（ボス戦のウェーブではボスがいる間）は、地平線の向こうを赤く（ボス戦は紫に）光らせる */
function drawRushGlow(ctx: Ctx, s: GameState, v: View): void {
  if (s.over || s.t % B.waveLength < RUSH_START) return;
  const boss = waveOf(s.t) % B.bossEvery === 0;
  const a = 0.3 + 0.12 * Math.sin(v.time * 6);
  const g = ctx.createLinearGradient(0, HORIZON_Y - 120, 0, HORIZON_Y);
  g.addColorStop(0, boss ? 'rgba(170,60,255,0)' : 'rgba(255,60,40,0)');
  g.addColorStop(1, boss ? `rgba(170,60,255,${a})` : `rgba(255,60,40,${a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, HORIZON_Y - 120, W, 120);
}

/** 弾の列を、プレイヤーから標的まで薄く光らせる。狙いがどこに当たっているかを見せる。会心のあいだは金色 */
function drawAimColumn(ctx: Ctx, s: GameState, v: View): void {
  if (s.over) return;
  const u = s.player.x;
  const rgb = v.aim.crit ? '255,214,64' : '255,255,255';
  const a = (v.aim.crit ? 0.3 : 0.15) + 0.04 * Math.sin(v.time * 9);
  band(ctx, u - AIM.beamHalf, u + AIM.beamHalf, 0, v.aim.z, `rgba(${rgb},${v.aim.hit ? a : a * 0.45})`);
  // 列の両端に細い線を引いて、当たる幅をはっきり見せる
  for (const side of [-1, 1]) band(ctx, u + side * AIM.beamHalf - 0.004, u + side * AIM.beamHalf + 0.004, 0, v.aim.z, `rgba(${rgb},${v.aim.hit ? 0.45 : 0.18})`);
  if (v.aim.hit) {
    // 標的の足元に、脈打つ輪を出す
    const r = (30 + 4 * Math.sin(v.time * 10)) * v.aim.k + 6;
    ctx.strokeStyle = `rgba(${rgb},0.85)`;
    ctx.lineWidth = v.aim.crit ? 4 : 2.5;
    ctx.beginPath();
    ctx.ellipse(v.aim.x, yOf(v.aim.z), r, r * 0.32, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** 的の印（同心円と十字）。hot なら金色に光らせる */
function drawTarget(ctx: Ctx, x: number, y: number, r: number, hot: boolean, time: number): void {
  if (hot) {
    ctx.globalCompositeOperation = 'lighter';
    circle(ctx, x, y, r * (1.5 + 0.2 * Math.sin(time * 30)), 'rgba(255,214,64,0.45)');
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.lineWidth = Math.max(1.5, r * 0.22);
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, r * 0.13);
  ctx.strokeStyle = hot ? '#ffd640' : '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.moveTo(x - r * 1.5, y);
  ctx.lineTo(x - r * 0.45, y);
  ctx.moveTo(x + r * 0.45, y);
  ctx.lineTo(x + r * 1.5, y);
  ctx.moveTo(x, y - r * 1.5);
  ctx.lineTo(x, y - r * 0.45);
  ctx.moveTo(x, y + r * 0.45);
  ctx.lineTo(x, y + r * 1.5);
  ctx.stroke();
  circle(ctx, x, y, Math.max(1.2, r * 0.2), hot ? '#ffd640' : '#ffffff');
}

/**
 * 敵の弱点の印。ここを弾の列で捉えると会心になる。
 * ボスの弱点は左右に動くので、いつも見せる。ふつうの敵は、今当たっている敵にだけ出す。
 */
function drawWeakPoints(ctx: Ctx, s: GameState, v: View): void {
  if (s.over) return;
  for (const e of s.enemies) {
    if (e.kind !== 'boss') continue;
    const vis = v.enemies.get(e.id);
    if (!vis) continue;
    const h = sprite(vis.spriteId).h * vis.scale;
    const hot = v.aim.enemyId === e.id && v.aim.crit;
    drawTarget(ctx, xOf(weakPointOf(e, s.t), vis.z), vis.y - h * 0.45, 20 * vis.scale + 3, hot, v.time);
  }
  if (v.aim.enemyId === 0) return;
  const target = s.enemies.find((e) => e.id === v.aim.enemyId);
  if (!target || target.kind === 'boss') return;
  drawTarget(ctx, v.aim.weakX, v.aim.y, 13 * v.aim.k + 3, v.aim.crit, v.time);
}

/** 初めて出た種類の敵は、紹介の札が出ているあいだ、いちばん手前の 1 体の頭上に名前を出す（札の絵と実物を結びつける） */
function drawEnemyNameTag(ctx: Ctx, s: GameState, v: View): void {
  const intro = v.enemyIntro;
  if (!intro || s.over) return;
  const age = v.time - intro.start;
  if (age >= LOOK.introTime) return;
  const e = s.enemies.find((o) => o.kind === intro.kind);
  const vis = e && v.enemies.get(e.id);
  if (!vis) return;
  const name = ENEMIES.find((d) => d.id === intro.kind)!.name;
  const top = vis.y - sprite(vis.spriteId).h * vis.scale;
  const y = top - 20 - Math.abs(Math.sin(v.time * 6)) * 4;
  ctx.globalAlpha = clamp((LOOK.introTime - age) / 0.3, 0, 1);
  fancyText(ctx, name, vis.x, y, { size: 17, top: '#ffffff', bottom: '#ffe27a', strokeWidth: 4, shadow: 1 });
  poly(ctx, [vis.x - 6, y + 11, vis.x + 6, y + 11, vis.x, y + 18], INK);
  ctx.globalAlpha = 1;
}
