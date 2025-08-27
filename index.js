// index.js ＊このファイルに丸ごと貼り替え
import express from "express";
import { Client } from "@line/bot-sdk";
import dayjs from "dayjs";
import { google } from "googleapis";

// ===== LINE設定（Renderの環境変数）=====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ===== Google Sheets クライアント =====
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  // 秘密鍵の \n を本物の改行に直す
  process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1"; // なければSheet1

async function appendToSheet({ timestamp, userId, displayName, message }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:D`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[timestamp, userId, displayName, message]],
    },
  });
}

// ===== Express =====
const app = express();
app.use(express.json());

// Webhook 受け口
app.post("/webhook", (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({}))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// イベント処理
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source?.userId || "";
  const userMessage = event.message.text;

  // 表示名（取れなかったら空）
  let displayName = "";
  try {
    const profile = await client.getProfile(userId);
    displayName = profile.displayName || "";
  } catch (e) {
    console.warn("getProfile failed:", e.message);
  }

  const timestamp = dayjs().format("YYYY/MM/DD HH:mm:ss");

  // シートへ追記（失敗しても返信はする）
  try {
    await appendToSheet({ timestamp, userId, displayName, message: userMessage });
  } catch (e) {
    console.error("appendToSheet error:", e);
  }

  // 返信
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `受け取りました: ${userMessage}\n(${timestamp})`,
  });
}

// 動作確認用
app.get("/", (_req, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`LINE bot is running on port ${port}`));