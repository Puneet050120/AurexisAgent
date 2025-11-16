import { Plan, TaskStatus } from '../types/agent';

export interface TaskResultWithInfo {
  taskId: string;
  description: string;
  tool: string;
  status: string | TaskStatus;
  result?: any;
  error?: string | null;
  dependencies?: string[];
}

export function generateFinalSummary(
  plan: Plan,
  taskResults: TaskResultWithInfo[]
): {
  text: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  successRate: string;
  finalAnswer: string;
  keyFindings: string[];
  sources: Array<{ title: string; url: string }>;
} {
  const totalTasks = plan.tasks.length;
  const normalizedTaskResults = taskResults.map((t) => ({
    ...t,
    status: String(t.status).toLowerCase(),
  }));
  
  const completedTasks = normalizedTaskResults.filter((t) => t.status === 'completed').length;
  const failedTasks = normalizedTaskResults.filter((t) => t.status === 'failed').length;
  const successRate = totalTasks > 0 ? ((completedTasks / totalTasks) * 100).toFixed(1) : '0';

  // Build clean, ChatGPT-like response
  let finalAnswer = '';
  const sources: Array<{ title: string; url: string }> = [];
  const sourcesMap = new Map<string, { title: string; url: string }>();
  
  const weatherTasks = normalizedTaskResults.filter(
    (t) => t.tool === 'api' && t.status === 'completed' && t.result?.data
  );
  const searchTasks = normalizedTaskResults.filter(
    (t) => t.tool === 'web_search' && t.status === 'completed'
  );
  const calculatorTasks = normalizedTaskResults.filter(
    (t) => t.tool === 'calculator' && t.status === 'completed' && t.result?.result !== undefined
  );
  const stockTasks = normalizedTaskResults.filter(
    (t) => t.tool === 'stock' && t.status === 'completed' && t.result?.data
  );
  
  // Collect all sources from search tasks
  searchTasks.forEach((task) => {
    const result = task.result;
    if (result?.results && Array.isArray(result.results)) {
      result.results.forEach((r: any) => {
        if (r.url && !sourcesMap.has(r.url)) {
          const source = {
            title: r.title || 'Source',
            url: r.url,
          };
          sourcesMap.set(r.url, source);
          sources.push(source);
        }
      });
    }
  });

  // Format weather results - check if there's a temperature conversion
  const weatherToCalculator = new Map<string, string>();
  calculatorTasks.forEach((calcTask) => {
    const calcDesc = calcTask.description?.toLowerCase() || '';
    if ((calcDesc.includes('fahrenheit') || calcDesc.includes('temp')) && calcTask.result?.result !== undefined) {
      // Find which weather task this calculator depends on
      const calcTaskId = calcTask.taskId;
      const calcTaskObj = normalizedTaskResults.find(t => t.taskId === calcTaskId);
      // Also check plan.tasks for dependencies if not in normalizedTaskResults
      const planTask = plan.tasks.find(t => t.id === calcTaskId);
      const taskDeps = calcTaskObj?.dependencies || planTask?.dependencies || [];
      if (taskDeps.length > 0) {
        const weatherTaskId = taskDeps[0];
        // Check if the dependency is a weather task
        const depTask = plan.tasks.find(t => t.id === weatherTaskId);
        if (depTask?.tool === 'api') {
          const tempF = typeof calcTask.result.result === 'number' 
            ? (calcTask.result.result % 1 === 0 ? calcTask.result.result.toString() : calcTask.result.result.toFixed(1))
            : String(calcTask.result.result);
          weatherToCalculator.set(weatherTaskId, tempF);
        }
      }
    }
  });

  if (weatherTasks.length > 0) {
    weatherTasks.forEach((task) => {
      const data = task.result?.data;
      if (data?.city) {
        const conditionEmoji = data.description?.toLowerCase().includes('clear') || 
                               data.description?.toLowerCase().includes('sunny') ? '☀️' : 
                               data.description?.toLowerCase().includes('cloud') ? '☁️' : 
                               data.description?.toLowerCase().includes('rain') ? '🌧️' : 
                               data.description?.toLowerCase().includes('snow') ? '❄️' : '🌤️';
        
        // Check if there's a converted temperature for this weather task
        const tempF = weatherToCalculator.get(task.taskId);
        
        if (tempF) {
          finalAnswer += `**${data.city}**: ${conditionEmoji} ${data.temperature}°C (${tempF}°F), ${data.description}`;
        } else {
          finalAnswer += `**${data.city}**: ${conditionEmoji} ${data.temperature}°C, ${data.description}`;
        }
        
        if (data.humidity || data.windSpeed) {
          finalAnswer += ` (${data.humidity}% humidity`;
          if (data.windSpeed) finalAnswer += `, ${data.windSpeed} m/s wind`;
          finalAnswer += `)`;
        }
        finalAnswer += '\n\n';
      }
    });
  }

  // Check if this is a CAGR or stock comparison query
  const goalLower = plan.goal.toLowerCase();
  const isCAGRQuery = goalLower.includes('cagr') || goalLower.includes('compound annual growth rate') || 
                      goalLower.includes('annual growth') || goalLower.includes('growth rate');
  const isStockComparison = (goalLower.includes('compare') || goalLower.includes('comparison')) && stockTasks.length > 1;

  // Format stock results with context - Avoid duplicates
  const uniqueStockSymbols = new Set<string>();
  
  if (stockTasks.length > 0) {
    if (isCAGRQuery && calculatorTasks.length > 0) {
      // This is a CAGR comparison - format it properly with narrative
      const stockSymbols = stockTasks
        .map(t => t.result?.data?.symbol)
        .filter((symbol): symbol is string => Boolean(symbol) && !uniqueStockSymbols.has(symbol))
        .map(symbol => {
          uniqueStockSymbols.add(symbol);
          return symbol;
        });
      
      // Map calculator results to stock symbols by matching task descriptions
      const cagrResults: { symbol: string; cagr: number }[] = [];
      calculatorTasks.forEach((calcTask) => {
        const calcResult = calcTask.result?.result;
        if (calcResult === undefined) return;
        
        // Try to extract stock symbol from calculator task description
        const desc = calcTask.description || '';
        const symbolMatch = desc.match(/\b([A-Z]{1,5})\b/) || desc.match(/\b(AAPL|MSFT|GOOGL|AMZN|TSLA|META|NVDA|NFLX|DIS|IBM)\b/i);
        let matchedSymbol: string | null = null;
        
        if (symbolMatch) {
          const candidateSymbol = symbolMatch[1].toUpperCase();
          // Verify this symbol exists in our stock tasks
          if (stockSymbols.includes(candidateSymbol)) {
            matchedSymbol = candidateSymbol;
          }
        }
        
        // If no symbol found in description, try to match by order (as fallback)
        // We'll rely on the planner creating tasks in the correct order
        
        // If still no match, use index as fallback but only if unique
        if (!matchedSymbol && stockSymbols.length > 0) {
          const usedIndices = new Set(cagrResults.map(r => stockSymbols.indexOf(r.symbol)));
          for (let i = 0; i < stockSymbols.length; i++) {
            if (!usedIndices.has(i)) {
              matchedSymbol = stockSymbols[i];
              break;
            }
          }
        }
        
        if (matchedSymbol) {
          // Convert to percentage - handle various formats
          let cagrPercent: number;
          if (typeof calcResult === 'number') {
            // Handle different formats: 1.45 = 45%, 45 = 45%, 4505 = 4505% (unlikely but possible)
            // Most likely: values between 1-10 are multipliers, >100 are percentages
            if (calcResult >= 100 && calcResult < 1000) {
              cagrPercent = calcResult; // Already a percentage (e.g., 45.05)
            } else if (calcResult >= 1000) {
              // Very large number - likely a price or incorrectly formatted, divide by 100
              cagrPercent = calcResult / 100;
            } else if (calcResult > 1 && calcResult < 10) {
              cagrPercent = (calcResult - 1) * 100; // Multiplier format (e.g., 1.45 = 45%)
            } else if (calcResult > 10 && calcResult < 100) {
              cagrPercent = calcResult; // Likely already percentage
            } else if (calcResult > 0 && calcResult <= 1) {
              cagrPercent = calcResult * 100; // Decimal format (e.g., 0.45 = 45%)
            } else {
              cagrPercent = calcResult;
            }
          } else {
            const parsed = parseFloat(String(calcResult));
            if (parsed >= 1000) {
              cagrPercent = parsed / 100;
            } else if (parsed >= 100) {
              cagrPercent = parsed;
            } else if (parsed > 1 && parsed < 10) {
              cagrPercent = (parsed - 1) * 100;
            } else if (parsed <= 1) {
              cagrPercent = parsed * 100;
            } else {
              cagrPercent = parsed;
            }
          }
          
          cagrResults.push({ symbol: matchedSymbol, cagr: cagrPercent });
        }
      });
      
      if (cagrResults.length > 0) {
        finalAnswer += `## Stock CAGR Analysis\n\n`;
        finalAnswer += `I've calculated the Compound Annual Growth Rate (CAGR) for the stocks you requested.\n\n`;
        
        cagrResults.forEach(({ symbol, cagr }) => {
          finalAnswer += `**${symbol}**: ${cagr.toFixed(2)}% CAGR over 5 years\n`;
        });
        
        if (cagrResults.length >= 2) {
          finalAnswer += '\n';
          const [first, second] = cagrResults;
          const higher = first.cagr > second.cagr ? first : second;
          const lower = first.cagr > second.cagr ? second : first;
          const diff = Math.abs(first.cagr - second.cagr);
          
          finalAnswer += `**Comparison**: ${higher.symbol} has shown stronger growth with a **${diff.toFixed(2)} percentage point** advantage over ${lower.symbol} in 5-year CAGR.\n\n`;
        }
        
        // Add current stock prices for context (once per symbol)
        finalAnswer += `**Current Stock Prices**:\n`;
        const shownSymbols = new Set<string>();
        stockTasks.forEach((task) => {
          const data = task.result?.data;
          if (data?.symbol && !shownSymbols.has(data.symbol)) {
            shownSymbols.add(data.symbol);
            const changeEmoji = (data.change || 0) >= 0 ? '📈' : '📉';
            finalAnswer += `- **${data.symbol}**: ${changeEmoji} $${data.price.toFixed(2)}`;
            if (data.change !== undefined && data.changePercent) {
              finalAnswer += ` (${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}, ${data.changePercent})`;
            }
            finalAnswer += '\n';
          }
        });
        finalAnswer += '\n';
      }
    } else if (isStockComparison && stockTasks.length > 1) {
      // Stock comparison without CAGR
      finalAnswer += `## Stock Comparison\n\n`;
      stockTasks.forEach((task) => {
        const data = task.result?.data;
        if (data?.symbol) {
          const changeEmoji = (data.change || 0) >= 0 ? '📈' : '📉';
          finalAnswer += `**${data.symbol}**: ${changeEmoji} $${data.price.toFixed(2)}`;
          if (data.change !== undefined && data.changePercent) {
            finalAnswer += ` (${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}, ${data.changePercent})`;
          }
          finalAnswer += '\n';
        }
      });
      
      // Add comparison summary
      if (stockTasks.length === 2) {
        const price1 = stockTasks[0]?.result?.data?.price || 0;
        const price2 = stockTasks[1]?.result?.data?.price || 0;
        const symbol1 = stockTasks[0]?.result?.data?.symbol || 'Stock 1';
        const symbol2 = stockTasks[1]?.result?.data?.symbol || 'Stock 2';
        
        if (price1 > 0 && price2 > 0) {
          const diff = Math.abs(price1 - price2);
          const higher = price1 > price2 ? symbol1 : symbol2;
          finalAnswer += `\n**Current Price Difference**: ${higher} is currently ${diff > 1 ? `$${diff.toFixed(2)}` : `${(diff/price1 * 100).toFixed(2)}%`} higher.\n\n`;
        }
      }
    } else {
      // Regular stock display
      stockTasks.forEach((task) => {
        const data = task.result?.data;
        if (data?.symbol) {
          const changeEmoji = (data.change || 0) >= 0 ? '📈' : '📉';
          finalAnswer += `**${data.symbol}**: ${changeEmoji} $${data.price.toFixed(2)}`;
          if (data.change !== undefined && data.changePercent) {
            finalAnswer += ` (${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}, ${data.changePercent})`;
          }
          finalAnswer += `\n   Open: $${data.open?.toFixed(2) || 'N/A'} | High: $${data.high?.toFixed(2) || 'N/A'} | Low: $${data.low?.toFixed(2) || 'N/A'}`;
          if (data.volume) {
            finalAnswer += `\n   Volume: ${data.volume.toLocaleString()}`;
          }
          finalAnswer += '\n\n';
        }
      });
    }
  }

  // Format calculator results with context
  if (calculatorTasks.length > 0 && !isCAGRQuery) {
    calculatorTasks.forEach((task, idx) => {
      const result = task.result?.result;
      const desc = task.description?.toLowerCase() || '';
      const originalDesc = task.description || '';
      const deps = task.dependencies || plan.tasks.find(t => t.id === task.taskId)?.dependencies || [];
      
      if (result !== undefined) {
        // Skip temperature conversions if they're already shown in weather section
        const taskDeps = task.dependencies || plan.tasks.find(t => t.id === task.taskId)?.dependencies || [];
        const isTemperatureConversion = (desc.includes('convert') || desc.includes('temperature') || desc.includes('fahrenheit') || desc.includes('celsius')) &&
                                        taskDeps.some((depId: string) => {
                                          const depPlanTask = plan.tasks.find(t => t.id === depId);
                                          return depPlanTask?.tool === 'api';
                                        });
        
        if (isTemperatureConversion) {
          // Temperature conversion is already shown in weather section, skip it here
          return;
        }
        
        // Try to infer what the calculation is about
        if (desc.includes('cagr') || desc.includes('compound annual growth') || desc.includes('growth rate')) {
          // Format as percentage
          const percent = typeof result === 'number' ? 
            (result > 1 ? ((result - 1) * 100) : (result * 100)) : 
            parseFloat(String(result));
          finalAnswer += `**CAGR Result**: ${percent.toFixed(2)}%\n\n`;
        } else if (/usd.*inr|inr.*usd|exchange rate|convert|₹|rs\.?/i.test(plan.goal)) {
          // Currency conversion narrative
          // Try to find the related search task that contains the rate
          let rate: number | null = null;
          for (const depId of deps) {
            const depTaskRes = normalizedTaskResults.find(t => t.taskId === depId && t.tool === 'web_search');
            const n = depTaskRes?.result ? parseFloat(String((depTaskRes.result.summary || '').match(/(\d+(\.\d+)?)/)?.[1] || '')) : NaN;
            if (!isNaN(n) && n > 0) {
              rate = n;
              break;
            }
          }
          const usdValue = typeof result === 'number' ? result : parseFloat(String(result));
          if (!isNaN(usdValue)) {
            const prettyUsd = `$${usdValue.toFixed(2)}`;
            const prettyInr = originalDesc.match(/10,?0{3,}/) ? '₹10,000' : '₹' + Math.round(usdValue * (rate || 80)).toLocaleString();
            if (rate) {
              finalAnswer += `**Currency Conversion**: ${prettyInr} ≈ ${prettyUsd} at ~₹${rate.toFixed(2)} per $1.\n\n`;
            } else {
              finalAnswer += `**Currency Conversion**: ≈ ${prettyUsd}.\n\n`;
            }
          } else {
            finalAnswer += `**Conversion Result**: ${String(result)}\n\n`;
          }
        } else if (desc.includes('compare') || desc.includes('comparison')) {
          // Comparison result
          if (typeof result === 'number') {
            finalAnswer += `**Comparison Value**: ${result.toLocaleString()}\n\n`;
          } else {
            finalAnswer += `**Result**: ${result}\n\n`;
          }
        } else {
          // Generic result with better formatting
          if (typeof result === 'number') {
            // Check if it's a large number that might be currency
            if (result > 1000 && desc.includes('funding') || desc.includes('amount')) {
              if (result >= 1000000000) {
                finalAnswer += `**Total**: $${(result / 1000000000).toFixed(2)}B\n\n`;
              } else if (result >= 1000000) {
                finalAnswer += `**Total**: $${(result / 1000000).toFixed(2)}M\n\n`;
              } else {
                finalAnswer += `**Total**: $${result.toLocaleString()}\n\n`;
              }
            } else {
              finalAnswer += `**Result**: ${result.toLocaleString()}\n\n`;
            }
          } else {
            finalAnswer += `**Result**: ${result}\n\n`;
          }
        }
      }
    });
  }

  // Format search results - Clean ChatGPT-style (without sources - collected separately)
  if (searchTasks.length > 0) {
    searchTasks.forEach((searchTask) => {
      const result = searchTask.result;
      
      // Use Tavily's AI-generated summary if available (best quality)
      if (result?.summary && result.summary.length > 50) {
        let cleanSummary = result.summary
          .replace(/^Based on the search results.*?:/i, '')
          .replace(/^According to the search results.*?:/i, '')
          .trim();
        
        finalAnswer += `${cleanSummary}\n\n`;
      } else if (result?.results && Array.isArray(result.results) && result.results.length > 0) {
        // Fallback: format top results cleanly
        const topResults = result.results
          .sort((a: any, b: any) => (b.score || 0) - (a.score || 0))
          .slice(0, 3);

        if (topResults.length > 0) {
          topResults.forEach((item: any, idx: number) => {
            let title = item.title || 'Source';
            // Clean title
            title = title
              .replace(/^THE \d+ BEST\s+/i, '')
              .replace(/^\d+\.\s*/i, '')
              .replace(/\s*-\s*(Tripadvisor|Reddit|Facebook|TripAdvisor).*$/i, '')
              .replace(/\s*\([^)]*\)\s*$/g, '')
              .replace(/\.\.\./g, '')
              .trim();
            
            if (item.content && item.content.length > 20) {
              // Extract first meaningful sentence
              const sentences = item.content.match(/[^.!?]+[.!?]+/g);
              if (sentences && sentences.length > 0) {
                const firstSentence = sentences[0].trim();
                if (firstSentence.length > 30 && firstSentence.length < 200) {
                  finalAnswer += `${idx + 1}. **${title}**\n   ${firstSentence}\n\n`;
                }
              }
            }
          });
        }
      }
    });
  }

  // If goal is about movies/ratings, add a recommendation based on highest rating we can infer
  if (/movie|imdb|rating|film/i.test(goalLower)) {
    let bestTitle: string | null = null;
    let bestRating = -1;
    searchTasks.forEach((task) => {
      const items = task.result?.results || [];
      items.forEach((it: any) => {
        const text = `${it.title || ''} ${it.content || ''}`;
        const match = text.match(/(\d\.\d)\s*\/\s*10/i);
        const rating = match ? parseFloat(match[1]) : NaN;
        if (!isNaN(rating) && rating > bestRating) {
          bestRating = rating;
          // Heuristic: use the first capitalized phrase from title as movie name
          const titleName = (it.title || '').replace(/\s*-\s*.*$/, '').trim();
          bestTitle = titleName || 'the top movie';
        }
      });
    });
    if (bestTitle && bestRating > 0) {
      finalAnswer += `\n**Recommendation**: Watch ${bestTitle} (IMDb ${bestRating.toFixed(1)}/10) tonight.\n`;
    }
  }

  // Summary text
  let summaryText = '';
  if (completedTasks === totalTasks) {
    summaryText = '';
  } else if (completedTasks > 0) {
    summaryText = '';
  } else {
    summaryText = `❌ Execution failed: All ${totalTasks} task${totalTasks > 1 ? 's' : ''} failed.\n\n`;
  }

  // Add error details if any tasks failed
  if (failedTasks > 0) {
    const failedTaskDetails = normalizedTaskResults
      .filter((t) => t.status === 'failed')
      .map((t) => `- ${t.description}: ${t.error || 'Unknown error'}`);
    
    if (failedTaskDetails.length > 0) {
      finalAnswer += `\n**Errors:**\n${failedTaskDetails.join('\n')}`;
    }
  }

  // If finalAnswer is empty or too short, try to build a better summary from available data
  if (!finalAnswer || finalAnswer.trim().length < 50) {
    // Try to create a narrative summary from the data we have
    if (isCAGRQuery && calculatorTasks.length > 0 && stockTasks.length >= 2) {
      const symbols = stockTasks.map(t => t.result?.data?.symbol).filter(Boolean);
      const cagrValues = calculatorTasks.map(t => {
        const val = t.result?.result;
        return typeof val === 'number' ? (val > 1 ? ((val - 1) * 100) : (val * 100)) : parseFloat(String(val || 0));
      });
      
      if (symbols.length >= 2 && cagrValues.length >= 2) {
        finalAnswer = `## Stock CAGR Analysis\n\n`;
        finalAnswer += `I calculated the 5-year Compound Annual Growth Rate (CAGR) for ${symbols[0]} and ${symbols[1]}.\n\n`;
        finalAnswer += `**${symbols[0]}**: ${cagrValues[0].toFixed(2)}% CAGR over 5 years\n`;
        finalAnswer += `**${symbols[1]}**: ${cagrValues[1].toFixed(2)}% CAGR over 5 years\n\n`;
        
        const higher = cagrValues[0] > cagrValues[1] ? symbols[0] : symbols[1];
        const diff = Math.abs(cagrValues[0] - cagrValues[1]);
        finalAnswer += `**Conclusion**: ${higher} has shown stronger growth with a ${diff.toFixed(2)} percentage point advantage in 5-year CAGR.\n\n`;
        
        // Add current prices for context
        stockTasks.forEach((task) => {
          const data = task.result?.data;
          if (data?.symbol) {
            finalAnswer += `Current ${data.symbol} price: $${data.price.toFixed(2)}\n`;
          }
        });
      }
    } else if (stockTasks.length > 0 && calculatorTasks.length === 0) {
      // Just stock data without calculations
      finalAnswer = `## Current Stock Information\n\n`;
      stockTasks.forEach((task) => {
        const data = task.result?.data;
        if (data?.symbol) {
          const changeEmoji = (data.change || 0) >= 0 ? '📈' : '📉';
          finalAnswer += `**${data.symbol}**: ${changeEmoji} $${data.price.toFixed(2)}`;
          if (data.change !== undefined) {
            finalAnswer += ` (${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}, ${data.changePercent || ''})`;
          }
          finalAnswer += '\n';
        }
      });
    }
  }

  return {
    text: summaryText + finalAnswer.trim(),
    totalTasks,
    completedTasks,
    failedTasks,
    successRate: `${successRate}%`,
    finalAnswer: finalAnswer.trim(),
    keyFindings: [],
    sources: sources.slice(0, 10),
  };
}
