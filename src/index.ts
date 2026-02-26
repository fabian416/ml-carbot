import "dotenv/config";
import cron from "node-cron";
import { browseFBVehicles, getFBListingDetail, getFBMedianPrice, loadCookies, clearMedianCache, AUTO_QUERIES, MOTO_QUERIES } from "./fb-graphql";
import { analyzeListing, AnalysisResult, ListingInput } from "./analyzer";
import { sendAlert, sendDailySummary } from "./telegram";
import { FBListing } from "./facebook";

// ── Configuración ──────────────────────────────────────────────
const CONFIG = {
  autos: {
    maxHoursOld: 24,
    priceMinARS: 3_000_000,    // $3M ARS  (~$2.300 USD)
    priceMaxARS: 20_000_000,   // $20M ARS (~$15.000 USD)
    minScore: 6,               // bajado de 7 → más alertas
    queries: AUTO_QUERIES,
  },
  motos: {
    maxHoursOld: 24,
    priceMinARS: 1_500_000,    // $1.5M ARS → cubre motos medianas
    priceMaxARS: 12_000_000,   // $12M ARS
    minScore: 6,
    queries: MOTO_QUERIES,
  },
};

const POLL_INTERVAL = "*/30 * * * *"; // cada 30 minutos
const SUMMARY_TIME  = "0 20 * * *";   // resumen diario a las 20hs
// ──────────────────────────────────────────────────────────────

// IDs ya vistos para no analizar dos veces
const seen = new Set<string>();

let totalAnalyzed = 0;
const approvedToday: Array<{ listing: ListingInput; analysis: AnalysisResult }> = [];

// Blacklist de títulos que no valen la pena
const TITLE_BLACKLIST = [
  "repuesto", "repuestos", "chocado", "accidentado",
  "a reparar", "sin motor", "para reparar", "no arranca",
  "quemado", "inundado", "solo partes", "en partes",
  "chatarra", "polarizado", "accesorios", "cuotas fijas",
  "joya", "nunca taxi", "anticipo", "financiacion", "financiación",
];

function passesTitleFilter(title: string): boolean {
  const lower = title.toLowerCase();
  return !TITLE_BLACKLIST.some((w) => lower.includes(w));
}

function isRecent(dateStr: string, maxHoursOld: number): boolean {
  const cutoff = Date.now() - maxHoursOld * 60 * 60 * 1000;
  return new Date(dateStr).getTime() >= cutoff;
}

async function runCategory(
  name: string,
  config: typeof CONFIG.autos
) {
  // Paso 1: browse categoría con queries específicas (autos o motos)
  const allListings = await browseFBVehicles({
    radiusKm: 50,
    sortBy: "creation_time_descend",
    maxItems: 60,
    queries: config.queries,
  });

  // Paso 2: filtros básicos (precio ARS, recencia, blacklist, ya vistos)
  const candidates = allListings.filter((l) => {
    if (seen.has(l.id)) return false;
    if (!passesTitleFilter(l.title)) return false;
    if (l.price < config.priceMinARS || l.price > config.priceMaxARS) return false;
    if (!isRecent(l.date_created, config.maxHoursOld)) return false;
    return true;
  });

  console.log(`  [${name}] ${allListings.length} del feed → ${candidates.length} pasan filtros`);

  if (candidates.length === 0) return;

  // Marcar todos como vistos ANTES de procesar para evitar duplicados entre ciclos
  candidates.forEach((l) => seen.add(l.id));

  const { cookieStr } = loadCookies();

  for (const listing of candidates) {
    totalAnalyzed++;

    try {
      // Paso 3: traer detalle completo del listing (descripción, km, año, fotos)
      const detail = await getFBListingDetail(listing.id, cookieStr);
      const enriched: FBListing = {
        ...listing,
        description: detail.description || listing.description || "",
        images: detail.images?.length ? detail.images : listing.images ?? [],
      };

      // Paso 4: mediana de precios en Facebook para el mismo modelo
      const medianPrice = await getFBMedianPrice(enriched.title);

      const medianLog = medianPrice
        ? `mediana FB: $${medianPrice.toLocaleString("es-AR")} | diff: ${(((enriched.price - medianPrice) / medianPrice) * 100).toFixed(1)}%`
        : "mediana FB: no disponible";
      console.log(`    📊 ${medianLog} | precio: $${enriched.price.toLocaleString("es-AR")}`);

      // Paso 5: descartar si está caro (ahorra tokens de Claude)
      if (medianPrice && enriched.price > medianPrice * 1.2) {
        console.log(`    ⏭️  Caro vs mediana — ${enriched.title.slice(0, 50)}`);
        continue;
      }

      // Paso 6: análisis profundo con Claude
      const input: ListingInput = {
        ...enriched,
        currency: "ARS",
        condition: "usado",
        year: (detail as any).year,
        km: (detail as any).km,
      };

      const analysis = await analyzeListing(input, medianPrice);

      const emoji = analysis.score >= 8 ? "🔥" : analysis.score >= 6 ? "✅" : "❌";
      console.log(`    ${emoji} Score ${analysis.score}/10 — ${enriched.title.slice(0, 60)}`);
      console.log(`       $${enriched.price.toLocaleString("es-AR")} ARS | ${enriched.permalink}`);
      if (enriched.description) {
        console.log(`       "${enriched.description.slice(0, 80)}..."`);
      }

      // Paso 7: alerta Telegram
      if (analysis.isDeal && analysis.score >= config.minScore) {
        await sendAlert(enriched as any, analysis);
        approvedToday.push({ listing: input, analysis });
        console.log(`    📬 Alerta enviada`);
      }

      await new Promise((r) => setTimeout(r, 1200));
    } catch (err: any) {
      console.error(`    Error en ${listing.id}: ${err.message}`);
    }
  }
}

async function run() {
  const now = new Date().toLocaleTimeString("es-AR");
  console.log(`\n[${now}] Iniciando ciclo...`);

  clearMedianCache(); // limpiar cache de medianas en cada ciclo

  await runCategory("Autos", CONFIG.autos);
  await runCategory("Motos", CONFIG.motos);

  console.log(`  Total analizados hoy: ${totalAnalyzed}`);
}

async function resetDaily() {
  await sendDailySummary(totalAnalyzed, approvedToday as any);
  totalAnalyzed = 0;
  approvedToday.length = 0;
  console.log("Resumen diario enviado, contadores reiniciados");
}

// Arranque inmediato
run();

// Polling cada 30 minutos
cron.schedule(POLL_INTERVAL, run);

// Resumen diario a las 20hs
cron.schedule(SUMMARY_TIME, resetDaily);

console.log("🤖 Bot corriendo:");
console.log(`  Autos: últimas ${CONFIG.autos.maxHoursOld}hs | $${(CONFIG.autos.priceMinARS / 1_000_000).toFixed(1)}M-$${(CONFIG.autos.priceMaxARS / 1_000_000).toFixed(0)}M ARS | minScore ${CONFIG.autos.minScore}`);
console.log(`  Motos: últimas ${CONFIG.motos.maxHoursOld}hs | $${(CONFIG.motos.priceMinARS / 1_000).toFixed(0)}k-$${(CONFIG.motos.priceMaxARS / 1_000_000).toFixed(1)}M ARS | minScore ${CONFIG.motos.minScore}`);
console.log(`  Polling: cada 30 min | Resumen: 20:00hs | Threshold mediana: 1.2x`);
