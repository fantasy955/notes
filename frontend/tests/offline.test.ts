import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getNoteMergeVersion,
  mergeNoteWorkspaces,
  pushWorkspaceWithConflictMerge,
} from "../../src/lib/offline-sync.js";
import {
  moveNoteToTrash,
  restoreNoteFromTrash,
} from "../../src/lib/notes.js";
import type { NoteDocument, NoteWorkspace } from "../../src/types/app.js";

const manifest = readFileSync("public/manifest.webmanifest", "utf8");
const indexHtml = readFileSync("index.html", "utf8");
const swTemplate = readFileSync("scripts/sw-template.js", "utf8");
const viteConfig = readFileSync("vite.config.ts", "utf8");
const mainSource = readFileSync("src/main.tsx", "utf8");
const registerSwSource = readFileSync("src/lib/register-sw.ts", "utf8");
const offlineSource = readFileSync("src/lib/offline.ts", "utf8");
const offlineSyncSource = readFileSync("src/lib/offline-sync.ts", "utf8");
const appSource = readFileSync("src/App.tsx", "utf8");
const appStateSource = readFileSync("src/lib/app-state.ts", "utf8");
const notesSource = readFileSync("src/lib/notes.ts", "utf8");
const authSource = readFileSync("src/lib/auth.ts", "utf8");
const styles = readFileSync("src/styles.css", "utf8");
const frontendDockerfile = readFileSync("Dockerfile.frontend", "utf8");

function createNote(overrides: Partial<NoteDocument>): NoteDocument {
  return {
    id: "note-1",
    markdown: "正文",
    createdAt: 1000,
    updatedAt: 1000,
    normalOrder: 0,
    pinnedAt: null,
    folderId: null,
    isStarred: false,
    deletedAt: null,
    ...overrides,
  };
}

function createWorkspace(
  notes: NoteDocument[],
  overrides: Partial<NoteWorkspace> = {},
): NoteWorkspace {
  return {
    activeNoteId: notes[0]?.id ?? "",
    folders: [],
    notes,
    version: 1,
    ...overrides,
  };
}

test("PWA manifest 提供可安装的独立应用声明", () => {
  const parsed = JSON.parse(manifest) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };

  assert.equal(parsed.name, "开源版锤子便签");
  assert.equal(parsed.short_name, "锤子便签");
  // 相对路径让 /notes/ 子路径部署无需修改 manifest
  assert.equal(parsed.start_url, ".");
  assert.equal(parsed.scope, "./");
  assert.equal(parsed.display, "standalone");

  const sizes = new Set(parsed.icons.map((icon) => icon.sizes));
  assert.ok(sizes.has("192x192"), "缺少 192x192 图标");
  assert.ok(sizes.has("512x512"), "缺少 512x512 图标");
  assert.ok(
    parsed.icons.some((icon) => icon.purpose === "maskable"),
    "缺少 maskable 图标",
  );
  for (const icon of parsed.icons) {
    assert.ok(icon.src.startsWith("./"), "图标必须使用相对路径");
  }
});

test("index.html 引用 manifest 并声明安装元数据", () => {
  assert.match(indexHtml, /<link rel="manifest" href="manifest\.webmanifest" \/>/);
  assert.match(indexHtml, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png" \/>/);
  assert.match(indexHtml, /<meta name="theme-color" content="#fffcf7" \/>/);
  assert.match(indexHtml, /<meta name="apple-mobile-web-app-capable" content="yes" \/>/);
});

test("Service Worker 模板实现导航回退与分层缓存策略", () => {
  // 导航请求 network-first + 离线回退缓存外壳
  assert.match(swTemplate, /request\.mode === "navigate"/);
  assert.match(swTemplate, /networkFirstNavigation/);
  assert.match(swTemplate, /cache\.match\(request, \{ ignoreSearch: true \}\)/);
  // 静态资源 cache-first
  assert.match(swTemplate, /isCacheableStatic/);
  assert.match(swTemplate, /cacheFirst/);
  // API 与七牛代理完全放行
  assert.match(swTemplate, /BYPASS_PREFIXES = \["\/api\/", "\/qiniu\/"\]/);
  // 用户图片独立缓存并限量淘汰
  assert.match(swTemplate, /IMAGES_PREFIX = "\/images\/"/);
  assert.match(swTemplate, /IMAGE_CACHE_LIMIT = 300/);
  assert.match(swTemplate, /trimImageCache/);
  // 版本化缓存与激活清理
  assert.match(swTemplate, /notes-shell-/);
  assert.match(swTemplate, /caches\.delete\(key\)/);
  // 构建注入点保留
  assert.match(swTemplate, /__SW_VERSION__/);
  assert.match(swTemplate, /__PRECACHE_MANIFEST__/);
});

test("构建插件在产物中注入预缓存清单与内容哈希版本", () => {
  assert.match(viteConfig, /notesPwaServiceWorkerPlugin/);
  assert.match(viteConfig, /apply: "build"/);
  assert.match(viteConfig, /scripts\/sw-template\.js/);
  assert.match(viteConfig, /createHash\("sha256"\)/);
  assert.match(viteConfig, /fileName: "sw\.js"/);
  assert.match(viteConfig, /import\.meta\.dirname/);
});

test("生产环境注册 Service Worker 且导出渲染与开发模式跳过", () => {
  assert.match(mainSource, /registerNotesServiceWorker\(\)/);
  assert.match(registerSwSource, /import\.meta\.env\.PROD/);
  assert.match(registerSwSource, /renderMode.*===.*"playwright"/s);
  // 先相对路径注册（子路径 scope 精确），失败回退站点根路径
  assert.match(registerSwSource, /navigator\.serviceWorker\.register\("sw\.js"\)/);
  assert.match(registerSwSource, /navigator\.serviceWorker\.register\("\/sw\.js"\)/);
});

test("非安全上下文（HTTP + IP 访问）静默跳过注册", () => {
  // HTTP 访问时浏览器会拒绝注册 Service Worker，提前判断可避免无意义告警
  assert.match(registerSwSource, /!window\.isSecureContext/);
  assert.ok(
    registerSwSource.indexOf("isSecureContext") <
      registerSwSource.indexOf("navigator.serviceWorker.register"),
    "安全上下文判断应位于注册调用之前",
  );
});

test("离线状态库提供在线订阅与服务器可达性探测", () => {
  assert.match(offlineSource, /subscribeOnlineStatus/);
  assert.match(offlineSource, /probeServerReachable/);
  assert.match(offlineSource, /\/api\/health\?probe=/);
  assert.match(offlineSource, /cache: "no-store"/);
  assert.match(offlineSource, /navigator\.onLine/);
});

test("云同步元数据与冲突合并推送具备持久化语义", () => {
  assert.match(offlineSyncSource, /notes\.cloudSyncMeta\.v1/);
  assert.match(offlineSyncSource, /notes\.authSession\.v1/);
  assert.match(offlineSyncSource, /pendingPush/);
  assert.match(offlineSyncSource, /MAX_CONFLICT_MERGE_ATTEMPTS = 4/);
  // 合并版本取 updatedAt 与 deletedAt 的较大值，兼容历史软删除数据
  assert.match(offlineSyncSource, /Math\.max\(note\.updatedAt, note\.deletedAt \?\? 0\)/);
});

test("离线启动优先推送待同步修改，避免云端水合覆盖本地编辑", () => {
  assert.match(appSource, /hasPendingLocalEdits/);
  assert.match(appSource, /pushWorkspaceWithConflictMerge/);
  assert.match(appSource, /subscribeOnlineStatus/);
  assert.match(appSource, /probeServerReachable/);
  assert.match(appSource, /runReconnectSync/);
  // 登录用户的离线编辑直接进入离线分支并标记待推送
  assert.match(appSource, /writeCloudSyncMeta\(\{[\s\S]*?pendingPush: true/);
  // 离线提示横幅
  assert.match(appSource, /offline-indicator/);
  assert.match(appSource, /OFFLINE_FEATURE_MESSAGE/);
  // 匿名分支在 canUseCloudWorkspace 为真时提前返回，不再写遗留本地键
  assert.match(
    appSource,
    /if \(canUseCloudWorkspace\(authUser\)\) \{\s*return;\s*\}\s*\n\s*setCloudSyncState\("local"\);/,
  );
  // 登录用户另有独立的本地镜像 effect，供离线时作为唯一持久层
  assert.match(
    appSource,
    /if \(authStatus !== "ready" \|\| !canUseCloudWorkspace\(authUser\)\) \{\s*return;\s*\}\s*\n\s*persistNoteWorkspace\(\{/,
  );
});

test("登录用户工作区镜像按账号命名空间隔离", () => {
  assert.match(appStateSource, /USER_WORKSPACE_STORAGE_PREFIX = "notes\.workspace\.user\."/);
  assert.match(appStateSource, /getWorkspaceUserScope/);
  assert.match(appStateSource, /readCachedAuthUser/);
});

test("认证层抛出带 HTTP 状态码的错误并支持乐观锁参数", () => {
  assert.match(authSource, /export class ApiError extends Error/);
  assert.match(authSource, /this\.status = status/);
  assert.match(
    authSource,
    /saveCloudWorkspace\(\s*workspace: NoteWorkspace,\s*expectedUpdatedAt\?: number \| null,?\s*\)/,
  );
  assert.match(authSource, /expectedUpdatedAt: expectedUpdatedAt \?\? null/);
});

test("软删除与恢复会推进 updatedAt 以参与离线合并", () => {
  assert.match(
    notesSource,
    /moveNoteToTrash[\s\S]*?deletedAt: now,[\s\S]*?updatedAt: now,/,
  );
  assert.match(
    notesSource,
    /restoreNoteFromTrash[\s\S]*?deletedAt: null,[\s\S]*?updatedAt: now,/,
  );
});

test("前端镜像包含 manifest 与图标资源", () => {
  assert.match(frontendDockerfile, /COPY public \.\/public/);
});

test("样式表提供明暗两套离线横幅样式", () => {
  assert.match(styles, /\.offline-indicator \{/);
  assert.match(styles, /\[data-theme="smartisan-dark"\] \.offline-indicator \{/);
});

test("合并按笔记粒度保留较新副本并并集两侧数据", () => {
  const local = createWorkspace([
    createNote({ id: "a", markdown: "本地新", updatedAt: 2000 }),
    createNote({ id: "b", markdown: "本地旧", updatedAt: 1000 }),
    createNote({ id: "only-local", markdown: "本地独有" }),
  ]);
  const cloud = createWorkspace(
    [
      createNote({ id: "a", markdown: "云端旧", updatedAt: 1500 }),
      createNote({ id: "b", markdown: "云端新", updatedAt: 3000 }),
      createNote({ id: "only-cloud", markdown: "云端独有" }),
    ],
    {
      folders: [{ id: "f1", name: "云端名", createdAt: 1 }],
      activeNoteId: "b",
    },
  );

  const merged = mergeNoteWorkspaces(local, cloud);

  const byId = new Map(merged.notes.map((note) => [note.id, note]));
  assert.equal(byId.get("a")?.markdown, "本地新");
  assert.equal(byId.get("b")?.markdown, "云端新");
  assert.ok(byId.has("only-local"));
  assert.ok(byId.has("only-cloud"));
  assert.equal(merged.folders.length, 1);
  assert.equal(merged.folders[0]?.name, "云端名");
  // activeNoteId 属于设备本地界面状态，本地仍有效时优先保留
  assert.equal(merged.activeNoteId, "a");
});

test("离线软删除在与云端编辑合并时按时间决出胜负", () => {
  const noteId = "delete-case";

  // 本地刚删除（时间较新）→ 保持删除状态
  const locallyDeleted = moveNoteToTrash(
    [createNote({ id: noteId, updatedAt: 1000 })],
    noteId,
    5000,
  );
  const cloudOlder = createWorkspace([createNote({ id: noteId, updatedAt: 3000 })]);
  const mergedKeptDeleted = mergeNoteWorkspaces(
    createWorkspace(locallyDeleted),
    cloudOlder,
  );
  assert.equal(mergedKeptDeleted.notes[0]?.deletedAt, 5000);

  // 云端在本地删除之后又编辑过 → 云端胜出，笔记复活
  const cloudNewer = createWorkspace([createNote({ id: noteId, updatedAt: 9000 })]);
  const mergedRevived = mergeNoteWorkspaces(
    createWorkspace(locallyDeleted),
    cloudNewer,
  );
  assert.equal(mergedRevived.notes[0]?.deletedAt, null);
  assert.equal(mergedRevived.notes[0]?.updatedAt, 9000);

  // 版本号取 updatedAt 与 deletedAt 较大值
  assert.equal(
    getNoteMergeVersion(createNote({ id: "v", updatedAt: 100, deletedAt: 500 })),
    500,
  );
  assert.equal(
    getNoteMergeVersion(createNote({ id: "v", updatedAt: 800, deletedAt: 500 })),
    800,
  );
});

test("恢复回收站会推进 updatedAt，与云端删除状态可正确合并", () => {
  const noteId = "restore-case";
  const restored = restoreNoteFromTrash(
    [createNote({ id: noteId, updatedAt: 1000, deletedAt: 2000 })],
    noteId,
    6000,
  );

  assert.equal(restored[0]?.deletedAt, null);
  assert.equal(restored[0]?.updatedAt, 6000);
});

test("冲突推送在 409 时读取云端合并后重试", async () => {
  const localWorkspace = createWorkspace([
    createNote({ id: "a", markdown: "本地", updatedAt: 2000 }),
  ]);
  const cloudWorkspace = createWorkspace([
    createNote({ id: "a", markdown: "云端", updatedAt: 3000 }),
    createNote({ id: "cloud-only", markdown: "云端独有", updatedAt: 3000 }),
  ]);

  const originalFetch = globalThis.fetch;
  let putCount = 0;
  let receivedBody: unknown;

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);

    if (url === "/api/workspace" && init?.method === "PUT") {
      putCount += 1;
      receivedBody = JSON.parse(String(init.body));

      if (putCount === 1) {
        return new Response(
          JSON.stringify({ error: "工作区版本已变化", updatedAt: 5000 }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }

      assert.equal(receivedBody && typeof receivedBody === "object", true);
      const body = receivedBody as { expectedUpdatedAt?: number };
      assert.equal(body.expectedUpdatedAt, 5000);

      return new Response(
        JSON.stringify({ updatedAt: 6000, workspace: localWorkspace }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url === "/api/workspace") {
      return new Response(
        JSON.stringify({ updatedAt: 5000, workspace: cloudWorkspace }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const saved = await pushWorkspaceWithConflictMerge(localWorkspace, 4000);

    assert.equal(putCount, 2);
    assert.equal(saved.updatedAt, 6000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
