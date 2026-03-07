import type { TaskType, ClassificationResult, LLMProvider } from '@prism/shared';
import { listDecisions } from '../memory/decision';
import { modelRegistry } from './model-registry';

// --- Pattern rules ---

interface PatternRule {
  pattern: RegExp;
  taskType: TaskType;
  weight: number;
}

const PATTERN_RULES: PatternRule[] = [
  // Coding
  { pattern: /write\s+(a\s+)?function/i, taskType: 'coding', weight: 0.9 },
  { pattern: /```[\s\S]*```/, taskType: 'coding', weight: 0.85 },
  { pattern: /\b(debug|fix\s+(?:the\s+)?bug|bugfix)\b/i, taskType: 'coding', weight: 0.8 },
  { pattern: /\b(python|typescript|javascript|java|rust|golang|c\+\+|ruby|swift|kotlin|scala|php|html|css)\b/i, taskType: 'coding', weight: 0.5 },
  { pattern: /\b(function|class|method|api|endpoint|refactor|implement|algorithm|code)\b/i, taskType: 'coding', weight: 0.6 },
  { pattern: /\b(compile|syntax|runtime\s+error|stack\s+trace)\b/i, taskType: 'coding', weight: 0.7 },

  // Diagram
  { pattern: /\b(diagram|flowchart|uml|mermaid|sequence\s+diagram)\b/i, taskType: 'diagram', weight: 0.9 },
  { pattern: /draw\s+(a\s+|the\s+)?architecture/i, taskType: 'diagram', weight: 0.85 },
  { pattern: /\b(entity\s+relationship|er\s+diagram|class\s+diagram|state\s+diagram)\b/i, taskType: 'diagram', weight: 0.8 },
  { pattern: /\b(visualize|visualization|chart|graph)\b/i, taskType: 'diagram', weight: 0.7 },

  // Analysis
  { pattern: /\b(analyze|analyse|data\s+analysis)\b/i, taskType: 'analysis', weight: 0.85 },
  { pattern: /compare\s+.*pros\s+.*cons/i, taskType: 'analysis', weight: 0.8 },
  { pattern: /\b(csv|dataset|statistics|metrics|trends)\b/i, taskType: 'analysis', weight: 0.7 },
  { pattern: /\b(evaluate|assessment|benchmark)\b/i, taskType: 'analysis', weight: 0.65 },

  // Writing
  { pattern: /write\s+(a\s+|an\s+)?(essay|article|blog\s*post|report|letter|email)/i, taskType: 'writing', weight: 0.9 },
  { pattern: /\b(proofread|proofreading|grammar|spelling|copyedit)\b/i, taskType: 'writing', weight: 0.85 },
  { pattern: /\b(summarize|summarise|summary|paraphrase|rewrite)\b/i, taskType: 'writing', weight: 0.8 },
  { pattern: /\b(tone|readability|paragraph|draft)\b/i, taskType: 'writing', weight: 0.7 },

  // Math
  { pattern: /\b(calculate|computation|equation|formula)\b/i, taskType: 'math', weight: 0.85 },
  { pattern: /\b(calculus|integral|derivative|matrix|algebra|trigonometry)\b/i, taskType: 'math', weight: 0.8 },
  { pattern: /\b(proof|theorem|lemma|conjecture)\b/i, taskType: 'math', weight: 0.75 },
  { pattern: /\d+\s*[\+\-\*\/\^]\s*\d+/, taskType: 'math', weight: 0.5 },
  { pattern: /\b(solve|simplify)\b/i, taskType: 'math', weight: 0.6 },

  // Translation
  { pattern: /\btranslate\b/i, taskType: 'translation', weight: 0.9 },
  { pattern: /\b(from|into|to)\s+(english|spanish|french|german|chinese|japanese|korean|arabic|portuguese|russian|italian|hindi|dutch|swedish|turkish)/i, taskType: 'translation', weight: 0.8 },
  { pattern: /\b(localization|localize|localise|i18n)\b/i, taskType: 'translation', weight: 0.7 },

  // Creative
  { pattern: /\b(story|short\s+story|novel|fiction)\b/i, taskType: 'creative', weight: 0.85 },
  { pattern: /\b(poem|poetry|haiku|sonnet|limerick)\b/i, taskType: 'creative', weight: 0.85 },
  { pattern: /\b(screenplay|script|dialogue|monologue)\b/i, taskType: 'creative', weight: 0.8 },
  { pattern: /\b(brainstorm|imagine|creative|invent)\b/i, taskType: 'creative', weight: 0.6 },
  { pattern: /\b(worldbuilding|character\s+design|plot)\b/i, taskType: 'creative', weight: 0.7 },

  // Research
  { pattern: /research\s+(about|on|into)/i, taskType: 'research', weight: 0.8 },
  { pattern: /\bwhat\s+is\b/i, taskType: 'research', weight: 0.4 },
  { pattern: /\b(sources|citations|references|bibliography)\b/i, taskType: 'research', weight: 0.75 },
  { pattern: /\b(explain|how\s+does|why\s+does|what\s+are)\b/i, taskType: 'research', weight: 0.5 },
];

// --- Provider-based task mapping (models resolved dynamically) ---

interface ProviderPreference {
  provider: LLMProvider;
  reason: string;
}

const DEFAULT_PROVIDER_MAP: Record<TaskType, ProviderPreference> = {
  coding:      { provider: 'anthropic', reason: 'Claude excels at code generation and debugging' },
  diagram:     { provider: 'anthropic', reason: 'Claude produces well-structured diagrams' },
  analysis:    { provider: 'google',    reason: 'Gemini handles large data analysis with 1M context' },
  writing:     { provider: 'openai',    reason: 'GPT produces polished, natural prose' },
  math:        { provider: 'google',    reason: 'Gemini excels at mathematical reasoning' },
  translation: { provider: 'openai',    reason: 'GPT has strong multilingual capabilities' },
  creative:    { provider: 'openai',    reason: 'GPT generates vivid creative writing' },
  research:    { provider: 'google',    reason: 'Gemini processes and synthesizes large information' },
  general:     { provider: 'openai',    reason: 'GPT is a strong all-around model' },
};

/**
 * Resolve the best (flagship) model for a given provider from the model registry.
 * Picks the model with the highest inputCostPer1M (proxy for capability tier).
 */
function resolveModelForProvider(provider: LLMProvider): { model: string; displayName: string } | null {
  const models = modelRegistry.getByProvider(provider);
  const entries = Object.entries(models);
  if (entries.length === 0) return null;

  // Sort by input cost descending (higher cost = more capable flagship)
  entries.sort((a, b) => (b[1].inputCostPer1M ?? 0) - (a[1].inputCostPer1M ?? 0));

  const [modelId, config] = entries[0];
  return { model: modelId, displayName: config.displayName };
}

/**
 * Build a concrete model mapping for a task type by resolving the preferred provider.
 */
function resolveMapping(taskType: TaskType): { model: string; displayName: string; reason: string } {
  const pref = DEFAULT_PROVIDER_MAP[taskType];
  const resolved = resolveModelForProvider(pref.provider);
  if (resolved) {
    return { ...resolved, reason: pref.reason };
  }
  // Fallback: try any provider
  for (const fallbackProvider of ['openai', 'anthropic', 'google'] as LLMProvider[]) {
    const fallback = resolveModelForProvider(fallbackProvider);
    if (fallback) return { ...fallback, reason: pref.reason };
  }
  // Ultimate fallback (should never happen)
  return { model: 'gpt-4o', displayName: 'GPT-4o', reason: pref.reason };
}

// --- Model name detection for Decision Memory overrides ---
// Maps keywords to providers; actual model resolved dynamically

const MODEL_KEYWORD_PROVIDERS: Record<string, LLMProvider> = {
  'gpt': 'openai',
  'gpt-4o': 'openai',
  'gpt4o': 'openai',
  'gpt-5': 'openai',
  'openai': 'openai',
  'claude': 'anthropic',
  'claude-sonnet': 'anthropic',
  'claude-opus': 'anthropic',
  'anthropic': 'anthropic',
  'gemini': 'google',
  'gemini-flash': 'google',
  'gemini-pro': 'google',
  'google': 'google',
};

function resolveModelKeyword(keyword: string): { model: string; displayName: string } | null {
  const provider = MODEL_KEYWORD_PROVIDERS[keyword];
  if (!provider) return null;
  return resolveModelForProvider(provider);
}

// Task type keyword map for matching decisions to task types
const TASK_TYPE_KEYWORDS: Record<TaskType, string[]> = {
  coding: ['code', 'coding', 'programming', 'debug', 'function', 'implement'],
  diagram: ['diagram', 'flowchart', 'uml', 'mermaid', 'chart', 'visualization'],
  analysis: ['analysis', 'analyze', 'data', 'statistics', 'evaluate'],
  writing: ['writing', 'write', 'essay', 'article', 'blog', 'proofread'],
  math: ['math', 'calculate', 'equation', 'proof', 'formula'],
  translation: ['translate', 'translation', 'localize', 'language'],
  creative: ['creative', 'story', 'poem', 'brainstorm', 'fiction'],
  research: ['research', 'explain', 'sources', 'references'],
  general: ['general'],
};

/**
 * Classify a prompt and recommend the best model.
 */
export function classifyTask(prompt: string): ClassificationResult {
  const lower = prompt.toLowerCase();

  // Score each task type
  const scores: Record<string, number> = {};

  for (const rule of PATTERN_RULES) {
    if (rule.pattern.test(lower)) {
      const current = scores[rule.taskType] ?? 0;
      scores[rule.taskType] = Math.max(current, rule.weight);
    }
  }

  // Find highest scoring task type
  let bestType: TaskType = 'general';
  let bestScore = 0;

  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestType = type as TaskType;
    }
  }

  // Fallback confidence for general
  const confidence = bestScore > 0 ? bestScore : 0.3;
  const mapping = resolveMapping(bestType);

  let result: ClassificationResult = {
    taskType: bestType,
    confidence,
    recommendedModel: mapping.model,
    displayName: mapping.displayName,
    reason: mapping.reason,
    overriddenByDecision: false,
  };

  // Check Decision Memory for overrides
  try {
    const decisions = listDecisions(true);
    const preferences = decisions.filter((d) => d.type === 'preference');

    for (const pref of preferences) {
      const contentLower = pref.content.toLowerCase();

      // Check if this preference mentions the detected task type
      const keywords = TASK_TYPE_KEYWORDS[bestType];
      const matchesTaskType = keywords.some((kw) => contentLower.includes(kw));

      if (!matchesTaskType) continue;

      // Check if the preference specifies a model (via explicit model field or content)
      let overrideModel: string | null = null;
      let overrideDisplayName: string | null = null;

      if (pref.model) {
        // Check if the model field matches a known keyword → resolve dynamically
        const modelLower = pref.model.toLowerCase();
        for (const keyword of Object.keys(MODEL_KEYWORD_PROVIDERS)) {
          if (modelLower.includes(keyword)) {
            const resolved = resolveModelKeyword(keyword);
            if (resolved) {
              overrideModel = resolved.model;
              overrideDisplayName = resolved.displayName;
            }
            break;
          }
        }
        // If model field is a direct model ID, check if it exists in registry
        if (!overrideModel) {
          const registryModel = modelRegistry.getById(pref.model);
          if (registryModel) {
            overrideModel = pref.model;
            overrideDisplayName = registryModel.displayName;
          } else {
            overrideModel = pref.model;
            overrideDisplayName = pref.model;
          }
        }
      } else {
        // Try to extract model from content
        for (const keyword of Object.keys(MODEL_KEYWORD_PROVIDERS)) {
          if (contentLower.includes(keyword)) {
            const resolved = resolveModelKeyword(keyword);
            if (resolved) {
              overrideModel = resolved.model;
              overrideDisplayName = resolved.displayName;
            }
            break;
          }
        }
      }

      if (overrideModel && overrideDisplayName) {
        result = {
          ...result,
          recommendedModel: overrideModel,
          displayName: overrideDisplayName,
          reason: `User preference: ${pref.content}`,
          overriddenByDecision: true,
        };
        break; // First matching preference wins
      }
    }
  } catch {
    // Decision Memory unavailable — proceed with default
  }

  return result;
}
