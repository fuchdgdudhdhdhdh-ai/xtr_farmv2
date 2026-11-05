import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- настройки ----------
const OWNER_ID = String(process.env.OWNER_ID || '').trim();
const WEBHOOK_URL = String(process.env.WEBHOOK_URL || '').trim();
const MINIAPP_LINK = String(process.env.MINIAPP_LINK || '').trim().replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEFAULT_AMOUNT = 50;
const MIN_AMOUNT = 1;
const MAX_AMOUNT = 10000;
const MIN_WITHDRAW = 50;
const REF_PERCENT = 50;
const MIN_LEVEL_FOR_INVOICE = 3;

const REWARDS = {
  bear_cps: '🧸 Мишка (15 ⭐) — за 10+ кликов в секунду',
  bear_lvl8: '🧸 Мишка (15 ⭐) — за 8 уровень',
  rose_lvl15: '🌹 Роза (25 ⭐) — за 15 уровень'
};

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// ---------- хранилище ----------
const DB_FILE = path.join(DATA_DIR, 'db.json');
const db = { users: {}, links: {}, admins: [], withdrawals: [], states: {}, paid: {}, nextWithdrawal: 1, ownerId: '' };
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('DATA_DIR error:', e.message); }
try { Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch { /* новая база */ }

let saveTimer = null;
function writeDb() {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('DB save failed:', e.message); }
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeDb(); }, 300);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { writeDb(); process.exit(0); });

// ---------- Telegram helpers ----------
async function tg(method, body) {
  const token = process.env.BOT_TOKEN;
  if (!token) { console.error(`Telegram ${method}: BOT_TOKEN не задан`); return { ok: false }; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!data.ok) console.error(`Telegram ${method} error:`, data.description);
    return data;
  } catch (e) {
    console.error(`Telegram ${method} failed:`, e.message);
    return { ok: false };
  }
}
const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, disable_web_page_preview: true, ...extra });
const kb = rows => ({ reply_markup: { inline_keyboard: rows } });

function ownerId() { return OWNER_ID || String(db.ownerId || ''); }
const isOwner = id => ownerId() !== '' && String(id) === ownerId();
const isAdmin = id => isOwner(id) || db.admins.includes(String(id));

function label(u) {
  return `${u.name || 'без имени'}${u.username ? ' @' + u.username : ''} (id ${u.id})`;
}

function verifyTelegramInitData(initData, botToken) {
  if (typeof initData !== 'string' || !initData || initData.length > 10000) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  const supplied = Buffer.from(hash, 'hex');
  if (supplied.length !== calculated.length || !crypto.timingSafeEqual(supplied, calculated)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { return null; }
  if (!user?.id) return null;
  return { user, startParam: params.get('start_param') || '' };
}

// ---------- коды ----------
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomCode(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
function newLinkCode() {
  let c;
  do { c = randomCode(12); } while (db.links[c]);
  return c;
}
function refCodeFor(u) {
  if (u.refCode) return u.refCode;
  let c;
  do { c = randomCode(10); } while (Object.values(db.users).some(x => x.refCode === c));
  u.refCode = c;
  save();
  return c;
}
function findUserByRefCode(code) {
  return Object.values(db.users).find(x => x.refCode === code) || null;
}

// ---------- пользователи ----------
function touchUser(tgUser, startParam) {
  const id = String(tgUser.id);
  let u = db.users[id];
  const isNew = !u;
  if (isNew) u = db.users[id] = { id, amount: null, linkCode: null, refCode: null, balance: 0, referrer: null, rewards: {}, totalPaid: 0, created: Date.now() };
  u.name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');
  u.username = tgUser.username || '';
  refCodeFor(u);

  if (startParam) {
    if (db.links[startParam]) {                       // ссылка админа: любой код из базы
      const link = db.links[startParam];
      if (u.linkCode !== startParam) link.uses = (link.uses || 0) + 1;
      u.amount = link.amount;
      u.linkCode = startParam;
    } else if (/^ref_[a-z0-9]{6,16}$/.test(startParam)) {
      const code = startParam.slice(4);
      const ref = findUserByRefCode(code) || db.users[code] || null;  // поддерживаем старые ref_<id>
      if (ref && ref.id !== id && isNew && !u.referrer) u.referrer = ref.id;
    }
  }
  save();
  return u;
}
const userAmount = u => (Number.isInteger(u.amount) && u.amount >= MIN_AMOUNT && u.amount <= MAX_AMOUNT ? u.amount : DEFAULT_AMOUNT);
const withParam = (base, param) => (base.includes('?') ? `${base}&${param}` : `${base}?${param}`);
const linkUrl = code => (MINIAPP_LINK ? withParam(MINIAPP_LINK, `startapp=${code}`) : `(задайте MINIAPP_LINK) startapp=${code}`);
const refUrl = u => (MINIAPP_LINK ? withParam(MINIAPP_LINK, `startapp=ref_${refCodeFor(u)}`) : null);

function auth(req, res) {
  res.set('Cache-Control', 'no-store');
  const token = process.env.BOT_TOKEN;
  if (!token) { res.status(500).json({ error: 'Server is not configured: BOT_TOKEN is missing' }); return null; }
  const v = verifyTelegramInitData(req.body?.initData, token);
  if (!v) { res.status(401).json({ error: 'Invalid Telegram initData. Open the game inside Telegram.' }); return null; }
  return touchUser(v.user, v.startParam);
}

// ---------- API ----------
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.post('/api/me', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json({
    amount: userAmount(u),
    balance: u.balance,
    rewards: Object.fromEntries(Object.keys(u.rewards).map(k => [k, true])),
    refLink: refUrl(u),
    minWithdraw: MIN_WITHDRAW,
    refPercent: REF_PERCENT,
    minLevelForInvoice: MIN_LEVEL_FOR_INVOICE
  });
});

app.post('/api/claim-reward', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const key = req.body?.reward;
  if (typeof key !== 'string' || !Object.hasOwn(REWARDS, key)) return res.status(400).json({ error: 'Unknown reward' });
  if (u.rewards[key]) return res.json({ ok: true, already: true });
  u.rewards[key] = { at: Date.now(), delivered: false };
  save();
  const owner = ownerId();
  if (owner) {
    await send(owner, `🎁 Новая награда к выдаче\n${REWARDS[key]}\nИгрок: ${label(u)}`,
      kb([[{ text: '✅ Выдано', callback_data: `rw:${u.id}:${key}` }]]));
  }
  res.json({ ok: true });
});

app.post('/api/withdraw', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const amount = Number(req.body?.amount);
  if (!Number.isInteger(amount) || amount < MIN_WITHDRAW) return res.status(400).json({ error: `Минимум для вывода — ${MIN_WITHDRAW} ⭐` });
  if (amount > u.balance) return res.status(400).json({ error: 'Недостаточно звёзд на балансе' });
  const owner = ownerId();
  if (!owner) return res.status(500).json({ error: 'Владелец не настроен на сервере' });
  u.balance -= amount;
  const w = { id: db.nextWithdrawal++, user: u.id, amount, status: 'pending', created: Date.now() };
  db.withdrawals.push(w);
  save();
  await send(owner, `💸 Заявка на вывод #${w.id}\n${amount} ⭐\nИгрок: ${label(u)}`,
    kb([[{ text: '✅ Выплачено', callback_data: `wd:ok:${w.id}` }, { text: '❌ Отклонить', callback_data: `wd:no:${w.id}` }]]));
  res.json({ ok: true, balance: u.balance, id: w.id });
});

app.post('/api/create-invoice', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (req.body?.product !== 'super_hit') return res.status(400).json({ error: 'Unknown product' });
  const amount = userAmount(u);
  try {
    const payload = `super_hit:${u.id}:${amount}:${crypto.randomUUID()}`;
    const data = await tg('createInvoiceLink', {
      title: 'Супер-удар',
      description: 'Покупка супер-удара в игре «Раздай звёзды!»',
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Супер-удар', amount }]
    });
    if (!data.ok || typeof data.result !== 'string') return res.status(502).json({ error: 'Telegram could not create invoice' });
    return res.status(200).json({ invoiceUrl: data.result });
  } catch (error) {
    console.error('Invoice creation failed:', error);
    return res.status(502).json({ error: 'Could not create invoice' });
  }
});

// ---------- бот ----------
function parsePayload(p, fromId, total) {
  if (typeof p !== 'string') return false;
  const [kind, uid, amt] = p.split(':');
  return kind === 'super_hit' && uid === String(fromId) && Number(amt) === total && total >= MIN_AMOUNT && total <= MAX_AMOUNT;
}

function panel(uid) {
  const rows = [
    [{ text: '➕ Создать ссылку', callback_data: 'a:new' }],
    [{ text: '📋 Ссылки', callback_data: 'a:links' }]
  ];
  if (isOwner(uid)) rows.push([{ text: '👥 Админы', callback_data: 'a:admins' }], [{ text: '💸 Заявки на вывод', callback_data: 'a:wd' }]);
  return kb(rows);
}
const showPanel = (chat, uid) => send(chat, '🛠 Админ-панель', panel(uid));
const backRow = [{ text: '⬅️ Меню', callback_data: 'a:menu' }];

async function handleMessage(msg) {
  if (!msg.from || msg.from.is_bot) return;
  const uid = String(msg.from.id), chat = msg.chat.id;
  const text = (msg.text || '').trim().replace(/@\w+$/, '');
  if (!text) return;

  // бутстрап: первый /admin при пустом OWNER_ID становится владельцем
  if (/^\/admin$/i.test(text) && !ownerId()) {
    db.ownerId = uid; save();
    await send(chat, `👑 Вы назначены владельцем (id ${uid}). Сохраните это в OWNER_ID на Render.`);
  }

  if (/^\/(start|admin)$/i.test(text)) {
    if (!isAdmin(uid)) {
      return send(chat, `⛔ Нет доступа.\nВаш ID: ${uid}\nПришлите его владельцу, чтобы он добавил вас в админы.`);
    }
    delete db.states[uid]; save();
    if (/^\/start$/i.test(text)) {
      await send(chat, 'Нажми кнопку ниже, чтобы открыть игру 👇',
        { reply_markup: { inline_keyboard: [[{ text: '🎮 Открыть игру', web_app: MINIAPP_LINK ? { url: MINIAPP_LINK } : undefined }]] } });
    }
    return showPanel(chat, uid);
  }

  if (/^\/id$/i.test(text)) return send(chat, `Ваш Telegram ID: ${uid}`);

  const st = db.states[uid];
  if (!st || !isAdmin(uid)) return;
  if (text.startsWith('/')) { delete db.states[uid]; save(); return send(chat, 'Отменено.', kb([backRow])); }

  if (st.type === 'amount') {
    const n = /^\d{1,6}$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(n) || n < MIN_AMOUNT || n > MAX_AMOUNT) return send(chat, `Введите целое число от ${MIN_AMOUNT} до ${MAX_AMOUNT}.`);
    const code = newLinkCode();
    db.links[code] = { amount: n, by: uid, created: Date.now(), uses: 0 };
    delete db.states[uid]; save();
    return send(chat, `✅ Ссылка на счёт ${n} ⭐:\n\n${linkUrl(code)}\n\nПока игрок не перейдёт по другой такой ссылке, счёт у него всегда будет ${n} ⭐.`,
      kb([[{ text: '➕ Ещё ссылку', callback_data: 'a:new' }], backRow]));
  }
  if (st.type === 'addadmin' && isOwner(uid)) {
    if (!/^\d{3,15}$/.test(text)) return send(chat, 'Пришлите числовой Telegram ID (узнать можно у @userinfobot или командой /id).');
    if (text === ownerId() || db.admins.includes(text)) return send(chat, 'Он уже админ.', kb([backRow]));
    db.admins.push(text); delete db.states[uid]; save();
    return send(chat, `✅ Админ ${text} добавлен. Он может создавать ссылки через /admin.`, kb([[{ text: '👥 Админы', callback_data: 'a:admins' }], backRow]));
  }
}

async function handleCallback(cb) {
  const uid = String(cb.from.id), chat = cb.message?.chat?.id, mid = cb.message?.message_id;
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  if (!chat || !isAdmin(uid)) return;
  const [a, b, c] = String(cb.data || '').split(':');
  const owner = isOwner(uid);

  if (a === 'a') {
    if (b === 'menu') { delete db.states[uid]; save(); return showPanel(chat, uid); }
    if (b === 'new') { db.states[uid] = { type: 'amount' }; save(); return send(chat, `Введите сумму счёта в Stars (${MIN_AMOUNT}–${MAX_AMOUNT}), например 500.\n/admin — отмена.`); }
    if (b === 'links') {
      const list = Object.entries(db.links).filter(([, l]) => owner || l.by === uid).sort((x, y) => y[1].created - x[1].created).slice(0, 15);
      if (!list.length) return send(chat, 'Ссылок пока нет.', kb([backRow]));
      const body = list.map(([code, l]) => `${l.amount} ⭐ · открытий: ${l.uses || 0}${owner ? ` · автор ${l.by}` : ''}\n${linkUrl(code)}`).join('\n\n');
      const rows = list.map(([code, l]) => [{ text: `🗑 ${l.amount} ⭐ · ${code.slice(0, 5)}…`, callback_data: `a:dl:${code}` }]);
      return send(chat, `📋 Последние ссылки:\n\n${body}`, kb([...rows, backRow]));
    }
    if (b === 'dl') {
      const l = db.links[c];
      if (l && (owner || l.by === uid)) { delete db.links[c]; save(); return send(chat, '🗑 Ссылка удалена (у открывших её сумма сохранится).', kb([backRow])); }
      return;
    }
    if (!owner) return;
    if (b === 'admins') {
      const rows = db.admins.map(id => [{ text: `🗑 Убрать ${id}`, callback_data: `a:rm:${id}` }]);
      rows.push([{ text: '➕ Добавить админа', callback_data: 'a:addadmin' }], backRow);
      return send(chat, `👥 Админы: ${db.admins.length ? db.admins.join(', ') : 'пока нет'}\n(владелец ${ownerId()} — всегда админ)`, kb(rows));
    }
    if (b === 'addadmin') { db.states[uid] = { type: 'addadmin' }; save(); return send(chat, 'Пришлите числовой Telegram ID нового админа (узнать: /id у него или @userinfobot).\n/admin — отмена.'); }
    if (b === 'rm') { db.admins = db.admins.filter(x => x !== c); save(); return send(chat, `Админ ${c} удалён.`, kb([[{ text: '👥 Админы', callback_data: 'a:admins' }], backRow])); }
    if (b === 'wd') {
      const pending = db.withdrawals.filter(w => w.status === 'pending').slice(0, 10);
      if (!pending.length) return send(chat, 'Нет заявок на вывод.', kb([backRow]));
      for (const w of pending) {
        const u = db.users[w.user] || { id: w.user };
        await send(chat, `💸 Заявка #${w.id}\n${w.amount} ⭐\nИгрок: ${label(u)}`,
          kb([[{ text: '✅ Выплачено', callback_data: `wd:ok:${w.id}` }, { text: '❌ Отклонить', callback_data: `wd:no:${w.id}` }]]));
      }
      return;
    }
    return;
  }

  if (!owner) return;
  const finish = text => tg('editMessageText', { chat_id: chat, message_id: mid, text: `${cb.message.text}\n\n${text}`, reply_markup: { inline_keyboard: [] } });

  if (a === 'wd') {
    const w = db.withdrawals.find(x => x.id === Number(c));
    if (!w || w.status !== 'pending') return finish('— уже обработано');
    const u = db.users[w.user];
    if (b === 'ok') {
      w.status = 'paid'; save();
      send(w.user, `✅ Вывод ${w.amount} ⭐ выплачен.`);
      return finish('✅ Выплачено');
    }
    if (b === 'no') {
      w.status = 'rejected'; if (u) u.balance += w.amount; save();
      send(w.user, `❌ Заявка на вывод ${w.amount} ⭐ отклонена, звёзды возвращены на баланс.`);
      return finish('❌ Отклонено, баланс возвращён');
    }
  }
  if (a === 'rw') {
    const u = db.users[b];
    if (u?.rewards?.[c]) { u.rewards[c].delivered = true; save(); }
    return finish('✅ Выдано');
  }
}

app.post('/api/telegram-webhook', async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const received = req.get('x-telegram-bot-api-secret-token') || '';
  if (secret) {
    if (received.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(secret))) {
      console.error('Webhook: неверный secret. Проверьте TELEGRAM_WEBHOOK_SECRET и переустановите вебхук.');
      return res.status(401).send('Unauthorized');
    }
  }

  const update = req.body || {};
  console.log('update:', update.message ? 'message' : update.callback_query ? 'callback_query' : update.pre_checkout_query ? 'pre_checkout_query' : 'other');

  const checkout = update.pre_checkout_query;
  if (checkout) {
    const valid = checkout.currency === 'XTR' && parsePayload(checkout.invoice_payload, checkout.from?.id, checkout.total_amount);
    const result = await tg('answerPreCheckoutQuery', {
      pre_checkout_query_id: checkout.id,
      ok: valid,
      ...(valid ? {} : { error_message: 'Счёт недействителен. Создайте новый счёт.' })
    });
    if (!result.ok) return res.status(502).send('Could not answer pre-checkout query');
    return res.status(200).send('OK');
  }

  try {
    if (update.callback_query) { await handleCallback(update.callback_query); return res.status(200).send('OK'); }

    const payment = update.message?.successful_payment;
    if (payment) {
      const from = update.message.from;
      if (payment.currency !== 'XTR' || !parsePayload(payment.invoice_payload, from?.id, payment.total_amount)) {
        console.error('Unexpected Telegram payment update');
        return res.status(200).send('Ignored unexpected payment');
      }
      const chargeId = payment.telegram_payment_charge_id;
      if (db.paid[chargeId]) return res.status(200).send('OK');
      db.paid[chargeId] = 1;
      const payer = db.users[String(from.id)];
      if (payer) {
        payer.totalPaid = (payer.totalPaid || 0) + payment.total_amount;
        const ref = payer.referrer && db.users[payer.referrer];
        if (ref) {
          const bonus = Math.floor(payment.total_amount * REF_PERCENT / 100);
          if (bonus > 0) {
            ref.balance += bonus;
            send(ref.id, `🎉 Ваш реферал оплатил ${payment.total_amount} ⭐. Вам начислено ${bonus} ⭐.`);
          }
        }
      }
      save();
      return res.status(200).send('OK');
    }

    if (update.message) await handleMessage(update.message);
  } catch (e) {
    console.error('Webhook handling error:', e);
  }
  return res.status(200).send('OK');
});

app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use((req, res) => res.status(404).send('Not found'));

async function registerWebhook() {
  if (!WEBHOOK_URL) { console.warn('WEBHOOK_URL не задан — вебхук нужно ставить вручную.'); return; }
  const r = await tg('setWebhook', {
    url: WEBHOOK_URL,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
    allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
    drop_pending_updates: true
  });
  console.log('setWebhook:', r.ok ? 'OK' : JSON.stringify(r));
  const info = await tg('getWebhookInfo', {});
  console.log('webhook info:', JSON.stringify(info.result || info));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on ${PORT}`);
  if (!OWNER_ID) console.warn('OWNER_ID не задан: первый /admin назначит владельца автоматически.');
  registerWebhook();
});
