/**
 * merge-window.mjs —— 私聊「等她说完了再回」的合并窗口 + 生成期间的消息排队
 *
 * 移植自 AstrBot 的 astrbot_betterchat（betterchat_core.py 的 MergeWindow）。
 * 原插件描述：「私聊时耐心等待用户把话说完再合并成一条输入回复
 * （生成中可被新消息打断）」。DSH 版此前只搬了人设/记忆/表情，
 * 这套合并窗口没搬过来，于是出现两个症状：
 *
 *   1. 用户连续打字，她回第一条，后面几条被 busy 静默丢弃（engine.mjs 里
 *      `if (this.busy.has(key)) return` 没有任何日志）；
 *   2. 用户引用一条消息后紧接着补几句话，引用那条进了 prompt，补的几条没了，
 *      体感就是「她看不到我的消息」。
 *
 * 核心机制（与 BetterChat 一致）：
 *
 *   reserve()  —— 同步登记一条消息，返回 ticket。**内部不能有 await**，
 *                 只有同步登记才能保证 ticket 顺序 == 到达顺序。
 *   waitForQuiet() —— 等到「静默窗口」到期或整轮硬上限；期间新消息进来
 *                 会刷新窗口并让旧等待者重新判断归属。
 *   settle()   —— 原子地判断「我还是不是这一轮的主人」，是则取走合并文本。
 *
 * 归属用 ticket 仲裁：后到的消息成为新主人，先到的等待者拿到 SUPERSEDED
 * 就该静默退出。这样同一轮只会有一个回复者，不会重复回复、不会互相打断。
 */

/** 一轮聊天的合并参数，对应面板「消息合并」分组 */
export const DEFAULT_MERGE_SETTINGS = {
  /** 总开关 */
  enable: true,
  /** 静默窗口基准秒数：从最后一条消息算起，安静这么久就认为说完了 */
  baseQuietSeconds: 2.0,
  /** 静默窗口下限：再短也不低于这个，防止刚发两个字就被抢答 */
  minQuietSeconds: 1.5,
  /** 静默窗口上限：再长也不超过这个 */
  maxQuietSeconds: 4.0,
  /** 整轮硬上限：从第一条算起，最多等这么久（防止一直打字永不回复） */
  totalSeconds: 8.0,
  /** 长度换算：每 N 字把静默窗口 +1 秒（话越多越可能还在组织语言） */
  lengthScaleChars: 60,
  /** 单轮最多合并几条 */
  maxMessages: 8,
  /** 单轮最多合并多少字 */
  maxChars: 4000,
  /** 这些前缀开头的消息不参与合并（指令类要立刻处理） */
  ignorePrefixes: ['/', '!'],
}

/** 结算结果 */
export const ReservationState = {
  /** 我仍是这一轮的主人 —— 放行，用合并后的文本生成回复 */
  OWNER: 'owner',
  /** 更新的消息接管了本轮 —— 静默退出，什么都不做 */
  SUPERSEDED: 'superseded',
  /** 没有可结算的内容（被 prune / 已关闭）—— 交给正常流程 */
  BYPASS: 'bypass',
}

const nowMs = () => Date.now()

/** 可见长度：去掉空白后算，表情/空格不虚增窗口 */
function visibleLength(text) {
  return String(text || '').replace(/\s+/g, '').length
}

/**
 * 静默窗口：话越多，用户越可能还在组织语言，窗口相应延长；
 * 但被 min/max 夹住，避免极端值。
 * @param {string} text 这一轮**累计**的文本（不是单条）
 * @param {object} settings
 */
export function quietSecondsFor(text, settings) {
  const s = settings || DEFAULT_MERGE_SETTINGS
  const base = Number(s.baseQuietSeconds)
  const lo = Number(s.minQuietSeconds)
  const hi = Number(s.maxQuietSeconds)
  const clamp = (v) => Math.min(hi, Math.max(lo, v))
  const scale = Number(s.lengthScaleChars)
  if (!(scale > 0)) return clamp(base)
  const bonus = visibleLength(text) / scale
  return clamp(base + bonus)
}

/** 判断一条消息是否该跳过合并（指令类） */
export function shouldIgnoreForMerge(text, settings) {
  const s = settings || DEFAULT_MERGE_SETTINGS
  const prefixes = Array.isArray(s.ignorePrefixes) ? s.ignorePrefixes : []
  const stripped = String(text || '').replace(/^\s+/, '')
  return prefixes.some((p) => p && stripped.startsWith(p))
}

/** 把多条消息合并成一条输入（保留换行，方便模型看出是分几次说的） */
export function mergeTexts(parts, maxChars = 0) {
  let merged = (parts || []).filter((p) => p && String(p).trim()).join('\n')
  if (maxChars > 0 && merged.length > maxChars) merged = merged.slice(-maxChars)
  return merged
}

/**
 * 一次「登记」的凭据。ticket 单调递增，作为归属仲裁依据。
 */
class Reservation {
  constructor(ticket, receivedAt) {
    this.ticket = ticket
    this.receivedAt = receivedAt
  }
}

/**
 * 私聊合并窗口：登记 → 等待 → 结算。
 *
 * 每个会话（conversation key）同一时刻最多一轮。
 */
export class MergeWindow {
  constructor(options = {}) {
    this.settings = { ...DEFAULT_MERGE_SETTINGS, ...(options.settings || {}) }
    this._turns = new Map() // key -> { created_at, latest_at, parts, count, ownerTicket }
    this._settled = new Map() // key -> 最近一次结算的 ticket
    this._nextTicket = 0
    this._closed = false
    this._log = options.log || null
  }

  configure(settings) {
    this.settings = { ...DEFAULT_MERGE_SETTINGS, ...(settings || {}) }
  }

  close() {
    this._closed = true
    // 唤醒所有等待者，避免孤儿 Promise 和残留定时器
    for (const turn of this._turns.values()) {
      const wake = turn.waiter
      turn.waiter = null
      if (typeof wake === 'function') wake()
    }
    this._turns.clear()
  }

  _prune() {
    if (!this._turns.size) return
    const now = nowMs()
    const horizon = Math.max(Number(this.settings.totalSeconds) * 4, 60) * 1000
    for (const [key, turn] of [...this._turns]) {
      if (now - turn.latestAt > horizon) {
        this._turns.delete(key)
        this._settled.delete(key)
      }
    }
  }

  /**
   * 同步登记一条消息，返回它在本轮中的位置。
   * 关键：**这里不能有 await**，否则并发进事件时 ticket 顺序会乱。
   * @param {string} key 会话标识
   */
  reserve(key) {
    this._prune()
    this._nextTicket += 1
    const now = nowMs()
    const reservation = new Reservation(this._nextTicket, now)

    let turn = this._turns.get(key)
    if (!turn) {
      turn = { createdAt: now, latestAt: now, parts: [], count: 0, ownerTicket: 0, waiter: null }
      this._turns.set(key, turn)
    }
    turn.ownerTicket = reservation.ticket
    turn.latestAt = now
    turn.count += 1
    // 唤醒可能在等的旧等待者，让它们重新判断归属
    if (turn.waiter) {
      const w = turn.waiter
      turn.waiter = null
      w()
    }
    return reservation
  }

  /** 往当前轮追加一条文本（同一轮里的第 2、3 条…） */
  append(key, text) {
    const turn = this._turns.get(key)
    if (!turn) return
    turn.parts.push(String(text || ''))
  }

  /** 本轮应当结算的时刻 = min(静默到期, 整轮硬上限) */
  _deadline(turn) {
    const quietMs = quietSecondsFor(mergeTexts(turn.parts), this.settings) * 1000
    const totalMs = Number(this.settings.totalSeconds) * 1000
    return Math.min(turn.latestAt + quietMs, turn.createdAt + totalMs)
  }

  /** 本轮是否已攒爆（条数或字数超限）—— 超过就立刻结算，不再等 */
  _overflowed(turn) {
    const s = this.settings
    if (Number(s.maxMessages) > 0 && turn.count > Number(s.maxMessages)) return true
    if (Number(s.maxChars) > 0 && mergeTexts(turn.parts).length > Number(s.maxChars)) return true
    return false
  }

  /**
   * 等到可以结算为止。
   * @param {string} key
   * @param {Reservation} reservation
   * @param {() => boolean} [isCurrent] 可选外部校验，返回 false 即视为失效
   * @returns {Promise<string>} ReservationState.*
   */
  async waitForQuiet(key, reservation, isCurrent) {
    for (;;) {
      if (this._closed) return ReservationState.BYPASS
      if (typeof isCurrent === 'function' && !isCurrent()) return ReservationState.SUPERSEDED

      const turn = this._turns.get(key)
      if (!turn) {
        // 本轮已被别人结算：我不是主人
        if ((this._settled.get(key) || 0) >= reservation.ticket) return ReservationState.SUPERSEDED
        return ReservationState.BYPASS
      }
      // 被更新的消息超越
      if (turn.ownerTicket !== reservation.ticket) return ReservationState.SUPERSEDED
      if (this._overflowed(turn)) return ReservationState.OWNER

      const timeout = this._deadline(turn) - nowMs()
      if (timeout <= 0) return ReservationState.OWNER

      // 等一个「有新消息进来」的唤醒，或超时。
      // 注意：setTimeout 必须能被 close() 取消，否则插件卸载时
      // 会留一个挂满整个窗口的定时器，close() 看似返回了实则没释放。
      await new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (turn.waiter === wake) turn.waiter = null
          resolve()
        }
        const wake = finish
        const timer = setTimeout(finish, timeout)
        turn.waiter = wake
      })
      // 醒来后回到循环顶部重算窗口与归属
    }
  }

  /**
   * 原子地关闭本轮并取走合并文本。
   * @returns {{text:string, count:number}|null} 不是主人时返回 null
   */
  settle(key, reservation) {
    const turn = this._turns.get(key)
    if (!turn || turn.ownerTicket !== reservation.ticket) return null
    this._turns.delete(key)
    this._settled.set(key, reservation.ticket)
    const text = mergeTexts(turn.parts, Number(this.settings.maxChars) || 0)
    return { text, count: turn.count }
  }

  /** 是否有会话正在等待中（诊断用） */
  isPending(key) {
    return this._turns.has(key)
  }
}

/**
 * 生成期间的消息排队。
 *
 * 解决 engine.mjs 原来的写法：
 *     if (this.busy.has(key)) return      // ← 静默丢消息
 *
 * 改成：busy 时把消息压进 pending 队列，本轮 reply() 结束后
 * 立刻把排队的所有消息合并成一条新输入再跑一轮。
 */
export class PendingQueue {
  constructor(options = {}) {
    this._queues = new Map() // key -> array of entries
    this.maxMessages = Number(options.maxMessages) || 20
    this._log = options.log || null
  }

  /** 压入一条待处理消息；返回当前排队条数 */
  push(key, entry) {
    let q = this._queues.get(key)
    if (!q) {
      q = []
      this._queues.set(key, q)
    }
    q.push(entry)
    // 防御：极端情况下别无限涨
    if (q.length > this.maxMessages) q.splice(0, q.length - this.maxMessages)
    return q.length
  }

  /** 取走并清空某个会话的队列 */
  drain(key) {
    const q = this._queues.get(key)
    if (!q || !q.length) return []
    this._queues.delete(key)
    return q
  }

  size(key) {
    const q = this._queues.get(key)
    return q ? q.length : 0
  }

  clear(key) {
    this._queues.delete(key)
  }
}
