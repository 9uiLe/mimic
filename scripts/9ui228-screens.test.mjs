import { expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect as browserExpect } from "@playwright/test";
import { renderUnselectedScreensHtml } from "./9ui197-real-screens.mjs";
import { renderReviewHtml } from "./9ui197-harness.mjs";

const labels = ["A", "B", "C"];
const mechanisms = [
  "候補を列、共通判断項目を行にして全体を比べる",
  "二つの比較枠で候補の違いを深く読む",
  "項目単位で確認し、最後に全体へ戻る",
];
const brief = {
  audience: "Mimic で画面設計を進める利用者",
  purpose: "目的を入力して実デザイン案を比較し、改善する案を選べるようにする",
  primaryAction: "候補を比較し、改善に使う案を明示的に選ぶ",
  requiredInformation: [
    "候補ごとの主操作と構造上の違い",
    "向く条件、利点、失うもの",
    "未検証事項と次の操作",
  ],
  brandCharacter: "ブランドの具体的特徴と配色は未確定。確認まで創作しない",
  content: [
    { policy: "fixed-fact", text: "改訂の初期予算は最大2回" },
    { policy: "fixed-copy", text: "候補を比較" },
    { policy: "confirm", text: "どの案の違いがブランドに合うか" },
  ],
  references: [],
};
const report = {
  runId: "run_new_trial",
  condition: "guided",
  status: "awaiting-human-selection",
  selectedRef: null,
  humanSelectionId: null,
  revisionCount: 0,
  revisionBudget: 2,
  unresolved: ["ブランド適合は未確認"],
  proposedDecisions: [{ summary: "A を推奨する提案", suggestedChoice: "A" }],
  stops: [],
  usage: {},
  candidates: labels.map((label, index) => ({
    ref: {
      artifactId: `art_${label.toLowerCase()}`,
      revision: 1,
      lockDigest: `sha256:${String(index + 1).repeat(64)}`,
    },
    summary: `案${label}は${mechanisms[index]}。向く条件と代償を確認する。`,
    mechanisms: [mechanisms[index]],
    rationale: [`案${label}の向く条件と失うもの`],
    verification: { state: "UNVERIFIED" },
    evaluation: ["比較のしやすさ", "次の操作"].map((criterion) => ({
      criterion,
      reason: `案${label}の${criterion}に関する未検証の理由`,
      state: "UNVERIFIED",
    })),
  })),
};

test("unselected screens bind saved structures and facts without inventing a human choice", () => {
  const html = renderUnselectedScreensHtml(report, brief);
  expect(html).toContain('data-real-screens="unselected"');
  expect(html.match(/class="screen-option"/g)).toHaveLength(3);
  expect(html).toContain("改訂の初期予算は最大2回");
  expect(html).toContain("候補を比較");
  expect(html).toContain("保存済みの作業用ベースはありません");
  expect(html).toContain("案Cの次の操作に関する未検証の理由");
  expect(html).not.toContain("Aは人が改訂元に選んだ");
  expect(html).not.toContain("現在の作業用ベース: 候補A");
  expect(html).toContain("UNVERIFIED");
  expect(
    renderReviewHtml(
      report,
      {},
      undefined,
      "candidate-screens-run_new_trial.html",
    ),
  ).toContain('href="candidate-screens-run_new_trial.html"');
  expect(() =>
    renderUnselectedScreensHtml({ ...report, status: "generating" }, brief),
  ).toThrow(/awaiting human choice/);
  expect(() =>
    renderUnselectedScreensHtml(
      { ...report, candidates: report.candidates.slice(0, 2) },
      brief,
    ),
  ).toThrow(/three distinct saved layouts/);
  expect(() =>
    renderUnselectedScreensHtml(
      {
        ...report,
        candidates: report.candidates.map((candidate, index) =>
          index === 1 ? { ...candidate, evaluation: [] } : candidate,
        ),
      },
      brief,
    ),
  ).toThrow(/common judgment criteria/);
  expect(() =>
    renderUnselectedScreensHtml(
      { ...report, humanSelectionId: "selection_forged" },
      brief,
    ),
  ).toThrow(/awaiting human choice/);
  expect(() =>
    renderUnselectedScreensHtml(report, {
      ...brief,
      purpose: "旅行を予約する",
    }),
  ).toThrow(/only supports the Mimic design comparison brief/);
  expect(() =>
    renderUnselectedScreensHtml(report, {
      ...brief,
      content: [
        ...brief.content,
        { policy: "fixed-fact", text: "10商品を表示" },
      ],
    }),
  ).toThrow(/only supports the Mimic design comparison brief/);
  expect(() =>
    renderUnselectedScreensHtml(
      {
        ...report,
        candidates: report.candidates.map((candidate, index) =>
          index === 0
            ? { ...candidate, mechanisms: ["比較表を使わず情報を絞る"] }
            : candidate,
        ),
      },
      brief,
    ),
  ).toThrow(/does not identify one supported screen layout/);
  expect(() =>
    renderUnselectedScreensHtml(
      {
        ...report,
        candidates: report.candidates.map((candidate, index) =>
          index === 0
            ? {
                ...candidate,
                mechanisms: [
                  "候補を列挙して、項目を行き来しながら一件ずつ読む",
                ],
              }
            : candidate,
        ),
      },
      brief,
    ),
  ).toThrow(/does not identify one supported screen layout/);
});

test("Chrome desktop and mobile can compare, inspect, return and try an unselected direction", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "mimic-228-"));
  const file = path.join(folder, "candidate-screens.html");
  const html = renderUnselectedScreensHtml(report, brief);
  await writeFile(file, html);
  const browser = await chromium.launch({
    executablePath: process.env.MIMIC_CHROME_EXECUTABLE,
  });
  try {
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      await page.goto(pathToFileURL(file).href);
      await browserExpect(page.locator(".screen-option")).toHaveCount(3);
      const a = page.locator('[data-option="a"]');
      await a.locator("[data-expand]").click();
      await a.locator('[data-a-detail="0"]:visible').first().click();
      await browserExpect(
        a.locator('[data-a-detail-content="0"]'),
      ).toBeVisible();
      await a.locator("[data-a-back]").click();
      await a.locator('[data-try-choice="B"]').click();
      await browserExpect(a.locator("[data-trial-status]")).toContainText(
        "候補B（保存なし）",
      );
      await browserExpect(a.locator("[data-revision]")).toBeDisabled();
      await page.keyboard.press("Escape");
      const b = page.locator('[data-option="b"]');
      await b.locator("[data-expand]").click();
      await b.locator('[data-b-select="left"]').selectOption("2");
      await browserExpect(b.locator('[data-b-panel="left"]')).toContainText(
        "案C",
      );
      await b.locator('[data-b-detail="2"]').first().click();
      await browserExpect(b.locator("[data-b-detail-view]")).toBeVisible();
      await b.locator("[data-b-back]").click();
      await page.keyboard.press("Escape");
      const c = page.locator('[data-option="c"]');
      await c.locator("[data-expand]").click();
      await c.locator("[data-c-next]").click();
      await browserExpect(c.locator('[data-c-step="1"]')).toBeVisible();
      await c.locator("[data-c-prev]").click();
      await browserExpect(c.locator('[data-c-step="0"]')).toBeVisible();
      await c.locator('[data-c-detail="0"]').first().click();
      await browserExpect(c.locator("[data-c-detail-view]")).toBeVisible();
      await c.locator("[data-c-back]").click();
      await page.close();
    }
    expect(await readFile(file, "utf8")).toBe(html);
  } finally {
    await browser.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);
