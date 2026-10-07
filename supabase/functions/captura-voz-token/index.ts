// captura-voz-token: emite un token efímero de la Gemini Live API para la PWA de Voznotes.
// El navegador nunca ve GEMINI_API_KEY: recibe un token de un solo uso, que vence rápido
// y que queda atado al modelo y la configuración de transcripción en vivo.
// Autenticación propia: header x-captura-key (por eso verify_jwt=false).
import { GoogleGenAI, Modality } from "npm:@google/genai@2.27.0";

// SHA-256 de la clave de captura (la clave en sí no vive en el código).
const CAPTURE_KEY_SHA256 = "ecb54f9fdaf52ee97b7b77235f8d5fc51e0aa48c21b8552e825d97406482d0a7";
const LIVE_MODEL = Deno.env.get("GEMINI_LIVE_MODEL") || "gemini-3.5-transcribe-live";

// Misma configuración que manda la PWA en el mensaje "setup"; el token la deja bloqueada.
export const LIVE_CONFIG = {
  responseModalities: [Modality.TEXT],
  inputAudioTranscription: {
    languageCodes: ["es-AR", "en-US"],
    customVocabulary: ["Mocoretá", "Loop Labs", "MTM Loop", "Notion", "Supabase", "Claude", "PIM", "Arcos", "Roca", "Carhué", "Delta"],
  },
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "x-captura-key, content-type",
  "access-control-max-age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8" } });
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Usá POST." }, 405);
  if (await sha256Hex(req.headers.get("x-captura-key") || "") !== CAPTURE_KEY_SHA256) {
    return json({ error: "Clave de captura inválida." }, 401);
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ error: "Falta GEMINI_API_KEY en los secretos de Supabase." }, 500);

  const now = Date.now();
  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        newSessionExpireTime: new Date(now + 60_000).toISOString(), // 1 min para abrir la sesión
        expireTime: new Date(now + 30 * 60_000).toISOString(), // la sesión puede durar hasta 30 min
        liveConnectConstraints: { model: LIVE_MODEL, config: LIVE_CONFIG },
        lockAdditionalFields: [], // bloquea exactamente los campos de arriba
      },
    });
    return json({ token: token.name, model: LIVE_MODEL, config: LIVE_CONFIG });
  } catch (e) {
    console.error("token_error", (e as Error).message);
    return json({ error: "Gemini no emitió el token: " + (e as Error).message.slice(0, 300) }, 502);
  }
});
