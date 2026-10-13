// Вебхук навыка Яндекс Алисы: Gemini отвечает, Serper ищет в интернете.
// Работает на Vercel как serverless-функция по адресу /api.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const SERPER_URL = "https://google.serper.dev/search";

// Необязательно: уровень «размышлений» моделей Gemini 3 (minimal, low, medium, high).
// Если переменная не задана, используется настройка модели по умолчанию.
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || "";
// Если DEBUG=1, текст ошибки произносится в ответе (для отладки).
const DEBUG = process.env.DEBUG === "1";

// Алиса ждёт ответ не дольше 3 секунд, поэтому оставляем запас.
const TOTAL_TIMEOUT_MS = 2800;
const MAX_TEXT = 1000; // лимит Алисы на response.text — 1024 символа
const MAX_STATE_BYTES = 900; // лимит Алисы на размер состояния — около 1 КБ

const SYSTEM_PROMPT = [
  "Ты — голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай по-русски, коротко и по делу: 1–3 предложения, без markdown, списков и ссылок.",
  "Если вопрос требует актуальных данных (новости, погода, курсы, спорт, события, цены), вызови функцию web_search.",
  "Учитывай предыдущие реплики диалога.",
].join(" ");

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "web_search",
        description: "Поиск в интернете для актуальной информации.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Поисковый запрос" },
          },
          required: ["query"],
        },
      },
    ],
  },
];

const EXIT_WORDS = ["хватит", "выход", "выйти", "закончить", "стоп", "пока"];

function reply(text, { state, end = false } = {}) {
  const clean = String(text).slice(0, MAX_TEXT);
  const body = {
    version: "1.0",
    response: { text: clean, tts: clean, end_session: end },
  };
  if (state !== undefined) body.session_state = state;
  return body;
}

// История хранится в session_state. Обрезаем, чтобы влезть в лимит.
function packHistory(history) {
  let h = history.slice(-6).map((m) => ({ r: m.r, t: m.t.slice(0, 160) }));
  const size = () => Buffer.byteLength(JSON.stringify({ h }), "utf8");
  while (h.length > 0 && size() > MAX_STATE_BYTES) h = h.slice(1);
  return { h };
}

function unpackHistory(state) {
  const h = state && state.session && Array.isArray(state.session.h) ? state.session.h : [];
  return h.filter((m) => m && (m.r === "u" || m.r === "m") && typeof m.t === "string");
}

async function serperSearch(query, signal) {
  const res = await fetch(SERPER_URL, {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 5 }),
    signal,
  });
  if (!res.ok) throw new Error(`Serper ${res.status}`);
  const data = await res.json();
  const parts = [];
  if (data.answerBox) {
    const a = data.answerBox.answer || data.answerBox.snippet || data.answerBox.title;
    if (a) parts.push(`Прямой ответ: ${a}`);
  }
  if (data.knowledgeGraph && data.knowledgeGraph.description) {
    parts.push(`Справка: ${data.knowledgeGraph.description}`);
  }
  for (const r of (data.organic || []).slice(0, 4)) {
    parts.push(`${r.title}: ${r.snippet || ""}`);
  }
  return parts.join("\n") || "Ничего не найдено.";
}

async function gemini(contents, signal) {
  const generationConfig = { maxOutputTokens: 400, temperature: 0.7 };
  if (THINKING_LEVEL) generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL };

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      tools: TOOLS,
      generationConfig,
    }),
    signal,
  });
  if (!res.ok) {
    // Текст ошибки от Google помогает понять причину (виден в логах Vercel).
    let detail = "";
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new Error(`Gemini ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts;
}

async function answer(history, utterance, signal) {
  const contents = history.map((m) => ({
    role: m.r === "u" ? "user" : "model",
    parts: [{ text: m.t }],
  }));
  contents.push({ role: "user", parts: [{ text: utterance }] });

  let parts = await gemini(contents, signal);
  const call = parts.find((p) => p.functionCall);

  if (call) {
    const query = (call.functionCall.args && call.functionCall.args.query) || utterance;
    let result;
    try {
      result = await serperSearch(query, signal);
    } catch (e) {
      result = "Поиск сейчас недоступен.";
    }
    // Возвращаем ответ модели целиком (вместе с thoughtSignature): модели Gemini 3 это требуют.
    contents.push({ role: "model", parts });
    contents.push({
      role: "user",
      parts: [{ functionResponse: { name: call.functionCall.name || "web_search", response: { result } } }],
    });
    parts = await gemini(contents, signal);
  }

  // Берём только обычный текст, без служебных «мыслей».
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
  return text || "Не нашла, что ответить. Спросите по-другому.";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(200).send("Alice webhook is running. Send POST requests from Yandex Dialogs.");
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const utterance = ((body.request && (body.request.original_utterance || body.request.command)) || "").trim();
  const state = body.state || {};
  const isNew = body.session && body.session.new;

  // Проверка связи от Яндекса
  if (utterance.toLowerCase() === "ping") {
    res.status(200).json(reply("pong"));
    return;
  }

  if (isNew && !utterance) {
    res.status(200).json(reply("Привет! Я могу ответить на любой вопрос и поискать свежую информацию в интернете. Что вас интересует?", { state: packHistory([]) }));
    return;
  }

  if (!utterance) {
    res.status(200).json(reply("Я вас не расслышала. Повторите, пожалуйста.", { state: state.session }));
    return;
  }

  const lower = utterance.toLowerCase();
  if (EXIT_WORDS.includes(lower)) {
    res.status(200).json(reply("Хорошо, до встречи!", { end: true }));
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    res.status(200).json(reply("Не задан ключ Gemini в настройках Vercel."));
    return;
  }

  const history = unpackHistory(state);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);

  try {
    const text = await answer(history, utterance, controller.signal);
    const newHistory = [...history, { r: "u", t: utterance }, { r: "m", t: text }];
    res.status(200).json(reply(text, { state: packHistory(newHistory) }));
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    console.error("webhook error:", e && e.message);
    let msg = timedOut
      ? "Я не успела найти ответ. Спросите ещё раз, пожалуйста."
      : "Произошла ошибка. Попробуйте ещё раз.";
    if (DEBUG) msg = `Ошибка: ${(e && e.message) || "неизвестно"}`;
    res.status(200).json(reply(msg, { state: packHistory(history) }));
  } finally {
    clearTimeout(timer);
  }
};

