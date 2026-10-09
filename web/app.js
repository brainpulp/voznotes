import { LiveTranscriber } from "./live.js";

const FUNCTIONS = "https://ikztpvxfgmhmrcwolwgx.supabase.co/functions/v1";
const TOKEN_URL = `${FUNCTIONS}/captura-voz-token`;
const SAVE_URL = `${FUNCTIONS}/captura-voz`;
const KEY_STORE = "voznotes.key";
const PENDING_STORE = "voznotes.pending"; // notas sin guardar (texto); el audio va a IndexedDB
const DRAFT_STORE = "voznotes.draft"; // texto en vivo mientras se graba
const REVIEW_STORE = "voznotes.review"; // revisar/editar antes de guardar (por defecto sí)
const OPTIONS_STORE = "voznotes.options"; // opciones de tags leídas de Notion
const DEFAULT_TAGS = { type: ["nota"], moreTags: ["ADMIN"] };
const TAREA_TAG = "tarea"; // tag especial: la nota va a la base TAREAS con fecha de hoy
const HOY_URL = "https://www.notion.so/2417579326218009a5d6eb4291e12655?v=29675793262180729e4c000c0a1877f5";
const AUDIO_TIMEOUT_MS = 150_000;
const TEXT_TIMEOUT_MS = 60_000;

const $ = (id) => document.getElementById(id);
const ui = {
  status: $("status"), statusText: $("statusText"), timer: $("timer"),
  placeholder: $("placeholder"), finalText: $("finalText"), interimText: $("interimText"),
  transcript: $("transcript"), message: $("message"),
  recordBtn: $("recordBtn"), hint: $("hint"), meter: $("meter"), meterBar: $("meterBar"),
  pending: $("pending"), pendingText: $("pendingText"), retryBtn: $("retryBtn"),
  settingsBtn: $("settingsBtn"), keyDialog: $("keyDialog"), keyForm: $("keyForm"),
  keyInput: $("keyInput"), keyError: $("keyError"), keyCancel: $("keyCancel"),
  reviewToggle: $("reviewToggle"), controls: $("controls"),
  editor: $("editor"), editTitle: $("editTitle"), editText: $("editText"),
  editActions: $("editActions"), saveBtn: $("saveBtn"), discardBtn: $("discardBtn"),
  messageText: $("messageText"), messageLink: $("messageLink"),
  moreTagsChips: $("moreTagsChips"), tareaHint: $("tareaHint"),
  recentBtn: $("recentBtn"), recent: $("recent"), recentClose: $("recentClose"),
  recentList: $("recentList"), recentStatus: $("recentStatus"),
};

let rec = null; // grabación en curso
let busy = false; // guardando / reintentando
let editing = null; // nota abierta en el editor

// ---------- almacenamiento ----------

function lsGet(k, fallback = null) {
  try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin espacio o privado */ }
}
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* nada */ } }

const getKey = () => lsGet(KEY_STORE, "");
const getPending = () => lsGet(PENDING_STORE, []);
const setPending = (list) => (list.length ? lsSet(PENDING_STORE, list) : lsDel(PENDING_STORE));
const reviewOn = () => lsGet(REVIEW_STORE, true) !== false;
const needsReview = (n) => n.estado === "revisar";
function updatePending(note) {
  setPending(getPending().map((n) => (n.id === note.id ? note : n)));
}

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("voznotes", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("audio");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbOp(mode, fn) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("audio", mode);
      const req = fn(tx.objectStore("audio"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch { return undefined; }
}
const audioPut = (id, blob) => idbOp("readwrite", (s) => s.put(blob, id));
const audioGet = (id) => idbOp("readonly", (s) => s.get(id));
const audioDel = (id) => idbOp("readwrite", (s) => s.delete(id));

// ---------- UI ----------

function setState(state, text) {
  ui.status.dataset.state = state;
  ui.statusText.textContent = text;
}

function showMessage(text, kind, link, linkText = "Abrir en Notion") {
  ui.message.hidden = !text;
  ui.messageText.textContent = text || "";
  ui.messageLink.hidden = !link;
  ui.messageLink.textContent = linkText;
  if (link) ui.messageLink.href = link;
  ui.message.className = "message" + (kind ? " " + kind : "");
}

function renderTranscript(final, interim) {
  ui.finalText.textContent = final || "";
  ui.interimText.textContent = interim ? (final ? " " : "") + interim : "";
  ui.placeholder.hidden = !!(final || interim) || !!rec;
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function renderPending() {
  const n = getPending().filter((x) => !needsReview(x)).length;
  ui.pending.hidden = n === 0;
  ui.pendingText.textContent = n === 1 ? "1 nota sin guardar" : `${n} notas sin guardar`;
  ui.retryBtn.disabled = busy || !!rec;
}

function setButton(mode) {
  ui.recordBtn.classList.toggle("recording", mode === "recording");
  ui.recordBtn.disabled = mode === "disabled";
  ui.recordBtn.setAttribute("aria-label", mode === "recording" ? "Detener y guardar" : "Grabar");
  ui.hint.textContent = mode === "recording"
    ? (reviewOn() ? "Tocá para detener y revisar" : "Tocá para detener y guardar")
    : mode === "disabled" ? "" : "Grabar";
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------- clave ----------

function askKey(required) {
  ui.keyInput.value = getKey();
  ui.keyError.hidden = true;
  ui.keyCancel.hidden = required;
  ui.reviewToggle.checked = reviewOn();
  ui.keyDialog.showModal();
  setTimeout(() => ui.keyInput.focus(), 50);
}

ui.keyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = ui.keyInput.value.trim();
  if (!key) return;
  ui.keyError.hidden = true;
  try {
    await fetchToken(key); // valida la clave contra el servidor
    lsSet(KEY_STORE, key);
    ui.keyDialog.close();
    loadOptions();
    setState("idle", "Listo");
    retryPending();
  } catch (err) {
    ui.keyError.textContent = err.message;
    ui.keyError.hidden = false;
  }
});
ui.keyCancel.addEventListener("click", () => ui.keyDialog.close());
ui.reviewToggle.addEventListener("change", () => lsSet(REVIEW_STORE, ui.reviewToggle.checked));
ui.keyDialog.addEventListener("cancel", (e) => { if (!getKey()) e.preventDefault(); });
ui.settingsBtn.addEventListener("click", () => { if (!rec) askKey(false); });

// ---------- red ----------

async function fetchToken(key = getKey()) {
  let r;
  try {
    r = await fetch(TOKEN_URL, { method: "POST", headers: { "x-captura-key": key } });
  } catch {
    throw new Error("Sin conexión con el servidor.");
  }
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error("Clave de captura inválida.");
  if (!r.ok || !body.token) throw new Error(body.error || `No pude iniciar la transcripción (${r.status}).`);
  return body;
}

async function postWithTimeout(body, contentType, ms, url = SAVE_URL) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "x-captura-key": getKey(), "content-type": contentType },
      body,
      signal: ctrl.signal,
    });
    return { ok: r.ok, status: r.status, url: r.headers.get("x-nota-url") || "", text: (await r.text()).trim() };
  } catch (e) {
    return { ok: false, status: 0, text: e.name === "AbortError" ? "Se agotó el tiempo de espera." : "Sin conexión con el servidor." };
  } finally {
    clearTimeout(t);
  }
}

// Guarda una nota pendiente: primero el audio (transcripción final de calidad);
// si falla, el texto en vivo (modo texto de captura-voz). Devuelve {ok, msg, via}.
async function saveNote(note) {
  const blob = note.hasAudio ? await audioGet(note.id) : null;
  let audioRes = null;
  if (blob && blob.size > 1000) {
    audioRes = await postWithTimeout(blob, blob.type || "audio/mp4", AUDIO_TIMEOUT_MS);
    if (audioRes.ok) return { ok: true, msg: audioRes.text, url: audioRes.url, via: "audio" };
    if (audioRes.status === 401) return { ok: false, msg: "Clave de captura inválida.", fatal: true };
    // 422 = el audio no tiene habla: si tampoco hay texto en vivo, no hay nota.
    if (audioRes.status === 422 && !note.texto) return { ok: true, msg: audioRes.text, empty: true };
  }
  if (note.texto) {
    const t = await postWithTimeout(JSON.stringify({ texto: note.texto }), "application/json", TEXT_TIMEOUT_MS);
    if (t.ok) return { ok: true, msg: t.text, url: t.url, via: "texto" };
    if (t.status === 401) return { ok: false, msg: "Clave de captura inválida.", fatal: true };
    return { ok: false, msg: (audioRes ? audioRes.text + " / " : "") + t.text };
  }
  if (!blob) return { ok: true, msg: "No había audio ni texto para guardar.", empty: true };
  return { ok: false, msg: audioRes ? audioRes.text : "No se pudo enviar el audio." };
}

function dropPending(id) {
  setPending(getPending().filter((n) => n.id !== id));
  audioDel(id);
  renderPending();
}

function savedTitle(msg) {
  return msg.replace(/^(Guardada|Tarea para hoy):\s*/, "");
}

async function processNote(note, prefix = "") {
  setState("saving", "Guardando en Notion…");
  showMessage("");
  const res = await saveNote(note);
  if (res.ok) {
    dropPending(note.id);
    if (res.empty) {
      setState("idle", "Listo");
      showMessage(`${prefix}${res.msg}`, "err");
    } else {
      const title = savedTitle(res.msg);
      setState("saved", `Guardada: ${title}`);
      showMessage(`${prefix}${res.via === "texto" ? "Guardada (desde el texto en vivo)" : "Guardada"}: ${title}`, "ok", res.url);
    }
    return true;
  }
  setState("error", "No se guardó");
  showMessage(`${prefix}${res.msg} La nota quedó guardada en este iPhone; tocá Reintentar.`, "err");
  if (res.fatal) askKey(false);
  renderPending();
  return false;
}

async function retryPending() {
  if (busy || rec || !getKey()) return;
  const list = getPending().filter((n) => !needsReview(n));
  if (!list.length) return openNextReview();
  busy = true;
  renderPending();
  for (const note of list) {
    if (!(await processNote(note))) break;
  }
  busy = false;
  renderPending();
  openNextReview();
}

// ---------- revisar y editar antes de guardar ----------

function showEditor(on) {
  if (on) ui.recent.hidden = true;
  ui.editor.hidden = !on;
  ui.editActions.hidden = !on;
  ui.transcript.hidden = on;
  ui.controls.hidden = on;
}

function setEditorBusy(b) {
  ui.saveBtn.disabled = b;
  ui.discardBtn.disabled = b;
  ui.editTitle.disabled = b;
  ui.editText.disabled = b;
  for (const c of document.querySelectorAll(".chip")) c.disabled = b;
}

// Transcripción final desde el audio, sin crear la nota todavía.
async function transcribeOnly(note) {
  const blob = note.hasAudio ? await audioGet(note.id) : null;
  if (!blob || blob.size <= 1000) return null;
  const r = await postWithTimeout(blob, blob.type || "audio/mp4", AUDIO_TIMEOUT_MS, `${SAVE_URL}?modo=transcribir`);
  if (r.ok) {
    try { const j = JSON.parse(r.text); return { titulo: j.titulo || "", texto: j.texto || "" }; } catch { /* sigue */ }
  }
  return { error: r.status === 422 ? "No se detectó habla en el audio." : r.text };
}

// ---------- recientes ----------

function fmtFecha(iso) {
  const d = new Date(iso);
  const hoy = new Date();
  const ayer = new Date(Date.now() - 86_400_000);
  const hora = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === hoy.toDateString()) return `hoy ${hora}`;
  if (d.toDateString() === ayer.toDateString()) return `ayer ${hora}`;
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "short" }) + ` ${hora}`;
}

function renderRecent(notas) {
  ui.recentList.replaceChildren();
  for (const n of notas) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = n.url;
    a.target = "_blank";
    a.rel = "noopener";
    const t = document.createElement("div");
    t.className = "recent-title";
    t.textContent = n.titulo;
    const m = document.createElement("div");
    m.className = "recent-meta";
    m.textContent = [fmtFecha(n.creada), ...(n.tags || [])].join(" · ");
    a.append(t, m);
    li.append(a);
    ui.recentList.append(li);
  }
}

async function openRecent() {
  if (rec || editing) return;
  ui.recent.hidden = false;
  ui.transcript.hidden = true;
  ui.controls.hidden = true;
  showMessage("");
  const cached = lsGet("voznotes.recent", null);
  if (cached) renderRecent(cached);
  ui.recentStatus.textContent = cached ? "Actualizando…" : "Cargando…";
  const r = await postWithTimeout("{}", "application/json", 20_000, `${SAVE_URL}?modo=recientes`);
  if (ui.recent.hidden) return;
  try {
    const j = JSON.parse(r.text);
    if (!r.ok || !Array.isArray(j.notas)) throw new Error(j.error || r.text);
    lsSet("voznotes.recent", j.notas);
    renderRecent(j.notas);
    ui.recentStatus.textContent = j.notas.length ? "" : "Todavía no hay notas.";
  } catch (e) {
    ui.recentStatus.textContent = `No pude cargar las notas (${r.status ? e.message : "sin conexión"}).`;
  }
}

function closeRecent() {
  ui.recent.hidden = true;
  ui.transcript.hidden = false;
  ui.controls.hidden = false;
}

ui.recentBtn.addEventListener("click", () => (ui.recent.hidden ? openRecent() : closeRecent()));
ui.recentClose.addEventListener("click", closeRecent);

// ---------- tags ----------

function getOptions() {
  const o = lsGet(OPTIONS_STORE, null);
  return {
    moreTags: o?.moreTags?.length ? o.moreTags : ["RELEER", "CLAVE", "ADMIN", "ACCIÓN"],
  };
}

async function loadOptions() {
  if (!getKey()) return;
  const r = await postWithTimeout("{}", "application/json", 20_000, `${SAVE_URL}?modo=opciones`);
  if (!r.ok) return;
  try {
    const j = JSON.parse(r.text);
    if (Array.isArray(j.moreTags)) {
      lsSet(OPTIONS_STORE, { moreTags: j.moreTags });
      if (editing) renderChips();
    }
  } catch { /* se usan las opciones guardadas */ }
}

function noteTags(note) {
  return { moreTags: note.edit?.moreTags || [...DEFAULT_TAGS.moreTags] };
}

function renderChips() {
  if (!editing) return;
  const tags = noteTags(editing);
  const tarea = tags.moreTags.includes(TAREA_TAG);
  ui.moreTagsChips.replaceChildren();
  for (const name of [...getOptions().moreTags.filter((x) => x !== TAREA_TAG), TAREA_TAG]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (name === TAREA_TAG ? " tarea" : tarea ? " off" : "");
    b.textContent = name;
    b.setAttribute("aria-pressed", String(tags.moreTags.includes(name)));
    b.addEventListener("click", () => {
      if (!editing) return;
      const t = noteTags(editing);
      const i = t.moreTags.indexOf(name);
      if (i >= 0) t.moreTags.splice(i, 1); else t.moreTags.push(name);
      editing.edit = { ...editing.edit, ...t };
      updatePending(editing);
      renderChips();
    });
    ui.moreTagsChips.append(b);
  }
  ui.tareaHint.hidden = !tarea;
  ui.saveBtn.textContent = tarea ? "Guardar tarea" : "Guardar en Notion";
}

async function openEditor(note, prefix = "") {
  editing = note;
  showEditor(true);
  showMessage(prefix.trim());
  ui.editTitle.value = note.edit?.titulo || "";
  ui.editText.value = note.edit?.texto || note.texto || "";
  renderChips();
  if (!note.edit) {
    setEditorBusy(true);
    setState("saving", "Transcribiendo…");
    const res = await transcribeOnly(note);
    if (editing !== note) return;
    if (res && !res.error && res.texto) {
      note.edit = { ...noteTags(note), titulo: res.titulo, texto: res.texto };
      showMessage(prefix.trim());
    } else {
      note.edit = { ...noteTags(note), titulo: "", texto: note.texto || "" };
      const why = res?.error ? ` (${res.error})` : "";
      showMessage(`${prefix}No pude hacer la transcripción final${why}. Te dejo el texto en vivo para editar.`, "err");
    }
    updatePending(note);
    ui.editTitle.value = note.edit.titulo;
    ui.editText.value = note.edit.texto;
    setEditorBusy(false);
  }
  setState("idle", "Revisá y guardá");
}

function closeEditor() {
  editing = null;
  showEditor(false);
  setEditorBusy(false);
  renderPending();
}

function openNextReview() {
  if (editing || rec || busy) return;
  const next = getPending().find(needsReview);
  if (next) openEditor(next);
}

function onEdit() {
  if (!editing) return;
  editing.edit = { ...noteTags(editing), titulo: ui.editTitle.value, texto: ui.editText.value };
  updatePending(editing);
}
ui.editTitle.addEventListener("input", onEdit);
ui.editText.addEventListener("input", onEdit);

ui.saveBtn.addEventListener("click", async () => {
  const note = editing;
  if (!note) return;
  onEdit();
  const texto = ui.editText.value.trim();
  if (!texto) return showMessage("La nota está vacía. Escribí algo o tocá Descartar.", "err");
  setEditorBusy(true);
  setState("saving", "Guardando en Notion…");
  showMessage("");
  const tags = noteTags(note);
  const tarea = tags.moreTags.includes(TAREA_TAG);
  const payload = { titulo: ui.editTitle.value.trim(), texto, limpiar: false, type: DEFAULT_TAGS.type, more_tags: tags.moreTags.filter((x) => x !== TAREA_TAG) };
  if (tarea) Object.assign(payload, { destino: "tareas", fecha: new Date().toLocaleDateString("en-CA") });
  const r = await postWithTimeout(JSON.stringify(payload), "application/json", TEXT_TIMEOUT_MS);
  setEditorBusy(false);
  if (r.ok) {
    dropPending(note.id);
    closeEditor();
    const title = savedTitle(r.text);
    renderTranscript("", "");
    if (tarea) {
      setState("saved", `Tarea para hoy: ${title}`);
      showMessage(`Tarea para hoy: ${title}`, "ok", HOY_URL, "Ver tareas de HOY");
    } else {
      setState("saved", `Guardada: ${title}`);
      showMessage(`Guardada: ${title}`, "ok", r.url);
    }
    openNextReview();
  } else {
    setState("error", "No se guardó");
    showMessage(`${r.text} La nota sigue en este iPhone; probá Guardar de nuevo.`, "err");
    if (r.status === 401) askKey(false);
  }
});

ui.discardBtn.addEventListener("click", () => {
  const note = editing;
  if (!note || !confirm("¿Descartar esta nota? No se va a guardar en Notion.")) return;
  dropPending(note.id);
  closeEditor();
  renderTranscript("", "");
  setState("idle", "Listo");
  showMessage("Nota descartada.");
  openNextReview();
});

ui.retryBtn.addEventListener("click", retryPending);
window.addEventListener("online", retryPending);

// ---------- grabación ----------

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

async function startRecording() {
  if (!getKey()) return askKey(true);
  showMessage("");
  setButton("disabled");
  setState("connecting", "Conectando…");

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    setButton("idle");
    setState("error", "Sin micrófono");
    showMessage(e.name === "NotAllowedError"
      ? "No hay permiso para el micrófono. En Ajustes › Safari › Micrófono (o al abrir la app) permitilo y probá de nuevo."
      : `No pude abrir el micrófono: ${e.message}`, "err");
    return;
  }

  const id = `n${Date.now()}`;
  const r = { id, stream, chunks: [], startedAt: Date.now(), stopping: false };
  rec = r;
  renderTranscript("", "");
  ui.placeholder.hidden = true;
  lsSet(DRAFT_STORE, { id, texto: "", createdAt: r.startedAt });

  // 1) Grabación completa (Safari: audio/mp4) para la transcripción final.
  const mime = pickMime();
  if (mime !== null) {
    try {
      r.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      r.recorder.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
      r.recorder.start(1000);
    } catch {
      r.recorder = null;
    }
  }

  // 2) Audio en vivo → PCM 16 kHz → Gemini Live.
  r.live = new LiveTranscriber({
    getToken: () => fetchToken(),
    onUpdate: ({ final, interim }) => {
      if (rec !== r) return;
      renderTranscript(final, interim);
      lsSet(DRAFT_STORE, { id, texto: r.live.text, createdAt: r.startedAt });
    },
    onStatus: (s, detail) => {
      if (rec !== r || r.stopping) return;
      if (s === "open") setState("listening", "Escuchando");
      else if (s === "connecting") setState("connecting", "Conectando…");
      else if (s === "reconnecting") setState("connecting", "Reconectando…");
      else if (s === "error") {
        setState("listening", "Grabando (sin texto en vivo)");
        showMessage(`Texto en vivo no disponible (${detail}). La grabación sigue y se transcribe al guardar.`, "err");
      }
    },
  });

  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    r.ctx = new AC();
    if (r.ctx.state === "suspended") await r.ctx.resume();
    await r.ctx.audioWorklet.addModule("pcm-worklet.js");
    r.source = r.ctx.createMediaStreamSource(stream);
    r.node = new AudioWorkletNode(r.ctx, "pcm16-downsampler");
    r.node.port.onmessage = (e) => {
      r.live.sendPcm(e.data.pcm);
      ui.meterBar.style.width = `${Math.min(100, e.data.level * 400)}%`;
    };
    const mute = r.ctx.createGain();
    mute.gain.value = 0;
    r.source.connect(r.node).connect(mute).connect(r.ctx.destination);
    r.live.start();
  } catch (e) {
    showMessage(`Texto en vivo no disponible (${e.message}). La grabación sigue y se transcribe al guardar.`, "err");
  }

  if (!r.recorder && !r.node) {
    cleanup(r);
    rec = null;
    setButton("idle");
    setState("error", "No se pudo grabar");
    return;
  }

  // Si el micrófono se corta (llamada, Siri, otra app), guardamos lo que haya.
  for (const tr of stream.getAudioTracks()) tr.addEventListener("ended", () => stopRecording("El micrófono se cortó; corté la grabación ahí."));

  try { r.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* opcional */ }

  ui.meter.classList.add("on");
  ui.timer.hidden = false;
  ui.timer.textContent = "0:00";
  r.tick = setInterval(() => { ui.timer.textContent = fmtTime(Date.now() - r.startedAt); }, 500);
  setButton("recording");
  renderPending();
  if (ui.status.dataset.state !== "listening") setState("connecting", "Conectando…");
}

function cleanup(r) {
  clearInterval(r.tick);
  try { r.node && r.node.disconnect(); } catch { /* nada */ }
  try { r.source && r.source.disconnect(); } catch { /* nada */ }
  try { r.ctx && r.ctx.close(); } catch { /* nada */ }
  for (const tr of r.stream.getTracks()) tr.stop();
  try { r.wakeLock && r.wakeLock.release(); } catch { /* nada */ }
  ui.meter.classList.remove("on");
  ui.meterBar.style.width = "0";
}

function stopRecorder(r) {
  return new Promise((resolve) => {
    if (!r.recorder || r.recorder.state === "inactive") return resolve();
    r.recorder.onstop = () => resolve();
    try { r.recorder.requestData(); } catch { /* nada */ }
    r.recorder.stop();
    setTimeout(resolve, 3000);
  });
}

async function stopRecording(reason) {
  const r = rec;
  if (!r || r.stopping) return;
  r.stopping = true;
  setButton("disabled");
  setState("saving", "Terminando…");
  ui.timer.hidden = true;

  try { r.node && r.node.port.postMessage("flush"); } catch { /* nada */ }
  const [texto] = await Promise.all([r.live.stop(), stopRecorder(r)]);
  cleanup(r);

  const blob = r.chunks.length ? new Blob(r.chunks, { type: r.chunks[0].type || r.recorder?.mimeType || "audio/mp4" }) : null;
  const review = reviewOn();
  const note = { id: r.id, texto, createdAt: r.startedAt, hasAudio: !!blob, ...(review ? { estado: "revisar" } : {}) };
  // Primero queda guardada en el iPhone; recién después se manda.
  setPending([...getPending().filter((n) => n.id !== note.id), note]);
  if (blob) await audioPut(note.id, blob);
  lsDel(DRAFT_STORE);
  rec = null;
  renderTranscript(texto, "");
  setButton("idle");

  if (review) {
    await openEditor(note, reason ? `${reason} ` : "");
    return;
  }

  busy = true;
  renderPending();
  await processNote(note, reason ? `${reason} ` : "");
  busy = false;
  renderPending();
  retryPending();
}

ui.recordBtn.addEventListener("click", () => {
  if (rec) stopRecording();
  else if (!busy) startRecording();
});

// iOS suspende el micrófono de las web apps en segundo plano: al salir de la app
// cortamos y guardamos lo grabado hasta ese momento.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && rec) {
    stopRecording(reviewOn()
      ? "La app pasó a segundo plano; corté la grabación ahí."
      : "La app pasó a segundo plano; guardé lo grabado hasta ahí.");
  } else if (document.visibilityState === "visible" && !rec) {
    retryPending();
  }
});
window.addEventListener("pagehide", () => {
  if (rec) lsSet(DRAFT_STORE, { id: rec.id, texto: rec.live.text, createdAt: rec.startedAt });
});

// ---------- arranque ----------

function recoverDraft() {
  // Si la app se cerró en medio de una grabación, el texto en vivo quedó en el borrador.
  const d = lsGet(DRAFT_STORE);
  if (d && d.texto && !getPending().some((n) => n.id === d.id)) {
    setPending([...getPending(), { id: d.id, texto: d.texto, createdAt: d.createdAt, hasAudio: false, ...(reviewOn() ? { estado: "revisar" } : {}) }]);
  }
  lsDel(DRAFT_STORE);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

recoverDraft();
renderPending();
setButton("idle");
if (!navigator.mediaDevices?.getUserMedia) {
  setState("error", "Navegador sin micrófono");
  showMessage("Este navegador no permite grabar. Abrí la app desde Safari en el iPhone.", "err");
  setButton("disabled");
} else if (!getKey()) {
  askKey(true);
} else {
  loadOptions();
  retryPending();
}
