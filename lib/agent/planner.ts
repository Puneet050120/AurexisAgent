import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { Plan, Task } from '../types/agent';

const openrouter = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || '',
  baseURL: 'https://openrouter.ai/api/v1',
});

const taskSchema = z.object({
  id: z.string()
    .regex(/^task-\d+$/, 'Task ID must be in format task-1, task-2, etc.')
    .describe('Unique task identifier in format task-1, task-2, task-3, etc.'),
  description: z.string()
    .min(10, 'Description must be at least 10 characters')
    .describe('Clear description with all necessary details. For web_search: include exact query. For api: include city. For calculator: include expression. For stock: include symbol.'),
  tool: z.enum(['web_search', 'api', 'calculator', 'stock']).describe('Tool needed: web_search for queries, api for weather, calculator for math, stock for stock data'),
  dependencies: z.array(z.string())
    .refine((deps) => deps.every(dep => /^task-\d+$/.test(dep)), {
      message: 'All dependencies must be in format task-1, task-2, etc.',
    })
    .describe('Array of task IDs this task depends on (empty if no dependencies). CRITICAL: Only depend on tasks with lower IDs (task-2 can depend on task-1, not vice versa)'),
});

const planSchema = z.object({
  tasks: z.array(taskSchema).describe('Array of tasks to execute in DAG order'),
});

export async function generatePlan(userGoal: string): Promise<Plan> {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🧠 PLANNING PHASE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`📝 User Goal: "${userGoal}"`);
  console.log('🤔 Analyzing goal and generating execution plan...\n');

  const prompt = `Plan tasks (DAG) to solve the goal with these tools:

Goal: "${userGoal}"

Tools:
- web_search (research)
- api (weather)
- calculator (math on known numbers)
- stock (current stock data)

Rules (short):
- Research/compare → start with web_search. Only then use calculator on numbers found.
- Weather → api first; if needed, calculator for conversion; optional web_search for activities.
- Stock → use symbols (AAPL, MSFT, etc.). For CAGR: current price + historical via web_search → calculator.
- IDs: task-1, task-2, ... Dependencies only to lower IDs. No self-deps.
- Descriptions must be clear and include exact query/expression/symbol/city.
- Use placeholders [Startup N] only when depending on a prior web_search.

Return:
{
  "tasks": [
    { "id": "task-1", "description": "Search for: ...", "tool": "web_search", "dependencies": [] },
    { "id": "task-2", "description": "Calculate: ...", "tool": "calculator", "dependencies": ["task-1"] }
  ]
}`;

  // Cache check will be done client-side via API
  // Server-side planning will always generate fresh plans for consistency
  const maxRetries = 0;
  const maxPlanningTime = 8000; // 8 seconds timeout
  const startTime = Date.now();
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check timeout
    if (Date.now() - startTime > maxPlanningTime) {
      console.warn('⚠️  Planning timeout reached. Using fallback plan.');
      break;
    }

    try {
      const retryPrompt = attempt > 0 
          ? `${prompt}\n\n⚠️ CRITICAL ERROR: You previously generated INVALID tasks. You MUST fix these errors:\n\n1. Dependencies MUST be an array of task IDs ONLY, like: ["task-1", "task-2"]\n   ❌ WRONG: dependencies: ["tool"], ["calculator"], ["web_search"], ["api"], ["ul"], ["li"]\n   ✅ CORRECT: dependencies: ["task-1"], ["task-2"], or [] (empty array for no dependencies)\n\n2. Each description MUST be at least 10 characters long and meaningful\n   ❌ WRONG: "???", "...", "MAC...", "continue"\n   ✅ CORRECT: "Search for: top 5 AI startups funded in 2024"\n\n3. Task IDs MUST be exactly: "task-1", "task-2", "task-3" (lowercase "task-", hyphen, number)\n\n4. If a task has NO dependencies, use an empty array: []\n\n5. Dependencies can ONLY reference other tasks by their IDs (task-1, task-2, etc.)\n\n6. A task CANNOT depend on itself\n\n7. Dependencies must reference tasks with LOWER IDs (task-2 can depend on task-1, but task-1 CANNOT depend on task-2)\n\nCORRECT EXAMPLE:\n{\n  "tasks": [\n    {\n      "id": "task-1",\n      "description": "Search for: top 5 AI startups funded in 2024",\n      "tool": "web_search",\n      "dependencies": []\n    },\n    {\n      "id": "task-2",\n      "description": "Calculate: Math.max(100, 200, 300)",\n      "tool": "calculator",\n      "dependencies": ["task-1"]\n    }\n  ]\n}\n\nNow generate the plan with CORRECT dependencies format (task IDs only, not tool names):`
          : prompt;
      
      let object;
      try {
        const planPromise = generateObject({
          model: openrouter('openai/gpt-4o-mini'),
          schema: planSchema,
          prompt: retryPrompt,
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('planner-timeout')), Math.max(1000, maxPlanningTime - (Date.now() - startTime)));
        });
        const result = await Promise.race([planPromise, timeoutPromise]) as any;
        object = result.object;
      } catch (schemaError: any) {
        // If schema validation fails, check if we can still extract tasks
        if (schemaError?.cause?.issues || schemaError?.issues) {
          console.warn(`⚠️  Schema validation failed on attempt ${attempt + 1}. Will try fallback if all retries exhausted.`);
          throw schemaError;
        }
        throw schemaError;
      }

      // Additional validation and sanitization
      let tasks: Task[] = object.tasks
      .map((task, index) => {
        // Ensure task ID follows correct format
        let taskId = task.id.trim();
        if (!/^task-\d+$/.test(taskId)) {
          // If invalid, generate correct ID
          taskId = `task-${index + 1}`;
          console.warn(`⚠️  Invalid task ID "${task.id}" replaced with "${taskId}"`);
        }
        
        // Ensure description is valid
        let description = task.description.trim();
        
        // Check for obviously malformed descriptions (quotes, weird patterns, too short)
        const isMalformed = description.length < 10 || 
                           description === '...' || 
                           description === 'MAC...' || 
                           description === 'continue' || 
                           description.length < 5 ||
                           /^[^a-zA-Z0-9]+$/.test(description) || // Only special characters
                           (description.match(/"/g) || []).length > 2 || // Too many quotes
                           /Generate\s*"[^"]*"\s*first/i.test(description) || // Pattern like "Generate "a " first"
                           description.split(' ').length < 3; // Less than 3 words
        
        if (isMalformed) {
          // Try to generate a meaningful description from the tool and goal
          const goalLower = userGoal.toLowerCase();
          if (task.tool === 'api' && goalLower.includes('weather')) {
            const cityMatch = userGoal.match(/weather (?:for|in|in\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/i) ||
                             userGoal.match(/in\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/i) ||
                             userGoal.match(/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/);
            if (cityMatch) {
              let cityName = cityMatch[1].trim();
              cityName = cityName.replace(/\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week)$/i, '').trim();
              description = `Get weather for: ${cityName}`;
            } else {
              description = 'Get weather information';
            }
          } else if (task.tool === 'web_search') {
            description = `Search for: ${userGoal.substring(0, 100)}`;
          } else if (task.tool === 'calculator' && (goalLower.includes('research') || goalLower.includes('find') || goalLower.includes('search') || goalLower.includes('compare'))) {
            console.warn(`⚠️  Invalid tool selection: calculator used for research/query task. Converting to web_search.`);
            description = `Search for: ${userGoal.substring(0, 100)}`;
            task.tool = 'web_search';
          } else if (task.tool === 'calculator') {
            // Handle sum queries specially
            if (goalLower.includes('sum') && goalLower.includes('even')) {
              const nMatch = userGoal.match(/(\d+)\s*even/i);
              const n = nMatch ? nMatch[1] : '10';
              description = `Generate first ${n} even numbers: 2, 4, 6, 8, 10, ...`;
            } else if (goalLower.includes('sum') && goalLower.includes('odd')) {
              const nMatch = userGoal.match(/(\d+)\s*odd/i);
              const n = nMatch ? nMatch[1] : '10';
              description = `Generate first ${n} odd numbers: 1, 3, 5, 7, 9, ...`;
            } else if (goalLower.includes('sum') && goalLower.includes('first')) {
              const nMatch = userGoal.match(/first\s+(\d+)/i);
              const n = nMatch ? nMatch[1] : '10';
              description = `Generate first ${n} whole numbers: 1, 2, 3, 4, 5, ...`;
            } else {
              description = `Calculate: ${userGoal.substring(0, 80)}`;
            }
          } else if (task.tool === 'stock') {
            description = `Get stock data for requested symbol`;
          } else {
            description = `Execute ${task.tool} for: ${userGoal.substring(0, 80)}`;
          }
          console.warn(`⚠️  Invalid/malformed description for task ${taskId}, generated: "${description}"`);
        }
        
        // Validate and sanitize dependencies - CRITICAL: filter out invalid values
        const validDependencies = (task.dependencies || [])
          .filter((dep: any) => {
            // Reject non-string values
            if (typeof dep !== 'string') {
              console.warn(`⚠️  Non-string dependency "${JSON.stringify(dep)}" removed from task ${taskId}`);
              return false;
            }
            const depTrimmed = dep.trim();
            // Reject anything that's not in task-* format (tool names, HTML tags, etc.)
            if (!/^task-\d+$/.test(depTrimmed)) {
              console.warn(`⚠️  Invalid dependency "${dep}" removed from task ${taskId} (must be task-1, task-2, etc., not "${dep}")`);
              return false;
            }
            // Remove self-dependencies (task depending on itself)
            if (depTrimmed === taskId) {
              console.warn(`⚠️  Self-dependency "${dep}" removed from task ${taskId} (task cannot depend on itself)`);
              return false;
            }
            return true;
          })
          .map((dep: string) => dep.trim());
        
        return {
          id: taskId,
          description,
          tool: task.tool,
          dependencies: validDependencies,
        };
      })
      .filter((task): task is Task => {
        // Final validation
        if (!task.id || !task.description || !task.tool) {
          console.error(`❌ Task missing required fields: ${JSON.stringify(task)}`);
          return false;
        }
        return true;
      });

    // Post-processing: Validate query type requirements
    const goalLower = userGoal.toLowerCase();
    const hasWeatherQuery = goalLower.includes('weather');
    const hasCalculatorForWeather = tasks.some(t => t.tool === 'calculator' && t.description.toLowerCase().includes('temp'));
    const hasWeatherAPI = tasks.some(t => t.tool === 'api');
    
    // If query mentions weather but no weather API task exists, add it
    if (hasWeatherQuery && !hasWeatherAPI) {
      console.warn('⚠️  Weather query detected but no weather API task found. Adding weather API task.');
      const cityMatch = userGoal.match(/weather (?:for|in|in\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/i) ||
                       userGoal.match(/in\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/i) ||
                       userGoal.match(/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/);
      let city = 'Tokyo';
      if (cityMatch) {
        city = cityMatch[1].trim();
        city = city.replace(/\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week)$/i, '').trim();
      }
      
      // Insert weather API task at the beginning
      const weatherTask: Task = {
        id: 'task-1',
        description: `Get weather for: ${city}`,
        tool: 'api',
        dependencies: [],
      };
      
      // Renumber existing tasks
      tasks = tasks.map((t, idx) => ({
        ...t,
        id: `task-${idx + 2}`,
        dependencies: t.dependencies.map(dep => {
          const depNum = parseInt(dep.match(/\d+/)?.[0] || '0');
          return `task-${depNum + 1}`;
        }),
      }));
      
      tasks.unshift(weatherTask);
      
      // Fix dependencies for calculator tasks that need weather data
      if (hasCalculatorForWeather) {
        tasks.forEach(t => {
          if (t.tool === 'calculator' && t.description.toLowerCase().includes('temp') && !t.dependencies.includes('task-1')) {
            t.dependencies = ['task-1', ...t.dependencies];
          }
        });
      }
    }

    // Convert inappropriate API tasks (non-weather) into web_search tasks, especially for movies/ratings
    const isMovieQuery = /movie|imdb|rating|film/i.test(userGoal);
    tasks = tasks.map((t, idx) => {
      if (t.tool === 'api' && !hasWeatherQuery) {
        const newDesc = isMovieQuery
          ? 'Search for: IMDb ratings for top movies [Item 1]'
          : `Search for: ${t.description.replace(/^Get\s*/i, '').trim()}`;
        return {
          ...t,
          tool: 'web_search',
          description: newDesc,
          dependencies: t.dependencies,
        };
      }
      return t;
    });

    // Validate task IDs are sequential and unique
    const taskIds = new Set<string>();
    for (let i = 0; i < tasks.length; i++) {
      const expectedId = `task-${i + 1}`;
      if (tasks[i].id !== expectedId) {
        tasks[i].id = expectedId;
        console.warn(`⚠️  Task ID corrected to ${expectedId}`);
      }
      if (taskIds.has(tasks[i].id)) {
        console.error(`❌ Duplicate task ID found: ${tasks[i].id}`);
        throw new Error(`Duplicate task ID: ${tasks[i].id}`);
      }
      taskIds.add(tasks[i].id);
    }
    
    // Re-validate dependencies after ID changes
    let validTaskIds = new Set(tasks.map(t => t.id));
    for (const task of tasks) {
      task.dependencies = task.dependencies.filter(dep => {
        if (!validTaskIds.has(dep)) {
          console.warn(`⚠️  Invalid dependency "${dep}" removed from task ${task.id} (referenced task doesn't exist after renumbering)`);
          return false;
        }
        return true;
      });
    }

    // Validate dependencies reference valid tasks and check for self-dependencies
    validTaskIds = new Set(tasks.map(t => t.id));
    for (const task of tasks) {
      // Remove self-dependencies (should already be filtered, but double-check)
      task.dependencies = task.dependencies.filter(dep => {
        if (dep === task.id) {
          console.warn(`⚠️  Self-dependency "${dep}" removed from task ${task.id} (task cannot depend on itself)`);
          return false;
        }
        if (!validTaskIds.has(dep)) {
          console.warn(`⚠️  Invalid dependency "${dep}" removed from task ${task.id} (referenced task doesn't exist)`);
          return false;
        }
        return true;
      });
    }
    
    // Final check: ensure no self-dependencies remain (should not happen, but safety check)
    for (const task of tasks) {
      if (task.dependencies.includes(task.id)) {
        console.error(`❌ CRITICAL: Task ${task.id} still has self-dependency after sanitization`);
        task.dependencies = task.dependencies.filter(d => d !== task.id);
      }
    }

      if (tasks.length === 0) {
        console.error('❌ No valid tasks generated from plan. Will try fallback.');
        throw new Error('No valid tasks generated from plan');
      }
      
      // Final validation: check if any task has invalid dependencies (not in task-* format)
      const invalidDeps = tasks.some(t => {
        const hasInvalid = t.dependencies.some(dep => {
          if (typeof dep !== 'string') return true;
          return !/^task-\d+$/.test(dep.trim());
        });
        if (hasInvalid) {
          console.error(`❌ Task ${t.id} has invalid dependencies: ${JSON.stringify(t.dependencies)}`);
        }
        return hasInvalid;
      });
      if (invalidDeps) {
        console.error('❌ Plan contains invalid dependencies (not in task-* format). Will try fallback.');
        throw new Error('Invalid dependencies in plan');
      }

      console.log(`✅ Plan generated with ${tasks.length} task(s)${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);
      console.log('\n📋 GENERATED PLAN:');
      tasks.forEach((task, idx) => {
        console.log(`  ${idx + 1}. [${task.id}] ${task.description}`);
        console.log(`     🔧 Tool: ${task.tool} | 📌 Dependencies: ${task.dependencies.length > 0 ? task.dependencies.join(', ') : 'None'}`);
      });
      console.log('═══════════════════════════════════════════════════════════\n');

      const finalPlan = { tasks, goal: userGoal };
      
      // Cache will be saved client-side after execution completes
      
      return finalPlan;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isZodError = error && typeof error === 'object' && ('issues' in error || 'cause' in error);
      const isSchemaError = error && typeof error === 'object' && (
        error instanceof Error && error.message.includes('schema') ||
        'cause' in error && typeof (error as any).cause === 'object' && 'issues' in (error as any).cause
      );
      
      // If it's a schema validation error and we've tried multiple times, use fallback sooner
      if (attempt >= 2 && (isZodError || isSchemaError)) {
        console.warn(`⚠️  Plan generation failed after ${attempt + 1} attempts. Using fallback plan.`);
        break; // Break to fallback plan generation
      }
      
      if (attempt < maxRetries && (isZodError || isSchemaError)) {
        console.warn(`⚠️  Plan generation attempt ${attempt + 1} failed validation. Retrying with stricter prompt...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      
      // If timeout reached or all retries failed, try to create a simple fallback plan
      if (Date.now() - startTime > maxPlanningTime || attempt === maxRetries || (attempt >= 2 && (isZodError || isSchemaError))) {
        console.warn('⚠️  All plan generation attempts failed. Creating simple fallback plan...');
        const fallbackTasks: Task[] = [];
        
        // Try to create a basic plan based on the goal
        const goalLower = userGoal.toLowerCase();
        
        if (goalLower.includes('weather')) {
          const cityMatch = userGoal.match(/weather (?:for|in|in\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/i) ||
                           userGoal.match(/in\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/i) ||
                           userGoal.match(/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/);
          let city = 'the requested city';
          if (cityMatch) {
            city = cityMatch[1].trim();
            city = city.replace(/\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week)$/i, '').trim();
          }
          fallbackTasks.push({
            id: 'task-1',
            description: `Get weather for: ${city}`,
            tool: 'api',
            dependencies: [],
          });
          
          if (goalLower.includes('fahrenheit') || goalLower.includes('convert')) {
            fallbackTasks.push({
              id: 'task-2',
              description: 'Calculate: temp * 9/5 + 32',
              tool: 'calculator',
              dependencies: ['task-1'],
            });
          }
          
          if (goalLower.includes('activity') || goalLower.includes('activities')) {
            fallbackTasks.push({
              id: fallbackTasks.length > 1 ? 'task-3' : 'task-2',
              description: `Search for: outdoor activities suitable for weather conditions`,
              tool: 'web_search',
              dependencies: fallbackTasks.length > 1 ? ['task-2'] : ['task-1'],
            });
          }
        } else if (goalLower.includes('stock') || goalLower.includes('share')) {
          // Simple stock query
          fallbackTasks.push({
            id: 'task-1',
            description: 'Get stock data for requested symbol',
            tool: 'stock',
            dependencies: [],
          });
        } else if (goalLower.includes('sum') || goalLower.includes('calculate') || goalLower.includes('math')) {
          // Handle sum queries with proper breakdown
          const goalLowerForSum = goalLower;
          if (goalLowerForSum.includes('sum') && (goalLowerForSum.includes('first') || goalLowerForSum.includes('even') || goalLowerForSum.includes('odd'))) {
            // Extract number
            const nMatch = userGoal.match(/first\s+(\d+)/i) || userGoal.match(/(\d+)\s*(?:even|odd|whole|natural)/i);
            const n = nMatch ? nMatch[1] : '10';
            
            if (goalLowerForSum.includes('even')) {
              fallbackTasks.push({
                id: 'task-1',
                description: `Generate first ${n} even numbers: 2, 4, 6, 8, ...`,
                tool: 'calculator',
                dependencies: [],
              });
              fallbackTasks.push({
                id: 'task-2',
                description: `Calculate: sum of first ${n} even numbers`,
                tool: 'calculator',
                dependencies: ['task-1'],
              });
            } else if (goalLowerForSum.includes('odd')) {
              fallbackTasks.push({
                id: 'task-1',
                description: `Generate first ${n} odd numbers: 1, 3, 5, 7, ...`,
                tool: 'calculator',
                dependencies: [],
              });
              fallbackTasks.push({
                id: 'task-2',
                description: `Calculate: sum of first ${n} odd numbers`,
                tool: 'calculator',
                dependencies: ['task-1'],
              });
            } else {
              fallbackTasks.push({
                id: 'task-1',
                description: `Generate first ${n} whole numbers: 1, 2, 3, 4, 5, ...`,
                tool: 'calculator',
                dependencies: [],
              });
              fallbackTasks.push({
                id: 'task-2',
                description: `Calculate: sum of first ${n} whole numbers`,
                tool: 'calculator',
                dependencies: ['task-1'],
              });
            }
          } else {
            // Simple math query
            fallbackTasks.push({
              id: 'task-1',
              description: `Calculate: ${userGoal}`,
              tool: 'calculator',
              dependencies: [],
            });
          }
        } else {
          // Generic web search
          fallbackTasks.push({
            id: 'task-1',
            description: `Search for: ${userGoal}`,
            tool: 'web_search',
            dependencies: [],
          });
        }
        
        if (fallbackTasks.length > 0) {
          console.log(`✅ Fallback plan generated with ${fallbackTasks.length} task(s)`);
          console.log('\n📋 FALLBACK PLAN:');
          fallbackTasks.forEach((task, idx) => {
            console.log(`  ${idx + 1}. [${task.id}] ${task.description}`);
            console.log(`     🔧 Tool: ${task.tool} | 📌 Dependencies: ${task.dependencies.length > 0 ? task.dependencies.join(', ') : 'None'}`);
          });
          console.log('═══════════════════════════════════════════════════════════\n');
          return { tasks: fallbackTasks, goal: userGoal };
        }
      }
    }
  }
  
  // If we get here, all attempts failed - try one final fallback
  console.warn('⚠️  All plan generation attempts failed. Attempting final fallback plan...');
  const goalLower = userGoal.toLowerCase();
  
  // Final fallback - create a simple plan
  if (goalLower.includes('weather')) {
    const cityMatch = userGoal.match(/weather (?:for|in|in\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/i) ||
                     userGoal.match(/in\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/i) ||
                     userGoal.match(/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*?)(?:\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week))?/);
    let city = 'Tokyo';
    if (cityMatch) {
      city = cityMatch[1].trim();
      city = city.replace(/\s+(?:tomorrow|today|yesterday|next\s+week|this\s+week)$/i, '').trim();
    }
    
    const fallbackTasks: Task[] = [{
      id: 'task-1',
      description: `Get weather for: ${city}`,
      tool: 'api',
      dependencies: [],
    }];
    
    if (goalLower.includes('fahrenheit') || goalLower.includes('convert')) {
      fallbackTasks.push({
        id: 'task-2',
        description: 'Calculate: temp * 9/5 + 32',
        tool: 'calculator',
        dependencies: ['task-1'],
      });
    }
    
    if (goalLower.includes('activity') || goalLower.includes('activities')) {
      fallbackTasks.push({
        id: fallbackTasks.length > 1 ? 'task-3' : 'task-2',
        description: `Search for: outdoor activities suitable for weather conditions`,
        tool: 'web_search',
        dependencies: fallbackTasks.length > 1 ? ['task-2'] : ['task-1'],
      });
    }
    
    console.log(`✅ Final fallback plan generated with ${fallbackTasks.length} task(s)`);
    return { tasks: fallbackTasks, goal: userGoal };
  } else if (goalLower.includes('research') || goalLower.includes('find') || goalLower.includes('search') || goalLower.includes('top')) {
    const fallbackTasks: Task[] = [{
      id: 'task-1',
      description: `Search for: ${userGoal}`,
      tool: 'web_search',
      dependencies: [],
    }];
    console.log(`✅ Final fallback plan generated with ${fallbackTasks.length} task(s)`);
    return { tasks: fallbackTasks, goal: userGoal };
  }
  
  console.error('❌ Error generating plan after all retries and fallbacks:', lastError);
  throw new Error(`Failed to generate plan after ${maxRetries + 1} attempts: ${lastError?.message || 'Unknown error'}`);
}

