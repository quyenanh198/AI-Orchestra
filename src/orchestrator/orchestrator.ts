import * as vscode from 'vscode';
import { Message, ChatResponse, ChatChunk } from '../providers/types';
import { BudgetManager, BudgetStatus } from '../budget/budget-manager';
import { TaskAnalyzer, TaskAnalysis } from './task-analyzer';
import { ModelRouter, RoutingDecision } from './model-router';
import { CredentialBroker } from '../security/credential-broker';

export interface OrchestratorResult {
  response: ChatResponse;
  routingDecision: RoutingDecision;
  taskAnalysis: TaskAnalysis;
  budgetStatus: BudgetStatus;
}

/**
 * The main orchestrator that coordinates task analysis, routing, budget management,
 * and interactions with AI providers.
 */
export class Orchestrator implements vscode.Disposable {
  private _onTaskStarted = new vscode.EventEmitter<{ analysis: TaskAnalysis; decision: RoutingDecision }>();
  public readonly onTaskStarted = this._onTaskStarted.event;

  private _onTaskCompleted = new vscode.EventEmitter<OrchestratorResult>();
  public readonly onTaskCompleted = this._onTaskCompleted.event;

  private _onModelSwitched = new vscode.EventEmitter<RoutingDecision>();
  public readonly onModelSwitched = this._onModelSwitched.event;

  private _onError = new vscode.EventEmitter<Error>();
  public readonly onError = this._onError.event;

  private disposables: vscode.Disposable[] = [];

  constructor(
    private budgetManager: BudgetManager,
    private taskAnalyzer: TaskAnalyzer,
    private modelRouter: ModelRouter,
    private credentialBroker: CredentialBroker
  ) {
    this.disposables.push(
      this._onTaskStarted,
      this._onTaskCompleted,
      this._onModelSwitched,
      this._onError
    );
  }

  /**
   * Executes a conversation request fully.
   */
  public async execute(
    messages: Message[],
    options?: { signal?: AbortSignal; preferredProvider?: string; maxTokens?: number; agentId?: string }
  ): Promise<OrchestratorResult> {
    try {
      const taskAnalysis = this.taskAnalyzer.analyze(messages);
      const excluded = new Set<string>();
      let routingDecision = await this.modelRouter.route(taskAnalysis, options?.preferredProvider, excluded);

      if (routingDecision.wasFallback) {
        this._onModelSwitched.fire(routingDecision);
      }

      this._onTaskStarted.fire({ analysis: taskAnalysis, decision: routingDecision });

      // Check affordability
      const budgetCheck = this.budgetManager.canAfford(
        routingDecision.model,
        taskAnalysis.estimatedInputTokens,
        routingDecision.provider
      );

      if (!budgetCheck.allowed) {
        const cheaper = await this.modelRouter.route({ ...taskAnalysis, recommendedTier: 'budget' }, 'auto', excluded);
        const altCheck = this.budgetManager.canAfford(cheaper.model, taskAnalysis.estimatedInputTokens, cheaper.provider);
        if (!altCheck.allowed) throw new Error(`Budget exhausted. ${budgetCheck.reason}. No affordable alternative.`);
        cheaper.wasFallback = true;
        cheaper.originalModel = routingDecision.model;
        cheaper.reason = `Budget fallback from ${routingDecision.provider}/${routingDecision.model}. ${cheaper.reason}`;
        routingDecision = cheaper;
        this._onModelSwitched.fire(cheaper);
      }

      let response: ChatResponse | undefined;
      const failures: string[] = [];
      let reservationId: string | undefined;
      while (!response) {
        const reservation = this.budgetManager.reserveRequest(
          routingDecision.model,
          taskAnalysis.estimatedInputTokens,
          options?.maxTokens || taskAnalysis.estimatedOutputTokens,
          routingDecision.provider,
        );
        if (!reservation.allowed || !reservation.id) throw new Error(`Budget reservation failed: ${reservation.reason || 'unknown reason'}`);
        reservationId = reservation.id;
        try {
          const provider = await this.credentialBroker.getProviderForInvocation(options?.agentId || 'supervisor', routingDecision.provider, routingDecision.model);
          response = await provider.chat(messages, {
            model: routingDecision.model,
            signal: options?.signal,
            maxTokens: options?.maxTokens,
          });
        } catch (error) {
          this.budgetManager.releaseReservation(reservationId);
          reservationId = undefined;
          if (options?.signal?.aborted) throw error;
          failures.push(`${routingDecision.provider}: ${error instanceof Error ? error.message : String(error)}`);
          excluded.add(routingDecision.provider);
          try {
            const next = await this.modelRouter.route(taskAnalysis, 'auto', excluded);
            next.wasFallback = true;
            next.originalModel = routingDecision.model;
            next.reason = `Runtime fallback after ${failures.join('; ')}. ${next.reason}`;
            routingDecision = next;
            this._onModelSwitched.fire(next);
          } catch {
            throw new Error(`All providers failed: ${failures.join('; ')}`);
          }
        }
      }

      this.budgetManager.commitReservation(reservationId!, routingDecision.model, {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
      }, routingDecision.provider);

      const budgetStatus = this.budgetManager.getBudgetStatus();

      const result: OrchestratorResult = {
        response,
        routingDecision,
        taskAnalysis,
        budgetStatus,
      };

      this._onTaskCompleted.fire(result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this._onError.fire(err);
      throw err;
    }
  }

  /**
   * Executes a conversation request and streams the response.
   */
  public async *executeStream(
    messages: Message[],
    options?: { signal?: AbortSignal; preferredProvider?: string; maxTokens?: number; agentId?: string }
  ): AsyncGenerator<{ chunk?: ChatChunk; metadata?: OrchestratorResult }> {
    let reservationId: string | undefined;
    try {
      const taskAnalysis = this.taskAnalyzer.analyze(messages);
      const routingDecision = await this.modelRouter.route(taskAnalysis, options?.preferredProvider);

      if (routingDecision.wasFallback) {
        this._onModelSwitched.fire(routingDecision);
      }
      this._onTaskStarted.fire({ analysis: taskAnalysis, decision: routingDecision });

      const budgetCheck = this.budgetManager.canAfford(
        routingDecision.model,
        taskAnalysis.estimatedInputTokens,
        routingDecision.provider
      );
      if (!budgetCheck.allowed) {
        throw new Error(`Budget exhausted. ${budgetCheck.reason}`);
      }
      const reservation = this.budgetManager.reserveRequest(
        routingDecision.model,
        taskAnalysis.estimatedInputTokens,
        options?.maxTokens || taskAnalysis.estimatedOutputTokens,
        routingDecision.provider,
      );
      if (!reservation.allowed || !reservation.id) throw new Error(`Budget reservation failed: ${reservation.reason || 'unknown reason'}`);
      reservationId = reservation.id;

      const provider = await this.credentialBroker.getProviderForInvocation(options?.agentId || 'supervisor', routingDecision.provider, routingDecision.model);

      let fullContent = '';
      const stream = provider.stream(messages, {
        model: routingDecision.model,
        signal: options?.signal,
        maxTokens: options?.maxTokens,
      });

      for await (const chunk of stream) {
        fullContent += chunk.content;
        yield { chunk };
      }

      const estimatedInputTokens = taskAnalysis.estimatedInputTokens;
      const estimatedOutputTokens = Math.ceil(fullContent.length / 4);

      this.budgetManager.commitReservation(reservationId, routingDecision.model, {
        inputTokens: estimatedInputTokens,
        outputTokens: estimatedOutputTokens,
        totalTokens: estimatedInputTokens + estimatedOutputTokens,
      }, routingDecision.provider);

      const budgetStatus = this.budgetManager.getBudgetStatus();

      const response: ChatResponse = {
        content: fullContent,
        model: routingDecision.model,
        provider: routingDecision.provider,
        usage: {
          inputTokens: estimatedInputTokens,
          outputTokens: estimatedOutputTokens,
          totalTokens: estimatedInputTokens + estimatedOutputTokens,
          estimatedCost: budgetCheck.estimatedCost,
        },
        finishReason: 'stop',
      };

      const result: OrchestratorResult = {
        response,
        routingDecision,
        taskAnalysis,
        budgetStatus,
      };

      this._onTaskCompleted.fire(result);
      yield { metadata: result };
    } catch (error) {
      this.budgetManager.releaseReservation(reservationId);
      const err = error instanceof Error ? error : new Error(String(error));
      this._onError.fire(err);
      throw err;
    }
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
