/**
 * The tools from Rust that exact2's scripts run: the Contract compiler (`contract`) and the web compiler
 * (`exact-web-js`). Each reads exact2's files (the standard modules, the bake's TypeScript analysis) from the checkout
 * `EXACT_ROOT` names, so a binary kept for the machine, or built in another checkout, reads this checkout's files.
 *
 * @ref LLP 1174 D1
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `env` for a tool run for this checkout: `EXACT_ROOT` names it, over any the caller inherited. */
export const toolEnv = (env = process.env) => ({ ...env, EXACT_ROOT: ROOT });

/** A tool to run: its command and leading arguments, the environment to run it in, and `done()`, for when it ends. */
export const launch = (cmd, pre = [], done = () => {}, env = process.env) => ({ cmd, pre, env: toolEnv(env), done });
