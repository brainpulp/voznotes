// captura-voz: recibe un audio del Atajo de iPhone, lo transcribe con Gemini
// y crea una nota en Notion ("Notas y proyectos", type=nota, more tags=ADMIN).
// Autenticación propia: header x-captura-key (por eso verify_jwt=false).
//
// Agregados para la PWA de Voznotes (el comportamiento del Atajo no cambia):
// - CORS + OPTIONS, para que el navegador pueda llamar a la función.
// - Modo texto: POST con content-type application/json y {"texto": "..."}.
//   Gemini limpia el texto y le pone título; si Gemini falla, se guarda el texto tal cual.
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

// SHA-256 de la clave de captura (la clave en sí no vive en el código).
const CAPTURE_KEY_SHA256 = "ecb54f9fdaf52ee97b7b77235f8d5fc51e0aa48c21b8552e825d97406482d0a7";
const DATA_SOURCE_ID = "03b1a394-8ce1-49a9-b1a7-a5117a22847c";
const NOTION_VERSION = "2026-03-11";
const MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";
const MAX_BYTES = 18 * 1024 * 1024; // límite de audio inline de Gemini (~20 MB por pedido)
const MAX_TEXT = 100_000;

const NOMBRES = "Mocoretá, Loop Labs, MTM Loop, Notion, Supabase, Claude, PIM, Arcos, Roca, Carhué, Delta";

const PROMPT = `Transcribí este audio de una nota de voz personal.
- Puede mezclar castellano rioplatense e inglés: respetá cada idioma tal como se habla, no traduzcas nada.
- Puntuá bien, sacá muletillas (eh, este, o sea, um) y repeticiones involuntarias, sin cambiar el sentido ni resumir.
- Separá en párrafos si cambia el tema.
- Nombres propios que pueden aparecer: ${NOMBRES}.
Devolvé solo JSON: {"titulo": string, "texto": string}. El título resume la nota en 8 palabras como máximo, en el idioma predominante del audio. Si el audio no tiene habla, devolvé {"titulo": "", "texto": ""}.`;

const PROMPT_TEXTO = `Este es el texto de una nota de voz personal, transcripto automáticamente en vivo.
- Puede mezclar castellano rioplatense e inglés: respetá cada idioma tal como está, no traduzcas nada.
- Corregí puntuación y errores obvios de reconocimiento, sacá muletillas y repeticiones involuntarias, sin cambiar el sentido ni resumir ni agregar nada.
- Separá en párrafos si cambia el tema.
- Nombres propios que pueden aparecer: ${NOMBRES}.
Devolvé solo JSON: {"titulo": string, "texto": string}. El título resume la nota en 8 palabras como máximo, en el idioma predominante.

Texto:
`;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "x-captura-key, content-type",
  "access-control-max-age": "86400",
};

function text(msg: string, status = 200) {
  return new Response(msg, { status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeMime(m: string): string {
  m = (m || "").split(";")[0].trim().toLowerCase();
  if (["audio/x-m4a", "audio/m4a", "audio/mp4a-latm", "video/mp4", "application/octet-stream", ""].includes(m)) return "audio/mp4";
  if (m === "audio/x-wav") return "audio/wav";
  if (m === "video/webm") return "audio/webm";
  return m.startsWith("audio/") ? m : "audio/mp4";
}

async function gemini(parts: unknown[], key: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  };
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
  const raw = await r.text();
  return { ok: r.ok, status: r.status, raw };
}

function transcribe(b64: string, mime: string, key: string) {
  return gemini([{ inline_data: { mime_type: mime, data: b64 } }, { text: PROMPT }], key);
}

function parseNota(raw: string): { titulo: string; texto: string } {
  const j = JSON.parse(raw);
  const out = (j.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
  const parsed = JSON.parse(out.replace(/```json|```/g, "").trim());
  return { titulo: String(parsed.titulo || "").trim(), texto: String(parsed.texto || "").trim() };
}

function chunks(s: string, n = 1900): string[] {
  const out: string[] = [];
  for (const para of s.split(/\n\s*\n/)) {
    let p = para.trim();
    while (p.length > n) { out.push(p.slice(0, n)); p = p.slice(n); }
    if (p) out.push(p);
  }
  return out;
}

function tituloDesdeTexto(s: string): string {
  const words = s.replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  return words.length > 60 ? words.slice(0, 60) : words;
}

async function crearNota(titulo: string, cuerpo: string, notionToken: string): Promise<Response> {
  const page = {
    parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID },
    properties: {
      name: { title: [{ text: { content: titulo.slice(0, 200) } }] },
      type: { multi_select: [{ name: "nota" }] },
      "more tags": { multi_select: [{ name: "ADMIN" }] },
    },
    children: chunks(cuerpo).map((c) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: c } }] },
    })),
  };
  const n = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: { "Authorization": `Bearer ${notionToken}`, "Notion-Version": NOTION_VERSION, "content-type": "application/json" },
    body: JSON.stringify(page),
  });
  if (!n.ok) {
    const raw = await n.text();
    console.error("notion_error", n.status, raw.slice(0, 1500));
    return text(`Notion rechazó la nota (${n.status}). Transcripción: ${cuerpo}`, 502);
  }
  return text(`Guardada: ${titulo}`);
}

// Modo texto (PWA): {"texto": "..."} → Gemini pone título y limpia → Notion.
async function desdeTexto(req: Request, geminiKey: string, notionToken: string): Promise<Response> {
  let original = "";
  try {
    const body = await req.json();
    original = String(body?.texto ?? "").trim();
  } catch {
    return text("JSON inválido: mandá {\"texto\": \"...\"}.", 400);
  }
  if (!original) return text("El texto llegó vacío. No se creó la nota.", 422);
  if (original.length > MAX_TEXT) return text("El texto es demasiado largo para una nota.", 413);

  let titulo = "", cuerpo = "";
  const g = await gemini([{ text: PROMPT_TEXTO + original }], geminiKey);
  if (g.ok) {
    try {
      ({ titulo, texto: cuerpo } = parseNota(g.raw));
    } catch (e) {
      console.error("parse_error_texto", (e as Error).message, g.raw.slice(0, 1500));
    }
  } else {
    console.error("gemini_error_texto", g.status, g.raw.slice(0, 1500));
  }
  // Si Gemini falla, la nota se guarda igual con el texto original.
  if (!cuerpo) cuerpo = original;
  if (!titulo) titulo = tituloDesdeTexto(cuerpo);
  return crearNota(titulo, cuerpo, notionToken);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return text("Usá POST con el audio.", 405);
  if (await sha256Hex(req.headers.get("x-captura-key") || "") !== CAPTURE_KEY_SHA256) return text("Clave de captura inválida.", 401);

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  const notionToken = Deno.env.get("NOTION_TOKEN");
  if (!geminiKey || !notionToken) return text("Faltan GEMINI_API_KEY o NOTION_TOKEN en los secretos de Supabase.", 500);

  const ct = req.headers.get("content-type") || "";
  if (ct.toLowerCase().startsWith("application/json")) return desdeTexto(req, geminiKey, notionToken);

  // Audio: multipart (campo de archivo) o cuerpo crudo.
  let bytes: Uint8Array;
  let mime: string;
  try {
    if (ct.startsWith("multipart/form-data")) {
      const fd = await req.formData();
      let f: File | null = null;
      for (const [, v] of fd.entries()) if (v instanceof File) { f = v; break; }
      if (!f) return text("No llegó ningún archivo de audio.", 400);
      bytes = new Uint8Array(await f.arrayBuffer());
      mime = normalizeMime(f.type);
    } else {
      bytes = new Uint8Array(await req.arrayBuffer());
      mime = normalizeMime(ct);
    }
  } catch (e) {
    return text("No pude leer el audio: " + (e as Error).message, 400);
  }
  if (bytes.length < 1000) return text("El audio llegó vacío o demasiado corto.", 400);
  if (bytes.length > MAX_BYTES) return text("El audio es demasiado largo para una nota (máximo ~18 MB).", 413);

  const b64 = encodeBase64(bytes);
  let g = await transcribe(b64, mime, geminiKey);
  if (!g.ok && g.status === 400 && mime === "audio/mp4") {
    g = await transcribe(b64, "audio/aac", geminiKey); // segundo intento con otro tipo para .m4a
  }
  if (!g.ok) {
    console.error("gemini_error", g.status, g.raw.slice(0, 1500));
    return text(`Gemini falló (${g.status}). Revisá los logs de captura-voz.`, 502);
  }

  let titulo = "", cuerpo = "";
  try {
    ({ titulo, texto: cuerpo } = parseNota(g.raw));
  } catch (e) {
    console.error("parse_error", (e as Error).message, g.raw.slice(0, 1500));
    return text("No pude interpretar la transcripción. Revisá los logs de captura-voz.", 502);
  }
  if (!cuerpo) return text("No se detectó habla en el audio. No se creó la nota.", 422);
  if (!titulo) titulo = cuerpo.slice(0, 60);

  return crearNota(titulo, cuerpo, notionToken);
});
