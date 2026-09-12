/**
 * CodeBuddy CN CLI version string — the single source of truth shared by OAuth
 * (`src/lib/oauth/constants/oauth.ts`), chat completions (`./index.ts`) and
 * usage/quota (`open-sse/services/usage/codebuddy-cn.ts`).
 *
 * It lives in an import-free module on purpose. The provider registry is
 * reachable from client components (`shared/constants/models.ts` →
 * `providerModels.ts` → `providerRegistry.ts`), and `src/lib/oauth/constants/oauth.ts`
 * pulls in `open-sse/utils/cursorAgentCliVersion.ts`, which reads the local
 * install through `node:fs`/`node:os`/`node:path`. Importing the constant from
 * the OAuth module therefore dragged node builtins into 310 client bundles and
 * failed the webpack build ("UnhandledSchemeError: reading from node:fs").
 *
 * A version string that differs between one account's auth calls and its chat
 * calls is exactly the internally-inconsistent client fingerprint Tencent's WAF
 * flags as anomalous (#12702), so the three call sites must keep sharing it —
 * just from a module that has no imports of its own.
 */
export const CODEBUDDY_CN_USER_AGENT = "CLI/2.108.1 CodeBuddy/2.108.1";
