import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { ZenMoneyEntityPolicy, ZenMoneySnapshot, ZenMoneyWorkspaceConfig } from "./types.ts";

export function normalizeZenMoneyEntity(entity?: string): string {
	const normalized = (entity ?? "default")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
	return normalized || "default";
}

export function zenMoneyWorkspaceRoot(baseDir = ""): string {
	return join(baseDir, ".pi", "zenmoney");
}

export function zenMoneyConfigPath(baseDir = ""): string {
	return join(zenMoneyWorkspaceRoot(baseDir), "config.json");
}

export function zenMoneyEntitiesRoot(baseDir = ""): string {
	return join(zenMoneyWorkspaceRoot(baseDir), "entities");
}

export function zenMoneyEntityDir(entity: string, baseDir = ""): string {
	return join(zenMoneyEntitiesRoot(baseDir), normalizeZenMoneyEntity(entity));
}

export function zenMoneyEntityPolicyPath(entity: string, baseDir = ""): string {
	return join(zenMoneyEntityDir(entity, baseDir), "policy.json");
}

export function zenMoneyEntityRegistryPath(entity: string, baseDir = ""): string {
	return join(zenMoneyEntityDir(entity, baseDir), "registry.json");
}

export function zenMoneyEntitySnapshotsDir(entity: string, baseDir = ""): string {
	return join(zenMoneyEntityDir(entity, baseDir), "snapshots");
}

export function normalizeZenMoneySnapshotPath(pathValue: string, label: string): string {
	const trimmed = pathValue.trim();
	if (!trimmed) throw new Error(`${label} must not be empty.`);
	if (isAbsolute(trimmed)) {
		throw new Error(`${label} must be relative to the working files folder.`);
	}
	const normalized = normalize(trimmed).replaceAll("\\", "/");
	if (!normalized || normalized === ".") throw new Error(`${label} must not be empty.`);
	if (normalized.split("/").some((segment) => segment === "..")) {
		throw new Error(`${label} must not escape the working files folder.`);
	}
	return normalized;
}

async function readJsonObject<T>(path: string): Promise<T | undefined> {
	try {
		const text = await fs.readFile(path, "utf8");
		return JSON.parse(text) as T;
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeJsonObject(path: string, value: unknown): Promise<string> {
	await fs.mkdir(dirname(path), { recursive: true });
	await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	return path;
}

export async function readZenMoneyWorkspaceConfig(cwd: string): Promise<ZenMoneyWorkspaceConfig> {
	return (await readJsonObject<ZenMoneyWorkspaceConfig>(zenMoneyConfigPath(cwd))) ?? {};
}

export async function writeZenMoneyWorkspaceConfig(
	cwd: string,
	config: ZenMoneyWorkspaceConfig,
): Promise<string> {
	return writeJsonObject(zenMoneyConfigPath(cwd), config);
}

export async function listZenMoneyEntities(cwd: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(zenMoneyEntitiesRoot(cwd), { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw error;
	}
}

export async function readZenMoneyEntityPolicy(
	cwd: string,
	entity: string,
): Promise<ZenMoneyEntityPolicy> {
	return (await readJsonObject<ZenMoneyEntityPolicy>(zenMoneyEntityPolicyPath(entity, cwd))) ?? {};
}

export async function writeZenMoneyEntityPolicy(
	cwd: string,
	entity: string,
	policy: ZenMoneyEntityPolicy,
): Promise<string> {
	return writeJsonObject(zenMoneyEntityPolicyPath(entity, cwd), policy);
}

export async function readZenMoneyRegistry(
	cwd: string,
	entity: string,
): Promise<ZenMoneySnapshot | undefined> {
	return readJsonObject<ZenMoneySnapshot>(zenMoneyEntityRegistryPath(entity, cwd));
}

export async function writeZenMoneyRegistry(
	cwd: string,
	entity: string,
	registry: ZenMoneySnapshot,
): Promise<string> {
	return writeJsonObject(zenMoneyEntityRegistryPath(entity, cwd), registry);
}
