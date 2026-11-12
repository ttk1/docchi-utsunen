// 結果を貼るときの文面（仕様書 2.6 節）と、リザルトのボタン。
import { describe, expect, it } from 'vitest';
import { HASHTAG, LOW_POWER_LINE, resultButtons, resultText, shareText, type ResultStats } from '../src/app/screens.ts';

const result: ResultStats = {
  score: 151365,
  highScore: 151365,
  newRecord: true,
  wave: 14,
  weapon: 'バズーカ',
  power: 5670000,
  review: { title: '両取り名人', hint: '', taken: 30, offered: 36, doubles: 12, critRate: 0.5 },
};

describe('結果の文面', () => {
  it('1 行の結果は、WAVE・スコア・社会人力を並べる', () => {
    expect(resultText(result)).toBe('どっち撃つねん｜WAVE 14・スコア 151,365・社会人力 567万');
  });

  it('貼る文面は、結果・称号・ハッシュタグの 3 行で、URL は含めない', () => {
    expect(shareText(result).split('\n')).toEqual([resultText(result), '称号「両取り名人」', HASHTAG]);
    expect(shareText(result)).not.toMatch(/https?:/);
  });

  it('社会人力が低いときは、リザルトと同じひとことを添える', () => {
    const low = { ...result, power: 74 };
    expect(shareText(low).split('\n')[1]).toBe(`${LOW_POWER_LINE} 称号「両取り名人」`);
  });
});

describe('リザルトのボタン', () => {
  it('決定キーが最初に効くのは「もう一度」', () => {
    expect(resultButtons()[0]!.id).toBe('retry');
  });

  it('ボタンどうしが重ならず、画面に収まる', () => {
    const bs = resultButtons();
    for (const a of bs) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x + a.w).toBeLessThanOrEqual(540);
      for (const b of bs) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id} と ${b.id}`).toBe(true);
      }
    }
  });
});
