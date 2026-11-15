const assert = require('node:assert/strict');
const { test } = require('node:test');
const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function makeOrder(items, coupon = '') {
  const billed = pricing.computeTotals(items, coupon);
  const db = { nextOrderId: 1001, orders: [] };
  const order = orders.add(db, { ...billed, items, coupon, date: '2021-11-15' });
  return { billed, order };
}

test('historical invoices and reconciliation use saved checkout amounts', () => {
  const { order } = makeOrder([{ name: 'Rice', hsn: '1006', price: 1000, qty: 1 }]);
  const historicalOrder = { ...order, coupon: 'DIWALI20', discount: 200, tax: 40, total: 840 };
  const figures = invoice.computeInvoiceFigures(historicalOrder);

  assert.equal(figures.total, 840);
  assert.equal(figures.discount, 200);
  assert.equal(figures.tax, 40);
  assert.deepEqual([figures.rows[0].gstPercent, figures.rows[0].lineTax], [5, 40]);

  const html = invoice.render(historicalOrder);
  assert.match(html, /Invoice Total<\/td><td class="r">₹840\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);

  const reconciliation = reports.getGstReconciliation({ orders: [historicalOrder] });
  assert.equal(reconciliation.mismatchCount, 0);
  assert.deepEqual(
    reconciliation.rows.map(row => [row.invoiceDiscount, row.invoiceTax, row.invoiceTotal, row.matched]),
    [[200, 40, 840, true]]
  );
});

test('mixed HSN slabs and SAVE10 produce matching billed and printed figures', () => {
  const { billed, order } = makeOrder([
    { name: 'Rice', hsn: '1006', price: 150, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 300, qty: 1 }
  ], 'SAVE10');

  assert.deepEqual(billed, {
    subtotal: 600,
    discount: 60,
    taxable: 540,
    tax: 45.9,
    cgst: 22.95,
    sgst: 22.95,
    total: 585.9,
    lines: [
      { id: undefined, name: 'Rice', hsn: '1006', gstPercent: 5,
        gross: 300, discount: 30, taxable: 270, tax: 13.5, net: 283.5 },
      { id: undefined, name: 'Ghee', hsn: '0405', gstPercent: 12,
        gross: 300, discount: 30, taxable: 270, tax: 32.4, net: 302.4 }
    ]
  });
  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 600,
    discount: 60,
    tax: 45.9,
    cgst: 22.95,
    sgst: 22.95,
    total: 585.9,
    rows: [
      { name: 'Rice', sku: '-', hsn: '1006', qty: 2, price: 150,
        gstPercent: 5, line: 300, lineTax: 13.5 },
      { name: 'Ghee', sku: '-', hsn: '0405', qty: 1, price: 300,
        gstPercent: 12, line: 300, lineTax: 32.4 }
    ]
  });

  const html = invoice.render(order);
  assert.match(html, /<td class="r">5%<\/td><td class="r">₹13\.50<\/td>/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹45\.90<\/td>/);
  assert.match(html, /Coupon Discount \(SAVE10\)<\/td><td[^>]*>-₹60\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹585\.90<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('a flat coupon reduces taxable value for checkout and invoice GST', () => {
  const { billed, order } = makeOrder([{ name: 'Tea', hsn: '0902', price: 300, qty: 1 }], 'FLAT50');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([billed.discount, billed.tax, billed.total], [50, 45, 295]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 45, 295]);
});

for (const { description, coupon, price, billedDiscount, invoiceDiscount, invoiceTotal } of [
  { description: 'honors the saved SAVE10 cap', coupon: 'SAVE10', price: 2000,
    billedDiscount: 150, invoiceDiscount: 150, invoiceTotal: 2183 },
  { description: 'keeps the saved zero discount below the FLAT50 minimum', coupon: 'FLAT50', price: 25,
    billedDiscount: 0, invoiceDiscount: 0, invoiceTotal: 29.5 },
  { description: 'keeps the saved zero discount for expired DIWALI20', coupon: 'DIWALI20', price: 1000,
    billedDiscount: 0, invoiceDiscount: 0, invoiceTotal: 1180 }
]) {
  test(`invoice ${description}`, () => {
    const { billed, order } = makeOrder([{ name: 'Tea', price, qty: 1 }], coupon);
    const figures = invoice.computeInvoiceFigures(order);

    assert.equal(billed.discount, billedDiscount);
    assert.equal(figures.discount, invoiceDiscount);
    assert.equal(figures.total, invoiceTotal);
  });
}

test('decimal rates and explicit zero resolve the same way on the invoice', () => {
  const { billed, order } = makeOrder([
    { name: 'Decimal GST', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero GST', price: 100, qty: 1, gstRate: 0, hsn: '1006' },
    { name: 'Whole percent GST', price: 100, qty: 1, gstRate: 12 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(billed.lines.map(line => [line.gstPercent, line.tax]), [[5, 5], [0, 0], [12, 12]]);
  assert.deepEqual(figures.rows.map(row => [row.gstPercent, row.lineTax]), [[5, 5], [0, 0], [12, 12]]);
  assert.equal(billed.total, 317);
  assert.equal(figures.total, 317);
});

test('invoice and checkout agree when GST rounds at the line level', () => {
  const { billed, order } = makeOrder([
    { name: 'First item', price: 0.03, qty: 1 },
    { name: 'Second item', price: 0.03, qty: 1 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(billed.lines.map(line => line.tax), [0.01, 0.01]);
  assert.deepEqual(figures.rows.map(row => row.lineTax), [0.01, 0.01]);
  assert.deepEqual([billed.tax, billed.cgst, billed.sgst, billed.total], [0.02, 0.01, 0.01, 0.08]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.02, 0.01, 0.01, 0.08]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('a matching order prints the agreed total without a reconciliation notice', () => {
  const { order } = makeOrder([{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }]);
  const html = invoice.render(order);

  assert.equal(order.total, 118);
  assert.match(html, /Invoice Total<\/td><td class="r">₹118\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('the report uses saved GST when current line tax differs', () => {
  const { order } = makeOrder([{ name: 'Tea', price: 100, qty: 1 }]);
  const historicalOrder = { ...order, tax: 17.99 };

  const html = invoice.render(historicalOrder);
  assert.match(html, /Total GST\)<\/td><td class="r">₹17\.99<\/td>/);
  assert.doesNotMatch(html, /<td class="r">₹18\.00<\/td>/);
  assert.match(html, /Item-level GST breakdown unavailable for this order\./);
  assert.deepEqual(reports.getGstReconciliation({ orders: [historicalOrder] }), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1001, date: '2021-11-15', customer: 'Walk-in', coupon: '',
      ledgerSubtotal: 100, ledgerDiscount: 0, ledgerTax: 17.99, ledgerTotal: 118,
      invoiceDiscount: 0, invoiceTax: 17.99, invoiceTotal: 118, delta: 0, matched: true
    }]
  });
});
