const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIndex, isDetailHref, priceFromText, categoryFromHeading } = require('../lib/shared');

const fixture = `<!doctype html><html lang="ar"><body><main><div class="entry-content">
<p>15 أكتوبر 2026 آخر تحديث</p>
<h2>كروت الشاشة GPU</h2>
<table><tbody>
<tr><td><a href="https://connect4techs.com/hardware-prices/rtx-5070-ti/">NVIDIA GeForce RTX 5070 Ti 16GB</a></td><td>VRAM 16GB GDDR7 Bus 192-bit</td><td>64,000 ج.م <a href="https://www.sigma-computer.com/item?id=123">Sigma Computer</a></td><td>2 محلات</td></tr>
<tr><td><a href="https://maximumhardware.store/products/rtx5070ti">Maximum Hardware</a> 65,000 ج.م NVIDIA GeForce RTX 5070 Ti 16GB</td></tr>
</tbody></table>
<h2>المعالجات CPU</h2>
<table><tbody><tr><td><a href="/hardware-prices/ryzen-5-7600/">AMD Ryzen 5 7600</a></td><td>6 Cores / 12 Threads Socket AM5</td><td>7,999 ج.م <a href="https://maximumhardware.store/products/ryzen7600">Maximum Hardware</a></td></tr></tbody></table>
<h2>كروت شاشة قديمة</h2><table><tbody><tr><td><a href="/hardware-prices/rtx-4060/">NVIDIA GeForce RTX 4060 8GB</a></td><td>VRAM 8GB GDDR6</td><td>غير متوفر حالياً</td></tr></tbody></table>
</div></main></body></html>`;

test('price parser reads common EGP formats', () => {
  assert.equal(priceFromText('64,000 ج.م'), 64000);
  assert.equal(priceFromText('EGP 7999'), 7999);
  assert.equal(priceFromText('السعر غير متوفر'), null);
});

test('detail URL filter excludes the source index route', () => {
  assert.equal(isDetailHref('/hardware-prices/ryzen-5-7600/'), true);
  assert.equal(isDetailHref('https://connect4techs.com/hardware-prices/'), false);
  assert.equal(isDetailHref('https://example.com/hardware-prices/rtx-1/'), false);
});

test('heading mapper recognizes common and expanded hardware categories', () => {
  assert.equal(categoryFromHeading('كروت الشاشة GPU'), 'gpu');
  assert.equal(categoryFromHeading('المعالجات CPU'), 'cpu');
  assert.equal(categoryFromHeading('لابتوبات LAPTOPS'), 'laptop');
  assert.equal(categoryFromHeading('الراوترات Routers'), 'router');
  assert.equal(categoryFromHeading('أنظمة Mesh'), 'mesh');
  assert.equal(categoryFromHeading('السويتشات Switches'), 'switch');
  assert.equal(categoryFromHeading('أجهزة NAS'), 'nas');
  assert.equal(categoryFromHeading('الطابعات'), 'printer');
  assert.equal(categoryFromHeading('كاميرات المراقبة'), 'securitycamera');
});

test('index parser finds product rows, store offers and unavailable status', () => {
  const result = parseIndex(fixture);
  const gpu = result.products.find(p => p.id === 'rtx-5070-ti');
  const cpu = result.products.find(p => p.id === 'ryzen-5-7600');
  const unavailable = result.products.find(p => p.id === 'rtx-4060');
  assert.ok(gpu, 'GPU product was found');
  assert.equal(gpu.category, 'gpu');
  assert.ok(gpu.offers.length >= 1, 'at least one seller offer was extracted');
  assert.equal(cpu.category, 'cpu');
  assert.equal(unavailable.stock, 'unavailable');
  assert.equal(unavailable.price, null);
});
