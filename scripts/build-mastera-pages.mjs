// Builds a static page for every master (/mastera/m/<name>-<city>/) and for every "city + service" pair that has at least one master,
// e.g. /mastera/novi-sad/massazh/ "Массаж в Нови-Саде". Google shows such pages for
// searches like "массаж нови сад"; the main catalog loads its cards with JavaScript,
// which search engines read poorly. Run by .github/workflows/mastera-pages.yml.
//
//   node scripts/build-mastera-pages.mjs            fetch masters from the API
//   node scripts/build-mastera-pages.mjs data.json  use a saved API answer instead

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

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
<link href="${BOTIKA_FONT}" rel="stylesheet">
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
<style>${LIST_STYLE}</style>
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

// A price as HTML: the number in the serif, "от" and the currency smaller and quieter.
const moneyHtml = (p) => {
  const amount = p.priceTo ? `${num(p.price)}–${num(p.priceTo)}` : `${p.from ? "<small>от</small> " : ""}${num(p.price)}`;
  return `${amount} <small>${p.currency === "€" ? "€" : "дин"}</small>`;
};

// Lessons and sessions are chosen by the person and the room, not by "works":
// their photo strip gets its own heading and the photos are not called works.
const LESSONS = ["Репетиторы и языки", "Занятия и мастер-классы", "Спорт и фитнес", "Психолог"];

// "Русский, Srpski" → "русский, srpski": language names are lower case mid-sentence.
const langs = (s) => String(s || "").split(/\s*,\s*/).filter(Boolean).map((l) => l.toLowerCase()).join(", ");

const ICON_TG = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4 3 11l6 2.5L18 7l-7 8 7 5z"/></svg>';
const ICON_SHARE = '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7.5 7.5 4.5-4.5 4.5 4.5"/><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2"/></svg>';

// ---------------------------------------------------------------------------
// The picture a messenger shows when someone sends a master's link
// (og:image, 1200×630): name, what they do, the lowest price, address and
// the first work photo (or the first prices when there is no photo yet).
// Drawn by headless Chrome, which GitHub's runners have; redrawn only when
// the card changes, so an hourly run with no changes commits nothing.

const OG_VERSION = "1";

function ogCardHtml(m, i) {
  const cityIn = CITY_IN[m.city] ? `в ${CITY_IN[m.city]}` : m.city;
  const photo = (Array.isArray(m.photos) ? m.photos : []).find(isHttps);
  const prices = (m.prices || []).filter((p) => p && p.name && Number(p.price) > 0).slice(0, 4);
  const from = cheapest([m]).match(/^от (.+) (дин|€)$/);
  const avatar = isHttps(m.photo)
    ? `<img class="ava" src="${esc(m.photo)}" alt="">`
    : `<div class="ava" style="background:${PAL[i % PAL.length]}">${esc((m.name || "?").charAt(0))}</div>`;
  const side = photo
    ? `<img class="side photo" src="${esc(photo)}" alt="">`
    : prices.length
      ? `<div class="side list">${prices.map((p) => `<div class="row"><span class="n">${esc(p.name)}</span><span class="p">${moneyHtml(p)}</span></div>`).join("")}</div>`
      : "";
  const size = String(m.name || "").length > 20 ? 58 : 72;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
html,body{margin:0;width:1200px;height:630px;overflow:hidden}
body{background:#F7EEF0;color:#2E1A2B;font-family:system-ui,-apple-system,"Segoe UI",Inter,"DejaVu Sans",sans-serif;display:flex;gap:56px;padding:64px 64px 60px 80px}
.main{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between}
.ava{width:88px;height:88px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:600 40px Lora,Georgia,serif;color:#fff;object-fit:cover;box-shadow:0 0 0 5px #fff}
h1{margin:22px 0 0;font:600 ${size}px/1.04 Lora,Georgia,serif;letter-spacing:-.5px;text-wrap:balance;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sub{margin:14px 0 0;font-size:30px;line-height:1.3;color:#7C6676}
.from{display:flex;align-items:baseline;gap:12px;color:#7C6676;font-size:28px}
.from b{font:600 56px Lora,Georgia,serif;color:#8C2F5E}
.foot{display:flex;align-items:center;gap:10px;margin-top:16px;font-size:22px;color:#7C6676}
.foot .brand{margin-left:auto;font-weight:600;color:#2E1A2B;white-space:nowrap}
.foot .addr{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side{width:400px;flex:none;border-radius:32px}
.photo{height:100%;object-fit:cover;background:#EEDDE3}
.list{background:#fff;padding:30px 30px;display:flex;flex-direction:column;justify-content:center;gap:6px}
.row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;font-size:22px;line-height:1.25}
.row+.row{border-top:2px dotted #CDB8C3}
.row .p{font:600 24px Lora,Georgia,serif;white-space:nowrap}
.row .p small{font:400 18px system-ui,sans-serif;color:#7C6676}
</style></head>
<body>
<div class="main">
  <div>${avatar}
    <h1>${esc(m.name)}</h1>
    <p class="sub">${m.headline ? esc(m.headline) : `${esc(m.service)} ${esc(cityIn)}`}</p>
  </div>
  <div>
    ${from ? `<div class="from">от <b>${esc(from[1])}</b> ${esc(from[2])}</div>` : ""}
    <div class="foot">${m.placeNote ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8C2F5E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg><span class="addr">${esc(m.placeNote)}</span>` : ""}<span class="brand">Свои мастера · Botika</span></div>
  </div>
</div>
${side}
</body></html>
`;
}

// The first Chrome that works is kept; if none does, pages fall back to the first work photo.
let chrome;
function renderPng(html, out) {
  if (chrome === false) return false;
  const dir = mkdtempSync(join(tmpdir(), "og-"));
  const src = join(dir, "og.html");
  writeFileSync(src, html);
  const bins = chrome ? [chrome] : [process.env.CHROME, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].filter(Boolean);
  try {
    for (const bin of bins) {
      try {
        execFileSync(bin, [
          "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
          "--window-size=1200,630", "--virtual-time-budget=15000", `--screenshot=${out}`, `file://${src}`,
        ], { stdio: "ignore", timeout: 90_000 });
        if (existsSync(out)) { chrome = bin; return true; }
      } catch { /* try the next one */ }
    }
    if (!chrome) { chrome = false; console.warn("No headless Chrome: link previews use the first work photo."); }
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Look of a master's page, keyed by the page slug (/mastera/m/<slug>/); a page without
// its own entry gets "elegant", the catalog-wide look.
// A theme only adds CSS on top of the shared page, so content and data stay the same.
const THEMES = {
  "viktoriya-podolog-subotitsa": "elegant",
};
const THEME_FONTS = {
  elegant: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap",
};
// The same «изящный» look for the list pages (city + service, city, «О проекте»).
// mastera/index.html carries a copy of this block (marked "elegant"); keep the two in step.
const ELEGANT_FONT = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap";
const LIST_ELEGANT_CSS = `
:root{--bg:#F8F4EE;--surface:#FFFDF9;--ink:#2B2420;--muted:#8B7E73;--line:#E4D9CB;--accent:#7A5C3E;--accent-ink:#FFFDF9;--soft:#F2ECE3;--mint:#2B2420;--mint-soft:#F2ECE3;--gold:#B8976A;--serif:"Cormorant Garamond",Georgia,"Times New Roman",serif;--display:var(--serif)}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#17130F;--surface:#211B16;--ink:#F3EBE1;--muted:#B3A595;--line:#3A3129;--accent:#D9B98A;--accent-ink:#17130F;--soft:#2A221B;--mint:#F3EBE1;--mint-soft:#1E1914;--gold:#C9A877;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#17130F;--surface:#211B16;--ink:#F3EBE1;--muted:#B3A595;--line:#3A3129;--accent:#D9B98A;--accent-ink:#17130F;--soft:#2A221B;--mint:#F3EBE1;--mint-soft:#1E1914;--gold:#C9A877;color-scheme:dark}
body{letter-spacing:.1px}
h1{font-family:var(--serif);font-weight:500;font-size:clamp(34px,9vw,44px);line-height:1.05;letter-spacing:.2px}
h1::after{content:"";display:block;width:56px;height:1px;background:var(--gold);margin-top:14px}
h2{font-family:var(--serif);font-weight:500;font-size:24px}
.card,section,.state,.empty,#map{border-radius:6px}
.card,section,.state{border-color:var(--line);box-shadow:0 1px 0 rgba(43,36,32,.02)}
.who b,.who h2{font-family:var(--serif);font-weight:500;font-size:23px;line-height:1.15}
.ava{background:var(--surface)!important;color:var(--gold)!important;border:1px solid var(--gold);padding:3px;font-family:var(--serif);font-weight:500;font-size:24px}
.lbl,.bh,caption{color:var(--gold);font-weight:500;font-size:11px;letter-spacing:.22em;text-transform:uppercase}
.tag{font-family:inherit;color:var(--gold);border-color:var(--gold);letter-spacing:.15em}
.place{background:var(--soft);border-radius:4px}
.uses span{background:transparent;border-color:var(--line);border-radius:999px}
.uses span.dev::before{color:var(--gold)}
td{border-bottom:1px dotted var(--line)}
td:first-child{font-family:var(--serif);font-size:18px}
td.p{font-family:var(--serif);font-weight:500;font-size:19px}
.book .tg,.book a{font-family:inherit}
.chips button,.view,.langs{background:transparent}
.chips button[aria-pressed="true"],.view button[aria-pressed="true"],.langs button[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--bg)}
.demo{font-family:inherit;background:var(--soft);color:var(--accent);border-radius:4px;letter-spacing:.18em}
.join{background:var(--ink);color:var(--bg);border-radius:6px}
.join a:not(.btn){color:var(--bg)}
.join b{font-family:var(--serif);font-weight:500;font-size:22px}
.btn{background:var(--bg);color:var(--ink);border-radius:999px;letter-spacing:.12em;text-transform:uppercase;font-size:13px;font-weight:500}
.cta{background:var(--ink);color:var(--bg);border-radius:999px;letter-spacing:.12em;text-transform:uppercase;font-size:13px;font-weight:500}
.more,.pagelink{color:var(--accent)}
.leaflet-popup-content{font-family:inherit}
.leaflet-popup-content button{color:#7A5C3E}
`;

const BOTIKA_FONT = "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;1,400&family=Golos+Text:wght@400;500;600&display=swap";
// «Botika studio» look, the same as /usluge/: powder, plum ink, berry, sage; Playfair Display + Golos Text.
// It sits on top of LIST_ELEGANT_CSS. mastera/index.html carries a copy (marked "botika"); keep the two in step.
const LIST_BOTIKA_CSS = `
:root{--bg:#F2EDEA;--surface:#FBF8F6;--ink:#1F1418;--muted:#76666B;--line:#E6DBD6;--accent:#8A3A50;--accent-ink:#FBF8F6;--soft:#EDE3DF;--mint:#1F1418;--mint-soft:#E6ECE6;--gold:#8A3A50;--serif:"Playfair Display",Georgia,serif;--display:var(--serif);--body:"Golos Text",system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#1A1014;--surface:#24161C;--ink:#F2E6E9;--muted:#B9A5AB;--line:#3A2A31;--accent:#E3A0B3;--accent-ink:#1A1014;--soft:#2E1E25;--mint:#F2E6E9;--mint-soft:#202620;--gold:#E3A0B3;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#1A1014;--surface:#24161C;--ink:#F2E6E9;--muted:#B9A5AB;--line:#3A2A31;--accent:#E3A0B3;--accent-ink:#1A1014;--soft:#2E1E25;--mint:#F2E6E9;--mint-soft:#202620;--gold:#E3A0B3;color-scheme:dark}
body{font-family:var(--body);letter-spacing:0}
h1{font-weight:400;letter-spacing:-.03em;line-height:1}
h1::after{background:var(--accent);width:40px}
h2,.who b,.who h2,.join b{font-weight:400;letter-spacing:-.015em}
.card,section,.state,.empty,#map{border-radius:22px}
.card,section,.state{border-color:transparent;box-shadow:0 1px 0 var(--line),0 18px 40px rgba(31,20,24,.05)}
.ava{background:linear-gradient(135deg,#E3B7C1,#8A3A50)!important;color:#fff!important;border:0;padding:0}
.lbl,.bh,caption{color:var(--muted);font:italic 400 15px/1.2 var(--serif);letter-spacing:0;text-transform:none}
.tag{color:var(--accent);border-color:var(--line);letter-spacing:.04em}
td:first-child{font-family:var(--body);font-size:15px}
td.p{font-family:var(--body);font-weight:600;font-size:15px}
.place{background:var(--soft);border-radius:14px}
.join{border-radius:26px}
.btn,.cta,.demo{text-transform:none;letter-spacing:0;font-size:15px}
.btn,.cta{font-weight:500}
.cta:hover{background:var(--accent)}
.leaflet-popup-content button{color:#8A3A50}
.chips button[aria-pressed="true"],.view button[aria-pressed="true"],.langs button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.join{background:var(--deep);color:#F7EEF0}
.join a:not(.btn){color:#F7EEF0}
.btn{background:#F7EEF0;color:var(--deep)}
.cta{background:var(--accent);color:var(--accent-ink)}
.cta:hover{background:var(--deep)}
:root{--deep:#4A2433}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--deep:#5A2C3E}}
:root[data-theme="dark"]{--deep:#5A2C3E}
`;
const LIST_STYLE = LIST_ELEGANT_CSS + LIST_BOTIKA_CSS;
const THEME_CSS = {
  // «Изящный»: ivory and champagne, thin gold lines, a light high-contrast serif, lots of air.
  elegant: `
:root{--powder:#F8F4EE;--paper:#FFFDF9;--plum:#2B2420;--muted:#8B7E73;--berry:#7A5C3E;--sage:#F2ECE3;--leader:#D9CBB8;--select:#EADCC6;--gold:#B8976A;--serif:"Cormorant Garamond",Lora,Georgia,serif}
@media (prefers-color-scheme: dark){:root{--powder:#17130F;--paper:#211B16;--plum:#F3EBE1;--muted:#B3A595;--berry:#D9B98A;--sage:#1E1914;--leader:#4A3F33;--select:#4A3A28;--gold:#C9A877}}
body{letter-spacing:.1px}
.wrap{gap:30px}
.who{flex-direction:column;text-align:center;gap:16px;margin-top:40px}
.ava{width:112px;height:112px;border:1px solid var(--gold);padding:5px;background:var(--paper);font:500 44px var(--serif);color:var(--gold)}
h1{font:500 clamp(34px,10vw,44px)/1.05 var(--serif);letter-spacing:.2px}
h1::after{content:"";display:block;width:56px;height:1px;background:var(--gold);margin:16px auto 0}
.lead{font-size:14px;letter-spacing:.3px;line-height:1.7}
.card,.card.sage{border-radius:6px;border:1px solid var(--leader);padding:28px 24px;box-shadow:0 1px 0 rgba(43,36,32,.02)}
h2{font:500 12px/1 system-ui,-apple-system,"Segoe UI",Inter,sans-serif;letter-spacing:3px;text-transform:uppercase;color:var(--gold);text-align:center;margin:0 0 18px}
.works-h{font:500 12px/1 system-ui,-apple-system,"Segoe UI",Inter,sans-serif;letter-spacing:3px;text-transform:uppercase;color:var(--gold);text-align:center}
.works img{border-radius:6px}
.row{padding:12px 0}
.row .n{font:400 19px/1.25 var(--serif)}
.row .dots{border-bottom:1px dotted var(--gold);opacity:.7}
.row .p{font:500 20px var(--serif)}
.note{text-align:center;font-style:italic;font-family:var(--serif);font-size:15px;margin-top:12px}
.card.sage p{text-align:center;font:400 19px/1.4 var(--serif)}
.map{border-radius:4px;filter:grayscale(.85) sepia(.25) contrast(.95)}
@media (prefers-color-scheme: dark){.map{filter:grayscale(.9) sepia(.2) brightness(.8)}}
.route{display:block;text-align:center;font-weight:500;letter-spacing:.5px;text-decoration:none;border-bottom:0}
.uses{justify-content:center}
.uses span{background:transparent;border:1px solid var(--leader);border-radius:999px;font:400 17px var(--serif);padding:6px 16px}
.review{text-align:center}
.review p{font:italic 400 19px/1.45 var(--serif)}
.more,.join,.foot{text-align:center}
.bar{background:linear-gradient(rgba(248,244,238,0),var(--powder) 35%)}
@media (prefers-color-scheme: dark){.bar{background:linear-gradient(rgba(23,19,15,0),var(--powder) 35%)}}
.book{background:var(--plum);color:var(--powder);font-weight:500;letter-spacing:1.5px;text-transform:uppercase;font-size:14px;box-shadow:0 10px 28px rgba(43,36,32,.22)}
.share{border:1px solid var(--leader);box-shadow:none}
`,
};


// «Botika studio» look for a master's page: the elegant layout, recoloured and retyped like /usluge/.
THEME_FONTS.botika = BOTIKA_FONT;
THEME_CSS.botika = THEME_CSS.elegant + `
:root{--powder:#F2EDEA;--paper:#FBF8F6;--plum:#1F1418;--muted:#76666B;--berry:#8A3A50;--sage:#E6ECE6;--leader:#E2D5D0;--select:#EBD3DA;--gold:#8A3A50;--serif:"Playfair Display",Georgia,serif}
@media (prefers-color-scheme: dark){:root{--powder:#1A1014;--paper:#24161C;--plum:#F2E6E9;--muted:#B9A5AB;--berry:#E3A0B3;--sage:#202620;--leader:#3A2A31;--select:#4A2A36;--gold:#E3A0B3}}
body{font-family:"Golos Text",system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0}
.ava{border:0;padding:0;background:linear-gradient(135deg,#E3B7C1,#8A3A50)!important;color:#fff!important;font:400 44px var(--serif)}
h1{font:400 clamp(36px,10vw,48px)/1 var(--serif);letter-spacing:-.03em}
h1::after{width:40px;background:var(--berry)}
.card,.card.sage{border-radius:24px;border:0;box-shadow:0 1px 0 var(--leader),0 18px 40px rgba(31,20,24,.05)}
h2,.works-h{font:italic 400 18px/1.2 var(--serif);letter-spacing:0;text-transform:none;color:var(--muted)}
.row .n{font:400 15px/1.35 "Golos Text",system-ui,sans-serif}
.row .p{font:600 15px "Golos Text",system-ui,sans-serif}
.row .dots{border-bottom-color:var(--leader);opacity:1}
.works img{border-radius:14px}
.map{border-radius:18px;filter:saturate(.6) sepia(.08)}
.uses span{font:400 14px "Golos Text",system-ui,sans-serif}
.book{letter-spacing:0;text-transform:none;font-size:16px;box-shadow:0 10px 28px rgba(31,20,24,.22)}
.bar{background:linear-gradient(rgba(242,237,234,0),var(--powder) 35%)}
@media (prefers-color-scheme: dark){.bar{background:linear-gradient(rgba(26,16,20,0),var(--powder) 35%)}}.book{background:var(--berry);color:#FBF8F6}
@media (prefers-color-scheme: dark){.book{color:#1A1014}}
`;

function masterPageHtml(m, i, { categoryPath, neighbours, og }) {
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
  const uses = [m.devices, m.cosmetics].filter(Boolean).map((u) => `<span>${esc(u)}</span>`).join("");
  // Price list like a salon price card: name, dotted leader, price.
  const rows = prices.map((p) => `<div class="row"><span class="n">${esc(p.name)}${p.duration ? `<small>${esc(p.duration)}</small>` : ""}</span><i class="dots" aria-hidden="true"></i><span class="p">${moneyHtml(p)}</span></div>`).join("");
  const lessons = LESSONS.includes(m.service);
  // The sticky button says where it leads.
  const via = !href ? "" : /t\.me\//.test(href) ? " в Telegram" : /wa\.me|whatsapp/.test(href) ? " в WhatsApp" : /viber/.test(href) ? " в Viber" : "";
  const bookText = href && /^tel:/.test(href) ? "Позвонить" : `Записаться${via}`;
  const rating = reviews.filter((r) => Number(r.rating) > 0);
  const avg = rating.length ? (rating.reduce((a, r) => a + Number(r.rating), 0) / rating.length) : 0;

  let map = "";
  if (hasPoint) {
    const d = 0.004;
    const bbox = [m.lon - d, m.lat - d / 1.5, m.lon + d, m.lat + d / 1.5].map((x) => x.toFixed(5)).join(",");
    map = `<iframe class="map" title="Карта" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&amp;layer=mapnik&amp;marker=${m.lat},${m.lon}"></iframe>
    <a class="route" href="https://www.google.com/maps/dir/?api=1&amp;destination=${m.lat},${m.lon}" rel="noopener">Построить маршрут</a>`;
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
  const theme = THEMES[String(m.path || "").split("/").filter(Boolean).pop()] || "botika";

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
${og ? `<!-- og-src:${og.hash} -->
<meta property="og:image" content="${esc(og.url)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(m.name)} — ${esc(m.service)} ${esc(cityIn)}">` : `<meta property="og:image" content="${photos[0] ? esc(photos[0]) : `${SITE}/mastera/og.jpg`}">`}
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${json(ld)}</script>
<script type="application/ld+json">${json(crumbs)}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600&display=swap" rel="stylesheet">
${theme && THEME_FONTS[theme] ? `<link href="${THEME_FONTS[theme]}" rel="stylesheet">` : ""}
<style>
:root{--powder:#F7EEF0;--paper:#FFFFFF;--plum:#2E1A2B;--muted:#7C6676;--berry:#8C2F5E;--sage:#E3ECE2;--leader:#CDB8C3;--select:#EBC6D3;--serif:Lora,Georgia,"Times New Roman",serif;--ease-out:cubic-bezier(0.23,1,0.32,1)}
@media (prefers-color-scheme: dark){:root{--powder:#1C1419;--paper:#2A1F27;--plum:#F5E9F0;--muted:#BBA5B4;--berry:#C9558E;--sage:#22302A;--leader:#5A4554;--select:#5C2D47;color-scheme:dark}}
*{box-sizing:border-box}
html{accent-color:var(--berry);caret-color:var(--berry)}
::selection{background:var(--select);color:var(--plum)}
body{margin:0;background:var(--powder);color:var(--plum);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Inter,sans-serif;padding-bottom:104px}
a{color:var(--berry);text-underline-offset:3px}
a:focus-visible,button:focus-visible{outline:3px solid var(--plum);outline-offset:3px}
.works-h{margin:20px auto 0;padding:0 18px;max-width:560px;font:600 17px/1.2 var(--serif)}
.works{display:flex;gap:8px;overflow-x:auto;padding:16px 16px 0;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch}
.works-h+.works{padding-top:10px}
.works a{flex:none;scroll-snap-align:start}
.works img{height:240px;max-width:80vw;object-fit:cover;border-radius:22px;display:block;background:var(--paper)}
.wrap{max-width:560px;margin:0 auto;padding:0 18px;display:flex;flex-direction:column;gap:22px}
.who{display:flex;gap:14px;align-items:center;margin-top:20px}
.ava{width:62px;height:62px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font:600 26px var(--serif);color:#fff;object-fit:cover;border:3px solid var(--paper)}
h1{margin:0;font:600 clamp(26px,7.5vw,32px)/1.1 var(--serif);letter-spacing:-.3px;text-wrap:balance}
.lead{margin:3px 0 0;color:var(--muted);font-size:15px}
.stars{color:#B8863B;font-weight:600}
.job{display:inline-block;margin-top:6px;font-size:13px;color:var(--berry);background:var(--paper);border-radius:999px;padding:3px 10px}
.card{background:var(--paper);border-radius:28px;padding:22px 20px}
.card.sage{background:var(--sage)}
h2{margin:0 0 8px;font:600 21px/1.2 var(--serif)}
/* The price sits on the last line of a long name, like on a salon price card. */
.row{display:flex;align-items:flex-end;align-items:last baseline;gap:8px;padding:10px 0}
.row .n{flex:0 1 auto;min-width:0}
.row .n small{display:block;color:var(--muted);font-size:13px}
.row .dots{flex:1 1 16px;min-width:16px;border-bottom:2px dotted var(--leader);transform:translateY(-5px)}
.row .p{flex:none;font:600 18px var(--serif);white-space:nowrap;font-variant-numeric:lining-nums}
.row .p small{font:400 14px system-ui,-apple-system,"Segoe UI",Inter,sans-serif;color:var(--muted)}
.note{color:var(--muted);font-size:13px;margin:6px 0 0}
.card p{margin:4px 0 0}
/* OpenStreetMap's bright tiles, softened to sit on the sage card. */
.map{width:100%;height:190px;border:0;border-radius:18px;margin-top:14px;display:block;filter:saturate(.55)}
@media (prefers-color-scheme: dark){.map{filter:saturate(.5) brightness(.85)}}
.route{display:inline-block;margin-top:8px;padding:6px 0;color:var(--berry);font-weight:600;text-decoration-thickness:1.5px}
.uses{display:flex;flex-wrap:wrap;gap:8px}
.uses span{background:var(--paper);border-radius:999px;padding:7px 14px;font-size:14px}
.review{padding:10px 0;border-bottom:1px dotted var(--leader)}
.review:last-child{border-bottom:0}
.review p{margin:4px 0 0}
.review small{color:var(--muted)}
.more{font-size:14px;color:var(--muted)}
.more ul{padding-left:18px;margin:6px 0 0}
.join{color:var(--muted);font-size:14px;text-align:center;margin:0}
.foot{font-size:13px;color:var(--muted);text-align:center;margin:0}
.bar{position:fixed;left:0;right:0;bottom:0;padding:14px 16px 18px;background:linear-gradient(rgba(247,238,240,0),var(--powder) 35%);display:flex;gap:10px;justify-content:center}
@media (prefers-color-scheme: dark){.bar{background:linear-gradient(rgba(28,20,25,0),var(--powder) 35%)}}
.book{flex:1;max-width:460px;display:flex;align-items:center;justify-content:center;gap:10px;min-height:54px;border-radius:999px;background:var(--berry);color:#fff;font-weight:600;font-size:17px;text-decoration:none;box-shadow:0 8px 24px rgba(140,47,94,.28)}
.share{width:54px;height:54px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--paper);border:0;font-size:20px;color:var(--plum);cursor:pointer;box-shadow:0 8px 24px rgba(140,47,94,.16)}
.share.done{font-size:14px;width:auto;padding:0 16px;border-radius:999px}
/* A tap shows at once: the button gives a little under the finger. */
.book:active{transform:scale(.97)}
.share:active{transform:scale(.95)}
@media (prefers-reduced-motion: no-preference){.book,.share{transition:transform 160ms var(--ease-out)}}
</style>
${theme && THEME_CSS[theme] ? `<style>${THEME_CSS[theme]}</style>` : ""}
</head>
<body>
${photos.length ? `${lessons ? '<h2 class="works-h">Как проходят занятия</h2>' : ""}<div class="works">${photos.map((p, k) => `<a href="${esc(p)}" target="_blank" rel="noopener"><img src="${esc(p)}" alt="${lessons ? "Фото" : "Работа"} ${k + 1}" ${k ? 'loading="lazy"' : ""}></a>`).join("")}</div>` : ""}
<div class="wrap">
  <div class="who">${avatar}<div>
    <h1>${esc(h1)}</h1>
    <p class="lead">${m.headline ? esc(m.headline) : `${esc(m.service)} ${esc(cityIn)}`}${m.languages ? `<br>Языки: ${esc(langs(m.languages))}` : ""}</p>
    ${rating.length ? `<p class="lead"><span class="stars">★ ${avg.toFixed(1)}</span>, ${reviews.length} отз.</p>` : ""}
    ${m.seeksJob ? '<span class="job">Ищет постоянную работу</span>' : ""}
  </div></div>

  ${rows ? `<section class="card"><h2>Цены</h2>${rows}<p class="note">Цены указаны мастером.</p></section>` : ""}

  <section class="card sage"><h2>${esc(m.place || "Где принимает")}</h2>
    ${m.placeNote ? `<p>${esc(m.placeNote)}</p>` : ""}
    ${map}
  </section>

  ${uses ? `<section><h2>Чем работает</h2><div class="uses">${uses}</div></section>` : ""}

  ${reviews.length ? `<section class="card"><h2>Отзывы</h2>${reviews.map((r) => `<div class="review"><b>${esc(r.author || "Клиент")}</b>${Number(r.rating) > 0 ? ` <span class="stars">${"★".repeat(Math.min(5, Math.round(Number(r.rating))))}</span>` : ""}${r.date ? ` <small>${esc(r.date)}</small>` : ""}<p>${esc(r.text)}</p></div>`).join("")}</section>` : ""}

  ${!href && m.contact ? `<p>Запись: ${zapis(contactLink(m.contact), m.name)}</p>` : ""}

  ${neighbours.length ? `<div class="more">Ещё мастера: ${esc(title(m.service, m.city))}<ul>${neighbours.map((o) => `<li><a href="${o.path}">${esc(o.name)}</a></li>`).join("")}</ul></div>` : ""}
  <nav class="more" aria-label="Навигация"><a href="/mastera/">Свои мастера</a> › <a href="${categoryPath}">${esc(title(m.service, m.city))}</a></nav>
  <p class="join">Вы мастер? <a href="https://t.me/svoi_mastera_bot">Сделайте такую страницу бесплатно</a>, это 5 минут в Telegram.</p>
  <p class="foot">Botika, каталог «Свои мастера», <a href="/mastera/o-proekte/">о проекте</a></p>
</div>
<div class="bar">
  ${href ? `<a class="book" href="${esc(href)}" rel="noopener" data-zapis="${esc(m.name)}">${/t\.me\//.test(href) ? ICON_TG : ""}${bookText}</a>` : ""}
  <button class="share" type="button" id="share" aria-label="Поделиться страницей">${ICON_SHARE}</button>
</div>
<script>
document.getElementById("share").addEventListener("click", function () {
  var b = this, url = location.href.split("?")[0];
  if (navigator.share) { navigator.share({ title: document.title, url: url }).catch(function () {}); return; }
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { b.textContent = "Ссылка скопирована"; b.className = "share done"; }, function () { prompt("Ссылка на страницу:", url); });
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
<link href="${BOTIKA_FONT}" rel="stylesheet">
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
<style>${LIST_STYLE}</style>
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

  // Link preview pictures drawn by earlier runs, kept by the card they were drawn from.
  const ogCache = new Map();
  for (const dir of oldPages(MASTERA)) {
    const png = join(dir, "og.png");
    const drawn = existsSync(png) && readFileSync(join(dir, "index.html"), "utf8").match(/<!-- og-src:([0-9a-f]+) -->/);
    if (drawn) ogCache.set(resolve(dir), { hash: drawn[1], png: readFileSync(png) });
    rmSync(dir, { recursive: true, force: true });
  }
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
      const card = ogCardHtml(m, i);
      const hash = createHash("sha1").update(OG_VERSION + card).digest("hex").slice(0, 12);
      const png = join(dir, "og.png");
      const cached = ogCache.get(resolve(dir));
      if (cached && cached.hash === hash) writeFileSync(png, cached.png);
      // The ?v= part makes messengers fetch the new picture when the card changes.
      const og = existsSync(png) || renderPng(card, png) ? { hash, url: `${SITE}${m.path}og.png?v=${hash.slice(0, 8)}` } : null;
      writeFileSync(join(dir, "index.html"), masterPageHtml(m, i, { categoryPath: p.path, neighbours, og }));
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
  const urls = ["/", "/usluge/", "/mastera/", "/radar/", ...extra.map((e) => e.path), ...pages.map((p) => p.path), ...cards.map((c) => c.path)];
  writeFileSync(join(ROOT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join("\n")}
</urlset>
`);
  console.log(`${pages.length} pages:\n${pages.map((p) => `  ${p.path}  ${title(p.service, p.city)} (${p.cards.length})`).join("\n")}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
