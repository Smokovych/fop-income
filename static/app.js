"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
const money = (v) => nf.format(v || 0) + " ₴";
const moneyShort = (v) => Math.abs(v) >= 1e6 ? nf.format(v / 1e6) + " млн" : Math.abs(v) >= 1e3 ? nf0.format(v / 1e3) + " тис" : nf0.format(v);
const fmtDate = (iso) => iso ? iso.split("-").reverse().join(".") : "";
const MONTHS = ["Січ", "Лют", "Бер", "Кві", "Тра", "Чер", "Лип", "Сер", "Вер", "Жов", "Лис", "Гру"];
const CUR = { UAH: "₴", USD: "$", EUR: "€", GBP: "£", PLN: "zł" };

const state = { year: new Date().getFullYear(), categories: {}, txOffset: 0, txLimit: 100 };

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers["Content-Type"] = "application/json";
  }
  const r = await fetch(path, init);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login") { showLogin(); throw new Error("Потрібен вхід"); }
  if (!r.ok) throw new Error(data.error || `Помилка ${r.status}`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), isError ? 6000 : 3000);
}

// ---------------------------------------------------------------- auth

function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#login-password").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/login", { method: "POST", body: { password: $("#login-password").value } });
    $("#login").classList.add("hidden");
    start();
  } catch (err) { $("#login-error").textContent = err.message; }
});

$("#btn-logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: {} });
  showLogin();
});

// ---------------------------------------------------------------- tabs

const loaders = { overview: loadOverview, transactions: () => loadTransactions(true), banks: loadBanks, rules: loadRules, settings: loadSettings };

function openTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + name));
  history.replaceState(null, "", "#" + name);
  loaders[name]?.();
}
$("#tabs").addEventListener("click", (e) => { if (e.target.dataset.tab) openTab(e.target.dataset.tab); });
addEventListener("hashchange", () => { const t = location.hash.slice(1); if (t in loaders) openTab(t); });

// ---------------------------------------------------------------- overview

async function loadOverview() {
  const s = await api(`/api/summary?year=${state.year}`);
  const years = new Set([...s.years.map(Number), new Date().getFullYear(), state.year]);
  $("#year-select").innerHTML = [...years].sort((a, b) => b - a).map((y) => `<option ${y === state.year ? "selected" : ""}>${y}</option>`).join("");
  $("#empty-hint").classList.toggle("hidden", s.accounts.length > 0);

  const curQ = Math.floor(new Date().getMonth() / 3) + 1;
  const isCur = state.year === new Date().getFullYear();
  const q = s.quarters[(isCur ? curQ : 4) - 1];
  $("#kpis").innerHTML = [
    ["Дохід за " + state.year, money(s.total_income), `${s.months.reduce((a, m) => a + m.count, 0)} надходжень`],
    [`Дохід за ${q.quarter} кв.`, money(q.net_income), isCur ? "поточний квартал" : ""],
    [`Єдиний податок ${s.params.single_tax_rate}% за рік`, money(s.single_tax_total), `за ${q.quarter} кв.: ${money(q.single_tax)}`],
    [`Військовий збір ${s.params.mil_rate}% за рік`, money(s.military_total), s.esv_enabled ? `ЄСВ: ${money(s.params.esv_month)}/міс` : "ЄСВ не сплачується"],
  ].map(([l, v, sub]) => `<div class="kpi"><div class="label">${esc(l)}</div><div class="value">${v}</div><div class="sub">${esc(sub)}</div></div>`).join("");

  const pct = Math.min(100, s.limit_used_pct);
  const fill = $("#limit-fill");
  fill.style.width = pct + "%";
  fill.className = s.limit_used_pct >= 100 ? "over" : s.limit_used_pct >= 80 ? "high" : "";
  $("#limit-text").textContent = `${nf.format(s.limit_used_pct)}% · ${money(s.total_income)} з ${money(s.limit)} · залишок ${money(Math.max(0, s.limit_left))}`;
  const warn = $("#limit-warn");
  if (s.over_limit > 0) {
    warn.textContent = `Ліміт перевищено на ${money(s.over_limit)}. Із суми перевищення сплачується 15% (${money(s.over_limit_tax)}), а з наступного кварталу потрібно перейти на загальну систему оподаткування — зверніться до бухгалтера.`;
    warn.classList.remove("hidden");
  } else if (s.limit_used_pct >= 80) {
    warn.textContent = `Використано понад 80% річного ліміту. Стежте за надходженнями.`;
    warn.classList.remove("hidden");
  } else warn.classList.add("hidden");
  if (s.params.assumed) {
    warn.textContent = `Податкові параметри для ${state.year} року не задано — використано параметри попереднього року. Оновіть їх у «Налаштуваннях».`;
    warn.classList.remove("hidden");
  }

  drawChart(s.months);

  $("#upcoming").innerHTML = s.upcoming.length ? s.upcoming.map((u) => `
    <li class="${u.days_left <= 10 ? "soon" : ""}">
      <div><div class="date">${fmtDate(u.date)}</div><div class="days">${u.days_left === 0 ? "сьогодні" : "через " + u.days_left + " дн."}</div></div>
      <div style="flex:1">${esc(u.title)}</div>
      <div class="amt">${u.amount != null ? money(u.amount) : ""}</div>
    </li>`).join("") : `<li class="muted">Немає</li>`;

  const qs = s.quarters;
  $("#quarters").innerHTML = `
    <thead><tr><th>Квартал</th><th class="num">Дохід</th><th class="num">Повернення</th><th class="num">Наростаючим</th>
      <th class="num">ЄП ${s.params.single_tax_rate}%</th><th class="num">ВЗ ${s.params.mil_rate}%</th><th class="num">ЄСВ</th>
      <th>Декларація до</th><th>Сплата ЄП/ВЗ до</th></tr></thead>
    <tbody>${qs.map((q) => `<tr>
      <td>${q.quarter} кв.</td><td class="num">${money(q.income)}</td><td class="num">${q.refunds ? money(-q.refunds) : "—"}</td>
      <td class="num">${money(q.cumulative)}</td><td class="num">${money(q.single_tax)}</td><td class="num">${money(q.military)}</td>
      <td class="num">${money(q.esv)}</td><td>${fmtDate(q.deadlines.declaration)}</td><td>${fmtDate(q.deadlines.single_tax)}</td></tr>`).join("")}
    </tbody>
    <tfoot><tr><td>Рік</td><td class="num">${money(qs.reduce((a, q) => a + q.income, 0))}</td>
      <td class="num">${money(-qs.reduce((a, q) => a + q.refunds, 0))}</td><td class="num">${money(s.total_income)}</td>
      <td class="num">${money(s.single_tax_total)}</td><td class="num">${money(s.military_total)}</td>
      <td class="num">${money(qs.reduce((a, q) => a + q.esv, 0))}</td><td></td><td></td></tr></tfoot>`;

  const mr = $("#missing-rates");
  mr.classList.toggle("hidden", !s.missing_rates);
  mr.textContent = `${s.missing_rates} валютних операцій ще без курсу НБУ — вони не враховані. Курси доберуться при наступному оновленні.`;
}

$("#year-select").addEventListener("change", (e) => { state.year = Number(e.target.value); loadOverview(); });

function drawChart(months) {
  const el = $("#chart");
  const W = Math.max(320, el.clientWidth || 600), H = 260, padL = 52, padR = 8, padT = 16, padB = 26;
  const max = Math.max(...months.map((m) => m.income - m.refunds), 1);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const colW = (W - padL - padR) / 12;
  const barW = Math.min(36, colW * 0.6);
  let grid = "";
  for (let v = 0; v <= top + 1e-9; v += step) {
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end" class="axis-t">${moneyShort(v)}</text>`;
  }
  const best = months.reduce((b, m, i) => (m.income - m.refunds > months[b].income - months[b].refunds ? i : b), 0);
  const cols = months.map((m, i) => {
    const v = Math.max(0, m.income - m.refunds);
    const x = padL + colW * i + (colW - barW) / 2;
    const h = Math.max(0, y(0) - y(v));
    const r = Math.min(4, h);
    const path = h > 0 ? `M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + barW - r} Q${x + barW},${y(v)} ${x + barW},${y(v) + r} V${y(0)} Z` : "";
    const label = i === best && v > 0 ? `<text class="val" x="${x + barW / 2}" y="${y(v) - 6}" text-anchor="middle">${moneyShort(v)}</text>` : "";
    return `<g class="col" data-i="${i}">
      <rect class="bar-hit" x="${padL + colW * i}" y="${padT}" width="${colW}" height="${H - padT - padB}"/>
      <path class="bar" d="${path}"/>${label}
      <text class="axis-t" x="${padL + colW * i + colW / 2}" y="${H - 8}" text-anchor="middle">${MONTHS[i]}</text></g>`;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Дохід по місяцях">
    <g class="grid">${grid}</g>${cols}</svg>`;
  $$(".axis-t", el).forEach((t) => t.setAttribute("style", "fill:var(--muted);font-size:11px"));
  const tip = $("#tooltip");
  $$("g.col", el).forEach((g) => {
    const m = months[g.dataset.i];
    g.addEventListener("mousemove", (e) => {
      tip.innerHTML = `<b>${MONTHS[m.month - 1]} ${state.year}</b><br>Дохід: ${money(m.income)}${m.refunds ? `<br>Повернення: ${money(-m.refunds)}` : ""}<br>Надходжень: ${m.count}`;
      tip.classList.remove("hidden");
      tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
      tip.style.top = e.clientY + 12 + "px";
    });
    g.addEventListener("mouseleave", () => tip.classList.add("hidden"));
  });
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!$("#tab-overview").classList.contains("hidden")) loadOverview(); }, 200); });

// ---------------------------------------------------------------- transactions

function txQuery() {
  const p = new URLSearchParams();
  for (const [k, id] of [["from", "#f-from"], ["to", "#f-to"], ["account", "#f-account"], ["category", "#f-category"], ["direction", "#f-direction"], ["q", "#f-q"]]) {
    const v = $(id).value;
    if (v) p.set(k, v);
  }
  return p;
}

async function loadTransactions(reset) {
  if (reset) state.txOffset = 0;
  const p = txQuery();
  p.set("limit", state.txLimit);
  p.set("offset", state.txOffset);
  const [data, conns] = await Promise.all([api("/api/transactions?" + p), reset ? api("/api/connections") : null]);
  if (conns) {
    const cur = $("#f-account").value;
    $("#f-account").innerHTML = `<option value="">Усі</option>` + conns.flatMap((c) => c.accounts)
      .map((a) => `<option value="${esc(a.id)}" ${a.id === cur ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  }
  $("#tx-summary").textContent = `Знайдено операцій: ${data.total}. Дохід серед них: ${money(data.income)}`;
  const rows = data.items.map(txRow).join("");
  const table = $("#tx-table");
  if (reset) {
    table.innerHTML = `<thead><tr><th>Дата</th><th>Контрагент / призначення</th><th>Рахунок</th><th class="num">Сума</th><th class="num">У гривні</th><th>Категорія</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">Операцій немає</td></tr>`}</tbody>`;
  } else {
    table.tBodies[0].insertAdjacentHTML("beforeend", rows);
  }
  state.txOffset += data.items.length;
  $("#btn-more").classList.toggle("hidden", state.txOffset >= data.total);
  const exp = new URLSearchParams({ from: $("#f-from").value || `${state.year}-01-01`, to: $("#f-to").value || `${state.year}-12-31` });
  $("#btn-export").href = "/api/export/income-book.csv?" + exp;
}

function txRow(t) {
  const amt = t.amount / 100;
  const sign = amt > 0 ? "pos" : "neg";
  const opts = Object.entries(state.categories).map(([k, v]) => `<option value="${k}" ${k === t.category ? "selected" : ""}>${esc(v)}</option>`).join("");
  const time = new Date(t.ts * 1000).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  return `<tr data-id="${esc(t.id)}">
    <td>${fmtDate(t.date)}<div class="muted small">${time}${t.hold ? " · в обробці" : ""}</div></td>
    <td class="desc"><div class="cp">${esc(t.counter_name || t.description)}</div>
      <div class="sub">${esc(t.counter_name ? t.description : "")}${t.comment ? " · " + esc(t.comment) : ""}</div></td>
    <td class="small">${esc(t.account_name)}</td>
    <td class="num ${sign}">${amt > 0 ? "+" : ""}${nf.format(amt)} ${CUR[t.currency] || t.currency}</td>
    <td class="num">${t.uah_amount == null ? "—" : nf.format(t.uah_amount / 100)}${t.currency !== "UAH" && t.nbu_rate ? `<div class="muted small">курс ${t.nbu_rate}</div>` : ""}</td>
    <td><select class="cat ${t.manual_category ? "manual" : ""}" title="${esc(t.manual_category ? "Змінено вручну" : "Авто: " + (t.auto_reason || ""))}">${opts}</select>
      ${t.manual_category ? `<button class="btn ghost small reset" title="Повернути автоматичну категорію">↺</button>` : ""}
      <div class="muted small">${t.manual_category ? "вручну" : esc(t.auto_reason || "")}</div></td>
  </tr>`;
}

$("#tx-table").addEventListener("change", async (e) => {
  if (!e.target.classList.contains("cat")) return;
  const id = e.target.closest("tr").dataset.id;
  try {
    await api(`/api/transactions/${encodeURIComponent(id)}`, { method: "PATCH", body: { manual_category: e.target.value } });
    toast("Категорію змінено");
    refreshRow(id);
  } catch (err) { toast(err.message, true); }
});
$("#tx-table").addEventListener("click", async (e) => {
  if (!e.target.classList.contains("reset")) return;
  const id = e.target.closest("tr").dataset.id;
  await api(`/api/transactions/${encodeURIComponent(id)}`, { method: "PATCH", body: { manual_category: null } });
  refreshRow(id);
});
async function refreshRow(id) {
  // перезавантажуємо видимий список, зберігаючи кількість рядків
  const n = state.txOffset;
  state.txLimit = Math.max(100, n);
  await loadTransactions(true);
  state.txLimit = 100;
}

let filterTimer;
["#f-from", "#f-to", "#f-account", "#f-category", "#f-direction", "#f-q"].forEach((id) =>
  $(id).addEventListener("input", () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => loadTransactions(true), 250); }));
$("#btn-more").addEventListener("click", () => loadTransactions(false));

// ---------------------------------------------------------------- banks

async function loadBanks() {
  const [conns, st] = await Promise.all([api("/api/connections"), api("/api/sync/status")]);
  $("#connections").innerHTML = conns.length ? conns.map((c) => `
    <div class="card conn" data-id="${c.id}">
      <div class="conn-head">
        <div><h3>${esc(c.name)}</h3>
          <div class="muted small">Токен ${esc(c.token_masked)} · ${c.last_sync_at ? "оновлено " + new Date(c.last_sync_at * 1000).toLocaleString("uk-UA") : "ще не оновлювалось"}</div>
          ${c.last_error ? `<div class="error small">Помилка: ${esc(c.last_error)}</div>` : ""}
        </div>
        <div class="conn-actions">
          <button class="btn" data-act="sync">Оновити виписку</button>
          <button class="btn" data-act="refresh">Оновити рахунки</button>
          ${c.bank === "mono" ? `<button class="btn" data-act="webhook" title="Миттєве надходження операцій (потрібна публічна адреса)">Увімкнути вебхук</button>` : ""}
          <button class="btn danger" data-act="delete">Видалити</button>
        </div>
      </div>
      <div class="table-wrap acc-list"><table class="table">
        <thead><tr><th>Рахунок</th><th>IBAN</th><th class="num">Баланс</th><th>Рахунок ФОП</th><th>Тягнути виписку</th></tr></thead>
        <tbody>${c.accounts.map((a) => `<tr data-acc="${esc(a.id)}">
          <td>${esc(a.name)}</td><td class="small">${esc(a.iban || "")}</td>
          <td class="num">${a.balance != null ? nf.format(a.balance / 100) + " " + (CUR[a.currency] || a.currency) : ""}</td>
          <td><input type="checkbox" data-field="is_fop" ${a.is_fop ? "checked" : ""}></td>
          <td><input type="checkbox" data-field="enabled" ${a.enabled ? "checked" : ""}></td></tr>`).join("")}</tbody>
      </table></div>
    </div>`).join("") : `<p class="muted">Ще немає підключених банків.</p>`;

  $("#sync-interval").textContent = st.interval_min > 0 ? `Автооновлення кожні ${st.interval_min} хв` : "Автооновлення вимкнено";
  $("#sync-log").innerHTML = st.log.map((l) => `<li class="${l.level}">${new Date(l.ts * 1000).toLocaleString("uk-UA")} — ${esc(l.message)}</li>`).join("") || `<li class="muted">Порожньо</li>`;
}

$("#connections").addEventListener("click", async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const id = e.target.closest(".conn").dataset.id;
  try {
    if (act === "delete") {
      if (!confirm("Видалити підключення разом з усіма його операціями?")) return;
      await api(`/api/connections/${id}`, { method: "DELETE" });
      toast("Підключення видалено");
    } else if (act === "sync") {
      await api(`/api/connections/${id}/sync`, { method: "POST", body: {} });
      toast("Оновлення запущено у фоні");
    } else if (act === "refresh") {
      e.target.disabled = true;
      await api(`/api/connections/${id}/refresh`, { method: "POST", body: {} });
      toast("Список рахунків оновлено");
    } else if (act === "webhook") {
      const r = await api(`/api/connections/${id}/webhook`, { method: "POST", body: {} });
      toast("Вебхук встановлено: " + r.url);
    }
  } catch (err) { toast(err.message, true); }
  loadBanks();
  pollStatus();
});

$("#connections").addEventListener("change", async (e) => {
  const f = e.target.dataset.field;
  if (!f) return;
  const acc = e.target.closest("tr").dataset.acc;
  try {
    await api(`/api/accounts/${encodeURIComponent(acc)}`, { method: "PATCH", body: { [f]: e.target.checked } });
    toast("Збережено");
    pollStatus();
  } catch (err) { toast(err.message, true); }
});

for (const [formId, bank] of [["#form-mono", "mono"], ["#form-privat", "privat"]]) {
  $(formId).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = $("button", f);
    btn.disabled = true; btn.textContent = "Підключаю…";
    try {
      const body = { bank, token: f.token.value.trim() };
      if (f.client_id) body.client_id = f.client_id.value.trim();
      const c = await api("/api/connections", { method: "POST", body });
      f.reset();
      toast(`Підключено: ${c.name}. Завантаження виписки почалося у фоні.`);
      loadBanks();
      pollStatus();
    } catch (err) { toast(err.message, true); }
    btn.disabled = false; btn.textContent = "Підключити";
  });
}

$("#btn-sync-all").addEventListener("click", async () => {
  try {
    const r = await api("/api/sync", { method: "POST", body: {} });
    toast(r.queued ? "Оновлення запущено у фоні" : "Немає підключених банків");
    pollStatus();
  } catch (err) { toast(err.message, true); }
});

// ---------------------------------------------------------------- rules

async function loadRules() {
  const rules = await api("/api/rules");
  const fields = { any: "будь-де", description: "призначення", counter_name: "контрагент", counter_edrpou: "ЄДРПОУ", comment: "коментар" };
  const dirs = { in: "надходження", out: "списання", any: "будь-який" };
  $("#rules-table").innerHTML = `<thead><tr><th>Текст</th><th>Де</th><th>Напрям</th><th>Категорія</th><th></th></tr></thead>
    <tbody>${rules.map((r) => `<tr><td>«${esc(r.pattern)}»</td><td>${fields[r.field] || r.field}</td><td>${dirs[r.direction]}</td>
      <td>${esc(state.categories[r.category] || r.category)}</td>
      <td class="num"><button class="btn ghost danger" data-del="${r.id}">Видалити</button></td></tr>`).join("")}</tbody>`;
}
$("#rules-table").addEventListener("click", async (e) => {
  if (!e.target.dataset.del) return;
  const r = await api(`/api/rules/${e.target.dataset.del}`, { method: "DELETE" });
  toast(`Правило видалено, перекласифіковано: ${r.reclassified}`);
  loadRules();
});
$("#form-rule").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api("/api/rules", { method: "POST", body: Object.fromEntries(new FormData(f)) });
    f.reset();
    toast(`Правило додано, перекласифіковано: ${r.reclassified}`);
    loadRules();
  } catch (err) { toast(err.message, true); }
});

// ---------------------------------------------------------------- settings

async function loadSettings() {
  const s = await api("/api/settings");
  const f = $("#form-settings");
  f.owner_name.value = s.owner_name || "";
  f.owner_tax_id.value = s.owner_tax_id || "";
  f.sync_start.value = s.sync_start || "";
  f.esv_enabled.checked = !!s.esv_enabled;
  f.dataset.syncStart = s.sync_start || "";
  const cols = [["min_wage", "Мін. зарплата"], ["income_limit", "Ліміт доходу"], ["esv_month", "ЄСВ / міс"], ["single_tax_rate", "ЄП, %"], ["mil_rate", "ВЗ, %"]];
  const nextYear = Math.max(...s.tax_params.map((p) => p.year), new Date().getFullYear()) + 1;
  const rows = [...s.tax_params, { year: nextYear, _new: true }];
  $("#params-table").innerHTML = `<thead><tr><th>Рік</th>${cols.map(([, l]) => `<th>${l}</th>`).join("")}<th></th></tr></thead>
    <tbody>${rows.map((p) => `<tr data-year="${p.year}"><td>${p.year}${p._new ? " <span class='muted small'>(новий)</span>" : ""}</td>
      ${cols.map(([k]) => `<td><input type="number" step="0.01" name="${k}" value="${p[k] ?? ""}" style="width:120px"></td>`).join("")}
      <td><button class="btn" data-save>Зберегти</button></td></tr>`).join("")}</tbody>`;
}
$("#form-settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { owner_name: f.owner_name.value.trim(), owner_tax_id: f.owner_tax_id.value.trim(), esv_enabled: f.esv_enabled.checked };
  if (f.sync_start.value !== f.dataset.syncStart) body.sync_start = f.sync_start.value;
  try {
    await api("/api/settings", { method: "PUT", body });
    toast(body.sync_start ? "Збережено. Виписки буде перезавантажено з нової дати." : "Збережено");
    if (body.sync_start) await api("/api/sync", { method: "POST", body: {} });
    loadSettings();
  } catch (err) { toast(err.message, true); }
});
$("#params-table").addEventListener("click", async (e) => {
  if (!("save" in e.target.dataset)) return;
  const tr = e.target.closest("tr");
  const body = Object.fromEntries($$("input", tr).map((i) => [i.name, i.value]));
  try {
    await api(`/api/tax-params/${tr.dataset.year}`, { method: "PUT", body });
    toast("Параметри збережено");
    loadSettings();
  } catch (err) { toast(err.message, true); }
});

// ---------------------------------------------------------------- sync status polling

let pollTimer;
async function pollStatus() {
  clearTimeout(pollTimer);
  try {
    const st = await api("/api/sync/status");
    const ind = $("#sync-indicator");
    const s = st.status;
    if (s.running || s.queued) {
      ind.className = "sync-indicator busy";
      ind.textContent = s.current ? `Завантаження: ${s.current.account}${s.current.new ? ` (+${s.current.new})` : ""}` : "Оновлення…";
      pollTimer = setTimeout(pollStatus, 3000);
      state.wasBusy = true;
    } else {
      ind.className = "sync-indicator";
      ind.textContent = s.last_run ? "Оновлено " + new Date(s.last_run * 1000).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "";
      if (state.wasBusy) {
        state.wasBusy = false;
        const active = $("#tabs button.active").dataset.tab;
        if (active === "overview" || active === "banks") loaders[active]();
      }
      pollTimer = setTimeout(pollStatus, 60000);
    }
  } catch { pollTimer = setTimeout(pollStatus, 60000); }
}

// ---------------------------------------------------------------- start

async function start() {
  $("#app").classList.remove("hidden");
  state.categories = await api("/api/categories");
  const catOpts = Object.entries(state.categories).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  $("#f-category").innerHTML = `<option value="">Усі</option>` + catOpts;
  $("#rule-category").innerHTML = catOpts;
  openTab(location.hash.slice(1) in loaders ? location.hash.slice(1) : "overview");
  pollStatus();
}

(async () => {
  try {
    const me = await api("/api/me");
    $("#btn-logout").classList.toggle("hidden", !me.auth_required);
    if (!me.authenticated) return showLogin();
    start();
  } catch (err) { toast(err.message, true); }
})();
