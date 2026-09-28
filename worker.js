const TITLES = [
  {
    id: "defense_pass",
    title: "Проход защиты",
    genres: "Экшен • Фэнтези",
    description: "Манга «Проход защиты»"
  },
  {
    id: "sashimi_knife",
    title: "Я захватил власть в Академии одним лишь ножом для сашими",
    genres: "Экшен • Фэнтези • Академия",
    description: "Манга об Академии"
  }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/check") {
  const me = await telegramApi(env.BOT_TOKEN, "getMe");
  const webhook = await telegramApi(env.BOT_TOKEN, "getWebhookInfo");

  return new Response(
    JSON.stringify({ me, webhook }, null, 2),
    {
      headers: {
        "content-type": "application/json;charset=UTF-8"
      }
    }
  );
    }

    // Проверка, что Worker работает
    if (url.pathname === "/") {
      return new Response("SashiNote Bot работает ✅");
    }

    // Установка Telegram webhook
    if (url.pathname === "/setup") {
      if (!env.BOT_TOKEN) {
        return new Response("BOT_TOKEN не найден", {
          status: 500
        });
      }

      const webhookUrl = `${url.origin}/telegram`;

      const result = await telegramApi(
        env.BOT_TOKEN,
        "setWebhook",
        {
          url: webhookUrl
        }
      );

      return new Response(
        JSON.stringify(
          {
            webhook: webhookUrl,
            telegram: result
          },
          null,
          2
        ),
        {
          headers: {
            "content-type": "application/json;charset=UTF-8"
          }
        }
      );
    }

    // Telegram отправляет обновления сюда
    if (url.pathname === "/telegram") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405
        });
      }

      try {
        const update = await request.json();

        await handleUpdate(update, env);

        return new Response("OK");
      } catch (error) {
        console.error(error);

        return new Response("OK");
      }
    }

    return new Response("Not Found", {
      status: 404
    });
  }
};


async function handleUpdate(update, env) {
  const token = env.BOT_TOKEN;

  if (!token) {
    throw new Error("BOT_TOKEN отсутствует");
  }

  // ============================
  // ОБЫЧНЫЕ СООБЩЕНИЯ
  // ============================

  if (update.message) {
    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text?.trim() || "";

    if (text === "/start") {
      await showStart(token, chatId);
      return;
    }

    if (text === "/catalog" || text === "📚 Каталог") {
      await showCatalog(token, chatId);
      return;
    }

    // Поиск по названию
    if (text) {
      const found = TITLES.filter(item =>
        item.title
          .toLowerCase()
          .includes(text.toLowerCase())
      );

      if (found.length > 0) {
        for (const item of found) {
          await showTitle(token, chatId, item);
        }

        return;
      }
    }

    await telegramApi(token, "sendMessage", {
      chat_id: chatId,
      text:
        "Я не понял сообщение.\n\n" +
        "Нажми кнопку «📚 Каталог» или отправь /start.",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📚 Каталог",
              callback_data: "catalog"
            }
          ]
        ]
      }
    });

    return;
  }


  // ============================
  // НАЖАТИЯ НА КНОПКИ
  // ============================

  if (update.callback_query) {
    const callback = update.callback_query;
    const data = callback.data;
    const chatId = callback.message?.chat?.id;

    // Убирает загрузку на кнопке
    await telegramApi(token, "answerCallbackQuery", {
      callback_query_id: callback.id
    });

    if (!chatId) {
      return;
    }

    if (data === "catalog") {
      await showCatalog(token, chatId);
      return;
    }
if (data === "search") {
  await telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text:
      "🔍 Поиск манги\n\n" +
      "Отправь мне название манги сообщением.\n\n" +
      "Например:\n" +
      "Проход защиты",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🏠 Главное меню",
            callback_data: "home"
          }
        ]
      ]
    }
  });

  return;
}

if (data === "subscription") {
  await telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text:
      "🔔 Мои подписки\n\n" +
      "Здесь будут находиться тайтлы, на которые ты подписан.\n\n" +
      "Когда выйдет новая глава — бот сможет прислать уведомление.\n\n" +
      "⚙️ Подписки подключим после добавления тайтлов.",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📚 Каталог",
            callback_data: "catalog"
          }
        ],
        [
          {
            text: "🏠 Главное меню",
            callback_data: "home"
          }
        ]
      ]
    }
  });

  return;
}
    if (data === "home") {
      await showStart(token, chatId);
      return;
    }

    if (data.startsWith("title:")) {
      const id = data.substring(6);

      const item = TITLES.find(x => x.id === id);

      if (item) {
        await showTitle(token, chatId, item);
      }

      return;
    }

    if (data.startsWith("chapters:")) {
      const id = data.substring(9);

      const item = TITLES.find(x => x.id === id);

      if (!item) {
        return;
      }

      await telegramApi(token, "sendMessage", {
        chat_id: chatId,
        text:
          `📖 ${item.title}\n\n` +
          "Главы добавим следующим шагом.",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⬅️ Назад к каталогу",
                callback_data: "catalog"
              }
            ],
            [
              {
                text: "🏠 Главное меню",
                callback_data: "home"
              }
            ]
          ]
        }
      });

      return;
    }
  }
}


async function showStart(token, chatId) {
  await telegramApi(token, "sendMessage", {
    chat_id: chatId,

    text:
      "👋 Добро пожаловать в SashiNote!\n\n" +
      "📚 Здесь ты можешь выбрать мангу из каталога.\n\n" +
      "Выбери действие:",

    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📚 Каталог",
            callback_data: "catalog"
          }
        ]
      ]
    }
  });
}


async function showStart(token, chatId) {
  await telegramApi(token, "sendMessage", {
    chat_id: chatId,

    text:
      "👋 Добро пожаловать в SashiNote!\n\n" +
      "📚 Читай мангу\n" +
      "🔍 Ищи нужный тайтл\n" +
      "🔔 Подписывайся на обновления\n\n" +
      "Выбери действие:",

    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📚 Каталог",
            callback_data: "catalog"
          }
        ],
        [
          {
            text: "🔍 Поиск",
            callback_data: "search"
          },
          {
            text: "🔔 Подписка",
            callback_data: "subscription"
          }
        ]
      ]
    }
  });
}}

async function showCatalog(token, chatId) {
  const buttons = TITLES.map(item => [
    {
      text: `📖 ${item.title}`,
      callback_data: `title:${item.id}`
    }
  ]);

  buttons.push([
    {
      text: "🏠 Главное меню",
      callback_data: "home"
    }
  ]);

  await telegramApi(token, "sendMessage", {
    chat_id: chatId,

    text:
      "📚 Каталог SashiNote\n\n" +
      "Выбери произведение:",

    reply_markup: {
      inline_keyboard: buttons
    }
  });
}}


async function showTitle(token, chatId, item) {
  await telegramApi(token, "sendMessage", {
    chat_id: chatId,

    text:
      `📖 ${item.title}\n\n` +
      `🎭 Жанры: ${item.genres}\n\n` +
      `${item.description}`,

    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📚 Все главы",
            callback_data: `chapters:${item.id}`
          }
        ],
        [
          {
            text: "⬅️ Каталог",
            callback_data: "catalog"
          }
        ]
      ]
    }
  });
}


// ============================
// TELEGRAM API
// ============================

async function telegramApi(token, method, data = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",

      headers: {
        "content-type": "application/json"
      },

      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    console.error(
      "Telegram API error:",
      JSON.stringify(result)
    );
  }

  return result;
}
