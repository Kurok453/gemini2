// Вебхук навыка Яндекс Алисы: Gemini отвечает, Serper ищет в интернете.
// Работает на Vercel как serverless-функция по адресу /api.
//
// Алиса ждёт ответ не дольше 3 секунд, поэтому схема максимально быстрая:
//  - на каждую реплику делается ОДИН запрос к Gemini;
//  - если вопрос про актуальные данные, поиск Serper выполняется заранее;
//  - если основная модель перегружена (503) или тормозит, ответ даёт запасная модель.

const PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite";
// Через сколько мс запускать запасную модель, если основная ещё не ответила.
const HEDGE_MS = Number(process.env.GEMINI_HEDGE_MS || 1500);
// Уровень размышлений для основной модели: minimal, low, medium, high.
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || "minimal";
// Поиск: auto (по ключевым словам), always, never.
const SEARCH_MODE = (process.env.SEARCH_MODE || "auto").toLowerCase();
// Если DEBUG=1, текст ошибки произносится в ответе (для отладки).
const DEBUG = process.env.DEBUG === "1";

const SERPER_URL = "https://google.serper.dev/search";
const TOTAL_TIMEOUT_MS = 2800;
const SEARCH_TIMEOUT_MS = 1200;
const MAX_TEXT = 1000; // лимит Алисы на response.text — 1024 символа
const MAX_STATE_BYTES = 900; // лимит Алисы на размер состояния — около 1 КБ

const EXIT_WORDS = ["хватит", "выход", "выйти", "закончить", "стоп", "пока"];

// Вопросы, для которых нужны свежие данные из интернета.
const SEARCH_RE =
  /погод|температур|курс|доллар|евро|юан|биткоин|новост|сегодня|сейчас|вчера|завтра|на этой неделе|последн|свеж|цена|цены|стоит|сколько стоит|счёт|счет|матч|результат|кто выиграл|выбор|расписани|пробк|котировк|рейтинг|когда выйдет|вышел|вышла|202[4-9]/i;

function systemPrompt(searchContext) {
  const today = new Date().toLocaleDateString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const lines = [
    "Ты — голосовой помощник в навыке Яндекс Алисы.",
    "Отвечай по-русски, коротко и по делу: 1–3 предложения, без markdown, списков и ссылок.",
    "Учитывай предыдущие реплики диалога.",
    `Сегодня ${today}.`,
  ];
  if (searchContext) {
    lines.push("Ниже результаты поиска в интернете. Опирайся на них, если они подходят к вопросу:");
    lines.push(searchContext);
  }
  return lines.join("\n");
}

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

// Сигнал, который срабатывает по таймеру или вместе с родительским.
function limitedSignal(parent, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const onAbort = () => c.abort();
  if (parent.aborted) c.abort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return {
    signal: c.signal,
    done() {
      clearTimeout(t);
      parent.removeEventListener("abort", onAbort);
    },
  };
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
  return parts.join("\n");
}

async function maybeSearch(utterance, parentSignal) {
  if (SEARCH_MODE === "never" || !process.env.SERPER_API_KEY) return "";
  if (SEARCH_MODE === "auto" && !SEARCH_RE.test(utterance)) return "";
  const lim = limitedSignal(parentSignal, SEARCH_TIMEOUT_MS);
  try {
    return await serperSearch(utterance, lim.signal);
  } catch (e) {
    console.error("search error:", e && e.message);
    return ""; // без поиска отвечаем своими знаниями
  } finally {
    lim.done();
  }
}

async function callGemini(model, contents, system, thinking, signal) {
  const generationConfig = { maxOutputTokens: 600, temperature: 0.7 };
  if (thinking && THINKING_LEVEL) generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig,
      }),
      signal,
    }
  );
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 300); } catch {}
    const err = new Error(`Gemini ${model} ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const parts =
    (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
}

// Если модель не приняла настройку размышлений (400), повторяем без неё.
async function runModel(model, useThinking, contents, system, signal) {
  try {
    return await callGemini(model, contents, system, useThinking, signal);
  } catch (e) {
    if (useThinking && e.status === 400) {
      return callGemini(model, contents, system, false, signal);
    }
    throw e;
  }
}

// Основная модель; при ошибке или долгом ответе подключается запасная. Побеждает первая.
function generate(contents, system, signal) {
  return new Promise((resolve, reject) => {
    let pending = 1;
    let lastErr;
    let fallbackStarted = false;
    const fail = (e) => {
      lastErr = e;
      if (--pending === 0) reject(lastErr);
    };
    const startFallback = () => {
      if (fallbackStarted || !FALLBACK_MODEL || FALLBACK_MODEL === PRIMARY_MODEL) return;
      fallbackStarted = true;
      pending++;
      runModel(FALLBACK_MODEL, false, contents, system, signal).then(resolve, fail);
    };
    const timer = setTimeout(startFallback, HEDGE_MS);
    runModel(PRIMARY_MODEL, true, contents, system, signal).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        console.error("primary model error:", e && e.message);
        startFallback();
        fail(e);
      }
    );
  });
}

async function answer(history, utterance, signal) {
  const searchContext = await maybeSearch(utterance, signal);
  const contents = history.map((m) => ({
    role: m.r === "u" ? "user" : "model",
    parts: [{ text: m.t }],
  }));
  contents.push({ role: "user", parts: [{ text: utterance }] });

  const text = await generate(contents, systemPrompt(searchContext), signal);
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

  if (EXIT_WORDS.includes(utterance.toLowerCase())) {
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
      : "Сейчас сервис перегружен. Повторите вопрос через несколько секунд.";
    if (DEBUG) msg = `Ошибка: ${(e && e.message) || "неизвестно"}`;
    res.status(200).json(reply(msg, { state: packHistory(history) }));
  } finally {
    clearTimeout(timer);
  }
};
