import "dotenv/config";
import cron from "node-cron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { browseFBVehicles, getFBListingDetail, getFBMedianPrice, loadCookies, clearMedianCache, AUTO_QUERIES, MOTO_QUERIES } from "./fb-graphql";
import { analyzeListing, AnalysisResult, ListingInput } from "./analyzer";
import { sendAlert, sendDailySummary } from "./telegram";
import { FBListing } from "./facebook";

// ── Configuración ──────────────────────────────────────────────
const CONFIG = {
  autos: {
    maxHoursOld: 6,
    priceMinARS: 3_000_000,
    priceMaxARS: 20_000_000,
    minScore: 7.5,             // subido de 6 → menos spam, más calidad
    maxAlertsPerCycle: 3,      // máximo 3 alertas por ciclo
    queries: AUTO_QUERIES,
  },
  motos: {
    maxHoursOld: 6,
    priceMinARS: 1_500_000,
    priceMaxARS: 12_000_000,
    minScore: 7.5,
    maxAlertsPerCycle: 2,
    queries: MOTO_QUERIES,
  },
};

const POLL_INTERVAL = "*/30 * * * *"; // cada 30 minutos
const SUMMARY_TIME  = "0 20 * * *";   // resumen diario a las 20hs
// ──────────────────────────────────────────────────────────────

// IDs ya vistos — persisten en disco para sobrevivir reinicios
const SEEN_FILE = join(__dirname, "../seen-ids.json");

function loadSeen(): { autos: Set<string>; motos: Set<string> } {
  if (existsSync(SEEN_FILE)) {
    try {
      const data = JSON.parse(readFileSync(SEEN_FILE, "utf-8"));
      return {
        autos: new Set(data.autos ?? []),
        motos: new Set(data.motos ?? []),
      };
    } catch { /* ignorar */ }
  }
  return { autos: new Set(), motos: new Set() };
}

function saveSeen() {
  writeFileSync(SEEN_FILE, JSON.stringify({
    autos: [...seenAutos],
    motos: [...seenMotos],
  }));
}

const { autos: seenAutos, motos: seenMotos } = loadSeen();
console.log(`  IDs en memoria: ${seenAutos.size} autos, ${seenMotos.size} motos`);

// Mutex para evitar ciclos superpuestos
let isRunning = false;

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

// Frases que delatan concesionarias/revendedores en título o descripción
const DEALER_BLACKLIST = [
  "automotores", "autoparque", "concesionaria", "agencia",
  "garage ", "somos ", "stock físico", "stock fisico",
  "tomo su usado", "tomamos usado", "coordinar visita",
  "unidad en stock", "entrega inmediata", "financiamos con dni",
  "financiamos 100%", "todos nuestros autos",
  // financieras y cuotas
  "cuotas fijas", "cuotas desde", "con o sin veraz", "sin veraz",
  "retira con un anticipo", "retiro con dni", "financio en cuotas",
  "tasa 0", "anticipo y cuotas", "financiación en pesos",
  // dealers con emojis típicos
  "stock físico 🚗", "vendo ya!!", "liquido ya",
];

function passesTitleFilter(title: string): boolean {
  const lower = title.toLowerCase();
  return !TITLE_BLACKLIST.some((w) => lower.includes(w));
}

function passesDealer(title: string, description: string): boolean {
  const text = (title + " " + description).toLowerCase();
  const isDealer = DEALER_BLACKLIST.some((w) => text.includes(w));
  return !isDealer;
}

function isRecent(dateStr: string | null, maxHoursOld: number): boolean {
  if (!dateStr) return true; // sin fecha → FB ya ordena por recencia, lo dejamos pasar
  const cutoff = Date.now() - maxHoursOld * 60 * 60 * 1000;
  return new Date(dateStr).getTime() >= cutoff;
}

async function runCategory(
  name: string,
  config: typeof CONFIG.autos & { maxAlertsPerCycle: number },
  seen: Set<string>
) {
  // Paso 1: browse categoría con queries específicas (autos o motos)
  const allListings = await browseFBVehicles({
    radiusKm: 50,
    sortBy: "creation_time_descend",
    maxItems: 60,
    queries: config.queries,
  });

  let alertsThisCycle = 0;

  // Paso 2: filtros básicos con debug
  let nSeen = 0, nTitle = 0, nPrice = 0, nDate = 0;
  const candidates = allListings.filter((l) => {
    if (seen.has(l.id))                                              { nSeen++;  return false; }
    if (!passesTitleFilter(l.title))                                 { nTitle++; return false; }
    if (l.price < config.priceMinARS || l.price > config.priceMaxARS) { nPrice++; return false; }
    if (!isRecent(l.date_created, config.maxHoursOld))               { nDate++;  return false; }
    return true;
  });

  console.log(`  [${name}] ${allListings.length} del feed → ${candidates.length} pasan filtros`);
  if (candidates.length === 0) {
    console.log(`    ↳ ya vistos: ${nSeen} | blacklist: ${nTitle} | precio: ${nPrice} | fecha: ${nDate}`);
  }

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

      // Paso 3.5: filtrar concesionarias/revendedores por descripción
      if (!passesDealer(enriched.title, enriched.description ?? "")) {
        console.log(`    🏪 Dealer/concesionaria — ${enriched.title.slice(0, 50)}`);
        continue;
      }

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

      // Paso 7: alerta Telegram (con límite por ciclo)
      if (analysis.isDeal && analysis.score >= config.minScore && alertsThisCycle < config.maxAlertsPerCycle) {
        await sendAlert(enriched as any, analysis);
        approvedToday.push({ listing: input, analysis });
        alertsThisCycle++;
        console.log(`    📬 Alerta enviada (${alertsThisCycle}/${config.maxAlertsPerCycle})`);
      }

      await new Promise((r) => setTimeout(r, 1200));
    } catch (err: any) {
      console.error(`    Error en ${listing.id}: ${err.message}`);
    }
  }

  // Guardar IDs vistos en disco para sobrevivir reinicios
  saveSeen();
}

async function run() {
  if (isRunning) {
    console.log(`\n[ciclo anterior todavía corriendo, saltando...]`);
    return;
  }
  isRunning = true;

  const now = new Date().toLocaleTimeString("es-AR");
  console.log(`\n[${now}] Iniciando ciclo...`);

  clearMedianCache();

  try {
    await runCategory("Autos", CONFIG.autos, seenAutos);
  } catch (err: any) {
    console.error(`  [Autos] Error en ciclo: ${err.message}`);
  }

  try {
    await runCategory("Motos", CONFIG.motos, seenMotos);
  } catch (err: any) {
    console.error(`  [Motos] Error en ciclo: ${err.message}`);
  }

  console.log(`  Total analizados hoy: ${totalAnalyzed}`);
  isRunning = false;
}

async function resetDaily() {
  await sendDailySummary(totalAnalyzed, approvedToday as any);
  totalAnalyzed = 0;
  approvedToday.length = 0;
  console.log("Resumen diario enviado, contadores reiniciados");
}

// Servidor HTTP mínimo para que Railway no mate el proceso
import http from "http";
const PORT = process.env.PORT || 3000;
http.createServer((_, res) => { res.writeHead(200); res.end("ok"); }).listen(PORT);

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
