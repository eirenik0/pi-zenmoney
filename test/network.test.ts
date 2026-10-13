import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	isZenMoneyCancelled,
	isZenMoneyTimeout,
	networkTimeoutMs,
	runAbortableCommand,
	withNetworkDeadline,
	ZENMONEY_CANCELLED_MESSAGE,
} from "../src/network.ts";
import { resolveSecretReference } from "../src/secret-refs.ts";

function hangUntilAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

describe("network deadlines", () => {
	// @lat: [[tests#Network request timeout]]
	test("a request that never settles times out once and does not retry", async () => {
		let calls = 0;
		await assert.rejects(
			() =>
				withNetworkDeadline(
					{ timeoutMs: 25, timeoutMessage: "ZenMoney API request timed out after 25ms." },
					async (signal) => {
						calls += 1;
						await hangUntilAbort(signal);
					},
				),
			(error: unknown) => {
				assert.equal(isZenMoneyTimeout(error), true);
				assert.equal(isZenMoneyCancelled(error), false);
				return true;
			},
		);
		assert.equal(calls, 1);
	});

	// @lat: [[tests#Network request cancellation]]
	test("aborting the caller cancels the request without retrying it", async () => {
		const parent = new AbortController();
		let calls = 0;
		const pending = withNetworkDeadline(
			{
				signal: parent.signal,
				timeoutMs: 5_000,
				timeoutMessage: "timed out",
				cancelledMessage: ZENMONEY_CANCELLED_MESSAGE,
			},
			async (signal) => {
				calls += 1;
				await hangUntilAbort(signal);
			},
		);
		parent.abort();
		await assert.rejects(pending, (error: unknown) => {
			assert.equal(isZenMoneyCancelled(error), true);
			assert.match(error instanceof Error ? error.message : "", /cancelled/);
			return true;
		});
		assert.equal(calls, 1);
	});

	// @lat: [[tests#Already aborted request]]
	test("an already aborted caller does not start the request", async () => {
		const parent = new AbortController();
		parent.abort();
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			let calls = 0;
			await assert.rejects(
				() =>
					withNetworkDeadline(
						{
							signal: parent.signal,
							timeoutMs: 5_000,
							timeoutMessage: "timed out",
							cancelledMessage: ZENMONEY_CANCELLED_MESSAGE,
						},
						async () => {
							calls += 1;
							return Promise.reject(new Error("should not start"));
						},
					),
				isZenMoneyCancelled,
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(calls, 0);
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	// @lat: [[tests#Nested abort propagation]]
	test("a parent abort cancels a nested command signal", async () => {
		const parent = new AbortController();
		let nested: AbortSignal | undefined;
		const pending = runAbortableCommand("op", ["read", "op://vault/item"], {
			signal: parent.signal,
			timeoutMs: 5_000,
			timeoutMessage: "1Password request timed out after 5s.",
			cancelledMessage: ZENMONEY_CANCELLED_MESSAGE,
			execImpl: (_file, _args, options) => {
				nested = options.signal;
				return hangUntilAbort(options.signal);
			},
		});
		parent.abort();
		await assert.rejects(pending, isZenMoneyCancelled);
		assert.equal(nested?.aborted, true);
	});

	// @lat: [[tests#Network abort cleanup]]
	test("a finished request clears the deadline so a later parent abort does nothing", async () => {
		const parent = new AbortController();
		let inner: AbortSignal | undefined;
		const value = await withNetworkDeadline(
			{ signal: parent.signal, timeoutMs: 40, timeoutMessage: "timed out" },
			async (signal) => {
				inner = signal;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return "ok";
			},
		);
		assert.equal(value, "ok");
		await new Promise((resolve) => setTimeout(resolve, 50));
		parent.abort();
		assert.equal(inner?.aborted, false);
	});

	// @lat: [[tests#Network request success]]
	test("a request that finishes before the deadline returns its value", async () => {
		const value = await withNetworkDeadline(
			{ timeoutMs: 200, timeoutMessage: "timed out" },
			async () => {
				return { accounts: 2 };
			},
		);
		assert.deepEqual(value, { accounts: 2 });
	});

	// @lat: [[tests#Network timeout override]]
	test("invalid timeout overrides fall back to the default", () => {
		assert.equal(networkTimeoutMs({}), 30_000);
		assert.equal(networkTimeoutMs({ ZENMONEY_NETWORK_TIMEOUT_MS: "15000" }), 15_000);
		assert.equal(networkTimeoutMs({ ZENMONEY_NETWORK_TIMEOUT_MS: "0" }), 30_000);
		assert.equal(networkTimeoutMs({ ZENMONEY_NETWORK_TIMEOUT_MS: "nope" }), 30_000);
	});

	// @lat: [[tests#Network timeout upper bound]]
	test("timeouts above Node's maximum delay stay above 1ms", async () => {
		assert.equal(networkTimeoutMs({ ZENMONEY_NETWORK_TIMEOUT_MS: "2147483648" }), 2_147_483_647);
		const value = await withNetworkDeadline(
			{ timeoutMs: 2_147_483_648, timeoutMessage: "timed out" },
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 15));
				return "ok";
			},
		);
		assert.equal(value, "ok");
	});
});

describe("secret references", () => {
	// @lat: [[tests#1Password lookup timeout]]
	test("1Password lookup times out without treating it as a generic CLI failure", async () => {
		await assert.rejects(
			() =>
				resolveSecretReference("op://vault/item", "ZenMoney token", {
					timeoutMs: 20,
					execImpl: (_file, _args, options) => hangUntilAbort(options.signal),
				}),
			(error: unknown) => {
				assert.equal(isZenMoneyTimeout(error), true);
				assert.match(error instanceof Error ? error.message : "", /1Password request timed out/);
				return true;
			},
		);
	});

	// @lat: [[tests#1Password lookup success]]
	test("1Password lookup returns the resolved secret", async () => {
		const secret = await resolveSecretReference("op://vault/item", "ZenMoney token", {
			timeoutMs: 200,
			execImpl: async () => ({ stdout: " token \n" }),
		});
		assert.equal(secret, "token");
	});

	// @lat: [[tests#Raw token resolution]]
	test("raw tokens skip the 1Password command", async () => {
		let calls = 0;
		const secret = await resolveSecretReference("plain-token", "ZenMoney token", {
			execImpl: () => {
				calls += 1;
				return Promise.resolve({ stdout: "nope" });
			},
		});
		assert.equal(secret, "plain-token");
		assert.equal(calls, 0);
	});
});
