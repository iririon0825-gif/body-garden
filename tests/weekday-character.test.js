// HOME人物（yuraRi）の曜日別画像。weekdayCharacterImage(day) は Date に依存しない純粋関数として
// 分離されているため、0〜6を直接与えてテストする（OS日時を変える必要がない）

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv } = require("./helpers");

function setup() {
  const env = loadEnv();
  return { fn: env.get("weekdayCharacterImage"), IMAGE_ASSETS: env.get("IMAGE_ASSETS") };
}

const EXPECTED = {
  0: "assets/body-garden/yurari-sun.png",
  1: "assets/body-garden/yurari-mon.png",
  2: "assets/body-garden/yurari-tue.png",
  3: "assets/body-garden/yurari-wed.png",
  4: "assets/body-garden/yurari-thu.png",
  5: "assets/body-garden/yurari-fri.png",
  6: "assets/body-garden/yurari-sat.png",
};

for (const [day, expected] of Object.entries(EXPECTED)) {
  test(`weekdayCharacterImage(${day}): 正しい曜日画像を返す`, () => {
    const { fn } = setup();
    assert.equal(fn(Number(day)), expected);
  });
}

test("weekdayCharacterImage: 0〜6の7日ぶん、すべて異なるファイルを指す", () => {
  const { fn } = setup();
  const paths = [0, 1, 2, 3, 4, 5, 6].map((d) => fn(d));
  assert.equal(new Set(paths).size, 7, "7枚とも別ファイル");
});

test("weekdayCharacterImage: 想定外の入力（7, -1, null, undefined）は従来画像にフォールバックする", () => {
  const { fn, IMAGE_ASSETS } = setup();
  for (const bad of [7, -1, null, undefined, NaN]) {
    assert.equal(fn(bad), IMAGE_ASSETS.decoYurariFigure, `入力 ${bad} はフォールバック`);
  }
});

test("水曜日（3）の画像だけがエニシャ入りという前提に矛盾しない（他の曜日とファイル名が異なる）", () => {
  const { fn } = setup();
  const wed = fn(3);
  assert.equal(wed, "assets/body-garden/yurari-wed.png");
  for (const d of [0, 1, 2, 4, 5, 6]) assert.notEqual(fn(d), wed);
});
