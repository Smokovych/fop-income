// КЕП у браузері: відкриває файловий ключ (.pfx, .jks, Key-6.dat) і підписує текст (CAdES-BES, ДСТУ 4145, ГОСТ 34.311).
// Збирається в standalone/vendor/kep.bundle.js скриптом build-kep.sh. Ключ і пароль ніде не зберігаються й не надсилаються.
import { Buffer } from "buffer";
import gost89 from "gost89";
import * as jk from "./node_modules/jkurwa/lib/index.js";
import * as cmp from "./node_modules/jkurwa/lib/services/cmp.js";

// Сервери CMP кваліфікованих надавачів (з реєстру IIT CAs.json, жовтень 2026). Без шляху — стандартний /services/cmp/.
const CMP_HOSTS = ["ca.monobank.ua/services/cmp/", "acsk.privatbank.ua", "ca.diia.gov.ua", "ca.tax.gov.ua", "ca.depositsign.com",
  "ca.vchasno.ua", "uakey.com.ua", "masterkey.ua", "pki.pumb.ua", "csk.ukrsibbank.com", "ca.sensebank.com.ua", "ca.credit-agricole.ua",
  "amokey.com.ua", "ca.edin.ua", "cmp.e-life.com.ua/api/PKI/CMP", "ca.bankalliance.ua/cmp", "qca.ukrgasbank.com/cmp", "ca.pravex.com.ua",
  "ca.tascombank.ua", "csk.uss.gov.ua", "csk.uz.gov.ua", "acsk.oree.com.ua", "canbu.bank.gov.ua", "ca.mil.gov.ua", "acsk.dpsu.gov.ua",
  "ca.ngu.gov.ua", "ca.mvs.gov.ua", "ca.szru.gov.ua", "ca.gp.gov.ua/cmp", "va1-knedp.ssu.gov.ua/services/cmp/"];
export const CMP_URLS = CMP_HOSTS.map((h) => "http://" + (h.includes("/") ? h : h + "/services/cmp/"));

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
  const info = { hasCert: false, cert: null, certB64: null };
  const pick = () => {
    try { signKey = box.keyFor("sign"); } catch (e) { signKey = null; }
    info.hasCert = !!signKey;
    info.cert = signKey ? certInfo(signKey.cert) : null;
    info.certB64 = signKey ? Buffer.from(signKey.cert.as_asn1()).toString("base64") : null;
  };
  pick();
  return {
    info,
    /** Додає сертифікати (base64 DER); повертає true, якщо з'явилась пара ключ+сертифікат для підпису. */
    addCerts(list) {
      for (const b64 of list || []) { try { box.load({ cert: jk.Certificate.from_asn1(Buffer.from(b64, "base64")) }); } catch (e) { /* не наш формат */ } }
      pick();
      return info.hasCert;
    },
    /**
     * Шукає сертифікат ключа на серверах надавачів (CMP), як це робить сайт Кабінету.
     * post(url, bodyB64) → Promise<{ status, bodyB64 }> — запит іде через міст (браузер сам не може).
     */
    async findCert(post, urls) {
      const keyids = box.keys.filter((k) => k.priv).map((k) => k.priv.pub().keyid(box.algo));
      const query = (method, url, headers, payload, cb) => post(url, Buffer.from(payload).toString("base64"))
        .then((r) => cb(r.bodyB64 ? Buffer.from(r.bodyB64, "base64") : Buffer.alloc(0), r.status), () => cb(Buffer.alloc(0), 0));
      const tryUrl = (url) => cmp.lookup(keyids, url, query).then((certs) => {
        const ids = keyids.map((k) => k.toString("hex"));
        const own = certs.filter((c) => ids.includes(c.extension.subjectKeyIdentifier.toString("hex")));
        if (!own.length) throw new Error("not ours");
        return { url, certs: own };
      });
      const list = urls || CMP_URLS;
      // спершу найпоширеніші (monobank, Приват, Дія, ДПС), далі решта паралельно
      for (const group of [list.slice(0, 4), list.slice(4)]) {
        const found = await Promise.any(group.map(tryUrl)).catch(() => null);
        if (found) {
          for (const c of found.certs) box.load({ cert: c });
          pick();
          return { url: found.url, ok: info.hasCert, certs: found.certs.map((c) => Buffer.from(c.as_asn1()).toString("base64")) };
        }
      }
      return { ok: false };
    },
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
