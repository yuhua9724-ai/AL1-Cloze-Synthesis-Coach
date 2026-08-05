// ══════════════════════════════════════════════════════════════
// 注册
// 学生填：电话号码、孩子名字、密码、邀请码
// 服务器决定：身份 = tester、试用 3 天、推荐关系
// 学生的浏览器填不到那几个格子，所以改不了自己的身份和到期日。
// ══════════════════════════════════════════════════════════════

import { db, authAdmin, emailOf, sgToday, addDays, ok, fail, envReady } from './_lib.js';

const PHONE_RE = /^[689]\d{7}$/; // 新加坡手机号：8 位，开头 6/8/9

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  if (!envReady()) return fail(res, 500, 'Server is not configured yet. Please contact your teacher.');

  const { phone, display, password, code } = req.body || {};

  // ── 基本检查 ────────────────────────────────────────────────
  const ph = String(phone || '').trim();
  const nm = String(display || '').trim();
  const pw = String(password || '');
  const cd = String(code || '').trim().toUpperCase();

  if (!PHONE_RE.test(ph)) {
    return fail(res, 400, 'Please enter a valid Singapore mobile number (8 digits, starting with 6, 8 or 9).');
  }
  if (nm.length < 2) return fail(res, 400, "Please enter your child's name.");
  if (pw.length < 4) return fail(res, 400, 'Password must be at least 4 characters.');
  if (cd.length < 4) return fail(res, 400, 'Please enter a referral code.');

  let newUserId = null;

  try {
    // ── 1. 邀请码必须是真的 ──────────────────────────────────
    const referrers = await db(`profiles?referral_code=eq.${encodeURIComponent(cd)}&select=id,display`);
    if (!referrers || !referrers.length) {
      return fail(res, 400, 'Invalid referral code. Please check with your friend and try again.');
    }
    const referrerId = referrers[0].id;

    // ── 2. 这个号码不能已经注册过 ────────────────────────────
    const existing = await db(`profiles?phone=eq.${encodeURIComponent(ph)}&select=id`);
    if (existing && existing.length) {
      return fail(res, 409, 'This number is already registered. Please sign in instead.');
    }

    // ── 3. 建立帐号 ──────────────────────────────────────────
    // 背后拼一个假邮箱，家长完全看不到，登入时输入的还是电话号码。
    const created = await authAdmin('users', {
      method: 'POST',
      body: {
        email: emailOf(ph),
        password: pw,
        email_confirm: true,          // 这个邮箱收不到信，所以直接当成已验证
        user_metadata: { phone: ph, display: nm },
      },
    });
    if (!created || !created.id) throw new Error('Could not create account');
    newUserId = created.id;

    // ── 4. 建立个人资料：身份和到期日由服务器写死 ────────────
    const today = sgToday();
    const profile = await db('profiles', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        id: newUserId,
        phone: ph,
        display: nm,
        role: 'tester',              // 一律试用，学生改不了
        level: 'P6',
        start_date: today,
        expiry: addDays(today, 3),   // 3 天试用，从今天算起
        daily_limit: 5,
        referred_by: referrerId,
        referral_settled: false,
      },
    });
    if (!profile || !profile.length) throw new Error('Could not create profile');

    return ok(res, { message: 'Account created' });
  } catch (e) {
    // 帐号建了但资料没建成 → 把帐号收回，不留半个残缺帐号
    if (newUserId) {
      try { await authAdmin(`users/${newUserId}`, { method: 'DELETE' }); } catch (_) {}
    }
    const msg = String(e.message || '');
    if (msg.toLowerCase().includes('already') || msg.includes('409')) {
      return fail(res, 409, 'This number is already registered. Please sign in instead.');
    }
    console.error('signup failed:', msg);
    return fail(res, 500, 'Something went wrong creating your account. Please try again.');
  }
}
