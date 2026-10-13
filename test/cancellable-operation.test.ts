import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CancellableLoader } from "@earendil-works/pi-tui";

import { createExclusiveOperation, finishCancellableWork } from "../src/cancellable-operation.ts";

function fakeTui() {
	return { requestRender() {} };
}

describe("escape cancellation", () => {
	// @lat: [[tests#Escape cancels loading]]
	test("escape aborts the loader, clears busy, and allows a later operation", async () => {
		const gate = createExclusiveOperation();
		const loader = new CancellableLoader(
			fakeTui() as never,
			(text) => text,
			(text) => text,
			"Loading ZenMoney accounts…",
			{ frames: ["."], intervalMs: 1_000 },
		);
		let sawAbort = false;
		const first = gate.run(() =>
			finishCancellableWork(loader.signal, (signal) => {
				return new Promise<string>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							sawAbort = true;
							reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
						},
						{ once: true },
					);
				});
			}),
		);

		assert.equal(gate.busy, true);
		loader.handleInput("\u001b");
		assert.deepEqual(await first, { status: "cancelled" });
		assert.equal(sawAbort, true);
		assert.equal(gate.busy, false);
		assert.equal(loader.aborted, true);
		loader.dispose();

		const second = await gate.run(async () => "next");
		assert.equal(second, "next");
		assert.equal(gate.busy, false);
	});

	test("a second request is rejected while one is already busy", async () => {
		const gate = createExclusiveOperation();
		let release: (() => void) | undefined;
		const first = gate.run(
			() =>
				new Promise<string>((resolve) => {
					release = () => resolve("first");
				}),
		);
		await assert.rejects(() => gate.run(async () => "second"), /already running/);
		release?.();
		assert.equal(await first, "first");
		assert.equal(gate.busy, false);
	});
});
