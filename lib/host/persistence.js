import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExplainAssistantError, SCHEMA_VERSION, assertState, createEmptyState, safeSessionId, } from './contracts.js';
/**
 * Durable per-session state with serialized updates and replace-style writes.
 * The directory is plugin-owned; callers must never pass a workspace path here.
 */
export class JsonSessionStore {
    rootDir;
    now;
    readOnlyFutureVersions;
    queues = new Map();
    migrations = new Map();
    pendingDeletes = new Set();
    closed = false;
    constructor(options) {
        if (!options.rootDir || typeof options.rootDir !== 'string')
            throw new ExplainAssistantError('PERSISTENCE_FAILED', '缺少小助手自己的保存目录，无法保存记录。');
        this.rootDir = options.rootDir;
        this.now = options.now ?? (() => new Date());
        this.readOnlyFutureVersions = options.readOnlyFutureVersions ?? true;
    }
    pathFor(sessionId) {
        return join(this.rootDir, 'sessions', safeSessionId(sessionId) + '.json');
    }
    imageDirFor(sessionId) {
        return join(this.rootDir, 'sessions', safeSessionId(sessionId), 'images');
    }
    registerMigration(fromVersion, migration) {
        if (!Number.isSafeInteger(fromVersion) || fromVersion < 0 || fromVersion >= SCHEMA_VERSION)
            throw new ExplainAssistantError('PERSISTENCE_FAILED', '记录迁移版本号无效。');
        if (this.migrations.has(fromVersion))
            throw new ExplainAssistantError('PERSISTENCE_FAILED', '记录迁移版本号重复。');
        this.migrations.set(fromVersion, migration);
    }
    async load(sessionId) {
        this.ensureOpen();
        const id = safeSessionId(sessionId);
        return this.enqueue(id, async () => {
            const file = this.pathFor(id);
            let raw;
            try {
                raw = await readFile(file, 'utf8');
            }
            catch (error) {
                if (isMissing(error))
                    return { state: createEmptyState(id, this.now().toISOString()), created: true };
                throw persistenceError('读取小助手的本地记录失败。', error);
            }
            let parsed;
            try {
                parsed = JSON.parse(raw);
                assertState(parsed, id);
            }
            catch (error) {
                if (error instanceof ExplainAssistantError && error.code === 'UNSUPPORTED_SCHEMA')
                    throw error;
                const quarantined = await this.quarantine(file);
                const state = createEmptyState(id, this.now().toISOString());
                await this.writeAtomic(state);
                return { state, created: true, recoveredCorrupt: quarantined };
            }
            const state = parsed;
            if (state.schemaVersion > SCHEMA_VERSION) {
                if (this.readOnlyFutureVersions)
                    return { state: state, created: false, readOnlyFutureVersion: state.schemaVersion };
                throw new ExplainAssistantError('UNSUPPORTED_SCHEMA', '这份小助手记录由更新版本的插件创建，当前版本无法读取。');
            }
            const migrated = this.migrate(state);
            if (migrated !== state)
                await this.writeAtomic(migrated);
            return { state: migrated, created: false };
        });
    }
    async save(state) {
        this.ensureOpen();
        const id = safeSessionId(state.sessionId);
        await this.enqueue(id, async () => {
            const existing = await this.readExistingSchema(id);
            if (existing !== undefined && existing > SCHEMA_VERSION) {
                throw new ExplainAssistantError('UNSUPPORTED_SCHEMA', '这份小助手记录由更新版本的插件创建，当前只读，不会覆盖它。');
            }
            const copy = structuredClone(state);
            copy.schemaVersion = SCHEMA_VERSION;
            assertState(copy, id);
            await this.writeAtomic(copy);
        });
    }
    async update(sessionId, mutator) {
        this.ensureOpen();
        const id = safeSessionId(sessionId);
        return this.enqueue(id, async () => {
            const loaded = await this.loadUnlocked(id);
            if (loaded.readOnlyFutureVersion !== undefined)
                throw new ExplainAssistantError('UNSUPPORTED_SCHEMA', '这份小助手记录由更新版本的插件创建，当前只读，不会覆盖它。');
            const next = structuredClone(loaded.state);
            const result = mutator(next);
            const state = result ?? next;
            state.updatedAt = this.now().toISOString();
            state.historyRevision = Math.max(0, state.historyRevision) + 1;
            await this.writeAtomic(state);
            return state;
        });
    }
    /**
     * §4/§8 F6：枚举**本插件自己**存储目录里的会话标识，供归档周期检查使用。
     *
     * 刻意不去列 DSH 的全局会话列表（没有可靠的全局接口）：只读我们自己的
     * `<rootDir>/sessions/*.json`，文件名就是会话标识（见 pathFor）。
     * 读目录失败时回空数组——清理是尽力而为，不能因为列不出来就报错或乱猜。
     */
    async listSessionIds() {
        try {
            const entries = await readdir(join(this.rootDir, 'sessions'), { withFileTypes: true });
            return entries
                .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
                .map(entry => entry.name.slice(0, -'.json'.length))
                // 隔离/损坏时留下的 .corrupt.<ts> 备份不是会话文件，天然被上面的 .json 结尾过滤掉。
                .filter(name => name.length > 0 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name));
        }
        catch {
            return [];
        }
    }
    async remove(sessionId) {
        this.ensureOpen();
        const id = safeSessionId(sessionId);
        try {
            await this.enqueue(id, async () => {
                await rm(this.pathFor(id), { force: true });
                await rm(join(this.rootDir, 'sessions', id), { recursive: true, force: true });
            });
            this.pendingDeletes.delete(id);
        }
        catch (error) {
            this.pendingDeletes.add(id);
            throw persistenceError('删除小助手的本地记录或图片快照失败。', error);
        }
    }
    async close() {
        this.closed = true;
        await Promise.allSettled([...this.queues.values()]);
    }
    /** Retry archive cleanup; failed deletes remain queued and never touch workspace files. */
    async retryPendingDeletes() {
        const ids = [...this.pendingDeletes];
        let failed = 0;
        for (const id of ids) {
            try {
                await this.remove(id);
                this.pendingDeletes.delete(id);
            }
            catch {
                failed++;
            }
        }
        return { attempted: ids.length, failed };
    }
    pendingDeleteIds() { return [...this.pendingDeletes]; }
    async loadUnlocked(id) {
        const file = this.pathFor(id);
        let raw;
        try {
            raw = await readFile(file, 'utf8');
        }
        catch (error) {
            if (isMissing(error))
                return { state: createEmptyState(id, this.now().toISOString()), created: true };
            throw persistenceError('读取小助手的本地记录失败。', error);
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
            assertState(parsed, id);
        }
        catch (error) {
            if (error instanceof ExplainAssistantError && error.code === 'UNSUPPORTED_SCHEMA')
                throw error;
            const quarantined = await this.quarantine(file);
            const state = createEmptyState(id, this.now().toISOString());
            await this.writeAtomic(state);
            return { state, created: true, recoveredCorrupt: quarantined };
        }
        const state = parsed;
        if (state.schemaVersion > SCHEMA_VERSION)
            return { state: state, created: false, readOnlyFutureVersion: state.schemaVersion };
        return { state: this.migrate(state), created: false };
    }
    migrate(input) {
        let state = input;
        while (state.schemaVersion < SCHEMA_VERSION) {
            const migration = this.migrations.get(state.schemaVersion);
            if (!migration)
                throw new ExplainAssistantError('UNSUPPORTED_SCHEMA', '这个记录版本没有对应的迁移方案，无法读取。');
            const migrated = migration(state);
            assertState(migrated, state.sessionId);
            if (migrated.schemaVersion <= state.schemaVersion)
                throw new ExplainAssistantError('PERSISTENCE_CORRUPT', '记录迁移没有推进版本号，已中止以免损坏数据。');
            state = migrated;
        }
        return state;
    }
    async writeAtomic(state) {
        const file = this.pathFor(state.sessionId);
        const dir = dirname(file);
        await mkdir(dir, { recursive: true });
        const temp = join(dir, '.' + state.sessionId + '.' + randomUUID() + '.tmp');
        try {
            await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
            await rename(temp, file);
        }
        catch (error) {
            try {
                await rm(temp, { force: true });
            }
            catch { /* preserve primary failure */ }
            throw persistenceError('保存小助手记录失败（原子写入未完成）。', error);
        }
    }
    async quarantine(file) {
        const target = file + '.corrupt.' + this.now().getTime();
        try {
            await rename(file, target);
            return target;
        }
        catch (error) {
            throw persistenceError('隔离损坏的小助手记录失败。', error);
        }
    }
    async readExistingSchema(id) {
        try {
            const raw = await readFile(this.pathFor(id), 'utf8');
            const parsed = JSON.parse(raw);
            return typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : undefined;
        }
        catch (error) {
            if (isMissing(error))
                return undefined;
            if (error instanceof SyntaxError)
                return undefined;
            throw error;
        }
    }
    enqueue(id, operation) {
        const previous = this.queues.get(id) ?? Promise.resolve();
        const current = previous.then(operation, operation);
        this.queues.set(id, current);
        // Do not create an unhandled rejected promise merely for queue cleanup.
        void current.then(() => { if (this.queues.get(id) === current)
            this.queues.delete(id); }, () => { if (this.queues.get(id) === current)
            this.queues.delete(id); });
        return current;
    }
    ensureOpen() { if (this.closed)
        throw new ExplainAssistantError('PERSISTENCE_FAILED', '保存服务已关闭。'); }
}
function isMissing(error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'; }
function persistenceError(message, cause) { return new ExplainAssistantError('PERSISTENCE_FAILED', message, { retryable: true, cause }); }
export function createPersistenceStore(rootDir) { return new JsonSessionStore({ rootDir }); }
