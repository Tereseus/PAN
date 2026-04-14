// PAN AI Interface — legacy entry point
// Re-exports from unified llm.js for backwards compatibility

export { 
  claude, 
  logUsage, 
  getAuthStatus, 
  getConfiguredModel, 
  getCustomModelConfig, 
  MODEL_PRICING, 
  CEREBRAS_MODELS 
} from './llm.js';
