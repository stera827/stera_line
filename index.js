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
    return;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credsRaw),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheetId =
    process.env.SPREADSHEET_ID || process.env.SHEET_ID;
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
  const userId = event.source?.user
