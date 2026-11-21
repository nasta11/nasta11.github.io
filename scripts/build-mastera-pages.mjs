// Builds a static page for every master (/mastera/m/<name>-<city>/) and for every "city + service" pair that has at least one master,
// e.g. /mastera/novi-sad/massazh/ "Массаж в Нови-Саде". Google shows such pages for
// searches like "массаж нови сад"; the main catalog loads its cards with JavaScript,
// which search engines read poorly. Run by .github/workflows/mastera-pages.yml.
//
//   node scripts/build-mastera-pages.mjs            fetch masters from the API
//   node scripts/build-mastera-pages.mjs data.json  use a saved API answer instead

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const API = "https://lifearchive-platform.vercel.app/api/mastera";
const SITE = "https://nasta11.github.io";
const ROOT = new URL("..", import.meta.url).pathname;
const MASTERA = join(ROOT, "mastera");
const MARK = "generated-by-build-mastera-pages";

// "в Нови-Саде": the catalog's three cities in the locative case.
const CITY_IN = { "Суботица": "Суботице", "Нови-Сад": "Нови-Саде", "Белград": "Белграде" };
const ICON = { "Салон": "🏢", "Кабинет": "🚪", "Студия / мастерская": "🎨", "Спортзал / фитнес-клуб": "🏋️", "На дому": "🏠", "Выезжаю к клиенту": "🚗", "На улице / в парке": "🌳", "Онлайн": "💻" };
const PAL = ["#C9677D", "#8E74B8", "#C9963F", "#5E9E86", "#C9805E"];

const LAT = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya",і:"i",ї:"yi",є:"ye",ґ:"g",đ:"dj",č:"c",ć:"c",š:"s",ž:"z" };
export function slug(text) {
  const s = String(text).toLowerCase().split("").map((c) => LAT[c] ?? c).join("")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 60).replace(/-+$/, "") || "drugoe";
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (v) => Number(v).toLocaleString("ru-RU").replace(/\u00a0/g, " ");
const money = (p) => (p.priceTo ? `${num(p.price)}–${num(p.priceTo)}` : `${p.from ? "от " : ""}${num(p.price)}`) + " " + (p.currency === "€" ? "€" : "дин");

// Same rules as contactLink() in mastera/index.html.
function contactLink(raw) {
  const c = String(raw || "").trim();
  const tg = c.match(/^@([A-Za-z0-9_]{4,32})$/);
  if (tg) return `<a href="https://t.me/${tg[1]}" rel="noopener">${esc(c)}</a>`;
  if (/^https:\/\/[^\s"<>]+$/.test(c)) return `<a href="${esc(c)}" rel="noopener">${esc(c.replace(/^https:\/\//, ""))}</a>`;
  const phone = c.match(/\+?\d[\d\s()\-]{7,}\d/);
  if (phone && !/viber|вайбер/i.test(c) && (/whats|ватс|вотс/i.test(c) || phone[0].length >= c.length - 1)) {
    let digits = phone[0].replace(/\D/g, "");
    if (digits[0] === "0") digits = "381" + digits.slice(1);
    return `<a href="https://wa.me/${digits}" rel="noopener">${esc(c)}</a>`;
  }
  return esc(c);
}

// Marks a contact link so a tap on it is counted (see the click script in the pages).
const zapis = (html, name) => String(html).replace(/^<a /, `<a data-zapis="${esc(name)}" `);

// Where the big "Записаться" button leads (null when the contact is not a link).
function contactHref(raw) {
  const m = String(contactLink(raw)).match(/^<a href="([^"]+)"/);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

const title = (service, city) => CITY_IN[city] ? `${service} в ${CITY_IN[city]}` : `${service}, ${city}`;
const cheapest = (cards) => {
  const all = cards.flatMap((m) => m.prices || []).filter((p) => Number(p.price) > 0);
  const din = all.filter((p) => p.currency !== "€").sort((a, b) => a.price - b.price)[0];
  const eur = all.filter((p) => p.currency === "€").sort((a, b) => a.price - b.price)[0];
  const p = din || eur;
  return p ? `от ${num(p.price)} ${p.currency === "€" ? "€" : "дин"}` : "";
};
const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? "мастер" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "мастера" : "мастеров");

function cardHtml(m, i) {
  const rows = (m.prices || []).map((p) => `<tr><td>${esc(p.name)}${p.duration ? `<small>${esc(p.duration)}</small>` : ""}</td><td class="p">${money(p)}</td></tr>`).join("");
  const uses = [m.devices, m.cosmetics].filter(Boolean).map(esc).join(" · ");
  return `<article class="card">
  <div class="top">${/^https:\/\/[^\s"<>]+$/.test(m.photo || "") ? `<img class="ava" src="${esc(m.photo)}" alt="" loading="lazy">` : `<div class="ava" style="background:${PAL[i % PAL.length]}">${esc((m.name || "?").charAt(0))}</div>`}<div class="who"><h2>${m.path ? `<a href="${m.path}">${esc(m.name)}</a>` : esc(m.name)}</h2><span>${esc(m.service)} · ${esc(m.city)}</span></div>${m.seeksJob ? '<span class="tag">ищет работу</span>' : ""}</div>
  <div class="place"><span aria-hidden="true">${ICON[m.place] || "📍"}</span><div><b>${esc(m.place)}</b>${m.placeNote ? `<span>${esc(m.placeNote)}</span>` : ""}</div></div>
  ${uses ? `<p class="uses">Чем работает: ${uses}</p>` : ""}
  ${rows ? `<table><caption>Цены</caption>${rows}</table>` : ""}
  <div class="book">${m.languages ? `<span>${esc(m.languages)}</span>` : ""}<span>запись: ${zapis(contactLink(m.contact), m.name)}</span></div>
  ${m.path ? `<a class="page" href="${m.path}">Страница мастера →</a>` : ""}
</article>`;
}

function pageHtml({ city, service, cards, path, others }) {
  const h1 = title(service, city);
  const from = cheapest(cards);
  const names = cards.map((m) => m.name).filter(Boolean).slice(0, 3).join(", ");
  // What people actually type into Google is the dish or the procedure ("пельмени", "педикюр"),
  // so the first price lines go into the description too.
  const seen = new Set();
  const what = cards
    .flatMap((m) => (m.prices || []).map((p) => (p.name || "").trim()))
    .filter((name) => name && name.length <= 40 && !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase()))
    .slice(0, 6)
    .map((name, i) => (i === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1)))
    .join(", ");
  const description = `${h1}: ${cards.length} ${plural(cards.length)}${from ? `, цены ${from}` : ""}.${what ? ` ${what}.` : ""} ${names}. Где принимают, точные цены и как записаться.`.slice(0, 300);
  const url = `${SITE}${path}`;
  const catalog = `/mastera/?city=${encodeURIComponent(city)}&svc=${encodeURIComponent(service)}`;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- ${MARK}: do not edit by hand, the page is rebuilt from the catalog data -->
<title>${esc(h1)}: мастера и цены · Свои мастера</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:site_name" content="Botika">
<meta property="og:title" content="${esc(h1)}: мастера и цены">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/mastera/og.jpg">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
  { "@type": "ListItem", position: 1, name: "Свои мастера", item: `${SITE}/mastera/` },
  // Google wants an "item" link on every step but the last: the city step opens the catalog on that city.
  { "@type": "ListItem", position: 2, name: city, item: `${SITE}/mastera/${slug(city)}/` },
  { "@type": "ListItem", position: 3, name: service, item: url },
] }).replace(/</g, "\\u003c")}</script>
<style>
:root{--bg:#F6F1EC;--surface:#FFFFFF;--ink:#2A1F1C;--muted:#73655F;--line:#E6DCD4;--accent:#B4485E;--mint:#0B6E5B;--mint-soft:#E1F0EA}
@media (prefers-color-scheme: dark){:root{--bg:#1A1514;--surface:#241D1B;--ink:#F3EAE6;--muted:#B4A59F;--line:#3A2F2C;--accent:#E87F93;--mint:#55CFB2;--mint-soft:#1E302A;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.5}
.wrap{max-width:640px;margin:0 auto;padding:20px 16px 56px;display:flex;flex-direction:column;gap:18px}
a{color:var(--accent)}
nav.crumbs{font-size:14px;color:var(--muted)}
h1{font-size:clamp(26px,7vw,34px);line-height:1.15;margin:0}
.lead{margin:0;color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:12px}
.top{display:flex;gap:12px;align-items:center}
.ava{width:48px;height:48px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:19px;color:#fff;object-fit:cover}
.who{min-width:0;display:flex;flex-direction:column}
.who h2{font-size:17px;margin:0}
.who span{font-size:14px;color:var(--muted)}
.tag{margin-left:auto;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);border:1px solid currentColor;border-radius:999px;padding:3px 8px;flex:none}
.place{display:flex;gap:10px;background:var(--mint-soft);border-radius:12px;padding:10px 12px}
.place b{display:block}
.place span{font-size:14px;color:var(--muted)}
.uses{margin:0;font-size:14px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:15px}
caption{text-align:left;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding-bottom:4px}
td{padding:8px 0;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
td.p{text-align:right;font-weight:700;white-space:nowrap;padding-left:12px}
td small{display:block;color:var(--muted);font-size:13px}
.book{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:12px;font-size:14px;color:var(--muted)}
.cta{display:inline-flex;align-self:flex-start;align-items:center;min-height:44px;padding:10px 18px;border-radius:12px;background:var(--accent);color:#fff;font-weight:700;text-decoration:none}
.join{background:var(--mint);color:#fff;border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:6px}
.join a{color:#fff;font-weight:700}
.who h2 a{color:inherit;text-decoration:none}
.page{font-size:14px;font-weight:700;text-decoration:none}
.more{font-size:14px;color:var(--muted)}
.more ul{padding-left:18px;margin:6px 0 0}
</style>
</head>
<body>
<div class="wrap">
  <nav class="crumbs"><a href="/mastera/">Свои мастера</a> › <a href="/mastera/${slug(city)}/">${esc(city)}</a> › ${esc(service)}</nav>
  <h1>${esc(h1)}</h1>
  <p class="lead">${cards.length} ${plural(cards.length)}${from ? ` · цены ${from}` : ""}. Где принимают, точные цены и как записаться.</p>
  ${cards.map(cardHtml).join("\n  ")}
  <a class="cta" href="${esc(catalog)}">Все мастера в каталоге →</a>
  <div class="join"><b>Вы мастер?</b><span>Добавьте свою карточку бесплатно, это 5 минут в Telegram: <a href="https://t.me/svoi_mastera_bot">@svoi_mastera_bot</a></span></div>
  ${others.length ? `<div class="more">Ещё в каталоге:<ul>${others.map((o) => `<li><a href="${o.path}">${esc(title(o.service, o.city))}</a></li>`).join("")}</ul></div>` : ""}
  <div class="more">Botika · каталог «Свои мастера» · <a href="/">nasta11.github.io</a></div>
</div>
<script>
// Counts taps on "Записаться" as GoatCounter events (zapis/<master>), no cookies.
document.addEventListener("click", function (e) {
  var a = e.target.closest && e.target.closest("a[data-zapis]"); if (!a) return;
  var gc = window.goatcounter, who = a.getAttribute("data-zapis");
  if (gc && gc.count) gc.count({ path: "zapis/" + who, title: "Записаться: " + who, event: true });
});
</script>
<script data-goatcounter="https://botika.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// One page per master: /mastera/m/<name>-<city>/. Like a profile on Avito:
// everything about the master in one place, with a link they can share.
// Photos and reviews show up as soon as the API starts sending them
// (m.photos: ["https://…"], m.reviews: [{ author, text, rating, date }]).

const isHttps = (u) => /^https:\/\/[^\s"<>]+$/.test(String(u || ""));

function masterPageHtml(m, i, { categoryPath, neighbours }) {
  const url = `${SITE}${m.path}`;
  const cityIn = CITY_IN[m.city] ? `в ${CITY_IN[m.city]}` : m.city;
  const h1 = m.name;
  const prices = (m.prices || []).filter((p) => p && p.name);
  const from = cheapest([m]);
  const what = prices.slice(0, 4).map((p) => p.name).join(", ");
  const description = `${m.name} — ${m.service} ${cityIn}.${from ? ` Цены ${from}.` : ""}${what ? ` ${what}.` : ""} Где принимает, точные цены и запись.`.slice(0, 300);
  const href = contactHref(m.contact);
  const hasPoint = typeof m.lat === "number" && typeof m.lon === "number";
  const photos = (Array.isArray(m.photos) ? m.photos : []).filter(isHttps).slice(0, 12);
  const reviews = (Array.isArray(m.reviews) ? m.reviews : []).filter((r) => r && r.text);
  const avatar = isHttps(m.photo)
    ? `<img class="ava" src="${esc(m.photo)}" alt="">`
    : `<div class="ava" style="background:${PAL[i % PAL.length]}">${esc((m.name || "?").charAt(0))}</div>`;
  const uses = [m.devices, m.cosmetics].filter(Boolean).map(esc).join(" · ");
  const rows = prices.map((p) => `<tr><td>${esc(p.name)}${p.duration ? `<small>${esc(p.duration)}</small>` : ""}</td><td class="p">${money(p)}</td></tr>`).join("");
  const rating = reviews.filter((r) => Number(r.rating) > 0);
  const avg = rating.length ? (rating.reduce((a, r) => a + Number(r.rating), 0) / rating.length) : 0;

  let map = "";
  if (hasPoint) {
    const d = 0.004;
    const bbox = [m.lon - d, m.lat - d / 1.5, m.lon + d, m.lat + d / 1.5].map((x) => x.toFixed(5)).join(",");
    map = `<iframe class="map" title="Карта" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&amp;layer=mapnik&amp;marker=${m.lat},${m.lon}"></iframe>
    <a href="https://www.google.com/maps/dir/?api=1&amp;destination=${m.lat},${m.lon}" rel="noopener">Построить маршрут ↗</a>`;
  }

  const offers = prices.filter((p) => Number(p.price) > 0).map((p) => ({
    "@type": "Offer",
    itemOffered: { "@type": "Service", name: p.name },
    price: Number(p.price),
    priceCurrency: p.currency === "€" ? "EUR" : "RSD",
  }));
  const ld = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: m.name,
    description: `${m.service} ${cityIn}`,
    url,
    address: { "@type": "PostalAddress", addressLocality: m.city, addressCountry: "RS", ...(m.placeNote ? { streetAddress: m.placeNote } : {}) },
    ...(hasPoint ? { geo: { "@type": "GeoCoordinates", latitude: m.lat, longitude: m.lon } } : {}),
    ...(photos.length ? { image: photos } : {}),
    ...(offers.length ? { makesOffer: offers } : {}),
    ...(rating.length ? { aggregateRating: { "@type": "AggregateRating", ratingValue: avg.toFixed(1), reviewCount: rating.length } } : {}),
  };
  const crumbs = {
    "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Свои мастера", item: `${SITE}/mastera/` },
      { "@type": "ListItem", position: 2, name: title(m.service, m.city), item: `${SITE}${categoryPath}` },
      { "@type": "ListItem", position: 3, name: m.name, item: url },
    ],
  };
  const json = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- ${MARK}: do not edit by hand, the page is rebuilt from the catalog data -->
<title>${esc(m.name)} — ${esc(m.service)} ${esc(cityIn)} · Свои мастера</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:site_name" content="Botika">
<meta property="og:title" content="${esc(m.name)} — ${esc(m.service)} ${esc(cityIn)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="profile">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${photos[0] ? esc(photos[0]) : `${SITE}/mastera/og.jpg`}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${json(ld)}</script>
<script type="application/ld+json">${json(crumbs)}</script>
<style>
:root{--bg:#F6F1EC;--surface:#FFFFFF;--ink:#2A1F1C;--muted:#73655F;--line:#E6DCD4;--accent:#B4485E;--mint:#0B6E5B;--mint-soft:#E1F0EA}
@media (prefers-color-scheme: dark){:root{--bg:#1A1514;--surface:#241D1B;--ink:#F3EAE6;--muted:#B4A59F;--line:#3A2F2C;--accent:#E87F93;--mint:#55CFB2;--mint-soft:#1E302A;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.5}
.wrap{max-width:640px;margin:0 auto;padding:20px 16px 56px;display:flex;flex-direction:column;gap:18px}
a{color:var(--accent)}
nav.crumbs{font-size:14px;color:var(--muted)}
.hero{display:flex;gap:16px;align-items:center}
.ava{width:76px;height:76px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:30px;color:#fff;object-fit:cover}
h1{font-size:clamp(24px,6.5vw,32px);line-height:1.15;margin:0}
.sub{color:var(--muted);font-size:15px}
.stars{color:#C9963F;font-weight:700;font-size:15px}
.tag{display:inline-block;margin-top:4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);border:1px solid currentColor;border-radius:999px;padding:3px 8px}
.actions{display:flex;gap:10px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:10px 20px;border-radius:14px;background:var(--accent);color:#fff;font-weight:700;text-decoration:none;font-size:16px;border:0;cursor:pointer;font-family:inherit}
.btn.ghost{background:var(--surface);color:var(--ink);border:1px solid var(--line)}
section{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:10px}
h2{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0}
.place{display:flex;gap:10px;background:var(--mint-soft);border-radius:12px;padding:10px 12px}
.place b{display:block}
.place span{font-size:14px;color:var(--muted)}
.map{width:100%;height:220px;border:0;border-radius:12px}
table{width:100%;border-collapse:collapse;font-size:15px}
td{padding:9px 0;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
td.p{text-align:right;font-weight:700;white-space:nowrap;padding-left:12px}
td small{display:block;color:var(--muted);font-size:13px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.gallery a{display:block;background:var(--bg);border-radius:12px;overflow:hidden;aspect-ratio:1}
.gallery img{width:100%;height:100%;object-fit:contain;display:block}
.review{border-bottom:1px solid var(--line);padding-bottom:10px}
.review:last-child{border-bottom:0;padding-bottom:0}
.review p{margin:4px 0 0}
.review small{color:var(--muted)}
.muted{color:var(--muted);font-size:14px;margin:0}
.join{background:var(--mint);color:#fff;border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:6px}
.join a{color:#fff;font-weight:700}
.more{font-size:14px;color:var(--muted)}
.more ul{padding-left:18px;margin:6px 0 0}
</style>
</head>
<body>
<div class="wrap">
  <nav class="crumbs"><a href="/mastera/">Свои мастера</a> › <a href="${categoryPath}">${esc(title(m.service, m.city))}</a></nav>

  <div class="hero">${avatar}<div>
    <h1>${esc(h1)}</h1>
    <div class="sub">${esc(m.service)} · ${esc(m.city)}${m.languages ? ` · ${esc(m.languages)}` : ""}</div>
    ${rating.length ? `<div class="stars">★ ${avg.toFixed(1)} <span class="sub">· ${reviews.length} отз.</span></div>` : ""}
    ${m.seeksJob ? '<span class="tag">ищет работу</span>' : ""}
  </div></div>

  <div class="actions">
    ${href ? `<a class="btn" href="${esc(href)}" rel="noopener" data-zapis="${esc(m.name)}">Записаться</a>` : ""}
    <button class="btn ghost" type="button" id="share">Поделиться</button>
  </div>
  ${!href && m.contact ? `<p class="muted">Запись: ${zapis(contactLink(m.contact), m.name)}</p>` : ""}

  ${rows ? `<section><h2>Цены</h2>${from ? `<p class="muted">${esc(from.charAt(0).toUpperCase() + from.slice(1))}</p>` : ""}<table>${rows}</table></section>` : ""}

  <section><h2>Где принимает</h2>
    <div class="place"><span aria-hidden="true">${ICON[m.place] || "📍"}</span><div><b>${esc(m.place)}</b>${m.placeNote ? `<span>${esc(m.placeNote)}</span>` : ""}</div></div>
    ${map}
  </section>

  ${uses ? `<section><h2>Чем работает</h2><p style="margin:0">${uses}</p></section>` : ""}

  ${photos.length ? `<section><h2>Работы</h2><div class="gallery">${photos.map((p, k) => `<a href="${esc(p)}" target="_blank" rel="noopener"><img src="${esc(p)}" alt="Работа ${k + 1}" loading="lazy"></a>`).join("")}</div></section>` : ""}

  ${reviews.length ? `<section><h2>Отзывы</h2>${reviews.map((r) => `<div class="review"><b>${esc(r.author || "Клиент")}</b>${Number(r.rating) > 0 ? ` <span class="stars">${"★".repeat(Math.min(5, Math.round(Number(r.rating))))}</span>` : ""}${r.date ? ` <small>${esc(r.date)}</small>` : ""}<p>${esc(r.text)}</p></div>`).join("")}</section>` : ""}

  ${neighbours.length ? `<div class="more">Ещё мастера: ${esc(title(m.service, m.city))}<ul>${neighbours.map((o) => `<li><a href="${o.path}">${esc(o.name)}</a></li>`).join("")}</ul></div>` : ""}
  <a href="${categoryPath}">← Все: ${esc(title(m.service, m.city))}</a>
  <div class="join"><b>Вы мастер?</b><span>Получите такую же страницу бесплатно, это 5 минут в Telegram: <a href="https://t.me/svoi_mastera_bot">@svoi_mastera_bot</a></span></div>
  <div class="more">Botika · каталог «Свои мастера» · <a href="/">nasta11.github.io</a></div>
</div>
<script>
document.getElementById("share").addEventListener("click", function () {
  var b = this, url = location.href.split("?")[0];
  if (navigator.share) { navigator.share({ title: document.title, url: url }).catch(function () {}); return; }
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { b.textContent = "Ссылка скопирована ✓"; }, function () { prompt("Ссылка на страницу:", url); });
});
</script>
<script>
// Counts taps on "Записаться" as GoatCounter events (zapis/<master>), no cookies.
document.addEventListener("click", function (e) {
  var a = e.target.closest && e.target.closest("a[data-zapis]"); if (!a) return;
  var gc = window.goatcounter, who = a.getAttribute("data-zapis");
  if (gc && gc.count) gc.count({ path: "zapis/" + who, title: "Записаться: " + who, event: true });
});
</script>
<script data-goatcounter="https://botika.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Answer pages: one per city (/mastera/<city>/) and «О проекте» (/mastera/o-proekte/),
// plus /llms.txt. Search engines and AI answers quote pages that answer a question
// directly ("где найти мастера в Нови-Саде, сколько стоит, как записаться"), so these
// pages say it in plain sentences, built from the live catalog.

const cityIn = (city) => (CITY_IN[city] ? `в ${CITY_IN[city]}` : `— ${city}`);
const lower1 = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const LANG_NAMES = (cards) => {
  const seen = new Map();
  for (const m of cards) for (const l of String(m.languages || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    const key = l.toLowerCase();
    if (!seen.has(key)) seen.set(key, l);
  }
  return [...seen.values()];
};

function shell({ title: pageTitle, h1, description, path, ld, crumbs, body }) {
  const url = `${SITE}${path}`;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- ${MARK}: do not edit by hand, the page is rebuilt from the catalog data -->
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:site_name" content="Botika">
<meta property="og:title" content="${esc(h1)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/mastera/og.jpg">
<meta name="twitter:card" content="summary_large_image">
${ld.map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`).join("\n")}
<style>
:root{--bg:#F6F1EC;--surface:#FFFFFF;--ink:#2A1F1C;--muted:#73655F;--line:#E6DCD4;--accent:#B4485E;--mint:#0B6E5B;--mint-soft:#E1F0EA}
@media (prefers-color-scheme: dark){:root{--bg:#1A1514;--surface:#241D1B;--ink:#F3EAE6;--muted:#B4A59F;--line:#3A2F2C;--accent:#E87F93;--mint:#55CFB2;--mint-soft:#1E302A;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.55}
.wrap{max-width:640px;margin:0 auto;padding:20px 16px 56px;display:flex;flex-direction:column;gap:18px}
a{color:var(--accent)}
nav.crumbs{font-size:14px;color:var(--muted)}
h1{font-size:clamp(26px,7vw,34px);line-height:1.15;margin:0}
h2{font-size:20px;margin:0}
p{margin:0}
.lead{font-size:17px}
section{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:8px}
section ul{margin:0;padding-left:18px}
section li{margin:4px 0}
.muted{color:var(--muted);font-size:14px}
.join{background:var(--mint);color:#fff;border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:6px}
.join a{color:#fff;font-weight:700}
.cta{display:inline-flex;align-self:flex-start;align-items:center;min-height:44px;padding:10px 18px;border-radius:12px;background:var(--accent);color:#fff;font-weight:700;text-decoration:none}
.more{font-size:14px;color:var(--muted)}
</style>
</head>
<body>
<div class="wrap">
  <nav class="crumbs">${crumbs}</nav>
  <h1>${esc(h1)}</h1>
  ${body}
  <div class="join"><b>Вы мастер?</b><span>Добавьте себя бесплатно, это 5 минут в Telegram: <a href="https://t.me/svoi_mastera_bot">@svoi_mastera_bot</a>. Вы получите свою страницу с прайсом, адресом, фото работ и кнопкой записи.</span></div>
  <div class="more"><a href="/mastera/o-proekte/">О проекте</a> · Botika · каталог «Свои мастера» · <a href="/">nasta11.github.io</a></div>
</div>
<script data-goatcounter="https://botika.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>
</body>
</html>
`;
}

function cityPageHtml(city, pages, allCities) {
  const cards = pages.flatMap((p) => p.cards);
  const path = `/mastera/${slug(city)}/`;
  const services = pages.map((p) => p.service);
  const langs = LANG_NAMES(cards);
  const from = cheapest(cards);
  const h1 = `Мастера ${cityIn(city)}: цены, адреса и запись`;
  const servicesText = services.map(lower1).join(", ");
  const answer = `Сейчас в каталоге «Свои мастера» ${cards.length} ${plural(cards.length)} ${cityIn(city)}: ${servicesText}. ` +
    `У каждого мастера указаны точные цены на каждую услугу, где он принимает (салон, на дому, выезд или онлайн) и как записаться — одной кнопкой в Telegram, WhatsApp или Viber, без посредников и комиссий.`;
  const description = `${cards.length} ${plural(cards.length)} ${cityIn(city)}: ${servicesText}.${from ? ` Цены ${from}.` : ""} Точный прайс, адрес и запись в один клик.`.slice(0, 300);

  const blocks = pages.map((p) => {
    const f = cheapest(p.cards);
    return `<section><h2><a href="${p.path}">${esc(p.service)}</a></h2>
    <p class="muted">${p.cards.length} ${plural(p.cards.length)}${f ? ` · цены ${f}` : ""}</p>
    <ul>${p.cards.map((m) => {
      const mf = cheapest([m]);
      return `<li><a href="${m.path}">${esc(m.name)}</a>${m.place ? ` — ${esc(lower1(m.place))}` : ""}${mf ? `, ${mf}` : ""}</li>`;
    }).join("")}</ul></section>`;
  }).join("\n  ");

  const faq = [
    [`Как найти мастера ${cityIn(city)}?`, `Откройте нужную услугу ниже или <a href="/mastera/?city=${encodeURIComponent(city)}">каталог с фильтрами и картой</a>. Выберите мастера по цене и месту приёма и нажмите «Записаться»: откроется чат с мастером.`],
    [`Сколько стоят услуги мастеров ${cityIn(city)}?`, `Цены указывают сами мастера, по каждой процедуре отдельно${from ? `; самые доступные — ${from}` : ""}. Точный прайс есть на странице каждого мастера.`],
    ...(langs.length ? [[`На каких языках говорят мастера?`, `Язык указан в карточке каждого мастера. Сейчас ${cityIn(city)}: ${langs.map(esc).join(", ")}.`]] : []),
    [`Каталог платный?`, `Нет. Искать мастеров и записываться бесплатно, мастера тоже добавляются бесплатно. Каталог не берёт комиссию и не участвует в оплате.`],
  ];

  const others = allCities.filter((c) => c !== city);
  const body = `<p class="lead">${esc(answer)}</p>
  <a class="cta" href="/mastera/?city=${encodeURIComponent(city)}">Каталог ${esc(cityIn(city))} с картой →</a>
  ${blocks}
  <section><h2>Вопросы и ответы</h2>${faq.map(([q, a]) => `<p><b>${esc(q)}</b><br>${a}</p>`).join("")}</section>
  ${others.length ? `<p class="more">Другие города: ${others.map((c) => `<a href="/mastera/${slug(c)}/">${esc(c)}</a>`).join(" · ")}</p>` : ""}`;

  const ld = [
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Свои мастера", item: `${SITE}/mastera/` },
      { "@type": "ListItem", position: 2, name: city, item: `${SITE}${path}` },
    ] },
    { "@context": "https://schema.org", "@type": "ItemList", name: h1, numberOfItems: cards.length,
      itemListElement: cards.map((m, i) => ({ "@type": "ListItem", position: i + 1, name: m.name, url: `${SITE}${m.path}` })) },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({
      "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a.replace(/<[^>]+>/g, "") } })) },
  ];
  return { path, html: shell({ title: `${h1} · Свои мастера`, h1, description, path, ld, crumbs: `<a href="/mastera/">Свои мастера</a> › ${esc(city)}`, body }) };
}

function aboutPageHtml(cards, cities, pages) {
  const path = "/mastera/o-proekte/";
  const h1 = "О проекте «Свои мастера»";
  const services = [...new Set(pages.map((p) => p.service))];
  const description = `«Свои мастера» — бесплатный каталог мастеров в Сербии: ${cities.join(", ")}. Точные цены, адрес и запись в один клик. Сейчас ${cards.length} ${plural(cards.length)}.`;
  const body = `<p class="lead">«Свои мастера» — бесплатный каталог мастеров и специалистов в Сербии от Botika. Он помогает своим находить своих: клиент сразу видит, <b>сколько точно стоит</b> каждая услуга, <b>где принимает</b> мастер и <b>как записаться</b>.</p>
  <section><h2>Что есть в каталоге сейчас</h2>
    <p>${cards.length} ${plural(cards.length)} в городах: ${cities.map((c) => `<a href="/mastera/${slug(c)}/">${esc(c)}</a>`).join(", ")}.</p>
    <p>Услуги: ${services.map((s) => esc(lower1(s))).join(", ")}.</p></section>
  <section><h2>Для клиентов</h2><ul>
    <li>Точный прайс по каждой процедуре, а не «цена по договорённости».</li>
    <li>Где принимает мастер: салон, кабинет, на дому, выезд или онлайн; адрес и карта.</li>
    <li>Запись одной кнопкой: открывается Telegram, WhatsApp или Viber мастера. Без регистрации, посредников и комиссий.</li>
    <li>Фото работ и язык, на котором говорит мастер.</li></ul></section>
  <section><h2>Для мастеров</h2><ul>
    <li>Бесплатно. Карточка заполняется за 5 минут в Telegram-боте <a href="https://t.me/svoi_mastera_bot">@svoi_mastera_bot</a>, документы не нужны.</li>
    <li>Своя страница с прайсом, адресом, фото работ и кнопкой записи — ссылку можно поставить в Instagram.</li>
    <li>Можно отметить, что ищете постоянную работу: салоны и семьи найдут вас по фильтру.</li>
    <li>Цены и фото можно менять в любой момент, карточку можно удалить.</li></ul></section>
  <section><h2>Как это устроено</h2>
    <p>Каталог не берёт комиссию и не участвует в оплате: клиент договаривается с мастером напрямую. Новые карточки проверяются перед публикацией. Страницы мастеров и городов обновляются автоматически.</p></section>
  <a class="cta" href="/mastera/">Открыть каталог →</a>`;
  const ld = [
    { "@context": "https://schema.org", "@type": "WebSite", name: "Свои мастера", alternateName: "Botika · Свои мастера", url: `${SITE}/mastera/`, inLanguage: ["ru", "uk"],
      description, publisher: { "@type": "Organization", name: "Botika", url: `${SITE}/` } },
    { "@context": "https://schema.org", "@type": "AboutPage", name: h1, url: `${SITE}${path}` },
  ];
  return { path, html: shell({ title: `${h1} · Botika`, h1, description, path, ld, crumbs: `<a href="/mastera/">Свои мастера</a> › О проекте`, body }) };
}

function llmsTxt(cards, cities, pages) {
  return `# Свои мастера (Botika)

> Бесплатный каталог мастеров и специалистов в Сербии: ${cities.join(", ")}. У каждого мастера — точные цены на каждую услугу, где он принимает, фото работ и запись в один клик (Telegram, WhatsApp, Viber). Без комиссий. Сейчас ${cards.length} ${plural(cards.length)}.

Мастера добавляются бесплатно через Telegram-бота https://t.me/svoi_mastera_bot. Каталог обновляется автоматически.

## Главное
- [Каталог с фильтрами и картой](${SITE}/mastera/)
- [О проекте](${SITE}/mastera/o-proekte/)

## Города
${cities.map((c) => { const n = pages.filter((p) => p.city === c).reduce((a, p) => a + p.cards.length, 0); return `- [Мастера ${cityIn(c)}](${SITE}/mastera/${slug(c)}/): ${n} ${plural(n)}`; }).join("\n")}

## Услуги по городам
${pages.map((p) => `- [${title(p.service, p.city)}](${SITE}${p.path}): ${p.cards.length} ${plural(p.cards.length)}${cheapest(p.cards) ? `, цены ${cheapest(p.cards)}` : ""}`).join("\n")}
`;
}

// Pages this script made earlier (it only ever deletes its own).
function oldPages(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    const page = join(full, "index.html");
    if (existsSync(page) && readFileSync(page, "utf8").includes(MARK)) out.push(full);
    oldPages(full, out);
  }
  return out;
}

async function main() {
  const data = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : await (await fetch(API)).json();
  const cards = (data.cards || []).filter((c) => c.name && c.city && c.service);
  if (!Array.isArray(data.cards)) throw new Error("API answered without cards");

  // A stable address for every master: /mastera/m/<name>-<city>/ (namesakes get -2, -3 by id).
  const used = new Set();
  for (const c of [...cards].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")))) {
    // "Дмитрий барбер Белград" already names the city: no "-belgrad-belgrad".
    const name = slug(c.name), city = slug(c.city);
    const base = `-${name}-`.includes(`-${city}-`) ? name : `${name}-${city}`;
    let s = base, n = 2;
    while (used.has(s)) s = `${base}-${n++}`;
    used.add(s);
    c.path = `/mastera/m/${s}/`;
  }

  const groups = new Map();
  for (const c of cards) {
    const key = `${c.city}\u0000${c.service}`;
    if (!groups.has(key)) groups.set(key, { city: c.city, service: c.service, cards: [] });
    groups.get(key).cards.push(c);
  }
  const pages = [...groups.values()].map((g) => ({ ...g, path: `/mastera/${slug(g.city)}/${slug(g.service)}/` }));
  pages.sort((a, b) => a.path.localeCompare(b.path));

  for (const dir of oldPages(MASTERA)) rmSync(dir, { recursive: true, force: true });
  for (const p of pages) {
    const others = pages.filter((o) => o !== p && (o.city === p.city || o.service === p.service)).slice(0, 12);
    const dir = join(ROOT, p.path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), pageHtml({ ...p, others }));
  }

  // Master pages.
  for (const p of pages) {
    p.cards.forEach((m, i) => {
      const neighbours = p.cards.filter((o) => o !== m).slice(0, 10);
      const dir = join(ROOT, m.path);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), masterPageHtml(m, i, { categoryPath: p.path, neighbours }));
    });
  }
  // City answer pages, «О проекте» and llms.txt.
  const cities = [...new Set(pages.map((p) => p.city))].sort((a, b) => pages.filter((p) => p.city === b).length - pages.filter((p) => p.city === a).length);
  const extra = [];
  for (const city of cities) extra.push(cityPageHtml(city, pages.filter((p) => p.city === city), cities));
  extra.push(aboutPageHtml(cards, cities, pages));
  for (const page of extra) {
    mkdirSync(join(ROOT, page.path), { recursive: true });
    writeFileSync(join(ROOT, page.path, "index.html"), page.html);
  }
  writeFileSync(join(ROOT, "llms.txt"), llmsTxt(cards, cities, pages));

  // id → page address, so the main catalog can link each card to its page.
  const paths = Object.fromEntries(cards.filter((c) => c.id != null).map((c) => [String(c.id), c.path]));
  mkdirSync(join(MASTERA, "m"), { recursive: true });
  writeFileSync(join(MASTERA, "m", "paths.json"), JSON.stringify(paths, null, 1) + "\n");

  // Links from the catalog page, so search engines find the pages there too.
  const indexPath = join(MASTERA, "index.html");
  const index = readFileSync(indexPath, "utf8");
  // Folded away under «Все города и услуги»: search engines still follow the links,
  // people see one quiet line instead of a wall of links.
  const byCity = cities.map((c) => `<p><a href="/mastera/${slug(c)}/"><b>${esc(c)}</b></a>: ${pages.filter((p) => p.city === c).map((p) => `<a href="${p.path}">${esc(p.service)}</a>`).join(" · ")}</p>`).join("");
  const block = `<!-- seo-links:start -->${pages.length ? `<details class="seo"><summary>Все города и услуги</summary>${byCity}<p><a href="/mastera/o-proekte/">О проекте «Свои мастера»</a></p></details>` : ""}<!-- seo-links:end -->`;
  writeFileSync(indexPath, index.replace(/<!-- seo-links:start -->[\s\S]*?<!-- seo-links:end -->/, block));

  // Sitemap: the three main pages plus one line per generated page. No dates,
  // so a run that changes nothing leaves the file (and the repository) as it was.
  const urls = ["/", "/mastera/", "/radar/", ...extra.map((e) => e.path), ...pages.map((p) => p.path), ...cards.map((c) => c.path)];
  writeFileSync(join(ROOT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join("\n")}
</urlset>
`);
  console.log(`${pages.length} pages:\n${pages.map((p) => `  ${p.path}  ${title(p.service, p.city)} (${p.cards.length})`).join("\n")}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
