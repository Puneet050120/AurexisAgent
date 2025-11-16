import { Plan, Task, TaskResult, TaskStatus } from '../types/agent';
import { topologicalSort } from '../utils/topological-sort';
import { toolExecutors } from './tools';
import { getAgentCache, TASK_TTL_MS } from './cache-client';
import { extractCalculatorParams, extractStockSymbol, extractNumericValue } from './parameter-extractor';
function parseSearchResultsForEntities(searchResult: any, entityType: 'startup' | 'company' | 'funding' | 'any' = 'any'): string[] {
  const entities: string[] = [];
  
  if (!searchResult || typeof searchResult !== 'object') return entities;
  
  if (searchResult.summary) {
    const summary = searchResult.summary;
    const numberedMatches = summary.match(/(?:^|\n)\s*\d+[\.\)]\s*([A-Z][A-Za-z0-9\s&]+(?:\.|:|$))/gm);
    if (numberedMatches) {
      numberedMatches.forEach((match: string) => {
        const entity = match.replace(/^\s*\d+[\.\)]\s*/, '').trim().replace(/[\.:]+$/, '').trim();
        if (entity.length > 2 && entity.length < 100) {
          entities.push(entity);
        }
      });
    }
    const bulletMatches = summary.match(/(?:^|\n)\s*[-•*]\s*([A-Z][A-Za-z0-9\s&]+(?:\.|:|$))/gm);
    if (bulletMatches) {
      bulletMatches.forEach((match: string) => {
        const entity = match.replace(/^\s*[-•*]\s*/, '').trim().replace(/[\.:]+$/, '').trim();
        if (entity.length > 2 && entity.length < 100) {
          entities.push(entity);
        }
      });
    }
    const nameMatches = summary.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g);
    if (nameMatches && entities.length < 5) {
      nameMatches.forEach((match: string) => {
        if (match.length > 3 && match.length < 50 && !match.match(/^(The|A|An|This|That|They|Their|We|Our|In|On|At|For|With|From|To|And|Or|But|Is|Are|Was|Were|Has|Have|Had|Will|Would|Should|Could|May|Might|Can|Must)$/i)) {
          if (!entities.includes(match)) {
            entities.push(match);
          }
        }
      });
    }
  }
  
  if (searchResult.results && Array.isArray(searchResult.results)) {
    searchResult.results.forEach((r: any) => {
      if (r.title) {
        const titleNames = r.title.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:\s*[-–]|\s*:|\s*$)/);
        if (titleNames && titleNames[1] && !entities.includes(titleNames[1])) {
          entities.push(titleNames[1]);
        }
      }
      if (r.content && entities.length < 10) {
        const contentNames = r.content.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/);
        if (contentNames && contentNames[1] && !entities.includes(contentNames[1])) {
          entities.push(contentNames[1]);
        }
      }
    });
  }
  
  return Array.from(new Set(entities)).slice(0, 10);
}

function replacePlaceholders(description: string, dependencies: Map<string, TaskResult>, taskMap?: Map<string, Task>): string {
  let result = description;
  const placeholderMatches = result.match(/\[(?:Startup|Company|Entity|Item)\s*(\d+)\]/gi);
  if (placeholderMatches) {
    for (const [depId, depResult] of dependencies.entries()) {
      if (depResult.status === 'completed' && depResult.result) {
        const entities = parseSearchResultsForEntities(depResult.result);
        if (entities.length > 0) {
          placeholderMatches.forEach((match: string) => {
            const numMatch = match.match(/\d+/);
            if (numMatch) {
              const index = parseInt(numMatch[0]) - 1;
              if (entities[index]) {
                result = result.replace(match, entities[index]);
              }
            }
          });
          break;
        }
      }
    }
  }
  const valuePlaceholderMatches = result.match(/\[(temperature|price|funding|amount|value|result)\]/gi);
  if (valuePlaceholderMatches) {
    for (const [depId, depResult] of dependencies.entries()) {
      if (depResult.status === 'completed' && depResult.result) {
        const numValue = extractNumericValue(depResult.result);
        if (numValue !== null) {
          valuePlaceholderMatches.forEach((match: string) => {
            result = result.replace(match, String(numValue));
          });
          break;
        }
      }
    }
  }
  return result;
}

export async function executeTask(
  task: Task,
  dependencies: Map<string, TaskResult>,
  taskMap?: Map<string, Task>,
  onUpdate?: (update: { taskId: string; status: TaskStatus; result?: any; error?: string }) => void
): Promise<TaskResult> {
  const startTime = new Date();
  
  console.log(`\n[EXECUTOR] 🚀 Starting Task: ${task.id}`);
  console.log(`[EXECUTOR] 📋 Description: ${task.description}`);
  console.log(`[EXECUTOR] 🔧 Tool: ${task.tool}`);
  console.log(`[EXECUTOR] 📌 Dependencies: ${task.dependencies.length > 0 ? task.dependencies.join(', ') : 'None'}`);
  
  try {
    const toolExecutor = toolExecutors[task.tool];
    if (!toolExecutor) {
      throw new Error(`Unknown tool: ${task.tool}. Available tools: ${Object.keys(toolExecutors).join(', ')}`);
    }

    let params: Record<string, any> = task.parameters ? { ...task.parameters } : {};
    
    const depResults = new Map<string, any>();
    for (const depId of task.dependencies) {
      const depResult = dependencies.get(depId);
      if (depResult?.status === 'completed' && depResult.result) {
        depResults.set(depId, { result: depResult.result });
      }
    }
    
    if (task.dependencies.length > 0) {
      console.log(`[EXECUTOR] 🔗 Processing ${task.dependencies.length} dependency/dependencies...`);
      
      for (const depId of task.dependencies) {
        const depResult = dependencies.get(depId);
        if (!depResult || depResult.status !== 'completed') {
          console.warn(`[EXECUTOR] ⚠️  Dependency ${depId} not completed or not found`);
          continue;
        }
        
        console.log(`[EXECUTOR] ✅ Using result from dependency: ${depId}`);
        const depData = depResult.result;
        
        if (task.tool === 'web_search' && !params.query) {
          if (depData?.data?.city && depData.data.temperature !== undefined) {
            const { city, temperature, description } = depData.data;
            const baseQuery = task.description.match(/search for:\s*(.+)/i)?.[1] || 
                             task.description.replace(/search for:/i, '').trim() ||
                             task.description;
            params.query = `${baseQuery} in ${city} ${temperature}°C ${description}`;
            console.log(`[EXECUTOR] 🌐 Enhanced search query with weather context from ${depId}: "${params.query}"`);
          } else if (depData?.data?.symbol) {
            params.query = `${task.description.replace(/search for:/i, '').trim()} ${depData.data.symbol}`;
            console.log(`[EXECUTOR] 🌐 Enhanced search query with stock symbol from ${depId}`);
          } else if (depData?.query || depData?.summary || depData?.results) {
            const entities = parseSearchResultsForEntities(depData);
            const descLower = task.description.toLowerCase();
            const placeholderMatch = task.description.match(/\[(?:Startup|Company|Entity|Item)\s*(\d+)\]/i);
            
            if (placeholderMatch) {
              const index = parseInt(placeholderMatch[1]) - 1;
              if (entities[index]) {
                const entity = entities[index];
                const baseQuery = task.description.match(/search for:\s*(.+)/i)?.[1] || 
                                 task.description.replace(/search for:/i, '').trim();
                params.query = baseQuery.replace(/\[(?:Startup|Company|Entity|Item)\s*\d+\]/gi, entity);
                console.log(`[EXECUTOR] 🌐 Extracted entity "${entity}" from ${depId} and created query: "${params.query}"`);
              } else if (entities.length > 0) {
                const entity = entities[0];
                const baseQuery = task.description.match(/search for:\s*(.+)/i)?.[1] || 
                                 task.description.replace(/search for:/i, '').trim();
                params.query = baseQuery.replace(/\[(?:Startup|Company|Entity|Item)\s*\d+\]/gi, entity);
                console.log(`[EXECUTOR] 🌐 Using first entity "${entity}" from ${depId}: "${params.query}"`);
              }
            } else if (descLower.includes('funding') && entities.length > 0) {
              const entity = entities[0];
              const baseQuery = task.description.match(/search for:\s*(.+)/i)?.[1] || 
                               task.description.replace(/search for:/i, '').trim();
              params.query = `${baseQuery} ${entity}`;
              console.log(`[EXECUTOR] 🌐 Extracted entity "${entity}" from ${depId} for funding query: "${params.query}"`);
            } else if ((descLower.includes('imdb') || descLower.includes('rating')) && entities.length > 0) {
              const entity = entities[0];
              params.query = `IMDb rating ${entity}`;
              console.log(`[EXECUTOR] 🎬 Built IMDb rating query from dependency entity "${entity}"`);
            } else if (entities.length > 0 && descLower.includes('for')) {
              const entity = entities[0];
              const baseQuery = task.description.match(/search for:\s*(.+)/i)?.[1] || 
                               task.description.replace(/search for:/i, '').trim();
              params.query = baseQuery.replace(/\[.*?\]/g, entity);
              console.log(`[EXECUTOR] 🌐 Extracted entity "${entity}" from ${depId}: "${params.query}"`);
            }
            
            if (!params.query && depData?.summary) {
              const num = extractNumericValue(depData) ?? null;
              const base = task.description
                .replace(/^search\s+for\s*/i, '')
                .replace(/^[^:]+:\s*/i, '')
                .trim();
              if (/favorable|suggest|good time|should i/i.test(base) && num !== null) {
                params.query = `Is it a good time to convert INR to USD at ~${num} INR per USD?`;
              } else {
                params.query = base || (depData.summary as string).slice(0, 120);
              }
              console.log(`[EXECUTOR] 🌐 Built follow-up query from dependency summary: "${params.query}"`);
            }
          }
        } else if (task.tool === 'calculator' && !params.expression) {
          // Check if this is a "generate/list numbers" task
          const descLower = task.description.toLowerCase();
          if (descLower.includes('generate') || descLower.includes('list') || descLower.includes('get') || descLower.includes('extract')) {
            const nMatch = task.description.match(/(\d+)\s*(?:whole|natural|consecutive)?\s*numbers?/i);
            if (nMatch) {
              const n = parseInt(nMatch[1]);
              if (n > 0 && n <= 100) {
                // Generate the list of numbers as a sum (this is just to "generate" them, the actual sum is in task-2)
                const numbers: number[] = [];
                for (let i = 1; i <= n; i++) {
                  numbers.push(i);
                }
                params.expression = numbers.join('+');
                console.log(`[EXECUTOR] 🔢 Generated numbers list expression: "${params.expression}" (for numbers 1 to ${n})`);
              }
            }
          }
          
          if (!params.expression) {
            const expression = extractCalculatorParams(task.description, depResults);
            if (expression) {
              params.expression = expression;
              console.log(`[EXECUTOR] 🧮 Generated expression: "${params.expression}"`);
            } else {
              // Try to extract IMDb ratings from dependency web_search results and build Math.max
              for (const [depId, depResult] of dependencies.entries()) {
                if (depResult.status === 'completed' && depResult.result && depResult.result.results) {
                  const items: any[] = depResult.result.results;
                  const ratings: number[] = [];
                  items.forEach((it: any) => {
                    const text = `${it.title || ''} ${it.content || ''}`;
                    const m = text.match(/(\d\.\d)\s*\/\s*10|\bIMDB[:\s-]*([0-9]\.[0-9])\b/i);
                    const val = m ? parseFloat(m[1] || m[2]) : NaN;
                    if (!isNaN(val)) ratings.push(val);
                  });
                  if (ratings.length > 0) {
                    params.expression = `Math.max(${ratings.join(', ')})`;
                    console.log(`[EXECUTOR] 🎬 Extracted IMDb ratings and built expression: "${params.expression}"`);
                    break;
                  }
                }
              }
            }
          }
        } else if (task.tool === 'api' && !params.endpoint) {
          if (depData?.data?.city) {
            params.endpoint = 'weather';
            let cityName = depData.data.city;
            cityName = cityName.replace(/\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week)$/i, '').trim();
            params.params = { city: cityName };
            console.log(`[EXECUTOR] 🌤️  Using city from dependency ${depId}: ${params.params.city}`);
          }
        } else if (task.tool === 'stock' && !params.symbol) {
          if (depData?.symbol) {
            params.symbol = depData.symbol;
            console.log(`[EXECUTOR] 📈 Using symbol from dependency ${depId}: ${depData.symbol}`);
          } else if (depData?.data?.symbol) {
            params.symbol = depData.data.symbol;
            console.log(`[EXECUTOR] 📈 Using symbol from dependency ${depId} data: ${depData.data.symbol}`);
          }
        }
      }
    }
    
    if (task.tool === 'web_search' && !params.query) {
      const processedDescription = replacePlaceholders(task.description, dependencies, taskMap);
      let q = processedDescription;
      const colonMatch = processedDescription.match(/search for:\s*(.+)/i);
      if (colonMatch) {
        q = colonMatch[1];
      } else {
        q = processedDescription.replace(/^search\s+for\s+/i, '');
      }
      q = q.replace(/^['"]+|['"]+$/g, '').trim();
      params.query = q.length > 0 ? q : processedDescription.trim();
      
      // Replace placeholders from dependencies
      if (params.query.includes('[') && params.query.includes(']')) {
        for (const [depId, depResult] of dependencies.entries()) {
          if (depResult.status === 'completed' && depResult.result) {
            const depData: any = depResult.result;
            const depTask = taskMap?.get(depId);
            
            // Replace calculator result placeholders (temp_f, temp_c, result, value)
            // Calculator results have a 'result' property with the calculated value
            // Check for calculator results: has 'result' property but no 'data' property
            if (depData && typeof depData === 'object' && depData.result !== undefined && !depData.data) {
              const calcResult = typeof depData.result === 'number' 
                ? (depData.result % 1 === 0 ? depData.result.toString() : depData.result.toFixed(1))
                : String(depData.result);
              
              // Check if this is a temperature conversion based on dependency task description
              if (depTask) {
                const depTaskDesc = depTask.description.toLowerCase();
                if (depTaskDesc.includes('fahrenheit') || depTaskDesc.includes('temp') || depTaskDesc.includes('convert')) {
                  params.query = params.query.replace(/\[temp_f\]/gi, calcResult);
                  params.query = params.query.replace(/\[fahrenheit\]/gi, calcResult);
                }
                if (depTaskDesc.includes('celsius')) {
                  params.query = params.query.replace(/\[temp_c\]/gi, calcResult);
                }
                // Also replace [temp] if it's a temperature-related calculation
                if (depTaskDesc.includes('temp') || depTaskDesc.includes('temperature')) {
                  params.query = params.query.replace(/\[temp\]/gi, calcResult);
                }
              }
              
              // Generic result placeholders (replace regardless of description)
              params.query = params.query.replace(/\[result\]/gi, calcResult);
              params.query = params.query.replace(/\[value\]/gi, calcResult);
              params.query = params.query.replace(/\[calc_result\]/gi, calcResult);
            }
            
            // Replace weather data placeholders (weather API results have a 'data' property)
            if (depData && typeof depData === 'object' && 'data' in depData && depData.data?.temperature !== undefined) {
              const tempC = depData.data.temperature;
              params.query = params.query.replace(/\[temp_c\]/gi, tempC.toString());
              params.query = params.query.replace(/\[temp\]/gi, tempC.toString());
            }
            if (depData?.data?.temperatureF !== undefined) {
              params.query = params.query.replace(/\[temp_f\]/gi, depData.data.temperatureF.toString());
            }
            
            // Replace entity placeholders from search results
            const entities = parseSearchResultsForEntities(depData);
            if (entities.length > 0) {
              const placeholderMatch = params.query.match(/\[(?:Startup|Company|Entity|Item)\s*(\d+)\]/i);
              if (placeholderMatch) {
                const index = parseInt(placeholderMatch[1]) - 1;
                if (entities[index]) {
                  params.query = params.query.replace(/\[(?:Startup|Company|Entity|Item)\s*\d+\]/gi, entities[index]);
                }
              } else {
                // Only replace generic placeholders if no calculator/weather placeholders were found
                if (!params.query.match(/\[(?:temp|result|value|calc_result)\]/i)) {
                  params.query = params.query.replace(/\[.*?\]/g, entities[0]);
                }
              }
            }
          }
        }
      }
      
      console.log(`[EXECUTOR] 🌐 Extracted query from description: "${params.query}"`);
    } else if (task.tool === 'api' && !params.endpoint) {
      params.endpoint = 'weather';
      let cityMatch = task.description.match(/weather (?:for|in):\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/i) ||
                       task.description.match(/in\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/i) ||
                       task.description.match(/for\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/i);
      
      if (cityMatch) {
        let cityName = cityMatch[1].trim();
        cityName = cityName.replace(/\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week)$/i, '').trim();
        params.params = { city: cityName };
        console.log(`[EXECUTOR] 🌤️  Extracted city: ${params.params.city}`);
      }
    } else if (task.tool === 'calculator' && !params.expression) {
      // Check if this is a "generate/list numbers" task
      const descLower = task.description.toLowerCase();
      if (descLower.includes('generate') || descLower.includes('list') || descLower.includes('get') || descLower.includes('extract')) {
        const nMatch = task.description.match(/(\d+)\s*(?:whole|natural|consecutive|even|odd)?\s*numbers?/i);
        if (nMatch) {
          const n = parseInt(nMatch[1]);
          if (n > 0 && n <= 100) {
            // Generate the list of numbers based on type
            const numbers: number[] = [];
            if (descLower.includes('even')) {
              // Even numbers: 2, 4, 6, 8, ...
              for (let i = 1; i <= n; i++) {
                numbers.push(i * 2);
              }
              params.expression = numbers.join('+');
              console.log(`[EXECUTOR] 🔢 Generated even numbers list expression: "${params.expression}" (for first ${n} even numbers)`);
            } else if (descLower.includes('odd')) {
              // Odd numbers: 1, 3, 5, 7, ...
              for (let i = 0; i < n; i++) {
                numbers.push(i * 2 + 1);
              }
              params.expression = numbers.join('+');
              console.log(`[EXECUTOR] 🔢 Generated odd numbers list expression: "${params.expression}" (for first ${n} odd numbers)`);
            } else {
              // Whole numbers: 1, 2, 3, 4, ...
              for (let i = 1; i <= n; i++) {
                numbers.push(i);
              }
              params.expression = numbers.join('+');
              console.log(`[EXECUTOR] 🔢 Generated numbers list expression: "${params.expression}" (for numbers 1 to ${n})`);
            }
          }
        }
      }
      
      // Check if this is a sum task that depends on a "generate numbers" task
      if (!params.expression && (descLower.includes('sum') || descLower.includes('add'))) {
        for (const [depId, depResult] of dependencies.entries()) {
          if (depResult.status === 'completed' && depResult.result) {
            const depData = depResult.result;
            const depTask = taskMap?.get(depId);
            
            if (depTask) {
              const depDesc = depTask.description.toLowerCase();
              
              // If dependency was a "generate numbers" task, extract numbers from it
              if (depDesc.includes('generate') || depDesc.includes('list') || depDesc.includes('get')) {
                const nMatch = depTask.description.match(/(\d+)\s*(?:whole|natural|consecutive|even|odd)?\s*numbers?/i);
                if (nMatch) {
                  const n = parseInt(nMatch[1]);
                  if (n > 0 && n <= 100) {
                    const numbers: number[] = [];
                    if (depDesc.includes('even')) {
                      // Even numbers: 2, 4, 6, 8, ...
                      for (let i = 1; i <= n; i++) {
                        numbers.push(i * 2);
                      }
                    } else if (depDesc.includes('odd')) {
                      // Odd numbers: 1, 3, 5, 7, ...
                      for (let i = 0; i < n; i++) {
                        numbers.push(i * 2 + 1);
                      }
                    } else {
                      // Whole numbers: 1, 2, 3, 4, ...
                      for (let i = 1; i <= n; i++) {
                        numbers.push(i);
                      }
                    }
                    params.expression = numbers.join('+');
                    console.log(`[EXECUTOR] 🔢 Extracted numbers from dependency ${depId}: "${params.expression}"`);
                    break;
                  }
                }
              }
            }
          }
        }
      }
      
      if (!params.expression) {
        const expression = extractCalculatorParams(task.description, depResults);
        if (expression) {
          params.expression = expression;
          console.log(`[EXECUTOR] 🧮 Extracted expression: "${params.expression}"`);
        }
      }
    } else if (task.tool === 'stock' && !params.symbol) {
      const symbol = extractStockSymbol(task.description);
      if (symbol) params.symbol = symbol;
    }
    if (task.tool === 'web_search' && !params.query) {
      throw new Error(`Web search task requires a query. Task: "${task.description}"`);
    }
    if (task.tool === 'api' && (!params.endpoint || !params.params?.city)) {
      throw new Error(`Weather API task requires a city. Task: "${task.description}"`);
    }
    if (task.tool === 'calculator' && !params.expression) {
      throw new Error(`Calculator task requires an expression. Task: "${task.description}"`);
    }
    if (task.tool === 'stock' && !params.symbol) {
      throw new Error(`Stock task requires a symbol. Task: "${task.description}"`);
    }

    console.log(`[EXECUTOR] ⚙️  Executing ${task.tool} with params:`, JSON.stringify(params, null, 2));

    // Agent-standard cache: check as early as possible using stable key parts
    const cache = getAgentCache();
    const keyParts: Record<string, any> = { 
      tool: task.tool, 
      description: task.description.trim()
    };
    // Only include the minimal stable param(s) that determine uniqueness
    if (task.tool === 'web_search' && params.query) keyParts.query = params.query;
    if (task.tool === 'api' && params.endpoint) {
      keyParts.endpoint = params.endpoint;
      if (params.params?.city) keyParts.city = params.params.city;
    }
    if (task.tool === 'calculator' && params.expression) keyParts.expression = params.expression;
    if (task.tool === 'stock' && params.symbol) keyParts.symbol = String(params.symbol).toUpperCase();
    const cacheKey = cache.generateKey(keyParts);
    const cached = await cache.get(cacheKey);
    if (cached?.result) {
      console.log(`[EXECUTOR] ✅ Using cached result for ${task.id}`);
      return {
        taskId: task.id,
        status: 'completed',
        result: cached.result,
        startedAt: startTime,
        completedAt: new Date(),
      };
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await toolExecutor(params);
        await cache.set(cacheKey, result, TASK_TTL_MS);
        console.log(`[EXECUTOR] ✅ Task ${task.id} completed successfully`);
        console.log(`[EXECUTOR] 📊 Result preview:`, JSON.stringify(result).substring(0, 150));
        return {
          taskId: task.id,
          status: 'completed',
          result,
          startedAt: startTime,
          completedAt: new Date(),
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < 2) {
          console.warn(`[EXECUTOR] ⚠️  Task ${task.id} attempt ${attempt + 1} failed, retrying...`);
          onUpdate?.({
            taskId: task.id,
            status: 'running',
            error: `Retrying... (attempt ${attempt + 2}/3)`,
          });
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
      }
    }
    
    // All retries failed
    const errorMessage = lastError instanceof Error ? lastError.message : 'Unknown error';
    console.error(`[EXECUTOR] ❌ Task ${task.id} failed after 3 attempts: ${errorMessage}`);
    
    return {
      taskId: task.id,
      status: 'failed',
      error: errorMessage,
      startedAt: startTime,
      completedAt: new Date(),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[EXECUTOR] ❌ Task ${task.id} failed: ${errorMessage}`);
    
    return {
      taskId: task.id,
      status: 'failed',
      error: errorMessage,
      startedAt: startTime,
      completedAt: new Date(),
    };
  }
}

export async function executePlan(
  plan: Plan,
  onUpdate?: (update: { taskId: string; status: TaskStatus; result?: any; error?: string }) => void
): Promise<Map<string, TaskResult>> {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🎯 EXECUTION PLAN STARTED');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`📋 Goal: ${plan.goal}`);
  console.log(`📊 Total Tasks: ${plan.tasks.length}`);
  console.log('\n📝 PLANNED TASKS:');
  plan.tasks.forEach((task, idx) => {
    console.log(`  ${idx + 1}. [${task.id}] ${task.description}`);
    console.log(`     Tool: ${task.tool} | Dependencies: ${task.dependencies.length > 0 ? task.dependencies.join(', ') : 'None'}`);
  });
  
  const results = new Map<string, TaskResult>();
  const completedTaskIds = new Set<string>();
  const failedTaskIds = new Set<string>();
  const taskMap = new Map<string, Task>(plan.tasks.map((t) => [t.id, t]));
  console.log('\n🔄 Computing execution order using DAG...');
  let sortedTasks: Task[];
  try {
    sortedTasks = topologicalSort(plan.tasks);
    console.log(`✅ Execution order determined: ${sortedTasks.map(t => t.id).join(' → ')}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown topological sort error';
    console.error(`❌ Topological sort error: ${errorMessage}`);
    if (errorMessage.includes('Circular dependency')) {
      console.warn('⚠️  Circular dependency detected. Using fallback order (by task ID).');
      sortedTasks = [...plan.tasks].sort((a, b) => {
        const aNum = parseInt(a.id.match(/\d+/)?.[0] || '0');
        const bNum = parseInt(b.id.match(/\d+/)?.[0] || '0');
        return aNum - bNum;
      });
    } else {
      sortedTasks = plan.tasks;
    }
  }
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🚀 EXECUTING TASKS');
  console.log('═══════════════════════════════════════════════════════════');

  // Parallel DAG execution with bounded concurrency
  const MAX_CONCURRENCY = 3;
  const inProgress = new Set<string>();
  const depCount = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  // Initialize dependency counts and dependents map
  for (const task of sortedTasks) {
    depCount.set(task.id, task.dependencies.length);
    for (const dep of task.dependencies) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(task.id);
    }
  }

  const readyQueue: string[] = sortedTasks
    .filter((t) => (depCount.get(t.id) || 0) === 0)
    .map((t) => t.id);

  const startNext = async (): Promise<void> => {
    while (inProgress.size < MAX_CONCURRENCY && readyQueue.length > 0) {
      const nextId = readyQueue.shift()!;
      // Skip if already completed/failed
      if (completedTaskIds.has(nextId) || failedTaskIds.has(nextId) || inProgress.has(nextId)) continue;
      const task = taskMap.get(nextId);
      if (!task) continue;

      // Double-check dependencies state
      const depsMet = task.dependencies.every((depId) => completedTaskIds.has(depId) && !failedTaskIds.has(depId));
      if (!depsMet) {
        const failedDeps = task.dependencies.filter((depId) => failedTaskIds.has(depId));
        if (failedDeps.length > 0) {
          console.warn(`⏭️  Skipping ${task.id}: Dependencies failed: ${failedDeps.join(', ')}`);
          results.set(task.id, {
            taskId: task.id,
            status: 'skipped',
            error: `Dependencies failed: ${failedDeps.join(', ')}`,
            startedAt: new Date(),
            completedAt: new Date(),
          });
          onUpdate?.({ taskId: task.id, status: 'skipped', error: `Cannot execute: dependencies ${failedDeps.join(', ')} failed` });
          // No need to enqueue its dependents; they will detect failure through depCount and failedTaskIds
          continue;
        }
        // If not failed but not met, it will be re-enqueued once deps complete
        continue;
      }

      inProgress.add(nextId);
      onUpdate?.({ taskId: task.id, status: 'running' });

      // Execute without blocking; handle completion to update queues
      (async () => {
        try {
          const result = await executeTask(task, results, taskMap, onUpdate);
          results.set(task.id, result);
          onUpdate?.({ taskId: task.id, status: result.status, result: result.result, error: result.error });

          if (result.status === 'completed') {
            completedTaskIds.add(task.id);
            console.log(`✅ Task ${task.id} completed and added to completed set`);
            // Decrement dependency counts of dependents and enqueue newly ready tasks
            const deps = dependents.get(task.id) || [];
            for (const depTaskId of deps) {
              const remaining = (depCount.get(depTaskId) || 0) - 1;
              depCount.set(depTaskId, remaining);
              if (remaining === 0) {
                readyQueue.push(depTaskId);
              }
            }
          } else if (result.status === 'failed') {
            failedTaskIds.add(task.id);
            console.log(`❌ Task ${task.id} failed and added to failed set`);
            // Propagate skip to downstream dependents (they will detect failure)
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unexpected error during execution';
          console.error(`❌ Unexpected error executing ${task.id}: ${errorMessage}`);
          const errorResult: TaskResult = { taskId: task.id, status: 'failed', error: errorMessage, startedAt: new Date(), completedAt: new Date() };
          results.set(task.id, errorResult);
          failedTaskIds.add(task.id);
          onUpdate?.({ taskId: task.id, status: 'failed', error: errorMessage });
        } finally {
          inProgress.delete(nextId);
          // Do not recursively call startNext here; the outer loop drives scheduling
        }
      })();
    }
  };

  // Kick off initial wave
  await startNext();
  // Wait for all in-progress tasks to finish
  while (inProgress.size > 0 || readyQueue.length > 0) {
    await startNext();
    await new Promise((r) => setTimeout(r, 25));
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('📊 EXECUTION SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`✅ Completed: ${completedTaskIds.size}`);
  console.log(`❌ Failed: ${failedTaskIds.size}`);
  console.log(`⏭️  Skipped: ${results.size - completedTaskIds.size - failedTaskIds.size}`);
  console.log(`📈 Success Rate: ${plan.tasks.length > 0 ? ((completedTaskIds.size / plan.tasks.length) * 100).toFixed(1) : 0}%`);
  console.log('═══════════════════════════════════════════════════════════\n');

  return results;
}
