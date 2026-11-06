// Wrangler entrypoint (`main` in wrangler.jsonc).
// App assembly lives in ./app; this file exists to keep the worker entry thin.
export { default } from './app'
export type { AppType } from './app'
