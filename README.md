# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/KITLAB13/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/KITLAB13/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast Markdown-to-HTML renderer written in TypeScript with a single-file entrypoint (main.ts), built by an AI agent for make.fun's "Make Markdown rendering faster" bounty.

## Run it

```sh
node main.ts
```

## How it works

`parse.js` is a dependency-free, single-file renderer whose output is byte-identical to marked 18.1.3 with default options. A line-oriented block parser strips blockquote/list containers column-wise (so tabs keep their true tab-stop positions), collects link reference definitions in a document pre-pass, and dispatches leaf blocks on their first line. Inline content is rendered by a character scanner — no backtracking regexes in the hot path — covering code spans, links and images, tables, task lists, and GFM extended autolinks. Emphasis follows the reference's regex-style strong/emphasis matching model, which observably differs from the CommonMark delimiter-stack algorithm in nested cases. `parse()` is pure: no state is shared between calls, and identical input always produces identical output.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
