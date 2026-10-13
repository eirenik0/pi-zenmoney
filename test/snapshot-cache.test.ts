import assert from "node:assert/strict";
import { test } from "node:test";

import { isZenMoneyCancelled } from "../src/network.ts";
import { cachedZenMoneySnapshot } from "../src/snapshot-cache.ts";
import type { ZenMoneySnapshot } from "../src/types.ts";

const snapshot = { fetchedAt: 1_000 } as ZenMoneySnapshot;

// @lat: [[tests#Cancelled snapshot cache]]
test("an aborted caller does not receive a cached snapshot", () => {
	const signal = AbortSignal.abort();
	assert.throws(
		() => cachedZenMoneySnapshot({ token: "token", snapshot }, "token", 1_100, { signal }),
		isZenMoneyCancelled,
	);
	assert.equal(cachedZenMoneySnapshot({ token: "token", snapshot }, "token", 1_100), snapshot);
});
