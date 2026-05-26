import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_SCREENSHOT_FORMAT = "png";

const GLOBAL_OPTIONS_SCHEMA = Type.Optional(Type.Object({
  session: Type.Optional(Type.String({ description: "agent-browser --session value for isolated browser state." })),
  sessionName: Type.Optional(Type.String({ description: "agent-browser --session-name value for cookie/localStorage persistence." })),
  profile: Type.Optional(Type.String({ description: "Chrome profile name or path." })),
  state: Type.Optional(Type.String({ description: "Auth state JSON path to load." })),
  headed: Type.Optional(Type.Boolean({ description: "Show browser window." })),
  provider: Type.Optional(Type.String({ description: "Browser provider name: ios, browserbase, kernel, browseruse, browserless, agentcore." })),
  cdp: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "CDP port or URL." })),
  executablePath: Type.Optional(Type.String()),
  userAgent: Type.Optional(Type.String()),
  proxy: Type.Optional(Type.String()),
  proxyBypass: Type.Optional(Type.String()),
  ignoreHttpsErrors: Type.Optional(Type.Boolean()),
  allowFileAccess: Type.Optional(Type.Boolean()),
  colorScheme: Type.Optional(StringEnum(["dark", "light", "no-preference"] as const)),
  downloadPath: Type.Optional(Type.String()),
  screenshotDir: Type.Optional(Type.String()),
  screenshotFormat: Type.Optional(StringEnum(["png", "jpeg"] as const)),
  screenshotQuality: Type.Optional(Type.Number()),
  allowedDomains: Type.Optional(Type.Array(Type.String())),
  contentBoundaries: Type.Optional(Type.Boolean()),
  maxOutput: Type.Optional(Type.Number({ description: "agent-browser --max-output chars." })),
  json: Type.Optional(Type.Boolean({ description: "Request JSON output from agent-browser when command supports it." })),
  annotate: Type.Optional(Type.Boolean({ description: "Annotate screenshots when supported." })),
  enable: Type.Optional(Type.Array(Type.String({ description: "Built-in feature names, e.g. react-devtools." }))),
  extensions: Type.Optional(Type.Array(Type.String({ description: "Browser extension paths." }))),
  initScripts: Type.Optional(Type.Array(Type.String({ description: "Init script paths." }))),
  launchArgs: Type.Optional(Type.Array(Type.String({ description: "Chromium launch args." }))),
}));

type GlobalOptions = Static<NonNullable<typeof GLOBAL_OPTIONS_SCHEMA>>;

const RUN_SCHEMA = Type.Object({
  args: Type.Array(Type.String(), {
    description: "Exact argv after `agent-browser`. Example: [\"open\", \"https://example.com\"] or [\"snapshot\", \"-i\"]. Prefer this over shell strings.",
  }),
  global: GLOBAL_OPTIONS_SCHEMA,
  timeoutMs: Type.Optional(Type.Number()),
  truncate: Type.Optional(StringEnum(["head", "tail", "none"] as const)),
  maxBytes: Type.Optional(Type.Number({ description: "Context output byte limit before temp-file spill. Default 50KB." })),
  maxLines: Type.Optional(Type.Number({ description: "Context output line limit before temp-file spill. Default 2000." })),
});

type RunParams = Static<typeof RUN_SCHEMA>;

const SNAPSHOT_SCHEMA = Type.Object({
  interactive: Type.Optional(Type.Boolean({ description: "Use snapshot -i. Default true." })),
  compact: Type.Optional(Type.Boolean({ description: "Use snapshot -c." })),
  depth: Type.Optional(Type.Number({ description: "Use snapshot -d <n>." })),
  selector: Type.Optional(Type.String({ description: "Use snapshot -s <selector>." })),
  global: GLOBAL_OPTIONS_SCHEMA,
  timeoutMs: Type.Optional(Type.Number()),
  maxBytes: Type.Optional(Type.Number()),
  maxLines: Type.Optional(Type.Number()),
});

type SnapshotParams = Static<typeof SNAPSHOT_SCHEMA>;

const SCREENSHOT_SCHEMA = Type.Object({
  path: Type.Optional(Type.String({ description: "Output image path. If omitted, extension creates temp file." })),
  full: Type.Optional(Type.Boolean({ description: "Capture full page with --full when supported." })),
  inline: Type.Optional(Type.Boolean({ description: "Return image content inline to Pi. Default true." })),
  global: GLOBAL_OPTIONS_SCHEMA,
  timeoutMs: Type.Optional(Type.Number()),
});

type ScreenshotParams = Static<typeof SCREENSHOT_SCHEMA>;

const BATCH_SCHEMA = Type.Object({
  commands: Type.Array(Type.Array(Type.String()), {
    description: "List of exact agent-browser argv arrays. Example: [[\"open\", \"https://example.com\"], [\"snapshot\", \"-i\"]].",
  }),
  bail: Type.Optional(Type.Boolean({ description: "Stop on first failing command." })),
  global: GLOBAL_OPTIONS_SCHEMA,
  timeoutMs: Type.Optional(Type.Number()),
  truncate: Type.Optional(StringEnum(["head", "tail", "none"] as const)),
  maxBytes: Type.Optional(Type.Number()),
  maxLines: Type.Optional(Type.Number()),
});

type BatchParams = Static<typeof BATCH_SCHEMA>;

const SKILL_SCHEMA = Type.Object({
  action: StringEnum(["list", "get"] as const),
  name: Type.Optional(Type.String({ description: "Skill name for action=get, e.g. core, electron, slack, vercel-sandbox, agentcore." })),
  full: Type.Optional(Type.Boolean({ description: "Pass --full for complete docs." })),
  timeoutMs: Type.Optional(Type.Number()),
  maxBytes: Type.Optional(Type.Number()),
  maxLines: Type.Optional(Type.Number()),
});

type SkillParams = Static<typeof SKILL_SCHEMA>;

const QA_RECORD_SCHEMA = Type.Object({
  action: StringEnum(["start", "stop", "status"] as const),
  name: Type.Optional(Type.String({ description: "Recording basename. Default qa-session-<timestamp>." })),
  outputDir: Type.Optional(Type.String({ description: "Directory for QA recordings. Default <cwd>/qa-recordings." })),
  url: Type.Optional(Type.String({ description: "Optional URL passed to `agent-browser record start <path> <url>`." })),
  transcode: Type.Optional(StringEnum(["none", "mp4", "gif", "both"] as const)),
  global: GLOBAL_OPTIONS_SCHEMA,
  timeoutMs: Type.Optional(Type.Number()),
});

type QaRecordParams = Static<typeof QA_RECORD_SCHEMA>;

type QaRecordingState = {
  webmPath: string;
  outputDir: string;
  name: string;
  startedAt: string;
  global?: GlobalOptions;
};

type ExecResult = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  killed?: boolean;
};

type AgentBrowserExecTarget = {
  command: string;
  prefixArgs: string[];
};

let cachedAgentBrowserExecTarget: AgentBrowserExecTarget | undefined;

function parseCommandLine(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const ch of input.trim()) {
    if (escaping) {
      cur += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }

  if (escaping) cur += "\\";
  if (quote) throw new Error(`Unclosed quote in command: ${input}`);
  if (cur.length > 0) out.push(cur);
  return out;
}

function buildGlobalArgs(global?: GlobalOptions): string[] {
  if (!global) return [];
  const args: string[] = [];
  const add = (flag: string, value?: string | number | boolean) => {
    if (value === undefined || value === false) return;
    args.push(flag);
    if (value !== true) args.push(String(value));
  };
  const addMany = (flag: string, values?: string[]) => {
    for (const value of values ?? []) add(flag, value);
  };

  add("--session", global.session);
  add("--session-name", global.sessionName);
  add("--profile", global.profile);
  add("--state", global.state);
  add("--headed", global.headed);
  add("-p", global.provider);
  add("--cdp", global.cdp);
  add("--executable-path", global.executablePath);
  add("--user-agent", global.userAgent);
  add("--proxy", global.proxy);
  add("--proxy-bypass", global.proxyBypass);
  add("--ignore-https-errors", global.ignoreHttpsErrors);
  add("--allow-file-access", global.allowFileAccess);
  add("--color-scheme", global.colorScheme);
  add("--download-path", global.downloadPath);
  add("--screenshot-dir", global.screenshotDir);
  add("--screenshot-format", global.screenshotFormat);
  add("--screenshot-quality", global.screenshotQuality);
  add("--allowed-domains", global.allowedDomains?.join(","));
  add("--content-boundaries", global.contentBoundaries);
  add("--max-output", global.maxOutput);
  add("--json", global.json);
  add("--annotate", global.annotate);
  addMany("--enable", global.enable);
  addMany("--extension", global.extensions);
  addMany("--init-script", global.initScripts);
  if (global.launchArgs?.length) add("--args", global.launchArgs.join(","));
  return args;
}

function outputFile(content: string, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agentx-browser-${prefix}-`));
  const file = join(dir, "output.txt");
  writeFileSync(file, content, "utf8");
  return file;
}

function tempScreenshotPath(format = DEFAULT_SCREENSHOT_FORMAT): string {
  const dir = mkdtempSync(join(tmpdir(), "agentx-browser-shot-"));
  return join(dir, `screenshot.${format === "jpeg" ? "jpg" : "png"}`);
}

function normalizeMaybeRelativePath(cwd: string, path: string): string {
  return resolve(cwd, path.replace(/^@(?=[A-Za-z]:|[\\/]|\.)/, ""));
}

function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeBasename(name: string): string {
  return name.replace(/[^a-z0-9_.-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "qa-session";
}

function actionName(argv: string[]): string {
  const first = argv.find((arg) => !arg.startsWith("-"));
  return first ?? "unknown";
}

function summarizeResult(stdout: string, stderr: string): string {
  if (stdout && stderr) return `${stdout.trim()}\n\n[stderr]\n${stderr.trim()}`.trim();
  return (stdout || stderr || "").trim();
}

function truncateOutput(text: string, opts: { truncate?: "head" | "tail" | "none"; maxBytes?: number; maxLines?: number; label: string }) {
  if (opts.truncate === "none") return { text, truncated: false, file: undefined as string | undefined };
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const truncation = opts.truncate === "tail"
    ? truncateTail(text, { maxBytes, maxLines })
    : truncateHead(text, { maxBytes, maxLines });
  if (!truncation.truncated) return { text: truncation.content, truncated: false, file: undefined as string | undefined };

  const file = outputFile(text, opts.label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 24) || "output");
  let result = truncation.content;
  result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
  result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  result += ` Full output saved to: ${file}]`;
  return { text: result, truncated: true, file };
}

function formatFailure(argv: string[], result: ExecResult): string {
  const raw = summarizeResult(result.stdout ?? "", result.stderr ?? "");
  const failure = raw || (result.killed ? "Command killed" : `Command exited with code ${result.code ?? "unknown"}`);
  const truncated = truncateOutput(failure, { truncate: "tail", maxBytes: 12_000, maxLines: 300, label: "error" });
  return `agent-browser ${argv.join(" ")} failed (${result.code ?? "unknown"})\n${truncated.text}`.trim();
}

function quoteBatchArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return JSON.stringify(arg);
}

function batchCommandString(args: string[]): string {
  return args.map(quoteBatchArg).join(" ");
}

async function resolveAgentBrowserExecTarget(pi: ExtensionAPI): Promise<AgentBrowserExecTarget> {
  if (cachedAgentBrowserExecTarget) return cachedAgentBrowserExecTarget;
  if (process.platform !== "win32") {
    cachedAgentBrowserExecTarget = { command: "agent-browser", prefixArgs: [] };
    return cachedAgentBrowserExecTarget;
  }

  const whereResult = await pi.exec("where", ["agent-browser"], { timeout: 5_000 }) as ExecResult;
  const firstHit = (whereResult.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (firstHit) {
    const binDir = dirname(firstHit);
    const nodePath = join(binDir, "node.exe");
    const cliPath = join(binDir, "node_modules", "agent-browser", "bin", "agent-browser.js");
    if (existsSync(nodePath) && existsSync(cliPath)) {
      cachedAgentBrowserExecTarget = { command: nodePath, prefixArgs: [cliPath] };
      return cachedAgentBrowserExecTarget;
    }
  }

  cachedAgentBrowserExecTarget = { command: "cmd.exe", prefixArgs: ["/d", "/s", "/c", "agent-browser"] };
  return cachedAgentBrowserExecTarget;
}

async function execAgentBrowser(
  pi: ExtensionAPI,
  argv: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<ExecResult> {
  const target = await resolveAgentBrowserExecTarget(pi);
  return pi.exec(target.command, [...target.prefixArgs, ...argv], {
    signal,
    timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }) as Promise<ExecResult>;
}

async function runAgentBrowser(
  pi: ExtensionAPI,
  commandArgs: string[],
  global: GlobalOptions | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<{ argv: string[]; result: ExecResult }> {
  const argv = [...buildGlobalArgs(global), ...commandArgs];
  const result = await execAgentBrowser(pi, argv, signal, timeoutMs);
  if (result.code !== 0) throw new Error(formatFailure(argv, result));
  return { argv, result };
}

function renderCompact(name: string, args: unknown, theme: any) {
  const serialized = typeof args === "object" && args !== null
    ? JSON.stringify(args).slice(0, 180)
    : String(args ?? "");
  return new Text(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", serialized)}`, 0, 0);
}

function renderTextResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any) {
  if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
  const details = result.details ?? {};
  const content = result.content?.find?.((part: any) => part.type === "text")?.text ?? "";
  if (details.screenshotPath) return new Text(theme.fg("success", `Screenshot: ${details.screenshotPath}`), 0, 0);
  if (details.action === "snapshot") {
    const count = details.refCount ?? 0;
    let text = theme.fg("success", `${count} refs`);
    if (details.truncated) text += theme.fg("warning", " (truncated)");
    if (expanded) text += "\n" + theme.fg("dim", content);
    return new Text(text, 0, 0);
  }
  if (expanded) return new Text(theme.fg("dim", content || "(no output)"), 0, 0);
  const firstLine = (content || "(no output)").split("\n")[0];
  return new Text(theme.fg("dim", firstLine + (content.includes("\n") ? "…" : "")), 0, 0);
}

function textContent(text: string) {
  return [{ type: "text" as const, text: text || "(no output)" }];
}

async function toolRun(pi: ExtensionAPI, params: RunParams, signal: AbortSignal | undefined) {
  const { argv, result } = await runAgentBrowser(pi, params.args, params.global, signal, params.timeoutMs);
  const raw = summarizeResult(result.stdout ?? "", result.stderr ?? "");
  const action = actionName(params.args);
  const truncated = truncateOutput(raw, {
    truncate: params.truncate,
    maxBytes: params.maxBytes,
    maxLines: params.maxLines,
    label: action,
  });
  return {
    content: textContent(truncated.text),
    details: { argv, action, exitCode: result.code, truncated: truncated.truncated, fullOutputPath: truncated.file },
  };
}

async function transcodeRecording(pi: ExtensionAPI, webmPath: string, mode: "none" | "mp4" | "gif" | "both", signal: AbortSignal | undefined) {
  const outputs: Record<string, string> = { webm: webmPath };
  if (mode === "none") return outputs;

  const ffmpegCheck = await pi.exec("ffmpeg", ["-version"], { signal, timeout: 10_000 }) as ExecResult;
  if (ffmpegCheck.code !== 0) {
    throw new Error("ffmpeg not found. Install ffmpeg and ensure it is on PATH to transcode QA recordings.");
  }

  if (mode === "mp4" || mode === "both") {
    const mp4Path = webmPath.replace(/\.webm$/i, ".mp4");
    const mp4 = await pi.exec("ffmpeg", [
      "-y",
      "-i", webmPath,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      mp4Path,
    ], { signal, timeout: 300_000 }) as ExecResult;
    if (mp4.code !== 0) throw new Error(formatFailure(["ffmpeg", "mp4", webmPath], mp4));
    outputs.mp4 = mp4Path;
  }

  if (mode === "gif" || mode === "both") {
    const gifPath = webmPath.replace(/\.webm$/i, ".gif");
    const gif = await pi.exec("ffmpeg", [
      "-y",
      "-i", webmPath,
      "-vf", "fps=12,scale=1280:-1:flags=lanczos",
      gifPath,
    ], { signal, timeout: 300_000 }) as ExecResult;
    if (gif.code !== 0) throw new Error(formatFailure(["ffmpeg", "gif", webmPath], gif));
    outputs.gif = gifPath;
  }

  return outputs;
}

async function toolScreenshot(pi: ExtensionAPI, params: ScreenshotParams, signal: AbortSignal | undefined, cwd: string) {
  const format = params.global?.screenshotFormat ?? DEFAULT_SCREENSHOT_FORMAT;
  const screenshotPath = params.path ? normalizeMaybeRelativePath(cwd, params.path) : tempScreenshotPath(format);
  const args = ["screenshot"];
  if (params.full) args.push("--full");
  args.push(screenshotPath);

  const { argv, result } = await runAgentBrowser(pi, args, params.global, signal, params.timeoutMs);
  const output = summarizeResult(result.stdout ?? "", result.stderr ?? "");
  const content = textContent(output || `Screenshot saved: ${screenshotPath}`);
  const inline = params.inline ?? true;
  if (inline) {
    const imageData = readFileSync(screenshotPath);
    const ext = extname(screenshotPath).toLowerCase();
    const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    content.push({ type: "image" as const, data: imageData.toString("base64"), mimeType } as any);
  }
  return {
    content,
    details: { argv, action: "screenshot", screenshotPath, inline, exitCode: result.code },
  };
}

export default function agentxBrowser(pi: ExtensionAPI) {
  let currentQaRecording: QaRecordingState | undefined;

  pi.registerTool({
    name: "browser_run",
    label: "Browser Run",
    description: "Run any agent-browser CLI command using exact argv array. Prefer for robust browser automation; no shell splitting. Supports global agent-browser flags, truncation, sessions, profiles, auth state, providers, React devtools, console/network/debug commands.",
    promptSnippet: "Run precise agent-browser commands with argv arrays for browser automation.",
    promptGuidelines: [
      "Use browser_run for arbitrary agent-browser commands; pass exact args arrays, not shell command strings.",
      "Use browser_snapshot before clicking refs, and re-snapshot after navigation or dynamic UI changes.",
      "Use browser_batch for multi-step setup like open plus route/cookies/init scripts in one browser turn.",
    ],
    parameters: RUN_SCHEMA,
    prepareArguments(args: any) {
      if (args?.command && !args.args) return { ...args, args: parseCommandLine(args.command) };
      return args;
    },
    renderCall(args: RunParams, theme: any) { return renderCompact("browser_run", args.args, theme); },
    renderResult: renderTextResult,
    async execute(_id, params, signal) {
      return toolRun(pi, params, signal);
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Take agent-browser accessibility snapshot. Defaults to interactive refs (-i). Use before clicking @refs and after page changes.",
    promptSnippet: "Capture accessibility tree refs from current browser page.",
    promptGuidelines: ["Use browser_snapshot before interactions that depend on @refs."],
    parameters: SNAPSHOT_SCHEMA,
    renderCall(args: SnapshotParams, theme: any) { return renderCompact("browser_snapshot", args, theme); },
    renderResult: renderTextResult,
    async execute(_id, params, signal) {
      const args = ["snapshot"];
      if (params.interactive ?? true) args.push("-i");
      if (params.compact) args.push("-c");
      if (params.depth !== undefined) args.push("-d", String(params.depth));
      if (params.selector) args.push("-s", params.selector);
      const { argv, result } = await runAgentBrowser(pi, args, params.global, signal, params.timeoutMs);
      const raw = summarizeResult(result.stdout ?? "", result.stderr ?? "");
      const truncated = truncateOutput(raw, { truncate: "head", maxBytes: params.maxBytes, maxLines: params.maxLines, label: "snapshot" });
      const refCount = (raw.match(/@e\d+/g) ?? []).length;
      return {
        content: textContent(truncated.text),
        details: { argv, action: "snapshot", refCount, truncated: truncated.truncated, fullOutputPath: truncated.file },
      };
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Take screenshot with agent-browser. Creates temp path if omitted and can return inline image to Pi.",
    promptSnippet: "Capture browser screenshot, optionally full-page and inline.",
    parameters: SCREENSHOT_SCHEMA,
    renderCall(args: ScreenshotParams, theme: any) { return renderCompact("browser_screenshot", args.path ?? "temp", theme); },
    renderResult: renderTextResult,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolScreenshot(pi, params, signal, ctx.cwd);
    },
  });

  pi.registerTool({
    name: "browser_batch",
    label: "Browser Batch",
    description: "Run multiple agent-browser commands through `agent-browser batch` using JSON argv arrays. Best for pre-navigation setup, cookies/routes/open/snapshot sequences, and fewer flaky cross-process calls.",
    promptSnippet: "Run multiple agent-browser commands in one batch using argv arrays.",
    promptGuidelines: ["Use browser_batch for sequences that should share browser state and reduce flaky command handoffs."],
    parameters: BATCH_SCHEMA,
    renderCall(args: BatchParams, theme: any) { return renderCompact("browser_batch", `${args.commands.length} commands`, theme); },
    renderResult: renderTextResult,
    async execute(_id, params, signal) {
      const batchArgs = ["batch"];
      if (params.bail) batchArgs.push("--bail");
      for (const command of params.commands) batchArgs.push(batchCommandString(command));
      const { argv, result } = await runAgentBrowser(pi, batchArgs, params.global, signal, params.timeoutMs);
      const raw = summarizeResult(result.stdout ?? "", result.stderr ?? "");
      const truncated = truncateOutput(raw, { truncate: params.truncate, maxBytes: params.maxBytes, maxLines: params.maxLines, label: "batch" });
      return {
        content: textContent(truncated.text),
        details: { argv, action: "batch", count: params.commands.length, truncated: truncated.truncated, fullOutputPath: truncated.file },
      };
    },
  });

  pi.registerTool({
    name: "browser_qa_record",
    label: "Browser QA Record",
    description: "Start/stop/status QA session recording using agent-browser record. On stop, optionally transcode WebM to MP4/GIF with ffmpeg. Use for QA evidence, bug reproduction, and test walkthrough videos.",
    promptSnippet: "Record QA browser sessions and optionally transcode with ffmpeg.",
    promptGuidelines: [
      "Use browser_qa_record action=start before QA walkthroughs when user wants recording evidence.",
      "Use browser_qa_record action=stop when QA flow ends; choose transcode=mp4 for shareable evidence if ffmpeg is installed.",
    ],
    parameters: QA_RECORD_SCHEMA,
    renderCall(args: QaRecordParams, theme: any) { return renderCompact("browser_qa_record", args, theme); },
    renderResult: renderTextResult,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.action === "status") {
        const text = currentQaRecording
          ? `Recording active: ${currentQaRecording.webmPath}\nStarted: ${currentQaRecording.startedAt}`
          : "No QA recording active.";
        return { content: textContent(text), details: { action: "qa-record-status", active: Boolean(currentQaRecording), recording: currentQaRecording } };
      }

      if (params.action === "start") {
        if (currentQaRecording) {
          return {
            content: textContent(`QA recording already active: ${currentQaRecording.webmPath}`),
            details: { action: "qa-record-start", active: true, recording: currentQaRecording },
          };
        }

        const outputDir = normalizeMaybeRelativePath(ctx.cwd, params.outputDir ?? "qa-recordings");
        mkdirSync(outputDir, { recursive: true });
        const name = safeBasename(params.name ?? `qa-session-${timestampSlug()}`);
        const webmPath = join(outputDir, `${name}.webm`);
        const commandArgs = ["record", "start", webmPath];
        if (params.url) commandArgs.push(params.url);
        const { argv, result } = await runAgentBrowser(pi, commandArgs, params.global, signal, params.timeoutMs ?? 30_000);
        const raw = summarizeResult(result.stdout ?? "", result.stderr ?? "");
        currentQaRecording = { webmPath, outputDir, name, startedAt: new Date().toISOString(), global: params.global };
        return {
          content: textContent(raw || `QA recording started: ${webmPath}`),
          details: { argv, action: "qa-record-start", recording: currentQaRecording },
        };
      }

      if (!currentQaRecording) {
        return { content: textContent("No QA recording active. Start one with action=start."), details: { action: "qa-record-stop", active: false } };
      }

      const recording = currentQaRecording;
      const { argv, result } = await runAgentBrowser(pi, ["record", "stop"], params.global ?? recording.global, signal, params.timeoutMs ?? 60_000);
      currentQaRecording = undefined;
      const raw = summarizeResult(result.stdout ?? "", result.stderr ?? "");
      const transcode = params.transcode ?? "none";
      const outputs = await transcodeRecording(pi, recording.webmPath, transcode, signal);
      const lines = [raw || `QA recording stopped: ${recording.webmPath}`];
      lines.push(`WebM: ${outputs.webm}`);
      if (outputs.mp4) lines.push(`MP4: ${outputs.mp4}`);
      if (outputs.gif) lines.push(`GIF: ${outputs.gif}`);
      return {
        content: textContent(lines.join("\n")),
        details: { argv, action: "qa-record-stop", recording, transcode, outputs },
      };
    },
  });

  pi.registerTool({
    name: "browser_skill",
    label: "Browser Skill",
    description: "Read version-matched agent-browser built-in skills (core, electron, slack, vercel-sandbox, agentcore). Use when needing exact command patterns.",
    parameters: SKILL_SCHEMA,
    renderCall(args: SkillParams, theme: any) { return renderCompact("browser_skill", args, theme); },
    renderResult: renderTextResult,
    async execute(_id, params, signal) {
      const args = ["skills", params.action];
      if (params.action === "get") {
        if (!params.name) throw new Error("browser_skill action=get requires name");
        args.push(params.name);
        if (params.full) args.push("--full");
      }
      const { argv, result } = await runAgentBrowser(pi, args, undefined, signal, params.timeoutMs);
      const raw = summarizeResult(result.stdout ?? "", result.stderr ?? "");
      const truncated = truncateOutput(raw, { truncate: "head", maxBytes: params.maxBytes, maxLines: params.maxLines, label: "skill" });
      return {
        content: textContent(truncated.text),
        details: { argv, action: "skill", truncated: truncated.truncated, fullOutputPath: truncated.file },
      };
    },
  });

  pi.registerCommand("agentx-browser-doctor", {
    description: "Check agent-browser availability/version and show recommended Pi install path.",
    handler: async (_args, ctx) => {
      const check = await execAgentBrowser(pi, ["--version"], undefined, 10_000);
      const version = check.code === 0 ? (check.stdout || check.stderr).trim() : "not found";
      ctx.ui.notify(`agent-browser: ${version}`, check.code === 0 ? "info" : "error");
      ctx.ui.notify(`Package path: ${dirname(dirname(new URL(import.meta.url).pathname))}`, "info");
    },
  });

  pi.on("session_shutdown", async () => {
    if (process.env.AGENTX_BROWSER_CLOSE_ON_SHUTDOWN !== "1") return;
    try {
      await execAgentBrowser(pi, ["close", "--all"], undefined, 5_000);
    } catch {
      // Browser may already be closed. Ignore shutdown cleanup failures.
    }
  });
}
