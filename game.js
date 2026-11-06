// 逆ババ抜きのゲームエンジン（通信に依存しない純粋なロジック）
// ルール: 最後までジョーカーを持っていた人が勝ち。先に手札がなくなった人ほど順位が下。
'use strict';
const crypto = require('crypto');

const SUITS = ['s', 'h', 'd', 'c'];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDeck() {
  const cards = [];
  let id = 0;
  for (const s of SUITS) for (let r = 1; r <= 13; r++) cards.push({ id: id++, r, s });
  cards.push({ id: id++, r: 0, s: 'j' }); // ジョーカー
  return cards;
}

// 同じ数字のペアを取り除く（ジョーカーは対象外）
function removePairs(hand) {
  const byRank = new Map();
  for (const c of hand) {
    if (c.r === 0) continue;
    if (!byRank.has(c.r)) byRank.set(c.r, []);
    byRank.get(c.r).push(c);
  }
  const drop = new Set();
  const pairs = [];
  for (const list of byRank.values()) {
    for (let i = 0; i + 1 < list.length; i += 2) {
      drop.add(list[i].id); drop.add(list[i + 1].id);
      pairs.push([list[i], list[i + 1]]);
    }
  }
  return { hand: hand.filter((c) => !drop.has(c.id)), pairs };
}

class Game {
  // seats: [{ pid, name, npc: bool, owner: clientId|null }]
  constructor(seats) {
    this.seats = seats.map((s) => ({ ...s, hand: [], outOrder: 0 }));
    this.outCount = 0;
    this.discardCount = 0;
    this.turn = -1;
    this.turnId = 0;
    this.phase = 'turn';
    this.winner = null;
    this.ranking = null;
    this.startPairs = 0;
    this.deal();
  }

  deal() {
    const deck = shuffle(makeDeck());
    const n = this.seats.length;
    const start = crypto.randomInt(n);
    deck.forEach((c, i) => this.seats[(start + i) % n].hand.push(c));
    for (const seat of this.seats) {
      const res = removePairs(seat.hand);
      seat.hand = shuffle(res.hand);
      this.startPairs += res.pairs.length;
      this.discardCount += res.pairs.length * 2;
    }
    const initialOuts = [];
    for (const seat of this.seats) {
      if (seat.hand.length === 0) { seat.outOrder = ++this.outCount; initialOuts.push(seat.pid); }
    }
    this.initialOuts = initialOuts;
    if (this.activeCount() <= 1) { this.finish(); return; }
    // 開始プレイヤーはランダム（手札のある人から）
    const actives = this.seats.map((s, i) => i).filter((i) => this.seats[i].hand.length > 0);
    this.turn = actives[crypto.randomInt(actives.length)];
    this.turnId++;
  }

  activeCount() { return this.seats.filter((s) => s.hand.length > 0).length; }

  nextActive(from) {
    const n = this.seats.length;
    for (let k = 1; k <= n; k++) {
      const j = (from + k) % n;
      if (this.seats[j].hand.length > 0) return j;
    }
    return -1;
  }

  drawer() { return this.phase === 'turn' ? this.seats[this.turn] : null; }
  targetIndex() { return this.phase === 'turn' ? this.nextActive(this.turn) : -1; }
  target() { const t = this.targetIndex(); return t >= 0 ? this.seats[t] : null; }
  seatIndexOf(pid) { return this.seats.findIndex((s) => s.pid === pid); }

  // 手番のプレイヤーが、次の人の手札の index 番目を引く
  draw(index) {
    if (this.phase !== 'turn') return null;
    const di = this.turn;
    const ti = this.nextActive(di);
    if (ti < 0 || ti === di) return null;
    const drawer = this.seats[di];
    const target = this.seats[ti];
    if (!Number.isInteger(index) || index < 0 || index >= target.hand.length) index = crypto.randomInt(target.hand.length);
    const card = target.hand.splice(index, 1)[0];
    let pair = null;
    if (card.r !== 0) {
      const mi = drawer.hand.findIndex((c) => c.r === card.r);
      if (mi >= 0) {
        const mate = drawer.hand.splice(mi, 1)[0];
        pair = [mate, card];
        this.discardCount += 2;
      }
    }
    if (!pair) {
      // 引いたカードはランダムな位置に入れる（位置から推測されないように）
      const pos = crypto.randomInt(drawer.hand.length + 1);
      drawer.hand.splice(pos, 0, card);
    }
    const outs = [];
    for (const s of [target, drawer]) {
      if (s.hand.length === 0 && !s.outOrder) { s.outOrder = ++this.outCount; outs.push(s.pid); }
    }
    const ev = { from: target.pid, to: drawer.pid, index, card, pair, outs, joker: card.r === 0 };
    if (this.activeCount() <= 1) {
      this.finish();
      ev.ended = true;
    } else {
      this.turn = this.nextActive(di);
      this.turnId++;
    }
    return ev;
  }

  shuffleHand(pid) {
    const s = this.seats.find((x) => x.pid === pid);
    if (!s || s.hand.length < 2) return false;
    shuffle(s.hand);
    return true;
  }

  finish() {
    this.phase = 'end';
    this.turn = -1;
    this.turnId++;
    const holder = this.seats.find((s) => s.hand.length > 0) || null;
    this.winner = holder ? holder.pid : null;
    // 1位: ジョーカー保持者。以降は上がるのが遅かった順。
    const rest = this.seats.filter((s) => s !== holder).sort((a, b) => b.outOrder - a.outOrder);
    this.ranking = (holder ? [holder] : []).concat(rest).map((s, i) => ({ pid: s.pid, name: s.name, rank: i + 1 }));
  }
}

module.exports = { Game, makeDeck, removePairs, shuffle };
