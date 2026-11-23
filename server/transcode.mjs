// H.266/VVC 服务端转码：浏览器的解码器里没有 VVC（Chrome/Edge/Firefox 都没有），
// 所以红果 360P–720P 这几档官方 VVC 流送进 <video> 只能黑屏。
// 这里把服务端已解密的 VVC 分片重排为 Annex B，交给 ffmpeg 转成 H.264；
// 封装由 hls-tc.mjs 用 fMP4 分片（HLS）完成，播放器因此有真实时长、可拖动进度。
//
// 上游的 VVC 文件有两个坑（实测）：
//   1. 采样描述里的 4CC 写的是 hvc1（HEVC），实际码流是 VVC → 必须自己按 stsz/stco/stsc 剥出 NAL；
//   2. 配置盒是 bv2C（非标准），ffmpeg 会当成 extradata 解析失败 → 只取码流，不依赖容器。
// 音轨另存一份“去掉视频轨”的 MP4 让 ffmpeg 直接读，避免自己实现 ADTS 封装。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail } from "./errors.mjs";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const MAX_INPUT = Number(process.env.TRANSCODE_MAX_INPUT_BYTES || 64 * 1024 * 1024);
const READ_TIMEOUT_MS = Number(process.env.TRANSCODE_READ_TIMEOUT_MS || 60 * 1000);
let availability = null;
let availabilityAt = 0;
const AVAILABILITY_RETRY_MS = 60 * 1000;

// ffmpeg 是否存在：可用结果长期缓存；不可用时 60 秒后重探，避免运行期装上 ffmpeg 也永远被判无转码。
export function transcodeAvailable() {
  if (availability === true) return true;
  if (availability === false && Date.now() - availabilityAt < AVAILABILITY_RETRY_MS) return false;
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-version"], { timeout: 5000, stdio: "ignore" });
    availability = true;
  } catch {
    availability = false;
  }
  availabilityAt = Date.now();
  return availability;
}

export function transcodeStats() {
  return { available: transcodeAvailable() };
}

// 1080P 档是 HEVC(hvc1)：Chrome/Edge 默认解不了，但 ffmpeg 可以。
// 用 HONGGUO_HEVC_TRANSCODE=0 可关掉这条链路（弱 NAS 上省 CPU），默认开启。
export function hevcTranscodeEnabled() {
  return String(process.env.HONGGUO_HEVC_TRANSCODE || "1") !== "0";
}

function boxes(buf, start, end) {
  const list = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let hdr = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) size = end - off;
    if (size < 8 || off + size > end) break;
    list.push({ type, start: off, body: off + hdr, size });
    off += size;
  }
  return list;
}

function stblOf(buf, trak) {
  const mdia = boxes(buf, trak.body, trak.start + trak.size).find((b) => b.type === "mdia");
  if (!mdia) return null;
  const minf = boxes(buf, mdia.body, mdia.start + mdia.size).find((b) => b.type === "minf");
  if (!minf) return null;
  return boxes(buf, minf.body, minf.start + minf.size).find((b) => b.type === "stbl") || null;
}

// 解析 moov：分出视频/音频轨，返回重建音轨 MP4 与视频 Annex B 所需的一切。
function analyse(buf) {
  const top = boxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new Error("不是 MP4（缺 moov）");
  const kids = boxes(buf, moov.body, moov.start + moov.size);
  const traks = kids.filter((b) => b.type === "trak");
  let video = null;
  let audio = null;
  for (const trak of traks) {
    const stbl = stblOf(buf, trak);
    if (!stbl) continue;
    const stsd = boxes(buf, stbl.body, stbl.start + stbl.size).find((b) => b.type === "stsd");
    if (!stsd) continue;
    const entry = buf.toString("latin1", stsd.body + 12, stsd.body + 16);
    if (/^(hvc1|hev1|vvc1|bv2C)$/.test(entry)) video = { trak, stbl, entry };
    else if (/^mp4a$/.test(entry)) audio = { trak, stbl, entry };
  }
  if (!video) throw new Error("找不到视频轨");
  return { moov, kids, video, audio };
}

function audioOnlyMp4(buf, { moov, kids, audio }) {
  if (!audio) return null;
  const keep = kids.filter((k) => k.type !== "trak" || k.start === audio.trak.start);
  const inner = keep.reduce((n, k) => n + k.size, 0);
  // 关键：moov 在 mdat 前面（faststart），音轨的 stco/co64 是**绝对文件偏移**。
  // 去掉视频轨后 moov 变短，mdat 会前移 → 音轨偏移全部指错 → ffmpeg 读到垃圾 AAC
  // （症状：invalid band type / channel element not allocated）。
  // 所以用 free 盒把 moov 总长度补回原值，mdat 位置不变，音轨样本表无需改动。
  const pad = moov.size - (8 + inner);
  if (pad < 8) throw new Error("音轨重建失败：moov 余量不足（" + pad + " 字节）");
  const size = 8 + inner + pad;
  const head = Buffer.alloc(size);
  head.writeUInt32BE(size, 0);
  head.write("moov", 4, "latin1");
  let off = 8;
  for (const k of keep) {
    buf.copy(head, off, k.start, k.start + k.size);
    off += k.size;
  }
  head.writeUInt32BE(pad, off);      // free 盒：垫齐 moov 原始长度
  head.write("free", off + 4, "latin1");
  return Buffer.concat([buf.subarray(0, moov.start), head, buf.subarray(moov.start + moov.size)]);
}

// 按 stsc/stsz/stco 定位每个样本，把长度前缀的 NAL 改成 Annex B 起始码。
function annexB(buf, video) {
  const stbl = video.stbl;
  const find = (type) => boxes(buf, stbl.body, stbl.start + stbl.size).find((b) => b.type === type);
  const stsz = find("stsz");
  const stco = find("stco");
  const co64 = find("co64");
  const stsc = find("stsc");
  if (!stsz || (!stco && !co64) || !stsc) throw new Error("样本表不完整");
  const fixed = buf.readUInt32BE(stsz.body + 4);
  const count = buf.readUInt32BE(stsz.body + 8);
  const sizes = new Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || buf.readUInt32BE(stsz.body + 12 + i * 4);
  const chunkCount = buf.readUInt32BE((co64 || stco).body + 4);
  const chunkOffsets = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++)
    chunkOffsets[i] = co64
      ? Number(buf.readBigUInt64BE(co64.body + 8 + i * 8))
      : buf.readUInt32BE(stco.body + 8 + i * 4);
  const stscCount = buf.readUInt32BE(stsc.body + 4);
  const runs = [];
  for (let i = 0; i < stscCount; i++)
    runs.push({
      first: buf.readUInt32BE(stsc.body + 8 + i * 12),
      per: buf.readUInt32BE(stsc.body + 12 + i * 12),
    });
  const startCode = Buffer.from([0, 0, 0, 1]);
  const parts = [];
  let sample = 0;
  for (let ci = 0; ci < chunkCount && sample < count; ci++) {
    let per = 1;
    for (const run of runs) if (ci + 1 >= run.first) per = run.per;
    let off = chunkOffsets[ci];
    for (let k = 0; k < per && sample < count; k++, sample++) {
      const end = off + sizes[sample];
      while (off + 4 <= end) {
        const len = buf.readUInt32BE(off);
        off += 4;
        if (len <= 0 || off + len > end) break;
        parts.push(startCode, buf.subarray(off, off + len));
        off += len;
      }
      off = end;
    }
  }
  return Buffer.concat(parts);
}

async function readAll(stream) {
  const CH = 1024 * 1024;
  const total = Number(stream.total) || 0;
  if (!total) throw new Error("分片总长为 0");
  if (total > MAX_INPUT) throw fail("SOURCE_OOM", "该集文件过大，超出转码上限（" + MAX_INPUT + " 字节）");
  const parts = [];
  const startedAt = Date.now();
  for (let off = 0; off < total; off += CH) {
    if (Date.now() - startedAt > READ_TIMEOUT_MS) throw fail("UPSTREAM_TIMEOUT", "拉取该集分片超时，已放弃转码");
    parts.push(await stream.chunk(off, Math.min(off + CH - 1, total - 1)));
  }
  // 注意：这里会把整集读进内存（峰值约 2×MAX_INPUT），默认上限已压到 64 MB，避免并发转码把进程撑爆。
  const buf = Buffer.concat(parts);
  return buf.subarray(0, total);
}

// 把已解密的整集 mp4 拆成「Annex B 视频 + 纯音频 mp4」并落到临时目录，供 ffmpeg 读取。
// 旧的分片 MP4 直推和新的 HLS 转码共用这一段（两条路都要求同样的上游预处理）。
export async function stageVvcInput(stream) {
  const buf = await readAll(stream);
  const layout = analyse(buf);
  // hvc1 必须放行：红果的 VVC 流在 stsd 里写的就是 hvc1，按 4CC 判断会把真正需要转码的流挡在门外。
  if (!/^(vvc1|bv2C|hvc1)$/.test(layout.video.entry)) {
    throw fail("CODEC_UNSUPPORTED", "该档位不是 H.266/VVC，无需服务端转码");
  }
  const annex = annexB(buf, layout.video);
  const audio = audioOnlyMp4(buf, layout);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-tc-"));
  try {
    const vFile = path.join(dir, "v.h266");
    const aFile = path.join(dir, "a.mp4");
    fs.writeFileSync(vFile, annex);
    if (audio) fs.writeFileSync(aFile, audio);
    return { dir, vFile, aFile, kind: "vvc", hasAudio: Boolean(audio), bytesIn: buf.length };
  } catch (error) {
    // 写临时文件失败必须清掉刚建的目录，否则每次失败都泄漏一个 hg-tc-*。
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// P0-1：边下边转。红果的 HEVC MP4 是 faststart（moov 在 mdat 之前），先只读一小段
// （够解析出 moov 即可）就启动 ffmpeg，用 stdin 把剩余字节顺序泵进去——不用等整集下载完。
const HEAD_MAX = 8 * 1024 * 1024;

export async function stageHevcStream(stream) {
  const CH = 1024 * 1024;
  const total = Number(stream.total) || 0;
  if (!total) throw new Error("分片总长为 0");
  if (total > MAX_INPUT) throw fail("SOURCE_OOM", "该集文件过大，超出转码上限（" + MAX_INPUT + " 字节）");
  const parts = [];
  let got = 0;
  let buf = null;
  let moov = null;
  let moovDone = false;
  let mdatStart = -1;
  // 只按「盒头」扫描：mdat 通常比一个读块大得多，用 boxes() 会因为盒体不完整而丢掉它，
  // 结果非要读完整集才认得出 mdat（等于退回「整集下载」）。这里允许最后一个盒被截断。
  const scan = (b) => {
    const list = [];
    let off = 0;
    while (off + 8 <= b.length) {
      let size = b.readUInt32BE(off);
      let hdr = 8;
      if (size === 1) {
        if (off + 16 > b.length) break;
        size = Number(b.readBigUInt64BE(off + 8));
        hdr = 16;
      } else if (size === 0) {
        size = b.length - off;
      }
      if (size < hdr) break;
      list.push({
        type: b.toString("latin1", off + 4, off + 8),
        start: off,
        size,
        complete: off + size <= b.length,
      });
      if (off + size > b.length) break; // 截断：只保留这个盒头，别继续往后扫
      off += size;
    }
    return list;
  };
  while (got < total && got < HEAD_MAX) {
    const end = Math.min(got + CH - 1, total - 1);
    const part = await stream.chunk(got, end);
    parts.push(part);
    got += part.length;
    buf = Buffer.concat(parts);
    const top = scan(buf);
    moov = top.find((b) => b.type === "moov") || null;
    moovDone = !!(moov && moov.complete);
    const mdat = top.find((b) => b.type === "mdat");
    mdatStart = mdat ? mdat.start : -1;
    // moov 已完整、且 mdat 排在 moov 后面（faststart）→ 立刻开转，剩下的 mdat 边下边喂给 ffmpeg。
    if (moovDone && mdatStart > moov.start) break;
    if (mdat && mdat.start < (moov ? moov.start : Number.MAX_SAFE_INTEGER)) return null; // 非 faststart
    if (got >= total) break;
  }
  if (!moovDone || mdatStart < 0 || mdatStart <= moov.start) {
    return null; // 解析不了或非 faststart：让调用方回落到「整集下载」路径
  }
  const layout = analyse(buf);
  if (!/^(hvc1|hev1)$/.test(layout.video.entry)) {
    throw fail("CODEC_UNSUPPORTED", "该档位不是 HEVC，无需服务端转码");
  }
  return {
    kind: "hevc-stream",
    stream,
    total,
    head: buf.subarray(0, got),
    headLen: got,
    hasAudio: Boolean(layout.audio),
  };
}

// 把已读的 head 和剩余字节顺序写进 ffmpeg 的 stdin；ffmpeg 提前退出（EPIPE）时安静收场。
export async function pumpHevcStream(child, staged) {
  const stdin = child && child.stdin;
  if (!stdin) throw new Error("ffmpeg stdin 不可用");
  stdin.on("error", () => { /* ffmpeg 提前关管道的 EPIPE 噪音，忽略 */ });
  const CH = 1024 * 1024;
  const write = (data) =>
    new Promise((resolve, reject) => {
      if (!data || !data.length) return resolve();
      if (stdin.destroyed || stdin.writableEnded) return reject(new Error("ffmpeg stdin 已关闭"));
      stdin.write(data, (err) => (err ? reject(err) : resolve()));
    });
  try {
    if (staged.headLen) await write(staged.head);
    for (let off = staged.headLen; off < staged.total; off += CH) {
      const end = Math.min(off + CH - 1, staged.total - 1);
      const part = await staged.stream.chunk(off, end);
      await write(part);
    }
    if (!stdin.destroyed) stdin.end();
  } catch (error) {
    try { stdin.destroy(); } catch { /* 已关闭 */ }
    throw error;
  }
}

// HEVC(hvc1) 档位：MP4 容器本身是标准的（moov/stbl 正常，ffmpeg 直接能读），
// 不需要像 VVC 那样手工剥 NAL，只要把整集落盘后交给 ffmpeg 重编码成 H.264。
export async function stageHevcInput(stream) {
  const buf = await readAll(stream);
  const layout = analyse(buf);
  if (!/^(hvc1|hev1)$/.test(layout.video.entry)) {
    throw fail("CODEC_UNSUPPORTED", "该档位不是 HEVC，无需服务端转码");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-tc-"));
  try {
    const mp4File = path.join(dir, "in.mp4");
    fs.writeFileSync(mp4File, buf);
    return { dir, mp4File, kind: "hevc", hasAudio: Boolean(layout.audio), bytesIn: buf.length };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function dropStage(dir) {
  if (!dir) return;
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

// 转码共用的编码参数（输出封装由调用方追加）。
// VVC：输入是裸 Annex B 码流（-f vvc）+ 另一份纯音频 MP4；
// HEVC：输入就是标准 MP4，音视频一起读，并加码率上限避免 1080P 转出过大的文件。
export function h264Args(staged) {
  const { vFile, aFile, hasAudio } = staged || {};
  if (staged && staged.kind === "hevc") {
    const args = ["-hide_banner", "-v", "error", "-nostdin", "-i", staged.mp4File, "-map", "0:v:0"];
    if (hasAudio) args.push("-map", "0:a:0");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-maxrate", "2500k", "-bufsize", "5000k", "-c:a", "copy");
    return args;
  }
  // hevc-stream：输入来自 stdin 管道（stageHevcStream 已把 moov 读进 head），无需落地整集。
  if (staged && staged.kind === "hevc-stream") {
    const args = ["-hide_banner", "-v", "error", "-nostdin", "-i", "pipe:0", "-map", "0:v:0"];
    if (staged.hasAudio) args.push("-map", "0:a:0");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-maxrate", "2500k", "-bufsize", "5000k", "-c:a", "copy");
    return args;
  }
  const args = ["-hide_banner", "-v", "error", "-nostdin", "-f", "vvc", "-i", vFile];
  if (hasAudio) args.push("-i", aFile);
  args.push("-map", "0:v:0");
  if (hasAudio) args.push("-map", "1:a:0");
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "copy");
  return args;
}
