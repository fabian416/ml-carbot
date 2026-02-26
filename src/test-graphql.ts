import "dotenv/config";
import { browseFBVehicles, getFBListingDetail, loadCookies } from "./fb-graphql";

async function main() {
  console.log("Probando browse de vehículos + detalle...\n");

  const listings = await browseFBVehicles({
    radiusKm: 50,
    sortBy: "creation_time_descend",
    maxItems: 30,
  });

  // Filtrar spam obvio de precio
  const filtered = listings.filter(
    (l) => l.price >= 3_000_000 && l.price <= 40_000_000
  );

  console.log(`Total traídos: ${listings.length} | Pasan filtro precio: ${filtered.length}\n`);

  if (filtered.length === 0) {
    console.log("Sin resultados con ese rango. Mostrando todos:");
    listings.slice(0, 5).forEach((l) => {
      console.log(`  $${l.price.toLocaleString("es-AR")} — ${l.title}`);
    });
    return;
  }

  // Mostrar los primeros 3 con detalle
  const { cookieStr } = loadCookies();
  for (const listing of filtered.slice(0, 3)) {
    console.log(`\n📌 ${listing.title}`);
    console.log(`   Precio: $${listing.price.toLocaleString("es-AR")} ARS`);
    console.log(`   Fecha:  ${listing.date_created}`);
    console.log(`   Link:   ${listing.permalink}`);

    const detail = await getFBListingDetail(listing.id, cookieStr);
    if (detail.description) {
      console.log(`   Desc:   ${detail.description.slice(0, 150)}`);
    }
    if ((detail as any).km) console.log(`   Km:     ${(detail as any).km}`);
    if ((detail as any).year) console.log(`   Año:    ${(detail as any).year}`);
    console.log(`   Fotos:  ${detail.images?.length ?? 0}`);
  }
}

main().catch(console.error);
