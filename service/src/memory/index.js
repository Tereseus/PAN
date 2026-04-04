// PAN Memory System — unified interface to three-tier vector memory
//
// Exports all memory operations through a single module.
// Usage: import { memory } from './memory/index.js';

import * as episodic from './episodic.js';
import * as semantic from './semantic.js';
import * as procedural from './procedural.js';
import { buildContext, getStats } from './context-builder.js';
import { consolidate } from './consolidation.js';
import { resetOllamaStatus } from './embeddings.js';

const memory = {
  episodic,
  semantic,
  procedural,
  buildContext,
  getStats,
  consolidate,
  resetOllamaStatus,
};

export { memory };
export { buildContext, getStats, consolidate };
export { episodic, semantic, procedural };
