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
import { readdir, readFile, stat, statfs } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

const MAX_SAMPLES = 90;
const PERSIST_INTERVAL_MS = 30000;
const IS_WIN32 = process.platform === 'win32';

// Sub-sampling cadences, expressed in units of the 1-second sample tick.
const NET_GPU_EVERY_TICKS = 2;
const DISK_EVERY_TICKS = 5;
const DISK_REPROBE_EVERY_TICKS = 300; // 5 minutes

/** Official PEAK pricing table, CNY per million tokens.
 *  Verified 2026-10-19 against api-docs.deepseek.com (Lead's research):
 *  - `deepseek-flash`            peak: input 2 / cachedInput 0.04 / output 8
 *  - `deepseek-v4-pro`           peak: input 9.0 / cachedInput 0.30 / output 27.0
 *  - Legacy aliases billed as flash: deepseek-v4-flash, deepseek-v4-flash-vision-exp
 *  - Discontinued models (deepseek-chat, deepseek-reasoner) are deliberately NOT
 *    listed, so they fall through to `default` like any unknown model id.
 *  - Off-peak prices are exactly half of peak (see periodAt/priceFor below).
 *  Peak window = Beijing time Mon–Fri 09:00–12:00 & 14:00–18:00 (effective since
 *  2026-08-16). The official page states peak excludes Chinese statutory
 *  holidays; this plugin cannot embed a holiday table, so holidays are
 *  conservatively billed at peak prices. */
const PRICING = {
  'deepseek-flash': { input: 2, cachedInput: 0.04, output: 8 },
  'deepseek-v4-pro': { input: 9.0, cachedInput: 0.30, output: 27.0 },
  'deepseek-v4-flash': { input: 2, cachedInput: 0.04, output: 8 },
  'deepseek-v4-flash-vision-exp': { input: 2, cachedInput: 0.04, output: 8 },
  default: { input: 9.0, cachedInput: 0.30, output: 27.0 },
};

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

/** Effective unit price at a given instant (off-peak = half of peak). */
function priceFor(modelId, timeMs) {
  const peak = peakPriceFor(modelId);
  if (periodAt(timeMs) === 'offpeak') {
    return { input: peak.input / 2, cachedInput: peak.cachedInput / 2, output: peak.output / 2 };
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

export function apply(ctx) {
  const logger = ctx.logger ?? console;

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
    // Sub-sampling cadences driven by the same 1-second tick.
    if (tick % NET_GPU_EVERY_TICKS === 0) {
      sampleWindowsCounters(); // merged: net + disk active (+ generic GPU counters)
      sampleGpu();             // nvidia-smi only, when that backend is active
    }
    if (tick % DISK_EVERY_TICKS === 0) sampleDisk();
    if (tick % DISK_REPROBE_EVERY_TICKS === 0) {
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

  /** Read the whale widget ledger (~/.dsh/.dshw-usage.json) defensively.
   *  A missing/unreadable/corrupt file or an unextractable value clears
   *  whaleToday (the delta logic then takes over); only a successfully
   *  parsed number survives. Debug-level logging only. */
  async function sampleWhaleLedger() {
    try {
      const home = homeDir();
      if (!home) { whaleToday = null; return; }
      const raw = await readFile(join(home, '.dshw-usage.json'), 'utf8');
      let ledger = null;
      try { ledger = JSON.parse(raw); } catch { ledger = null; }
      const value = whaleTodayOf(ledger, beijingDayKey());
      whaleToday = value;
      logger.debug?.(`dsh-resmon: whale ledger read: ${value === null ? 'no usable value' : 'todayUsed ' + value}`);
    } catch (error) {
      whaleToday = null;
      logger.debug?.(`dsh-resmon: whale ledger read failed: ${String(error?.message ?? error)}`);
    }
  }

  /** Probe the data source: API key first, then the logged-in account.
   *  Only plausible DeepSeek key strings (sk-…) select the apikey source —
   *  the local credential store can hold a placeholder UUID that must not
   *  hijack apikey mode (observed on this machine). */
  async function probeOfficialSource() {
    const credentials = ctx.get('credentials');
    let key = null;
    if (credentials && typeof credentials.resolve === 'function') {
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
    const officialTimer = setInterval(() => { sampleOfficialBalance().catch(() => {}); }, OFFICIAL_BALANCE_INTERVAL_MS);
    ctx.effect(() => () => {
      clearInterval(persistTimer);
      clearInterval(backfillTimer);
      clearInterval(officialTimer);
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
}
