// Тести бібліотеки КЕП (standalone/vendor/kep.bundle.js): node tests/kep.test.js
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert/strict");
const ctx = { console, crypto: globalThis.crypto, TextEncoder, TextDecoder }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "standalone", "vendor", "kep.bundle.js"), "utf8"), ctx);
const K = ctx.FopKep, fx = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, "data", "kep", f)));
let n = 0; const test = async (name, fn) => { await fn(); n++; console.log("ok -", name); };
const fake = (subject, ipn, bytes) => ({ subject, extension: { ipn }, as_asn1: () => Buffer.from(bytes || []) });
const drfo = (tin, v = 1) => [0x30, 0x1e, 0x06, 0x0c, 0x2a, 0x86, 0x24, 0x02, 0x01, 0x01, 0x01, 0x0b, 0x01, 0x04, v, 0x01, 0x31, 0x0e, 0x13, 0x0a, ...Buffer.from(tin)];
(async () => {
  await test("РНОКПП з розширення ДРФО (розібраного бібліотекою)", () => assert.equal(K._certTin(fake({}, { DRFO: "1234567890" })), "1234567890"));
  await test("РНОКПП із serialNumber TINUA-…", () => assert.equal(K._certTin(fake({ serialNumber: "TINUA-2345678901" }, null)), "2345678901"));
  await test("РНОКПП з байтів сертифіката (ДРФО .4.1.1 і .4.7.1)", () => {
    assert.equal(K._certTin(fake({}, null, [0x30, 0x00, ...drfo("3456789012")])), "3456789012");
    assert.equal(K._certTin(fake({}, null, drfo("4567890123", 7))), "4567890123");
  });
  await test("TINUA- у байтах", () => assert.equal(K._certTin(fake({ serialNumber: "UA-1" }, null, Buffer.from("xxTINUA-5678901234yy"))), "5678901234"));
  await test("немає РНОКПП → null", () => assert.equal(K._certTin(fake({ serialNumber: "1058" }, null, [1, 2, 3])), null));
  await test("PFX без сертифіката: ключ відкривається, сертифікат знаходиться через CMP", async () => {
    const k = K.openKey([fx("key.pfx")], "test-pass");
    assert.equal(k.info.hasCert, false);
    const resp = fs.readFileSync(path.join(__dirname, "data", "kep", "cmp_resp.b64"), "utf8");
    const r = await k.findCert(async (url) => ({ status: url.includes("monobank") ? 200 : 404, bodyB64: url.includes("monobank") ? resp : "" }));
    assert.equal(r.ok, true);
    const v = await K.verify(await k.sign("1234567890", 1540236305));
    assert.equal(v.signed, true); assert.equal(v.content, "1234567890");
  });
  await test("невірний пароль", () => assert.throws(() => K.openKey([fx("key.pfx")], "wrong"), /пароль/));
  console.log(`${n} тестів пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
