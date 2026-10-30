// Тести злиття змін з різних пристроїв (standalone/remote.js): node tests/merge.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");

const code = fs.readFileSync(path.join(__dirname, "..", "standalone", "remote.js"), "utf8");
const ctx = {
  document: { querySelector: () => null },
  localStorage: { getItem: () => "dev", setItem() {} },
  randomKey: () => "0123456789abcdef",
};
vm.createContext(ctx);
vm.runInContext(code + "\nthis.merge3 = merge3; this.mergeLog = mergeLog;", ctx);
const { merge3, mergeLog } = ctx;
const clone = (x) => JSON.parse(JSON.stringify(x));

let n = 0;
function test(name, fn) { fn(); n++; console.log("ok -", name); }

const base = {
  settings: { owner_name: "Іван", esv_enabled: true },
  connections: [{ id: 1, name: "Mono", token: "t" }],
  accounts: { "mono:a": { id: "mono:a", enabled: true, is_fop: true, loaded_from: 100 } },
  tx: { "mono:1": { id: "mono:1", amount: 100, manual_category: null }, "mono:2": { id: "mono:2", amount: 200, manual_category: null } },
  rules: [{ id: 1, pattern: "позик" }],
};

test("зміни різних операцій з двох пристроїв обидві зберігаються", () => {
  const ours = clone(base), theirs = clone(base);
  ours.tx["mono:1"].manual_category = "own_transfer";
  theirs.tx["mono:2"].manual_category = "loan";
  theirs.tx["mono:3"] = { id: "mono:3", amount: 300 };
  merge3(base, ours, theirs);
  assert.equal(ours.tx["mono:1"].manual_category, "own_transfer");
  assert.equal(ours.tx["mono:2"].manual_category, "loan");
  assert.equal(ours.tx["mono:3"].amount, 300);
});

test("об'єкти змінюються на місці (синхронізація, що йде, не губить рахунок)", () => {
  const ours = clone(base), theirs = clone(base);
  const acc = ours.accounts["mono:a"];
  theirs.accounts["mono:a"].is_fop = false;
  merge3(base, ours, theirs);
  assert.equal(ours.accounts["mono:a"], acc);
  assert.equal(acc.is_fop, false);
  acc.loaded_from = 50;
  assert.equal(ours.accounts["mono:a"].loaded_from, 50);
});

test("видалення на іншому пристрої застосовується", () => {
  const ours = clone(base), theirs = clone(base);
  theirs.connections = [];
  delete theirs.accounts["mono:a"];
  delete theirs.tx["mono:1"];
  theirs.rules = [];
  merge3(base, ours, theirs);
  assert.equal(JSON.stringify(ours.connections), "[]");
  assert.equal(ours.accounts["mono:a"], undefined);
  assert.equal(ours.tx["mono:1"], undefined);
  assert.equal(JSON.stringify(ours.rules), "[]");
});

test("нові правила з обох пристроїв об'єднуються", () => {
  const ours = clone(base), theirs = clone(base);
  ours.rules.push({ id: 1700000000001, pattern: "a" });
  theirs.rules.push({ id: 1700000000002, pattern: "b" });
  merge3(base, ours, theirs);
  assert.equal(JSON.stringify(ours.rules.map((r) => r.pattern).sort()), JSON.stringify(["a", "b", "позик"]));
});

test("одне й те саме поле змінили обидва — перемагає цей пристрій", () => {
  const ours = clone(base), theirs = clone(base);
  ours.settings.owner_name = "Наш";
  theirs.settings.owner_name = "Їхній";
  theirs.settings.esv_enabled = false;
  merge3(base, ours, theirs);
  assert.equal(ours.settings.owner_name, "Наш");
  assert.equal(ours.settings.esv_enabled, false);
});

test("без бази (перше збереження) — дані сервера додаються до наших", () => {
  const ours = clone(base), theirs = { tx: { "mono:9": { id: "mono:9", amount: 9 } } };
  merge3({}, ours, theirs);
  assert.equal(ours.tx["mono:9"].amount, 9);
  assert.equal(ours.tx["mono:1"].amount, 100);
});

test("журнал об'єднується без дублікатів, від нових до старих", () => {
  const l = mergeLog([{ ts: 2, message: "b" }, { ts: 1, message: "a" }], [{ ts: 3, message: "c" }, { ts: 1, message: "a" }]);
  assert.equal(l.map((x) => x.message).join(), "c,b,a");
});

console.log(`${n} тестів пройдено`);
