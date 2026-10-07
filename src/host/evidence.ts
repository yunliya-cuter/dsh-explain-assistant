import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EvidenceEnvelope, ImageSnapshotRef } from './contracts.js';

export type EvidenceSource = 'session_snapshot' | 'selected_frozen' | 'workspace_latest' | 'assistant_history';
export type EvidenceState = 'observed' | 'reported_only' | 'unavailable';
export interface EvidenceLimits { maxBytes?: number; maxItems?: number; maxText?: number; }
export interface ImageSnapshotOptions { sessionId: string; snapshotRoot: string; signal?: AbortSignal; maxBytes?: number; }

const DEFAULTS = { maxBytes: 128 * 1024, maxItems: 200, maxText: 64 * 1024, imageBytes: 10 * 1024 * 1024 } as const;

export function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort().map(k => JSON.stringify(k) + ':' + stableJson(object[k])).join(',') + '}';
}
export function hashBytes(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
export function byteLength(value: unknown): number { return Buffer.byteLength(typeof value === 'string' ? value : stableJson(value), 'utf8'); }

export function truncateValue<T>(value: T, limits: EvidenceLimits = {}): { value: T; truncated: boolean; bytes: number } {
  const max = limits.maxBytes ?? DEFAULTS.maxBytes;
  const encoded = stableJson(value); const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes <= max) return { value, truncated: false, bytes };
  if (typeof value === 'string') {
    const maxText = limits.maxText ?? max;
    let end = Math.min(value.length, maxText);
    while (end > 0 && Buffer.byteLength(JSON.stringify(value.slice(0, end)), 'utf8') > max) end--;
    return { value: value.slice(0, end) as T, truncated: true, bytes };
  }
  if (Array.isArray(value)) return { value: value.slice(0, limits.maxItems ?? DEFAULTS.maxItems) as T, truncated: true, bytes };
  return { value: { truncated: true, availableBytes: bytes, sentBytes: max } as T, truncated: true, bytes };
}

export function makeEvidence(input: Omit<EvidenceEnvelope, 'schemaVersion'|'timestamp'|'capturedAt'|'truncated'|'incomplete'> & Partial<Pick<EvidenceEnvelope,'timestamp'|'capturedAt'|'truncated'|'incomplete'>>): EvidenceEnvelope {
  const now = new Date().toISOString();
  return { schemaVersion: 1, timestamp: input.timestamp ?? now, capturedAt: input.capturedAt ?? now, truncated: input.truncated ?? false, incomplete: input.incomplete ?? false, ...input };
}

export function assertRelativeWorkspacePath(relative: string): void {
  // 空字符（NUL）必须在这里挡住。
  //
  // 这一句原本写的是 includes('\\0') —— 在**源码**里那是「反斜杠 + 0」两个普通字符，
  // 不是空字符；实测（node 复现）含真正 NUL 的路径**能通过**这道检查。
  // 危险度低（后面还有 resolveWorkspacePath 的前缀校验与 ensureContained 的 realpath 兜底），
  // 但既然本意就是挡空字符，就该挡真货。
  if (typeof relative !== 'string' || !relative || relative === '.' && relative.length !== 1 || path.isAbsolute(relative) || relative.includes('\u0000')) throw new Error('WORKSPACE_PATH_INVALID');
  const parts = relative.split(/[\\\\/]+/u);
  if (parts.some(part => part === '..')) throw new Error('WORKSPACE_PATH_INVALID');
}

export function resolveWorkspacePath(workspace: string, relative: string): string {
  assertRelativeWorkspacePath(relative); const root = path.resolve(workspace); const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('WORKSPACE_PATH_ESCAPE'); return target;
}

async function ensureContained(root: string, target: string): Promise<{ realRoot: string; realTarget: string }> {
  const realRoot = await fs.realpath(root);
  if (path.resolve(target) === path.resolve(root)) return { realRoot, realTarget: realRoot };
  const relative = path.relative(root, target);
  const parent = await fs.realpath(path.dirname(target));
  const candidate = path.join(parent, path.basename(target));
  let realTarget: string;
  try { realTarget = await fs.realpath(target); }
  catch (error) {
    if ((error as { code?: string })?.code !== 'ENOENT') throw error;
    realTarget = candidate;
  }
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (!inside(parent) || !inside(realTarget) || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('WORKSPACE_PATH_ESCAPE');
  return { realRoot, realTarget };
}

export async function verifyWorkspacePath(workspace: string, relative: string, options: { allowMissing?: boolean } = {}): Promise<string> {
  const target = resolveWorkspacePath(workspace, relative); await ensureContained(workspace, target);
  if (!options.allowMissing) await fs.stat(target);
  return target;
}

export async function readWorkspaceText(workspace: string, relative: string, options: { offset?: number; length?: number; limits?: EvidenceLimits; signal?: AbortSignal; sessionId?: string } = {}): Promise<EvidenceEnvelope> {
  const target = await verifyWorkspacePath(workspace, relative); const statBefore = await fs.stat(target); if (!statBefore.isFile()) throw new Error('WORKSPACE_NOT_FILE');
  const bytes = await fs.readFile(target); options.signal?.throwIfAborted();
  const statAfter = await fs.stat(target); const stable = statBefore.size === statAfter.size && statBefore.mtimeMs === statAfter.mtimeMs;
  const text = bytes.toString('utf8'); const offset = Math.max(0, options.offset ?? 0); const end = options.length === undefined ? text.length : offset + options.length; const sliced = text.slice(offset, end); const clipped = truncateValue(sliced, options.limits);
  return makeEvidence({ sessionId: options.sessionId ?? '', kind: 'file', title: relative, text: clipped.value as string, source: 'workspace_latest', evidenceState: stable ? 'observed' : 'unavailable', version: hashBytes(bytes), metadata: { path: relative, bytes: bytes.byteLength, offset, length: sliced.length }, truncated: clipped.truncated, incomplete: !stable });
}

export async function listWorkspace(workspace: string, relative = '.', signal?: AbortSignal, sessionId = ''): Promise<EvidenceEnvelope[]> {
  const target = await verifyWorkspacePath(workspace, relative); const entries = await fs.readdir(target, { withFileTypes: true }); signal?.throwIfAborted();
  return entries.slice(0, DEFAULTS.maxItems).map(entry => makeEvidence({ sessionId, kind: 'file', title: entry.name, summary: entry.isDirectory() ? 'directory' : 'file', source: 'workspace_latest', evidenceState: 'observed', metadata: { path: path.relative(workspace, path.join(target, entry.name)), directory: entry.isDirectory() }}));
}

export async function searchWorkspace(workspace: string, query: string, relative = '.', signal?: AbortSignal, sessionId = ''): Promise<EvidenceEnvelope[]> {
  if (!query || query.length > 512) throw new Error('SEARCH_QUERY_INVALID'); const root = await verifyWorkspacePath(workspace, relative); const results: EvidenceEnvelope[] = [];
  async function walk(dir: string): Promise<void> { signal?.throwIfAborted(); if (results.length >= DEFAULTS.maxItems) return; for (const item of await fs.readdir(dir, { withFileTypes: true })) { signal?.throwIfAborted(); if (item.name === 'node_modules' || item.name.startsWith('.git')) continue; const full = path.join(dir, item.name); if (item.isDirectory()) { try { await ensureContained(workspace, full); await walk(full); } catch { /* skip escaped symlink */ } } else { try { await ensureContained(workspace, full); const bytes = await fs.readFile(full); const text = bytes.toString('utf8'); const index = text.indexOf(query); if (index >= 0) results.push(makeEvidence({ sessionId, kind: 'file', title: path.relative(workspace, full), text: text.slice(Math.max(0,index-160), index+query.length+160), source: 'workspace_latest', evidenceState: 'observed', version: hashBytes(bytes), metadata: { path: path.relative(workspace, full), index }})); } catch { /* binary/unreadable/escaped files are skipped */ } } } }
  await walk(root); return results;
}

export async function saveWorkspaceImageSnapshot(workspace: string, relative: string, options: ImageSnapshotOptions): Promise<{ evidence: EvidenceEnvelope; snapshot: ImageSnapshotRef }> {
  const target = await verifyWorkspacePath(workspace, relative); const before = await fs.stat(target); if (!before.isFile()) throw new Error('WORKSPACE_NOT_FILE');
  if (before.size > (options.maxBytes ?? DEFAULTS.imageBytes)) throw new Error('IMAGE_TOO_LARGE');
  const bytes = await fs.readFile(target); options.signal?.throwIfAborted(); const after = await fs.stat(target);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('IMAGE_CHANGED_DURING_READ');
  const sha256 = hashBytes(bytes); const safeId = options.sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.resolve(options.snapshotRoot, 'sessions', safeId, 'images'); await fs.mkdir(dir, { recursive: true });
  const id = sha256; const filename = id + path.extname(relative).toLowerCase(); const finalPath = path.join(dir, filename); const tempPath = path.join(dir, '.' + filename + '.' + Date.now() + '.tmp');
  await fs.writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 }); try { await fs.rename(tempPath, finalPath); } catch (error) { await fs.rm(tempPath, { force: true }); if ((error as { code?: string })?.code !== 'EEXIST') throw error; }
  const ref: ImageSnapshotRef = { id, relativePath: path.relative(options.snapshotRoot, finalPath), mediaType: mediaTypeFor(relative), bytes: bytes.byteLength, sha256, capturedAt: new Date().toISOString() };
  return { snapshot: ref, evidence: makeEvidence({ sessionId: options.sessionId, kind: 'image', title: relative, source: 'workspace_latest', evidenceState: 'observed', version: sha256, metadata: { snapshot: ref } }) };
}

function mediaTypeFor(file: string): string { switch (path.extname(file).toLowerCase()) { case '.png': return 'image/png'; case '.jpg': case '.jpeg': return 'image/jpeg'; case '.gif': return 'image/gif'; case '.webp': return 'image/webp'; case '.bmp': return 'image/bmp'; default: return 'application/octet-stream'; } }
