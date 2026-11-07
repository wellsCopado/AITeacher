export const LABEL: string;
export const APP: string;
export function paths(home?: string): { support: string; agent: string; logs: string };
export function plist(value: unknown): string;
export function agentPlist(o: { root: string; node: string; env: Record<string, string>; logs: string }): string;
export function infoPlist(sourceHash: string): string;
export function agentEnv(env: Record<string, string | undefined>, saved?: Record<string, string>): Record<string, string>;
export function sourceHash(): string;
export function buildApp(out?: string): string;
