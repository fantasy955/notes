/**
 * 生产环境注册 Service Worker，为应用提供离线缓存能力。
 *
 * - 仅生产构建注册，开发模式不注册（避免干扰 Vite HMR）
 * - Playwright 导出渲染页不注册（无头渲染不需要离线能力）
 * - 非安全上下文（如通过 HTTP + IP 访问）静默跳过：浏览器本身会拒绝注册，
 *   提前判断可避免控制台出现无意义的注册失败警告
 * - 优先按页面相对路径注册：`/notes/` 子路径部署时 scope 精确限定为子路径；
 *   根部署的深层页面（如 /superadmin）相对解析会命中 SPA 回退导致 MIME
 *   错误，此时回退到站点根路径注册
 */

export async function registerNotesServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD) {
    return;
  }

  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  if (
    typeof window !== "undefined" &&
    !window.isSecureContext
  ) {
    return;
  }

  if (
    new URLSearchParams(window.location.search).get("renderMode") ===
    "playwright"
  ) {
    return;
  }

  try {
    try {
      await navigator.serviceWorker.register("sw.js");
      return;
    } catch {
      await navigator.serviceWorker.register("/sw.js");
    }
  } catch (error) {
    console.warn("[pwa] Service Worker 注册失败，离线能力不可用", error);
  }
}
