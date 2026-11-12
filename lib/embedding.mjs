// 向量记忆的基础设施：调硅基流动 bge-m3 把文本转向量，带磁盘缓存与每日上限。
// 免费模型：bge-m3 免费（9B 以下/embedding 免费层），但仍要项目 key。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const API = 'https://api.siliconflow.cn/v1/embeddings';
const MODEL = 'BAAI/bge-m3';
const CACHE_MAX = 3000;
const DAILY_CAP = 800;

function paths(home = os.homedir()) {
  const base = path.join(home, '.dsh', 'qq-fish');
  return { base, cache: path.join(base, 'embedding-cache.json'), config: path.join(base, 'config.json') };
}

function readJson(file, fb = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}

function hashText(t) {
  return crypto.createHash('sha1').update(String(t)).digest('hex').slice(0, 24);
}

export function embeddingKey(home = os.homedir()) {
  const cfg = readJson(paths(home).config, {}) || {};
  return String(cfg.embeddingKey || cfg.embeddingApiKey || '').trim();
}

export function embeddingModel(home = os.homedir()) {
  const cfg = readJson(paths(home).config, {}) || {};
  return String(cfg.embeddingModel || MODEL).trim();
}

function today(now = new Date()) {
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}

/**
 * 批量转向量（先查缓存；缓存不命中再请求，合并一次调用）。
 * @returns {Promise<number[][]|null>} 与输入等长的向量数组；失败返回 null
 */
export async function embedMany(texts, { home = os.homedir(), noCache = false } = {}) {
  const key = embeddingKey(home);
  if (!key) return null;
  const p = paths(home);
  const cache = readJson(p.cache, {}) || {};
  const list = texts.map((t) => String(t || '').trim().slice(0, 500));
  const out = new Array(list.length).fill(null);
  const need = [];
  const needIdx = [];
  for (let i = 0; i < list.length; i += 1) {
    if (!list[i]) continue;
    const h = hashText(list[i]);
    if (!noCache && cache[h] && Array.isArray(cache[h].v)) out[i] = cache[h].v;
    else { need.push(list[i]); needIdx.push(i); }
  }
  if (need.length) {
    // 每日上限
    const day = today();
    const used = cache.__usage && cache.__usage.date === day ? Number(cache.__usage.n || 0) : 0;
    if (used + need.length > DAILY_CAP) return null;
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ model: embeddingModel(home), input: need }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !Array.isArray(j.data)) return null;
      for (const item of j.data) {
        const idx = Number(item.index || 0);
        const vec = item.embedding;
        if (!Array.isArray(vec)) continue;
        const target = needIdx[idx];
        if (target == null) continue;
        out[target] = vec;
        cache[hashText(need[idx])] = { v: vec, at: Date.now() };
      }
      cache.__usage = { date: day, n: used + need.length };
      // 裁剪
      const keys = Object.keys(cache).filter((k) => k !== '__usage');
      if (keys.length > CACHE_MAX) {
        for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
      }
      writeJson(p.cache, cache);
    } catch {
      return null;
    }
  }
  return out.every((v) => Array.isArray(v)) ? out : null;
}

export async function embed(text, opts = {}) {
  const arr = await embedMany([text], opts);
  return arr && arr[0] ? arr[0] : null;
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}
