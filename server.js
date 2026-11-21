import express from "express";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateFollowUp, generateJobQuestions, analyzeInterview, AIError } from "./lib/ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "public")));

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

// 질문 은행 + 인성검사 척도 설정
app.get("/api/config", async (_req, res, next) => {
  try {
    const [questions, scales] = await Promise.all([
      readJson(path.join(DATA_DIR, "questions.json")),
      readJson(path.join(DATA_DIR, "personality-scales.json")),
    ]);
    res.json({ questions, testName: scales.testName, scales: scales.scales });
  } catch (err) {
    next(err);
  }
});

function requireFields(body, fields) {
  const missing = fields.filter((f) => body?.[f] === undefined || body?.[f] === null || body?.[f] === "");
  if (missing.length) throw new AIError(`필수 항목 누락: ${missing.join(", ")}`, 400);
}

// 방금 답변에 대한 꼬리질문 생성
app.post("/api/followup", async (req, res, next) => {
  try {
    requireFields(req.body, ["current"]);
    const { current } = req.body;
    requireFields(current, ["question", "answer"]);
    res.json(
      await generateFollowUp({
        candidate: req.body.candidate ?? {},
        scales: req.body.scales ?? [],
        turns: req.body.turns ?? [],
        current,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// 지원 직무 맞춤 직무면접 질문 생성
app.post("/api/job-questions", async (req, res, next) => {
  try {
    requireFields(req.body?.candidate, ["jobRole"]);
    res.json(await generateJobQuestions(req.body));
  } catch (err) {
    next(err);
  }
});

// 면접 종합 분석 + 인성검사 비교
app.post("/api/analyze", async (req, res, next) => {
  try {
    const turns = (req.body?.turns ?? []).filter((t) => t.answer?.trim());
    if (!turns.length) throw new AIError("답변이 기록된 질문이 없습니다.", 400);
    res.json(await analyzeInterview({ ...req.body, turns }));
  } catch (err) {
    next(err);
  }
});

// 면접 세션 저장 / 목록 / 불러오기 (data/sessions/*.json)
const SESSION_ID = /^[a-zA-Z0-9-]{1,64}$/;

app.post("/api/sessions", async (req, res, next) => {
  try {
    const id = SESSION_ID.test(req.body?.id ?? "") ? req.body.id : randomUUID();
    const session = { ...req.body, id, savedAt: new Date().toISOString() };
    await mkdir(SESSIONS_DIR, { recursive: true });
    await writeFile(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify(session, null, 2));
    res.json({ id, savedAt: session.savedAt });
  } catch (err) {
    next(err);
  }
});

app.get("/api/sessions", async (_req, res, next) => {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".json"));
    const list = await Promise.all(
      files.map(async (f) => {
        const s = await readJson(path.join(SESSIONS_DIR, f));
        return { id: s.id, name: s.candidate?.name, jobRole: s.candidate?.jobRole, savedAt: s.savedAt, analyzed: !!s.analysis };
      }),
    );
    res.json(list.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? "")));
  } catch (err) {
    next(err);
  }
});

app.get("/api/sessions/:id", async (req, res, next) => {
  try {
    if (!SESSION_ID.test(req.params.id)) throw new AIError("잘못된 세션 ID", 400);
    res.json(await readJson(path.join(SESSIONS_DIR, `${req.params.id}.json`)));
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "세션을 찾을 수 없습니다." });
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  const status = err instanceof AIError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err instanceof AIError ? err.message : "서버 오류가 발생했습니다." });
});

app.listen(PORT, () => {
  console.log(`HR 면접 프로그램: http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("⚠ ANTHROPIC_API_KEY 가 설정되지 않았습니다. .env 파일에 키를 넣어 주세요. (README 참고)");
  }
});
