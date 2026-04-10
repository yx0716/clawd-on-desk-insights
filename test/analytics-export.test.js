const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildSessionAnalysesExportMarkdown,
  makeSessionAnalysesExportFilename,
} = require("../src/analytics-export");

describe("analytics export", () => {
  it("builds markdown for multiple session analyses", () => {
    const text = buildSessionAnalysesExportMarkdown({
      exportedAt: "2026-04-10T16:00:00.000Z",
      providerLabel: "Codex",
      sessions: [
        {
          sessionId: "sess-1",
          title: "修复 dashboard 布局",
          agentLabel: "Codex",
          project: "clawd-on-desk",
          timeRange: "10:02-10:48",
          activeSpan: "31m",
          briefAnalysis: {
            summary: "把双栏布局和 provider 交互都收顺了",
            keyTopics: ["布局", "provider"],
            outcomes: [{ headline: "修布局", detail: "默认打开时卡片直接并列" }],
          },
          detailAnalysis: {
            summary: "把 dashboard 布局、provider 选择和提示文案都理顺了",
            keyTopics: ["布局", "缓存", "引导"],
            outcomes: [{ headline: "稳交互", detail: "切 provider 不再迷惑用户" }],
            timeBreakdown: [{ activity: "整理 provider 行为", percent: 55 }],
            suggestions: ["把首次引导再做轻一点"],
          },
        },
        {
          sessionId: "sess-2",
          title: "补时间轴提示",
          agentLabel: "Claude Code",
          briefAnalysis: { summary: "补上时间轴操作提示" },
          detailAnalysis: { summary: "增加滚轮缩放和左右键平移提醒" },
        },
      ],
    });

    assert.match(text, /# Session AI 分析导出/);
    assert.match(text, /- Provider：Codex/);
    assert.match(text, /## 1\. 修复 dashboard 布局/);
    assert.match(text, /### 速览/);
    assert.match(text, /### 深入分析/);
    assert.match(text, /修布局：默认打开时卡片直接并列/);
    assert.match(text, /时间分布/);
    assert.match(text, /整理 provider 行为 55%/);
    assert.match(text, /## 2\. 补时间轴提示/);
  });

  it("builds a stable default export filename", () => {
    const name = makeSessionAnalysesExportFilename(new Date("2026-04-10T08:30:00.000Z"));
    assert.strictEqual(name, "clawd-session-analyses-20260410.md");
  });
});
