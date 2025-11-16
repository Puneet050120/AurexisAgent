export type ToolResult = {
  success: boolean;
  [key: string]: any;
};

async function executeWebSearch(params: { query: string }): Promise<ToolResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY is not set');

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: params.query,
      search_depth: 'advanced',
      max_results: 5,
      include_answer: true,
    }),
  });

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

    const response = await fetch(url);
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

  // 3) Generic arithmetic expression evaluation (numbers and operators only)
  let sanitized = raw;
  // Allow math operators and comparison operators
  sanitized = sanitized.replace(/[^0-9+\-*/().<>=!\s]/g, '').trim().replace(/\s+/g, '');

  if (!/[0-9]/.test(sanitized)) {
    throw new Error(`Invalid expression: must contain at least one number`);
  }
  if (/\.\s*\./.test(sanitized) || /\(\s*\)/.test(sanitized) || /[+\-*/]\s*[+\-*/]/.test(sanitized)) {
    throw new Error(`Invalid expression: malformed mathematical expression`);
  }

  const openParens = (sanitized.match(/\(/g) || []).length;
  const closeParens = (sanitized.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    throw new Error(`Invalid expression: unbalanced parentheses`);
  }

  try {
    const calculate = new Function('Math', 'return ' + sanitized);
    const result = calculate(Math);

    if (typeof result === 'boolean') {
      return {
        success: true,
        expression: sanitized,
        result,
      };
    }
    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error(`Invalid result: expression did not evaluate to a valid number or boolean`);
    }

    return {
      success: true,
      expression: sanitized,
      result,
    };
  } catch (evalError) {
    throw new Error(`Failed to evaluate expression "${params.expression}": ${evalError instanceof Error ? evalError.message : 'Unknown error'}`);
  }
}

async function executeStock(params: { symbol: string }): Promise<ToolResult> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) throw new Error('ALPHA_VANTAGE_API_KEY is not set');

  const symbol = params.symbol.toUpperCase();
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;

  const response = await fetch(url);
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

