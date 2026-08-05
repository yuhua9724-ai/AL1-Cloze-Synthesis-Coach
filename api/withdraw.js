// ══════════════════════════════════════════════════════════════
// 提现（学生 / 家长自己用）
//
// 关键：可提现金额由服务器自己数流水算出来，不接受浏览器送来的数字。
// 这是整个系统里唯一直接通到钱的地方。
// ══════════════════════════════════════════════════════════════

import { db, requireUser, MIN_WITHDRAWAL, ok, fail, envReady } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  if (!envReady()) return fail(res, 500, 'Server is not configured yet.');

  const user = await requireUser(req);
  if (!user) return fail(res, 401, 'Please sign in again.');

  const { action } = req.body || {};

  try {
    if (action === 'summary') return await summary(res, user.id);
    if (action === 'request') return await request(req, res, user.id);
    return fail(res, 400, 'Unknown action: ' + action);
  } catch (e) {
    console.error('withdraw failed:', action, e.message);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
}

// ── 数一遍流水，算出各项余额 ──────────────────────────────────
async function computeState(userId) {
  const ledger = (await db(`credit_ledger?user_id=eq.${userId}&select=*&order=earned_at.asc`)) || [];
  const now = Date.now();

  let available = 0, locked = 0, reserved = 0, withdrawn = 0, refunded = 0;

  for (const e of ledger) {
    const amt = e.amount || 0;
    if (amt < 0) { refunded += Math.abs(amt); continue; }       // 退款纪录，只显示不计入余额
    if (e.status === 'withdrawn') { withdrawn += amt; continue; } // 已经付出去了
    if (e.status === 'reserved')  { reserved  += amt; continue; } // 申请处理中，锁住
    if (new Date(e.unlock_at).getTime() <= now) available += amt; // 已过解锁期
    else locked += amt;                                           // 还在锁定期
  }

  return {
    ledger,
    available: Math.max(0, available),
    locked, reserved, withdrawn, refunded,
    earned: withdrawn + Math.max(0, available),
  };
}

async function summary(res, userId) {
  const st = await computeState(userId);
  return ok(res, {
    available: st.available,
    locked: st.locked,
    reserved: st.reserved,
    withdrawn: st.withdrawn,
    refunded: st.refunded,
    earned: st.earned,
    min_withdrawal: MIN_WITHDRAWAL,
  });
}

// ── 提交提现申请 ──────────────────────────────────────────────
async function request(req, res, userId) {
  const { amount, paynow_id, paynow_name, remarks } = req.body || {};

  const amt = parseInt(amount, 10);
  const pid = String(paynow_id || '').trim();
  const pnm = String(paynow_name || '').trim();

  if (!pid || !pnm) return fail(res, 400, 'PayNow ID and PayNow name are required.');
  if (isNaN(amt) || amt < MIN_WITHDRAWAL) {
    return fail(res, 400, `Minimum withdrawal is ${MIN_WITHDRAWAL} credits.`);
  }

  // 重点：以服务器算出来的余额为准，浏览器送什么数字都不算
  const st = await computeState(userId);
  if (amt > st.available) {
    return fail(res, 400, `You only have ${st.available} unlocked credits.`);
  }

  // 同一时间只能有一笔待处理的申请，避免重复送单
  const pending = await db(`withdrawal_requests?user_id=eq.${userId}&status=eq.pending&select=id`);
  if (pending && pending.length) {
    return fail(res, 409, 'You already have a request being processed. Please wait for it to be completed.');
  }

  const profiles = await db(`profiles?id=eq.${userId}&select=display,phone`);
  const me = (profiles && profiles[0]) || {};

  const created = await db('withdrawal_requests', {
    method: 'POST', prefer: 'return=representation',
    body: {
      user_id: userId,
      display_name: me.display || null,
      phone: me.phone || null,
      amount: amt,
      paynow_id: pid,
      paynow_name: pnm,
      remarks: String(remarks || '').trim() || null,
      status: 'pending',
    },
  });
  if (!created || !created.length) return fail(res, 500, 'Could not submit the request.');
  const wid = created[0].id;

  // ── 把对应额度锁起来，先到期的先用 ───────────────────────
  const unlocked = st.ledger
    .filter((e) => e.status === 'earned' && (e.amount || 0) > 0 && new Date(e.unlock_at).getTime() <= Date.now())
    .sort((a, b) => new Date(a.unlock_at) - new Date(b.unlock_at));

  let need = amt;
  for (const lot of unlocked) {
    if (need <= 0) break;
    if (lot.amount <= need) {
      await db(`credit_ledger?id=eq.${lot.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'reserved', withdrawal_id: wid },
      });
      need -= lot.amount;
    } else {
      // 这一笔比需要的多 → 拆成两笔，只锁住需要的部分
      await db(`credit_ledger?id=eq.${lot.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { amount: lot.amount - need },
      });
      await db('credit_ledger', {
        method: 'POST', prefer: 'return=minimal',
        body: {
          user_id: lot.user_id,
          amount: need,
          source: lot.source,
          referee: lot.referee,
          referee_list: lot.referee_list,
          plan: lot.plan,
          earned_at: lot.earned_at,
          unlock_at: lot.unlock_at,
          status: 'reserved',
          withdrawal_id: wid,
          note: 'split from lot ' + lot.id,
        },
      });
      need = 0;
    }
  }

  return ok(res, {
    message: `Request submitted — S$${amt} will reach your PayNow within 7 working days.`,
    id: wid,
  });
}
