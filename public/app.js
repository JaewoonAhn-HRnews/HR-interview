// AI 면접 도우미 - 프론트엔드
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STORAGE_KEY = "hr-interview-current";
const TYPE_LABEL = { personality: "인성", job: "직무" };

let config = null;
let state = null;
let bankTab = "personality";

function newState() {
  return {
    id: crypto.randomUUID(),
    candidate: { name: "", jobRole: "", jobDescription: "", interviewType: "both" },
    testName: config.testName,
    scales: structuredClone(config.scales),
    scores: {},
    testReport: "",
    extraJobQuestions: [],
    turns: [],
    current: null,
    analysis: null,
  };
}

// ---------- 공통 유틸 ----------

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = "toast"), 3500);
}

function loading(on, text = "AI가 분석 중입니다...") {
  $("#loading").classList.toggle("hidden", !on);
  $("#loading-text").textContent = text;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* 저장소를 쓸 수 없는 환경에서는 무시 */
  }
  $("#candidate-badge").textContent = state.candidate.name
    ? `${state.candidate.name} · ${state.candidate.jobRole || "직무 미입력"}`
    : "";
}

function showStep(step) {
  $$(".steps button").forEach((b) => b.classList.toggle("active", b.dataset.step === step));
  $$(".step").forEach((s) => s.classList.toggle("active", s.id === `step-${step}`));
  if (step === "interview") renderInterview();
  if (step === "report") renderReport();
}

// ---------- 1. 면접 준비 ----------

function renderSetup() {
  const c = state.candidate;
  $("#c-name").value = c.name;
  $("#c-role").value = c.jobRole;
  $("#c-jd").value = c.jobDescription;
  $("#c-type").value = c.interviewType;
  $("#test-report").value = state.testReport;
  $("#test-title").textContent = `인성검사 결과 (${state.testName || "인성검사"})`;

  $("#scales-body").innerHTML = state.scales
    .map(
      (s, i) => `<tr>
        <td><b>${esc(s.name)}</b><div class="muted small">${esc(s.description)}</div></td>
        <td class="nowrap">${esc(s.min)}~${esc(s.max)}</td>
        <td><input type="number" step="any" data-score="${esc(s.id)}" min="${esc(s.min)}" max="${esc(s.max)}" value="${esc(state.scores[s.id] ?? "")}" /></td>
        <td><button class="icon" data-del-scale="${i}" title="척도 삭제">×</button></td>
      </tr>`,
    )
    .join("");
}

function readSetup() {
  state.candidate = {
    name: $("#c-name").value.trim(),
    jobRole: $("#c-role").value.trim(),
    jobDescription: $("#c-jd").value.trim(),
    interviewType: $("#c-type").value,
  };
  state.testReport = $("#test-report").value.trim();
  persist();
}

$("#scales-body").addEventListener("input", (e) => {
  const id = e.target.dataset.score;
  if (!id) return;
  const v = e.target.value;
  if (v === "") delete state.scores[id];
  else state.scores[id] = Number(v);
  persist();
});

$("#scales-body").addEventListener("click", (e) => {
  const i = e.target.dataset.delScale;
  if (i === undefined) return;
  const [removed] = state.scales.splice(Number(i), 1);
  delete state.scores[removed.id];
  persist();
  renderSetup();
});

$("#btn-add-scale").addEventListener("click", () => {
  const name = prompt("척도 이름 (예: 스트레스 내성)");
  if (!name?.trim()) return;
  const range = prompt("점수 범위 (최소~최대)", "1~10") || "1~10";
  const [min, max] = range.split(/[~\-,]/).map((x) => Number(x.trim()));
  const description = prompt("척도 설명 (선택)") || "";
  state.scales.push({
    id: `custom_${Date.now()}`,
    name: name.trim(),
    description,
    min: Number.isFinite(min) ? min : 1,
    max: Number.isFinite(max) ? max : 10,
  });
  persist();
  renderSetup();
});

["#c-name", "#c-role", "#c-jd", "#c-type", "#test-report"].forEach((sel) =>
  $(sel).addEventListener("change", readSetup),
);

$("#btn-start").addEventListener("click", () => {
  readSetup();
  if (!state.candidate.name) return toast("지원자 이름을 입력하세요.", true);
  bankTab = state.candidate.interviewType === "job" ? "job" : "personality";
  showStep("interview");
});

// ---------- 2. 면접 진행 ----------

function bankQuestions(type) {
  const base = config.questions[type] ?? [];
  return type === "job" ? [...state.extraJobQuestions, ...base] : base;
}

function renderBank() {
  const t = state.candidate.interviewType;
  $$(".tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.bank === bankTab);
    b.classList.toggle("hidden", t !== "both" && b.dataset.bank !== t);
  });
  $("#btn-gen-job").classList.toggle("hidden", bankTab !== "job");

  const asked = new Set(state.turns.map((x) => x.question));
  $("#bank-list").innerHTML = bankQuestions(bankTab)
    .map(
      (q, i) => `<li class="${asked.has(q.question) ? "asked" : ""}" data-bank-idx="${i}">
        <span class="cat">${esc(q.category)}${q.ai ? " ✨" : ""}</span>${esc(q.question)}
      </li>`,
    )
    .join("");
}

function renderCurrent() {
  const cur = state.current;
  $("#q-tag").textContent = cur
    ? `${TYPE_LABEL[cur.type]} 질문${cur.isFollowUp ? " · 꼬리질문" : ""}`
    : "질문을 선택하세요";
  $("#q-tag").className = `tag ${cur?.type ?? ""} ${cur?.isFollowUp ? "follow" : ""}`;
  $("#q-text").textContent = cur?.question ?? "왼쪽 질문 목록에서 질문을 고르거나 직접 입력하세요.";
}

function renderTurns() {
  $("#turn-count").textContent = `(${state.turns.length})`;
  $("#turn-list").innerHTML = state.turns
    .map(
      (t, i) => `<li class="${t.isFollowUp ? "follow" : ""}">
        <div class="turn-head">
          <span class="tag ${t.type} ${t.isFollowUp ? "follow" : ""}">${TYPE_LABEL[t.type]}${t.isFollowUp ? "·꼬리" : ""}</span>
          <button class="icon" data-del-turn="${i}" title="삭제">×</button>
        </div>
        <p class="tq">Q. ${esc(t.question)}</p>
        <p class="ta">A. ${esc(t.answer)}</p>
        ${t.followup ? `<p class="muted small">요약: ${esc(t.followup.answer_summary)}</p>` : ""}
      </li>`,
    )
    .join("");
  const list = $("#turn-list");
  list.scrollTop = list.scrollHeight;
}

function renderFollowUp(turnIndex) {
  const t = state.turns[turnIndex];
  const f = t?.followup;
  if (!f) return $("#followup-card").classList.add("hidden");
  $("#followup-card").classList.remove("hidden");
  const dir = { 긍정: "pos", 부정: "neg", 중립: "neu" };
  $("#followup-body").innerHTML = `
    <p><b>답변 요약</b> ${esc(f.answer_summary)} <span class="pill spec-${esc(f.specificity)}">구체성 ${esc(f.specificity)}</span></p>
    ${f.missing_points.length ? `<p><b>빠진/모호한 부분</b></p><ul class="compact">${f.missing_points.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
    ${f.observed_traits.length ? `<p><b>관찰된 특성</b></p><div class="traits">${f.observed_traits
      .map((o) => `<span class="trait ${dir[o.direction] ?? "neu"}" title="${esc(o.evidence)}">${esc(o.trait)}</span>`)
      .join("")}</div>` : ""}
    <p><b>추천 꼬리질문</b></p>
    <ol class="fq-list">
      ${f.follow_up_questions
        .map(
          (q, i) => `<li>
            <div><p class="fq">${esc(q.question)}</p><p class="muted small">의도: ${esc(q.intent)}</p></div>
            <button class="primary small" data-ask-follow="${turnIndex}:${i}">이 질문 하기</button>
          </li>`,
        )
        .join("")}
    </ol>`;
}

function renderInterview() {
  renderBank();
  renderCurrent();
  renderTurns();
  renderFollowUp(state.turns.length - 1);
}

function setCurrent(cur) {
  if (recognizing) stopRecognition();
  state.current = cur;
  $("#answer").value = "";
  $("#interim").textContent = "";
  persist();
  renderCurrent();
  $("#answer").focus();
}

$$(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    bankTab = b.dataset.bank;
    renderBank();
  }),
);

$("#bank-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-bank-idx]");
  if (!li) return;
  const q = bankQuestions(bankTab)[Number(li.dataset.bankIdx)];
  setCurrent({ type: bankTab, question: q.question, isFollowUp: false, parentIndex: null });
});

$("#btn-custom-q").addEventListener("click", () => {
  const q = $("#custom-q").value.trim();
  if (!q) return;
  $("#custom-q").value = "";
  setCurrent({ type: bankTab, question: q, isFollowUp: false, parentIndex: null });
});

$("#followup-body").addEventListener("click", (e) => {
  const v = e.target.dataset.askFollow;
  if (!v) return;
  const [ti, qi] = v.split(":").map(Number);
  const parent = state.turns[ti];
  setCurrent({
    type: parent.type,
    question: parent.followup.follow_up_questions[qi].question,
    isFollowUp: true,
    parentIndex: ti,
  });
});

$("#turn-list").addEventListener("click", (e) => {
  const i = e.target.dataset.delTurn;
  if (i === undefined || !confirm("이 기록을 삭제할까요?")) return;
  state.turns.splice(Number(i), 1);
  persist();
  renderInterview();
});

$("#btn-gen-job").addEventListener("click", async () => {
  if (!state.candidate.jobRole) return toast("면접 준비 단계에서 지원 직무를 입력하세요.", true);
  loading(true, "지원 직무에 맞는 질문을 만드는 중...");
  try {
    const { questions } = await api("/api/job-questions", { candidate: state.candidate, count: 6 });
    state.extraJobQuestions = [...questions.map((q) => ({ ...q, ai: true })), ...state.extraJobQuestions];
    persist();
    renderBank();
    toast(`직무 맞춤 질문 ${questions.length}개를 추가했습니다.`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    loading(false);
  }
});

$("#btn-submit").addEventListener("click", async () => {
  if (!state.current) return toast("먼저 질문을 선택하세요.", true);
  if (recognizing) stopRecognition();
  const answer = $("#answer").value.trim();
  if (!answer) return toast("답변 내용이 없습니다.", true);

  const prevTurns = state.turns.map(({ type, question, answer, isFollowUp }) => ({ type, question, answer, isFollowUp }));
  const turn = { ...state.current, answer, followup: null, at: new Date().toISOString() };
  state.turns.push(turn);
  const idx = state.turns.length - 1;
  state.current = null;
  $("#answer").value = "";
  $("#interim").textContent = "";
  persist();
  renderInterview();

  $("#btn-submit").disabled = true;
  $("#followup-card").classList.remove("hidden");
  $("#followup-body").innerHTML = `<p class="muted">답변을 분석하고 꼬리질문을 만드는 중...</p>`;
  try {
    turn.followup = await api("/api/followup", {
      candidate: state.candidate,
      scales: state.scales,
      turns: prevTurns,
      current: { type: turn.type, question: turn.question, answer: turn.answer },
    });
    persist();
    renderTurns();
    renderFollowUp(idx);
  } catch (err) {
    $("#followup-body").innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  } finally {
    $("#btn-submit").disabled = false;
  }
});

// ---------- 음성 인식 (Web Speech API) ----------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognizing = false;
let baseText = "";

function startRecognition() {
  if (!SpeechRecognition) {
    return toast("이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Edge를 사용하거나 직접 입력하세요.", true);
  }
  recognition = new SpeechRecognition();
  recognition.lang = "ko-KR";
  recognition.continuous = true;
  recognition.interimResults = true;
  baseText = $("#answer").value;

  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        baseText = `${baseText}${baseText && !baseText.endsWith(" ") ? " " : ""}${r[0].transcript.trim()}`;
      } else {
        interim += r[0].transcript;
      }
    }
    $("#answer").value = baseText;
    $("#interim").textContent = interim;
  };
  recognition.onerror = (e) => {
    if (e.error === "not-allowed") {
      recognizing = false;
      toast("마이크 권한이 거부되었습니다. 브라우저 주소창에서 마이크 권한을 허용하세요.", true);
    }
  };
  // 크롬은 침묵이 길어지면 자동 종료되므로, 녹음 중이면 다시 시작
  recognition.onend = () => {
    if (recognizing) {
      baseText = $("#answer").value;
      try {
        recognition.start();
      } catch {
        recognizing = false;
      }
    }
    updateRecUI();
  };

  recognizing = true;
  recognition.start();
  updateRecUI();
}

function stopRecognition() {
  recognizing = false;
  recognition?.stop();
  $("#interim").textContent = "";
  updateRecUI();
}

function updateRecUI() {
  $("#btn-rec").textContent = recognizing ? "⏹ 녹음 중지" : "🎤 녹음 시작";
  $("#btn-rec").classList.toggle("on", recognizing);
  $("#rec-status").textContent = recognizing ? "● 받아쓰는 중" : "";
}

$("#btn-rec").addEventListener("click", () => (recognizing ? stopRecognition() : startRecognition()));
// 직접 수정한 내용이 다음 인식 결과에 덮어써지지 않도록 기준 텍스트 갱신
$("#answer").addEventListener("input", () => (baseText = $("#answer").value));

// ---------- 3. 분석 결과 ----------

async function runAnalysis() {
  if (!state.turns.some((t) => t.answer?.trim())) return toast("기록된 답변이 없습니다.", true);
  loading(true, "면접 전체를 분석하고 인성검사와 비교하는 중... (1~2분 소요)");
  try {
    state.analysis = await api("/api/analyze", {
      candidate: state.candidate,
      testName: state.testName,
      scales: state.scales,
      scores: state.scores,
      testReport: state.testReport,
      turns: state.turns.map(({ type, question, answer, isFollowUp }) => ({ type, question, answer, isFollowUp })),
    });
    state.analyzedAt = new Date().toISOString();
    persist();
    await saveSession(true);
    showStep("report");
  } catch (err) {
    toast(err.message, true);
  } finally {
    loading(false);
  }
}

$("#btn-analyze").addEventListener("click", () => {
  if (recognizing) stopRecognition();
  runAnalysis();
});
$("#btn-reanalyze").addEventListener("click", runAnalysis);

const CONS_CLASS = { 일치: "ok", 부분일치: "partial", 불일치: "bad", 판단불가: "na" };
const REC_CLASS = { "적극 추천": "ok", 추천: "ok", 보류: "partial", 비추천: "bad" };

function scoreBar(scale, testScore, a) {
  const span = scale.max - scale.min || 1;
  const pos = (v) => Math.min(100, Math.max(0, ((v - scale.min) / span) * 100));
  const hasTest = typeof testScore === "number";
  const hasInt = a.interview_level !== "판단불가";
  return `<div class="bar">
    ${hasTest ? `<span class="mark test" style="left:${pos(testScore)}%" title="검사 ${testScore}"></span>` : ""}
    ${hasInt ? `<span class="mark intv" style="left:${pos(a.interview_score)}%" title="면접 추정 ${a.interview_score}"></span>` : ""}
  </div>`;
}

function list(items) {
  return items?.length ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">없음</p>`;
}

function renderReport() {
  const a = state.analysis;
  $("#report-empty").classList.toggle("hidden", !!a);
  $("#report").classList.toggle("hidden", !a);
  $("#report-actions").classList.toggle("hidden", !a);
  if (!a) return;

  const c = state.candidate;
  const scaleById = Object.fromEntries(state.scales.map((s) => [s.id, s]));
  const counts = a.scale_comparison.reduce((m, s) => ((m[s.consistency] = (m[s.consistency] ?? 0) + 1), m), {});

  $("#report").innerHTML = `
    <div class="card report-head">
      <div>
        <h2>${esc(c.name)} <span class="muted">· ${esc(c.jobRole)}</span></h2>
        <p class="one-line">“${esc(a.one_line)}”</p>
        <p class="muted small">질문 ${state.turns.length}개 · 분석 ${esc(new Date(state.analyzedAt ?? Date.now()).toLocaleString("ko-KR"))}</p>
      </div>
      <div class="rec-box ${REC_CLASS[a.recommendation] ?? ""}">
        <span class="muted small">AI 참고 의견</span>
        <b>${esc(a.recommendation)}</b>
      </div>
    </div>

    <div class="grid-2">
      <div class="card"><h3>어떤 사람인가</h3><p>${esc(a.personality_profile)}</p></div>
      <div class="card"><h3>예상 업무 스타일</h3><p>${esc(a.work_style)}</p></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>인성검사 결과 vs 면접 관찰</h3>
        <div class="legend small">
          <span><i class="mark test"></i> 인성검사</span><span><i class="mark intv"></i> 면접 추정</span>
          ${["일치", "부분일치", "불일치", "판단불가"].map((k) => `<span class="pill ${CONS_CLASS[k]}">${k} ${counts[k] ?? 0}</span>`).join("")}
        </div>
      </div>
      <table class="compare">
        <thead><tr><th>척도</th><th>검사</th><th>면접</th><th class="bar-col">위치</th><th>일치도</th><th>해석 · 근거</th></tr></thead>
        <tbody>
        ${a.scale_comparison
          .map((s) => {
            const scale = scaleById[s.scale_id] ?? { min: 1, max: 10, name: s.scale_name };
            const test = state.scores[s.scale_id];
            return `<tr>
              <td><b>${esc(scale.name ?? s.scale_name)}</b><div class="muted small">${esc(scale.min)}~${esc(scale.max)}</div></td>
              <td class="nowrap">${typeof test === "number" ? esc(test) : "-"}</td>
              <td class="nowrap">${s.interview_level === "판단불가" ? "판단불가" : `${esc(s.interview_level)} (${esc(s.interview_score)})`}</td>
              <td class="bar-col">${scoreBar(scale, test, s)}</td>
              <td><span class="pill ${CONS_CLASS[s.consistency]}">${esc(s.consistency)}</span></td>
              <td>${esc(s.comment)}${s.evidence.length ? `<div class="evidence">${s.evidence.map((e) => `<q>${esc(e)}</q>`).join("")}</div>` : ""}</td>
            </tr>`;
          })
          .join("")}
        </tbody>
      </table>
    </div>

    ${a.job_competencies.length ? `<div class="card">
      <h3>직무 역량 평가</h3>
      <table class="compare">
        <thead><tr><th>역량</th><th>평가</th><th>근거</th><th>코멘트</th></tr></thead>
        <tbody>${a.job_competencies
          .map((j) => `<tr><td><b>${esc(j.competency)}</b></td><td><span class="pill rate-${esc(j.rating)}">${esc(j.rating)}</span></td><td><q>${esc(j.evidence)}</q></td><td>${esc(j.comment)}</td></tr>`)
          .join("")}</tbody>
      </table>
    </div>` : ""}

    <div class="grid-2">
      <div class="card"><h3>강점</h3>${list(a.strengths)}</div>
      <div class="card"><h3>우려 사항</h3>${list(a.concerns)}</div>
    </div>
    <div class="grid-2">
      <div class="card"><h3>모순 · 불일치 지점</h3>${list(a.inconsistencies)}</div>
      <div class="card"><h3>다음 면접 확인 질문</h3>${list(a.verification_questions)}</div>
    </div>
    <div class="card"><h3>종합 의견</h3><p>${esc(a.recommendation_reason)}</p>
      <p class="muted small">※ 이 결과는 AI가 면접 기록을 바탕으로 작성한 참고 자료입니다. 채용 결정은 면접관의 종합적인 판단으로 내려 주세요.</p>
    </div>

    <details class="card">
      <summary><b>면접 전체 기록</b></summary>
      <ol class="turn-list print-full">${state.turns
        .map((t) => `<li class="${t.isFollowUp ? "follow" : ""}"><p class="tq">[${TYPE_LABEL[t.type]}${t.isFollowUp ? "·꼬리" : ""}] Q. ${esc(t.question)}</p><p class="ta">A. ${esc(t.answer)}</p></li>`)
        .join("")}</ol>
    </details>`;
}

$("#btn-print").addEventListener("click", () => {
  $$("#report details").forEach((d) => (d.open = true));
  window.print();
});

$("#btn-download").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `면접결과_${state.candidate.name || "지원자"}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- 저장 / 불러오기 ----------

async function saveSession(silent = false) {
  readSetupIfVisible();
  try {
    await api("/api/sessions", state);
    if (!silent) toast("서버에 저장했습니다.");
  } catch (err) {
    toast(`저장 실패: ${err.message}`, true);
  }
}

function readSetupIfVisible() {
  if ($("#step-setup").classList.contains("active")) readSetup();
}

$("#btn-save").addEventListener("click", () => saveSession());

$("#btn-load").addEventListener("click", async () => {
  try {
    const sessions = await api("/api/sessions");
    $("#session-list").innerHTML = sessions.length
      ? sessions
          .map(
            (s) => `<li><button class="ghost full" data-session="${esc(s.id)}">
              <b>${esc(s.name || "(이름 없음)")}</b> · ${esc(s.jobRole || "")}
              <span class="muted small">${esc(new Date(s.savedAt).toLocaleString("ko-KR"))}${s.analyzed ? " · 분석완료" : ""}</span>
            </button></li>`,
          )
          .join("")
      : `<li class="muted">저장된 면접이 없습니다.</li>`;
    $("#load-dialog").showModal();
  } catch (err) {
    toast(err.message, true);
  }
});

$("#session-list").addEventListener("click", async (e) => {
  const id = e.target.closest("[data-session]")?.dataset.session;
  if (!id) return;
  try {
    state = { ...newState(), ...(await api(`/api/sessions/${encodeURIComponent(id)}`)) };
    persist();
    renderSetup();
    $("#load-dialog").close();
    showStep(state.analysis ? "report" : "interview");
    toast("불러왔습니다.");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#btn-new").addEventListener("click", () => {
  if (!confirm("현재 면접을 닫고 새 면접을 시작할까요? (저장하지 않은 내용은 사라집니다)")) return;
  if (recognizing) stopRecognition();
  state = newState();
  persist();
  renderSetup();
  showStep("setup");
});

$$(".steps button").forEach((b) =>
  b.addEventListener("click", () => {
    readSetupIfVisible();
    showStep(b.dataset.step);
  }),
);

// ---------- 시작 ----------

async function init() {
  config = await api("/api/config");
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    saved = null;
  }
  state = saved ? { ...newState(), ...saved } : newState();
  persist();
  renderSetup();
  if (!SpeechRecognition) $("#rec-status").textContent = "음성 인식 미지원 브라우저 (직접 입력)";
}

init().catch((err) => toast(`초기화 실패: ${err.message}`, true));
