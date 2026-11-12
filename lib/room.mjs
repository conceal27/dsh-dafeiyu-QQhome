// 她的小屋：四房两卫一厨一厅一阳台一露台。
// 家具是生活痕迹（带房间归属），不是工具；她此刻在哪个房间由日程推算。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = 'room.json';

export const ROOMS = [
  { id: 'living', name: '客厅', emoji: '🛋️' },
  { id: 'kitchen', name: '厨房', emoji: '🍳' },
  { id: 'master', name: '主卧', emoji: '🛏️' },
  { id: 'second', name: '次卧', emoji: '🛌' },
  { id: 'study', name: '书房', emoji: '📚' },
  { id: 'guest', name: '主人房', emoji: '🛏️' },
  { id: 'bath1', name: '主卫', emoji: '🚿' },
  { id: 'bath2', name: '客卫', emoji: '🛁' },
  { id: 'balcony', name: '阳台', emoji: '🌿' },
  { id: 'terrace', name: '露台', emoji: '🌤️' },
];

const DEFAULT_ITEMS = [
  { emoji: '🛏️', name: '床', room: 'master', x: 24, y: 62, story: '她自己挑的，说睡起来像被白饭包住。' },
  { emoji: '🪟', name: '落地窗', room: 'living', x: 76, y: 18, story: '能看到楼下小卖部，晚上灯一亮就想吃宵夜。' },
  { emoji: '🛋️', name: '沙发', room: 'living', x: 42, y: 58, story: '窝着刷手机、看剧、发呆的地方。' },
  { emoji: '🍚', name: '碗柜', room: 'kitchen', x: 28, y: 34, story: '专门放她的碗，最大的那个是吃白饭用的。' },
  { emoji: '🍳', name: '灶台', room: 'kitchen', x: 64, y: 40, story: '其实很少开火，主要用来煮泡面。' },
  { emoji: '💡', name: '台灯', room: 'master', x: 66, y: 28, story: '晚上开到很暗，说太亮会睡不着。' },
  { emoji: '🧸', name: '小鲸鱼玩偶', room: 'master', x: 84, y: 58, story: '抱着睡的，说是她的同类。' },
  { emoji: '🚿', name: '淋浴', room: 'bath1', x: 50, y: 36, story: '洗澡的时候会唱歌，跑调。' },
  { emoji: '📚', name: '书桌', room: 'study', x: 44, y: 52, story: '摆了很多书，翻几页就用来垫碗。' },
  { emoji: '🪴', name: '绿萝', room: 'balcony', x: 36, y: 46, story: '浇水总忘，但还活着。' },
  { emoji: '🌤️', name: '躺椅', room: 'terrace', x: 52, y: 50, story: '晒太阳专用，晒着晒着就睡着了。' },
  { emoji: '🛁', name: '浴缸', room: 'bath2', x: 48, y: 42, story: '客人用的，她自己很少泡。' },
  { emoji: '🛏️', name: '主人的床', room: 'guest', x: 40, y: 56, story: '留给主人的，铺得整整齐齐，他说不定哪天来住。' },
  { emoji: '🛌', name: '次卧小床', room: 'second', x: 44, y: 56, story: '午睡用的，被子从来不叠。' },
];

const POOL = [
  { emoji: '📺', name: '小电视', room: 'living', story: '看 B 站用的，有时候看着看着就睡了。' },
  { emoji: '🪞', name: '镜子', room: 'master', story: '出门前照一下，说今天也很可爱。' },
  { emoji: '🧺', name: '洗衣篮', room: 'bath1', story: '堆到满了才洗。' },
  { emoji: '🕯️', name: '香薰蜡烛', room: 'living', story: '只在心情好的时候点。' },
  { emoji: '🎧', name: '耳机', room: 'study', story: '听歌的时候听不见人叫她。' },
  { emoji: '🧋', name: '奶茶杯', room: 'living', story: '喝完了没扔，说留着当纪念。' },
  { emoji: '🌙', name: '小夜灯', room: 'master', story: '怕黑，又不肯承认。' },
  { emoji: '🍽️', name: '一摞盘子', room: 'kitchen', story: '洗得干净，摆得也整齐。' },
  { emoji: '🐟', name: '鱼缸摆件', room: 'living', story: '里面没鱼，她说先摆着占个位置。' },
  { emoji: '🪴', name: '吊兰', room: 'balcony', story: '阳台上的第二盆，长得比绿萝好。' },
];

export function roomPath(home = os.homedir()) {
  return path.join(home, '.dsh', 'qq-fish', FILE);
}

function readJson(file, fb) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}

function normalizeRoomId(id, fallback = 'living') {
  const s = String(id || '').trim();
  return ROOMS.some((r) => r.id === s) ? s : fallback;
}

export function loadRoom(home = os.homedir()) {
  const raw = readJson(roomPath(home), null);
  let items = raw && Array.isArray(raw.items) && raw.items.length ? raw.items : null;
  if (!items) {
    items = DEFAULT_ITEMS.map((x, i) => ({ id: 'f' + i, emoji: x.emoji, name: x.name, room: x.room, x: x.x, y: x.y, story: x.story, from: 'start', addedAt: Date.now() }));
  }
  // 迁移：旧数据没有 room 字段的，按名字分配
  items = items.map((it, i) => ({
    id: it.id || 'f' + i,
    emoji: it.emoji || '📦',
    name: it.name || '东西',
    room: normalizeRoomId(it.room || guessRoomFromText(it.name), 'living'),
    x: Number.isFinite(Number(it.x)) ? Number(it.x) : 50,
    y: Number.isFinite(Number(it.y)) ? Number(it.y) : 50,
    story: it.story || '',
    from: it.from || 'start',
    addedAt: it.addedAt || Date.now(),
  }));
  return { name: raw && raw.name ? raw.name : '大肥鱼的家', items, lastAddDate: raw && raw.lastAddDate ? raw.lastAddDate : '', weather: ['sunny', 'rain', 'snow'].includes(raw && raw.weather) ? raw.weather : '', updatedAt: Date.now() };
}

export function setWeather(home = os.homedir(), weather = 'sunny') {
  const w = ['sunny', 'rain', 'snow'].includes(String(weather)) ? String(weather) : 'sunny';
  const r = loadRoom(home);
  r.weather = w;
  saveRoom(home, r);
  return w;
}

export function saveRoom(home, room) {
  writeJson(roomPath(home), { ...room, updatedAt: Date.now() });
}

/** 按文字猜房间（用于日程/家具名） */
export function guessRoomFromText(text) {
  const t = String(text || '');
  // 先匹配更具体的场景，再落到卧室（「沙发上打盹」不该算主卧）
  if (/沙发|客厅|电视|看剧|刷手机|打盹/.test(t)) return 'living';
  if (/做饭|煮|厨房|碗|锅|灶|泡面|烧水/.test(t)) return 'kitchen';
  if (/洗澡|淋浴|厕所|卫生间|刷牙|洗脸|洗衣/.test(t)) return 'bath1';
  if (/书房|看书|写字|电脑|工作|学习/.test(t)) return 'study';
  if (/阳台|晾|衣服/.test(t)) return 'balcony';
  if (/露台|看星星|吹风|晒太阳|躺椅/.test(t)) return 'terrace';
  if (/主人房|客房/.test(t)) return 'guest';
  if (/次卧/.test(t)) return 'second';
  if (/睡|床|躺|赖床|被窝|卧室/.test(t)) return 'master';
  return 'living';
}

/** 面板快照：所有房间 + 家具 + 她此刻在哪 */
export function roomSnapshot(home = os.homedir()) {
  const r = loadRoom(home);
  const rooms = ROOMS.map((room) => ({
    ...room,
    items: r.items.filter((it) => it.room === room.id),
  }));
  return { ok: true, name: r.name, items: r.items, rooms, recent: r.items.slice(-3), weather: r.weather || '', weatherAuto: !r.weather };
}

/** 添一件家具（可指定房间；默认随机一个没东西的房间） */
export function addFurniture(home = os.homedir(), { from = 'her', room = '', item = null } = {}) {
  const r = loadRoom(home);
  const have = new Set(r.items.map((x) => String(x.name)));
  const picks = POOL.filter((x) => !have.has(x.name));
  const src = item || picks[Math.floor(Math.random() * Math.max(1, picks.length))];
  if (!src) return null;
  const rid = normalizeRoomId(room || src.room || 'living');
  const next = {
    id: 'f' + Date.now().toString(36),
    emoji: src.emoji,
    name: src.name,
    room: rid,
    x: 16 + Math.random() * 68,
    y: 22 + Math.random() * 56,
    story: src.story,
    from,
    addedAt: Date.now(),
  };
  r.items.push(next);
  saveRoom(home, r);
  return next;
}

/** 每天最多一次：15% 概率自己添一件 */
export function maybeAddDaily(home = os.homedir(), now = new Date()) {
  const r = loadRoom(home);
  const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  if (r.lastAddDate === day) return null;
  r.lastAddDate = day;
  saveRoom(home, r);
  if (Math.random() >= 0.15) return null;
  return addFurniture(home, { from: 'her' });
}

/** 她聊天时知道自己家（简短） */
export function roomPromptBlock(home = os.homedir()) {
  try {
    const r = loadRoom(home);
    const byRoom = {};
    for (const it of r.items) {
      const room = ROOMS.find((x) => x.id === it.room);
      const key = room ? room.name : '家';
      byRoom[key] = (byRoom[key] || []).concat(it.name);
    }
    const lines = ROOMS.filter((x) => byRoom[x.name]).map((x) => x.name + '：' + byRoom[x.name].slice(0, 4).join('、'));
    if (!lines.length) return '';
    return '【她的家】她住在一个四房两卫一厨一厅一阳台一露台的家；其中「主人房」是留给主人的——她平时不睡那间，偶尔进去打扫或放东西。各房间有：' + lines.join('；') + '。聊天时可以自然提到（「我在客厅」「厨房里」），但别罗列。';
  } catch {
    return '';
  }
}
