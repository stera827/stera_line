import express from "express";
import { Client } from "@line/bot-sdk";
import dayjs from "dayjs";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new Client(config);
const app = express();
app.use(express.json());

// LINEからのWebhookを受け取るエンドポイント
app.post("/webhook", (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// イベント処理
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;
  const replyText = `受け取りました: ${userMessage}\n(${dayjs().format("YYYY/MM/DD HH:mm")})`;

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: replyText
  });
}

// サーバー起動
app.listen(3000, () => {
  console.log("LINE bot is running on port 3000");
});
