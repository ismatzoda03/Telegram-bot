export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.BOT_TOKEN) {
      return new Response("BOT_TOKEN не установлен", { status: 500 });
    }

    // Один раз откроем /setup, чтобы подключить Telegram webhook
    if (request.method === "GET" && url.pathname === "/setup") {
      const webhookUrl = `${url.origin}/telegram`;

      const response = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: webhookUrl,
          }),
        }
      );

      const result = await response.text();

      return new Response(result, {
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    // Сюда Telegram будет отправлять сообщения
    if (request.method === "POST" && url.pathname === "/telegram") {
      const update = await request.json();

      await handleUpdate(update, env.BOT_TOKEN);

      return new Response("OK");
    }

    return new Response("Telegram bot работает ✅");
  },
};


async function handleUpdate(update, token) {
  const message = update.message;

  if (!message || !message.chat) {
    return;
  }

  const chatId = message.chat.id;
  const text = message.text || "";

  if (text.startsWith("/start")) {
    await sendMessage(
      token,
      chatId,
      "👋 Добро пожаловать!\n\nЗдесь ты сможешь искать тайтлы и читать главы.\nВыбери действие 👇",
      {
        keyboard: [
          ["📚 Каталог", "🔎 Поиск"],
          ["❤️ Подписки"],
        ],
        resize_keyboard: true,
      }
    );

    return;
  }

  if (text === "📚 Каталог") {
    await sendMessage(
      token,
      chatId,
      "📚 Каталог пока пуст.\nСкоро здесь появятся тайтлы."
    );

    return;
  }

  if (text === "🔎 Поиск") {
    await sendMessage(
      token,
      chatId,
      "🔎 Напиши название тайтла целиком или частично."
    );

    return;
  }

  if (text === "❤️ Подписки") {
    await sendMessage(
      token,
      chatId,
      "❤️ Здесь будут тайтлы, на обновления которых ты подписан."
    );

    return;
  }

  await sendMessage(
    token,
    chatId,
    `🔎 Ищу: ${text}\n\nПока база тайтлов пустая.`
  );
}


async function sendMessage(token, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text: text,
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
}
