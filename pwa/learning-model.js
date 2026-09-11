export const LEARNING_SCHEMA_VERSION = 2;
export const RELEASE_ID = "LEARNING-UPDATE-2026-09-rc2";
export const REVIEW_INTERVALS = [1, 3, 7];

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function emptyCourseState() {
  return {
    completed: {}, progress: {}, review: {}, checkpoints: {},
    exitAssessment: {skills: {}}, attempts: [], objectives: {},
  };
}

function migrateCourseState(raw, markLegacy) {
  const course = Object.assign(emptyCourseState(), object(raw));
  course.completed = object(course.completed);
  course.progress = object(course.progress);
  course.review = object(course.review);
  course.checkpoints = object(course.checkpoints);
  course.exitAssessment = Object.assign({skills: {}}, object(course.exitAssessment));
  course.exitAssessment.skills = object(course.exitAssessment.skills);
  course.attempts = Array.isArray(course.attempts) ? course.attempts : [];
  course.objectives = object(course.objectives);

  Object.entries(course.completed).forEach(([lessonId, completed]) => {
    if (!completed) return;
    if (markLegacy && typeof completed !== "object") {
      course.completed[lessonId] = {
        legacyCompleted: true,
        evidenceStatus: "legacy_unverified",
      };
    } else if (markLegacy && !completed.evidenceStatus) {
      completed.legacyCompleted = true;
      completed.evidenceStatus = "legacy_unverified";
    }
  });

  Object.values(course.progress).forEach((progress) => {
    if (!progress || typeof progress !== "object") return;
    progress.practice = object(progress.practice);
    progress.independent = object(progress.independent);
    progress.needsReview = Boolean(progress.needsReview);
    if (markLegacy && (progress.taskDone || progress.speechDone) && !progress.evidenceStatus) {
      progress.evidenceStatus = "legacy_unverified";
    }
  });
  Object.values(course.checkpoints).forEach((checkpoint) => {
    if (!checkpoint || typeof checkpoint !== "object") return;
    checkpoint.results = object(checkpoint.results);
    if (markLegacy && checkpoint.passed && !checkpoint.evidenceStatus) {
      checkpoint.legacyPassed = true;
      checkpoint.passed = false;
      checkpoint.evidenceStatus = "legacy_unverified";
    }
  });
  Object.entries(course.review).forEach(([lessonId, review]) => {
    const value = object(review);
    const successfulStep = Number.isInteger(value.successfulStep)
      ? Math.max(-1, Math.min(REVIEW_INTERVALS.length - 1, value.successfulStep))
      : Number.isInteger(value.completedReviews)
        ? Math.max(-1, Math.min(REVIEW_INTERVALS.length - 1, value.completedReviews - 1))
        : -1;
    course.review[lessonId] = {
      due: Number(value.due) || 0,
      dueDate: value.dueDate || "",
      successfulStep,
      policyVersion: value.policyVersion || "review-1-3-7-v1",
      lastOutcome: value.lastOutcome || "",
      lastAttemptId: value.lastAttemptId || "",
      lastReviewedDate: value.lastReviewedDate || "",
      currentAttemptId: "",
    };
  });
  return course;
}

export function migrateLearningState(raw) {
  const state = Object.assign({}, object(raw));
  const previous = Number(state.learningSchemaVersion) || 0;
  const markLegacy = previous < LEARNING_SCHEMA_VERSION;
  state.foundation = migrateCourseState(state.foundation, markLegacy);
  state.a1Course = migrateCourseState(state.a1Course, markLegacy);
  state.learningSchemaVersion = LEARNING_SCHEMA_VERSION;
  state.releaseId = RELEASE_ID;
  state.migrations = object(state.migrations);
  if (markLegacy) state.migrations[`schema-${LEARNING_SCHEMA_VERSION}`] = new Date().toISOString();
  return state;
}

export function nextReview(review, today, outcome, attemptId = "") {
  const current = object(review);
  if (attemptId && current.lastAttemptId === attemptId) return {...current};
  const step = Number.isInteger(current.successfulStep) ? current.successfulStep : -1;
  if (outcome !== "correct") {
    return {...current, due: today + 1, successfulStep:-1, policyVersion:"review-1-3-7-v1",
      lastOutcome: outcome, lastAttemptId:attemptId || current.lastAttemptId || ""};
  }
  const successfulStep = Math.min(REVIEW_INTERVALS.length - 1, step + 1);
  const offset = REVIEW_INTERVALS[successfulStep];
  return {...current, due: today + offset, successfulStep, policyVersion:"review-1-3-7-v1",
    lastOutcome: outcome, lastAttemptId:attemptId || current.lastAttemptId || ""};
}

function words(value) {
  return String(value || "").toLowerCase().replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
}

function hasAny(haystack, variants) {
  return variants.some((variant) => haystack.includes(variant));
}

const NEGATIONS = ["not", "no", "never", "don't", "doesn't", "didn't", "isn't", "aren't", "can't", "cannot"];
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export function scoreLearningPhrase(expected, heard, accepted = [], rule = {}) {
  const expectedVariants = [expected, ...accepted].filter(Boolean).map(words);
  const heardWords = words(heard);
  const joined = heardWords.join(" ");
  // Дословное совпадение считается только по вариантам без слота «...», иначе голая заготовка проходит.
  const expectedJoined = [expected, ...accepted].filter((variant) => variant && !String(variant).includes("..."))
    .map((variant) => words(variant).join(" "));
  const intent = rule.intent || (String(expected).includes("...") && /\b(name is|i am|i'm)\b/i.test(String(expected)) ? "introduce-self" : "closed-phrase");

  let correct = expectedJoined.includes(joined);
  let source = "rule";
  const openSlot = expectedVariants.some((variant) => variant.length > 0) &&
    [expected, ...accepted].some((variant) => String(variant || "").includes("..."));
  if (intent === "closed-phrase" && openSlot) {
    // Шаблон с многоточием: фиксированное начало обязано совпасть, слот обязан быть заполнен хотя бы одним словом.
    correct = correct || [expected, ...accepted].filter(Boolean).some((variant) => {
      const stem = words(String(variant).split("...")[0]);
      return stem.length > 0 && heardWords.length > stem.length &&
        stem.every((token, index) => heardWords[index] === token);
    });
  }
  if (intent === "introduce-self") {
    correct = /^(hello |hi )?(my name is|i am|i'm) [a-z][a-z'-]*$/.test(joined);
  } else if (intent === "day-answer") {
    const expectedDays = expectedVariants.flat().filter((token) => DAYS.includes(token));
    const heardDays = heardWords.filter((token) => DAYS.includes(token));
    correct = expectedDays.length > 0 && heardDays.length > 0 &&
      heardDays.every((day) => expectedDays.includes(day)) && expectedDays.some((day) => heardDays.includes(day));
  } else if (intent === "accept-meeting") {
    correct = hasAny(joined, ["yes sure", "sure", "yes i can", "okay", "ok", "let's meet tomorrow", "let us meet tomorrow"]);
  } else if (intent === "free-response") {
    return {outcome:"not_verified", source:"self", score:null, heard:String(heard || "").trim(), claim:"Свободный ответ сохранён для самопроверки или проверки преподавателем."};
  }

  const expectedNegative = expectedVariants.some((variant) => variant.some((token) => NEGATIONS.includes(token)));
  const heardNegative = heardWords.some((token) => NEGATIONS.includes(token));
  if (expectedNegative !== heardNegative) correct = false;
  const expectedNumbers = expectedVariants.flat().filter((token) => /^\d+$/.test(token));
  if (expectedNumbers.length && !expectedNumbers.some((token) => heardWords.includes(token))) correct = false;
  const expectedTimes = expectedVariants.flat().filter((token) => /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/.test(token));
  if (rule.protectTime && expectedTimes.length && !expectedTimes.some((token) => heardWords.includes(token))) correct = false;

  return {
    outcome: correct ? "correct" : "incorrect",
    source,
    score: correct ? 100 : 0,
    status: correct ? "good" : "again",
    missing: correct ? [] : expectedVariants[0] || [],
    extra: [],
    heard: String(heard || "").trim(),
    claim: "Проверены смысловой шаблон и защищённые слова. Проверка не оценивает акцент и интонацию.",
  };
}

export function validateBackupPayload(payload) {
  if (!payload || payload.format !== "pogruzhenie-pwa-backup" || ![1, 2].includes(payload.version)) {
    throw {error:"это не резервная копия PWA «Погружение»"};
  }
  if (!payload.records || typeof payload.records !== "object" || Array.isArray(payload.records)) {
    throw {error:"резервная копия не содержит записей"};
  }
  const state = payload.records.state;
  const wordsRecord = payload.records.words;
  if (state !== undefined && (!state || typeof state !== "object" || Array.isArray(state))) {
    throw {error:"в резервной копии повреждено состояние"};
  }
  if (wordsRecord !== undefined && (!wordsRecord || !Array.isArray(wordsRecord.list))) {
    throw {error:"в резервной копии повреждена тетрадка"};
  }
  return true;
}
