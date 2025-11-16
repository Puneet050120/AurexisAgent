// Topological sort implementation for task dependency resolution
import { Task } from '../types/agent';

/**
 * Performs topological sort on tasks to determine execution order
 * Uses Kahn's algorithm
 */
export function topologicalSort(tasks: Task[]): Task[] {
  // Build dependency graph and calculate in-degree
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>();
  const taskMap = new Map<string, Task>();

  // Initialize
  tasks.forEach((task) => {
    inDegree.set(task.id, 0);
    graph.set(task.id, []);
    taskMap.set(task.id, task);
  });

  // Build graph: for each task, track its dependents
  tasks.forEach((task) => {
    task.dependencies.forEach((depId) => {
      const currentInDegree = inDegree.get(task.id) || 0;
      inDegree.set(task.id, currentInDegree + 1);
      
      const dependents = graph.get(depId) || [];
      dependents.push(task.id);
      graph.set(depId, dependents);
    });
  });

  // Kahn's algorithm: start with tasks that have no dependencies
  const queue: string[] = [];
  inDegree.forEach((degree, taskId) => {
    if (degree === 0) {
      queue.push(taskId);
    }
  });

  const result: Task[] = [];

  while (queue.length > 0) {
    const taskId = queue.shift()!;
    const task = taskMap.get(taskId);
    if (task) {
      result.push(task);
    }

    // Decrease in-degree of dependents
    const dependents = graph.get(taskId) || [];
    dependents.forEach((dependentId) => {
      const newDegree = (inDegree.get(dependentId) || 0) - 1;
      inDegree.set(dependentId, newDegree);
      if (newDegree === 0) {
        queue.push(dependentId);
      }
    });
  }

  // Check for cycles (if result length < tasks length, there's a cycle)
  if (result.length !== tasks.length) {
    // Find which tasks are part of the cycle
    const processedTasks = new Set(result.map(t => t.id));
    const remainingTasks = tasks.filter(t => !processedTasks.has(t.id));
    
    // Try to detect the cycle by following dependencies
    const findCycle = (startTaskId: string, visited: Set<string>, path: string[]): string[] | null => {
      if (visited.has(startTaskId)) {
        // Found a cycle - return the path
        const cycleStart = path.indexOf(startTaskId);
        return path.slice(cycleStart).concat(startTaskId);
      }
      
      const task = taskMap.get(startTaskId);
      if (!task) return null;
      
      visited.add(startTaskId);
      path.push(startTaskId);
      
      for (const depId of task.dependencies) {
        const cycle = findCycle(depId, visited, path);
        if (cycle) return cycle;
      }
      
      path.pop();
      visited.delete(startTaskId);
      return null;
    };
    
    let cycle: string[] | null = null;
    for (const task of remainingTasks) {
      cycle = findCycle(task.id, new Set(), []);
      if (cycle) break;
    }
    
    // Build error message
    let errorMessage = 'Circular dependency detected in task graph.\n';
    errorMessage += `Tasks involved in cycle: ${remainingTasks.map(t => `${t.id} (${t.description.substring(0, 50)}...)`).join(', ')}.\n`;
    
    if (cycle && cycle.length > 1) {
      errorMessage += `Cycle path: ${cycle.join(' -> ')}.\n`;
    }
    
    errorMessage += '\nPlease review the task dependencies to ensure they form a valid Directed Acyclic Graph (DAG).';
    errorMessage += '\nEach task should only depend on tasks that come before it, not tasks that depend on it.';
    
    throw new Error(errorMessage);
  }

  return result;
}

/**
 * Get tasks that are ready to execute (all dependencies completed)
 */
export function getReadyTasks(
  tasks: Task[],
  completedTaskIds: Set<string>
): Task[] {
  return tasks.filter((task) => {
    // Check if all dependencies are completed
    return task.dependencies.every((depId) => completedTaskIds.has(depId));
  });
}

