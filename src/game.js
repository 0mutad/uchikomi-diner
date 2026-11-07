/* うちこみ食堂：状態・遊びの流れ・描画・パネル・保存
 * 流れ: 文字を集める → 「営業する」ボタン → 料理を作って売る → また集める */

(() => {
  'use strict';

  const SAVE_KEY = 'uchikomi-diner-v1';
  const isDesk = !!window.desk;
  if (isDesk) document.body.classList.add('electron');

  /* ---------- 状態と保存 ---------- */
  function fresh() {
    return {
      v: 1,
      letters: Object.fromEntries(LETTERS.map((c) => [c, 0])),
      coins: 0,
      sales: 0,                 // 累計売上（次の国へ進む目標に使う予定）
      cooked: {},               // 料理ごとに作った数 { sushi: 3, ... }
      upg: { fridge: 0, stove: 0, sign: 0 },
      today: { day: '', keys: 0 },
      totalKeys: 0,
      introSeen: false,
    };
  }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return fresh(); }
    if (!raw) return fresh();
    try {
      const s = JSON.parse(raw);
      const base = fresh();
      // 初期値に重ねる（項目が増えても古い保存データで動くように）
      return {
        ...base, ...s,
        letters: { ...base.letters, ...s.letters },
        upg: { ...base.upg, ...s.upg },
        today: { ...base.today, ...s.today },
        cooked: { ...s.cooked },
      };
    } catch (e) { return fresh(); }
  }

  let state = load();
  function save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* 保存できなくても続行 */ }
  }
  setInterval(save, 5000);
  window.addEventListener('beforeunload', save);

  /* ---------- 日付と日替わりの人気料理 ---------- */
  function dayKey(t = Date.now()) {
    const d = new Date(t - DAY_START_HOUR * 3600 * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function seeded(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => {
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      return ((h >>> 0) % 100000) / 100000;
    };
  }

  let popular = { day: '', ids: new Set() };
  function refreshDay() {
    const day = dayKey();
    if (popular.day !== day) {
      const rnd = seeded(day);
      const pool = DISHES.slice();
      const ids = new Set();
      while (ids.size < POPULAR_COUNT && pool.length) ids.add(pool.splice(Math.floor(rnd() * pool.length), 1)[0].id);
      popular = { day, ids };
    }
    if (state.today.day !== day) state.today = { day, keys: 0 };
  }
  refreshDay();
  setInterval(refreshDay, 60 * 1000);

  /* ---------- 計算 ---------- */
  const upgValue = (id) => UPGRADES.find((u) => u.id === id).value(state.upg[id]);
  const capacity = () => upgValue('fridge');
  const stoveMax = () => upgValue('stove');
  const stock = () => LETTERS.reduce((s, c) => s + state.letters[c], 0);

  function sellPrice(d) {
    const pop = popular.ids.has(d.id) ? POPULAR_BONUS : 1;
    return Math.round(d.price * (upgValue('sign') / 100) * pop);
  }

  function makeable(d, letters) {
    let n = Infinity;
    for (const ch in d.need) n = Math.min(n, Math.floor(letters[ch] / d.need[ch]));
    return n;
  }

  function take(d, letters, times) {
    for (const ch in d.need) letters[ch] -= d.need[ch] * times;
  }

  /* 決めた順に、作れるだけ作る */
  function greedy(order, letters, slots, plan = new Map()) {
    for (const d of order) {
      if (slots <= 0) break;
      const n = Math.min(slots, makeable(d, letters));
      if (n <= 0) continue;
      take(d, letters, n);
      plan.set(d.id, (plan.get(d.id) || 0) + n);
      slots -= n;
    }
    return { plan, letters, slots };
  }

  function planTotal(plan) {
    let sum = 0;
    for (const [id, n] of plan) sum += sellPrice(DISH_BY_ID[id]) * n;
    return sum;
  }

  /* 決めた順に1皿ずつ、ぐるぐる回して作る（同じ料理に偏らない） */
  function roundRobin(order, letters, slots, plan) {
    let progress = true;
    while (slots > 0 && progress) {
      progress = false;
      for (const d of order) {
        if (slots <= 0) break;
        if (makeable(d, letters) < 1) continue;
        take(d, letters, 1);
        plan.set(d.id, (plan.get(d.id) || 0) + 1);
        slots--;
        progress = true;
      }
    }
    return plan;
  }

  /* 売上優先: 並べ方と作り方を何通りか試し、一番売上が高いものを使う。
   * 厳密な最適ではないが、十分に近い */
  function planRevenue(letters, slots, plan) {
    const byPrice = DISHES.slice().sort((a, b) => sellPrice(b) - sellPrice(a));
    const byEff = DISHES.slice().sort((a, b) => sellPrice(b) / b.ro.length - sellPrice(a) / a.ro.length);
    const orders = [byPrice, byEff];
    // 少し順番を揺らした並べ方も試す（毎回同じ結果になるよう乱数は固定）
    const rnd = seeded('plan');
    for (let i = 0; i < 24; i++) {
      orders.push(DISHES.slice()
        .map((d) => ({ d, k: sellPrice(d) / d.ro.length * (0.7 + rnd() * 0.6) }))
        .sort((a, b) => b.k - a.k).map((x) => x.d));
    }
    let best = null;
    let bestTotal = -1;
    for (const order of orders) {
      for (const p of [
        greedy(order, { ...letters }, slots, new Map(plan)).plan,
        roundRobin(order, { ...letters }, slots, new Map(plan)),
      ]) {
        const t = planTotal(p);
        if (t > bestTotal) { best = p; bestTotal = t; }
      }
    }
    return best;
  }

  /* 新しい料理優先: まだ作っていない料理を高い順に1皿ずつ、残りは売上優先で埋める */
  function planNew(letters, slots) {
    const fresh = DISHES.filter((d) => !state.cooked[d.id]).sort((a, b) => sellPrice(b) - sellPrice(a));
    const left = { ...letters };
    const plan = new Map();
    for (const d of fresh) {
      if (slots <= 0) break;
      if (makeable(d, left) < 1) continue;
      take(d, left, 1);
      plan.set(d.id, 1);
      slots--;
    }
    return planRevenue(left, slots, plan);
  }

  /* ---------- 文字を受け取る ---------- */
  let lastKeyAt = 0;
  let hookError = null;

  function addLetters(letters, other) {
    const cap = capacity();
    let room = cap - stock();
    let got = 0;
    let dropped = 0;
    for (const ch in letters) {
      if (!(ch in state.letters)) continue;
      const n = letters[ch];
      const ok = Math.max(0, Math.min(n, room));
      state.letters[ch] += ok;
      room -= ok;
      got += ok;
      dropped += n - ok;
      for (let i = 0; i < Math.min(ok, 3); i++) spawnLetter(ch);
    }
    const keys = Object.values(letters).reduce((s, n) => s + n, 0) + (other || 0);
    refreshDay();
    state.today.keys += keys;
    state.totalKeys += keys;
    if (got || dropped) lastKeyAt = performance.now();
    paintHud();
    if (openPanel === 'letters') renderPanel();
  }

  if (isDesk) {
    window.desk.onKeys((data) => addLetters(data.letters || {}, data.other || 0));
    window.desk.hookStatus().then((s) => {
      if (!s.ok) {
        hookError = s.error || '不明なエラー';
        paintHud();
      }
    });
  } else {
    // ブラウザで開いたとき（動作確認用）は、このページで打った文字を数える
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      const ch = e.key.length === 1 ? e.key.toLowerCase() : '';
      if (ch >= 'a' && ch <= 'z') addLetters({ [ch]: 1 }, 0);
      else addLetters({}, 1);
    });
  }

  /* ---------- HUD ---------- */
  const $ = (id) => document.getElementById(id);

  function paintHud() {
    const s = stock();
    const cap = capacity();
    $('stock').textContent = s;
    $('cap').textContent = cap;
    $('stock').parentElement.classList.toggle('full', s >= cap);
    $('today').textContent = state.today.keys.toLocaleString();
    $('money').textContent = state.coins.toLocaleString();
    let note = '';
    if (hookError) note = 'キー入力を取得できません';
    else if (s >= cap) note = '冷蔵庫がいっぱい！';
    $('notice').textContent = note;
    $('btn-open').disabled = openPanel === 'cook' || openPanel === 'result';
    for (const [id, name] of [['btn-letters', 'letters'], ['btn-upgrade', 'upgrade'], ['btn-book', 'book']]) {
      $(id).classList.toggle('on', openPanel === name);
    }
  }

  /* ---------- パネル ---------- */
  const panel = $('panel');
  let openPanel = null;
  let cookMode = 'revenue';
  let cart = new Map();       // 手動モードの注文 { id: 個数 }
  let cookPlan = new Map();   // 今表示している作る予定
  let lastResult = null;

  function open(name) {
    openPanel = name;
    if (name === 'cook') { cart = new Map(); }
    renderPanel();
    panel.classList.add('open');
    paintHud();
  }
  function close() {
    openPanel = null;
    panel.classList.remove('open');
    paintHud();
  }
  function toggle(name) { if (openPanel === name) close(); else open(name); }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const roHtml = (ro) => [...ro].map((ch) => (RARE.has(ch) ? `<span class="rare">${ch}</span>` : ch)).join('');

  function head(title, sub = '') {
    return `<div class="panel-head"><span>${title}<span class="sub">${sub}</span></span><button data-act="close" title="閉じる">✕</button></div>`;
  }

  function dishTags(d) {
    let t = '';
    if (!state.cooked[d.id]) t += '<span class="tag new">NEW</span>';
    if (popular.ids.has(d.id)) t += '<span class="tag pop">人気×1.5</span>';
    return t;
  }

  function renderPanel() {
    let html = '';
    if (openPanel === 'intro') html = renderIntro();
    else if (openPanel === 'letters') html = renderLetters();
    else if (openPanel === 'upgrade') html = renderUpgrade();
    else if (openPanel === 'book') html = renderBook();
    else if (openPanel === 'cook') html = renderCook();
    else if (openPanel === 'result') html = renderResult();
    panel.innerHTML = html;
  }

  function renderIntro() {
    return `${head('うちこみ食堂へようこそ')}
      <div class="panel-body">
        <p style="line-height:1.8;margin:4px 0">
          ふだんの作業で打った <b>a〜z の文字</b> が、そのまま料理の食材になります。<br>
          たまったら <b>「🍳 営業する」</b> を押して、料理を作って売りましょう。
        </p>
        <p class="hint">
          🔒 数えるのは <b>キーごとの合計回数だけ</b> です。押した順番や打った文章は記録しません。通信もしません。<br>
          ⚠ 管理者として動いているアプリ（タスクマネージャーなど）の上で打った文字は、Windows の仕組み上数えられません。
        </p>
      </div>
      <div class="panel-foot"><span></span><button class="btn primary" data-act="intro-ok">はじめる</button></div>`;
  }

  function renderLetters() {
    const cells = LETTERS.map((c) => {
      const n = state.letters[c];
      return `<div class="letter${RARE.has(c) ? ' rare' : ''}${n ? '' : ' zero'}"><div class="ch">${c}</div><div class="n">${n}</div></div>`;
    }).join('');
    return `${head('ためた文字', `${stock()} / ${capacity()}`)}
      <div class="panel-body">
        <div class="letters">${cells}</div>
        <p class="hint">黄色の文字は高級食材（あまり打たれない文字）です。<br>
        🔒 数えているのはキーごとの合計回数だけ。押した順番や文章は残りません。
        ${hookError ? `<br>⚠ キー入力を取得できませんでした: ${esc(hookError)}` : ''}</p>
      </div>`;
  }

  function renderUpgrade() {
    const rows = UPGRADES.map((u) => {
      const lv = state.upg[u.id];
      const cost = u.cost(lv);
      return `<div class="upg">
        <div class="icon">${u.icon}</div>
        <div><div class="t">${u.name} <span class="count">Lv.${lv + 1}</span></div>
          <div class="d">${u.desc}: ${u.value(lv)}${u.unit} → <b>${u.value(lv + 1)}${u.unit}</b></div></div>
        <button class="btn primary" data-act="buy" data-id="${u.id}" ${state.coins < cost ? 'disabled' : ''}>🪙 ${cost.toLocaleString()}</button>
      </div>`;
    }).join('');
    return `${head('店の設備', `🪙 ${state.coins.toLocaleString()}`)}<div class="panel-body">${rows}</div>`;
  }

  function renderBook() {
    const made = DISHES.filter((d) => state.cooked[d.id]).length;
    const list = DISHES.slice().sort((a, b) => a.price - b.price);
    const rows = list.map((d) => {
      const n = state.cooked[d.id] || 0;
      return `<div class="dish book-dish${n ? '' : ' unknown'}">
        <div class="name"><div class="ja">${esc(d.ja)}${popular.ids.has(d.id) ? '<span class="tag pop">人気</span>' : ''}</div><div class="ro">${roHtml(d.ro)}</div></div>
        <div class="count">${n ? `${n}皿` : '未作成'}</div>
        <div class="price">🪙 ${sellPrice(d)}</div>
      </div>`;
    }).join('');
    return `${head('図鑑 🇯🇵 日本', `${made} / ${DISHES.length} 品 ・ 累計売上 🪙 ${state.sales.toLocaleString()}`)}<div class="panel-body">${rows}</div>`;
  }

  function renderCook() {
    const slots = stoveMax();
    const tabs = [['revenue', '💰 売上優先'], ['new', '✨ 新しい料理'], ['manual', '✋ 手動']]
      .map(([id, label]) => `<button class="tab${cookMode === id ? ' on' : ''}" data-act="mode" data-id="${id}">${label}</button>`).join('');

    let body = '';
    if (cookMode === 'manual') {
      cookPlan = new Map([...cart].filter(([, n]) => n > 0));
      const left = { ...state.letters };
      for (const [id, n] of cookPlan) take(DISH_BY_ID[id], left, n);
      const used = [...cookPlan.values()].reduce((s, n) => s + n, 0);
      const list = DISHES.slice()
        .map((d) => ({ d, can: makeable(d, left), q: cart.get(d.id) || 0 }))
        .filter((x) => x.q > 0 || x.can > 0)
        .sort((a, b) => sellPrice(b.d) - sellPrice(a.d));
      body = list.length ? list.map(({ d, can, q }) => `<div class="dish${q || can ? '' : ' off'}">
          <div class="name"><div class="ja">${esc(d.ja)}${dishTags(d)}</div><div class="ro">${roHtml(d.ro)}</div></div>
          <div class="price">🪙 ${sellPrice(d)}</div>
          <div class="qty">
            <button data-act="minus" data-id="${d.id}" ${q ? '' : 'disabled'}>−</button>
            <span>${q}</span>
            <button data-act="plus" data-id="${d.id}" ${can > 0 && used < slots ? '' : 'disabled'}>＋</button>
          </div></div>`).join('')
        : '<div class="empty">作れる料理がまだありません。<br>もう少し文字をためましょう。</div>';
    } else {
      cookPlan = cookMode === 'new' ? planNew(state.letters, slots) : planRevenue(state.letters, slots, new Map());
      const rows = [...cookPlan].map(([id, n]) => ({ d: DISH_BY_ID[id], n })).sort((a, b) => sellPrice(b.d) * b.n - sellPrice(a.d) * a.n);
      body = rows.length ? rows.map(({ d, n }) => `<div class="dish">
          <div class="name"><div class="ja">${esc(d.ja)}${dishTags(d)}</div><div class="ro">${roHtml(d.ro)}</div></div>
          <div class="count">×${n}</div>
          <div class="price">🪙 ${(sellPrice(d) * n).toLocaleString()}</div></div>`).join('')
        : '<div class="empty">作れる料理がまだありません。<br>もう少し文字をためましょう。</div>';
    }

    const count = [...cookPlan.values()].reduce((s, n) => s + n, 0);
    const total = planTotal(cookPlan);
    return `${head('🍳 営業', `調理台 ${slots}皿まで ・ 手持ち ${stock()}文字`)}
      <div class="tabs">${tabs}</div>
      <div class="panel-body">${body}</div>
      <div class="panel-foot">
        <span>${count}皿 ・ 合計 <b style="color:var(--gold)">🪙 ${total.toLocaleString()}</b></span>
        <span><button class="btn" data-act="close">やめる</button>
        <button class="btn primary" data-act="cook" ${count ? '' : 'disabled'}>作って売る</button></span>
      </div>`;
  }

  function renderResult() {
    const r = lastResult;
    const rows = r.rows.map(({ d, n, first }) => `<div class="dish">
        <div class="name"><div class="ja">${esc(d.ja)}${first ? '<span class="tag new">図鑑に追加</span>' : ''}</div><div class="ro">${roHtml(d.ro)}</div></div>
        <div class="count">×${n}</div>
        <div class="price">🪙 ${(sellPrice(d) * n).toLocaleString()}</div></div>`).join('');
    return `${head('本日の売上')}
      <div class="panel-body"><div class="result-total">🪙 ${r.total.toLocaleString()}</div>${rows}</div>
      <div class="panel-foot"><span class="count">残りの文字は次の営業に持ち越し</span><button class="btn primary" data-act="close">また文字をためる</button></div>`;
  }

  function cook() {
    const rows = [];
    let total = 0;
    for (const [id, n] of cookPlan) {
      const d = DISH_BY_ID[id];
      const can = makeable(d, state.letters);
      const k = Math.min(n, can);
      if (k <= 0) continue;
      take(d, state.letters, k);
      const first = !state.cooked[id];
      state.cooked[id] = (state.cooked[id] || 0) + k;
      const earned = sellPrice(d) * k;
      total += earned;
      rows.push({ d, n: k, first });
    }
    state.coins += total;
    state.sales += total;
    lastResult = { rows: rows.sort((a, b) => sellPrice(b.d) * b.n - sellPrice(a.d) * a.n), total };
    spawnCoins(total);
    save();
    open('result');
  }

  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const id = b.dataset.id;
    if (act === 'close') close();
    else if (act === 'intro-ok') { state.introSeen = true; save(); close(); }
    else if (act === 'mode') { cookMode = id; cart = new Map(); renderPanel(); }
    else if (act === 'plus') { cart.set(id, (cart.get(id) || 0) + 1); renderPanel(); }
    else if (act === 'minus') { cart.set(id, Math.max(0, (cart.get(id) || 0) - 1)); renderPanel(); }
    else if (act === 'cook') cook();
    else if (act === 'buy') {
      const u = UPGRADES.find((x) => x.id === id);
      const cost = u.cost(state.upg[id]);
      if (state.coins < cost) return;
      state.coins -= cost;
      state.upg[id]++;
      save();
      renderPanel();
      paintHud();
    }
  });

  $('btn-open').addEventListener('click', () => open('cook'));
  $('btn-letters').addEventListener('click', () => toggle('letters'));
  $('btn-upgrade').addEventListener('click', () => toggle('upgrade'));
  $('btn-book').addEventListener('click', () => toggle('book'));
  $('btn-quit').addEventListener('click', () => {
    save();
    if (isDesk) window.desk.quit();
  });

  /* ---------- 描画（コードで描く。あとでドット絵に差し替える） ---------- */
  const canvas = $('scene');
  const ctx = canvas.getContext('2d');
  const W = 480;
  const H = 190;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const POT = { x: 205, y: 112 };
  const flyers = [];   // 鍋へ飛んでいく文字
  const floats = [];   // 売上の表示

  function spawnLetter(ch) {
    if (flyers.length > 40) return;
    flyers.push({ ch, x: 300 + Math.random() * 160, y: 150 + Math.random() * 10, t: 0, dur: 0.7 + Math.random() * 0.4, rare: RARE.has(ch) });
  }
  function spawnCoins(total) {
    floats.push({ text: `+${total.toLocaleString()} 🪙`, x: POT.x, y: 90, t: 0 });
  }

  function drawStall(t) {
    // 壁
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#5a3d2b');
    g.addColorStop(1, '#3a2619');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 板張り
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 32) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, 126); ctx.stroke(); }

    // のれん
    const flaps = 3;
    const nx = 18;
    const nw = 150;
    for (let i = 0; i < flaps; i++) {
      const sway = Math.sin(t * 1.5 + i) * 1.5;
      ctx.fillStyle = '#1f3a5f';
      ctx.fillRect(nx + i * (nw / flaps) + 1, 0, nw / flaps - 3, 40 + sway);
    }
    ctx.fillStyle = '#f3ece2';
    ctx.font = 'bold 15px "Yu Gothic UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('うちこみ', nx + nw / 2, 18);
    ctx.font = 'bold 12px "Yu Gothic UI", sans-serif';
    ctx.fillText('食 堂', nx + nw / 2, 34);

    // おすすめの札
    const bx = 300;
    const by = 52;
    ctx.fillStyle = '#e9dcc3';
    ctx.fillRect(bx, by, 166, 66);
    ctx.fillStyle = '#7a2e1d';
    ctx.font = 'bold 10px "Yu Gothic UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('本日の人気（売値×1.5）', bx + 8, by + 14);
    ctx.fillStyle = '#3a2619';
    ctx.font = '11px "Yu Gothic UI", sans-serif';
    [...popular.ids].forEach((id, i) => {
      const d = DISH_BY_ID[id];
      ctx.fillText(`・${d.ja}`, bx + 8, by + 31 + i * 14);
      ctx.fillStyle = '#8a7a66';
      ctx.font = '9px Consolas, monospace';
      ctx.fillText(d.ro, bx + 100, by + 31 + i * 14);
      ctx.fillStyle = '#3a2619';
      ctx.font = '11px "Yu Gothic UI", sans-serif';
    });

    // 料理人
    const typing = performance.now() - lastKeyAt < 600;
    const bob = typing ? Math.sin(t * 18) * 2 : Math.sin(t * 2) * 0.8;
    const cx = 120;
    ctx.fillStyle = '#f7f3ee';
    ctx.fillRect(cx - 16, 82 + bob, 32, 40);             // 体
    ctx.fillStyle = '#f2c9a0';
    ctx.beginPath(); ctx.arc(cx, 70 + bob, 12, 0, Math.PI * 2); ctx.fill();   // 顔
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - 11, 46 + bob, 22, 14);             // 帽子
    ctx.beginPath(); ctx.arc(cx, 46 + bob, 11, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#3a2619';
    ctx.fillRect(cx - 5, 68 + bob, 2, 3);
    ctx.fillRect(cx + 3, 68 + bob, 2, 3);
    // 腕（打っている間は動く）
    const arm = typing ? Math.sin(t * 22) * 6 : 0;
    ctx.strokeStyle = '#f7f3ee';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx + 14, 92 + bob); ctx.lineTo(POT.x - 34, POT.y - 10 + arm); ctx.stroke();

    // カウンター
    ctx.fillStyle = '#8b5a3c';
    ctx.fillRect(0, 122, W, 34);
    ctx.fillStyle = '#a06a47';
    ctx.fillRect(0, 122, W, 5);

    // 鍋と湯気
    ctx.fillStyle = '#2b2b2b';
    ctx.beginPath(); ctx.ellipse(POT.x, POT.y + 6, 30, 12, 0, 0, Math.PI); ctx.fill();
    ctx.fillRect(POT.x - 30, POT.y - 8, 60, 14);
    ctx.fillStyle = '#444';
    ctx.beginPath(); ctx.ellipse(POT.x, POT.y - 8, 30, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const sx = POT.x - 14 + i * 14;
      const ph = t * 2 + i;
      ctx.beginPath();
      ctx.moveTo(sx, POT.y - 14);
      ctx.quadraticCurveTo(sx + Math.sin(ph) * 6, POT.y - 26, sx, POT.y - 38 - (ph % 1) * 4);
      ctx.stroke();
    }
  }

  function drawFlyers(dt) {
    ctx.textAlign = 'center';
    for (let i = flyers.length - 1; i >= 0; i--) {
      const f = flyers[i];
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      const x = f.x + (POT.x - f.x) * k;
      const y = f.y + (POT.y - 12 - f.y) * k - Math.sin(k * Math.PI) * 40;
      ctx.globalAlpha = 1 - k * 0.6;
      ctx.fillStyle = f.rare ? '#ffd166' : '#f3ece2';
      ctx.font = 'bold 14px Consolas, monospace';
      ctx.fillText(f.ch, x, y);
      ctx.globalAlpha = 1;
      if (k >= 1) flyers.splice(i, 1);
    }
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.t += dt;
      ctx.globalAlpha = Math.max(0, 1 - f.t / 2);
      ctx.fillStyle = '#ffd166';
      ctx.font = 'bold 16px "Yu Gothic UI", sans-serif';
      ctx.fillText(f.text, f.x, f.y - f.t * 20);
      ctx.globalAlpha = 1;
      if (f.t > 2) floats.splice(i, 1);
    }
  }

  let last = performance.now();
  let acc = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    const busy = flyers.length || floats.length || now - lastKeyAt < 800;
    // 動きがあるときは30fps、ないときは5fps程度に落とす
    if (acc >= (busy ? 1 / 30 : 1 / 5)) {
      const step = acc;
      acc = 0;
      drawStall(now / 1000);
      drawFlyers(step);
    }
    requestAnimationFrame(frame);
  }

  paintHud();
  requestAnimationFrame(frame);
  if (!state.introSeen) open('intro');
})();
