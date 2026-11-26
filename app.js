/* =========================================================
 * 快乐学英语 · 应用逻辑
 * 模块：背单词 / 测验 / 听力 / 口语 / 统计
 * 数据来源：新概念英语一册 + 剑桥 Power Up（见 data.js）
 * ========================================================= */

"use strict";

/* ---------------- 存储 ---------------- */
const STORE_KEY = "happy_english_v1";

const DEFAULT_STATE = {
  progress: {},            // word -> { level, nextReview, correct, wrong, mastered }
  daily: {},               // "YYYY-MM-DD" -> { reviews, quizCorrect, quizTotal, listenCorrect, listenTotal }
  quiz: { correct: 0, total: 0 },
  listen: { correct: 0, total: 0 },
  settings: { dailyGoal: 20, accent: 1 },
  wordbook: [],            // 生词本（收藏"还不熟"的单词）
  achievements: []         // 已解锁的成就 id
};

let state = loadState();

function normalizeState(obj) {
  const base = structuredClone(DEFAULT_STATE);
  const o = obj || {};
  return {
    ...base,
    ...o,
    progress: o.progress || {},
    daily: o.daily || {},
    quiz: o.quiz || { correct: 0, total: 0 },
    listen: o.listen || { correct: 0, total: 0 },
    settings: { ...base.settings, ...(o.settings || {}) },
    wordbook: Array.isArray(o.wordbook) ? o.wordbook : [],
    achievements: Array.isArray(o.achievements) ? o.achievements : []
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return normalizeState(raw ? JSON.parse(raw) : null);
  } catch (e) {
    return normalizeState(null);
  }
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  scheduleCloudSave();
}

/* ---------------- 云端账号（Supabase） ---------------- */
let supabase = null;
let currentUser = null;
let cloudConfigured = false;
let cloudSaveTimer = null;

const SUPABASE_CDN = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://unpkg.com/@supabase/supabase-js@2"
];

function loadSupabaseSDK() {
  return new Promise((resolve, reject) => {
    if (window.supabase) { resolve(window.supabase); return; }
    let i = 0;
    const tryNext = () => {
      if (i >= SUPABASE_CDN.length) { reject(new Error("SDK load failed")); return; }
      const s = document.createElement("script");
      s.src = SUPABASE_CDN[i++];
      s.onload = () => resolve(window.supabase);
      s.onerror = tryNext;
      document.head.appendChild(s);
    };
    tryNext();
  });
}

async function initSupabase() {
  if (!(typeof SUPABASE_URL === "string" && SUPABASE_URL && typeof SUPABASE_ANON_KEY === "string" && SUPABASE_ANON_KEY)) {
    supabase = null;
    cloudConfigured = false;
    return;
  }
  try {
    const sb = await loadSupabaseSDK();
    supabase = sb.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    cloudConfigured = true;
  } catch (e) {
    supabase = null;
    cloudConfigured = false;
  }
}

function scheduleCloudSave() {
  if (!cloudConfigured || !currentUser) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(saveToCloud, 800);
}

async function saveToCloud() {
  if (!supabase || !currentUser) return;
  try {
    await supabase.from("profiles").upsert({
      id: currentUser.id,
      email: currentUser.email,
      data: state,
      updated_at: new Date().toISOString()
    });
  } catch (e) {}
}

async function loadFromCloud() {
  const { data, error } = await supabase.from("profiles").select("data").eq("id", currentUser.id).maybeSingle();
  if (error) throw error;
  if (data && data.data && typeof data.data === "object") {
    state = normalizeState(data.data);
  } else {
    await supabase.from("profiles").insert({ id: currentUser.id, email: currentUser.email, data: structuredClone(DEFAULT_STATE) });
    state = normalizeState(null);
  }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
}

/* ---------------- 工具 ---------------- */
function todayKey(d) {
  const dt = d || new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const DAY_MS = 86400000;
// 记忆间隔（艾宾浩斯简化）：level 1~5 对应 1/3/7/14/30 天
const INTERVALS = [null, DAY_MS, DAY_MS * 3, DAY_MS * 7, DAY_MS * 14, DAY_MS * 30];

function sourceLabel(src) {
  return src === "nce" ? "📘 新概念" : "🎒 Power Up";
}

/* ---------------- 发音（自然音频 + TTS 兜底） ---------------- */
let voices = [];
function loadVoices() {
  if ("speechSynthesis" in window) {
    voices = window.speechSynthesis.getVoices() || [];
  }
}
if ("speechSynthesis" in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

/* 选择相对自然的系统语音（离线兜底用） */
function pickEnglishVoice() {
  const prefs = ["natural", "neural", "online", "premium", "enhanced", "google", "samantha", "aria", "jenny", "guy", "ava", "emma", "zira"];
  const en = voices.filter((v) => v.lang && v.lang.toLowerCase().replace("_", "-").startsWith("en"));
  for (const p of prefs) {
    const m = en.find((v) => v.name.toLowerCase().includes(p));
    if (m) return m;
  }
  return en[0] || null;
}

function speak(text, rate) {
  if (!("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickEnglishVoice();
    if (v) u.voice = v;
    u.lang = v ? v.lang : "en-US";
    u.rate = rate || 0.95;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch (e) {}
}

/* 有道词典真人发音：type 1 = 英音，2 = 美音 */
function naturalAudioUrl(text, accent) {
  return "https://dict.youdao.com/dictvoice?audio=" + encodeURIComponent(text) + "&type=" + (accent === 2 ? 2 : 1);
}

let activeAudio = null;
function stopAudio() {
  if (activeAudio) { try { activeAudio.pause(); } catch (e) {} activeAudio = null; }
  if ("speechSynthesis" in window) { try { window.speechSynthesis.cancel(); } catch (e) {} }
}

/* 优先播放真人自然发音，加载失败则回退到系统语音 */
function playAudio(text, opts) {
  opts = opts || {};
  stopAudio();
  const a = new Audio(naturalAudioUrl(text, state.settings.accent));
  a.playbackRate = opts.slow ? 0.72 : 1;
  activeAudio = a;
  a.onerror = function () { activeAudio = null; speak(text, opts.rate); };
  a.play().catch(function () { activeAudio = null; speak(text, opts.rate); });
}

/* ---------------- DOM 引用 ---------------- */
const $ = (id) => document.getElementById(id);

/* ---------------- 页面切换 ---------------- */
const pages = {
  learn: $("page-learn"),
  quiz: $("page-quiz"),
  listen: $("page-listen"),
  speak: $("page-speak"),
  stats: $("page-stats")
};

function switchPage(name) {
  Object.keys(pages).forEach((k) => {
    pages[k].classList.toggle("active", k === name);
  });
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.page === name);
  });
  window.scrollTo({ top: 0 });
  if (name === "stats") renderStats();
  if (name === "learn") renderLearn();
  if (name === "speak") renderSentences();
}

document.querySelector(".tab-bar").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (btn) switchPage(btn.dataset.page);
});

/* =========================================================
 * 学习进度统计
 * ========================================================= */
function recordStudy() {
  const key = todayKey();
  if (!state.daily[key]) state.daily[key] = { reviews: 0, quizCorrect: 0, quizTotal: 0, listenCorrect: 0, listenTotal: 0 };
  state.daily[key].reviews += 1;
  saveState();
  updateStreakBadge();
}

function computeStreak() {
  let streak = 0;
  const d = new Date();
  if (!state.daily[todayKey(d)]) d.setDate(d.getDate() - 1);
  while (state.daily[todayKey(d)]) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function updateStreakBadge() {
  $("streak-badge").textContent = `🔥 ${computeStreak()} 天`;
}

/* 口音切换（英音 / 美音） */
function accentLabel() {
  return state.settings.accent === 2 ? "🇺🇸 美音" : "🇬🇧 英音";
}
function updateAccentToggle() {
  const el = $("accent-toggle");
  if (el) el.textContent = accentLabel();
}
$("accent-toggle").addEventListener("click", () => {
  state.settings.accent = state.settings.accent === 2 ? 1 : 2;
  saveState();
  updateAccentToggle();
});

function masteredCount() {
  return Object.values(state.progress).filter((p) => p.mastered).length;
}

function totalReviews() {
  return Object.values(state.daily).reduce((s, d) => s + (d.reviews || 0), 0);
}

/* =========================================================
 * 学习页（单词卡）
 * ========================================================= */
let currentSource = "all";
let session = [];
let sessionIndex = 0;
let audioUnlocked = false;

function filteredWords() {
  if (currentSource === "all") return WORDS;
  return WORDS.filter((w) => w.source.includes(currentSource));
}

function getDueWords() {
  const now = Date.now();
  return filteredWords().filter((w) => {
    const p = state.progress[w.word];
    if (!p) return true;
    return (p.nextReview || 0) <= now;
  });
}

function buildSession() {
  session = shuffle(getDueWords());
  sessionIndex = 0;
}

function renderTags(word) {
  let html = "";
  if (word.source.includes("nce")) html += `<span class="card-tag">${sourceLabel("nce")}</span>`;
  if (word.source.includes("pu")) html += `<span class="card-tag pu">${sourceLabel("pu")}</span>`;
  html += `<span class="card-tag">${word.category}</span>`;
  return html;
}

function renderLearn() {
  renderGoal();
  if (session.length === 0) buildSession();
  if (session.length === 0 || sessionIndex >= session.length) {
    showLearnDone();
    return;
  }
  renderCard(session[sessionIndex]);
}

function renderGoal() {
  const goal = state.settings.dailyGoal;
  const done = (state.daily[todayKey()] || {}).reviews || 0;
  const pct = Math.min(100, Math.round((done / goal) * 100));
  $("goal-progress").style.width = pct + "%";
  $("goal-label").textContent = `${done} / ${goal}`;
}

function renderCard(word) {
  const card = $("flashcard");
  card.classList.remove("flipped");
  $("card-tags").innerHTML = renderTags(word);
  $("card-word").textContent = word.word;
  $("card-phonetic").textContent = word.phonetic;
  $("card-meaning").textContent = word.meaning;
  $("card-example").textContent = word.example;
  $("card-example-cn").textContent = word.exampleCn;
  $("card-actions").hidden = true;
  $("learn-hint").hidden = false;
  $("session-progress").textContent = `本轮 ${sessionIndex + 1} / ${session.length}`;
  if (audioUnlocked) playAudio(word.word);
}

function showLearnDone() {
  const card = $("flashcard");
  card.classList.remove("flipped");
  $("card-tags").innerHTML = "";
  $("card-word").textContent = "太棒啦！🎉";
  $("card-phonetic").textContent = "";
  $("card-meaning").textContent = "今天的单词都学完啦";
  $("card-example").textContent = "明天再来复习一下吧";
  $("card-example-cn").textContent = "";
  $("card-actions").hidden = true;
  $("learn-hint").hidden = true;
  $("session-progress").textContent = "本轮完成";
  $("goal-progress").style.width = "100%";
}

function answerCard(known) {
  const word = session[sessionIndex];
  const p = state.progress[word.word] || { level: 0, correct: 0, wrong: 0, mastered: false };
  if (known) {
    p.level = Math.min(5, p.level + 1);
    p.nextReview = Date.now() + INTERVALS[p.level];
    p.correct += 1;
    p.mastered = p.level >= 5;
  } else {
    p.level = Math.max(0, p.level - 1);
    p.nextReview = Date.now() + 10 * 60 * 1000; // 10 分钟后再来
    p.wrong += 1;
    p.mastered = false;
  }
  state.progress[word.word] = p;
  recordStudy();
  sessionIndex++;
  if (sessionIndex >= session.length) {
    showLearnDone();
  } else {
    renderCard(session[sessionIndex]);
  }
}

/* 学习页事件 */
$("flashcard").addEventListener("click", (e) => {
  audioUnlocked = true;
  if (session.length === 0 || sessionIndex >= session.length) return;
  const card = $("flashcard");
  card.classList.toggle("flipped");
  $("card-actions").hidden = !card.classList.contains("flipped");
  $("learn-hint").hidden = card.classList.contains("flipped");
  if (card.classList.contains("flipped")) playAudio(session[sessionIndex].example);
});

$("btn-known").addEventListener("click", () => answerCard(true));
$("btn-unknown").addEventListener("click", () => answerCard(false));

$("btn-speak-card").addEventListener("click", (e) => {
  e.stopPropagation();
  audioUnlocked = true;
  if (session.length && sessionIndex < session.length) playAudio(session[sessionIndex].word);
});

$("btn-speak-card2").addEventListener("click", (e) => {
  e.stopPropagation();
  if (session.length && sessionIndex < session.length) playAudio(session[sessionIndex].word);
});

$("source-filter").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  currentSource = chip.dataset.source;
  document.querySelectorAll("#source-filter .chip").forEach((c) => c.classList.toggle("active", c === chip));
  buildSession();
  renderLearn();
});

$("goal-label").addEventListener("click", () => {
  const v = prompt("设置每天要学习的单词数量：", state.settings.dailyGoal);
  if (v && !isNaN(v) && Number(v) > 0) {
    state.settings.dailyGoal = Math.min(200, Math.floor(Number(v)));
    saveState();
    renderGoal();
  }
});

/* =========================================================
 * 测验页
 * ========================================================= */
let quizMode = "choice";
let quiz = { questions: [], index: 0, score: 0, lock: false };

function sampleOther(word, key, n) {
  return shuffle(WORDS.filter((x) => x !== word && x[key] !== word[key]))
    .slice(0, n)
    .map((x) => x[key]);
}

function makeChoiceQuestions(count) {
  const pool = shuffle(WORDS).slice(0, count);
  return pool.map((w) => {
    const en2cn = Math.random() < 0.5;
    let prompt, options, correctText;
    if (en2cn) {
      prompt = { type: "word", text: w.word };
      correctText = w.meaning;
      const distractors = sampleOther(w, "meaning", 3);
      options = shuffle([{ text: w.meaning, correct: true }, ...distractors.map((m) => ({ text: m, correct: false }))]);
    } else {
      prompt = { type: "meaning", text: w.meaning };
      correctText = w.word;
      const distractors = sampleOther(w, "word", 3);
      options = shuffle([{ text: w.word, correct: true }, ...distractors.map((m) => ({ text: m, correct: false }))]);
    }
    return { type: "choice", word: w, prompt, options, correctText };
  });
}

function makeSpellQuestions(count) {
  const pool = shuffle(WORDS.filter((w) => /^[a-zA-Z]+$/.test(w.word))).slice(0, count);
  return pool.map((w) => ({
    type: "spell",
    word: w,
    prompt: { type: "meaning", text: w.meaning },
    correctText: w.word,
    hint: w.word[0]
  }));
}

function startQuiz() {
  const count = Math.min(10, WORDS.length);
  quiz.questions = quizMode === "choice" ? makeChoiceQuestions(count) : makeSpellQuestions(count);
  quiz.index = 0;
  quiz.score = 0;
  quiz.lock = false;
  $("quiz-setup").hidden = true;
  $("quiz-result").hidden = true;
  $("quiz-area").hidden = false;
  renderQuizQuestion();
}

function renderQuizQuestion() {
  const q = quiz.questions[quiz.index];
  quiz.lock = false;
  $("quiz-progress").textContent = `第 ${quiz.index + 1} / ${quiz.questions.length} 题`;
  $("quiz-score").textContent = `⭐ ${quiz.score}`;
  const promptEl = $("quiz-prompt");
  $("quiz-options").innerHTML = "";
  const fb = $("quiz-area").querySelector(".feedback");
  if (fb) fb.remove();

  if (q.type === "choice") {
    promptEl.innerHTML = q.prompt.type === "word"
      ? `这个单词是什么意思？<span class="big-word">${q.prompt.text}</span>`
      : `选出正确的英文单词：<span class="big-word">${q.prompt.text}</span>`;
    $("quiz-spell-box").hidden = true;
    $("quiz-options").hidden = false;
    q.options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.className = "quiz-option";
      btn.textContent = opt.text;
      btn.addEventListener("click", () => answerQuiz(btn, opt.correct));
      $("quiz-options").appendChild(btn);
    });
  } else {
    promptEl.innerHTML = `请拼出这个单词：<span class="big-word">${q.prompt.text}</span><div class="hint-line">提示：以 <b>${q.hint.toUpperCase()}</b> 开头</div>`;
    $("quiz-options").hidden = true;
    $("quiz-spell-box").hidden = false;
    const input = $("spell-input");
    input.value = "";
    input.focus();
  }
}

function showFeedback(good, msg) {
  const area = $("quiz-area");
  const old = area.querySelector(".feedback");
  if (old) old.remove();
  const div = document.createElement("div");
  div.className = "feedback " + (good ? "good" : "bad");
  div.textContent = msg;
  area.appendChild(div);
}

function answerQuiz(btn, correct) {
  if (quiz.lock) return;
  quiz.lock = true;
  const q = quiz.questions[quiz.index];
  document.querySelectorAll(".quiz-option").forEach((b) => {
    b.disabled = true;
    if (b.textContent === q.correctText) b.classList.add("correct");
    if (b === btn && !correct) b.classList.add("wrong");
  });
  state.quiz.total += 1;
  if (correct) {
    quiz.score += 1;
    state.quiz.correct += 1;
    showFeedback(true, pickPraise());
  } else {
    showFeedback(false, `答案是：${q.correctText}`);
  }
  saveState();
  setTimeout(nextQuiz, correct ? 1000 : 1800);
}

function checkSpell() {
  if (quiz.lock) return;
  const q = quiz.questions[quiz.index];
  const val = $("spell-input").value.trim().toLowerCase();
  if (!val) return;
  quiz.lock = true;
  const correct = val === q.correctText.toLowerCase();
  state.quiz.total += 1;
  if (correct) {
    quiz.score += 1;
    state.quiz.correct += 1;
    showFeedback(true, pickPraise());
  } else {
    showFeedback(false, `正确答案是：${q.correctText}`);
  }
  saveState();
  setTimeout(nextQuiz, correct ? 1000 : 1800);
}

function nextQuiz() {
  quiz.index++;
  if (quiz.index >= quiz.questions.length) {
    finishQuiz();
  } else {
    renderQuizQuestion();
  }
}

function finishQuiz() {
  $("quiz-area").hidden = true;
  $("quiz-result").hidden = false;
  const total = quiz.questions.length;
  const sc = quiz.score;
  const pct = sc / total;
  let emoji, stars;
  if (pct >= 0.9) { emoji = "🏆"; stars = "⭐⭐⭐"; }
  else if (pct >= 0.7) { emoji = "🎉"; stars = "⭐⭐"; }
  else if (pct >= 0.5) { emoji = "💪"; stars = "⭐"; }
  else { emoji = "🌱"; stars = ""; }
  $("quiz-result-emoji").textContent = emoji;
  $("quiz-result-text").innerHTML = `答对 <b>${sc}</b> / ${total} 题<span class="stars">${stars}</span>`;
  $("quiz-score").textContent = `⭐ ${quiz.score}`;
}

function pickPraise() {
  const arr = ["太棒了！👍", "真厉害！⭐", "好样的！🎉", "继续加油！💪", "你真聪明！🌟"];
  return arr[Math.floor(Math.random() * arr.length)];
}

$("btn-start-quiz").addEventListener("click", startQuiz);
$("btn-quiz-again").addEventListener("click", startQuiz);
$("btn-spell-check").addEventListener("click", checkSpell);
$("spell-input").addEventListener("keydown", (e) => { if (e.key === "Enter") checkSpell(); });

document.querySelector("#page-quiz .mode-select").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  quizMode = chip.dataset.mode;
  document.querySelectorAll("#page-quiz .mode-select .chip").forEach((c) => c.classList.toggle("active", c === chip));
});

/* =========================================================
 * 听力页
 * ========================================================= */
let listen = { questions: [], index: 0, score: 0, lock: false, slow: false };

function makeListenQuestions(count) {
  const pool = shuffle(WORDS.filter((w) => /^[a-zA-Z]{3,}$/.test(w.word))).slice(0, count);
  return pool.map((w) => {
    const distractors = sampleOther(w, "word", 3);
    return {
      word: w,
      correctText: w.word,
      options: shuffle([{ text: w.word, correct: true }, ...distractors.map((t) => ({ text: t, correct: false }))])
    };
  });
}

function startListen() {
  listen.questions = makeListenQuestions(10);
  listen.index = 0;
  listen.score = 0;
  listen.lock = false;
  listen.slow = false;
  $("listen-setup").hidden = true;
  $("listen-result").hidden = true;
  $("listen-area").hidden = false;
  renderListenQuestion();
}

function renderListenQuestion() {
  const q = listen.questions[listen.index];
  listen.lock = false;
  $("listen-progress").textContent = `第 ${listen.index + 1} / ${listen.questions.length} 题`;
  $("listen-score").textContent = `⭐ ${listen.score}`;
  $("listen-options").innerHTML = "";
  const fb = $("listen-area").querySelector(".feedback");
  if (fb) fb.remove();
  q.options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.className = "quiz-option";
    btn.textContent = opt.text;
    btn.addEventListener("click", () => answerListen(btn, opt.correct));
    $("listen-options").appendChild(btn);
  });
  playListen();
}

function playListen() {
  const q = listen.questions[listen.index];
  playAudio(q.word.word, { slow: listen.slow, rate: 0.85 });
}

function answerListen(btn, correct) {
  if (listen.lock) return;
  listen.lock = true;
  const q = listen.questions[listen.index];
  document.querySelectorAll("#listen-options .quiz-option").forEach((b) => {
    b.disabled = true;
    if (b.textContent === q.correctText) b.classList.add("correct");
    if (b === btn && !correct) b.classList.add("wrong");
  });
  state.listen.total += 1;
  if (correct) {
    listen.score += 1;
    state.listen.correct += 1;
    showListenFeedback(true, pickPraise());
  } else {
    showListenFeedback(false, `正确答案是：${q.correctText}`);
  }
  saveState();
  setTimeout(nextListen, correct ? 1000 : 1800);
}

function showListenFeedback(good, msg) {
  const area = $("listen-area");
  const old = area.querySelector(".feedback");
  if (old) old.remove();
  const div = document.createElement("div");
  div.className = "feedback " + (good ? "good" : "bad");
  div.textContent = msg;
  area.appendChild(div);
}

function nextListen() {
  listen.index++;
  if (listen.index >= listen.questions.length) finishListen();
  else renderListenQuestion();
}

function finishListen() {
  $("listen-area").hidden = true;
  $("listen-result").hidden = false;
  const total = listen.questions.length;
  const sc = listen.score;
  const pct = sc / total;
  let emoji, stars;
  if (pct >= 0.9) { emoji = "🏆"; stars = "⭐⭐⭐"; }
  else if (pct >= 0.7) { emoji = "🎉"; stars = "⭐⭐"; }
  else if (pct >= 0.5) { emoji = "💪"; stars = "⭐"; }
  else { emoji = "🌱"; stars = ""; }
  $("listen-result-emoji").textContent = emoji;
  $("listen-result-text").innerHTML = `答对 <b>${sc}</b> / ${total} 题<span class="stars">${stars}</span>`;
}

$("btn-start-listen").addEventListener("click", startListen);
$("btn-listen-again").addEventListener("click", startListen);
$("btn-play-audio").addEventListener("click", () => { listen.slow = false; playListen(); });
$("btn-play-slow").addEventListener("click", () => { listen.slow = true; playListen(); });

/* =========================================================
 * 口语页
 * ========================================================= */
let sentenceCat = "all";

function renderSentences() {
  const list = $("sentence-list");
  list.innerHTML = "";
  const items = sentenceCat === "all" ? SENTENCES : SENTENCES.filter((s) => s.category === sentenceCat);
  items.forEach((s) => {
    const card = document.createElement("div");
    card.className = "sentence-card";
    card.innerHTML = `
      <button class="sentence-play" aria-label="播放">🔊</button>
      <div class="sentence-body">
        <div class="sentence-text">${s.text}</div>
        <div class="sentence-trans">${s.translation}</div>
      </div>
      <span class="sentence-cat">${s.category}</span>`;
    card.addEventListener("click", () => playAudio(s.text, { rate: 0.9 }));
    list.appendChild(card);
  });
}

$("sentence-tabs").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  sentenceCat = chip.dataset.cat;
  document.querySelectorAll("#sentence-tabs .chip").forEach((c) => c.classList.toggle("active", c === chip));
  renderSentences();
});

/* =========================================================
 * 统计页
 * ========================================================= */
function accuracy(correct, total) {
  if (!total) return null;
  return Math.round((correct / total) * 100);
}

function renderStats() {
  $("st-streak").textContent = computeStreak();
  $("st-mastered").textContent = masteredCount();
  $("st-today").textContent = (state.daily[todayKey()] || {}).reviews || 0;
  $("st-total").textContent = totalReviews();

  const qAcc = accuracy(state.quiz.correct, state.quiz.total);
  $("rate-quiz").style.width = (qAcc == null ? 0 : qAcc) + "%";
  $("rate-quiz-text").textContent = qAcc == null ? "-" : qAcc + "%";

  const lAcc = accuracy(state.listen.correct, state.listen.total);
  $("rate-listen").style.width = (lAcc == null ? 0 : lAcc) + "%";
  $("rate-listen-text").textContent = lAcc == null ? "-" : lAcc + "%";

  renderWeekChart();
}

function renderWeekChart() {
  const chart = $("week-chart");
  chart.innerHTML = "";
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  const values = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    values.push({ day: days[d.getDay()], count: (state.daily[todayKey(d)] || {}).reviews || 0 });
  }
  const max = Math.max(1, ...values.map((v) => v.count));
  values.forEach((v) => {
    const col = document.createElement("div");
    col.className = "week-col";
    const h = Math.max(4, Math.round((v.count / max) * 90));
    col.innerHTML = `
      <div class="week-bar-wrap"><div class="week-bar" style="height:${h}px" title="${v.count} 个单词"></div></div>
      <div class="week-day">${v.day}</div>`;
    chart.appendChild(col);
  });
}

$("btn-reset").addEventListener("click", () => {
  if (confirm("确定要清空所有学习记录吗？此操作无法恢复。")) {
    state = normalizeState(null);
    saveState();
    updateStreakBadge();
    renderStats();
    buildSession();
    renderLearn();
  }
});

/* =========================================================
 * 登录 / 注册 与 初始化
 * ========================================================= */
let authMode = "login"; // "login" | "signup"

function setAuthMode(mode) {
  authMode = mode;
  $("tab-login").classList.toggle("active", mode === "login");
  $("tab-signup").classList.toggle("active", mode === "signup");
  $("auth-nickname").hidden = mode !== "signup";
  $("btn-auth-submit").textContent = mode === "login" ? "登录" : "注册";
  $("auth-hint").textContent = mode === "login" ? "还没有账号？点上面「注册」创建一个" : "已有账号？点上面「登录」";
}

function showAuthScreen() {
  $("auth-screen").hidden = false;
  $("auth-error").textContent = "";
  setAuthMode("login");
}
function hideAuthScreen() {
  $("auth-screen").hidden = true;
}

function updateUserBadge() {
  const badge = $("btn-logout");
  if (currentUser) {
    const nick = (currentUser.user_metadata && currentUser.user_metadata.nickname) || currentUser.email;
    badge.textContent = "👤 " + nick + " · 退出";
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function friendlyAuthError(err) {
  const m = (err && (err.message || err.error_description || err.msg)) || "操作失败，请重试";
  if (/Invalid login credentials/i.test(m)) return "邮箱或密码错误";
  if (/already registered/i.test(m)) return "该邮箱已注册，请直接登录";
  if (/Email not confirmed/i.test(m)) return "邮箱还没确认，请先点邮件里的链接";
  if (/at least 6/i.test(m) || /weak password/i.test(m)) return "密码太简单，请至少 6 位";
  if (/email/i.test(m)) return "邮箱格式不对";
  return m;
}

async function handleAuth() {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const nickname = $("auth-nickname").value.trim();
  $("auth-error").textContent = "";
  if (!email || !password) { $("auth-error").textContent = "请填写邮箱和密码"; return; }
  if (authMode === "signup" && password.length < 6) { $("auth-error").textContent = "密码至少 6 位"; return; }
  const btn = $("btn-auth-submit");
  btn.disabled = true;
  btn.textContent = "请稍候…";
  try {
    let res;
    if (authMode === "signup") {
      res = await supabase.auth.signUp({ email, password, options: { data: { nickname: nickname || email.split("@")[0] } } });
      if (res.error) throw res.error;
      if (res.data && res.data.user && !res.data.session) {
        $("auth-error").textContent = "✅ 注册成功！请到邮箱点击确认链接，然后回来点「登录」。";
        btn.disabled = false;
        setAuthMode("login");
        return;
      }
    } else {
      res = await supabase.auth.signInWithPassword({ email, password });
      if (res.error) throw res.error;
    }
    if (res.data && res.data.user) {
      await onAuthSuccess(res.data.user);
    }
  } catch (err) {
    $("auth-error").textContent = friendlyAuthError(err);
    btn.disabled = false;
    btn.textContent = authMode === "login" ? "登录" : "注册";
  }
}

async function onAuthSuccess(user) {
  currentUser = user;
  try {
    await loadFromCloud();
  } catch (e) {
    /* 云端数据读取失败时沿用本地数据 */
  }
  hideAuthScreen();
  updateUserBadge();
  refreshAll();
}

async function handleLogout() {
  if (supabase) { try { await supabase.auth.signOut(); } catch (e) {} }
  currentUser = null;
  state = normalizeState(null);
  try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  buildSession();
  refreshAll();
  showAuthScreen();
}

function refreshAll() {
  updateStreakBadge();
  updateAccentToggle();
  renderLearn();
  renderSentences();
}

$("tab-login").addEventListener("click", () => setAuthMode("login"));
$("tab-signup").addEventListener("click", () => setAuthMode("signup"));
$("btn-auth-submit").addEventListener("click", handleAuth);
$("btn-logout").addEventListener("click", handleLogout);
$("auth-password").addEventListener("keydown", (e) => { if (e.key === "Enter") handleAuth(); });

async function init() {
  await initSupabase();
  buildSession();

  if (cloudConfigured) {
    try {
      const { data } = await supabase.auth.getSession();
      if (data && data.session) {
        currentUser = data.session.user;
        try { await loadFromCloud(); } catch (e) {}
        hideAuthScreen();
        updateUserBadge();
      } else {
        showAuthScreen();
      }
    } catch (e) {
      showAuthScreen();
    }
  } else {
    // 本地模式（未配置 Supabase）：无登录，直接使用
    hideAuthScreen();
    $("btn-logout").hidden = true;
  }

  refreshAll();

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

init();
