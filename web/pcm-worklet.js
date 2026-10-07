// Convierte el audio del micrófono (a la frecuencia nativa del AudioContext, p. ej. 48 kHz)
// en PCM de 16 bits, mono, 16 kHz, en bloques de 100 ms, que es lo que espera la Gemini Live API.
const TARGET_RATE = 16000;
const BLOCK = 1600; // 100 ms a 16 kHz

class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0; // muestras de entrada acumuladas hacia la próxima muestra de salida
    this.acc = 0;
    this.cnt = 0;
    this.sumSq = 0;
    this.out = new Int16Array(BLOCK);
    this.n = 0;
    this.port.onmessage = (e) => { if (e.data === "flush") this.flush(); };
  }

  flush() {
    if (this.n === 0) return;
    const pcm = this.out.slice(0, this.n);
    this.port.postMessage({ pcm: pcm.buffer, level: Math.sqrt(this.sumSq / this.n) }, [pcm.buffer]);
    this.n = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // Promedio por ventana (filtro de caja) antes de diezmar: evita aliasing grueso.
      this.acc += ch[i];
      this.cnt++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let s = this.acc / this.cnt;
        this.acc = 0;
        this.cnt = 0;
        s = s > 1 ? 1 : s < -1 ? -1 : s;
        this.sumSq += s * s;
        this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === BLOCK) {
          const level = Math.sqrt(this.sumSq / BLOCK);
          this.port.postMessage({ pcm: this.out.buffer, level }, [this.out.buffer]);
          this.out = new Int16Array(BLOCK);
          this.n = 0;
          this.sumSq = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);
