import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- настройки ----------
const OWNER_ID = String(process.env.OWNER_ID || '').trim();            // Telegram ID владельца (главный админ)
const MINIAPP_LINK = String(process.env.MINIAPP_LINK || '').trim().replace(/\/+$/, ''); // https://t.me/bot  или  https://t.me/bot/app
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEFAULT_AMOUNT = 50;
const MIN_AMOUNT = 1;
const MAX_AMOUNT = 10000;      // лимит Telegram на один счёт в Stars
const MIN_WITHDRAW = 50;
const REF_PERCENT = 50;
const REWARDS = {
  bear_cps: '🧸 Мишка — за 10+ кликов в секунду',
  bear_lvl8: '🧸 Мишка — за 8 уровень',
  rose_lvl15: '🌹 Роза (25 ⭐) — за 15 уровень'
};

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// ---------- хранилище (JSON-файл) ----------
const DB_FILE = path.join(DATA_DIR, 'db.json');
const db = { users: {}, links: {}, admins: [], withdrawals: [], states: {}, paid: {}, nextWithdrawal: 1 };
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

const isOwner = id => !!OWNER_ID && String(id) === OWNER_ID;
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

// ---------- пользователи ----------
function touchUser(tgUser, startParam) {
  const id = String(tgUser.id);
  let u = db.users[id];
  const isNew = !u;
  if (isNew) u = db.users[id] = { id, amount: null, linkCode: null, balance: 0, referrer: null, rewards: {}, totalPaid: 0, created: Date.now() };
  u.name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');
  u.username = tgUser.username || '';

  if (startParam) {
    if (/^L[a-f0-9]{10}$/.test(startParam) && db.links[startParam]) {
      const link = db.links[startParam];
      if (u.linkCode !== startParam) { link.uses = (link.uses || 0) + 1; }
      u.amount = link.amount;
      u.linkCode = startParam;
    } else {
      const m = /^ref_(\d{1,15})$/.exec(startParam);
      if (m && isNew && m[1] !== id && db.users[m[1]]) u.referrer = m[1];
    }
  }
  save();
  return u;
}
const userAmount = u => (Number.isInteger(u.amount) && u.amount >= MIN_AMOUNT && u.amount <= MAX_AMOUNT ? u.amount : DEFAULT_AMOUNT);

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
    refLink: MINIAPP_LINK || null,
    minWithdraw: MIN_WITHDRAW,
    refPercent: REF_PERCENT
  });
});

app.post('/api/claim-reward', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const key = req.body?.reward;
  if (typeof key !== 'string' || !Object.hasOwn(REWARDS, key)) return res.status(400).json({ error: 'Unknown reward' });
  if (u.rewards[key]) return res.json({ ok: true, already: true });
  u.rewards[key] = { at: Date.now(), delivered: false };
  save();
  if (OWNER_ID) {
    await send(OWNER_ID, `🎁 Новая награда к выдаче\n${REWARDS[key]}\nИгрок: ${label(u)}`,
      kb([[{ text: '✅ Выдано', callback_data: `rw:${u.id}:${key}` }]]));
  }
  res.json({ ok: true });
});

app.post('/api/withdraw', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const amount = Number(req.body?.amount);
  if (!Number.isInteger(amount) || amount < MIN_WITHDRAW) return res.status(400).json({ error: `Минимум для вывода — ${MIN_WITHDRAW} ⭐` });
  if (amount > u.balance) return res.status(400).json({ error: 'Недостаточно звёзд на балансе' });
  if (!OWNER_ID) return res.status(500).json({ error: 'OWNER_ID не настроен на сервере' });
  u.balance -= amount;
  const w = { id: db.nextWithdrawal++, user: u.id, amount, status: 'pending', created: Date.now() };
  db.withdrawals.push(w);
  save();
  await send(OWNER_ID, `💸 Заявка на вывод #${w.id}\n${amount} ⭐\nИгрок: ${label(u)}`,
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

// ---------- бот: /admin ----------
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
const linkUrl = code => MINIAPP_LINK ? `${MINIAPP_LINK}?startapp=${code}` : `(задайте MINIAPP_LINK в Render) startapp=${code}`;

async function handleMessage(msg) {
  if (msg.chat?.type !== 'private' || !msg.from) return;
  const uid = String(msg.from.id), chat = msg.chat.id, text = (msg.text || '').trim();

  if (/^\/admin(@\w+)?$/i.test(text)) {
    if (!isAdmin(uid)) return send(chat, '⛔ Нет доступа.');
    delete db.states[uid]; save();
    return showPanel(chat, uid);
  }
  const st = db.states[uid];
  if (!st || !isAdmin(uid) || !text) return;
  if (text.startsWith('/')) { delete db.states[uid]; save(); return send(chat, 'Отменено.', kb([backRow])); }

  if (st.type === 'amount') {
    const n = /^\d{1,6}$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(n) || n < MIN_AMOUNT || n > MAX_AMOUNT) return send(chat, `Введите целое число от ${MIN_AMOUNT} до ${MAX_AMOUNT}.`);
    const code = 'L' + crypto.randomBytes(5).toString('hex');
    db.links[code] = { amount: n, by: uid, created: Date.now(), uses: 0 };
    delete db.states[uid]; save();
    return send(chat, `✅ Ссылка на счёт ${n} ⭐:\n\n${linkUrl(code)}\n\nПока игрок не перейдёт по другой такой ссылке, счёт у него всегда будет ${n} ⭐.`,
      kb([[{ text: '➕ Ещё ссылку', callback_data: 'a:new' }], backRow]));
  }
  if (st.type === 'addadmin' && isOwner(uid)) {
    if (!/^\d{3,15}$/.test(text)) return send(chat, 'Пришлите числовой Telegram ID (узнать можно у @userinfobot).');
    if (text === OWNER_ID || db.admins.includes(text)) return send(chat, 'Он уже админ.', kb([backRow]));
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
      const text = list.map(([code, l]) => `${l.amount} ⭐ · открытий: ${l.uses || 0}${owner ? ` · автор ${l.by}` : ''}\n${linkUrl(code)}`).join('\n\n');
      const rows = list.map(([code, l]) => [{ text: `🗑 ${l.amount} ⭐ · ${code.slice(1, 5)}…`, callback_data: `a:dl:${code}` }]);
      return send(chat, `📋 Последние ссылки:\n\n${text}`, kb([...rows, backRow]));
    }
    if (b === 'dl') {
      const l = db.links[c];
      if (l && (owner || l.by === uid)) { delete db.links[c]; save(); return send(chat, '🗑 Ссылка удалена (у игроков, уже открывших её, сумма сохранится).', kb([backRow])); }
      return;
    }
    if (!owner) return;
    if (b === 'admins') {
      const rows = db.admins.map(id => [{ text: `🗑 Убрать ${id}`, callback_data: `a:rm:${id}` }]);
      rows.push([{ text: '➕ Добавить админа', callback_data: 'a:addadmin' }], backRow);
      return send(chat, `👥 Админы: ${db.admins.length ? db.admins.join(', ') : 'пока нет'}\n(владелец ${OWNER_ID} — всегда админ)`, kb(rows));
    }
    if (b === 'addadmin') { db.states[uid] = { type: 'addadmin' }; save(); return send(chat, 'Пришлите числовой Telegram ID нового админа (узнать: @userinfobot).\n/admin — отмена.'); }
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
  if (a === 'rw') {            // rw:<userId>:<reward>
    const u = db.users[b];
    if (u?.rewards?.[c]) { u.rewards[c].delivered = true; save(); }
    return finish('✅ Выдано');
  }
}

app.post('/api/telegram-webhook', async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const token = process.env.BOT_TOKEN;
  const received = req.get('x-telegram-bot-api-secret-token') || '';
  if (!secret || !token || received.length !== secret.length ||
      !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(secret))) {
    return res.status(401).send('Unauthorized');
  }

  const update = req.body || {};
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
      if (db.paid[chargeId]) return res.status(200).send('OK');   // защита от повторной доставки
      db.paid[chargeId] = 1;
      console.log('Successful Telegram Stars payment:', JSON.stringify({
        telegram_payment_charge_id: chargeId, invoice_payload: payment.invoice_payload,
        total_amount: payment.total_amount, currency: payment.currency, user_id: from.id, date: update.message.date
      }));
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

// Раздаём только index.html (не всю папку — иначе станет доступна база данных).
app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Render web service listening on port ${PORT}`);
  if (!OWNER_ID) console.warn('OWNER_ID не задан: /admin и уведомления о наградах/выводах не будут работать.');
});
