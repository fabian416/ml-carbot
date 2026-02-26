import { chromium } from "playwright-extra";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
import { existsSync, readFileSync } from "fs";
import { join } from "path";

chromium.use(StealthPlugin());

export interface FBListing {
  id: string;
  title: string;
  price: number;
  location: string;
  permalink: string;
  thumbnail: string;
  date_created: string;
  description?: string;  // descripción completa de la publicación
  images?: string[];     // fotos reales del auto
}

export interface FBSearchOptions {
  query: string;
  radiusKm: number;      // radio en km desde tu ubicación
  priceMin: number;
  priceMax: number;
  maxItems?: number;
}

// Radio en km → valor que usa Facebook en la URL
function radiusToFBParam(km: number): number {
  // FB usa millas internamente: 10km≈6mi, 20km≈12mi, 40km≈25mi, 80km≈50mi
  return Math.round(km * 0.621);
}

// Títulos que descartamos sin entrar a la publicación
const TITLE_BLACKLIST = [
  "repuesto", "repuestos", "chocado", "accidentado",
  "a reparar", "sin motor", "para reparar", "no arranca",
  "quemado", "inundado", "solo partes", "en partes",
  "para repuesto", "chatarra", "polarizado", "polarizados",
  "remolque", "trailer", "accesorios",
];

function passesTitleFilter(title: string): boolean {
  const lower = title.toLowerCase();
  return !TITLE_BLACKLIST.some((word) => lower.includes(word));
}

export async function scrapeFacebookMarketplace(
  opts: FBSearchOptions
): Promise<FBListing[]> {
  const cookiesPath = join(__dirname, "../fb-cookies.json");
  const hasCookies = existsSync(cookiesPath);

  if (!hasCookies) {
    console.log("⚠️  No hay cookies de Facebook. Corré primero: npm run fb:login");
    return [];
  }

  const browser = await chromium.launch({
    headless: true, // invisible una vez logueado
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "es-AR",
    viewport: { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 100) },
    timezoneId: "America/Argentina/Buenos_Aires",
  });

  // Carga las cookies guardadas
  const cookies = JSON.parse(readFileSync(cookiesPath, "utf-8"));
  await context.addCookies(cookies);

  const page = await context.newPage();

  // URL con filtros de radio y precio
  const radiusMiles = radiusToFBParam(opts.radiusKm);
  const url = `https://www.facebook.com/marketplace/category/vehicles?` +
    `query=${encodeURIComponent(opts.query)}` +
    `&radius=${radiusMiles}` +
    `&minPrice=${opts.priceMin}` +
    `&maxPrice=${opts.priceMax}` +
    `&exact=false`;

  console.log(`  FB: buscando "${opts.query}" en radio ${opts.radiusKm}km, $${opts.priceMin}-$${opts.priceMax}...`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Delay aleatorio para simular lectura humana
  await page.waitForTimeout(3000 + Math.random() * 2000);
  // Scroll suave como humano
  await page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 200);
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(800 + Math.random() * 500);
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(600 + Math.random() * 400);

  // Screenshot de debug para ver qué está mostrando Facebook
  await page.screenshot({ path: "fb-debug.png", fullPage: false });
  console.log("  FB: screenshot guardado en fb-debug.png");

  const maxItems = opts.maxItems ?? 20;

  const listings = await page.evaluate((max) => {
    const results: any[] = [];
    const links = document.querySelectorAll('a[href*="/marketplace/item/"]');
    const seen = new Set<string>();

    links.forEach((link) => {
      if (results.length >= max) return;

      const href = (link as HTMLAnchorElement).href;
      const idMatch = href.match(/\/marketplace\/item\/(\d+)/);
      if (!idMatch || seen.has(idMatch[1])) return;
      seen.add(idMatch[1]);

      const spans = Array.from(link.querySelectorAll("span[dir='auto']"))
        .map((el) => el.textContent?.trim())
        .filter(Boolean);

      const img = link.querySelector("img");
      const priceText = spans.find((s) => s?.includes("$")) ?? "";
      const priceNum = parseInt(priceText.replace(/[^0-9]/g, "")) || 0;
      const title = spans.filter((s) => !s?.includes("$")).join(" ").slice(0, 100);

      results.push({
        id: idMatch[1],
        title,
        price: priceNum,
        location: "",
        permalink: href,
        thumbnail: img?.src ?? "",
        date_created: new Date().toISOString(),
      });
    });

    return results;
  }, maxItems);

  // Aplicar filtros antes de entrar a cada publicación
  const filtered = listings.filter(
    (l) => l.price > 0 && passesTitleFilter(l.title)
  );

  console.log(`  FB: ${listings.length} tarjetas → ${filtered.length} pasan filtros → entrando a cada una...`);

  // Entrar a cada publicación que pasó el filtro
  const detailed: FBListing[] = [];
  for (const listing of filtered) {
    try {
      const detail = await scrapeListingDetail(context, listing);
      detailed.push(detail);
      await new Promise((r) => setTimeout(r, 1500)); // pausa para no ser detectado
    } catch {
      detailed.push(listing); // si falla, usamos los datos básicos
    }
  }

  await browser.close();
  return detailed;
}

// Entra a una publicación individual y extrae todos los detalles
async function scrapeListingDetail(context: any, listing: FBListing): Promise<FBListing> {
  const page = await context.newPage();

  try {
    // Simular comportamiento humano con movimiento de mouse aleatorio
    await page.mouse.move(
      Math.floor(Math.random() * 800),
      Math.floor(Math.random() * 600)
    );

    await page.goto(listing.permalink, { waitUntil: "networkidle", timeout: 30000 });

    // Esperar a que cargue el contenido dinámico
    await page.waitForTimeout(3000);

    // Scroll suave para cargar contenido lazy
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(1000);

    const detail = await page.evaluate(() => {
      // Extraer descripción completa — Facebook usa varias estructuras
      const textSelectors = [
        "span[dir='auto']",
        "div[dir='auto']",
        "[data-testid='marketplace-pdp-description']",
        "div[class*='description']",
      ];

      const texts = new Set<string>();
      textSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          const t = el.textContent?.trim();
          if (t && t.length > 10) texts.add(t);
        });
      });

      // Buscar datos específicos en el texto
      const allText = Array.from(texts).join(" | ");

      // Extraer km si aparece en el texto
      const kmMatch = allText.match(/(\d[\d.,]+)\s*(km|kilómetros|kilometros)/i);
      const km = kmMatch ? kmMatch[1] : null;

      // Extraer año si aparece
      const yearMatch = allText.match(/\b(19|20)\d{2}\b/);
      const year = yearMatch ? yearMatch[0] : null;

      // Imágenes reales del auto
      const imgs = Array.from(document.querySelectorAll("img"))
        .map((img) => (img as HTMLImageElement).src)
        .filter((src) => src.includes("scontent") || src.includes("fbcdn"))
        .slice(0, 6);

      return {
        fullText: allText.slice(0, 3000),
        km,
        year,
        images: imgs,
      };
    });

    await page.close();

    // Enriquecer el listing con los datos extraídos
    const enriched = { ...listing } as any;
    if (detail.fullText) enriched.description = detail.fullText;
    if (detail.images.length > 0) enriched.images = detail.images;

    // Inyectar km y año en los atributos si los encontramos
    if (detail.km || detail.year) {
      enriched.attributes = enriched.attributes || [];
      if (detail.km) enriched.attributes.push({ id: "KILOMETERS", value_name: detail.km });
      if (detail.year) enriched.attributes.push({ id: "VEHICLE_YEAR", value_name: detail.year });
    }

    return enriched as FBListing;
  } catch (err) {
    await page.close();
    return listing;
  }
}
