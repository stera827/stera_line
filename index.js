// ==== 必須ライブラリ ====
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const dayjs = require('dayjs');

// ==== LINE 設定（Render の環境変数を使う）====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ====== ユーザーごとの入力状態を記録（簡易RAM保存）======
/*
  state[userId] = {
    clockIn: "HH:mm",
    clockOut: "HH:mm",
    hourly: number,
    drink: number,
    dohan: number,
    request: number,
    champagne: number,
    okuri: number
  }
*/
const state = Object.create(null);

// ==== ユーティリティ ====
const toYen = n => `${Math.round(n).toLocaleString()}円`;
const floor10yen = n => Math.floor(n / 10) * 10;

function parseNumber(s) {
  // 先頭にある数値を抜く（カンマ許容）
  const m = (s || '').replace(/[,，]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

function setNum(userId, key, text) {
  const val = parseNumber(text);
  if (Number.isNaN(val)) return `数値が読み取れませんでした。例）「${key} 5000」`;
  state[userId] ||= {};
  state[userId][key] = val;
  return `${labelOf(key)} を ${toYen(val)} に設定しました。`;
}

function labelOf(key) {
  return ({
    hourly: '時給',
    drink: 'ドリンク',
    dohan: '同伴',
    request: 'リクエスト',
    champagne: 'シャンパン',
    okuri: '送り',
    clockIn: '出勤',
    clockOut: '退勤',
  })[key] || key;
}

function setTime(userId, key, text) {
  const m = text.match(/(\d{1,2}):?(\d{2})?/);
  if (!m) return `時刻が読み取れませんでした。例）「${labelOf(key)} 18:30」`;
  const hh = String(m[1]).padStart(2, '0');
  const mm = String(m[2] ?? '00').padStart(2, '0');
  state[userId] ||= {};
  state[userId][key] = `${hh}:${mm}`;
  return `${labelOf(key)} を ${hh}:${mm} に設定しました。`;
}

function calc(userId) {
  const s = state[userId] || {};
  const start = s.clockIn, end = s.clockOut, hourly = Number(s.hourly || 0);

  // 勤務時間（小数時間）
  let hours = 0;
  if (start && end) {
    const today = dayjs().format('YYYY-MM-DD');
    let t1 = dayjs(`${today} ${start}`);
    let t2 = dayjs(`${today} ${end}`);
    if (t2.isBefore(t1)) t2 = t2.add(1, 'day'); // 日跨ぎ対応
    hours = t2.diff(t1, 'minute') / 60;
  }
  const basic = hourly * hours;

  const drink = Number(s.drink || 0);
  const dohan = Number(s.dohan || 0);
  const request = Number(s.request || 0);
  const champagne = Number(s.champagne || 0);
  const okuri = Number(s.okuri || 0);

  const subtotal = basic + drink + dohan + request + champagne;
  const welfare = floor10yen(subtotal * 0.10); // 厚生費10% → 10円単位切り捨て
  const total = subtotal - welfare - okuri;

  return {
    hours,
    basic,
    drink,
    dohan,
    request,
    champagne,
    okuri,
    welfare,
    total,
  };
}

function viewForStaff(userId) {
  const r = calc(userId);
  return [
    '— 明細（本人用）—',
    `勤務時間: ${r.hours.toFixed(2)} 時間`,
    `基本給: ${toYen(r.basic)}`,
    `ドリンク: ${toYen(r.drink)}`,
    `同伴: ${toYen(r.dohan)}`,
    `リクエスト: ${toYen(r.request)}`,
    `シャンパン: ${toYen(r.champagne)}`,
    `厚生費(10%・10円切捨て): -${toYen(r.welfare)}`,
    `送り: -${toYen(r.okuri)}`,
    `———`,
    `総額: ${toYen(r.total)}`,
  ].join('\n');
}

function viewForSeisan(userId) {
  const r = calc(userId);
  // 基本給は表示しない（総額は表示）
  return [
    '— 明細（清算担当用）—',
    `ドリンク: ${toYen(r.drink)}`,
    `同伴: ${toYen(r.dohan)}`,
    `リクエスト: ${toYen(r.request)}`,
    `シャンパン: ${toYen(r.champagne)}`,
    `送り: -${toYen(r.okuri)}`,
    `厚生費(10%・10円切捨て): -${toYen(r.welfare)}`,
    `———`,
    `総額: ${toYen(r.total)}`,
  ].join('\n');
}

// ==== メッセージ処理 ====
async function handleTextMessage(event) {
  const userId = event.source?.userId || 'anonymous';
  const text = (event.message.text || '').trim();

  let reply = '';

  if (/^出勤/i.test(text)) reply = setTime(userId, 'clockIn', text);
  else if (/^退勤/i.test(text)) reply = setTime(userId, 'clockOut', text);
  else if (/^時給/i.test(text)) reply = setNum(userId, 'hourly', text);
  else if (/^ドリンク/i.test(text)) reply = setNum(userId, 'drink', text);
  else if (/^同伴/i.test(text)) reply = setNum(userId, 'dohan', text);
  else if (/^リクエスト/i.test(text)) reply = setNum(userId, 'request', text);
  else if (/^シャンパン/i.test(text)) reply = setNum(userId, 'champagne', text);
  else if (/^送り/i.test(text)) reply = setNum(userId, 'okuri', text);
  else if (/^(確認|明細|合計)$/i.test(text)) reply = viewForStaff(userId);
  else if (/^清算$/i.test(text)) reply = viewForSeisan(userId);
  else if (/^リセット$/i.test(text)) {
    delete state[userId];
    reply = '入力内容をリセットしました。';
  } else {
    reply =
      '入力例:\n' +
      '出勤 18:00 / 退勤 23:30 / 時給 2000\n' +
      'ドリンク 5000 / 同伴 3000 / リクエスト 2000 / シャンパン 10000 / 送り 1000\n' +
      '確認 → 本人用明細を表示\n' +
      '清算 → 清算担当用（基本給を非表示）\n' +
      'リセット → クリア';
  }

  await client.replyMessage(event.replyToken, { type: 'text', text: reply });
}

// ==== Express + Webhook ====
const app = express();
app.post('/webhook', middleware(config), async (req, res) => {
  const results = await Promise.all(
    req.body.events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        return handleTextMessage(event);
      }
      return Promise.resolve(null);
    })
  );
  res.json(results);
});

// ==== Render で起動 ====
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`LINE bot is running on port ${port}`));

module.exports = app;
