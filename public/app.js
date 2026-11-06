'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const RK = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SU = { s: '♠', h: '♥', d: '♦', c: '♣' };

  function rid() {
    const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
    const a = new Uint8Array(24);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => abc[b & 63]).join('');
  }
  let clientId = store.get('bb_cid');
  if (!clientId || !/^[A-Za-z0-9_-]{16,64}$/.test(clientId)) { clientId = rid(); store.set('bb_cid', clientId); }

  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (urlRoom && store.get('bb_room') !== urlRoom) store.del('bb_room');

  let ws = null, wsOpen = false, retry = 0, kicked = false, queue = [];
  let S = null;
  let pendingRejoin = false;
  let sel = null;
  let drawingTurn = -1;
  let timerInt = null;
  let resultHidden = false;
  let lastHoverSent = -1, lastHoverAt = 0;
  let logOpen = false;

  // ---------- 通信 ----------
  let reconnectTimer = 0;
  function connect() {
    clearTimeout(reconnectTimer);
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      wsOpen = true; retry = 0;
      $('#conn').classList.add('hidden');
      raw({ t: 'hello', clientId });
      const last = store.get('bb_room');
      if (last) { pendingRejoin = true; raw({ t: 'join', code: last, name: myName(), rejoin: true }); }
      const q = queue; queue = []; q.forEach(raw);
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (er) { return; } handle(m); };
    ws.onclose = () => {
      wsOpen = false;
      if (kicked) return;
      if (retry > 0 || S) $('#conn').classList.remove('hidden');
      reconnectTimer = setTimeout(connect, Math.min(5000, 400 + retry++ * 700));
    };
  }
  function raw(o) { if (wsOpen) ws.send(JSON.stringify(o)); }
  function send(o) { if (wsOpen) ws.send(JSON.stringify(o)); else queue.push(o); }
  function myName() { return store.get('bb_name') || ''; }
  function setUrlRoom(code) {
    const u = code ? `${location.pathname}?room=${code}` : location.pathname;
    if (location.pathname + location.search !== u) history.replaceState(null, '', u);
  }

  function handle(m) {
    switch (m.t) {
      case 'state': {
        pendingRejoin = false;
        const prev = S;
        S = m;
        store.set('bb_room', m.code);
        setUrlRoom(m.code);
        if (!prev || prev.state !== m.state) { if (m.state !== 'result') resultHidden = false; }
        render();
        break;
      }
      case 'error':
        toast(m.msg, 'bad');
        if (pendingRejoin || !S) {
          if (m.code === 'notfound' || m.code === 'playing') { store.del('bb_room'); }
          pendingRejoin = false;
          if (!S) render();
        }
        break;
      case 'left':
        S = null; store.del('bb_room'); setUrlRoom(null); render();
        break;
      case 'kicked':
        kicked = true; S = null;
        showScreen('lobby');
        $('#lobby').innerHTML = `<div class="kickbox"><h2>${esc(m.msg)}</h2><p class="note">この画面は使われなくなりました。</p><button class="btn gold" onclick="location.reload()">この画面で開き直す</button></div>`;
        break;
      case 'hover':
        if (S && S.game && m.turnId === S.game.turnId) { S.game.hover = m.i; applyHover(); }
        break;
      case 'emote': showEmote(m.pid, m.e); break;
      case 'fx': fx(m); break;
    }
  }

  // ---------- 画面切り替え ----------
  function showScreen(name) {
    for (const id of ['top', 'lobby', 'game']) $('#' + id).classList.toggle('hidden', id !== name);
  }

  function render() {
    if (!S) { renderTop(); return; }
    if (S.state === 'lobby') { closeLog(); renderLobby(); }
    else renderGame();
  }

  function renderTop() {
    showScreen('top');
    clearInterval(timerInt);
    $('#nameInput').value = myName();
    if (urlRoom && !$('#codeInput').value) $('#codeInput').value = urlRoom;
    const inv = $('#invited');
    if (urlRoom) { inv.classList.remove('hidden'); inv.innerHTML = `部屋 <b>${esc(urlRoom)}</b> に招待されています。なまえを入れて「参加する」を押してね。`; }
    else inv.classList.add('hidden');
  }

  $('#createBtn').onclick = () => {
    const n = $('#nameInput').value.trim();
    if (!n) { $('#nameInput').focus(); toast('なまえを入れてください', 'bad'); return; }
    store.set('bb_name', n);
    send({ t: 'create', name: n });
  };
  $('#joinBtn').onclick = () => {
    const n = $('#nameInput').value.trim();
    const code = $('#codeInput').value.trim().toUpperCase();
    if (!n) { $('#nameInput').focus(); toast('なまえを入れてください', 'bad'); return; }
    if (code.length !== 4) { $('#codeInput').focus(); toast('4文字の部屋コードを入れてください', 'bad'); return; }
    store.set('bb_name', n);
    send({ t: 'join', code, name: n });
  };
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('#codeInput').value ? $('#joinBtn') : $('#createBtn')).click(); });

  // ---------- ロビー ----------
  function memberRow(m) {
    return `<li class="${m.connected ? '' : 'off'}"><span class="nm">${esc(m.name)}</span>` +
      (m.host ? '<span class="tag host">ホスト</span>' : '') +
      (m.pid === S.you ? '<span class="tag me">あなた</span>' : '') +
      (m.connected ? '' : '<span class="tag off">切断中</span>') + '</li>';
  }

  function renderLobby() {
    showScreen('lobby');
    clearInterval(timerInt);
    const me = S.members.find((x) => x.pid === S.you) || {};
    const players = S.members.filter((x) => x.role === 'player');
    const specs = S.members.filter((x) => x.role === 'spectator');
    const total = players.length + S.npcs.length;
    const max = S.maxPlayers;
    const H = S.isHost;
    const full = total >= max;
    let startNote = '';
    const chooseMode = S.settings.seatMode === 'choose';
    const seatN = Math.max(2, total);
    let seatBox = '';
    if (chooseMode) {
      const bySeat = {};
      for (const x of players) if (x.seat) bySeat[x.seat] = x;
      const mineSeat = me.seat;
      const rows = [];
      for (let n = 1; n <= seatN; n++) {
        const x = bySeat[n];
        const isMe = x && x.pid === S.you;
        rows.push(`<li class="seatrow ${isMe ? 'mine' : ''} ${x ? '' : 'free'}"><span class="sno">${n}</span>` +
          (x ? `<span class="nm">${esc(x.name)}</span>${isMe ? '<button class="btn tiny ghost" data-act="unseat">外す</button>' : ''}`
             : `<span class="nm">空き</span>${me.role === 'player' && n <= total ? `<button class="btn tiny" data-act="seat" data-n="${n}">${mineSeat ? 'ここに移る' : 'ここに座る'}</button>` : ''}`) +
          '</li>');
      }
      seatBox = `<div class="box" style="margin-top:14px">
        <h2>席順 <span class="count">${seatN}席</span></h2>
        <p class="seatnote">番号順に回り、手番の人は<b>次の番号の人</b>から引きます（最後の席は1番から）。空いた席にはNPCと未選択の人がランダムに入ります。</p>
        <ul class="mlist">${rows.join('')}</ul>
      </div>`;
    }
    if (total === 0) startNote = '全員観戦なので、NPC 2人の対戦になります';
    else if (total === 1) startNote = 'ひとりなので、NPCを1人入れて開始します';

    $('#lobby').innerHTML = `
      <div class="lhead"><h1>逆ババ抜き</h1><button class="btn tiny ghost" data-act="rename">名前変更</button><button class="btn tiny ghost" data-act="leave">退出</button></div>
      <div class="invite">
        <div><div class="lbl">部屋コード</div><div class="code">${esc(S.code)}</div></div>
        <div class="grow lbl">このコードか招待リンクを送ってね。試合が始まると新しい人は入れません。</div>
        <button class="btn" data-act="copy">招待リンクをコピー</button>
      </div>
      <div class="lgrid">
        <div>
        <div class="box">
          <h2>プレイヤー <span class="count">${total} / ${max}</span></h2>
          <div class="deckinfo">トランプ <b>${S.decks}組</b>（${S.decks * 52}枚）＋ジョーカー1枚 <span>2〜4人=1組・5〜8人=2組・9〜12人=3組…</span></div>
          <ul class="mlist">
            ${players.map(memberRow).join('')}
            ${S.npcs.map((n) => `<li class="npc"><span class="nm">🤖 ${esc(n.name)}</span><span class="tag npc">NPC</span>${H ? `<button class="xbtn" data-act="rmnpc" data-pid="${esc(n.pid)}" title="外す">×</button>` : ''}</li>`).join('')}
            ${total === 0 ? '<li class="empty">プレイヤーがいません</li>' : ''}
          </ul>
          ${H ? `<div class="npcbar">
            <button class="btn tiny" data-act="npc" data-n="1" ${full ? 'disabled' : ''}>＋ NPC</button>
            <button class="btn tiny" data-act="npc" data-n="5" ${full ? 'disabled' : ''}>＋5</button>
            <button class="btn tiny" data-act="npc" data-n="17" ${full ? 'disabled' : ''}>満員まで</button>
            <button class="btn tiny" data-act="rmnpc" ${S.npcs.length ? '' : 'disabled'}>− NPC</button>
            <button class="btn tiny ghost" data-act="rmall" ${S.npcs.length ? '' : 'disabled'}>NPCを全員外す</button>
          </div>` : ''}
        </div>
        ${seatBox}
        </div>
        <div>
          <div class="box">
            <h2>あなたの参加方法</h2>
            <div class="seg">
              <button class="btn ${me.role === 'player' ? 'on' : ''}" data-act="role" data-role="player" ${me.role !== 'player' && full ? 'disabled' : ''}>プレイヤー</button>
              <button class="btn ${me.role === 'spectator' ? 'on' : ''}" data-act="role" data-role="spectator">観戦する</button>
            </div>
          </div>
          <div class="box" style="margin-top:14px">
            <h2>観戦 <span class="count">${specs.length}</span></h2>
            <ul class="mlist">${specs.map(memberRow).join('') || '<li class="empty">観戦者はいません</li>'}</ul>
          </div>
          <div class="box" style="margin-top:14px">
            <h2>設定 ${H ? '' : '<span class="tag">ホストが変更できます</span>'}</h2>
            <div class="setrow"><span>1手の持ち時間</span>
              <select data-act="turnTime" ${H ? '' : 'disabled'}>${S.turnTimes.map((t) => `<option value="${t}" ${t === S.settings.turnTime ? 'selected' : ''}>${t}秒</option>`).join('')}</select>
            </div>
            <div class="setrow"><span>席順</span>
              <div class="seg mini-seg">
                <button class="btn tiny ${chooseMode ? '' : 'on'}" data-act="seatMode" data-v="random" ${H ? '' : 'disabled'}>ランダム</button>
                <button class="btn tiny ${chooseMode ? 'on' : ''}" data-act="seatMode" data-v="choose" ${H ? '' : 'disabled'}>各自で選ぶ</button>
              </div>
            </div>
            <div class="setrow"><span>観戦者に全員の手札を見せる</span>
              <button class="switch ${S.settings.reveal ? 'on' : ''}" data-act="reveal" ${H ? '' : 'disabled'} aria-label="観戦者に手札を見せる"></button>
            </div>
          </div>
        </div>
      </div>
      <div class="startbox">
        ${H ? `<button class="btn gold big" data-act="start">試合開始（${Math.max(2, total)}人）</button>${startNote ? `<div class="hint">${startNote}</div>` : ''}`
          : `<div class="waiting">ホストの開始を待っています<span class="dots"></span></div>`}
      </div>
      <section class="rules">
        <h2>ルール</h2>
        <ol>
          <li>人数に応じたトランプ（4人ごとに1組）＋ジョーカー1枚を配り、同じ数字のペアは捨てる。</li>
          <li>手番の人は次の人の手札から1枚引く。ペアができたら捨てる。</li>
          <li>手札がなくなった人は脱落。早く上がるほど順位は下。</li>
          <li>最後に残ったジョーカー持ちが優勝！</li>
        </ol>
        <p class="note">試合中に通信が切れたらNPCが代打。同じ端末でページを開き直せば復帰できます。</p>
      </section>`;
  }

  $('#lobby').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled || !S) return;
    const act = b.dataset.act;
    if (act === 'leave') send({ t: 'leave' });
    else if (act === 'copy') copyInvite();
    else if (act === 'rename') {
      const n = prompt('新しいなまえ（12文字まで）', myName());
      if (n && n.trim()) { store.set('bb_name', n.trim()); send({ t: 'rename', name: n.trim() }); }
    }
    else if (act === 'npc') send({ t: 'addNpc', n: +b.dataset.n });
    else if (act === 'rmnpc') send({ t: 'removeNpc', pid: b.dataset.pid || null });
    else if (act === 'rmall') send({ t: 'removeNpc', all: true });
    else if (act === 'role') send({ t: 'role', role: b.dataset.role });
    else if (act === 'reveal') send({ t: 'settings', reveal: !S.settings.reveal });
    else if (act === 'start') send({ t: 'start' });
    else if (act === 'seatMode') send({ t: 'settings', seatMode: b.dataset.v });
    else if (act === 'seat') send({ t: 'seat', n: +b.dataset.n });
    else if (act === 'unseat') send({ t: 'seat', n: null });
  });
  $('#lobby').addEventListener('change', (e) => {
    if (e.target.dataset.act === 'turnTime') send({ t: 'settings', turnTime: +e.target.value });
  });

  function copyInvite() {
    const url = `${location.origin}${location.pathname}?room=${S.code}`;
    const done = () => toast('招待リンクをコピーしました');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, () => prompt('このリンクを送ってね', url));
    else prompt('このリンクを送ってね', url);
  }

  // ---------- 対戦 ----------
  function cardHTML(c, cls, i) {
    const di = i == null ? '' : ` data-i="${i}"`;
    if (!c) return `<div class="card back ${cls || ''}"${di}></div>`;
    if (c.r === 0) return `<div class="card jk ${cls || ''}"${di}><span class="jk-star">★</span><span class="jk-word">JOKER</span><span class="jk-star">★</span></div>`;
    const red = c.s === 'h' || c.s === 'd';
    return `<div class="card face ${red ? 'r' : ''} ${cls || ''}"${di}><span class="rk">${RK[c.r]}</span><span class="st">${SU[c.s]}</span><span class="big">${SU[c.s]}</span></div>`;
  }
  function miniHTML(c) {
    if (c.r === 0) return '<span class="mini j">JK</span>';
    return `<span class="mini ${c.s === 'h' || c.s === 'd' ? 'r' : ''}">${SU[c.s]}${RK[c.r]}</span>`;
  }
  function label(c) { return c.r === 0 ? 'ジョーカー' : SU[c.s] + RK[c.r]; }

  function seatOf(pid) { return S && S.game ? S.game.seats.find((s) => s.pid === pid) : null; }
  function isMyTurnNow() {
    const g = S && S.game;
    return !!(g && g.phase === 'turn' && g.mySeat && g.turn === g.mySeat && drawingTurn !== g.turnId);
  }

  function renderGame() {
    const g = S.game;
    if (!g) return;
    showScreen('game');
    if (sel && sel.turnId !== g.turnId) sel = null;
    $('#gCode').textContent = S.code;
    const active = g.seats.filter((s) => !s.out).length;
    const specCount = S.members.filter((m) => m.role === 'spectator').length;
    $('#gStats').textContent = g.phase === 'turn'
      ? `残り${active}人 ・ 捨て札${g.discard}枚${specCount ? ` ・ 観戦${specCount}` : ''}`
      : '試合終了';

    const me = g.mySeat ? seatOf(g.mySeat) : null;
    const drawer = seatOf(g.turn);
    const target = seatOf(g.target);
    const myTurn = isMyTurnNow();
    const amTarget = !!(me && target && target.pid === me.pid);

    // 状況表示
    const st = $('#status');
    st.className = 'status';
    if (g.phase !== 'turn') st.textContent = S.state === 'result' ? '試合終了！' : '';
    else if (myTurn) { st.textContent = `あなたの番！ ${target.name} の手札から1枚引こう`; st.classList.add('mine'); }
    else if (amTarget) { st.textContent = `${drawer.name} があなたの手札から引こうとしています`; st.classList.add('targeted'); }
    else st.textContent = `${drawer.name} が ${target.name} から引く番${me && me.out ? '（あなたは脱落）' : ''}${!me ? '（観戦中）' : ''}`;

    // プレイヤー一覧
    $('#plates').innerHTML = g.seats.map((s, i) => {
      const cls = ['plate'];
      if (s.pid === g.mySeat) cls.push('me');
      if (s.pid === g.turn) cls.push('turn');
      if (s.pid === g.target) cls.push('target');
      if (s.out) cls.push('out');
      const showMinis = s.hand && s.pid !== g.mySeat && !s.out;
      return `<div class="${cls.join(' ')}" data-pid="${esc(s.pid)}">
        <span class="seat">${i + 1}</span>
        <div class="pn">${s.npc ? '🤖 ' : ''}${esc(s.name)}</div>
        <div class="pm">
          ${s.out ? '<span class="tag">脱落</span>' : `<span class="cnt"><i></i>${s.count}</span>`}
          ${s.pid === g.turn ? '<span class="role">引く</span>' : ''}
          ${s.pid === g.target ? '<span class="role">引かれる</span>' : ''}
          ${s.sub ? '<span class="tag sub">代打</span>' : ''}
          ${s.pid === g.mySeat ? '<span class="tag me">あなた</span>' : ''}
        </div>
        ${showMinis ? `<div class="minis">${s.hand.map(miniHTML).join('')}</div>` : ''}
        <div class="bubble"></div>
      </div>`;
    }).join('');

    // 場（引かれる人の手札）
    const stage = $('#stage');
    stage.classList.toggle('pick', myTurn);
    if (g.phase === 'turn' && target && drawer) {
      $('#stageLabel').innerHTML = myTurn ? `<b>${esc(target.name)}</b> の手札 ― 1枚選んでね`
        : amTarget ? `<b>${esc(drawer.name)}</b> があなたの手札から引きます`
        : `<b>${esc(drawer.name)}</b> → <b>${esc(target.name)}</b> の手札から引く`;
      const cards = amTarget ? me.hand : target.hand;
      stage.innerHTML = cards
        ? cards.map((c, i) => cardHTML(c, '', i)).join('')
        : Array.from({ length: target.count }, (_, i) => cardHTML(null, '', i)).join('');
    } else {
      $('#stageLabel').textContent = S.state === 'result' ? '試合終了' : '';
      const w = seatOf(g.winner);
      stage.innerHTML = w ? `<div class="ph">🃏 ${esc(w.name)} が最後までジョーカーを守りきった！</div>` : '';
    }
    renderStageActions();

    // エモート
    $('#emotes').innerHTML = S.emotes.map((e) => `<button data-e="${e}">${e}</button>`).join('');

    // 自分の手札
    const wrap = $('#myWrap');
    if (!me) {
      wrap.classList.add('hidden');
    } else {
      wrap.classList.remove('hidden');
      wrap.classList.toggle('targeted', amTarget);
      const jk = me.hand && me.hand.some((c) => c.r === 0);
      $('#myLabel').textContent = me.out ? 'あなたは脱落しました' : `あなたの手札（${me.count}枚）${jk ? ' ― ジョーカーを守れ！' : ''}`;
      $('#shuffleBtn').classList.toggle('hidden', me.out || me.count < 2 || g.phase !== 'turn');
      $('#myHand').innerHTML = me.out || !me.hand || !me.hand.length
        ? '<div class="msg">最後まで見届けよう</div>'
        : me.hand.map((c, i) => cardHTML(c, c.r === 0 ? 'glow' : '', i)).join('');
    }

    applyHover();
    requestAnimationFrame(layoutAll);
    startTimer(g);
    renderResult();
    if (logOpen) renderLog();
  }

  function renderStageActions() {
    const g = S.game;
    const box = $('#stageActions');
    if (S.state === 'result') {
      box.innerHTML = (resultHidden ? '<button class="btn" data-act="showResult">結果を見る</button>' : '') +
        (S.isHost ? '<button class="btn gold" data-act="lobby">ロビーに戻る</button>' : '');
      return;
    }
    if (!isMyTurnNow()) { box.innerHTML = ''; return; }
    if (sel && sel.turnId === g.turnId) box.innerHTML = '<button class="btn joker" data-act="drawSel">このカードを引く</button>';
    else box.innerHTML = '<button class="btn" data-act="drawRandom">おまかせで引く</button>';
  }

  function applyHover() {
    const g = S && S.game;
    if (!g) return;
    const myTurn = isMyTurnNow();
    const amTarget = g.mySeat && g.target === g.mySeat;
    document.querySelectorAll('#stage .card').forEach((el) => {
      const i = +el.dataset.i;
      el.classList.toggle('hov', g.hover === i);
      el.classList.toggle('sel', !!(myTurn && sel && sel.turnId === g.turnId && sel.i === i));
    });
    document.querySelectorAll('#myHand .card').forEach((el) => {
      el.classList.toggle('aim', !!(amTarget && g.hover === +el.dataset.i));
    });
  }

  function layoutRow(row) {
    const cards = [...row.querySelectorAll(':scope > .card')];
    if (!cards.length) return;
    const W = row.clientWidth;
    const cw = cards[0].offsetWidth;
    const n = cards.length;
    let ml = 6;
    if (n > 1 && n * cw + (n - 1) * 6 > W) ml = Math.max(-cw + 10, (W - cw) / (n - 1) - cw);
    cards.forEach((c, i) => { c.style.marginLeft = i ? ml + 'px' : '0'; });
  }
  function layoutAll() { layoutRow($('#stage')); layoutRow($('#myHand')); }
  window.addEventListener('resize', () => { if (S && S.game) layoutAll(); });

  function sendHover(i) {
    const now = performance.now();
    if (i === lastHoverSent && now - lastHoverAt < 400) return;
    if (now - lastHoverAt < 70) return;
    lastHoverSent = i; lastHoverAt = now;
    send({ t: 'hover', i });
  }

  function drawCard(i) {
    const g = S.game;
    if (!isMyTurnNow()) return;
    drawingTurn = g.turnId;
    sel = null;
    send({ t: 'draw', i, turnId: g.turnId });
    renderStageActions();
  }

  $('#stage').addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (!c || !isMyTurnNow()) return;
    const i = +c.dataset.i;
    const g = S.game;
    if (sel && sel.turnId === g.turnId && sel.i === i) { drawCard(i); return; }
    sel = { turnId: g.turnId, i };
    g.hover = i;
    lastHoverAt = 0;
    sendHover(i);
    applyHover();
    renderStageActions();
  });
  $('#stage').addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !isMyTurnNow()) return;
    const c = e.target.closest('.card');
    if (c) sendHover(+c.dataset.i);
  });
  $('#stageActions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'drawSel' && sel) drawCard(sel.i);
    else if (act === 'drawRandom') {
      const t = seatOf(S.game.target);
      if (t) drawCard(Math.floor(Math.random() * t.count));
    } else if (act === 'showResult') { resultHidden = false; renderResult(); renderStageActions(); }
    else if (act === 'lobby') send({ t: 'lobby' });
  });
  $('#shuffleBtn').onclick = () => send({ t: 'shuffle' });
  $('#emotes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-e]');
    if (b) send({ t: 'emote', e: b.dataset.e });
  });
  $('#gLeave').onclick = () => {
    const g = S && S.game;
    const me = g && g.mySeat ? seatOf(g.mySeat) : null;
    if (S.state === 'playing' && me && !me.out &&
      !confirm('試合中に抜けるとNPCが代打します。\n同じ端末で部屋コードを入れれば戻れます。退出しますか？')) return;
    send({ t: 'leave' });
  };
  $('#logBtn').onclick = () => { logOpen = !logOpen; $('#logPanel').classList.toggle('hidden', !logOpen); if (logOpen) renderLog(); };
  $('#logClose').onclick = closeLog;
  function closeLog() { logOpen = false; $('#logPanel').classList.add('hidden'); }
  function renderLog() { $('#logList').innerHTML = S.log.slice().reverse().map((l) => `<li>${esc(l)}</li>`).join(''); }

  function startTimer(g) {
    clearInterval(timerInt);
    const el = $('#timer');
    if (!(g.phase === 'turn' && g.deadlineIn > 0)) { el.classList.add('off'); return; }
    el.classList.remove('off');
    const end = performance.now() + g.deadlineIn;
    const total = g.turnTime * 1000;
    const tick = () => {
      const left = Math.max(0, end - performance.now());
      $('#timerFill').style.width = Math.min(100, left / total * 100) + '%';
      $('#timerText').textContent = Math.ceil(left / 1000) + '秒';
      el.classList.toggle('low', left < 5000);
    };
    tick();
    timerInt = setInterval(tick, 100);
  }

  function renderResult() {
    const r = $('#result');
    if (!S || S.state !== 'result' || resultHidden || !S.game || !S.game.ranking) { r.classList.add('hidden'); return; }
    const g = S.game;
    const w = seatOf(g.winner);
    const iWon = g.winner && g.winner === g.mySeat;
    r.classList.remove('hidden');
    r.innerHTML = `<div class="rbox">
      ${cardHTML({ r: 0, s: 'j' }, 'glow')}
      <h2>${iWon ? 'あなたの勝ち！' : `${esc(w ? w.name : '？')} の勝ち！`}</h2>
      <p class="sub">最後までジョーカーを守りきった</p>
      <ol class="rank">${g.ranking.map((x) => {
        const s = seatOf(x.pid);
        return `<li class="${x.rank === 1 ? 'first' : ''} ${x.pid === g.mySeat ? 'me' : ''}"><span class="no">${x.rank}位</span><span class="nm">${s && s.npc ? '🤖 ' : ''}${esc(x.name)}</span>${x.rank === 1 ? '🃏' : ''}</li>`;
      }).join('')}</ol>
      <div class="rbtns">
        ${S.isHost ? '<button class="btn gold big" data-act="lobby">ロビーに戻る</button>' : '<div class="waiting">ホストがロビーに戻すのを待っています<span class="dots"></span></div>'}
        <button class="btn ghost" data-act="hideResult">盤面を見る</button>
      </div></div>`;
  }
  $('#result').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'lobby') send({ t: 'lobby' });
    if (b.dataset.act === 'hideResult') { resultHidden = true; renderResult(); renderStageActions(); }
  });

  // ---------- 演出 ----------
  function toast(text, cls) {
    const el = document.createElement('div');
    el.className = 'toast ' + (cls || '');
    el.textContent = text;
    $('#toasts').appendChild(el);
    while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, cls === 'jk' ? 2600 : 2000);
  }

  let popupT = 0;
  function popup(html) {
    const p = $('#popup');
    p.innerHTML = html;
    p.classList.add('show');
    clearTimeout(popupT);
    popupT = setTimeout(() => p.classList.remove('show'), 1500);
  }

  function showEmote(pid, e) {
    const plate = document.querySelector(`.plate[data-pid="${CSS.escape(pid)}"] .bubble`);
    if (plate && !$('#game').classList.contains('hidden')) {
      plate.textContent = e;
      plate.classList.add('show');
      clearTimeout(plate._t);
      plate._t = setTimeout(() => plate.classList.remove('show'), 1600);
      return;
    }
    const m = S && S.members.find((x) => x.pid === pid);
    if (m) toast(`${m.name}（観戦）${e}`);
  }

  function flyCard(fromEl, toEl, card) {
    if (!fromEl || !toEl) return;
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const wrap = document.createElement('div');
    wrap.innerHTML = cardHTML(card || null, '');
    const el = wrap.firstChild;
    el.style.left = a.left + 'px';
    el.style.top = a.top + 'px';
    el.style.width = a.width + 'px';
    el.style.height = a.height + 'px';
    $('#fly').appendChild(el);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const anim = el.animate([
      { transform: 'translate(0,0) rotate(0) scale(1)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) rotate(${dx > 0 ? 12 : -12}deg) scale(.7)`, opacity: .9 },
    ], { duration: 480, easing: 'cubic-bezier(.3,.7,.3,1)' });
    anim.onfinish = () => el.remove();
  }

  function fx(m) {
    if (m.k === 'start') { resultHidden = false; sel = null; drawingTurn = -1; toast('試合開始！ ジョーカーを最後まで持っていた人の勝ち'); return; }
    if (m.k === 'end') { resultHidden = false; return; }
    if (!S || !S.game) return;
    const g = S.game;
    if (m.k === 'shuffle') {
      if (g.target === m.pid) { sel = null; }
      showEmote(m.pid, '🔀');
      return;
    }
    if (m.k !== 'draw') return;
    const from = seatOf(m.from), to = seatOf(m.to);
    if (!from || !to) return;
    const mine = g.mySeat;
    const src = document.querySelector(`#stage .card[data-i="${m.index}"]`) ||
      document.querySelector(`.plate[data-pid="${CSS.escape(m.from)}"]`);
    const dst = m.to === mine ? $('#myHand') : document.querySelector(`.plate[data-pid="${CSS.escape(m.to)}"]`);
    flyCard(src, dst, m.card && (m.to === mine || m.from === mine || !mine) ? m.card : null);
    const plate = document.querySelector(`.plate[data-pid="${CSS.escape(m.to)}"]`);
    if (plate) { plate.classList.remove('flash'); void plate.offsetWidth; plate.classList.add('flash'); }

    if (m.to === mine && m.card) {
      if (m.joker) { toast('🃏 ジョーカーを手に入れた！ 守りきれ！', 'jk'); popup(`<div class="pc">${cardHTML(m.card)}</div>ジョーカー獲得！`); }
      else if (m.pair) popup(`<div class="pc">${cardHTML(m.pair[0])}${cardHTML(m.pair[1])}</div>${label(m.card)} を引いてペア成立！`);
      else popup(`<div class="pc">${cardHTML(m.card)}</div>${label(m.card)} を引いた`);
    } else {
      if (m.from === mine && m.joker) toast(`ジョーカーを ${to.name} に奪われた…`, 'bad');
      else if (!mine && m.joker) toast(`🃏 ジョーカーが ${to.name} に移った！`, 'jk');
      if (m.pair) popup(`<div class="pc">${cardHTML(m.pair[0])}${cardHTML(m.pair[1])}</div>${esc(to.name)} が ${RK[m.pair[0].r]} のペアを捨てた`);
    }
    for (const pid of m.outs || []) {
      const s = seatOf(pid);
      if (s) toast(pid === mine ? 'あなたの手札がなくなった… 脱落' : `${s.name} 脱落`, pid === mine ? 'bad' : '');
    }
  }

  document.addEventListener('visibilitychange', () => {
    // スマホでバックグラウンドから戻ったとき、切れていればすぐ再接続
    if (document.visibilityState === 'visible' && !wsOpen && !kicked) connect();
  });

  render();
  connect();
})();
