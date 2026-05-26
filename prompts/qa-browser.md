---
description: Run browser QA with agentx-browser tools, recording, screenshots, logs, and final findings.
argument-hint: "<url-or-task> [extra instructions]"
---
Use `/skill:agentx-browser-qa` behavior for this task.

Run browser QA for: $@

Default execution policy:
- use `agentx-browser` tools, not generic browser tooling
- run headless by default
- use headed mode only if user explicitly asks or visual/manual debugging is necessary
- if switching between headless and headed, close existing browser sessions first so daemon restarts in correct mode
- start `browser_qa_record` unless user explicitly says not to record
- default recording output: `qa-recordings`
- stop recording at end and prefer `transcode: "mp4"`
- take screenshots for notable states and failures
- inspect console, page errors, and relevant network failures
- provide concise final QA report with:
  - scenario tested
  - pass/fail
  - repro steps
  - findings
  - artifact paths
  - console/errors/network highlights

If input is URL, open it and perform exploratory QA unless user narrowed scope.
If input is task/flow, test that flow end-to-end.
Ask only for missing critical info such as auth path, environment, or destructive-action approval.
