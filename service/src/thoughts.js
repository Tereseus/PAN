// Back-compat shim. The real code lives in `./intuition/mind.js`. PAN's
// thought stream is the "Mind" subsystem of Intuition — see
// `docs/PAN-ARCHITECTURE.md` § Intuition.
//
// Don't add code here. New behavior goes in `./intuition/mind.js`.
// This shim exists so external imports `from './thoughts.js'` keep working
// during the migration. It will be deleted once all importers are updated.
export * from './intuition/mind.js';
