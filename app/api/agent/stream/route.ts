import { NextRequest } from 'next/server';
import { generatePlan } from '@/lib/agent/planner';
import { executePlan } from '@/lib/agent/executor';
import { generateFinalSummary } from '@/lib/agent/summarizer';
import { cleanAndProcessQuery } from '@/lib/agent/query-processor';
import { rateLimit, getClientIdentifier } from '@/lib/utils/rate-limit';
import { TaskResult } from '@/lib/types/agent';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const clientId = getClientIdentifier(req);
    const rateLimitResult = rateLimit(clientId);
    
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ 
          error: 'Rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000),
        }),
        { 
          status: 429, 
          headers: { 
            'Content-Type': 'application/json',
            'Retry-After': String(Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)),
          } 
        }
      );
    }
    
    const { goal: rawGoal } = await req.json();

    if (!rawGoal || typeof rawGoal !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Goal is required and must be a string' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    const goal = cleanAndProcessQuery(rawGoal);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const safeEnqueue = (chunk: Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch (_e) {
            closed = true;
          }
        };
        const send = (type: string, data: any) => {
          if (closed) return;
          safeEnqueue(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
        };

        try {
          send('status', { stage: 'planning', message: 'Planning tasks...' });
          const plan = await generatePlan(goal);
          send('plan', { plan });

          send('status', { stage: 'executing', message: 'Executing tasks...' });
          
          const executionResults = new Map<string, any>();
          const updates: Array<{
            taskId: string;
            status: string;
            result?: any;
            error?: string;
          }> = [];

          let executionResultsMap: Map<string, TaskResult> = new Map();
          try {
            executionResultsMap = await executePlan(plan, (update) => {
              updates.push(update);
              if (update.result) {
                executionResults.set(update.taskId, update.result);
              }
              if (update.error && update.error.includes('Retrying')) {
                send('status', { stage: 'executing', message: update.error });
              }
              const task = plan.tasks.find(t => t.id === update.taskId);
              send('task_update', { 
                taskId: update.taskId,
                status: update.status,
                description: task?.description,
                tool: task?.tool,
                result: update.result,
                error: update.error,
              });
              
              if (update.status === 'completed' || update.status === 'failed') {
                send('status', { 
                  stage: 'executing', 
                  message: update.status === 'completed' 
                    ? `Task ${update.taskId} completed` 
                    : `Task ${update.taskId} failed` 
                });
              }
            });

            executionResultsMap.forEach((taskResult, taskId) => {
              if (taskResult.result) {
                executionResults.set(taskId, taskResult.result);
              }
            });
          } catch (executionError) {
            console.error('Execution error:', executionError);
          }

          const taskResults = plan.tasks.map((task) => {
            const taskResult = executionResultsMap.get(task.id);
            const updatesForTask = updates.filter((u) => u.taskId === task.id);
            const lastUpdate = updatesForTask.length > 0 ? updatesForTask[updatesForTask.length - 1] : null;
            
            const finalStatus = taskResult?.status || lastUpdate?.status || 'unknown';
            const finalResult = taskResult?.result || executionResults.get(task.id) || lastUpdate?.result || null;
            const finalError = taskResult?.error || lastUpdate?.error || null;
            
            return {
              taskId: task.id,
              description: task.description,
              tool: task.tool,
              dependencies: task.dependencies,
              status: finalStatus,
              result: finalResult,
              error: finalError,
            };
          });

          send('status', { stage: 'summarizing', message: 'Generating summary...' });
          const summary = generateFinalSummary(plan, taskResults);
          
          send('complete', {
            success: true,
            plan,
            taskResults,
            summary,
            updates,
          });

          if (!closed) {
            closed = true;
            controller.close();
          }
        } catch (error) {
          console.error('Agent execution error:', error);
          if (!closed) {
            send('error', {
              error: 'Something went wrong. Please try again.',
            });
            closed = true;
            controller.close();
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Agent API error:', error);
    return new Response(
      JSON.stringify({
        error: 'Something went wrong. Please try again.',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
