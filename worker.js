const TITLES = [
  {
    name: "Проход защиты",
    aliases: ["guard pass"],
  },
  {
    name: "Я захватил власть в Академии одним лишь ножом для сашими",
    aliases: [],
  },
];

function normalize(value) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();
}

function findTitles(query) {
  const normalizedQuery = normalize(query);

  if (!normalizedQuery) return [];

  return TITLES.filter((title) =>
    [title.name, ...title.aliases].some((name) =>
      normalize(name).includes(normalizedQuery) ||
      normalizedQuery.includes(normalize(name))
    )
  );
}

function catalogText() {
  return (
    "📚 Тайтлы в каталоге:\n\n" +
    TITLES.map((title, index) => `${index + 1}. ${title.name}`).join("\n") +
    "\n\nНажми «🔎 Поиск» и напиши название или его часть."
  );
}

async function handleUpdate(update, token) {
  const message = update.message;

  if (!message || !message.chat) return;

  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  if (text.startsWith("/start")) {
    await sendMessage(
      token,
      chatId,
      "👋 Добро пожаловать!\n\n" +
        "Здесь можно искать тайтлы и находить ссылки на разрешённые источники. " +
        "Бот пока не хранит и не пересылает главы.\n\n" +
        "Выбери действие 👇",
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

  if (text === "📚 Каталог" || text === "/catalog") {
    await sendMessage(token, chatId, catalogText());
    return;
  }

  if (text === "🔎 Поиск" || text === "/search") {
    await sendMessage(
      token,
      chatId,
      "🔎 Напиши название тайтла целиком или его часть."
    );
    return;
  }

  if (text === "❤️ Подписки" || text === "/subscriptions") {
    await sendMessage(
      token,
      chatId,
      "❤️ Подписки и уведомления пока не подключены. Добавим их после настройки хранения данных."
    );
    return;
  }

  if (text === "/help") {
    await sendMessage(
      token,
      chatId,
      "ℹ️ Используй кнопки «📚 Каталог» и «🔎 Поиск». " +
        "Сейчас бот показывает только названия тайтлов."
    );
    return;
  }

  if (message.document) {
    await sendMessage(
      token,
      chatId,
      "Приём PDF пока не включён. Сначала нужно подтвердить разрешение на размещение файлов и подготовить хранилище."
    );
    return;
  }

  if (!text) return;

  const found = findTitles(text);

  if (found.length > 0) {
    await sendMessage(
      token,
      chatId,
      "🔎 Нашёл:\n\n" +
        found.map((title) => `📖 ${title.name}`).join("\n") +
        "\n\nСсылку на разрешённый источник добавим после подтверждения сотрудничества."
    );
    return;
  }

  await sendMessage(
    token,
    chatId,
    "Не нашёл такой тайтл.\n\n" + catalogText()
  );
}

async function sendMessage(token, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text,
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    console.error("Telegram sendMessage failed:", await response.text());
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.BOT_TOKEN) {
      return new Response("BOT_TOKEN не установлен", { status: 500 });
    }

    if (request.method === "GET" && url.pathname === "/setup") {
      const webhookUrl = `${url.origin}/telegram`;

      const response = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: webhookUrl }),
        }
      );

      return new Response(await response.text(), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      const update = await request.json();
      await handleUpdate(update, env.BOT_TOKEN);
      return new Response("OK");
    }

    return new Response("Telegram bot работает ✅");
  },
};
