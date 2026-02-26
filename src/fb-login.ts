import "dotenv/config";
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { join } from "path";

async function login() {
  console.log("Abriendo Facebook para que te logues...");
  console.log("1. Iniciá sesión con tu cuenta");
  console.log("2. Cuando estés en el feed principal, volvé acá y presioná ENTER\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "es-AR",
  });

  const page = await context.newPage();
  await page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded" });

  // Espera hasta que el usuario presione ENTER
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  // Guarda las cookies
  const cookies = await context.cookies();
  const cookiesPath = join(__dirname, "../fb-cookies.json");
  writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));

  console.log(`\n✅ Cookies guardadas en fb-cookies.json`);
  console.log("Ya no necesitás loguearte de nuevo.");

  await browser.close();
  process.exit(0);
}

login().catch(console.error);
