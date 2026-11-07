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
    // 営業中は、まだお客さんから受け取っていない分を引いて見せる
    $('money').textContent = Math.max(0, state.coins - unpaid).toLocaleString();
    let note = '';
    if (hookError) note = 'キー入力を取得できません';
    else if (s >= cap) note = '冷蔵庫がいっぱい！';
    $('notice').textContent = note;
    const btn = $('btn-open');
    btn.textContent = serving ? '⏩ すぐ終える' : '🍳 営業する';
    btn.disabled = !serving && (openPanel === 'cook' || openPanel === 'result');
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
    save();
    // 売上は先に保存しておき、営業画面ではお客さんが払うたびに見た目だけ増やす
    close();
    startServe(rows);
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
      if (serving) return;   // 営業中は受け取り前のお金があるので買えない
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

  $('btn-open').addEventListener('click', () => (serving ? finishServe() : open('cook')));
  $('btn-letters').addEventListener('click', () => toggle('letters'));
  $('btn-upgrade').addEventListener('click', () => toggle('upgrade'));
  $('btn-book').addEventListener('click', () => toggle('book'));
  $('btn-quit').addEventListener('click', () => {
    save();
    if (isDesk) window.desk.quit();
  });

  /* ---------- 描画（コードで描く。あとでドット絵に差し替える） ----------
   * 仕込み: キーボードが見えていて、打った文字が料理人に吸い込まれていく
   * 営業:   店にお客さんが来て、料理人が作り、店員が運び、お客さんが食べて払って帰る */
  const canvas = $('scene');
  const ctx = canvas.getContext('2d');
  const W = 480;
  const H = 190;
  const FLOOR = 156;   // ここから下は HUD
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;

  const R = (x) => Math.round(x);
  function rect(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(R(x), R(y), R(w), R(h)); }
  function text(str, x, y, { size = 11, color = '#f3ece2', bold = false, align = 'left', font = '"Yu Gothic UI", sans-serif' } = {}) {
    ctx.font = `${bold ? 'bold ' : ''}${size}px ${font}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(str, R(x), R(y));
  }

  /* 人を描く。足元が (x, foot)。ドット絵に差し替えるときはここを画像にする */
  function person(x, foot, look, { walk = 0, sit = false, carry = null, chef = false, face = -1 } = {}) {
    const px = R(x);
    const step = walk ? (Math.floor(walk * 8) % 2 ? 2 : -2) : 0;
    const top = foot - 36 + (sit ? 6 : 0) + (walk ? Math.abs(step) * 0.5 : 0);
    // 脚
    if (sit) {
      rect(px - 5, top + 24, 10, 5, look.pants);
      rect(px + face * 6 - 2, top + 24, 6, 9, look.pants);
    } else {
      rect(px - 5 + step, top + 24, 4, 12, look.pants);
      rect(px + 1 - step, top + 24, 4, 12, look.pants);
    }
    // 体
    rect(px - 6, top + 11, 12, 14, look.shirt);
    if (chef) rect(px - 6, top + 17, 12, 8, '#e8e2d8');      // 前掛け
    // 頭
    rect(px - 5, top, 10, 11, look.skin);
    rect(px - 5, top, 10, 3, look.hair);
    rect(px + (face < 0 ? -5 : 3), top + 3, 2, 4, look.hair);
    rect(px + face * 2 - 1, top + 5, 2, 2, '#2a1d14');      // 目
    if (chef) {
      rect(px - 6, top - 7, 12, 7, '#ffffff');              // 帽子
      rect(px - 7, top - 10, 14, 4, '#ffffff');
    }
    // 運んでいる料理
    if (carry) {
      rect(px + face * 9 - 6, top + 14, 12, 3, '#f3ece2');
      rect(px + face * 9 - 4, top + 11, 8, 3, carry.color);
    }
  }

  const CHEF_LOOK = { skin: '#f2c9a0', hair: '#3a2619', shirt: '#ffffff', pants: '#3b3b46' };
  const STAFF_LOOK = { skin: '#f2c9a0', hair: '#1f1a17', shirt: '#7a2e1d', pants: '#2f2a28' };
  const GUEST_LOOKS = [
    { skin: '#f2c9a0', hair: '#3a2619', shirt: '#4f7cac', pants: '#2c3e50' },
    { skin: '#e8b98f', hair: '#1f1a17', shirt: '#6a994e', pants: '#3d405b' },
    { skin: '#f6d5b5', hair: '#a0522d', shirt: '#e9c46a', pants: '#264653' },
    { skin: '#d9a77c', hair: '#2b2b2b', shirt: '#b56576', pants: '#355070' },
    { skin: '#f2c9a0', hair: '#c9c9c9', shirt: '#8d6e63', pants: '#424242' },
    { skin: '#eac8a4', hair: '#5c3d2e', shirt: '#9b5de5', pants: '#22223b' },
  ];
  // 料理の色（見分け用。ドット絵になったら料理ごとの絵にする）
  const dishColor = (d) => ['#e76f51', '#f4a261', '#e9c46a', '#8ab17d', '#c08457', '#d4a373'][d.ro.length % 6];

  const floats = [];   // 浮かぶ文字（+コインなど）
  function floatText(str, x, y, color = '#ffd166') { floats.push({ str, x, y, t: 0, color }); }

  /* ===== 仕込み（キーボード） ===== */
  const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const KEY_W = 33;
  const KEY_H = 28;
  const KEY_GAP = 3;
  const KB_X = 112;
  const KB_Y = 58;
  const ROW_SHIFT = [0, 10, 26];
  const keyPos = {};
  ROWS.forEach((row, r) => [...row].forEach((ch, i) => {
    keyPos[ch] = { x: KB_X + ROW_SHIFT[r] + i * (KEY_W + KEY_GAP), y: KB_Y + r * (KEY_H + KEY_GAP) };
  }));
  const PREP_CHEF = { x: 56, foot: 148 };
  const flash = {};        // キーが光る残り時間
  const flyers = [];       // 料理人へ吸い込まれる文字
  let gulp = 0;            // 料理人が吸い込んだときの弾み

  /* 文字を料理人へ飛ばす。仕込み中はキーから、営業中は店の床から厨房の料理人へ */
  function spawnLetter(ch) {
    flash[ch] = 0.35;
    if (flyers.length > 50) return;
    const f = { ch, t: 0, dur: 0.55 + Math.random() * 0.25, rare: RARE.has(ch) };
    if (serving) {
      Object.assign(f, { sx: 200 + Math.random() * 250, sy: 150, tx: 84, ty: 82, dur: f.dur + 0.3 });
    } else {
      const k = keyPos[ch];
      Object.assign(f, { sx: k.x + KEY_W / 2, sy: k.y + KEY_H / 2, tx: PREP_CHEF.x + 4, ty: PREP_CHEF.foot - 26 });
    }
    flyers.push(f);
  }

  function drawFlyers(dt) {
    gulp = Math.max(0, gulp - dt * 4);
    for (let i = flyers.length - 1; i >= 0; i--) {
      const f = flyers[i];
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      const e = k * k;   // 吸い込まれるように加速
      const x = f.sx + (f.tx - f.sx) * e;
      const y = f.sy + (f.ty - f.sy) * e - Math.sin(k * Math.PI) * 26;
      const size = 14 - e * 7;
      ctx.globalAlpha = 1 - e * 0.5;
      text(f.ch, x, y, { size, bold: true, align: 'center', color: f.rare ? '#ffd166' : '#ffffff', font: 'Consolas, monospace' });
      ctx.globalAlpha = 1;
      if (k >= 1) { flyers.splice(i, 1); gulp = Math.min(1, gulp + 0.25); }
    }
  }

  function glow(x, y) {
    if (gulp <= 0) return;
    ctx.fillStyle = `rgba(255, 209, 102, ${gulp * 0.35})`;
    ctx.beginPath();
    ctx.arc(x, y, 18 + gulp * 6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPrep(t, dt) {
    // 背景（厨房の壁）
    rect(0, 0, W, FLOOR, '#5a3d2b');
    for (let x = 0; x < W; x += 24) rect(x, 0, 1, FLOOR, 'rgba(0,0,0,0.15)');
    rect(0, 136, W, 20, '#8b5a3c');
    rect(0, 136, W, 3, '#a06a47');

    // 見出し
    text('仕込み中', 12, 20, { size: 13, bold: true });
    text('打った文字が料理人に集まります', 12, 36, { size: 10, color: '#d8c8b0' });
    const pop = [...popular.ids].map((id) => DISH_BY_ID[id].ja).join('・');
    text(`本日の人気：${pop}`, KB_X, 46, { size: 9, color: '#ffd166' });

    // キーボードの台
    ctx.fillStyle = '#2b1d15';
    ctx.beginPath();
    ctx.roundRect(KB_X - 6, KB_Y - 5, 362, 3 * KEY_H + 2 * KEY_GAP + 10, 8);
    ctx.fill();

    // キー
    const max = Math.max(1, ...LETTERS.map((c) => state.letters[c]));
    for (const ch of LETTERS) {
      const k = keyPos[ch];
      const n = state.letters[ch];
      const f = Math.max(0, flash[ch] || 0);
      flash[ch] = f - dt;
      const press = f > 0 ? 2 : 0;
      const fill = 0.18 + 0.5 * (n / max);
      const base = RARE.has(ch) ? `rgba(255, 209, 102, ${fill})` : `rgba(243, 236, 226, ${fill * 0.7})`;
      rect(k.x, k.y + 3, KEY_W, KEY_H - 2, '#1a120d');                       // 影
      rect(k.x, k.y + press, KEY_W, KEY_H - 3, '#4a3428');
      rect(k.x, k.y + press, KEY_W, KEY_H - 3, base);
      if (f > 0) rect(k.x, k.y + press, KEY_W, KEY_H - 3, `rgba(255,255,255,${f * 1.5})`);
      text(ch.toUpperCase(), k.x + 5, k.y + press + 13, { size: 12, bold: true, color: RARE.has(ch) ? '#ffd166' : '#ffffff', font: 'Consolas, monospace' });
      text(String(n), k.x + KEY_W - 4, k.y + press + 24, { size: 9, align: 'right', color: n ? '#f3ece2' : 'rgba(243,236,226,0.4)', font: 'Consolas, monospace' });
    }

    // 料理人（吸い込むと弾む）
    const bob = Math.sin(t * 2) * 0.8 - gulp * 4;
    glow(PREP_CHEF.x, PREP_CHEF.foot - 22);   // 吸い込みの光
    person(PREP_CHEF.x, PREP_CHEF.foot + bob, CHEF_LOOK, { chef: true, face: 1 });
    drawFlyers(dt);
  }

  /* ===== 営業（お店） ===== */
  let serving = false;
  let unpaid = 0;              // まだ見た目で受け取っていない売上
  let orders = [];             // これから来るお客さんが頼む料理
  let served = 0;
  let totalOrders = 0;
  let guests = [];
  let spawnWait = 0;
  const TABLES = [220, 305, 390].map((x) => ({ x, guest: null, dish: null }));
  const COUNTER_X = 150;       // 料理を置く場所
  const STAFF_HOME = 172;
  const DOOR_X = 468;
  const SPEED = 110;
  const kitchen = { queue: [], cooking: null, t: 0 };
  let ready = [];              // カウンターに置かれた料理（お客さん）
  const staff = { x: STAFF_HOME, state: 'idle', target: STAFF_HOME, carry: null, walk: 0 };

  function startServe(rows) {
    orders = [];
    for (const { d, n } of rows) for (let i = 0; i < n; i++) orders.push(d);
    // 順番を混ぜる
    for (let i = orders.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [orders[i], orders[j]] = [orders[j], orders[i]];
    }
    totalOrders = orders.length;
    served = 0;
    unpaid = lastResult.total;
    guests = [];
    ready = [];
    kitchen.queue = [];
    kitchen.cooking = null;
    Object.assign(staff, { x: STAFF_HOME, state: 'idle', target: STAFF_HOME, carry: null });
    TABLES.forEach((tb) => { tb.guest = null; tb.dish = null; });
    spawnWait = 0;
    serving = true;
    paintHud();
  }

  function finishServe() {
    serving = false;
    unpaid = 0;
    orders = [];
    guests = [];
    paintHud();
    open('result');
  }

  function moveToward(obj, target, dt) {
    const d = target - obj.x;
    const s = Math.sign(d) * Math.min(Math.abs(d), SPEED * dt);
    obj.x += s;
    obj.walk = s ? (obj.walk || 0) + dt : 0;
    obj.face = s ? Math.sign(s) : (obj.face || -1);
    return Math.abs(target - obj.x) < 0.5;
  }

  function updateServe(dt) {
    // お客さんが来る（空いている席があれば）
    spawnWait -= dt;
    const free = TABLES.find((tb) => !tb.guest);
    if (orders.length && free && spawnWait <= 0) {
      const g = { x: DOOR_X, dish: orders.shift(), table: free, state: 'enter', t: 0, look: GUEST_LOOKS[Math.floor(Math.random() * GUEST_LOOKS.length)] };
      free.guest = g;
      guests.push(g);
      spawnWait = 0.9;
    }

    for (let i = guests.length - 1; i >= 0; i--) {
      const g = guests[i];
      if (g.state === 'enter') {
        if (moveToward(g, g.table.x - 16, dt)) { g.state = 'order'; g.t = 0.8; g.face = 1; }
      } else if (g.state === 'order') {
        g.t -= dt;
        if (g.t <= 0) { g.state = 'wait'; kitchen.queue.push(g); }
      } else if (g.state === 'eat') {
        g.t -= dt;
        if (g.t <= 0) {
          const price = sellPrice(g.dish);
          unpaid = Math.max(0, unpaid - price);
          served++;
          floatText(`+${price}`, g.table.x, 74);
          g.table.dish = null;
          g.table.guest = null;
          g.state = 'leave';
          paintHud();
        }
      } else if (g.state === 'leave') {
        if (moveToward(g, DOOR_X + 10, dt)) guests.splice(i, 1);
      }
    }

    // 厨房: 1皿ずつ作る
    if (!kitchen.cooking && kitchen.queue.length) { kitchen.cooking = kitchen.queue.shift(); kitchen.t = 0.8; }
    if (kitchen.cooking) {
      kitchen.t -= dt;
      if (kitchen.t <= 0) { ready.push(kitchen.cooking); kitchen.cooking = null; }
    }

    // 店員: カウンターの料理を席へ運ぶ
    if (staff.state === 'idle' && ready.length) staff.state = 'pick';
    if (staff.state === 'pick') {
      if (moveToward(staff, COUNTER_X + 10, dt)) { staff.carry = ready.shift(); staff.state = 'deliver'; }
    } else if (staff.state === 'deliver') {
      const g = staff.carry;
      if (moveToward(staff, g.table.x + 18, dt)) {
        g.table.dish = g.dish;
        g.state = 'eat';
        g.t = 1.3;
        staff.carry = null;
        staff.state = ready.length ? 'pick' : 'back';
      }
    } else if (staff.state === 'back') {
      if (moveToward(staff, STAFF_HOME, dt)) { staff.state = 'idle'; staff.face = 1; }
    }

    if (!orders.length && !guests.length && !ready.length && !kitchen.cooking && !kitchen.queue.length && !staff.carry) finishServe();
  }

  function bubble(str, x, y) {
    ctx.font = '10px "Yu Gothic UI", sans-serif';
    const w = ctx.measureText(str).width + 10;
    rect(x - w / 2, y - 14, w, 16, '#fffaf0');
    rect(x - 2, y + 2, 4, 3, '#fffaf0');
    text(str, x, y - 2, { size: 10, align: 'center', color: '#3a2619' });
  }

  function drawServe(t, dt) {
    // 壁と床
    rect(0, 0, W, 104, '#6b4a33');
    for (let x = 0; x < W; x += 24) rect(x, 0, 1, 104, 'rgba(0,0,0,0.12)');
    rect(0, 92, W, 12, '#4e3424');
    for (let x = 0; x < W; x += 16) {
      for (let y = 104; y < FLOOR; y += 13) rect(x, y, 16, 13, ((x / 16 + (y - 104) / 13) % 2) ? '#8a6448' : '#7c583e');
    }

    // のれん（店の名前）
    for (let i = 0; i < 3; i++) rect(14 + i * 42, 0, 40, 30 + Math.sin(t * 1.5 + i) * 1.5, '#1f3a5f');
    text('うちこみ食堂', 77, 19, { size: 12, bold: true, align: 'center' });

    // 窓と入口
    rect(250, 30, 70, 40, '#9fc5d9');
    rect(284, 30, 2, 40, '#6b4a33');
    rect(250, 49, 70, 2, '#6b4a33');
    rect(456, 40, 24, 64, '#3a2619');
    rect(460, 44, 16, 56, '#4e3424');

    // 営業の進み具合
    text(`営業中  ${served} / ${totalOrders} 皿`, 160, 20, { size: 11, bold: true, color: '#ffd166' });

    // 厨房（料理人はカウンターの奥）
    rect(14, 60, 46, 30, '#3b3b46');            // コンロ
    rect(18, 56, 16, 4, '#555');
    const cooking = !!kitchen.cooking;
    const flip = cooking ? Math.abs(Math.sin(t * 10)) * 4 : 0;
    glow(80, 88);
    person(80, 110 - flip * 0.3, CHEF_LOOK, { chef: true, face: 1 });
    if (cooking) {
      rect(93, 78 - flip, 12, 3, '#2b2b2b');    // フライパン
      for (let i = 0; i < 3; i++) rect(95 + i * 4, 70 - flip - ((t * 30 + i * 7) % 10), 2, 2, 'rgba(255,255,255,0.6)');
      bubble(kitchen.cooking.dish.ja, 80, 52);
    }
    rect(0, 100, COUNTER_X + 22, 22, "#a06a47");  // カウンター
    rect(0, 100, COUNTER_X + 22, 3, "#c08457");
    ready.forEach((g, i) => {
      rect(COUNTER_X - i * 14, 96, 12, 3, '#f3ece2');
      rect(COUNTER_X + 2 - i * 14, 93, 8, 3, dishColor(g.dish));
    });

    // テーブル
    for (const tb of TABLES) {
      rect(tb.x - 28, 128, 8, 14, '#5c3d2e');   // いす
      rect(tb.x - 16, 116, 36, 5, '#c08457');   // 天板
      rect(tb.x, 121, 4, 20, '#8b5a3c');        // 脚
      if (tb.dish) {
        rect(tb.x - 4, 112, 14, 4, '#f3ece2');
        rect(tb.x - 2, 109, 10, 3, dishColor(tb.dish));
      }
    }

    // 人（奥から順に）
    for (const g of guests) {
      const sit = g.state === 'order' || g.state === 'wait' || g.state === 'eat';
      person(g.x, sit ? 140 : 146, g.look, { walk: sit ? 0 : g.walk, sit, face: g.face || -1 });
      if (g.state === 'order') bubble(g.dish.ja, g.x, 96);
      if (g.state === 'eat' && Math.sin(t * 12) > 0) rect(g.x + 5, 116, 2, 2, '#ffffff');
    }
    person(staff.x, 146, STAFF_LOOK, { walk: staff.walk, carry: staff.carry ? { color: dishColor(staff.carry.dish) } : null, face: staff.face || 1 });
    drawFlyers(dt);   // 営業中に打った文字も料理人へ集まる
  }

  function drawFloats(dt) {
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.t += dt;
      ctx.globalAlpha = Math.max(0, 1 - f.t / 1.4);
      text(`${f.str} 🪙`, f.x, f.y - f.t * 22, { size: 13, bold: true, align: 'center', color: f.color });
      ctx.globalAlpha = 1;
      if (f.t > 1.4) floats.splice(i, 1);
    }
  }

  let last = performance.now();
  let acc = 0;
  function frame(now) {
    const dt = Math.min(1, (now - last) / 1000);
    last = now;
    acc += dt;
    const busy = serving || flyers.length || floats.length || gulp > 0 || now - lastKeyAt < 800;
    // 動きがあるときは30fps、ないときは5fps程度に落とす
    if (acc >= (busy ? 1 / 30 : 1 / 5)) {
      const step = Math.min(1, acc);
      acc = 0;
      if (serving) {
        // 描画の回数が少なくても時間どおりに進むよう、0.05秒ずつ刻んで進める
        for (let left = step; left > 0 && serving; left -= 0.05) updateServe(Math.min(0.05, left));
        if (serving) drawServe(now / 1000, step);
        else drawPrep(now / 1000, step);
      } else {
        drawPrep(now / 1000, step);
      }
      drawFloats(step);
    }
    requestAnimationFrame(frame);
  }

  paintHud();
  requestAnimationFrame(frame);
  if (!state.introSeen) open('intro');
})();
