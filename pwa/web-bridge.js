import {grammarLesson, speakingSample, writingHints, basicWritingCheck, onlineVideos} from "./offline-learning.js";
import {LEARNING_SCHEMA_VERSION, RELEASE_ID, migrateLearningState, scoreLearningPhrase, validateBackupPayload} from "./learning-model.js";

const DB_NAME = "pogruzhenie-pwa";
// The record schema is versioned inside the `state` value. IndexedDB itself
// stays at version 1 because no object store changed. This keeps the previous
// published client able to open the same data during a code rollback.
const DB_VERSION = 1;
const STORE_NAME = "records";
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_KEYS = [
  "level", "audience", "course", "theme", "channels", "onboarded", "volume", "muted", "rate", "videoSize",
  "lessonSchedule",
];
const STORE_ROOTS = ["writing/", "speaking/", "cache/gen/"];

let databasePromise;
let glossaryPromise;
let recorder = null;
let recordingStream = null;
let recordingChunks = [];
let recordingStartedAt = 0;
let pwaZoom = 100;
const recordings = new Map();

function problem(error, code = "pwa") {
  return {error, code};
}

function fail(error, code) {
  throw problem(error, code);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB did not open"));
  });
  return databasePromise;
}

async function readRecord(key, fallback) {
  const db = await openDatabase();
  const value = await requestResult(db.transaction(STORE_NAME).objectStore(STORE_NAME).get(key));
  return value === undefined ? fallback : value;
}

async function writeRecord(key, value) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB write aborted"));
  });
}

async function deleteRecords(predicate) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (predicate(String(cursor.key))) cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("IndexedDB scan failed"));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("IndexedDB delete failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB delete aborted"));
  });
}

async function allRecords() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const out = {};
    const tx = db.transaction(STORE_NAME);
    const request = tx.objectStore(STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      out[String(cursor.key)] = cursor.value;
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("IndexedDB export failed"));
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB export failed"));
  });
}

async function replaceRecords(recordsToImport) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    Object.entries(recordsToImport).forEach(([key, value]) => store.put(value, key));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("IndexedDB import failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB import aborted"));
  });
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function localDayNumber(date = new Date()) {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function shiftLocalDay(date, amount) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount, 12, 0, 0, 0);
}

function mondayDay(date = new Date()) {
  const js = date.getDay();
  return js === 0 ? 7 : js;
}

const DAY_NAMES = [
  "понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье",
];

function planFor(day) {
  const blocks = [];
  const add = (key, title, note, module, part) => {
    blocks.push({key, title, note, module, part, optional: false});
  };

  if (day === 2) add("review_video", "Пересмотреть вчерашнее видео 1-2 раза", "Закрепить слова и фразы; забытое перевести ещё раз", "listening", "Утро");
  if (day === 3) add("review_video", "Пересмотреть вчерашнее видео", "Плюс проверить слова, записанные в Пн и Вт", "listening", "Утро");
  if (day === 4) add("review_media", "Пересмотреть вчерашний фильм или видео", "Вспомнить все слова и фразы, составить с ними предложения", "listening", "Утро");
  add("words", "Слова: очередь повторения + составить предложения", "Регулярно просматривать записанное и строить с ним фразы", "words", "Утро");

  if (day === 1 || day === 2) {
    add("video_parse", "Разобрать одно видео: перевести часть, выписать слова", "После перевода пересмотреть этот фрагмент ещё несколько раз", "listening", "День");
    add("video_watch", "Ещё 1-2 видео просто посмотреть", "Всего 2-3 видео за день, привыкать к звучанию", "listening", "День");
  } else if (day === 3) {
    add("film_parse", "Фильм с английскими субтитрами: перевести часть", "Бери уже виденный фильм, русские субтитры не включай", "today", "День");
    add("video_watch", "2-3 видео просто посмотреть", "Без разбора, на привыкание", "listening", "День");
  } else if (day === 4) {
    add("texts", "Тексты своего уровня: перевести минимум один", "Короткие лучше 2-4; уровень текста равен твоему", "reading", "День");
    add("video_watch", "2-3 видео просто посмотреть", "Без разбора", "listening", "День");
  } else if (day === 5) {
    add("video_parse", "Перевести часть одного видео", "Выписать новые слова и фразы", "listening", "День");
  } else {
    add("video_parse", "Одно видео перевести", "С выпиской слов", "listening", "День");
    add("videos5", "Около 5 видео за день", "Простой просмотр, погружение", "listening", "День");
    add("texts", "Перевести 1-2 текста своего уровня", "Со словами в тетрадку", "reading", "День");
  }
  add("think", "В течение дня думать на английском", "Крутить фразы в голове, спрашивать себя: как бы я это сказал?", "today", "День");

  if (day === 5) add("film_full", "Посмотреть фильм на английском целиком", "С пятницы самое глубокое погружение", "today", "Вечер");
  if (day === 6 || day === 7) add("film_full", "Фильм целиком, английские субтитры", "Просто смотреть, ничего не разбирать", "today", "Вечер");
  add("write", "Написать текст на английском + базовая проверка", "Вставить новые слова из тетрадки и проверить несколько правил без ИИ", "writing", "Вечер");
  add("speak", "Ответить на вопросы вслух по схеме", "Well/So, I think that, эхо вопроса, because", "speaking", "Вечер");
  add("grammar", "Грамматика: новая тема или повторение", "Пройденное возвращается по кривой забывания", "grammar", "Вечер");
  if (day <= 6) add("recon", "Реконструкция разобранного куска: три круга", "Пропуски, свои пропуски, пустой лист", "recon", "Вечер");
  return blocks;
}

const SRS = {
  ladder: [1, 3, 7, 16, 35, 70],
  startEase: 2.5,
  minEase: 1.3,
  maxEase: 3.2,
  maxInterval: 365,
};

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function srsCard(args) {
  const streak = Math.max(0, Number(args.streak) || 0);
  const ease = clamp(Number.isFinite(Number(args.ease)) ? Number(args.ease) : SRS.startEase, SRS.minEase, SRS.maxEase);
  let interval;
  if (Number.isFinite(Number(args.interval))) interval = Math.max(0, Number(args.interval));
  else interval = streak > 0 ? SRS.ladder[Math.min(streak - 1, SRS.ladder.length - 1)] : 0;
  return {streak, ease, interval};
}

function srsNext(card, grade) {
  let {streak, ease} = card;
  const previous = card.interval;
  let interval;
  if (grade === "again") {
    ease -= 0.2;
    streak = 0;
    interval = 1;
  } else if (grade === "hard") {
    ease -= 0.15;
    streak += 1;
    interval = previous <= 0 ? 1 : Math.max(previous + 1, Math.round(previous * 1.2));
  } else if (grade === "easy") {
    ease += 0.15;
    streak += 1;
    interval = previous <= 0 ? 3 : Math.round(previous * (ease + 0.15) * 1.3);
  } else {
    streak += 1;
    interval = previous <= 0 ? 1 : Math.round(previous * ease);
  }
  return {
    streak,
    ease: clamp(ease, SRS.minEase, SRS.maxEase),
    interval: clamp(interval, 1, SRS.maxInterval),
  };
}

const ARTICLES = new Set(["a", "an", "the"]);
const PREPOSITIONS = new Set([
  "about", "above", "across", "after", "against", "along", "among", "around", "at", "before",
  "behind", "below", "beside", "between", "by", "down", "during", "for", "from", "in", "inside",
  "into", "near", "of", "off", "on", "onto", "out", "outside", "over", "past", "since", "through",
  "to", "toward", "towards", "under", "until", "up", "upon", "with", "within", "without",
]);
const LINKERS = new Set([
  "so", "then", "though", "although", "however", "anyway", "actually", "still", "just", "even",
  "because", "but", "while", "when", "end", "finally", "instead", "besides", "otherwise", "therefore", "yet",
]);
const TOO_COMMON = new Set([
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your",
  "his", "its", "our", "their", "this", "that", "these", "those", "is", "am", "are", "was", "were",
  "be", "been", "being", "do", "does", "did", "have", "has", "had", "will", "would", "can", "could",
  "shall", "should", "may", "might", "must", "not", "no", "yes", "and", "or", "if", "as", "there",
  "here", "what", "who", "how", "why", "very", "too", "also", "all", "some", "any", "one",
]);
const IRREGULAR = {
  took: "take", taken: "take", went: "go", gone: "go", grew: "grow", grown: "grow", gave: "give",
  given: "give", made: "make", got: "get", gotten: "get", said: "say", spoke: "speak", spoken: "speak",
  knew: "know", known: "know", thought: "think", felt: "feel", found: "find", kept: "keep", left: "leave",
  met: "meet", paid: "pay", put: "put", read: "read", ran: "run", saw: "see", seen: "see", sold: "sell",
  sent: "send", sat: "sit", slept: "sleep", spent: "spend", stood: "stand", told: "tell",
  understood: "understand", wrote: "write", written: "write", came: "come", began: "begin", brought: "bring",
  bought: "buy", chose: "choose", drove: "drive", ate: "eat", fell: "fall", forgot: "forget", heard: "hear",
  held: "hold", lost: "lose", won: "win", wore: "wear",
};

function norm(word) {
  return String(word || "").toLowerCase().match(/[\p{L}']/gu)?.join("") || "";
}

function tokens(line) {
  const pieces = String(line || "").match(/[\p{L}\p{N}']+/gu) || [];
  return pieces.map((piece, at) => {
    const raw = piece.replace(/^'+|'+$/g, "");
    return {raw, norm: norm(raw), at};
  }).filter((item) => item.raw);
}

function lossKind(word) {
  if (ARTICLES.has(word)) return "article";
  if (PREPOSITIONS.has(word)) return "preposition";
  if (LINKERS.has(word)) return "linker";
  return "word";
}

function reconTargets(lines, known, count) {
  const knownWords = new Set((known || []).map(norm));
  const byLine = lines.map((line, lineIndex) => {
    const candidates = tokens(line).filter((token) => {
      const word = token.norm;
      return word.length >= 3 && !TOO_COMMON.has(word) && !ARTICLES.has(word)
        && !PREPOSITIONS.has(word) && !LINKERS.has(word) && !/^\d/.test(word);
    }).map((token) => ({
      gap: {line: lineIndex, at: token.at, answer: token.raw, kind: "target"},
      score: (knownWords.has(token.norm) ? 3 : 0) + (token.norm.length >= 7 ? 2 : token.norm.length >= 5 ? 1 : 0),
    }));
    candidates.sort((a, b) => b.score - a.score || a.gap.at - b.gap.at);
    return candidates;
  });
  const out = [];
  for (let round = 0; round < 2 && out.length < count; round += 1) {
    byLine.forEach((items) => {
      if (out.length < count && items[round]) out.push(items[round].gap);
    });
  }
  return out.sort((a, b) => a.line - b.line || a.at - b.at);
}

function reconLosses(lines, skip) {
  const taken = new Set((skip || []).map((gap) => `${gap.line}:${gap.at}`));
  const out = [];
  lines.forEach((line, lineIndex) => {
    let added = 0;
    tokens(line).forEach((token) => {
      if (added >= 2 || taken.has(`${lineIndex}:${token.at}`)) return;
      const word = token.norm;
      let kind = "";
      if (ARTICLES.has(word)) kind = "article";
      else if (PREPOSITIONS.has(word)) kind = "preposition";
      else if (LINKERS.has(word)) kind = "linker";
      else if (IRREGULAR[word] || (word.endsWith("ed") && word.length > 4)) kind = "verb";
      if (!kind) return;
      out.push({line: lineIndex, at: token.at, answer: token.raw, kind});
      added += 1;
    });
  });
  return out;
}

function stem(word) {
  let result = word;
  for (const suffix of ["ing", "ed", "es", "s", "d"]) {
    if (word.endsWith(suffix) && word.length > suffix.length + 2) {
      result = word.slice(0, -suffix.length);
      if (result.length > 1 && result.at(-1) === result.at(-2)) result = result.slice(0, -1);
      break;
    }
  }
  if (result.endsWith("e") && result.length >= 5) result = result.slice(0, -1);
  return result;
}

function sameStem(a, b) {
  if (a === b || IRREGULAR[a] === b || IRREGULAR[b] === a) return true;
  if (IRREGULAR[a] && IRREGULAR[a] === IRREGULAR[b]) return true;
  const aa = stem(a);
  const bb = stem(b);
  return aa === bb || aa === b || bb === a;
}

function reconCompare(original, answer) {
  const a = tokens(original);
  const b = tokens(answer);
  if (!a.length) return [];
  if (!b.length) return a.map((item) => ({kind: "missing", orig: item.raw, got: "", tag: lossKind(item.norm)}));
  const an = a.map((item) => item.norm);
  const bn = b.map((item) => item.norm);
  if (a.length === b.length && an.join("\u0000") !== bn.join("\u0000")
      && [...an].sort().join("\u0000") === [...bn].sort().join("\u0000")) {
    return [{kind: "order", orig: a.map((item) => item.raw).join(" "), got: b.map((item) => item.raw).join(" "), tag: "order"}];
  }

  const dp = Array.from({length: a.length + 1}, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i].norm === b[j].norm ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const raw = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].norm === b[j].norm) {
      raw.push({kind: "ok", orig: a[i].raw, got: b[j].raw, tag: "word"});
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({kind: "missing", orig: a[i].raw, got: "", tag: lossKind(a[i].norm)});
      i += 1;
    } else {
      raw.push({kind: "extra", orig: "", got: b[j].raw, tag: lossKind(b[j].norm)});
      j += 1;
    }
  }
  while (i < a.length) {
    raw.push({kind: "missing", orig: a[i].raw, got: "", tag: lossKind(a[i].norm)});
    i += 1;
  }
  while (j < b.length) {
    raw.push({kind: "extra", orig: "", got: b[j].raw, tag: lossKind(b[j].norm)});
    j += 1;
  }

  const out = [];
  for (let k = 0; k < raw.length; k += 1) {
    const first = raw[k];
    const second = raw[k + 1];
    if (second && ((first.kind === "missing" && second.kind === "extra")
        || (first.kind === "extra" && second.kind === "missing"))) {
      const missing = first.kind === "missing" ? first : second;
      const extra = first.kind === "extra" ? first : second;
      out.push({
        kind: "replaced",
        orig: missing.orig,
        got: extra.got,
        tag: sameStem(norm(missing.orig), norm(extra.got)) ? "tense" : lossKind(norm(missing.orig)),
      });
      k += 1;
    } else out.push(first);
  }
  return out;
}

function reconSummary(deltas) {
  let kept = 0;
  let total = 0;
  const tags = {};
  deltas.forEach((delta) => {
    if (delta.kind === "ok") {
      kept += 1;
      total += 1;
    } else if (delta.kind === "missing" || delta.kind === "replaced") {
      total += 1;
      tags[delta.tag] = (tags[delta.tag] || 0) + 1;
    } else if (delta.kind === "order") {
      const n = tokens(delta.orig).length;
      kept += n;
      total += n;
      tags.order = (tags.order || 0) + 1;
    } else {
      tags[delta.tag] = (tags[delta.tag] || 0) + 1;
    }
  });
  return {kept, total, tags};
}

function storePath(rel) {
  if (!rel || rel.startsWith("/") || rel.includes("..") || rel.includes("//") || !rel.endsWith(".json")) return null;
  return STORE_ROOTS.some((root) => rel.startsWith(root)) ? `store:${rel}` : null;
}

async function loadSeed(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) fail("неверное имя стартового материала");
  const response = await fetch(new URL(`../seed/${name}.json`, import.meta.url));
  if (!response.ok) fail(`стартовый материал ${name} не найден`);
  return response.json();
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadTextTranslation(text) {
  const key = (await sha256(text)).slice(0, 16);
  const response = await fetch(new URL(`data/texts/${key}.json`, import.meta.url));
  if (!response.ok) return {ready: false};
  return response.json();
}

function glossaryKey(word) {
  return String(word || "").trim().toLowerCase().replace(/^[\s'’‘"“”.,!?;:()[\]…\-–—]+|[\s'’‘"“”.,!?;:()[\]…\-–—]+$/g, "");
}

async function loadGlossary() {
  if (!glossaryPromise) {
    glossaryPromise = fetch(new URL("data/glossary.json", import.meta.url))
      .then((response) => response.ok ? response.json() : {})
      .catch(() => ({}));
  }
  return glossaryPromise;
}

function speechSynthesisCall(text, lang = "en-US") {
  if (!text || !("speechSynthesis" in window)) fail("озвучивание не поддерживается этим браузером");
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  speechSynthesis.speak(utterance);
  return {ok: true};
}

function speechWords(value) {
  const contractions = {
    "i'm": "i am", "what's": "what is", "it's": "it is", "don't": "do not",
    "doesn't": "does not", "can't": "can not", "couldn't": "could not",
    "i'd": "i would", "let's": "let us", "you're": "you are", "we're": "we are",
  };
  const numbers = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten"};
  let text = String(value || "").toLowerCase().replace(/[’‘]/g, "'");
  Object.entries(contractions).forEach(([short, full]) => {
    text = text.replace(new RegExp(`\\b${short.replace("'", "\\'")}\\b`, "g"), full);
  });
  return (text.match(/[a-z0-9]+/g) || []).map((word) => numbers[word] || word);
}

function tokenDistance(a, b) {
  const rows = Array.from({length: a.length + 1}, (_, i) => {
    const row = Array(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = a[i - 1] === b[j - 1]
        ? rows[i - 1][j - 1]
        : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
    }
  }
  return rows[a.length][b.length];
}

function missingWords(expected, heard) {
  const remaining = [...heard];
  return expected.filter((word) => {
    const at = remaining.indexOf(word);
    if (at < 0) return true;
    remaining.splice(at, 1);
    return false;
  });
}

function orderedWords(expected, heard) {
  let cursor = 0;
  const matched = [];
  const missing = [];
  expected.forEach((word) => {
    const at = heard.indexOf(word, cursor);
    if (at < 0) {
      missing.push(word);
      return;
    }
    matched.push(word);
    cursor = at + 1;
  });
  return {matched, missing};
}

export function scorePhrase(expected, heard, accepted = []) {
  const variants = [expected, ...(accepted || [])].filter(Boolean);
  const heardWords = speechWords(heard);
  let best = null;
  variants.forEach((variant) => {
    const required = speechWords(variant);
    const openTail = String(variant).includes("...");
    let score;
    let ordered = null;
    if (openTail) {
      ordered = orderedWords(required, heardWords);
      score = required.length ? ordered.matched.length / required.length : 0;
    } else {
      const longest = Math.max(required.length, heardWords.length, 1);
      score = Math.max(0, 1 - tokenDistance(required, heardWords) / longest);
    }
    const result = {
      expected: variant,
      heard: String(heard || "").trim(),
      score: Math.round(score * 100),
      missing: ordered ? ordered.missing : missingWords(required, heardWords),
      extra: openTail ? [] : missingWords(heardWords, required),
    };
    if (!best || result.score > best.score) best = result;
  });
  best ||= {expected: String(expected || ""), heard: String(heard || ""), score: 0, missing: [], extra: []};
  best.status = best.score >= 80 ? "good" : best.score >= 50 ? "close" : "again";
  best.claim = "Проверяю, распознались ли слова. Акцент и интонацию эта проверка не оценивает.";
  return best;
}

function recognizeSpeech() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    fail("В этом браузере нет распознавания речи. На iPhone открой установленное приложение из Safari и проверь, что Siri включена.", "speech-unavailable");
  }
  return new Promise((resolve, reject) => {
    const recognition = new Recognition();
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fn(value);
    };
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;
    recognition.onresult = (event) => {
      const result = event.results?.[event.resultIndex || 0];
      const alternatives = result ? Array.from(result).map((item) => ({
        transcript: String(item.transcript || "").trim(),
        confidence: Number.isFinite(item.confidence) ? item.confidence : null,
      })).filter((item) => item.transcript) : [];
      if (!alternatives.length) {
        finish(reject, problem("Речь не распозналась. Нажми ещё раз и скажи фразу ближе к телефону.", "no-speech"));
        return;
      }
      finish(resolve, {ok: true, text: alternatives[0].transcript, alternatives});
    };
    recognition.onerror = (event) => {
      const messages = {
        "not-allowed": "Safari не получил доступ к распознаванию речи. Разреши микрофон для сайта и проверь, что Siri включена.",
        "service-not-allowed": "Служба распознавания речи недоступна. Проверь, что Siri включена, затем открой приложение из Safari.",
        "audio-capture": "Не получилось включить микрофон. Проверь разрешение микрофона для сайта.",
        "no-speech": "Речь не услышана. Нажми ещё раз и скажи фразу ближе к телефону.",
        "network": "Для распознавания сейчас нужна сеть. Запись и переслушивание остаются доступны.",
      };
      finish(reject, problem(messages[event.error] || "Речь не распозналась. Попробуй ещё раз.", event.error || "speech"));
    };
    recognition.onnomatch = () => finish(reject, problem("Слова не распознались. Послушай образец и попробуй ещё раз.", "no-match"));
    recognition.onend = () => {
      if (!finished) finish(reject, problem("Распознавание закончилось без текста. Попробуй ещё раз.", "no-speech"));
    };
    const timer = setTimeout(() => {
      try { recognition.abort(); } catch {}
      finish(reject, problem("Распознавание не ответило. Проверь сеть и Siri или используй запись с переслушиванием.", "speech-timeout"));
    }, 15_000);
    try {
      recognition.start();
    } catch {
      finish(reject, problem("Не получилось запустить распознавание. Подожди секунду и нажми ещё раз.", "speech-start"));
    }
  });
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !("MediaRecorder" in window)) {
    fail("запись голоса не поддерживается этим браузером", "mic");
  }
  if (recorder && recorder.state === "recording") fail("запись уже идёт", "mic");
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({audio: true});
  } catch {
    fail("нет доступа к микрофону. Разреши микрофон для сайта в настройках Safari", "mic");
  }
  const choices = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  const mimeType = choices.find((type) => MediaRecorder.isTypeSupported?.(type));
  recorder = mimeType ? new MediaRecorder(recordingStream, {mimeType}) : new MediaRecorder(recordingStream);
  recordingChunks = [];
  recordingStartedAt = Date.now();
  recorder.ondataavailable = (event) => {
    if (event.data?.size) recordingChunks.push(event.data);
  };
  recorder.start();
  return {ok: true};
}

function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error("audio read failed"));
    reader.readAsDataURL(blob);
  });
}

async function stopRecording() {
  if (!recorder || recorder.state !== "recording") fail("запись не шла", "mic");
  const active = recorder;
  await new Promise((resolve) => {
    active.addEventListener("stop", resolve, {once: true});
    active.stop();
  });
  recordingStream?.getTracks().forEach((track) => track.stop());
  recordingStream = null;
  const mime = active.mimeType || "audio/mp4";
  const blob = new Blob(recordingChunks, {type: mime});
  const path = `pwa-recording:${Date.now()}`;
  recordings.set(path, blob);
  const b64 = await blobBase64(blob);
  return {ok: true, path, seconds: Math.max(1, Math.round((Date.now() - recordingStartedAt) / 1000)), b64, mime};
}

function isoWeekStart(date = new Date()) {
  const day = mondayDay(date);
  return shiftLocalDay(date, 1 - day);
}

function unavailable(feature) {
  fail(`${feature} на iPhone требует защищённый сервер или открытое приложение на Mac. Остальные упражнения и данные работают на телефоне.`);
}

export const bridge = {
  async call(cmd, args = {}) {
    switch (cmd) {
      case "state.load": {
        const before = await readRecord("state", {});
        const data = migrateLearningState(before);
        if (JSON.stringify(before) !== JSON.stringify(data)) await writeRecord("state", data);
        return {data};
      }
      case "state.save": await writeRecord("state", migrateLearningState(args.data || {})); return {ok: true};
      case "words.load": return {data: await readRecord("words", {list: []})};
      case "words.save": await writeRecord("words", args.data || {list: []}); return {ok: true};
      case "store.load": {
        const key = storePath(args.rel);
        if (!key) fail("этот путь недоступен веб-приложению");
        const value = await readRecord(key, undefined);
        return value === undefined ? {empty: true, data: {}} : {data: value};
      }
      case "store.save": {
        const key = storePath(args.rel);
        if (!key) fail("этот путь недоступен веб-приложению");
        await writeRecord(key, args.data || {});
        return {ok: true};
      }
      case "today": {
        const date = new Date();
        const weekday = mondayDay(date);
        return {date: localDateKey(date), weekday, dayName: DAY_NAMES[weekday - 1], dayNumber: localDayNumber(date)};
      }
      case "plan": {
        const day = Number(args.day) || mondayDay();
        if (day < 1 || day > 7) fail("нет такого дня недели");
        let blocks = planFor(day);
        if (args.audience === "child") {
          blocks = blocks.filter((item) => !["film_parse", "film_full", "videos5"].includes(item.key));
          blocks = blocks.map((item) => ({...item,
            title:item.key === "write" ? "Написать 3-5 предложений и улучшить после проверки" : item.key === "speak" ? "Ответить вслух двумя связанными репликами" : item.title,
            note:item.key === "video_watch" ? "Короткие возрастные видео из детского маршрута" : item.note,
          }));
        }
        return {blocks};
      }
      case "streak": {
        const dates = new Set(args.dates || []);
        let cursor = new Date();
        if (!dates.has(localDateKey(cursor))) cursor = shiftLocalDay(cursor, -1);
        let streak = 0;
        while (dates.has(localDateKey(cursor))) {
          streak += 1;
          cursor = shiftLocalDay(cursor, -1);
        }
        return {streak};
      }
      case "grammarWeek": {
        const start = localDayNumber(isoWeekStart());
        const end = start + 6;
        const count = (args.dates || []).filter((value) => {
          const [y, m, d] = String(value).split("-").map(Number);
          const n = Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
          return n >= start && n <= end;
        }).length;
        return {count};
      }
      case "listenRules": return {total: 3, doneAt: 0.85, endedMin: 0.6, seekGap: 3};
      case "srsNext": {
        const grade = args.grade || (args.remembered ? "good" : "again");
        const next = srsNext(srsCard(args), grade);
        return {...next, days: next.interval, due: localDayNumber() + next.interval};
      }
      case "srsPreview": {
        const card = srsCard(args);
        return Object.fromEntries(["again", "hard", "good", "easy"].map((grade) => [grade, srsNext(card, grade).interval]));
      }
      case "reset": {
        const scope = args.scope || "progress";
        if (scope !== "progress" && scope !== "all") fail("непонятный объём сброса");
        const state = await readRecord("state", {});
        const words = await readRecord("words", {list: []});
        await writeRecord(`backup:${Date.now()}`, {at: new Date().toISOString(), state, words});
        const kept = Object.fromEntries(KEEP_KEYS.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
        await writeRecord("state", kept);
        await writeRecord("words", {list: []});
        if (scope === "all") await deleteRecords((key) => key.startsWith("store:"));
        return {ok: true, scope};
      }
      case "seed": return {data: await loadSeed(String(args.name || ""))};
      case "course.load": {
        const level = String(args.level || "PRE_A1").toUpperCase();
        const path = level === "A1" ? "data/course/a1/catalog.json" : "data/course/pre-a1/catalog.json";
        const response = await fetch(new URL(path, import.meta.url));
        if (!response.ok) fail(`курс ${level} не найден`);
        return {data: await response.json()};
      }
      case "release.info": return {releaseId:RELEASE_ID, schemaVersion:LEARNING_SCHEMA_VERSION};
      case "tools": return {mode: "pwa", ytdlp: "", claude: "", whisper: "", hasToken: false};
      case "typing":
      case "theme": return {ok: true};
      case "zoom": {
        if (args.dir === "in") pwaZoom = Math.min(200, pwaZoom + 10);
        if (args.dir === "out") pwaZoom = Math.max(80, pwaZoom - 10);
        if (args.dir === "reset") pwaZoom = 100;
        document.body.style.zoom = `${pwaZoom / 100}`;
        return {ok: true, percent: pwaZoom};
      }
      case "openURL": {
        const url = String(args.url || "");
        if (!/^https?:\/\//i.test(url)) fail("можно открыть только http или https адрес");
        window.open(url, "_blank", "noopener,noreferrer");
        return {ok: true};
      }
      case "reveal": unavailable("Папка Finder"); break;
      case "token.get": return {hasToken: false, masked: "", fromEnv: false, help: "На iPhone токен Claude не хранится"};
      case "token.set": unavailable("Токен Claude"); break;
      case "limitStatus": return {blocked: false};
      case "speak": return speechSynthesisCall(String(args.text || ""), String(args.lang || "en-US"));
      case "speech.check": return recognizeSpeech();
      case "speech.score": return scoreLearningPhrase(String(args.expected || ""), String(args.heard || ""), args.accepted || [], args.rule || {});
      case "rec.start": return startRecording();
      case "rec.stop": return stopRecording();
      case "rec.delete": recordings.delete(String(args.path || "")); return {ok: true};
      case "stt": unavailable("Распознавание и разбор речи"); break;
      case "subs.fetch":
      case "subs.translateChunk": unavailable("Автоматический разбор YouTube"); break;
      case "series.list": return {folder: "", episodes: []};
      case "series.pick":
      case "series.open": unavailable("Доступ к фильмам на диске Mac"); break;
      case "library.load": return {items:(await onlineVideos()).map((video) => ({...video,kind:"online",onlineOnly:true})), running:false, pwa:true};
      case "library.text": return loadTextTranslation(String(args.text || ""));
      case "library.refill": unavailable("Пополнение библиотеки"); break;
      case "ai.grammarLesson": return grammarLesson(args);
      case "ai.speakSample": return speakingSample(args);
      case "ai.writeHints": return writingHints(args);
      case "ai.checkWriting": return basicWritingCheck(args);
      case "ai.checkSentence": {
        const checked = basicWritingCheck({text:args.sentence});
        const word = String(args.word || "").toLowerCase().match(/[a-z]+(?:['’][a-z]+)?/g) || [];
        const sentence = String(args.sentence || "").toLowerCase().match(/[a-z]+(?:['’][a-z]+)?/g) || [];
        const wordFound = word.length > 0 && sentence.some((_, i) => word.every((token,j) => sentence[i+j] === token));
        return {...checked,wordFound};
      }
      case "ai.canISay": return {mode:"comparison",original:String(args.original || ""),
        identical:tokens(String(args.original || "")).map((t) => t.norm).join(" ") === tokens(String(args.mine || "")).map((t) => t.norm).join(" ")};
      case "ai.word": {
        const glossary = await loadGlossary();
        const entry = glossary[glossaryKey(args.word)];
        if (!entry) return {here: "", all: "", pos: "", base: "", source: "none", translation: "", note: "слова нет в офлайн-словаре"};
        const here = entry.here || "";
        const all = entry.all || entry.translation || "";
        return {here, all, pos: entry.pos || "", base: "", exact: Boolean(here), cached: true, source: "glossary", translation: here || all};
      }
      case "recon.gaps": {
        const lines = Array.isArray(args.lines) ? args.lines.map(String) : [];
        const targets = reconTargets(lines, args.known || [], Number(args.count) || 8);
        return {targets, losses: reconLosses(lines, targets)};
      }
      case "recon.compare": {
        const deltas = reconCompare(String(args.original || ""), String(args.answer || ""));
        return {deltas, ...reconSummary(deltas)};
      }
      default:
        if (cmd.startsWith("ai.")) unavailable("Проверка через ИИ");
        fail(`неизвестная веб-команда: ${cmd}`);
    }
    return {ok: false};
  },

  onlineVideos,

  async exportData() {
    await window.flushPwaData?.();
    const payload = {
      format: "pogruzhenie-pwa-backup",
      version: 2,
      releaseId: RELEASE_ID,
      schemaVersion: LEARNING_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      records: await allRecords(),
      writingDraft: localStorage.getItem("pogruzhenie-writing-draft") || "",
    };
    const text = JSON.stringify(payload, null, 2);
    const fileName = `pogruzhenie-backup-${localDateKey()}.json`;
    const file = new File([text], fileName, {type: "application/json"});
    if (navigator.canShare?.({files: [file]})) {
      await navigator.share({title: "Резервная копия Погружения", files: [file]});
      return;
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  },

  async importFile(file) {
    if (!file) return;
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      fail("резервная копия не является JSON-файлом");
    }
    validateBackupPayload(payload);
    const allowed = Object.fromEntries(Object.entries(payload.records).filter(([key]) => (
      key === "state" || key === "words" || key.startsWith("store:") || key.startsWith("backup:")
    )));
    if (allowed.state) allowed.state = migrateLearningState(allowed.state);
    await replaceRecords(allowed);
    localStorage.setItem("pogruzhenie-writing-draft", String(payload.writingDraft || ""));
    location.reload();
  },
};

function updatePwaStatus(message) {
  const status = document.getElementById("pwaUpdateStatus");
  if (status) status.textContent = message;
}

function installModeText() {
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone === true) {
    return "Открыто отдельным приложением. Обновления проверяются автоматически.";
  }
  const ua = navigator.userAgent || "";
  if (/huawei|android/i.test(ua)) return "На Huawei или Android: открой меню браузера и выбери «Установить приложение» или «Добавить на главный экран».";
  if (/iphone|ipad|ipod/i.test(ua)) return "На iPhone или iPad: открой в Safari, нажми «Поделиться», затем «На экран Домой».";
  return "Открой меню браузера и выбери «Установить приложение» или «Добавить на главный экран».";
}

function updateIsSafe() {
  const current = document.querySelector(".screen.on")?.id;
  const overlayOpen = document.getElementById("overlay")?.classList.contains("on");
  const recording = document.getElementById("micbtn")?.classList.contains("recording");
  const courseRecording = document.getElementById("courseRecBtn")?.classList.contains("recording");
  return (current === "s-today" || current === "s-settings") && !overlayOpen && !recording && !courseRecording;
}

function showUpdateBanner(reload) {
  let banner = document.getElementById("pwaUpdateBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "pwaUpdateBanner";
    banner.className = "pwa-update-banner";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    banner.innerHTML = "<div><b>Новая версия готова</b><div class='muted small'>Прогресс и память слов сохранятся.</div></div><button class='btn pri'>Обновить</button>";
    banner.querySelector("button").onclick = reload;
    document.body.appendChild(banner);
  }
  banner.classList.add("on");
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    updatePwaStatus("Этот браузер не поддерживает офлайн-обновления.");
    return;
  }
  const local = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  if (location.protocol !== "https:" && !local) {
    updatePwaStatus("Для установки, микрофона и обновлений нужен постоянный HTTPS-адрес.");
    return;
  }
  let hadController = Boolean(navigator.serviceWorker.controller);
  let applying = false;
  let reloadStarted = false;
  const reloadOnce = () => {
    if (reloadStarted) return;
    reloadStarted = true;
    location.reload();
  };
  const applyWaitingWorker = async (worker) => {
    if (applying || !worker) return;
    updatePwaStatus("Сохраняю данные и применяю обновление…");
    try {
      await window.flushPwaData?.();
      applying = true;
      worker.addEventListener("statechange", () => {
        if (applying && worker.state === "activated") reloadOnce();
      });
      worker.postMessage({type:"APPLY_UPDATE"});
    } catch (error) {
      updatePwaStatus("Не удалось сохранить текущую работу. Обновление не применено.");
      throw error;
    }
  };
  const offerUpdate = (worker) => {
    if (!worker || applying) return;
    updatePwaStatus("Новая версия полностью загружена и ждёт подтверждения.");
    showUpdateBanner(() => applyWaitingWorker(worker));
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    if (applying) reloadOnce();
  });
  try {
    const workerUrl = new URL("../sw.js", import.meta.url);
    const registration = await navigator.serviceWorker.register(workerUrl, {
      scope: new URL("../", import.meta.url).pathname,
      updateViaCache: "none",
    });
    updatePwaStatus(installModeText());
    if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          offerUpdate(registration.waiting || installing);
        }
      });
    });
    const check = () => {
      if (navigator.onLine) registration.update().catch(() => {});
    };
    check();
    setInterval(check, 60_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") check();
    });
    window.addEventListener("online", check);
    window.addEventListener("focus", check);
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    updatePwaStatus("Офлайн-пакет пока не установился. Открой приложение ещё раз при наличии сети.");
  }
}

function preparePwaPage() {
  document.documentElement.classList.add("pwa");
  const card = document.getElementById("pwaCard");
  if (card) card.classList.remove("hidden");
  bridge.call("release.info").then((info) => {
    const label = document.getElementById("releaseId");
    if (label) label.textContent = `${info.releaseId} · схема ${info.schemaVersion}`;
  }).catch(() => {});
  const listenNotice = document.getElementById("pwaListenNotice");
  if (listenNotice) listenNotice.classList.remove("hidden");
  const phoneVideos = document.getElementById("phoneVideos");
  if (listenNotice && phoneVideos) listenNotice.before(phoneVideos);
  const videoToggle = document.getElementById("pickBtn");
  if (videoToggle) videoToggle.setAttribute("data-native-only", "");
  const analyze = document.getElementById("sttBtn");
  if (analyze) analyze.textContent = "Сравнить запись";
  const checkWriting = document.getElementById("wCheckBtn");
  if (checkWriting) checkWriting.textContent = "Базовая проверка";
  const intro = document.getElementById("listenIntro");
  if (intro) intro.hidden = true;
  const writingHint = document.getElementById("wtext");
  if (writingHint) writingHint.placeholder = "Напиши несколько предложений по-английски. Черновик сохраняется на этом устройстве.";
  // Keep the navigation in the same flex viewport as the content. Safari's
  // keyboard and collapsing browser bars resize the visual viewport.
  const resizeViewport = () => {
    const viewport = window.visualViewport;
    if (viewport && viewport.scale === 1) {
      document.documentElement.style.setProperty("--pwa-viewport-height", `${viewport.height}px`);
    }
  };
  resizeViewport();
  window.visualViewport?.addEventListener("resize", resizeViewport);
  window.addEventListener("resize", resizeViewport);
  const draft = localStorage.getItem("pogruzhenie-writing-draft") || "";
  const writing = document.getElementById("wtext");
  if (writing && draft && !writing.value) {
    writing.value = draft;
    setTimeout(() => window.wCount?.(), 0);
  }
  registerServiceWorker();
}

window.PogruzheniePWA = bridge;
preparePwaPage();
