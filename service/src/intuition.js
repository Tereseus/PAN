// Back-compat shim. The real code lives in `./intuition/index.js`. See
// `docs/PAN-ARCHITECTURE.md` for the section breakdown — Intuition is the
// cortex and is being split into per-subsystem files under intuition/.
//
// Don't add code here. New behavior goes in the appropriate file under
// `service/src/intuition/` (state.js, needs.js, identity.js, mind.js,
// scorer.js, dispatch.js — and the public API stays in index.js).
//
// This shim exists so external imports `from './intuition.js'` keep working
// during the migration. It will be deleted once all importers are updated.
export * from './intuition/index.js';
