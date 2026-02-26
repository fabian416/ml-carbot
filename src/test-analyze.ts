import "dotenv/config";
import { scrapeFacebookMarketplace, FBListing } from "./facebook";
import { analyzeListing, AnalysisResult } from "./analyzer";

// Convertimos FBListing al formato que espera el analyzer
function fbToMLFormat(fb: FBListing) {
  return {
    id: fb.id,
    title: fb.title,
    price: fb.price,
    currency_id: "USD",
    condition: "used",
    permalink: fb.permalink,
    thumbnail: fb.thumbnail,
    date_created: fb.date_created,
    attributes: [],
  };
}

async function main() {
  console.log("Scrapeando Facebook...\n");

  const listings = await scrapeFacebookMarketplace({
    query: "auto usado",
    radiusKm: 50,
    priceMin: 3000,
    priceMax: 25000,
    maxItems: 10,
  });

  if (listings.length === 0) {
    console.log("Sin resultados.");
    return;
  }

  console.log(`Analizando ${listings.length} publicaciones con Claude...\n`);
  console.log("─".repeat(60));

  const results: Array<{ listing: FBListing; analysis: AnalysisResult }> = [];

  for (const listing of listings) {
    if (listing.price === 0) continue; // saltamos los sin precio

    try {
      const analysis = await analyzeListing(fbToMLFormat(listing));

      results.push({ listing, analysis });

      const emoji = analysis.score >= 8 ? "🔥" : analysis.score >= 6 ? "✅" : "❌";
      console.log(`${emoji} Score ${analysis.score}/10 — ${listing.title || "Sin título"}`);
      console.log(`   💰 $${listing.price.toLocaleString("es-AR")}`);
      console.log(`   📋 ${analysis.summary}`);
      if (analysis.redFlags.length > 0) {
        console.log(`   🚩 ${analysis.redFlags.join(", ")}`);
      }
      console.log(`   💬 ${analysis.negotiationArg}`);
      console.log(`   🔗 ${listing.permalink}`);
      console.log("─".repeat(60));

      // Pausa entre llamadas para no saturar la API
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err: any) {
      if (err?.status === 401) {
        console.log("\n❌ API key de Anthropic inválida o sin créditos.");
        console.log("   Cargá $5 en console.anthropic.com/settings/billing");
        break;
      }
      console.error(`Error en ${listing.id}:`, err.message);
    }
  }

  // Ranking final
  const sorted = results.sort((a, b) => b.analysis.score - a.analysis.score);
  console.log("\n🏆 RANKING DE MEJORES DEALS:\n");
  sorted.slice(0, 3).forEach((r, i) => {
    console.log(`${i + 1}. Score ${r.analysis.score}/10 — ${r.listing.title || "Sin título"}`);
    console.log(`   $${r.listing.price.toLocaleString("es-AR")} — ${r.analysis.recommendation}`);
    console.log(`   🔗 ${r.listing.permalink}\n`);
  });
}

main().catch(console.error);
