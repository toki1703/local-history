'use strict';

var obsidian = require('obsidian');

const VIEW_TYPE = 'local-history';
const HISTORY_ROOT = '.obsidian/plugins/local-history/history';
const DEBOUNCE_MS = 2000;
const BATCH_SIZE = 20;
const SUPPORTED_EXT = new Set(['md', 'canvas', 'base']);

const DEFAULT_SETTINGS = {
    enabled: false,
    maxEntries: 50,
    mergeWindow: 10,
    showSource: false,
    deviceAsSource: false,
    showDiffStats: true,
};

// ---- LCS diff (line-level) ----
function diffLines(a, b) {
    const al = a.split('\n'), bl = b.split('\n');
    if (al.length > 3000 || bl.length > 3000) return null;
    const m = al.length, n = bl.length;
    const dp = [];
    for (let i = 0; i <= m; i++) dp[i] = new Uint32Array(n + 1);
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = al[i-1] === bl[j-1]
                ? dp[i-1][j-1] + 1
                : dp[i-1][j] >= dp[i][j-1] ? dp[i-1][j] : dp[i][j-1];
        }
    }
    const out = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && al[i-1] === bl[j-1]) { out.unshift({ t: 'eq', s: al[i-1] }); i--; j--; }
        else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { out.unshift({ t: 'add', s: bl[j-1] }); j--; }
        else { out.unshift({ t: 'del', s: al[i-1] }); i--; }
    }
    return out;
}

// ---- Date helpers ----
function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtLabel(ts) {
    const d = new Date(ts), now = new Date();
    const yest = new Date(now); yest.setDate(yest.getDate() - 1);
    const time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    if (sameDay(d, now)) return `今日 ${time}`;
    if (sameDay(d, yest)) return `昨日 ${time}`;
    return d.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' }) + ' ' + time;
}
function fmtGroup(ts) {
    const d = new Date(ts), now = new Date();
    const yest = new Date(now); yest.setDate(yest.getDate() - 1);
    if (sameDay(d, now)) return '今日';
    if (sameDay(d, yest)) return '昨日';
    const days = Math.floor((now - d) / 86400000);
    if (days < 7) return `${days}日前`;
    return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ---- Source config ----
const SOURCE = {
    local:          { label: 'ローカル',           icon: 'clock',    sub: 'ローカル' },
    fileRecovery:   { label: 'ファイルリカバリー',  icon: 'history', sub: 'ファイルリカバリー' },
    sync:           { label: 'Obsidian Sync',       icon: 'cloud',    sub: 'Sync' },
};

// ===== Diff Modal =====
class DiffModal extends obsidian.Modal {
    constructor(app, file, ts, sourceKey, snapContent, curContent, device) {
        super(app);
        this.file = file; this.ts = ts; this.sourceKey = sourceKey;
        this.snapContent = snapContent; this.curContent = curContent;
        this.device = device;
        this.modalEl.addClass('lh-modal');
    }

    onOpen() {
        Object.assign(this.modalEl.style, { width: 'min(92vw, 860px)', maxHeight: '88vh', overflow: 'hidden' });
        Object.assign(this.contentEl.style, { display: 'flex', flexDirection: 'column', overflow: 'hidden', maxHeight: 'calc(88vh - 2rem)' });

        const { contentEl } = this;
        contentEl.addClass('lh-diff-content');

        // Header
        const hdr = contentEl.createDiv('lh-dm-hdr');
        hdr.createSpan({ cls: 'lh-dm-fname', text: this.file.name });
        const meta = hdr.createDiv('lh-dm-meta');
        meta.createSpan({ cls: 'lh-dm-ts', text: fmtLabel(this.ts) });
        const srcLabel = SOURCE[this.sourceKey]?.label ?? this.sourceKey;
        meta.createSpan({ cls: `lh-dm-src lh-src-${this.sourceKey}`, text: srcLabel });
        if (this.device) {
            meta.createSpan({ cls: 'lh-dm-device', text: this.device });
        }

        // Action buttons
        const btnGroup = hdr.createDiv('lh-dm-btn-group');

        // Copy button
        const copyBtn = btnGroup.createEl('button', { cls: 'clickable-icon lh-icon-btn', attr: { 'aria-label': 'コピー' } });
        obsidian.setIcon(copyBtn, 'copy');
        copyBtn.addEventListener('click', async () => {
            await navigator.clipboard.writeText(this.snapContent);
            new obsidian.Notice('クリップボードにコピーしました');
        });

        // Restore button (only for local and file-recovery)
        if (this.sourceKey !== 'sync') {
            const btn = btnGroup.createEl('button', { cls: 'mod-cta lh-dm-restore', text: 'この版に戻す' });
            btn.addEventListener('click', async () => {
                await this.app.vault.modify(this.file, this.snapContent);
                new obsidian.Notice(`${this.file.name} をこの版に戻しました`);
                this.close();
            });
        }

        // Diff body
        const body = contentEl.createDiv('lh-dm-body');
        const diff = diffLines(this.snapContent, this.curContent);

        const renderLines = (lines) => {
            const pre = body.createEl('pre', { cls: 'lh-dm-pre' });
            for (const d of lines) {
                const row = pre.createDiv({ cls: `lh-dm-row lh-dm-row-${d.t}` });
                row.createSpan({ cls: 'lh-dm-pfx', text: d.t === 'add' ? '+' : d.t === 'del' ? '-' : ' ' });
                row.createSpan({ cls: 'lh-dm-code', text: d.s });
            }
        };

        if (!diff) {
            // Too large to diff — show snapshot content as plain text
            renderLines(this.snapContent.split('\n').map(s => ({ t: 'eq', s })));
            return;
        }

        const added = diff.filter(d => d.t === 'add').length;
        const removed = diff.filter(d => d.t === 'del').length;
        if (added || removed) {
            const stats = body.createDiv('lh-dm-stats');
            if (added) stats.createSpan({ cls: 'lh-stat-add', text: `+${added}` });
            if (removed) stats.createSpan({ cls: 'lh-stat-del', text: `-${removed}` });
        }

        renderLines(diff);
    }

    onClose() { this.contentEl.empty(); }
}

// ===== History View =====
class LocalHistoryView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this._renderGen = 0;
        this._refreshTimer = null;
        // Lazy-load state (reset on each render)
        this._allItems = [];
        this._renderedCount = 0;
        this._lastGroup = null;
        this._currentGroupEl = null;
        this._listEl = null;
        this._sentinel = null;
        this._observer = null;
        this._syncCursor = null;
        this._syncHasMore = false;
        this._activeFile = null;
        this._loadingMore = false;
    }

    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return 'ローカル履歴'; }
    getIcon() { return 'history'; }

    async onOpen() { await this.render(); }
    async onClose() {
        clearTimeout(this._refreshTimer);
        this._observer?.disconnect();
    }

    // ---- render ----
    async render() {
        const gen = ++this._renderGen;
        this._observer?.disconnect();
        this._observer = null;
        this._loadingMore = false;

        const root = this.containerEl.children[1];
        root.empty();
        root.addClass('lh-view');

        // Header
        const hdr = root.createDiv('lh-hdr');
        hdr.createDiv('lh-hdr-label').createSpan({ text: 'ローカル履歴' });
        const btnGroup = hdr.createDiv('lh-btn-group');
        if (this.plugin.settings.enabled) {
            const camBtn = btnGroup.createEl('button', { cls: 'clickable-icon lh-icon-btn', attr: { 'aria-label': '今すぐ保存' } });
            obsidian.setIcon(camBtn, 'camera');
            camBtn.addEventListener('click', async () => {
                const f = this.app.workspace.getActiveFile();
                if (!f || !SUPPORTED_EXT.has(f.extension)) return;
                await this.plugin._snapForce(f);
                new obsidian.Notice('スナップショットを保存しました');
            });
        }
        const refreshBtn = btnGroup.createEl('button', { cls: 'clickable-icon lh-icon-btn', attr: { 'aria-label': '更新' } });
        obsidian.setIcon(refreshBtn, 'refresh-cw');
        refreshBtn.addEventListener('click', () => this.render());

        // Active file
        const active = this.app.workspace.getActiveFile();
        if (!active || !SUPPORTED_EXT.has(active.extension)) {
            root.createDiv({ cls: 'lh-empty', text: 'ファイルを開いてください\n(.md / .canvas / .base)' });
            return;
        }
        root.createDiv({ cls: 'lh-file-bar', text: active.name });

        // Load local + FR + first Sync page in parallel
        const [localSnaps, frItems, syncPage] = await Promise.all([
            this.plugin.getSnapshots(active.path),
            this.plugin.loadFileRecoveryItems(active.path),
            this.plugin.loadSyncFirstPage(active.path),
        ]);
        if (gen !== this._renderGen) return;

        // Initialize lazy-load state
        this._activeFile = active;
        this._allItems = [
            ...localSnaps.map(s => ({ source: 'local', ts: s.ts, data: s })),
            ...frItems.map(s => ({ source: 'fileRecovery', ts: s.ts, data: s })),
            ...syncPage.items.map(v => ({ source: 'sync', ts: v.ts, data: v })),
        ].sort((a, b) => b.ts - a.ts);
        this._syncCursor = syncPage.cursor;
        this._syncHasMore = syncPage.more;
        this._renderedCount = 0;
        this._lastGroup = null;
        this._currentGroupEl = null;

        if (this._allItems.length === 0 && !this._syncHasMore) {
            root.createDiv({ cls: 'lh-empty', text: '履歴がまだありません\nファイルを編集すると自動保存されます' });
            return;
        }

        // Create list + sentinel
        const list = root.createDiv('lh-list');
        this._listEl = list;
        this._sentinel = document.createElement('div');
        this._sentinel.className = 'lh-sentinel';
        list.appendChild(this._sentinel);

        // Render first batch (awaited: stats are embedded before DOM is shown)
        await this._renderBatch(gen);

        // Observe sentinel for lazy load
        if (this._renderedCount < this._allItems.length || this._syncHasMore) {
            this._observer = new IntersectionObserver(
                entries => { if (entries[0].isIntersecting) this._loadMore(gen); },
                { rootMargin: '200px' }
            );
            this._observer.observe(this._sentinel);
        } else {
            this._sentinel.remove();
            this._sentinel = null;
        }
    }

    // ---- batch rendering ----
    async _renderBatch(gen) {
        if (gen !== this._renderGen) return;
        const batch = this._allItems.slice(this._renderedCount, this._renderedCount + BATCH_SIZE);
        if (batch.length === 0) return;

        // Pre-compute diff stats for the batch before touching the DOM
        let statsMap = new Map(); // index → { added, removed } | null
        if (this.plugin.settings.showDiffStats) {
            const curContent = await this.app.vault.read(this._activeFile).catch(() => null);
            if (gen !== this._renderGen) return;
            if (curContent) {
                await Promise.allSettled(batch.map(async (entry, i) => {
                    try {
                        const snap = await this.plugin.fetchContent(this._activeFile, entry);
                        if (gen !== this._renderGen) return;
                        const d = diffLines(snap, curContent);
                        statsMap.set(i, d ? {
                            added:   d.filter(x => x.t === 'add').length,
                            removed: d.filter(x => x.t === 'del').length,
                        } : null);
                    } catch { statsMap.set(i, null); }
                }));
            }
            if (gen !== this._renderGen) return;
        }

        // Render items with stats already computed
        for (let i = 0; i < batch.length; i++) {
            this._appendItem(batch[i], statsMap.get(i) ?? null);
        }
        this._renderedCount += batch.length;
    }

    // ---- build a detached item element ----
    _buildItemEl(entry, stats = null) {
        const active = this._activeFile;
        const cfg = SOURCE[entry.source] ?? SOURCE.local;
        const item = document.createElement('div');
        item.className = 'lh-item';

        const icon = item.createDiv(`lh-item-icon lh-icon-${entry.source}`);
        obsidian.setIcon(icon, cfg.icon);

        const info = item.createDiv('lh-item-info');
        const nameRow = info.createDiv('lh-item-name');
        nameRow.createSpan({ text: active.name });
        item._lhEntry = entry;
        item._lhNameRow = nameRow;
        if (this.plugin.settings.showDiffStats && stats) {
            const { added, removed } = stats;
            if (added || removed) {
                const statsSpan = nameRow.createSpan({ cls: 'lh-item-stats' });
                if (added)   statsSpan.createSpan({ cls: 'lh-stat-add', text: `+${added}` });
                if (removed) statsSpan.createSpan({ cls: 'lh-stat-del', text: `-${removed}` });
            }
        }
        const deviceName = entry.source === 'sync' ? entry.data.device : null;
        const sourceLabel = (deviceName && this.plugin.settings.deviceAsSource) ? deviceName : cfg.sub;
        const subText = this.plugin.settings.showSource
            ? `${fmtLabel(entry.ts)} · ${sourceLabel}`
            : fmtLabel(entry.ts);
        const subRow = info.createDiv('lh-item-sub');
        subRow.createSpan({ cls: 'lh-item-sub-text', text: subText });
        if (deviceName && !this.plugin.settings.deviceAsSource) {
            subRow.createSpan({ cls: 'lh-item-device', text: deviceName });
        }

        item.addEventListener('click', async () => {
            try {
                const snapContent = await this.plugin.fetchContent(active, entry);
                const curContent = await this.app.vault.read(active);
                new DiffModal(this.app, active, entry.ts, entry.source, snapContent, curContent, entry.data.device).open();
            } catch (e) {
                console.error('[LocalHistory] content fetch failed', e);
                new obsidian.Notice('スナップショットを読み込めませんでした');
            }
        });

        item.addEventListener('contextmenu', event => {
            const menu = new obsidian.Menu();
            if (entry.source !== 'sync') {
                menu.addItem(i => i.setTitle('この版に復元').setIcon('history').onClick(async () => {
                    try {
                        const snapContent = await this.plugin.fetchContent(active, entry);
                        await this.app.vault.modify(active, snapContent);
                        new obsidian.Notice(`${active.name} をこの版に戻しました`);
                    } catch (e) {
                        console.error('[LocalHistory] restore failed', e);
                        new obsidian.Notice('復元に失敗しました');
                    }
                }));
            }
            if (entry.source === 'local') {
                menu.addItem(i => i.setTitle('削除').setIcon('trash').onClick(async () => {
                    try {
                        await this.app.vault.adapter.remove(entry.data.path);
                        this.refresh();
                    } catch (e) {
                        console.error('[LocalHistory] delete failed', e);
                        new obsidian.Notice('削除に失敗しました');
                    }
                }));
            }
            menu.showAtMouseEvent(event);
        });

        return item;
    }

    // ---- append single item (downward batch rendering) ----
    _appendItem(entry, stats) {
        const g = fmtGroup(entry.ts);
        if (g !== this._lastGroup) {
            const grpEl = document.createElement('div');
            grpEl.className = 'lh-group';
            grpEl.createDiv({ cls: 'lh-group-label', text: g });
            this._listEl.insertBefore(grpEl, this._sentinel);
            this._lastGroup = g;
            this._currentGroupEl = grpEl;
        }
        this._currentGroupEl.appendChild(this._buildItemEl(entry, stats));
    }

    // ---- load more on scroll ----
    async _loadMore(gen) {
        if (gen !== this._renderGen || this._loadingMore) return;
        this._loadingMore = true;
        this._sentinel?.classList.add('lh-sentinel--loading');
        try {
            if (this._renderedCount < this._allItems.length) {
                // Buffered items still waiting — render next batch
                await this._renderBatch(gen);
            } else if (this._syncHasMore) {
                // Fetch next Sync page
                const syncPage = await this.plugin.loadSyncNextPage(
                    this._activeFile.path, this._syncCursor
                );
                if (gen !== this._renderGen) return;

                const newItems = syncPage.items.map(v => ({ source: 'sync', ts: v.ts, data: v }));
                // Merge into sorted list (new sync items are older, so usually append)
                for (const item of newItems) {
                    const idx = this._allItems.findIndex(x => x.ts < item.ts);
                    if (idx === -1) this._allItems.push(item);
                    else this._allItems.splice(idx, 0, item);
                }
                this._syncCursor = syncPage.cursor;
                this._syncHasMore = syncPage.more;
                await this._renderBatch(gen);
            }

            // Remove sentinel when truly exhausted
            if (this._renderedCount >= this._allItems.length && !this._syncHasMore) {
                this._observer?.disconnect();
                this._observer = null;
                this._sentinel?.remove();
                this._sentinel = null;
            }
        } finally {
            this._loadingMore = false;
            this._sentinel?.classList.remove('lh-sentinel--loading');
        }
    }

    // ---- update diff stats on all rendered items ----
    async _updateAllStats(gen) {
        if (!this.plugin.settings.showDiffStats || !this._listEl || !this._activeFile) return;
        const curContent = await this.app.vault.read(this._activeFile).catch(() => null);
        if (!curContent || gen !== this._renderGen) return;
        const items = [...this._listEl.querySelectorAll('.lh-item')].filter(el => el._lhEntry);
        await Promise.allSettled(items.map(async el => {
            try {
                const snap = await this.plugin.fetchContent(this._activeFile, el._lhEntry);
                if (gen !== this._renderGen) return;
                const d = diffLines(snap, curContent);
                const added   = d ? d.filter(x => x.t === 'add').length : 0;
                const removed = d ? d.filter(x => x.t === 'del').length : 0;
                const existing = el._lhNameRow.querySelector('.lh-item-stats');
                if (existing) existing.remove();
                if (added || removed) {
                    const statsSpan = el._lhNameRow.createSpan({ cls: 'lh-item-stats' });
                    if (added)   statsSpan.createSpan({ cls: 'lh-stat-add', text: `+${added}` });
                    if (removed) statsSpan.createSpan({ cls: 'lh-stat-del', text: `-${removed}` });
                }
            } catch {}
        }));
    }

    // ---- apply a new local snapshot incrementally ----
    async applyLocalSnap(filePath, newTs, mergedTs) {
        if (!this._activeFile || this._activeFile.path !== filePath) return;
        if (!this._listEl) { this.refresh(); return; }
        const gen = this._renderGen;

        // Remove merged item from buffer and DOM
        if (mergedTs !== null) {
            const idx = this._allItems.findIndex(x => x.source === 'local' && x.ts === mergedTs);
            if (idx !== -1) { this._allItems.splice(idx, 1); this._renderedCount = Math.max(0, this._renderedCount - 1); }
            const oldEl = [...this._listEl.querySelectorAll('.lh-item')]
                .find(el => el._lhEntry?.source === 'local' && el._lhEntry?.ts === mergedTs);
            if (oldEl) {
                const grpEl = oldEl.closest('.lh-group');
                oldEl.remove();
                if (grpEl && grpEl.querySelectorAll('.lh-item').length === 0) grpEl.remove();
            }
        }

        // Prepend new local item
        const newEntry = { source: 'local', ts: newTs, data: { ts: newTs, path: `${HISTORY_ROOT}/${filePath}/${newTs}` } };
        this._allItems = [newEntry, ...this._allItems].sort((a, b) => b.ts - a.ts);
        this._renderedCount += 1;

        // Compute stats for new item
        let newStats = null;
        if (this.plugin.settings.showDiffStats) {
            try {
                const curContent = await this.app.vault.read(this._activeFile).catch(() => null);
                if (curContent && gen === this._renderGen) {
                    const snap = await this.plugin.fetchContent(this._activeFile, newEntry);
                    if (gen === this._renderGen) {
                        const d = diffLines(snap, curContent);
                        if (d) newStats = { added: d.filter(x => x.t === 'add').length, removed: d.filter(x => x.t === 'del').length };
                    }
                }
            } catch {}
        }
        if (gen !== this._renderGen) return;

        // Insert into DOM at top of group
        const groupMap = new Map();
        for (const grpEl of this._listEl.querySelectorAll('.lh-group')) {
            const label = grpEl.querySelector('.lh-group-label')?.textContent;
            if (label) groupMap.set(label, { groupEl: grpEl, insertAfter: grpEl.querySelector('.lh-group-label') });
        }
        const g = fmtGroup(newTs);
        if (!groupMap.has(g)) {
            const grpEl = document.createElement('div');
            grpEl.className = 'lh-group';
            grpEl.createDiv({ cls: 'lh-group-label', text: g });
            this._listEl.insertBefore(grpEl, this._listEl.firstChild);
            groupMap.set(g, { groupEl: grpEl, insertAfter: grpEl.querySelector('.lh-group-label') });
        }
        const state = groupMap.get(g);
        const item = this._buildItemEl(newEntry, newStats);
        state.insertAfter.after(item);

        // Update diff stats on all existing rendered items
        await this._updateAllStats(gen);
    }

    // ---- incremental prepend of new sync items ----
    async checkNewSyncItems(filePath) {
        if (!this._activeFile || this._activeFile.path !== filePath) return;
        if (!this._listEl) return;
        const gen = this._renderGen;
        try {
            const page = await this.plugin.loadSyncFirstPage(filePath);
            if (gen !== this._renderGen) return;
            const knownTs = new Set(this._allItems.filter(x => x.source === 'sync').map(x => x.ts));
            const newItems = page.items
                .filter(v => !knownTs.has(v.ts))
                .map(v => ({ source: 'sync', ts: v.ts, data: v }))
                .sort((a, b) => b.ts - a.ts); // newest first
            if (newItems.length === 0) return;

            // Update internal buffer
            this._allItems = [...newItems, ...this._allItems].sort((a, b) => b.ts - a.ts);
            this._renderedCount += newItems.length;

            // Pre-compute diff stats (mirrors _renderBatch logic)
            const statsMap = new Map();
            if (this.plugin.settings.showDiffStats) {
                const curContent = await this.app.vault.read(this._activeFile).catch(() => null);
                if (gen !== this._renderGen) return;
                if (curContent) {
                    await Promise.allSettled(newItems.map(async (entry, i) => {
                        try {
                            const snap = await this.plugin.fetchContent(this._activeFile, entry);
                            if (gen !== this._renderGen) return;
                            const d = diffLines(snap, curContent);
                            statsMap.set(i, d ? {
                                added:   d.filter(x => x.t === 'add').length,
                                removed: d.filter(x => x.t === 'del').length,
                            } : null);
                        } catch { statsMap.set(i, null); }
                    }));
                }
                if (gen !== this._renderGen) return;
            }

            // Build map of existing group elements (label → { groupEl, insertAfter })
            const groupMap = new Map();
            for (const grpEl of this._listEl.querySelectorAll('.lh-group')) {
                const label = grpEl.querySelector('.lh-group-label')?.textContent;
                if (label) groupMap.set(label, { groupEl: grpEl, insertAfter: grpEl.querySelector('.lh-group-label') });
            }

            // Insert each new item at the top of its group
            let lastNewGroupEl = null;
            for (let i = 0; i < newItems.length; i++) {
                const entry = newItems[i];
                const g = fmtGroup(entry.ts);
                if (!groupMap.has(g)) {
                    const grpEl = document.createElement('div');
                    grpEl.className = 'lh-group';
                    grpEl.createDiv({ cls: 'lh-group-label', text: g });
                    const ref = lastNewGroupEl ? lastNewGroupEl.nextSibling : this._listEl.firstChild;
                    this._listEl.insertBefore(grpEl, ref);
                    lastNewGroupEl = grpEl;
                    groupMap.set(g, { groupEl: grpEl, insertAfter: grpEl.querySelector('.lh-group-label') });
                }
                const state = groupMap.get(g);
                const item = this._buildItemEl(entry, statsMap.get(i) ?? null);
                state.insertAfter.after(item);
                state.insertAfter = item;
            }
        } catch (e) {
            console.warn('[LocalHistory] checkNewSyncItems:', e);
        }
    }

    // ---- debounced refresh ----
    refresh() {
        clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => this.render(), 50);
    }
}

// ===== Settings Tab =====
class LocalHistorySettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new obsidian.Setting(containerEl)
            .setName('ローカル履歴を有効にする')
            .setDesc('オフにすると自動スナップショットの作成を停止します。既存の履歴は残ります。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enabled)
                .onChange(async value => {
                    this.plugin.settings.enabled = value;
                    await this.plugin.saveSettings();
                })
            );

        containerEl.createEl('h2', { text: '表示' });

        new obsidian.Setting(containerEl)
            .setName('ソースを表示')
            .setDesc('各エントリの時刻の左にソース名（ローカル・ファイルリカバリー・Sync）を表示します。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showSource)
                .onChange(async value => {
                    this.plugin.settings.showSource = value;
                    await this.plugin.saveSettings();
                })
            );

        new obsidian.Setting(containerEl)
            .setName('差分統計を一覧に表示')
            .setDesc('各エントリに +追加行 -削除行 の統計を表示します。有効にするとすべてのエントリの内容を読み込むため、エントリ数が多い場合は表示が遅くなることがあります。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showDiffStats)
                .onChange(async value => {
                    this.plugin.settings.showDiffStats = value;
                    await this.plugin.saveSettings();
                })
            );

        new obsidian.Setting(containerEl)
            .setName('Sync: デバイス名をソースとして表示')
            .setDesc('オンにすると Sync エントリの時刻左に「Sync」の代わりにデバイス名を表示します。オフにするとデバイス名はファイル名横のバッジで表示されます。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.deviceAsSource)
                .onChange(async value => {
                    this.plugin.settings.deviceAsSource = value;
                    await this.plugin.saveSettings();
                })
            );

        containerEl.createEl('h2', { text: 'ローカル保存' });

        new obsidian.Setting(containerEl)
            .setName('Max File Entries')
            .setDesc('ファイルごとのローカル ファイル履歴エントリの最大数を制御します。ローカル ファイル履歴エントリ数がファイルのこの値を超えると、最古のエントリが破棄されます。')
            .addText(text => text
                .setPlaceholder('50')
                .setValue(String(this.plugin.settings.maxEntries))
                .onChange(async value => {
                    const n = parseInt(value, 10);
                    if (!isNaN(n) && n >= 1) {
                        this.plugin.settings.maxEntries = n;
                        await this.plugin.saveSettings();
                    }
                })
            );

        new obsidian.Setting(containerEl)
            .setName('Merge Window')
            .setDesc('ローカル ファイル履歴の最後のエントリが追加されるエントリに置き換えられる間隔を秒単位で構成します。これにより、自動保存が有効になっている場合など、追加されるエントリの総数を減らすことができます。この設定は、元のソースが同じエントリにのみ適用されます。この設定を変更しても、既存のローカル ファイル履歴エントリには影響しません。0 を設定するとマージを無効にします。')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '0';
                text.setPlaceholder('60')
                    .setValue(String(this.plugin.settings.mergeWindow))
                    .onChange(async value => {
                        const n = parseInt(value, 10);
                        if (!isNaN(n) && n >= 0) {
                            this.plugin.settings.mergeWindow = n;
                            await this.plugin.saveSettings();
                        }
                    });
            })
            .addExtraButton(btn => btn
                .setIcon('reset')
                .setTooltip('デフォルトに戻す (10秒)')
                .onClick(async () => {
                    this.plugin.settings.mergeWindow = DEFAULT_SETTINGS.mergeWindow;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );
    }
}

// ===== Plugin =====
class LocalHistoryPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();
        this._timers = new Map();
        this._syncTimers = new Map();
        this.registerView(VIEW_TYPE, leaf => new LocalHistoryView(leaf, this));
        this.addSettingTab(new LocalHistorySettingTab(this.app, this));

        this.registerEvent(this.app.vault.on('modify', file => {
            if (!(file instanceof obsidian.TFile) || !SUPPORTED_EXT.has(file.extension)) return;
            clearTimeout(this._timers.get(file.path));
            this._timers.set(file.path, setTimeout(() => {
                this._timers.delete(file.path);
                this._snap(file);
            }, DEBOUNCE_MS));
            clearTimeout(this._syncTimers.get(file.path));
            this._syncTimers.set(file.path, setTimeout(() => {
                this._syncTimers.delete(file.path);
                this._checkSyncViews(file);
            }, 2500));
        }));

        this.registerEvent(this.app.workspace.on('file-open', () => {
            this._refreshViews();
        }));

        this.addCommand({
            id: 'open-local-history',
            name: 'ローカル履歴パネルを開く',
            callback: () => this._openPanel(),
        });

        this.addRibbonIcon('history', 'ローカル履歴', () => this._openPanel());
    }

    onunload() {
        for (const t of this._timers.values()) clearTimeout(t);
        for (const t of this._syncTimers.values()) clearTimeout(t);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async _openPanel() {
        const ws = this.app.workspace;
        const leaves = ws.getLeavesOfType(VIEW_TYPE);
        if (leaves.length) { ws.revealLeaf(leaves[0]); return; }
        const leaf = ws.getRightLeaf(false) ?? ws.getRightLeaf(true);
        await leaf.setViewState({ type: VIEW_TYPE });
        ws.revealLeaf(leaf);
    }

    _refreshViews() {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            if (leaf.view instanceof LocalHistoryView) leaf.view.refresh();
        }
    }

    _notifyLocalSnap(file, newTs, mergedTs) {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            if (leaf.view instanceof LocalHistoryView) leaf.view.applyLocalSnap(file.path, newTs, mergedTs);
        }
    }

    _checkSyncViews(file) {
        if (!this.isSyncAvailable()) return;
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            if (leaf.view instanceof LocalHistoryView) leaf.view.checkNewSyncItems(file.path);
        }
    }

    // ---- Source availability ----
    isFileRecoveryAvailable() {
        try {
            const fr = this.app.internalPlugins.plugins['file-recovery'];
            return !!(fr?.instance?.db);
        } catch { return false; }
    }

    isSyncAvailable() {
        try {
            const sync = this.app.internalPlugins.plugins.sync;
            return !!(sync?.instance?.getHistory);
        } catch { return false; }
    }

    // ---- Fetch content (dispatch by source) ----
    async fetchContent(file, entry) {
        switch (entry.source) {
            case 'local':
                return this.getSnapshotContent(file.path, entry.data.ts);
            case 'fileRecovery':
                return entry.data.content;
            case 'sync':
                return this._fetchSyncContent(entry.data.uid);
            default:
                throw new Error(`Unknown source: ${entry.source}`);
        }
    }

    async _fetchSyncContent(uid) {
        const sync = this.app.internalPlugins.plugins.sync;
        const raw = await sync.instance.getContentForVersion(uid);
        return new TextDecoder('utf-8').decode(new Uint8Array(raw));
    }

    // ---- File Recovery ----
    async loadFileRecoveryItems(filePath) {
        try {
            const fr = this.app.internalPlugins.plugins['file-recovery'];
            if (!fr?.instance?.db) return [];
            const all = await fr.instance.db
                .transaction('backups', 'readonly')
                .store.index('path')
                .getAll(filePath);
            return all.map(item => ({ ts: item.ts, content: item.data }));
        } catch (e) {
            console.warn('[LocalHistory] File Recovery:', e);
            return [];
        }
    }

    // ---- Obsidian Sync ----
    // getHistory(path, cursorUid) -> { items: [{ ts(ms), uid, size, device }], more: bool }
    _parseSyncPage(res) {
        const raw = Array.isArray(res?.items) ? res.items : [];
        const items = raw
            .filter(v => v.uid != null && v.ts)
            .map(v => ({ ts: v.ts, uid: v.uid, size: v.size, device: v.device }));
        const cursor = items.length > 0 ? items[items.length - 1].uid : null;
        return { items, more: !!res?.more, cursor };
    }

    async loadSyncFirstPage(filePath) {
        try {
            const sync = this.app.internalPlugins.plugins.sync;
            if (!sync?.instance?.getHistory) return { items: [], more: false, cursor: null };
            return this._parseSyncPage(await sync.instance.getHistory(filePath, null));
        } catch (e) {
            console.warn('[LocalHistory] Sync first page:', e);
            return { items: [], more: false, cursor: null };
        }
    }

    async loadSyncNextPage(filePath, cursor) {
        try {
            const sync = this.app.internalPlugins.plugins.sync;
            return this._parseSyncPage(await sync.instance.getHistory(filePath, cursor));
        } catch (e) {
            console.warn('[LocalHistory] Sync next page:', e);
            return { items: [], more: false, cursor: null };
        }
    }

    // ---- Local snapshots ----
    async _snap(file) {
        if (!this.settings.enabled) return;
        try {
            const content = await this.app.vault.read(file);
            const snaps = await this.getSnapshots(file.path);
            const sorted = snaps.sort((a, b) => b.ts - a.ts);
            let mergedTs = null;
            if (sorted.length) {
                const last = sorted[0];
                if (await this.getSnapshotContent(file.path, last.ts) === content) return;
                // Merge window: replace last entry if within window
                if (this.settings.mergeWindow > 0 && Date.now() - last.ts < this.settings.mergeWindow * 1000) {
                    try { await this.app.vault.adapter.remove(last.path); mergedTs = last.ts; } catch {}
                }
            }
            const newTs = await this._writeSnap(file.path, content);
            this._notifyLocalSnap(file, newTs, mergedTs);
        } catch (e) { console.error('[LocalHistory]', e); }
    }

    async _snapForce(file) {
        try {
            const content = await this.app.vault.read(file);
            await this._writeSnap(file.path, content);
            this._refreshViews();
        } catch (e) { console.error('[LocalHistory]', e); }
    }

    async _writeSnap(filePath, content) {
        const ts = Date.now();
        const dir = `${HISTORY_ROOT}/${filePath}`;
        await this._mkdirp(dir);
        await this.app.vault.adapter.write(`${dir}/${ts}`, content);
        await this._prune(filePath);
        return ts;
    }

    async _mkdirp(path) {
        const a = this.app.vault.adapter;
        const parts = path.split('/');
        let cur = '';
        for (const p of parts) {
            cur = cur ? `${cur}/${p}` : p;
            if (!(await a.exists(cur))) { try { await a.mkdir(cur); } catch {} }
        }
    }

    async getSnapshots(filePath) {
        const dir = `${HISTORY_ROOT}/${filePath}`;
        const a = this.app.vault.adapter;
        if (!(await a.exists(dir))) return [];
        try {
            const { files } = await a.list(dir);
            return files.map(f => {
                const ts = parseInt(f.replace(/\\/g, '/').split('/').pop(), 10);
                return isNaN(ts) ? null : { ts, path: f };
            }).filter(Boolean);
        } catch { return []; }
    }

    async getSnapshotContent(filePath, ts) {
        return this.app.vault.adapter.read(`${HISTORY_ROOT}/${filePath}/${ts}`);
    }

    async _prune(filePath) {
        const snaps = await this.getSnapshots(filePath);
        if (snaps.length <= this.settings.maxEntries) return;
        const old = snaps.sort((a, b) => a.ts - b.ts).slice(0, snaps.length - this.settings.maxEntries);
        for (const s of old) { try { await this.app.vault.adapter.remove(s.path); } catch {} }
    }
}

module.exports = LocalHistoryPlugin;
