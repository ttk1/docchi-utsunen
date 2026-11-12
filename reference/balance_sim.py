#!/usr/bin/env python3
"""どっち撃つねん 参照シミュレータ

docs/spec.md の 2章(ルール)・3章(バランス)・4章(データ)・5章(デモAI)・9章(ボット)を
そのまま実装した、画面なしのゲームロジック。TypeScript 実装の答え合わせに使う。

    python3 balance_sim.py            # 全ボット 100 回ずつの集計と合格判定
    python3 balance_sim.py --golden   # golden.json (単体テスト用の期待値) を書き出す
    python3 balance_sim.py --seeds    # 各ボットの種 0〜9 の生存時間も出す
    python3 balance_sim.py --knobs    # 調整つまみごとの感度 (時間がかかる)

乱数は mulberry32。JavaScript の定番実装と同じ値列を返すので、
ブロックの段の並びは TypeScript 側でも種ごとに完全一致する。
"""
import json, math, statistics, sys
from multiprocessing import Pool

# ---------------------------------------------------------------- 乱数
M32 = 0xFFFFFFFF
def mulberry32(seed):
    a = seed & M32
    def rnd():
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & M32
        t = ((t + (((t ^ (t >> 7)) * (t | 61)) & M32)) & M32) ^ t
        return ((t ^ (t >> 14)) & M32) / 4294967296
    return rnd

def shuffle(a, rnd):
    """Fisher-Yates。i = n-1 から 1 まで、j = floor(rnd() * (i+1)) と入れ替える"""
    for i in range(len(a) - 1, 0, -1):
        j = int(rnd() * (i + 1))
        a[i], a[j] = a[j], a[i]

SPAWN_SALT = 0x9E3779B9     # 敵の出現用の乱数列の種     = seed + SPAWN_SALT
BOT_SALT = 0x85EBCA6B       # ボット用の乱数列の種       = seed + BOT_SALT
POSITION_SALT = 0xC2B2AE35  # 敵の横位置用の乱数列の種   = seed + POSITION_SALT

# ---------------------------------------------------------------- 設定値 (spec 3.4, 4章)
P = dict(
    TPS=60,                       # 1秒あたりの刻み数
    D0=40.0, G=1.2,
    R_REF=0.44 / 3,               # 4/30 + 2/150 [rank/s]
    PHI0=0.30, KAPPA=0.0052,
    S0=3.0, S_SLOPE=0.02, S_MAX=8.0,
    CAP=100.0,
    WAVE=20.0, RUSH_LEN=5.0, RUSH_MULT=2.0,
    BOSS_EVERY=5, BOSS_COEF=7.0, BOSS_SIZE=20.0,
    BLOCK_FIRST=3.0, BLOCK_INTERVAL=5.0, BLOCK_TRAVEL=10.0,
    COST=dict(rank=3.5, gold=5.0, buddy=4.0, bomb=1.5, vacation=2.0, expand=2.5, trap=0.7, hat=1.5),
    GOLD_RANKS=2, BUDDY_DPS=0.10, BUDDY_MAX=3,
    BOMB_SIZE=35.0, BOMB_BOSS=0.15,
    VACATION=6.0, EXPAND=10.0, EXPAND_MAX=3, TRAP_COUNT=8,
    REV_RATE=0.10, REV_TIME=20.0,
    # 位置取り (spec 2.1, 2.2)。横位置 u は -1(左端) 〜 +1(右端)
    MIN_X=-0.9, MAX_X=0.9, MOVE_SPEED=3.0, BEAM_HALF=0.06,
    CRIT_HALF=0.05, CRIT_MULT=2.0,          # 会心: 弱点を捉えるとダメージが倍
    BOSS_WEAK_SWING=0.3, BOSS_WEAK_PERIOD=4.0,   # ボスの弱点は左右に往復する
    ENEMY_MIN=-0.5, ENEMY_MAX=0.5, GROUP_SPREAD=0.3, BORDER=0.55,
    BOSS_U=0.0, BOSS_HALF=0.5,
    BLOCK_COLS=(-0.76, 0.76), BLOCK_HALF=0.156,
)
# (id, HP倍率, サイズ, 解禁WAVE, 重み, 1回の出現数, 半分の幅)  ※s̄・m̄ は「倍率×数」「サイズ×数」で計算する
ENEMY_TYPES = [
    ("notice",    2.5,  2.5, 1, 10.0, 1, 0.13),
    ("spam",      0.35, 0.5, 3, 2.5,  8, 0.075),
    ("deadline",  10.0, 6.0, 6, 1.5,  1, 0.21),
    ("revolving", 3.0,  3.0, 9, 1.5,  1, 0.145),
]
# ブロックの段 (spec 4.3)。袋 1 つ = 6 段、うち 4 段がランクアップの段
ROWS_PER_BAG = 6
RANK_ROWS = 4
PILE_BASE = [("gold", 1), ("bomb", 7), ("vacation", 5), ("trap", 11), ("hat", 10)]   # + サポート枠 6 枚
SUPPORT_PER_PILE = 6

# ---------------------------------------------------------------- 数式 (spec 3.2)
def dps_of(rank, p): return p["D0"] * p["G"] ** rank
def d_ref(t, p): return p["D0"] * p["G"] ** (p["R_REF"] * t)
def phi(t, p): return p["PHI0"] * math.exp(p["KAPPA"] * t)
def size_rate(t, p): return min(p["S_MAX"], p["S0"] + p["S_SLOPE"] * t)
def wave_of(t, p): return int(t // p["WAVE"]) + 1
def unlocked(t, p): return [e for e in ENEMY_TYPES if e[3] <= wave_of(t, p)]
def base_hp(t, p):
    ts = unlocked(t, p); tot = sum(e[4] for e in ts)
    s_bar = sum(e[2] * e[5] * e[4] for e in ts) / tot
    m_bar = sum(e[1] * e[5] * e[4] for e in ts) / tot
    return phi(t, p) * d_ref(t, p) * s_bar / (size_rate(t, p) * m_bar)

# ---------------------------------------------------------------- ブロックの段 (spec 4.3)
class Deck:
    def __init__(self, seed, p):
        self.rnd = mulberry32(seed); self.p = p
        self.first = True; self.bag = []; self.pile = []; self.sup_given = 0
    def from_pile(self):
        p = self.p
        if not self.pile:
            for kind, n in PILE_BASE: self.pile += [kind] * n
            for _ in range(SUPPORT_PER_PILE):
                if self.sup_given < p["BUDDY_MAX"]: self.pile.append("buddy")
                elif self.sup_given < p["BUDDY_MAX"] + p["EXPAND_MAX"]: self.pile.append("expand")
                else: self.pile.append("vacation")
                self.sup_given += 1
            shuffle(self.pile, self.rnd)
        return self.pile.pop()
    def draw_row(self):
        """次の段。並びは [左の列, 右の列]。最初の段だけはランクアップ 1 個"""
        if self.first:
            self.first = False; return ["rank"]
        if not self.bag:
            self.bag = [i < RANK_ROWS for i in range(ROWS_PER_BAG)]
            shuffle(self.bag, self.rnd)
        first = "rank" if self.bag.pop() else self.from_pile()
        second = self.from_pile()
        return [first, second] if self.rnd() < 0.5 else [second, first]

# ---------------------------------------------------------------- ゲーム本体 (spec 2章)
class Enemy:
    __slots__ = ("hp", "size", "kind", "hp0", "born", "u", "hw")
    def __init__(self, hp, size, kind, born, u, hw):
        self.hp = hp; self.size = size; self.kind = kind; self.hp0 = hp; self.born = born; self.u = u; self.hw = hw

class Block:
    __slots__ = ("id", "kind", "hp", "maxhp", "pass_t", "row", "col", "u")
    def __init__(self, id, kind, hp, pass_t, row, col, u):
        self.id = id; self.kind = kind; self.hp = hp; self.maxhp = hp; self.pass_t = pass_t; self.row = row; self.col = col; self.u = u

class Game:
    def __init__(self, seed, p=P):
        self.p = p; self.dt = 1.0 / p["TPS"]; self.tick = 0; self.t = 0.0
        self.deck = Deck(seed, p); self.rnd = mulberry32(seed + SPAWN_SALT); self.pos = mulberry32(seed + POSITION_SALT)
        self.x = 0.0; self.rank = 0; self.buddy = 0; self.cap = p["CAP"]; self.expands = 0; self.hats = 0
        self.enemies = []      # 先頭が最も古く、最も手前
        self.growing = []      # 成長中のリボ払い
        self.blocks = []       # 通過時刻の早い順
        self.fill = 0.0; self.budget = 0.0; self.next_row = p["BLOCK_FIRST"]; self.rows = 0; self.next_id = 1
        self.half_rows = []; self.doubles = 0; self.hit_ticks = 0; self.crit_ticks = 0
        self.vac_until = -1.0; self.boss_wave = 0; self.bosses_killed = 0
        self.score = 0.0; self.dead = False; self.got = {}; self.missed = {}
    @property
    def dps(self): return dps_of(self.rank, self.p)
    def spawn_mult(self):
        p = self.p; tau = self.t % p["WAVE"]; calm = p["WAVE"] - p["RUSH_LEN"]
        if tau < calm: return (p["WAVE"] - p["RUSH_LEN"] * p["RUSH_MULT"]) / calm
        return 0.0 if wave_of(self.t, p) % p["BOSS_EVERY"] == 0 else p["RUSH_MULT"]
    def add_enemy(self, hp, size, kind, u, hw):
        e = Enemy(hp, size, kind, self.t, u, hw); self.enemies.append(e); self.fill += size
        if kind == "revolving": self.growing.append(e)
    def add_group(self, d, count, hp):
        """敵 count 体をひとかたまりで出す。まとめて出る敵は中心のまわりに散らばる"""
        p = self.p; lo = p["ENEMY_MIN"] + d[6]; hi = p["ENEMY_MAX"] - d[6]
        center = lo + (hi - lo) * self.pos()
        for _ in range(count):
            u = center if count == 1 else min(hi, max(lo, center + (self.pos() - 0.5) * p["GROUP_SPREAD"]))
            self.add_enemy(hp, d[2], d[0], u, d[6])
    def spawn_group(self):
        ts = unlocked(self.t, self.p); tot = sum(e[4] for e in ts)
        r = self.rnd() * tot
        for e in ts:
            r -= e[4]
            if r <= 0: break
        self.add_group(e, e[5], base_hp(self.t, self.p) * e[1])
        return e[2] * e[5]
    def kill(self, e):
        e.hp = 0
        self.fill -= e.size; self.score += e.size * wave_of(self.t, self.p) * 10
        if e.kind == "boss":
            self.bosses_killed += 1; self.score += 5000 * self.bosses_killed
    def damage_enemies(self, dmg, x=None):
        """先頭から順に、条件に合う敵へダメージ。x を渡すとその列に重なる敵だけで、弱点を捉えていれば会心 (プレイヤーの弾)"""
        p = self.p; beam = p["BEAM_HALF"]; i = 0; first = True
        while dmg > 0 and i < len(self.enemies):
            e = self.enemies[i]
            if x is not None and abs(e.u - x) > e.hw + beam:
                i += 1; continue
            crit = x is not None and abs(weak_point(e, self.t, p) - x) <= p["CRIT_HALF"]
            mult = p["CRIT_MULT"] if crit else 1
            if x is not None and first:
                first = False; self.hit_ticks += 1
                if crit: self.crit_ticks += 1
            if e.hp <= dmg * mult:
                dmg -= e.hp / mult; self.enemies.pop(i); self.kill(e)
            else:
                e.hp -= dmg * mult; dmg = 0
    def apply_block(self, b):
        p = self.p; k = b.kind
        self.got[k] = self.got.get(k, 0) + 1
        self.score += 100 * wave_of(self.t, p)
        if b.row in self.half_rows:                       # 同じ段のもう片方を先に壊していれば「両取り」
            self.half_rows.remove(b.row); self.doubles += 1
        elif any(o.row == b.row for o in self.blocks): self.half_rows.append(b.row)
        if k == "rank": self.rank += 1
        elif k == "gold": self.rank += p["GOLD_RANKS"]
        elif k == "buddy": self.buddy = min(p["BUDDY_MAX"], self.buddy + 1)
        elif k == "bomb":
            rem = p["BOMB_SIZE"]; keep = []
            for e in self.enemies:
                if e.kind == "boss":
                    e.hp -= e.hp0 * p["BOMB_BOSS"]
                    if e.hp > 0: keep.append(e)
                    else: self.kill(e)                    # ボムでボスを倒した場合はスコアが入る
                elif rem >= e.size - 1e-9:
                    rem -= e.size; e.hp = 0; self.fill -= e.size   # ボムで消した敵はスコアなし
                else: keep.append(e)
            self.enemies = keep
        elif k == "vacation": self.vac_until = max(self.vac_until, self.t) + p["VACATION"]
        elif k == "expand":
            if self.expands < p["EXPAND_MAX"]: self.expands += 1; self.cap += p["EXPAND"]
        elif k == "trap":
            d = ENEMY_TYPES[0]
            for _ in range(p["TRAP_COUNT"]): self.add_group(d, 1, base_hp(self.t, p) * d[1])
        elif k == "hat": self.hats += 1
    def step(self, aim):
        """spec 2.7 の処理順。aim は立ちたい横位置"""
        p = self.p; dt = self.dt
        # 1. 入力
        want = min(p["MAX_X"], max(p["MIN_X"], aim)); reach = p["MOVE_SPEED"] * dt
        self.x += min(reach, max(-reach, want - self.x))
        # 2. ボス
        w = wave_of(self.t, p)
        if w % p["BOSS_EVERY"] == 0 and self.boss_wave != w and self.t % p["WAVE"] >= p["WAVE"] - p["RUSH_LEN"]:
            self.boss_wave = w
            self.add_enemy(p["BOSS_COEF"] * phi(self.t, p) * d_ref(self.t, p), p["BOSS_SIZE"], "boss", p["BOSS_U"], p["BOSS_HALF"])
        # 3. 敵の出現
        if self.t >= self.vac_until:
            self.budget += size_rate(self.t, p) * self.spawn_mult() * dt
            while self.budget > 0: self.budget -= self.spawn_group()
        # 4. リボ払いの成長
        if self.growing:
            self.growing = [e for e in self.growing if e.hp > 0 and self.t - e.born < p["REV_TIME"]]
            for e in self.growing: e.hp += e.hp0 * p["REV_RATE"] * dt
        # 5. ブロックの段の出現
        if self.t >= self.next_row:
            row = self.rows; self.rows += 1
            for col, k in enumerate(self.deck.draw_row()):
                self.blocks.append(Block(self.next_id, k, p["COST"][k] * self.dps, self.next_row + p["BLOCK_TRAVEL"], row, col, p["BLOCK_COLS"][col]))
                self.next_id += 1
            self.next_row += p["BLOCK_INTERVAL"]
        # 6. ブロックの通過
        while self.blocks and self.blocks[0].pass_t <= self.t:
            b = self.blocks.pop(0); self.missed[b.kind] = self.missed.get(b.kind, 0) + 1
            if b.row in self.half_rows: self.half_rows.remove(b.row)
        # 7. 相棒 (列に関係なく、敵の先頭から)
        if self.buddy: self.damage_enemies(self.dps * p["BUDDY_DPS"] * self.buddy * dt)
        # 8. プレイヤー。立っている列に重なる、最も手前の標的を撃つ
        if abs(self.x) < p["BORDER"]: self.damage_enemies(self.dps * dt, self.x)
        else:
            reach_b = p["BLOCK_HALF"] + p["BEAM_HALF"]
            for i, b in enumerate(self.blocks):
                if abs(b.u - self.x) <= reach_b:
                    b.hp -= self.dps * dt
                    if b.hp <= 0: self.blocks.pop(i); self.apply_block(b)
                    break
        # 9. 時間  (足し込まず、刻み数から求める)
        self.tick += 1; self.t = self.tick / p["TPS"]
        # 10. 終了判定
        if self.fill >= self.cap - 1e-9: self.dead = True

# ---------------------------------------------------------------- ボット (spec 5章, 9.1)
PRIORITY = ["rank", "gold", "buddy", "expand", "vacation", "bomb", "trap", "hat"]
LOOKAHEAD = 16

def weak_point(e, t, p):
    """敵の弱点の横位置。ふつうの敵は真ん中。ボスは真ん中から左右へ一定の速さで往復する"""
    if e.kind != "boss": return e.u
    q = (t - e.born) / p["BOSS_WEAK_PERIOD"] + 0.25; f = q - math.floor(q)
    return e.u + p["BOSS_WEAK_SWING"] * (4 * abs(f - 0.5) - 1)

def aim_oldest(g): return weak_point(g.enemies[0], g.t, g.p) if g.enemies else 0.0
def aim_best(g):
    """時間あたりに減らせるサイズが最も大きい敵。手前の敵にふさがれている敵は選ばない"""
    p = g.p; dps = g.dps; best = None; best_v = -1.0
    for i in range(min(LOOKAHEAD, len(g.enemies))):
        e = g.enemies[i]
        if any(abs(g.enemies[j].u - e.u) <= g.enemies[j].hw + p["BEAM_HALF"] for j in range(i)): continue
        v = e.size / (e.hp / dps + abs(e.u - g.x) / p["MOVE_SPEED"] + 0.05)
        if v > best_v: best_v = v; best = e
    return weak_point(best, g.t, g.p) if best else 0.0
def first_of(blocks, ok):
    """通過の早い段から、優先順で 1 個"""
    best = None; best_r = math.inf
    for b in blocks:
        if not ok(b): continue
        r = b.row * 100 + PRIORITY.index(b.kind)
        if r < best_r: best_r = r; best = b
    return best
def find_block(g, id):
    for b in g.blocks:
        if b.id == id: return b
    return None

class Bot:
    lo = 0.3; hi = 0.6; interval = 0.5; aim_interval = 0.22; aim_error = 0.07; avoid = 1.0; check = False; lapse = 0.0; smart = False
    def __init__(self, seed):
        self.rnd = mulberry32(seed + BOT_SALT); self.next = 0.0; self.next_aim = 0.0
        self.going = False; self.target = 0; self.aim = 0.0; self.junk = {}
    def fooled(self, b):
        if b.id not in self.junk: self.junk[b.id] = self.rnd() >= self.avoid
        return self.junk[b.id]
    def pick_block(self, g):
        p = g.p; ratio = g.fill / g.cap; best = None; best_r = math.inf
        for b in g.blocks:
            if any(o.col == b.col and o.pass_t < b.pass_t for o in g.blocks): continue   # 同じ列の手前にふさがれている
            if b.kind in ("trap", "hat") and not self.fooled(b): continue
            urgent = b.kind == "bomb" and ratio > 0.5
            if self.check:
                if b.kind == "bomb" and g.fill < 25: continue
                need = b.hp / g.dps + abs(b.u - g.x) / p["MOVE_SPEED"]
                if need > b.pass_t - g.t - 0.1: continue
                if not urgent and g.fill + size_rate(g.t, p) * need > 0.92 * g.cap: continue
            r = b.row - 1e6 if urgent else b.row * 100 + PRIORITY.index(b.kind)   # 急ぎのボムは段に関係なく最優先
            if r < best_r: best_r = r; best = b
        return best
    def decide(self, g):
        b = self.pick_block(g); ratio = g.fill / g.cap
        if not b: self.going = False
        elif b.kind == "bomb" and ratio > 0.5: self.going = True            # 急ぎのボムは、敵を撃つのをやめてでも取りに行く
        elif self.going: self.going = ratio <= self.hi
        else: self.going = ratio < self.lo
        self.target = b.id if self.going and b else 0
    def act(self, g):
        if g.t >= self.next - 1e-9:
            self.next += self.interval
            if self.rnd() >= self.lapse: self.decide(g)
        if self.going:
            b = find_block(g, self.target)
            if b: return b.u
            nb = self.pick_block(g)
            if nb:
                self.target = nb.id; return nb.u
            return g.x
        if g.t >= self.next_aim - 1e-9:
            self.next_aim = g.t + self.aim_interval
            self.aim = (aim_best(g) if self.smart else aim_oldest(g)) + (self.rnd() * 2 - 1) * self.aim_error
        return self.aim

class EnemyOnly(Bot):
    def act(self, g):
        if g.t >= self.next_aim - 1e-9:
            self.next_aim = g.t + self.aim_interval; self.aim = aim_oldest(g) + (self.rnd() * 2 - 1) * self.aim_error
        return self.aim
class BlockOnly(Bot):
    def act(self, g):
        b = first_of(g.blocks, lambda b: True)
        return b.u if b else g.p["BLOCK_COLS"][1]
class Demo(Bot):
    interval = 0.3; aim_interval = 0.6; aim_error = 0.12; miss_rate = 0.3; miss_gap = 0.04
    def __init__(self, seed):
        super().__init__(seed); self.mode = "enemy"; self.quit = set()   # mode: "enemy" / ("x", 位置) / ("block", id)
        self.missing = False                                              # 今、敵のすぐ横を狙って空振りしているか
    def decide(self, g):
        p = g.p; f = g.fill / g.cap
        if not g.blocks: self.mode = ("x", p["BLOCK_COLS"][1]) if f < 0.20 else "enemy"; return        # 規則1
        if g.rank == 0 and not g.missed.get("rank"):
            for b in g.blocks:
                if b.kind == "rank": self.mode = ("block", b.id); return                                # 規則2
        # 同じ列の手前に別のブロックがあるものは選ばない (撃つと手前のほうに当たり、取るつもりのない強化を取ってしまう)
        front = lambda b: not any(o.col == b.col and o.pass_t < b.pass_t for o in g.blocks)
        junk = first_of(g.blocks, lambda b: b.kind in ("trap", "hat") and front(b))
        if junk: self.mode = ("block", junk.id); return                                                 # 規則3
        for b in g.blocks:
            if b.hp / b.maxhp < 0.12: self.quit.add(b.id)
        wanted = first_of(g.blocks, lambda b: b.kind != "bomb" and b.id not in self.quit and front(b))
        current = self.mode[1] if isinstance(self.mode, tuple) and self.mode[0] == "block" else 0
        if current in self.quit: self.mode = "enemy"; return                                            # 規則5
        if not wanted: self.mode = "enemy"; return                                                      # 規則4
        if f > 0.75: self.mode = ("x", p["ENEMY_MIN"] + (p["ENEMY_MAX"] - p["ENEMY_MIN"]) * self.rnd()); return   # 規則6
        self.mode = ("block", wanted.id) if f < 0.45 else "enemy"                                       # 規則7
    def act(self, g):
        if g.t >= self.next - 1e-9:
            self.next += self.interval; self.decide(g)
        if self.mode == "enemy":
            if g.t >= self.next_aim - 1e-9:
                self.next_aim = g.t + self.aim_interval; self.aim = aim_oldest(g) + (self.rnd() * 2 - 1) * self.aim_error
                # ときどき、いちばん古い敵のすぐ横を狙って空振りする
                self.missing = bool(g.enemies) and self.rnd() < self.miss_rate
                if self.missing:
                    e = g.enemies[0]; side = -1 if self.rnd() < 0.5 else 1
                    self.aim = e.u + side * (e.hw + g.p["BEAM_HALF"] + self.miss_gap)
            return self.aim
        self.missing = False
        if self.mode[0] == "x": return self.mode[1]
        b = find_block(g, self.mode[1])
        return b.u if b else g.x
class Timid(Bot):  lo = 0.10; hi = 0.35; interval = 0.8;  aim_interval = 0.30; aim_error = 0.10; avoid = 0.5; lapse = 0.15
class Casual(Bot): lo = 0.30; hi = 0.60; interval = 0.6;  aim_interval = 0.22; aim_error = 0.07; avoid = 0.8; lapse = 0.08
class Good(Bot):   lo = 0.50; hi = 0.75; interval = 0.35; aim_interval = 0.15; aim_error = 0.04; avoid = 1.0; lapse = 0.03; check = True; smart = True
class Expert(Bot): lo = 0.80; hi = 0.95; interval = 0.15; aim_interval = 0.08; aim_error = 0.015; avoid = 1.0; lapse = 0.0;  check = True; smart = True

BOTS = dict(demo=Demo, enemy_only=EnemyOnly, block_only=BlockOnly, timid=Timid, casual=Casual, good=Good, expert=Expert)
# spec 9.2 の合格範囲 (生存時間の中央値, 秒)
PASS = dict(demo=(50, 80), enemy_only=(100, 130), block_only=(30, 110), timid=(120, 170), casual=(205, 285), good=(295, 375), expert=(335, 420))
LONGEST = 600
DEMO_RANGE = (35, 100)

def run(bot_name, seed, p=P, tmax=1500.0):
    g = Game(seed, p); b = BOTS[bot_name](seed)
    while not g.dead and g.t < tmax: g.step(b.act(g))
    return dict(t=g.t, rank=g.rank, wave=wave_of(g.t, p), score=g.score, got=g.got, missed=g.missed)

def _job(a): return run(*a)
def batch(bot_name, n=100, p=P, pool=None):
    args = [(bot_name, s, p) for s in range(n)]
    return pool.map(_job, args) if pool else [run(*a) for a in args]

def stats(rs):
    ts = sorted(r["t"] for r in rs); n = len(ts)
    return dict(min=ts[0], p10=ts[n // 10], med=statistics.median(ts), p90=ts[n - n // 10 - 1], max=ts[-1],
                rank=statistics.mean(r["rank"] for r in rs), wave=statistics.median(r["wave"] for r in rs),
                score=statistics.median(r["score"] for r in rs))

def main_table(pool, n=100, seeds=False):
    out = {}; ok = True
    print(f"{'bot':11s} {'min':>5s} {'p10':>5s} {'med':>5s} {'p90':>5s} {'max':>5s} {'rank':>5s} {'wave':>4s} {'score':>8s}  判定")
    for name in BOTS:
        rs = batch(name, n, P, pool); s = stats(rs); out[name] = s; lo, hi = PASS[name]
        good = lo <= s["med"] <= hi; ok &= good
        print(f"{name:11s} {s['min']:5.0f} {s['p10']:5.0f} {s['med']:5.0f} {s['p90']:5.0f} {s['max']:5.0f} {s['rank']:5.1f} {s['wave']:4.0f} {s['score']:8.0f}  {'OK' if good else 'NG'} ({lo}-{hi})")
        if name == "demo":
            inr = sum(DEMO_RANGE[0] <= r["t"] <= DEMO_RANGE[1] for r in rs); demo_ok = inr >= 0.9 * n; ok &= demo_ok
            print(f"            demo が {DEMO_RANGE[0]}-{DEMO_RANGE[1]} 秒で終わった回数: {inr}/{n} {'OK' if demo_ok else 'NG'}")
        if seeds: print("            種 0〜9: " + ", ".join(f"{r['t']:.2f}" for r in rs[:10]))
    order = out["timid"]["med"] < out["casual"]["med"] < out["good"]["med"] <= out["expert"]["med"]
    longest = max(s["max"] for s in out.values())
    print(f"順序 timid<casual<good<=expert: {'OK' if order else 'NG'} / 最長 {longest:.0f} 秒 (<{LONGEST}): {'OK' if longest < LONGEST else 'NG'}")
    print("総合:", "合格" if ok and order and longest < LONGEST else "不合格")
    return out

def golden(pool):
    first5 = lambda seed: (lambda r: [r() for _ in range(5)])(mulberry32(seed))
    g = dict(
        note="単体テスト用の期待値。mulberry32 と rows は完全一致、formulas/boss/dps は相対誤差 1e-9 以内で一致すること。sim_reference は参考値(完全一致は求めない)。",
        mulberry32={"0": first5(0), "12345": first5(12345)},
        formulas=[dict(t=t, wave=wave_of(t, P), phi=phi(t, P), d_ref=d_ref(t, P), size_rate=size_rate(t, P), base_hp=base_hp(t, P))
                  for t in (0, 30, 60, 120, 180, 240, 300, 360, 420)],
        boss=[dict(wave=w, t=w * 20 - 5, hp=P["BOSS_COEF"] * phi(w * 20 - 5, P) * d_ref(w * 20 - 5, P)) for w in (5, 10, 15, 20)],
        dps=[dict(rank=r, dps=dps_of(r, P)) for r in (0, 1, 10, 30, 60)],
        rows={str(seed): (lambda d: [d.draw_row() for _ in range(31)])(Deck(seed, P)) for seed in (0, 1, 2, 42)},
        sim_reference={},
    )
    for name in BOTS:
        rs = batch(name, 100, P, pool); s_ = stats(rs)
        g["sim_reference"][name] = dict(median=round(s_["med"], 2), p10=round(s_["p10"], 2), p90=round(s_["p90"], 2), max=round(s_["max"], 2),
                                        pass_range=list(PASS[name]), first10_seeds=[round(r["t"], 2) for r in rs[:10]])
    return g

if __name__ == "__main__":
    with Pool() as pool:
        if "--golden" in sys.argv:
            # 書き出し先は引数で渡せる (既定は今いるディレクトリの golden.json)
            out = next((a for a in sys.argv[1:] if not a.startswith("--")), "golden.json")
            json.dump(golden(pool), open(out, "w"), ensure_ascii=False, indent=1); print(f"{out} を書き出しました")
        elif "--knobs" in sys.argv:
            import copy
            def variant(**kw):
                p = copy.deepcopy(P)
                for k, v in kw.items():
                    if k == "COST": p["COST"].update(v)
                    else: p[k] = v
                return p
            for label, kw in [("確定値", {}), ("KAPPA=0.0047", dict(KAPPA=0.0047)), ("KAPPA=0.0057", dict(KAPPA=0.0057)),
                              ("PHI0=0.27", dict(PHI0=0.27)), ("PHI0=0.33", dict(PHI0=0.33)),
                              ("rank=3.0", dict(COST=dict(rank=3.0))), ("rank=4.0", dict(COST=dict(rank=4.0))),
                              ("gold=4.0", dict(COST=dict(gold=4.0))), ("gold=7.0", dict(COST=dict(gold=7.0))),
                              ("CAP=80", dict(CAP=80.0)), ("CAP=120", dict(CAP=120.0)),
                              ("MOVE_SPEED=2.4", dict(MOVE_SPEED=2.4)), ("MOVE_SPEED=3.6", dict(MOVE_SPEED=3.6)),
                              ("BEAM_HALF=0.04", dict(BEAM_HALF=0.04)), ("BEAM_HALF=0.09", dict(BEAM_HALF=0.09)),
                              ("CRIT_MULT=1.5", dict(CRIT_MULT=1.5)), ("CRIT_MULT=2.5", dict(CRIT_MULT=2.5)),
                              ("CRIT_HALF=0.03", dict(CRIT_HALF=0.03)), ("CRIT_HALF=0.08", dict(CRIT_HALF=0.08))]:
                p = variant(**kw)
                print(f"{label:16s} " + "  ".join(f"{b}={stats(batch(b, 100, p, pool))['med']:.0f}" for b in ("timid", "casual", "good", "expert")), flush=True)
        else:
            main_table(pool, seeds="--seeds" in sys.argv)
