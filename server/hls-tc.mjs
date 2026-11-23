// 服务端 HLS 转码：把红果的 H.266/VVC 档位转成 H.264 的分片 HLS（fMP4）后交给 hls.js 播放。
//
// 为什么不用旧的「管道 fMP4」：边转边推的碎片流没有 Content-Length、也不支持 Range，
// 浏览器拿到的 duration 会随时间一起长（等于「已产出多长就多长」），进度条总长是假的、
// 拖动会直接回到开头。改成 HLS 后，清单（EVENT 类型）会不断追加分片，播放器知道真实总时长，
// 也能按分片随机访问，拖动就不再失效。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail } from "./errors.mjs";
import { QUALITIES } from "./stream.mjs";
import { transcodeAvailable, stageVvcInput, stageHevcInput, stageHevcStream, pumpHevcStream, hevcTranscodeEnabled, dropStage, h264Args } from "./transcode.mjs";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const MAX_CONCURRENT = Math.max(1, Number(process.env.TRANSCODE_MAX_CONCURRENT || 2) || 2);
// 槽位满时先排队等一会儿（默认 8s），而不是立刻 503——同一个人连看/多端同看时
// 1080P 才不会因为「刚好有 2 个转码在跑」被前端降成 540P。
const QUEUE_WAIT_MS = Math.max(0, Number(process.env.TRANSCODE_QUEUE_WAIT_MS == null ? 8000 : process.env.TRANSCODE_QUEUE_WAIT_MS) || 0);
// P0-2：转码任务若长时间无人取清单/分片（关页面、切走），就主动终止，别让 ffmpeg 白白占槽位与内存。
const IDLE_MS = Math.max(20 * 1000, Number(process.env.HLS_TC_IDLE_MS || 60 * 1000) || 60 * 1000);
// 转码结果留 30 分钟：够同一集被反复起播/拖动，也不会把临时目录撑爆（容器里 /tmp 是 tmpfs）。
const TTL_MS = Math.max(60 * 1000, Number(process.env.HLS_TC_TTL_MS || 30 * 60 * 1000) || 30 * 60 * 1000);
// 单个转码任务的硬超时：ffmpeg 卡死时若不主动 kill，running 计数永不归零，最终把并发槽位占满导致转码永久不可用。
const JOB_TIMEOUT_MS = Math.max(60 * 1000, Number(process.env.TRANSCODE_JOB_TIMEOUT_MS || 10 * 60 * 1000) || 10 * 60 * 1000);
const ROOT = path.join(os.tmpdir(), "hg-hls");
const SEGMENT_RE = /^seg_\d{5}\.m4s$/;
const INIT_NAME = "init.mp4";
const jobs = new Map();
let running = 0;
const STATS = { started: 0, done: 0, failed: 0, cancelled: 0, lastError: "", lastAt: 0 };

export function hlsTranscodeStats() {
  return { available: transcodeAvailable(), active: running, jobs: jobs.size, limit: MAX_CONCURRENT, queueWaitMs: QUEUE_WAIT_MS, ttlMs: TTL_MS, jobTimeoutMs: JOB_TIMEOUT_MS, idleMs: IDLE_MS, ...STATS };
}

function jobKey(epId, quality) {
  return String(epId) + "-" + String(quality);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createJob({ provider, epId, quality, logger }) {
  const key = jobKey(epId, quality);
  const existing = jobs.get(key);
  if (existing) {
    // 失败任务不能永久缓存：否则同一集同档在 TTL(30min) 内永远命中失败结果、无法重试。
    if (existing.state === "failed") {
      jobs.delete(key);
      fs.rmSync(existing.dir, { recursive: true, force: true });
    } else {
      existing.touched = Date.now();
      existing.lastAccess = Date.now();
      return existing;
    }
  }
  if (running >= MAX_CONCURRENT) {
    const deadline = Date.now() + QUEUE_WAIT_MS;
    while (running >= MAX_CONCURRENT) {
      // 排队期间别的请求可能已经把同一个任务建好了，直接复用，别重复转。
      const again = jobs.get(key);
      if (again && again.state !== "failed") { again.touched = Date.now(); again.lastAccess = Date.now(); return again; }
      if (Date.now() >= deadline) {
        const err = fail("BUSY", "同时转码数已达上限（" + MAX_CONCURRENT + "），请稍后重试");
        err.retryAfter = 3;
        throw err;
      }
      await sleep(150);
    }
  }
  const dir = path.join(ROOT, key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    key,
    epId: String(epId),
    quality: String(quality),
    dir,
    playlist: path.join(dir, "index.m3u8"),
    state: "preparing",
    error: "",
    touched: Date.now(),
    lastAccess: Date.now(),
    startedAt: Date.now(),
    child: null,
    cancelled: false,
  };
  jobs.set(key, job);
  running += 1;
  STATS.started += 1;
  job.promise = runJob(job, { provider, logger }).finally(() => {
    running -= 1;
    job.touched = Date.now();
  });
  return job;
}

async function runJob(job, { provider, logger }) {
  let staged = null;
  try {
    const stream = await provider.stream(job.epId, { quality: job.quality });
    const codec = String(stream.codec || "").toLowerCase();
    // 官方高清通道不可用（限流/熔断）时，provider 会静默回落成 360P 的 H.264 兼容流。
    // 那不是 VVC/HEVC，硬拿去转码只会在 mp4 解析处报「找不到视频轨」，对用户毫无意义；
    // 这里直接给出可读原因，让前端提示「稍后重试 / 选 360P」。
    if (codec === "vvc") {
      staged = await stageVvcInput(stream);
    } else if (codec === "hevc" && hevcTranscodeEnabled()) {
      // P0-1：先试「边下边转」（只读到 moov 就开转），失败再回落到整集下载。
      staged = await stageHevcStream(stream);
      if (!staged) staged = await stageHevcInput(stream);
    } else {
      throw fail(
        "UPSTREAM_COOLDOWN",
        "官方高清通道暂时不可用（当前已回落 360P），无法提供 " + job.quality + " 转码；请稍后重试，或直接选择 360P 兼容线路"
      );
    }
  } catch (error) {
    job.state = "failed";
    job.error = String((error && error.message) || error);
    STATS.failed += 1;
    STATS.lastError = job.error;
    return;
  }
  job.state = "running";
  // 每 4 秒一个分片，并强制在 4 秒整数倍处插关键帧——否则 x264 默认 GOP 会让分片忽长忽短，
  // hls.js 的起播/拖动都会变慢。EVENT 类型清单允许播放中继续追加分片。
  const args = h264Args(staged).concat([
    "-force_key_frames", "expr:gte(t,n_forced*4)",
    "-f", "hls",
    "-hls_time", "4",
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", INIT_NAME,
    "-hls_segment_filename", "seg_%05d.m4s",
    "-hls_flags", "temp_file+independent_segments",
    "index.m3u8",
  ]);
  await new Promise((resolve) => {
    let stderr = "";
    let child = null;
    let watchdog = null;
    let settled = false;
    let timedOut = false;
    const clearWatchdog = () => { if (watchdog) clearTimeout(watchdog); };
    // 所有退出路径（超时/error/exit）统一走这里，保证 failed/done 只计一次。
    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      try { if (child && child.stdin && !child.stdin.destroyed) child.stdin.destroy(); } catch { /* 已关闭 */ }
      dropStage(staged.dir);
      if (ok) {
        job.state = "done";
        job.error = "";
        STATS.done += 1;
        STATS.lastAt = Date.now();
        if (logger) logger({ event: "hls_transcode_done", epId: job.epId, quality: job.quality });
      } else if (job.cancelled) {
        job.state = "failed";
        job.error = String(message || "无人观看，已自动取消转码");
        STATS.cancelled += 1;
        STATS.lastAt = Date.now();
        if (logger) logger({ event: "hls_transcode_cancelled", epId: job.epId, quality: job.quality });
      } else {
        job.state = "failed";
        job.error = String(message || "转码失败");
        STATS.failed += 1;
        STATS.lastError = job.error;
        STATS.lastAt = Date.now();
        if (logger) logger({ event: "hls_transcode_failed", epId: job.epId, quality: job.quality, error: job.error });
      }
      resolve();
    };
    try {
      const streaming = Boolean(staged && staged.kind === "hevc-stream");
      child = spawn(FFMPEG, args, { cwd: job.dir, stdio: [streaming ? "pipe" : "ignore", "ignore", "pipe"] });
    } catch (error) {
      finish(false, "转码进程启动失败：" + String((error && error.message) || error));
      return;
    }
    job.child = child;
    // P0-1：边下边转时，把已读 head + 剩余字节泵进 ffmpeg 的 stdin；失败就关管道让它收尾，
    // 真正的失败原因由 exit 分支统一处理（避免这里再弹一个重复错误）。
    if (staged && staged.kind === "hevc-stream") {
      pumpHevcStream(child, staged).catch(() => {
        try { if (child.stdin && !child.stdin.destroyed) child.stdin.destroy(); } catch { /* 已关闭 */ }
      });
    }
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    // 硬超时：到时强杀 ffmpeg 并把任务标失败，finally 里 running 才能归零、槽位被释放。
    watchdog = setTimeout(() => {
      timedOut = true;
      finish(false, "转码超时（超过 " + Math.round(JOB_TIMEOUT_MS / 1000) + " 秒），已终止");
      try { child.kill("SIGKILL"); } catch { /* 进程可能刚好自行退出 */ }
    }, JOB_TIMEOUT_MS);
    if (watchdog.unref) watchdog.unref();
    child.on("error", (error) => {
      finish(false, "转码进程启动失败：" + String((error && error.message) || error));
    });
    child.on("exit", (code) => {
      if (timedOut) return finish(false, job.error);
      if (job.cancelled) return finish(false, job.error || "无人观看，已自动取消转码");
      if (code === 0) return finish(true);
      finish(false, (stderr || "ffmpeg 退出码 " + code).slice(-400));
    });
  });
}

// 等清单出现且至少写好一个分片：ffmpeg 要先转完第一个 4 秒分片才会落盘清单。
function waitForPlaylist(job, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (job.state === "failed") return resolve(false);
      try {
        const text = fs.readFileSync(job.playlist, "utf8");
        if (text.indexOf(".m4s") !== -1) return resolve(true);
      } catch {
        /* 清单还没写出来 */
      }
      if (job.state === "done") return resolve(fs.existsSync(job.playlist));
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
}

function checkParams(req, quality) {
  if (!transcodeAvailable()) {
    throw fail(
      "CODEC_UNSUPPORTED",
      "该档位是 H.266/VVC 编码，浏览器无法解码，且服务端未安装 ffmpeg（设置 FFMPEG_PATH 后可用转码播放）"
    );
  }
  if (!["GET", "HEAD"].includes(req.method)) throw fail("BAD_METHOD", "只支持 GET / HEAD");
  if (!QUALITIES.has(String(quality))) throw fail("BAD_INPUT", "清晰度参数无效");
}

// GET /api/tc/:epId/:q/index.m3u8 —— 返回（并在需要时启动）该档位的转码清单。
export async function serveTranscodePlaylist({ provider, epId, quality, req, res, logger, authSuffix = "" }) {
  checkParams(req, quality);
  if (!/^\d{1,30}$/.test(String(epId))) throw fail("BAD_INPUT", "剧集 id 无效");
  const job = await createJob({ provider, epId, quality, logger });
  job.lastAccess = Date.now();
  const ok = await waitForPlaylist(job, job.state === "done" ? 2000 : 25000);
  if (!ok) {
    if (job.state === "failed") throw fail("UPSTREAM_ERROR", "转码失败：" + (job.error || "未知错误"));
    throw fail("UPSTREAM_ERROR", "转码超时（首个分片未就绪），请稍后重试");
  }
  const raw = fs.readFileSync(job.playlist, "utf8");
  // 分片/初始化段必须写成绝对路径：hls.js 按「清单所在目录」解析相对地址时会丢掉 at 口令，
  // 带访问口令的部署下所有分片都会 401。
  const base = "/api/tc/" + encodeURIComponent(job.epId) + "/" + encodeURIComponent(job.quality);
  const text = raw
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.indexOf("#EXT-X-MAP:") === 0) {
        return trimmed.replace(/URI="([^"]*)"/, (_m, uri) => 'URI="' + base + "/" + String(uri).split(/[\\/]/).pop() + authSuffix + '"');
      }
      if (trimmed.charAt(0) === "#") return line;
      return base + "/" + String(trimmed).split(/[\\/]/).pop() + authSuffix;
    })
    .join("\n");
  res.writeHead(200, {
    "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    "x-stream-transcode": "1",
    "x-stream-quality": job.quality,
    "x-hls-state": job.state,
  });
  if (req.method === "HEAD") return res.end();
  return res.end(text);
}

// GET /api/tc/:epId/:q/<segment> —— 按 Range 发分片；还没转出来的分片回 404，hls.js 会自己重试。
export async function serveTranscodeFile({ epId, quality, file, req, res, logger }) {
  if (!["GET", "HEAD"].includes(req.method)) throw fail("BAD_METHOD", "只支持 GET / HEAD");
  const name = String(file || "");
  if (name !== INIT_NAME && !SEGMENT_RE.test(name)) throw fail("BAD_INPUT", "分片名无效");
  const job = jobs.get(jobKey(epId, quality));
  if (!job) throw fail("NOT_FOUND", "转码任务不存在（清单需先请求）");
  const target = path.join(job.dir, name);
  job.touched = Date.now();
  job.lastAccess = Date.now();
  if (!fs.existsSync(target)) {
    // 播放器常常比转码快一步：短暂等一会儿（最多 10 秒），还不行就让它重试。
    const waited = await waitForFile(target, job, 10000);
    if (!waited) throw fail("NOT_FOUND", job.state === "failed" ? "转码失败：" + (job.error || "未知错误") : "分片尚未生成");
  }
  const size = fs.statSync(target).size;
  const type = name === INIT_NAME ? "video/mp4" : "video/iso.segment";
  const range = parseRange(req.headers.range, size);
  if (range === null) {
    res.writeHead(416, { "content-range": "bytes */" + size, "cache-control": "no-store" });
    return res.end();
  }
  if (!range) {
    res.writeHead(200, {
      "content-type": type,
      "content-length": size,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(target).pipe(res);
  }
  const [start, end] = range;
  res.writeHead(206, {
    "content-type": type,
    "content-length": end - start + 1,
    "content-range": "bytes " + start + "-" + end + "/" + size,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });
  if (req.method === "HEAD") return res.end();
  return fs.createReadStream(target, { start, end }).pipe(res);
}

function waitForFile(target, job, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (fs.existsSync(target)) return resolve(true);
      if (job.state === "failed") return resolve(false);
      if (job.state === "done" || Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function parseRange(header, size) {
  // undefined = 没有 Range 头（整段返回）；null = Range 头非法（416）。
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  let start;
  let end;
  if (m[1] === "") {
    if (m[2] === "") return null;
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Number(m[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return [start, Math.min(end, size - 1)];
}

// 定期清掉过期任务目录（只清已结束的；正在转的不动）。
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, job] of jobs) {
    // P0-2：正在转但长时间没人取清单/分片（关页面、切走）→ 主动终止，释放槽位与内存。
    if (job.state === "preparing" || job.state === "running") {
      if (now - (job.lastAccess || job.touched) < IDLE_MS) continue;
      job.cancelled = true;
      job.error = "无人观看，已自动取消转码";
      try { if (job.child) job.child.kill("SIGKILL"); } catch { /* 进程可能已退出 */ }
      continue; // 等 runJob 的 exit/finish 归零 running，再按 TTL 清理目录
    }
    if (now - job.touched < TTL_MS) continue;
    fs.rm(job.dir, { recursive: true, force: true }, () => {});
    jobs.delete(key);
  }
}, 15 * 1000);
if (sweeper.unref) sweeper.unref();
