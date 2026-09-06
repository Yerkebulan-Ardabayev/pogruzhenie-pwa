// Original practice material and deliberately bounded local feedback. No AI API.
const dataPromises = new Map();

async function dataFile(name) {
  if (!dataPromises.has(name)) {
    const request = fetch(new URL(`data/${name}.json`, import.meta.url)).then(async (response) => {
      if (!response.ok) throw {error:"Учебный пакет не загрузился. Открой приложение при наличии сети и попробуй ещё раз.", code:"content"};
      return response.json();
    }).catch((error) => {
      dataPromises.delete(name);
      throw error;
    });
    dataPromises.set(name, request);
  }
  return dataPromises.get(name);
}

export async function grammarLesson({level, topic}) {
  const catalog = await dataFile("grammar");
  const lesson = catalog[level]?.[topic];
  if (!lesson) throw {error:"Для этой темы пока нет готового урока в пакете. Выбери другую тему.", code:"content-missing"};
  const result = structuredClone(lesson);
  result.exercises = (result.exercises || []).map((exercise, index, all) => ({
    ...exercise,
    evidence: exercise.evidence || (index >= Math.max(0, all.length - 2) ? "independent" : "practice"),
  }));
  result.independentRule = "Обе последние задачи нужно решить верно без подсказки. Самооценка отдельно определяет срок повторения.";
  return result;
}

export async function speakingSample({level, question, scheme}) {
  const catalog = await dataFile("speaking");
  const answer = catalog[level]?.[question];
  if (!answer) throw {error:"Для этого вопроса нет готового образца. Выбери следующий вопрос.", code:"content-missing"};
  if (scheme === "Рассказ: пять W") {
    return {
      offline:true, scaffold:true, full:"", fullRu:"",
      steps:[
        {step:"Кто", en:"A friend and I…", ru:"Начни с участников случая по теме вопроса."},
        {step:"Что", en:"We decided to…", ru:"Что произошло? Выбери одно событие."},
        {step:"Когда", en:"Last week…", ru:"Когда это было? Замени на своё время."},
        {step:"Где", en:"At home / at work / in the city…", ru:"Где это происходило? Выбери своё место."},
        {step:"Почему", en:"We did this because…", ru:"Объясни причину и закончи рассказ."},
      ],
    };
  }
  if (scheme === "Аргумент: Point → Reason → Example") {
    return {
      offline:true, scaffold:true, full:"", fullRu:"",
      steps:[
        {step:"Мнение", en:"My view is that…", ru:"Назови свою позицию по вопросу."},
        {step:"Причина", en:"The main reason is…", ru:"Объясни, почему ты так считаешь."},
        {step:"Пример", en:"For example…", ru:"Добавь свой конкретный пример."},
      ],
    };
  }
  return {
    offline:true, full:answer.en, fullRu:answer.ru,
    steps:[],
  };
}

export function writingHints({topic}) {
  return {
    offline:true,
    ideas:[
      {en:"What is your own view?",ru:`Выбери свою позицию по теме «${topic || "мой день"}».`},
      {en:"What happened in your experience?",ru:"Вспомни один конкретный случай: кто, где и что сделал."},
      {en:"What would you change next time?",ru:"Закончи тем, что ты решил или изменил бы."},
    ],
    starters:[
      {en:"I think",ru:"Я думаю"},
      {en:"One reason is that",ru:"Одна из причин в том, что"},
      {en:"For example, last week",ru:"Например, на прошлой неделе"},
      {en:"Next time, I would like to",ru:"В следующий раз я хотел бы"},
    ],
  };
}

// Only flag a pronoun at the beginning of a simple sentence. Embedded clauses,
// coordinated subjects, introductions and quotes need context this checker lacks.
const BASIC_RULES = [
  [ /\bI is\b/gi, "I am", "С I в настоящем нужен am." ],
  [ /\bI are\b/gi, "I am", "С I в настоящем нужен am." ],
  [ /\b(he|she|it) are\b/gi, "$1 is", "С he/she/it в настоящем нужен is." ],
  [ /\b(we|they|you) is\b/gi, "$1 are", "С we/they/you в настоящем нужен are." ],
  [ /\b(he|she|it) have\b/gi, "$1 has", "В самостоятельном утверждении: he/she/it has. В цитате или особой конструкции проверь контекст." ],
  [ /\b(I|you|we|they) has\b/gi, "$1 have", "С I/you/we/they используется have." ],
  [ /\b(I|you|he|she|it|we|they) (can|could|must|should) to (\w+)\b/gi, "$1 $2 $3", "После этого модального глагола to не нужно." ],
];

export function basicWritingCheck({text = ""}) {
  text = String(text).trim();
  if (!/[a-z]/i.test(text)) throw {error:"Напиши ответ по-английски. Русский текст здесь не переводится автоматически.",code:"writing-language"};
  const errors = [];
  BASIC_RULES.forEach(([pattern, replacement, why]) => {
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(0, match.index).split(/[.!?\n]/).pop();
      if (before.trim()) continue;
      errors.push({was:match[0],fix:match[0].replace(new RegExp(pattern.source,"i"), replacement),why});
    }
  });
  return {
    mode:"basic", corrected:text, errors,
    comment:"Это локальная проверка am/is/are, have/has и to после нескольких модальных глаголов, только с местоимением в начале простого предложения. " +
      "Смысл, выбор времени, стиль и остальные ошибки не проверены. Исходный текст сохранён без автоматической замены.",
  };
}

export async function onlineVideos() {
  return dataFile("videos");
}
