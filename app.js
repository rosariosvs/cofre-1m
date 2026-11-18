import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, addDoc, updateDoc, deleteDoc, setDoc, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const TARGET = 1000000;
// Neutral starting goals. The real goals are saved in Firebase from "Editar metas".
const DEFAULT_GOALS = [
  { id: "m1", name: "Meta 1", cap: 250000 },
  { id: "m2", name: "Meta 2", cap: 250000 },
  { id: "m3", name: "Meta 3", cap: 250000 },
  { id: "m4", name: "Meta 4", cap: 250000 }
];
const MONTHS = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const MILES = [10, 25, 50, 75, 90, 100];
const DEADLINE = new Date(2027, 11, 31, 23, 59);
const DAY = 86400000, MONTH = 30.44 * DAY;

// 150 cells: 5k, 10k, 5k repeated 50 times = 100 x 5k + 50 x 10k
const CELLS = [];
for (let i = 0; i < 50; i++) CELLS.push(5000, 10000, 5000);
const CUM = [0];
CELLS.forEach((v, k) => CUM.push(CUM[k] + v));

const $ = (id) => document.getElementById(id);
const els = {
  loginView: $("loginView"), setupView: $("setupView"), appView: $("appView"),
  loginForm: $("loginForm"), loginEmail: $("loginEmail"), loginPass: $("loginPass"), loginBtn: $("loginBtn"), loginHint: $("loginHint"),
  logoutBtn: $("logoutBtn"),
  grid: $("grid"), cellsLeft: $("cellsLeft"), amount: $("amount"), source: $("source"),
  sourceList: $("sourceList"), addBtn: $("addBtn"), hint: $("hint"), form: $("form"),
  goals: $("goals"), goalsNote: $("goalsNote"), histBtn: $("histBtn"), history: $("history"),
  histBody: $("histBody"), toast: $("toast"), last: $("last"), lastBody: $("lastBody"),
  editBtn: $("editGoalsBtn"), editor: $("editor"), edRows: $("edRows"), edAdd: $("edAdd"),
  edSum: $("edSum"), edCancel: $("edCancel"), edSave: $("edSave"), offline: $("offline")
};

const state = { deposits: [], total: 0, ready: false, goals: DEFAULT_GOALS.slice() };

function fmt(n) { n = Math.round(n); return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
function parseAmount(s) { const d = String(s || "").replace(/[^\d]/g, ""); return d ? parseInt(d, 10) : 0; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function sumCaps(list) { return list.reduce((s, g) => s + g.cap, 0); }
function moneyInput(inp) { inp.addEventListener("input", () => { const n = parseAmount(inp.value); inp.value = n ? fmt(n) : ""; }); }
function monthYear(d) { return MONTHS[d.getMonth()].toLowerCase() + " de " + d.getFullYear(); }

// Equal split with redistribution: a goal stops at its cap and its share flows to the others.
function allocate(total, goals) {
  const t = clamp(total, 0, sumCaps(goals));
  const sorted = goals.slice().sort((a, b) => a.cap - b.cap);
  const out = {}; let remaining = t, left = sorted.length;
  sorted.forEach((g) => { const a = Math.min(g.cap, remaining / left); out[g.id] = a; remaining -= a; left--; });
  return out;
}

/* ---------------- Firebase ---------------- */
const configured = firebaseConfig && firebaseConfig.apiKey && firebaseConfig.apiKey !== "COLA_AQUI";
let auth = null, db = null, depositsCol = null, cofreDoc = null;
let unsubs = [];

if (!configured) {
  els.setupView.hidden = false;
} else {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  setPersistence(auth, browserLocalPersistence).catch(() => {});
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    db = initializeFirestore(app, {});
  }
  depositsCol = collection(db, "cofres", "main", "deposits");
  cofreDoc = doc(db, "cofres", "main");

  onAuthStateChanged(auth, (user) => {
    unsubs.forEach((u) => u()); unsubs = [];
    if (!user) {
      els.appView.hidden = true; els.loginView.hidden = false;
      state.ready = false; state.deposits = []; state.total = 0;
      return;
    }
    els.loginView.hidden = true; els.appView.hidden = false;
    fit();
    startListeners();
  });
}

function startListeners() {
  unsubs.push(onSnapshot(cofreDoc, (snap) => {
    const items = snap.exists() && Array.isArray(snap.data().goals) ? snap.data().goals : null;
    const clean = items ? items.filter((g) => g && g.id && g.name && Number(g.cap) > 0).map((g) => ({ id: String(g.id), name: String(g.name), cap: Number(g.cap) })) : [];
    state.goals = clean.length ? clean : DEFAULT_GOALS.slice();
    buildGoalBars();
    if (lastAlloc) { const keep = lastAlloc._t; lastAlloc = allocate(state.total, state.goals); lastAlloc._t = keep; }
    render();
  }, onAccessError));

  unsubs.push(onSnapshot(query(depositsCol, orderBy("at", "desc")), (snap) => {
    state.deposits = snap.docs.map((d) => { const x = d.data(); return { id: d.id, amount: Number(x.amount) || 0, source: String(x.source || ""), at: String(x.at || "") }; });
    state.total = state.deposits.reduce((s, d) => s + d.amount, 0);
    state.ready = true;
    renderSources(); renderLast(); render();
    if (!els.history.hidden) renderHistory();
  }, onAccessError));
}

function onAccessError(err) {
  if (err && err.code === "permission-denied") {
    els.cellsLeft.textContent = "Esta conta não tem acesso ao cofre.";
    lockHint("Confirma que o teu email está nas regras do Firestore.", true);
  } else {
    els.cellsLeft.textContent = "Não foi possível ligar ao cofre. Recarrega a app.";
  }
}

els.loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!auth) return;
  els.loginBtn.disabled = true; els.loginHint.textContent = ""; els.loginHint.classList.remove("err");
  signInWithEmailAndPassword(auth, els.loginEmail.value.trim(), els.loginPass.value)
    .catch((err) => {
      const c = err && err.code;
      let msg = "Não foi possível entrar. Tenta de novo.";
      if (c === "auth/invalid-credential" || c === "auth/wrong-password" || c === "auth/user-not-found" || c === "auth/invalid-email") msg = "Email ou palavra-passe errados.";
      else if (c === "auth/too-many-requests") msg = "Demasiadas tentativas. Espera uns minutos e tenta de novo.";
      else if (c === "auth/network-request-failed") msg = "Sem internet. Liga-te e tenta de novo.";
      els.loginHint.textContent = msg; els.loginHint.classList.add("err");
    })
    .finally(() => { els.loginBtn.disabled = false; });
});
els.logoutBtn.addEventListener("click", () => { if (auth) signOut(auth); });

function updateOnline() { els.offline.hidden = navigator.onLine; }
window.addEventListener("online", updateOnline);
window.addEventListener("offline", updateOnline);
updateOnline();

/* ---------------- Grid ---------------- */
const R = 20, W = Math.sqrt(3) * R, PAD = 3;
let PER = 0;
const NS = "http://www.w3.org/2000/svg";
const cellEls = [];
function hexPoints(r) {
  const p = [];
  for (let k = 0; k < 6; k++) { const a = Math.PI / 180 * (60 * k - 30); p.push((r * Math.cos(a)).toFixed(2) + "," + (r * Math.sin(a)).toFixed(2)); }
  return p.join(" ");
}
const PTS = hexPoints(R - 1.6);
CELLS.forEach((v, idx) => {
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "cell" + (v === 10000 ? " ten" : ""));
  g.setAttribute("tabindex", "0");
  g.setAttribute("role", "button");
  const clip = document.createElementNS(NS, "clipPath"); clip.setAttribute("id", "hx" + idx);
  const cp = document.createElementNS(NS, "polygon"); cp.setAttribute("points", PTS); clip.appendChild(cp);
  const base = document.createElementNS(NS, "polygon"); base.setAttribute("points", PTS); base.setAttribute("class", "base");
  const clipG = document.createElementNS(NS, "g"); clipG.setAttribute("clip-path", "url(#hx" + idx + ")");
  const fillbar = document.createElementNS(NS, "rect");
  fillbar.setAttribute("class", "fillbar");
  fillbar.setAttribute("x", (-W / 2).toFixed(2)); fillbar.setAttribute("y", (-R).toFixed(2));
  fillbar.setAttribute("width", W.toFixed(2)); fillbar.setAttribute("height", (2 * R).toFixed(2));
  clipG.appendChild(fillbar);
  const outline = document.createElementNS(NS, "polygon"); outline.setAttribute("points", PTS); outline.setAttribute("class", "outline");
  const text = document.createElementNS(NS, "text");
  text.setAttribute("x", 0); text.setAttribute("y", 0);
  text.textContent = v === 10000 ? "10k" : "5k";
  const tick = document.createElementNS(NS, "path");
  tick.setAttribute("class", "tick");
  tick.setAttribute("d", "M-5 0.5 l3.6 3.6 l6.6 -7.4");
  tick.style.display = "none";
  g.append(clip, base, clipG, outline, text, tick);
  g.addEventListener("click", () => pickCell(idx));
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickCell(idx); } });
  els.grid.appendChild(g);
  cellEls.push({ g, fill: fillbar, text, tick, v });
});

function layout(per) {
  if (per === PER) return;
  PER = per;
  const rows = Math.ceil(CELLS.length / PER);
  const vbW = PER * W + W / 2 + PAD * 2, vbH = 2 * R + (rows - 1) * 1.5 * R + PAD * 2;
  els.grid.setAttribute("viewBox", "0 0 " + vbW.toFixed(1) + " " + vbH.toFixed(1));
  cellEls.forEach((c, idx) => {
    const row = Math.floor(idx / PER), col = idx % PER;
    const x = PAD + W / 2 + col * W + (row % 2 ? W / 2 : 0);
    const y = PAD + R + row * 1.5 * R;
    c.g.setAttribute("transform", "translate(" + x.toFixed(2) + " " + y.toFixed(2) + ")");
  });
}
function fit() {
  const w = els.grid.parentNode.clientWidth || 360;
  // cells about 44px wide on screen, between 8 and 25 per row
  layout(clamp(Math.floor(w / 44), 8, 25));
}
fit();
if (window.ResizeObserver) new ResizeObserver(fit).observe(els.grid.parentNode);
else window.addEventListener("resize", fit);

function pickCell(idx) {
  if (!state.ready) return;
  const need = CUM[idx + 1] - state.total;
  if (need <= 0) { flashHint('Este favo já está cheio. Para corrigir um valor, usa "Corrigir" no último registo ou no histórico.', false); return; }
  const current = parseAmount(els.amount.value);
  els.amount.value = current === need ? "" : fmt(need);
  render();
  if (els.amount.value) els.source.focus();
}

/* ---------------- Goal bars ---------------- */
let goalEls = {};
function makeGoal(id, name, cap, big) {
  const wrap = el("div", "goal" + (big ? " total" : ""));
  const row = el("div", "goal-row");
  const nm = el("span", "goal-name", name);
  nm.appendChild(el("small", null, fmt(cap) + " MT"));
  const right = el("span", "goal-right");
  row.append(nm, right);
  const track = el("div", "track" + (big ? " big" : ""));
  track.setAttribute("role", "progressbar"); track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100"); track.setAttribute("aria-label", name);
  const bar = el("div", "bar"); track.appendChild(bar);
  wrap.append(row, track);
  els.goals.appendChild(wrap);
  goalEls[id] = { wrap, right, bar, track, cap, name };
}
function buildGoalBars() {
  els.goals.innerHTML = ""; goalEls = {};
  makeGoal("all", "Cofre 1M", TARGET, true);
  els.goals.appendChild(el("div", "divider"));
  state.goals.forEach((g) => makeGoal(g.id, g.name, g.cap, false));
  const s = sumCaps(state.goals);
  if (s !== TARGET) {
    els.goalsNote.hidden = false;
    els.goalsNote.textContent = s > TARGET
      ? "As metas somam " + fmt(s) + " MT, " + fmt(s - TARGET) + " MT acima do cofre. Depois do 1M, continua a registar para as completar."
      : "As metas somam " + fmt(s) + " MT. Os últimos " + fmt(TARGET - s) + " MT do cofre ficam livres de meta.";
  } else els.goalsNote.hidden = true;
}
function setGoal(id, value) {
  const ge = goalEls[id]; if (!ge) return;
  const pct = ge.cap ? clamp(value / ge.cap, 0, 1) * 100 : 0;
  ge.bar.style.width = pct.toFixed(2) + "%";
  ge.track.setAttribute("aria-valuenow", Math.floor(pct));
  const done = pct >= 100;
  ge.wrap.classList.toggle("done", done);
  ge.right.textContent = "";
  if (done) ge.right.appendChild(el("span", "pill", "Pronta"));
  else ge.right.appendChild(el("span", "goal-pct", (pct < 10 && pct > 0 ? pct.toFixed(1) : Math.floor(pct)) + "%"));
}

/* ---------------- Render ---------------- */
let lastAlloc = null;
function render() {
  const total = state.total;
  const pending = parseAmount(els.amount.value);
  const after = total + pending;
  let full = 0, touched = 0;
  cellEls.forEach((c, idx) => {
    const start = CUM[idx];
    const frac = clamp((total - start) / c.v, 0, 1);
    const pfrac = clamp((after - start) / c.v, 0, 1);
    const isFull = frac >= 1;
    if (isFull) full++;
    c.fill.style.transform = "scaleX(" + frac.toFixed(4) + ")";
    c.g.classList.toggle("full", isFull);
    const isPending = pending > 0 && pfrac > frac;
    if (isPending) touched++;
    c.g.classList.toggle("pending", isPending);
    c.tick.style.display = isFull ? "" : "none";
    c.text.style.display = isFull ? "none" : "";
    c.g.setAttribute("aria-label", (c.v === 10000 ? "Favo de 10.000 MT" : "Favo de 5.000 MT") + (isFull ? ", cheio" : frac > 0 ? ", " + Math.round(frac * 100) + "% cheio" : ", vazio"));
  });
  if (state.ready) {
    const left = CELLS.length - full;
    els.cellsLeft.textContent = "";
    els.cellsLeft.appendChild(el("strong", null, left === 0 ? "Cofre cheio" : left + (left === 1 ? " favo por pintar" : " favos por pintar")));
  }

  setGoal("all", total);
  const alloc = allocate(total, state.goals);
  state.goals.forEach((g) => setGoal(g.id, alloc[g.id]));
  if (state.ready) renderInsights(total, alloc);
  if (lastAlloc && lastAlloc._t < total) {
    MILES.forEach((m) => { const th = TARGET * m / 100; if (m < 100 && lastAlloc._t < th && total >= th) showToast(m + "% do cofre alcançado"); });
    state.goals.forEach((g) => { if (lastAlloc[g.id] != null && lastAlloc[g.id] < g.cap && alloc[g.id] >= g.cap) showToast(g.name + ": meta atingida"); });
    if (lastAlloc._t < TARGET && total >= TARGET) showToast("Cofre 1M completo");
  }
  if (state.ready) { lastAlloc = alloc; lastAlloc._t = total; }

  els.addBtn.disabled = !(state.ready && pending > 0);
  if (!els.hint.dataset.locked) {
    if (!state.ready) setHint("A abrir o cofre…");
    else if (pending > 0) setHint(fmt(pending) + " MT vão pintar " + touched + (touched === 1 ? " favo" : " favos") + ". Indica a proveniência e carrega em +.");
    else setHint("Toca num favo ou escreve o valor que acabaste de guardar.");
  }
}

function renderInsights(total, alloc) {
  // next finish line: under the equal split, the open goal with the least left finishes first
  const nx = $("next"); nx.innerHTML = "";
  const open = state.goals.filter((g) => alloc[g.id] < g.cap - 0.5).sort((a, b) => (a.cap - alloc[a.id]) - (b.cap - alloc[b.id]));
  if (open.length) {
    const g = open[0];
    nx.appendChild(el("span", "lbl", "Próxima meta"));
    nx.appendChild(el("span", "nm", g.name));
    const mini = el("div", "mini"); const bi = el("i"); bi.style.width = clamp(alloc[g.id] / g.cap, 0, 1) * 100 + "%"; mini.appendChild(bi); nx.appendChild(mini);
  } else {
    nx.appendChild(el("span", "lbl", "Metas"));
    nx.appendChild(el("span", "nm", "Todas as metas estão prontas"));
  }
  // milestones
  const ms = $("miles"); ms.innerHTML = "";
  MILES.forEach((m) => { const hit = total >= TARGET * m / 100; const c = el("span", "mile" + (hit ? " hit" : ""), m + "%"); c.setAttribute("aria-label", m + "% " + (hit ? "alcançado" : "por alcançar")); ms.appendChild(c); });
  // pace: total divided by months since the first deposit (at least one month)
  const pc = $("pace"); pc.innerHTML = "";
  if (!state.deposits.length) { pc.appendChild(el("p", "small", "Aparece depois do primeiro depósito.")); return; }
  const now = Date.now();
  const first = state.deposits.reduce((m, d) => { const t = Date.parse(d.at); return isNaN(t) ? m : Math.min(m, t); }, now);
  const months = Math.max(1, (now - first) / MONTH);
  const pace = total / months;
  const remaining = Math.max(0, TARGET - total);
  pc.appendChild(el("span", "big", fmt(pace) + " MT/mês"));
  if (remaining <= 0) pc.appendChild(el("p", "small", "Cofre completo."));
  else {
    const proj = new Date(now + (remaining / pace) * MONTH);
    pc.appendChild(el("p", "small", "Ao ritmo atual, chegas ao 1M em " + monthYear(proj) + "."));
    const monthsLeft = Math.max(1, (DEADLINE.getTime() - now) / MONTH);
    pc.appendChild(el("p", "small", "Para dezembro de 2027: " + fmt(Math.ceil(remaining / monthsLeft)) + " MT/mês."));
  }
  if ((now - first) < MONTH) pc.appendChild(el("p", "small", "Estimativa inicial, fica mais certa com o tempo."));
}

function setHint(t, err) { els.hint.textContent = t; els.hint.classList.toggle("err", !!err); }
let hintTimer;
function flashHint(t, err) {
  els.hint.dataset.locked = "1"; setHint(t, err);
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { delete els.hint.dataset.locked; render(); }, 3600);
}
function lockHint(t, err) { clearTimeout(hintTimer); els.hint.dataset.locked = "1"; setHint(t, err); }
let toastTimer;
function showToast(t) {
  els.toast.textContent = t; els.toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3800);
}

/* ---------------- Deposit rows ---------------- */
function canonicalSource(source) {
  let out = source;
  Array.prototype.forEach.call(els.sourceList.options, (o) => { if (o.value.toLowerCase() === source.toLowerCase()) out = o.value; });
  return out;
}
function confirmButton(btn, label, action) {
  btn.addEventListener("click", () => {
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm"); btn.textContent = "Confirmar";
      setTimeout(() => { if (btn.isConnected) { btn.classList.remove("confirm"); btn.textContent = label; } }, 4000);
      return;
    }
    action();
  });
}
function depositRow(d) {
  const box = el("div");
  function view() {
    box.innerHTML = "";
    const row = el("div", "dep");
    const dt = new Date(d.at);
    row.appendChild(el("span", "d", String(dt.getDate()).padStart(2, "0") + "/" + String(dt.getMonth() + 1).padStart(2, "0")));
    row.appendChild(el("span", "s", d.source || "Sem proveniência"));
    row.appendChild(el("span", "amt", fmt(d.amount) + " MT"));
    const acts = el("span", "acts");
    const fix = el("button", "btn-text", "Corrigir"); fix.type = "button"; fix.addEventListener("click", edit);
    const del = el("button", "btn-text danger", "Apagar"); del.type = "button";
    confirmButton(del, "Apagar", () => {
      del.disabled = true;
      deleteDoc(doc(depositsCol, d.id))
        .then(() => flashHint(fmt(d.amount) + " MT retirados do cofre.", false))
        .catch(() => { del.disabled = false; flashHint("Não foi possível apagar. Tenta de novo.", true); });
    });
    acts.append(fix, del);
    row.appendChild(acts);
    box.appendChild(row);
  }
  function edit() {
    box.innerHTML = "";
    const f = el("div", "dep-edit");
    const a = el("input", "inp"); a.inputMode = "numeric"; a.value = fmt(d.amount); a.setAttribute("aria-label", "Valor correto"); moneyInput(a);
    const s = el("input", "inp"); s.value = d.source; s.setAttribute("list", "sourceList"); s.setAttribute("aria-label", "Proveniência");
    const btns = el("div", "row-btns");
    const ok = el("button", "btn-solid", "Guardar"); ok.type = "button";
    const no = el("button", "btn-text", "Cancelar"); no.type = "button";
    no.addEventListener("click", view);
    ok.addEventListener("click", () => {
      const amt = parseAmount(a.value), src = s.value.trim();
      if (!amt) { a.focus(); return; }
      if (!src) { s.focus(); return; }
      ok.disabled = true;
      updateDoc(doc(depositsCol, d.id), { amount: amt, source: canonicalSource(src) })
        .then(() => flashHint("Registo corrigido.", false))
        .catch(() => { ok.disabled = false; flashHint("Não foi possível corrigir. Tenta de novo.", true); });
    });
    btns.append(no, ok);
    f.append(a, s, btns);
    box.appendChild(f);
    a.focus(); a.select();
  }
  view();
  return box;
}
function renderLast() {
  const d = state.deposits[0];
  els.last.hidden = !d;
  els.lastBody.innerHTML = "";
  if (d) els.lastBody.appendChild(depositRow(d));
}

/* ---------------- History ---------------- */
function renderHistory() {
  const body = els.histBody; body.innerHTML = "";
  if (!state.deposits.length) { body.appendChild(el("p", "empty", "Ainda não há depósitos. O primeiro aparece aqui com a data e a proveniência.")); return; }
  const years = {};
  state.deposits.forEach((d) => {
    const dt = new Date(d.at); const y = dt.getFullYear(), m = dt.getMonth();
    years[y] = years[y] || { total: 0, sources: {}, months: {} };
    years[y].total += d.amount;
    const src = d.source || "Sem proveniência";
    years[y].sources[src] = (years[y].sources[src] || 0) + d.amount;
    years[y].months[m] = years[y].months[m] || { total: 0, items: [] };
    years[y].months[m].total += d.amount;
    years[y].months[m].items.push(d);
  });
  Object.keys(years).sort((a, b) => b - a).forEach((y) => {
    const Y = years[y];
    const sec = el("div", "year");
    const head = el("div", "year-head");
    head.append(el("h3", null, y), el("span", "num", fmt(Y.total) + " MT"));
    sec.appendChild(head);
    const srcs = el("div", "sources");
    Object.keys(Y.sources).sort((a, b) => Y.sources[b] - Y.sources[a]).forEach((s) => {
      const c = el("span", "chip", s + " · "); c.appendChild(el("b", null, fmt(Y.sources[s]) + " MT")); srcs.appendChild(c);
    });
    sec.appendChild(srcs);
    Object.keys(Y.months).sort((a, b) => b - a).forEach((m) => {
      const M = Y.months[m];
      const mh = el("div", "month-head");
      mh.append(el("span", null, MONTHS[m]), el("span", "num", fmt(M.total) + " MT"));
      sec.appendChild(mh);
      const ul = el("ul", "items");
      M.items.forEach((d) => { const li = el("li"); li.appendChild(depositRow(d)); ul.appendChild(li); });
      sec.appendChild(ul);
    });
    body.appendChild(sec);
  });
}
function renderSources() {
  const seen = {}; els.sourceList.innerHTML = "";
  state.deposits.forEach((d) => {
    const s = (d.source || "").trim(); if (!s || seen[s.toLowerCase()]) return; seen[s.toLowerCase()] = 1;
    const o = document.createElement("option"); o.value = s; els.sourceList.appendChild(o);
  });
}

/* ---------------- Goal editor ---------------- */
function edRow(g) {
  const row = el("div", "ed-row"); row.dataset.id = g.id;
  const n = el("input", "inp ed-name"); n.value = g.name; n.placeholder = "Nome da meta"; n.setAttribute("aria-label", "Nome da meta");
  const v = el("input", "inp ed-cap"); v.inputMode = "numeric"; v.value = g.cap ? fmt(g.cap) : ""; v.placeholder = "Valor"; v.setAttribute("aria-label", "Valor da meta");
  moneyInput(v); v.addEventListener("input", updateEdSum);
  const rm = el("button", "btn-text danger", "Remover"); rm.type = "button";
  confirmButton(rm, "Remover", () => { row.remove(); updateEdSum(); });
  row.append(n, v, rm);
  return row;
}
function readEditor() {
  return Array.prototype.map.call(els.edRows.children, (r) => ({ id: r.dataset.id, name: r.querySelector(".ed-name").value.trim(), cap: parseAmount(r.querySelector(".ed-cap").value) }));
}
function updateEdSum() {
  els.edSum.textContent = "";
  els.edSum.append(document.createTextNode("Total das metas: "), el("b", null, fmt(sumCaps(readEditor())) + " MT"));
}
function closeEditor() { els.editor.hidden = true; els.editBtn.hidden = false; }
els.editBtn.addEventListener("click", () => {
  els.edRows.innerHTML = "";
  state.goals.forEach((g) => els.edRows.appendChild(edRow(g)));
  updateEdSum();
  els.editor.hidden = false; els.editBtn.hidden = true;
});
els.edCancel.addEventListener("click", closeEditor);
els.edAdd.addEventListener("click", () => {
  const r = edRow({ id: "g" + Date.now().toString(36), name: "", cap: 0 });
  els.edRows.appendChild(r); r.querySelector(".ed-name").focus(); updateEdSum();
});
els.edSave.addEventListener("click", () => {
  const list = readEditor();
  if (!list.length) { flashHint("Mantém pelo menos uma meta.", true); return; }
  for (let k = 0; k < list.length; k++) {
    if (!list[k].name) { els.edRows.children[k].querySelector(".ed-name").focus(); flashHint("Dá um nome a cada meta.", true); return; }
    if (!list[k].cap) { els.edRows.children[k].querySelector(".ed-cap").focus(); flashHint("Indica o valor de cada meta.", true); return; }
  }
  els.edSave.disabled = true;
  setDoc(cofreDoc, { goals: list, updatedAt: new Date().toISOString() }, { merge: true })
    .then(() => { closeEditor(); flashHint("Metas guardadas.", false); })
    .catch(() => flashHint("Não foi possível guardar as metas. Tenta de novo.", true))
    .finally(() => { els.edSave.disabled = false; });
});

/* ---------------- Events ---------------- */
els.histBtn.addEventListener("click", () => {
  const open = els.history.hidden;
  els.history.hidden = !open;
  els.histBtn.setAttribute("aria-expanded", String(open));
  els.histBtn.textContent = open ? "Fechar histórico" : "Histórico";
  if (open) { renderHistory(); els.history.scrollIntoView({ behavior: "smooth", block: "start" }); }
});
els.amount.addEventListener("input", () => {
  const n = parseAmount(els.amount.value);
  els.amount.value = n ? fmt(n) : "";
  render();
});
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const amount = parseAmount(els.amount.value);
  const source = els.source.value.trim();
  if (!amount || !depositsCol) return;
  if (!source) { flashHint("Indica a proveniência para o balanço anual.", true); els.source.focus(); return; }
  els.addBtn.disabled = true;
  // without internet the write is kept on the device and syncs later, so clear the form right away
  addDoc(depositsCol, { amount, source: canonicalSource(source), at: new Date().toISOString() })
    .catch(() => flashHint("Não foi possível guardar. Verifica a ligação e tenta de novo.", true));
  els.amount.value = ""; els.source.value = "";
  flashHint(fmt(amount) + " MT guardados no cofre.", false);
  render();
});

buildGoalBars();
render();
