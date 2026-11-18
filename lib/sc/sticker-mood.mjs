/**
 * 表情包情绪分类（参考 ohwhale 的 12 类方案）
 * 输入：OCR 文字 + tags
 * 输出：12 类之一，或 null
 */

export const STICKER_MOODS = ['困累', '委屈', '嫌弃', '安慰', '害羞', '开心', '得意', '惊讶', '撒娇', '无语', '生气', '饿想吃']

// 顺序有意义：越具体的放前面（『饿想吃』比『开心』具体）
const RULES = [
  { mood: '饿想吃', words: ['饿', '白饭', '吃饭', '想吃', '奶茶', '馋', '干饭', '饭', '吃'] },
  { mood: '困累', words: ['困', '睡', '熬夜', '打哈欠', '眯', '躺', '累死', '好累', '醒了', '起床', '晚安', '睁不开', '迷糊', '犯困'] },
  { mood: '委屈', words: ['委屈', '呜呜', '哭', '难受', '可怜', '欺负', '眼泪', '瘪嘴', '伤心'] },
  { mood: '安慰', words: ['摸摸', '抱抱', '别哭', '乖', '安慰', '没事', '不闹', '好孩子', '揉头'] },
  { mood: '害羞', words: ['害羞', '脸红', '羞', '不好意思', '别看', '心跳'] },
  { mood: '生气', words: ['生气', '愤怒', '气死', '滚', '烦', '傻逼', '骂', '混蛋', '可恶'] },
  { mood: '嫌弃', words: ['嫌弃', '啧', '吐', '恶心', '臭', '脏', '无语了', '鄙视'] },
  { mood: '惊讶', words: ['惊', '卧槽', '居然', '什么鬼', '真的假的', '震', '啊？', '诶'] },
  { mood: '得意', words: ['得意', '最强', '赢', '厉害', '傲慢', '嚣张', '牛', '服不服', '我赢了'] },
  { mood: '撒娇', words: ['撒娇', '求你', '抱', '哼哼', '嘛', '人家', '好不好', '要嘛'] },
  { mood: '开心', words: ['哈哈', '笑', '开心', '好耶', '高兴', '快乐', '爽', '赢了', '妙'] },
  { mood: '无语', words: ['无语', '无语了', '算了', '离谱', '服了', '你赢了', '摊手'] },
]

/** 归一化文本 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
}

/**
 * 判断一张表情包属于哪个情绪。
 * @param {object} sticker { desc, tags, stem, file }
 * @returns {{mood: string, hits: string[], score: number} | null}
 */
export function classifySticker(sticker) {
  const parts = [sticker.desc || '', ...(Array.isArray(sticker.tags) ? sticker.tags : []), sticker.stem || '']
  const text = norm(parts.join(' '))
  if (!text) return null

  let best = null
  for (const rule of RULES) {
    const hits = rule.words.filter((w) => text.includes(norm(w)))
    if (!hits.length) continue
    // 词越长越具体，权重越高
    const score = hits.reduce((n, w) => n + w.length, 0)
    if (!best || score > best.score) best = { mood: rule.mood, hits, score }
  }
  return best
}
