// 语义记忆检索：从记忆卡里按"意思像"找条目（补关键词召回的盲区）。
// 数据来自 sc/memory-card.mjs 的 records；向量有磁盘缓存，不重复付费。
import { loadMemoryCard } from './sc/memory-card.mjs';
import { memoryPaths } from './memory-decay.mjs';
import { embedMany, cosine } from './embedding.mjs';

const MAX_RECORDS = 150;
const MIN_SCORE = 0.42;

function recordText(r) {
  const title = String(r.title || '').trim();
  const text = String(r.text || '').trim();
  return (title && text ? title + '：' + text : title || text).replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * @param {string} query 当前一句（或最近几句）对话
 * @param {{topK?: number, minScore?: number, limit?: number}} opts
 * @returns {Promise<Array<{text: string, score: number, at: number}>>}
 */
export async function searchMemories(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  let card = null;
  try { card = loadMemoryCard(memoryPaths()); } catch { return []; }
  if (!card || !Array.isArray(card.records) || !card.records.length) return [];

  const limit = Math.max(10, Math.min(300, Number(opts.limit) || MAX_RECORDS));
  const records = card.records
    .filter((r) => r && (r.text || r.title) && r.clarity !== 'forgotten' && r.clarity !== 'trace')
    .slice(-limit);
  if (!records.length) return [];

  const texts = records.map(recordText);
  let vectors = null;
  try { vectors = await embedMany([q, ...texts]); } catch { return []; }
  if (!vectors || !vectors[0]) return [];

  const qv = vectors[0];
  const scored = [];
  for (let i = 0; i < records.length; i += 1) {
    const mv = vectors[i + 1];
    if (!mv) continue;
    const score = cosine(qv, mv);
    if (score >= (opts.minScore != null ? opts.minScore : MIN_SCORE)) {
      scored.push({ text: recordText(records[i]), score, at: Number(new Date(records[i].createdAt).getTime()) || 0 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Number(opts.topK) || 3));
}
