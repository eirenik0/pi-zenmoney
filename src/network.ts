import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { DEFAULT_NETWORK_TIMEOUT_MS } from "./constants.ts";

const execFile = promisify(execFileCallback);

export class ZenMoneyTimeoutError extends Error {
	override name = "ZenMoneyTimeoutError";
}

export class ZenMoneyCancelledError extends Error {
	override name = "ZenMoneyCancelledError";
}

export function isZenMoneyTimeout(error: unknown): error is ZenMoneyTimeoutError {
	return (
		error instanceof ZenMoneyTimeoutError ||
		(error instanceof Error && error.name === "ZenMoneyTimeoutError")
	);
}

export function isZenMoneyCancelled(error: unknown): error is ZenMoneyCancelledError {
	return (
		error instanceof ZenMoneyCancelledError ||
		(error instanceof Error && error.name === "ZenMoneyCancelledError")
	);
}

export function networkTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.ZENMONEY_NETWORK_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_NETWORK_TIMEOUT_MS;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) return DEFAULT_NETWORK_TIMEOUT_MS;
	return value;
}

export function formatTimeout(timeoutMs: number): string {
	if (timeoutMs % 1000 === 0) return `${timeoutMs / 1000}s`;
	return `${timeoutMs}ms`;
}

export function zenMoneyTimeoutMessage(timeoutMs = networkTimeoutMs()): string {
	return `ZenMoney API request timed out after ${formatTimeout(timeoutMs)}.`;
}

export function onePasswordTimeoutMessage(timeoutMs = networkTimeoutMs()): string {
	return `1Password request timed out after ${formatTimeout(timeoutMs)}.`;
}

export const ZENMONEY_CANCELLED_MESSAGE = "ZenMoney request cancelled.";

type NetworkAbort = {
	signal: AbortSignal;
	reason: () => "timeout" | "cancelled" | undefined;
	dispose: () => void;
};

function createNetworkAbort(options: {
	parent?: AbortSignal;
	timeoutMs: number;
	timeoutMessage: string;
	cancelledMessage: string;
}): NetworkAbort {
	const controller = new AbortController();
	let outcome: "timeout" | "cancelled" | undefined;
	const abortOnce = (next: "timeout" | "cancelled", reason: unknown) => {
		if (controller.signal.aborted) return;
		outcome = next;
		controller.abort(reason);
	};
	const onTimeout = () => {
		abortOnce("timeout", new DOMException(options.timeoutMessage, "TimeoutError"));
	};
	const onParentAbort = () => {
		const reason = options.parent?.reason;
		abortOnce(
			"cancelled",
			reason instanceof Error ? reason : new DOMException(options.cancelledMessage, "AbortError"),
		);
	};
	const timer = setTimeout(onTimeout, options.timeoutMs);
	if (options.parent) {
		if (options.parent.aborted) onParentAbort();
		else options.parent.addEventListener("abort", onParentAbort, { once: true });
	}

	return {
		signal: controller.signal,
		reason: () => outcome,
		dispose() {
			clearTimeout(timer);
			options.parent?.removeEventListener("abort", onParentAbort);
		},
	};
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		promise.then(
			() => undefined,
			() => undefined,
		);
		return Promise.reject(abortReason(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export type NetworkDeadlineOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
	timeoutMessage?: string;
	cancelledMessage?: string;
};

// @lat: [[extension#Network timeouts and cancellation]]
export async function withNetworkDeadline<T>(
	options: NetworkDeadlineOptions,
	fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? networkTimeoutMs();
	const timeoutMessage = options.timeoutMessage ?? zenMoneyTimeoutMessage(timeoutMs);
	const cancelledMessage = options.cancelledMessage ?? ZENMONEY_CANCELLED_MESSAGE;
	const abort = createNetworkAbort({
		parent: options.signal,
		timeoutMs,
		timeoutMessage,
		cancelledMessage,
	});
	try {
		if (abort.signal.aborted) throw abortReason(abort.signal);
		return await raceSignal(fn(abort.signal), abort.signal);
	} catch (error) {
		if (abort.reason() === "timeout") throw new ZenMoneyTimeoutError(timeoutMessage);
		if (abort.reason() === "cancelled") throw new ZenMoneyCancelledError(cancelledMessage);
		throw error;
	} finally {
		abort.dispose();
	}
}

export type CommandExec = (
	file: string,
	args: string[],
	options: { signal: AbortSignal },
) => Promise<{ stdout: string; stderr?: string }>;

async function defaultExec(
	file: string,
	args: string[],
	options: { signal: AbortSignal },
): Promise<{ stdout: string; stderr?: string }> {
	return execFile(file, args, { signal: options.signal, killSignal: "SIGTERM" });
}

export async function runAbortableCommand(
	file: string,
	args: string[],
	options: NetworkDeadlineOptions & { execImpl?: CommandExec },
): Promise<{ stdout: string; stderr?: string }> {
	const execImpl = options.execImpl ?? defaultExec;
	return withNetworkDeadline(options, (signal) => execImpl(file, args, { signal }));
}
