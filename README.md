# Voznotes

PWA para iPhone: grabás una nota de voz, ves la transcripción en vivo y al tocar stop se guarda en Notion.

## Cómo funciona

1. **Token en vivo** — `supabase/functions/captura-voz-token` (proyecto Supabase "pim") emite un token efímero
   de la Gemini Live API: un solo uso, 1 minuto para abrir la sesión, bloqueado al modelo
   `gemini-3.5-transcribe-live` y a su configuración. `GEMINI_API_KEY` nunca llega al navegador.
2. **Transcripción en vivo** — el navegador abre el WebSocket de la Live API con ese token, convierte el
   micrófono a PCM 16-bit 16 kHz (`web/pcm-worklet.js`) y muestra el texto a medida que llega (`web/live.js`).
3. **Nota final** — en paralelo graba el mismo audio con MediaRecorder (Safari: `audio/mp4`). Al tocar stop
   lo manda a `captura-voz`, que hace la transcripción final con Gemini y crea la página en Notion.
4. **Respaldo** — si el audio falla, manda el texto en vivo a `captura-voz` en modo texto
   (`{"texto": "..."}`). Toda nota queda guardada en el iPhone (localStorage + IndexedDB) hasta que se guarda.

Ambas funciones se autentican con el header `x-captura-key`; el código solo tiene su SHA-256.
La app pide la clave la primera vez y la guarda en el iPhone.

## Archivos

- `web/` — la app (HTML/CSS/JS sin build). Se publica en Netlify (`netlify.toml`).
- `supabase/functions/captura-voz/` — función existente del Atajo, con agregados: CORS y modo texto.
- `supabase/functions/captura-voz-token/` — función nueva que emite el token efímero.

## Deploy

- Funciones: se despliegan en el proyecto Supabase `ikztpvxfgmhmrcwolwgx` con `verify_jwt = false`.
- Web: carpeta `web/` en Netlify.

Para cambiar la clave de captura: calcular `printf '%s' 'NUEVA_CLAVE' | sha256sum`, reemplazar
`CAPTURE_KEY_SHA256` en las dos funciones, desplegarlas, y actualizar el Atajo y la app (ícono de engranaje).
