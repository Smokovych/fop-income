// КЕП у браузері: відкриває файловий ключ (.pfx, .jks, Key-6.dat) і підписує текст (CAdES-BES, ДСТУ 4145, ГОСТ 34.311).
// Збирається в standalone/vendor/kep.bundle.js скриптом build-kep.sh. Ключ і пароль ніде не зберігаються й не надсилаються.
import { Buffer } from "buffer";
import gost89 from "gost89";
import * as jk from "./node_modules/jkurwa/lib/index.js";

function makeBox() {
  const a = gost89.compat.algos();
  return new jk.Box({ algo: Object.assign({}, a, { hashes: { Gost34311: a.hash, Dstu4145le: a.hash } }) });
}

function certInfo(cert) {
  const s = cert.subject || {}, ext = cert.extension || {}, ipn = ext.ipn || {};
  const tin = ipn.DRFO || (String(s.serialNumber || "").match(/TINUA-(\d{10})/) || [])[1] || null;
  return {
    name: s.commonName || [s.surname, s.givenName].filter(Boolean).join(" ") || null,
    org: s.organizationName || null,
    tin,
    edrpou: ipn.EDRPOU || null,
    issuer: (cert.issuer || {}).organizationName || (cert.issuer || {}).commonName || null,
    validFrom: cert.valid && cert.valid.from ? new Date(cert.valid.from).toISOString() : null,
    validTo: cert.valid && cert.valid.to ? new Date(cert.valid.to).toISOString() : null,
  };
}

/** keyFiles — масив Uint8Array: файл ключа і, за потреби, файли сертифікатів (.cer). */
export function openKey(keyFiles, password) {
  const box = makeBox();
  const keyBuffers = [], certs = [];
  for (const f of keyFiles) {
    const b = Buffer.from(f);
    let cert = null;
    try { cert = jk.Certificate.from_asn1(b); } catch (e) {
      try { cert = jk.Certificate.from_pem(b); } catch (e2) { cert = null; }
    }
    if (cert) certs.push(cert); else keyBuffers.push(b);
  }
  if (!keyBuffers.length) throw new Error("Не знайдено файлу ключа — оберіть файл .pfx, .jks або Key-6.dat");
  try {
    box.load({ keyBuffers, password });
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/password|Cant load key|Cant parse store|decrypt|mac/i.test(m)) throw new Error("Не вдалося відкрити ключ. Перевірте пароль (розкладка, Caps Lock).");
    throw new Error("Не вдалося прочитати файл ключа: " + m);
  }
  for (const cert of certs) box.load({ cert });
  if (!box.keys.some((k) => k.priv)) throw new Error("У файлі не знайдено особистого ключа. Можливо, це ключ не за ДСТУ 4145 (напр. ECDSA) — такі поки не підтримуються.");
  let signKey = null;
  try { signKey = box.keyFor("sign"); } catch (e) { signKey = null; }
  return {
    info: { hasCert: !!signKey, cert: signKey ? certInfo(signKey.cert) : null },
    async sign(text, time) {
      if (!signKey) {
        const err = new Error("У файлі ключа немає сертифіката для підпису. Додайте файл сертифіката (.cer) разом із ключем.");
        err.code = "NOCERT";
        throw err;
      }
      const der = await box.pipe(Buffer.from(String(text), "utf8"), [{ op: "sign", time: time || Math.floor(Date.now() / 1000) }], {});
      return Buffer.from(der).toString("base64");
    },
  };
}

/** Перевіряє підпис так, як це зробить отримувач: за сертифікатом, вкладеним у підпис. */
export async function verify(b64) {
  const res = await makeBox().unwrap(Buffer.from(b64, "base64"));
  const p = res.pipe[0] || {};
  return { signed: p.signed === true && !res.error, error: res.error || null,
    content: p.signed ? Buffer.from(res.content).toString("utf8") : null,
    signer: p.cert ? (p.cert.subject || {}).commonName || null : null };
}
