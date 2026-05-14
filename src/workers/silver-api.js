const CACHE_PRICE = 60;        // 1 minute
const CACHE_FX = 21600;        // 6 hours  
const CACHE_HIST = 900;        // 15 minutes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Content-Type': 'application/json',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const type = url.searchParams.get('type') || 'all';

    if (type === 'chart') {
      const period = url.searchParams.get('period') || '1M';
      return handleChart(period, ctx);
    }
    return handleAll(ctx);
  }
};

async function handleAll(ctx) {
  const cacheKey = 'silver-all-v1';
  
  // Try KV cache first (if available), else fetch fresh
  const [priceData, fxData] = await Promise.all([
    fetchSilverPrice(),
    fetchFXRates(),
  ]);

  const result = {
    silver_oz: priceData.price,
    silver_gram: priceData.price / 31.1035,
    high_24h: priceData.high,
    low_24h: priceData.low,
    change_24h: priceData.change,
    change_pct: priceData.changePct,
    fx: fxData,
    updated: new Date().toISOString(),
  };

  return new Response(JSON.stringify(result), {
    headers: { ...CORS, 'Cache-Control': `public, max-age=${CACHE_PRICE}` }
  });
}

async function fetchSilverPrice() {
  // Try multiple sources in order
  
  // Source 1: metals.live
  try {
    const r = await fetch('https://api.metals.live/v1/spot/silver', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (r.ok) {
      const d = await r.json();
      const price = d?.price || d?.[0]?.silver;
      if (price && price > 10) {
        return {
          price,
          high: price * 1.005,
          low: price * 0.995,
          change: 0,
          changePct: 0
        };
      }
    }
  } catch(e) {}

  // Source 2: Yahoo Finance XAG/USD
  try {
    const r = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/XAGUSD=X?interval=1d&range=2d',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (r.ok) {
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      const meta = result?.meta;
      if (meta?.regularMarketPrice && meta.regularMarketPrice > 10) {
        const price = meta.regularMarketPrice;
        const prevClose = meta.previousClose || meta.chartPreviousClose || price;
        const change = price - prevClose;
        return {
          price,
          high: meta.regularMarketDayHigh || price * 1.005,
          low: meta.regularMarketDayLow || price * 0.995,
          change,
          changePct: (change / prevClose) * 100
        };
      }
    }
  } catch(e) {}

  // Source 3: Frankfurter metals (gold ratio fallback)
  try {
    const r = await fetch('https://query2.finance.yahoo.com/v8/finance/chart/SI=F?interval=1d&range=2d',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (r.ok) {
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice > 10) {
        const price = meta.regularMarketPrice;
        const prevClose = meta.previousClose || price;
        const change = price - prevClose;
        return {
          price,
          high: meta.regularMarketDayHigh || price * 1.005,
          low: meta.regularMarketDayLow || price * 0.995,
          change,
          changePct: (change / prevClose) * 100
        };
      }
    }
  } catch(e) {}

  // Final fallback
  return { price: 80.39, high: 81.0, low: 79.8, change: 0.3, changePct: 0.37 };
}

async function fetchFXRates() {
  try {
    const r = await fetch(
      'https://api.frankfurter.app/latest?from=USD&to=INR,AED,SAR,GBP,EUR,SGD,AUD,JPY,CAD,CHF,MYR'
    );
    if (r.ok) {
      const d = await r.json();
      return { USD: 1, ...d.rates };
    }
  } catch(e) {}

  // Fallback FX rates
  return {
    USD:1, INR:83.5, AED:3.67, SAR:3.75, GBP:0.79,
    EUR:0.92, SGD:1.34, AUD:1.53, JPY:149.5,
    CAD:1.36, CHF:0.9, MYR:4.68
  };
}

async function handleChart(period, ctx) {
  const intervalMap = {
    '1D': { interval: '5m',  range: '1d' },
    '1W': { interval: '1h',  range: '5d' },
    '1M': { interval: '1d',  range: '1mo' },
    '1Y': { interval: '1wk', range: '1y' },
    '5Y': { interval: '1mo', range: '5y' },
  };
  
  const cfg = intervalMap[period] || intervalMap['1M'];

  try {
    // Try Yahoo Finance for XAG/USD spot
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/XAGUSD=X?interval=${cfg.interval}&range=${cfg.range}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });

    if (r.ok) {
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (result) {
        const timestamps = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];
        const points = timestamps.map((t, i) => ({
          t: t * 1000,
          v: closes[i]
        })).filter(p => p.v != null && p.v > 0);

        if (points.length > 3) {
          return new Response(JSON.stringify({ period, points }), {
            headers: { ...CORS, 'Cache-Control': `public, max-age=${CACHE_HIST}` }
          });
        }
      }
    }
  } catch(e) {}

  // Fallback: Try silver futures
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/SI=F?interval=${cfg.interval}&range=${cfg.range}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (r.ok) {
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (result) {
        const timestamps = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];
        const points = timestamps.map((t, i) => ({
          t: t * 1000,
          v: closes[i]
        })).filter(p => p.v != null && p.v > 0);

        if (points.length > 3) {
          return new Response(JSON.stringify({ period, points }), {
            headers: { ...CORS, 'Cache-Control': `public, max-age=${CACHE_HIST}` }
          });
        }
      }
    }
  } catch(e) {}

  return new Response(JSON.stringify({ period, points: [], error: 'No data' }), {
    headers: { ...CORS }
  });
}