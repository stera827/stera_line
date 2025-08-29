// ==== 必須ライブラリ ====
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { google } = require('googleapis'); // 後でLOG_TO_SHEETS=1のときだけ使用

// ==== LINE 設定（Render の環境変数）====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ==== メモリ保持（サーバ再起動で消える簡易ストア）====
const sessions = new Map();
const yen = (n) => (isNaN(n) ? 0 : Number(n));
const fmtY = (n) => `${Math.round(n).toLocaleString()}円`;
const fmtH = (h) => `${(Math.round(h * 100) / 100).toFixed(2)}h`;

function getState(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      name: '',           // 表示名（必要なら手動設定可）
      start: null,        // 出勤Date
      end: null,          // 退勤Date
      wage: 0,            // 時給
      drink: 0,           // ドリンクバック(円) ※D1500xN/D2500xN も対応
      douhan: 0,          // 同伴バック(円) 例: 同伴 1 → 2000
      request: 0,         // リクエスト(円) 例: リクエ 5000 → 70%を計上
      champagne: 0,       // シャンパン(円) 例: シャンパン 20000 12000 → (売上-原価)*10%
      okuri: 0,           // 送り(円) ※最後に差し引き
    });
  }
  return sessions.get(userId);
}

// ==== 計算（仕様確定版）====
// 小計 = 基本給 + ドリンク + 同伴 + リクエスト + シャンパン
// 厚生費 = 小計10%（控除）→ 小計*0.9 を 10円単位切捨て
// 最終 = (小計 - 厚生費) - 送り（最後に差し引き）
function calc(state) {
  let hours = 0;
  if (state.start && state.end) {
    hours = (state.end - state.start) / (1000 * 60 * 60);
  }
  const base = Math.max(0, state.wage * hours);
  const subtotal = base + state.drink + state.douhan + state.request + state.champagne;

  const afterWelfare = Math.floor((subtotal * 0.9) / 10) * 10; // 小計90%を10円切捨て
  const total = afterWelfare - state.okuri;

  return { hours, base, subtotal, afterWelfare, total };
}

// ==== Google Sheets 追記（任意ON/OFF）====
async function appendToSheetIfEnabled(values) {
  if (process.env.LOG_TO_SHEETS !== '1') return; // 後回し運用OK
  const credsRaw =
    process.env.GOOGLE_SERVICE_JSON ||
    process.env.GOOGLE_CREDENTIALS ||
    process.env.GOOGLE_JSON;

  if (!credsRaw) { console.error('No Google service account JSON in env'); return; }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credsRaw),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheetId = process.env.SPREADSHEET_ID || process.env.SHEET_ID;
  const sheetName = process.env.SHEET_NAME || 'Sheet1';

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:P`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

// ==== テキストメッセージ処理（ここだけ触れば運用拡張可）====
async function handleTextMessage(event) {
  const text = (event.message.text || '').trim();
  const userId = event.source?.userId || '';
  const state = getState(userId);

  // 表示名（未設定ならLINEプロフィールから）
  if (!state.name) {
    try {
      const prof = await client.getProfile(userId);
      state.name = prof?.displayName || '';
    } catch (_) {}
  }

  // -------------- 入力コマンド --------------
  // 出勤 HH:MM 時給 N
  let m;
  if ((m = text.match(/^出勤\s+(\d{1,2}):(\d{2})\s+時給\s+(\d+)/))) {
    const [, hh, mm, wage] = m;
    const now = new Date(); now.setHours(+hh, +mm, 0, 0);
    state.start = now; state.wage = yen(wage);
    await client.replyMessage(event.replyToken, { type:'text', text:`出勤を記録：${hh}:${mm}／時給 ${fmtY(state.wage)}` });
    return;
  }

  // 退勤 HH:MM
  if ((m = text.match(/^退勤\s+(\d{1,2}):(\d{2})/))) {
    const [, hh, mm] = m;
    const now = new Date(); now.setHours(+hh, +mm, 0, 0);
    state.end = now;
    const r = calc(state);
    await client.replyMessage(event.replyToken, { type:'text', text:`退勤を記録：${hh}:${mm}（勤務 ${fmtH(r.hours)}）` });
    return;
  }

  // 時給 N（後から修正したいとき）
  if ((m = text.match(/^時給\s+(\d+)/))) {
    state.wage = yen(m[1]);
    await client.replyMessage(event.replyToken, { type:'text', text:`時給を ${fmtY(state.wage)} に更新しました。` });
    return;
  }

  // ドリンク：①合計円で直入力 ②D1500xN と D2500xN の混在もOK（例: "D1500x3 D2500x2"）
  if ((m = text.match(/^ドリンク\s+(-?\d+)/))) {
    state.drink = yen(m[1]);
    await client.replyMessage(event.replyToken, { type:'text', text:`ドリンク合計を ${fmtY(state.drink)} で記録しました。` });
    return;
  }
  if (/D(1500|2500)x(\d+)/i.test(text)) {
    let sum = 0;
    const re = /D(1500|2500)x(\d+)/gi;
    let t;
    while ((t = re.exec(text))) {
      const price = Number(t[1]), count = Number(t[2]);
      if (price === 1500) sum += 300 * count;
      if (price === 2500) sum += 500 * count;
    }
    state.drink = yen(sum);
    await client.replyMessage(event.replyToken, { type:'text', text:`ドリンク（伝票換算）を ${fmtY(state.drink)} で記録しました。` });
    return;
  }

  // 同伴：同伴 N（件数）→ 2000×N、または 同伴 金額（円）
  if ((m = text.match(/^同伴\s+(\d+)$/))) {
    const count = Number(m[1]);
    if (count <= 10) {
      state.douhan = 2000 * count;
      await client.replyMessage(event.replyToken, { type:'text', text:`同伴 ${count}件 → ${fmtY(state.douhan)} を記録しました。` });
      return;
    }
  }
  if ((m = text.match(/^同伴\s+(-?\d+)/))) {
    state.douhan = yen(m[1]);
    await client.replyMessage(event.replyToken, { type:'text', text:`同伴を ${fmtY(state.douhan)} で記録しました。` });
    return;
  }

  // リクエスト：売上から70%バック → 「リクエ 5000」
  if ((m = text.match(/^(リクエ|リクエスト)\s+(\d+)/))) {
    const uriage = yen(m[2]);
    state.request = Math.round(uriage * 0.7);
    await client.replyMessage(event.replyToken, { type:'text', text:`リクエスト: 売上 ${fmtY(uriage)} → バック ${fmtY(state.request)} を記録しました。` });
    return;
  }

  // シャンパン： (売上 - 原価)×10% → 「シャンパン 20000 12000」
  if ((m = text.match(/^シャンパン\s+(\d+)\s+(\d+)/))) {
    const uriage = yen(m[1]), genka = yen(m[2]);
    state.champagne = Math.round(Math.max(0, uriage - genka) * 0.1);
    await client.replyMessage(event.replyToken, { type:'text', text:`シャンパン: 売上 ${fmtY(uriage)} - 原価 ${fmtY(genka)} → ${fmtY(state.champagne)} を記録しました。` });
    return;
  }

  // 送り：控除（最後に差し引き） → 「送り 800」
  if ((m = text.match(/^送り\s+(\-?\d+)/))) {
    state.okuri = yen(m[1]);
    await client.replyMessage(event.replyToken, { type:'text', text:`送り（控除）を ${fmtY(state.okuri)} で記録しました。` });
    return;
  }

  // 氏名を手動設定したい場合 → 「名前 山田」 （任意）
  if ((m = text.match(/^名前\s+(.+)/))) {
    state.name = m[1].trim();
    await client.replyMessage(event.replyToken, { type:'text', text:`名前を「${state.name}」に設定しました。` });
    return;
  }

  // 清算（本人/オーナー向け：基本給も表示）
  if (/^清算$/.test(text)) {
    const r = calc(state);
    const msg =
`【清算（本人/オーナー向け）】
名前：${state.name || '(未設定)'}
勤務時間：${fmtH(r.hours)}
時給：${fmtY(state.wage)}
基本給：${fmtY(r.base)}
ドリンク：${fmtY(state.drink)}
同伴：${fmtY(state.douhan)}
リクエスト：${fmtY(state.request)}
シャンパン：${fmtY(state.champagne)}
小計：${fmtY(r.subtotal)}
厚生費10%後（10円切捨て）：${fmtY(r.afterWelfare)}
送り（控除）：-${fmtY(state.okuri)}
————————————
総額：${fmtY(r.total)}`;
    await client.replyMessage(event.replyToken, { type:'text', text: msg });

    // 任意でログ行を追加（ONのときのみ）
    try {
      await appendToSheetIfEnabled([
        new Date().toISOString(),
        userId,
        state.name,
        state.start ? state.start.toLocaleString('ja-JP') : '',
        state.end ? state.end.toLocaleString('ja-JP') : '',
        state.wage, r.hours.toFixed(2), r.base,
        state.drink, state.douhan, state.request, state.champagne,
        r.subtotal, r.afterWelfare, state.okuri, r.total
      ]);
    } catch (e) { console.error('appendToSheet error', e?.message || e); }

    return;
  }

  // 清算担当（基本給は非表示）
  if (/^清算担当$/.test(text)) {
    const r = calc(state);
    const msg =
`【清算（担当向け）】
名前：${state.name || '(未設定)'}
ドリンク：${fmtY(state.drink)}
同伴：${fmtY(state.douhan)}
リクエスト：${fmtY(state.request)}
シャンパン：${fmtY(state.champagne)}
厚生費10%後（10円切捨て）：${fmtY(r.afterWelfare)}
送り（控除）：-${fmtY(state.okuri)}
————————————
総額：${fmtY(r.total)}
※ 基本給（時給×時間）は非表示`;
    await client.replyMessage(event.replyToken, { type:'text', text: msg });
    return;
  }

  // リセット
  if (/^リセット$/.test(text)) {
    sessions.delete(userId);
    await client.replyMessage(event.replyToken, { type:'text', text:'このトークの計算状態をリセットしました。' });
    return;
  }

  // デフォルト応答（受け取り確認）
  await client.replyMessage(event.replyToken, { type:'text', text:`受け取りました: ${text}` });
}

// ==== Express + Webhook ====
const app = express();
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map((event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        return handleTextMessage(event);
      }
      return Promise.resolve();
    }));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

// Render で起動
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`LINE bot is running on port ${port}`);
});

module.exports = app;
