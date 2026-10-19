/**
 * @local/dsh-resmon — Host half.
 * Samples CPU / memory once per second, plus one merged PowerShell sampler
 * every 2 s (network adapter bytes, per-drive active-time %, and — on
 * non-NVIDIA GPUs — generic GPU counters), plus statfs disk capacity every
 * 5 s and an async DSH-footprint walk every 5 minutes. Folds per-session
 * token usage *and cost* from the session log (durable, replay-safe),
 * backfills historical usage from the session artifact store every 10
 * minutes, persists cumulative totals through the storage domain facility
 * when available, and answers the Client panel over two authenticated
 * fetch routes (`/api/dsh-resmon/stats|usage`).
 */
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import z from '@deepseek-ai/schemastery';

const MAX_SAMPLES = 90;
const PERSIST_INTERVAL_MS = 30000;
const IS_WIN32 = process.platform === 'win32';

/** Built-in official PEAK pricing table, CNY per million tokens.
 *  Verified 2026-10-19 against api-docs.deepseek.com (Lead's research):
 *  - `deepseek-flash`            peak: input 2 / cachedInput 0.04 / output 8
 *  - `deepseek-v4-pro`           peak: input 9.0 / cachedInput 0.30 / output 27.0
 *  - Legacy aliases billed as flash: deepseek-v4-flash, deepseek-v4-flash-vision-exp
 *  - Discontinued models (deepseek-chat, deepseek-reasoner) are deliberately NOT
 *    listed, so they fall through to `default` like any unknown model id.
 *  - Off-peak prices are peak × OFF_PEAK_RATIO (see periodAt/priceFor below).
 *  Peak window = Beijing time Mon–Fri 09:00–12:00 & 14:00–18:00 (effective since
 *  2026-08-16). The official page states peak excludes Chinese statutory
 *  holidays; this plugin cannot embed a holiday table, so holidays are
 *  conservatively billed at peak prices. */
const BUILTIN_PRICING = {
  'deepseek-flash': { input: 2, cachedInput: 0.04, output: 8 },
  'deepseek-v4-pro': { input: 9.0, cachedInput: 0.30, output: 27.0 },
  'deepseek-v4-flash': { input: 2, cachedInput: 0.04, output: 8 },
  'deepseek-v4-flash-vision-exp': { input: 2, cachedInput: 0.04, output: 8 },
  default: { input: 9.0, cachedInput: 0.30, output: 27.0 },
};

/** Effective pricing table — starts as the built-in; each apply() replaces it
 *  from the Config (pricing.models.default / pricing.models.overrides JSON). */
let PRICING = { ...BUILTIN_PRICING };
/** Off-peak multiplier applied to peak prices (configurable). */
let OFF_PEAK_RATIO = 0.5;

/** Peak/off-peak billing period at a given instant (Beijing time, UTC+8, no
 *  DST). Unknown or unparseable instants conservatively count as peak.
 *  Peak = Mon–Fri 09:00–12:00 & 14:00–18:00 Beijing time. */
function periodAt(timeMs) {
  const t = Number(timeMs);
  if (!Number.isFinite(t)) return 'peak';
  const bj = new Date(t + 8 * 3600 * 1000);
  const day = bj.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  if (day >= 1 && day <= 5) {
    const morning = minutes >= 9 * 60 && minutes < 12 * 60;
    const afternoon = minutes >= 14 * 60 && minutes < 18 * 60;
    if (morning || afternoon) return 'peak';
  }
  return 'offpeak';
}

/** Display alias for reasoning-effort values. Pricing is identical for all of
 *  low/high/max, so this mapping only affects what the panel shows; unknown
 *  values pass through unchanged. */
const REASONING_EFFORT_ALIASES = {
  medium: 'high',
  xhigh: 'high',
  minimal: 'low',
  ultra: 'max',
};

function normalizeReasoningEffort(value) {
  if (typeof value !== 'string') return value;
  return REASONING_EFFORT_ALIASES[value] ?? value;
}

/** Generic GPU probe: first video controller's name + adapter RAM (32-bit). */
const GPU_PROBE_SCRIPT = [
  'Get-CimInstance Win32_VideoController',
  '| Select-Object -First 1 Name,AdapterRAM',
  '| ConvertTo-Json -Compress',
].join(' ');

/** Merged 2-second PowerShell sampler parts: network adapter bytes, per-drive
 *  active-time % (Task-Manager style), and — when the generic GPU backend is
 *  active — GPU utilization / dedicated memory usage. All counter lookups are
 *  SilentlyContinue so a missing category degrades gracefully (e.g. localized
 *  Windows with non-English counter names).
 *  Note on the net part: Get-NetAdapterStatistics.OperationalStatus is null on
 *  some Windows builds, so the Up-adapter set is taken from Get-NetAdapter's
 *  Status instead (same intent: sum bytes over every Up adapter). */
const COUNTERS_NET = [
  "$upNames = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty Name)",
  "$net = @(Get-NetAdapterStatistics | Where-Object { $upNames -contains $_.Name } | Select-Object Name,ReceivedBytes,SentBytes)",
].join('; ');
const COUNTERS_DISK = String.raw`$disk = @((Get-Counter '\PhysicalDisk(*)\% Disk Time' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples | Select-Object InstanceName,CookedValue))`;
const COUNTERS_GPU_UTIL = String.raw`$gpuUtil = @((Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples | Select-Object InstanceName,CookedValue))`;
const COUNTERS_GPU_MEM = String.raw`$gpuMem = @((Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples | Select-Object CookedValue))`;
const COUNTERS_EMIT = '[pscustomobject]@{ net = $net; disk = $disk; gpuUtil = $gpuUtil; gpuMem = $gpuMem } | ConvertTo-Json -Compress -Depth 4';

/** Assemble the merged sampler script (GPU counter parts only when the
 *  generic backend is in use, to keep the NVIDIA path lean). */
function countersScript(withGpuCounters) {
  const parts = [COUNTERS_NET, COUNTERS_DISK];
  if (withGpuCounters) parts.push(COUNTERS_GPU_UTIL, COUNTERS_GPU_MEM);
  parts.push(COUNTERS_EMIT);
  return parts.join('; ');
}

/** Boot-time system-version probe (registry value names are locale-stable). */
const OS_VERSION_SCRIPT = [
  String.raw`Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'`,
  '| Select-Object DisplayVersion,CurrentBuildNumber,UBR',
  '| ConvertTo-Json -Compress',
].join(' ');

/** History backfill cadence and artifact naming. */
const BACKFILL_INTERVAL_MS = 600000; // 10 minutes, mtime-incremental
const SESSION_ARTIFACT_NAME = 'session.v4.jsonl.zstd';
const ZSTD_MAGIC = 0xfd2fb528;

/** Official balance endpoint — the ONLY external address this plugin is
 *  allowed to contact; the API key never leaves this origin. */
const OFFICIAL_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const OFFICIAL_BALANCE_INTERVAL_MS = 60000; // snapshot cadence (source re-probed every tick)

/** Runtime-editable JSON config file: <home>/.dsh-resmon-config.json.
 *  Priority: file > schemastery Config > built-in defaults. */
const CONFIG_FILENAME = '.dsh-resmon-config.json';

/** External loopback HTTP API (CONTRACT.md §11): panel-command whitelists,
 *  default port and the generated spec file name. */
const PANEL_ITEM_WHITELIST = ['cpu', 'mem', 'disk', 'net', 'gpu', 'tokens', 'cost', 'dshsize'];
const PANEL_SCOPE_VALUES = ['machine', 'dsh'];
const PANEL_METRIC_VALUES = ['turn', 'session', 'today', 'cumulative'];
const EXTERNAL_DEFAULT_PORT = 57123;
const EXTERNAL_SPEC_FILENAME = 'dsh-resmon-external-api.md';
const EXTERNAL_PIPE_NAME = '\\\\.\\pipe\\dsh-resmon';

/** Plugin version for the external API/spec; read from the neighbouring
 *  package.json when present, else the fallback constant. */
let PLUGIN_VERSION = '1.0.0';
try {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  if (pkg && typeof pkg.version === 'string') PLUGIN_VERSION = pkg.version;
} catch { /* keep the fallback version */ }

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Beijing calendar day key (UTC+8, no DST), e.g. `2026-10-19`. */
function beijingDayKey(time = Date.now()) {
  const bj = new Date(time + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const d = String(bj.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Map an apikey balance response to { total, bonus, recharge } CNY, or null. */
function apikeyBalanceOf(json) {
  if (!json || typeof json !== 'object') return null;
  const list = Array.isArray(json.balance_infos) ? json.balance_infos : [];
  const info = list.find((wallet) => wallet && wallet.currency === 'CNY') ?? list[0] ?? null;
  if (!info) return null;
  const total = Number.parseFloat(info.total_balance);
  if (!Number.isFinite(total)) return null;
  const bonus = Number.parseFloat(info.granted_balance);
  const recharge = Number.parseFloat(info.topped_up_balance);
  return {
    total,
    bonus: Number.isFinite(bonus) ? bonus : 0,
    recharge: Number.isFinite(recharge) ? recharge : total,
  };
}

/** Map an account getBalance outcome to { total, bonus, recharge } CNY, or
 *  null. `value` = recharge wallets, `bonusWallets` = granted bonuses. */
function accountBalanceOf(outcome) {
  if (!outcome || outcome.status !== 'ready') return null;
  const wallets = Array.isArray(outcome.value) ? outcome.value : [];
  const bonuses = Array.isArray(outcome.bonusWallets) ? outcome.bonusWallets : [];
  const rechargeWallet = wallets.find((wallet) => wallet && wallet.currency === 'CNY') ?? wallets[0] ?? null;
  const bonusWallet = bonuses.find((wallet) => wallet && wallet.currency === 'CNY') ?? bonuses[0] ?? null;
  if (!rechargeWallet && !bonusWallet) return null;
  const recharge = rechargeWallet ? Number.parseFloat(rechargeWallet.balance) : 0;
  const bonus = bonusWallet ? Number.parseFloat(bonusWallet.balance) : 0;
  if (!Number.isFinite(recharge) || !Number.isFinite(bonus)) return null;
  return { total: recharge + bonus, bonus, recharge };
}

/** Tier-2 (account mode only): the platform's undisclosed usage endpoints
 *  are parsed defensively — a recursive scan for arrays of objects that carry
 *  a date-ish field AND a numeric cost-ish field. API-level error envelopes
 *  (code !== 0) and unrecognized shapes yield null; secret-ish keys
 *  (api_key / token / secret) are never read or propagated. */
const COST_DATE_KEYS = ['utc_date', 'date', 'day'];
const COST_VALUE_KEYS = ['cost', 'amount', 'total_cost'];
const PLATFORM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function collectCostRows(node, rows, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object') {
        const hasDate = COST_DATE_KEYS.some((key) => item[key] !== undefined && item[key] !== null);
        const hasCost = COST_VALUE_KEYS.some((key) => typeof item[key] === 'number');
        if (hasDate && hasCost && !seen.has(item)) {
          seen.add(item);
          rows.push(item);
        }
      }
    }
    for (const item of node) collectCostRows(item, rows, seen);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (/api_?key|secret|token/i.test(key)) continue;
    collectCostRows(value, rows, seen);
  }
}

function costRowDate(row) {
  for (const key of COST_DATE_KEYS) {
    const value = row[key];
    if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10);
    if (typeof value === 'number' && Number.isFinite(value)) return beijingDayKey(value * 1000);
  }
  return null;
}

function costRowValue(row) {
  for (const key of COST_VALUE_KEYS) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** Recognized response → its cost rows; anything else → null. */
function platformUsageRowsOf(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.code !== undefined && json.code !== 0) return null;
  const rows = [];
  const seen = new Set();
  collectCostRows(json, rows, seen);
  return rows.length > 0 ? rows : null;
}

/** Today (Beijing) cost from a /usage/by_api_key/cost response, or null. */
function todayCostOf(json) {
  const rows = platformUsageRowsOf(json);
  if (!rows) return null;
  const today = beijingDayKey();
  let sum = 0;
  let matched = false;
  for (const row of rows) {
    if (costRowDate(row) !== today) continue;
    const value = costRowValue(row);
    if (value !== null) {
      sum += value;
      matched = true;
    }
  }
  return matched ? sum : null;
}

/** Month cost from a /usage/cost response: sum of every numeric cost row. */
function monthCostOf(json) {
  const rows = platformUsageRowsOf(json);
  if (!rows) return null;
  let sum = 0;
  let matched = false;
  for (const row of rows) {
    const value = costRowValue(row);
    if (value !== null) {
      sum += value;
      matched = true;
    }
  }
  return matched ? sum : null;
}

/** Unix seconds of today 00:00 Beijing time. */
function beijingDayStartSeconds() {
  const seconds = Date.now() / 1000;
  return Math.floor((seconds + 8 * 3600) / 86400) * 86400 - 8 * 3600;
}

/** Extract today's usage (CNY) from the whale widget ledger. Prefers the
 *  active book's day row (debitUnits / 1e8); falls back to the top-level
 *  todayUsage; returns null when neither is available. The `correction`
 *  field needs no extra handling — the ledger value already includes it. */
function whaleTodayOf(ledger, todayKey) {
  if (!ledger || typeof ledger !== 'object') return null;
  let value = null;
  const accounting = ledger.accounting;
  if (accounting && typeof accounting === 'object' && typeof accounting.active === 'string') {
    const books = accounting.books;
    if (books && typeof books === 'object') {
      const book = books[accounting.active];
      if (book && typeof book === 'object' && book.days && typeof book.days === 'object') {
        const day = book.days[todayKey];
        if (day && typeof day === 'object' && typeof day.debitUnits === 'number' && Number.isFinite(day.debitUnits)) {
          value = day.debitUnits / 1e8;
        }
      }
    }
  }
  if (value === null && typeof ledger.todayUsage === 'number' && Number.isFinite(ledger.todayUsage)) {
    value = ledger.todayUsage;
  }
  return value;
}

/** Cumulative (all-days) usage from the whale ledger: Σ debitUnits/1e8 across
 *  every day of the active book; without usable accounting data, Σ of the
 *  top-level history values. Null when neither yields a number. */
function whaleCumulativeOf(ledger) {
  if (!ledger || typeof ledger !== 'object') return null;
  let sum = null;
  const accounting = ledger.accounting;
  if (accounting && typeof accounting === 'object' && typeof accounting.active === 'string') {
    const books = accounting.books;
    if (books && typeof books === 'object') {
      const book = books[accounting.active];
      if (book && typeof book === 'object' && book.days && typeof book.days === 'object' && !Array.isArray(book.days)) {
        let total = 0;
        let count = 0;
        for (const day of Object.values(book.days)) {
          if (day && typeof day === 'object' && typeof day.debitUnits === 'number' && Number.isFinite(day.debitUnits)) {
            total += day.debitUnits;
            count += 1;
          }
        }
        if (count > 0) sum = total / 1e8;
      }
    }
  }
  if (sum === null) {
    const history = ledger.history;
    if (history && typeof history === 'object' && !Array.isArray(history)) {
      let total = 0;
      let count = 0;
      for (const value of Object.values(history)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          total += value;
          count += 1;
        }
      }
      if (count > 0) sum = total;
    }
  }
  return sum;
}

/** Structural scan of a multi-frame zstd stream — mirrors the Harness
 *  `scanZstdFrames` (Buffer reads only, no zlib). One deliberate deviation:
 *  the official code throws when the current offset no longer starts with
 *  the frame magic; here that offset is returned as `tornStart` instead,
 *  because the writer may leave a plaintext JSONL tail after the frames and
 *  the contract reader must recover it (tornStart is read as UTF-8 text).
 *  Genuine in-frame corruption (reserved bits / block types) still throws. */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start };
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function peakPriceFor(modelId) {
  if (typeof modelId === 'string' && PRICING[modelId]) return PRICING[modelId];
  return PRICING.default;
}

/** Effective unit price at a given instant (off-peak = peak × ratio). */
function priceFor(modelId, timeMs) {
  const peak = peakPriceFor(modelId);
  if (periodAt(timeMs) === 'offpeak') {
    return {
      input: peak.input * OFF_PEAK_RATIO,
      cachedInput: peak.cachedInput * OFF_PEAK_RATIO,
      output: peak.output * OFF_PEAK_RATIO,
    };
  }
  return { input: peak.input, cachedInput: peak.cachedInput, output: peak.output };
}

/** Cost (CNY) of one provider-reported usage block at the given instant
 *  (per-message period is judged from the event's own `time`). */
function costOfUsage(usage, modelId, timeMs) {
  const price = priceFor(modelId, timeMs);
  const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
  const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  const cacheRead = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
  // Cache writes are billed as cache misses, i.e. at the plain input price.
  return round6((Math.max(0, input - cacheRead) * price.input + cacheRead * price.cachedInput + output * price.output) / 1e6);
}

/** Local calendar day key, e.g. `2026-10-18` (host local time). */
function localDayKey(time = Date.now()) {
  const d = new Date(time);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Extract provider-reported usage (tokens + cost) from one durable event. */
function usageOf(event) {
  if (event.type !== 'assistant/message' || !event.data || !event.data.usage) return null;
  const u = event.data.usage;
  const message = event.data.message;
  const source = message && typeof message === 'object' ? message.source : null;
  const modelId = source && typeof source === 'object' && typeof source.model === 'string' ? source.model : null;
  return {
    input: typeof u.inputTokens === 'number' ? u.inputTokens : 0,
    output: typeof u.outputTokens === 'number' ? u.outputTokens : 0,
    cacheRead: typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0,
    cost: costOfUsage(u, modelId, event.time),
  };
}

function isSessionEventLike(first, second) {
  return first && typeof first === 'object' && typeof first.id === 'string' &&
    second && typeof second === 'object' && typeof second.type === 'string' && typeof second.seq === 'number';
}

export const inject = ['connection'];

/** Settings-editor schema (DSH 设置 → 插件 renders a form from this; the
 *  Loader validates and persists the parsed config into the profile patch).
 *  Defaults mirror the built-in behaviour exactly (CONTRACT.md §9.2). */
export const Config = z.object({
  pricing: z.object({
    offPeakRatio: z.number().min(0).max(1).default(0.5).description('空闲时段价格系数(高峰×该系数)'),
    models: z.object({
      default: z.string().default(JSON.stringify(BUILTIN_PRICING.default)).description('default 兜底计价(JSON,如 {"input":9.0,"cachedInput":0.30,"output":27.0})'),
      overrides: z.string().default('{}').description('模型计价覆盖(JSON,如 {"deepseek-flash":{"input":2,"cachedInput":0.04,"output":8}})'),
    }).description('模型计价(JSON)'),
  }).description('计价配置').default({}),
  official: z.object({
    mode: z.union(['auto', 'apikey', 'account', 'off']).default('auto').description('官方数据源模式(auto=自动探测)'),
    pollSeconds: z.number().min(15).max(600).default(60).description('官方余额轮询间隔(秒)'),
  }).description('官方数据源').default({}),
  whale: z.object({
    enabled: z.boolean().default(true).description('读取小鲸鱼账本'),
    path: z.string().default('').description('账本路径(空=默认 ~/.dsh/.dshw-usage.json)'),
  }).description('小鲸鱼账本').default({}),
  sampling: z.object({
    netGpuSeconds: z.number().min(1).max(30).default(2).description('网络/GPU 采样间隔(秒)'),
    diskSeconds: z.number().min(2).max(120).default(5).description('磁盘采样间隔(秒)'),
    dshsizeMinutes: z.number().min(1).max(120).default(5).description('DSH 占用重算间隔(分钟)'),
  }).description('采样节奏').default({}),
  external: z.object({
    enabled: z.boolean().default(false).description('启用外部程序接口(仅 127.0.0.1)'),
    port: z.number().min(1024).max(65535).default(57123).description('外部接口监听端口'),
  }).description('外部程序接口').default({}),
});

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;
  const cfg = config && typeof config === 'object' ? config : {};

  /* ================================================================== *
   * 0. Runtime configuration                                             *
   *    Priority: JSON file (>homeDir()/.dsh-resmon-config.json)         *
   *              > schemastery Config > built-in defaults.              *
   *    GET/POST /api/dsh-resmon/config read/write the file and apply    *
   *    changes immediately (pricing, cadences, official timer).         *
   * ================================================================== */
  function parsePriceEntry(value) {
    if (!value || typeof value !== 'object') return null;
    const input = Number(value.input);
    const cachedInput = Number(value.cachedInput);
    const output = Number(value.output);
    if (!Number.isFinite(input) || !Number.isFinite(cachedInput) || !Number.isFinite(output)) return null;
    return { input, cachedInput, output };
  }

  function defaultConfig() {
    return {
      pricing: {
        offPeakRatio: 0.5,
        models: {
          default: JSON.stringify(BUILTIN_PRICING.default),
          overrides: '{}',
        },
      },
      official: { mode: 'auto', pollSeconds: 60 },
      whale: { enabled: true, path: '' },
      sampling: { netGpuSeconds: 2, diskSeconds: 5, dshsizeMinutes: 5 },
      external: { enabled: false, port: EXTERNAL_DEFAULT_PORT },
    };
  }

  function cloneConfig(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /** Validate a partial config patch against the current values and merge.
   *  Numbers must lie inside the Config min/max ranges, official.mode must be
   *  one of the enum values, models.default/overrides must parse as JSON and
   *  pass parsePriceEntry, whale.path must be a string. */
  function validateConfigPatch(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'config body must be an object' };
    const merged = cloneConfig(base);
    const numIn = (value, min, max, name) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < min || n > max) return { ok: false, error: `${name} must be a number within [${min}, ${max}]` };
      return { ok: true, value: n };
    };
    if (patch.pricing !== undefined) {
      if (!patch.pricing || typeof patch.pricing !== 'object' || Array.isArray(patch.pricing)) return { ok: false, error: 'pricing must be an object' };
      const p = patch.pricing;
      if (p.offPeakRatio !== undefined) {
        const r = numIn(p.offPeakRatio, 0, 1, 'pricing.offPeakRatio');
        if (!r.ok) return r;
        merged.pricing.offPeakRatio = r.value;
      }
      if (p.models !== undefined) {
        if (!p.models || typeof p.models !== 'object' || Array.isArray(p.models)) return { ok: false, error: 'pricing.models must be an object' };
        const m = p.models;
        for (const key of ['default', 'overrides']) {
          if (m[key] === undefined) continue;
          if (typeof m[key] !== 'string') return { ok: false, error: `pricing.models.${key} must be a JSON string` };
          try {
            const parsed = JSON.parse(m[key]);
            if (key === 'default') {
              if (!parsePriceEntry(parsed)) return { ok: false, error: 'pricing.models.default must parse to {input, cachedInput, output} numbers' };
            } else {
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'pricing.models.overrides must parse to an object of {input, cachedInput, output}' };
              for (const [modelId, entry] of Object.entries(parsed)) {
                if (!parsePriceEntry(entry)) return { ok: false, error: `pricing.models.overrides["${modelId}"] must be {input, cachedInput, output} numbers` };
              }
            }
          } catch {
            return { ok: false, error: `pricing.models.${key} is not valid JSON` };
          }
          merged.pricing.models[key] = m[key];
        }
      }
    }
    if (patch.official !== undefined) {
      if (!patch.official || typeof patch.official !== 'object' || Array.isArray(patch.official)) return { ok: false, error: 'official must be an object' };
      const o = patch.official;
      if (o.mode !== undefined) {
        if (!['auto', 'apikey', 'account', 'off'].includes(o.mode)) return { ok: false, error: "official.mode must be one of auto|apikey|account|off" };
        merged.official.mode = o.mode;
      }
      if (o.pollSeconds !== undefined) {
        const r = numIn(o.pollSeconds, 15, 600, 'official.pollSeconds');
        if (!r.ok) return r;
        merged.official.pollSeconds = r.value;
      }
    }
    if (patch.whale !== undefined) {
      if (!patch.whale || typeof patch.whale !== 'object' || Array.isArray(patch.whale)) return { ok: false, error: 'whale must be an object' };
      const w = patch.whale;
      if (w.enabled !== undefined) {
        if (typeof w.enabled !== 'boolean') return { ok: false, error: 'whale.enabled must be a boolean' };
        merged.whale.enabled = w.enabled;
      }
      if (w.path !== undefined) {
        if (typeof w.path !== 'string') return { ok: false, error: 'whale.path must be a string' };
        merged.whale.path = w.path.trim();
      }
    }
    if (patch.sampling !== undefined) {
      if (!patch.sampling || typeof patch.sampling !== 'object' || Array.isArray(patch.sampling)) return { ok: false, error: 'sampling must be an object' };
      const s = patch.sampling;
      const fields = [
        ['netGpuSeconds', 1, 30],
        ['diskSeconds', 2, 120],
        ['dshsizeMinutes', 1, 120],
      ];
      for (const [key, min, max] of fields) {
        if (s[key] === undefined) continue;
        const r = numIn(s[key], min, max, `sampling.${key}`);
        if (!r.ok) return r;
        merged.sampling[key] = r.value;
      }
    }
    if (patch.external !== undefined) {
      if (!patch.external || typeof patch.external !== 'object' || Array.isArray(patch.external)) return { ok: false, error: 'external must be an object' };
      const e = patch.external;
      if (e.enabled !== undefined) {
        if (typeof e.enabled !== 'boolean') return { ok: false, error: 'external.enabled must be a boolean' };
        merged.external.enabled = e.enabled;
      }
      if (e.port !== undefined) {
        const r = numIn(e.port, 1024, 65535, 'external.port');
        if (!r.ok) return r;
        merged.external.port = r.value;
      }
    }
    return { ok: true, value: merged };
  }

  /* Runtime variables derived from the effective config (mutable so a
   *  config POST can re-apply them without restarting the plugin). */
  let effectiveCfg = defaultConfig();
  let officialTimer = null;
  let officialMode = 'auto';
  let officialPollMs = OFFICIAL_BALANCE_INTERVAL_MS;
  let whaleEnabled = true;
  let whalePath = '';
  let netGpuEveryTicks = 2;
  let diskEveryTicks = 5;
  let dshsizeEveryTicks = 300;
  let externalEnabled = false;
  let externalPort = EXTERNAL_DEFAULT_PORT;
  let externalServer = null;
  let externalListeningPort = null;
  const externalState = { running: false, error: null };
  // External → Client panel command channel (GET /v1/panel + /api/dsh-resmon/panel).
  const panelCommand = { revision: 0, command: null };
  // Windows named pipe (CONTRACT.md §12): same lifecycle as the HTTP server.
  let pipeServer = null;
  const pipeConnections = new Set();

  /** (Re)start the official-balance polling interval with the current
   *  pollSeconds (a config change rebuilds the timer). */
  function startOfficialTimer() {
    if (officialTimer !== null) clearInterval(officialTimer);
    officialTimer = setInterval(() => { sampleOfficialBalance().catch(() => {}); }, officialPollMs);
  }

  /** Push the effective config into all runtime variables. */
  function applyEffectiveConfig() {
    const pricing = effectiveCfg.pricing;
    const ratio = Number(pricing.offPeakRatio);
    OFF_PEAK_RATIO = Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 0.5;
    const effective = { ...BUILTIN_PRICING };
    const models = pricing.models;
    if (typeof models.default === 'string' && models.default.trim() !== '') {
      try {
        const entry = parsePriceEntry(JSON.parse(models.default));
        if (entry) effective.default = entry;
      } catch (error) {
        logger.warn(`dsh-resmon: invalid pricing.models.default JSON, keeping built-in: ${String(error?.message ?? error)}`);
      }
    }
    if (typeof models.overrides === 'string' && models.overrides.trim() !== '') {
      try {
        const overrides = JSON.parse(models.overrides);
        if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
          for (const [modelId, value] of Object.entries(overrides)) {
            const entry = parsePriceEntry(value);
            if (entry) effective[modelId] = entry;
          }
        }
      } catch (error) {
        logger.warn(`dsh-resmon: invalid pricing.models.overrides JSON, keeping built-in: ${String(error?.message ?? error)}`);
      }
    }
    PRICING = effective;
    const mode = effectiveCfg.official.mode;
    officialMode = ['auto', 'apikey', 'account', 'off'].includes(mode) ? mode : 'auto';
    const poll = Number(effectiveCfg.official.pollSeconds);
    officialPollMs = Number.isFinite(poll) && poll >= 15 && poll <= 600
      ? Math.round(poll * 1000) : OFFICIAL_BALANCE_INTERVAL_MS;
    whaleEnabled = effectiveCfg.whale.enabled !== false;
    whalePath = typeof effectiveCfg.whale.path === 'string' ? effectiveCfg.whale.path.trim() : '';
    const s = effectiveCfg.sampling;
    const n = Number(s.netGpuSeconds);
    netGpuEveryTicks = Number.isFinite(n) && n >= 1 ? Math.max(1, Math.round(n)) : 2;
    const d = Number(s.diskSeconds);
    diskEveryTicks = Number.isFinite(d) && d >= 2 ? Math.max(2, Math.round(d)) : 5;
    const m = Number(s.dshsizeMinutes);
    dshsizeEveryTicks = Number.isFinite(m) && m >= 1 ? Math.max(60, Math.round(m * 60)) : 300;
    // External loopback API: start / restart / stop according to config.
    externalEnabled = effectiveCfg.external.enabled === true;
    const ep = Number(effectiveCfg.external.port);
    externalPort = Number.isFinite(ep) && ep >= 1024 && ep <= 65535 ? Math.round(ep) : EXTERNAL_DEFAULT_PORT;
    if (externalEnabled) {
      if (externalServer === null || externalListeningPort !== externalPort) {
        stopExternalServer();
        startExternalServer();
      }
      startPipeServer(); // no-op when already running or on non-win32
    } else {
      stopExternalServer();
      stopPipeServer();
    }
    startOfficialTimer();
  }

  /** Atomic config write: temp file + rename (mkdir -p first). */
  async function writeConfigFile(value) {
    const home = homeDir();
    if (!home) throw new Error('cannot resolve the home directory');
    const target = join(home, CONFIG_FILENAME);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rename(tmp, target);
    } catch (error) {
      try { await unlink(tmp); } catch { /* best effort */ }
      throw error;
    }
  }

  /** POST body → validate → persist → immediate apply. Throws on failure. */
  async function configPostValue(body) {
    const merged = validateConfigPatch(effectiveCfg, body);
    if (!merged.ok) throw new Error(merged.error);
    await writeConfigFile(merged.value);
    effectiveCfg = merged.value;
    applyEffectiveConfig();
    return cloneConfig(effectiveCfg);
  }

  /* ==================== external loopback HTTP API ==================== */

  function externalResponse(res, status, body, contentType) {
    try {
      res.writeHead(status, {
        'content-type': contentType ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    } catch { /* socket already gone */ }
  }

  function stopExternalServer() {
    if (externalServer === null) return;
    const server = externalServer;
    externalServer = null;
    externalListeningPort = null;
    externalState.running = false;
    try { server.close(); } catch { /* never listened */ }
  }

  /** Shared panel-command validation (HTTP POST /v1/panel and the named
   *  pipe use exactly the same rules): items ⊆ 8-item whitelist (deduped),
   *  collapsed boolean, scope machine|dsh, metric turn|session|today|cumulative. */
  function validatePanelCommand(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'body must be a JSON object' };
    const command = {};
    if (parsed.items !== undefined) {
      if (!Array.isArray(parsed.items) || parsed.items.some((item) => typeof item !== 'string' || !PANEL_ITEM_WHITELIST.includes(item))) {
        return { ok: false, error: `items must be an array containing only: ${PANEL_ITEM_WHITELIST.join(', ')}` };
      }
      command.items = [...new Set(parsed.items)];
    }
    if (parsed.collapsed !== undefined) {
      if (typeof parsed.collapsed !== 'boolean') return { ok: false, error: 'collapsed must be a boolean' };
      command.collapsed = parsed.collapsed;
    }
    if (parsed.scope !== undefined) {
      if (!PANEL_SCOPE_VALUES.includes(parsed.scope)) return { ok: false, error: `scope must be one of: ${PANEL_SCOPE_VALUES.join(', ')}` };
      command.scope = parsed.scope;
    }
    if (parsed.metric !== undefined) {
      if (!PANEL_METRIC_VALUES.includes(parsed.metric)) return { ok: false, error: `metric must be one of: ${PANEL_METRIC_VALUES.join(', ')}` };
      command.metric = parsed.metric;
    }
    return { ok: true, command };
  }

  function applyPanelCommand(command) {
    panelCommand.revision = Date.now();
    panelCommand.command = command;
    return { ...panelCommand };
  }

  function handleExternalRequest(req, res) {
    let url;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { url = null; }
    if (!url) { externalResponse(res, 400, { ok: false, error: 'bad url' }); return; }
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const routeHandlers = {
      '/': {
        GET: () => externalResponse(res, 200, {
          ok: true,
          service: 'dsh-resmon',
          version: PLUGIN_VERSION,
          endpoints: ['/v1/health', '/v1/stats', '/v1/usage', '/v1/panel', '/v1/stream', '/v1/spec'],
          spec: '/v1/spec',
        }),
      },
      '/v1/health': {
        GET: () => externalResponse(res, 200, { ok: true, pid: process.pid, uptimeSeconds: Math.floor(process.uptime()) }),
      },
      '/v1/stats': {
        GET: () => externalResponse(res, 200, { ok: true, value: statsPayload() }),
      },
      '/v1/usage': {
        GET: () => {
          const sessionId = url.searchParams.get('sessionId') ?? undefined;
          externalResponse(res, 200, { ok: true, value: usagePayload(sessionId) });
        },
      },
      '/v1/panel': {
        GET: () => externalResponse(res, 200, { ok: true, value: { ...panelCommand } }),
        POST: () => {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 65536) req.destroy();
          });
          req.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
          req.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(body || '{}'); } catch { parsed = null; }
            const result = validatePanelCommand(parsed);
            if (!result.ok) {
              externalResponse(res, 400, { ok: false, error: result.error });
              return;
            }
            externalResponse(res, 200, { ok: true, value: applyPanelCommand(result.command) });
          });
        },
      },
      '/v1/stream': {
        GET: () => {
          const parsedInterval = Number(url.searchParams.get('interval'));
          const intervalMs = Number.isFinite(parsedInterval) && parsedInterval >= 250 && parsedInterval <= 10000
            ? Math.round(parsedInterval) : 1000;
          try {
            res.writeHead(200, {
              'content-type': 'application/x-ndjson; charset=utf-8',
              'cache-control': 'no-store',
              'connection': 'keep-alive',
            });
          } catch { return; }
          let timer = null;
          const writeLine = () => {
            try {
              res.write(`${JSON.stringify({ type: 'stats', ts: Date.now(), value: statsPayload() })}\n`);
            } catch {
              if (timer !== null) clearInterval(timer);
              timer = null;
              try { res.destroy(); } catch { /* ignore */ }
            }
          };
          writeLine(); // first line immediately
          timer = setInterval(writeLine, intervalMs);
          res.on('close', () => {
            if (timer !== null) clearInterval(timer);
            timer = null;
          });
          res.on('error', () => {
            if (timer !== null) clearInterval(timer);
            timer = null;
          });
        },
      },
      '/v1/spec': {
        GET: async () => {
          try {
            const spec = buildExternalSpec();
            externalResponse(res, 200, spec, 'text/markdown; charset=utf-8');
          } catch (error) {
            externalResponse(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      },
    };
    const handlers = routeHandlers[path];
    if (!handlers) { externalResponse(res, 404, { ok: false, error: 'not found' }); return; }
    const handler = handlers[method];
    if (!handler) {
      res.writeHead(405, { allow: Object.keys(handlers).join(', '), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
      return;
    }
    handler();
  }

  function startExternalServer() {
    if (!externalEnabled || externalServer !== null) return;
    externalState.error = null;
    const server = createServer((req, res) => {
      try {
        handleExternalRequest(req, res);
      } catch (error) {
        externalResponse(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    });
    server.on('error', (error) => {
      externalState.error = String(error?.message ?? error);
      externalState.running = false;
      logger.warn(`dsh-resmon: external HTTP server error: ${externalState.error}`);
    });
    externalServer = server;
    server.listen(externalPort, '127.0.0.1', () => {
      externalListeningPort = externalPort;
      externalState.running = true;
      externalState.error = null;
      logger.debug?.(`dsh-resmon: external HTTP server listening on 127.0.0.1:${externalPort}`);
      writeExternalSpec(buildExternalSpec())
        .catch((error) => logger.warn(`dsh-resmon: external spec generation failed: ${String(error?.message ?? error)}`));
    });
  }

  /* ---- Windows named pipe channel (CONTRACT.md §12.2) ---- */

  function startPipeServer() {
    if (!IS_WIN32 || !externalEnabled || pipeServer !== null) return;
    const server = createNetServer((socket) => {
      pipeConnections.add(socket);
      let buffer = '';
      let timer = null;
      const cleanup = () => {
        if (timer !== null) clearInterval(timer);
        timer = null;
        pipeConnections.delete(socket);
        try { socket.destroy(); } catch { /* ignore */ }
      };
      const writeJson = (obj) => {
        try { socket.write(`${JSON.stringify(obj)}\n`); } catch { cleanup(); }
      };
      const statsLine = () => {
        writeJson({ type: 'stats', ts: Date.now(), value: statsPayload() });
      };
      statsLine();
      timer = setInterval(statsLine, 1000);
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 65536) {
          writeJson({ type: 'error', error: 'line too long (64KB cap)' });
          cleanup();
          return;
        }
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let parsed = null;
          try { parsed = JSON.parse(line); } catch { parsed = null; }
          const isCommand = parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            (parsed.items !== undefined || parsed.collapsed !== undefined || parsed.scope !== undefined || parsed.metric !== undefined);
          if (!isCommand) continue; // non-command lines are ignored
          const result = validatePanelCommand(parsed);
          if (!result.ok) {
            writeJson({ type: 'error', error: result.error });
          } else {
            writeJson({ type: 'ack', value: applyPanelCommand(result.command) });
          }
        }
      });
      socket.on('error', cleanup);
      socket.on('end', cleanup);
      socket.on('close', cleanup);
    });
    server.on('error', (error) => {
      logger.warn(`dsh-resmon: named pipe server error: ${String(error?.message ?? error)}`);
    });
    pipeServer = server;
    server.listen(EXTERNAL_PIPE_NAME, () => {
      logger.debug?.(`dsh-resmon: named pipe listening on ${EXTERNAL_PIPE_NAME}`);
    });
  }

  function stopPipeServer() {
    if (pipeServer === null) return;
    const server = pipeServer;
    pipeServer = null;
    try { server.close(); } catch { /* never listened */ }
    for (const socket of [...pipeConnections]) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    pipeConnections.clear();
  }

  /** Chinese Markdown spec for the external API (endpoint table, parameters,
   *  response examples, curl / PowerShell / Python / Node.js / C# snippets,
   *  version and generation time). */
  function buildExternalSpec() {
    const base = `http://127.0.0.1:${externalPort}`;
    const items = PANEL_ITEM_WHITELIST.join('、');
    const generatedAt = new Date().toISOString();
    return `# dsh-resmon 外部程序接口规范

资源监控插件(@local/dsh-resmon)为外部本机程序提供的回环 HTTP 接口。
服务仅在配置 external.enabled 为真时监听 **127.0.0.1:${externalPort}**,不对外网开放;不提供任何凭据、密钥或写配置/执行命令能力(仅读数据与面板参数控制)。

- 所有响应带 \`Cache-Control: no-store\`;JSON 响应为 \`application/json; charset=utf-8\`,规范文档为 \`text/markdown; charset=utf-8\`。
- 版本:${PLUGIN_VERSION};生成时间:${generatedAt}(北京时间 ${new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)})。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | / | 服务信息与端点列表 |
| GET | /v1/health | 健康检查(pid、uptimeSeconds) |
| GET | /v1/stats | 当前资源采样快照(CPU/内存/磁盘/网络/GPU/DSH 占用等,与面板同结构) |
| GET | /v1/usage?sessionId=... | Token 与费用统计(可选 sessionId) |
| GET | /v1/panel | 当前面板参数命令 |
| POST | /v1/panel | 下发面板参数命令(增删监控项/折叠/口径/Token 视图) |
| GET | /v1/stream?interval=ms | 资源快照流(NDJSON,每行一条) |
| GET | /v1/spec | 本规范文档(Markdown) |

未知路径返回 404、方法不符返回 405(JSON)。

## 响应示例

### GET /v1/health

\`\`\`json
{ "ok": true, "pid": 1234, "uptimeSeconds": 3600 }
\`\`\`

### GET /v1/stats

\`\`\`json
{ "ok": true, "value": { "now": 1730000000000, "cpu": 12.3, "mem": { "percent": 41.2 }, "disk": [ { "drive": "C:", "percent": 41.2, "activePercent": 12.5 } ], "net": { "available": true, "downBps": 0, "upBps": 0 }, "gpu": { "available": true, "util": 34.5, "memUsed": 0, "memTotal": null }, "system": { "osVersion": "Win11 26H2 26300.9711" } } }
\`\`\`

### POST /v1/panel

请求体(全部可选):

\`\`\`json
{
  "items": ["cpu", "mem", "tokens"],   // 白名单:${items}
  "collapsed": false,
  "scope": "machine",                  // machine | dsh
  "metric": "today"                    // turn | session | today | cumulative
}
\`\`\`

响应:

\`\`\`json
{ "ok": true, "value": { "revision": 1792347556758, "command": { "items": ["cpu", "mem", "tokens"], "collapsed": false } } }
\`\`\`

非法参数返回 HTTP 400:\`{ "ok": false, "error": "items must be an array containing only: ..." }\`。

## 调用示例

### curl

\`\`\`bash
curl -s ${base}/v1/health
curl -s "${base}/v1/usage?sessionId=<会话id>"
curl -s -X POST ${base}/v1/panel -H "Content-Type: application/json" -d '{"items":["cpu","mem","tokens"],"collapsed":false}'
\`\`\`

### PowerShell

\`\`\`powershell
Invoke-RestMethod -Uri '${base}/v1/stats'
Invoke-RestMethod -Method Post -Uri '${base}/v1/panel' -ContentType 'application/json' -Body '{"items":["cpu","mem","tokens"]}'
\`\`\`

### Python

\`\`\`python
import requests
print(requests.get('${base}/v1/health').json())
print(requests.post('${base}/v1/panel', json={"items": ["cpu", "mem"], "collapsed": False}).json())
\`\`\`

### Node.js

\`\`\`js
const res = await fetch('${base}/v1/stats');
console.log(await res.json());
await fetch('${base}/v1/panel', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items: ['cpu', 'gpu'] }),
});
\`\`\`

### C#

\`\`\`csharp
using var client = new HttpClient { BaseAddress = new Uri("${base}") };
var stats = await client.GetStringAsync("/v1/stats");
await client.PostAsync("/v1/panel", new StringContent(
    "{\\"items\\":[\\"cpu\\",\\"gpu\\"]}", System.Text.Encoding.UTF8, "application/json"));
\`\`\`

## 流式通道

### HTTP 流式端点 /v1/stream

\`GET ${base}/v1/stream?interval=1000\`(interval 毫秒,范围 250–10000,默认 1000;非法值回默认)。响应为 \`application/x-ndjson; charset=utf-8\`(chunked,\`Cache-Control: no-store\`),立即写首行,此后每 interval 写一行,每行一个 JSON、以 \`\\n\` 结尾:

\`\`\`json
{ "type": "stats", "ts": 1792347556758, "value": { "cpu": 12.3, "mem": { "percent": 41.2 } } }
\`\`\`

客户端断开连接后服务端即停止写入。

### Windows 命名管道 \\\\.\\pipe\\dsh-resmon

仅 Windows 且 external.enabled 为真时存在。每个连接每 1000ms 收到一行与 /v1/stream 相同结构的 stats NDJSON;客户端也可向管道写 JSON 行(每行以 \`\\n\` 结尾,单行 ≤64KB)下发面板命令,字段与 POST /v1/panel 相同(items/collapsed/scope/metric,全部可选):

- 合法命令 → 回一行 \`{ "type": "ack", "value": { "revision": <ms>, "command": { ... } } }\`
- 非法命令 → 回一行 \`{ "type": "error", "error": "..." }\`
- 非命令 JSON 行与无法解析的行被忽略;单行超 64KB 断开连接。

### C 示例一:WinHTTP 流式读(完整可编译)

\`\`\`c
// stream_winhttp.c — MSVC: cl stream_winhttp.c winhttp.lib | MinGW: gcc stream_winhttp.c -lwinhttp
#include <windows.h>
#include <winhttp.h>
#include <stdio.h>

int main(void) {
    HINTERNET session = WinHttpOpen(L"dsh-resmon-stream/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) { fprintf(stderr, "WinHttpOpen failed: %lu\\n", GetLastError()); return 1; }
    HINTERNET connect = WinHttpConnect(session, L"127.0.0.1", ${externalPort}, 0);
    HINTERNET request = connect ? WinHttpOpenRequest(connect, L"GET",
        L"/v1/stream?interval=1000", NULL, WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES, 0) : NULL;
    if (!request || !WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
            WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request, NULL)) {
        fprintf(stderr, "request failed: %lu\\n", GetLastError()); return 1;
    }
    char buf[4096]; DWORD n = 0; int lines = 0;
    while (lines < 5) {                 // 示例:读 5 行后退出
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request, &available)) break;
        DWORD want = (available < (DWORD)sizeof(buf)) ? available : (DWORD)sizeof(buf);
        if (want == 0) { Sleep(50); continue; }
        if (!WinHttpReadData(request, buf, want, &n) || n == 0) break;
        for (DWORD i = 0; i < n; i++) if (buf[i] == '\\n') lines++;  // 按行计数/解析
        fwrite(buf, 1, n, stdout);
    }
    WinHttpCloseHandle(request); WinHttpCloseHandle(connect); WinHttpCloseHandle(session);
    return 0;
}
\`\`\`

### C 示例二:命名管道读 + 写面板命令(完整可编译)

\`\`\`c
// pipe_client.c — MSVC: cl pipe_client.c | MinGW: gcc pipe_client.c
#include <windows.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    HANDLE pipe = CreateFileW(L"\\\\\\\\.\\\\pipe\\\\dsh-resmon",
        GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "CreateFileW failed: %lu\\n", GetLastError()); return 1;
    }
    char buf[8192]; DWORD n = 0; int lines = 0;
    while (lines < 2) {                  // 1) 读 2 行 stats NDJSON
        if (!ReadFile(pipe, buf, sizeof(buf) - 1, &n, NULL) || n == 0) break;
        for (DWORD i = 0; i < n; i++) if (buf[i] == '\\n') lines++;
        fwrite(buf, 1, n, stdout);
    }
    const char cmd[] = "{\\"collapsed\\":true}\\n";   // 2) 写面板命令
    DWORD written = 0;
    if (!WriteFile(pipe, cmd, (DWORD)(sizeof(cmd) - 1), &written, NULL)) {
        fprintf(stderr, "WriteFile failed: %lu\\n", GetLastError());
    }
    while (ReadFile(pipe, buf, sizeof(buf) - 1, &n, NULL) && n > 0) {  // 3) 读 ack 行
        fwrite(buf, 1, n, stdout);
        if (memchr(buf, '\\n', n)) break;
    }
    CloseHandle(pipe);
    return 0;
}
\`\`\`

### C++ 示例:libcurl 回调按行解析(需 libcurl)

\`\`\`cpp
// stream_curl.cpp — 编译: g++ stream_curl.cpp -lcurl (需安装 libcurl)
#include <curl/curl.h>
#include <cstdio>
#include <string>

static size_t onData(char *ptr, size_t size, size_t nmemb, void *userdata) {
    std::string &buffer = *static_cast<std::string *>(userdata);
    buffer.append(ptr, size * nmemb);
    size_t pos;
    while ((pos = buffer.find('\\n')) != std::string::npos) {
        std::string line = buffer.substr(0, pos);
        buffer.erase(0, pos + 1);
        std::printf("%s\\n", line.c_str());   // 按行处理(例如解析 JSON)
    }
    return size * nmemb;
}

int main() {
    CURL *curl = curl_easy_init();
    if (!curl) return 1;
    std::string buffer;
    curl_easy_setopt(curl, CURLOPT_URL, "${base}/v1/stream?interval=1000");
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, onData);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buffer);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 15000L);   // 示例:15 秒后结束
    CURLcode code = curl_easy_perform(curl);
    curl_easy_cleanup(curl);
    return code == CURLE_OK ? 0 : 1;
}
\`\`\`
`;
  }

  /** Write the spec into <home>/dsh-resmon-external-api.md; returns path. */
  async function writeExternalSpec(spec) {
    const home = homeDir();
    if (!home) throw new Error('cannot resolve the home directory');
    const target = join(home, EXTERNAL_SPEC_FILENAME);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, spec, 'utf8');
    return target;
  }

  /** Build + persist the spec, returning { path, content } for the routes. */
  async function ensureExternalSpec() {
    const content = buildExternalSpec();
    const path = await writeExternalSpec(content);
    return { path, content };
  }

  /* ---- boot: schemastery Config over defaults, then the JSON file wins ---- */
  const cfgMerged = validateConfigPatch(defaultConfig(), cfg);
  if (cfgMerged.ok) effectiveCfg = cfgMerged.value;
  else logger.warn(`dsh-resmon: ignoring invalid schemastery config: ${cfgMerged.error}`);
  let fileCfg = null;
  try {
    const home = homeDir();
    if (home) fileCfg = JSON.parse(readFileSync(join(home, CONFIG_FILENAME), 'utf8'));
  } catch {
    fileCfg = null; // missing / unreadable / corrupt → defaults win
  }
  if (fileCfg !== null) {
    const merged = validateConfigPatch(effectiveCfg, fileCfg);
    if (merged.ok) effectiveCfg = merged.value;
    else logger.warn(`dsh-resmon: ignoring invalid ${CONFIG_FILENAME}: ${merged.error}`);
  }
  applyEffectiveConfig();

  /* ------------------------------------------------------------------ *
   * 1. CPU / memory / disk / network / GPU sampling                     *
   * ------------------------------------------------------------------ */
  const history = { cpu: [], mem: [], time: [] };
  const dshHistory = { cpu: [], mem: [] };
  let lastCpu = os.cpus().map((c) => ({ ...c.times }));
  let lastCpuUsage = process.cpuUsage();
  let lastSampleAt = Date.now();
  let tick = 0;

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  /* ---- 1.1 Disk: probe A-Z once at boot and every 5 minutes; statfs
   *          each present drive every 5 s. Probe errors skip the drive;
   *          a transient sample error keeps the previous sample. ---- */
  const diskState = {
    drives: new Map(), // 'C:' -> { drive, total, free, used, percent }
    active: new Map(), // 'C:' -> active-time % (from the merged 2 s sampler)
    busy: false,
  };

  async function probeDrives() {
    if (!IS_WIN32 || diskState.busy) return;
    diskState.busy = true;
    try {
      const found = new Map();
      for (let code = 65; code <= 90; code += 1) {
        const drive = `${String.fromCharCode(code)}:`;
        try {
          const s = await statfs(`${drive}\\`);
          const total = (Number(s.blocks) || 0) * (Number(s.bsize) || 0);
          if (total <= 0) continue;
          const free = (Number(s.bavail) || 0) * (Number(s.bsize) || 0);
          const used = total - free;
          found.set(drive, { drive, total, free, used, percent: (used / total) * 100 });
        } catch {
          // No such drive / inaccessible — skip it.
        }
      }
      for (const [drive, data] of found) {
        const prev = diskState.drives.get(drive);
        diskState.drives.set(drive, prev ? { ...prev, ...data } : data);
      }
      for (const drive of [...diskState.drives.keys()]) {
        if (!found.has(drive)) diskState.drives.delete(drive);
      }
    } catch (error) {
      logger.warn(`dsh-resmon: drive probe failed: ${String(error?.message ?? error)}`);
    } finally {
      diskState.busy = false;
    }
  }

  async function sampleDisk() {
    if (!IS_WIN32 || diskState.busy) return;
    diskState.busy = true;
    try {
      for (const [drive] of diskState.drives) {
        try {
          const s = await statfs(`${drive}\\`);
          const total = (Number(s.blocks) || 0) * (Number(s.bsize) || 0);
          if (total <= 0) continue;
          const free = (Number(s.bavail) || 0) * (Number(s.bsize) || 0);
          const used = total - free;
          diskState.drives.set(drive, { drive, total, free, used, percent: (used / total) * 100 });
        } catch {
          // Transient statfs failure: keep the previous sample for this drive.
        }
      }
    } catch (error) {
      logger.warn(`dsh-resmon: disk sampling failed: ${String(error?.message ?? error)}`);
    } finally {
      diskState.busy = false;
    }
  }

  /* ---- 1.2 Merged 2 s Windows sampler: one PowerShell spawn gathers
   *          network adapter bytes, per-drive active-time % and (with the
   *          generic GPU backend) GPU utilization / dedicated memory. Async
   *          spawn + busy guard + try/catch; the net piece keeps the same
   *          semantics as before (diff over real elapsed time, any failure
   *          → available:false with an empty history). ---- */
  const netState = {
    available: false,
    downBps: 0,
    upBps: 0,
    history: [], // totalBps (down + up) per sample point
    lastBytes: null, // { received, sent, at }
  };

  function netFailed() {
    netState.available = false;
    netState.downBps = 0;
    netState.upBps = 0;
    netState.history.length = 0;
    netState.lastBytes = null;
  }

  function netSucceeded(received, sent, atMs) {
    let downBps = 0;
    let upBps = 0;
    const prev = netState.lastBytes;
    if (prev) {
      const dtMs = Math.max(1, atMs - prev.at);
      downBps = Math.max(0, Math.round((received - prev.received) / (dtMs / 1000)));
      upBps = Math.max(0, Math.round((sent - prev.sent) / (dtMs / 1000)));
    }
    netState.lastBytes = { received, sent, at: atMs };
    netState.downBps = downBps;
    netState.upBps = upBps;
    netState.available = true;
    netState.history.push(downBps + upBps);
    if (netState.history.length > MAX_SAMPLES) netState.history.shift();
  }

  const countersState = { busy: false };

  /** One merged failure path: net → unavailable, disk active-time → cleared,
   *  generic-GPU backend → unavailable. (NVIDIA sampling has its own path.) */
  function countersFailed() {
    netFailed();
    diskState.active.clear();
    if (gpuState.backend === 'generic') gpuFailed();
  }

  function applyCountersResult(parsed) {
    // Network: sum Received/Sent bytes over every Up adapter, diff vs previous.
    const adapters = Array.isArray(parsed.net) ? parsed.net : [];
    if (adapters.length === 0) {
      netFailed();
    } else {
      let received = 0;
      let sent = 0;
      for (const adapter of adapters) {
        if (adapter && typeof adapter.ReceivedBytes === 'number') received += adapter.ReceivedBytes;
        if (adapter && typeof adapter.SentBytes === 'number') sent += adapter.SentBytes;
      }
      netSucceeded(received, sent, Date.now());
    }
    // Disk active-time % (Task-Manager style): parse drive letters out of the
    // PhysicalDisk instance names, skip _total / drive-less instances, clamp
    // 0..100. Several instances may share one letter (spanned volumes) → keep
    // the max. The contract regex handles '0 c:'; some machines report one
    // physical disk with several letters ('0 c: d:') — all of them get the
    // same sample value.
    const active = new Map();
    const diskSamples = Array.isArray(parsed.disk) ? parsed.disk : [];
    for (const sample of diskSamples) {
      if (!sample || typeof sample.InstanceName !== 'string') continue;
      const name = sample.InstanceName.trim();
      let letters = null;
      const single = /^(\d+)\s+([A-Za-z]):$/.exec(name);
      if (single) {
        letters = [single[2]];
      } else {
        const multi = /^(\d+)\s+((?:[A-Za-z]:)(?:\s+[A-Za-z]:)*)$/.exec(name);
        if (multi) letters = multi[2].split(/\s+/).map((part) => part[0]);
      }
      if (!letters) continue;
      const value = Number(sample.CookedValue);
      if (!Number.isFinite(value)) continue;
      const clamped = Math.min(100, Math.max(0, value));
      for (const letter of letters) {
        const drive = `${letter.toUpperCase()}:`;
        const previous = active.get(drive);
        if (previous === undefined || clamped > previous) active.set(drive, clamped);
      }
    }
    diskState.active = active;
    // Generic GPU backend: Task-Manager-style utilization — only the 3D
    // engine instances (InstanceName containing 'engtype_3D', case-
    // insensitive) are summed and clamped 0..100, so video-decode/copy
    // engines and per-process instances don't stack up. When no 3D instance
    // exists at all, fall back to summing every instance. Memory samples are
    // summed (already bytes).
    if (gpuState.backend === 'generic') {
      const utilSamples = Array.isArray(parsed.gpuUtil) ? parsed.gpuUtil : [];
      const memSamples = Array.isArray(parsed.gpuMem) ? parsed.gpuMem : [];
      const threeD = utilSamples.filter((sample) => sample &&
        typeof sample.InstanceName === 'string' && /engtype_3d/i.test(sample.InstanceName));
      const utilPool = threeD.length > 0 ? threeD : utilSamples;
      let utilSum = 0;
      let utilCount = 0;
      for (const sample of utilPool) {
        const value = Number(sample && sample.CookedValue);
        if (Number.isFinite(value)) { utilSum += value; utilCount += 1; }
      }
      let memSum = 0;
      let memCount = 0;
      for (const sample of memSamples) {
        const value = Number(sample && sample.CookedValue);
        if (Number.isFinite(value)) { memSum += value; memCount += 1; }
      }
      if (utilCount === 0 && memCount === 0) {
        gpuFailed(); // counter category missing (e.g. localized Windows)
      } else {
        gpuState.util = Math.min(100, Math.max(0, utilSum));
        gpuState.memUsed = Math.max(0, Math.round(memSum));
        // Win32_VideoController.AdapterRAM is a 32-bit value, so large cards
        // can report a truncated total; when usage exceeds it, drop the total.
        if (gpuState.memTotal !== null && gpuState.memUsed > gpuState.memTotal) gpuState.memTotal = null;
        gpuState.available = true;
        gpuState.history.push(gpuState.util);
        if (gpuState.history.length > MAX_SAMPLES) gpuState.history.shift();
      }
    }
  }

  function sampleWindowsCounters() {
    if (!IS_WIN32 || countersState.busy) return;
    countersState.busy = true;
    let settled = false;
    const finish = (applyFn) => {
      if (!settled) {
        settled = true;
        countersState.busy = false;
        applyFn();
      }
    };
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', countersScript(gpuState.backend === 'generic')], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(countersFailed);
      return;
    }
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', () => { /* ignore */ });
    child.on('error', () => finish(countersFailed));
    child.on('close', (code) => {
      if (code !== 0) { finish(countersFailed); return; }
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim()); } catch { parsed = null; }
      if (!parsed || typeof parsed !== 'object') { finish(countersFailed); return; }
      finish(() => applyCountersResult(parsed));
    });
  }

  /* ---- 1.3 GPU: boot probe prefers nvidia-smi (name/util/memUsed/memTotal,
   *          first card, MB → bytes); when that fails, a generic Windows
   *          performance-counter backend is probed via Win32_VideoController
   *          (name/AdapterRAM) and its counters ride the merged sampler.
   *          Both backends failing → available:false. ---- */
  const gpuState = {
    backend: null, // 'nvidia' | 'generic' | null (both probes failed)
    available: false,
    name: null,
    util: 0,
    memUsed: 0,
    memTotal: null, // nullable: unknown for the generic backend / truncated AdapterRAM
    history: [], // util per sample point
    busy: false, // guards the nvidia-smi sampling spawn
  };

  function gpuFailed() {
    gpuState.available = false;
    gpuState.util = 0;
    gpuState.memUsed = 0;
    gpuState.history.length = 0;
  }

  function probeGpu() {
    gpuState.backend = null;
    gpuState.available = false;
    gpuState.name = null;
    gpuState.memTotal = null;
    if (!IS_WIN32) return;
    // 1) NVIDIA backend (richest data: name / util / memUsed / memTotal).
    let output = '';
    try {
      const result = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
      if (result.status === 0 && result.stdout) output = String(result.stdout);
    } catch {
      output = ''; // no nvidia-smi on PATH
    }
    if (output) {
      const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (firstLine) {
        const parts = firstLine.split(',').map((part) => part.trim());
        const name = parts[0];
        const memTotalMb = Number.parseFloat(parts[1]);
        if (name && Number.isFinite(memTotalMb) && memTotalMb > 0) {
          gpuState.name = name;
          gpuState.memTotal = Math.round(memTotalMb * 1024 * 1024); // MB → bytes
          gpuState.backend = 'nvidia';
          gpuState.available = true;
          return;
        }
      }
    }
    // 2) Generic Windows performance-counter backend (AMD / Intel / …).
    let probeOutput = '';
    try {
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', GPU_PROBE_SCRIPT], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
      if (result.status === 0 && result.stdout) probeOutput = String(result.stdout);
      else return;
    } catch {
      return; // powershell unavailable
    }
    let parsed = null;
    try { parsed = JSON.parse(probeOutput.trim()); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return;
    const name = typeof parsed.Name === 'string' ? parsed.Name : null;
    const adapterRam = Number(parsed.AdapterRAM);
    if (!name && !Number.isFinite(adapterRam)) return;
    gpuState.backend = 'generic';
    gpuState.name = name;
    // AdapterRAM is a 32-bit value: values ≥ 0xFFF00000 (4293918720) are the
    // truncation marker for cards with more than ~4 GB of VRAM, so the true
    // total is unknown → null (the client then shows usage without a total).
    const truncated = Number.isFinite(adapterRam) && adapterRam >= 0xfff00000;
    gpuState.memTotal = Number.isFinite(adapterRam) && adapterRam > 0 && !truncated ? adapterRam : null;
    gpuState.available = true;
  }

  function sampleGpu() {
    if (!IS_WIN32 || gpuState.backend !== 'nvidia' || gpuState.busy) return;
    gpuState.busy = true;
    let settled = false;
    const finish = (applyFn) => {
      if (!settled) {
        settled = true;
        gpuState.busy = false;
        applyFn();
      }
    };
    let child;
    try {
      child = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(gpuFailed);
      return;
    }
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', () => { /* ignore */ });
    child.on('error', () => finish(gpuFailed));
    child.on('close', (code) => {
      if (code !== 0) { finish(gpuFailed); return; }
      const firstLine = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (!firstLine) { finish(gpuFailed); return; }
      const parts = firstLine.split(',').map((part) => part.trim());
      const util = Number.parseFloat(parts[0]);
      const memUsedMb = Number.parseFloat(parts[1]);
      if (!Number.isFinite(util) || !Number.isFinite(memUsedMb)) { finish(gpuFailed); return; }
      finish(() => {
        gpuState.util = Math.min(100, Math.max(0, util));
        gpuState.memUsed = Math.round(memUsedMb * 1024 * 1024); // MB → bytes
        gpuState.available = true;
        gpuState.history.push(gpuState.util);
        if (gpuState.history.length > MAX_SAMPLES) gpuState.history.shift();
      });
    });
  }

  /* ---- 1.4 DSH footprint: async recursive walk of the app dir and the
   *          data dir, recomputed every 5 minutes. Junctions/symlinks are
   *          skipped (loop protection), per-entry errors are skipped, and
   *          the event loop is never blocked synchronously. While a walk is
   *          running, `computing` is true and the fields keep their previous
   *          values (null on the very first walk). ---- */
  const dshsizeState = {
    computing: false,
    app: null,
    home: null,
    total: null,
    busy: false,
  };

  function appDir() {
    try {
      return resolve(dirname(process.execPath));
    } catch {
      return null;
    }
  }

  function homeDir() {
    const env = process.env.DSH_HOME;
    if (typeof env === 'string' && env.trim() !== '') {
      try { return resolve(env); } catch { return null; }
    }
    try { return resolve(join(os.homedir(), '.dsh')); } catch { return null; }
  }

  function sameDir(first, second) {
    if (!first || !second) return false;
    if (IS_WIN32) return first.toLowerCase() === second.toLowerCase();
    return first === second;
  }

  /** Sum of file sizes under `dir`; returns null when the root is unreadable.
   *  The Dirent flags (the lstat data readdir already provides) drive the
   *  junction/symlink skip and the directory/file classification. */
  async function walkSize(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    let total = 0;
    for (const entry of entries) {
      const full = join(dir, entry.name);
      try {
        if (entry.isSymbolicLink()) continue; // junctions & symlinks
        if (entry.isDirectory()) {
          total += (await walkSize(full)) ?? 0;
        } else if (entry.isFile()) {
          const st = await stat(full);
          total += Number(st.size) || 0;
        }
        // Other entry kinds are not counted.
      } catch {
        // A single unreadable entry must not fail the walk.
      }
    }
    return total;
  }

  async function computeDshSize() {
    if (dshsizeState.busy) return;
    dshsizeState.busy = true;
    dshsizeState.computing = true;
    try {
      const app = appDir();
      const home = homeDir();
      const dedupe = sameDir(app, home);
      let appSize = null;
      if (app) {
        try { appSize = await walkSize(app); } catch { appSize = null; }
      }
      let homeSize = null;
      if (home && dedupe) {
        homeSize = appSize; // identical directory — walked once
      } else if (home) {
        try { homeSize = await walkSize(home); } catch { homeSize = null; }
      }
      let total = null;
      if (dedupe) {
        total = appSize;
      } else if (appSize !== null || homeSize !== null) {
        total = (appSize ?? 0) + (homeSize ?? 0);
      }
      dshsizeState.app = appSize;
      dshsizeState.home = homeSize;
      dshsizeState.total = total;
    } catch (error) {
      logger.warn(`dsh-resmon: dsh size computation failed: ${String(error?.message ?? error)}`);
    } finally {
      dshsizeState.busy = false;
      dshsizeState.computing = false;
    }
  }

  /* ---- 1.5 System version string (e.g. `Win11 26H2 26300.9711`). ---- */
  let osVersion = null;

  /** Assemble `Win11 26H2 26300.9711`; missing segments are omitted. The
   *  name comes from the build number (≥22000 → Win11), never ProductName
   *  (this machine reports "Windows 10 Pro" for an 11 build). */
  function assembleOsVersion(info) {
    if (!info || typeof info !== 'object') return null;
    const build = Number(info.CurrentBuildNumber);
    const name = Number.isFinite(build) && build > 0 ? (build >= 22000 ? 'Win11' : 'Win10') : null;
    const display = typeof info.DisplayVersion === 'string' && info.DisplayVersion.trim() !== ''
      ? info.DisplayVersion.trim() : null;
    const ubr = Number(info.UBR);
    const buildAndUbr = Number.isFinite(build) && build > 0
      ? (Number.isFinite(ubr) ? `${build}.${ubr}` : `${build}`) : null;
    const parts = [name, display, buildAndUbr].filter((part) => part !== null);
    return parts.length > 0 ? parts.join(' ') : null;
  }

  function probeOsVersion() {
    if (!IS_WIN32) { osVersion = null; return; }
    let output = '';
    try {
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', OS_VERSION_SCRIPT], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
      if (result.status === 0 && result.stdout) output = String(result.stdout);
    } catch {
      output = ''; // fall through to os.release()
    }
    let parsed = null;
    try { parsed = JSON.parse(output.trim()); } catch { parsed = null; }
    osVersion = assembleOsVersion(parsed) ?? os.release();
  }

  function sample() {
    tick += 1;
    const nowMs = Date.now();
    const elapsedMs = Math.max(1, nowMs - lastSampleAt);
    lastSampleAt = nowMs;
    const cpus = os.cpus();
    const cores = cpus.length;
    let totalDelta = 0;
    let idleDelta = 0;
    for (let i = 0; i < cpus.length; i += 1) {
      const prev = lastCpu[i];
      const cur = cpus[i].times;
      if (!prev) continue;
      const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
      const curTotal = cur.user + cur.nice + cur.sys + cur.idle + cur.irq;
      totalDelta += curTotal - prevTotal;
      idleDelta += cur.idle - prev.idle;
    }
    lastCpu = cpus.map((c) => ({ ...c.times }));
    const cpuPercent = totalDelta <= 0
      ? history.cpu[history.cpu.length - 1] ?? 0
      : Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100));
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPercent = totalMem > 0 ? (1 - freeMem / totalMem) * 100 : 0;
    history.cpu.push(round1(cpuPercent));
    history.mem.push(round1(memPercent));
    history.time.push(nowMs);
    // DSH 后端进程自身的占用(占整机总容量的百分比)
    const cpuDelta = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    const dshCpuPercent = cores > 0
      ? Math.min(100, ((cpuDelta.user + cpuDelta.system) / (elapsedMs * 1000) / cores) * 100)
      : 0;
    dshHistory.cpu.push(round1(dshCpuPercent));
    dshHistory.mem.push(process.memoryUsage().rss);
    if (history.cpu.length > MAX_SAMPLES) {
      history.cpu.shift();
      history.mem.shift();
      history.time.shift();
      dshHistory.cpu.shift();
      dshHistory.mem.shift();
    }
    // Sub-sampling cadences driven by the same 1-second tick (configurable).
    if (tick % netGpuEveryTicks === 0) {
      sampleWindowsCounters(); // merged: net + disk active (+ generic GPU counters)
      sampleGpu();             // nvidia-smi only, when that backend is active
    }
    if (tick % diskEveryTicks === 0) sampleDisk();
    if (tick % dshsizeEveryTicks === 0) {
      probeDrives();
      computeDshSize().catch(() => {});
    }
  }

  sample();
  probeGpu(); // synchronous boot probe (per contract)
  probeOsVersion(); // synchronous registry probe (per contract)
  probeDrives().catch(() => {});
  computeDshSize().catch(() => {}); // first footprint walk, right away
  const sampleTimer = setInterval(sample, 1000);
  ctx.effect(() => () => clearInterval(sampleTimer));

  /* ------------------------------------------------------------------ *
   * 2. Token usage + cost fold                                          *
   *    - foldSeq: global dedup boundary, persisted per session          *
   *    - scanSeq: full-log scan boundary for session totals (memory)    *
   *    - cost shares the exact same dedup (foldSeq/scanSeq)             *
   * ------------------------------------------------------------------ */
  const state = {
    cumulative: { input: 0, output: 0, cost: 0 },
    byDay: new Map(), // dayKey -> { input, output, cost }
    sessions: new Map(), // sessionId -> { foldSeq, scanSeq, input, output, cost, turn, turnInput, turnOutput, turnCost, model, reasoningEffort }
  };

  function sessionRecord(sessionId) {
    let rec = state.sessions.get(sessionId);
    if (!rec) {
      rec = {
        foldSeq: 0,
        scanSeq: 0,
        input: 0,
        output: 0,
        cost: 0,
        turn: 0,
        turnInput: 0,
        turnOutput: 0,
        turnCost: 0,
        model: null,
        reasoningEffort: null,
      };
      state.sessions.set(sessionId, rec);
    }
    return rec;
  }

  function addTo(target, usage) {
    target.input += usage.input;
    target.output += usage.output;
    target.cost = (target.cost ?? 0) + (typeof usage.cost === 'number' ? usage.cost : 0);
  }

  /** Pull `header.config` out of a `request/header` event, defensively. */
  function headerConfigOf(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
    const header = data?.header ?? payload.header ?? null;
    let config = null;
    if (header && typeof header.config === 'object') config = header.config;
    if (!config && data && typeof data.config === 'object') config = data.config;
    if (!config && typeof payload.config === 'object') config = payload.config;
    return config;
  }

  function applyHeaderToRecord(rec, config) {
    if (!rec || !config || typeof config !== 'object') return;
    if (typeof config.model === 'string') rec.model = config.model;
    if (typeof config.reasoningEffort === 'string') rec.reasoningEffort = normalizeReasoningEffort(config.reasoningEffort);
  }

  /** Best-effort sessionId extraction across the varying event payload shapes. */
  function sessionIdOf(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
    const session = payload.session ?? data?.session ?? null;
    if (typeof session === 'string') return session;
    if (session && typeof session.id === 'string') return session.id;
    if (typeof payload.sessionId === 'string') return payload.sessionId;
    if (data && typeof data.sessionId === 'string') return data.sessionId;
    const agent = payload.agent ?? null;
    if (typeof agent === 'string') return agent;
    if (agent && typeof agent === 'object') {
      if (typeof agent.sessionId === 'string') return agent.sessionId;
      if (typeof agent.id === 'string') return agent.id;
      if (agent.session && typeof agent.session.id === 'string') return agent.session.id;
    }
    if (typeof payload.id === 'string') return payload.id;
    return null;
  }

  /** Fold one event into global (today/cumulative) and per-session scan totals. */
  function foldEvent(sessionId, event) {
    if (!event || typeof event.seq !== 'number') return;
    const rec = sessionRecord(sessionId);
    const isNewForGlobal = event.seq > rec.foldSeq;
    const isNewForScan = event.seq > rec.scanSeq;
    if (!isNewForGlobal && !isNewForScan) return;
    const usage = usageOf(event);
    if (isNewForScan) {
      rec.scanSeq = event.seq;
      if (event.type === 'turn/start' && event.data && typeof event.data.turn === 'number') {
        rec.turn = event.data.turn;
        rec.turnInput = 0;
        rec.turnOutput = 0;
        rec.turnCost = 0;
      }
      if (event.type === 'request/header') {
        applyHeaderToRecord(rec, headerConfigOf(event));
      }
      if (usage) {
        addTo(rec, usage);
        rec.turnInput += usage.input;
        rec.turnOutput += usage.output;
        rec.turnCost = round6((rec.turnCost ?? 0) + (usage.cost ?? 0));
      }
    }
    if (isNewForGlobal && usage) {
      rec.foldSeq = event.seq;
      addTo(state.cumulative, usage);
      const dayKey = localDayKey(event.time);
      let day = state.byDay.get(dayKey);
      if (!day) {
        day = { input: 0, output: 0, cost: 0 };
        state.byDay.set(dayKey, day);
      }
      addTo(day, usage);
    } else if (isNewForGlobal) {
      rec.foldSeq = event.seq;
    }
    // keep the byDay map bounded
    if (state.byDay.size > 16) {
      const oldest = [...state.byDay.keys()].sort()[0];
      if (oldest) state.byDay.delete(oldest);
    }
  }

  /** Fold a session's log tail (from the recorded boundaries). */
  function catchUpSession(session) {
    if (!session || typeof session.id !== 'string') return;
    const rec = sessionRecord(session.id);
    let events;
    try {
      events = session.snapshotEvents(Math.min(rec.foldSeq, rec.scanSeq) || 0);
    } catch (error) {
      logger.warn(`dsh-resmon: snapshotEvents failed for ${session.id}: ${String(error)}`);
      return;
    }
    for (const event of events) foldEvent(session.id, event);
  }

  function catchUpAll() {
    const sessions = ctx.get('sessions');
    if (!sessions || typeof sessions.list !== 'function') return;
    for (const session of sessions.list()) {
      try {
        catchUpSession(session);
      } catch { /* a half-open session must not break the poll */ }
    }
  }

  // Running state per session + live streamed chars for the estimated cost.
  const runningSessions = new Map(); // sessionId -> boolean
  const liveChars = new Map(); // sessionId -> number

  // Live, post-commit append feed (fire-and-forget).
  ctx.on('session/event', (session, event) => {
    try {
      if (isSessionEventLike(session, event)) {
        if (event.type === 'turn/start') liveChars.set(session.id, 0);
        foldEvent(session.id, event);
      }
    } catch { /* never break session dispatch */ }
  });

  // Live request/header feed: remember the current model / reasoning level.
  ctx.on('request/header', (payload) => {
    try {
      const sessionId = sessionIdOf(payload);
      if (typeof sessionId !== 'string') return;
      applyHeaderToRecord(sessionRecord(sessionId), headerConfigOf(payload));
    } catch { /* never break event dispatch */ }
  });

  ctx.on('agent/status', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const status = payload.status;
      if (status !== 'running' && status !== 'idle') return;
      const sessionId = sessionIdOf(payload);
      if (typeof sessionId !== 'string') return;
      runningSessions.set(sessionId, status === 'running');
    } catch { /* defensive: event shape may differ */ }
  });

  ctx.on('agent/assistant-stream', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const sessionId = sessionIdOf(payload);
      const frame = payload.frame;
      if (typeof sessionId !== 'string' || !frame || typeof frame !== 'object') return;
      let delta = 0;
      if (frame.type === 'text-chunks' || frame.type === 'reasoning-chunks') {
        if (Array.isArray(frame.texts)) {
          for (const text of frame.texts) if (typeof text === 'string') delta += text.length;
        }
      } else if (frame.type === 'chunk' && frame.chunk && typeof frame.chunk === 'object' &&
        (frame.chunk.type === 'text-delta' || frame.chunk.type === 'reasoning-delta')) {
        if (typeof frame.chunk.text === 'string') delta += frame.chunk.text.length;
      }
      if (delta > 0) liveChars.set(sessionId, (liveChars.get(sessionId) ?? 0) + delta);
    } catch { /* defensive: event shape may differ */ }
  });

  /* ------------------------------------------------------------------ *
   * 2.5 History backfill: scan <home>/sessions/**\/session.v4.jsonl.zstd
   *     artifacts (multi-frame zstd + optional plaintext tail) and fold
   *     assistant/message events newer than the persisted foldSeq —
   *     the existing seq boundaries make this replay-safe. One full pass
   *     at boot, then mtime-incremental every 10 minutes; per-file errors
   *     are skipped with a warning and the loop yields between files.    *
   * ------------------------------------------------------------------ */
  const backfillMtimes = new Map(); // filePath -> last processed mtimeMs
  let backfillBusy = false;

  /** Decompress the complete frames, then append the torn tail as text. */
  function decodeSessionArtifact(buf) {
    const { frames, tornStart } = scanZstdFrames(buf);
    let text = '';
    for (const frame of frames) {
      text += zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8');
    }
    if (tornStart !== undefined) {
      // Plaintext JSONL tail; its trailing 4-byte checksum pollutes the last
      // line, which the per-line JSON.parse skip absorbs.
      text += buf.subarray(tornStart).toString('utf8');
    } else if (frames.length === 0) {
      text = buf.toString('utf8');
    }
    return text;
  }

  async function processArtifactFile(filePath, dirName) {
    const buf = await readFile(filePath);
    const text = decodeSessionArtifact(buf);
    let sessionId = dirName; // the header line (type === 'session') wins
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let event = null;
      try { event = JSON.parse(line); } catch { continue; } // corrupt/polluted line — skip
      if (!event || typeof event !== 'object') continue;
      if (event.type === 'session') {
        if (typeof event.id === 'string' && event.id) sessionId = event.id;
        continue; // header line — never folded
      }
      if (typeof event.seq !== 'number') continue; // missing seq — skip without folding
      try {
        foldEvent(sessionId, event);
      } catch { /* one malformed event must not fail the file */ }
    }
  }

  async function walkSessionFiles(dir, out) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkSessionFiles(full, out);
      } else if (entry.name === SESSION_ARTIFACT_NAME) {
        out.push({ filePath: full, dirName: basename(dir) });
      }
    }
  }

  /** One full/incremental backfill pass; never throws. */
  async function scanSessionStore() {
    if (backfillBusy) return;
    backfillBusy = true;
    try {
      const home = homeDir();
      if (!home) return;
      const files = [];
      await walkSessionFiles(join(home, 'sessions'), files);
      for (const { filePath, dirName } of files) {
        try {
          let mtimeMs = 0;
          try {
            const st = await stat(filePath);
            mtimeMs = st.mtimeMs;
          } catch { /* unreadable now — retry on a later round */ }
          if (mtimeMs <= (backfillMtimes.get(filePath) ?? 0)) continue;
          try {
            await processArtifactFile(filePath, dirName);
          } catch (error) {
            logger.warn(`dsh-resmon: history backfill skipped ${filePath}: ${String(error?.message ?? error)}`);
          }
          backfillMtimes.set(filePath, mtimeMs);
        } catch { /* one file must not break the scan */ }
        await new Promise((resolve) => setImmediate(resolve)); // yield between files
      }
      await persist();
    } catch (error) {
      logger.warn(`dsh-resmon: history backfill scan failed: ${String(error?.message ?? error)}`);
    } finally {
      backfillBusy = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 2.6 Official balance integration: one 60 s snapshot loop that first
   *     re-probes the data source (API key → official /user/balance via
   *     global fetch + 15 s timeout; logged-in account → deepseekAccount
   *     getBalance CNY wallet), then accounts the balance delta into the
   *     persisted `official` record (Beijing day rollover, drop→used,
   *     rise→needsReview). Every call is tolerant and never throws into
   *     the plugin fiber.                                               *
   * ------------------------------------------------------------------ */
  const officialState = {
    source: null, // 'apikey' | 'account' | null (persisted)
    sourceFp: '', // apikey: sha256(key)[:16]; account: 'account:cny'
    day: null, // Beijing day of the current baseline
    firstBalance: null,
    lastBalance: null,
    todayUsed: 0,
    needsReview: false,
  };
  const officialLive = {
    balance: null, // { total, bonus, recharge } in CNY yuan (live, not persisted)
    balanceError: false,
    updatedAt: null,
    usageUrl: null,
    todayCost: null, // tier-2: official platform today cost (CNY, account mode only)
    todayCostDay: null, // Beijing day the todayCost value belongs to
    monthCost: null, // tier-2: official platform month cost (CNY)
  };
  let officialSource = null; // cached probe result for the snapshot loop
  let apiKey = null;
  let apiKeyRejected = null; // a key the official API rejected (401/403)
  let officialBusy = false;
  let whaleToday = null; // today usage from the whale ledger, when readable (CNY)
  let whaleCumulative = null; // all-days usage from the whale ledger (CNY)

  function sha16(value) {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  /** Reset the persisted diff-accounting baseline; day=null forces the next
   *  snapshot to establish a fresh baseline (first=last=current). */
  function resetOfficialBaseline(source, sourceFp) {
    officialState.source = source;
    officialState.sourceFp = sourceFp;
    officialState.day = null;
    officialState.firstBalance = null;
    officialState.lastBalance = null;
    officialState.todayUsed = 0;
    officialState.needsReview = false;
  }

  /** Diff accounting: the official API has no usage history, so "today used"
   *  is the balance delta observed since the first snapshot of the Beijing
   *  day. A drop accumulates into todayUsed; a rise (top-up / granted bonus)
   *  sets needsReview and never reduces todayUsed. When the whale ledger
   *  supplies today's usage, `accumulate` is false: the balance trail is
   *  still maintained (lastBalance / needsReview), but todayUsed is left to
   *  the ledger value so the two sources never double-count. */
  function applyOfficialSnapshot(total, accumulate = true) {
    const day = beijingDayKey();
    if (officialState.day !== day || officialState.lastBalance === null) {
      officialState.day = day;
      officialState.firstBalance = total;
      officialState.lastBalance = total;
      officialState.todayUsed = 0;
      officialState.needsReview = false;
      return;
    }
    const delta = officialState.lastBalance - total;
    if (delta > 0) {
      if (accumulate) officialState.todayUsed += delta;
    } else if (delta < 0) {
      officialState.needsReview = true;
    }
    officialState.lastBalance = total;
  }

  /** Read the whale widget ledger defensively (configurable path; disabled
   *  by Config.whale.enabled). A missing/unreadable/corrupt file or an
   *  unextractable value clears both figures (the delta logic then takes
   *  over for today); only successfully parsed numbers survive.
   *  Debug-level logging only. */
  async function sampleWhaleLedger() {
    if (!whaleEnabled) {
      whaleToday = null;
      whaleCumulative = null;
      return;
    }
    try {
      const home = homeDir();
      const ledgerPath = whalePath !== '' ? whalePath : (home ? join(home, '.dshw-usage.json') : null);
      if (!ledgerPath) {
        whaleToday = null;
        whaleCumulative = null;
        return;
      }
      const raw = await readFile(ledgerPath, 'utf8');
      let ledger = null;
      try { ledger = JSON.parse(raw); } catch { ledger = null; }
      whaleToday = whaleTodayOf(ledger, beijingDayKey());
      whaleCumulative = whaleCumulativeOf(ledger);
      logger.debug?.(`dsh-resmon: whale ledger read: today=${whaleToday === null ? 'null' : whaleToday} cumulative=${whaleCumulative === null ? 'null' : whaleCumulative}`);
    } catch (error) {
      whaleToday = null;
      whaleCumulative = null;
      logger.debug?.(`dsh-resmon: whale ledger read failed: ${String(error?.message ?? error)}`);
    }
  }

  /** Probe the data source: API key first, then the logged-in account
   *  (Config.official.mode restricts the paths: 'apikey'/'account' force one,
   *  'off' disables both). Only plausible DeepSeek key strings (sk-…) select
   *  the apikey source — the local credential store can hold a placeholder
   *  UUID that must not hijack apikey mode (observed on this machine). */
  async function probeOfficialSource() {
    if (officialMode === 'off') {
      if (officialState.source !== null) resetOfficialBaseline(null, '');
      officialSource = null;
      officialLive.balance = null;
      officialLive.updatedAt = null;
      officialLive.balanceError = false;
      officialLive.todayCost = null; // tier-2 is account-only
      officialLive.todayCostDay = null;
      officialLive.monthCost = null;
      return null;
    }
    const credentials = ctx.get('credentials');
    let key = null;
    if (officialMode !== 'account' && credentials && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve('DEEPSEEK_API_KEY');
        if (resolved && typeof resolved.value === 'string') {
          const value = resolved.value.trim();
          if (/^sk-[A-Za-z0-9_-]+$/.test(value) && value !== apiKeyRejected) key = value;
        }
      } catch { /* tolerant */ }
    }
    if (key) {
      if (officialSource !== 'apikey' || apiKey !== key) {
        apiKey = key;
        apiKeyRejected = null;
        resetOfficialBaseline('apikey', sha16(key));
      }
      officialSource = 'apikey';
      return 'apikey';
    }
    if (officialMode !== 'apikey') {
      const account = ctx.get('deepseekAccount');
      if (account && typeof account.getState === 'function' && typeof account.getBalance === 'function') {
        try {
          const state = await account.getState();
          if (state && state.status === 'credential-stored') {
            const usageUrl = state.links && typeof state.links.usageUrl === 'string' ? state.links.usageUrl : null;
            officialLive.usageUrl = usageUrl;
            if (officialSource !== 'account') resetOfficialBaseline('account', 'account:cny');
            officialSource = 'account';
            return 'account';
          }
        } catch { /* tolerant */ }
      }
    }
    // Neither source available: everything official goes null.
    if (officialState.source !== null) resetOfficialBaseline(null, '');
    officialSource = null;
    officialLive.balance = null;
    officialLive.updatedAt = null;
    officialLive.balanceError = false;
    officialLive.todayCost = null; // tier-2 is account-only
    officialLive.todayCostDay = null;
    officialLive.monthCost = null;
    return null;
  }

  async function fetchOfficialApikeyBalance(accumulate = true) {
    if (!apiKey) return;
    // Safety: the only external address this plugin may contact.
    const target = new URL(OFFICIAL_BALANCE_URL);
    if (target.origin !== 'https://api.deepseek.com' || target.pathname !== '/user/balance') {
      officialLive.balanceError = true;
      return;
    }
    let res;
    try {
      res = await fetch(OFFICIAL_BALANCE_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      officialLive.balanceError = true;
      logger.warn(`dsh-resmon: official balance fetch failed: ${String(error?.message ?? error)}`);
      return;
    }
    if (res.status === 401 || res.status === 403) {
      // The stored key is rejected by the official API: remember it and let
      // the next probe fall back to the account source.
      apiKeyRejected = apiKey;
      apiKey = null;
      officialSource = null;
      officialLive.balanceError = true;
      logger.warn(`dsh-resmon: DEEPSEEK_API_KEY rejected by api.deepseek.com (status ${res.status}); falling back to the account source`);
      return;
    }
    if (!res.ok) {
      officialLive.balanceError = true;
      logger.warn(`dsh-resmon: official balance request failed with HTTP ${res.status}`);
      return;
    }
    try {
      const json = await res.json();
      const balance = apikeyBalanceOf(json);
      if (!balance) throw new Error('no parseable balance_infos');
      officialLive.balance = balance;
      officialLive.balanceError = false;
      officialLive.updatedAt = Date.now();
      applyOfficialSnapshot(balance.total, accumulate);
    } catch (error) {
      officialLive.balanceError = true;
      logger.warn(`dsh-resmon: official balance parse failed: ${String(error?.message ?? error)}`);
    }
  }

  async function fetchOfficialAccountBalance(accumulate = true) {
    const account = ctx.get('deepseekAccount');
    if (!account || typeof account.getBalance !== 'function') return;
    let outcome;
    try {
      outcome = await account.getBalance({ version: '1', locale: 'zh-CN', timezoneOffsetSeconds: -480 });
    } catch (error) {
      officialLive.balanceError = true;
      logger.warn(`dsh-resmon: account balance call failed: ${String(error?.message ?? error)}`);
      return;
    }
    const balance = accountBalanceOf(outcome);
    if (!balance) {
      officialLive.balanceError = true;
      return;
    }
    officialLive.balance = balance;
    officialLive.balanceError = false;
    officialLive.updatedAt = Date.now();
    applyOfficialSnapshot(balance.total, accumulate);
  }

  /** Tier-2: official platform usage (account mode only, best effort). The
   *  endpoints are undisclosed and may be WAF-blocked — every failure keeps
   *  the previous value (initial null) and is debug-logged only. */
  async function fetchOfficialPlatformUsage() {
    const account = ctx.get('deepseekAccount');
    if (!account || typeof account.getPlatformSession !== 'function') return;
    let session = null;
    try {
      session = await account.getPlatformSession();
    } catch (error) {
      logger.debug?.(`dsh-resmon: getPlatformSession failed: ${String(error?.message ?? error)}`);
      return;
    }
    if (!session || typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token === '') return;
    let origin;
    try {
      origin = new URL(session.origin).origin;
    } catch {
      return;
    }
    // Defense in depth: only HTTPS origins on the official platform host.
    if (!/^https:\/\/([a-z0-9-]+\.)*deepseek\.com$/i.test(origin)) return;
    if (officialLive.todayCostDay !== beijingDayKey()) {
      officialLive.todayCost = null; // stale cross-day value must not persist
      officialLive.todayCostDay = beijingDayKey();
    }
    const headers = {
      Authorization: `Bearer ${session.token}`,
      Accept: 'application/json',
      'x-client-platform': 'web',
      'User-Agent': PLATFORM_UA,
      Origin: origin,
      Referer: `${origin}/usage`,
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const bj = new Date(Date.now() + 8 * 3600 * 1000);
    const requests = [
      { kind: 'today', url: `${origin}/api/v0/usage/by_api_key/cost?start=${beijingDayStartSeconds()}&end=${nowSec}&tz=8` },
      { kind: 'month', url: `${origin}/api/v0/usage/cost?month=${bj.getUTCMonth() + 1}&year=${bj.getUTCFullYear()}` },
    ];
    for (const { kind, url } of requests) {
      let res;
      try {
        res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
      } catch (error) {
        logger.debug?.(`dsh-resmon: platform usage ${kind} request failed: ${String(error?.message ?? error)}`);
        continue; // keep the previous value
      }
      try {
        const text = await res.text();
        logger.debug?.(`dsh-resmon: platform usage ${kind} HTTP ${res.status}: ${JSON.stringify(text.slice(0, 200))}`);
        if (!res.ok) continue;
        let json = null;
        try { json = JSON.parse(text); } catch { continue; }
        if (kind === 'today') {
          const value = todayCostOf(json);
          if (value !== null) officialLive.todayCost = value;
        } else {
          const value = monthCostOf(json);
          if (value !== null) officialLive.monthCost = value;
        }
      } catch (error) {
        logger.debug?.(`dsh-resmon: platform usage ${kind} parse failed: ${String(error?.message ?? error)}`);
      }
    }
  }

  async function sampleOfficialBalance() {
    if (officialBusy) return;
    officialBusy = true;
    try {
      await sampleWhaleLedger(); // 1) whale ledger first — decides accumulate
      const accumulate = whaleToday === null; // ledger valid → no delta stacking
      const source = await probeOfficialSource();
      if (source === 'apikey') {
        officialLive.todayCost = null; // tier-2 is account-only
        officialLive.todayCostDay = null;
        officialLive.monthCost = null;
        await fetchOfficialApikeyBalance(accumulate);
      } else if (source === 'account') {
        await fetchOfficialAccountBalance(accumulate);
        await fetchOfficialPlatformUsage(); // same 60 s cycle, best effort
      }
      // 2) Whale ledger overrides the balance-delta figure for the day.
      if (whaleToday !== null && officialState.source !== null) {
        officialState.todayUsed = whaleToday;
      }
    } catch (error) {
      officialLive.balanceError = true;
      logger.warn(`dsh-resmon: official balance sampling failed: ${String(error?.message ?? error)}`);
    } finally {
      officialBusy = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 3. Persistence via the storage domain facility (best effort)        *
   * ------------------------------------------------------------------ */
  let domain = null;
  let domainOpenFailed = false;

  async function openDomain(storageDomain) {
    try {
      const opened = await storageDomain.open({
        name: 'dsh-resmon-usage',
        version: 1,
        layout: 'per-record',
        global: {
          schema: {
            parse(value) {
              if (typeof value !== 'object' || value === null) throw new Error('bad global');
              if (typeof value.cumulative !== 'object' || typeof value.byDay !== 'object') throw new Error('bad global');
              return value;
            },
          },
          initial: { cumulative: { input: 0, output: 0, cost: 0 }, byDay: {} },
        },
        tables: {
          sessions: {
            valueSchema: {
              parse(value) {
                if (typeof value !== 'object' || value === null || typeof value.lastSeq !== 'number') throw new Error('bad record');
                return value;
              },
            },
          },
        },
      });
      return opened;
    } catch (error) {
      domainOpenFailed = true;
      logger.warn(`dsh-resmon: storage domain unavailable, keeping cumulative totals in memory: ${String(error?.message ?? error)}`);
      return null;
    }
  }

  function applyPersistedBase(globalValue) {
    if (!globalValue || typeof globalValue !== 'object') return;
    const cumulative = globalValue.cumulative;
    if (cumulative && typeof cumulative.input === 'number' && typeof cumulative.output === 'number') {
      state.cumulative.input += cumulative.input;
      state.cumulative.output += cumulative.output;
      // Old archives have no cost field → treated as 0 (no domain version bump).
      state.cumulative.cost = (state.cumulative.cost ?? 0) + (typeof cumulative.cost === 'number' ? cumulative.cost : 0);
    }
    const byDay = globalValue.byDay;
    if (byDay && typeof byDay === 'object') {
      for (const [day, value] of Object.entries(byDay)) {
        if (!value || typeof value.input !== 'number' || typeof value.output !== 'number') continue;
        const cost = typeof value.cost === 'number' ? value.cost : 0;
        const existing = state.byDay.get(day);
        if (existing) {
          existing.input += value.input;
          existing.output += value.output;
          existing.cost = (existing.cost ?? 0) + cost;
        } else {
          state.byDay.set(day, { input: value.input, output: value.output, cost });
        }
      }
    }
    // Old archives have no `official` field → rebuild from defaults.
    const official = globalValue.official;
    if (official && typeof official === 'object') {
      officialState.source = official.source === 'apikey' || official.source === 'account' ? official.source : null;
      officialState.sourceFp = typeof official.sourceFp === 'string' ? official.sourceFp : '';
      officialState.day = typeof official.day === 'string' ? official.day : null;
      officialState.firstBalance = typeof official.firstBalance === 'number' ? official.firstBalance : null;
      officialState.lastBalance = typeof official.lastBalance === 'number' ? official.lastBalance : null;
      officialState.todayUsed = typeof official.todayUsed === 'number' ? official.todayUsed : 0;
      officialState.needsReview = official.needsReview === true;
    }
  }

  async function persist() {
    if (!domain) return;
    try {
      const snapshot = {
        cumulative: { ...state.cumulative },
        byDay: Object.fromEntries([...state.byDay.entries()].map(([k, v]) => [k, { ...v }])),
        official: {
          source: officialState.source,
          sourceFp: officialState.sourceFp,
          day: officialState.day,
          firstBalance: officialState.firstBalance,
          lastBalance: officialState.lastBalance,
          todayUsed: officialState.todayUsed,
          needsReview: officialState.needsReview,
        },
      };
      await domain.global.set(snapshot);
      for (const [sessionId, rec] of state.sessions) {
        if (rec.foldSeq > 0) await domain.table('sessions').put(sessionId, { lastSeq: rec.foldSeq });
      }
    } catch (error) {
      logger.warn(`dsh-resmon: persist failed: ${String(error?.message ?? error)}`);
    }
  }

  (async () => {
    const storageDomain = ctx.get('storageDomain');
    if (storageDomain && typeof storageDomain.open === 'function') {
      domain = await openDomain(storageDomain);
      if (domain) {
        try {
          applyPersistedBase(domain.global.get());
          for (const [sessionId, value] of domain.table('sessions').entries()) {
            if (value && typeof value.lastSeq === 'number') {
              sessionRecord(sessionId).foldSeq = value.lastSeq;
            }
          }
        } catch (error) {
          logger.warn(`dsh-resmon: loading persisted state failed: ${String(error?.message ?? error)}`);
        }
      }
    }
    catchUpAll();
    scanSessionStore().catch(() => {}); // first history backfill, right after boot folding
    sampleOfficialBalance().catch(() => {}); // first official probe + snapshot
    const persistTimer = setInterval(persist, PERSIST_INTERVAL_MS);
    const backfillTimer = setInterval(() => { scanSessionStore().catch(() => {}); }, BACKFILL_INTERVAL_MS);
    // The official polling timer is owned by startOfficialTimer() so a config
    // change can rebuild it; just make sure cleanup reaches it.
    ctx.effect(() => () => {
      clearInterval(persistTimer);
      clearInterval(backfillTimer);
      if (officialTimer !== null) clearInterval(officialTimer);
      stopExternalServer();
      if (domain) persist().catch(() => {});
    });
  })().catch((error) => logger.warn(`dsh-resmon: boot folding failed: ${String(error?.message ?? error)}`));

  /* ------------------------------------------------------------------ *
   * 4. Browser fetch routes answering the Client panel                  *
   * ------------------------------------------------------------------ */
  function statsPayload() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
      now: Date.now(),
      pid: process.pid,
      cpu: history.cpu[history.cpu.length - 1] ?? 0,
      history: { cpu: [...history.cpu], mem: [...history.mem] },
      mem: {
        total: totalMem,
        free: freeMem,
        used: totalMem - freeMem,
        percent: totalMem > 0 ? Math.round((1 - freeMem / totalMem) * 1000) / 10 : 0,
      },
      dsh: {
        cpu: dshHistory.cpu[dshHistory.cpu.length - 1] ?? 0,
        mem: { rss: dshHistory.mem[dshHistory.mem.length - 1] ?? 0 },
        history: { cpu: [...dshHistory.cpu], mem: [...dshHistory.mem] },
      },
      system: {
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptime: os.uptime(),
        cores: os.cpus().length,
        model: os.cpus()[0]?.model ?? '',
        osVersion,
      },
      disk: [...diskState.drives.values()].map((drive) => ({
        drive: drive.drive,
        total: drive.total,
        free: drive.free,
        used: drive.used,
        percent: round1(drive.percent),
        activePercent: diskState.active.has(drive.drive) ? round1(diskState.active.get(drive.drive)) : null,
      })),
      net: {
        available: netState.available,
        downBps: netState.downBps,
        upBps: netState.upBps,
        history: { totalBps: [...netState.history] },
      },
      gpu: {
        available: gpuState.available,
        name: gpuState.name,
        util: gpuState.util,
        memUsed: gpuState.memUsed,
        memTotal: gpuState.memTotal,
        history: { util: [...gpuState.history] },
      },
      dshsize: {
        computing: dshsizeState.computing,
        app: dshsizeState.app,
        home: dshsizeState.home,
        total: dshsizeState.total,
      },
      external: {
        enabled: externalEnabled,
        port: externalPort,
        running: externalState.running,
        error: externalState.error,
      },
    };
  }

  function costViewOf(sessionId, rec, day) {
    const running = typeof sessionId === 'string' ? (runningSessions.get(sessionId) ?? false) : false;
    const nowMs = Date.now();
    const period = periodAt(nowMs); // current billing period, for the UI
    let model = null;
    let reasoningEffort = null;
    let turn = null;
    let sessionCost = null;
    let estimatedTurn = null;
    if (rec) {
      model = rec.model ?? null;
      reasoningEffort = rec.reasoningEffort ?? null;
      turn = round6(rec.turnCost ?? 0);
      sessionCost = round6(rec.cost ?? 0);
      if (running) {
        const chars = typeof sessionId === 'string' ? (liveChars.get(sessionId) ?? 0) : 0;
        if (chars > 0) {
          estimatedTurn = round6(turn + (chars / 3) * priceFor(model, nowMs).output / 1e6);
        } else {
          estimatedTurn = turn;
        }
      }
    }
    return {
      model,
      reasoningEffort,
      period,
      prices: model ? priceFor(model, nowMs) : null,
      turn,
      session: sessionCost,
      today: round6(day?.cost ?? 0),
      cumulative: round6(state.cumulative.cost ?? 0),
      estimatedTurn,
      running,
    };
  }

  function usagePayload(sessionId) {
    catchUpAll();
    const dayKey = localDayKey();
    const day = state.byDay.get(dayKey) ?? { input: 0, output: 0, cost: 0 };
    let sessionView = null;
    let rec = null;
    if (sessionId) {
      const sessions = ctx.get('sessions');
      const session = sessions?.get?.(sessionId);
      if (session) {
        catchUpSession(session);
        rec = state.sessions.get(sessionId) ?? null;
        if (rec) {
          sessionView = {
            input: rec.input,
            output: rec.output,
            total: rec.input + rec.output,
            turn: {
              turn: rec.turn,
              input: rec.turnInput,
              output: rec.turnOutput,
              total: rec.turnInput + rec.turnOutput,
            },
          };
        }
      }
    }
    return {
      today: { input: day.input, output: day.output, total: day.input + day.output },
      cumulative: {
        input: state.cumulative.input,
        output: state.cumulative.output,
        total: state.cumulative.input + state.cumulative.output,
      },
      session: sessionView,
      cost: costViewOf(sessionId, rec, day),
      official: {
        source: officialState.source,
        balance: officialLive.balance
          ? {
              total: round2(officialLive.balance.total),
              bonus: round2(officialLive.balance.bonus),
              recharge: round2(officialLive.balance.recharge),
            }
          : null,
        todayUsed: officialState.source !== null && officialState.lastBalance !== null ? round2(officialState.todayUsed) : null,
        needsReview: officialState.needsReview,
        whaleToday: whaleToday !== null ? round2(whaleToday) : null,
        whaleCumulative: whaleCumulative !== null ? round2(whaleCumulative) : null,
        todayCost: officialLive.todayCost !== null ? round2(officialLive.todayCost) : null,
        monthCost: officialLive.monthCost !== null ? round2(officialLive.monthCost) : null,
        usageUrl: officialLive.usageUrl,
        balanceError: officialLive.balanceError,
        updatedAt: officialLive.updatedAt,
      },
      persistent: domain !== null,
      domainFailed: domainOpenFailed,
    };
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-resmon/stats',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return Response.json({ ok: true, value: statsPayload() });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
      }
    },
  }));

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-resmon/usage',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        let sessionId;
        try {
          const body = await request.json();
          if (body && typeof body.sessionId === 'string') sessionId = body.sessionId;
        } catch { /* body optional */ }
        return Response.json({ ok: true, value: usagePayload(sessionId) });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
      }
    },
  }));

  // Runtime config: GET returns the current effective values (file >
  // schemastery Config > built-in); POST validates a partial object, writes
  // the JSON file atomically and applies it immediately.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-resmon/config',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method === 'GET') {
          return Response.json({ ok: true, value: cloneConfig(effectiveCfg) });
        }
        let body = null;
        try { body = await request.json(); } catch { body = null; }
        const value = await configPostValue(body);
        return Response.json({ ok: true, value });
      } catch (error) {
        return Response.json({ ok: false, error: { message: String(error?.message ?? error) } }, { status: 400 });
      }
    },
  }));

  // Panel command channel: the Client polls this to apply external commands.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-resmon/panel',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return Response.json({ ok: true, value: { revision: panelCommand.revision, command: panelCommand.command } });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
      }
    },
  }));

  // Spec generation: POST regenerates + rewrites the file; GET returns the
  // same { path, content } shape (settings page display).
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-resmon/spec',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return Response.json({ ok: true, value: await ensureExternalSpec() });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
      }
    },
  }));
}
