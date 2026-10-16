const { fetchSource, categoryLabel, matchesQuery } = require('../lib/shared');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const forceRefresh = ['1','true','yes'].includes(String(req.query?.refresh || '').toLowerCase());
  res.setHeader('Cache-Control', forceRefresh ? 'no-store' : 's-maxage=120, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({error:'استخدم GET للبحث.'});
  try {
    const query = String(req.query?.q || '').slice(0,100).trim();
    const category = String(req.query?.category || 'all').toLowerCase().slice(0,30);
    const inStockOnly = ['1','true','yes'].includes(String(req.query?.inStock || '').toLowerCase());
    const sort = String(req.query?.sort || 'price').toLowerCase();
    const data = await fetchSource(forceRefresh);
    let products = data.products.filter(p => matchesQuery(p, query));
    if (category !== 'all') products = products.filter(p => p.category === category);
    if (inStockOnly) products = products.filter(p => p.stock === 'listed' && Number(p.price) > 0);
    if (sort === 'name') products.sort((a,b)=>a.name.localeCompare(b.name,'ar'));
    else if (sort === 'offers') products.sort((a,b)=>(b.offersCount||0)-(a.offersCount||0) || ((a.price||Infinity)-(b.price||Infinity)));
    else if (sort === 'high') products.sort((a,b)=>(b.price||0)-(a.price||0));
    else products.sort((a,b)=>((a.price==null)?Infinity:a.price)-((b.price==null)?Infinity:b.price));
    const totalMatches = products.length;
    const limit = Math.max(1,Math.min(80,Number(req.query?.limit)||60));
    products = products.slice(0,limit).map(({searchText,...p})=>p);
    return res.status(200).json({ok:true,source:'Connect4Techs Hardware Price Index',sourceUrl:'https://connect4techs.com/hardware-prices/',sourceUpdated:data.sourceUpdated,fetchedAt:data.fetchedAt,totalMatches,returned:products.length,products,notes:[
      'الأسعار وحالة التوفر تعكسان آخر رصد منشور في المصدر، وليستا ضمانًا للمخزون اللحظي.',
      'استخدم «افحص صفحة المتجر الآن» عند توفر رابط مباشر، ثم أكد السعر والضمان قبل الشراء.'
    ]});
  } catch (error) {
    console.error('BuildLab search:', error?.message || error);
    return res.status(502).json({ok:false,error:'تعذر جلب بيانات المقارنة الآن. قد يكون مصدر الأسعار متوقفًا مؤقتًا أو غيّر شكل صفحته.',details:String(error?.message || error).slice(0,220),sourceUrl:'https://connect4techs.com/hardware-prices/'});
  }
};
