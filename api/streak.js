// ══════════════════════════════════════════════════════════════
// 打卡：补签 · 周徽章结算 · 换头像
//
// 补签和徽章都由服务器判定，学生的浏览器碰不到。
// ══════════════════════════════════════════════════════════════

import { db, requireUser, ok, fail, envReady } from './_lib.js';

const REPAIRS_ALLOWED_FOR_BADGE = 1;   // 补 0–1 次拿得到徽章，补 2 次以上没有
const TIERS = [
  { at: 12, name: 'legend' },
  { at: 8,  name: 'platinum' },
  { at: 6,  name: 'gold' },
  { at: 4,  name: 'silver' },
  { at: 2,  name: 'bronze' },
];
const ALLOWED_AVATARS = ['initial','face-boy-1','face-boy-2','face-boy-3','face-girl-1','face-girl-2','face-girl-3'];

// 新加坡时间的今天
const sgToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

// 那一天所在的那一周的星期一
function weekStartOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay() || 7;              // 星期日算第 7 天
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  if (!envReady()) return fail(res, 500, 'Server is not configured yet.');

  const user = await requireUser(req);
  if (!user) return fail(res, 401, 'Please sign in again.');

  const { action } = req.body || {};
  try {
    if (action === 'repair')      return await repair(req, res, user.id);
    if (action === 'settle_week') return await settleWeek(res, user.id);
    if (action === 'set_avatar')  return await setAvatar(req, res, user.id);
    return fail(res, 400, 'Unknown action: ' + action);
  } catch (e) {
    console.error('streak failed:', action, e.message);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
}

// ── 那一天到底做满了没有 ──────────────────────────────────────
async function dayStatus(userId, dateStr, limit) {
  const rows = (await db(
    `attempts?user_id=eq.${userId}&attempt_date=eq.${dateStr}&select=question_type,source_id`
  )) || [];
  const seen = { cloze: new Set(), synthesis: new Set() };
  rows.forEach((r) => {
    if (seen[r.question_type] && r.source_id != null) seen[r.question_type].add(r.source_id);
  });
  return {
    cloze: seen.cloze.size,
    synthesis: seen.synthesis.size,
    done: seen.cloze.size >= limit && seen.synthesis.size >= limit * 5,
  };
}

// ── 补签：把某一天的叉补回来 ──────────────────────────────────
// 随时可补、不限次数；但一周补超过 1 次，这周的徽章就没了
async function repair(req, res, userId) {
  const { date } = req.body || {};
  const target = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return fail(res, 400, 'Which day would you like to repair?');

  const today = sgToday();
  if (target >= today) return fail(res, 400, 'You can only repair a day that has already passed.');

  const profiles = await db(`profiles?id=eq.${userId}&select=daily_limit`);
  const limit = (profiles && profiles[0] && profiles[0].daily_limit) || 5;

  // 那天本来就做满了，不用补
  const st = await dayStatus(userId, target, limit);
  if (st.done) return fail(res, 400, 'That day is already complete.');

  // 今天必须先做满，才有资格补前一天
  const todaySt = await dayStatus(userId, today, limit);
  if (!todaySt.done) {
    return fail(res, 400, `Finish today's practice first — ${limit} passages and ${limit} sets — then you can repair that day.`);
  }

  const existing = await db(`streak_repairs?user_id=eq.${userId}&repaired_date=eq.${target}&select=id`);
  if (existing && existing.length) return fail(res, 409, 'That day has already been repaired.');

  const ws = weekStartOf(target);
  await db('streak_repairs', {
    method: 'POST', prefer: 'return=minimal',
    body: { user_id: userId, repaired_date: target, week_start: ws },
  });

  const used = (await db(`streak_repairs?user_id=eq.${userId}&week_start=eq.${ws}&select=id`)) || [];
  const message = used.length > REPAIRS_ALLOWED_FOR_BADGE
    ? `${target} is back — but this week's badge is now out of reach.`
    : `${target} is back. You have used ${used.length} repair this week.`;

  await settleWeekFor(userId, ws);
  return ok(res, { message, repairs_used: used.length, badge_possible: used.length <= REPAIRS_ALLOWED_FOR_BADGE });
}

// ── 结算某一周：七天全部完成 + 补签不超过 1 次 → 拿到徽章 ────
async function settleWeekFor(userId, ws) {
  const profiles = await db(`profiles?id=eq.${userId}&select=daily_limit`);
  const limit = (profiles && profiles[0] && profiles[0].daily_limit) || 5;

  const repairs = (await db(`streak_repairs?user_id=eq.${userId}&week_start=eq.${ws}&select=repaired_date`)) || [];
  const repairedSet = new Set(repairs.map((r) => r.repaired_date));

  let daysDone = 0;
  const today = sgToday();
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    if (d > today) break;                       // 未来的日子不算
    if (repairedSet.has(d)) { daysDone++; continue; }
    const st = await dayStatus(userId, d, limit);
    if (st.done) daysDone++;
  }

  const weekOver = addDays(ws, 6) < today;
  const earned = daysDone >= 7 && repairs.length <= REPAIRS_ALLOWED_FOR_BADGE;

  const existing = await db(`weekly_badges?user_id=eq.${userId}&week_start=eq.${ws}&select=id,earned`);
  const body = { days_done: daysDone, repairs_used: repairs.length, earned };
  if (existing && existing.length) {
    await db(`weekly_badges?user_id=eq.${userId}&week_start=eq.${ws}`, {
      method: 'PATCH', prefer: 'return=minimal', body,
    });
  } else {
    await db('weekly_badges', {
      method: 'POST', prefer: 'return=minimal',
      body: Object.assign({ user_id: userId, week_start: ws }, body),
    });
  }

  // 更新历史最佳连胜
  const all = (await db(`weekly_badges?user_id=eq.${userId}&select=week_start,days_done&order=week_start.asc`)) || [];
  let best = 0;
  all.forEach((w) => { if (w.days_done > best) best = w.days_done; });
  await db(`profiles?id=eq.${userId}`, { method: 'PATCH', prefer: 'return=minimal', body: { best_streak: best } });

  const badgeRows = (await db(`weekly_badges?user_id=eq.${userId}&earned=is.true&select=id`)) || [];
  return { daysDone, repairsUsed: repairs.length, earned, weekOver, badges: badgeRows.length };
}

async function settleWeek(res, userId) {
  const ws = weekStartOf(sgToday());
  const r = await settleWeekFor(userId, ws);
  const tier = TIERS.find((t) => r.badges >= t.at);
  return ok(res, {
    week_start: ws,
    days_done: r.daysDone,
    repairs_used: r.repairsUsed,
    badge_earned: r.earned,
    badge_possible: r.repairsUsed <= REPAIRS_ALLOWED_FOR_BADGE,
    badges: r.badges,
    tier: tier ? tier.name : 'start',
  });
}

// ── 换头像：只能选清单里有的 ──────────────────────────────────
async function setAvatar(req, res, userId) {
  const { avatar } = req.body || {};
  const a = String(avatar || '').trim();
  if (!ALLOWED_AVATARS.includes(a)) return fail(res, 400, 'That avatar is not available.');

  // 拿到第一枚徽章之前只能用首字母
  if (a !== 'initial') {
    const badges = (await db(`weekly_badges?user_id=eq.${userId}&earned=is.true&select=id`)) || [];
    if (badges.length < 2) {
      return fail(res, 403, 'Collect 2 weekly badges to unlock avatars.');
    }
  }
  await db(`profiles?id=eq.${userId}`, { method: 'PATCH', prefer: 'return=minimal', body: { avatar: a } });
  return ok(res, { avatar: a });
}
