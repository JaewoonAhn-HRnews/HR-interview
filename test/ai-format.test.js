import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTranscript, formatScales } from "../lib/ai.js";

test("formatTranscript labels follow-up questions and empty answers", () => {
  const out = formatTranscript([
    { type: "personality", question: "Q1", answer: "A1" },
    { type: "job", question: "Q2", answer: "", isFollowUp: true },
  ]);
  assert.match(out, /\[1\] \(인성\) 질문: Q1\n    답변: A1/);
  assert.match(out, /\[2\] \(직무·꼬리질문\) 질문: Q2\n    답변: \(답변 없음\)/);
  assert.equal(formatTranscript([]), "(아직 진행된 질문 없음)");
});

test("formatScales shows score or 미입력, including zero scores", () => {
  const scales = [
    { id: "a", name: "성실성", min: 0, max: 10, description: "d", high: "h", low: "l" },
    { id: "b", name: "협조성", min: 1, max: 10 },
  ];
  const out = formatScales(scales, { a: 0 });
  assert.match(out, /id=a \| 성실성 \(점수범위 0~10\) \| 검사점수: 0/);
  assert.match(out, /높으면: h \/ 낮으면: l/);
  assert.match(out, /id=b .*검사점수: 미입력/);
});
