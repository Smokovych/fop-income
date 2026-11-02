// ============================================================ Фіскальні чеки (ПРРО, фіскальний сервер ДПС)
// Дані збирає сервер (app/node/worker.js, команда "fiscal") ключем КЕП, збереженим на сервері, і кладе в S.fiscal:
//   registrars: {фіскальний номер ПРРО: {name, object, address, loaded_from, loaded_to}}
//   shifts:     {ShiftId: {reg, opened, closed, cashier, z}}
//   checks:     {фіскальний номер чека: {reg, shift, dt, type, sum, pays[], items[], cashier, url, revoked, storned}}

const FC = { year: null, month: "", reg: "", type: "", q: "", open: null, shown: 200, polling: null };
const FC_TYPE = (c) => (/return/i.test(c.type) || c.doctype === 0 && c.subtype === 1 ? "return" : "sale");
const fcDate = (c) => {
  if (c.date && /^\d{8}$/.test(c.date)) return `${c.date.slice(4)}-${c.date.slice(2, 4)}-${c.date.slice(0, 2)}`;
  return String(c.dt || "").slice(0, 10);
};
const fcTime = (c) => (c.time && /^\d{6}$/.test(c.time) ? `${c.time.slice(0, 2)}:${c.time.slice(2, 4)}` : String(c.dt || "").slice(11, 16));

const chekiv = (n) => { const a = n % 10, b = n % 100; return `${n} ${a === 1 && b !== 11 ? "чек" : a >= 2 && a <= 4 && (b < 12 || b > 14) ? "чеки" : "чеків"}`; };
function fiscalChecks() {
  const f = S.fiscal && S.fiscal.checks;
  return f ? Object.values(f) : [];
}

function loadFiscal() {
  const F = S.fiscal || {};
  const all = fiscalChecks();
  const years = [...new Set([new Date().getFullYear(), ...all.map((c) => +fcDate(c).slice(0, 4)).filter(Boolean)])].sort((a, b) => b - a);
  if (!FC.year) FC.year = years[0];
  $("#fc-year").innerHTML = years.map((y) => `<option ${y === FC.year ? "selected" : ""}>${y}</option>`).join("");
  $("#fc-month").innerHTML = `<option value="">Усі місяці</option>` + MONTHS_NOM.map((m, i) => `<option value="${String(i + 1).padStart(2, "0")}" ${FC.month === String(i + 1).padStart(2, "0") ? "selected" : ""}>${m}</option>`).join("");
  const regs = Object.values(F.registrars || {});
  $("#fc-reg").innerHTML = `<option value="">Усі каси</option>` + regs.map((r) => `<option value="${esc(r.id)}" ${FC.reg === r.id ? "selected" : ""}>${esc(r.name || r.id)}${r.object ? " · " + esc(r.object) : ""}</option>`).join("");
  // стан завантаження
  const loadedFrom = regs.length ? regs.map((r) => r.loaded_from || "").sort()[regs.length - 1] : null;
  $("#fc-status").innerHTML = !SERVER_MODE ? `<span class="warn">Фіскальні чеки завантажує сервер — відкрийте серверну версію програми.</span>`
    : F.error ? `<span class="error">${esc(F.error)}</span>`
    : F.fetched_at ? `Кас: ${regs.length} · чеків: ${all.length}${loadedFrom && loadedFrom <= kyivDate(nowTs()) ? ` · завантажено з ${fmtDate(loadedFrom)}` : ""} · оновлено ${new Date(F.fetched_at * 1000).toLocaleString("uk-UA")}${F.more ? " · <b>довантажую історію…</b>" : ""}`
    : "Чеки ще не завантажувались. Натисніть «Оновити з фіскального сервера».";

  const sel = all.filter((c) => {
    const d = fcDate(c);
    if (!d.startsWith(FC.year + "-") || (FC.month && d.slice(5, 7) !== FC.month)) return false;
    if (FC.reg && c.reg !== FC.reg) return false;
    if (FC.type && FC_TYPE(c) !== FC.type) return false;
    if (FC.q) {
      const hay = norm([c.fn, c.cashier, ...(c.items || []).map((i) => i.name)].join(" "));
      if (!hay.includes(norm(FC.q))) return false;
    }
    return true;
  }).sort((a, b) => (fcDate(b) + fcTime(b)).localeCompare(fcDate(a) + fcTime(a)));
  // підсумки: продажі, повернення, за формами оплати
  const valid = sel.filter((c) => !c.revoked && !c.storned);
  const sale = valid.filter((c) => FC_TYPE(c) === "sale"), ret = valid.filter((c) => FC_TYPE(c) === "return");
  const sum = (l) => l.reduce((a, c) => a + (c.sum || 0), 0);
  const forms = {};
  for (const c of sale) for (const p of c.pays || []) forms[p.form || "Інше"] = (forms[p.form || "Інше"] || 0) + (p.sum || 0);
  $("#fc-kpis").innerHTML = [
    ["Продажі", money(sum(sale)), chekiv(sale.length)],
    ["Повернення", money(sum(ret)), chekiv(ret.length)],
    ["Разом", money(sum(sale) - sum(ret)), Object.entries(forms).map(([k, v]) => `${k}: ${money(v)}`).join(" · ") || "—"],
  ].map(([l, v, sub]) => `<div class="kpi"><div class="label">${esc(l)}</div><div class="value">${v}</div><div class="sub">${esc(sub)}</div></div>`).join("");

  const regName = (id) => { const r = (F.registrars || {})[id]; return r ? r.name || id : id; };
  const rows = sel.slice(0, FC.shown).map((c) => {
    const open = FC.open === c.fn, isRet = FC_TYPE(c) === "return";
    const pay = (c.pays || []).map((p) => p.form).filter(Boolean).join(", ");
    return `<tr class="fc-row${open ? " open" : ""}${c.revoked || c.storned ? " fc-void" : ""}" data-fn="${esc(c.fn)}">
        <td class="td-date">${fmtDate(fcDate(c))}<div class="muted small">${esc(fcTime(c))}</div></td>
        <td><span class="caret">${open ? "▾" : "▸"}</span>№ ${esc(c.fn)}${isRet ? ' <span class="badge danger-badge">повернення</span>' : ""}${c.storned ? ' <span class="muted small">сторновано</span>' : ""}${c.revoked ? ' <span class="muted small">відкликано</span>' : ""}
          <div class="muted small">${esc(regName(c.reg))}${c.cashier ? " · " + esc(c.cashier) : ""}</div></td>
        <td class="small">${esc(pay)}</td>
        <td class="num"><b class="${isRet ? "neg" : ""}">${isRet ? "−" : ""}${c.sum != null ? money(c.sum) : "—"}</b></td></tr>`
      + (open ? `<tr class="fc-detail"><td colspan="4">${fcDetail(c)}</td></tr>` : "");
  }).join("");
  $("#fc-table").innerHTML = `<thead><tr><th>Дата</th><th>Чек</th><th>Оплата</th><th class="num">Сума</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="muted">Чеків за вибраний період немає</td></tr>`}</tbody>`;
  $("#fc-more").classList.toggle("hidden", sel.length <= FC.shown);
  $("#fc-count").textContent = sel.length ? `Чеків: ${sel.length}` : "";
}

function fcDetail(c) {
  const items = (c.items || []).map((i) => `<tr><td>${esc(i.name || "")}</td><td class="num">${i.qty != null ? nf.format(i.qty).replace(/,00$/, "") : ""} ${esc(i.unit || "")}</td>
    <td class="num">${i.price != null ? money(i.price) : ""}</td><td class="num">${i.cost != null ? money(i.cost) : ""}</td></tr>`).join("");
  const pays = (c.pays || []).map((p) => `${esc(p.form || "")}: <b>${money(p.sum || 0)}</b>`).join(" · ");
  return `${c.error ? `<p class="error small">Не вдалося завантажити зміст чека: ${esc(c.error)}</p>` : ""}
    <div class="table-wrap"><table class="table fc-items"><thead><tr><th>Товар / послуга</th><th class="num">Кількість</th><th class="num">Ціна</th><th class="num">Сума</th></tr></thead>
      <tbody>${items || `<tr><td colspan="4" class="muted">Позицій немає</td></tr>`}</tbody></table></div>
    <p class="small">${pays ? "Оплата — " + pays : ""}${c.point ? ` · ${esc(c.point)}` : ""} · зміна ${esc(c.shift || "")}${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">Чек в Електронному кабінеті ↗</a>` : ""}</p>`;
}

async function refreshFiscal() {
  if (!SERVER_MODE) return toast("Фіскальні чеки завантажує сервер — відкрийте серверну версію програми", true);
  const btn = $("#btn-fc-refresh");
  await flushRemote();
  const r = await api("POST", "/api/fiscal/refresh", "{}");
  if (!r.ok) return toast(r.data.error || "Не вдалося запустити оновлення", true);
  toast(r.data.started ? "Сервер завантажує чеки — вони з'являтимуться по мірі завантаження" : "Сервер зараз зайнятий іншим оновленням — спробуйте за хвилину");
  if (!r.data.started) return;
  btn.disabled = true; btn.textContent = "Завантажую…";
  // опитуємо стан, поки сервер працює
  clearInterval(FC.polling);
  FC.polling = setInterval(async () => {
    const st = await api("GET", "/api/server-status").catch(() => null);
    await pollRemote(true);
    if (activeTab === "fiscal") loadFiscal();
    if (!st || !st.ok || st.data.bg.running !== "fiscal") {
      clearInterval(FC.polling);
      btn.disabled = false; btn.textContent = "Оновити з фіскального сервера";
      if (activeTab === "fiscal") loadFiscal();
    }
  }, 5000);
}

function initFiscalTab() {
  $("#btn-fc-refresh").addEventListener("click", refreshFiscal);
  $("#fc-year").addEventListener("change", (e) => { FC.year = +e.target.value; FC.shown = 200; loadFiscal(); });
  $("#fc-month").addEventListener("change", (e) => { FC.month = e.target.value; FC.shown = 200; loadFiscal(); });
  $("#fc-reg").addEventListener("change", (e) => { FC.reg = e.target.value; loadFiscal(); });
  $("#fc-type").addEventListener("change", (e) => { FC.type = e.target.value; loadFiscal(); });
  $("#fc-q").addEventListener("input", (e) => { FC.q = e.target.value; loadFiscal(); });
  $("#fc-more").addEventListener("click", () => { FC.shown += 200; loadFiscal(); });
  $("#fc-table").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const tr = e.target.closest("tr.fc-row");
    if (!tr) return;
    FC.open = FC.open === tr.dataset.fn ? null : tr.dataset.fn;
    loadFiscal();
  });
}
