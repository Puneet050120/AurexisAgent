export type ToolResult = {
  success: boolean;
  [key: string]: any;
};

async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit & { timeoutMs?: number } = {}, attempts = 3, backoffMs = 400): Promise<Response> {
  let lastErr: any;
  const timeoutMs = init.timeoutMs ?? 7000;
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(input, { ...init, signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, i)));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Network error');
}

async function executeWebSearch(params: { query: string }): Promise<ToolResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY is not set');

  const response = await fetchWithRetry('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: params.query,
      search_depth: 'advanced',
      max_results: 5,
      include_answer: true,
    }),
    timeoutMs: 8000,
  }, 2);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tavily API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const results = (data.results || []).map((r: any) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score || 0,
  })).sort((a: any, b: any) => (b.score || 0) - (a.score || 0));

  return {
    success: true,
    query: params.query,
    results,
    summary: data.answer || data.summary || null,
  };
}

async function executeApi(params: { endpoint: string; params?: Record<string, any> }): Promise<ToolResult> {
  if (params.endpoint === 'weather') {
    const apiKey = process.env.OPENWEATHERMAP_API_KEY;
    if (!apiKey) throw new Error('OPENWEATHERMAP_API_KEY is not set');

    const city = params.params?.city || 'London';
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`;

    const response = await fetchWithRetry(url, { timeoutMs: 7000 }, 2);
    if (!response.ok) {
      throw new Error(`Weather API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      success: true,
      endpoint: 'weather',
      data: {
        city: data.name,
        temperature: data.main.temp,
        description: data.weather[0].description,
        humidity: data.main.humidity,
        windSpeed: data.wind.speed,
      },
    };
  }
  
  throw new Error(`Unsupported endpoint: ${params.endpoint}`);
}

async function executeCalculator(params: { expression: string }): Promise<ToolResult> {
  if (!params.expression || params.expression.trim().length === 0) {
    throw new Error('Expression is required');
  }

  const raw = params.expression.trim();

  // Fast-path handlers for common function-style inputs produced by the planner
  // 1) Math.max( ...numbers... ) and Math.min( ...numbers... )
  const maxMinMatch = raw.match(/^Math\.(max|min)\s*\((.*)\)\s*$/i);
  if (maxMinMatch) {
    const fn = maxMinMatch[1].toLowerCase(); // 'max' | 'min'
    const inner = maxMinMatch[2];
    // Extract numeric tokens robustly (supports ints, decimals, and signs)
    const numMatches = inner.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    const numbers = numMatches.map((n) => parseFloat(n)).filter((n) => Number.isFinite(n));
    if (numbers.length === 0) {
      throw new Error('No numeric values found for Math.' + fn);
    }
    const result = fn === 'max' ? Math.max(...numbers) : Math.min(...numbers);
    return {
      success: true,
      expression: `Math.${fn}(${numbers.join(', ')})`,
      result,
    };
    }

  // 2) average( ...numbers... )
  const avgMatch = raw.match(/^average\s*\((.*)\)\s*$/i);
  if (avgMatch) {
    const inner = avgMatch[1];
    const numMatches = inner.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    const numbers = numMatches.map((n) => parseFloat(n)).filter((n) => Number.isFinite(n));
    if (numbers.length === 0) {
      throw new Error('No numeric values found for average()');
    }
    const sum = numbers.reduce((acc, n) => acc + n, 0);
    const result = sum / numbers.length;
    return {
      success: true,
      expression: `average(${numbers.join(', ')})`,
      result,
    };
  }

  // 3) Generic arithmetic expression evaluation (Edge-safe)
  // Supports numbers, + - * /, parentheses, and decimals.
  // Implements shunting-yard to RPN, then evaluates.
  const expr = raw.replace(/[^0-9+\-*/().\s]/g, '').trim().replace(/\s+/g, '');
  if (!/[0-9]/.test(expr)) throw new Error('Invalid expression: must contain numbers');
  const openParens = (expr.match(/\(/g) || []).length;
  const closeParens = (expr.match(/\)/g) || []).length;
  if (openParens !== closeParens) throw new Error('Invalid expression: unbalanced parentheses');

  const isOperator = (c: string) => c === '+' || c === '-' || c === '*' || c === '/';
  const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const output: string[] = [];
  const ops: string[] = [];

  // Tokenize numbers and operators/parentheses
  const tokens: string[] = [];
  for (let i = 0; i < expr.length; ) {
    const ch = expr[i];
    if (/\d|\./.test(ch)) {
      let j = i + 1;
      while (j < expr.length && /[\d.]/.test(expr[j])) j++;
      tokens.push(expr.slice(i, j));
      i = j;
    } else if (isOperator(ch) || ch === '(' || ch === ')') {
      tokens.push(ch);
      i += 1;
    } else {
      // Should not happen after sanitization
      i += 1;
    }
  }

  // Shunting-yard
  for (const t of tokens) {
    if (/^\d*\.?\d+$/.test(t)) {
      output.push(t);
    } else if (isOperator(t)) {
      while (ops.length > 0 && isOperator(ops[ops.length - 1]) && precedence[ops[ops.length - 1]] >= precedence[t]) {
        output.push(ops.pop() as string);
      }
      ops.push(t);
    } else if (t === '(') {
      ops.push(t);
    } else if (t === ')') {
      while (ops.length > 0 && ops[ops.length - 1] !== '(') {
        output.push(ops.pop() as string);
      }
      if (ops.length === 0 || ops[ops.length - 1] !== '(') {
        throw new Error('Invalid expression: mismatched parentheses');
      }
      ops.pop();
    }
  }
  while (ops.length > 0) {
    const op = ops.pop() as string;
    if (op === '(' || op === ')') throw new Error('Invalid expression: mismatched parentheses');
    output.push(op);
  }

  // Evaluate RPN
  const st: number[] = [];
  for (const t of output) {
    if (/^\d*\.?\d+$/.test(t)) {
      st.push(parseFloat(t));
    } else if (isOperator(t)) {
      const b = st.pop();
      const a = st.pop();
      if (a === undefined || b === undefined) throw new Error('Invalid expression');
      let v = 0;
      if (t === '+') v = a + b;
      else if (t === '-') v = a - b;
      else if (t === '*') v = a * b;
      else if (t === '/') v = b === 0 ? Infinity : a / b;
      st.push(v);
    }
  }
  if (st.length !== 1 || !isFinite(st[0])) throw new Error('Invalid result');

  return {
    success: true,
    expression: expr,
    result: st[0],
  };
}

async function executeStock(params: { symbol: string }): Promise<ToolResult> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) throw new Error('ALPHA_VANTAGE_API_KEY is not set');

  const symbol = params.symbol.toUpperCase();
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;

  const response = await fetchWithRetry(url, { timeoutMs: 8000 }, 2);
  if (!response.ok) {
    throw new Error(`Stock API error: ${response.status}`);
  }

  const data = await response.json();
  
  if (data['Global Quote'] && Object.keys(data['Global Quote']).length > 0) {
    const quote = data['Global Quote'];
    return {
      success: true,
      symbol,
      data: {
        symbol: quote['01. symbol'],
        price: parseFloat(quote['05. price']),
        change: parseFloat(quote['09. change']),
        changePercent: quote['10. change percent'],
        volume: parseInt(quote['06. volume']),
        high: parseFloat(quote['03. high']),
        low: parseFloat(quote['04. low']),
        open: parseFloat(quote['02. open']),
        previousClose: parseFloat(quote['08. previous close']),
      },
    };
  }

  if (data['Error Message'] || data['Note']) {
    throw new Error(data['Error Message'] || data['Note'] || 'Stock API returned an error');
  }

  throw new Error(`No stock data found for symbol: ${symbol}`);
}

export const toolExecutors: Record<string, (params: any) => Promise<ToolResult>> = {
  web_search: executeWebSearch,
  api: executeApi,
  calculator: executeCalculator,
  stock: executeStock,
};

