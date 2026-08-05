// ══════════════════════════════════════════════════════════════
// 后台管理（只有 admin 能用）
//
// 每一次呼叫，服务器都会先问 Supabase「送这个请求的人是谁」，
// 再去资料库确认他的 role 是不是 admin。
// 学生就算照抄这个网址，也会被挡在第一步。
// ══════════════════════════════════════════════════════════════

import {
  db, authAdmin, requireAdmin, generateReferralCode,
  sgToday, addDays, addDaysISO,
  PLAN_DAYS, PLAN_LABELS, REFERRAL_CREDIT, WEEK_BATCH_SIZE,
  ok, fail, envReady,
} from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  if (!envReady()) return fail(res, 500, 'Server is not configured yet.');

  const admin = await requireAdmin(req);
  if (!admin) return fail(res, 403, 'Admin access required.');

  const { action } = req.body || {};

  try {
    switch (action) {
      case 'list_students':    return await listStudents(req, res);
      case 'upgrade':          return await applyPlan(req, res);   // 试用 → 正式
      case 'set_plan':         return await applyPlan(req, res);   // 续费 / 改方案
      case 'edit_student':     return await editStudent(req, res);
      case 'reset_password':   return await resetPassword(req, res);
      case 'delete_student':   return await deleteStudent(req, res);
      case 'list_withdrawals': return await listWithdrawals(req, res);
      case 'mark_paid':        return await markPaid(req, res);
      case 'reject_withdrawal':return await rejectWithdrawal(req, res);
      case 'refund':           return await refundStudent(req, res);
      default:                 return fail(res, 400, 'Unknown action: ' + action);
    }
  } catch (e) {
    console.error('admin action failed:', action, e.message);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
}

// ── 学生名单 ──────────────────────────────────────────────────
async function listStudents(req, res) {
  const rows = await db(
    'profiles?role=in.(tester,student)&select=id,phone,display,role,plan,level,start_date,expiry,upgraded_at,daily_limit,referral_code,referred_by,referral_settled&order=role.asc,phone.asc'
  );
  return ok(res, { students: rows || [] });
}

// ── 升级 / 续费：新时长加在剩余时间上 ─────────────────────────
async function applyPlan(req, res) {
  const { user_id, plan } = req.body || {};
  if (!user_id) return fail(res, 400, 'Missing user_id');
  if (!PLAN_DAYS[plan]) return fail(res, 400, 'Unknown plan: ' + plan);

  const rows = await db(`profiles?id=eq.${user_id}&select=*`);
  if (!rows || !rows.length) return fail(res, 404, 'Account not found.');
  const user = rows[0];

  const today = sgToday();
  // 还没到期就从原到期日往后加，不浪费学生已付的天数
  const stillActive = user.role === 'student' && user.expiry && user.expiry > today;
  const base = stillActive ? user.expiry : today;
  const newExpiry = addDays(base, PLAN_DAYS[plan]);

  const patch = {
    role: 'student',
    plan,
    upgraded_at: new Date().toISOString(),
    expiry: newExpiry,
  };
  if (!user.referral_code) patch.referral_code = await generateReferralCode();
  if (!user.start_date) patch.start_date = today;

  const updated = await db(`profiles?id=eq.${user_id}`, {
    method: 'PATCH', prefer: 'return=representation', body: patch,
  });
  if (!updated || !updated.length) return fail(res, 500, 'Update failed.');

  const award = await awardReferralCredit({ ...user, ...patch });

  let message = `${user.display} → ${PLAN_LABELS[plan]}, expires ${newExpiry}`;
  if (award && award.type === 'full') message += ` · +${REFERRAL_CREDIT} credits to referrer`;
  else if (award && award.type === 'week_batch') message += ` · batch complete, +${REFERRAL_CREDIT} credits to referrer`;
  else if (award && award.type === 'week_pending') message += ` · referrer now at ${award.count}/${WEEK_BATCH_SIZE} week referrals`;

  return ok(res, { message, student: updated[0] });
}

// ── 推荐奖励结算（规则跟 Vocab 一模一样）────────────────────
async function awardReferralCredit(user) {
  const referrerId = user.referred_by;
  if (!referrerId || user.referral_settled) return null;

  const now = new Date().toISOString();

  // 月 / 季 / 半年方案：立刻记一笔，30 天后解锁
  if (user.plan !== 'week') {
    await db('credit_ledger', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        user_id: referrerId,
        amount: REFERRAL_CREDIT,
        source: 'referral',
        referee: user.id,
        plan: user.plan,
        earned_at: now,
        unlock_at: addDaysISO(now, 30),
        status: 'earned',
        seen: false,
      },
    });
    await db(`profiles?id=eq.${user.id}`, {
      method: 'PATCH', prefer: 'return=minimal', body: { referral_settled: true },
    });
    return { type: 'full' };
  }

  // 1 周方案：攒够 4 个才发一笔，7 天后解锁
  const pending = (await db(
    `profiles?referred_by=eq.${referrerId}&role=eq.student&plan=eq.week&referral_settled=is.false&select=id,upgraded_at&order=upgraded_at.asc`
  )) || [];

  if (pending.length < WEEK_BATCH_SIZE) {
    return { type: 'week_pending', count: pending.length };
  }

  const batch = pending.slice(0, WEEK_BATCH_SIZE);
  const last = batch.reduce((a, b) =>
    new Date(a.upgraded_at || 0) > new Date(b.upgraded_at || 0) ? a : b
  );

  await db('credit_ledger', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      user_id: referrerId,
      amount: REFERRAL_CREDIT,
      source: 'week_batch',
      referee_list: batch.map((b) => b.id).join(','),
      plan: 'week',
      earned_at: now,
      unlock_at: addDaysISO(last.upgraded_at || now, 7),
      status: 'earned',
      seen: false,
    },
  });
  for (const b of batch) {
    await db(`profiles?id=eq.${b.id}`, {
      method: 'PATCH', prefer: 'return=minimal', body: { referral_settled: true },
    });
  }
  return { type: 'week_batch' };
}

// ── 修改学生资料 ──────────────────────────────────────────────
async function editStudent(req, res) {
  const { user_id, display, start_date, expiry, daily_limit, level } = req.body || {};
  if (!user_id) return fail(res, 400, 'Missing user_id');

  const patch = {};
  if (display !== undefined)     patch.display = String(display).trim();
  if (start_date !== undefined)  patch.start_date = start_date || null;
  if (expiry !== undefined)      patch.expiry = expiry || null;
  if (level !== undefined)       patch.level = level || 'P6';
  if (daily_limit !== undefined) {
    const n = parseInt(daily_limit, 10);
    if (isNaN(n) || n < 1 || n > 100) return fail(res, 400, 'Daily limit must be between 1 and 100.');
    patch.daily_limit = n;
  }
  if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to update.');

  const updated = await db(`profiles?id=eq.${user_id}`, {
    method: 'PATCH', prefer: 'return=representation', body: patch,
  });
  if (!updated || !updated.length) return fail(res, 404, 'Account not found.');
  return ok(res, { student: updated[0] });
}

// ── 帮学生重设密码（家长忘记密码时用）────────────────────────
async function resetPassword(req, res) {
  const { user_id, password } = req.body || {};
  if (!user_id) return fail(res, 400, 'Missing user_id');
  if (!password || String(password).length < 4) {
    return fail(res, 400, 'Password must be at least 4 characters.');
  }
  await authAdmin(`users/${user_id}`, { method: 'PUT', body: { password: String(password) } });
  return ok(res, { message: 'Password updated.' });
}

// ── 删除帐号 ──────────────────────────────────────────────────
// 删掉帐号后，他的进度、错题、credit 流水会一并消失（外键设了连动删除）
async function deleteStudent(req, res) {
  const { user_id } = req.body || {};
  if (!user_id) return fail(res, 400, 'Missing user_id');
  await authAdmin(`users/${user_id}`, { method: 'DELETE' });
  return ok(res, { message: 'Account removed.' });
}

// ── 提现申请：列表 ────────────────────────────────────────────
async function listWithdrawals(req, res) {
  const rows = await db('withdrawal_requests?select=*&order=created_at.desc&limit=100');
  return ok(res, { withdrawals: rows || [] });
}

// ── 提现申请：标记已付 ────────────────────────────────────────
async function markPaid(req, res) {
  const { id } = req.body || {};
  if (!id) return fail(res, 400, 'Missing id');

  const rows = await db(`withdrawal_requests?id=eq.${id}&select=*`);
  if (!rows || !rows.length) return fail(res, 404, 'Request not found.');
  if (rows[0].status !== 'pending') return fail(res, 400, 'This request has already been processed.');

  await db(`withdrawal_requests?id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { status: 'paid', processed_at: new Date().toISOString() },
  });
  // 被这笔申请锁住的 credit，正式扣掉
  await db(`credit_ledger?withdrawal_id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal', body: { status: 'withdrawn' },
  });
  return ok(res, { message: `Marked paid — S$${rows[0].amount}` });
}

// ── 提现申请：驳回（credit 退回可提现）────────────────────────
async function rejectWithdrawal(req, res) {
  const { id, reason } = req.body || {};
  if (!id) return fail(res, 400, 'Missing id');

  const rows = await db(`withdrawal_requests?id=eq.${id}&select=*`);
  if (!rows || !rows.length) return fail(res, 404, 'Request not found.');
  if (rows[0].status !== 'pending') return fail(res, 400, 'This request has already been processed.');

  await db(`withdrawal_requests?id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      status: 'rejected',
      processed_at: new Date().toISOString(),
      admin_note: String(reason || 'No reason given').slice(0, 30),
    },
  });
  await db(`credit_ledger?withdrawal_id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal', body: { status: 'earned', withdrawal_id: null },
  });
  return ok(res, { message: `Rejected — ${rows[0].amount} credits returned.` });
}

// ── 退款：帐号立即到期，并追回推荐人尚未提领的 credit ─────────
async function refundStudent(req, res) {
  const { user_id } = req.body || {};
  if (!user_id) return fail(res, 400, 'Missing user_id');

  const rows = await db(`profiles?id=eq.${user_id}&select=*`);
  if (!rows || !rows.length) return fail(res, 404, 'Account not found.');
  const user = rows[0];

  // 1. 帐号设为昨天到期 = 立刻失效
  await db(`profiles?id=eq.${user_id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { expiry: addDays(sgToday(), -1), plan: null, referral_settled: false },
  });

  const referrerId = user.referred_by;
  if (!referrerId) return ok(res, { message: 'Refund processed — account expired.' });

  // 2. 1 周方案：整批作废，同批的人退回未结算状态
  const batches = (await db("credit_ledger?source=eq.week_batch&status=eq.earned&select=*")) || [];
  for (const batch of batches) {
    const members = (batch.referee_list || '').split(',').map((s) => s.trim());
    if (!members.includes(user_id)) continue;
    await db(`credit_ledger?id=eq.${batch.id}`, { method: 'DELETE', prefer: 'return=minimal' });
    for (const m of members) {
      if (!m) continue;
      await db(`profiles?id=eq.${m}`, {
        method: 'PATCH', prefer: 'return=minimal', body: { referral_settled: false },
      });
    }
    return ok(res, { message: `Refund processed — ${REFERRAL_CREDIT} credits clawed back, batch reset to ${members.length - 1}/${WEEK_BATCH_SIZE}.` });
  }

  // 3. 其他方案：删掉那笔尚未提领的 credit，并留一条 -15 的可见纪录
  const direct = (await db(
    `credit_ledger?user_id=eq.${referrerId}&referee=eq.${user_id}&source=eq.referral&status=eq.earned&select=id`
  )) || [];
  for (const c of direct) {
    await db(`credit_ledger?id=eq.${c.id}`, { method: 'DELETE', prefer: 'return=minimal' });
  }

  const now = new Date().toISOString();
  await db('credit_ledger', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      user_id: referrerId,
      amount: -REFERRAL_CREDIT,
      source: 'refund',
      referee: user_id,
      earned_at: now,
      unlock_at: now,
      status: 'earned',
      seen: false,
      note: 'Refund: ' + (user.phone || user_id),
    },
  });

  return ok(res, { message: `Refund processed — account expired, ${REFERRAL_CREDIT} credits clawed back.` });
}
