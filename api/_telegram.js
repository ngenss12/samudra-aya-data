export async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return {
      ok: false,
      reason: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing",
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      ok: false,
      reason: result?.description || `Telegram HTTP ${response.status}`,
      result,
    };
  }

  return { ok: true, result };
}