const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBalancedFeed,
  getOrBuildMixedHandleOrder,
  clearMixedFeedCache,
  resolveMainCategory,
} = require('../catalog/feed-mix');

const CATEGORIES = [
  'women',
  'men',
  'kids',
  'shoes',
  'bags',
  'electronics',
  'accessories',
  'beauty',
  'hair',
  'other',
];

function makeCatalog(countsByCategory, { allInStock = true } = {}) {
  const products = [];
  let id = 1;
  for (const [category, count] of Object.entries(countsByCategory)) {
    for (let i = 0; i < count; i += 1) {
      const handle =
        category === 'men'
          ? 'clothing'
          : category === 'electronics'
            ? 'power-tools'
            : category;
      products.push({
        id: String(id),
        handle: `${category}-${id}`,
        collectionHandles: [handle],
        tags: [],
        productType: '',
        availableForSale: allInStock ? true : category === 'women' ? true : i % 5 === 0,
      });
      id += 1;
    }
  }
  return products;
}

function streakMetrics(categories) {
  if (!categories.length) {
    return { maxStreak: 0, avgStreak: 0 };
  }
  const streaks = [];
  let run = 1;
  for (let i = 1; i < categories.length; i += 1) {
    if (categories[i] === categories[i - 1]) {
      run += 1;
    } else {
      streaks.push(run);
      run = 1;
    }
  }
  streaks.push(run);
  return {
    maxStreak: Math.max(...streaks),
    avgStreak: streaks.reduce((a, b) => a + b, 0) / streaks.length,
  };
}

function shannonEntropy(categories) {
  if (!categories.length) return 0;
  const counts = new Map();
  for (const c of categories) counts.set(c, (counts.get(c) || 0) + 1);
  const n = categories.length;
  let h = 0;
  for (const count of counts.values()) {
    const p = count / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function distribution(categories) {
  const dist = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const c of categories) dist[c] = (dist[c] || 0) + 1;
  return dist;
}

function pctMap(dist, n) {
  return Object.fromEntries(
    Object.entries(dist).map(([k, v]) => [k, n ? Number(((100 * v) / n).toFixed(1)) : 0])
  );
}

function windowReport(label, cats) {
  const n = cats.length;
  const dist = distribution(cats);
  const streaks = streakMetrics(cats);
  return {
    window: label,
    n,
    counts: dist,
    percentages: pctMap(dist, n),
    maxStreak: streaks.maxStreak,
    avgStreak: Number(streaks.avgStreak.toFixed(3)),
    shannonEntropy: Number(shannonEntropy(cats).toFixed(4)),
    sequencePreview: cats.slice(0, 40).join(' > '),
  };
}

test('resolveMainCategory maps power-tools to electronics', () => {
  assert.equal(
    resolveMainCategory({ collectionHandles: ['power-tools'], tags: [] }),
    'electronics'
  );
  assert.equal(resolveMainCategory({ collectionHandles: ['women'], tags: [] }), 'women');
});

test('buildBalancedFeed is deterministic for same mixSeed', () => {
  const products = makeCatalog({
    women: 200,
    men: 80,
    kids: 40,
    shoes: 80,
    electronics: 60,
    bags: 30,
    beauty: 20,
    hair: 40,
    accessories: 40,
    other: 50,
  });

  const a = buildBalancedFeed(products, 424242);
  const b = buildBalancedFeed(products, 424242);
  assert.deepEqual(
    a.map((p) => p.id),
    b.map((p) => p.id)
  );
  assert.notDeepEqual(
    a.map((p) => p.id),
    buildBalancedFeed(products, 999001).map((p) => p.id)
  );
});

test('buildBalancedFeed preserves all unique product ids', () => {
  const products = makeCatalog({
    women: 100,
    men: 50,
    electronics: 40,
    shoes: 40,
    hair: 20,
  });
  const mixed = buildBalancedFeed(products, 7);
  assert.deepEqual(
    mixed.map((p) => p.id).sort(),
    products.map((p) => p.id).sort()
  );
});

test('weighted discovery keeps women from dominating first 100-200', () => {
  // Skewed inventory similar to production pressure: women large + all in stock.
  const products = makeCatalog({
    women: 400,
    men: 80,
    kids: 50,
    shoes: 100,
    electronics: 90,
    bags: 40,
    beauty: 25,
    hair: 50,
    accessories: 50,
    other: 60,
  });

  const mixSeed = 123456789;
  const mixed = buildBalancedFeed(products, mixSeed);
  const cats = mixed.map((p) => resolveMainCategory(p));

  const r100 = windowReport('first_100', cats.slice(0, 100));
  const r200 = windowReport('first_200', cats.slice(0, 200));
  const r500 = windowReport('first_500', cats.slice(0, 500));

  console.log('\n[DISCOVERY MIXER v2 VALIDATION]');
  console.log(JSON.stringify({ mixSeed, r100, r200, r500 }, null, 2));

  assert.ok(r100.percentages.women <= 28, `women first100 too high: ${r100.percentages.women}%`);
  assert.ok(r100.percentages.women >= 12, `women first100 too low: ${r100.percentages.women}%`);
  assert.ok(r200.percentages.women <= 30, `women first200 too high: ${r200.percentages.women}%`);
  assert.ok(r100.maxStreak <= 2, `max streak first100: ${r100.maxStreak}`);
  assert.ok(r200.maxStreak <= 2, `max streak first200: ${r200.maxStreak}`);
  assert.ok(r100.shannonEntropy >= 2.5, `entropy first100 too low: ${r100.shannonEntropy}`);

  // Small categories should appear in first 100
  assert.ok(r100.counts.hair >= 4, 'hair should appear regularly in first 100');
  assert.ok(r100.counts.accessories >= 4, 'accessories should appear regularly in first 100');
  assert.ok(r100.counts.electronics >= 5, 'electronics should appear in first 100');

  // Not a pure fixed round-robin of category order (sequence should not be strict cycle of all cats)
  const first20 = cats.slice(0, 20);
  const unique = new Set(first20).size;
  assert.ok(unique >= 6, `first 20 should span many categories, got ${unique}`);
});

test('getOrBuildMixedHandleOrder stable for pagination contract', () => {
  clearMixedFeedCache();
  const rows = makeCatalog({
    women: 30,
    men: 30,
    electronics: 30,
    shoes: 30,
  }).map((p) => ({
    handle: p.handle,
    id: p.id,
    collectionHandles: p.collectionHandles,
    tags: [],
    productType: '',
    availableForSale: true,
  }));

  const first = getOrBuildMixedHandleOrder(rows, 777);
  const second = getOrBuildMixedHandleOrder(rows, 777);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(first.handles, second.handles);
  assert.deepEqual(first.handles.slice(0, 20), [
    ...first.handles.slice(0, 10),
    ...first.handles.slice(10, 20),
  ]);
});

test('in-stock products are preferred early within each category pool', () => {
  const products = [];
  for (let i = 0; i < 40; i += 1) {
    products.push({
      id: `w-oos-${i}`,
      handle: `w-oos-${i}`,
      collectionHandles: ['women'],
      availableForSale: false,
    });
  }
  for (let i = 0; i < 20; i += 1) {
    products.push({
      id: `w-in-${i}`,
      handle: `w-in-${i}`,
      collectionHandles: ['women'],
      availableForSale: true,
    });
  }
  for (let i = 0; i < 30; i += 1) {
    products.push({
      id: `e-in-${i}`,
      handle: `e-in-${i}`,
      collectionHandles: ['power-tools'],
      availableForSale: true,
    });
  }

  const mixed = buildBalancedFeed(products, 55);
  const womenInOrder = mixed.filter((p) => resolveMainCategory(p) === 'women');
  // First women placements should be in-stock when available.
  const firstWomen = womenInOrder.slice(0, 20);
  assert.ok(
    firstWomen.every((p) => p.availableForSale === true),
    'early women slots should prefer in-stock'
  );
});
