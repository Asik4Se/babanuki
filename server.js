// 逆ババ抜き オンライン対戦サーバー（依存パッケージなし）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { handleUpgrade } = require('./ws');
const { Game, deckCountFor } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 18;         // プレイヤー（人＋NPC）の上限
const MAX_MEMBERS = 60;         // 観戦者を含めた部屋の上限
const LOBBY_GRACE = 60 * 1000;  // ロビーで切断した人を残しておく時間
const HOST_GRACE = 10 * 1000;   // ホストが切断してから交代するまで
const EMPTY_ROOM_TTL = 10 * 60 * 1000;
const TURN_TIMES = [10, 15, 20, 30, 60];
const EMOTES = ['😏', '😱', '🤔', '😇', '🃏', '👀', '🙏', '😂'];
const NPC_NAMES = ['ポチ', 'タマ', 'ゴン', 'ミケ', 'ハチ', 'クロ', 'シロ', 'チビ', 'モモ', 'ソラ',
  'リン', 'コタ', 'マロ', 'キナコ', 'アズキ', 'ダイズ', 'ゴマ', 'ユズ', 'ムギ', 'ラテ'];
const RANK_LABEL = ['JOKER', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const rooms = new Map();
const conns = new Set();

// ---------- 部屋の管理 ----------

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[crypto.randomInt(chars.length)];
    if (!rooms.has(c)) return c;
  }
}

function newRoom() {
  const room = {
    code: newCode(), hostId: null, members: new Map(), npcs: [],
    settings: { turnTime: 20, reveal: true, seatMode: 'random' },
    state: 'lobby', game: null, log: [], timers: [], hover: null,
    deadline: 0, pidSeq: 0, emptySince: 0,
  };
  rooms.set(room.code, room);
  return room;
}

function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  return s || 'ゲスト' + (100 + crypto.randomInt(900));
}

function playerCount(room) {
  let n = room.npcs.length;
  for (const m of room.members.values()) if (m.role === 'player') n++;
  return n;
}

// 席の希望を整理（観戦者・人数を超えた席・重複は外す）
function normalizeSeats(room) {
  const total = playerCount(room);
  const used = new Set();
  for (const m of room.members.values()) {
    if (m.role !== 'player' || !m.seat || m.seat > total || used.has(m.seat)) m.seat = null;
    if (m.seat) used.add(m.seat);
  }
}

function connectedMembers(room) { return [...room.members.values()].filter((m) => m.connected); }

function addLog(room, text) {
  room.log.push(text);
  if (room.log.length > 60) room.log.splice(0, room.log.length - 60);
}

function nextNpcName(room) {
  const used = new Set(room.npcs.map((n) => n.name));
  for (const m of room.members.values()) used.add(m.name);
  const free = NPC_NAMES.filter((n) => !used.has(n));
  const base = free.length ? free[crypto.randomInt(free.length)] : 'ボット' + (room.pidSeq + 1);
  return base;
}

function addNpc(room) {
  room.npcs.push({ pid: 'n' + (++room.pidSeq), name: nextNpcName(room) });
}

function memberOf(conn) {
  if (!conn.roomCode) return null;
  const room = rooms.get(conn.roomCode);
  if (!room) return null;
  const m = room.members.get(conn.clientId);
  if (!m || m.conn !== conn) return null;
  return { room, m };
}

function removeMember(room, clientId) {
  const m = room.members.get(clientId);
  if (!m) return;
  room.members.delete(clientId);
  if (m.conn) m.conn.roomCode = null;
  addLog(room, `${m.name} が退出しました`);
  if (room.hostId === clientId) pickHost(room);
  if (room.members.size === 0) deleteRoom(room);
}

function pickHost(room) {
  const cand = connectedMembers(room).filter((m) => m.clientId !== room.hostId);
  const next = cand.find((m) => m.role === 'player') || cand[0] || null;
  if (next) {
    room.hostId = next.clientId;
    addLog(room, `${next.name} がホストになりました`);
  } else if (!room.members.has(room.hostId)) {
    const any = [...room.members.values()][0];
    room.hostId = any ? any.clientId : null;
  }
}

function deleteRoom(room) {
  clearTimers(room);
  for (const m of room.members.values()) if (m.conn) m.conn.roomCode = null;
  rooms.delete(room.code);
}

// ---------- 送信 ----------

function send(conn, obj) { if (conn && conn.open) conn.send(JSON.stringify(obj)); }

function isConnectedOwner(room, seat) {
  if (!seat || !seat.owner) return false;
  const m = room.members.get(seat.owner);
  return !!(m && m.connected);
}

function viewFor(room, me) {
  const host = room.members.get(room.hostId);
  const v = {
    t: 'state', code: room.code, you: me.pid, youRole: me.role,
    host: host ? host.pid : null, isHost: room.hostId === me.clientId,
    state: room.state, settings: room.settings, maxPlayers: MAX_PLAYERS,
    members: [...room.members.values()].map((m) => ({
      pid: m.pid, name: m.name, role: m.role, connected: m.connected, host: m.clientId === room.hostId, seat: m.seat || null,
    })),
    decks: deckCountFor(Math.max(2, playerCount(room))),
    npcs: room.npcs.map((n) => ({ pid: n.pid, name: n.name })),
    log: room.log.slice(-40),
    turnTimes: TURN_TIMES, emotes: EMOTES,
  };
  const g = room.game;
  if (g) {
    const mySeat = g.seats.find((s) => s.owner === me.clientId) || null;
    const seeAll = g.phase === 'end' || (!mySeat && room.settings.reveal);
    const drawer = g.drawer();
    const target = g.target();
    v.game = {
      phase: g.phase, turnId: g.turnId,
      turn: drawer ? drawer.pid : null, target: target ? target.pid : null,
      mySeat: mySeat ? mySeat.pid : null, seeAll,
      hover: room.hover && room.hover.turnId === g.turnId ? room.hover.i : null,
      deadlineIn: room.deadline ? Math.max(0, room.deadline - Date.now()) : 0,
      turnTime: room.settings.turnTime,
      discard: g.discardCount, winner: g.winner, ranking: g.ranking,
      seats: g.seats.map((s) => ({
        pid: s.pid, name: s.name, npc: s.npc,
        sub: !!s.owner && !isConnectedOwner(room, s),
        count: s.hand.length, out: s.outOrder > 0,
        hand: (seeAll || s === mySeat) ? s.hand : undefined,
      })),
    };
  }
  return v;
}

function broadcastState(room) {
  if (room.state === 'lobby') normalizeSeats(room);
  for (const m of room.members.values()) if (m.connected) send(m.conn, viewFor(room, m));
}

function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (const m of room.members.values()) if (m.connected && m.conn && m.conn.open) m.conn.send(s);
}

// ---------- ゲーム進行 ----------

function clearTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers = [];
}

function later(room, ms, fn) { room.timers.push(setTimeout(fn, ms)); }

function rnd(a, b) { return a + crypto.randomInt(b - a + 1); }

function startGame(room) {
  normalizeSeats(room);
  const pool = [];
  const fixed = [];
  for (const m of room.members.values()) {
    if (m.role !== 'player') continue;
    const s = { pid: m.pid, name: m.name, npc: false, owner: m.clientId };
    if (room.settings.seatMode === 'choose' && m.seat) fixed.push([m.seat, s]); else pool.push(s);
  }
  while (pool.length + fixed.length + room.npcs.length < 2) addNpc(room);
  for (const n of room.npcs) pool.push({ pid: n.pid, name: n.name, npc: true, owner: null });
  // 選んだ人は希望の席へ、残り（NPC・未選択の人）は空いた席にランダムで
  for (let i = pool.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const total = pool.length + fixed.length;
  const seats = new Array(total).fill(null);
  for (const [n, s] of fixed) seats[n - 1] = s;
  for (let i = 0; i < total; i++) if (!seats[i]) seats[i] = pool.shift();
  room.game = new Game(seats);
  room.state = 'playing';
  room.hover = null;
  room.log = [];
  addLog(room, `試合開始！ ${seats.length}人で対戦（トランプ${room.game.decks}組＋ジョーカー＝${room.game.totalCards}枚／${room.settings.seatMode === 'choose' ? '席は各自選択' : '席はランダム'}）`);
  addLog(room, `最初にペア${room.game.startPairs}組を捨てました`);
  for (const pid of room.game.initialOuts) {
    addLog(room, `${room.game.seats.find((s) => s.pid === pid).name} は配った時点で手札がなくなり脱落`);
  }
  broadcast(room, { t: 'fx', k: 'start' });
  if (room.game.phase === 'end') endGame(room);
  else { scheduleTurn(room); broadcastState(room); }
}

function scheduleTurn(room) {
  clearTimers(room);
  const g = room.game;
  if (!g || g.phase !== 'turn') { room.deadline = 0; return; }
  const seat = g.drawer();
  const target = g.target();
  const turnId = g.turnId;
  const alive = () => room.game === g && g.turnId === turnId && rooms.has(room.code);

  // 引かれる側がNPC（または代打）ならたまに手札を混ぜる
  if (target && !isConnectedOwner(room, target) && target.hand.length > 1 && crypto.randomInt(100) < 30) {
    later(room, rnd(150, 400), () => {
      if (!alive()) return;
      g.shuffleHand(target.pid);
      room.hover = null;
      broadcast(room, { t: 'fx', k: 'shuffle', pid: target.pid });
    });
  }

  if (isConnectedOwner(room, seat)) {
    const ms = room.settings.turnTime * 1000;
    room.deadline = Date.now() + ms;
    later(room, ms + 250, () => {
      if (!alive()) return;
      addLog(room, `${seat.name} は時間切れ（自動で1枚引きました）`);
      doDraw(room, -1);
    });
  } else {
    room.deadline = 0;
    // NPC（代打を含む）の手番：人の手札を狙うときはじっくり迷い、NPC同士はテンポよく
    const humanTarget = isConnectedOwner(room, target);
    const npcCount = g.seats.filter((s) => !isConnectedOwner(room, s)).length;
    const fast = !humanTarget && npcCount >= 6;
    let t = humanTarget ? rnd(500, 800) : fast ? rnd(220, 380) : rnd(350, 600);
    const looks = humanTarget ? rnd(2, 4) : 1;
    for (let k = 0; k < looks; k++) {
      later(room, t, () => {
        if (!alive() || !g.target()) return;
        const i = crypto.randomInt(g.target().hand.length);
        room.hover = { i, turnId };
        broadcast(room, { t: 'hover', turnId, i });
      });
      t += humanTarget ? rnd(300, 550) : fast ? rnd(200, 320) : rnd(260, 420);
    }
    if (crypto.randomInt(100) < 12) {
      later(room, t - 150, () => {
        if (!alive()) return;
        broadcast(room, { t: 'emote', pid: seat.pid, e: EMOTES[crypto.randomInt(EMOTES.length)] });
      });
    }
    later(room, t + 200, () => {
      if (!alive()) return;
      const h = room.hover && room.hover.turnId === turnId ? room.hover.i : -1;
      doDraw(room, h);
    });
  }
}

function cardLabel(c) {
  if (c.r === 0) return 'JOKER';
  return ({ s: '♠', h: '♥', d: '♦', c: '♣' })[c.s] + RANK_LABEL[c.r];
}

function doDraw(room, index) {
  const g = room.game;
  if (!g || g.phase !== 'turn') return;
  const ev = g.draw(index);
  if (!ev) return;
  room.hover = null;
  const nameOf = (pid) => g.seats.find((s) => s.pid === pid).name;
  addLog(room, `${nameOf(ev.to)} が ${nameOf(ev.from)} から1枚引いた`);
  if (ev.pair) addLog(room, `${nameOf(ev.to)} が ${RANK_LABEL[ev.pair[0].r]} のペアを捨てた`);
  for (const pid of ev.outs) addLog(room, `${nameOf(pid)} の手札がなくなった（脱落）`);

  const fromSeat = g.seats.find((s) => s.pid === ev.from);
  const toSeat = g.seats.find((s) => s.pid === ev.to);
  for (const m of room.members.values()) {
    if (!m.connected) continue;
    const involved = fromSeat.owner === m.clientId || toSeat.owner === m.clientId;
    const isSpectator = !g.seats.some((s) => s.owner === m.clientId);
    const fx = { t: 'fx', k: 'draw', from: ev.from, to: ev.to, index: ev.index, pair: ev.pair, outs: ev.outs };
    if (involved || (isSpectator && room.settings.reveal)) { fx.card = ev.card; fx.joker = ev.joker; }
    send(m.conn, fx);
  }
  if (ev.ended) endGame(room);
  else { scheduleTurn(room); broadcastState(room); }
}

function endGame(room) {
  clearTimers(room);
  room.deadline = 0;
  room.state = 'result';
  const g = room.game;
  const w = g.seats.find((s) => s.pid === g.winner);
  if (w) addLog(room, `🃏 ${w.name} が最後までジョーカーを守りきって優勝！`);
  broadcast(room, { t: 'fx', k: 'end', winner: g.winner });
  broadcastState(room);
}

function backToLobby(room) {
  clearTimers(room);
  room.state = 'lobby';
  room.game = null;
  room.hover = null;
  room.deadline = 0;
  for (const m of [...room.members.values()]) if (!m.connected) room.members.delete(m.clientId);
  if (!room.members.has(room.hostId)) pickHost(room);
  room.log = [];
  addLog(room, 'ロビーに戻りました');
  broadcastState(room);
}

// ---------- 接続とメッセージ ----------

function bind(room, m, conn) {
  if (m.conn && m.conn !== conn) {
    send(m.conn, { t: 'kicked', msg: '別のタブ・端末からこの部屋に接続しました' });
    const old = m.conn;
    old.roomCode = null;
    setTimeout(() => old.close(), 50);
  }
  m.conn = conn;
  m.connected = true;
  m.discAt = 0;
  conn.roomCode = room.code;
}

function leaveCurrent(conn) {
  const cur = memberOf(conn);
  if (!cur) { conn.roomCode = null; return; }
  const { room, m } = cur;
  if (room.state === 'playing') {
    dropMember(room, m);
  } else {
    removeMember(room, m.clientId);
    if (rooms.has(room.code)) broadcastState(room);
  }
  conn.roomCode = null;
}

function dropMember(room, m) {
  m.connected = false;
  m.discAt = Date.now();
  if (m.conn) m.conn.roomCode = null;
  m.conn = null;
  if (room.state === 'playing' && room.game) {
    const seat = room.game.seats.find((s) => s.owner === m.clientId);
    if (seat && seat.hand.length > 0) addLog(room, `${m.name} が切断 → NPCが代打します`);
    if (seat && room.game.drawer() === seat) scheduleTurn(room);
  }
  broadcastState(room);
}

function err(conn, msg, code) { send(conn, { t: 'error', msg, code: code || '' }); }

function joinRoom(conn, room, name, rejoinOnly) {
  const existing = room.members.get(conn.clientId);
  if (existing) {
    const wasPlaying = room.state === 'playing' && !existing.connected;
    if (conn.roomCode && conn.roomCode !== room.code) leaveCurrent(conn);
    bind(room, existing, conn);
    if (wasPlaying) {
      const seat = room.game.seats.find((s) => s.owner === conn.clientId);
      if (seat && seat.hand.length > 0) addLog(room, `${existing.name} が復帰しました`);
      if (seat && room.game.drawer() === seat) scheduleTurn(room);
    }
    broadcastState(room);
    return;
  }
  if (rejoinOnly && room.state === 'playing') return err(conn, 'この部屋は試合中のため参加できません', 'playing');
  if (room.state === 'playing') return err(conn, '試合中のため新しく参加できません。試合が終わってから入ってください', 'playing');
  if (room.members.size >= MAX_MEMBERS) return err(conn, '部屋が満員です', 'full');
  if (conn.roomCode) leaveCurrent(conn);
  const m = {
    clientId: conn.clientId, pid: 'm' + (++room.pidSeq), name: cleanName(name),
    role: playerCount(room) < MAX_PLAYERS ? 'player' : 'spectator',
    conn: null, connected: false, discAt: 0, seat: null, lastEmote: 0, lastShuffle: 0, lastHover: 0,
  };
  room.members.set(conn.clientId, m);
  if (!room.hostId || !room.members.has(room.hostId)) room.hostId = conn.clientId;
  bind(room, m, conn);
  addLog(room, `${m.name} が入室しました${m.role === 'spectator' ? '（観戦）' : ''}`);
  broadcastState(room);
}

function onMessage(conn, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'hello') {
    const id = String(msg.clientId || '');
    if (/^[A-Za-z0-9_-]{16,64}$/.test(id)) conn.clientId = id;
    send(conn, { t: 'hello' });
    return;
  }
  if (!conn.clientId) return;

  if (msg.t === 'create') {
    if (conn.roomCode) leaveCurrent(conn);
    const room = newRoom();
    joinRoom(conn, room, msg.name);
    return;
  }
  if (msg.t === 'join') {
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = rooms.get(code);
    if (!room) return err(conn, `部屋「${code}」が見つかりません`, 'notfound');
    joinRoom(conn, room, msg.name, !!msg.rejoin);
    return;
  }

  const cur = memberOf(conn);
  if (!cur) return;
  const { room, m } = cur;
  const isHost = room.hostId === m.clientId;
  const g = room.game;

  switch (msg.t) {
    case 'leave':
      leaveCurrent(conn);
      send(conn, { t: 'left' });
      break;

    case 'role': {
      if (room.state !== 'lobby') return;
      const role = msg.role === 'spectator' ? 'spectator' : 'player';
      if (role === m.role) return;
      if (role === 'player' && playerCount(room) >= MAX_PLAYERS) return err(conn, `プレイヤーは最大${MAX_PLAYERS}人です`);
      m.role = role;
      addLog(room, `${m.name} が${role === 'player' ? 'プレイヤー' : '観戦'}に切り替えました`);
      broadcastState(room);
      break;
    }

    case 'seat': {
      if (room.state !== 'lobby' || room.settings.seatMode !== 'choose' || m.role !== 'player') return;
      if (msg.n == null) { m.seat = null; broadcastState(room); return; }
      const n = parseInt(msg.n, 10);
      if (!(n >= 1 && n <= playerCount(room))) return;
      const taken = [...room.members.values()].find((x) => x !== m && x.seat === n);
      if (taken) return err(conn, `${n}番の席は ${taken.name} が選んでいます`);
      m.seat = n;
      broadcastState(room);
      break;
    }

    case 'rename': {
      if (room.state !== 'lobby') return;
      m.name = cleanName(msg.name);
      broadcastState(room);
      break;
    }

    case 'addNpc': {
      if (!isHost || room.state !== 'lobby') return;
      const n = Math.max(1, Math.min(17, parseInt(msg.n, 10) || 1));
      let added = 0;
      for (let i = 0; i < n && playerCount(room) < MAX_PLAYERS; i++) { addNpc(room); added++; }
      if (!added) return err(conn, `プレイヤーは最大${MAX_PLAYERS}人です`);
      broadcastState(room);
      break;
    }

    case 'removeNpc': {
      if (!isHost || room.state !== 'lobby') return;
      if (msg.all) room.npcs = [];
      else {
        const i = msg.pid ? room.npcs.findIndex((n) => n.pid === msg.pid) : room.npcs.length - 1;
        if (i >= 0) room.npcs.splice(i, 1);
      }
      broadcastState(room);
      break;
    }

    case 'settings': {
      if (!isHost || room.state !== 'lobby') return;
      const tt = parseInt(msg.turnTime, 10);
      if (TURN_TIMES.includes(tt)) room.settings.turnTime = tt;
      if (typeof msg.reveal === 'boolean') room.settings.reveal = msg.reveal;
      if (msg.seatMode === 'random' || msg.seatMode === 'choose') room.settings.seatMode = msg.seatMode;
      broadcastState(room);
      break;
    }

    case 'start':
      if (!isHost || room.state !== 'lobby') return;
      startGame(room);
      break;

    case 'hover': {
      if (!g || g.phase !== 'turn') return;
      const d = g.drawer();
      if (!d || d.owner !== m.clientId) return;
      const now = Date.now();
      if (now - m.lastHover < 50) return;
      m.lastHover = now;
      const t = g.target();
      const i = parseInt(msg.i, 10);
      if (!t || !(i >= 0 && i < t.hand.length)) return;
      room.hover = { i, turnId: g.turnId };
      broadcast(room, { t: 'hover', turnId: g.turnId, i });
      break;
    }

    case 'draw': {
      if (!g || g.phase !== 'turn') return;
      const d = g.drawer();
      if (!d || d.owner !== m.clientId) return;
      if (msg.turnId !== g.turnId) return;
      const t = g.target();
      const i = parseInt(msg.i, 10);
      if (!t || !(i >= 0 && i < t.hand.length)) return;
      doDraw(room, i);
      break;
    }

    case 'shuffle': {
      if (!g || g.phase !== 'turn') return;
      const seat = g.seats.find((s) => s.owner === m.clientId);
      if (!seat) return;
      const now = Date.now();
      if (now - m.lastShuffle < 700) return;
      m.lastShuffle = now;
      if (!g.shuffleHand(seat.pid)) return;
      if (g.target() === seat) room.hover = null;
      broadcast(room, { t: 'fx', k: 'shuffle', pid: seat.pid });
      broadcastState(room);
      break;
    }

    case 'emote': {
      if (!EMOTES.includes(msg.e)) return;
      const now = Date.now();
      if (now - m.lastEmote < 800) return;
      m.lastEmote = now;
      broadcast(room, { t: 'emote', pid: m.pid, e: msg.e });
      break;
    }

    case 'lobby':
      if (!isHost || room.state !== 'result') return;
      backToLobby(room);
      break;
  }
}

function onClose(conn) {
  conns.delete(conn);
  const cur = memberOf(conn);
  if (!cur) return;
  dropMember(cur.room, cur.m);
}

// ---------- 定期処理 ----------

setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.state !== 'playing') {
      for (const m of [...room.members.values()]) {
        if (!m.connected && now - m.discAt > LOBBY_GRACE) removeMember(room, m.clientId);
      }
      if (!rooms.has(room.code)) continue;
    }
    const host = room.members.get(room.hostId);
    if (!host || (!host.connected && now - host.discAt > HOST_GRACE)) {
      const before = room.hostId;
      pickHost(room);
      if (room.hostId !== before) broadcastState(room);
    }
    if (connectedMembers(room).length === 0) {
      if (!room.emptySince) room.emptySince = now;
      else if (now - room.emptySince > EMPTY_ROOM_TTL) deleteRoom(room);
    } else room.emptySince = 0;
  }
}, 2000);

setInterval(() => {
  const now = Date.now();
  for (const c of conns) {
    if (now - c.lastSeen > 50000) c.destroy();
    else c.ping();
  }
}, 20000);

// ---------- HTTP ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') { socket.destroy(); return; }
  handleUpgrade(req, socket, head, (conn) => {
    conns.add(conn);
    conn.clientId = null;
    conn.roomCode = null;
    conn.on('message', (raw) => { try { onMessage(conn, raw); } catch (e) { console.error(e); } });
    conn.on('close', () => { try { onClose(conn); } catch (e) { console.error(e); } });
  });
});

server.listen(PORT, () => console.log(`babanuki server listening on :${PORT}`));
