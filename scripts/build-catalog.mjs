// Печёт статический (SEO-видимый) слепок каталога прямо в index.html.
//
// Зачем: сам каталог на сайте грузится через JavaScript из Google Таблицы —
// это удобно для живых посетителей (актуальные цены сразу), но поисковики
// (особенно Яндекс) не всегда исполняют JS и могут не увидеть товары как текст.
//
// Что делает скрипт:
//   1. Берёт тот же CSV-эндпоинт (Apps Script), что и сам сайт.
//   2. Разбирает CSV той же логикой, что и клиентский JS на странице.
//   3. Генерирует HTML-список товаров и вставляет его в index.html между
//      метками <!-- STATIC_CATALOG_START --> и <!-- STATIC_CATALOG_END -->.
//   4. Обновляет lastmod в sitemap.xml (сигнал свежести для поисковиков).
//
// Когда запускается: по расписанию через GitHub Actions (см.
// .github/workflows/update-catalog.yml) — не требует ручных действий.
// При обычном открытии сайта JS всё равно подгружает свежие данные поверх
// этого слепка, так что посетители всегда видят актуальную таблицу.

import { readFileSync, writeFileSync } from 'node:fs';

const INDEX_PATH = new URL('../index.html', import.meta.url);
const SITEMAP_PATH = new URL('../sitemap.xml', import.meta.url);

const html = readFileSync(INDEX_PATH, 'utf8');

// Берём ссылку на каталог прямо из самого index.html — один источник правды,
// чтобы скрипт не разъезжался с сайтом, если ссылку когда-нибудь поменяют.
const urlMatch = html.match(/CATALOG_SHEET_CSV_URL\s*=\s*'([^']+)'/);
if (!urlMatch) {
  console.error('Не нашёл CATALOG_SHEET_CSV_URL в index.html — прерываю сборку.');
  process.exit(1);
}
const CATALOG_URL = urlMatch[1];

// ---- Парсинг CSV: та же логика посимвольного разбора, что и в клиентском JS ----
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function guessCategory(raw) {
  const v = (raw || '').toLowerCase();
  if (v.includes('кабел')) return 'cable';
  if (v.includes('пожар')) return 'fire';
  return 'other';
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function main() {
  console.log('Качаю CSV с', CATALOG_URL);
  const res = await fetch(CATALOG_URL, { cache: 'no-store' });
  if (!res.ok) {
    console.error('Каталог не отдался (HTTP', res.status, ') — оставляю index.html как есть.');
    process.exit(1);
  }
  const text = await res.text();
  const rows = parseCSV(text);
  rows.shift(); // строка заголовков

  const items = rows.map(r => {
    const category = guessCategory(r[0]);
    return {
      category,
      categoryLabel: category === 'cable' ? 'Кабель' : category === 'fire' ? 'Пожарное оборудование' : 'Другое',
      name: (r[1] || '').trim(),
      qty: (r[2] || '').trim(),
      price: (r[3] || '').trim(),
      note: (r[4] || '').trim(),
      photo: (r[5] || '').trim(),
    };
  }).filter(item => item.name);

  console.log('Товаров в таблице:', items.length);

  let block;
  if (items.length === 0) {
    // Пустая таблица — не ломаем страницу, просто ничего не подставляем.
    // JS на сайте по-прежнему покажет "Раздел в разработке" при живой загрузке.
    block = '';
  } else {
    const itemsHTML = items.map(item => `
      <div class="catalog-item">
        <div class="catalog-item-main">
          ${item.photo ? `<img class="catalog-item-photo" src="${escapeHTML(item.photo)}" alt="${escapeHTML(item.name)}" loading="lazy" onerror="this.remove()">` : ''}
          <span class="catalog-item-tag" data-cat="${item.category}">${escapeHTML(item.categoryLabel)}</span>
          <span class="catalog-item-name">${escapeHTML(item.name)}</span>
          ${item.note ? `<span class="catalog-item-note">— ${escapeHTML(item.note)}</span>` : ''}
        </div>
        <div class="catalog-item-right">
          ${item.qty ? `<span class="catalog-item-qty">${escapeHTML(item.qty)}</span>` : ''}
          ${item.price ? `<span class="catalog-item-price">${escapeHTML(item.price)}</span>` : ''}
        </div>
      </div>`).join('');

    // ItemList JSON-LD — помогает поисковику понять, что это каталог товаров
    const itemListJSON = {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: items.map((item, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: {
          '@type': 'Product',
          name: item.name,
          category: item.categoryLabel,
          ...(item.note ? { description: item.note } : {}),
        },
      })),
    };

    block = `${itemsHTML}\n      <script type="application/ld+json">${JSON.stringify(itemListJSON)}</script>`;
  }

  const startMarker = '<!-- STATIC_CATALOG_START -->';
  const endMarker = '<!-- STATIC_CATALOG_END -->';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    console.error('Не нашёл метки STATIC_CATALOG_START/END в index.html — прерываю.');
    process.exit(1);
  }

  const before = html.slice(0, startIdx + startMarker.length);
  const after = html.slice(endIdx);
  // Если есть товары — список виден сразу (без hidden), пустое состояние скрыто.
  // JS при загрузке страницы всё равно тут же подменит это свежими данными.
  const listHiddenAttr = items.length > 0 ? '' : ' hidden';
  const emptyHiddenAttr = items.length > 0 ? ' hidden' : '';

  let newHtml = before + '\n' + block + '\n      ' + endMarker;
  newHtml = newHtml + html.slice(endIdx + endMarker.length);

  // Проставляем hidden-атрибуты на исходные контейнеры (ищем их один раз в начале файла)
  newHtml = newHtml.replace(
    /<div class="catalog-list" id="catalogList"( hidden)?>/,
    `<div class="catalog-list" id="catalogList"${listHiddenAttr}>`
  );
  newHtml = newHtml.replace(
    /<div class="empty-state" id="catalogEmptyState"( hidden)?>/,
    `<div class="empty-state" id="catalogEmptyState"${emptyHiddenAttr}>`
  );

  if (newHtml !== html) {
    writeFileSync(INDEX_PATH, newHtml, 'utf8');
    console.log('index.html обновлён.');
  } else {
    console.log('Изменений нет — index.html не трогаю.');
  }

  // Обновляем lastmod в sitemap.xml, если файл есть
  try {
    let sitemap = readFileSync(SITEMAP_PATH, 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    if (sitemap.includes('<lastmod>')) {
      sitemap = sitemap.replace(/<lastmod>.*?<\/lastmod>/, `<lastmod>${today}</lastmod>`);
    } else {
      sitemap = sitemap.replace('</url>', `  <lastmod>${today}</lastmod>\n  </url>`);
    }
    writeFileSync(SITEMAP_PATH, sitemap, 'utf8');
    console.log('sitemap.xml: lastmod →', today);
  } catch {
    console.log('sitemap.xml не найден — пропускаю обновление lastmod.');
  }
}

main().catch(err => {
  console.error('Ошибка сборки каталога:', err);
  process.exit(1);
});
