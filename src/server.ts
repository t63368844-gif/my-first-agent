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
    const wxRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,weather_code`
    );
    const wx = await wxRes.json() as { current: { temperature_2m: number; weather_code: number } };
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
    console.log("Open-Meteo API error:", e);
    return { temp: 0, condition: "ошибка API", city };
  }
}

// ── Агент ────────────────────────────────────────────────────
export class ChatAgent extends AIChatAgent<Env> {
  progress(step: string, message: string, status: "start" | "done" | "error" = "start") {
    const payload = JSON.stringify({ type: "progress", step, message, status, ts: Date.now() });
    this.broadcast(payload);
    console.log(`[PROGRESS:${status}] ${step}: ${message}`);
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

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
            
            console.log(`[TOOL] generateReport result:`, report);
            return report;
          },
        }),
      },
      stopWhen: stepCountIs(8),
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
