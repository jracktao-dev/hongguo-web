// 红果官方高清（1080P HEVC）取址桥 —— 调用 phone_account SDK v5 解析器。
//
// 背景：2026-11-23 起，上游播放接口对「纯 HTTP 签名」一律返回 HTTP 200 + 0 字节，
// 只有用官方 SDK（libmetasec_ml.so）算出 X-Medusa digest、再向 mssdk 换 SDI token，
// 才能拿到 1080P/720P 的 video_model 与 CENC 内容密钥。
//
// 实现来源：GPL-3.0，派生自 woshishiq1/drpys → waligoraamodio288-rgb/hongguo-desktop-releases
// v1.0.104 → jackotom/hongguo-drama 8.1（commit b20413b）的 scripts/sdk-playback。
// 完整来源与许可见同目录 SOURCE.md 与项目 THIRD-PARTY-NOTICES.md。
//
// 本模块只负责「拉起子进程 + 排队 + 超时 + 解析 JSON」，不实现签名算法。
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "sdk-playback", "resolve_cli.py");

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function createSdkPlayback(options = {}) {
  const python = String(options.python || process.env.HONGGUO_PYTHON || "python3").trim() || "python3";
  const cacheRoot = path.resolve(
    String(options.cacheDir || process.env.SDK_CACHE_DIR || path.join(process.env.DATA_DIR || "/app/data", "sdk-cache"))
  );
  const concurrency = positiveInt(options.concurrency || process.env.HONGGUO_SDK_CONCURRENCY, 2);
  const timeoutMs = positiveInt(options.timeoutMs || process.env.HONGGUO_SDK_TIMEOUT_MS, 45000);
  const disabledMs = positiveInt(options.disabledMs, 5 * 60 * 1000);

  let active = 0;
  const waiting = [];
  let disabledUntil = 0;
  let lastError = "";

  const stats = { ok: 0, failed: 0, lastError: "", lastErrorAt: 0, disabledUntil: 0 };

  function acquire() {
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  }
  function release() {
    active = Math.max(0, active - 1);
    const next = waiting.shift();
    if (next) {
      active += 1;
      next();
    }
  }

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function run(epId) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(SCRIPT)) return reject(fail("SDK_UNAVAILABLE", "SDK 解析器缺失"));
      try {
        fs.mkdirSync(cacheRoot, { recursive: true });
      } catch (error) {
        return reject(fail("SDK_UNAVAILABLE", "SDK 缓存目录不可写: " + error.message));
      }
      const args = [SCRIPT, "--video", String(epId), "--cache", cacheRoot];
      const child = spawn(python, args, {
        cwd: HERE,
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch {}
        reject(fail("SDK_TIMEOUT", "SDK 取址超时（" + timeoutMs + "ms）"));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > 2 * 1024 * 1024) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { child.kill("SIGKILL"); } catch {}
            reject(fail("SDK_FAILED", "SDK 输出过大"));
          }
        }
      });
      child.stderr.on("data", (chunk) => { if (stderr.length < 8192) stderr += chunk; });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const message = String((error && error.message) || error);
        if (/ENOENT|spawn .* ENOENT/.test(message)) reject(fail("SDK_UNAVAILABLE", "找不到 Python 解释器: " + python));
        else reject(fail("SDK_FAILED", "SDK 进程启动失败: " + message));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const text = stdout.trim();
        let parsed = null;
        if (text) {
          const line = text.split(/\r?\n/).filter(Boolean).pop();
          try { parsed = JSON.parse(line); } catch {}
        }
        if (parsed && parsed.ok === true && parsed.model && Array.isArray(parsed.model.video_list)) {
          return resolve(parsed.model);
        }
        const detail = (parsed && parsed.error) || stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || ("退出码 " + code);
        if (/ModuleNotFoundError|No module named|ImportError/.test(detail + " " + stderr)) {
          return reject(fail("SDK_UNAVAILABLE", "Python 依赖缺失: " + detail));
        }
        reject(fail("SDK_FAILED", "SDK 取址失败: " + String(detail).slice(0, 300)));
      });
    });
  }

  return {
    enabled: true,
    cacheDir: cacheRoot,
    stats,
    get available() {
      return Date.now() >= disabledUntil;
    },
    async resolve(epId) {
      if (Date.now() < disabledUntil) {
        throw fail("SDK_DISABLED", "SDK 通道暂时禁用（" + lastError + "）");
      }
      if (!/^[0-9]{5,30}$/.test(String(epId))) throw fail("SDK_FAILED", "非法的分集 id");
      await acquire();
      const started = Date.now();
      try {
        const model = await run(epId);
        stats.ok += 1;
        stats.lastError = "";
        if (process.env.HONGGUO_SDK_DEBUG === "1") {
          console.log(JSON.stringify({ event: "sdk_playback_ok", epId: String(epId), ms: Date.now() - started }));
        }
        return model;
      } catch (error) {
        stats.failed += 1;
        lastError = String((error && error.message) || error).slice(0, 300);
        stats.lastError = lastError;
        stats.lastErrorAt = Date.now();
        // 解释器/依赖缺失属于部署问题：短期禁用，避免每次播放都白等一次进程启动。
        if (error && error.code === "SDK_UNAVAILABLE") {
          disabledUntil = Date.now() + disabledMs;
          stats.disabledUntil = disabledUntil;
          console.error(JSON.stringify({ event: "sdk_playback_unavailable", message: lastError }));
        }
        throw error;
      } finally {
        release();
      }
    },
  };
}
