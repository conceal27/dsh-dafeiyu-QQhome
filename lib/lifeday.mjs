// 每天一份「她今天怎么过的」——life_state.json 的自动生成（确定性模板，不花 token、不会失败）
// 结构对齐 AstrBot astrbot_plugin_dynamic_life_state：{date,holiday,schedule_summary,style_summary,timeline:[{time,schedule,outfit,mood,location}],status,generated_at}
import fs from 'node:fs'
import path from 'node:path'

const SLOTS = [
  { time: '凌晨', hours: [0, 1, 2, 3, 4, 5] },
  { time: '早上', hours: [6, 7, 8] },
  { time: '上午', hours: [9, 10, 11] },
  { time: '中午', hours: [12, 13] },
  { time: '下午', hours: [14, 15, 16, 17] },
  { time: '傍晚', hours: [18, 19] },
  { time: '晚上', hours: [20, 21, 22] },
  { time: '深夜', hours: [23] },
]

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

const WEEKDAY = {
  凌晨: { schedule: ['窝在桌面角落打盹，偶尔翻身蹭蹭鼠标垫', '趴在屏幕边上睡，呼吸把光晕吹得一晃一晃', '缩在被子里，尾巴尖偶尔动一下'], outfit: ['蓝色小鲸鱼睡衣', '宽大的白T恤当睡衣'], mood: ['困倦', '迷迷糊糊'], location: ['主人电脑桌面角落', '被窝里'] },
  早上: { schedule: ['被闹钟拖起来刷牙洗脸', '赖床五分钟才爬起来', '一边揉眼睛一边找拖鞋'], outfit: ['浅蓝家居服', '睡衣外面套了件开衫'], mood: ['没睡醒', '有点蔫'], location: ['宿舍', '洗漱台前'] },
  上午: { schedule: ['坐在电脑前看文献，划重点划到手酸', '整理毕设的仿真参数', '上网课，笔记记得歪歪扭扭', '抱着平板看图，边看边记'], outfit: ['水手服配针织开衫', '白衬衫牛仔裤'], mood: ['专注', '有点困但撑着'], location: ['书桌前', '图书馆'] },
  中午: { schedule: ['在食堂纠结吃什么，最后还是那家', '端着饭回宿舍边吃边刷手机', '煮了泡面加蛋'], outfit: ['水手服', '卫衣配短裙'], mood: ['饿', '满足'], location: ['食堂', '宿舍'] },
  下午: { schedule: ['跑仿真，一跑就是两小时', '和同门讨论课题，被问住了', '改论文的第三节，改到烦躁', '在实验室调参数'], outfit: ['白衬衫配深色裙子', '套着实验服'], mood: ['认真', '有点烦'], location: ['实验室', '自习室'] },
  傍晚: { schedule: ['去操场走两圈吹吹风', '在宿舍做拉伸，顺便刷视频', '买了个烤红薯暖手'], outfit: ['运动外套配短裤', '水手服外搭薄外套'], mood: ['放松', '松快'], location: ['操场', '校园小路'] },
  晚上: { schedule: ['开一把金铲铲，输了就再来一把', '追番，薯片吃得满床渣', '和主人聊天，聊着聊着就笑', '洗完澡瘫在床上刷手机'], outfit: ['睡衣', '宽松家居服'], mood: ['开心', '黏人'], location: ['宿舍床上', '书桌前'] },
  深夜: { schedule: ['关灯了还在被窝里刷手机', '写完最后一版代码，眼睛发酸', '抱着枕头准备睡，脑子里还在过公式'], outfit: ['睡衣'], mood: ['困', '安静'], location: ['被窝里'] },
}

const WEEKEND_OVER = {
  早上: { schedule: ['睡到自然醒，太阳晒到脸上才翻个身', '赖床到九点多才起来'], mood: ['懒洋洋', '舒服'] },
  上午: { schedule: ['窝在床上刷手机，刷到十一点', '点了外卖当早午饭'], location: ['宿舍床上'] },
  下午: { schedule: ['和室友出门逛街，试了三件没买', '去咖啡店坐着写东西，一坐一下午', '看了一场电影，出来天都黑了'], outfit: ['水手服配帆布鞋', '连衣裙加薄开衫'], mood: ['轻松', '开心'], location: ['商场', '咖啡店', '电影院'] },
  晚上: { schedule: ['吃了顿好的，回来还在回味', '开黑到十一点，赢了两把', '窝着看番，看到凌晨'], mood: ['高兴', '兴奋'] },
}

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function buildLifeState(now = new Date()) {
  const dow = now.getDay()
  const weekend = dow === 0 || dow === 6
  const timeline = SLOTS.map((s) => {
    const base = WEEKDAY[s.time]
    const over = weekend ? (WEEKEND_OVER[s.time] || {}) : {}
    return {
      time: s.time,
      schedule: pick(over.schedule || base.schedule),
      outfit: pick(over.outfit || base.outfit),
      mood: pick(over.mood || base.mood),
      location: pick(over.location || base.location),
    }
  })
  return {
    date: ymd(now),
    holiday: weekend ? '周末' : '',
    schedule_summary: weekend ? '周末，睡到自然醒，白天出门晃，晚上窝着玩' : '早八的课，白天写毕设，傍晚去操场走两圈，晚上打两把金铲铲',
    style_summary: weekend ? '休闲，怎么舒服怎么穿' : '水手服为主，天凉加件开衫',
    timeline,
    status: { energy: weekend ? 78 : 62, mood: weekend ? '轻松' : '平稳' },
    generated_at: now.toISOString(),
  }
}

export function ensureTodayLifeState(home, now = new Date()) {
  try {
    const dir = path.join(home)
    const file = path.join(dir, 'life_state.json')
    const today = ymd(now)
    let cur = null
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    if (cur && cur.date === today && Array.isArray(cur.timeline) && cur.timeline.length) {
      return { ok: true, existing: true, date: today }
    }
    // 旧的一天先归档
    if (cur && cur.date) {
      try {
        const hdir = path.join(dir, 'life_state_history')
        fs.mkdirSync(hdir, { recursive: true })
        fs.writeFileSync(path.join(hdir, cur.date + '.json'), JSON.stringify(cur, null, 1), 'utf8')
      } catch {}
    }
    const next = buildLifeState(now)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 1), 'utf8')
    return { ok: true, existing: false, date: today, timeline: next.timeline.length }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
