// ══════════════════════════════════════════════════════════════
// AL1 Cloze & S&T — 服务端共用工具
// 这个文件不是接口，只是给其他 api 文件调用的工具箱。
// 档名以底线开头 = Vercel 不会把它当成网址对外开放。
// ══════════════════════════════════════════════════════════════

export const SB_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// 假邮箱的网域。学生完全看不到，纯粹是 Supabase 内部需要一个邮箱格式。
export const EMAIL_DOMAIN = 'al1cloze.app';
export const emailOf = (phone) => `${phone}@${EMAIL_DOMAIN}`;

// 付费方案（跟 Vocab 完全一致）
export const PLAN_DAYS = { week: 7, month: 30, quarter: 90, half_year: 180 };
export const PLAN_LABELS = { week: '1 week', month: '1 month', quarter: '3 months', half_year: '6 months' };

export const REFERRAL_CREDIT = 15;   // 每成功推荐一人 15 credit
export const WEEK_BATCH_SIZE = 4;    // 1 周方案：攒够 4 个才发一笔
export const MIN_WITHDRAWAL = 15;    // 提现门槛

// ── 新加坡日期（服务器跑在 UTC，不处理会算错一天）─────────────
export function sgToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function addDaysISO(baseISO, days) {
  const d = new Date(baseISO);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ── 用万能钥匙读写资料库（只在服务器上跑，钥匙永不下发浏览器）──
export async function db(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) {
    if (res.ok) return null;
    throw new Error(`DB ${res.status}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('DB bad response'); }
  if (!res.ok) throw new Error(data.message || data.error || `DB ${res.status}`);
  return data;
}

// ── Supabase 帐号系统的管理接口 ────────────────────────────────
export async function authAdmin(path, opts = {}) {
  const res = await fetch(`${SB_URL}/auth/v1/admin/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && (data.msg || data.message || data.error_description)) || `AUTH ${res.status}`);
  return data;
}

// ── 验明来人身份 ──────────────────────────────────────────────
// 浏览器送来的凭证只代表他自己，服务器拿去问 Supabase「这是谁」。
export async function requireUser(req) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  if (!token) return null;
  const res = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u && u.id ? u : null;
}

// 验明是不是管理员。学生自己说了不算，以资料库里的 role 为准。
export async function requireAdmin(req) {
  const u = await requireUser(req);
  if (!u) return null;
  const rows = await db(`profiles?id=eq.${u.id}&select=id,role`);
  if (!rows || !rows.length || rows[0].role !== 'admin') return null;
  return rows[0];
}

// ── 邀请码 ────────────────────────────────────────────────────
export async function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I O 0 1，避免看错
  const existing = (await db('profiles?select=referral_code')) || [];
  const taken = new Set(existing.map((r) => r.referral_code).filter(Boolean));
  for (let i = 0; i < 50; i++) {
    const code = 'REF-' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    if (!taken.has(code)) return code;
  }
  return 'REF-' + Date.now().toString(36).slice(-4).toUpperCase();
}

// ── 回覆格式 ──────────────────────────────────────────────────
export const ok = (res, data = {}) => res.status(200).json({ ok: true, ...data });
export const fail = (res, code, message) => res.status(code).json({ ok: false, error: message });

// 环境变数没设好时，早点讲清楚，不要让人对着空白页猜
export function envReady() {
  return Boolean(SB_URL && SERVICE_KEY);
}
