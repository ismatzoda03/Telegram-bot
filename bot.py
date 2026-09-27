import os

from telegram import Update, ReplyKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

TOKEN = os.getenv("BOT_TOKEN")

keyboard = ReplyKeyboardMarkup(
    [
        ["📚 Каталог", "🔎 Поиск"],
        ["❤️ Подписки"],
    ],
    resize_keyboard=True,
)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 Добро пожаловать!\n\n"
        "Здесь ты сможешь искать тайтлы и читать главы.\n"
        "Выбери действие 👇",
        reply_markup=keyboard,
    )


async def messages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text

    if text == "📚 Каталог":
        await update.message.reply_text(
            "📚 Каталог пока пуст.\n"
            "Скоро здесь появятся тайтлы."
        )

    elif text == "🔎 Поиск":
        await update.message.reply_text(
            "🔎 Напиши название тайтла целиком или частично."
        )

    elif text == "❤️ Подписки":
        await update.message.reply_text(
            "❤️ Здесь будут тайтлы, на обновления которых ты подписан."
        )

    else:
        await update.message.reply_text(
            f"🔎 Ищу: {text}\n\n"
            "Пока база тайтлов пустая."
        )


def main():
    if not TOKEN:
        raise RuntimeError("BOT_TOKEN не установлен")

    app = Application.builder().token(TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(
        MessageHandler(filters.TEXT & ~filters.COMMAND, messages)
    )

    app.run_polling()


if __name__ == "__main__":
    main()
