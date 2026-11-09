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
      guestsSeen: {},           // 来店したお客さんの数 { salaryman: 3, ... }（図鑑の人）
      upg: { fridge: 0, stove: 0, sign: 0, knife: 0 },
      today: { day: '', keys: 0 },
      totalKeys: 0,
      introSeen: false,
      eng: { unlocked: false, slots: Array(ENG_SLOTS_MAX).fill(null), slotCount: ENG_SLOTS_START },   // ⚙ 工学（枠ごとに { fac, lv } か null）
      prepCount: 0,                        // 自動仕込み機: 次の文字までの打鍵数
    };
  }

  // 工学の保存データ。前の形（施設ごとのレベル fac）なら枠に並べ直す
  function loadEng(base, e) {
    if (!e) return base;
    const out = { ...base, ...e };
    const slots = Array.isArray(e.slots) ? [...e.slots] : Array(ENG_SLOTS_MAX).fill(null);
    while (slots.length < ENG_SLOTS_MAX) slots.push(null);
    if (!Array.isArray(e.slots) && e.fac) {
      let i = 0;
      for (const [id, lv] of Object.entries(e.fac)) if (lv > 0 && i < ENG_SLOTS_MAX) slots[i++] = { fac: id, lv };
      out.slotCount = Math.max(ENG_SLOTS_START, i);
    }
    out.slots = slots;
    delete out.fac;
    return out;
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
        guestsSeen: { ...s.guestsSeen },
        eng: loadEng(base.eng, s.eng),
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

  // 同じ施設のレベルの合計（工学を買っていなければ 0）
  const facLv = (id) => (state.eng.unlocked ? state.eng.slots.reduce((n, s) => n + (s && s.fac === id ? s.lv : 0), 0) : 0);
  const facCount = (id) => state.eng.slots.filter((s) => s && s.fac === id).length;
  const facSpent = (f, lv) => { let n = 0; for (let i = 0; i < lv; i++) n += f.cost(i); return n; };
  const popularBonus = () => POPULAR_BONUS + facLv('tower') * 0.1;

  function sellPrice(d) {
    const pop = popular.ids.has(d.id) ? popularBonus() : 1;
    const spice = 1 + facLv('spice') * 0.05;
    return Math.round(d.price * (upgValue('sign') / 100) * spice * pop);
  }

  /* ---------- 工学: 文字の変換 ---------- */
  const NORMAL = LETTERS.filter((c) => !RARE.has(c));
  const RARES = LETTERS.filter((c) => RARE.has(c));

  /* 変換に使える材料と、1回に使う数 */
  function convSpec(id) {
    const f = FACILITIES.find((x) => x.id === id);
    const lv = facLv(id);
    return id === 'converter'
      ? { pool: VOWELS, rate: f.rate(lv), targets: NORMAL }
      : { pool: NORMAL, rate: f.rate(lv), targets: RARES };
  }

  function convMax(id, target) {
    const { pool, rate } = convSpec(id);
    // 変換先の文字そのものは材料にしない
    const have = pool.filter((c) => c !== target).reduce((s, c) => s + state.letters[c], 0);
    return Math.floor(have / rate);
  }

  /* 一番多い文字から順に材料として使う */
  function convert(id, target, times) {
    const { pool, rate } = convSpec(id);
    const n = Math.min(times, convMax(id, target));
    for (let k = 0; k < n * rate; k++) {
      let best = null;
      for (const c of pool) if (c !== target && (best === null || state.letters[c] > state.letters[best])) best = c;
      state.letters[best]--;
    }
    state.letters[target] += n;
    for (let i = 0; i < Math.min(n, 5); i++) spawnLetter(target);
    return n;
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
    // 自動仕込み機: a〜z を100打つごとに、出やすさに合わせたランダムな文字を足す
    const prep = facLv('prepper');
    if (prep) {
      state.prepCount += Object.values(letters).reduce((s, n) => s + n, 0);
      const totalFreq = LETTERS.reduce((s, c) => s + FREQ[c], 0);
      while (state.prepCount >= 100) {
        state.prepCount -= 100;
        for (let i = 0; i < prep && room > 0; i++) {
          let r = Math.random() * totalFreq;
          const c = LETTERS.find((x) => (r -= FREQ[x]) < 0) || 'a';
          state.letters[c]++;
          room--;
          spawnLetter(c);
        }
      }
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
    btn.textContent = serving ? '🍳 営業中…' : '🍳 営業する';
    btn.disabled = serving || openPanel === 'cook' || openPanel === 'result';
    for (const [id, name] of [['btn-letters', 'letters'], ['btn-upgrade', 'upgrade'], ['btn-book', 'book']]) {
      $(id).classList.toggle('on', openPanel === name);
    }
    for (const b of document.querySelectorAll('#views button')) b.classList.toggle('on', b.dataset.view === view);
    $('view-eng').textContent = state.eng.unlocked ? '⚙' : '🔒';
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
    if (popular.ids.has(d.id)) t += `<span class="tag pop">人気×${popularBonus().toFixed(1)}</span>`;
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
    else if (openPanel === 'eng') html = renderEng();
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
    // ⚙ 工学: 最初から並べておき、買うとアンロック
    const eng = state.eng.unlocked
      ? `<div class="upg"><div class="icon">⚙</div>
          <div><div class="t">工学 <span class="count">購入済み</span></div>
          <div class="d">下の ⚙ ボタンで工学の画面へ。施設を買って文字の変換や売値アップができます</div></div>
          <button class="btn" data-act="go-eng">開く</button></div>`
      : `<div class="upg"><div class="icon">⚙</div>
          <div><div class="t">工学 <span class="count">未購入</span></div>
          <div class="d">工学の画面をアンロック。文字の変換・売値アップなどの施設を置けるようになります</div></div>
          <button class="btn primary" data-act="unlock" ${state.coins < ENGINEERING_COST ? 'disabled' : ''}>🪙 ${ENGINEERING_COST.toLocaleString()}</button></div>`;
    return `${head('店の設備', `🪙 ${state.coins.toLocaleString()}`)}<div class="panel-body">${rows}${eng}</div>`;
  }

  /* ⚙ 工学のパネル: マップで選んだ枠に施設を建てる・強化する・撤去する、文字の変換 */
  const convTarget = { converter: 's', refiner: 'c' };
  let engSel = null;   // マップで選んでいる枠の番号

  function convControls(id) {
    const { targets } = convSpec(id);
    const opts = targets.map((c) => `<option value="${c}" ${convTarget[id] === c ? 'selected' : ''}>${c}（${state.letters[c]}）</option>`).join('');
    const can = convMax(id, convTarget[id]);
    return `<div class="conv">変換先 <select data-conv="${id}">${opts}</select>
      <button class="btn" data-act="conv" data-id="${id}" data-n="1" ${can ? '' : 'disabled'}>1個</button>
      <button class="btn" data-act="conv" data-id="${id}" data-n="max" ${can ? '' : 'disabled'}>できるだけ（${can}）</button></div>`;
  }

  function renderEng() {
    if (!state.eng.unlocked) {
      return `${head('⚙ 工学')}
        <div class="panel-body"><div class="empty">🔒 工学はまだ使えません。<br>
        🔧 店の設備から 🪙 ${ENGINEERING_COST.toLocaleString()} で購入するとアンロックされます。</div></div>`;
    }
    const e = state.eng;
    const used = e.slots.slice(0, e.slotCount).filter(Boolean).length;
    const money = Math.max(0, state.coins - unpaid);
    const h = head('⚙ 工学', `枠 ${used} / ${e.slotCount} ・ 🪙 ${money.toLocaleString()}`);
    const back = '<button class="btn" data-act="eng-back">← 一覧へ</button>';
    const busy = serving ? '<p class="hint">営業中は建てる・強化することができません（変換はできます）</p>' : '';

    // 枠が増やせるところ
    if (engSel != null && engSel >= e.slotCount) {
      const cost = slotCost(e.slotCount);
      return `${h}<div class="panel-body">
        <div class="upg"><div class="icon">🧱</div>
          <div><div class="t">空き枠を増やす <span class="count">${e.slotCount} → ${e.slotCount + 1} 枠</span></div>
          <div class="d">施設を建てられる場所が1つ増えます（いずれショップやステージの報酬でも増える予定）</div></div>
          <button class="btn primary" data-act="slot-buy" ${money < cost || serving ? 'disabled' : ''}>🪙 ${cost.toLocaleString()}</button></div>
        ${busy}</div><div class="panel-foot"><span></span>${back}</div>`;
    }

    // 空き枠: 建てる施設を選ぶ
    if (engSel != null && !e.slots[engSel]) {
      const rows = FACILITIES.map((f) => {
        const n = facCount(f.id);
        const full = n >= FAC_LIMIT[f.id];
        const cost = f.cost(0);
        return `<div class="upg fac${full ? ' off' : ''}"><div class="icon">${f.icon}</div>
          <div><div class="t">${f.name} <span class="count">${f.kind} ・ ${n} / ${FAC_LIMIT[f.id]} 個</span></div>
          <div class="d">${f.desc(1)}</div></div>
          ${full ? '<span class="count">上限</span>'
            : `<button class="btn primary" data-act="build" data-id="${f.id}" ${money < cost || serving ? 'disabled' : ''}>建てる<br>🪙 ${cost.toLocaleString()}</button>`}
        </div>`;
      }).join('');
      return `${h}<div class="panel-body"><p class="hint" style="margin:0 0 4px">空き枠 ${engSel + 1} に建てる施設を選んでください。同じ施設は上限の数まで建てられ、効果はレベルの合計になります。</p>${rows}${busy}</div>
        <div class="panel-foot"><span></span>${back}</div>`;
    }

    // 建っている施設: 強化・撤去・変換
    if (engSel != null) {
      const s = e.slots[engSel];
      const f = FACILITIES.find((x) => x.id === s.fac);
      const maxed = s.lv >= FAC_MAX_LV;
      const cost = f.cost(s.lv);
      const total = facLv(f.id);
      const refund = Math.round(facSpent(f, s.lv) * REMOVE_REFUND);
      const sum = facCount(f.id) > 1 ? `<br>同じ施設が ${facCount(f.id)} 個あるので、効果は合計 Lv.${total}: ${f.desc(Math.min(total, 99))}` : '';
      return `${h}<div class="panel-body">
        <div class="upg fac"><div class="icon">${f.icon}</div>
          <div><div class="t">${f.name} <span class="count">Lv.${s.lv} ・ ${f.kind}</span></div>
          <div class="d">${f.desc(s.lv)}<br><span class="next">${maxed ? '最大レベル' : `強化すると → ${f.desc(s.lv + 1)}`}</span>${sum}</div>
          ${f.id === 'converter' || f.id === 'refiner' ? convControls(f.id) : ''}</div>
          ${maxed ? '<span class="count">MAX</span>'
            : `<button class="btn primary" data-act="fac-up" ${money < cost || serving ? 'disabled' : ''}>強化<br>🪙 ${cost.toLocaleString()}</button>`}
        </div>${busy}</div>
        <div class="panel-foot"><button class="btn" data-act="fac-remove" ${serving ? 'disabled' : ''}>撤去（🪙 ${refund.toLocaleString()} 戻る）</button>${back}</div>`;
    }

    // 一覧
    const rows = e.slots.slice(0, e.slotCount).map((s, i) => {
      if (!s) return `<div class="upg"><div class="icon">⬚</div><div><div class="t">空き枠 ${i + 1}</div><div class="d">クリックして施設を建てる</div></div>
        <button class="btn" data-act="slot-sel" data-i="${i}">建てる</button></div>`;
      const f = FACILITIES.find((x) => x.id === s.fac);
      return `<div class="upg fac"><div class="icon">${f.icon}</div>
        <div><div class="t">${f.name} <span class="count">Lv.${s.lv}</span></div><div class="d">${f.desc(s.lv)}</div>
        ${f.id === 'converter' || f.id === 'refiner' ? convControls(f.id) : ''}</div>
        <button class="btn" data-act="slot-sel" data-i="${i}">詳しく</button></div>`;
    }).join('');
    const more = e.slotCount < ENG_SLOTS_MAX
      ? `<div class="upg"><div class="icon">🧱</div><div><div class="t">空き枠を増やす</div><div class="d">${e.slotCount} → ${e.slotCount + 1} 枠</div></div>
        <button class="btn primary" data-act="slot-buy" ${money < slotCost(e.slotCount) || serving ? 'disabled' : ''}>🪙 ${slotCost(e.slotCount).toLocaleString()}</button></div>` : '';
    return `${h}<div class="panel-body"><p class="hint" style="margin:0 0 4px">下のマップの枠をクリックしても選べます。</p>${rows}${more}${busy}</div>`;
  }

  /* ---------- 📖 図鑑（料理／人のタブ） ----------
   * 絵は仮（コードで描いたドット）。あとでPNGに差し替える */
  let bookTab = 'dish';
  let bookSel = null;          // 詳しく見ている料理

  const imgCache = new Map();
  function toImg(key, src, scale) {
    if (imgCache.has(key)) return imgCache.get(key);
    const c = document.createElement('canvas');
    c.width = src.width * scale;
    c.height = src.height * scale;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, 0, c.width, c.height);
    const url = c.toDataURL();
    imgCache.set(key, url);
    return url;
  }

  // 料理の絵（仮）: どんぶり・お皿・串の3種類を、料理ごとの色で描く
  const DISH_ART = {
    bowl: ['................', '................', '...ffffffffff...', '..ffhfffffhfff..', '.ffffffffffffff.', '.rrrrrrrrrrrrrr.',
      '..rrrrrrrrrrrr..', '..rRrrrrrrrrrr..', '...rrrrrrrrrr...', '....rrrrrrrr....', '.....dddddd.....', '................'],
    plate: ['................', '................', '................', '......ffff......', '....ffhfffff....', '...ffffffffff...',
      '..ffffffffffff..', '.wwffffffffffww.', 'wwwwwwwwwwwwwwww', '.wwwwwwwwwwwwww.', '..gggggggggggg..', '................'],
    skewer: ['................', '................', '................', '..fff.fff.fff...', 'sfhffsfhffsfhffs', '..fff.fff.fff...',
      '................', '.wwwwwwwwwwwwww.', 'wwwwwwwwwwwwwwww', '.gggggggggggggg.', '................', '................'],
  };
  const FOOD_COLORS = ['#e76f51', '#f4a261', '#e9c46a', '#8ab17d', '#c08457', '#d4a373', '#b5651d', '#f2d398', '#9c6644', '#e85d75', '#a3b18a', '#ddb892'];
  function dishArtType(d) {
    if (/yakitori|kushikatsu|dango|tebasaki/.test(d.ro)) return 'skewer';
    if (/don$|ramen|udon|soba|men$|jiru|shiru|nabe|zosui|okayu|zuke|oden|chuka|imoni|hoto|mushi|yudofu|mizutaki|shabu|sukiyaki/.test(d.ro)) return 'bowl';
    return 'plate';
  }
  function dishImg(d, scale = 3) {
    let h = 0;
    for (const ch of d.ro) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const type = dishArtType(d);
    const sprite = makeSprite(`dish|${d.id}`, DISH_ART[type], {
      f: FOOD_COLORS[h % FOOD_COLORS.length], h: '#fff1d0', r: '#7a2e1d', R: '#a2533a', d: '#4a1a10',
      w: '#f3ece2', g: '#c8c0b4', s: '#c99560',
    });
    return toImg(`dish|${d.id}|${scale}`, sprite, scale);
  }
  function guestImg(g, scale = 3) {
    return toImg(`guest|${g.id}|${scale}`, personSprite(g.look, false, 'front'), scale);
  }
  const stars = (n) => `<span class="stars r${n}">${'★'.repeat(n)}<span class="off">${'★'.repeat(3 - n)}</span></span>`;

  function renderBook() {
    const tabs = [['dish', '🍳 料理'], ['guest', '🧑 人']]
      .map(([id, label]) => `<button class="tab${bookTab === id ? ' on' : ''}" data-act="book-tab" data-id="${id}">${label}</button>`).join('');

    if (bookTab === 'guest') {
      const met = GUESTS.filter((g) => state.guestsSeen[g.id]).length;
      const rows = GUESTS.slice().sort((a, b) => a.rarity - b.rarity).map((g) => {
        const n = state.guestsSeen[g.id] || 0;
        return `<div class="guest-row${n ? '' : ' unknown'}">
          <img class="pix" src="${guestImg(g)}" alt="">
          <div class="name"><div class="ja">${n ? esc(g.name) : '？？？'}</div><div class="d">${n ? esc(g.desc) : 'まだ来ていない'}</div></div>
          ${stars(g.rarity)}
          <div class="count">${n ? `来店 ${n}回` : ''}</div>
        </div>`;
      }).join('');
      return `${head('📖 図鑑', `人 ${met} / ${GUESTS.length}`)}<div class="tabs">${tabs}</div><div class="panel-body">${rows}</div>`;
    }

    const made = DISHES.filter((d) => state.cooked[d.id]).length;
    const sub = `料理 ${made} / ${DISHES.length} 品 ・ 累計売上 🪙 ${state.sales.toLocaleString()}`;

    // 料理をひとつ詳しく見る
    if (bookSel) {
      const d = DISH_BY_ID[bookSel];
      const n = state.cooked[d.id] || 0;
      return `${head('📖 図鑑', sub)}<div class="tabs">${tabs}</div><div class="panel-body">
        <div class="book-detail${n ? '' : ' unknown'}">
          <img class="pix" src="${dishImg(d, 6)}" alt="">
          <div>
            <div class="t">${n ? esc(d.ja) : '？？？'}${popular.ids.has(d.id) ? '<span class="tag pop">人気</span>' : ''}</div>
            <div class="ro">${roHtml(d.ro)}</div>
            <div class="d">売値 🪙 ${sellPrice(d)} ・ ${n ? `${n}皿 作った` : 'まだ作っていない'}</div>
          </div>
        </div>
        <p class="desc">${n ? esc(d.desc || '説明は準備中です。') : 'この料理を作ると説明が読めます。'}</p>
      </div><div class="panel-foot"><span></span><button class="btn" data-act="book-back">← 一覧へ</button></div>`;
    }

    // 料理の一覧（横に4つ、縦にスクロール）
    const cards = DISHES.map((d) => {
      const n = state.cooked[d.id] || 0;
      return `<button class="book-card${n ? '' : ' unknown'}" data-act="book-dish" data-id="${d.id}">
        <img class="pix" src="${dishImg(d)}" alt="">
        <div class="ja">${n ? esc(d.ja) : '？？？'}</div>
        <div class="ro">${d.ro}</div>
      </button>`;
    }).join('');
    return `${head('📖 図鑑', sub)}<div class="tabs">${tabs}</div><div class="panel-body"><div class="book-grid">${cards}</div></div>`;
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
    return `${head('🍳 営業', `記憶量 ${slots}皿まで ・ 手持ち ${stock()}文字`)}
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
    else if (act === 'book-tab') { bookTab = id; bookSel = null; renderPanel(); }
    else if (act === 'book-dish') { bookSel = id; renderPanel(); }
    else if (act === 'book-back') { bookSel = null; renderPanel(); }
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
    } else if (act === 'unlock') {
      if (serving || state.eng.unlocked || state.coins < ENGINEERING_COST) return;
      state.coins -= ENGINEERING_COST;
      state.eng.unlocked = true;
      save();
      setView('eng');
    } else if (act === 'go-eng') {
      setView('eng');
    } else if (act === 'eng-back') {
      engSel = null;
      renderPanel();
    } else if (act === 'slot-sel') {
      engSel = Number(b.dataset.i);
      showSlot(engSel);
      renderPanel();
    } else if (act === 'slot-buy') {
      const cost = slotCost(state.eng.slotCount);
      if (serving || state.eng.slotCount >= ENG_SLOTS_MAX || state.coins < cost) return;
      state.coins -= cost;
      engSel = state.eng.slotCount;
      state.eng.slotCount++;
      showSlot(engSel);
      save(); renderPanel(); paintHud();
    } else if (act === 'build') {
      const f = FACILITIES.find((x) => x.id === id);
      const cost = f.cost(0);
      if (serving || engSel == null || state.eng.slots[engSel] || facCount(id) >= FAC_LIMIT[id] || state.coins < cost) return;
      state.coins -= cost;
      state.eng.slots[engSel] = { fac: id, lv: 1 };
      machinePop[engSel] = 1;
      save(); renderPanel(); paintHud();
    } else if (act === 'fac-up') {
      const sl = engSel != null && state.eng.slots[engSel];
      if (serving || !sl) return;
      const f = FACILITIES.find((x) => x.id === sl.fac);
      const cost = f.cost(sl.lv);
      if (sl.lv >= FAC_MAX_LV || state.coins < cost) return;
      state.coins -= cost;
      sl.lv++;
      machinePop[engSel] = 1;
      save(); renderPanel(); paintHud();
    } else if (act === 'fac-remove') {
      const sl = engSel != null && state.eng.slots[engSel];
      if (serving || !sl) return;
      const f = FACILITIES.find((x) => x.id === sl.fac);
      const refund = Math.round(facSpent(f, sl.lv) * REMOVE_REFUND);
      state.coins += refund;
      state.eng.slots[engSel] = null;
      floatText(`+${refund}`, 240, 60);
      save(); renderPanel(); paintHud();
    } else if (act === 'conv') {
      const n = convert(id, convTarget[id], b.dataset.n === 'max' ? Infinity : 1);
      if (n) floatText(`${convTarget[id]} +${n}`, 120 + Math.random() * 240, 60, '#9ad1ff', '');
      save();
      renderPanel();
      paintHud();
    }
  });

  panel.addEventListener('change', (e) => {
    const s = e.target.closest('select[data-conv]');
    if (!s) return;
    convTarget[s.dataset.conv] = s.value;
    renderPanel();
  });

  /* ---------- 3つの画面の切り替え（⌨ キーボード / 🍽 レストラン / ⚙ 工学） ---------- */
  let view = 'keyboard';
  function setView(v) {
    view = v;
    if (v === 'eng') { flyers.length = 0; engSel = null; open('eng'); }
    else if (openPanel === 'eng') close();
    paintHud();
  }
  for (const b of document.querySelectorAll('#views button')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }

  $('btn-open').addEventListener('click', () => { if (!serving) open('cook'); });
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

  /* ===== ドット絵（仮） =====
   * 絵は文字の並びで書き、1ドットを画面の2px（料理人の大きい絵は3px）で描く。
   * 本番の絵に差し替えるときは makeSprite の代わりに画像を読み込めばよい */
  const PX = 2;
  const spriteCache = new Map();
  function makeSprite(key, rows, pal) {
    let c = spriteCache.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = rows[0].length;
    c.height = rows.length;
    const g = c.getContext('2d');
    rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (pal[ch]) { g.fillStyle = pal[ch]; g.fillRect(x, y, 1, 1); }
    }));
    spriteCache.set(key, c);
    return c;
  }
  // (x, foot) が足元の真ん中
  function drawSprite(img, x, foot, { flip = false, scale = PX } = {}) {
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(R(x - w / 2), R(foot - h));
    if (flip) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(img, 0, 0, w, h);
    ctx.restore();
  }

  // 人の絵（8×12ドット）。h髪 s肌 k目 c服 p下 o靴 w白 a前掛け
  const HEAD_FRONT = ['..hhhh..', '.hhhhhh.', '.hssssh.', '.skssks.', '..ssss..'];
  const HEAD_SIDE = ['..hhhh..', '.hhhhhh.', '.hhssss.', '.hsssks.', '..ssss..'];
  const HAT_FRONT = ['.wwwwww.', '.wwwwww.', '.hssssh.', '.skssks.', '..ssss..'];
  const HAT_SIDE = ['.wwwwww.', '.wwwwww.', '.hhssss.', '.hsssks.', '..ssss..'];
  const BODY = ['.cccccc.', 'sccccccs', 'sccccccs', '.cccccc.'];
  const BODY_CHEF = ['.cccccc.', 'sccccccs', 'saaaaaas', '.aaaaaa.'];
  const LEGS = { a: ['.pp..pp.', '.pp..pp.', '.oo..oo.'], b: ['..pppp..', '..pppp..', '..oooo..'], sit: ['.pppppp.'] };
  const HAT_TOP = ['..wwww..', '.wwwwww.'];

  function personSprite(look, chef, pose) {
    const side = pose === 'sideA' || pose === 'sideB';
    let rows = [...(chef ? (side ? HAT_SIDE : HAT_FRONT) : (side ? HEAD_SIDE : HEAD_FRONT)), ...(chef ? BODY_CHEF : BODY)];
    if (pose === 'sit') rows = [...rows, ...LEGS.sit];
    else rows = [...rows, ...(pose === 'sideB' || pose === 'frontB' ? LEGS.b : LEGS.a)];
    if (chef) rows = [...HAT_TOP, ...rows];
    const key = `p|${chef}|${pose}|${look.skin}${look.hair}${look.shirt}${look.pants}`;
    return makeSprite(key, rows, {
      h: look.hair, s: look.skin, k: '#2a1d14', c: look.shirt, p: look.pants, o: '#2a1d14', w: '#ffffff', a: '#e0d6c8',
    });
  }

  /* 人を描く。足元が (x, foot) */
  function person(x, foot, look, { walk = 0, dir = 'h', sit = false, carry = null, chef = false, face = 1, scale = PX } = {}) {
    let pose = 'front';
    if (sit) pose = 'sit';
    else if (walk) {
      const b = Math.floor(walk * 7) % 2;
      pose = dir === 'h' ? (b ? 'sideB' : 'sideA') : (b ? 'frontB' : 'front');
    }
    rect(x - 4 * scale, foot - scale, 8 * scale, scale * 1.5, 'rgba(0,0,0,0.22)');   // 影
    const bob = walk && Math.floor(walk * 7) % 2 ? -1 : 0;
    drawSprite(personSprite(look, chef, pose), x, foot + bob, { flip: pose.startsWith('side') && face < 0, scale });
    if (carry) {
      const px = x + (face < 0 ? -10 : 10);
      rect(px - 6, foot - 15, 12, 3, '#f3ece2');
      rect(px - 4, foot - 18, 8, 3, carry.color);
    }
  }

  const CHEF_LOOK = { skin: '#f2c9a0', hair: '#3a2619', shirt: '#ffffff', pants: '#3b3b46' };
  // 料理の色（見分け用。ドット絵になったら料理ごとの絵にする）
  const dishColor = (d) => ['#e76f51', '#f4a261', '#e9c46a', '#8ab17d', '#c08457', '#d4a373'][d.ro.length % 6];

  const floats = [];   // 浮かぶ文字（+コインなど）
  function floatText(str, x, y, color = '#ffd166', suffix = ' 🪙') { floats.push({ str, x, y, t: 0, color, suffix }); }

  /* ===== 仕込み（PCのキーボード） ===== */
  // アルファベットの部分だけ（シンプルな初期のキーボード。スキンはショップで買う予定）
  const KU = 32;          // キー1個ぶんの幅
  const KEY_H = 28;
  const KB_X = 116;
  const KB_Y = 44;
  const KB_COLS = 10.75;  // 本体の幅（キー何個ぶん）
  const KB_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const KB_SHIFT = [0, 0.25, 0.75];
  const KEYS = [];
  const keyPos = {};
  KB_ROWS.forEach((row, r) => [...row].forEach((ch, i) => {
    const k = { label: ch, x: KB_X + (KB_SHIFT[r] + i) * KU, y: KB_Y + r * (KEY_H + 4), w: KU - 3, letter: true };
    KEYS.push(k);
    keyPos[ch] = { x: k.x + k.w / 2, y: k.y + KEY_H / 2 };
  }));
  const PREP_CHEF = { x: 54, foot: 148 };
  const flash = {};        // キーが光る残り時間
  const flyers = [];       // 料理人へ吸い込まれる文字
  let gulp = 0;            // 料理人が吸い込んだときの弾み
  const REST_CHEF = { x: 40, foot: 70 };

  /* 文字を飛ばす。キーボード画面はキーから料理人へ、レストラン画面は床から厨房の料理人へ */
  function spawnLetter(ch) {
    flash[ch] = 0.35;
    if (flyers.length > 50) return;
    if (view === 'eng') return;   // 工学の画面では文字を飛ばさない（数は裏で増える）
    const f = { ch, t: 0, dur: 0.55 + Math.random() * 0.25, rare: RARE.has(ch) };
    if (view === 'restaurant') {
      Object.assign(f, { sx: 160 + Math.random() * 280, sy: 150, tx: REST_CHEF.x, ty: REST_CHEF.foot - 16, dur: f.dur + 0.3 });
    } else {
      const k = keyPos[ch];
      Object.assign(f, { sx: k.x, sy: k.y, tx: PREP_CHEF.x, ty: PREP_CHEF.foot - 30 });
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
      text(f.ch, x + 1, y + 1, { size, bold: true, align: 'center', color: 'rgba(0,0,0,0.5)', font: 'Consolas, monospace' });
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

  // 机（木目）を一度だけ描いておく
  const deskBg = document.createElement('canvas');
  (() => {
    deskBg.width = W; deskBg.height = FLOOR;
    const g = deskBg.getContext('2d');
    for (let y = 0; y < FLOOR; y += 12) {
      g.fillStyle = (y / 12) % 2 ? '#7a5034' : '#80563a';
      g.fillRect(0, y, W, 12);
      g.fillStyle = 'rgba(0,0,0,0.12)';
      g.fillRect(0, y + 11, W, 1);
      for (let x = (y * 7) % 90; x < W; x += 90) g.fillRect(x, y + 4, 26, 1);   // 木目
    }
  })();

  function drawPrep(t, dt) {
    ctx.drawImage(deskBg, 0, 0);

    // 見出し
    text('仕込み中', 10, 16, { size: 13, bold: true });
    text('打った文字が', 10, 32, { size: 9, color: '#f0dcc4' });
    text('料理人に集まります', 10, 44, { size: 9, color: '#f0dcc4' });
    const pop = [...popular.ids].map((id) => DISH_BY_ID[id].ja).join('・');
    text(`本日の人気：${pop}`, KB_X, 18, { size: 10, bold: true, color: '#ffd166' });

    // キーボードの本体
    const bw = KB_COLS * KU + 14;
    const bh = 3 * (KEY_H + 4) + 10;
    rect(KB_X - 8, KB_Y - 6, bw, bh, '#1d1f24');
    rect(KB_X - 8, KB_Y - 6, bw, 2, '#3a3d45');
    rect(KB_X - 8, KB_Y - 6 + bh - 2, bw, 2, '#0f1013');

    // キー
    const max = Math.max(1, ...LETTERS.map((c) => state.letters[c]));
    for (const k of KEYS) {
      const ch = k.label;
      const n = state.letters[ch];
      const f = Math.max(0, flash[ch] || 0);
      flash[ch] = f - dt;
      const press = f > 0 ? 2 : 0;
      const rare = RARE.has(ch);
      rect(k.x, k.y, k.w, KEY_H, rare ? '#a8873a' : '#9d978e');                      // キーの側面
      rect(k.x, k.y + press, k.w, KEY_H - 4, rare ? '#f1d58a' : '#e9e5de');          // キーの上面
      // ためた数が多いほど色が濃くなる
      rect(k.x, k.y + press, k.w, KEY_H - 4, `rgba(231, 111, 81, ${0.45 * (n / max)})`);
      if (f > 0) rect(k.x, k.y + press, k.w, KEY_H - 4, `rgba(255,255,255,${Math.min(0.9, f * 2.5)})`);
      text(ch.toUpperCase(), k.x + 4, k.y + press + 13, { size: 12, bold: true, color: '#2d2925', font: 'Consolas, monospace' });
      text(String(n), k.x + k.w - 3, k.y + press + 23, { size: 9, align: 'right', color: n ? '#5a3a2a' : 'rgba(45,41,37,0.35)', font: 'Consolas, monospace' });
    }

    // 料理人（吸い込むと弾む）
    const bob = Math.sin(t * 2) * 0.8 - gulp * 4;
    glow(PREP_CHEF.x, PREP_CHEF.foot - 28);
    person(PREP_CHEF.x, PREP_CHEF.foot + bob, CHEF_LOOK, { chef: true, scale: 3 });
    drawFlyers(dt);
  }

  /* ===== 営業（お店を見下ろす） ===== */
  let serving = false;
  let unpaid = 0;              // まだ見た目で受け取っていない売上
  let orders = [];             // これから来るお客さんが頼む料理
  let served = 0;
  let totalOrders = 0;
  let guests = [];
  const TABLES = [[200, 70], [290, 70], [380, 70], [200, 122], [290, 122], [380, 122]]
    .map(([x, y]) => ({ x, y, guest: null, dish: null }));
  const AISLE_Y = 98;          // テーブルの列の間の通路
  const SPEED = 110;
  const kitchen = { cooking: null, t: 0 };
  let ready = [];              // できあがってカウンターに置かれた料理

  /* 営業の流れ:
   * 予約した皿の数だけお客さんが来て、カウンターから店の奥・右の壁ぞいに行列を作る。
   * 厨房は予約の料理を1皿ずつ作る（最初は10秒。🔪包丁で短くなる）。
   * できた料理は行列の先頭の人が受け取り、空いた席で食べ、しばらくしたら店を出る */
  const cookTime = () => upgValue('knife');
  const EAT_TIME = 6;
  const QUEUE = [[140, 86], [140, 42], [446, 42], [446, 150]];   // 行列の道すじ（先頭 → 最後尾）
  const QUEUE_GAP = 14;
  const EXIT = { x: 428, y: 178 };
  const QUEUE_LEN = QUEUE.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - QUEUE[i][0], p[1] - QUEUE[i][1]), 0);
  const QUEUE_MAX = Math.floor(QUEUE_LEN / QUEUE_GAP) + 1;   // 店の中に並べる人数
  let pending = 0;             // まだ店に入っていないお客さん
  let queue = [];              // 並んでいる人（先頭から）
  let spawnWait = 0;

  // 行列の道すじの上で、先頭から d の位置
  function queuePos(d) {
    for (let i = 1; i < QUEUE.length; i++) {
      const [ax, ay] = QUEUE[i - 1];
      const [bx, by] = QUEUE[i];
      const len = Math.hypot(bx - ax, by - ay);
      if (d <= len) return [ax + ((bx - ax) * d) / len, ay + ((by - ay) * d) / len, bx - ax, by - ay];
      d -= len;
    }
    const [x, y] = QUEUE[QUEUE.length - 1];
    return [x, y + d, 0, 1];   // 最後尾より後ろは入口の外
  }

  // 来るお客さんを決める。まずレア度を引いて、そのレア度の人から1人
  function pickGuest() {
    const roll = Math.random();
    const rarity = roll < RARITY_RATE[3] ? 3 : roll < RARITY_RATE[3] + RARITY_RATE[2] ? 2 : 1;
    const pool = GUESTS.filter((g) => g.rarity === rarity);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function startServe(rows) {
    orders = [];
    for (const { d, n } of rows) for (let i = 0; i < n; i++) orders.push(d);
    // 順番を混ぜる
    for (let i = orders.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [orders[i], orders[j]] = [orders[j], orders[i]];
    }
    totalOrders = orders.length;
    pending = orders.length;
    served = 0;
    unpaid = lastResult.total;
    guests = [];
    queue = [];
    ready = [];
    kitchen.cooking = null;
    TABLES.forEach((tb) => { tb.guest = null; tb.dish = null; });
    spawnWait = 0;
    serving = true;
    setView('restaurant');
  }

  function finishServe() {
    serving = false;
    unpaid = 0;
    orders = [];
    guests = [];
    queue = [];
    view = 'keyboard';
    open('result');
  }

  // 決めた道すじ（path）にそって歩く。着いたら true
  function moveAlong(e, dt) {
    let left = SPEED * dt;
    while (e.path.length && left > 0) {
      const [tx, ty] = e.path[0];
      const dx = tx - e.x;
      const dy = ty - e.y;
      const d = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5) e.face = Math.sign(dx);
      e.dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
      if (d <= left) { e.x = tx; e.y = ty; left -= d; e.path.shift(); }
      else { e.x += (dx / d) * left; e.y += (dy / d) * left; left = 0; }
    }
    const moving = e.path.length > 0;
    e.walk = moving ? (e.walk || 0) + dt : 0;
    return !moving;
  }

  const seatOf = (tb) => [tb.x - 21, tb.y + 4];          // お客さんは左の席

  function updateServe(dt) {
    // お客さんが入口から入ってきて、行列の最後に並ぶ
    spawnWait -= dt;
    if (pending > 0 && queue.length < QUEUE_MAX && spawnWait <= 0) {
      const type = pickGuest();
      const g = { type, look: type.look, state: 'queue', d: QUEUE_LEN + 40, path: [], face: -1, walk: 0 };
      [g.x, g.y] = queuePos(g.d);
      queue.push(g);
      guests.push(g);
      pending--;
      spawnWait = 0.35;
    }

    // 行列: 自分の場所（前の人の後ろ）まで道すじにそって進む
    queue.forEach((g, i) => {
      const target = i * QUEUE_GAP;
      if (g.d > target) {
        g.d = Math.max(target, g.d - SPEED * dt);
        const [x, y, dx, dy] = queuePos(g.d);
        g.x = x; g.y = y;
        g.dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
        if (dx) g.face = -Math.sign(dx);   // 道すじを逆向き（先頭へ）に歩く
        g.walk += dt;
      } else g.walk = 0;
    });

    // 厨房: 予約の料理を1皿ずつ時間をかけて作る
    if (!kitchen.cooking && orders.length) { kitchen.cooking = orders.shift(); kitchen.t = cookTime(); }
    if (kitchen.cooking) {
      kitchen.t -= dt;
      if (kitchen.t <= 0) { ready.push(kitchen.cooking); kitchen.cooking = null; }
    }

    // 先頭の人が料理を受け取って、空いている席へ
    const front = queue[0];
    const free = TABLES.filter((tb) => !tb.guest);
    if (front && front.d <= 0.5 && ready.length && free.length) {
      queue.shift();
      const tb = free[Math.floor(Math.random() * free.length)];
      const [sx, sy] = seatOf(tb);
      Object.assign(front, { state: 'toSeat', dish: ready.shift(), table: tb, path: [[QUEUE[0][0], AISLE_Y], [sx, AISLE_Y], [sx, sy]] });
      tb.guest = front;
    }

    for (let i = guests.length - 1; i >= 0; i--) {
      const g = guests[i];
      if (g.state === 'toSeat') {
        if (moveAlong(g, dt)) { g.state = 'eat'; g.t = EAT_TIME; g.face = 1; g.table.dish = g.dish; }
      } else if (g.state === 'eat') {
        g.t -= dt;
        if (g.t <= 0) {
          const price = sellPrice(g.dish);
          unpaid = Math.max(0, unpaid - price);
          served++;
          // 図鑑の「人」に記録。初めて来た人は名前を出す
          const first = !state.guestsSeen[g.type.id];
          state.guestsSeen[g.type.id] = (state.guestsSeen[g.type.id] || 0) + 1;
          if (first) floatText(`図鑑に追加：${'★'.repeat(g.type.rarity)} ${g.type.name}`, 300, 40, '#9ad1ff', '');
          floatText(`+${price}`, g.table.x, g.table.y - 18);
          g.table.dish = null;
          g.table.guest = null;
          g.state = 'leave';
          g.path = [[g.x, AISLE_Y], [EXIT.x, AISLE_Y], [EXIT.x, EXIT.y]];
          paintHud();
        }
      } else if (g.state === 'leave') {
        if (moveAlong(g, dt)) guests.splice(i, 1);
      }
    }

    if (!pending && !orders.length && !kitchen.cooking && !ready.length && !guests.length) finishServe();
  }

  function bubble(str, x, y) {
    ctx.font = '10px "Yu Gothic UI", sans-serif';
    const w = ctx.measureText(str).width + 10;
    rect(x - w / 2, y - 14, w, 16, '#fffaf0');
    rect(x - 2, y + 2, 4, 3, '#fffaf0');
    text(str, x, y - 2, { size: 10, align: 'center', color: '#3a2619' });
  }

  // 店の床・壁・厨房（動かない部分）は一度だけ描いておく
  const shopBg = document.createElement('canvas');
  (() => {
    shopBg.width = W; shopBg.height = FLOOR;
    const g = shopBg.getContext('2d');
    const r = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
    // 客席の床（板張り）
    for (let y = 22; y < FLOOR; y += 8) {
      r(124, y, W - 124, 8, (y / 8) % 2 ? '#a0704c' : '#96673f');
      for (let x = 124 + ((y / 8) % 3) * 22; x < W; x += 66) r(x, y, 1, 8, 'rgba(0,0,0,0.18)');
    }
    // 厨房の床（タイル）
    for (let y = 22; y < FLOOR; y += 12) {
      for (let x = 0; x < 124; x += 12) r(x, y, 12, 12, ((x + y) / 12) % 2 ? '#d8d2c4' : '#c7c0b0');
    }
    // 奥の壁
    r(0, 0, W, 22, '#6b4a33');
    r(0, 16, W, 6, '#4e3424');
    r(0, 0, W, 2, '#3a2619');
    // 窓
    for (const wx of [170, 420]) {
      r(wx, 3, 34, 12, '#9fc5d9');
      r(wx + 16, 3, 2, 12, '#6b4a33');
      r(wx, 3, 34, 2, '#cfe6f0');
    }
    // 看板
    r(8, 2, 104, 14, '#1f3a5f');
    r(8, 2, 104, 2, '#2d5080');
    // 左右の壁
    r(0, 22, 3, FLOOR - 22, '#4e3424');
    r(W - 3, 22, 3, FLOOR - 22, '#4e3424');
    // 厨房: コンロ・流し・冷蔵庫（上の面と前の面）
    r(6, 22, 40, 16, '#3b3b46'); r(6, 38, 40, 6, '#2a2a32');
    for (const bx of [12, 30]) { r(bx, 26, 8, 8, '#1c1c22'); r(bx + 2, 28, 4, 4, '#55555f'); }
    r(50, 22, 30, 16, '#b8bec6'); r(50, 38, 30, 6, '#8f959d'); r(56, 25, 18, 10, '#7d9cb3');
    r(84, 22, 22, 16, '#e6e9ec'); r(84, 38, 22, 6, '#c3c8cd'); r(102, 26, 2, 8, '#8f959d');
    // カウンター（厨房と客席の仕切り）
    r(112, 30, 16, 118, '#c08457');
    r(112, 30, 16, 2, '#d89a6a');
    r(112, 148, 16, 6, '#8b5a3c');
    r(127, 30, 1, 118, '#8b5a3c');
    // 入口のマット
    r(436, 148, 38, 8, '#6b2f1f');
    r(438, 150, 34, 4, '#8a3d28');
  })();

  function drawTable(tb) {
    const { x, y } = tb;
    // いす（左・右）
    for (const cx of [x - 26, x + 16]) { rect(cx, y - 6, 10, 8, '#7a4b2e'); rect(cx, y + 2, 10, 3, '#5c3d2e'); }
    // 天板と前の面
    rect(x - 15, y - 12, 30, 16, '#d49a68');
    rect(x - 15, y - 12, 30, 2, '#e6b386');
    rect(x - 15, y + 4, 30, 5, '#8b5a3c');
    if (tb.dish) {
      rect(x - 7, y - 7, 14, 6, '#f3ece2');
      rect(x - 4, y - 6, 8, 4, dishColor(tb.dish));
    }
  }

  function drawServe(t, dt) {
    ctx.drawImage(shopBg, 0, 0);
    text('うちこみ食堂', 60, 13, { size: 10, bold: true, align: 'center' });
    text(serving ? `営業中  ${served} / ${totalOrders} 皿` : '準備中（「営業する」で開店）', 300, 14, { size: 11, bold: true, align: 'center', color: '#ffd166' });

    // 厨房の料理人
    const cooking = !!kitchen.cooking;
    if (cooking) {
      for (let i = 0; i < 3; i++) rect(14 + i * 9, 22 - ((t * 24 + i * 6) % 14), 3, 3, 'rgba(255,255,255,0.7)');   // 湯気
      rect(28, 24, 12, 6, '#2b2b2b');   // フライパン
    }
    glow(REST_CHEF.x, REST_CHEF.foot - 14);
    const hop = cooking ? -Math.abs(Math.sin(t * 10)) * 2 : 0;
    person(REST_CHEF.x, REST_CHEF.foot + hop, CHEF_LOOK, { chef: true });

    // カウンターの料理
    ready.slice(0, 8).forEach((d, i) => {
      rect(114, 80 - i * 6, 12, 5, '#f3ece2');
      rect(116, 81 - i * 6, 8, 3, dishColor(d));
    });

    // テーブル・人を奥（上）から順に描く
    const items = TABLES.map((tb) => ({ y: tb.y + 2, draw: () => drawTable(tb) }));
    for (const g of guests) {
      const sit = g.state === 'eat';
      items.push({ y: g.y + (sit ? 3 : 0), draw: () => {
        person(g.x, g.y, g.look, { walk: sit ? 0 : g.walk, dir: g.dir, sit, face: g.face,
          carry: g.state === 'toSeat' ? { color: dishColor(g.dish) } : null });
        if (sit && Math.sin(t * 12) > 0) rect(g.x + 8, g.y - 14, 2, 2, '#ffffff');
        if (g.type && g.type.rarity >= 2) text('★'.repeat(g.type.rarity - 1), g.x, g.y - 26 + Math.sin(t * 4) * 1.5, { size: 8, bold: true, align: 'center', color: g.type.rarity === 3 ? '#ffd166' : '#d8dde6' });
      } });
    }
    items.sort((a, b) => a.y - b.y).forEach((it) => it.draw());

    // 店に入りきれずに外で待っている人
    if (serving && pending > 0) text(`ほか ${pending}人`, 432, 150, { size: 9, bold: true, align: 'right', color: '#ffd166' });
    if (cooking) {
      bubble(kitchen.cooking.ja, REST_CHEF.x + 20, REST_CHEF.foot - 30);
      // 調理の進み具合
      const k = 1 - Math.max(0, kitchen.t) / cookTime();
      rect(REST_CHEF.x - 18, REST_CHEF.foot + 4, 36, 5, '#2a1d14');
      rect(REST_CHEF.x - 17, REST_CHEF.foot + 5, 34 * k, 3, '#7bc47f');
      text(`${Math.max(0, kitchen.t).toFixed(1)}秒`, REST_CHEF.x + 22, REST_CHEF.foot + 10, { size: 8, color: '#3a2619' });
    }
    drawFlyers(dt);   // 営業中に打った文字も料理人へ集まる
  }

  /* ===== ⚙ 工学（見下ろしの作業場） ===== */
  const machinePop = {};   // 設置・強化したときの弾み（枠ごと）
  /* マップ（Rusty's Retirement を参考に、水路と道で区画が分かれた土地）。
   * 横に長いのでホイール・ドラッグで横にスクロールする。
   * 区画A（倉庫のある最初の土地）→ 区画B → 区画C の順に枠が開いていく */
  const MAP_W = 720;
  const ENG_ROAD = 98;                 // 作業員が歩く道
  const STORE = { x: 54, y: ENG_ROAD };
  const SLOTS = [[150, 82], [70, 146], [162, 146], [262, 82], [372, 82], [318, 146], [552, 82], [626, 146]];
  const WATER_X = [200, 470];          // 縦の水路
  const slotPos = (i) => ({ cx: SLOTS[i][0], foot: SLOTS[i][1] });
  let engCam = 0;
  const camMax = () => MAP_W - W;
  const clampCam = (v) => Math.max(0, Math.min(camMax(), v));
  function slotAt(x, y) {
    const mx = x + engCam;
    for (let i = 0; i < ENG_SLOTS_MAX; i++) {
      const { cx, foot } = slotPos(i);
      if (mx >= cx - 38 && mx <= cx + 38 && y >= foot - 48 && y <= foot + 6) return i;
    }
    return -1;
  }
  function showSlot(i) {
    const { cx } = slotPos(i);
    if (cx - engCam < 50 || cx - engCam > W - 50) engCam = clampCam(cx - W / 2);
  }

  // 地面・水路・道・倉庫・飾り（動かない部分）は一度だけ描く
  const engBg = document.createElement('canvas');
  (() => {
    engBg.width = MAP_W; engBg.height = FLOOR;
    const g = engBg.getContext('2d');
    const r = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    // 草地
    r(0, 0, MAP_W, FLOOR, '#5b8c3a');
    for (let i = 0; i < 900; i++) r(Math.floor(rnd() * MAP_W / 2) * 2, Math.floor(rnd() * FLOOR / 2) * 2, 2, 2, rnd() < 0.5 ? '#68994a' : '#4f7d33');
    for (let i = 0; i < 120; i++) {   // 草のふさ
      const x = Math.floor(rnd() * MAP_W / 2) * 2; const y = Math.floor(rnd() * FLOOR / 2) * 2;
      r(x, y, 2, 4, '#7bb057'); r(x + 2, y - 2, 2, 4, '#7bb057');
    }
    // 道（土）
    r(0, ENG_ROAD - 7, MAP_W, 14, '#a07c52');
    r(0, ENG_ROAD - 7, MAP_W, 2, '#7f603e');
    r(0, ENG_ROAD + 5, MAP_W, 2, '#7f603e');
    for (let i = 0; i < 160; i++) r(Math.floor(rnd() * MAP_W / 2) * 2, ENG_ROAD - 4 + Math.floor(rnd() * 4) * 2, 2, 2, rnd() < 0.5 ? '#b08c60' : '#8f6d47');
    // 水路（縦）と池
    const water = (x, y, w, h) => {
      r(x - 2, y, w + 4, h, '#3f6a3a');           // 岸
      r(x, y, w, h, '#3b6f9a');
      r(x, y, 2, h, '#2d5577'); r(x + w - 2, y, 2, h, '#2d5577');
      for (let yy = y + 4; yy < y + h; yy += 10) r(x + 3 + ((yy / 10) % 2) * 3, yy, 4, 1, '#6a9ec8');
    };
    for (const wx of WATER_X) water(wx, 0, 14, FLOOR);
    water(640, 22, 62, 40);
    water(392, 116, 56, 30);
    // 橋（道が水路をまたぐところ）
    for (const wx of WATER_X) {
      r(wx - 4, ENG_ROAD - 9, 22, 18, '#9c6b3f');
      for (let x = wx - 4; x < wx + 18; x += 4) r(x, ENG_ROAD - 9, 1, 18, '#7a5030');
      r(wx - 4, ENG_ROAD - 10, 22, 2, '#6b4426'); r(wx - 4, ENG_ROAD + 8, 22, 2, '#6b4426');
    }
    // 倉庫（区画Aの左上）
    r(10, 18, 84, 22, '#6d7d96');                 // 屋根
    r(10, 18, 84, 3, '#8a9ab3');
    r(50, 18, 4, 22, '#596a82');
    r(14, 40, 76, 30, '#8a7a66');                 // 壁
    r(40, 50, 26, 20, '#3a2c22');                 // 入口
    r(42, 52, 22, 2, '#5a4636');
    r(20, 46, 12, 8, '#9fc5d9'); r(74, 46, 12, 8, '#9fc5d9');
    r(54, 70, 4, ENG_ROAD - 77, '#a07c52');      // 入口から道まで
    // 飾り（花・しげみ・石）
    const flower = (x, y, c) => { r(x, y, 2, 2, c); r(x + 3, y + 2, 2, 2, c); r(x - 2, y + 3, 2, 2, c); r(x + 1, y + 4, 1, 3, '#3f6a2a'); };
    const bush = (x, y) => { r(x, y + 2, 16, 8, '#3f6a2a'); r(x + 2, y, 12, 8, '#4f8a36'); r(x + 4, y + 1, 4, 2, '#6aa84a'); };
    const rock = (x, y) => { r(x, y, 10, 6, '#8d9290'); r(x + 2, y - 2, 6, 2, '#a5aaa8'); r(x, y + 6, 10, 2, '#5f6462'); };
    [[110, 20, '#f4a6c0'], [118, 26, '#ffd166'], [236, 24, '#ffffff'], [430, 24, '#f4a6c0'], [500, 130, '#ffd166'],
      [520, 26, '#ffffff'], [700, 120, '#f4a6c0'], [26, 120, '#ffd166'], [300, 24, '#e76f51'], [680, 80, '#ffffff']]
      .forEach(([x, y, c]) => { flower(x, y, c); flower(x + 8, y + 5, c); });
    [[104, 124], [226, 132], [452, 20], [664, 108], [8, 82]].forEach(([x, y]) => bush(x, y));
    [[188, 30], [420, 60], [596, 30], [700, 140], [230, 60]].forEach(([x, y]) => rock(x, y));
  })();

  // 作業員（施設1つにつき1人）。倉庫と施設を行き来して機械を動かす（見た目だけ）
  const WORKER_LOOK = { skin: '#f2c9a0', hair: '#5c3d2e', shirt: '#3f6a99', pants: '#2c3e50' };
  const workers = {};
  function updateWorkers(dt) {
    state.eng.slots.forEach((s, i) => {
      if (!s || i >= state.eng.slotCount) { delete workers[i]; return; }
      if (!workers[i]) workers[i] = { x: STORE.x, y: STORE.y, path: [], state: 'go', t: 0, face: 1, slot: i };
    });
    for (const w of Object.values(workers)) {
      const { cx, foot } = slotPos(w.slot);
      const spot = [cx + 30, foot + 2];
      if (w.state === 'go' && !w.path.length && (w.x !== spot[0] || w.y !== spot[1])) {
        w.path = [[w.x, ENG_ROAD], [spot[0], ENG_ROAD], spot];
      }
      if (w.state === 'go') {
        if (moveAlong(w, dt * 0.6)) { w.state = 'work'; w.t = 3 + Math.random() * 3; w.face = -1; }
      } else if (w.state === 'work') {
        w.t -= dt;
        if (w.t <= 0) { w.state = 'carry'; w.path = [[w.x, ENG_ROAD], [STORE.x, STORE.y]]; }
      } else if (w.state === 'carry') {
        if (moveAlong(w, dt * 0.6)) { w.state = 'store'; w.t = 0.8; }
      } else if (w.state === 'store') {
        w.t -= dt;
        if (w.t <= 0) w.state = 'go';
      }
    }
  }

  // マップの操作: 枠をクリックして選ぶ／ホイール・ドラッグで横スクロール
  let drag = null;
  canvas.addEventListener('mousedown', (ev) => {
    if (view !== 'eng') return;
    drag = { x: ev.clientX, cam: engCam, moved: false };
  });
  window.addEventListener('mouseup', () => { setTimeout(() => { drag = null; }, 0); });
  canvas.addEventListener('wheel', (ev) => {
    if (view !== 'eng') return;
    ev.preventDefault();
    engCam = clampCam(engCam + (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY) * 0.6);
  }, { passive: false });
  canvas.addEventListener('click', (ev) => {
    if (view !== 'eng' || !state.eng.unlocked || (drag && drag.moved)) return;
    const r = canvas.getBoundingClientRect();
    const i = slotAt(ev.clientX - r.left, ev.clientY - r.top);
    if (i < 0 || i > state.eng.slotCount) return;   // 買える枠は次の1つだけ
    engSel = i;
    if (openPanel !== 'eng') open('eng'); else renderPanel();
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (drag && view === 'eng' && ev.buttons & 1) {
      const dx = ev.clientX - drag.x;
      if (Math.abs(dx) > 4) drag.moved = true;
      engCam = clampCam(drag.cam - dx);
    }
    const r = canvas.getBoundingClientRect();
    const i = view === 'eng' && state.eng.unlocked ? slotAt(ev.clientX - r.left, ev.clientY - r.top) : -1;
    canvas.style.cursor = i >= 0 && i <= state.eng.slotCount ? 'pointer' : (view === 'eng' ? 'grab' : 'default');
  });

  // 箱（上の面と前の面）
  function box(x, y, w, top, front, cTop, cFront) {
    rect(x, y, w, top, cTop);
    rect(x, y, w, 2, 'rgba(255,255,255,0.25)');
    rect(x, y + top, w, front, cFront);
    rect(x, y + top + front - 2, w, 2, 'rgba(0,0,0,0.25)');
  }

  // 施設の絵（足元が foot、真ん中が cx）
  function drawMachine(id, cx, foot, t) {
    rect(cx - 28, foot - 3, 56, 4, 'rgba(0,0,0,0.25)');
    if (id === 'converter') {
      box(cx - 26, foot - 34, 52, 14, 20, '#5f8fc4', '#3f6a99');
      box(cx - 22, foot - 44, 14, 8, 6, '#9fc5e8', '#6f9cc6');    // 入れ口
      box(cx + 8, foot - 44, 14, 8, 6, '#9fc5e8', '#6f9cc6');     // 出口
      rect(cx - 16, foot - 16, 32, 10, '#14202c');
      const ch = 'aiueo'[Math.floor(t * 2) % 5];
      const out = 'kstnhmr'[Math.floor(t * 2) % 7];
      text(`${ch}→${out}`, cx, foot - 8, { size: 9, align: 'center', color: '#7bc47f', font: 'Consolas, monospace' });
    } else if (id === 'refiner') {
      box(cx - 24, foot - 36, 48, 14, 22, '#8d6fb8', '#644a8c');
      box(cx + 8, foot - 50, 10, 6, 10, '#6d6f78', '#4b4d55');    // えんとつ
      for (let i = 0; i < 2; i++) rect(cx + 11 + i * 3, foot - 54 - ((t * 14 + i * 7) % 12), 4, 4, 'rgba(220,220,230,0.6)');
      const fl = 0.6 + Math.sin(t * 9) * 0.3;
      rect(cx - 14, foot - 18, 20, 12, '#2a1a1a');
      rect(cx - 12, foot - 14, 16, 8, `rgba(255, 150, 60, ${fl})`);
      rect(cx - 18, foot - 44, 8, 2, '#ffd166'); rect(cx - 20, foot - 42, 12, 2, '#ffd166'); rect(cx - 18, foot - 40, 8, 2, '#e9a93a');
    } else if (id === 'spice') {
      box(cx - 26, foot - 26, 34, 10, 16, '#7fb07a', '#5a8a55');
      box(cx + 10, foot - 40, 16, 10, 30, '#c9d6c7', '#9fb09c');  // タンク
      rect(cx + 6, foot - 20, 4, 3, '#9aa3b2');
      for (let i = 0; i < 3; i++) {
        const bx = cx - 22 + i * 10;
        rect(bx, foot - 34, 6, 8, ['#e76f51', '#e9c46a', '#f3ece2'][i]);
        rect(bx + 1, foot - 36, 4, 2, '#5c3d2e');
      }
    } else if (id === 'tower') {
      box(cx - 12, foot - 16, 24, 6, 10, '#c0574a', '#8f3a30');
      rect(cx - 2, foot - 52, 4, 38, '#9aa3b2');
      rect(cx + 2, foot - 56, 6, 10, '#e76f51');
      rect(cx + 8, foot - 58, 4, 14, '#e76f51');
      const w = (t * 2) % 1;
      ctx.globalAlpha = 1 - w;
      rect(cx + 14 + w * 14, foot - 56 - w * 4, 2, 10 + w * 8, '#ffd166');
      ctx.globalAlpha = 1;
    } else if (id === 'washer') {
      box(cx - 22, foot - 36, 44, 10, 26, '#e6eef2', '#b9c8d0');
      ctx.fillStyle = '#3d6e86';
      ctx.beginPath(); ctx.arc(cx, foot - 15, 9, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 3; i++) {
        const a = t * 3 + i * 2.1;
        rect(cx + Math.cos(a) * 5 - 1, foot - 15 + Math.sin(a) * 5 - 1, 3, 3, '#bfe7f5');
      }
      rect(cx + 12, foot - 32, 6, 3, '#7bc47f');
    } else if (id === 'prepper') {
      box(cx - 20, foot - 24, 40, 10, 14, '#e9c46a', '#c09a3c');
      const arm = Math.sin(t * 4) * 4;
      rect(cx - 2, foot - 44 + arm, 4, 22 - arm, '#6d6f78');
      box(cx - 8, foot - 50 + arm, 16, 6, 6, '#f4d58d', '#c09a3c');   // 頭
      rect(cx - 4, foot - 46 + arm, 2, 2, '#2a1d14'); rect(cx + 2, foot - 46 + arm, 2, 2, '#2a1d14');
      if (Math.sin(t * 4) > 0.8) text('+', cx + 14, foot - 30, { size: 10, bold: true, color: '#ffd166' });
    }
  }

  function drawEng(t, dt) {
    if (!state.eng.unlocked) {
      ctx.drawImage(engBg, 0, 0);
      rect(0, 0, W, FLOOR, 'rgba(0,0,0,0.5)');
      text('🔒 工学はまだ使えません', W / 2, 80, { size: 14, bold: true, align: 'center' });
      text(`🔧 店の設備から 🪙 ${ENGINEERING_COST.toLocaleString()} で購入するとアンロック`, W / 2, 102, { size: 11, align: 'center', color: '#d8c8b0' });
      return;
    }
    const e = state.eng;
    updateWorkers(dt);

    ctx.save();
    ctx.translate(-R(engCam), 0);
    ctx.drawImage(engBg, 0, 0);
    text('倉庫', 52, 66, { size: 8, bold: true, align: 'center', color: '#f3ece2' });

    const items = [];
    for (let i = 0; i < ENG_SLOTS_MAX; i++) {
      const { cx, foot } = slotPos(i);
      const s = e.slots[i];
      const x = cx - 34;
      const y = foot - 40;
      if (i >= e.slotCount) {
        // まだ使えない土地（草ぼうぼう）
        rect(x + 4, y + 4, 60, 32, 'rgba(40,70,30,0.45)');
        if (i === e.slotCount) {
          rect(cx - 1, foot - 30, 2, 22, '#7a5030');                 // 立て札
          rect(cx - 16, foot - 34, 32, 12, '#c99560');
          text('＋', cx, foot - 25, { size: 10, bold: true, align: 'center', color: '#3a2619' });
          text('枠を増やす', cx, foot + 2, { size: 8, bold: true, align: 'center', color: '#f3ece2' });
        } else {
          text('🔒', cx, foot - 14, { size: 10, align: 'center' });
        }
      } else if (!s) {
        // 空き枠（石の土台）
        rect(x + 2, y + 6, 64, 32, '#7d8279');
        rect(x + 4, y + 8, 60, 28, '#969b91');
        for (let gx = x + 4; gx < x + 64; gx += 12) rect(gx, y + 8, 1, 28, 'rgba(0,0,0,0.12)');
        rect(x + 2, y + 36, 64, 3, '#5f645c');
        text('＋ 空き', cx, foot - 15, { size: 10, bold: true, align: 'center', color: 'rgba(255,255,255,0.75)' });
      } else {
        const pop = Math.max(0, machinePop[i] || 0);
        machinePop[i] = pop - dt * 2;
        const f = FACILITIES.find((q) => q.id === s.fac);
        rect(x + 2, y + 6, 64, 33, '#7d8279');   // 土台
        items.push({ y: foot, draw: () => {
          drawMachine(s.fac, cx, foot - pop * 6, t + i);
          for (let l = 0; l < s.lv; l++) rect(cx - 26 + l * 6, foot - 1, 4, 3, '#ffd166');   // レベルの印
          text(f.name, cx, foot + 9, { size: 8, bold: true, align: 'center', color: '#f3ece2' });
        } });
      }
      // 選んでいる枠
      if (engSel === i && openPanel === 'eng' && Math.sin(t * 6) > -0.3) {
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 2, y - 8, 72, 50);
        ctx.lineWidth = 1;
      }
    }
    for (const w of Object.values(workers)) {
      items.push({ y: w.y, draw: () => {
        const working = w.state === 'work';
        const hop = working ? -Math.abs(Math.sin(t * 8 + w.slot)) * 2 : 0;
        person(w.x, w.y + hop, WORKER_LOOK, { walk: w.path.length ? w.walk : 0, dir: w.dir, face: w.face,
          carry: w.state === 'carry' ? { color: '#b07d4a' } : null });
        if (working && Math.sin(t * 8 + w.slot) > 0.7) rect(w.x - 12, w.y - 18, 3, 3, '#ffd166');   // 火花
      } });
    }
    items.sort((a, b) => a.y - b.y).forEach((it) => it.draw());
    // 水のきらめき
    for (let k = 0; k < 4; k++) {
      const wx = WATER_X[k % 2] + 4 + ((k * 5) % 6);
      const wy = ((t * 18 + k * 40) % FLOOR);
      rect(wx, wy, 2, 2, 'rgba(255,255,255,0.6)');
    }
    ctx.restore();

    // 画面に固定する表示（見出し・スクロールの目印）
    const used = e.slots.slice(0, e.slotCount).filter(Boolean).length;
    rect(0, 0, 210, 20, 'rgba(20,28,16,0.6)');
    text(`工学  枠 ${used} / ${e.slotCount}`, 8, 14, { size: 11, bold: true });
    text('ドラッグ・ホイールで移動', 104, 14, { size: 8, color: '#d8e6c8' });
    if (engCam > 2) text('◀', 6, 100, { size: 14, bold: true, color: 'rgba(255,255,255,0.8)' });
    if (engCam < camMax() - 2) text('▶', W - 18, 100, { size: 14, bold: true, color: 'rgba(255,255,255,0.8)' });
    const bw = (W / MAP_W) * W;
    rect(0, FLOOR - 3, W, 3, 'rgba(0,0,0,0.3)');
    rect((engCam / MAP_W) * W, FLOOR - 3, bw, 3, 'rgba(255,255,255,0.6)');
  }

  function drawFloats(dt) {
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.t += dt;
      ctx.globalAlpha = Math.max(0, 1 - f.t / 1.4);
      text(`${f.str}${f.suffix}`, f.x, f.y - f.t * 22, { size: 13, bold: true, align: 'center', color: f.color });
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
        // 描画の回数が少なくても時間どおりに進むよう、0.05秒ずつ刻んで進める。
        // 別の画面を見ている間も営業は裏で続く。食器洗浄機があると速くなる
        const speed = 1 + facLv('washer') * 0.15;
        for (let left = step; left > 0 && serving; left -= 0.05) updateServe(Math.min(0.05, left) * speed);
      }
      if (view === 'restaurant') drawServe(now / 1000, step);
      else if (view === 'eng') drawEng(now / 1000, step);
      else drawPrep(now / 1000, step);
      drawFloats(step);
    }
    requestAnimationFrame(frame);
  }

  paintHud();
  requestAnimationFrame(frame);
  if (!state.introSeen) open('intro');
})();
