import "dotenv/config";
import { scrapeFBWithApify } from "./apify-facebook";
import { analyzeListing } from "./analyzer";

async function main() {
  console.log("Probando Apify + Facebook Marketplace...\n");

  const listings = await scrapeFBWithApify({
    query: "auto usado",
    location: "Buenos Aires, Argentina",
    radiusKm: 50,
    priceMin: 3000,
    priceMax: 20000,
    maxItems: 10,
  });

  if (listings.length === 0) {
    console.log("Sin resultados.");
    return;
  }

  console.log(`Encontré ${listings.length} publicaciones. Analizando con Claude...\n`);
  console.log("─".repeat(60));

  for (const listing of listings) {
    if (!listing.title || listing.price === 0) continue;

    try {
      const analysis = await analyzeListing({
        ...listing,
        currency_id: "USD",
        condition: "used",
        attributes: [],
      } as any);

      const emoji = analysis.score >= 8 ? "🔥" : analysis.score >= 6 ? "✅" : "❌";
      console.log(`${emoji} Score ${analysis.score}/10 — ${listing.title}`);
      console.log(`   💰 $${listing.price.toLocaleString("es-AR")}`);
      console.log(`   📋 ${analysis.summary}`);
      if (analysis.redFlags.length > 0) {
        console.log(`   🚩 ${analysis.redFlags.slice(0, 3).join(", ")}`);
      }
      console.log(`   💬 ${analysis.negotiationArg}`);
      console.log(`   🔗 ${listing.permalink}`);
      console.log("─".repeat(60));

      await new Promise((r) => setTimeout(r, 800));
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
    }
  }
}

main().catch(console.error);
