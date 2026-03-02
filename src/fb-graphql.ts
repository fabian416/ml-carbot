import axios from "axios";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { FBListing } from "./facebook";

const BA_LAT = -34.6037;
const BA_LNG = -58.3816;

export const AUTO_QUERIES = [
  "Toyota", "Volkswagen", "Chevrolet", "Ford",
  "Renault", "Peugeot", "Fiat", "Honda",
  "auto usado", "camioneta", "Nissan", "Citroën",
];

export const MOTO_QUERIES = [
  "Honda CB", "Yamaha", "Kawasaki", "Zanella",
  "Motomel", "Beta moto", "KTM", "Bajaj",
  "moto usada", "enduro", "naked", "Royal Enfield",
];

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";

// doc_id para búsqueda/browse del feed de marketplace
const DOC_ID_SEARCH = "7111939778879383";

const BASE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "accept-language": "es-AR,es;q=0.9",
  "accept-encoding": "gzip, deflate, br",
};

function buildCookieString(cookies: any[]): string {
  return cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
}

// ─── Tokens de sesión ──────────────────────────────────────────
async function getPageTokens(
  cookieStr: string,
  attempt = 1
): Promise<{ lsd: string; dtsg: string; userId: string }> {
  try {
    const res = await axios.get("https://www.facebook.com/marketplace/", {
      headers: {
        ...BASE_HEADERS,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "cookie": cookieStr,
      },
      timeout: 25000,
      decompress: true,
    });
    const html: string = res.data;
    const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1] ?? "";
    const dtsg =
      html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/)?.[1] ??
      html.match(/name="fb_dtsg" value="([^"]+)"/)?.[1] ?? "";
    const userId =
      html.match(/"USER_ID":"(\d+)"/)?.[1] ??
      html.match(/"userID":"(\d+)"/)?.[1] ?? "";
    return { lsd, dtsg, userId };
  } catch (err: any) {
    const retryable = ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ERR_NETWORK"].includes(err.code ?? "");
    if (retryable && attempt <= 3) {
      const wait = attempt * 4000;
      console.log(`  FB: conexión cortada (${err.code}), reintentando en ${wait / 1000}s... (intento ${attempt}/3)`);
      await new Promise((r) => setTimeout(r, wait));
      return getPageTokens(cookieStr, attempt + 1);
    }
    throw err;
  }

}

// ─── Browse por categoría (sin texto, todos los vehículos) ─────
export async function browseFBVehicles(opts: {
  radiusKm: number;
  priceMin?: number;
  priceMax?: number;
  maxItems?: number;
  sortBy?: "creation_time_descend" | "price_ascend" | "price_descend";
  queries?: string[];
}): Promise<FBListing[]> {

  console.log(`  FB: browsing categoría vehículos en BA, radio ${opts.radiusKm}km...`);

  const session = await getSession();
  if (!session) { console.log("  FB: sin sesión"); return []; }
  const { lsd, dtsg, userId, cookieStr } = session;

  // Múltiples queries amplias para capturar todo tipo de vehículo
  const VEHICLE_QUERIES = opts.queries ?? AUTO_QUERIES;

  const allSeen = new Set<string>();
  const allResults: FBListing[] = [];

  for (const query of VEHICLE_QUERIES) {
    const variables = {
      count: Math.ceil((opts.maxItems ?? 48) / VEHICLE_QUERIES.length),
      params: {
        bqf: { callsite: "COMMERCE_MKTPLACE_WWW", query },
        browse_request_params: {
          commerce_enable_local_pickup: true,
          commerce_enable_shipping: false,
          filter_location_latitude: BA_LAT,
          filter_location_longitude: BA_LNG,
          filter_radius_km: opts.radiusKm,
          ...(opts.priceMin !== undefined && { filter_price_min_amount: opts.priceMin }),
          ...(opts.priceMax !== undefined && { filter_price_max_amount: opts.priceMax }),
        },
        custom_request_params: { surface: "SEARCH" },
      },
    };

    const results = await callGraphQL(variables, { lsd, dtsg, userId, cookieStr });
    for (const r of results) {
      if (!allSeen.has(r.id)) {
        allSeen.add(r.id);
        allResults.push(r);
      }
    }
    // Pausa entre queries para evitar rate limit de FB
    await new Promise((r) => setTimeout(r, 2500));
  }

  return allResults;
}

// ─── Búsqueda por texto (fallback) ────────────────────────────
export async function scrapeFBGraphQL(opts: {
  query: string;
  radiusKm: number;
  priceMin: number;
  priceMax: number;
  maxItems?: number;
}): Promise<FBListing[]> {
  const cookiesPath = join(__dirname, "../fb-cookies.json");
  if (!existsSync(cookiesPath)) return [];

  const cookies = JSON.parse(readFileSync(cookiesPath, "utf-8"));
  const cookieStr = buildCookieString(cookies);

  console.log(`  FB: buscando "${opts.query}"...`);

  let lsd = "", dtsg = "", userId = "";
  try {
    ({ lsd, dtsg, userId } = await getPageTokens(cookieStr));
  } catch { /* ignorar */ }

  const variables = {
    count: opts.maxItems ?? 24,
    params: {
      bqf: { callsite: "COMMERCE_MKTPLACE_WWW", query: opts.query },
      browse_request_params: {
        commerce_enable_local_pickup: true,
        commerce_enable_shipping: false,
        filter_location_latitude: BA_LAT,
        filter_location_longitude: BA_LNG,
        filter_price_max_amount: opts.priceMax,
        filter_price_min_amount: opts.priceMin,
        filter_radius_km: opts.radiusKm,
      },
      custom_request_params: { surface: "SEARCH" },
    },
  };

  return callGraphQL(variables, { lsd, dtsg, userId, cookieStr });
}

// ─── Detalle de una publicación individual ────────────────────
export async function getFBListingDetail(
  listingId: string,
  cookieStr: string
): Promise<Partial<FBListing>> {
  try {
    const res = await axios.get(
      `https://www.facebook.com/marketplace/item/${listingId}/`,
      {
        headers: {
          ...BASE_HEADERS,
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none",
          "cookie": cookieStr,
        },
        timeout: 15000,
        decompress: true,
      }
    );

    const html: string = res.data;

    // Descripción completa
    const descMatch =
      html.match(/"redacted_description"\s*:\s*\{"text"\s*:\s*"((?:[^"\\]|\\.)*)"/s) ??
      html.match(/"description"\s*:\s*"((?:[^"\\]|\\.){20,1500})"/s);
    const description = descMatch
      ? descMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"')
      : "";

    // Imágenes adicionales
    const imgMatches = [...html.matchAll(/"uri"\s*:\s*"(https:\/\/scontent[^"]+)"/g)];
    const images = [...new Set(imgMatches.map((m) => m[1]))].slice(0, 8);

    // Km del texto
    const kmMatch = html.match(/(\d[\d.,]+)\s*(km|kilómetros|kilometros)/i);
    const km = kmMatch?.[1];

    // Año del texto
    const yearMatch = html.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch?.[0];

    return { description, images, ...(km && { km }), ...(year && { year }) };
  } catch {
    return {};
  }
}

// ─── Mediana de precio en Facebook ───────────────────────────
// Busca autos similares en FB y devuelve la mediana de precios
// Sesión cacheada para reusar tokens en todo un ciclo
interface SessionCache {
  lsd: string; dtsg: string; userId: string; cookieStr: string;
  expiresAt: number;
}
let _session: SessionCache | null = null;

export async function getSession(): Promise<SessionCache | null> {
  // Reusar sesión por 10 minutos
  if (_session && Date.now() < _session.expiresAt) return _session;

  let cookies: any[];
  if (process.env.FB_COOKIES_B64) {
    cookies = JSON.parse(Buffer.from(process.env.FB_COOKIES_B64, "base64").toString("utf-8"));
  } else if (process.env.FB_COOKIES) {
    cookies = JSON.parse(process.env.FB_COOKIES);
  } else {
    const cookiesPath = join(__dirname, "../fb-cookies.json");
    if (!existsSync(cookiesPath)) return null;
    cookies = JSON.parse(readFileSync(cookiesPath, "utf-8"));
  }
  const cookieStr = buildCookieString(cookies);

  const { lsd, dtsg, userId } = await getPageTokens(cookieStr);
  _session = { lsd, dtsg, userId, cookieStr, expiresAt: Date.now() + 10 * 60 * 1000 };
  return _session;
}

// Cache de medianas para no repetir queries del mismo modelo en un ciclo
const _medianCache = new Map<string, number | null>();

export function clearMedianCache() {
  _medianCache.clear();
}

function extractVehicleQuery(title: string): string {
  const yearMatch = title.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch?.[0] ?? "";

  // Limpiar: sacar año, emojis, palabras de relleno
  const NOISE = /oportunidad|liquido|vendo|permuto|financio|urgente|full|manual|automatico|automatica|gnc|nafta|diesel|unico|segunda|mano|impecable|excelente|listo|oferta|titular|usado|usada/gi;
  const words = title
    .replace(/\b(19|20)\d{2}\b/g, "")   // quitar año
    .replace(/[^a-zA-Z0-9 ]/g, " ")      // quitar caracteres especiales
    .replace(NOISE, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 3);

  return `${words.join(" ")} ${year}`.trim();
}

export async function getFBMedianPrice(
  title: string,
  radiusKm = 80
): Promise<number | undefined> {
  const query = extractVehicleQuery(title);
  if (query.length < 5) return undefined;

  // Retornar del cache si ya lo buscamos
  if (_medianCache.has(query)) {
    const cached = _medianCache.get(query);
    return cached ?? undefined;
  }

  const session = await getSession();
  if (!session) return undefined;

  // Pausa breve para no saturar Facebook
  await new Promise((r) => setTimeout(r, 600));

  const variables = {
    count: 20,
    params: {
      bqf: { callsite: "COMMERCE_MKTPLACE_WWW", query },
      browse_request_params: {
        commerce_enable_local_pickup: true,
        commerce_enable_shipping: false,
        filter_location_latitude: BA_LAT,
        filter_location_longitude: BA_LNG,
        filter_radius_km: radiusKm,
      },
      custom_request_params: { surface: "SEARCH" },
    },
  };

  const results = await callGraphQL(variables, session);

  const prices = results
    .map((r) => r.price)
    .filter((p) => p > 500_000)
    .sort((a, b) => a - b);

  if (prices.length < 3) {
    _medianCache.set(query, null);
    return undefined;
  }

  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 !== 0
    ? prices[mid]
    : (prices[mid - 1] + prices[mid]) / 2;

  _medianCache.set(query, median);
  return median;
}

// ─── Helpers privados ─────────────────────────────────────────

// Carga las cookies desde env var o archivo local
export function loadCookies(): { cookies: any[]; cookieStr: string } {
  let cookies: any[];
  if (process.env.FB_COOKIES_B64) {
    cookies = JSON.parse(Buffer.from(process.env.FB_COOKIES_B64, "base64").toString("utf-8"));
  } else if (process.env.FB_COOKIES) {
    cookies = JSON.parse(process.env.FB_COOKIES);
  } else {
    const cookiesPath = join(__dirname, "../fb-cookies.json");
    cookies = JSON.parse(readFileSync(cookiesPath, "utf-8"));
  }
  return { cookies, cookieStr: buildCookieString(cookies) };
}

async function callGraphQL(
  variables: object,
  auth: { lsd: string; dtsg: string; userId: string; cookieStr: string }
): Promise<FBListing[]> {
  const body = new URLSearchParams({
    doc_id: DOC_ID_SEARCH,
    variables: JSON.stringify(variables),
    ...(auth.lsd ? { lsd: auth.lsd } : {}),
    ...(auth.dtsg ? { fb_dtsg: auth.dtsg } : {}),
    ...(auth.userId ? { __user: auth.userId } : {}),
    __a: "1",
    __req: "1",
    __ccg: "GOOD",
  });

  const res = await axios.post(GRAPHQL_URL, body.toString(), {
    headers: {
      ...BASE_HEADERS,
      "content-type": "application/x-www-form-urlencoded",
      "accept": "*/*",
      "origin": "https://www.facebook.com",
      "referer": "https://www.facebook.com/marketplace/",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "x-fb-lsd": auth.lsd,
      "cookie": auth.cookieStr,
    },
    timeout: 20000,
    decompress: true,
    responseType: "text",
  });

  let parsed: any;
  try {
    const raw = String(res.data);
    const lines = raw.split("\n").filter((l) => l.trim().startsWith("{"));
    parsed = JSON.parse(lines[0] ?? raw);
  } catch {
    console.log("  FB: error parseando respuesta");
    return [];
  }

  // Debug: mostrar claves top-level de la respuesta
  const topKeys = Object.keys(parsed?.data ?? {});
  console.log(`  FB debug: data keys=${JSON.stringify(topKeys)} | errors=${JSON.stringify(parsed?.errors?.map((e:any)=>e.message) ?? [])}`);

  const edges: any[] =
    parsed?.data?.marketplace_search?.feed_units?.edges ??
    parsed?.data?.viewer?.marketplace_feed_stories?.edges ??
    [];

  return edges
    .map((edge: any) => {
      const listing = edge?.node?.listing ?? edge?.node;
      if (!listing?.id) return null;

      const rawPrice =
        listing.listing_price?.formatted_amount ??
        listing.listing_price?.amount_with_offset_in_currency ?? "0";
      const price = parseInt(String(rawPrice).replace(/[^0-9]/g, ""), 10) || 0;
      const currency: string =
        listing.listing_price?.currency ??
        listing.listing_price?.currency_id ?? "ARS";

      // Convertir USD a ARS aproximado (1 USD ≈ 1050 ARS blue)
      const USD_TO_ARS = 1050;
      const priceARS = currency === "USD" ? price * USD_TO_ARS : price;

      return {
        id: listing.id,
        title: listing.marketplace_listing_title ?? listing.name ?? "",
        price: priceARS,
        currency_id: currency,
        location:
          listing.location?.reverse_geocode?.city ?? "Buenos Aires",
        permalink: `https://www.facebook.com/marketplace/item/${listing.id}`,
        thumbnail: listing.primary_listing_photo?.image?.uri ?? "",
        date_created: listing.creation_time
          ? new Date(listing.creation_time * 1000).toISOString()
          : null,
        description: listing.redacted_description?.text ?? "",
        images: listing.listing_photos?.map((p: any) => p.image?.uri).filter(Boolean) ?? [],
      } as FBListing;
    })
    .filter((l): l is FBListing => l !== null && l.price > 0 && l.title.length > 0);
}
