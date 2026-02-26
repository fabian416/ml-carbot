import "dotenv/config";
import { scrapeFacebookMarketplace } from "./facebook";

async function main() {
  console.log("Probando scraper de Facebook Marketplace...\n");

  const listings = await scrapeFacebookMarketplace({
    query: "auto usado",
    radiusKm: 50,
    priceMin: 3000,
    priceMax: 25000,
    maxItems: 10,
  });

  if (listings.length === 0) {
    console.log("No se encontraron resultados.");
    console.log("Si no te logueaste todavía, corré: npm run fb:login");
    return;
  }

  console.log(`Encontré ${listings.length} publicaciones:\n`);
  listings.forEach((l, i) => {
    console.log(`${i + 1}. ${l.title}`);
    console.log(`   Precio: $${l.price.toLocaleString("es-AR")}`);
    console.log(`   Link: ${l.permalink}\n`);
  });
}

main().catch(console.error);
