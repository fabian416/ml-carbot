import axios from "axios";
import { AnalysisResult } from "./analyzer";

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Escapa caracteres que rompen HTML de Telegram
function esc(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface ListingBase {
  title: string;
  price: number;
  permalink: string;
  currency?: string;
  currency_id?: string;
}

export async function sendAlert(listing: ListingBase, analysis: AnalysisResult) {
  const scoreEmoji = analysis.score >= 8 ? "🔥" : analysis.score >= 6 ? "✅" : "⚠️";
  const currency = listing.currency ?? listing.currency_id ?? "ARS";

  const positives = analysis.positives?.length > 0
    ? `\n✅ <b>Puntos positivos:</b>\n${analysis.positives.map((p) => `  • ${esc(p)}`).join("\n")}`
    : "";

  const flags = analysis.redFlags?.length > 0
    ? `\n🚩 <b>Red flags:</b>\n${analysis.redFlags.map((f) => `  • ${esc(f)}`).join("\n")}`
    : "\n✅ <b>Sin red flags detectadas</b>";

  const message = `${scoreEmoji} <b>Nueva oferta — Score ${analysis.score}/10</b>

<b>${esc(listing.title)}</b>
💰 $${listing.price.toLocaleString("es-AR")} ${currency}

📋 ${esc(analysis.summary)}
${positives}${flags}

📊 <b>Precio:</b> ${esc(analysis.priceAnalysis)}
💬 <b>Para negociar:</b> ${esc(analysis.negotiationArg)}

💡 <b>Recomendación:</b> ${esc(analysis.recommendation)}

🔗 <a href="${listing.permalink}">Ver publicación</a>`;

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  });
}

export async function sendDailySummary(
  total: number,
  approved: Array<{ listing: ListingBase; analysis: AnalysisResult }>
) {
  const currency = "ARS";

  if (approved.length === 0) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: `📊 <b>Resumen del día</b>\n\nAnalicé ${total} publicaciones.\nNinguna pasó todos los filtros hoy.`,
      parse_mode: "HTML",
    });
    return;
  }

  const items = approved
    .map(
      ({ listing, analysis }, i) =>
        `${i + 1}. <b>${esc(listing.title)}</b>\n   💰 $${listing.price.toLocaleString("es-AR")} ${currency} — Score ${analysis.score}/10\n   💡 ${esc(analysis.recommendation)}\n   🔗 <a href="${listing.permalink}">Ver</a>`
    )
    .join("\n\n");

  const message = `📊 <b>Resumen del día</b>

Analicé <b>${total}</b> publicaciones
Pasaron los filtros: <b>${approved.length}</b>

${items}`;

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}
