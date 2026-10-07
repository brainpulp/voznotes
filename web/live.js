// Sesión de transcripción en vivo con la Gemini Live API, usando un token efímero.
// Funciona igual en el navegador y en Node (para las pruebas).

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

const MAX_QUEUE = 300; // ~30 s de audio en espera mientras se conecta

export function pcmToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// getToken(): Promise<{token, model, config}> — lo provee la función captura-voz-token.
// onUpdate({final, interim}): texto acumulado confirmado + hipótesis en curso.
// onStatus(state, detail): "connecting" | "open" | "reconnecting" | "closed" | "error".
export class LiveTranscriber {
  constructor({ getToken, onUpdate, onStatus, WebSocketImpl }) {
    this.getToken = getToken;
    this.onUpdate = onUpdate || (() => {});
    this.onStatus = onStatus || (() => {});
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this.final = "";
    this.interim = "";
    this.queue = [];
    this.ws = null;
    this.ready = false;
    this.active = false;
    this.reconnects = 0;
    this.connecting = null;
  }

  get text() {
    return joinText(this.final, this.interim).trim();
  }

  start() {
    this.active = true;
    this.connecting = this._connect();
    return this.connecting;
  }

  async _connect() {
    this.ready = false;
    this.onStatus(this.reconnects ? "reconnecting" : "connecting");
    let t;
    try {
      t = await this.getToken();
    } catch (e) {
      this.onStatus("error", e.message);
      return;
    }
    if (!this.active) return;

    const ws = new this.WS(`${WS_BASE}?access_token=${encodeURIComponent(t.token)}`);
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: `models/${t.model}`,
          generationConfig: { responseModalities: t.config.responseModalities },
          inputAudioTranscription: t.config.inputAudioTranscription,
        },
      }));
    };

    ws.onmessage = async (ev) => {
      let raw = ev.data;
      if (typeof raw !== "string") {
        raw = raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : await raw.text();
      }
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this._handle(msg);
    };

    ws.onerror = () => {};

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ready = false;
      // Lo que estaba como hipótesis se conserva: es mejor que perderlo.
      if (this.interim) { this.final = joinText(this.final, this.interim); this.interim = ""; this._emit(); }
      if (this.active && this.reconnects < 5) {
        // La sesión se cortó (límite de duración, red, GoAway): abrimos otra con un token nuevo.
        this.reconnects++;
        this.connecting = this._connect();
      } else {
        this.onStatus(this.active ? "error" : "closed", ev.reason || `código ${ev.code}`);
      }
    };
  }

  _handle(msg) {
    if (msg.setupComplete) {
      this.ready = true;
      this.onStatus("open");
      for (const chunk of this.queue) this._sendAudio(chunk);
      this.queue = [];
      return;
    }
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interimInputTranscription && typeof sc.interimInputTranscription.text === "string") {
        this.interim = sc.interimInputTranscription.text;
      }
      if (sc.inputTranscription && typeof sc.inputTranscription.text === "string") {
        this.final = joinText(this.final, sc.inputTranscription.text);
        this.interim = "";
      }
      this._emit();
    }
    if (msg.goAway) {
      // El servidor avisa que va a cerrar; onclose se encarga de reconectar.
    }
  }

  _emit() {
    this.onUpdate({ final: this.final, interim: this.interim });
  }

  _sendAudio(buf) {
    try {
      this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcmToBase64(buf), mimeType: "audio/pcm;rate=16000" } } }));
    } catch { /* la reconexión se encarga */ }
  }

  sendPcm(buf) {
    if (!this.active) return;
    if (this.ready && this.ws && this.ws.readyState === 1) this._sendAudio(buf);
    else if (this.queue.length < MAX_QUEUE) this.queue.push(buf);
  }

  // Avisa fin de audio, espera la última transcripción y cierra.
  async stop(waitMs = 2500) {
    const ws = this.ws;
    if (ws && ws.readyState === 1 && this.ready) {
      try { ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch { /* nada */ }
      await new Promise((resolve) => {
        let timer = setTimeout(resolve, waitMs);
        const prev = this.onUpdate;
        this.onUpdate = (u) => {
          prev(u);
          // Cuando llega texto confirmado y no queda hipótesis, cortamos antes.
          if (!this.interim) { clearTimeout(timer); timer = setTimeout(resolve, 400); }
        };
      });
    }
    this.active = false;
    if (this.interim) { this.final = joinText(this.final, this.interim); this.interim = ""; this._emit(); }
    try { ws && ws.close(1000, "fin"); } catch { /* nada */ }
    return this.text;
  }

  abort() {
    this.active = false;
    try { this.ws && this.ws.close(1000, "fin"); } catch { /* nada */ }
  }
}

// Une fragmentos de texto respetando espacios y saltos.
export function joinText(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  if (/\s$/.test(a) || /^[\s.,;:!?)]/.test(b)) return a + b;
  return a + " " + b;
}
