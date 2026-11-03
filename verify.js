const cheerio = require('cheerio');
const { safeStoreUrl, hostLabel, STORE_DOMAINS } = require('../lib/shared');

function gatherJsonLd($) {
  const found = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { walk(JSON.parse($(el).contents().text())); } catch {}
  });
  function walk(x) {
    if (!x) return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x !== 'object') return;
    const type = x['@type'];
    if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) found.push(x);
    if (x['@graph']) walk(x['@graph']);
    if (x.mainEntity) walk(x.mainEntity);
    if (x.itemListElement) walk(x.itemListElement);
  }
  return found;
}
function numericPrice(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[\s,٬]/g, '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 && n < 100000000 ? n : null;
}
function productPagePrice($) {
  // Prefer structured single-product fields; never use the first random price in the whole page.
  const currency = String($('meta[property="product:price:currency"]').attr('content') || $('[itemprop="priceCurrency"]').attr('content') || 'EGP').toUpperCase();
  if (!['EGP','LE','جنيه','EGYPTIAN POUND'].includes(currency)) return null;
  const metaSelectors = [
    'meta[property="product:price:amount"]','meta[property="og:price:amount"]',
    'meta[itemprop="price"]','meta[name="product:price:amount"]'
  ];
  for (const selector of metaSelectors) {
    const value = $(selector).first().attr('content');
    const price = numericPrice(value);
    if (price) return price;
  }
  const itemprop = $('[itemprop="price"]').first();
  if (itemprop.length) {
    const price = numericPrice(itemprop.attr('content') || itemprop.attr('value') || itemprop.text());
    if (price) return price;
  }
  const selectors = [
    '.product-info .price','.product-details .price','.summary .price','.product__price',
    '.product-price','.price--main','.current-price','.single-product .price','.woocommerce-Price-amount'
  ];
  for (const selector of selectors) {
    const node = $(selector).first();
    if (!node.length) continue;
    const price = numericPrice(node.attr('data-price') || node.attr('content') || node.text());
    if (price) return price;
  }
  return null;
}
function productPageStock($, structuredProducts) {
  let sawInStock = false; let sawOutOfStock = false;
  for (const product of structuredProducts) {
    const rawOffers = Array.isArray(product.offers) ? product.offers : [product.offers].filter(Boolean);
    for (const offer of rawOffers) {
      const value = String(offer?.availability || '').toLowerCase();
      if (value.includes('instock') || value.includes('limitedavailability')) sawInStock = true;
      if (value.includes('outofstock') || value.includes('soldout') || value.includes('discontinued')) sawOutOfStock = true;
    }
  }
  if (sawInStock) return {status:'available', evidence:'بيانات التوفر المنظمة في صفحة المنتج'};
  if (sawOutOfStock) return {status:'unavailable', evidence:'بيانات التوفر المنظمة في صفحة المنتج'};

  // Fall back only to elements that look like stock/availability labels, not arbitrary page text.
  const selector = [
    '[itemprop="availability"]','.stock','.availability','.product-stock','.stock-status',
    '.product-availability','.inventory-status','[data-stock]','[data-availability]','[class*="stock-status"]','[id*="product-availability"]'
  ].join(',');
  let found = '';
  $(selector).each((_, el) => {
    if (found) return;
    const $el = $(el); const raw = String($el.attr('content') || $el.attr('data-stock') || $el.attr('data-availability') || $el.text()).trim();
    if (raw && raw.length <= 240 && /in\s*stock|available|متوفر|غير\s*متوفر|نفدت|out\s*of\s*stock|sold\s*out/i.test(raw)) found = raw;
  });
  if (/out\s*of\s*stock|sold\s*out|غير\s*متوفر|نفدت|unavailable/i.test(found)) return {status:'unavailable', evidence:'عنصر حالة مخزون ظاهر في صفحة المنتج'};
  if (/in\s*stock|available|متوفر/i.test(found)) return {status:'available', evidence:'عنصر حالة مخزون ظاهر في صفحة المنتج'};
  return {status:'unknown', evidence:''};
}
function hostAllowed(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return STORE_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain));
  } catch { return false; }
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control','s-maxage=60, stale-while-revalidate=120');
  if (req.method !== 'GET') return res.status(405).json({error:'استخدم GET.'});
  const url = String(req.query?.url || '').slice(0,2000);
  if (!safeStoreUrl(url) || new URL(url).hostname === 'connect4techs.com') return res.status(400).json({status:'unknown',message:'الرابط مش تابع لمتجر معتمد في فاحص BuildLab.'});
  if (!hostAllowed(url)) return res.status(400).json({status:'unknown',message:'نطاق المتجر غير مدعوم في فاحص المخزون.'});
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),12000);
  let currentUrl = url;
  try {
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await fetch(currentUrl,{signal:controller.signal,redirect:'manual',headers:{
        'user-agent':'Mozilla/5.0 (compatible; BuildLabEgypt/2.0; stock-check)',
        'accept':'text/html,application/xhtml+xml','accept-language':'ar-EG,ar;q=0.9,en;q=0.8'
      }});
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('تعذر إكمال تحويل صفحة المتجر بأمان.');
        const next = new URL(location, currentUrl).href;
        if (!safeStoreUrl(next) || !hostAllowed(next) || new URL(next).hostname === 'connect4techs.com') throw new Error('صفحة المتجر حوّلت إلى نطاق غير مدعوم.');
        currentUrl = next;
        continue;
      }
      break;
    }
    if (!response || !response.ok) throw new Error(`صفحة المتجر رجعت HTTP ${response?.status || 'غير معروف'}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    const products = gatherJsonLd($);
    const stockResult = productPageStock($, products);
    let currentPrice = null;
    for (const product of products) {
      const rawOffers = Array.isArray(product.offers) ? product.offers : [product.offers].filter(Boolean);
      for (const offer of rawOffers) {
        const price = numericPrice(offer?.price || product.price);
        if (price && currentPrice === null) currentPrice = price;
      }
    }
    if (currentPrice === null) currentPrice = productPagePrice($);
    const status = stockResult.status;
    const message = status === 'available'
      ? (currentPrice ? 'صفحة المتجر تعرض مؤشر توفر وسعرًا؛ أكد المخزون والسعر النهائي قبل الدفع.' : 'صفحة المتجر تعرض مؤشرًا على التوفر، لكن السعر الحالي لم يُقرأ بشكل موثوق؛ أكد السعر قبل الدفع.')
      : status === 'unavailable'
        ? 'الصفحة تعرض أن المنتج غير متوفر؛ لا تعتمد على سعر الرصد القديم.'
        : 'لم نستطع إثبات حالة المخزون أو السعر الحالي من الصفحة آليًا؛ افتحها وتأكد يدويًا.';
    return res.status(200).json({ok:true,store:hostLabel(currentUrl),url:currentUrl,checkedAt,httpStatus:response.status,stock:status,currentPrice,evidence:stockResult.evidence,message,source:'صفحة المتجر المباشرة'});
  } catch (error) {
    return res.status(200).json({ok:true,store:hostLabel(currentUrl),url:currentUrl,checkedAt,stock:'unknown',currentPrice:null,evidence:'',message:'المتجر منع الفحص الآلي أو لم يستجب. حالة المخزون والسعر الحالي غير مؤكدة؛ افتح صفحة المتجر للتأكد.',error:String(error?.message||error).slice(0,180)});
  } finally { clearTimeout(timer); }
};
