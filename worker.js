// SashiNote: Cloudflare Worker + D1.
// Bindings: BOT_TOKEN, ADMIN_ID, DB.
// After deployment, open /setup once.

const CHANNEL = "https://t.me/SashiNoteManga";
const PAGE_SIZE = 9;
const READY = new WeakMap();
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS sn_titles (id TEXT PRIMARY KEY, title_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, kind TEXT NOT NULL, genres TEXT NOT NULL, genre_key TEXT NOT NULL, source_label TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '', cover TEXT NOT NULL DEFAULT '')",
  "CREATE TABLE IF NOT EXISTS sn_chapters (id TEXT PRIMARY KEY, title_id TEXT NOT NULL REFERENCES sn_titles(id), volume INTEGER NOT NULL, chapter TEXT NOT NULL, chapter_sort REAL NOT NULL, file_id TEXT NOT NULL, file_unique_id TEXT NOT NULL, source_label TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(title_id, volume, chapter))",
  "CREATE INDEX IF NOT EXISTS sn_chapter_order ON sn_chapters(title_id, volume, chapter_sort)",
  "CREATE INDEX IF NOT EXISTS sn_chapter_file ON sn_chapters(file_unique_id)",
  "CREATE TABLE IF NOT EXISTS sn_drafts (actor TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, step TEXT NOT NULL, data TEXT NOT NULL, last_update INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sn_updates (id INTEGER PRIMARY KEY, status TEXT NOT NULL, lease INTEGER NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sn_searches (id TEXT PRIMARY KEY, actor TEXT NOT NULL, query TEXT NOT NULL, created_at INTEGER NOT NULL)"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("SashiNote Bot работает ✅");
    if (!env.BOT_TOKEN) return new Response("Не задан BOT_TOKEN", { status: 503 });
    try {
      if (url.pathname === "/setup") {
        await api(env, "setWebhook", {
          url: url.origin + "/telegram",
          secret_token: await webhookSecret(env.BOT_TOKEN),
          allowed_updates: ["message", "callback_query"],
          max_connections: 1
        });
        return Response.json({ ok: true, message: "Бот подключён. Отправь ему /id." });
      }
      if (url.pathname === "/check") {
        const me = await api(env, "getMe");
        const webhook = await api(env, "getWebhookInfo");
        return Response.json({
          ok: true, bot: me.username, database_connected: !!env.DB,
          admin_configured: !!adminId(env), webhook: webhook.url,
          pending_updates: webhook.pending_update_count
        });
      }
      if (url.pathname !== "/telegram") return new Response("Not Found", { status: 404 });
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!sameSecret(supplied, await webhookSecret(env.BOT_TOKEN))) {
        return new Response("Forbidden", { status: 403 });
      }
      let update;
      try { update = await request.json(); }
      catch { return new Response("Bad JSON", { status: 400 }); }
      if (!Number.isSafeInteger(update.update_id)) return new Response("Bad update", { status: 400 });
      if (!env.DB) {
        await handleUpdate(update, env);
        return new Response("OK");
      }
      await initDatabase(env.DB);
      const now = Date.now();
      const claim = await run(env.DB,
        "INSERT INTO sn_updates(id,status,lease,created_at) VALUES(?,'working',?,?) ON CONFLICT(id) DO UPDATE SET lease=excluded.lease WHERE sn_updates.status='working' AND sn_updates.lease < ?",
        update.update_id, now + 120000, now, now);
      if (!claim.meta.changes) {
        const previous = await one(env.DB, "SELECT status FROM sn_updates WHERE id=?", update.update_id);
        return new Response(previous?.status === "done" ? "OK" : "Retry", {
          status: previous?.status === "done" ? 200 : 503
        });
      }
      try {
        await handleUpdate(update, env);
        await run(env.DB, "UPDATE sn_updates SET status='done',lease=0 WHERE id=?", update.update_id);
        if (update.update_id % 100 === 0) {
          await run(env.DB, "DELETE FROM sn_updates WHERE status='done' AND created_at < ?", now - 604800000);
          await run(env.DB, "DELETE FROM sn_searches WHERE created_at < ?", now - 86400000);
        }
      } catch (error) {
        await run(env.DB, "UPDATE sn_updates SET lease=0 WHERE id=?", update.update_id);
        throw error;
      }
      return new Response("OK");
    } catch (error) {
      console.error("SashiNote request failed", error.name, error.apiMethod || "", error.apiCode || "");
      return new Response("Temporary error. Retry.", { status: 503 });
    }
  }
};

async function handleUpdate(update, env) {
  const message = update.message;
  const callback = update.callback_query;
  if (callback) {
    try { await api(env, "answerCallbackQuery", { callback_query_id: callback.id }); }
    catch { /* A delayed callback may already have expired. */ }
  }
  const chat = message?.chat || callback?.message?.chat;
  const actor = message?.from || callback?.from;
  if (!chat || !actor || actor.is_bot) return;
  const c = {
    env, db: env.DB, chat: chat.id, actor: String(actor.id),
    uid: update.update_id, admin: chat.type === "private" && String(actor.id) === adminId(env)
  };
  const text = message?.text?.trim() || "";
  const command = text.split(/\s/)[0].split("@")[0];
  const data = callback?.data || "";
  if (chat.type !== "private") {
    if (command === "/start") await say(c, "Открой бота в личных сообщениях.");
    return;
  }
  if (command === "/id") {
    await api(env, "sendMessage", {
      chat_id: c.chat, text: "Твой Telegram ID:\n" + c.actor, protect_content: false
    });
    return;
  }
  if (command === "/start" || data === "home") return showHome(c);
  if (!env.DB) return say(c, "Каталог пока настраивается. Попробуй немного позже.");
  if (data.startsWith("admin:")) return adminCallback(c, data.split(":"));
  if (["/admin", "/upload", "/cancel"].includes(command)) {
    if (!c.admin) return say(c, "Загружать главы может только владелец бота.");
    if (command === "/cancel") {
      await run(c.db, "DELETE FROM sn_drafts WHERE actor=?", c.actor);
      return say(c, "Добавление отменено. Можешь отправить другой PDF.");
    }
    const draft = await getDraft(c);
    if (draft && draft.step !== "done") return promptDraft(c, draft);
    return say(c, "Отправь PDF файлом или прямую HTTPS-ссылку на PDF.\nЯ помогу добавить тайтл и главу. Отмена: /cancel.");
  }
  if (data === "search" || command === "/search" || text === "🔍 Поиск") {
    return say(c, "Напиши название манги или жанр.", [[button("📚 Каталог", "catalog")]]);
  }
  if (data === "subscription") {
    return say(c, "Новости SashiNote:", [[{ text: "🔔 Подписка", url: CHANNEL }]]);
  }
  if (data === "catalog" || command === "/catalog" || text === "📚 Каталог") return showCatalog(c);
  if (data.startsWith("catalog:")) return showCatalog(c, Number(data.split(":")[1]));
  if (data.startsWith("find:")) {
    const [, id, page] = data.split(":");
    const search = await one(c.db, "SELECT * FROM sn_searches WHERE id=? AND actor=?", id, c.actor);
    if (!search || search.created_at < Date.now() - 86400000) {
      return say(c, "Поиск устарел. Напиши название ещё раз.");
    }
    return showCatalog(c, Number(page), search);
  }
  if (data.startsWith("title:")) return showTitle(c, data.split(":")[1]);
  if (data.startsWith("chapters:")) {
    const [, id, page] = data.split(":");
    return showChapters(c, id, Number(page || 0));
  }
  if (data.startsWith("chapter:")) return showChapter(c, data.split(":")[1]);
  if (data.startsWith("pdf:")) return sendPdf(c, data.split(":")[1]);
  if (data.startsWith("read:")) {
    const chapter = await one(c.db, "SELECT id FROM sn_chapters WHERE title_id=? ORDER BY volume,chapter_sort,id LIMIT 1", data.split(":")[1]);
    return chapter ? sendPdf(c, chapter.id) : say(c, "Глав пока нет.");
  }
  if (callback) return;
  const draft = c.admin ? await getDraft(c) : null;
  if (draft?.last_update === c.uid) return promptDraft(c, draft);
  if (draft && draft.step !== "done") return advanceDraft(c, draft, message);
  const isUrl = /^https:\/\//i.test(text);
  if (message.document || isUrl || message.photo) {
    if (!c.admin) return say(c, adminId(env) ? "Добавлять файлы может только владелец бота." : "Приём файлов пока настраивается.");
    if (message.photo) return say(c, "Сначала отправь PDF. Обложку я попрошу при добавлении тайтла.");
    return beginUpload(c, message);
  }
  if (text && !text.startsWith("/")) {
    if (text.length > 160) return say(c, "Напиши более короткое название или жанр.");
    const search = { id: randomId(), actor: c.actor, query: normalize(text), created_at: Date.now() };
    await run(c.db, "INSERT INTO sn_searches(id,actor,query,created_at) VALUES(?,?,?,?)",
      search.id, search.actor, search.query, search.created_at);
    return showCatalog(c, 0, search);
  }
  return say(c, "Выбери каталог или напиши название манги.", [[button("📚 Каталог", "catalog")]]);
}

async function showHome(c) {
  const rows = [
    [button("📚 Каталог", "catalog")],
    [button("🔍 Поиск", "search"), { text: "🔔 Подписка", url: CHANNEL }]
  ];
  if (c.admin) rows.push([button("Добавить главу", "admin:new")]);
  return say(c, "👋 Добро пожаловать в SashiNote!\n\n📚 Читай мангу\n🔍 Находи нужный тайтл\n🔔 Следи за новостями\n\nВыбери действие:", rows);
}

async function showCatalog(c, page = 0, search = null) {
  const where = search ? " WHERE title_key LIKE ? ESCAPE '\\' OR genre_key LIKE ? ESCAPE '\\'" : "";
  const pattern = search ? "%" + search.query.replace(/[\\%_]/g, "\\$&") + "%" : "";
  const args = search ? [pattern, pattern] : [];
  const count = await one(c.db, "SELECT COUNT(*) AS n FROM sn_titles" + where, ...args);
  const pages = Math.max(1, Math.ceil(count.n / PAGE_SIZE));
  page = clampPage(page, pages);
  const items = await all(c.db, "SELECT * FROM sn_titles" + where + " ORDER BY title_key,id LIMIT ? OFFSET ?", ...args, PAGE_SIZE, page * PAGE_SIZE);
  if (!items.length) {
    return say(c, search ? "Ничего не найдено. Попробуй другое название или жанр." : "В каталоге пока нет тайтлов.",
      [[button("🔍 Поиск", "search"), button("🏠 Главное меню", "home")]]);
  }
  const heading = search ? "🔍 Результаты поиска" : "📚 Каталог SashiNote";
  const text = heading + "\n\n" + items.map((item, i) => (i + 1) + ". " + item.title).join("\n")
    + "\n\nСтраница " + (page + 1) + "/" + pages;
  const rows = chunks(items.map((item, i) => button(String(i + 1), "title:" + item.id)), 3);
  const prefix = search ? "find:" + search.id + ":" : "catalog:";
  const navigation = [];
  if (page > 0) navigation.push(button("←", prefix + (page - 1)));
  navigation.push(button("🔍 Поиск", "search"));
  if (page + 1 < pages) navigation.push(button("→", prefix + (page + 1)));
  rows.push(navigation, [button("🏠 Главное меню", "home")]);
  return say(c, text, rows);
}

async function showTitle(c, id) {
  const title = await one(c.db, "SELECT * FROM sn_titles WHERE id=?", id);
  if (!title) return say(c, "Тайтл не найден.", [[button("📚 Каталог", "catalog")]]);
  return card(c, title, titleCaption(title), [
    [button("📖 Читать", "read:" + id)],
    [button("📚 Все главы", "chapters:" + id + ":0")],
    [button("← Каталог", "catalog")]
  ]);
}

async function showChapters(c, id, page = 0) {
  const title = await one(c.db, "SELECT * FROM sn_titles WHERE id=?", id);
  if (!title) return say(c, "Тайтл не найден.");
  const count = await one(c.db, "SELECT COUNT(*) AS n FROM sn_chapters WHERE title_id=?", id);
  const pages = Math.max(1, Math.ceil(count.n / PAGE_SIZE));
  page = clampPage(page, pages);
  const chapters = await all(c.db, "SELECT * FROM sn_chapters WHERE title_id=? ORDER BY volume,chapter_sort,id LIMIT ? OFFSET ?", id, PAGE_SIZE, page * PAGE_SIZE);
  const rows = chunks(chapters.map(ch => button(ch.volume + "–" + ch.chapter, "chapter:" + ch.id)), 3);
  const navigation = [];
  if (page > 0) navigation.push(button("←", "chapters:" + id + ":" + (page - 1)));
  if (page + 1 < pages) navigation.push(button("→", "chapters:" + id + ":" + (page + 1)));
  if (navigation.length) rows.push(navigation);
  rows.push([button("← К тайтлу", "title:" + id)]);
  return say(c, title.title + "\n\nТом — глава\nСтраница " + (page + 1) + "/" + pages, rows);
}

async function getChapter(c, id) {
  return one(c.db,
    "SELECT ch.*,t.title,t.kind,t.genres,t.cover FROM sn_chapters ch JOIN sn_titles t ON t.id=ch.title_id WHERE ch.id=?", id);
}

async function showChapter(c, id) {
  const chapter = await getChapter(c, id);
  if (!chapter) return say(c, "Глава не найдена.");
  return card(c, chapter, chapterCaption(chapter), [
    [button("📖 Читать", "pdf:" + id)],
    [button("📄 PDF", "pdf:" + id)],
    [button("📚 Все главы", "chapters:" + chapter.title_id + ":0")]
  ]);
}

async function sendPdf(c, id) {
  const ch = await getChapter(c, id);
  if (!ch) return say(c, "Глава не найдена.");
  const prev = await one(c.db, "SELECT id FROM sn_chapters WHERE title_id=? AND (volume < ? OR (volume=? AND chapter_sort < ?)) ORDER BY volume DESC,chapter_sort DESC LIMIT 1",
    ch.title_id, ch.volume, ch.volume, ch.chapter_sort);
  const next = await one(c.db, "SELECT id FROM sn_chapters WHERE title_id=? AND (volume > ? OR (volume=? AND chapter_sort > ?)) ORDER BY volume,chapter_sort LIMIT 1",
    ch.title_id, ch.volume, ch.volume, ch.chapter_sort);
  const navigation = [];
  if (prev) navigation.push(button("← Предыдущая", "pdf:" + prev.id));
  if (next) navigation.push(button("Следующая →", "pdf:" + next.id));
  const rows = navigation.length ? [navigation] : [];
  rows.push([button("📚 Все главы", "chapters:" + ch.title_id + ":0")], [button("← К тайтлу", "title:" + ch.title_id)]);
  return api(c.env, "sendDocument", {
    chat_id: c.chat, document: ch.file_id, caption: chapterCaption(ch),
    parse_mode: "HTML", reply_markup: { inline_keyboard: rows }
  });
}

async function beginUpload(c, message) {
  let document = message.document;
  if (!document) {
    let url;
    try { url = new URL(message.text.trim()); } catch { return say(c, "Отправь PDF файлом или прямую HTTPS-ссылку на него."); }
    if (url.protocol !== "https:" || url.username || url.password || url.href.length > 3000) {
      return say(c, "Нужна прямая HTTPS-ссылка на PDF.");
    }
    try {
      const uploaded = await api(c.env, "sendDocument", { chat_id: c.chat, document: url.href, protect_content: false });
      document = uploaded.document;
    } catch {
      return say(c, "Telegram не смог получить PDF по ссылке. Отправь сам файл. Ссылки на страницу сайта или вход в аккаунт не подходят.");
    }
  }
  if (!document?.file_id || !(document.mime_type === "application/pdf" || /\.pdf$/i.test(document.file_name || ""))) {
    return say(c, "Нужен PDF. Отправь его через скрепку → Файл.");
  }
  const unique = document.file_unique_id || document.file_id;
  const existing = await one(c.db, "SELECT ch.id,t.title,ch.volume,ch.chapter FROM sn_chapters ch JOIN sn_titles t ON t.id=ch.title_id WHERE ch.file_unique_id=? LIMIT 1", unique);
  if (existing) return say(c, "Этот PDF уже добавлен: " + existing.title + ", " + chapterLabel(existing) + ".");
  const draft = {
    id: randomId(), actor: c.actor, step: "title", last_update: c.uid,
    data: { chapter_id: randomId(), file_id: document.file_id, file_unique_id: unique, file_name: document.file_name || "chapter.pdf" }
  };
  await run(c.db, "INSERT INTO sn_drafts(actor,id,step,data,last_update) VALUES(?,?,?,?,?) ON CONFLICT(actor) DO UPDATE SET id=excluded.id,step=excluded.step,data=excluded.data,last_update=excluded.last_update",
    c.actor, draft.id, draft.step, JSON.stringify(draft.data), c.uid);
  return promptDraft(c, draft);
}

async function advanceDraft(c, draft, message) {
  const text = message.text?.trim() || "";
  const d = draft.data;
  if (draft.step === "title") {
    if (!validText(text, 160)) return say(c, "Напиши название манги текстом, до 160 символов.");
    const title = await one(c.db, "SELECT * FROM sn_titles WHERE title_key=?", normalize(text));
    d.title = title || { id: randomId(), title: clean(text), title_key: normalize(text), cover: "" };
    if (title) {
      d.source_label = title.source_label; d.source_url = title.source_url;
      return moveDraft(c, draft, "number");
    }
    return moveDraft(c, draft, "kind");
  }
  if (draft.step === "kind") {
    const kind = ["Манга", "Манхва", "Маньхуа", "Ранобэ"].find(k => normalize(k) === normalize(text));
    if (!kind) return promptDraft(c, draft);
    d.title.kind = kind;
    return moveDraft(c, draft, "genres");
  }
  if (draft.step === "genres") {
    if (!validText(text, 120)) return say(c, "Напиши жанры до 120 символов: например, Экшен, Фэнтези.");
    d.title.genres = clean(text); d.title.genre_key = normalize(text);
    return moveDraft(c, draft, "source");
  }
  if (draft.step === "source") {
    const source = parseSource(text);
    if (!source) return say(c, "Напиши источник: название проекта.\nСо ссылкой: Название проекта | https://t.me/имя_канала");
    d.source_label = source.label; d.source_url = source.url;
    if (!d.title.source_label) {
      d.title.source_label = source.label; d.title.source_url = source.url;
    }
    const next = d.return_to || "cover"; delete d.return_to;
    return moveDraft(c, draft, next);
  }
  if (draft.step === "cover") {
    if (text !== "/skip") {
      const photo = message.photo?.at(-1);
      if (!photo) return say(c, "Пришли обложку как фото. Или отправь /skip.");
      d.title.cover = photo.file_id; d.cover_changed = true;
    }
    const next = d.return_to || "number"; delete d.return_to;
    return moveDraft(c, draft, next);
  }
  if (draft.step === "number") {
    const numbers = parseNumbers(text);
    if (!numbers) return say(c, "Напиши номер главы, например: 12.\nЕсли нужен другой том — два числа: 2 12.");
    const duplicate = await one(c.db, "SELECT ch.id FROM sn_chapters ch JOIN sn_titles t ON t.id=ch.title_id WHERE t.title_key=? AND ch.volume=? AND ch.chapter=?",
      d.title.title_key, numbers.volume, numbers.chapter);
    if (duplicate) return say(c, "Эта глава уже есть. Напиши другой номер или /cancel.");
    Object.assign(d, numbers);
    return moveDraft(c, draft, "confirm");
  }
  return promptDraft(c, draft);
}

async function adminCallback(c, [, action, id, extra]) {
  if (!c.admin) return say(c, "Эта кнопка доступна только владельцу бота.");
  if (action === "new") {
    const current = await getDraft(c);
    return current && current.step !== "done" ? promptDraft(c, current) : say(c, "Отправь PDF файлом или прямую HTTPS-ссылку на PDF.");
  }
  const draft = await getDraft(c);
  if (!draft || draft.id !== id) return say(c, "Эта кнопка устарела. Отправь /admin.");
  if (action === "save") return publishDraft(c, draft);
  if (draft.step === "done") return promptDraft(c, draft);
  if (draft.last_update === c.uid) return promptDraft(c, draft);
  if (action === "cancel") {
    await run(c.db, "DELETE FROM sn_drafts WHERE actor=? AND id=?", c.actor, id);
    return say(c, "Добавление отменено.");
  }
  if (action === "kind" && draft.step === "kind") {
    const kind = ["Манга", "Манхва", "Маньхуа", "Ранобэ"][Number(extra)];
    if (!kind) return;
    draft.data.title.kind = kind;
    return moveDraft(c, draft, "genres");
  }
  if (action === "edit" && draft.step === "confirm" && ["cover", "number", "source"].includes(extra)) {
    if (extra !== "number") draft.data.return_to = "confirm";
    return moveDraft(c, draft, extra);
  }
  return promptDraft(c, draft);
}

async function promptDraft(c, draft) {
  const prompts = {
    title: "PDF получен. Как называется манга?\nНапиши название.",
    kind: "Выбери тип произведения:",
    genres: "Напиши жанры через запятую.",
    source: "Кто предоставил главы?\nНапиши название проекта. Можно добавить ссылку: Название | https://t.me/канал",
    cover: "Пришли обложку как фото. Выбери изображение, которое хочешь видеть на карточке.\n/skip — продолжить без новой обложки.",
    number: "Напиши номер главы.\nНапример: 12 → том 1, глава 12.\nИли два числа: 2 12 → том 2, глава 12.",
    done: "Эта глава уже сохранена. Можешь отправить следующий PDF."
  };
  if (draft.step === "confirm") {
    const ch = { ...draft.data.title, ...draft.data };
    ch.title = draft.data.title.title;
    return card(c, draft.data.title, "Предпросмотр\n\n" + chapterCaption(ch), [
      [button("Сохранить главу", "admin:save:" + draft.id)],
      [button("Другая обложка", "admin:edit:" + draft.id + ":cover")],
      [button("Изменить номер", "admin:edit:" + draft.id + ":number"), button("Источник", "admin:edit:" + draft.id + ":source")],
      [button("Отмена", "admin:cancel:" + draft.id)]
    ]);
  }
  const rows = draft.step === "kind"
    ? chunks(["Манга", "Манхва", "Маньхуа", "Ранобэ"].map((name, i) => button(name, "admin:kind:" + draft.id + ":" + i)), 2)
    : [];
  if (draft.step !== "done") rows.push([button("Отмена", "admin:cancel:" + draft.id)]);
  return say(c, prompts[draft.step] || "Отправь /admin.", rows);
}

async function publishDraft(c, draft) {
  if (draft.step === "done") return promptDraft(c, draft);
  if (draft.step !== "confirm") return promptDraft(c, draft);
  const d = draft.data;
  const t = d.title;
  const duplicate = await one(c.db, "SELECT ch.id FROM sn_chapters ch JOIN sn_titles t ON t.id=ch.title_id WHERE t.title_key=? AND ch.volume=? AND ch.chapter=?",
    t.title_key, d.volume, d.chapter);
  if (duplicate && duplicate.id !== d.chapter_id) return say(c, "Эта глава уже есть. Измени номер через предпросмотр или отправь /cancel.");
  const statements = [
    c.db.prepare("INSERT OR IGNORE INTO sn_titles(id,title_key,title,kind,genres,genre_key,source_label,source_url,cover) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(t.id, t.title_key, t.title, t.kind, t.genres, t.genre_key, t.source_label, t.source_url || "", t.cover || ""),
    c.db.prepare("INSERT INTO sn_chapters(id,title_id,volume,chapter,chapter_sort,file_id,file_unique_id,source_label,source_url,created_at) SELECT ?,id,?,?,?,?,?,?,?,? FROM sn_titles WHERE title_key=? ON CONFLICT(id) DO NOTHING")
      .bind(d.chapter_id, d.volume, d.chapter, Number(d.chapter), d.file_id, d.file_unique_id, d.source_label, d.source_url || "", Date.now(), t.title_key)
  ];
  if (d.cover_changed) statements.push(c.db.prepare("UPDATE sn_titles SET cover=? WHERE title_key=?").bind(t.cover, t.title_key));
  statements.push(c.db.prepare("UPDATE sn_drafts SET step='done',last_update=? WHERE actor=? AND id=?").bind(c.uid, c.actor, draft.id));
  await c.db.batch(statements);
  return say(c, "Глава сохранена: " + t.title + "\n" + chapterLabel(d) + "\n\nМожешь отправить следующий PDF.",
    [[button("Открыть главу", "chapter:" + d.chapter_id)], [button("📚 Каталог", "catalog")]]);
}

async function getDraft(c) {
  const row = await one(c.db, "SELECT * FROM sn_drafts WHERE actor=?", c.actor);
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}

async function moveDraft(c, draft, step) {
  const result = await run(c.db, "UPDATE sn_drafts SET step=?,data=?,last_update=? WHERE actor=? AND id=? AND last_update=?",
    step, JSON.stringify(draft.data), c.uid, c.actor, draft.id, draft.last_update);
  const current = result.meta.changes ? { ...draft, step, last_update: c.uid } : await getDraft(c);
  if (current) return promptDraft(c, current);
}

async function card(c, item, caption, rows) {
  if (item.cover) {
    return api(c.env, "sendPhoto", {
      chat_id: c.chat, photo: item.cover, caption, parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows }
    });
  }
  return say(c, caption, rows, true);
}

function titleCaption(t) {
  return "<b>" + html(t.title) + "</b>\n" + html(t.kind) + " · " + html(t.genres) + "\n\n" + sourceCaption(t);
}
function chapterCaption(ch) {
  return "<b>" + html(ch.title) + "</b>\n" + html(ch.kind) + " · " + html(ch.genres)
    + "\n" + html(chapterLabel(ch)) + "\n\n" + sourceCaption(ch);
}
function sourceCaption(item) {
  const label = html(item.source_label);
  return "Источник: " + (item.source_url ? '<a href="' + html(item.source_url) + '">' + label + "</a>" : label);
}
function chapterLabel(ch) { return "Том " + ch.volume + " · Глава " + ch.chapter; }
function button(text, callback_data) { return { text, callback_data }; }
function chunks(items, size) { return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size)); }
function clampPage(page, pages) { return Math.max(0, Math.min(Number.isFinite(page) ? Math.floor(page) : 0, pages - 1)); }
function clean(text) { return text.trim().replace(/\s+/g, " "); }
function normalize(text) { return clean(text).normalize("NFKC").toLowerCase().replace(/ё/g, "е"); }
function html(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function validText(text, limit) { return !!text && !text.startsWith("/") && clean(text).length <= limit; }
function randomId() { return crypto.randomUUID().replace(/-/g, "").slice(0, 16); }
function adminId(env) { const id = String(env.ADMIN_ID || "").trim(); return /^[1-9]\d{0,15}$/.test(id) ? id : ""; }
function parseNumbers(text) {
  const parts = text.replace(/,/g, ".").trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 2) return null;
  const volume = parts.length === 2 ? parts[0] : "1";
  const chapter = parts.at(-1);
  if (!/^[1-9]\d{0,3}$/.test(volume) || !/^\d{1,6}(?:\.\d{1,3})?$/.test(chapter)) return null;
  return { volume: Number(volume), chapter: String(Number(chapter)) };
}
function parseSource(text) {
  const parts = text.split("|").map(x => x.trim());
  if (parts.length > 2 || !validText(parts[0], 100)) return null;
  let url = "";
  if (parts.length === 2) {
    try {
      const parsed = new URL(parts[1]);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.href.length > 300) return null;
      url = parsed.href;
    } catch { return null; }
  }
  return { label: clean(parts[0]), url };
}
async function say(c, text, rows = [], formatted = false) {
  return api(c.env, "sendMessage", {
    chat_id: c.chat, text,
    ...(formatted ? { parse_mode: "HTML" } : {}),
    link_preview_options: { is_disabled: true },
    ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {})
  });
}
async function api(env, method, data = {}) {
  if (["sendMessage", "sendPhoto", "sendDocument"].includes(method)) {
    data = { ...data, protect_content: data.protect_content ?? (String(data.chat_id) !== adminId(env)) };
  }
  const response = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(data), signal: AbortSignal.timeout(20000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    const error = new Error("Telegram request failed");
    error.apiMethod = method; error.apiCode = result.error_code || response.status;
    throw error;
  }
  return result.result;
}
async function webhookSecret(token) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("SashiNote webhook v1:" + token));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
function sameSecret(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return diff === 0;
}
async function initDatabase(db) {
  if (!READY.has(db)) READY.set(db, db.batch(SCHEMA.map(sql => db.prepare(sql))).catch(error => { READY.delete(db); throw error; }));
  return READY.get(db);
}
function one(db, sql, ...args) { return db.prepare(sql).bind(...args).first(); }
async function all(db, sql, ...args) { return (await db.prepare(sql).bind(...args).all()).results; }
function run(db, sql, ...args) { return db.prepare(sql).bind(...args).run(); }
