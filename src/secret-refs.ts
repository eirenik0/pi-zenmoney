import { Data } from "effect";

import {
	type CommandExec,
	clampTimeoutMs,
	isZenMoneyCancelled,
	isZenMoneyTimeout,
	networkTimeoutMs,
	onePasswordTimeoutMessage,
	runAbortableCommand,
	ZENMONEY_CANCELLED_MESSAGE,
} from "./network.ts";

function trimMatchingQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function extractOnePasswordReference(rawValue: string): string | undefined {
	const value = rawValue.trim();
	if (!value) return undefined;
	if (value.startsWith("op://")) return value;

	const wrappedCommand = value.match(/^\$\(\s*op\s+read\s+(.+?)\s*\)$/i);
	if (wrappedCommand) {
		const target = trimMatchingQuotes(wrappedCommand[1].trim());
		return target.startsWith("op://") ? target : undefined;
	}

	const plainCommand = value.match(/^op\s+read\s+(.+)$/i);
	if (plainCommand) {
		const target = trimMatchingQuotes(plainCommand[1].trim());
		return target.startsWith("op://") ? target : undefined;
	}

	return undefined;
}

export function looksLikeOnePasswordSecretReference(rawValue: string): boolean {
	return Boolean(extractOnePasswordReference(rawValue));
}

class SecretReferenceError extends Data.TaggedError("SecretReferenceError")<{
	message: string;
}> {}

function toSecretReferenceError(
	label: string,
	reference: string,
	error: unknown,
): SecretReferenceError {
	const message = error instanceof Error ? error.message : String(error);
	return new SecretReferenceError({
		message: `Failed to resolve ${label} from 1Password reference ${reference}. Make sure the 1Password CLI is installed and authenticated. ${message}`,
	});
}

export type SecretReferenceOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
	execImpl?: CommandExec;
};

export async function resolveSecretReference(
	rawValue: string,
	label = "secret",
	options?: SecretReferenceOptions,
): Promise<string> {
	const reference = extractOnePasswordReference(rawValue);
	if (!reference) return rawValue;

	try {
		const timeoutMs = clampTimeoutMs(options?.timeoutMs ?? networkTimeoutMs());
		const { stdout } = await runAbortableCommand("op", ["read", reference], {
			signal: options?.signal,
			timeoutMs,
			timeoutMessage: onePasswordTimeoutMessage(timeoutMs),
			cancelledMessage: ZENMONEY_CANCELLED_MESSAGE,
			execImpl: options?.execImpl,
		});
		const secret = stdout.trim();
		if (!secret) {
			throw new SecretReferenceError({
				message: `1Password reference ${reference} resolved to an empty value.`,
			});
		}
		return secret;
	} catch (error) {
		if (
			isZenMoneyCancelled(error) ||
			isZenMoneyTimeout(error) ||
			error instanceof SecretReferenceError
		) {
			throw error;
		}
		throw toSecretReferenceError(label, reference, error);
	}
}
