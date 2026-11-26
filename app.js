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
  settings: { dailyGoal: 20, accent: 1, dark: false },
  wordbook: [],            // 生词本（收藏"还不熟"的单词）
  achievements: [],        // 已解锁的成就 id
  cards: [],               // 已收集的卡片 id
  lastDrawDate: ""         // 上次抽卡日期（YYYY-MM-DD）
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
    achievements: Array.isArray(o.achievements) ? o.achievements : [],
    cards: Array.isArray(o.cards) ? o.cards : [],
    lastDrawDate: o.lastDrawDate || ""
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

/* ---------------- 云端账号（Supabase，直接用 fetch，无第三方 SDK/CDN 依赖） ---------------- */
let currentUser = null;
let cloudConfigured = false;
let cloudSaveTimer = null;

const CLOUD = { url: "", key: "" };

function cloudInit() {
  if (typeof SUPABASE_URL === "string" && SUPABASE_URL && typeof SUPABASE_ANON_KEY === "string" && SUPABASE_ANON_KEY) {
    CLOUD.url = SUPABASE_URL.replace(/\/+$/, "");
    CLOUD.key = SUPABASE_ANON_KEY;
    return true;
  }
  return false;
}

const SESSION_KEY = "happy_english_session_v1";
let cloudSession = null;

function loadCloudSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    cloudSession = raw ? JSON.parse(raw) : null;
  } catch (e) {
    cloudSession = null;
  }
}
function saveCloudSession(s) {
  cloudSession = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch (e) {}
}

async function cloudFetch(path, opts) {
  opts = opts || {};
  const headers = { "apikey": CLOUD.key, "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = "Bearer " + opts.token;
  if (opts.prefer) headers["Prefer"] = opts.prefer;
  const res = await fetch(CLOUD.url + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const msg = (data && (data.msg || data.message || data.error_description || data.error)) || ("HTTP " + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function authPath(p) { return "/auth/v1" + p; }
function restPath(p) { return "/rest/v1" + p; }

function pickSession(r) {
  if (!r) return null;
  const s = r.session || r;
  if (s && s.access_token) {
    return {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_in: s.expires_in,
      user: r.user || s.user
    };
  }
  return null;
}

async function ensureFreshSession() {
  loadCloudSession();
  if (!cloudSession || !cloudSession.access_token) return null;
  if (Date.now() < (cloudSession.expires_at || 0) - 60000) return cloudSession;
  try {
    const r = await cloudFetch(authPath("/token?grant_type=refresh_token"), { method: "POST", body: { refresh_token: cloudSession.refresh_token } });
    const s = {
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      expires_at: Date.now() + (r.expires_in || 3600) * 1000,
      user: r.user || cloudSession.user
    };
    saveCloudSession(s);
    return s;
  } catch (e) {
    saveCloudSession(null);
    return null;
  }
}

function scheduleCloudSave() {
  if (!cloudConfigured || !currentUser) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(saveToCloud, 800);
}

async function saveToCloud() {
  if (!cloudConfigured || !currentUser) return;
  const s = await ensureFreshSession();
  if (!s) return;
  try {
    await cloudFetch(restPath("/profiles"), {
      method: "POST",
      token: s.access_token,
      prefer: "resolution=merge-duplicates",
      body: { id: currentUser.id, email: currentUser.email, data: state, updated_at: new Date().toISOString() }
    });
  } catch (e) {}
}

async function loadFromCloud() {
  const s = await ensureFreshSession();
  if (!s) throw new Error("登录已过期，请重新登录");
  const uid = encodeURIComponent(currentUser.id);
  const rows = await cloudFetch(restPath("/profiles?id=eq." + uid + "&select=data"), { token: s.access_token });
  if (Array.isArray(rows) && rows.length && rows[0].data && typeof rows[0].data === "object") {
    state = normalizeState(rows[0].data);
  } else {
    await cloudFetch(restPath("/profiles"), {
      method: "POST",
      token: s.access_token,
      prefer: "resolution=merge-duplicates",
      body: { id: currentUser.id, email: currentUser.email, data: structuredClone(DEFAULT_STATE) }
    });
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
  wordbook: $("page-wordbook"),
  gacha: $("page-gacha"),
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
  if (name === "wordbook") renderWordbook();
  if (name === "gacha") renderGacha();
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

/* 深色模式切换 */
function applyTheme(dark) {
  document.body.classList.toggle("dark", !!dark);
  const btn = $("btn-theme");
  if (btn) btn.textContent = dark ? "☀️" : "🌙";
}
$("btn-theme").addEventListener("click", () => {
  applyTheme(!state.settings.dark);
  state.settings.dark = !state.settings.dark;
  saveState();
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
    state.wordbook = state.wordbook.filter((w) => w !== word.word);
  } else {
    p.level = Math.max(0, p.level - 1);
    p.nextReview = Date.now() + 10 * 60 * 1000; // 10 分钟后再来
    p.wrong += 1;
    p.mastered = false;
    if (!state.wordbook.includes(word.word)) state.wordbook.push(word.word);
  }
  state.progress[word.word] = p;
  recordStudy();
  checkAchievements();
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
  if (card.classList.contains("flipped")) playAudio(session[sessionIndex].word);
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
  checkAchievements();
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
  checkAchievements();
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

/* ---------- 每日一句 ---------- */
function dailySentence() {
  const idx = Math.floor(Date.now() / 86400000) % SENTENCES.length;
  return SENTENCES[idx];
}
function renderDailySentence() {
  const s = dailySentence();
  const t = $("ds-text"); if (t) t.textContent = s.text;
  const tr = $("ds-trans"); if (tr) tr.textContent = s.translation;
}
$("ds-play").addEventListener("click", () => playAudio(dailySentence().text, { rate: 0.9 }));

/* ---------- 生词本 ---------- */
function renderWordbook() {
  const list = $("wordbook-list");
  const empty = $("wordbook-empty");
  if (!list) return;
  list.innerHTML = "";
  const words = (state.wordbook || []).slice().reverse();
  if (!words.length) { if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;
  words.forEach((w) => {
    const data = WORDS.find((x) => x.word === w) || { word: w, meaning: "", phonetic: "" };
    const card = document.createElement("div");
    card.className = "sentence-card";
    card.innerHTML = `
      <button class="sentence-play" aria-label="播放">🔊</button>
      <div class="sentence-body">
        <div class="sentence-text">${data.word}<span style="font-weight:400;color:var(--text-soft);margin-left:6px">${data.phonetic || ""}</span></div>
        <div class="sentence-trans">${data.meaning}</div>
      </div>
      <button class="wb-remove">移出</button>`;
    card.querySelector(".sentence-play").addEventListener("click", (e) => { e.stopPropagation(); playAudio(data.word); });
    card.querySelector(".wb-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      state.wordbook = state.wordbook.filter((x) => x !== w);
      saveState();
      renderWordbook();
    });
    list.appendChild(card);
  });
}

/* ---------- 成就 ---------- */
const ACHIEVEMENTS = [
  { id: "words10", emoji: "🌱", name: "初出茅庐", check: () => masteredCount() >= 10 },
  { id: "words50", emoji: "🌿", name: "词汇小能手", check: () => masteredCount() >= 50 },
  { id: "words100", emoji: "🌳", name: "百词斩", check: () => masteredCount() >= 100 },
  { id: "streak3", emoji: "🔥", name: "坚持 3 天", check: () => computeStreak() >= 3 },
  { id: "streak7", emoji: "💪", name: "坚持 7 天", check: () => computeStreak() >= 7 },
  { id: "quiz10", emoji: "🎯", name: "测验 10 题", check: () => (state.quiz.total || 0) >= 10 },
  { id: "listen10", emoji: "🎧", name: "听力 10 题", check: () => (state.listen.total || 0) >= 10 },
  { id: "wb10", emoji: "📒", name: "收集生词", check: () => (state.wordbook || []).length >= 10 },
  { id: "review50", emoji: "📚", name: "复习 50 次", check: () => totalReviews() >= 50 }
];

function checkAchievements() {
  let changed = false;
  ACHIEVEMENTS.forEach((a) => {
    if (state.achievements.indexOf(a.id) === -1 && a.check()) {
      state.achievements.push(a.id);
      changed = true;
    }
  });
  if (changed) { saveState(); renderAchievements(); }
}

function renderAchievements() {
  const box = $("achievements");
  if (!box) return;
  box.innerHTML = "";
  ACHIEVEMENTS.forEach((a) => {
    const el = document.createElement("div");
    const unlocked = state.achievements.indexOf(a.id) !== -1;
    el.className = "ach-item" + (unlocked ? " unlocked" : "");
    el.innerHTML = `<div class="ach-emoji">${a.emoji}</div><div class="ach-name">${a.name}</div>`;
    box.appendChild(el);
  });
}

/* ---------- 抽卡 ---------- */
function seriesName(s) {
  return s === "ultraman" ? "奥特曼" : s === "mlp" ? "小马宝莉" : "宝可梦";
}

function gachaStudiedToday() {
  const d = state.daily[todayKey()];
  return !!(d && d.reviews > 0);
}

function canDraw() {
  return gachaStudiedToday() && state.lastDrawDate !== todayKey();
}

function rollRarity() {
  const total = RARITIES.reduce((s, r) => s + r.chance, 0);
  let x = Math.random() * total;
  for (const r of RARITIES) {
    x -= r.chance;
    if (x <= 0) return r.id;
  }
  return RARITIES[0].id;
}

function pickCard(rarity) {
  let pool = CARDS.filter((c) => c.rarity === rarity);
  if (!pool.length) pool = CARDS.filter((c) => c.rarity === "N");
  return pool[Math.floor(Math.random() * pool.length)];
}

function drawCard() {
  if (!canDraw()) { renderGacha(); return; }
  const rarity = rollRarity();
  const card = pickCard(rarity);
  state.lastDrawDate = todayKey();
  if (state.cards.indexOf(card.id) === -1) state.cards.push(card.id);
  saveState();
  showGachaResult(card);
  checkAchievements();
  renderGacha();
}

function cardEmoji(card) {
  return CARD_EMOJI[card.id] || (card.series === "ultraman" ? "👾" : card.series === "mlp" ? "🦄" : "🔴");
}

function cardArt(card) {
  const emoji = `<div class="gcard-emoji">${cardEmoji(card)}</div>`;
  if (card.img) {
    return `<div class="gcard-art">${emoji}<img class="gcard-img" src="${card.img}" alt="${card.name}" onerror="this.remove()"></div>`;
  }
  return emoji;
}

function showGachaResult(card) {
  const disp = $("gacha-display");
  const r = RARITIES.find((x) => x.id === card.rarity);
  disp.className = "gacha-display rarity-" + card.rarity;
  disp.innerHTML = `
    <div class="gcard-rarity">${card.rarity} · ${r.full}</div>
    <div class="gacha-art">${cardArt(card)}</div>
    <div class="gcard-name">${card.name}</div>
    <div class="gcard-series">${seriesName(card.series)}</div>`;
  void disp.offsetWidth;
  disp.classList.add("pop");
  setTimeout(() => disp.classList.remove("pop"), 700);
}

function renderGacha() {
  const btn = $("btn-draw");
  const hint = $("gacha-hint");
  if (!btn) return;
  const studied = gachaStudiedToday();
  const drawn = state.lastDrawDate === todayKey();
  if (drawn) {
    btn.disabled = true;
    btn.textContent = "今天已抽过啦，明天再来 🌙";
    if (hint) hint.textContent = "";
  } else if (!studied) {
    btn.disabled = true;
    btn.textContent = "抽卡 🎴";
    if (hint) hint.textContent = "今天还没学习哦～去「学习」页背几个单词就能抽卡啦";
  } else {
    btn.disabled = false;
    btn.textContent = "抽卡 🎴（今日可抽 1 次）";
    if (hint) hint.textContent = "";
  }
  const ownedEl = $("gacha-owned"); if (ownedEl) ownedEl.textContent = state.cards.length;
  const totalEl = $("gacha-total"); if (totalEl) totalEl.textContent = CARDS.length;
  renderCollection();
}

function renderCollection() {
  const box = $("gacha-collection");
  if (!box) return;
  box.innerHTML = "";
  CARDS.forEach((c) => {
    const owned = state.cards.indexOf(c.id) !== -1;
    const el = document.createElement("div");
    el.className = "gcard rarity-" + c.rarity + (owned ? " owned" : " locked");
    const art = owned ? cardArt(c) : `<div class="gcard-emoji">？</div>`;
    el.innerHTML = `
      <div class="gcard-rar">${c.rarity}</div>
      <div class="gcard-art-sm">${art}</div>
      <div class="gcard-body">${owned ? c.name : "？"}</div>
      <div class="gcard-series">${owned ? seriesName(c.series) : "未收集"}</div>`;
    box.appendChild(el);
  });
}

$("btn-draw").addEventListener("click", drawCard);

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
  renderAchievements();
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
  $("btn-auth-submit").disabled = false;
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
    let user = null;
    if (authMode === "signup") {
      const r = await cloudFetch(authPath("/signup"), { method: "POST", body: { email, password, data: { nickname: nickname || email.split("@")[0] } } });
      const sess = pickSession(r);
      if (sess) {
        saveCloudSession({ access_token: sess.access_token, refresh_token: sess.refresh_token, expires_at: Date.now() + (sess.expires_in || 3600) * 1000, user: sess.user });
        user = sess.user;
      } else if (r && r.user) {
        $("auth-error").textContent = "✅ 注册成功！请到邮箱点击确认链接，然后回来点「登录」。";
        btn.disabled = false;
        setAuthMode("login");
        return;
      }
    } else {
      const r = await cloudFetch(authPath("/token?grant_type=password"), { method: "POST", body: { email, password } });
      const sess = pickSession(r);
      if (sess) {
        saveCloudSession({ access_token: sess.access_token, refresh_token: sess.refresh_token, expires_at: Date.now() + (sess.expires_in || 3600) * 1000, user: sess.user });
        user = sess.user;
      }
    }
    if (user) {
      await onAuthSuccess(user);
    } else {
      $("auth-error").textContent = "登录失败，请重试";
      btn.disabled = false;
      btn.textContent = authMode === "login" ? "登录" : "注册";
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
  const s = cloudSession;
  if (s && s.access_token) {
    try { await cloudFetch(authPath("/logout"), { method: "POST", token: s.access_token }); } catch (e) {}
  }
  saveCloudSession(null);
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
  renderDailySentence();
}

$("tab-login").addEventListener("click", () => setAuthMode("login"));
$("tab-signup").addEventListener("click", () => setAuthMode("signup"));
$("btn-auth-submit").addEventListener("click", handleAuth);
$("btn-logout").addEventListener("click", handleLogout);
$("auth-password").addEventListener("keydown", (e) => { if (e.key === "Enter") handleAuth(); });

async function init() {
  cloudConfigured = cloudInit();
  loadCloudSession();
  buildSession();
  applyTheme(!!state.settings.dark);

  if (cloudConfigured) {
    let user = null;
    try {
      const s = await ensureFreshSession();
      if (s && s.access_token) {
        user = await cloudFetch(authPath("/user"), { token: s.access_token });
      }
    } catch (e) {
      user = null;
    }
    if (user) {
      currentUser = user;
      try { await loadFromCloud(); } catch (e) {}
      hideAuthScreen();
      updateUserBadge();
    } else {
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
