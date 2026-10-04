import type { EvidenceEnvelope, ImageSnapshotRef } from './contracts.js';
export type EvidenceSource = 'session_snapshot' | 'selected_frozen' | 'workspace_latest' | 'assistant_history';
export type EvidenceState = 'observed' | 'reported_only' | 'unavailable';
export interface EvidenceLimits {
    maxBytes?: number;
    maxItems?: number;
    maxText?: number;
}
export interface ImageSnapshotOptions {
    sessionId: string;
    snapshotRoot: string;
    signal?: AbortSignal;
    maxBytes?: number;
}
export declare function stableJson(value: unknown): string;
export declare function hashBytes(value: Uint8Array | string): string;
export declare function byteLength(value: unknown): number;
export declare function truncateValue<T>(value: T, limits?: EvidenceLimits): {
    value: T;
    truncated: boolean;
    bytes: number;
};
export declare function makeEvidence(input: Omit<EvidenceEnvelope, 'schemaVersion' | 'timestamp' | 'capturedAt' | 'truncated' | 'incomplete'> & Partial<Pick<EvidenceEnvelope, 'timestamp' | 'capturedAt' | 'truncated' | 'incomplete'>>): EvidenceEnvelope;
export declare function assertRelativeWorkspacePath(relative: string): void;
export declare function resolveWorkspacePath(workspace: string, relative: string): string;
export declare function verifyWorkspacePath(workspace: string, relative: string, options?: {
    allowMissing?: boolean;
}): Promise<string>;
export declare function readWorkspaceText(workspace: string, relative: string, options?: {
    offset?: number;
    length?: number;
    limits?: EvidenceLimits;
    signal?: AbortSignal;
    sessionId?: string;
}): Promise<EvidenceEnvelope>;
export declare function listWorkspace(workspace: string, relative?: string, signal?: AbortSignal, sessionId?: string): Promise<EvidenceEnvelope[]>;
export declare function searchWorkspace(workspace: string, query: string, relative?: string, signal?: AbortSignal, sessionId?: string): Promise<EvidenceEnvelope[]>;
export declare function saveWorkspaceImageSnapshot(workspace: string, relative: string, options: ImageSnapshotOptions): Promise<{
    evidence: EvidenceEnvelope;
    snapshot: ImageSnapshotRef;
}>;
