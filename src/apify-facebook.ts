import { ApifyClient } from "apify-client";
import { FBListing } from "./facebook";

const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });

export interface ApifySearchOptions {
  query: string;
  location: string;  // ej: "Buenos Aires, Argentina"
  radiusKm: number;
  priceMin: number;
  priceMax: number;
  maxItems?: number;
}

export async function scrapeFBWithApify(
  opts: ApifySearchOptions
): Promise<FBListing[]> {
  console.log(`  Apify: buscando "${opts.query}" en ${opts.location}...`);

  // Construir URL de búsqueda de Facebook Marketplace
  const fbUrl = `https://www.facebook.com/marketplace/buenosaires/vehicles?` +
    `query=${encodeURIComponent(opts.query)}` +
    `&minPrice=${opts.priceMin}` +
    `&maxPrice=${opts.priceMax}` +
    `&exact=false`;

  const run = await client.actor("apify/facebook-marketplace-scraper").call({
    startUrls: [{ url: fbUrl }],
    maxItems: opts.maxItems ?? 50,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  return items.map((item: any) => ({
    id: item.id ?? String(item.listingId ?? Math.random()),
    title: item.title ?? item.name ?? "",
    price: parseFloat(String(item.price ?? "0").replace(/[^0-9.]/g, "")) || 0,
    location: item.location?.city ?? opts.location,
    permalink: item.url ?? item.link ?? "",
    thumbnail: item.image ?? item.primaryPhoto ?? "",
    date_created: item.datePosted ?? new Date().toISOString(),
    description: item.description ?? item.text ?? "",
    images: item.photos ?? [],
  })) as FBListing[];
}
