import { getKieApiToken } from "./guest/db";

/**
 * The kie.ai API key: the one saved in Settings → API keys, else the
 * `KIE_API_TOKEN` environment variable. Arguments are ignored — kept so existing
 * call sites don't need to change.
 */
export async function getKieToken(..._args: unknown[]): Promise<string | null> {
  return getKieApiToken() ?? process.env.KIE_API_TOKEN ?? null;
}
