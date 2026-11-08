/* ゲームのデータと、売値の計算。バランス調整はこのファイルで行う。
 * 設計書: 宝物庫/タイピング常駐ゲーム/06_料理リスト_日本.md */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

/* ローマ字入力で日本語を打ったときの文字の出現率（%・推定）。
 * 実際の打鍵を集めたら、その数字に差し替える。 */
const FREQ = {
  a: 12, i: 11, o: 10, u: 9, n: 8, k: 6, e: 5, t: 5, s: 4, r: 4, h: 3.5, m: 3,
  y: 2, d: 2, g: 2, w: 1.5, z: 1, b: 1, c: 0.8, p: 0.5, j: 0.5, f: 0.3,
  l: 0.05, v: 0.05, x: 0.05, q: 0.02,
};

/* 1文字の価値 = √(a の出現率 ÷ その文字の出現率)。a=1.0、打たれにくい文字ほど高い */
const LETTER_VALUE = {};
for (const ch of LETTERS) LETTER_VALUE[ch] = Math.round(Math.sqrt(FREQ.a / FREQ[ch]) * 10) / 10;

/* 高級食材（日本語入力ではあまり打たれない文字） */
const RARE = new Set(['c', 'f', 'j', 'l', 'q', 'v', 'x']);

/* 料理: [ローマ字, 日本語名, 実際の値段の目安(円)]
 * 綴り: 海外のメニュー表記、伸ばす音は書かない、shi・chi・ji・fu */
const DISH_ROWS = {
  japan: [
  ["sushi", "すし", 1500],
  ["onigiri", "おにぎり", 150],
  ["udon", "うどん", 500],
  ["soba", "そば", 600],
  ["ramen", "ラーメン", 900],
  ["tempura", "天ぷら", 1200],
  ["tonkatsu", "とんかつ", 1200],
  ["karaage", "唐揚げ", 700],
  ["yakitori", "焼き鳥", 400],
  ["misoshiru", "味噌汁", 150],
  ["gyudon", "牛丼", 450],
  ["oyakodon", "親子丼", 800],
  ["katsudon", "カツ丼", 900],
  ["tendon", "天丼", 1000],
  ["unadon", "うな丼", 3500],
  ["kaisendon", "海鮮丼", 1800],
  ["ikuradon", "いくら丼", 2500],
  ["sashimi", "刺身", 1500],
  ["sukiyaki", "すき焼き", 3000],
  ["shabushabu", "しゃぶしゃぶ", 3000],
  ["okonomiyaki", "お好み焼き", 900],
  ["takoyaki", "たこ焼き", 500],
  ["yakisoba", "焼きそば", 600],
  ["gyoza", "餃子", 400],
  ["nikujaga", "肉じゃが", 600],
  ["oden", "おでん", 600],
  ["tamagoyaki", "卵焼き", 400],
  ["dashimaki", "だし巻き卵", 500],
  ["chawanmushi", "茶碗蒸し", 400],
  ["natto", "納豆", 100],
  ["tofu", "豆腐", 150],
  ["edamame", "枝豆", 300],
  ["yakiniku", "焼肉", 2500],
  ["omuraisu", "オムライス", 900],
  ["kareraisu", "カレーライス", 800],
  ["hayashiraisu", "ハヤシライス", 900],
  ["korokke", "コロッケ", 200],
  ["menchikatsu", "メンチカツ", 300],
  ["ebifurai", "エビフライ", 1100],
  ["hanbagu", "ハンバーグ", 1100],
  ["naporitan", "ナポリタン", 800],
  ["tsukemen", "つけ麺", 950],
  ["somen", "そうめん", 600],
  ["hiyashichuka", "冷やし中華", 850],
  ["zarusoba", "ざるそば", 700],
  ["kitsuneudon", "きつねうどん", 600],
  ["tanukisoba", "たぬきそば", 600],
  ["nabeyakiudon", "鍋焼きうどん", 900],
  ["yudofu", "湯豆腐", 800],
  ["mizutaki", "水炊き", 2500],
  ["motsunabe", "もつ鍋", 1800],
  ["chankonabe", "ちゃんこ鍋", 2500],
  ["yosenabe", "寄せ鍋", 2000],
  ["ochazuke", "お茶漬け", 500],
  ["zosui", "雑炊", 600],
  ["okayu", "おかゆ", 400],
  ["takikomigohan", "炊き込みご飯", 400],
  ["sekihan", "赤飯", 400],
  ["inarizushi", "いなり寿司", 300],
  ["makizushi", "巻き寿司", 600],
  ["temakizushi", "手巻き寿司", 800],
  ["chirashizushi", "ちらし寿司", 1200],
  ["sabanomisoni", "サバの味噌煮", 900],
  ["sakenoshioyaki", "鮭の塩焼き", 800],
  ["teriyaki", "照り焼き", 900],
  ["nizakana", "煮魚", 1000],
  ["kabayaki", "蒲焼き", 2500],
  ["shogayaki", "生姜焼き", 900],
  ["kakuni", "角煮", 900],
  ["tonjiru", "豚汁", 300],
  ["kenchinjiru", "けんちん汁", 300],
  ["nikuman", "肉まん", 250],
  ["kushikatsu", "串カツ", 600],
  ["yakionigiri", "焼きおにぎり", 250],
  ["hiyayakko", "冷奴", 300],
  ["kinpira", "きんぴら", 300],
  ["hijiki", "ひじき", 300],
  ["tsukemono", "漬物", 300],
  ["umeboshi", "梅干し", 150],
  ["agedashidofu", "揚げ出し豆腐", 500],
  ["tamagokakegohan", "卵かけご飯", 350],
  ["monjayaki", "もんじゃ焼き", 1000],
  ["ikayaki", "いか焼き", 500],
  ["dango", "団子", 150],
  ["mochi", "餅", 150],
  ["daifuku", "大福", 200],
  ["dorayaki", "どら焼き", 200],
  ["taiyaki", "たい焼き", 200],
  ["anmitsu", "あんみつ", 700],
  ["warabimochi", "わらび餅", 500],
  ["imoni", "芋煮", 700],
  ["hoto", "ほうとう", 1100],
  ["kishimen", "きしめん", 700],
  ["misokatsu", "味噌カツ", 1200],
  ["tebasaki", "手羽先", 600],
  ["hitsumabushi", "ひつまぶし", 4000],
  ["goyachanpuru", "ゴーヤチャンプルー", 900],
  ["sokisoba", "ソーキそば", 900],
  ["jingisukan", "ジンギスカン", 2000],
  ["kamameshi", "釜飯", 1300],
  ["ohagi", "おはぎ", 200],
  ],
};

const COUNTRIES = [
  { id: 'japan', name: '日本', flag: '🇯🇵' },
];

/* 値段の補正の幅。主役は文字なので、実際の値段は少し差をつける程度 */
const REAL_PRICE_MIN = 0.9;
const REAL_PRICE_MAX = 1.1;

/* 料理の一覧を作る。売値 = 文字の価値の合計 × 値段の補正 × 10 */
const DISHES = (() => {
  const list = [];
  for (const c of COUNTRIES) {
    for (const [ro, ja, real] of DISH_ROWS[c.id]) list.push({ id: ro, ro, ja, real, country: c.id });
  }
  const reals = list.map((d) => d.real).sort((a, b) => a - b);
  const mid = reals.length % 2
    ? reals[(reals.length - 1) / 2]
    : (reals[reals.length / 2 - 1] + reals[reals.length / 2]) / 2;

  for (const d of list) {
    d.need = {};
    for (const ch of d.ro) d.need[ch] = (d.need[ch] || 0) + 1;
    d.letterValue = [...d.ro].reduce((s, ch) => s + LETTER_VALUE[ch], 0);
    const adj = Math.min(REAL_PRICE_MAX, Math.max(REAL_PRICE_MIN, Math.sqrt(d.real / mid)));
    d.price = Math.round(d.letterValue * adj * 10);
    d.rare = [...new Set(d.ro)].filter((ch) => RARE.has(ch));
  }
  return list;
})();

const DISH_BY_ID = Object.fromEntries(DISHES.map((d) => [d.id, d]));

/* ① 店の設備強化。強化するほど値段が大きく上がる（数字は遊びながら調整） */
const UPGRADES = [
  {
    id: 'fridge', name: '冷蔵庫', icon: '🧊',
    desc: 'ためておける文字の数',
    value: (lv) => 300 + lv * 100,
    unit: '文字',
    cost: (lv) => Math.round(500 * Math.pow(2.2, lv)),
  },
  {
    id: 'stove', name: '調理台', icon: '🔥',
    desc: '1回の営業で作れる料理の数',
    value: (lv) => 20 + lv * 5,
    unit: '皿',
    cost: (lv) => Math.round(800 * Math.pow(2.3, lv)),
  },
  {
    id: 'knife', name: '包丁', icon: '🔪',
    desc: '1皿を作る時間',
    value: (lv) => Math.round(10 * Math.pow(0.85, lv) * 10) / 10,
    unit: '秒',
    cost: (lv) => Math.round(600 * Math.pow(2.3, lv)),
  },
  {
    id: 'sign', name: '看板', icon: '🏮',
    desc: 'すべての料理の売値',
    value: (lv) => 100 + lv * 10,
    unit: '%',
    cost: (lv) => Math.round(1000 * Math.pow(2.5, lv)),
  },
];

/* ② 日替わりの人気料理。現実の時間で入れ替える（入れ替わる時刻は仮） */
const POPULAR_COUNT = 3;
const POPULAR_BONUS = 1.5;
const DAY_START_HOUR = 5;

/* ⚙ 工学。強化の欄で買うとアンロックされ、その中の施設をさらに買っていく。
 * 数字は遊びながら調整する（仮） */
const ENGINEERING_COST = 5000;
const FAC_MAX_LV = 5;
const VOWELS = ['a', 'i', 'u', 'e', 'o'];

const FACILITIES = [
  {
    id: 'converter', name: '文字変換機', icon: '🔄', kind: '文字の変換',
    rate: (lv) => Math.max(2, 6 - lv),                 // 母音 何個で 1文字
    desc: (lv) => `母音（a・i・u・e・o）${Math.max(2, 6 - lv)}個 → 好きな普通の文字1個`,
    cost: (lv) => Math.round(1500 * Math.pow(2.0, lv)),
  },
  {
    id: 'refiner', name: '高級変換炉', icon: '💎', kind: '文字の変換',
    rate: (lv) => Math.max(8, 24 - lv * 4),             // 普通の文字 何個で 高級1文字
    desc: (lv) => `普通の文字${Math.max(8, 24 - lv * 4)}個 → 好きな高級食材1個`,
    cost: (lv) => Math.round(3000 * Math.pow(2.2, lv)),
  },
  {
    id: 'spice', name: '調味料工場', icon: '🧂', kind: '利益率',
    desc: (lv) => `全料理の売値 +${lv * 5}%`,
    cost: (lv) => Math.round(2500 * Math.pow(2.3, lv)),
  },
  {
    id: 'tower', name: '宣伝塔', icon: '📣', kind: '利益率',
    desc: (lv) => `日替わり人気料理の売値 ×${(1.5 + lv * 0.1).toFixed(1)}`,
    cost: (lv) => Math.round(2000 * Math.pow(2.2, lv)),
  },
  {
    id: 'washer', name: '食器洗浄機', icon: '🫧', kind: '便利',
    desc: (lv) => `営業のスピード +${lv * 15}%`,
    cost: (lv) => Math.round(1500 * Math.pow(2.0, lv)),
  },
  {
    id: 'prepper', name: '自動仕込み機', icon: '🤖', kind: '資源',
    desc: (lv) => `a〜z を100打つごとに、ランダムな文字 +${lv}個`,
    cost: (lv) => Math.round(3000 * Math.pow(2.3, lv)),
  },
];

/* 工学のマップ。空き枠に施設を建てる。枠はお金で増やす（いずれショップ・ステージ報酬でも増やす） */
const ENG_SLOTS_MAX = 8;
const ENG_SLOTS_START = 3;
const slotCost = (count) => Math.round(3000 * Math.pow(1.8, count - ENG_SLOTS_START));   // count = 今の枠の数
// 同じ施設を建てられる数。効果は同じ施設のレベルの合計で決まる
const FAC_LIMIT = { converter: 2, refiner: 1, spice: 2, tower: 1, washer: 2, prepper: 3 };
const REMOVE_REFUND = 0.5;   // 撤去したときに戻るお金（かけた額の割合）
