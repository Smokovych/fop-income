// ============================================================ облікові записи і профілі ФОП (режим сервера)
// Кожен користувач працює з одним або кількома ФОП: своїм (власник) і клієнтськими (бухгалтер).
// Угорі ліворуч — ПІБ і РНОКПП ФОП, з даними якого зараз працює програма; натиск відкриває меню:
// перемикання між ФОП, «Додати ФОП», «Доступ до ФОП» (надати доступ бухгалтеру) і «Вийти».

// «СМОКОВИЧ МИКОЛА ВАСИЛЬОВИЧ» → «Смокович М. В.»
function shortName(full) {
  const words = String(full || "").replace(/^(ФОП|ФІЗИЧНА ОСОБА[- ]ПІДПРИЄМЕЦЬ)\s+/i, "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const cap = (w) => w.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return [cap(words[0]), ...words.slice(1, 3).map((w) => w[0].toUpperCase() + ".")].join(" ");
}

function brandInfo() {
  const st = (typeof S !== "undefined" && S && S.settings) || {};
  const name = st.owner_name || (ACTIVE && ACTIVE.name) || "";
  const tin = st.owner_tax_id || (ACTIVE && ACTIVE.tin) || "";
  return { name: shortName(name), tin };
}

function renderBrand() {
  const el = typeof document !== "undefined" && document.getElementById("brand-text");
  if (!el) return;
  const { name, tin } = brandInfo();
  el.innerHTML = name ? `${esc(name)}${tin ? `<span class="brand-tin">${esc(tin)}</span>` : ""}` : "ФОП-дохід";
  const btn = $("#brand");
  btn.title = name ? `${name}${tin ? ", РНОКПП " + tin : ""}${SERVER_MODE ? " — натисніть, щоб перемкнути ФОП або надати доступ" : ""}` : "";
  document.title = name ? `${name} — ФОП-дохід` : "ФОП-дохід";
}

// ---------------------------------------------------------------- меню профілів
function initProfileMenu() {
  const btn = $("#brand"), menu = $("#profile-menu");
  btn.disabled = false;
  btn.querySelector(".brand-caret").hidden = false;
  renderBrand();
  btn.onclick = async (e) => {
    e.stopPropagation();
    if (!menu.classList.contains("hidden")) return closeProfileMenu();
    renderProfileMenu();
    menu.classList.remove("hidden");
    // список доступів міг змінитися (клієнт надав доступ) — підтягуємо свіжий
    const me = await api("GET", "/api/me", undefined, { noProfile: true }).catch(() => null);
    if (me && me.ok) { ME = me.data; if (!menu.classList.contains("hidden")) renderProfileMenu(); }
  };
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) closeProfileMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeProfileMenu(); });
  menu.onclick = (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    closeProfileMenu();
    if (b.dataset.act === "switch") switchProfile(Number(b.dataset.id));
    else if (b.dataset.act === "add") addProfile();
    else if (b.dataset.act === "access") openAccess();
    else if (b.dataset.act === "logout") logout();
  };
}

function closeProfileMenu() { $("#profile-menu").classList.add("hidden"); }

function renderProfileMenu() {
  const list = (ME && ME.profiles) || [];
  $("#profile-menu").innerHTML = list.map((p) => {
    const cur = ACTIVE && p.id === ACTIVE.id;
    const nm = (cur ? brandInfo().name : shortName(p.name)) || "ФОП без назви";
    return `<button type="button" class="pm-item${cur ? " active" : ""}" data-act="switch" data-id="${p.id}" role="menuitem">
      <span class="pm-name">${cur ? "✓ " : ""}${esc(nm)}</span><span class="pm-meta">${esc(p.tin || "")}${p.role === "accountant" ? " · бухгалтер" : ""}</span></button>`;
  }).join("") + `<hr>
    <button type="button" class="pm-item" data-act="access" role="menuitem">👥 Доступ до ФОП…</button>
    <button type="button" class="pm-item" data-act="add" role="menuitem">＋ Додати ФОП</button>
    <hr><div class="pm-user">${esc(ME.user.name)} · ${esc(ME.user.email)}</div>
    <button type="button" class="pm-item" data-act="logout" role="menuitem">Вийти</button>`;
}

async function switchProfile(id) {
  if (!ACTIVE || id === ACTIVE.id) return;
  setStatus("Зберігаю зміни…");
  await flushRemote();
  try { localStorage.setItem(PROFILE_KEY, String(id)); } catch {}
  await api("POST", `/api/profiles/${id}/select`, "{}").catch(() => {});
  location.hash = "";
  location.reload();
}

async function logout() {
  await flushRemote();
  await api("POST", "/api/logout", "{}", { noLogin: true, noProfile: true }).catch(() => {});
  try { localStorage.removeItem(PROFILE_KEY); } catch {}
  location.reload();
}

async function addProfile() {
  const p = await showOnboard(true);
  if (p) {
    try { localStorage.setItem(PROFILE_KEY, String(p.id)); } catch {}
    await flushRemote();
    location.hash = "account";
    location.reload();
  }
}

// ---------------------------------------------------------------- підключення ФОП ключем КЕП
async function fileB64(f) {
  const buf = new Uint8Array(await f.arrayBuffer());
  let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

// Повертає доданий/знайдений профіль або null (скасовано). cancelable — відкрито з меню, у користувача вже є ФОП.
function showOnboard(cancelable) {
  const box = $("#onboard"), form = $("#onboard-form"), status = $("#ob-status");
  box.classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#ob-email").textContent = ME.user.email;
  $("#ob-cancel").classList.toggle("hidden", !cancelable);
  $("#ob-logout").classList.toggle("hidden", cancelable);
  $(".ob-accountant").classList.toggle("hidden", cancelable);
  status.className = "small muted"; status.textContent = "";
  return new Promise((resolve) => {
    const done = (p) => {
      box.classList.add("hidden");
      $("#ob-password").value = "";
      if (cancelable && !p) $("#app").classList.remove("hidden");
      resolve(p);
    };
    $("#ob-cancel").onclick = () => done(null);
    $("#ob-logout").onclick = logout;
    $("#ob-recheck").onclick = async () => {
      const me = await api("GET", "/api/me", undefined, { noProfile: true });
      if (me.ok) ME = me.data;
      const p = pickProfile();
      if (p) return done(p);
      status.className = "small warn";
      status.textContent = `Доступів поки немає. Клієнт має надати доступ саме на ${ME.user.email}.`;
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const files = [...$("#ob-files").files];
      if (!files.length) return;
      if (!$("#ob-consent").checked) { status.className = "small error"; status.textContent = "Потрібна ваша згода"; return; }
      const tinField = !$("#ob-tin-field").classList.contains("hidden");
      if (tinField && !/^\d{10}$/.test($("#ob-tin").value.trim())) { status.className = "small error"; status.textContent = "РНОКПП — 10 цифр"; return; }
      $("#ob-submit").disabled = true;
      status.className = "small muted";
      status.textContent = "Відкриваю ключ і отримую дані з Електронного кабінету… Це може тривати до хвилини.";
      try {
        const body = { files: await Promise.all(files.map(fileB64)), password: $("#ob-password").value, consent: true,
          tin: tinField ? $("#ob-tin").value.trim() : undefined };
        const r = await api("POST", "/api/profiles", JSON.stringify(body), { noProfile: true });
        if (!r.ok) throw new Error(r.data.error || "Не вдалося підключити ФОП");
        if (r.data.need_tin) {
          $("#ob-tin-field").classList.remove("hidden");
          $("#ob-tin").focus();
          status.className = "small warn";
          status.textContent = `Ключ відкрито${r.data.info && r.data.info.name ? ` (${r.data.info.name})` : ""}, але в сертифікаті немає РНОКПП — вкажіть його і натисніть «Підключити ФОП» ще раз.`;
          return;
        }
        const me = await api("GET", "/api/me", undefined, { noProfile: true });
        if (me.ok) ME = me.data;
        if (r.data.tax && r.data.tax.last_error) toast("ФОП додано, але дані з Кабінету поки не отримано: " + r.data.tax.last_error, true);
        else toast(r.data.joined ? "Ключ підтверджено — ви отримали доступ до цього ФОП" : "ФОП підключено, облікові дані завантажено з Кабінету");
        done(r.data.profile);
      } catch (err) {
        status.className = "small error";
        status.textContent = err.message;
      } finally {
        $("#ob-submit").disabled = false;
      }
    };
  });
}

// ---------------------------------------------------------------- доступ до ФОП (бухгалтер)
const ROLE_NAMES = { owner: "Власник", accountant: "Бухгалтер" };

async function openAccess() {
  const dlg = $("#access-dialog");
  $("#acc-title").textContent = `· ${brandInfo().name || ""} ${brandInfo().tin || ""}`;
  $("#acc-error").textContent = "";
  $("#acc-list").innerHTML = `<p class="muted small">Завантажую…</p>`;
  $("#acc-close").onclick = () => dlg.close();
  dlg.showModal();
  await renderAccess();
  $("#acc-form").onsubmit = async (e) => {
    e.preventDefault();
    $("#acc-error").textContent = "";
    const r = await api("POST", `/api/profiles/${ACTIVE.id}/access`, JSON.stringify({ email: $("#acc-email").value.trim(), role: $("#acc-role").value }));
    if (!r.ok) { $("#acc-error").textContent = r.data.error || "Не вдалося"; return; }
    $("#acc-email").value = "";
    toast(r.data.invited ? `Запрошення збережено: доступ з'явиться після реєстрації ${r.data.email}` : `Доступ надано: ${r.data.user.name || r.data.user.email}`);
    renderAccess();
  };
  $("#acc-list").onclick = async (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    const self = b.dataset.rm === String(ME.user.id);
    if (!confirm(b.dataset.inv ? `Скасувати запрошення для ${b.dataset.inv}?` : self ? "Відмовитися від доступу до цього ФОП?" : "Забрати доступ у цього користувача?")) return;
    const r = b.dataset.inv
      ? await api("DELETE", `/api/profiles/${ACTIVE.id}/invites`, JSON.stringify({ email: b.dataset.inv }))
      : await api("DELETE", `/api/profiles/${ACTIVE.id}/access/${b.dataset.rm}`, "{}");
    if (!r.ok) { $("#acc-error").textContent = r.data.error || "Не вдалося"; return; }
    if (self) { R.changes = 0; try { localStorage.removeItem(PROFILE_KEY); } catch {} location.reload(); return; }
    renderAccess();
  };
}

async function renderAccess() {
  const r = await api("GET", `/api/profiles/${ACTIVE.id}/access`);
  if (!r.ok) { $("#acc-list").innerHTML = `<p class="error small">${esc(r.data.error || "Не вдалося завантажити")}</p>`; return; }
  const d = r.data, owner = d.role === "owner";
  $("#acc-form").classList.toggle("hidden", !owner);
  $("#acc-hint").classList.toggle("hidden", !owner);
  $("#acc-list").innerHTML = d.users.map((u) => {
    const me = u.id === d.me;
    const can = (owner || me) && !(me && owner && d.users.filter((x) => x.role === "owner").length < 2);
    return `<div class="acc-row"><div class="acc-who">${esc(u.name || u.email)}${me ? " <span class=\"muted\">(ви)</span>" : ""}<small>${esc(u.email)}</small></div>
      <span class="acc-role">${ROLE_NAMES[u.role] || u.role}</span>
      ${can ? `<button class="btn small" type="button" data-rm="${u.id}">${me ? "Відмовитися" : "Забрати доступ"}</button>` : ""}</div>`;
  }).join("") + d.invites.map((i) => `<div class="acc-row"><div class="acc-who">${esc(i.email)}<small>ще не зареєструвався</small></div>
      <span class="acc-role pending">${ROLE_NAMES[i.role] || i.role} · запрошення</span>
      <button class="btn small" type="button" data-rm="inv" data-inv="${esc(i.email)}">Скасувати</button></div>`).join("");
}
