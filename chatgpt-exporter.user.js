// ==UserScript==
// @name         ChatGPT 对话迁移工具
// @description  批量导出 ChatGPT 对话记录，支持 JSON/Markdown/HTML 格式，自动打包为 ZIP 下载。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 配置与全局变量 Config & globals ---
    const BASE_DELAY = 600;
    const JITTER = 400;
    const PAGE_LIMIT = 100;
    let accessToken = null;
    let capturedWorkspaceIds = new Set();
    let stopNetworkIntercept = () => {};
    let interceptStopped = false;

    // 导出格式配置 Export formats
    let exportFormats = { json: true, markdown: true, html: true };

    // 安全恢复拦截，防止长期劫持 fetch 影响正常聊天
    function maybeStopIntercept() {
        if (interceptStopped) return;
        interceptStopped = true;
        try { stopNetworkIntercept(); } catch (_) {}
    }

    // --- 网络拦截与信息捕获 Network intercept (minimal & safe) ---
    (function interceptNetwork() {
        const rawFetch = window.fetch;
        const rawOpen = XMLHttpRequest.prototype.open;
        stopNetworkIntercept = () => {
            window.fetch = rawFetch;
            XMLHttpRequest.prototype.open = rawOpen;
        };
        function isSameOriginResource(res) {
            try {
                const url = typeof res === 'string' ? new URL(res, location.href) : new URL(res.url, location.href);
                return url.origin === location.origin;
            } catch (_) { return true; }
        }
        function getHeaderValueFromAny(hLike, name) {
            if (!hLike) return null;
            try {
                if (hLike instanceof Headers) return hLike.get(name) || hLike.get(name.toLowerCase());
                if (Array.isArray(hLike)) {
                    const found = hLike.find(p => Array.isArray(p) && (String(p[0]).toLowerCase() === name.toLowerCase()));
                    return found ? found[1] : null;
                }
                if (typeof hLike === 'object') return hLike[name] || hLike[name.toLowerCase()] || null;
                if (typeof hLike === 'string' && name.toLowerCase() === 'authorization') return hLike;
            } catch (_) {}
            return null;
        }
        window.fetch = function(resource, options) {
            try {
                if (isSameOriginResource(resource)) {
                    const headerCandidates = [];
                    if (resource && typeof Request !== 'undefined' && resource instanceof Request) {
                        headerCandidates.push(resource.headers);
                    }
                    if (options && options.headers) {
                        headerCandidates.push(options.headers);
                    }
                    for (const hc of headerCandidates) {
                        tryCaptureToken(getHeaderValueFromAny(hc, 'Authorization'));
                        const wid = getHeaderValueFromAny(hc, 'ChatGPT-Account-Id');
                        if (wid && !capturedWorkspaceIds.has(wid)) {
                            capturedWorkspaceIds.add(wid);
                            try { console.log('🎯 [Fetch] 捕获 Workspace ID:', wid); } catch(_){}
                        }
                    }
                }
            } catch (_) {}
            return rawFetch.apply(this, arguments);
        };

        XMLHttpRequest.prototype.open = function () {
            this.addEventListener('readystatechange', () => {
                if (this.readyState === 4) {
                    try {
                        const auth = this.getRequestHeader && this.getRequestHeader('Authorization');
                        tryCaptureToken(auth);
                        const id = this.getRequestHeader && this.getRequestHeader('ChatGPT-Account-Id');
                        if (id && !capturedWorkspaceIds.has(id)) {
                            capturedWorkspaceIds.add(id);
                            try { console.log('🎯 [XHR] 捕获 Workspace ID:', id); } catch(_){}
                        }
                    } catch (_) {}
                }
            });
            return rawOpen.apply(this, arguments);
        };
    })();

    function tryCaptureToken(headerLike) {
        let h = null;
        try {
            if (!headerLike) { h = null; }
            else if (typeof headerLike === 'string') { h = headerLike; }
            else if (headerLike instanceof Headers) { h = headerLike.get('Authorization') || headerLike.get('authorization'); }
            else if (Array.isArray(headerLike)) {
                const found = headerLike.find(e => Array.isArray(e) && String(e[0]).toLowerCase() === 'authorization');
                h = found ? found[1] : null;
            } else if (typeof headerLike === 'object') {
                h = headerLike.Authorization || headerLike.authorization || null;
            }
        } catch (_) {}
        if (h && /^Bearer\s+(.+)/i.test(h)) {
            const token = h.replace(/^Bearer\s+/i, '');
            if (token && token.toLowerCase() !== 'dummy') {
                accessToken = token;
                maybeStopIntercept();
            }
        }
    }

    async function ensureAccessToken() {
        if (accessToken) return accessToken;
        try {
            const session = await (await fetch('/api/auth/session?unstable_client=true')).json();
            if (session.accessToken) {
                accessToken = session.accessToken;
                maybeStopIntercept();
                return accessToken;
            }
        } catch (_) {}
        alert('无法获取 Access Token。请刷新页面或打开任意一个对话后再试。');
        return null;
    }

    // --- 辅助函数 Helpers ---
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const jitter = () => BASE_DELAY + Math.random() * JITTER;
    const sanitizeFilename = (name) => name.replace(/[\/\\?%*:|"<>]/g, '-').trim();

    function getOaiDeviceId() {
        const cookieString = document.cookie;
        const match = cookieString.match(/oai-did=([^;]+)/);
        return match ? match[1] : null;
    }

    async function fetchWithRetry(input, init = {}, retries = 3) {
        let attempt = 0;
        while (true) {
            try {
                const res = await fetch(input, init);
                if (res.ok) return res;
                if (attempt < retries && (res.status === 429 || res.status >= 500)) {
                    await sleep(BASE_DELAY * Math.pow(2, attempt) + Math.random() * JITTER);
                    attempt++;
                    continue;
                }
                return res;
            } catch (err) {
                if (attempt < retries) {
                    await sleep(BASE_DELAY * Math.pow(2, attempt) + Math.random() * JITTER);
                    attempt++;
                    continue;
                }
                throw err;
            }
        }
    }

    function buildHeaders(workspaceId) {
        const headers = { 'Authorization': `Bearer ${accessToken}` };
        const did = getOaiDeviceId();
        if (did) headers['oai-device-id'] = did;
        if (workspaceId) headers['ChatGPT-Account-Id'] = workspaceId;
        return headers;
    }

    function generateUniqueFilename(convData, extension = 'json') {
        const convId = String(convData.conversation_id || '').trim();
        const idPart = convId || Math.random().toString(36).slice(2, 10);
        const ts = convData.create_time ? new Date(convData.create_time * 1000) : new Date();
        const tsPart = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;
        let baseName = convData.title;
        if (!baseName || baseName.trim().toLowerCase() === 'new chat') {
            baseName = 'Untitled Conversation';
        }
        return `${sanitizeFilename(baseName)}_${idPart}_${tsPart}.${extension}`;
    }

    function downloadFile(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    // --- Conversation parsing (full mapping sorted by time) ---
    function parseConversation(convData) {
        const mapping = convData.mapping || {};
        const msgs = [];
        for (const key in mapping) {
            const node = mapping[key];
            const message = node && node.message;
            if (!message || !message.content || !message.content.parts) continue;
            const role = message.author && message.author.role;
            if (role !== 'user' && role !== 'assistant') continue;
            const content = message.content.parts.join('\n');
            if (!content || !content.trim()) continue;
            msgs.push({
                role,
                content,
                createTime: message.create_time,
                model: (message.metadata && message.metadata.model_slug) || ''
            });
        }
        msgs.sort((a, b) => (a.createTime || 0) - (b.createTime || 0));
        return {
            title: convData.title || 'Untitled Conversation',
            createTime: convData.create_time,
            updateTime: convData.update_time,
            conversationId: convData.conversation_id,
            model: convData.default_model_slug || '',
            messages: msgs
        };
    }

    // --- Markdown 转换函数 Markdown converter ---
    function convertToMarkdown(convData) {
        const parsed = parseConversation(convData);
        let md = '';
        md += `# ${parsed.title}\n\n`;
        md += `**Conversation ID:** \`${parsed.conversationId}\`\n\n`;
        if (parsed.model) md += `**Model:** ${parsed.model}\n\n`;
        if (parsed.createTime) md += `**Created:** ${new Date(parsed.createTime * 1000).toLocaleString()}\n\n`;
        if (parsed.updateTime) md += `**Last Updated:** ${new Date(parsed.updateTime * 1000).toLocaleString()}\n\n`;
        md += `---\n\n`;
        parsed.messages.forEach((msg, index) => {
            const roleLabel = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
            const timestamp = msg.createTime ? ` (${new Date(msg.createTime * 1000).toLocaleString()})` : '';
            md += `## ${roleLabel}${timestamp}\n\n`;
            md += `${msg.content}\n\n`;
            if (index < parsed.messages.length - 1) md += `---\n\n`;
        });
        return md;
    }

    // --- HTML 转换函数 HTML converter (code-block safe) ---
    function convertToHTML(convData) {
        const parsed = parseConversation(convData);
        const escapeHtml = (text) => { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; };
        const renderContent = (content) => {
            let html = escapeHtml(content);
            const blocks = [];
            html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
                const idx = blocks.length;
                const blockHtml = `<pre><code class="language-${lang || 'text'}">${code.trim()}</code></pre>`;
                blocks.push(blockHtml);
                return `[[[CODE_BLOCK_${idx}]]]`;
            });
            html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
            html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
            html = html.replace(/\n/g, '<br>');
            html = html.replace(/\[\[\[CODE_BLOCK_(\d+)]]]/g, (_, i) => blocks[Number(i)]);
            return html;
        };

        let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(parsed.title)}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            line-height: 1.6; color: #333; background: #f5f5f5; padding: 20px;
        }
        .container { max-width: 900px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 30px; }
        .header h1 { font-size: 28px; margin-bottom: 15px; }
        .metadata { font-size: 14px; opacity: 0.95; }
        .metadata-item { margin: 5px 0; }
        .conversation { padding: 20px; }
        .message { margin-bottom: 25px; padding: 20px; border-radius: 8px; position: relative; }
        .message.user { background: #e3f2fd; border-left: 4px solid #2196f3; }
        .message.assistant { background: #f3e5f5; border-left: 4px solid #9c27b0; }
        .message-header { display: flex; align-items: center; margin-bottom: 12px; font-weight: 600; font-size: 16px; }
        .message.user .message-header { color: #1976d2; }
        .message.assistant .message-header { color: #7b1fa2; }
        .role-icon { font-size: 20px; margin-right: 8px; }
        .timestamp { font-size: 12px; color: #666; margin-left: auto; font-weight: normal; }
        .message-content { font-size: 15px; line-height: 1.7; }
        pre { background: #2d2d2d; color: #f8f8f2; padding: 15px; border-radius: 6px; overflow-x: auto; margin: 10px 0; }
        code { font-family: "Consolas", "Monaco", "Courier New", monospace; font-size: 14px; }
        .message-content > code { background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 3px; font-size: 13px; }
        a { color: #1976d2; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .footer { text-align: center; padding: 20px; color: #999; font-size: 13px; border-top: 1px solid #eee; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${escapeHtml(parsed.title)}</h1>
            <div class="metadata">
                <div class="metadata-item"><strong>Conversation ID:</strong> ${escapeHtml(parsed.conversationId)}</div>
                ${parsed.model ? `<div class="metadata-item"><strong>Model:</strong> ${escapeHtml(parsed.model)}</div>` : ''}
                ${parsed.createTime ? `<div class="metadata-item"><strong>Created:</strong> ${new Date(parsed.createTime * 1000).toLocaleString()}</div>` : ''}
                ${parsed.updateTime ? `<div class="metadata-item"><strong>Last Updated:</strong> ${new Date(parsed.updateTime * 1000).toLocaleString()}</div>` : ''}
            </div>
        </div>
        <div class="conversation">`;

        parsed.messages.forEach((msg) => {
            const roleClass = msg.role;
            const roleIcon = msg.role === 'user' ? '👤' : '🤖';
            const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
            const timestamp = msg.createTime ? new Date(msg.createTime * 1000).toLocaleString() : '';
            html += `
            <div class="message ${roleClass}">
                <div class="message-header">
                    <span class="role-icon">${roleIcon}</span>
                    <span>${roleLabel}</span>
                    ${timestamp ? `<span class="timestamp">${timestamp}</span>` : ''}
                </div>
                <div class="message-content">
                    ${renderContent(msg.content)}
                </div>
            </div>`;
        });

        html += `
        </div>
        <div class="footer">由 ChatGPT 对话迁移工具导出</div>
    </div>
</body>
</html>`;
        return html;
    }

    // --- 导出流程 Export process ---
    async function startExportProcess(mode, workspaceId, formats, selectedConversations = []) {
        const btn = document.getElementById('gpt-rescue-btn');
        btn.disabled = true;
        if (!await ensureAccessToken()) { btn.disabled = false; btn.textContent = '导出对话'; return; }
        try {
            const zip = new JSZip();
            if (!selectedConversations.length) throw new Error('没有需要导出的对话。');
            const rootConvs = selectedConversations.filter(c => !c.projectId);
            const projectMap = {};
            selectedConversations.filter(c => c.projectId).forEach(c => {
                if (!projectMap[c.projectId]) projectMap[c.projectId] = { title: c.projectTitle || c.projectId, items: [] };
                projectMap[c.projectId].items.push(c);
            });

            btn.textContent = '📂 导出项目外对话…';
            for (let i = 0; i < rootConvs.length; i++) {
                const conv = rootConvs[i];
                btn.textContent = `📥 根目录 (${i + 1}/${rootConvs.length})`;
                const convData = await getConversation(conv.id, workspaceId);
                if (formats.json) zip.file(generateUniqueFilename(convData, 'json'), JSON.stringify(convData, null, 2));
                if (formats.markdown) zip.file(generateUniqueFilename(convData, 'md'), convertToMarkdown(convData));
                if (formats.html) zip.file(generateUniqueFilename(convData, 'html'), convertToHTML(convData));
                await sleep(jitter());
            }

            const projectEntries = Object.entries(projectMap);
            for (const [projectId, detail] of projectEntries) {
                const folderName = sanitizeFilename(detail.title || projectId);
                const projectFolder = zip.folder(folderName);
                btn.textContent = `📂 项目: ${folderName}`;
                const list = detail.items;
                for (let i = 0; i < list.length; i++) {
                    const conv = list[i];
                    btn.textContent = `📥 ${folderName.substring(0,10)}... (${i + 1}/${list.length})`;
                    const convData = await getConversation(conv.id, workspaceId);
                    if (formats.json) projectFolder.file(generateUniqueFilename(convData, 'json'), JSON.stringify(convData, null, 2));
                    if (formats.markdown) projectFolder.file(generateUniqueFilename(convData, 'md'), convertToMarkdown(convData));
                    if (formats.html) projectFolder.file(generateUniqueFilename(convData, 'html'), convertToHTML(convData));
                    await sleep(jitter());
                }
            }
            btn.textContent = '📦 生成 ZIP 文件…';
            const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
            const date = new Date().toISOString().slice(0, 10);
            const filename = mode === 'team' ? `chatgpt_team_backup_${workspaceId}_${date}.zip` : `chatgpt_personal_backup_${date}.zip`;
            downloadFile(blob, filename);
            alert(`✅ 导出完成！`);
            btn.textContent = '✅ 完成';
        } catch (e) {
            console.error("导出过程中发生严重错误", e);
            alert(`导出失败: ${e.message}。详情请查看控制台（F12 -> Console）。`);
            btn.textContent = '⚠️ 出错';
        } finally {
            setTimeout(() => { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> 导出对话'; }, 3000);
        }
    }

    // --- API 调用函数 API helpers ---
    async function getProjects(workspaceId) {
        if (!workspaceId) return [];
        const r = await fetchWithRetry(`/backend-api/gizmos/snorlax/sidebar`, { headers: buildHeaders(workspaceId) });
        if (!r.ok) { console.warn(`获取项目(Gizmo)列表失败 (${r.status})`); return []; }
        const data = await r.json();
        const projects = [];
        data.items?.forEach(item => { if (item?.gizmo?.id && item?.gizmo?.display?.name) { projects.push({ id: item.gizmo.id, title: item.gizmo.display.name }); } });
        return projects;
    }

    async function collectIds(btn, workspaceId, gizmoId) {
        const all = new Set();
        const headers = buildHeaders(workspaceId);
        if (gizmoId) {
            let cursor = '0';
            do {
                const r = await fetchWithRetry(`/backend-api/gizmos/${gizmoId}/conversations?cursor=${cursor}`, { headers });
                if (!r.ok) throw new Error(`列举项目对话列表失败 (${r.status})`);
                const j = await r.json();
                j.items?.forEach(it => all.add(it.id));
                cursor = j.cursor;
                await sleep(jitter());
            } while (cursor);
        } else {
            for (const is_archived of [false, true]) {
                let offset = 0, has_more = true, page = 0;
                do {
                    btn.textContent = `📂 项目外对话 (${is_archived ? '归档' : '活跃'} 第${++page}页)`;
                    const r = await fetchWithRetry(`/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated${is_archived ? '&is_archived=true' : ''}`, { headers });
                    if (!r.ok) throw new Error(`列举项目外对话列表失败 (${r.status})`);
                    const j = await r.json();
                    if (j.items && j.items.length > 0) {
                        j.items.forEach(it => all.add(it.id));
                        has_more = j.items.length === PAGE_LIMIT;
                        offset += j.items.length;
                    } else { has_more = false; }
                    await sleep(jitter());
                } while (has_more);
            }
        }
        return Array.from(all);
    }

    async function listConversationMetas(mode, workspaceId, progressCb = () => {}) {
        if (!await ensureAccessToken()) throw new Error('无法获取 Access Token，无法列出对话。');
        const headers = buildHeaders(workspaceId);
        const all = [];
        const seen = new Set();
        const pushItem = (item, projectInfo = {}) => {
            if (!item || !item.id || seen.has(item.id)) return;
            seen.add(item.id);
            all.push({
                id: item.id,
                title: item.title || '未命名对话',
                projectId: projectInfo.id || null,
                projectTitle: projectInfo.title || ''
            });
        };

        // 根目录对话
        progressCb('加载项目外对话列表…');
        for (const is_archived of [false, true]) {
            let offset = 0, has_more = true, page = 0;
            do {
                progressCb(`加载项目外对话 ${is_archived ? '归档' : '活跃'} 第 ${++page} 页…`);
                const r = await fetchWithRetry(`/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated${is_archived ? '&is_archived=true' : ''}`, { headers });
                if (!r.ok) throw new Error(`列举项目外对话列表失败 (${r.status})`);
                const j = await r.json();
                if (j.items && j.items.length > 0) {
                    j.items.forEach(it => pushItem(it));
                    has_more = j.items.length === PAGE_LIMIT;
                    offset += j.items.length;
                } else { has_more = false; }
                await sleep(jitter());
            } while (has_more);
        }

        // 项目内对话（仅团队空间有）
        if (workspaceId) {
            const projects = await getProjects(workspaceId);
            for (const project of projects) {
                let cursor = '0';
                do {
                    progressCb(`加载项目 ${project.title}…`);
                    const r = await fetchWithRetry(`/backend-api/gizmos/${project.id}/conversations?cursor=${cursor}`, { headers });
                    if (!r.ok) throw new Error(`列举项目 ${project.title} 对话列表失败 (${r.status})`);
                    const j = await r.json();
                    j.items?.forEach(it => pushItem(it, { id: project.id, title: project.title }));
                    cursor = j.cursor;
                    await sleep(jitter());
                } while (cursor);
            }
        }

        progressCb(`已加载 ${all.length} 个对话，可勾选导出。`);
        return all;
    }

    async function getConversation(id, workspaceId) {
        const headers = buildHeaders(workspaceId);
        const r = await fetchWithRetry(`/backend-api/conversation/${id}`, { headers });
        if (!r.ok) throw new Error(`获取对话详情失败 conv ${id} (${r.status})`);
        const j = await r.json();
        j.__fetched_at = new Date().toISOString();
        return j;
    }

    // --- 工作空间自动检测 Workspace detection ---
    function detectAllWorkspaceIds() {
        const foundIds = new Set(capturedWorkspaceIds);
        try {
            const data = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}');
            const accounts = data?.props?.pageProps?.user?.accounts;
            if (accounts) { Object.values(accounts).forEach(acc => { if (acc?.account?.id) foundIds.add(acc.account.id); }); }
        } catch (e) {}
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;
                if (key.includes('account') || key.includes('workspace')) {
                    const value = localStorage.getItem(key);
                    if (!value) continue;
                    if (/^ws-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                        foundIds.add(value.replace(/"/g, ''));
                    } else if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                        foundIds.add(value.replace(/"/g, ''));
                    }
                }
            }
        } catch(e) {}
        try { console.log('🔍 检测到以下 Workspace IDs:', Array.from(foundIds)); } catch(_){}
        return Array.from(foundIds);
    }

    // --- 对话框UI函数 Export dialog ---
    function showExportDialog() {
        if (document.getElementById('export-dialog-overlay')) return;

        // 注入样式
        if (!document.getElementById('export-dialog-style')) {
            const style = document.createElement('style');
            style.id = 'export-dialog-style';
            style.textContent = `
                @keyframes edFadeIn { from { opacity:0; } to { opacity:1; } }
                @keyframes edSlideUp { from { opacity:0; transform:translateY(30px) scale(0.96); } to { opacity:1; transform:translateY(0) scale(1); } }
                #export-dialog-overlay {
                    position:fixed; top:0; left:0; width:100%; height:100%;
                    background:rgba(0,0,0,0.5); backdrop-filter:blur(4px);
                    z-index:99998; display:flex; align-items:center; justify-content:center;
                    animation: edFadeIn 0.2s ease;
                }
                .ed-dialog {
                    background:#fff; border-radius:16px; padding:28px 32px; width:480px;
                    box-shadow:0 20px 60px rgba(0,0,0,0.2); font-family:-apple-system,"Microsoft YaHei","PingFang SC",sans-serif;
                    color:#1a1a1a; animation: edSlideUp 0.3s ease;
                    max-height:85vh; overflow-y:auto;
                }
                .ed-title {
                    font-size:20px; font-weight:700; margin:0 0 6px 0;
                    display:flex; align-items:center; gap:8px;
                }
                .ed-title svg { width:22px; height:22px; fill:#10a37f; }
                .ed-subtitle { font-size:13px; color:#888; margin-bottom:20px; }
                .ed-section { margin-bottom:18px; }
                .ed-section-label { font-size:12px; font-weight:600; color:#999; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; }
                .ed-format-group { display:flex; gap:8px; }
                .ed-format-card {
                    flex:1; padding:10px 0; border:2px solid #e8e8e8; border-radius:10px;
                    text-align:center; cursor:pointer; transition:all 0.2s ease; user-select:none;
                }
                .ed-format-card:hover { border-color:#c0c0c0; background:#fafafa; }
                .ed-format-card.active { border-color:#10a37f; background:#f0faf6; }
                .ed-format-card .ed-fc-icon { font-size:20px; margin-bottom:2px; }
                .ed-format-card .ed-fc-name { font-size:13px; font-weight:600; color:#333; }
                .ed-tab-group { display:flex; background:#f3f3f3; border-radius:10px; padding:3px; }
                .ed-tab {
                    flex:1; padding:8px 0; text-align:center; border-radius:8px; font-size:13px;
                    font-weight:500; cursor:pointer; transition:all 0.2s ease; color:#666; user-select:none;
                }
                .ed-tab.active { background:#fff; color:#1a1a1a; box-shadow:0 1px 4px rgba(0,0,0,0.08); font-weight:600; }
                .ed-tab:hover:not(.active) { color:#333; }
                .ed-team-area {
                    margin-top:12px; padding:12px; background:#f8f9fa; border-radius:10px;
                    display:none; animation: edFadeIn 0.2s ease;
                }
                .ed-team-area.show { display:block; }
                .ed-team-hint { font-size:12px; color:#888; margin-bottom:6px; }
                .ed-team-detected { font-size:12px; color:#10a37f; font-weight:500; margin-bottom:8px; word-break:break-all; }
                .ed-input {
                    width:100%; padding:10px 12px; border:1.5px solid #e0e0e0; border-radius:8px;
                    font-size:13px; outline:none; transition:border-color 0.2s; box-sizing:border-box;
                }
                .ed-input:focus { border-color:#10a37f; }
                .ed-input::placeholder { color:#bbb; }
                .ed-conv-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
                .ed-conv-status { font-size:12px; color:#888; }
                .ed-conv-actions { display:flex; align-items:center; gap:10px; padding-right:16px; }
                .ed-btn-refresh {
                    padding:0; border:none; background:transparent; cursor:pointer;
                    font-size:12px; color:#10a37f; transition:all 0.15s;
                }
                .ed-btn-refresh:hover { color:#0d8c6d; text-decoration:underline; }
                .ed-select-all-label { font-size:12px; color:#666; display:flex; align-items:center; gap:4px; cursor:pointer; }
                .ed-conv-list {
                    max-height:200px; overflow-y:auto; border:1.5px solid #eee; border-radius:10px;
                    padding:4px; background:#fafafa; font-size:13px;
                }
                .ed-conv-list::-webkit-scrollbar { width:5px; }
                .ed-conv-list::-webkit-scrollbar-thumb { background:#ddd; border-radius:3px; }
                .ed-conv-list label {
                    display:flex; align-items:center; justify-content:space-between;
                    padding:7px 10px; border-radius:6px; transition:background 0.15s; cursor:pointer;
                }
                .ed-conv-list label:hover { background:#f0f0f0; }
                .ed-conv-list summary { cursor:pointer; font-weight:600; padding:6px 10px; font-size:13px; }
                .ed-conv-list details { margin:2px 0; }
                .ed-footer { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; padding-top:16px; border-top:1px solid #f0f0f0; }
                .ed-btn {
                    padding:10px 20px; border-radius:10px; font-size:14px; font-weight:600;
                    cursor:pointer; transition:all 0.2s ease; border:none;
                }
                .ed-btn-cancel { background:#f3f3f3; color:#666; }
                .ed-btn-cancel:hover { background:#e8e8e8; color:#333; }
                .ed-btn-start { background:#10a37f; color:#fff; min-width:120px; }
                .ed-btn-start:hover { background:#0d8c6d; transform:translateY(-1px); box-shadow:0 4px 12px rgba(16,163,127,0.3); }
                .ed-btn-start:active { transform:translateY(0); }
                .ed-empty { font-size:12px; color:#999; text-align:center; padding:16px 0; }
                .ed-checkbox {
                    -webkit-appearance:none; appearance:none; width:18px; height:18px; cursor:pointer;
                    border:2px solid #ccc; border-radius:4px; background:#fff; position:relative; transition:all 0.15s;
                    flex-shrink:0; outline:none; box-shadow:none;
                }
                .ed-checkbox:focus { outline:none; box-shadow:none; }
                .ed-checkbox:checked { background:#10a37f; border-color:#10a37f; }
                .ed-checkbox:checked::after {
                    content:''; position:absolute; left:5px; top:1px; width:5px; height:10px;
                    border:solid #fff; border-width:0 2px 2px 0; transform:rotate(45deg);
                }
            `;
            document.head.appendChild(style);
        }

        const overlay = document.createElement('div');
        overlay.id = 'export-dialog-overlay';
        const dialog = document.createElement('div');
        dialog.className = 'ed-dialog';
        dialog.innerHTML = `
            <div class="ed-title">
                <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                对话迁移
            </div>
            <div class="ed-subtitle">选择格式和范围，一键打包下载</div>

            <div class="ed-section">
                <div class="ed-section-label">导出格式</div>
                <div class="ed-format-group">
                    <div class="ed-format-card active" data-fmt="json">
                        <div class="ed-fc-icon">{&nbsp;}</div>
                        <div class="ed-fc-name">JSON</div>
                    </div>
                    <div class="ed-format-card active" data-fmt="md">
                        <div class="ed-fc-icon">M↓</div>
                        <div class="ed-fc-name">Markdown</div>
                    </div>
                    <div class="ed-format-card active" data-fmt="html">
                        <div class="ed-fc-icon">&lt;/&gt;</div>
                        <div class="ed-fc-name">HTML</div>
                    </div>
                </div>
            </div>

            <div class="ed-section">
                <div class="ed-section-label">导出空间</div>
                <div class="ed-tab-group">
                    <div class="ed-tab active" data-mode="personal">个人空间</div>
                    <div class="ed-tab" data-mode="team">团队空间</div>
                </div>
                <div class="ed-team-area" id="team-area">
                    <div class="ed-team-hint">自动检测到的工作区 ID：</div>
                    <div class="ed-team-detected" id="detected">未检测到</div>
                    <input type="text" class="ed-input" id="team-id" placeholder="或在此粘贴工作区 ID（ws-...）">
                </div>
            </div>

            <div class="ed-section" id="conv-select-area">
                <div class="ed-section-label">选择对话</div>
                <div class="ed-conv-header">
                    <div class="ed-conv-status" id="conv-select-status">加载中…</div>
                    <div class="ed-conv-actions">
                        <button class="ed-btn-refresh" id="conv-refresh">刷新</button>
                        <input type="checkbox" class="ed-checkbox" id="conv-select-all" checked title="全选">
                    </div>
                </div>
                <div class="ed-conv-list" id="conv-list"></div>
            </div>

            <div class="ed-footer">
                <button class="ed-btn ed-btn-cancel" id="dlg-cancel">取消</button>
                <button class="ed-btn ed-btn-start" id="dlg-start">开始导出</button>
            </div>
        `;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // 格式卡片点击切换
        dialog.querySelectorAll('.ed-format-card').forEach(card => {
            card.onclick = () => card.classList.toggle('active');
        });

        // Tab 切换
        const tabs = dialog.querySelectorAll('.ed-tab');
        const teamArea = dialog.querySelector('#team-area');
        tabs.forEach(tab => {
            tab.onclick = () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                if (tab.dataset.mode === 'team') {
                    teamArea.classList.add('show');
                } else {
                    teamArea.classList.remove('show');
                }
                loadConversationList();
            };
        });

        const detectedDiv = dialog.querySelector('#detected');
        const teamInput = dialog.querySelector('#team-id');
        const convStatus = dialog.querySelector('#conv-select-status');
        const convListEl = dialog.querySelector('#conv-list');
        const convRefresh = dialog.querySelector('#conv-refresh');
        const convSelectAll = dialog.querySelector('#conv-select-all');
        const convCache = {};
        let loadToken = 0;

        const renderConversationList = (items) => {
            convListEl.innerHTML = '';
            if (!items.length) {
                convListEl.innerHTML = '<div class="ed-empty">暂无可用对话</div>';
                convSelectAll.checked = false;
                return;
            }

            const roots = [];
            const projectMap = {};
            const projectOrder = [];
            items.forEach(it => {
                if (it.projectId) {
                    if (!projectMap[it.projectId]) {
                        projectMap[it.projectId] = { title: it.projectTitle || it.projectId, list: [] };
                        projectOrder.push(it.projectId);
                    }
                    projectMap[it.projectId].list.push(it);
                } else {
                    roots.push(it);
                }
            });

            const frag = document.createDocumentFragment();

            projectOrder.forEach(pid => {
                const detail = projectMap[pid];
                if (!detail.list.length) return;
                const wrap = document.createElement('details');
                wrap.style.margin = '2px 0';
                const summary = document.createElement('summary');
                summary.textContent = `项目 ${sanitizeFilename(detail.title)} (${detail.list.length})`;
                wrap.appendChild(summary);

                detail.list.forEach(item => {
                    const row = document.createElement('label');
                    row.innerHTML = `
                        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${sanitizeFilename(item.title)}</span>
                        <input class="conv-check ed-checkbox" type="checkbox" data-id="${item.id}" data-project="${item.projectId}" data-project-title="${sanitizeFilename(detail.title)}" data-title="${sanitizeFilename(item.title)}" checked>
                    `;
                    wrap.appendChild(row);
                });
                frag.appendChild(wrap);
            });

            roots.forEach(item => {
                const row = document.createElement('label');
                row.innerHTML = `
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${sanitizeFilename(item.title)}</span>
                    <input class="conv-check ed-checkbox" type="checkbox" data-id="${item.id}" data-project="" data-project-title="" data-title="${sanitizeFilename(item.title)}" checked>
                `;
                frag.appendChild(row);
            });

            convListEl.appendChild(frag);
            convSelectAll.checked = true;
        };

        const determineWorkspace = () => {
            const activeTab = dialog.querySelector('.ed-tab.active');
            const mode = activeTab && activeTab.dataset.mode === 'team' ? 'team' : 'personal';
            if (mode === 'personal') return { mode, workspaceId: null };
            const manual = teamInput.value.trim();
            const workspaceId = manual || ids[0] || '';
            return { mode, workspaceId };
        };

        const loadConversationList = async (showWarnOnMissing = false) => {
            const { mode, workspaceId } = determineWorkspace();
            if (mode === 'team' && !workspaceId) {
                convStatus.textContent = '请输入有效的 Team Workspace ID 后再刷新列表。';
                convListEl.innerHTML = '';
                convSelectAll.checked = false;
                if (showWarnOnMissing) alert('请输入一个有效的 Team Workspace ID 再加载对话列表。');
                return;
            }
            const cacheKey = `${mode}:${workspaceId || 'personal'}`;
            if (convCache[cacheKey]) {
                convStatus.textContent = `已加载 ${convCache[cacheKey].length} 个对话（缓存）`;
                renderConversationList(convCache[cacheKey]);
                return;
            }
            const token = ++loadToken;
            convStatus.textContent = '加载对话列表中…';
            convListEl.innerHTML = '';
            try {
                const data = await listConversationMetas(mode, workspaceId || null, (msg) => { if (token === loadToken) convStatus.textContent = msg; });
                if (token !== loadToken) return;
                convCache[cacheKey] = data;
                renderConversationList(data);
            } catch (e) {
                if (token !== loadToken) return;
                convStatus.textContent = `加载失败: ${e.message}`;
                convListEl.innerHTML = '<div class="ed-empty" style="color:#e55;">无法加载对话列表</div>';
                convSelectAll.checked = false;
            }
        };

        convSelectAll.addEventListener('change', () => {
            convListEl.querySelectorAll('.conv-check').forEach(cb => { cb.checked = convSelectAll.checked; });
        });
        convListEl.addEventListener('change', () => {
            const checks = Array.from(convListEl.querySelectorAll('.conv-check'));
            convSelectAll.checked = checks.length > 0 && checks.every(cb => cb.checked);
        });
        convRefresh.onclick = () => { loadConversationList(true); };
        const ids = detectAllWorkspaceIds();
        if (ids.length) {
            detectedDiv.textContent = ids.join(' , ');
            // 自动切换到团队空间
            tabs.forEach(t => t.classList.remove('active'));
            dialog.querySelector('.ed-tab[data-mode="team"]').classList.add('active');
            teamArea.classList.add('show');
        }
        teamInput.addEventListener('change', () => { loadConversationList(); });
        loadConversationList();
        dialog.querySelector('#dlg-cancel').onclick = () => document.body.removeChild(overlay);
        dialog.querySelector('#dlg-start').onclick = async () => {
            const jsonCard = dialog.querySelector('.ed-format-card[data-fmt="json"]');
            const mdCard = dialog.querySelector('.ed-format-card[data-fmt="md"]');
            const htmlCard = dialog.querySelector('.ed-format-card[data-fmt="html"]');
            const formats = {
                json: jsonCard.classList.contains('active'),
                markdown: mdCard.classList.contains('active'),
                html: htmlCard.classList.contains('active')
            };
            if (!formats.json && !formats.markdown && !formats.html) { alert('请至少选择一种导出格式！'); return; }
            const activeTab = dialog.querySelector('.ed-tab.active');
            const mode = activeTab && activeTab.dataset.mode === 'team' ? 'team' : 'personal';
            let workspaceId = null;
            if (mode === 'team') {
                const manual = teamInput.value.trim();
                workspaceId = manual || ids[0] || '';
                if (!workspaceId) { alert('请选择或输入一个有效的 Team Workspace ID！'); return; }
            }
            const selected = Array.from(dialog.querySelectorAll('.conv-check:checked')).map(cb => ({
                id: cb.getAttribute('data-id'),
                projectId: cb.getAttribute('data-project') || null,
                projectTitle: cb.getAttribute('data-project-title') || '',
                title: cb.getAttribute('data-title') || ''
            }));
            if (!selected.length) {
                await loadConversationList(true);
                const retrySelected = Array.from(dialog.querySelectorAll('.conv-check:checked')).map(cb => ({
                    id: cb.getAttribute('data-id'),
                    projectId: cb.getAttribute('data-project') || null,
                    projectTitle: cb.getAttribute('data-project-title') || '',
                    title: cb.getAttribute('data-title') || ''
                }));
                if (!retrySelected.length) { alert('请至少勾选一个要导出的对话。'); return; }
                selected.splice(0, selected.length, ...retrySelected);
            }
            document.body.removeChild(overlay);
            exportFormats.mode = mode; exportFormats.workspaceId = workspaceId;
            startExportProcess(mode, workspaceId, formats, selected);
        };
        overlay.onclick = (e) => { if (e.target === overlay) document.body.removeChild(overlay); };
    }

    function addBtn() {
        if (document.getElementById('gpt-rescue-btn')) return;
        if (!document.getElementById('gpt-rescue-btn-style')) {
            const s = document.createElement('style');
            s.id = 'gpt-rescue-btn-style';
            s.textContent = `
                #gpt-rescue-btn {
                    position:fixed; bottom:24px; right:24px; z-index:99997;
                    padding:12px 18px; border-radius:12px; border:none; cursor:pointer;
                    font-weight:600; background:linear-gradient(135deg,#10a37f,#0d8c6d); color:#fff;
                    font-size:14px; box-shadow:0 4px 16px rgba(16,163,127,0.3);
                    user-select:none; transition:all 0.2s ease;
                    font-family:-apple-system,"Microsoft YaHei","PingFang SC",sans-serif;
                    display:flex; align-items:center; gap:6px;
                }
                #gpt-rescue-btn:hover { transform:translateY(-2px); box-shadow:0 6px 20px rgba(16,163,127,0.4); }
                #gpt-rescue-btn:active { transform:translateY(0); }
            `;
            document.head.appendChild(s);
        }
        const b = document.createElement('button');
        b.id = 'gpt-rescue-btn';
        b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> 导出对话';
        b.onclick = showExportDialog; document.body.appendChild(b);
    }

    setTimeout(addBtn, 2000);
})();
