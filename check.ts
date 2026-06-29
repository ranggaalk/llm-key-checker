#!/usr/bin/env bun
/**
 * LLM Key Checker
 *
 * Membaca daftar akun dari file JSON (default: results.json), lalu mengecek
 * validitas tiap api_key terhadap endpoint OpenAI-compatible mana pun
 * (Qwen/DashScope, OpenAI, OpenRouter, Groq, DeepSeek, dll) via BASE_URL.
 * Hasil ditulis ke output/results-<timestamp>.json.
 */

// ── Konfigurasi (dari .env) ────────────────────────────────────────────────
const BASE_URL = (
  process.env.BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
).replace(/\/+$/, "");
const INPUT_FILE = process.env.INPUT_FILE ?? "results.json";
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "output";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 5) || 5);
const TIMEOUT_MS = Math.max(1000, Number(process.env.TIMEOUT_MS ?? 15000) || 15000);

// Mode pengecekan:
//   "token" → GET /models (ringan, tidak makan kuota, cek otorisasi token/key saja)
//   "model" → POST /chat/completions ke MODEL (cek akses ke model spesifik)
const CHECK_MODE = (process.env.CHECK_MODE ?? "token").toLowerCase() === "model" ? "model" : "token";
// Model yang dipakai saat CHECK_MODE=model. Bisa beberapa, dipisah koma.
const MODELS = (process.env.MODEL ?? "qwen-plus")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
// Tulis file terpisah per kategori (valid/invalid/dll) selain file gabungan
const SPLIT_OUTPUT = (process.env.SPLIT_OUTPUT ?? "true").toLowerCase() !== "false";

// ── Warna ANSI untuk console ───────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

// ── Tipe ────────────────────────────────────────────────────────────────────
interface Account {
  email?: string;
  password?: string;
  api_key?: string;
  timestamp?: string;
  [k: string]: unknown;
}

type Status = "VALID" | "RESTRICTED" | "INVALID" | "RATE_LIMITED" | "ERROR";

interface ModelCheck {
  model: string;
  status: Status;
  http_status: number | null;
  message: string;
  latency_ms: number;
}

interface CheckResult {
  email: string | null;
  api_key: string;
  status: Status;
  http_status: number | null;
  message: string;
  latency_ms: number;
  checked_at: string;
  // Detail per model — hanya terisi saat CHECK_MODE=model
  models?: ModelCheck[];
}

// ── Util ─────────────────────────────────────────────────────────────────────

function fmtTimestampForFile(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function isoNow(): string {
  return new Date().toISOString();
}

const statusBadge: Record<Status, string> = {
  VALID: `${c.green}● VALID       ${c.reset}`,
  RESTRICTED: `${c.blue}● RESTRICTED  ${c.reset}`,
  INVALID: `${c.red}● INVALID     ${c.reset}`,
  RATE_LIMITED: `${c.yellow}● RATE LIMITED${c.reset}`,
  ERROR: `${c.gray}● ERROR       ${c.reset}`,
};

// Klasifikasikan satu HTTP response menjadi status + message
function classify(res: Response, apiMessage: string): { status: Status; message: string } {
  const lower = apiMessage.toLowerCase();
  if (res.ok) {
    return { status: "VALID", message: apiMessage || "OK" };
  }
  if (res.status === 429 || lower.includes("rate limit") || lower.includes("quota")) {
    // Kuota/limit habis — key tetap valid
    return { status: "RATE_LIMITED", message: apiMessage || "Kena rate limit / kuota habis" };
  }
  if (
    lower.includes("access to model denied") ||
    lower.includes("not eligible") ||
    lower.includes("eligible for using") ||
    lower.includes("model not exist") ||
    lower.includes("no permission") ||
    lower.includes("permission deny")
  ) {
    // Key valid, tapi tidak punya akses ke model tertentu
    return { status: "RESTRICTED", message: apiMessage || "Key valid, akses model dibatasi / belum eligible" };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: "INVALID", message: apiMessage || "Tidak terotorisasi (key salah / revoked)" };
  }
  return { status: "ERROR", message: apiMessage || `HTTP tak terduga (${res.status})` };
}

// Lakukan satu probe HTTP (GET /models, atau POST /chat/completions ke `model`)
async function probe(apiKey: string, model: string | null): Promise<Omit<ModelCheck, "model">> {
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    const res =
      model === null
        ? await fetch(`${BASE_URL}/models`, { method: "GET", headers, signal: ctrl.signal })
        : await fetch(`${BASE_URL}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
            }),
            signal: ctrl.signal,
          });

    const latency_ms = Math.round(performance.now() - started);

    // Ambil pesan detail dari body (kalau ada)
    let apiMessage = "";
    if (!res.ok) {
      try {
        const body = (await res.json()) as { error?: { message?: string; code?: string } };
        apiMessage = body?.error?.message ?? "";
      } catch {
        /* body bukan JSON, abaikan */
      }
    }

    const { status, message } = classify(res, apiMessage);
    return { status, http_status: res.status, message, latency_ms };
  } catch (err) {
    const latency_ms = Math.round(performance.now() - started);
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      status: "ERROR",
      http_status: null,
      message: aborted
        ? `Timeout setelah ${TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : "Kesalahan jaringan tak diketahui",
      latency_ms,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Urutan prioritas untuk agregasi status key dari beberapa model.
// VALID menang (key bisa minimal 1 model), lalu RESTRICTED, dst.
const STATUS_RANK: Record<Status, number> = {
  VALID: 5,
  RESTRICTED: 4,
  RATE_LIMITED: 3,
  INVALID: 2,
  ERROR: 1,
};

// ── Pengecekan satu key ───────────────────────────────────────────────────────
async function checkOne(acc: Account): Promise<CheckResult> {
  const checked_at = isoNow();
  const base = {
    email: acc.email ?? null,
    api_key: typeof acc.api_key === "string" ? acc.api_key : "",
    checked_at,
  };

  if (!acc.api_key || typeof acc.api_key !== "string") {
    return {
      ...base,
      status: "ERROR",
      http_status: null,
      message: "api_key tidak ada / bukan string",
      latency_ms: 0,
    };
  }

  // Mode "token": satu probe ke GET /models
  if (CHECK_MODE === "token") {
    const p = await probe(acc.api_key, null);
    return {
      ...base,
      status: p.status,
      http_status: p.http_status,
      message: p.status === "VALID" ? "Key aktif & terotorisasi" : p.message,
      latency_ms: p.latency_ms,
    };
  }

  // Mode "model": probe ke tiap model, lalu agregasi
  const models: ModelCheck[] = [];
  for (const model of MODELS) {
    const p = await probe(acc.api_key, model);
    models.push({
      model,
      status: p.status,
      http_status: p.http_status,
      message: p.status === "VALID" ? `Bisa akses ${model}` : p.message,
      latency_ms: p.latency_ms,
    });
  }

  // Status key = status terbaik di antara semua model
  const best = models.reduce((a, b) => (STATUS_RANK[b.status] > STATUS_RANK[a.status] ? b : a));
  const okCount = models.filter((m) => m.status === "VALID").length;
  const total_latency = models.reduce((s, m) => s + m.latency_ms, 0);

  let message: string;
  if (MODELS.length === 1) {
    message = best.message;
  } else if (best.status === "VALID") {
    message = `Akses ${okCount}/${MODELS.length} model`;
  } else {
    message = best.message;
  }

  return {
    ...base,
    status: best.status,
    http_status: best.http_status,
    message,
    latency_ms: total_latency,
    models,
  };
}

// ── Worker pool sederhana dengan batas konkurensi ─────────────────────────────
async function runPool(
  accounts: Account[],
  onDone: (r: CheckResult, idx: number) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = new Array(accounts.length);
  let next = 0;

  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= accounts.length) break;
      const r = await checkOne(accounts[idx]);
      results[idx] = r;
      onDone(r, idx);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── TUI: scroll region + footer tetap ─────────────────────────────────────────
interface Summary {
  valid: number;
  restricted: number;
  invalid: number;
  rate_limited: number;
  error: number;
}

const dotColor: Record<Status, string> = {
  VALID: c.green,
  RESTRICTED: c.blue,
  RATE_LIMITED: c.yellow,
  INVALID: c.red,
  ERROR: c.gray,
};

const out = (s: string) => process.stdout.write(s);
const termRows = () => process.stdout.rows || 24;
const termCols = () => process.stdout.columns || 80;

// Potong string ke lebar tertentu, abaikan escape ANSI saat menghitung lebar
function clip(s: string, width: number): string {
  let res = "";
  let vis = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        res += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (vis >= width) break;
    res += s[i];
    vis++;
    i++;
  }
  return res + c.reset;
}

// Format satu hasil menjadi 1+ baris siap cetak
function formatResult(r: CheckResult, n: number, total: number, pad: number): string[] {
  const counter = `${c.gray}[${String(n).padStart(pad)}/${total}]${c.reset}`;
  const email = (r.email ?? "(tanpa email)").padEnd(28).slice(0, 28);
  const key = (r.api_key || "(kosong)").padEnd(20);
  const lat = `${c.dim}${String(r.latency_ms).padStart(5)}ms${c.reset}`;
  const lines = [
    `${counter} ${statusBadge[r.status]} ${c.cyan}${email}${c.reset} ${c.dim}${key}${c.reset} ${lat}  ${c.gray}${r.message}${c.reset}`,
  ];
  if (r.models && r.models.length > 1) {
    for (const m of r.models) {
      lines.push(
        `        ${dotColor[m.status]}↳${c.reset} ${m.model.padEnd(16)} ` +
          `${dotColor[m.status]}${m.status}${c.reset} ${c.gray}${m.message}${c.reset}`,
      );
    }
  }
  return lines;
}

function progressLine(completed: number, total: number, elapsed: string): string {
  const w = 24;
  const ratio = total ? completed / total : 1;
  const filled = Math.min(w, Math.round(ratio * w));
  const bar = `${c.green}${"█".repeat(filled)}${c.gray}${"░".repeat(w - filled)}${c.reset}`;
  const pct = String(Math.round(ratio * 100)).padStart(3);
  return `${c.bold}Progress${c.reset} [${bar}] ${pct}%  ${c.cyan}${completed}/${total}${c.reset}  ${c.dim}${elapsed}s${c.reset}`;
}

function summaryLine(s: Summary): string {
  return (
    `  ${c.green}● VALID ${s.valid}${c.reset}` +
    `  ${c.blue}● RESTRICTED ${s.restricted}${c.reset}` +
    `  ${c.red}● INVALID ${s.invalid}${c.reset}` +
    `  ${c.yellow}● RATE ${s.rate_limited}${c.reset}` +
    `  ${c.gray}● ERROR ${s.error}${c.reset}`
  );
}

const FOOTER_H = 3; // rule + progress + summary
let tuiActive = false;
let tuiHeaderH = 0;

function tuiSetRegion() {
  const top = tuiHeaderH + 1;
  const bottom = Math.max(top, termRows() - FOOTER_H);
  out(`\x1b[${top};${bottom}r`); // scroll region
  out(`\x1b[${bottom};1H`); // taruh kursor di dasar region
}

function tuiInit(headerLines: string[]) {
  out("\x1b[2J\x1b[H"); // clear + home
  for (const l of headerLines) out(clip(l, termCols()) + "\r\n");
  tuiHeaderH = headerLines.length;
  out("\x1b[?25l"); // sembunyikan kursor
  tuiSetRegion();
  tuiActive = true;
}

function tuiPrint(lines: string[]) {
  const cols = termCols();
  for (const l of lines) out("\r\x1b[K" + clip(l, cols) + "\r\n");
}

function tuiFooter(completed: number, total: number, s: Summary, elapsed: string) {
  const top = termRows() - FOOTER_H + 1;
  const cols = termCols();
  out("\x1b7"); // simpan kursor
  out(`\x1b[${top};1H\x1b[K` + c.gray + "─".repeat(Math.min(cols, 64)) + c.reset);
  out(`\x1b[${top + 1};1H\x1b[K` + clip(progressLine(completed, total, elapsed), cols));
  out(`\x1b[${top + 2};1H\x1b[K` + clip(summaryLine(s), cols));
  out("\x1b8"); // kembalikan kursor
}

function tuiTeardown() {
  if (!tuiActive) return;
  out("\x1b[r"); // reset scroll region
  const top = termRows() - FOOTER_H + 1;
  out(`\x1b[${top};1H\x1b[J`); // bersihkan area footer
  out("\x1b[?25h"); // tampilkan kursor lagi
  tuiActive = false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const headerLines = [
    `${c.bold}${c.cyan}┌─ LLM Key Checker ────────────────────────────────┐${c.reset}`,
    `${c.gray}│${c.reset} Base URL    : ${c.blue}${BASE_URL}${c.reset}`,
    `${c.gray}│${c.reset} Input file  : ${INPUT_FILE}`,
    `${c.gray}│${c.reset} Mode        : ${c.yellow}${CHECK_MODE}${c.reset}` +
      (CHECK_MODE === "model"
        ? ` ${c.dim}(${MODELS.join(", ")})${c.reset}`
        : ` ${c.dim}(GET /models)${c.reset}`),
    `${c.gray}│${c.reset} Concurrency : ${CONCURRENCY}`,
    `${c.bold}${c.cyan}└──────────────────────────────────────────────────┘${c.reset}`,
  ];

  // Baca & parse input (sebelum masuk mode TUI agar error tampil normal)
  const inputFile = Bun.file(INPUT_FILE);
  if (!(await inputFile.exists())) {
    for (const l of headerLines) console.log(l);
    console.error(`\n${c.red}✗ File input tidak ditemukan: ${INPUT_FILE}${c.reset}`);
    process.exit(1);
  }

  let accounts: Account[];
  try {
    const parsed = await inputFile.json();
    accounts = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    console.error(`${c.red}✗ Gagal parse JSON dari ${INPUT_FILE}: ${(e as Error).message}${c.reset}`);
    process.exit(1);
  }

  if (accounts.length === 0) {
    console.error(`${c.yellow}⚠ Tidak ada akun di ${INPUT_FILE}${c.reset}`);
    process.exit(0);
  }

  const total = accounts.length;
  const pad = String(total).length;

  // Aktifkan TUI hanya bila output adalah terminal & cukup tinggi
  const useTui = process.stdout.isTTY === true && termRows() >= headerLines.length + FOOTER_H + 2;

  const live: Summary = { valid: 0, restricted: 0, invalid: 0, rate_limited: 0, error: 0 };
  const bump = (st: Status) => {
    if (st === "VALID") live.valid++;
    else if (st === "RESTRICTED") live.restricted++;
    else if (st === "INVALID") live.invalid++;
    else if (st === "RATE_LIMITED") live.rate_limited++;
    else live.error++;
  };

  const startedAll = performance.now();

  let onResize: (() => void) | null = null;
  let cleanup: (() => void) | null = null;
  if (useTui) {
    tuiInit(headerLines);
    onResize = () => {
      if (tuiActive) {
        tuiSetRegion();
        tuiFooter(completed, total, live, ((performance.now() - startedAll) / 1000).toFixed(1));
      }
    };
    process.stdout.on("resize", onResize);
    cleanup = () => {
      tuiTeardown();
      out("\x1b[?25h");
    };
    process.on("SIGINT", () => {
      cleanup?.();
      process.exit(130);
    });
  } else {
    for (const l of headerLines) console.log(l);
    console.log(`\n${c.dim}Mengecek ${total} api key...${c.reset}\n`);
  }

  let completed = 0;
  const onDone = (r: CheckResult) => {
    completed++;
    bump(r.status);
    const lines = formatResult(r, completed, total, pad);
    if (useTui) {
      tuiPrint(lines);
      tuiFooter(completed, total, live, ((performance.now() - startedAll) / 1000).toFixed(1));
    } else {
      for (const l of lines) console.log(l);
    }
  };

  const results = await runPool(accounts, onDone);
  const elapsed = ((performance.now() - startedAll) / 1000).toFixed(1);

  if (useTui) {
    if (onResize) process.stdout.off("resize", onResize);
    tuiTeardown();
  }

  // Ringkasan (final, permanen)
  const summary: Summary = {
    valid: results.filter((r) => r.status === "VALID").length,
    restricted: results.filter((r) => r.status === "RESTRICTED").length,
    invalid: results.filter((r) => r.status === "INVALID").length,
    rate_limited: results.filter((r) => r.status === "RATE_LIMITED").length,
    error: results.filter((r) => r.status === "ERROR").length,
  };

  console.log(`\n${c.bold}── Ringkasan ──────────────────────────────────────${c.reset}`);
  console.log(`  ${c.green}VALID${c.reset}        : ${summary.valid}`);
  console.log(`  ${c.blue}RESTRICTED${c.reset}   : ${summary.restricted}`);
  console.log(`  ${c.red}INVALID${c.reset}      : ${summary.invalid}`);
  console.log(`  ${c.yellow}RATE LIMITED${c.reset} : ${summary.rate_limited}`);
  console.log(`  ${c.gray}ERROR${c.reset}        : ${summary.error}`);
  console.log(`  ${c.dim}Total ${total} key dalam ${elapsed}s${c.reset}`);

  // Tulis output
  const now = new Date();
  const outName = `results-${fmtTimestampForFile(now)}.json`;
  const outPath = `${OUTPUT_DIR}/${outName}`;
  const meta = {
    base_url: BASE_URL,
    check_mode: CHECK_MODE,
    models: CHECK_MODE === "model" ? MODELS : null,
    input_file: INPUT_FILE,
    generated_at: now.toISOString(),
    total,
    summary,
    duration_seconds: Number(elapsed),
  };

  await Bun.write(outPath, JSON.stringify({ meta, results }, null, 2));
  console.log(`\n${c.green}✓ Hasil disimpan ke ${c.bold}${outPath}${c.reset}`);

  // Tulis file terpisah per kategori
  if (SPLIT_OUTPUT) {
    const groups: Record<string, Status[]> = {
      valid: ["VALID"],
      restricted: ["RESTRICTED"],
      invalid: ["INVALID"],
      rate_limited: ["RATE_LIMITED"],
      error: ["ERROR"],
    };
    const stamp = fmtTimestampForFile(now);
    for (const [label, statuses] of Object.entries(groups)) {
      const subset = results.filter((r) => statuses.includes(r.status));
      if (subset.length === 0) continue;
      const p = `${OUTPUT_DIR}/${stamp}/${label}.json`;
      await Bun.write(p, JSON.stringify({ meta: { ...meta, category: label, count: subset.length }, results: subset }, null, 2));
      console.log(`  ${c.dim}↳ ${label.padEnd(12)} ${String(subset.length).padStart(4)} → ${p}${c.reset}`);
    }
  }
}

main().catch((e) => {
  console.error(`${c.red}✗ Fatal: ${e instanceof Error ? e.stack : e}${c.reset}`);
  process.exit(1);
});
