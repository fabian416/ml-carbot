import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = readFileSync(
  join(__dirname, "../AGENT_PROMPT.md"),
  "utf-8"
);

export interface AnalysisResult {
  isDeal: boolean;
  score: number;
  summary: string;
  positives: string[];
  redFlags: string[];
  priceAnalysis: string;
  negotiationArg: string;
  recommendation: string;
}

// Interfaz mínima que aceptamos — funciona tanto para FB como para ML
export interface ListingInput {
  id: string;
  title: string;
  price: number;
  permalink: string;
  description?: string;
  currency?: string;      // "ARS" | "USD" — default ARS
  condition?: string;
  year?: string;
  km?: string;
  brand?: string;
  model?: string;
}

export async function analyzeListing(
  listing: ListingInput,
  medianPrice?: number
): Promise<AnalysisResult> {
  // Extraer año del título si no viene explícito
  const year = listing.year ??
    listing.title.match(/\b(19|20)\d{2}\b/)?.[0] ?? "N/A";

  // Extraer km del título/descripción si no viene explícito
  const kmMatch = (listing.description ?? listing.title)
    .match(/(\d[\d.,]+)\s*(km|kilómetros|kilometros)/i);
  const km = listing.km ?? kmMatch?.[1] ?? "N/A";

  const currency = listing.currency ?? "ARS";

  const priceContext = medianPrice
    ? `- Mediana del mercado (ML histórico): $${medianPrice.toLocaleString("es-AR")} ${currency}
- Diferencia vs mediana: ${(((listing.price - medianPrice) / medianPrice) * 100).toFixed(1)}%`
    : "- Sin datos de mediana disponibles";

  const descriptionSection = listing.description
    ? `\nDESCRIPCIÓN DEL VENDEDOR:\n${listing.description.slice(0, 1500)}`
    : "";

  const prompt = `Analizá esta publicación como el perito experto que sos.

DATOS DE LA PUBLICACIÓN:
- Título: ${listing.title}
- Precio: $${listing.price.toLocaleString("es-AR")} ${currency}
- Condición: ${listing.condition ?? "usado"}
- Año: ${year}
- Kilómetros: ${km}
- Marca: ${listing.brand ?? "N/A"}
- Modelo: ${listing.model ?? "N/A"}
- Link: ${listing.permalink}
${descriptionSection}

CONTEXTO DE MERCADO:
${priceContext}

Respondé SOLO con un JSON con esta estructura exacta (sin texto antes ni después):
{
  "isDeal": boolean,
  "score": número entre 1 y 10,
  "summary": "veredicto en 1 oración directa",
  "positives": ["máximo 3 puntos positivos"],
  "redFlags": ["todas las red flags que detectes, vacío si no hay"],
  "priceAnalysis": "análisis del precio vs mercado en 1 oración",
  "negotiationArg": "el argumento más fuerte para bajar el precio",
  "recommendation": "contactar / ignorar / contactar con cautela + razón"
}`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  const text = (message.content[0] as { text: string }).text;
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  return JSON.parse(json) as AnalysisResult;
}
