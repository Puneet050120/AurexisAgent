// Type definitions for the autonomous agent system

export type ToolType = 'web_search' | 'api' | 'calculator' | 'stock';

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

export interface Task {
  id: string;
  description: string;
  tool: ToolType;
  dependencies: string[]; // Array of task IDs this task depends on
  parameters?: Record<string, any>; // Tool-specific parameters
}

export interface Plan {
  tasks: Task[];
  goal: string;
}

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  result?: any;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ExecutionState {
  plan: Plan;
  results: Map<string, TaskResult>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  currentTasks: string[]; // Tasks currently running
}

export interface ExecutionUpdate {
  type: 'task_started' | 'task_complete' | 'task_failed' | 'task_progress' | 'execution_complete';
  taskId?: string;
  message: string;
  result?: any;
  error?: string;
}

