export function extractNumericValue(result: any): number | null {
  if (typeof result === 'number') return result;
  if (typeof result === 'string') {
    const parsed = parseFloat(result);
    if (!isNaN(parsed) && isFinite(parsed)) return parsed;
  }
  if (Array.isArray(result) && result.every((item: any) => typeof item === 'number')) {
    return result.reduce((sum, num) => sum + num, 0);
  }
  if (result && typeof result === 'object') {
    if (result.result !== undefined && typeof result.result === 'number') return result.result;
    if (result.data?.temperature !== undefined && typeof result.data.temperature === 'number') return result.data.temperature;
    if (result.data?.price !== undefined && typeof result.data.price === 'number') return result.data.price;
    for (const key in result) {
      if (typeof result[key] === 'number') return result[key];
    }
  }
  return null;
}

function extractNumbersFromText(text: string): number[] {
  const numbers: number[] = [];
  const patterns = [
    /\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(?:billion|million|thousand|b|m|k)/gi,
    /\$?\s*(\d{1,3}(?:\.\d{2})?)\s*(?:per\s*share|stock|price|was|at|closed)/gi,
    /\$(\d{1,3}\.?\d{0,2})\b/g,
  ];

  patterns.forEach((pattern) => {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const numStr = match[1]?.replace(/,/g, '');
      if (numStr) {
        let num = parseFloat(numStr);
        if (!isNaN(num) && num > 0) {
          const unit = match[0].toLowerCase();
          if (unit.includes('b') || unit.includes('billion')) num *= 1000000000;
          else if (unit.includes('m') || unit.includes('million')) num *= 1000000;
          else if (unit.includes('k') || unit.includes('thousand')) num *= 1000;
          if (num >= 0.01 && num <= 1000000000000) {
            numbers.push(num);
          }
        }
      }
    }
  });

  return [...new Set(numbers)].sort((a, b) => b - a);
}

export function extractCalculatorParams(
  description: string,
  dependencies: Map<string, any>
): string | null {
  const descLower = description.toLowerCase();
  const depArray = Array.from(dependencies.values());
  const text = JSON.stringify(depArray).toLowerCase();

  // Helper: extract plausible FX rates (40-200) from text
  const extractFxRates = (t: string): number[] => {
    const nums: number[] = [];
    const directMatches = t.match(/\b(?:1\s*usd\s*=?\s*)(\d{1,3}(?:\.\d+)?)(?:\s*(?:inr|₹))\b/gi) || [];
    directMatches.forEach((m) => {
      const valMatch = m.match(/(\d{1,3}(?:\.\d+)?)/);
      if (valMatch) {
        const v = parseFloat(valMatch[1]);
        if (v >= 40 && v <= 200) nums.push(v);
      }
    });
    const numericMatches = t.match(/\b\d{1,3}(?:\.\d+)?\b/g) || [];
    numericMatches.forEach((s) => {
      const v = parseFloat(s);
      if (v >= 40 && v <= 200) nums.push(v);
    });
    return Array.from(new Set(nums));
  };

  // Try to resolve placeholders like [current_rate], [average_rate]
  const rates = extractFxRates(text);
  let currentRate: number | null = null;
  let averageRate: number | null = null;
  if (rates.length > 0) {
    currentRate = rates[0];
    if (rates.length >= 2) {
      const sum = rates.reduce((a, b) => a + b, 0);
      averageRate = sum / rates.length;
    }
  }
  // Also fallback: use first numeric from first dep as current, first numeric from second dep as average
  if (!currentRate && depArray[0]) {
    const n = extractNumericValue(depArray[0]?.result);
    if (n && n >= 0.0001) currentRate = n;
  }
  if (!averageRate && depArray[1]) {
    const n = extractNumericValue(depArray[1]?.result);
    if (n && n >= 0.0001) averageRate = n;
  }

  // FX specific intents
  // 1) "<amount> divided by the current rate"
  const amountMatch = description.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?)/);
  if (amountMatch && currentRate) {
    const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (amount > 0) {
      if (descLower.includes('divided by the current rate') || descLower.includes('to usd') || descLower.includes('in usd')) {
        return `${amount} / ${currentRate}`;
      }
      if (descLower.includes('multipl') && (descLower.includes('rate') || descLower.includes('to inr') || descLower.includes('in inr'))) {
        return `${amount} * ${currentRate}`;
      }
    }
  }
  // 2) "difference between current rate and 30-day average rate"
  if (currentRate && averageRate && (descLower.includes('difference') || descLower.includes('favorable'))) {
    // Return percentage difference (positive => current > average)
    return `(${currentRate} - ${averageRate}) / ${averageRate} * 100`;
  }

  // Generic "Calculate: <expr>" with optional trailing prose; replace placeholders before sanitizing
  const calcPrefix = description.match(/Calculate:\s*([^\n]+)/i);
  if (calcPrefix) {
    // Stop at " to ..." if present to avoid prose
    let exprRaw = calcPrefix[1];
    const toIdx = exprRaw.toLowerCase().indexOf(' to ');
    if (toIdx > 0) exprRaw = exprRaw.slice(0, toIdx);
    // Substitute placeholders
    if (currentRate) {
      exprRaw = exprRaw.replace(/\[(?:rate|current_rate)\]/gi, String(currentRate));
    }
    if (averageRate) {
      exprRaw = exprRaw.replace(/\[average_rate\]/gi, String(averageRate));
    }
    // Clean keep math/compare ops and numbers
    let expr = exprRaw.replace(/[^0-9+\-*/().<>=!\s]/g, '').replace(/\s+/g, ' ').trim();
    // Fix dangling operator by removing trailing operator if present
    expr = expr.replace(/[+\-*/.<>=!]\s*$/, '').trim();
    if (/[0-9]/.test(expr)) {
      return expr;
    }
  }

  // If description includes "using expression ..." capture the expression and substitute placeholders
  const exprPhrase = description.match(/using\s+expression\s+([^\n]+)/i);
  if (exprPhrase) {
    let expr = exprPhrase[1].trim();
    if (currentRate) expr = expr.replace(/\[current_rate\]/gi, String(currentRate));
    if (averageRate) expr = expr.replace(/\[average_rate\]/gi, String(averageRate));
    // Replace generic [rate] with currentRate if present
    if (currentRate) expr = expr.replace(/\[rate\]/gi, String(currentRate));
    // Remove stray words, keep math ops and numbers
    expr = expr.replace(/[^0-9+\-*/().<>=!\s]/g, '').replace(/\s+/g, ' ').trim();
    if (/[0-9]/.test(expr)) return expr;
  }

  // Special pattern: "calories in N bananas" (or similar "value in N items") using a numeric value from dependencies
  // e.g., "Calculate: calories in 3 bananas using value from task-1"
  const qtyMatch = descLower.match(/(?:in|for)\s+(\d+)\s+(?:bananas?|items?|units?)/i) || descLower.match(/(\d+)\s*(?:x|times)\b/i);
  if (qtyMatch) {
    const n = parseInt(qtyMatch[1], 10);
    if (n > 0 && n <= 1000) {
      for (const [_, dep] of dependencies) {
        const depNum = extractNumericValue(dep?.result);
        if (depNum !== null && depNum > 0) {
          return `${depNum} * ${n}`;
        }
      }
    }
  }

  // FX conversion: "USD amount for X INR" or "INR amount for X USD"
  const inrToUsd = descLower.match(/usd\s+amount\s+for\s+(\d+(?:\.\d+)?)\s*inr/i);
  if (inrToUsd && currentRate) {
    const amount = parseFloat(inrToUsd[1]);
    if (amount > 0) {
      return `${amount} / ${currentRate}`;
    }
  }
  const usdToInr = descLower.match(/inr\s+amount\s+for\s+(\d+(?:\.\d+)?)\s*usd/i);
  if (usdToInr && currentRate) {
    const amount = parseFloat(usdToInr[1]);
    if (amount > 0) {
      return `${amount} * ${currentRate}`;
    }
  }

  // Handle "generate/list numbers" pattern (for task-1 that generates numbers)
  const generatePatterns = [
    /generate\s+(?:first|first\s+\d+)?\s*(\d+)\s*(?:whole|natural|consecutive)?\s*numbers?/i,
    /list\s+(?:first|first\s+\d+)?\s*(\d+)\s*(?:whole|natural|consecutive)?\s*numbers?/i,
    /get\s+(?:first|first\s+\d+)?\s*(\d+)\s*(?:whole|natural|consecutive)?\s*numbers?/i,
    /extract\s+(?:first|first\s+\d+)?\s*(\d+)\s*(?:whole|natural|consecutive)?\s*numbers?/i,
  ];
  
  for (const pattern of generatePatterns) {
    const match = descLower.match(pattern);
    if (match && match[1]) {
      const n = parseInt(match[1]);
      if (n > 0 && n <= 100) {
        // For generating numbers, create an expression that lists them (we'll return as sum for now, but task-2 will use this)
        const numbers: number[] = [];
        for (let i = 1; i <= n; i++) {
          numbers.push(i);
        }
        // Return the numbers as a sum expression (this will be used to "generate" them)
        return numbers.join('+');
      }
    }
  }
  
  // Handle extracting numbers from dependency (for task-2 that depends on task-1)
  if (descLower.includes('sum') && descLower.includes('from') || descLower.includes('task')) {
    for (const [_, dep] of dependencies) {
      const depResult = dep?.result;
      if (depResult && typeof depResult === 'object') {
        // Check if dependency description contains a list of numbers
        const depDesc = dep?.description || '';
        const numbersMatch = depDesc.match(/(?:numbers?|list|generate).*?(\d+(?:\s*,\s*\d+)+)/i) ||
                           depDesc.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (numbersMatch) {
          // Extract numbers from the match
          const numbersStr = numbersMatch[1] || depDesc;
          const numbers = numbersStr.match(/\d+/g)?.map((n: string) => parseInt(n, 10)) || [];
          if (numbers.length > 0) {
            return numbers.join('+');
          }
        }
        
        // If dependency was a "generate numbers" task, try to extract from its result or create from description
        const depDescLower = depDesc.toLowerCase();
        if (depDescLower.includes('generate') || depDescLower.includes('list') || depDescLower.includes('get')) {
          const nMatch = depDesc.match(/(\d+)\s*(?:whole|natural|consecutive)?\s*numbers?/i);
          if (nMatch) {
            const n = parseInt(nMatch[1]);
            if (n > 0 && n <= 100) {
              const numbers: number[] = [];
              for (let i = 1; i <= n; i++) {
                numbers.push(i);
              }
              return numbers.join('+');
            }
          }
        }
      }
    }
  }

  // Handle "sum of first n numbers" pattern - various formats (only if no dependencies or if this is the final calculation)
  if (dependencies.size === 0 || descLower.includes('calculate') && !descLower.includes('from')) {
    const sumPatterns = [
      /(?:calculate|compute|find|what\s+is)\s+(?:the\s+)?sum\s+of\s+(?:the\s+)?first\s+(\d+)\s*(?:whole|natural|consecutive)?\s*numbers?/i,
      /sum\s+of\s+(?:the\s+)?first\s+(\d+)\s*(?:whole|natural|consecutive)?\s*numbers?/i,
      /sum\s+(?:from\s+)?1\s+to\s+(\d+)/i,
      /add\s+(?:up\s+)?(?:numbers\s+)?(?:from\s+)?1\s+to\s+(\d+)/i,
    ];
    
    for (const pattern of sumPatterns) {
      const match = descLower.match(pattern);
      if (match && match[1]) {
        const n = parseInt(match[1]);
        if (n > 0 && n <= 1000) {
          // For direct sum (no dependencies), use formula
          return `${n}*(${n}+1)/2`;
        }
      }
    }
  }
  
  // Handle "sum from 1 to n" pattern
  const sumFromToMatch = descLower.match(/sum\s+(?:from\s+)?(\d+)\s+to\s+(\d+)/i);
  if (sumFromToMatch) {
    const start = parseInt(sumFromToMatch[1]);
    const end = parseInt(sumFromToMatch[2]);
    if (start > 0 && end > start && end - start <= 100) {
      // Generate explicit sum for small ranges
      const numbers: number[] = [];
      for (let i = start; i <= end; i++) {
        numbers.push(i);
      }
      return numbers.join('+');
    } else if (start === 1) {
      // Use formula for sum from 1 to n
      return `${end}*(${end}+1)/2`;
    }
  }
  
  // Handle explicit expressions in description (e.g., "Calculate: 10*11/2" or "Calculate: 1+2+3+4+5+6+7+8+9+10")
  const explicitExprMatch = description.match(/(?:Calculate|Compute):\s*([\d+\-*/().\s]+)/i) ||
                           description.match(/:\s*([\d+\-*/().\s]+)$/);
  if (explicitExprMatch) {
    let expr = explicitExprMatch[1].trim().replace(/\s+/g, '');
    // Handle cases like "10*11/2" or "1+2+3+4+5+6+7+8+9+10"
    // Validate it's a valid expression (numbers, operators, parentheses)
    if (/^[\d+\-*/().]+$/.test(expr) && expr.length > 0) {
      // Make sure it has at least one operator or is a formula
      if (/[+\-*/]/.test(expr) || expr.includes('(')) {
        return expr;
      }
    }
  }

  if (descLower.includes('cagr') || descLower.includes('compound annual growth') || descLower.includes('growth rate')) {
    let currentPrice: number | null = null;
    let historicalPrice: number | null = null;
    let years = 5;

    const yearsMatch = description.match(/(\d+)\s*year/i);
    if (yearsMatch) years = parseInt(yearsMatch[1]);

    for (const [_, dep] of dependencies) {
      const depResult = dep?.result;
      if (depResult?.data?.price !== undefined) {
        currentPrice = depResult.data.price;
      }
      if (depResult?.summary || depResult?.results) {
        const prices = extractNumbersFromText(JSON.stringify(depResult));
        if (prices.length > 0) historicalPrice = prices[0];
      }
    }

    if (currentPrice !== null && historicalPrice !== null && currentPrice > 0 && historicalPrice > 0) {
      return `Math.pow(${currentPrice} / ${historicalPrice}, 1 / ${years}) - 1`;
    }
  }

  let numbers = extractNumbersFromText(text);
  if (numbers.length === 0) {
    for (const [_, dep] of dependencies) {
      const num = extractNumericValue(dep?.result);
      if (num !== null && !numbers.includes(num)) numbers.push(num);
    }
  }

  if (numbers.length === 0) return null;

  if (descLower.includes('sum') || descLower.includes('total')) {
    return numbers.join(' + ');
  }
  if (descLower.includes('average') || descLower.includes('mean')) {
    const sum = numbers.reduce((a, b) => a + b, 0);
    return `${sum} / ${numbers.length}`;
  }
  if (descLower.includes('max') || descLower.includes('maximum') || descLower.includes('highest')) {
    return `Math.max(${numbers.join(', ')})`;
  }
  if (descLower.includes('min') || descLower.includes('minimum') || descLower.includes('lowest')) {
    return `Math.min(${numbers.join(', ')})`;
  }
  if (descLower.includes('convert') || descLower.includes('fahrenheit')) {
    if (numbers.length > 0) {
      if (descLower.includes('fahrenheit') && !descLower.includes('celsius')) {
        return `${numbers[0]} * 9/5 + 32`;
      }
      if (descLower.includes('celsius') && descLower.includes('fahrenheit')) {
        return `(${numbers[0]} - 32) * 5/9`;
      }
    }
  }

  const exprMatch = description.match(/:\s*([a-zA-Z0-9+\-*/().\s]+)/) ||
                   description.match(/(?:calculate|compute)\s+([a-zA-Z0-9+\-*/().\s]+)/i);

  if (exprMatch) {
    let expr = exprMatch[1].trim();
    numbers.forEach((num, idx) => {
      expr = expr.replace(new RegExp(`\\b(price|value|result|temp|temperature|amount|num${idx + 1}|amount${idx + 1})\\b`, 'gi'), String(num));
    });
    if (/[0-9]/.test(expr) && /[+\-*/]/.test(expr)) {
      return expr.replace(/\s+/g, '');
    }
  }

  return numbers.length > 0 ? String(numbers[0]) : null;
}

export function extractStockSymbol(description: string): string | null {
  const descUpper = description.toUpperCase();
  const companyMap: Record<string, string> = {
    'APPLE': 'AAPL', 'MICROSOFT': 'MSFT', 'GOOGLE': 'GOOGL', 'ALPHABET': 'GOOGL',
    'AMAZON': 'AMZN', 'TESLA': 'TSLA', 'META': 'META', 'FACEBOOK': 'META',
    'NVIDIA': 'NVDA', 'NETFLIX': 'NFLX', 'DISNEY': 'DIS', 'IBM': 'IBM',
    'INTEL': 'INTC', 'ORACLE': 'ORCL', 'SALESFORCE': 'CRM',
  };

  for (const [company, symbol] of Object.entries(companyMap)) {
    if (descUpper.includes(company)) return symbol;
  }

  const symbolMatch = descUpper.match(/\b([A-Z]{2,5})\b/);
  if (symbolMatch) {
    const candidate = symbolMatch[1];
    if (!['FOR', 'THE', 'AND', 'WITH', 'USING', 'CAGR', 'YEAR', 'YEARS', 'DATA', 'STOCK', 'PRICE'].includes(candidate)) {
      return candidate;
    }
  }

  const descMatch = description.match(/for:\s*([A-Z]{2,5})\b/i);
  if (descMatch) return descMatch[1].toUpperCase();

  return null;
}
