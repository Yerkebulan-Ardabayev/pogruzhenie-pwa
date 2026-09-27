export const LEARNING_SCHEMA_VERSION = 2;
export const RELEASE_ID = "LEARNING-UPDATE-2026-09-rc3";
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

// Сокращение и полная форма это один ответ (spec 3.1, LEARNING-FIX Б5). Порядок важен:
// can't и won't раньше общего n't. Притяжательное 's (Anna's) не раскрывается.
const CONTRACTIONS = [
  [/\bcan't\b/g, "can not"], [/\bcannot\b/g, "can not"], [/\bwon't\b/g, "will not"], [/\bshan't\b/g, "shall not"],
  [/n't\b/g, " not"], [/\bi'm\b/g, "i am"], [/\blet's\b/g, "let us"],
  [/\b(what|where|who|how|that|there|here|it|he|she|name|today)'s\b/g, "$1 is"],
  [/'re\b/g, " are"], [/'ve\b/g, " have"], [/'ll\b/g, " will"], [/\b(i|you|he|she|we|they)'d\b/g, "$1 would"],
];
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

// Распознавание речи пишет числа цифрами («at 7»), курс словами («at seven»): до 100 это одно и то же.
function numberWords(token) {
  if (!/^\d+$/.test(token)) return [token];
  const n = Number(token);
  if (n > 100) return [token];
  if (n === 100) return ["one", "hundred"];
  if (n < 20) return [ONES[n]];
  return n % 10 ? [TENS[Math.floor(n / 10)], ONES[n % 10]] : [TENS[Math.floor(n / 10)]];
}

function words(value) {
  let text = String(value || "").toLowerCase().replace(/[’‘]/g, "'");
  CONTRACTIONS.forEach(([pattern, full]) => { text = text.replace(pattern, full); });
  // Распознавание пишет время как «7:00» и «7:30»: это «seven o'clock» и «seven thirty».
  text = text.replace(/\b(\d{1,2}):00\b/g, "$1 o'clock").replace(/\b(\d{1,2}):([0-5]\d)\b/g, "$1 $2");
  return text.replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean).flatMap(numberWords);
}

// Одна нормализация для речи и точного письма: регистр, пунктуация, сокращения, числа.
export function normalizeAnswerText(value) {
  return words(value).join(" ");
}

function hasAny(haystack, variants) {
  const padded = ` ${haystack} `;
  return variants.some((variant) => padded.includes(` ${variant} `));
}

// Частые английские слова, та же строка, что COMMON_EN_WORDS в ui.html (равенство проверяет pwa/test_learning_quality.mjs).
// Здесь словарь отличает имя от обычных слов в ответе «I am ...»: «I am nice girl» это не имя, «I am Aigerim Nurlanovna» имя.
export const COMMON_EN_WORDS = new Set("the of and to a in for is on that by this with i you it not or be are from at as your all have new more an was we will home can us about if page my has search free but our one other do no information time they site he up may what which their news out use any there see only so his when contact here business who web also now help get pm view online c e first am been would how were me s services some these click its like service x than find price date back top people had list name just over state year day into email two health n world re next used go b work last most products music buy data make them should product system post her city t add policy number such please available copyright support message after best software then jan good video well d where info rights public books high school through m each links she review years order very privacy book items company r read group need many user said de does set under general research university january mail full map reviews program life know games way days management p part could great united hotel real f item international center ebay must store travel comments made development report off member details line terms before hotels did send right type because local those using results office education national car design take posted internet address community within states area want phone dvd shipping reserved subject between forum family l long based w code show o even black check special prices website index being women much sign file link open today technology south case project same pages uk version section own found sports house related security both g county american photo game members power while care network down computer systems three total place end following download h him without per access think north resources current posts big media law control water history pictures size art personal since including guide shop directory board location change white text small rating rate government children during usa return students v shopping account times sites level digital profile previous form events love old john main call hours image department title description non k y insurance another why shall property class cd still money quality every listing content country private little visit save tools low reply customer december compare movies include college value article york man card jobs provide j food source author different press u learn sale around print course job canada process room stock training too credit point join science men categories advanced west sales look english left team estate box conditions select windows photos thread week category note live large gallery table register however june october november market library really action start series model features air industry plan human provided tv yes required second hot accessories cost movie forums march la september better say questions july yahoo going medical test friend come dec server pc study application cart staff articles san feedback again play looking issues april never users complete street topic comment financial things working against standard tax person below mobile less got blog party payment equipment login student let programs offers legal above recent park stores side act problem red give memory performance social q august quote language story sell options experience rates create key body young america important field few east paper single ii age activities club example girls additional password z latest something road gift question changes night ca hard texas oct pay four status browse issue range building seller court february always result audio light write war nov offer blue groups al easy given files event release analysis request fax china making picture needs possible might professional yet month major star areas future space committee hand sun cards problems london washington meeting rss become interest id child keep enter california share similar garden schools million added reference companies listed baby learning energy run delivery net popular term film stories put computers journal reports co try welcome central images president notice god original head radio until cell color self council away includes track australia discussion archive once others entertainment agreement format least society months log safety friends sure faq trade edition cars messages marketing tell further updated association able having provides david fun already green studies close common drive specific several gold feb living sep collection called short arts lot ask display limited powered solutions means director daily beach past natural whether due et electronics five upon period planning database says official weather mar land average done technical window france pro region island record direct microsoft conference environment records st district calendar costs style url front statement update parts aug ever downloads early miles sound resource present applications either ago document word works material bill apr written talk federal hosting rules final tickets thing centre requirements via cheap kids finance true minutes else mark third rock gifts europe reading topics bad individual tips plus auto cover usually edit together videos percent fast function fact unit getting global tech meet far economic en player projects lyrics often subscribe submit germany amount watch included feel though bank risk thanks everything deals various words linux jul production commercial james weight town heart advertising received choose treatment newsletter archives points knowledge magazine error camera jun girl currently construction toys registered clear golf receive domain methods chapter makes protection policies loan wide beauty manager india position taken sort listings models michael known half cases step engineering florida simple quick none wireless license paul friday lake whole annual published later basic sony shows corporate google church method purchase customers active response practice hardware figure materials fire holiday chat enough designed along among death writing speed html countries loss face brand discount higher effects created remember standards oil bit yellow political increase advertise kingdom base near environmental thought stuff french storage oh japan doing loans shoes entry stay nature orders availability africa summary turn mean growth notes agency king monday european activity copy although drug pics western income force cash employment overall bay river commission ad package contents seen players engine port album regional stop supplies started administration bar institute views plans double dog build screen exchange types soon sponsored lines electronic continue across benefits needed season apply someone held ny anything printer condition effective believe organization effect asked eur mind sunday selection pdf lost tour menu volume cross anyone mortgage hope silver corporation wish inside solution role rather weeks addition came supply nothing certain usr executive running lower necessary union jewelry according dc clothing mon com particular fine names robert homepage hour gas skills six bush islands advice career military rental decision leave british pre huge sat woman facilities zip bid kind sellers middle move cable opportunities taking values division coming tuesday object appropriate machine logo length actually nice score statistics client ok returns capital follow sample investment sent shown saturday christmas england culture band flash ms lead george choice went starting registration fri thursday courses consumer hi airport foreign artist outside furniture levels channel letter mode phones ideas wednesday structure fund summer allow degree contract button releases wed homes super male matter custom virginia almost took located multiple asian distribution editor inn industrial cause potential song cnet ltd los hp focus late fall featured idea rooms female responsible inc communications win associated thomas primary cancer numbers reason tool browser spring foundation answer voice eg friendly schedule documents communication purpose feature bed comes police everyone independent ip approach cameras brown physical operating hill maps medicine deal hold ratings chicago forms glass happy tue smith wanted developed thank safe unique survey prior telephone sport ready feed animal sources mexico population pa regular secure navigation operations therefore simply evidence station christian round paypal favorite understand option master valley recently probably thu rentals sea built publications blood cut worldwide improve connection publisher hall larger anti networks earth parents nokia impact transfer introduction kitchen strong tel carolina wedding properties hospital ground overview ship accommodation owners disease tx excellent paid italy perfect hair opportunity kit classic basis command cities william express award distance tree peter assessment ensure thus wall ie involved el extra especially interface partners budget rated guides success maximum ma operation existing quite selected boy amazon patients restaurants beautiful warning locations horse vote forward flowers stars significant lists technologies owner retail animals useful directly manufacturer ways est son providing rule mac housing takes iii gmt bring catalog searches max trying mother authority considered told xml traffic programme joined input strategy feet agent valid bin modern senior ireland teaching door grand testing trial charge units instead canadian cool normal wrote enterprise ships entire educational md leading metal positive fl fitness chinese opinion mb asia football abstract uses output funds mr greater likely develop employees artists alternative processing responsibility resolution java guest seems publication pass relations trust van contains session multi photography republic fees components vacation century academic assistance completed skin graphics indian prev ads mary il expected ring grade pacific mountain organizations pop filter mailing vehicle longer consider int northern behind panel floor german buying match proposed default require iraq boys outdoor deep morning otherwise allows rest protein plant reported hit transportation mm pool mini politics partner disclaimer authors boards faculty parties fish membership mission eye string sense modified pack released stage internal goods recommended born unless richard detailed japanese race approved background target except character usb maintenance ability maybe functions ed moving brands places php pretty trademarks spain southern yourself etc winter battery youth pressure submitted boston debt keywords medium television interested core break purposes throughout sets dance wood msn itself defined papers playing awards fee studio reader virtual device established answers rent las remote dark programming external apple le regarding instructions min offered theory enjoy remove aid surface minimum visual host variety teachers isbn martin manual block subjects agents increased repair fair civil steel understanding songs fixed wrong beginning hands associates finally az updates desktop classes paris ohio gets sector capacity requires jersey un fat fully father electric saw instruments quotes officer driver businesses dead respect unknown specified restaurant mike trip pst worth mi procedures poor teacher eyes relationship workers farm georgia peace traditional campus tom showing creative coast benefit progress funding devices lord grant sub agree fiction hear sometimes watches careers beyond goes families led museum themselves fan transport interesting blogs wife evaluation accepted former implementation ten hits zone complex th cat galleries references die presented jack flat flow agencies literature respective parent spanish michigan columbia setting dr scale stand economy highest helpful monthly critical frame musical definition secretary angeles networking path australian employee chief gives kb bottom magazines packages detail francisco laws changed pet heard begin individuals colorado royal clean switch russian largest african guy titles relevant guidelines justice connect bible dev cup basket applied weekly vol installation described demand pp suite vegas na square chris attention advance skip diet army auction gear lee os difference allowed correct charles nation selling lots piece sheet firm seven older illinois regulations elements species jump cells module resort facility random pricing dvds certificate minister motion looks fashion directions visitors documentation monitor trading forest calls whose coverage couple giving chance vision ball ending clients actions listen discuss accept automotive goal successful sold wind communities clinical situation sciences markets lowest highly publishing appear emergency developing lives currency leather determine temperature palm announcements patient actual historical stone bob commerce ringtones perhaps persons difficult scientific satellite fit tests village accounts ex met pain xbox particularly factors coffee www settings buyer cultural steve easily oral ford poster edge functional root au fi closed holidays ice pink zealand balance monitoring graduate replies shot nc architecture initial label thinking scott llc sec recommend canon league waste minute bus provider optional dictionary cold accounting manufacturing sections chair fishing effort phase fields bag fantasy po letters motor va mum mom dad sister brother grandma grandpa grandmother grandfather aunt uncle cousin daughter husband eat ate drink drank milk juice tea bread butter cheese egg meat chicken rice soup salad pizza pasta banana orange fruit vegetable carrot potato tomato onion sugar salt cake cookie chocolate cream breakfast lunch dinner sandwich burger sweet bedroom bathroom sofa lamp classroom lesson homework pen pencil desk pupil maths bird cow pig sheep rabbit mouse lion tiger elephant monkey bear duck purple grey gray ear nose mouth leg arm foot shirt dress shoe hat coat jacket jeans sock supermarket cinema zoo afternoon evening tomorrow yesterday weekend autumn o'clock swim walk sleep cook speak sing ride draw sit tall sad funny favourite slow hello goodbye bye sorry okay zero eight nine eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred".split(" "));
const NEGATIONS = ["not", "no", "never", "don't", "doesn't", "didn't", "isn't", "aren't", "can't", "cannot"];
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
// Слова, которые после «I am» или «my name is» означают не имя: артикль, место, состояние, возраст, профессия.
const NOT_A_NAME = new Set([
  "a", "an", "the", "from", "in", "at", "on", "here", "there", "home", "not", "very", "so", "really", "fine", "ok", "okay",
  "good", "well", "great", "happy", "sad", "tired", "hungry", "thirsty", "busy", "ready", "sorry", "glad", "late", "sick",
  "cold", "hot", "old", "young", "years", "year", "student", "teacher", "doctor", "thank", "thanks", "you", "and", "is", "am",
  "my", "your", "his", "her", "our", "their", "its", "to", "with", "for", "about",
  ...ONES, ...TENS.filter(Boolean), "hundred",
]);
// Имена и фамилии, которые сами стоят в частотном списке: в составе имени они не считаются обычными словами.
const NAME_WORDS = new Set(["john", "james", "david", "michael", "paul", "robert", "richard", "thomas", "william", "george",
  "peter", "mary", "martin", "mike", "tom", "jack", "charles", "chris", "steve", "scott", "bob", "lee", "smith", "max", "mark",
  "bill", "will", "son", "song", "park", "brown", "asia", "said"]);

// Лексика A1, которой нет в веб-частотном списке: профессии, прилагательные, национальности, люди, глаголы
// и слова фраз курса. Без неё «I am Kazakh schoolboy» и «I am sporty kid» выглядели как имя. Слова фраз курса
// сверяет с каталогами pwa/test_learning_update.mjs. Имён здесь нет: имя не должно совпасть с обычным словом.
const A1_LEXICON = new Set(`
teacher doctor nurse driver engineer student pupil farmer cook chef waiter waitress pilot policeman policewoman officer
firefighter fireman dentist vet artist singer dancer actor actress writer lawyer manager programmer developer builder
mechanic cashier assistant secretary accountant scientist footballer player athlete sportsman sportswoman businessman
businesswoman journalist photographer musician painter designer hairdresser baker postman soldier sailor worker housewife
cleaner guard shopkeeper seller librarian receptionist tourist boss director translator interpreter coach trainer
angry sporty happy sad tired hungry thirsty bored boring busy lazy clever smart kind friendly shy funny tall short fat thin
slim strong weak beautiful pretty handsome ugly young old new nice good bad great cool cute quiet loud noisy brave polite
rude honest careful hardworking lucky sick ill fine well excited scared afraid nervous worried surprised sleepy hot cold
warm rich poor famous married single little big small long fast slow early late ready free sorry glad sure right wrong
clean dirty easy difficult hard interesting favourite favorite best better healthy sweet lovely wonderful amazing awesome
terrible perfect open dark bright alone fine ok okay
kazakh russian english american british chinese japanese korean german french italian spanish turkish uzbek kyrgyz
ukrainian indian arab arabic canadian australian mexican brazilian polish european asian african
kid kids boy girl child children teenager teen baby man woman men women person people friend classmate schoolboy
schoolgirl brother sister son daughter mother father mum mom dad parent grandmother grandfather grandma grandpa aunt uncle
cousin wife husband neighbour neighbor guest fan beginner learner colleague
play like speak learn go want have love live work study read write watch eat drink sleep swim run walk sing dance draw
cook help know think see look listen hear say tell ask answer come get give take make do buy sell open close start finish
stop wait sit stand ride drive fly travel visit meet call use try need feel wear wash wake miss spell repeat understand
remember forget
broccoli colour excuse meeting straight train also all right here there
`.split(/\s+/).filter(Boolean));

/// Слово и его основы без окончаний -s, -es, -ed, -ing. Основа короче трёх букв не считается:
/// иначе «Ted» давал бы «t», а в веб-списке есть однобуквенный мусор.
function wordForms(word) {
  const base = word.replace(/'s$/, "");
  const stems = [base.replace(/ies$/, "y"), base.replace(/es$/, ""), base.replace(/s$/, ""), base.replace(/ed$/, ""),
    base.replace(/d$/, ""), base.replace(/ing$/, ""), base.replace(/ing$/, "e"), base.replace(/([a-z])\1ing$/, "$1")];
  return [base, ...stems.filter((stem) => stem !== base && stem.length >= 3)];
}

/// Слово из частотного списка, в том числе с окончанием («playing», «swimming», «likes»).
function commonEnglishWord(word) {
  return wordForms(word).some((form) => COMMON_EN_WORDS.has(form));
}

/// Слово из лексики A1, в том числе с окончанием («schoolboys», «waiting»).
function a1LexiconWord(word) {
  return wordForms(word).some((form) => A1_LEXICON.has(form));
}

/// Обычное английское слово для проверки имени: частотный список или лексика A1.
export function ordinaryEnglishWord(word) {
  return commonEnglishWord(word) || a1LexiconWord(word);
}

/// Хвост после «I am» или «my name is» похож на имя. Решение пользователя 27.09 (мягкое правило): распознаватель
/// разбивает казахское имя на английские слова («Yerkebulan» → «here Kim Mulan»), поэтому имя из двух-трёх слов
/// засчитывается, если в нём есть хотя бы одно слово вне словаря или оно целиком из списка имён (John Smith).
/// «I am nice girl», «I am play football», «I am Kazakh schoolboy» целиком из обычных слов и не засчитываются.
/// Ответ не может начинаться со слова из стоп-списка («I am a student», «I am fine»), кроме here и there,
/// с которых распознаватель начинает искажённое имя. Одно слово: стоп-список, лексика A1 («I am boy»)
/// и форма на -ing от частого глагола («I am learning»), но не «Irving».
/// Остаток риска принят пользователем: «I am Almaty resident» засчитывается (goal.md, четвёртый круг).
function looksLikeName(tail) {
  const parts = tail.split(" ");
  const [first] = parts;
  if (NOT_A_NAME.has(first) && first !== "here" && first !== "there") return false;
  if (parts.length === 1) {
    if (NAME_WORDS.has(first)) return true;
    return !a1LexiconWord(first) && !(first.length > 4 && first.endsWith("ing") && commonEnglishWord(first));
  }
  return parts.some((word) => !ordinaryEnglishWord(word)) || parts.every((word) => NAME_WORDS.has(word));
}

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
    // Имя может состоять из двух-трёх слов («My name is Aigerim Nurlanovna»), но «I am a student»,
    // «I am from Almaty» и «I am fine» это не представление: такие слова именем не считаются.
    const match = joined.match(/^(?:hello |hi )?(my name is|i am) ([a-z][a-z'-]*(?: [a-z][a-z'-]*){0,2})$/);
    correct = Boolean(match) && looksLikeName(match[2]);
  } else if (intent === "day-answer" && rule.anyDay) {
    // «Ответь, назвав день»: верен любой один день недели, а не день из образца.
    correct = new RegExp(`^(today is |it is )?(${DAYS.join("|")})$`).test(joined);
  } else if (intent === "day-answer") {
    const expectedDays = expectedVariants.flat().filter((token) => DAYS.includes(token));
    const heardDays = heardWords.filter((token) => DAYS.includes(token));
    correct = expectedDays.length > 0 && heardDays.length > 0 &&
      heardDays.every((day) => expectedDays.includes(day)) && expectedDays.some((day) => heardDays.includes(day));
  } else if (intent === "accept-meeting") {
    correct = hasAny(joined, ["yes", "sure", "of course", "okay", "ok", "sounds good", "let us meet tomorrow"]);
  } else if (intent === "free-response") {
    return {outcome:"not_verified", source:"self", score:null, heard:String(heard || "").trim(), claim:"Свободный ответ сохранён для самопроверки или проверки преподавателем."};
  }

  // Дословное совпадение с образцом или вариантом верно само по себе. Защита отрицания и чисел нужна нестрогим
  // совпадениям (шаблон со слотом, представление), иначе вариант «one two three» проигрывал «123» из образца.
  if (!expectedJoined.includes(joined)) {
    const expectedNegative = expectedVariants.some((variant) => variant.some((token) => NEGATIONS.includes(token)));
    const heardNegative = heardWords.some((token) => NEGATIONS.includes(token));
    if (expectedNegative !== heardNegative) correct = false;
    const expectedNumbers = expectedVariants.flat().filter((token) => /^\d+$/.test(token));
    if (expectedNumbers.length && !expectedNumbers.some((token) => heardWords.includes(token))) correct = false;
    const expectedTimes = expectedVariants.flat().filter((token) => /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/.test(token));
    if (rule.protectTime && expectedTimes.length && !expectedTimes.some((token) => heardWords.includes(token))) correct = false;
  }

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
