import { isZenMoneyCancelled } from "./network.ts";

export function linkAbortSignals(signals: Array<AbortSignal | undefined>): {
	signal: AbortSignal;
	dispose: () => void;
} {
	const controller = new AbortController();
	const listeners: Array<{ parent: AbortSignal; listener: () => void }> = [];
	for (const parent of signals) {
		if (!parent) continue;
		const listener = () => {
			if (controller.signal.aborted) return;
			controller.abort(parent.reason);
		};
		if (parent.aborted) listener();
		else {
			parent.addEventListener("abort", listener, { once: true });
			listeners.push({ parent, listener });
		}
	}
	return {
		signal: controller.signal,
		dispose() {
			for (const entry of listeners) entry.parent.removeEventListener("abort", entry.listener);
		},
	};
}

export function createExclusiveOperation() {
	let busy = false;
	return {
		get busy() {
			return busy;
		},
		async run<T>(fn: () => Promise<T>): Promise<T> {
			if (busy) throw new Error("A ZenMoney request is already running.");
			busy = true;
			try {
				return await fn();
			} finally {
				busy = false;
			}
		},
	};
}

export async function finishCancellableWork<T>(
	signal: AbortSignal,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<
	{ status: "ok"; value: T } | { status: "cancelled" } | { status: "error"; error: unknown }
> {
	try {
		const value = await work(signal);
		if (signal.aborted) return { status: "cancelled" };
		return { status: "ok", value };
	} catch (error) {
		if (signal.aborted || isZenMoneyCancelled(error)) return { status: "cancelled" };
		return { status: "error", error };
	}
}
