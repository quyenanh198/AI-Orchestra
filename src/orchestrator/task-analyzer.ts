import { Message } from '../providers/types';

export type TaskComplexity = 'simple' | 'medium' | 'complex';
export type TaskType = 'code-generation' | 'code-review' | 'explanation' | 'refactoring' | 'debugging' | 'conversation' | 'unknown';

export interface TaskAnalysis {
  type: TaskType;
  complexity: TaskComplexity;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  recommendedTier: 'budget' | 'standard' | 'premium';
  keywords: string[];
  context: string;
}

/**
 * Analyzes user requests to determine the complexity, type, and recommended AI model tier.
 */
export class TaskAnalyzer {
  /**
   * Analyzes a list of messages to understand the task.
   * 
   * @param messages - The conversation history and current request
   * @returns An analysis of the task
   */
  public analyze(messages: Message[]): TaskAnalysis {
    if (!messages || messages.length === 0) {
      return {
        type: 'unknown',
        complexity: 'simple',
        estimatedInputTokens: 0,
        estimatedOutputTokens: 50,
        recommendedTier: 'budget',
        keywords: [],
        context: 'Empty messages',
      };
    }

    const lastMessage = messages[messages.length - 1];
    const textContent = lastMessage.content;
    const lowerContent = textContent.toLowerCase();

    // 1. Detect Keywords and Type
    const { type, keywords } = this.detectTypeAndKeywords(lowerContent);

    // 2. Estimate Tokens
    // Rough estimation: 1 word ~ 1.3 tokens
    const totalWords = messages.reduce((acc, msg) => acc + msg.content.split(/\s+/).length, 0);
    const estimatedInputTokens = Math.ceil(totalWords * 1.3);

    let outputRatio = 1;
    switch (type) {
      case 'code-generation':
      case 'refactoring':
        outputRatio = 1.5;
        break;
      case 'code-review':
      case 'explanation':
        outputRatio = 0.8;
        break;
      case 'debugging':
        outputRatio = 1.0;
        break;
      default:
        outputRatio = 0.5;
        break;
    }
    const estimatedOutputTokens = Math.max(100, Math.ceil(estimatedInputTokens * outputRatio));

    // 3. Determine Complexity
    const totalTokensEstimate = estimatedInputTokens + estimatedOutputTokens;
    let complexity: TaskComplexity = 'simple';
    if (totalTokensEstimate > 2000 || type === 'debugging' || type === 'code-generation') {
        if (totalTokensEstimate > 4000) {
            complexity = 'complex';
        } else {
            complexity = 'medium';
        }
    } else if (totalTokensEstimate > 500 || type === 'code-review' || type === 'refactoring') {
      complexity = 'medium';
    }

    // Adjust complexity for short questions
    if (totalTokensEstimate < 300 && type === 'explanation') {
      complexity = 'simple';
    }

    // 4. Recommend Tier
    let recommendedTier: 'budget' | 'standard' | 'premium' = 'budget';
    if (complexity === 'complex') {
      recommendedTier = 'premium';
    } else if (complexity === 'medium') {
      recommendedTier = 'standard';
    }

    return {
      type,
      complexity,
      estimatedInputTokens,
      estimatedOutputTokens,
      recommendedTier,
      keywords,
      context: `Detected ${type} task with ${complexity} complexity based on ${estimatedInputTokens} input tokens.`,
    };
  }

  private detectTypeAndKeywords(content: string): { type: TaskType; keywords: string[] } {
    const keywordMap: Record<TaskType, string[]> = {
      'code-generation': ['create', 'build', 'implement', 'write', 'generate'],
      'code-review': ['review', 'check', 'feedback', 'critique'],
      'explanation': ['explain', 'what is', 'how to', 'how do'],
      'refactoring': ['refactor', 'rename', 'move', 'clean up', 'extract'],
      'debugging': ['bug', 'error', 'fix', 'issue', 'problem', 'crash', 'fail'],
      'conversation': ['hello', 'hi', 'hey', 'thanks', 'thank you'],
      'unknown': []
    };

    let detectedType: TaskType = 'unknown';
    let matchedKeywords: string[] = [];

    for (const [type, kws] of Object.entries(keywordMap)) {
      const matched = kws.filter(kw => content.includes(kw));
      if (matched.length > 0) {
        if (detectedType === 'unknown' || matched.length > matchedKeywords.length) {
          detectedType = type as TaskType;
          matchedKeywords = matched;
        }
      }
    }

    // Default to explanation or conversation if no clear code intent
    if (detectedType === 'unknown') {
      if (content.length > 50) {
        detectedType = 'explanation';
      } else {
        detectedType = 'conversation';
      }
    }

    return { type: detectedType, keywords: matchedKeywords };
  }
}
