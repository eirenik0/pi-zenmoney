import { ZENMONEY_CANCELLED_MESSAGE, ZenMoneyCancelledError } from "./network.ts";
import type { ZenMoneySnapshot } from "./types.ts";

export const SNAPSHOT_CACHE_MS = 60_000;

export function cachedZenMoneySnapshot(
	cache: { token: string; snapshot: ZenMoneySnapshot } | undefined,
	token: string,
	now: number,
	options?: { force?: boolean; signal?: AbortSignal },
): ZenMoneySnapshot | undefined {
	if (options?.signal?.aborted) throw new ZenMoneyCancelledError(ZENMONEY_CANCELLED_MESSAGE);
	if (
		!options?.force &&
		cache?.token === token &&
		now - cache.snapshot.fetchedAt < SNAPSHOT_CACHE_MS
	) {
		return cache.snapshot;
	}
	return undefined;
}
