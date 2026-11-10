import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages, tool, stepCountIs } from "ai";
import { z } from "zod";

// ── База знаний (имитация RAG) ────────────────────────────────
const KNOWLEDGE: Record<string, string> = {
  "квантовые компьютеры": "Квантовые компьютеры используют кубиты вместо битов. Google Sycamore достиг квантового превосходства в 2019 году. IBM разрабатывает процессоры с 1000+ кубитами. Ключевые применения: криптография, оптимизация, молекулярное моделирование.",
  "машинное обучение": "Машинное обучение — подраздел ИИ, где модели обучаются на данных без явного программирования. Основные типы: supervised (с учителем), unsupervised (без учителя), reinforcement learning (с подкреплением). Популярные фреймворки: TensorFlow, PyTorch.",
  "блокчейн": "Блокчейн — распределённый реестр транзакций, защищённый криптографией. Bitcoin использует Proof-of-Work, Ethereum перешёл на Proof-of-Stake в 2022 году. Смарт-контракты позволяют автоматизировать соглашения без посредников.",
  "cloudflare workers": "Cloudflare Workers — serverless платформа для запуска JavaScript/TypeScript на 300+ edge-серверах. Поддерживает Durable Objects (stateful), KV (key-value), R2 (object storage), Workers AI (LLM inference). Время холодного старта <1ms.",
  "durable objects": "Durable Objects — stateful вычисления на Cloudflare с уникальным ID, SQLite-хранилищем и WebSocket. Гарантируют single-threaded execution. Идеальны для чатов, игровых сессий, агентов. Состояние переживает редеплои и отказы серверов.",
  "agents sdk": "Agents SDK — фреймворк Cloudflare для создания AI-агентов. Предоставляет: tools (инструменты), WebSocket streaming, persistent state, scheduling. Агент сам выбирает какие tools вызывать на основе контекста.",
  "websocket": "WebSocket — протокол двусторонней связи поверх TCP. В отличие от HTTP, соединение остаётся открытым. Используется для real-time приложений: чаты, уведомления, live-обновления. Agents SDK использует hibernatable WebSockets (экономят ресурсы).",
};

// ── Слой 1: локальный словарь (детерминированный, без сети) ────
const KNOWN_CITIES: Record<string, { lat: number; lon: number; region: string }> = {
  "мурманск":        { lat: 68.9707, lon: 33.0749,  region: "Мурманская область" },
  "москва":          { lat: 55.7558, lon: 37.6173,  region: "Москва" },
  "санкт-петербург": { lat: 59.9343, lon: 30.3351,  region: "Ленинградская область" },
  "спб":             { lat: 59.9343, lon: 30.3351,  region: "Ленинградская область" },
  "сочи":            { lat: 43.6028, lon: 39.7342,  region: "Краснодарский край" },
  "казань":          { lat: 55.7887, lon: 49.1221,  region: "Татарстан" },
  "новосибирск":     { lat: 55.0084, lon: 82.9357,  region: "Новосибирская область" },
  "екатеринбург":    { lat: 56.8389, lon: 60.6057,  region: "Свердловская область" },
  "владивосток":     { lat: 43.1155, lon: 131.8855, region: "Приморский край" },
  "норильск":        { lat: 69.3536, lon: 88.2027,  region: "Красноярский край" },
  "якутск":          { lat: 62.0355, lon: 129.6755, region: "Саха (Якутия)" },
};

// ── Транслитерация для запасного запроса латиницей ─────────────
const TRANSLIT: Record<string, string> = {
  "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"e","ж":"zh","з":"z",
  "и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r",
  "с":"s","т":"t","у":"u","ф":"f","х":"kh","ц":"ts","ч":"ch","ш":"sh",
  "щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya",
};
function translit(s: string): string {
  return s.toLowerCase().split("").map((ch) => TRANSLIT[ch] ?? ch).join("");
}

// ── Тип колбэка прогресса: tool докладывает о каждом шаге ─────
type EmitFn = (step: string, message: string, status?: "start" | "done" | "error") => void;

// ── Геокодинг: ТОЛЬКО точное совпадение, иначе эскалация ───────
// ── Нормализация падежей для русского языка ─────────────────
function normalizeCity(city: string): string {
  const suffixes = ["е", "у", "а", "ы", "и", "ом", "ем"];
  let normalized = city.trim();
  
  // Убираем распространённые окончания предложного падежа
  for (const suffix of suffixes) {
    if (normalized.endsWith(suffix) && normalized.length > 4) {
      normalized = normalized.slice(0, -1);
      break;
    }
  }
  
  return normalized;
}

async function geocode(city: string, emit?: EmitFn): Promise<{ lat: number; lon: number; name: string; region: string; source: string } | null> {
  const key = city.trim().toLowerCase();

  // Слой 1: словарь — мгновенно и без сети
  const local = KNOWN_CITIES[key];
  if (local) {
    console.log(`[GEO] layer1 dict: "${city}" → (${local.lat}, ${local.lon})`);
    emit?.("geo", `Координаты «${city}» найдены в словаре`, "done");
    return { lat: local.lat, lon: local.lon, name: city, region: local.region, source: "dict" };
  }

  // Слой 2: Open-Meteo, запросы ru → транслит; принимаем ТОЛЬКО exact match
  for (const [lang, q] of [["ru", city], ["en", translit(city)]] as const) {
    try {
      const res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=10&language=${lang}`
      );
      const geo = await res.json() as { results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string }> };
      const list = geo.results ?? [];
      const exact = list.find((r) => r.name.trim().toLowerCase() === q.trim().toLowerCase());
      if (exact) {
        console.log(`[GEO] layer2 open-meteo(${lang}) EXACT: "${q}" → (${exact.latitude}, ${exact.longitude})`);
        emit?.("geo", `Open-Meteo (${lang}): точное совпадение «${exact.name}»`, "done");
        return { lat: exact.latitude, lon: exact.longitude, name: exact.name, region: exact.admin1 ?? "", source: `open-meteo:${lang}` };
      }
      console.log(`[GEO] layer2 open-meteo(${lang}): ${list.length} candidates, NO exact match — rejected: ` + list.map((r) => r.name).join(", "));
        emit?.("geo", `Open-Meteo (${lang}): точного совпадения нет, отклонено кандидатов: ${list.length}`, "error");
    } catch (e) {
      console.log(`[GEO] layer2 open-meteo(${lang}) error:`, e);
    }
  }

  // Слой 3: OpenStreetMap Nominatim — авторитетный источник
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=jsonv2&limit=1&accept-language=ru`,
      { headers: { "User-Agent": "my-first-agent-edu/1.0" } }
    );
    const arr = await res.json() as Array<{ lat: string; lon: string; display_name: string }>;
    if (arr?.[0]) {
      console.log(`[GEO] layer3 nominatim: "${city}" → (${arr[0].lat}, ${arr[0].lon})`);
      emit?.("geo", `OpenStreetMap: «${city}» найден`, "done");
      return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), name: city, region: arr[0].display_name, source: "osm" };
    }
  } catch (e) {
    console.log(`[GEO] layer3 nominatim error:`, e);
  }

  console.log(`[GEO] ALL LAYERS FAILED for "${city}"`);
  emit?.("geo", `«${city}» не найден ни в одном источнике`, "error");
  return null;
}

// ── Реальная погода через open-meteo.com ─────────────────────
async function fetchWeather(city: string, emit?: EmitFn): Promise<{ temp: number; condition: string; city: string }> {
  try {
    const place = await geocode(city, emit);
    if (!place) {
      return { temp: 0, condition: "город не найден: ни один источник не дал точного совпадения", city };
    }

    emit?.("weather", "Запрашиваю погоду у Open-Meteo…", "start");
    // Retry loop: 3 попытки при сетевых сбоях Open-Meteo
    let wx: { current?: { temperature_2m: number; weather_code: number } } | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const wxRes = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,weather_code`
        );
        if (!wxRes.ok) throw new Error(`HTTP ${wxRes.status}`);
        const data = await wxRes.json() as typeof wx;
        if (data?.current?.temperature_2m !== undefined) {
          wx = data;
          break;
        }
        throw new Error("empty current data");
      } catch (e) {
        lastErr = e;
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
          emit?.("weather", `Попытка ${attempt}/3: ${e instanceof Error ? e.message : "сбой"}`, "error");
        }
      }
    }

    if (!wx?.current) {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      emit?.("weather", `Open-Meteo не ответил после 3 попыток: ${msg}`, "error");
      return { temp: 0, condition: `ошибка API (${msg})`, city: place.name };
    }

    const temp = Math.round(wx.current.temperature_2m);
    const code = wx.current.weather_code;
    let condition = "облачно";
    if (code === 0 || code === 1) condition = "ясно";
    else if (code >= 2 && code <= 3) condition = "облачно";
    else if (code >= 51 && code <= 67) condition = "дождь";
    else if (code >= 71 && code <= 77) condition = "снег";
    else if (code >= 95) condition = "гроза";

    emit?.("weather", `${place.name}: ${temp}°C, ${condition}`, "done");
    console.log(`[WORKER] fetchWeather: ${city} → ${place.name} [${place.source}] (${place.lat}, ${place.lon}) → ${temp}°C, ${condition}`);
    return { temp, condition, city: place.name };
  } catch (e) {
    console.log("Unexpected error in fetchWeather:", e);
    return { temp: 0, condition: "внутренняя ошибка", city };
  }
}

// ── Агент ────────────────────────────────────────────────────
// ── Хранилище PDF-презентаций (in-memory для демонстрации) ──
// ── Single-flight: одновременные одинаковые заказы = один рендер ──
const STUDIO_INFLIGHT = new Map<string, Promise<ArrayBuffer>>();

async function renderAtStudio(topic: string, slideCount: number, emit?: EmitFn): Promise<ArrayBuffer> {
  const key = `${topic.toLowerCase()}|${slideCount}`;
  const existing = STUDIO_INFLIGHT.get(key);
  if (existing) {
    emit?.("presentation", "Рендер уже идёт — подключаюсь к нему", "start");
    return existing;
  }
  const promise = (async () => {
    let lastErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch("https://ai-creative-studio.t63368844.workers.dev/pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic, slideCount }),
        });
        if (!res.ok) {
          lastErr = `Studio ${res.status}: ${(await res.text()).slice(0, 150)}`;
        } else {
          return await res.arrayBuffer();
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      if (attempt < 3) {
        const wait = attempt === 1 ? 5000 : 15000;
        emit?.("presentation", `Попытка ${attempt}/3 не удалась (429/500), повтор через ${wait / 1000} с`, "error");
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw new Error(lastErr || "render failed");
  })();
  STUDIO_INFLIGHT.set(key, promise);
  promise.finally(() => STUDIO_INFLIGHT.delete(key));
  return promise;
}

// ── Bybit Demo Trading: подпись HMAC-SHA256 (криптография живёт в коде) ──
const BYBIT_BASE = "https://api-demo.bybit.com"; // ТОЛЬКО demo-домен: реальные деньги недоступны

interface BybitEnv { BYBIT_API_KEY: string; BYBIT_API_SECRET: string }

async function bybitHeaders(env: Env, method: "GET" | "POST", path: string, queryOrBody: string): Promise<Record<string, string>> {
  const benv = env as unknown as BybitEnv;
  const timestamp = String(Date.now());
  const recvWindow = "5000";
  // Правило v5: payload = timestamp + apiKey + recvWindow + (query для GET | JSON-тело для POST)
  const payload = timestamp + benv.BYBIT_API_KEY + recvWindow + queryOrBody;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(benv.BYBIT_API_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const signature = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    "X-BAPI-API-KEY": benv.BYBIT_API_KEY,
    "X-BAPI-SIGN": signature,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": recvWindow,
  };
}

export class ChatAgent extends AIChatAgent<Env> {
  progress(step: string, message: string, status: "start" | "done" | "error" = "start") {
    const payload = JSON.stringify({ type: "progress", step, message, status, ts: Date.now() });
    this.broadcast(payload);
    console.log(`[PROGRESS:${status}] ${step}: ${message}`);
  }

  // ── HTTP-эндпоинт для нативных клиентов (Android app) ────────
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/api/chat")) {
      try {
        const body = (await request.json()) as { text?: string };
        const text = (body.text ?? "").trim();
        if (!text) {
          return new Response(JSON.stringify({ error: "text is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Сохраняем сообщение пользователя в историю DO
        const userMsg = {
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "user" as const,
          parts: [{ type: "text" as const, text }],
          createdAt: new Date(),
        };
        await this.saveMessages([...this.messages, userMsg]);

        // Запускаем агента и возвращаем SSE-стрим (UI Message Stream)
        return await this.onChatMessage();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(
      JSON.stringify({ error: "Not found", hint: "POST /api/chat with {text}" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const env = this.env;  // ← сохраняем для доступа внутри tools

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: `You are an AI agent that orchestrates workers to complete tasks.

## Available workers (tools):
1. **getWeather** — get current weather for a city (real data from open-meteo.com)
2. **searchKnowledge** — search the internal knowledge base. Available topics:
   - квантовые компьютеры (quantum computing)
   - машинное обучение (machine learning)
   - блокчейн (blockchain)
   - cloudflare workers
   - durable objects
   - agents sdk
   - websocket
3. **generateReport** — create a structured report after completing a multi-step task
4. **translateText** — translate text between languages (codes: ru, en, de, fr, es, zh, ja…)
5. **summarizeText** — compress a long text into 1-3 sentences (works best on English text)

Chain rule: if the user asks to summarize NON-English text, first call translateText (to English),
then summarizeText the translated text, and finish with generateReport listing both workers.

## CRITICAL RULE — NEVER bypass workers:
Even if you can do a task yourself (translate, summarize, answer a question), you MUST use the corresponding worker tool.
The purpose of this agent is to DEMONSTRATE worker orchestration, not to answer directly.

Mandatory mapping:
- User asks to TRANSLATE → you MUST call translateText (do not translate yourself)
- User asks to SUMMARIZE → you MUST call summarizeText (do not summarize yourself)
- User asks about WEATHER → you MUST call getWeather (do not guess)
- User asks about a TOPIC → you MUST call searchKnowledge first (do not rely on your training data)
- Any task involving 2+ workers → you MUST finish with generateReport

If you answer directly without calling a worker, the response is considered INCOMPLETE and WRONG.

## Workflow rules:
- For weather questions → use getWeather
- For technical/knowledge questions → use searchKnowledge
- If task involved 2+ different tools → call generateReport at the end with summary
- Always explain which workers you called and what they returned
- Respond in the same language as the user (Russian if user writes in Russian)
- If user asks about topics NOT in the knowledge base, politely explain what topics are available

## Example complex task:
User: "Какая погода в Москве и расскажи про квантовые компьютеры. Сделай отчёт."
Agent workflow:
1. Call getWeather({city: "Москва"})
2. Call searchKnowledge({query: "квантовые компьютеры"})
3. Call generateReport({task: "...", workers: [...]})
4. Provide comprehensive answer based on both results`,
      messages: await convertToModelMessages(this.messages),
      tools: {
        // ── Worker 1: реальная погода ─────────────────────────
        getWeather: tool({
          description: "Get current weather for a city. Returns real data from open-meteo.com API.",
          inputSchema: z.object({ 
            city: z.string().describe("City name in any language") 
          }),
          execute: async ({ city }) => {
            console.log(`[TOOL] getWeather called with city="${city}"`);
            const result = await fetchWeather(city, (st, msg, status = "start") => this.progress(st, msg, status));
            console.log(`[TOOL] getWeather result:`, result);
            return result;
          },
        }),

        // ── Worker 2: поиск в базе знаний (RAG) ──────────────
        searchKnowledge: tool({
          description: "Search the internal knowledge base for technical topics. Available topics: квантовые компьютеры, машинное обучение, блокчейн, cloudflare workers, durable objects, agents sdk, websocket.",
          inputSchema: z.object({ 
            query: z.string().describe("What to search for (topic or keyword)") 
          }),
          execute: async ({ query }) => {
            console.log(`[TOOL] searchKnowledge called with query="${query}"`);
            
            this.progress("rag", `Ищу в базе знаний: «${query}»…`, "start");
            // Имитация задержки worker'а (как реальный RAG)
            await new Promise(resolve => setTimeout(resolve, 300));
            
            const q = query.toLowerCase();
            const found = Object.entries(KNOWLEDGE).find(([key, value]) =>
              q.includes(key) || key.includes(q) || value.toLowerCase().includes(q)
            );
            
            const result = {
              found: !!found,
              topic: found ? found[0] : null,
              content: found ? found[1] : "Информация не найдена. Доступные темы: " + Object.keys(KNOWLEDGE).join(", "),
              source: found ? "internal-knowledge-base" : "none",
              workerId: "rag-worker-001",
              searchTime: "300ms",
            };
            
            this.progress("rag", result.found ? `Найдено: ${result.topic}` : "Не найдено", result.found ? "done" : "error");
            console.log(`[TOOL] searchKnowledge result:`, result);
            return result;
          },
        }),

        // ── Worker 3: генерация отчёта ───────────────────────
        generateReport: tool({
          description: "Generate a structured report summarizing what workers accomplished. Use this after completing a complex task that involved multiple workers.",
          inputSchema: z.object({
            task: z.string().describe("Original user task"),
            workers: z.array(z.object({
              name: z.string().describe("Worker name (getWeather, searchKnowledge)"),
              action: z.string().describe("What the worker did"),
              result: z.string().describe("Brief summary of result"),
            })).describe("List of workers that were called"),
          }),
          execute: async ({ task, workers }) => {
            this.progress("report", `Формирую отчёт по задаче: "${task.slice(0, 50)}…"`, "start");
            console.log(`[TOOL] generateReport called with task="${task}", workers:`, workers);
            
            const report = {
              taskId: `task-${Date.now()}`,
              task,
              workersInvoked: workers.length,
              workerDetails: workers,
              status: "completed",
              timestamp: new Date().toISOString(),
              summary: `Задача "${task}" выполнена с использованием ${workers.length} worker(ов): ${workers.map(w => w.name).join(", ")}`,
            };
            
            this.progress("report", `Отчёт готов: ${workers.length} worker(ов)`, "done");
            console.log(`[TOOL] generateReport result:`, report);
            return report;
          },
        }),

        // ── Worker 4: перевод (Workers AI M2M100) ────────────────
        translateText: tool({
          description: "Translate text between languages using M2M100. Language codes: ru, en, de, fr, es, zh, ja, etc.",
          inputSchema: z.object({
            text: z.string().describe("Text to translate"),
            source_lang: z.string().describe("Source language code, e.g. 'ru'"),
            target_lang: z.string().describe("Target language code, e.g. 'en'"),
          }),
          execute: async ({ text, source_lang, target_lang }) => {
            this.progress("translate", `Перевожу ${source_lang} → ${target_lang}…`, "start");
            const res = (await this.env.AI.run("@cf/meta/m2m100-1.2b", {
              text,
              source_lang,
              target_lang,
            })) as { translated_text?: string };
            this.progress("translate", `Перевод готов: ${(res.translated_text ?? "").slice(0, 60)}`, "done");
            return { translated_text: res.translated_text ?? "" };
          },
        }),

        // ── Worker 5: суммаризация (через chat-модель) ───────────
        summarizeText: tool({
          description: "Summarize a long text into 1-3 sentences. Works with any language.",
          inputSchema: z.object({
            text: z.string().describe("Long text to summarize"),
            language: z.string().optional().describe("Output language (e.g. 'en', 'ru'). Defaults to input language."),
          }),
          execute: async ({ text, language }) => {
            this.progress("summarize", `Сжимаю текст (${text.length} символов)…`, "start");
            const lang = language ?? "same as input";
            const res = await streamText({
              model: workersai("@cf/zai-org/glm-4.7-flash"),
              system: `You are a summarization assistant. Compress the following text into 2-3 concise sentences. Output language: ${lang}. Do NOT add commentary, just the summary.`,
              prompt: text,
              maxTokens: 150,
            });
            const summary = (await res.text).trim();
            this.progress("summarize", "Сводка готова", "done");
            return { summary };
          },
        }),

        // ── Worker 6: интеграция с ai-creative-studio ────────────
        createPresentation: tool({
          description: "Create a PDF presentation on a given topic using the ai-creative-studio service. Returns a download link.",
          inputSchema: z.object({
            topic: z.string().describe("Topic of the presentation (e.g. 'Quantum computing basics')"),
            slideCount: z.number().describe("Number of slides (3-10)"),
          }),
          execute: async ({ topic, slideCount }) => {
            this.progress("presentation", `Заказываю презентацию: «${topic}» (${slideCount} слайдов)…`, "start");
            
            try {
              // KV-reuse: та же тема+слайды уже отрендерены? Отдаём готовый PDF
              const list = await env.PDF_STORE.list({ prefix: "pdf-" });
              for (const k of list.keys) {
                const md = k.metadata as { topic?: string; slideCount?: number } | undefined;
                if (md && md.topic === topic && md.slideCount === slideCount) {
                  const cachedBuf = await env.PDF_STORE.get(k.name, "arrayBuffer");
                  if (cachedBuf) {
                    const cachedKB = Math.round(cachedBuf.byteLength / 1024);
                    this.progress("presentation", `PDF найден в KV (${k.name}, ${cachedKB} KB) — рендер не нужен`, "done");
                    const cachedUrl = `https://my-first-agent.t63368844.workers.dev/download?id=${k.name}`;
                    return {
                      success: true,
                      cached: true,
                      size: `${cachedKB} KB`,
                      pdfId: k.name,
                      downloadUrl: cachedUrl,
                      message: `Презентация уже создавалась ранее. [Скачать PDF](${cachedUrl})`,
                    };
                  }
                }
              }

              // Рендер в студии: single-flight + retry при 429/500
              const pdfBuffer = await renderAtStudio(topic, slideCount, (st, msg, status = "start") => this.progress(st, msg, status));
              const sizeKB = Math.round(pdfBuffer.byteLength / 1024);
              
              // Сохраняю PDF в KV (на 7 дней)
              const pdfId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              await env.PDF_STORE.put(pdfId, pdfBuffer, {
                expirationTtl: 7 * 24 * 60 * 60, // 7 дней
                metadata: { topic, slideCount, createdAt: Date.now() }
              });
              
              this.progress("presentation", `PDF готов (${sizeKB} KB), сохранён в KV`, "done");
              
              const downloadUrl = `https://my-first-agent.t63368844.workers.dev/download?id=${pdfId}`;
              
              return {
                success: true,
                size: `${sizeKB} KB`,
                pdfId,
                downloadUrl,
                message: `Презентация создана и сохранена. [Скачать PDF](${downloadUrl})`,
              };
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              this.progress("presentation", `Ошибка: ${msg}`, "error");
              return { success: false, error: msg };
            }
          },
        }),

        // ── Worker 6.5: база знаний (скиллы в KV) ──
        listSkills: tool({
          description: "List available knowledge skills with descriptions from frontmatter. Call before complex tasks to see what knowledge exists.",
          inputSchema: z.object({}),
          execute: async () => {
            const list = await env.SKILLS.list();
            const skills = [];
            for (const k of list.keys) {
              const text = await env.SKILLS.get(k.name);
              const descMatch = text?.match(/^description:\s*(.+)$/m);
              skills.push({
                name: k.name,
                description: descMatch ? descMatch[1].trim() : "no description",
              });
            }
            this.progress("skills", `Доступно знаний: ${skills.length}`, "done");
            return { skills };
          },
        }),

        readSkill: tool({
          description: "Read the full text of a knowledge skill by name (e.g. 'risk-rules', 'order-types'). Use BEFORE complex Bybit operations.",
          inputSchema: z.object({
            name: z.string().describe("Skill name without .md, e.g. 'risk-rules'"),
          }),
          execute: async ({ name }) => {
            this.progress("skills", `Читаю знание: ${name}…`, "start");
            const text = await env.SKILLS.get(name);
            if (!text) {
              const list = await env.SKILLS.list();
              this.progress("skills", `Скилл ${name} не найден`, "error");
              return { error: "skill not found", available: list.keys.map((k) => k.name) };
            }
            this.progress("skills", `Прочитано ${text.length} символов: ${name}`, "done");
            return { name, content: text };
          },
        }),

        // ── Worker 7: цена с Bybit (публичный endpoint, без подписи) ──
        getBybitPrice: tool({
          description: "Get current price of a symbol from Bybit demo market. Symbols: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT.",
          inputSchema: z.object({
            symbol: z.string().describe("Trading pair, e.g. BTCUSDT"),
          }),
          execute: async ({ symbol }) => {
            this.progress("bybit", `Запрашиваю цену ${symbol}…`, "start");
            const res = await fetch(`${BYBIT_BASE}/v5/market/tickers?category=spot&symbol=${symbol}`);
            const json = (await res.json()) as { result?: { list?: Array<Record<string, string>> } };
            const row = json.result?.list?.[0];
            if (!row) {
              this.progress("bybit", `Символ ${symbol} не найден`, "error");
              return { error: "symbol not found", symbol };
            }
            this.progress("bybit", `${symbol} = ${row.lastPrice} USDT`, "done");
            return { symbol, lastPrice: row.lastPrice, change24h: row.price24hPcnt, high24h: row.high24h, low24h: row.low24h };
          },
        }),

        // ── Worker 8: баланс демо-аккаунта (приватный, с подписью) ──
        getBybitBalance: tool({
          description: "Get demo account wallet balances (USDT, USDC, BTC, ETH) from Bybit.",
          inputSchema: z.object({}),
          execute: async () => {
            this.progress("bybit", "Подписываю запрос баланса (HMAC-SHA256)…", "start");
            const path = "/v5/account/wallet-balance";
            const query = "accountType=UNIFIED";
            const headers = await bybitHeaders(env, "GET", path, query);
            const res = await fetch(BYBIT_BASE + path + "?" + query, { headers });
            const json = (await res.json()) as { retCode: number; retMsg: string; result?: { list?: Array<{ coin?: Array<{ coin: string; walletBalance: string }> }> } };
            if (json.retCode !== 0) {
              this.progress("bybit", `Bybit отклонил запрос: ${json.retMsg}`, "error");
              return { error: json.retMsg, retCode: json.retCode };
            }
            const coins = json.result?.list?.[0]?.coin ?? [];
            const balances = coins
              .map((c) => ({ coin: c.coin, walletBalance: c.walletBalance }))
              .filter((c) => parseFloat(c.walletBalance) > 0);
            this.progress("bybit", `Баланс: ${balances.map((b) => `${b.coin}=${b.walletBalance}`).join(", ")}`, "done");
            return { balances };
          },
        }),

        // ── Worker 8.5: параметры инструмента (чтобы агент знал точные лимиты) ──
        getBybitInstrumentInfo: tool({
          description: "Get trading rules and limits for a symbol on Bybit demo (min/max qty, price precision). Call BEFORE placing any order to know the exact limits.",
          inputSchema: z.object({
            symbol: z.string().describe("e.g. BTCUSDT"),
          }),
          execute: async ({ symbol }) => {
            this.progress("bybit", `Узнаю правила торговли ${symbol}…`, "start");
            const res = await fetch(`${BYBIT_BASE}/v5/market/instruments-info?category=spot&symbol=${symbol}`);
            const json = (await res.json()) as { result?: { list?: Array<any> } };
            const inst = json.result?.list?.[0];
            if (!inst) {
              this.progress("bybit", `Символ ${symbol} не найден`, "error");
              return { error: "symbol not found", symbol };
            }
            const info = {
              symbol: inst.symbol,
              baseCoin: inst.baseCoin,
              quoteCoin: inst.quoteCoin,
              minOrderQty: inst.lotSizeFilter?.minOrderQty,
              maxOrderQty: inst.lotSizeFilter?.maxOrderQty,
              qtyStep: inst.lotSizeFilter?.qtyStep,
              minPrice: inst.priceFilter?.tickSize,
              status: inst.status,
            };
            this.progress("bybit", `${symbol}: min=${info.minOrderQty}, max=${info.maxOrderQty}`, "done");
            return info;
          },
        }),

        // ── Worker 9: ордер с guardrails (только spot, лимиты, подтверждение) ──
        placeBybitOrder: tool({
          description: "Place a SPOT Market order on Bybit DEMO account. CRITICAL: for BUY orders use amountUSDT (spend USDT); for SELL orders use qtyBase (sell base coin). ALWAYS call getBybitInstrumentInfo and getBybitPrice FIRST.",
          inputSchema: z.object({
            symbol: z.string().describe("e.g. BTCUSDT"),
            side: z.enum(["Buy", "Sell"]),
            amountUSDT: z.string().optional().describe("For BUY only: USDT amount to spend, e.g. '10' means spend 10 USDT. REQUIRED when side=Buy."),
            qtyBase: z.string().optional().describe("For SELL only: base coin quantity, e.g. '0.001' means sell 0.001 BTC. REQUIRED when side=Sell."),
            confirm: z.boolean().describe("MUST be true. Set true ONLY after user explicitly approved this exact order in chat."),
          }),
          execute: async ({ symbol, side, amountUSDT, qtyBase, confirm }) => {
            // Guardrail 1: без явного подтверждения — отклоняем с явным success:false
            if (!confirm) {
              this.progress("bybit", "Ордер без подтверждения отклонён", "error");
              return {
                success: false,
                error: "NOT CONFIRMED. Show order details to user, wait for explicit approval, then call again with confirm=true.",
              };
            }

            // Валидация: для Buy нужен amountUSDT, для Sell нужен qtyBase
            if (side === "Buy" && !amountUSDT) {
              return { success: false, error: "For Buy Market orders, amountUSDT is required (USDT to spend)." };
            }
            if (side === "Sell" && !qtyBase) {
              return { success: false, error: "For Sell Market orders, qtyBase is required (base coin quantity)." };
            }

            // Guardrail 2: разумные лимиты
            const usdtAmount = side === "Buy" ? parseFloat(amountUSDT!) : 0;
            const baseQty = side === "Sell" ? parseFloat(qtyBase!) : 0;
            if (usdtAmount > 0 && (usdtAmount < 5 || usdtAmount > 10000)) {
              return { success: false, error: `amountUSDT ${usdtAmount} out of safe range [5, 10000]. Demo min is usually 5-10 USDT.` };
            }
            const MAX_BASE: Record<string, number> = { BTCUSDT: 0.5, ETHUSDT: 5, SOLUSDT: 100, XRPUSDT: 5000 };
            if (baseQty > 0 && MAX_BASE[symbol] !== undefined && baseQty > MAX_BASE[symbol]) {
              return { success: false, error: `qtyBase ${baseQty} ${symbol} exceeds guardrail ${MAX_BASE[symbol]}` };
            }

            this.progress("bybit", `Подписываю ордер ${side} ${side === "Buy" ? amountUSDT + " USDT" : qtyBase + " " + symbol}…`, "start");
            const path = "/v5/order/create";
            const body: Record<string, string> = { category: "spot", symbol, side, orderType: "Market" };
            if (side === "Buy") {
              body.qty = amountUSDT!;           // ← для Buy: qty = сумма в USDT (по документации V5)
              body.marketUnit = "quoteCoin";    // ← явно указываем единицу измерения
            } else {
              body.qty = qtyBase!;              // ← для Sell: qty = количество BTC
              body.marketUnit = "baseCoin";
            }
            const bodyStr = JSON.stringify(body);
            const headers = await bybitHeaders(env, "POST", path, bodyStr);
            const res = await fetch(BYBIT_BASE + path, {
              method: "POST",
              headers: { ...headers, "Content-Type": "application/json" },
              body: bodyStr,
            });
            const json = (await res.json()) as { retCode: number; retMsg: string; result?: { orderId?: string } };
            if (json.retCode !== 0) {
              this.progress("bybit", `Bybit отклонил: ${json.retMsg} (retCode=${json.retCode})`, "error");
              return {
                success: false,
                error: json.retMsg,
                retCode: json.retCode,
                hint: "For Buy Market, amountUSDT is USDT amount. For Sell Market, qtyBase is base coin amount. Min ~5-10 USDT per order.",
              };
            }
            this.progress("bybit", `Ордер исполнен: ${json.result?.orderId}`, "done");
            return { success: true, orderId: json.result?.orderId, symbol, side, executed: side === "Buy" ? `${amountUSDT} USDT` : `${qtyBase} ${symbol}` };
          },
        }),
      },
      stopWhen: stepCountIs(10),
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    
    // GET /download?id=... — отдаёт PDF из KV
    if (request.method === "GET" && url.pathname === "/download") {
      const pdfId = url.searchParams.get("id");
      
      if (!pdfId) {
        return new Response(JSON.stringify({ error: "Missing id parameter" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      try {
        const pdfBytes = await env.PDF_STORE.get(pdfId, "arrayBuffer");
        
        if (!pdfBytes) {
          return new Response(JSON.stringify({ error: "PDF not found or expired", id: pdfId }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        
        const filename = pdfId.replace("pdf-", "presentation-") + ".pdf";
        
        return new Response(pdfBytes, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "public, max-age=3600",
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: "Download failed", details: msg }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    
    // Всё остальное — в агент
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
