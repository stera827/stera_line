// ==== 必須ライブラリ ====
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { google } = require('googleapis');

// ==== LINE 設定（Render の環境変数）====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ==== Google Sheets 追記関数（環境変数名の揺れを吸収）====
async function appendToSheet(values) {
  const credsRaw =
    process.env.GOOGLE_SERVICE_JSON ||
    process.env.GOOGLE_CREDENTIALS ||
    process.env.GOOGLE_JSON;

  if (!credsRaw) {
    console.error('No Google service account JSON in env');
    return; // シート連携はスキップ（返信は続行）
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credsRaw),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheetId = process.env.SPREADSHEET_ID || process.env.SHEET_ID;
  const sheetName = process.env.SHEET_NAME || 'Sheet1';

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:D`, // timestamp, userId, displayName, message
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

// ==== 受信テキスト処理 ====
async function handleTextMessage(event) {
  const text = (event.message.text || '').trim();
  const userId = event.source?.userId || '';

  let displayName = '';
  try {
    const prof = await client.getProfile(userId);
    displayName = prof?.displayName || '';
  } catch (_) {
    // 取得できないケースは無視
  }

  // 返信（これまで通り）
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `受け取りました: ${text}`,
  });

  // Sheets へ記録（失敗してもアプリは落とさない）
  try {
    await appendToSheet([new Date().toISOString(), userId, displayName, text]);
  } catch (e) {
    console.error('appendToSheet error', e);
  }
}

// ==== Express + Webhook ====
const app = express();
app.post('/webhook', middleware(config), async (req, res) => {
  const results = await Promise.all(
    req.body.events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        return handleTextMessage(event);
      }
      // 他のイベントは無視
      return Promise.resolve(null);
    })
  );
  res.json(results);
});

// Render で起動
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`LINE bot is running on port ${port}`);
});

module.exports = app;
