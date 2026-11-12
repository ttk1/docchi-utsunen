// プレイ中の表示類（仕様書 6.7 節）と、画面中央に出る演出の文字。
import { AIM, B, ENEMIES, RUSH_START } from '../core/balance.ts';
import { bossName, dpsOf, waveOf, weaponName, weaponStage } from '../core/formulas.ts';
import type { GameState } from '../core/state.ts';
import { INK, circle, clamp, fancyText, fillRoundRect, gradV, poly, roundRect, text, textWidth, type Ctx } from './draw.ts';
import { formatComma, formatNumber } from './format.ts';
import { W, kOf, xOf, yOf } from './projection.ts';
import { canBreakInTime } from './scene.ts';
import { drawSprite, drawSpriteCentered, sprite } from './sprites.ts';
import { LOOK, blockZ, enemySpriteId, type View } from './view.ts';

/** 埋まり度がこの割合以上でゲージが赤く点滅する */
export const DANGER_RATIO = 0.7;
export interface HudOptions {
  /** タイトル画面のデモ。右上の「✕」のためにゲージを短くし、武器名を上に移す */
  demo: boolean;
}

/** 輪郭つきの角丸を、縦のグラデーションで塗る */
function plate(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, top: string, bottom: string): void {
  fillRoundRect(ctx, x - 2.5, y - 2.5, w + 5, h + 5, r + 2.5, INK);
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = gradV(ctx, y, y + h, top, bottom);
  ctx.fill();
}

function drawGauge(ctx: Ctx, s: GameState, v: View, width: number): void {
  // 危険域では、ゲージが小刻みに震える
  const shake = s.fill / s.capacity >= DANGER_RATIO && !s.over ? Math.sin(v.time * 47) * 1.6 : 0;
  const x = 20 + shake;
  const y = 16;
  const h = 24;
  const ratio = clamp(s.fill / s.capacity, 0, 1);
  plate(ctx, x, y, width, h, 12, '#232838', '#3a4157');
  const danger = ratio >= DANGER_RATIO;
  // 点滅は毎秒 2.5 回（1 秒に 3 回を超えない）
  const blink = danger && Math.sin(v.time * Math.PI * 5) > 0;
  const [top, bottom] = danger ? (blink ? ['#ff8a8a', '#ff1f1f'] : ['#e05252', '#a81414']) : ratio >= 0.45 ? ['#ffe08a', '#ff9d1a'] : ['#9ff5a8', '#27b85a'];
  if (ratio > 0) {
    const fw = Math.max(h, width * ratio);
    ctx.save();
    roundRect(ctx, x, y, fw, h, 12);
    ctx.clip();
    ctx.fillStyle = gradV(ctx, y, y + h, top!, bottom!);
    ctx.fillRect(x, y, fw, h);
    // 流れる縞と、上側のつや
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    const shift = (v.time * 30) % 28;
    for (let sx = x - 28 + shift; sx < x + fw; sx += 28) {
      ctx.beginPath();
      ctx.moveTo(sx, y + h);
      ctx.lineTo(sx + 12, y + h);
      ctx.lineTo(sx + 24, y);
      ctx.lineTo(sx + 12, y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(x, y + 2, fw, 6);
    ctx.restore();
  }
  // 危険域の目印
  const mx = x + width * DANGER_RATIO;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(mx - 1, y, 2, h);
  ctx.beginPath();
  ctx.moveTo(mx - 5, y - 3);
  ctx.lineTo(mx + 5, y - 3);
  ctx.lineTo(mx, y + 4);
  ctx.closePath();
  ctx.fillStyle = '#ff5c5c';
  ctx.fill();
  fancyText(ctx, `埋まり度 ${Math.floor(ratio * 100)}%`, x + width / 2, y + h / 2 + 1, { size: 16, top: '#ffffff', bottom: '#e8eefc', strokeWidth: 4, shadow: 0 });
}

function drawWave(ctx: Ctx, s: GameState, x: number): void {
  const wave = waveOf(s.t);
  const tau = s.t % B.waveLength;
  const bossWave = wave % B.bossEvery === 0;
  const rush = tau >= RUSH_START;
  text(ctx, 'WAVE', x, 58, { size: 13, weight: 900, align: 'left', color: '#cfe0ff', stroke: INK, strokeWidth: 3 });
  // WAVE が変わった直後は数字が弾む
  const pop = tau < 0.3 ? 1 + (1 - tau / 0.3) * 0.5 : 1;
  fancyText(ctx, String(wave), x + 46, 63, { size: 30 * pop, top: '#ffffff', bottom: rush ? '#ffb0b0' : '#bcd7ff', align: 'left' });
  // 20 秒の進行バー。凪とラッシュ（ボス戦ならボス）を色で分ける
  const bx = x;
  const by = 82;
  const bw = 150;
  const bh = 9;
  const calm = (bw * RUSH_START) / B.waveLength;
  fillRoundRect(ctx, bx - 2.5, by - 2.5, bw + 5, bh + 5, 7, INK);
  ctx.save();
  roundRect(ctx, bx, by, bw, bh, 4.5);
  ctx.clip();
  ctx.fillStyle = '#2b4470';
  ctx.fillRect(bx, by, calm, bh);
  ctx.fillStyle = bossWave ? '#5a2d85' : '#7a2a2a';
  ctx.fillRect(bx + calm, by, bw - calm, bh);
  const p = (bw * tau) / B.waveLength;
  ctx.fillStyle = gradV(ctx, by, by + bh, '#bfe0ff', '#5aa2ff');
  ctx.fillRect(bx, by, Math.min(p, calm), bh);
  if (p > calm) {
    ctx.fillStyle = bossWave ? gradV(ctx, by, by + bh, '#e6c4ff', '#b05cff') : gradV(ctx, by, by + bh, '#ffb3b3', '#ff4d4d');
    ctx.fillRect(bx + calm, by, p - calm, bh);
  }
  ctx.restore();
  circle(ctx, bx + p, by + bh / 2, 6.5, INK);
  circle(ctx, bx + p, by + bh / 2, 4.5, rush ? '#ffe066' : '#ffffff');
}

function drawCenterTop(ctx: Ctx, s: GameState, v: View, y: number, small: boolean): void {
  const size = small ? 26 : 42;
  if (v.warning) {
    // 点滅は毎秒 2.5 回
    if (Math.sin(v.time * Math.PI * 5) > -0.2) {
      if (v.warning.boss) {
        fancyText(ctx, 'WARNING', W / 2, y, { size, top: '#fff3a0', bottom: '#ff9d1a', stroke: '#4a0a0a' });
        fancyText(ctx, v.warning.name, W / 2, y + size * 0.92, { size: size * 0.62, top: '#ffffff', bottom: '#ffd0d0', stroke: '#4a0a0a', maxWidth: 440 });
      } else {
        fancyText(ctx, 'RUSH!', W / 2, y, { size: size * 1.2, top: '#ffb0b0', bottom: '#ff1f1f', stroke: '#ffffff', strokeWidth: size * 0.16 });
        fancyText(ctx, v.warning.name, W / 2, y + size * 0.95, { size: size * 0.5, top: '#ffffff', bottom: '#ffd0d0', stroke: '#4a0a0a', maxWidth: 440 });
      }
    }
    return;
  }
  // ボスがいる間は名前と HP を出す
  for (const e of s.enemies) {
    if (e.kind !== 'boss') continue;
    fancyText(ctx, bossName(e.bossIndex), W / 2, y - 8, { size: small ? 18 : 25, top: '#ffffff', bottom: '#ffd0d0', stroke: '#4a0a0a', maxWidth: 400 });
    const bw = small ? 220 : 300;
    const ratio = clamp(e.hp / e.hp0, 0, 1);
    plate(ctx, W / 2 - bw / 2, y + 12, bw, 12, 6, '#232838', '#3a4157');
    if (ratio > 0) {
      roundRect(ctx, W / 2 - bw / 2, y + 12, bw * ratio, 12, 6);
      ctx.fillStyle = gradV(ctx, y + 12, y + 24, '#ff9a9a', '#e01f1f');
      ctx.fill();
    }
    return;
  }
}

function drawToasts(ctx: Ctx, v: View): void {
  for (const t of v.toasts) {
    const age = v.time - t.start;
    // 出るときに少し大きく弾み、終わりに薄れる
    const pop = age < 0.12 ? 0.6 + (age / 0.12) * 0.6 : age < 0.2 ? 1.2 - ((age - 0.12) / 0.08) * 0.2 : 1;
    ctx.globalAlpha = clamp((t.life - age) / 0.25, 0, 1);
    ctx.save();
    ctx.translate(t.x, t.y - age * 14);
    ctx.rotate(-0.04);
    fancyText(ctx, t.label, 0, 0, { size: t.size * pop, top: t.tone[0], bottom: t.tone[1], maxWidth: 500 });
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawBossIntro(ctx: Ctx, v: View): void {
  if (!v.bossIntro) return;
  const age = v.time - v.bossIntro.start;
  const a = clamp(Math.min(age / 0.15, (LOOK.bossIntroTime - age) / 0.3), 0, 1);
  ctx.globalAlpha = a;
  ctx.fillStyle = gradV(ctx, 380, 570, 'rgba(60,0,0,0.86)', 'rgba(10,0,0,0.86)');
  ctx.fillRect(0, 380, W, 190);
  // 上下の帯を警戒色の縞にして流す
  for (const y of [374, 564]) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, W, 12);
    ctx.clip();
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(0, y, W, 12);
    ctx.fillStyle = INK;
    const shift = (v.time * 60) % 30;
    for (let x = -30 + shift; x < W + 30; x += 30) {
      ctx.beginPath();
      ctx.moveTo(x, y + 12);
      ctx.lineTo(x + 12, y + 12);
      ctx.lineTo(x + 24, y);
      ctx.lineTo(x + 12, y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  const slide = (1 - clamp(age / 0.2, 0, 1)) * 200;
  fancyText(ctx, 'BOSS', W / 2 - slide, 422, { size: 28, top: '#fff3a0', bottom: '#ff9d1a' });
  fancyText(ctx, v.bossIntro.name, W / 2 + slide, 484, { size: 80, top: '#ffffff', bottom: '#ffb0b0', stroke: '#b01212', strokeWidth: 10, maxWidth: 500 });
  // ボスのひとこと。名前より少し遅れて出す
  ctx.globalAlpha = a * clamp((age - 0.35) / 0.2, 0, 1);
  text(ctx, v.bossIntro.line, W / 2, 546, { size: 21, weight: 900, color: '#ffe9c9', maxWidth: 480 });
  ctx.globalAlpha = 1;
}

/** 開始直後の案内。遊ぶ場所をふさがないよう、道の上に小さく書く */
function drawGuide(ctx: Ctx, s: GameState, v: View): void {
  if (s.t >= LOOK.guideTime) return;
  const fade = clamp(LOOK.guideTime - s.t, 0, 1);
  const bounce = Math.abs(Math.sin(v.time * 5)) * 6;
  ctx.globalAlpha = fade;
  fillRoundRect(ctx, 76, 104, 388, 34, 17, 'rgba(10,14,30,0.7)');
  text(ctx, '← 左右に動いて狙う →　真ん中に当てると会心', W / 2, 122, { size: 16, weight: 900, color: '#ffffff', maxWidth: 360 });
  // 真ん中は敵、両端は強化ブロック
  ctx.globalAlpha = fade * 0.92;
  fancyText(ctx, '▼ 敵 ▼', xOf(0, 0.1), yOf(0.1) + bounce, { size: 30, top: '#ffd0d0', bottom: '#ff5c5c' });
  for (const u of AIM.blockCols) fancyText(ctx, '▼強化', xOf(u, 0.1), yOf(0.1) + bounce, { size: 24, top: '#ffffff', bottom: '#8fd0ff' });
  ctx.globalAlpha = 1;
}

/**
 * まだ 1 個も強化を取っていない人に、ランクアップのブロックを指して「撃つもの」だと教える。
 * 広告を見て来た人は、箱が何なのかを知らないため。1 個取れたら、もう出さない
 */
function drawFirstBlockHint(ctx: Ctx, s: GameState, v: View): void {
  if (s.got.rank > 0 || s.player.rank > 0 || s.t >= LOOK.firstBlockHintTime || s.over) return;
  const b = s.blocks.find((o) => o.kind === 'rank');
  if (!b) return;
  // もう間に合わないブロックには出さない（「間に合わない」の表示と食い違うため）。撃っている最中は出したままにする
  if (!canBreakInTime(s, b) && v.aim.blockId !== b.id) return;
  const z = blockZ(s, b.passAt);
  const k = kOf(z);
  const x = clamp(xOf(b.u, z), 112, W - 112);
  const bounce = Math.abs(Math.sin(v.time * 5)) * 6;
  // 遠いうちは、上に出すと敵の紹介の札に重なるので、ブロックの下から指す。近づいたら上から指す
  const below = z > LOOK.firstBlockHintZ;
  const y = below ? yOf(z) + 30 + bounce : yOf(z) - 118 * k - 16 - bounce;
  const dir = below ? -1 : 1;
  fillRoundRect(ctx, x - 104, y - 16.5, 208, 32, 16, INK);
  poly(ctx, [x - 9, y + dir * 14, x + 9, y + dir * 14, x, y + dir * 25], INK);
  fillRoundRect(ctx, x - 101.5, y - 14, 203, 27, 13.5, '#ffd23f');
  poly(ctx, [x - 6, y + dir * 12, x + 6, y + dir * 12, x, y + dir * 21], '#ffd23f');
  text(ctx, '撃って壊すと強くなる！', x, y - 0.5, { size: 16, weight: 900, color: INK, maxWidth: 190 });
}

function drawWeaponBar(ctx: Ctx, s: GameState): void {
  const rank = s.player.rank;
  plate(ctx, 12, 910, W - 24, 42, 14, '#3a4157', '#1e2230');
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(18, 913, W - 36, 8);
  circle(ctx, 40, 931, 19, INK);
  circle(ctx, 40, 931, 16.5, '#4d5874');
  drawSpriteCentered(ctx, `weapon.${weaponStage(rank)}`, 40, 931, 0.42, 0.5);
  fancyText(ctx, weaponName(rank), 66, 932, { size: 21, top: '#ffffff', bottom: '#cfe6ff', align: 'left', maxWidth: 230, shadow: 0, strokeWidth: 4 });
  // ランクの札
  const lv = `Lv.${rank}`;
  const lx = 66 + Math.min(230, textWidth(ctx, weaponName(rank), 21)) + 10;
  fillRoundRect(ctx, lx, 921, 58, 22, 11, '#ffd23f');
  text(ctx, lv, lx + 29, 932.5, { size: 14, weight: 900, color: INK, maxWidth: 50 });
  fancyText(ctx, `DPS ${formatNumber(dpsOf(rank))}`, W - 26, 932, { size: 20, top: '#fff7a8', bottom: '#ffb400', align: 'right', shadow: 0, strokeWidth: 4 });
}

export function drawHud(ctx: Ctx, s: GameState, v: View, o: HudOptions): void {
  drawGauge(ctx, s, v, o.demo ? 460 : 500);
  drawWave(ctx, s, o.demo ? 20 : 66);
  // スコアは増えた瞬間に弾む
  const bump = v.time - v.scoreAt < 0.1 ? 1.14 : 1;
  fancyText(ctx, formatComma(s.score), W - 20, 62, { size: 28 * bump, top: '#ffffff', bottom: '#ffe9a8', align: 'right' });
  if (o.demo) {
    const line = `${weaponName(s.player.rank)} Lv.${s.player.rank}　DPS ${formatNumber(dpsOf(s.player.rank))}`;
    text(ctx, line, W - 20, 90, { size: 15, weight: 900, align: 'right', stroke: INK, strokeWidth: 3.5 });
    drawCenterTop(ctx, s, v, 176, true);
  } else {
    text(ctx, 'スコア', W - 20, 88, { size: 12, weight: 900, align: 'right', color: '#e8eefc', stroke: INK, strokeWidth: 3 });
    drawWeaponBar(ctx, s);
    drawCenterTop(ctx, s, v, 150, false);
    drawGuide(ctx, s, v);
    drawFirstBlockHint(ctx, s, v);
  }
  drawEnemyIntro(ctx, v);
  drawToasts(ctx, v);
  drawBossIntro(ctx, v);
}

/**
 * 初めて出た種類の敵を、絵・名前・ひとことで紹介する札。
 * 何と戦っているのか（現代人のストレス）と、その敵の扱い方を、出てきたその場で伝える。
 */
function drawEnemyIntro(ctx: Ctx, v: View): void {
  const intro = v.enemyIntro;
  if (!intro) return;
  const age = v.time - intro.start;
  if (age >= LOOK.introTime) return;
  const def = ENEMIES.find((d) => d.id === intro.kind)!;
  // 右から滑り込んで、終わりに薄れる
  const slide = (1 - clamp(age / 0.18, 0, 1)) ** 2 * 80;
  ctx.globalAlpha = clamp((LOOK.introTime - age) / 0.3, 0, 1) * clamp(age / 0.12, 0, 1);
  ctx.save();
  ctx.translate(slide, 0);
  fillRoundRect(ctx, 75, 177, 390, 62, 16, INK);
  fillRoundRect(ctx, 78, 180, 384, 56, 13, 'rgba(24,30,58,0.94)');
  // 絵は、札の左の丸い窓に収まる大きさで出す
  circle(ctx, 112, 208, 24, 'rgba(255,255,255,0.14)');
  const id = enemySpriteId(intro.kind, 0, 0);
  const sp = sprite(id);
  const scale = Math.min(40 / sp.w, 40 / sp.h);
  drawSprite(ctx, id, 112, 208 + (sp.h * scale) / 2, scale);
  fillRoundRect(ctx, 146, 186, 40, 18, 9, '#ffd23f');
  text(ctx, 'NEW', 166, 195.5, { size: 12, weight: 900, color: INK });
  fancyText(ctx, def.name, 194, 196, { size: 21, top: '#ffffff', bottom: '#ffe27a', align: 'left', shadow: 0, strokeWidth: 4, maxWidth: 256 });
  text(ctx, def.intro, 146, 222, { size: 15, weight: 800, align: 'left', color: '#dbe6ff', maxWidth: 304 });
  ctx.restore();
  ctx.globalAlpha = 1;
}
