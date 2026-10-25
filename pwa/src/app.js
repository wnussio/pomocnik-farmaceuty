"use strict";
/* global Engine, ZXing */

const $ = (sel) => document.querySelector(sel);
const LIST_KEY = "farmacja.pwa.lista";
const DETAIL_SHARDS = 16;
const LEVEL_LABELS = {
  przeciwwskazane: "Przeciwwskazane / unikać",
  istotna: "Istotna – monitorować / modyfikować",
  niewielka: "Niewielka / informacyjna",
};
const RPL_URL = "https://rejestry.ezdrowie.gov.pl/api/rpl/medicinal-products";

let store, supplements, interactions, patientRules, dispensing, symptoms, refund;
const detailShards = new Map();

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function debounce(fn, ms = 150) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function toast(msg) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const badges = (cats) => (cats || []).map((c) => `<span class="badge${c === "OTC" ? " otc" : ""}">${esc(c)}</span>`).join("");

const FREE_LABELS = { S: "bezpłatny dla seniorów 65+", DZ: "bezpłatny dla dzieci i młodzieży do 18 lat", C: "bezpłatny dla kobiet w ciąży" };
const zl = (v) => `${v.toFixed(2).replace(".", ",")} zł`;

function refundBadges(id) {
  const r = refund.produkty[id];
  if (!r) return "";
  return `<span class="badge ref">${esc(r.min_doplata != null ? `Ref. od ${zl(r.min_doplata)}` : "Ref.")}</span>`
    + r.bezplatny.map((c) => `<span class="badge free" title="${esc(FREE_LABELS[c])}">${esc(c)}</span>`).join("");
}
const substancesText = (p) => p.substances.map((s) => `${s.name}${s.text ? " " + s.text : ""}`).join(" + ");

/* ---------- zakładki ---------- */

function showTab(name) {
  document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("hidden", p.id !== `panel-${name}`));
  if (name === "lista") runCheck();
  if (name === "objawy" && currentSymptom) openSymptom(currentSymptom);
  window.scrollTo(0, 0);
}
document.querySelectorAll(".nav").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

/* ---------- lista ---------- */

function loadList() {
  try { return JSON.parse(localStorage.getItem(LIST_KEY)) || []; } catch { return []; }
}
let checkList = loadList();

function saveList() {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(checkList)); } catch { /* brak pamięci lokalnej */ }
  renderList();
}

const isOnList = (id) => checkList.some((x) => x.id === id);

function addProduct(p) {
  if (isOnList(p.id)) { toast("Ten lek jest już na liście"); return; }
  checkList.push({ id: p.id, nazwa: p.name, moc: p.strength, postac: p.form });
  saveList();
  toast(`Dodano: ${p.name}`);
}

function renderList() {
  $("#list-count").textContent = checkList.length || "";
  $("#check-list").innerHTML = checkList.length
    ? checkList.map((x, i) => `
      <li><span>${esc(x.nazwa)}<span class="meta">${esc([x.moc, x.postac].filter(Boolean).join(" · "))}</span></span>
      <button type="button" data-remove="${i}" aria-label="Usuń z listy">×</button></li>`).join("")
    : `<li class="empty">Lista jest pusta. Dodawaj leki i suplementy przyciskiem „+”.</li>`;
  document.querySelectorAll("[data-add]").forEach((b) => markAddButton(b, isOnList(Number(b.dataset.add))));
  if (supplements) renderSupplements($("#supplement-q").value);
  if (!$("#panel-lista").classList.contains("hidden")) runCheck();
  refreshSymptom();
}
$("#check-list").addEventListener("click", (e) => {
  const i = e.target.dataset.remove;
  if (i === undefined) return;
  checkList.splice(Number(i), 1);
  saveList();
});
// Wyczyszczenie listy = nowy pacjent: dane pacjenta też wracają do ustawień domyślnych.
$("#clear-list").addEventListener("click", () => { checkList = []; patient = { ...ADULT }; savePatient(); saveList(); });
$("#add-alcohol").addEventListener("click", () => {
  if (checkList.some((x) => x.specjalny === "alkohol")) return;
  checkList.push({ specjalny: "alkohol", nazwa: "Alkohol", postac: "pozycja specjalna" });
  saveList();
});

function markAddButton(btn, on) {
  btn.classList.toggle("on", on);
  btn.textContent = on ? "✓" : "+";
  btn.setAttribute("aria-label", on ? "Na liście" : "Dodaj do listy");
}

/* ---------- 1. wyszukiwanie leku ---------- */

function productRow(p, extra = "") {
  const on = isOnList(p.id);
  return `
    <li class="result">
      <div class="main" data-open="${p.id}">
        <div class="name">${esc(p.name)} <span class="meta">${esc(p.strength)}</span></div>
        <div class="meta">${esc(p.form)} · ${esc(p.holder)} ${badges(p.categories)}${refundBadges(p.id)}</div>
        <div class="subs">${esc(substancesText(p))}</div>${extra}
      </div>
      <button type="button" class="add${on ? " on" : ""}" data-add="${p.id}" aria-label="${on ? "Na liście" : "Dodaj do listy"}">${on ? "✓" : "+"}</button>
    </li>`;
}

function handleResultClick(e) {
  const add = e.target.closest("[data-add]");
  const open = e.target.closest("[data-open]");
  if (add) {
    const id = Number(add.dataset.add);
    if (!isOnList(id)) addProduct(store.products.get(id));
  } else if (open) {
    openCard(Number(open.dataset.open));
  }
}

async function searchProducts(q) {
  if (store.isEanQuery(q) && !store.gtin) store.gtin = await getJSON("data/ean.json");
  const results = store.searchProducts(q);
  const onlyRefunded = $("#p-refunded").checked;
  const shown = onlyRefunded ? results.filter((p) => refund.produkty[p.id]) : results;
  $("#product-hint").classList.toggle("hidden", Boolean(q.trim()));
  $("#product-results").innerHTML = q.trim() && !shown.length
    ? `<li class="empty">Nie znaleziono ${onlyRefunded ? "refundowanego " : ""}leku „${esc(q)}”.</li>`
    : shown.map((p) => productRow(p)).join("");
  return results;
}
$("#p-refunded").addEventListener("change", () => searchProducts($("#product-q").value));
$("#product-q").addEventListener("input", debounce((e) => searchProducts(e.target.value)));
$("#product-results").addEventListener("click", handleResultClick);

/* ---------- karta leku ---------- */

async function details(id) {
  const shard = id % DETAIL_SHARDS;
  if (!detailShards.has(shard)) detailShards.set(shard, await getJSON(`data/szczegoly-${shard}.json`));
  return detailShards.get(shard)[id];
}

async function openCard(id) {
  const p = store.products.get(id);
  const [commonName, permitNo, validity, leafletId, spcId, packages] = (await details(id)) || ["", "", "", null, null, []];
  const on = isOnList(id);
  $("#card-body").innerHTML = `
    <h2>${esc(p.name)}</h2>
    <p class="sub">${esc(p.strength)} · ${esc(p.form)} ${badges(p.categories)}${refundBadges(p.id)}</p>
    ${p.topical ? `<p class="notice" style="margin-top:10px">Lek o działaniu miejscowym.</p>` : ""}
    ${dispensingSection(dispensing.check([store.checkItem(p)]), false)}
    <h3>Substancje czynne</h3>
    ${p.substances.map((s) => `
      <div class="subst"><span>${esc(s.name)}<span class="meta"> ${esc(s.text)}</span></span>
        <button type="button" class="btn btn-small" data-eq-key="${esc(s.key)}">zamienniki</button></div>`).join("")
      || `<p class="empty">Brak danych o substancjach w rejestrze.</p>`}
    <div class="card-actions">
      <button type="button" class="btn btn-primary" id="card-add" ${on ? "disabled" : ""}>${on ? "✓ Na liście" : "+ Dodaj do listy"}</button>
      ${p.substances.length ? `<button type="button" class="btn" id="card-eq">Zamienniki (ta sama moc)</button>` : ""}
    </div>
    <h3>Informacje</h3>
    <dl class="kv">
      <dt>Nazwa powszechna</dt><dd>${esc(commonName) || "–"}</dd>
      <dt>Podmiot</dt><dd>${esc(p.holder)}</dd>
      <dt>Kod ATC</dt><dd>${esc(p.atc.join(", ")) || "–"}</dd>
      <dt>Droga podania</dt><dd>${esc(p.routes.join(", ")) || "–"}</dd>
      <dt>Pozwolenie</dt><dd>${esc(permitNo)} (${esc(validity) || "–"})</dd>
      <dt>Dokumenty</dt><dd>
        ${spcId ? `<a href="${RPL_URL}/${spcId}/characteristic" target="_blank" rel="noopener">ChPL</a>` : ""}
        ${leafletId ? ` · <a href="${RPL_URL}/${leafletId}/leaflet" target="_blank" rel="noopener">Ulotka</a>` : ""}
        <span class="meta">(wymaga internetu)</span></dd>
    </dl>
    <h3>Opakowania (${packages.length})</h3>
    ${packages.map(([gtin, cat, desc, parallel]) => `
      <div class="pkg">${esc(desc)} ${badges([cat].filter(Boolean))}
        <div class="gtin">EAN ${esc(gtin)}${parallel ? ` · import równoległy: ${esc(parallel)}` : ""}</div></div>`).join("")}
    ${refundSection(packages)}`;
  $("#card-add").addEventListener("click", (e) => {
    addProduct(p);
    e.target.disabled = true;
    e.target.textContent = "✓ Na liście";
  });
  $("#card-eq")?.addEventListener("click", () => { closeCard(); openEquivalents(p.substances.map((s) => s.key), p); });
  $("#card-body").querySelectorAll("[data-eq-key]").forEach((b) =>
    b.addEventListener("click", () => { closeCard(); openEquivalents([b.dataset.eqKey], null); }));
  if ($("#card-sheet").classList.contains("hidden")) history.pushState({ karta: id }, "");
  $("#card-sheet").classList.remove("hidden");
  $("#card-body").scrollTop = 0;
}

function closeCard() {
  if ($("#card-sheet").classList.contains("hidden")) return;
  $("#card-sheet").classList.add("hidden");
  if (history.state && history.state.karta) history.back();
}
$("#card-back").addEventListener("click", closeCard);
// Przycisk „wstecz” w telefonie zamyka kartę / skaner zamiast wychodzić z aplikacji.
window.addEventListener("popstate", () => {
  $("#card-sheet").classList.add("hidden");
  stopScanner();
});

function refundSection(packages) {
  const rows = packages.map(([gtin, , desc]) => [gtin, desc, refund.opakowania[gtin.replace(/^0+/, "")]]).filter(([, , r]) => r);
  if (!rows.length) return "";
  return `<h3>Refundacja (lista MZ)</h3>${rows.map(([gtin, desc, r]) => `
    <div class="refund"><strong>${esc(desc)}</strong> <span class="meta">EAN ${esc(gtin)}</span>
      <div class="meta">Cena detaliczna ${esc(r.cena)} zł · limit ${esc(r.limit)} zł</div>
      <table><thead><tr><th>Wskazania</th><th>Odpł.</th><th>Dopłata</th></tr></thead>
        <tbody>${r.wskazania.map((w) => `<tr><td>${esc(w.zakres)}</td><td>${esc(w.odplatnosc)}</td><td>${esc(w.doplata)} zł</td></tr>`).join("")}</tbody></table>
      ${Object.entries(r.bezplatny).map(([c, note]) => `<div class="meta"><span class="badge free">${esc(c)}</span> ${esc(FREE_LABELS[c])}${note ? ` – ${esc(note)}` : ""}</div>`).join("")}
    </div>`).join("")}
    <p class="hint">Kwoty z obwieszczenia MZ; dopłata zależy od wskazania na recepcie.</p>`;
}

/* ---------- skaner kodów ---------- */

let scanStream = null, scanTimer = null, zxingReader = null;

function loadZxing() {
  if (window.ZXing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/zxing.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Nie udało się wczytać skanera"));
    document.head.appendChild(s);
  });
}

async function onCodeScanned(code) {
  if ($("#scanner").classList.contains("hidden")) return;  // kod odczytany podwójnie
  stopScanner();
  // Zastępujemy wpis skanera w historii (history.back() jest asynchroniczne i zamknęłoby kartę).
  if (history.state && history.state.skaner) history.replaceState(null, "");
  showTab("lek");
  $("#product-q").value = code;
  const results = await searchProducts(code);
  if (results.length === 1) openCard(results[0].id);
  else if (!results.length) toast(`Nie znaleziono leku o kodzie ${code}`);
}

async function startScanner() {
  if (!navigator.mediaDevices?.getUserMedia) { toast("Ta przeglądarka nie obsługuje aparatu"); return; }
  $("#scanner").classList.remove("hidden");
  history.pushState({ skaner: true }, "");
  const video = $("#scanner-video");
  const constraints = { video: { facingMode: { ideal: "environment" } }, audio: false };
  try {
    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8"] });
      scanStream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = scanStream;
      await video.play();
      scanTimer = setInterval(async () => {
        const codes = await detector.detect(video).catch(() => []);
        if (codes.length) onCodeScanned(codes[0].rawValue);
      }, 250);
    } else {
      await loadZxing();
      const hints = new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8]]]);
      zxingReader = new ZXing.BrowserMultiFormatReader(hints);
      await zxingReader.decodeFromConstraints(constraints, video, (result) => {
        if (result) onCodeScanned(result.getText());
      });
    }
  } catch (err) {
    stopScanner();
    if (history.state && history.state.skaner) history.back();
    toast(err.name === "NotAllowedError" ? "Brak zgody na użycie aparatu" : `Skaner niedostępny: ${err.message}`);
  }
}

function stopScanner() {
  clearInterval(scanTimer);
  scanTimer = null;
  if (zxingReader) { zxingReader.reset(); zxingReader = null; }
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  $("#scanner").classList.add("hidden");
}
$("#scan-btn").addEventListener("click", startScanner);
$("#scanner-close").addEventListener("click", () => { stopScanner(); if (history.state && history.state.skaner) history.back(); });

/* ---------- 2. zamienniki ---------- */

const eq = { keys: [], products: [], reference: null };

$("#substance-q").addEventListener("input", debounce((e) => {
  const box = $("#substance-suggestions");
  const q = e.target.value;
  if (!q.trim()) { box.classList.add("hidden"); return; }
  const hits = store.searchSubstances(q);
  box.innerHTML = hits.length
    ? hits.map((h) => `<li data-key="${esc(h.klucz)}"><span>${esc(h.nazwa)}</span><span class="meta">${h.liczba_lekow} leków</span></li>`).join("")
    : `<li class="meta">Nie znaleziono substancji</li>`;
  box.classList.remove("hidden");
}));
$("#substance-suggestions").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-key]");
  if (!li) return;
  $("#substance-suggestions").classList.add("hidden");
  $("#substance-q").value = "";
  $("#substance-q").blur();
  if (!eq.keys.includes(li.dataset.key)) eq.keys.push(li.dataset.key);
  eq.reference = null;
  loadEquivalents();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".picker")) $("#substance-suggestions").classList.add("hidden");
});

function openEquivalents(keys, referenceProduct) {
  eq.keys = [...new Set(keys.filter(Boolean))];
  eq.reference = referenceProduct;
  showTab("zamienniki");
  loadEquivalents();
}

function signatureOf(p) {
  return eq.keys.map((k) => {
    const s = p.substances.find((x) => x.key === k);
    return s && s.value != null ? [s.value, s.dim] : [null, null];
  });
}
const sigKey = (sig) => JSON.stringify(sig);

function distance(sig, ref) {
  let d = 0;
  for (let i = 0; i < sig.length; i++) {
    const [v, dim] = sig[i];
    const [rv, rdim] = ref[i];
    if (v == null || rv == null || dim !== rdim || v <= 0 || rv <= 0) return Infinity;
    d += Math.abs(Math.log(v / rv));
  }
  return d;
}

function loadEquivalents() {
  $("#substance-chips").innerHTML = eq.keys.map((k) => `
    <span class="chip">${esc(store.substanceName(k))}<button type="button" data-chip="${esc(k)}" aria-label="Usuń">×</button></span>`).join("");
  if (!eq.keys.length) {
    $("#eq-filters").classList.add("hidden");
    $("#eq-results").innerHTML = `<p class="empty">Wpisz substancję czynną albo otwórz kartę leku i wybierz „Zamienniki”.</p>`;
    return;
  }
  eq.products = store.equivalents(eq.keys, $("#f-combos").checked);
  buildFilters();
  renderEquivalents();
}
$("#substance-chips").addEventListener("click", (e) => {
  const k = e.target.dataset.chip;
  if (!k) return;
  eq.keys = eq.keys.filter((x) => x !== k);
  eq.reference = null;
  loadEquivalents();
});

function fillSelect(sel, options, value) {
  sel.innerHTML = options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join("");
  sel.value = options.some(([v]) => v === value) ? value : (options[0] ? options[0][0] : "");
}

function buildFilters() {
  $("#eq-filters").classList.remove("hidden");
  const bySig = new Map();
  for (const p of eq.products) {
    const sig = signatureOf(p);
    if (sig.some(([v]) => v == null)) continue;
    const k = sigKey(sig);
    if (!bySig.has(k)) bySig.set(k, { sig, labels: new Map(), n: 0 });
    const entry = bySig.get(k);
    entry.n++;
    const label = eq.keys.map((key) => p.substances.find((s) => s.key === key)?.text).join(" + ") || p.strength;
    entry.labels.set(label, (entry.labels.get(label) || 0) + 1);
  }
  const entries = [...bySig.entries()].sort((a, b) => {
    const [va, da] = a[1].sig[0];
    const [vb, db] = b[1].sig[0];
    return da === db ? va - vb : String(da).localeCompare(String(db));
  });
  const options = entries.map(([k, e]) => [k, `${[...e.labels.entries()].sort((a, b) => b[1] - a[1])[0][0]} (${e.n})`]);
  let wanted = $("#f-strength").value;
  if (eq.reference) wanted = sigKey(signatureOf(eq.reference));
  else if (!options.some(([k]) => k === wanted)) wanted = [...entries].sort((a, b) => b[1].n - a[1].n)[0]?.[0];
  fillSelect($("#f-strength"), [["", "— dowolna —"], ...options], wanted);

  const forms = [...new Set(eq.products.map((p) => p.formGroup))].sort();
  fillSelect($("#f-form"), [["", "wszystkie"], ...forms.map((f) => [f, f])], eq.reference ? eq.reference.formGroup : $("#f-form").value);
  const routes = [...new Set(eq.products.flatMap((p) => p.routes))].sort();
  fillSelect($("#f-route"), [["", "wszystkie"], ...routes.map((r) => [r, r])], eq.reference ? (eq.reference.routes[0] || "") : $("#f-route").value);
  eq.reference = null;
}
["#f-strength", "#f-form", "#f-route"].forEach((s) => $(s).addEventListener("change", renderEquivalents));
$("#f-refunded").addEventListener("change", () => { if (eq.keys.length) renderEquivalents(); });
$("#f-combos").addEventListener("change", loadEquivalents);

function renderEquivalents() {
  const form = $("#f-form").value;
  const route = $("#f-route").value;
  const refKey = $("#f-strength").value;
  const ref = refKey ? JSON.parse(refKey) : null;
  const onlyRefunded = $("#f-refunded").checked;
  const list = eq.products.filter((p) => (!form || p.formGroup === form) && (!route || p.routes.includes(route))
    && (!onlyRefunded || refund.produkty[p.id]));
  if (!list.length) { $("#eq-results").innerHTML = `<p class="empty">Brak leków spełniających kryteria.</p>`; return; }
  const withDist = list.map((p) => ({ p, d: ref ? distance(signatureOf(p), ref) : 0 }))
    .sort((a, b) => a.d - b.d || a.p.name.localeCompare(b.p.name, "pl"));
  const ratio = (x) => {
    const [v] = signatureOf(x.p)[0];
    return ref && v != null && ref[0][0] ? `<span class="dist">${Math.round((v / ref[0][0]) * 100)}% mocy odniesienia</span>` : "";
  };
  const section = (title, items, withRatio) => (items.length ? `
    <h3 class="group-title">${esc(title)} <span class="count">${items.length}</span></h3>
    <ul class="results">${items.map((x) => productRow(x.p, withRatio ? ratio(x) : "")).join("")}</ul>` : "");
  $("#eq-results").innerHTML = ref
    ? section("Ta sama moc", withDist.filter((x) => x.d < 1e-9), false)
      + section("Inne moce (od najbliższej)", withDist.filter((x) => x.d >= 1e-9 && Number.isFinite(x.d)), true)
      + section("Moc nieporównywalna / brak danych", withDist.filter((x) => !Number.isFinite(x.d)), false)
    : section("Wszystkie leki", withDist, false);
}
$("#eq-results").addEventListener("click", handleResultClick);

/* ---------- suplementy ---------- */

const SUPP_CATEGORIES = ["Minerały", "Witaminy", "Zioła", "Inne"];

function renderSupplements(q) {
  const results = supplements.search(q);
  if (!results.length) {
    $("#supplement-results").innerHTML = `<p class="empty">Nie znaleziono składnika „${esc(q)}”.</p>`;
    return;
  }
  const onList = new Set(checkList.filter((x) => x.suplement).map((x) => x.suplement));
  const card = (s) => `
    <li class="result${onList.has(s.id) ? " on-list" : ""}">
      <div class="main"><div class="name">${esc(s.nazwa)}</div></div>
      <button type="button" class="add${onList.has(s.id) ? " on" : ""}" data-supp="${esc(s.id)}"
        aria-label="${onList.has(s.id) ? "Na liście" : "Dodaj do listy"}">${onList.has(s.id) ? "✓" : "+"}</button>
    </li>`;
  const sections = [];
  if (!q.trim()) sections.push(["Najczęściej stosowane", results.filter((s) => s.popularny)]);
  for (const cat of SUPP_CATEGORIES) {
    sections.push([cat, results.filter((s) => s.kategoria === cat && (q.trim() || !s.popularny))]);
  }
  $("#supplement-results").innerHTML = sections.filter(([, items]) => items.length).map(([title, items]) => `
    <h3 class="group-title">${esc(title)} <span class="count">${items.length}</span></h3>
    <ul class="results supp-grid">${items.map(card).join("")}</ul>`).join("");
}
$("#supplement-q").addEventListener("input", debounce((e) => renderSupplements(e.target.value)));
$("#supplement-results").addEventListener("click", (e) => {
  const b = e.target.closest("[data-supp]");
  if (!b || checkList.some((x) => x.suplement === b.dataset.supp)) return;
  const s = supplements.byId.get(b.dataset.supp);
  checkList.push({ suplement: s.id, nazwa: s.nazwa, postac: "suplement diety" });
  saveList();
  toast(`Dodano: ${s.nazwa}`);
});

/* ---------- pacjent (wiek, ciąża, karmienie) ---------- */

const PATIENT_KEY = "farmacja.pwa.pacjent";
const ADULT = { wiek: "dorosly", ciaza: false, karmienie: false };

function loadPatient() {
  try { return { ...ADULT, ...JSON.parse(localStorage.getItem(PATIENT_KEY)) }; } catch { return { ...ADULT }; }
}
let patient = loadPatient();
const patientActive = () => patient.wiek !== "dorosly" || patient.ciaza || patient.karmienie;

function savePatient() {
  try { localStorage.setItem(PATIENT_KEY, JSON.stringify(patient)); } catch { /* brak pamięci lokalnej */ }
  renderPatient();
  runCheck();
  refreshSymptom();
}

function renderPatient() {
  $("#p-age").value = patient.wiek;
  $("#p-pregnant").checked = patient.ciaza;
  $("#p-breastfeeding").checked = patient.karmienie;
  $("#patient-box").classList.toggle("active", patientActive());
}

function initPatient() {
  $("#p-age").innerHTML = [...patientRules.bands.values()]
    .map((b) => `<option value="${esc(b.id)}">${esc(b.nazwa)}</option>`).join("");
  if (!patientRules.bands.has(patient.wiek)) patient = { ...ADULT };
  renderPatient();
}
$("#p-age").addEventListener("change", (e) => { patient.wiek = e.target.value; savePatient(); });
$("#p-pregnant").addEventListener("change", (e) => { patient.ciaza = e.target.checked; savePatient(); });
$("#p-breastfeeding").addEventListener("change", (e) => { patient.karmienie = e.target.checked; savePatient(); });

// Ostrzeżenie dotyczące jednej pozycji (pacjent, wydanie). withDrug=false – gdy pozycja jest oczywista (karta leku).
function warningCard(w, withDrug = true) {
  const subs = w.substancje.join(", ");
  return `
    <article class="ix ${w.poziom}">
      <div class="ix-level">${esc(LEVEL_LABELS[w.poziom])} · ${esc(w.tytul)}</div>
      ${withDrug ? `<div class="ix-drugs">${esc(w.lek)} <span class="s">(${esc(subs === w.lek ? "suplement diety" : subs)})</span></div>` : ""}
      <div class="ix-title">${esc(w.grupa)}</div>
      <p>${esc(w.opis)}</p>
      ${w.zalecenie ? `<p class="advice">Zalecenie: ${esc(w.zalecenie)}</p>` : ""}
    </article>`;
}

function ixCard(w) {
  return `
    <article class="ix ${w.poziom}">
      <div class="ix-level">${esc(LEVEL_LABELS[w.poziom])}</div>
      <div class="ix-drugs">${w.leki.map((l) => {
        const subs = l.substancje.join(", ");
        return `${esc(l.nazwa)} <span class="s">(${esc(subs === l.nazwa ? "suplement diety" : subs)})</span>`;
      }).join(" + ")}</div>
      <div class="ix-title">${esc(w.tytul)}</div>
      <p>${esc(w.opis)}</p>
      ${w.zalecenie ? `<p class="advice">Zalecenie: ${esc(w.zalecenie)}</p>` : ""}
    </article>`;
}

function dispensingSection(warnings, withDrug = true) {
  if (!warnings.length) return "";
  return `<h3>Przy wydaniu: pojazdy, słońce, żywność</h3>${warnings.map((w) => warningCard(w, withDrug)).join("")}`;
}

/* ---------- objawy: dobór leku bez recepty (nie jest poradą medyczną) ---------- */

let currentSymptom = null;
const LEVEL_RANK = { przeciwwskazane: 0, istotna: 1, niewielka: 2 };

function renderSymptomList(q) {
  const box = $("#symptom-list");
  box.classList.toggle("hidden", Boolean(currentSymptom));
  const list = symptoms.search(q);
  if (!list.length) { box.innerHTML = `<p class="empty">Nie znaleziono objawu „${esc(q)}”.</p>`; return; }
  box.innerHTML = [...new Set(list.map((s) => s.kategoria))].map((c) => `
    <h3 class="group-title">${esc(c)}</h3>
    <div class="symptom-chips">${list.filter((s) => s.kategoria === c).map((s) => `
      <button type="button" class="symptom-chip" data-symptom="${esc(s.id)}">${esc(s.nazwa)}</button>`).join("")}</div>`).join("");
}
$("#symptom-q").addEventListener("input", debounce((e) => {
  currentSymptom = null;
  $("#symptom-card").innerHTML = "";
  renderSymptomList(e.target.value);
}));
$("#symptom-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-symptom]");
  if (b) { openSymptom(b.dataset.symptom); window.scrollTo(0, 0); }
});

function optionStatus(levels) {
  if (levels.includes("przeciwwskazane")) return ["przeciwwskazane", "Przeciwwskazane / unikać – dla pacjenta lub z lekami z listy"];
  if (levels.includes("istotna")) return ["istotna", "Uwaga – ostrzeżenia dla pacjenta lub z lekami z listy"];
  if (levels.length) return ["niewielka", "Ostrzeżenia informacyjne"];
  return ["ok", "Brak ostrzeżeń w bazie dla pacjenta i listy – sprawdź ChPL"];
}

function optionCard(o, items) {
  const item = symptoms.optionItem(o);
  const ix = interactions.check([...items, item]).wyniki.filter((r) => r.pozycje.includes(items.length))
    .sort((a, b) => LEVEL_RANK[a.poziom] - LEVEL_RANK[b.poziom]);
  const pat = patientRules.check([item], patient);
  const disp = dispensing.check([item]);
  const [status, label] = optionStatus([...ix, ...pat].map((w) => w.poziom));
  const products = symptoms.products(store, o);
  const first = products.slice(0, 3), rest = products.slice(3);
  return `
    <article class="option ${status}">
      <h3>${esc(o.nazwa)}</h3><span class="pill ${status}">${esc(label)}</span>
      ${o.uwagi ? `<p class="option-note">${esc(o.uwagi)}</p>` : ""}
      ${ix.length ? `<div class="option-block"><div class="option-block-title">Interakcje z lekami z listy</div>${ix.map(ixCard).join("")}</div>` : ""}
      ${pat.length ? `<div class="option-block"><div class="option-block-title">Pacjent: ${esc(patientRules.profileLabel(patient))}</div>${pat.map((w) => warningCard(w, false)).join("")}</div>` : ""}
      ${disp.length ? `<details class="option-block"><summary>Przy wydaniu: ${esc([...new Set(disp.map((w) => w.tytul))].join(", "))} (${disp.length})</summary>
        ${disp.map((w) => warningCard(w, false)).join("")}</details>` : ""}
      ${products.length ? `<ul class="results">${first.map((p) => productRow(p)).join("")}</ul>
        ${rest.length ? `<details><summary>Pokaż wszystkie leki OTC (${products.length})</summary><ul class="results">${rest.map((p) => productRow(p)).join("")}</ul></details>` : ""}`
        : `<p class="empty">Brak leków OTC z tą substancją w rejestrze.</p>`}
    </article>`;
}

function openSymptom(id) {
  currentSymptom = id;
  renderSymptomList($("#symptom-q").value);
  const s = symptoms.byId.get(id);
  const items = checkItems();
  const context = [patientRules.profileLabel(patient) || "dorosły bez dodatkowych ustawień",
                   checkList.length ? `pozycje na liście: ${checkList.length}` : "lista leków pusta"].join(" · ");
  $("#symptom-card").innerHTML = `
    <button type="button" class="btn btn-link" id="symptom-back">← wszystkie objawy</button>
    <h2>${esc(s.nazwa)}</h2>
    <details class="questions"><summary>Najpierw zapytaj pacjenta</summary>
      <ul>${symptoms.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></details>
    <div class="red-flags">
      <div class="red-flags-title">Skieruj do lekarza (nie dobieraj leku samodzielnie), jeśli:</div>
      <ul>${s.alarmowe.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
    </div>
    <p class="hint">Sprawdzono dla: ${esc(context)}. Ustaw pacjenta i dodaj leki przyjmowane na stałe w zakładce „Lista”.</p>
    <h2 style="margin-top:16px">Możliwe leki bez recepty</h2>
    ${s.opcje.map((o) => optionCard(o, items)).join("")}
    ${s.porady.length ? `<h2 style="margin-top:16px">Postępowanie bez leków</h2><ul class="tips">${s.porady.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    <p class="disclaimer">To nie jest porada medyczna. Dawkowanie, przeciwwskazania i ograniczenia wiekowe – zawsze według ChPL / ulotki konkretnego produktu.</p>`;
  $("#symptom-back").addEventListener("click", () => {
    currentSymptom = null;
    $("#symptom-card").innerHTML = "";
    renderSymptomList($("#symptom-q").value);
  });
}
$("#symptom-card").addEventListener("click", handleResultClick);

function refreshSymptom() {
  if (symptoms && currentSymptom && !$("#panel-objawy").classList.contains("hidden")) openSymptom(currentSymptom);
}

/* ---------- interakcje ---------- */

function checkItems() {
  return checkList.map((x) => {
    if (x.specjalny === "alkohol") return Engine.ALCOHOL_ITEM();
    if (x.suplement) return supplements.checkItem(x.suplement);
    const p = store.products.get(x.id);
    return p && store.checkItem(p);
  }).filter(Boolean);
}

function runCheck() {
  const box = $("#interaction-results");
  if (!store) return;
  if (!checkList.length) {
    box.innerHTML = `<p class="empty">Dodaj leki do listy – sprawdzą się automatycznie. Interakcje od dwóch pozycji;
      ostrzeżenia dla pacjenta i przy wydaniu (pojazdy, słońce, żywność) – już dla jednej.</p>`;
    return;
  }
  const items = checkItems();
  const data = interactions.check(items);
  const warnings = patientRules.check(items, patient);
  const dispensingWarnings = dispensing.check(items);
  const counts = { przeciwwskazane: 0, istotna: 0, niewielka: 0 };
  [...data.wyniki, ...warnings].forEach((w) => { counts[w.poziom]++; });
  const patientBlock = patientActive() ? `
    <h2>Ostrzeżenia dla pacjenta</h2>
    <p class="meta">${esc(patientRules.profileLabel(patient))}</p>
    ${warnings.map(warningCard).join("")
      || `<div class="ok-box">Brak ostrzeżeń w bazie aplikacji dla tego pacjenta. Sprawdź ChPL (dawkowanie i postać dla wieku).</div>`}` : "";
  const summary = Object.entries(counts).filter(([, n]) => n)
    .map(([lvl, n]) => `<span class="pill ${lvl}">${esc(LEVEL_LABELS[lvl])}: ${n}</span>`).join("");
  box.innerHTML = `
    ${summary ? `<div class="summary-bar">${summary}</div>` : ""}
    ${patientBlock}
    ${checkList.length < 2 ? "" : `<h2 style="margin-top:18px">Interakcje</h2>
    ${data.uwagi.map((u) => `<p class="notice">${esc(u)}</p>`).join("")}
    ${data.wyniki.map(ixCard).join("")
      || `<div class="ok-box">Brak znanych interakcji w bazie aplikacji dla ${checkList.length} pozycji. Sprawdź ChPL.</div>`}`}
    ${dispensingWarnings.length ? `<h2 style="margin-top:18px">Przy wydaniu: pojazdy, słońce, żywność</h2>
      ${dispensingWarnings.map((w) => warningCard(w)).join("")}` : ""}
    <p class="hint">Baza: ${data.baza.liczba_regul} reguł, ${data.baza.liczba_grup} grup. ${esc(data.baza.status)}</p>`;
}

/* ---------- start i tryb offline ---------- */

async function init() {
  try {
    const [norm, leki, inter, supp, pac, ostrz, obj, ref] = await Promise.all([
      getJSON("data/normalizacja.json"), getJSON("data/leki.json"),
      getJSON("data/interakcje.json"), getJSON("data/suplementy.json"), getJSON("data/pacjent.json"),
      getJSON("data/ostrzezenia.json"), getJSON("data/objawy.json"), getJSON("data/refundacja.json"),
    ]);
    Engine.configure(norm);
    store = new Engine.Store(leki);
    interactions = new Engine.Interactions(inter);
    supplements = new Engine.Supplements(supp);
    patientRules = new Engine.PatientRules(pac, interactions);
    dispensing = new Engine.DispensingRules(ostrz, patientRules);
    symptoms = new Engine.Symptoms(obj);
    refund = ref;
  } catch (err) {
    $("#status").textContent = `Nie udało się wczytać bazy (${err.message}). Sprawdź połączenie i odśwież.`;
    return;
  }
  const refundDate = (refund.obwieszczenie.match(/na (\d+ \S+ \d{4})/) || [])[1];
  $("#status").textContent = `Rejestr leków – stan na ${store.meta.stan_na_dzien} · ${store.products.size} leków`
    + (refundDate ? ` · refundacja na ${refundDate}` : "");
  initPatient();
  renderSymptomList("");
  renderList();
  renderSupplements("");
  loadEquivalents();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const base = $("#status").textContent;
  navigator.serviceWorker.register("sw.js").then((reg) => {
    const offer = (worker) => {
      $("#update-banner").classList.remove("hidden");
      $("#update-btn").onclick = () => worker.postMessage("aktualizuj");
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      if (!navigator.serviceWorker.controller) $("#status").textContent = `${base} · zapisywanie do pracy offline…`;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) offer(worker);
        if (worker.state === "activated") $("#status").textContent = `${base} · działa offline ✓`;
      });
    });
    if (navigator.serviceWorker.controller) $("#status").textContent = `${base} · działa offline ✓`;
  }).catch(() => { /* bez trybu offline aplikacja nadal działa online */ });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !$("#update-banner").offsetParent) return;
    reloading = true;
    location.reload();
  });
  navigator.storage?.persist?.().catch(() => {});
}

init();
