import type {
  PriceGapItem,
  ProductPriceResult,
  RecallEntry,
  SpecialEntry,
} from "./types.js";

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(opts: {
  title: string;
  description: string;
  canonicalPath: string;
  jsonLd: object;
  bodyHtml: string;
}): string {
  const canonical = `https://bubstock-api-production.up.railway.app${opts.canonicalPath}`;
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <meta property="og:title" content="${escapeHtml(opts.title)}" />
  <meta property="og:description" content="${escapeHtml(opts.description)}" />
  <meta property="og:type" content="website" />
  <script type="application/ld+json">${JSON.stringify(opts.jsonLd)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")}</script>
  <style>
    :root { --bg:#f5f8f7; --card:#fff; --ink:#142220; --muted:#566865; --teal:#0d7a6c; --good:#118357; --bad:#c63b2b; --line:#e3ecea; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"SF Pro Rounded","Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--ink); line-height:1.5; }
    .wrap { max-width:860px; margin:0 auto; padding:24px 16px 48px; }
    .hero { background:linear-gradient(135deg,#0c7568,#095047); color:#fff; border-radius:20px; padding:24px; margin-bottom:20px; }
    .hero h1 { margin:6px 0 8px; font-size:26px; line-height:1.2; }
    .hero p { margin:0; opacity:.9; font-size:14px; }
    .pill { display:inline-block; font-size:11px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; padding:4px 10px; border-radius:999px; background:rgba(255,255,255,.18); }
    .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:12px; }
    .row { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
    .price { font-size:21px; font-weight:800; color:var(--good); }
    .was { text-decoration:line-through; color:var(--muted); font-size:13px; margin-left:6px; }
    .badge { display:inline-block; background:var(--bad); color:#fff; font-size:11px; font-weight:800; padding:2px 8px; border-radius:999px; margin-right:6px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin-bottom:16px; }
    .stat { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; }
    .stat strong { display:block; font-size:22px; color:var(--teal); }
    .stat span { font-size:12px; color:var(--muted); }
    a { color:var(--teal); font-weight:600; text-decoration:none; }
    .cta { display:inline-block; margin-top:14px; background:#fff; color:#095047; padding:10px 16px; border-radius:12px; font-weight:700; font-size:14px; }
    .footer { margin-top:28px; font-size:12px; color:var(--muted); border-top:1px solid var(--line); padding-top:16px; }
  </style>
</head>
<body>
  <div class="wrap">
    ${opts.bodyHtml}
    <div class="footer">
      <strong>Bubstock AU</strong> — 100% live Australian supermarket baby prices (Woolworths, Coles, IGA, Priceline &amp; ALDI) &amp; official FSANZ/ACCC recall tracking. Zero synthetic estimates.
      · <a href="/au/half-price-baby-deals">Half-Price Baby Deals</a>
      · <a href="/au/index">AU Baby Cost-of-Living Index</a>
    </div>
  </div>
</body>
</html>`;
}

export function renderHalfPriceDealsPage(specials: SpecialEntry[], updatedAt: string): string {
  const top = specials.slice(0, 40);
  const itemsHtml = top.length === 0
    ? `<div class="card"><p>Live Australian supermarket specials are refreshing right now. Check back shortly.</p></div>`
    : top
        .map(
          (s) => `
      <div class="card">
        <div class="row">
          <div>
            <span class="badge">-${s.savingsPercent}%</span>
            <strong>${escapeHtml(s.retailer)}</strong> · ${escapeHtml(s.category)}
            <div style="font-size:15px;font-weight:700;margin-top:4px;">${escapeHtml(s.name)}</div>
            <div style="font-size:12px;color:#566865;">Save $${s.savingsAmount.toFixed(2)}${s.unit ? " · " + escapeHtml(s.unit) : ""}</div>
          </div>
          <div style="text-align:right;">
            <span class="price">$${s.price.toFixed(2)}</span>
            <span class="was">$${s.wasPrice.toFixed(2)}</span>
          </div>
        </div>
      </div>`
        )
        .join("");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Live Half-Price Australian Baby Specials (Nappies, Formula & Pouches)",
    numberOfItems: top.length,
    itemListElement: top.slice(0, 15).map((s, idx) => ({
      "@type": "ListItem",
      position: idx + 1,
      name: `${s.name} — $${s.price.toFixed(2)} at ${s.retailer} (-${s.savingsPercent}%)`,
    })),
  };

  return layout({
    title: `Half-Price Baby Deals Australia Today (${top.length} Live Specials) | Bubstock`,
    description: `Live verified Woolworths & Coles baby specials across nappies, infant formula & pouches. Updated ${updatedAt}.`,
    canonicalPath: "/au/half-price-baby-deals",
    jsonLd,
    bodyHtml: `
      <div class="hero">
        <span class="pill">Live AU Supermarket Feed</span>
        <h1>Half-Price Baby Deals in Australia Today</h1>
        <p>${top.length} verified Was/Now baby discounts across Woolworths &amp; Coles — updated ${escapeHtml(updatedAt.slice(0, 16).replace("T", " "))} UTC.</p>
        <a class="cta" href="/au/index">View AU Baby Cost-of-Living Index →</a>
      </div>
      ${itemsHtml}
    `,
  });
}

export function renderProductCityPricePage(
  cityLabel: string,
  citySlug: string,
  productSlug: string,
  result: ProductPriceResult
): string {
  const bestMap = new Map<string, typeof result.entries[number]>();
  for (const e of result.entries) {
    if (!bestMap.has(e.retailer)) bestMap.set(e.retailer, e);
  }
  const best = [...bestMap.values()].sort((a, b) => a.price - b.price);
  const low = best[0]?.price;
  const high = best[best.length - 1]?.price;

  const cardsHtml = best.length === 0
    ? `<div class="card"><p>No live online matches found right now for <strong>${escapeHtml(result.productName)}</strong> in ${escapeHtml(cityLabel)}.</p></div>`
    : best
        .map(
          (e, i) => `
      <div class="card">
        <div class="row">
          <div>
            ${i === 0 && best.length > 1 ? `<span class="badge" style="background:#118357;">CHEAPEST</span>` : ""}
            <strong>${escapeHtml(e.retailer)}</strong>
            <div style="font-size:15px;font-weight:600;margin-top:4px;">${escapeHtml(e.matchedName)}</div>
            <div style="font-size:12px;color:#566865;">${escapeHtml(e.unit || result.state)}${e.isInStock === true ? " · In stock online" : e.isInStock === false ? " · Out of stock online" : ""}</div>
          </div>
          <div style="text-align:right;">
            <span class="price">$${e.price.toFixed(2)}</span>
            ${e.wasPrice ? `<span class="was">$${e.wasPrice.toFixed(2)}</span>` : ""}
          </div>
        </div>
      </div>`
        )
        .join("");

  const aldiHtml = result.aldiEquivalent
    ? `<div class="card" style="border-color:#0d7a6c;background:#eef7f5;">
        <strong>ALDI Mamia Budget Benchmark</strong> (${escapeHtml(result.aldiEquivalent.categoryLabel)})
        <div class="row" style="margin-top:6px;">
          <span>${escapeHtml(result.aldiEquivalent.entry.matchedName)}</span>
          <span class="price">$${result.aldiEquivalent.entry.price.toFixed(2)}</span>
        </div>
       </div>`
    : "";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: result.productName,
    offers: low !== undefined
      ? {
          "@type": "AggregateOffer",
          priceCurrency: "AUD",
          lowPrice: low.toFixed(2),
          highPrice: (high ?? low).toFixed(2),
          offerCount: best.length,
        }
      : undefined,
  };

  return layout({
    title: `${result.productName} Price in ${cityLabel} (${low ? "$" + low.toFixed(2) : "Live"}) | Bubstock`,
    description: `Compare live ${result.productName} prices across Woolworths, Coles, IGA, Priceline & ALDI in ${cityLabel}.`,
    canonicalPath: `/au/prices/${citySlug}/${productSlug}`,
    jsonLd,
    bodyHtml: `
      <div class="hero">
        <span class="pill">${escapeHtml(cityLabel)} · Live Multi-Retailer Check</span>
        <h1>${escapeHtml(result.productName)} — Live Prices in ${escapeHtml(cityLabel)}</h1>
        <p>${best.length > 0 ? `Cheapest verified price today: $${best[0].price.toFixed(2)} at ${escapeHtml(best[0].retailer)}.` : "Checking Woolworths, Coles, IGA, Priceline & ALDI live."}</p>
      </div>
      ${cardsHtml}
      ${aldiHtml}
    `,
  });
}

export interface BabyCostIndexData {
  generatedAt: string;
  region: string;
  liveSpecialsCount: number;
  halfPriceDealsCount: number;
  averageColesVsWooliesGapAUD: number;
  biggestGapAUD: number;
  medianFormulaPriceAUD: number | null;
  medianNappiesPriceAUD: number | null;
  activeRecallsCount: number;
  shrinkflationAlertsCount: number;
  sightingsLast24h: number;
}

export function renderCostIndexPage(index: BabyCostIndexData, topGaps: PriceGapItem[], recalls: RecallEntry[]): string {
  const gapRows = topGaps
    .slice(0, 8)
    .map(
      (g) => `
      <div class="card">
        <div class="row">
          <div>
            <strong>${escapeHtml(g.displayName)}</strong>
            <div style="font-size:12px;color:#566865;">Woolworths $${g.woolworths.price.toFixed(2)} vs Coles $${g.coles.price.toFixed(2)}</div>
          </div>
          <div class="price">${escapeHtml(g.cheaperRetailer)} -$${g.savingsAmount.toFixed(2)}</div>
        </div>
      </div>`
    )
    .join("");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Bubstock Australian Baby Cost-of-Living Index",
    description: "Real-time aggregated pricing across Australian infant formula, nappies and baby food retailers.",
    dateModified: index.generatedAt,
  };

  return layout({
    title: "Australian Baby Cost-of-Living Index (Live Data) | Bubstock",
    description: `Live Australian infant formula & nappy price index: ${index.liveSpecialsCount} specials, $${index.averageColesVsWooliesGapAUD.toFixed(2)} avg Coles vs Woolworths gap, ${index.activeRecallsCount} active FSANZ/ACCC recalls.`,
    canonicalPath: "/au/index",
    jsonLd,
    bodyHtml: `
      <div class="hero">
        <span class="pill">Public Market Telemetry · 100% Real Data</span>
        <h1>Australian Baby Cost-of-Living Index</h1>
        <p>Live aggregated supermarket pricing across Melbourne, Sydney, Brisbane, Perth, Adelaide &amp; Tasmania — updated ${escapeHtml(index.generatedAt.slice(0, 16).replace("T", " "))} UTC.</p>
      </div>
      <div class="grid">
        <div class="stat"><strong>${index.medianFormulaPriceAUD ? "$" + index.medianFormulaPriceAUD.toFixed(2) : "—"}</strong><span>Verified Median Formula</span></div>
        <div class="stat"><strong>${index.medianNappiesPriceAUD ? "$" + index.medianNappiesPriceAUD.toFixed(2) : "—"}</strong><span>Verified Median Nappies</span></div>
        <div class="stat"><strong>$${index.averageColesVsWooliesGapAUD.toFixed(2)}</strong><span>Avg Coles vs Woolies Gap</span></div>
        <div class="stat"><strong>${index.halfPriceDealsCount}</strong><span>Live ≥40% Off Deals</span></div>
        <div class="stat"><strong>${index.activeRecallsCount}</strong><span>Active FSANZ/ACCC Recalls</span></div>
        <div class="stat"><strong>${index.shrinkflationAlertsCount}</strong><span>90-Day Shrinkflation Alerts</span></div>
      </div>
      <h2 style="font-size:18px;margin:20px 0 10px;">Biggest Live Coles vs Woolworths Price Gaps</h2>
      ${gapRows || `<div class="card"><p>Live gap pairs refreshing from Melbourne &amp; national feeds.</p></div>`}
      <h2 style="font-size:18px;margin:20px 0 10px;">Latest Official FSANZ &amp; ACCC Recall Notices</h2>
      ${recalls
        .slice(0, 5)
        .map(
          (r) => `<div class="card"><strong>${escapeHtml(r.agency)}</strong> · ${escapeHtml(r.productName)}<div style="font-size:12px;color:#566865;margin-top:3px;">${escapeHtml(r.reason.slice(0, 180))}</div></div>`
        )
        .join("")}
    `,
  });
}

export const SEO_FLAGSHIP_SLUGS = [
  "aptamil-gold-1",
  "aptamil-gold-2",
  "karicare-stage-1",
  "nan-comfort-1",
  "s26-gold-newborn",
  "a2-platinum-1",
  "huggies-ultra-dry-size-3",
  "huggies-ultra-dry-size-4",
  "babylove-cosifit-nappies",
  "rascal-friends-nappies",
  "raffertys-garden-pouch",
  "farex-baby-rice-cereal",
];

export function renderSitemapXml(cities: string[]): string {
  const base = "https://bubstock-api-production.up.railway.app";
  const urls: string[] = [
    `${base}/au/half-price-baby-deals`,
    `${base}/au/index`,
  ];
  for (const city of cities) {
    for (const slug of SEO_FLAGSHIP_SLUGS) {
      urls.push(`${base}/au/prices/${city}/${slug}`);
    }
  }
  const body = urls
    .map((u) => `  <url><loc>${escapeHtml(u)}</loc><changefreq>daily</changefreq></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}
