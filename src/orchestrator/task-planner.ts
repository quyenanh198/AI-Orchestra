import * as crypto from 'crypto';

export interface SubTask {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  tokenBudget: number;
  result?: string;
}

export interface TaskPlan {
  id: string;
  originalTask: string;
  subtasks: SubTask[];
  totalTokenBudget: number;
  completedSubtasks: number;
}

/**
 * Plans and manages complex tasks by breaking them down into subtasks.
 */
export class TaskPlanner {
  private activePlans: Map<string, TaskPlan> = new Map();

  /**
   * Creates a plan for a given task based on its estimated token budget.
   * 
   * @param task - The description of the task
   * @param totalBudget - The estimated total token budget
   * @returns The generated task plan
   */
  public createPlan(task: string, totalBudget: number): TaskPlan {
    const planId = crypto.randomUUID();
    const subtasks: SubTask[] = [];

    // Simple heuristic: break down tasks that have a high token budget
    if (totalBudget > 4000) {
      subtasks.push({
        id: crypto.randomUUID(),
        description: 'Analyze requirements and outline steps.',
        status: 'pending',
        tokenBudget: Math.floor(totalBudget * 0.2),
      });
      subtasks.push({
        id: crypto.randomUUID(),
        description: 'Implement the core logic and modifications.',
        status: 'pending',
        tokenBudget: Math.floor(totalBudget * 0.6),
      });
      subtasks.push({
        id: crypto.randomUUID(),
        description: 'Review and refine the implementation.',
        status: 'pending',
        tokenBudget: Math.floor(totalBudget * 0.2),
      });
    } else {
      subtasks.push({
        id: crypto.randomUUID(),
        description: task, // Single subtask is the task itself
        status: 'pending',
        tokenBudget: totalBudget,
      });
    }

    const plan: TaskPlan = {
      id: planId,
      originalTask: task,
      subtasks,
      totalTokenBudget: totalBudget,
      completedSubtasks: 0,
    };

    this.activePlans.set(planId, plan);
    return plan;
  }

  /**
   * Updates the status or result of a specific subtask within a plan.
   * 
   * @param planId - The ID of the plan
   * @param subtaskId - The ID of the subtask
   * @param status - The new status
   * @param result - Optional result of the subtask
   */
  public updateSubtask(planId: string, subtaskId: string, status: SubTask['status'], result?: string): void {
    const plan = this.activePlans.get(planId);
    if (!plan) return;

    const subtask = plan.subtasks.find(st => st.id === subtaskId);
    if (subtask) {
      // Track completion
      if (status === 'completed' && subtask.status !== 'completed') {
          plan.completedSubtasks++;
      } else if (subtask.status === 'completed' && status !== 'completed') {
          plan.completedSubtasks--;
      }

      subtask.status = status;
      if (result) {
        subtask.result = result;
      }
    }
  }

  /**
   * Retrieves a plan by its ID.
   */
  public getPlan(planId: string): TaskPlan | undefined {
    return this.activePlans.get(planId);
  }

  /**
   * Retrieves all active plans.
   */
  public getActivePlans(): TaskPlan[] {
    return Array.from(this.activePlans.values());
  }
}
