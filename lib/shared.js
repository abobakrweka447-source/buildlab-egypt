const cheerio = require('cheerio');

const SOURCE_URL = 'https://connect4techs.com/hardware-prices/';
const SOURCE_HOST = 'connect4techs.com';
const STORE_DOMAINS = [
  'sigma-computer.com', 'compumarts.com', 'elbadrgroupeg.store', 'elnekhelytechnology.com',
  'maximumhardware.store', 'kimostore.net', 'alfrensia.com', 'ahw.store', '2b.com.eg',
  'btech.com', 'noon.com', 'amazon.eg', 'jumia.com.eg', 'egyptlaptop.com', 'raya-shop.com',
  'dream2000.com', 'hardwaremarket.net', 'elnekhely.com', 'games2egypt.com', 'tradeline.com.eg',
  'raya.com', 'connect4techs.com'
];
const UNAVAILABLE = /غير\s*متوفر(?:\s*حالي(?:اً|ا))?|نفدت\s*الكمية|out\s*of\s*stock|sold\s*out|unavailable/i;

function norm(s = '') {
  return String(s).normalize('NFKC').toLowerCase()
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[ًٌٍَُِّْـ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function decodeText(s = '') {
  return String(s).replace(/\u00a0/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#0*39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();
}
function priceFromText(text) {
  const normalized = decodeText(text).replace(/٬/g, ',').replace(/٫/g, '.');
  const matches = [...normalized.matchAll(/(?:ج\.?\s*م|جنيه(?:\s*مصري)?|EGP)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:ج\.?\s*م|جنيه(?:\s*مصري)?|EGP)/gi)];
  if (!matches.length) return null;
  const m = matches[0];
  const raw = (m[1] || m[2] || '').replace(/,/g, '');
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}
function categoryFromHeading(text) {
  const s = norm(text);
  if (/gpu|graphic card|graphics card|كروت الشاشه|كارت الشاشه|بطاقات الرسوم/.test(s)) return 'gpu';
  if (/cpu|processor|processors|المعالجات|معالج/.test(s)) return 'cpu';
  if (/laptop|laptops|notebook|notebooks|لابتوبات|لابتوب/.test(s)) return 'laptop';
  if (/motherboard|motherboards|مازر بورد|اللوحات الام|لوحه الام/.test(s)) return 'motherboard';
  if (/memory|ram|الرامات|ذاكره|الذاكره/.test(s)) return 'ram';
  if (/external storage|التخزين الخارجي/.test(s)) return 'externalstorage';
  if (/ssd|هاردات ssd|وحدات التخزين|التخزين/.test(s)) return 'ssd';
  if (/hdd|hard disk|هاردات hdd/.test(s)) return 'hdd';
  if (/power supply|psu|الباور سبلاي|مزود الطاقه/.test(s)) return 'psu';
  if (/monitor|monitors|الشاشات|شاشه/.test(s)) return 'monitor';
  if (/case|pc case|الكيسات|صندوق الحاسب/.test(s)) return 'case';
  if (/cooling|cooler|مبردات المعالج|تبريد/.test(s)) return 'cooler';
  if (/webcam|web camera|كاميرا ويب/.test(s)) return 'webcam';
  if (/microphone|mic |ميكروفون/.test(s)) return 'microphone';
  if (/capture card|usb hub|adapter|converter|ملحقات/.test(s)) return 'accessory';
  if (/keyboard|الكيبورد/.test(s)) return 'keyboard';
  if (/mouse|ماوس/.test(s)) return 'mouse';
  if (/headset|headphone|سماعات/.test(s)) return 'headset';
  if (/fan|مراوح/.test(s)) return 'fan';
  if (/ups|اجهزه ups/.test(s)) return 'ups';
  if (/router|routers|راوترات|الراوترات|راوتر/.test(s)) return 'router';
  if (/mesh|انظمه mesh|انظمة mesh/.test(s)) return 'mesh';
  if (/access point|access points|نقاط الوصول/.test(s)) return 'accesspoint';
  if (/switch|switches|السويتشات|مبدلات الشبكه/.test(s)) return 'switch';
  if (/firewall|فايروول|جدار الحمايه/.test(s)) return 'firewall';
  if (/repeater|wifi extender|مقويات الواي فاي|مقوي واي فاي/.test(s)) return 'repeater';
  if (/nas|network attached storage|اجهزه nas/.test(s)) return 'nas';
  if (/printer|printers|الطابعات|طابعه/.test(s)) return 'printer';
  if (/surveillance camera|security camera|كاميرات المراقبه|كاميرات المراقبة/.test(s)) return 'securitycamera';
  if (/router|network|راوتر|الشبكات|wifi|wi fi|access point/.test(s)) return 'network';
  if (/thermal paste|thermal compound|معجون حراري/.test(s)) return 'thermal';
  if (/speaker|desktop speaker|speakers|سماعات مكتبيه/.test(s)) return 'speaker';
  if (/webcam|web camera|كاميرا ويب/.test(s)) return 'webcam';
  if (/microphone|mic |ميكروفون/.test(s)) return 'microphone';
  if (/thermal paste|thermal compound|معجون حراري/.test(s)) return 'thermal';
  if (/capture card|usb hub|hub |adapter|cable|converter|accessory|ملحقات/.test(s)) return 'accessory';
  return 'all';
}
function categoryFromProduct(name, text, fallback = 'all') {
  const s = norm(`${name} ${text}`);
  if (/laptop|notebook|لابتوب/.test(s)) return 'laptop';
  if (/printer|طابعه|طابعة/.test(s)) return 'printer';
  if (/surveillance camera|security camera|كاميرا مراقبه|كاميرا مراقبة/.test(s)) return 'securitycamera';
  if (/mesh wi fi|mesh system|نظام mesh/.test(s)) return 'mesh';
  if (/access point/.test(s)) return 'accesspoint';
  if (/firewall/.test(s)) return 'firewall';
  if (/repeater|wifi extender/.test(s)) return 'repeater';
  if (/nas|network attached storage/.test(s)) return 'nas';
  if (/external storage|portable ssd|portable hdd/.test(s)) return 'externalstorage';
  if (/network switch|ethernet switch|managed switch/.test(s)) return 'switch';
  if (/router/.test(s)) return 'router';
  if (/rtx|geforce|radeon|graphics card|gpu|arc b[0-9]/.test(s)) return 'gpu';
  if (/ryzen|core i[3579]|core ultra|xeon|processor|معالج/.test(s)) return 'cpu';
  if (/motherboard|a[56]20|b[56]50|b[56]50|b[78]50|x[67]70|z[67]90|h[67]10|prime b|pro b[0-9]/.test(s)) return 'motherboard';
  if (/ddr[345]|ram |memory|trident|vengeance|t force|t force|ددي ار/.test(s)) return 'ram';
  if (/nvme|ssd|solid state|sn[0-9]{3}|kc[0-9]{3}|samsung 9[0-9]{3}/.test(s)) return 'ssd';
  if (/hdd|hard drive|hard disk|barracuda|ironwolf|wd blue [0-9]/.test(s)) return 'hdd';
  if (/power supply|\bpsu\b|\b[0-9]{3,4}\s*w\b|mwe gold|mwe bronze|focus gx|atom v[0-9]/.test(s)) return 'psu';
  if (/monitor|odyssey|\b[0-9]{2}\s*(inch|\")|\b[0-9]{3}\s*hz|ips monitor/.test(s)) return 'monitor';
  if (/pc case|mid tower|mini tower|chassis|computer case|الكيسه/.test(s)) return 'case';
  if (/cooler|cooling|aio|liquid cooling|radiator|thermalright|deepcool ak|frozn|fan kit|مبرد/.test(s)) return 'cooler';
  if (/keyboard|كيبورد/.test(s)) return 'keyboard';
  if (/mouse|ماوس/.test(s)) return 'mouse';
  if (/headset|headphone|earphone|سماعه/.test(s)) return 'headset';
  if (/case fan|pc fan|120mm fan|140mm fan|مروحه/.test(s)) return 'fan';
  if (/\bups\b|uninterruptible/.test(s)) return 'ups';
  if (/router|access point|mesh wi fi|switch|network adapter|wifi card/.test(s)) return 'network';
  if (/desktop speaker|pc speaker|computer speaker|speakers/.test(s)) return 'speaker';
  if (/webcam|web camera/.test(s)) return 'webcam';
  if (/microphone|usb mic/.test(s)) return 'microphone';
  if (/thermal paste|thermal compound|mx 4|mx 6|nt h1|nt h2/.test(s)) return 'thermal';
  if (/capture card|usb hub|adapter|converter|riser cable|extension cable/.test(s)) return 'accessory';
  return fallback;
}
function isDetailHref(href) {
  try {
    const u = new URL(href, SOURCE_URL);
    return u.hostname === SOURCE_HOST && /^\/hardware-prices\/[^/]+\/?$/.test(u.pathname) && u.pathname !== '/hardware-prices/';
  } catch { return false; }
}
function safeStoreUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return STORE_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch { return false; }
}
function hostLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const known = {
      'sigma-computer.com':'Sigma Computer','compumarts.com':'Compumarts','elbadrgroupeg.store':'El Badr Group',
      'elnekhelytechnology.com':'Elnekhely Technology','maximumhardware.store':'Maximum Hardware',
      'kimostore.net':'Kimo Store','alfrensia.com':'Alfrensia','ahw.store':'AHW Store','2b.com.eg':'2B',
      'btech.com':'B.TECH','noon.com':'Noon Egypt','amazon.eg':'Amazon Egypt','jumia.com.eg':'Jumia Egypt',
      'egyptlaptop.com':'Egypt Laptop','raya-shop.com':'Raya Shop','raya.com':'Raya','dream2000.com':'Dream 2000',
      'games2egypt.com':'Games 2 Egypt','tradeline.com.eg':'Tradeline'
    };
    return known[host] || host;
  } catch { return 'متجر إلكتروني'; }
}
function offerContainer($, anchor) {
  const $a = $(anchor);
  for (const tag of ['li', 'tr', 'p', 'article']) {
    const $candidate = $a.closest(tag);
    if (!$candidate.length) continue;
    const text = $candidate.text().trim();
    const externalLinks = $candidate.find('a[href]').filter((_, a) => safeStoreUrl($(a).attr('href')) && new URL($(a).attr('href')).hostname !== SOURCE_HOST).length;
    if (text.length >= 12 && text.length <= 900 && externalLinks <= 2) return $candidate;
  }
  let $p = $a.parent();
  for (let i = 0; i < 4 && $p.length; i++, $p = $p.parent()) {
    const txt = $p.text().trim();
    if (txt.length >= 12 && txt.length <= 350 && $p.find('a[href]').length <= 3) return $p;
  }
  return $a.parent();
}
function parseIndex(html) {
  const $ = cheerio.load(html);
  const $root = $('.entry-content, main, article').first().length ? $('.entry-content, main, article').first() : $('body');
  const events = [];
  $root.find('h2,h3,h4,a[href]').each((_, el) => {
    const $el = $(el);
    const tag = String(el.tagName || el.name || '').toLowerCase();
    const text = $el.text().trim();
    const href = $el.attr('href') || '';
    if (/^h[234]$/.test(tag)) events.push({type:'heading', node:el, title:text});
    else if (tag === 'a' && isDetailHref(href)) {
      const name = text.replace(/\s+/g,' ').trim();
      if (name && name.length > 2 && !/read more|view details|تفاصيل|اعرف اكثر/i.test(name)) events.push({type:'product', node:el, href, name});
    }
  });
  const products = [];
  let category = 'all';
  const seen = new Set();
  for (const event of events) {
    if (event.type === 'heading') {
      const mapped = categoryFromHeading(event.title);
      if (mapped !== 'all') category = mapped;
      continue;
    }
    let detailUrl;
    try { detailUrl = new URL(event.href, SOURCE_URL).href; } catch { continue; }
    const slug = new URL(detailUrl).pathname.replace(/\/$/, '').split('/').pop();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const $a = $(event.node);
    const $row = $a.closest('tr');
    const rowText = ($row.length ? $row.text() : $a.parent().text()).replace(/\s+/g, ' ').trim();
    const cells = $row.length ? $row.find('td').map((_, td) => $(td).text().replace(/\s+/g,' ').trim()).get() : [];
    const availabilityText = `${rowText} ${cells.join(' ')}`;
    const declaredUnavailable = UNAVAILABLE.test(availabilityText);
    let offers = [];
    // The index may place seller offers in the same table row or in consecutive detail rows.
    const productRows = [];
    if ($row.length) {
      productRows.push($row);
      let $sibling = $row.next();
      for (let i = 0; $sibling.length && i < 6; i++, $sibling = $sibling.next()) {
        const siblingHasProduct = $sibling.find('a[href]').filter((_, x) => {
          const h = $(x).attr('href') || '';
          return isDetailHref(h);
        }).length > 0;
        if (siblingHasProduct) break;
        if ($sibling.text().trim()) productRows.push($sibling);
      }
    } else {
      productRows.push($a.parent());
    }
    const sellerAnchors = [];
    for (const $part of productRows) {
      $part.find('a[href]').each((_, sellerA) => {
        const href = $(sellerA).attr('href') || '';
        if (!safeStoreUrl(href)) return;
        if (new URL(href).hostname === SOURCE_HOST) return;
        const text = $(sellerA).text().replace(/\s+/g,' ').trim();
        if (!text || text.length > 120) return;
        const $container = offerContainer($, sellerA);
        const fullText = $container.text().replace(/\s+/g,' ').trim();
        const value = priceFromText(fullText);
        if (!value) return;
        sellerAnchors.push({store:hostLabel(href), price:value, url:href, productName:fullText.replace(text,'').trim().slice(0,220), status:'listed'});
      });
    }
    offers = sellerAnchors;
    // The cheapest-price cell may link directly to the retailer; keep that offer if it is explicit.
    if ($row.length && cells.length >= 3) {
      const cheapestCell = cells.find(t => /ج\.?\s*م|جنيه|EGP/i.test(t));
      const cheapest = priceFromText(cheapestCell || rowText);
      let retailerUrl = null;
      let retailerName = '';
      $row.find('a[href]').each((_, link) => {
        const href = $(link).attr('href') || '';
        if (safeStoreUrl(href) && new URL(href).hostname !== SOURCE_HOST) { retailerUrl = href; retailerName = hostLabel(href); }
      });
      if (cheapest && retailerUrl && !offers.some(o => o.url === retailerUrl)) offers.push({store:retailerName,price:cheapest,url:retailerUrl,productName:event.name,status:'listed'});
    }
    const fallbackPrice = priceFromText(cells.join(' ') || rowText);
    // Small wrappers sometimes contain the expanded seller links even when the table row does not.
    if (!offers.length) {
      for (const sel of ['li','article','details','.product-item','.hardware-product']) {
        const $candidate = $a.closest(sel);
        if (!$candidate.length || $candidate.text().length > 4000) continue;
        const count = $candidate.find('a[href]').filter((_, x) => safeStoreUrl($(x).attr('href')) && new URL($(x).attr('href')).hostname !== SOURCE_HOST).length;
        if (!count) continue;
        $candidate.find('a[href]').each((_, sellerA) => {
          const href = $(sellerA).attr('href') || '';
          if (!safeStoreUrl(href) || new URL(href).hostname === SOURCE_HOST) return;
          const text = $(sellerA).text().trim();
          const fullText = offerContainer($, sellerA).text().replace(/\s+/g,' ').trim();
          const value = priceFromText(fullText);
          if (value) offers.push({store:hostLabel(href),price:value,url:href,productName:fullText.replace(text,'').trim().slice(0,220),status:'listed'});
        });
        if (offers.length) break;
      }
    }
    if (offers.length) {
      const distinct = new Map();
      for (const offer of offers) {
        const k = `${offer.url}|${offer.price}`;
        if (!distinct.has(k)) distinct.set(k, offer);
      }
      offers = [...distinct.values()].sort((a,b)=>a.price-b.price).slice(0,12);
    }
    const sourcePrice = offers.length ? offers[0].price : fallbackPrice;
    const unavailable = declaredUnavailable && offers.length === 0;
    const description = cells.length > 1 ? cells.slice(1,2).join(' ') : '';
    const categoryId = categoryFromProduct(event.name, `${description} ${rowText}`, category);
    products.push({
      id: slug, name: event.name, category: categoryId, categoryLabel: categoryLabel(categoryId),
      price: unavailable ? null : (sourcePrice || null), currency:'EGP',
      offers, offersCount:offers.length, stock:unavailable ? 'unavailable' : (offers.length ? 'listed' : 'unknown'),
      stockLabel: unavailable ? 'غير متوفر في آخر رصد' : (offers.length ? 'متوفر في آخر رصد المصدر' : 'المخزون غير مؤكد'),
      detailUrl, sourceUrl:SOURCE_URL, specs:description || '',
      store: offers[0]?.store || storeFromRow($, $row) || 'راجع المصدر',
      scannedAt: extractUpdateDate($),
      searchText: norm(`${event.name} ${description} ${rowText} ${categoryId}`)
    });
  }
  // The current page uses linked item rows; this fallback still preserves all visible listings if markup changes.
  return { products, fetchedAt: new Date().toISOString(), sourceUpdated: extractUpdateDate($) };
}
function storeFromRow($, $row) {
  if (!$row || !$row.length) return '';
  let out = '';
  $row.find('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (safeStoreUrl(href) && new URL(href).hostname !== SOURCE_HOST) out = hostLabel(href);
  });
  return out;
}
function extractUpdateDate($) {
  const text = $('body').text().replace(/\s+/g,' ');
  const m = text.match(/(\d{1,2}\s+(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)\s+\d{4})\s+آخر\s+تحديث/i);
  if (m) return m[1];
  const n = text.match(/آخر\s+تحديث\s*[:：]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/i);
  return n ? n[1] : 'غير مذكور في المصدر';
}
function categoryLabel(cat) {
  return ({all:'متنوع',cpu:'معالجات',gpu:'كروت شاشة',motherboard:'لوحات أم',ram:'رامات',ssd:'SSD',hdd:'HDD',psu:'باور سبلاي',monitor:'شاشات',case:'كيسات',cooler:'تبريد',keyboard:'كيبورد',mouse:'ماوس',headset:'سماعات رأس',fan:'مراوح',ups:'UPS',network:'شبكات وواي فاي',router:'راوترات',mesh:'أنظمة Mesh',accesspoint:'Access Points',switch:'سويتشات',firewall:'Firewall',repeater:'مقويات واي فاي',nas:'أجهزة NAS',externalstorage:'تخزين خارجي',laptop:'لابتوبات',printer:'طابعات',securitycamera:'كاميرات مراقبة',speaker:'سماعات مكتبية',webcam:'كاميرات ويب',microphone:'ميكروفونات',thermal:'معجون حراري',accessory:'ملحقات'})[cat] || 'متنوع';
}
function matchesQuery(product, q) {
  const query = norm(q);
  if (!query) return true;
  const tokens = query.split(/\s+/).filter(Boolean);
  const hay = product.searchText || norm(`${product.name} ${product.specs} ${product.categoryLabel}`);
  return tokens.every(t => hay.includes(t));
}
async function fetchSource(force = false) {
  const now = Date.now();
  if (force && globalThis.__buildLabLastForcedFetch && now - globalThis.__buildLabLastForcedFetch < 30000 && globalThis.__buildLabCache) return globalThis.__buildLabCache.data;
  if (globalThis.__buildLabCache && now - globalThis.__buildLabCache.at < 5 * 60 * 1000 && !force) return globalThis.__buildLabCache.data;
  if (force) globalThis.__buildLabLastForcedFetch = now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(SOURCE_URL, {signal:controller.signal, headers:{
      'user-agent':'Mozilla/5.0 (compatible; BuildLabEgypt/2.0; price-comparison)',
      'accept':'text/html,application/xhtml+xml', 'accept-language':'ar-EG,ar;q=0.9,en;q=0.8'
    }});
    if (!response.ok) throw new Error(`مصدر الأسعار رجّع HTTP ${response.status}`);
    const html = await response.text();
    if (html.length < 5000) throw new Error('صفحة مصدر الأسعار رجعت محتوى أقصر من المتوقع.');
    const data = parseIndex(html);
    if (!data.products.length) throw new Error('المصدر غيّر شكل الصفحة ولم نقدر نقرأ قائمة المنتجات بأمان.');
    globalThis.__buildLabCache = {at:Date.now(),data};
    return data;
  } finally { clearTimeout(timer); }
}
module.exports = { SOURCE_URL, STORE_DOMAINS, safeStoreUrl, isDetailHref, norm, priceFromText, parseIndex, fetchSource, categoryLabel, categoryFromHeading, categoryFromProduct, matchesQuery, hostLabel };
