// Claude API 연동: 꼬리질문 생성, 직무 질문 생성, 면접 종합 분석
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

let client;
function getClient() {
  // ANTHROPIC_API_KEY (또는 `ant auth login` 프로필)에서 인증 정보를 읽습니다.
  if (!client) client = new Anthropic();
  return client;
}

const COMMON_RULES = `
공통 원칙:
- 당신은 채용 면접관을 보조하는 HR 전문가입니다. 최종 판단은 사람 면접관이 내리며, 당신의 출력은 참고 자료입니다.
- 면접자의 답변 "내용"에 나타난 행동·사고·경험만을 근거로 판단하세요.
- 성별, 나이, 출신 지역·학교, 외모, 가족관계, 종교, 장애, 말투·사투리 등 직무와 무관하거나 차별 소지가 있는 요소는 판단 근거로 쓰지 말고, 그런 내용을 묻는 질문도 만들지 마세요.
- 답변은 음성인식(STT)으로 받아쓴 것이라 오탈자·띄어쓰기 오류가 있을 수 있습니다. 표기 오류는 감점 요소가 아닙니다.
- 근거가 부족하면 추측하지 말고 "판단불가"로 표시하세요.
- 모든 출력은 한국어로 작성하세요.`;

// ---------- JSON 스키마 (structured outputs) ----------

const followUpSchema = {
  type: "object",
  properties: {
    answer_summary: { type: "string", description: "답변 핵심 요약 (1~2문장)" },
    specificity: { type: "string", enum: ["높음", "보통", "낮음"], description: "답변의 구체성 (STAR: 상황·과제·행동·결과가 드러나는 정도)" },
    missing_points: { type: "array", items: { type: "string" }, description: "답변에서 빠졌거나 모호한 부분" },
    observed_traits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          trait: { type: "string", description: "관찰된 특성 (가능하면 인성검사 척도명 사용)" },
          direction: { type: "string", enum: ["긍정", "부정", "중립"] },
          evidence: { type: "string", description: "근거가 된 답변 내용 (짧게 인용)" },
        },
        required: ["trait", "direction", "evidence"],
        additionalProperties: false,
      },
    },
    follow_up_questions: {
      type: "array",
      description: "면접관이 바로 물어볼 수 있는 꼬리질문 2~3개, 가장 추천하는 것부터",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "면접관이 그대로 읽을 수 있는 구어체 질문" },
          intent: { type: "string", description: "이 질문으로 확인하려는 것" },
        },
        required: ["question", "intent"],
        additionalProperties: false,
      },
    },
  },
  required: ["answer_summary", "specificity", "missing_points", "observed_traits", "follow_up_questions"],
  additionalProperties: false,
};

const jobQuestionsSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          question: { type: "string" },
          intent: { type: "string" },
        },
        required: ["category", "question", "intent"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

const LEVELS = ["매우높음", "높음", "중간", "낮음", "매우낮음", "판단불가"];

const analysisSchema = {
  type: "object",
  properties: {
    one_line: { type: "string", description: "이 사람을 한 문장으로 표현" },
    personality_profile: { type: "string", description: "면접에서 드러난 이 사람의 성향·행동 방식에 대한 서술 (4~6문장)" },
    work_style: { type: "string", description: "예상되는 업무 스타일과 잘 맞는/맞지 않는 환경" },
    scale_comparison: {
      type: "array",
      description: "인성검사 척도별로 면접 관찰 결과와 검사 결과를 비교. 입력된 모든 척도를 같은 순서로 포함",
      items: {
        type: "object",
        properties: {
          scale_id: { type: "string" },
          scale_name: { type: "string" },
          interview_level: { type: "string", enum: LEVELS, description: "면접 답변으로 추정한 수준" },
          interview_score: { type: "number", description: "면접 기반 추정 점수 (해당 척도의 점수 범위 기준). 판단불가면 0" },
          consistency: { type: "string", enum: ["일치", "부분일치", "불일치", "판단불가"], description: "검사 점수와 면접 관찰의 일치 정도" },
          evidence: { type: "array", items: { type: "string" }, description: "근거가 된 답변 인용 (짧게)" },
          comment: { type: "string", description: "비교 해석. 불일치라면 가능한 원인(자기보고 편향, 상황 특수성, 답변 연습 등)" },
        },
        required: ["scale_id", "scale_name", "interview_level", "interview_score", "consistency", "evidence", "comment"],
        additionalProperties: false,
      },
    },
    job_competencies: {
      type: "array",
      description: "직무 면접 답변으로 평가한 직무 역량 (직무 질문이 없었다면 빈 배열)",
      items: {
        type: "object",
        properties: {
          competency: { type: "string" },
          rating: { type: "string", enum: ["우수", "양호", "보통", "미흡", "판단불가"] },
          evidence: { type: "string" },
          comment: { type: "string" },
        },
        required: ["competency", "rating", "evidence", "comment"],
        additionalProperties: false,
      },
    },
    strengths: { type: "array", items: { type: "string" } },
    concerns: { type: "array", items: { type: "string" } },
    inconsistencies: { type: "array", items: { type: "string" }, description: "답변 간 모순, 또는 인성검사와 크게 어긋나는 지점" },
    verification_questions: { type: "array", items: { type: "string" }, description: "다음 면접에서 추가로 확인할 질문" },
    recommendation: { type: "string", enum: ["적극 추천", "추천", "보류", "비추천"] },
    recommendation_reason: { type: "string" },
  },
  required: [
    "one_line", "personality_profile", "work_style", "scale_comparison", "job_competencies",
    "strengths", "concerns", "inconsistencies", "verification_questions", "recommendation", "recommendation_reason",
  ],
  additionalProperties: false,
};

// ---------- 공통 호출 ----------

export class AIError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function callStructured({ system, user, schema, effort, maxTokens }) {
  let response;
  try {
    response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      // 안전 분류기가 요청을 거절할 경우 서버 측에서 대체 모델로 재시도
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content: user }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new AIError("Claude API 인증 실패: ANTHROPIC_API_KEY 를 확인하세요.", 500);
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new AIError("요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도하세요.", 429);
    }
    if (err instanceof Anthropic.APIError) {
      throw new AIError(`Claude API 오류 (${err.status ?? "network"}): ${err.message}`);
    }
    // 예: 인증 정보가 전혀 없을 때 (ANTHROPIC_API_KEY 미설정)
    throw new AIError(`Claude API 호출 실패 - .env 의 ANTHROPIC_API_KEY 설정을 확인하세요. (${err.message})`, 500);
  }

  if (response.stop_reason === "refusal") {
    throw new AIError("AI가 이 요청에 대한 응답을 거절했습니다. 입력 내용을 확인해 주세요.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new AIError("응답이 너무 길어 잘렸습니다. 다시 시도해 주세요.");
  }
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new AIError("AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.");
  }
}

// ---------- 입력 포맷팅 ----------

const TYPE_LABEL = { personality: "인성", job: "직무" };

export function formatTranscript(turns = []) {
  if (!turns.length) return "(아직 진행된 질문 없음)";
  return turns
    .map((t, i) => {
      const tag = `${TYPE_LABEL[t.type] ?? "기타"}${t.isFollowUp ? "·꼬리질문" : ""}`;
      return `[${i + 1}] (${tag}) 질문: ${t.question}\n    답변: ${t.answer?.trim() || "(답변 없음)"}`;
    })
    .join("\n");
}

export function formatScales(scales = [], scores = {}) {
  return scales
    .map((s) => {
      const raw = scores[s.id];
      const score = raw === undefined || raw === null || raw === "" ? "미입력" : raw;
      const meaning = [s.high && `높으면: ${s.high}`, s.low && `낮으면: ${s.low}`].filter(Boolean).join(" / ");
      return `- id=${s.id} | ${s.name} (점수범위 ${s.min}~${s.max}) | 검사점수: ${score}\n  정의: ${s.description || "-"}${meaning ? `\n  해석: ${meaning}` : ""}`;
    })
    .join("\n");
}

function candidateHeader(candidate = {}) {
  return `지원자: ${candidate.name || "(이름 미입력)"}\n지원 직무: ${candidate.jobRole || "(미입력)"}${
    candidate.jobDescription ? `\n직무 설명/요구역량: ${candidate.jobDescription}` : ""
  }`;
}

// ---------- 기능 ----------

export async function generateFollowUp({ candidate, scales, turns, current }) {
  const system = `당신은 구조화 면접(행동사건면접, BEI) 전문가입니다. 면접자의 방금 답변을 보고, 면접관이 즉석에서 이어 물어볼 꼬리질문을 제안합니다.
꼬리질문 원칙:
- 답변에서 모호하거나 빠진 부분(STAR의 상황·과제·행동·결과, 본인의 실제 기여, 수치, 감정·판단 근거)을 파고드세요.
- 인성 질문이면 인성검사 척도와 관련된 행동 증거를 끌어내는 질문을, 직무 질문이면 실제 역량·전문성의 깊이를 검증하는 질문을 우선하세요.
- 답변이 연습된 모범답안처럼 보이면 구체적 장면을 묻는 질문으로 진위를 확인하세요.
- 이미 앞에서 물어본 내용은 반복하지 마세요.
- 질문은 면접관이 그대로 읽을 수 있게 짧고 자연스러운 존댓말 구어체로 쓰세요.
${COMMON_RULES}`;

  const user = `${candidateHeader(candidate)}

[인성검사 척도 (참고용)]
${formatScales(scales, {})}

[지금까지의 면접 기록]
${formatTranscript(turns)}

[방금 진행한 질문] (${TYPE_LABEL[current.type] ?? "기타"})
질문: ${current.question}
답변: ${current.answer}

위 답변을 분석하고 꼬리질문을 제안하세요.`;

  return callStructured({ system, user, schema: followUpSchema, effort: "low", maxTokens: 8000 });
}

export async function generateJobQuestions({ candidate, count = 6 }) {
  const system = `당신은 채용 직무면접 질문 설계 전문가입니다. 주어진 직무에 맞춘 행동·상황 기반 직무면접 질문을 만듭니다.
- 실제 업무 상황, 핵심 역량, 전문 지식 깊이를 검증할 수 있는 질문을 만드세요.
- 신입/경력 구분이 없다면 둘 다 답할 수 있도록 경험 또는 가정 상황으로 물어보세요.
${COMMON_RULES}`;
  const user = `${candidateHeader(candidate)}

이 직무에 맞는 직무면접 질문 ${Math.min(Math.max(Number(count) || 6, 3), 12)}개를 만들어 주세요.`;
  return callStructured({ system, user, schema: jobQuestionsSchema, effort: "low", maxTokens: 8000 });
}

export async function analyzeInterview({ candidate, testName, scales, scores, testReport, turns }) {
  const system = `당신은 인성검사 해석과 면접 평가에 모두 능숙한 산업·조직심리 전문가입니다.
면접 기록 전체를 분석해 이 사람이 어떤 사람인지 정리하고, 인성검사 결과와 척도별로 비교합니다.
분석 원칙:
- 인성검사는 자기보고식이므로 사회적 바람직성 편향이 있을 수 있고, 면접 답변은 준비된 답변일 수 있습니다. 두 자료가 어긋나면 어느 쪽이 맞다고 단정하지 말고 가능한 해석과 확인 방법을 제시하세요.
- 척도별 면접 추정은 그 척도와 관련된 행동 증거가 답변에 있을 때만 하세요. 관련 증거가 없으면 interview_level 과 consistency 를 "판단불가"로 하세요.
- 검사점수가 "미입력"인 척도는 consistency 를 "판단불가"로 하되 면접 기반 추정은 해 주세요.
- consistency 판단: 검사점수를 점수범위 안에서 상대적 위치로 보고 면접 추정 수준과 비교하세요.
- 근거(evidence)는 실제 답변에서 짧게 인용하세요.
- 추천 의견은 면접 내용에 근거한 참고 의견입니다.
${COMMON_RULES}`;

  const user = `${candidateHeader(candidate)}

[인성검사: ${testName || "인성검사"}]
${formatScales(scales, scores)}
${testReport ? `\n[인성검사 보고서 원문/메모]\n${testReport}\n` : ""}
[면접 기록]
${formatTranscript(turns)}

위 자료로 종합 분석 보고서를 작성하세요. scale_comparison 에는 위 척도를 모두 같은 순서로 포함하세요.`;

  return callStructured({ system, user, schema: analysisSchema, effort: "high", maxTokens: 16000 });
}
