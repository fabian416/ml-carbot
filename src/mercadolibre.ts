import axios from "axios";

const ML_API = "https://api.mercadolibre.com";

// Categorías MercadoLibre Argentina
export const CATEGORIES = {
  AUTOS: "MLA1743",
  MOTOS: "MLA1384",
};

export interface MLListing {
  id: string;
  title: string;
  price: number;
  currency_id: string;
  condition: string;
  permalink: string;
  thumbnail: string;
  date_created: string;
  attributes: { id: string; value_name: string }[];
}

// Trae todas las publicaciones recientes de una categoría completa
export async function searchByCategory(
  category: string,
  maxDaysOld: number,
  priceMin: number,
  priceMax: number,
  limit = 50
): Promise<MLListing[]> {
  const response = await axios.get(`${ML_API}/sites/MLA/search`, {
    params: {
      category,
      sort: "date_desc",
      limit,
    },
  });

  const cutoff = Date.now() - maxDaysOld * 24 * 60 * 60 * 1000;

  return (response.data.results as MLListing[]).filter(
    (l) =>
      new Date(l.date_created).getTime() >= cutoff &&
      l.price >= priceMin &&
      l.price <= priceMax
  );
}

// Calcula la mediana usando publicaciones históricas (últimos 90 días)
// No importa cuándo fue publicado — es solo referencia de precio
export async function getMedianPrice(
  listing: MLListing
): Promise<number | undefined> {
  const attrs = extractAttributes(listing);
  if (attrs.brand === "N/A" || attrs.model === "N/A") return undefined;

  try {
    const response = await axios.get(`${ML_API}/sites/MLA/search`, {
      params: {
        q: `${attrs.brand} ${attrs.model} ${attrs.year}`,
        category: listing.attributes.find((a) => a.id === "VEHICLE_TYPE")
          ? CATEGORIES.MOTOS
          : CATEGORIES.AUTOS,
        limit: 50, // muestra amplia para mediana confiable
      },
    });

    const prices: number[] = response.data.results
      .map((r: MLListing) => r.price)
      .filter((p: number) => p > 0);

    if (prices.length === 0) return undefined;

    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    return prices.length % 2 !== 0
      ? prices[mid]
      : (prices[mid - 1] + prices[mid]) / 2;
  } catch {
    return undefined;
  }
}

// Busca por título libre (para FB listings que no tienen atributos estructurados)
export async function getMedianPriceByTitle(
  title: string,
  category: string = CATEGORIES.AUTOS
): Promise<number | undefined> {
  try {
    const response = await axios.get(`${ML_API}/sites/MLA/search`, {
      params: { q: title, category, limit: 30 },
    });

    const prices: number[] = response.data.results
      .map((r: MLListing) => r.price)
      .filter((p: number) => p > 0);

    if (prices.length < 3) return undefined;

    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    return prices.length % 2 !== 0
      ? prices[mid]
      : (prices[mid - 1] + prices[mid]) / 2;
  } catch {
    return undefined;
  }
}

export function extractAttributes(listing: MLListing) {
  const get = (id: string) =>
    listing.attributes.find((a) => a.id === id)?.value_name ?? "N/A";

  return {
    year: get("VEHICLE_YEAR"),
    km: get("KILOMETERS"),
    brand: get("BRAND"),
    model: get("MODEL"),
    fuel: get("FUEL_TYPE"),
    transmission: get("TRANSMISSION"),
  };
}
