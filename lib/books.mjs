// lib/books.mjs — 合法书源：古腾堡（公版电子书）+ 维基文库（中文古籍/公版全文）
// 不做盗版站：只接开放授权 / 公有领域的书。
//
// 2026-11-06 重写要点（血泪）：
//   1) 这台机器到 gutendex 的连接时好时坏（Tailscale 抖动），单次失败就报「没搜到」= 演。
//      现在每个请求重试 2 次，失败原因记进 lastErrors，工具层会如实告诉她「网络不通」。
//   2) 古腾堡的 search 只匹配元数据（英文标题/繁体中文标题），简体「红楼梦」永远搜不到 0 条。
//      现在把 444 本中文书的目录缓存到本地（7 天），中文查询走本地匹配：繁体归一 + 别名。
//   3) zh.wikisource.org / api.ctext.org 在这条网络里连不上（UND_ERR_CONNECT_TIMEOUT），
//      维基文库只做 8 秒短超时，不通就跳过，不拖时间。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { epubExtract } from './epub.mjs'
import { stateHome } from './store.mjs'

const UA = 'Mozilla/5.0 (Linux; Android 13) Chrome/131 Mobile'
const TIMEOUT = 25000
const ZH_TTL = 7 * 24 * 3600 * 1000

/** 本次搜索过程中的失败原因（工具层取走，告诉她实话） */
let lastErrors = []
export function takeSearchErrors() {
  const e = lastErrors
  lastErrors = []
  return e
}
function note(msg) {
  if (msg) lastErrors.push(String(msg).slice(0, 120))
}

async function getText(url, { timeout = 20000, tries = 2, label = '请求' } = {}) {
  let err = ''
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xml,application/atom+xml,*/*' }, signal: ctrl.signal })
      if (!r.ok) err = 'HTTP ' + r.status
      else return await r.text()
    } catch (e) {
      err = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.name) || String((e && e.message) || e)
    } finally {
      clearTimeout(timer)
    }
    if (i + 1 < tries) await new Promise((r) => setTimeout(r, 800))
  }
  note(label + '失败（' + err + '）')
  return null
}

function unescapeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim()
}

/** 解析古腾堡 OPDS（Atom XML）：标题 / 作者 / epub 直链 */
function parseOpds(xml) {
  const BAD = /^(authors?|subjects?|bookshelves?|no records found\.?|search results?|advanced search|latest|popular|random|recently added)$/i
  const seen = new Set()
  const out = []
  const re = /<entry>([\s\S]*?)<\/entry>/g
  let m
  while ((m = re.exec(xml))) {
    const b = m[1]
    const title = unescapeXml((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '')
    const author = unescapeXml((b.match(/<name[^>]*>([\s\S]*?)<\/name>/) || [])[1] || '')
    const epubHref = (b.match(/href="([^"]+\.epub[^"]*)"/) || [])[1] || ''
    const htmlHref = (b.match(/href="([^"]+\.html[^"]*)"/) || [])[1] || ''
    const idm = b.match(/\/ebooks\/(\d+)/)
    if (!title || title.length < 2 || BAD.test(title)) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      source: '古腾堡',
      id: idm ? idm[1] : '',
      title: title.slice(0, 120),
      author: author.slice(0, 80),
      lang: '',
      epub: epubHref ? new URL(epubHref, 'https://www.gutenberg.org').href : '',
      html: htmlHref ? new URL(htmlHref, 'https://www.gutenberg.org').href : '',
      page: idm ? 'https://www.gutenberg.org/ebooks/' + idm[1] : '',
    })
  }
  return out
}

async function getJson(url, { timeout = TIMEOUT, tries = 2, label = '请求' } = {}) {
  let err = ''
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctrl.signal })
      if (!r.ok) {
        err = 'HTTP ' + r.status
      } else {
        return await r.json()
      }
    } catch (e) {
      err = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.name) || String((e && e.message) || e)
    } finally {
      clearTimeout(timer)
    }
    if (i + 1 < tries) await new Promise((r) => setTimeout(r, 900))
  }
  note(label + '失败（' + err + '）')
  return null
}

/** 古腾堡 book 对象 → 统一结构 */
function toBook(b, source = '古腾堡') {
  const f = (b && b.formats) || {}
  return {
    source,
    id: b && b.id,
    title: String((b && b.title) || '').slice(0, 120),
    author: ((b && b.authors) || []).map((a) => a.name).join('、').slice(0, 80),
    lang: ((b && b.languages) || []).join(','),
    html: f['text/html'] || '',
    epub: f['application/epub+zip'] || '',
    txt: f['text/plain; charset=utf-8'] || f['text/plain'] || '',
    page: '',
  }
}

// ── 繁简归一（只收书名/常用字，覆盖古腾堡这 444 本中文书够用） ────────────
const T2S_PAIRS =
  '紅红樓楼夢梦遊游記记國国義义傳传論论語语經经孫孙詩诗齋斋異异書书學学說说愛爱麗丽華华東东觀观閣阁園园風风雲云龍龙鳳凤鳥鸟魚鱼馬马車车萬万無无数數声聲樂乐氣气電电開开長长門门問问間间時时見见現现實实應应該该讓让對对頭头覺觉來来這这个個們们樣样從从會会後后邊边還还過过進进遠远運运动動讀读写寫聽听講讲認认识識谁誰請请謝谢歡欢買买賣卖錢钱鐵铁银銀鐘钟館馆飯饭飲饮騎骑雞鸡鴨鸭龜龟獸兽嚴严肅肃禮礼畫画筆笔紙纸硯砚戲戏劇剧雜杂誌志綱纲鑒鉴綠绿藍蓝黃黄歲岁曆历舊旧戰战軍军將将師师參参細细節节終终結结給给統统絲丝練练編编織织繼继續续網网羅罗罷罢聞闻聯联聰聪職职脅胁腦脑腳脚臉脸興兴舉举艱艰藝艺蘇苏蘭兰蘆芦蘿萝蟲虫蠻蛮補补裝装製制複复親亲規规視视覽览訓训許许設设評评試试話话詳详談谈變变讚赞豐丰貴贵費费資资賓宾賜赐質质趙赵趕赶趨趋躍跃體体髮发鬥斗鮮鲜黨党齊齐齒齿貓猫豬猪為为與与於于爾尔嘗尝嘆叹週周迴回疊叠臺台灣湾島岛嶺岭峽峡燦灿爛烂爐炉煙烟燈灯燒烧營营燭烛爭争牆墙獨独獲获獻献獵猎環环瓊琼產产畢毕癡痴發发盡尽監监盤盘矯矫礙碍祕秘禍祸禪禅穩稳竊窃豎竖純纯紗纱紋纹紡纺紹绍絹绢緞缎縫缝繞绕繪绘纜缆翹翘聳耸腸肠膚肤膩腻膽胆莊庄葦苇蔥葱蕭萧薑姜藥药處处號号蠶蚕褲裤襲袭訂订計计訊讯討讨託托訛讹訪访訴诉診诊註注証证詞词詢询誇夸課课調调諸诸諾诺謀谋謂谓證证譜谱議议護护豔艳貝贝負负財财貢贡貧贫貨货販贩貪贪責责貸贷貼贴賊贼賞赏賢贤賤贱賦赋賬账賭赌賴赖購购賽赛贈赠軌轨軒轩軟软軸轴較较載载輔辅輕轻輛辆輝辉輪轮輸输轉转轟轰轎轿辭辞農农達达違违遙遥遜逊遞递適适遲迟遷迁選选遺遗遼辽邁迈邏逻郵邮鄉乡鄒邹鄭郑鄰邻醫医醬酱釀酿釋释釘钉針针釣钓鈔钞鈴铃鉤钩銅铜銷销鋒锋鋼钢錄录錫锡錯错鍵键鏡镜鑄铸鑰钥閉闭閏闰閑闲閱阅闆板闡阐隊队階阶陽阳陰阴陳陈陸陆隕陨際际隨随險险隱隐雙双離离難难霧雾靈灵靜静韌韧響响頂顶項项順顺須须預预頌颂領领頸颈頻频題题額额顏颜願愿類类顧顾顯显飛飞飽饱飾饰養养餅饼餘余饑饥饒饶馮冯馳驰駐驻駕驾驗验驚惊驟骤髒脏鬆松鬧闹魯鲁鯉鲤鯨鲸鳴鸣鴻鸿鵝鹅鹽盐點点鷹鹰麥麦鼠鼠'

const T2S = new Map()
for (let i = 0; i + 1 < T2S_PAIRS.length; i += 2) T2S.set(T2S_PAIRS[i], T2S_PAIRS[i + 1])
const S2T = new Map()
for (const [t, s] of T2S) if (!S2T.has(s)) S2T.set(s, t)

function toSimple(s) {
  let out = ''
  for (const ch of String(s || '')) out += T2S.get(ch) || ch
  return out
}
function toTrad(s) {
  let out = ''
  for (const ch of String(s || '')) out += S2T.get(ch) || ch
  return out
}
function norm(s) {
  return toSimple(String(s || '').toLowerCase()).replace(/[\s·・,，。.、:：;；!！?？'"“”‘’()（）\[\]【】《》<>—\-_/\\|]/g, '')
}

/** 常见书的别名（中文 → 古腾堡/英文里可能的写法） */
const ALIAS = {
  红楼梦: ['red chamber', 'hong lou meng', 'hung lou meng'],
  石头记: ['red chamber'],
  西游记: ['journey to the west', 'xi you ji', 'hsi yu chi'],
  三国演义: ['three kingdoms', 'san guo'],
  三国志: ['three kingdoms'],
  水浒传: ['water margin', 'outlaws of the marsh', 'shui hu'],
  论语: ['analects', 'lun yu'],
  道德经: ['tao te ching', 'dao de jing', 'lao tzu', 'laozi'],
  老子: ['tao te ching', 'lao tzu'],
  孙子兵法: ['art of war', 'sun tzu'],
  诗经: ['book of songs', 'shi jing', 'shih ching'],
  楚辞: ['songs of chu', 'chu ci'],
  聊斋志异: ['strange stories', 'liao zhai'],
  儒林外史: ['scholars', 'ru lin wai shi'],
  金瓶梅: ['golden lotus', 'chin ping mei'],
  牡丹亭: ['peony pavilion'],
  西厢记: ['western chamber'],
  唐诗: ['tang poems', 'tang poetry'],
  宋词: ['song poems', 'song ci'],
  古文观止: ['ancient prose'],
  史记: ['records of the grand historian', 'shiji'],
  庄子: ['chuang tzu', 'zhuangzi'],
  孟子: ['mencius'],
  大学: ['great learning'],
  中庸: ['doctrine of the mean'],
  易经: ['i ching', 'book of changes', 'yijing'],
  山海经: ['classic of mountains', 'shan hai jing'],
  世说新语: ['new account of tales', 'shi shuo xin yu'],
  爱丽丝梦游仙境: ['alice'],
  爱丽丝: ['alice'],
  小王子: ['little prince'],
  傲慢与偏见: ['pride and prejudice'],
  简爱: ['jane eyre'],
  呼啸山庄: ['wuthering heights'],
  老人与海: ['old man and the sea'],
  1984: ['nineteen eighty-four', '1984'],
  动物农场: ['animal farm'],
  哈姆雷特: ['hamlet'],
  悲惨世界: ['les miserables'],
  基督山: ['monte cristo'],
  福尔摩斯: ['sherlock'],
  格林童话: ['grimm'],
  安徒生: ['andersen'],
  伊索寓言: ['aesop'],
  天方夜谭: ['arabian nights'],
  一千零一夜: ['arabian nights'],
  浮士德: ['faust'],
  神曲: ['divine comedy'],
  奥德赛: ['odyssey'],
  伊利亚特: ['iliad'],
  柏拉图: ['plato'],
  理想国: ['republic'],
  君主论: ['prince', 'machiavelli'],
  国富论: ['wealth of nations'],
  资本论: ['capital', 'marx'],
  共产党宣言: ['communist manifesto'],
  物种起源: ['origin of species', 'darwin'],
  相对论: ['relativity'],
}

// ── 中文书目缓存 ────────────────────────────────────────────────────────
const ZH_CACHE_FILE = () => join(stateHome(), 'books-zh-cache.json')
let zhMem = null

/** 拉/读古腾堡中文书目（444 本，7 天缓存） */
let zhFailAt = 0
let zhLoading = null

/** 后台预热（不阻塞搜索）：搜中文时顺手拉一次，成功了下次就快了 */
export function prefetchZhCatalog() {
  if (zhMem || zhLoading || Date.now() - zhFailAt < 10 * 60 * 1000) return
  zhLoading = ensureZhCatalog({ maxPages: 14 })
    .catch(() => {})
    .finally(() => { zhLoading = null })
}

export async function ensureZhCatalog({ force = false, maxPages = 14 } = {}) {
  if (!force && zhMem && Date.now() - zhMem.at < ZH_TTL) return zhMem.books
  // 刚失败过就别反复硬拉（每次要 20 秒），10 分钟内直接用别名走在线搜
  if (!force && Date.now() - zhFailAt < 10 * 60 * 1000) return zhMem ? zhMem.books : []
  try {
    const f = ZH_CACHE_FILE()
    if (!force && existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      if (j && Array.isArray(j.books) && j.books.length && Date.now() - (j.at || 0) < ZH_TTL) {
        zhMem = { at: j.at, books: j.books }
        return j.books
      }
    }
  } catch {}
  const books = []
  for (let page = 1; page <= maxPages; page++) {
    const j = await getJson('https://gutendex.com/books?languages=zh&page=' + page, {
      timeout: 20000,
      tries: 2,
      label: '古腾堡中文目录',
    })
    const rs = (j && j.results) || []
    for (const b of rs) books.push(toBook(b))
    if (!j || !j.next || !rs.length) break
  }
  if (!books.length) zhFailAt = Date.now()
  if (books.length) {
    zhMem = { at: Date.now(), books }
    try {
      mkdirSync(join(stateHome(), 'cache'), { recursive: true })
      writeFileSync(ZH_CACHE_FILE(), JSON.stringify({ at: Date.now(), count: books.length, books }), 'utf8')
    } catch {}
  }
  return books
}

/** 中文查询：本地目录匹配（简繁归一 + 别名 + 子序列） */
function searchZhLocal(q, books) {
  const nq = norm(q)
  if (!nq) return []
  const aliases = (ALIAS[q] || []).map((x) => norm(x))
  const scored = []
  for (const b of books) {
    const nt = norm(b.title)
    const na = norm(b.author)
    let score = 0
    if (nt === nq) score = 100
    else if (nt.includes(nq)) score = 80
    else if (nt.includes(toTrad(nq)) || toTrad(nt).includes(toTrad(nq))) score = 70
    else if (na.includes(nq)) score = 50
    else if (aliases.length && aliases.some((a) => nt.includes(a))) score = 60
    else if (nq.length >= 2) {
      // 子序列：红楼梦 → 紅樓夢 已由 toSimple 处理；再兜一层「字都在」
      const chars = [...new Set(nq)].filter((c) => /[\u4e00-\u9fff]/.test(c))
      if (chars.length && chars.every((c) => nt.includes(c))) score = 30
    }
    if (score > 0) scored.push({ b, score })
  }
  scored.sort((x, y) => y.score - x.score)
  return scored.slice(0, 5).map((x) => x.b)
}

/** 古腾堡：中文先查本地目录缓存，英文走 OPDS 搜索（XML 稳），别名兜底 */
export async function searchGutenberg(q, limit = 3) {
  const isZh = /[\u4e00-\u9fff]/.test(q)
  if (isZh) {
    const books = await ensureZhCatalog()
    if (books.length) {
      const hit = searchZhLocal(q, books)
      if (hit.length) return hit.slice(0, limit)
    } else {
      prefetchZhCatalog()
    }
    // 别名（英文/拼音书名）优先：繁体 OPDS 经常搜不到
    for (const alias of (ALIAS[q] || []).slice(0, 2)) {
      const xml = await getText('https://www.gutenberg.org/ebooks/search.opds/?query=' + encodeURIComponent(alias), { timeout: 15000, tries: 1, label: '古腾堡OPDS' })
      const hits = xml ? parseOpds(xml) : []
      if (hits.length) return hits.slice(0, limit)
    }
    // 再试繁体书名
    const xmlZh = await getText('https://www.gutenberg.org/ebooks/search.opds/?query=' + encodeURIComponent(toTrad(q)), { timeout: 15000, tries: 1, label: '古腾堡OPDS' })
    const hitsZh = xmlZh ? parseOpds(xmlZh) : []
    if (hitsZh.length) return hitsZh.slice(0, limit)
  }
  const xml = await getText('https://www.gutenberg.org/ebooks/search.opds/?query=' + encodeURIComponent(q), { label: '古腾堡OPDS' })
  const hits = xml ? parseOpds(xml) : []
  if (hits.length) return hits.slice(0, limit)
  // 兜底：gutendex（有 epub 直链，但网络不稳）
  const j = await getJson('https://gutendex.com/books?search=' + encodeURIComponent(q), { tries: 1, label: 'gutendex' })
  if (!j || !Array.isArray(j.results)) return []
  return j.results.slice(0, limit).map((b) => toBook(b))
}

/** 标准电子书：英文公版，排版最好，epub 直链 */
export async function searchStandardEbooks(q, limit = 3) {
  const html = await getText('https://standardebooks.org/ebooks?query=' + encodeURIComponent(q), { label: '标准电子书' })
  if (!html) return []
  const out = []
  const re = /<li[^>]*about="(\/ebooks\/[^"]+)"[^>]*>/g
  let m
  while ((m = re.exec(html)) && out.length < limit) {
    const about = m[1]
    const parts = about.split('/').filter(Boolean) // ['ebooks', author, title, maybe translator]
    if (parts.length < 3) continue
    const author = parts[1]
    const titleSlug = parts[2]
    const pretty = titleSlug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    const prettyAuthor = author.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    out.push({
      source: '标准电子书',
      title: pretty.slice(0, 120),
      author: prettyAuthor,
      lang: 'en',
      epub: 'https://standardebooks.org' + about + '/downloads/' + author + '_' + titleSlug + '.epub',
      page: 'https://standardebooks.org' + about,
    })
  }
  return out
}

/** 维基文库：中文公版书/古籍全文（这条网络基本连不上，快速失败） *//** 维基文库：中文公版书/古籍全文（这条网络基本连不上，8 秒短超时） */
export async function searchWikisource(q, limit = 3) {
  const j = await getJson(
    'https://zh.wikisource.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(q) + '&format=json&srlimit=' + limit + '&srprop=snippet',
    { timeout: 8000, tries: 1, label: '维基文库' },
  )
  const hits = (j && j.query && j.query.search) || []
  return hits.map((h) => ({
    source: '维基文库',
    title: String(h.title || '').slice(0, 80),
    author: '',
    lang: 'zh',
    page: 'https://zh.wikisource.org/wiki/' + encodeURIComponent(h.title || ''),
    snippet: String((h.snippet || '').replace(/<[^>]+>/g, '')).slice(0, 120),
  }))
}

/** 维基文库页面正文（action=parse，取纯文本） */
export async function wikisourceText(title, maxChars = 4000) {
  const j = await getJson(
    'https://zh.wikisource.org/w/api.php?action=parse&page=' + encodeURIComponent(title) + '&prop=text&format=json&disableeditsection=1',
    { timeout: 12000, tries: 1, label: '维基文库正文' },
  )
  const html = j && j.parse && j.parse.text && j.parse.text['*']
  if (!html) return { ok: false, error: '取不到正文（维基文库可能连不上）' }
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#\d+;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { ok: true, text: text.slice(0, maxChars), chars: text.length }
}

/** 下载 epub 并抽正文 */
export async function readEpubUrl(url, stateDir, maxChars = 6000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 40000)
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, signal: ctrl.signal })
    if (!r.ok) return { ok: false, error: '下载失败 ' + r.status }
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 30 * 1024 * 1024) return { ok: false, error: '文件太大' }
    const dir = join(stateDir, 'books')
    try { mkdirSync(dir, { recursive: true }) } catch {}
    const file = join(dir, 'book-' + Date.now().toString(36) + '.epub')
    writeFileSync(file, buf)
    const r2 = await epubExtract(file, { maxChars, maxChaps: 12 })
    return r2
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  } finally {
    clearTimeout(timer)
  }
}

/** 统一的搜索入口：古腾堡（中文缓存/OPDS）→ 标准电子书 → 维基文库 */
export async function searchBooks(q) {
  const g = await searchGutenberg(q).catch(() => [])
  if (g.length) return g
  const se = await searchStandardEbooks(q).catch(() => [])
  if (se.length) return se
  const w = await searchWikisource(q).catch(() => [])
  return w
}
