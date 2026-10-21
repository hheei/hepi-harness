# React 路由与构建方式：上游项目采用证据

日期：2026-10-17。用途：为 [客户端架构适配研究](hepi-client-architecture-adaptation.md) 第 4 节的
Web 入口取舍提供少量一手采用证据。**这是定点抽样，不是市场调查**，不用于推断安装量、性能或行业份额。
官方特性文档与 npm 下载量区间数据由父任务另行核验，本文不重复。

方法：只读上游仓库在指定 commit 的 `package.json` 与入口源码，通过
`raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>` 读取。未克隆、未安装、未运行任何项目。
下表只区分三件事：**打包器**（Vite / electron-vite / Next）、**路由库**、**应用前端 vs 文档/营销站点**。

## 1. 已核验样例

| 项目 | commit | 打包器 | 路由 | 应用前端位置 |
| --- | --- | --- | --- | --- |
| LibreChat | `e081b566a42d3a83b8102157bd7806cf4ff63b17` | Vite 8 | `react-router-dom` ^7.18.2，`createBrowserRouter` | `client/` |
| Chatbox | `0ac6385ae1ff5bf778777826da3c5edcd55b61b8` | electron-vite（另含 web 构建目标） | `@tanstack/react-router` ^1.114.23 | `src/renderer/` |
| Jan | `a86d87ebcfb7eb542dbc548cd3a5936b4650c3c6` | Vite 6 + Tauri 2 | `@tanstack/react-router` ^1.121.34 | `web-app/` |
| AnythingLLM | `d7d68e75c422d10384b8aa30f72d6d032fcc555e` | Vite 4 | `react-router-dom` ^6.3.0，`createBrowserRouter` | `frontend/` |
| Excalidraw | `4c37956ba5f04ec342a9d9d5891a38f22c5b7b4e` | Vite 5 | 已核验 manifests 未列这两种路由依赖 | `excalidraw-app/` |

对照（非样例结论）：lobehub/lobehub 在 `7963bbc159bdbb537c5a7299c16d62df155417e5`（canary）
仍以 `next ~16.3.8` + React 19 为主应用，说明 Next 继续服务大型 React 产品；该仓库同时有 Vite 构建的
子应用（`apps/auth`、`apps/workbench`），因此“仓库含 Vite”不等于“主应用已离开 Next”。

## 2. 逐条来源

**LibreChat — Vite + React Router**

- `client/package.json`：`vite ^8.2.2`、`@vitejs/plugin-react ^6.0.2`、`react-router-dom ^7.18.2`。
  https://github.com/LibreChat-AI/LibreChat/blob/e081b566a42d3a83b8102157bd7806cf4ff63b17/client/package.json
- `client/src/routes/index.tsx` 用 `createBrowserRouter` 组装 `/c/:conversationId?`、`/login`、
  `/projects/:projectId` 等路由，含 `lazy` 分包：
  https://github.com/LibreChat-AI/LibreChat/blob/e081b566a42d3a83b8102157bd7806cf4ff63b17/client/src/routes/index.tsx
- `client/src/App.jsx` 以 `RouterProvider router={router}` 挂载；`client/src/main.jsx` 只做
  `createRoot` + i18n 引导，无服务端渲染入口：
  https://github.com/LibreChat-AI/LibreChat/blob/e081b566a42d3a83b8102157bd7806cf4ff63b17/client/src/App.jsx
- 这是 SPA 前端 + 独立 API 服务的形态；构建脚本为 `vite build`，不是 Next。

**Chatbox — electron-vite + TanStack Router（同一份 renderer 另有 web 构建目标）**

- `package.json`：`electron-vite`、`vite`、`@tanstack/react-router ^1.114.23`、
  `@tanstack/router-plugin ^1.120.15`；脚本 `build:renderer` = `electron-vite build`，
  `build:web` = `CHATBOX_BUILD_PLATFORM=web electron-vite build`：
  https://github.com/chatboxai/chatbox/blob/0ac6385ae1ff5bf778777826da3c5edcd55b61b8/package.json
- `src/renderer/routes/__root.tsx` 用 `createRootRoute`，路由文件按目录组织（`settings/`、`session/$sessionId.tsx`）：
  https://github.com/chatboxai/chatbox/blob/0ac6385ae1ff5bf778777826da3c5edcd55b61b8/src/renderer/routes/__root.tsx
- `src/renderer/router.tsx` 按平台选历史类型：web 用默认 browser history，桌面用 `createHashHistory()`：
  https://github.com/chatboxai/chatbox/blob/0ac6385ae1ff5bf778777826da3c5edcd55b61b8/src/renderer/router.tsx
- `vite.config.web.ts` 复用同一套插件（含 `TanStackRouterVite`）：
  https://github.com/chatboxai/chatbox/blob/0ac6385ae1ff5bf778777826da3c5edcd55b61b8/vite.config.web.ts
- 与本项目相关的一点：**同一 React renderer 同时供桌面壳与 web 目标使用**，路由历史按宿主切换，
  而不是维护两套页面。这不证明 Tauri，只证明 Electron/Capacitor + web 共享的可行性。

**Jan — Vite + Tauri 2 + TanStack Router（最接近 Hepi App 侧形态）**

- `web-app/package.json`：`vite 6.3.2`、`@vitejs/plugin-react 4.4.1`、
  `@tanstack/react-router ^1.121.34`、`@tanstack/router-plugin 1.121.34`、
  `@tauri-apps/api 2.8.0`；脚本 `dev: vite`、`build: tsc -b && vite build`：
  https://github.com/janhq/jan/blob/a86d87ebcfb7eb542dbc548cd3a5936b4650c3c6/web-app/package.json
- `web-app/vite.config.ts` 注册 `TanStackRouterVite({ target: 'react', autoCodeSplitting: true })`，
  并按 Tauri 约定固定端口 1420：
  https://github.com/janhq/jan/blob/a86d87ebcfb7eb542dbc548cd3a5936b4650c3c6/web-app/vite.config.ts
- `src-tauri/tauri.conf.json`：`frontendDist: "../web-app/dist"`、`devUrl: http://localhost:1420`，
  构建前执行 `yarn build:web`：
  https://github.com/janhq/jan/blob/a86d87ebcfb7eb542dbc548cd3a5936b4650c3c6/src-tauri/tauri.conf.json
- `web-app/src/main.tsx` 用 `createRouter({ routeTree })` + `RouterProvider`：
  https://github.com/janhq/jan/blob/a86d87ebcfb7eb542dbc548cd3a5936b4650c3c6/web-app/src/main.tsx
- 结论范围：证明 **Vite 静态产物 + Tauri 2 + TanStack Router** 是已发布的组合，不证明其包体、内存或
  首屏优于 Next。

**AnythingLLM — Vite + React Router v6**

- `frontend/package.json`：`vite ^4.3.0`、`react-router-dom ^6.3.0`，脚本 `dev: vite`、`build: vite build`：
  https://github.com/Mintplex-Labs/anything-llm/blob/d7d68e75c422d10384b8aa30f72d6d032fcc555e/frontend/package.json
- `frontend/src/main.jsx` 用 `createBrowserRouter` + `RouterProvider`，路由 `lazy` 动态 import，
  含 `/workspace/:slug`、`/workspace/:slug/settings/:tab`：
  https://github.com/Mintplex-Labs/anything-llm/blob/d7d68e75c422d10384b8aa30f72d6d032fcc555e/frontend/src/main.jsx
- 该前端只做浏览器端路由，后端为独立 Express 服务；仓库根 `package.json` 仅作编排，不含 Next。

**Excalidraw — Vite + React（避免从构建工具误推路由库）**

- 根 `package.json` 的 `devDependencies` 有 `vite 5.0.12`、`@vitejs/plugin-react 3.1.0`；
  `excalidraw-app/package.json` 只有 `react 19.0.0`、`react-dom`、`vite-plugin-html`，
  **没有** `react-router` 或 `@tanstack/react-router` 依赖：
  https://github.com/excalidraw/excalidraw/blob/4c37956ba5f04ec342a9d9d5891a38f22c5b7b4e/excalidraw-app/package.json
- 因此“Excalidraw 用 React + Vite”**不能作为这两种路由方案的采用证据**；
  上述 manifest 范围也不足以证明整个仓库没有其他路由或导航实现。

## 3. 能推出什么、不能推出什么

可从上述 manifest 与入口源码确认的：

1. Vite 是这些项目的实际前端构建工具。LibreChat 与 AnythingLLM 展示了 Vite SPA 搭配独立 API 服务的形态；
   Jan 展示的是 Tauri 宿主形态。不能从仓库含 Vite 推断其服务端职责或整个仓库是否使用 Next。
2. 两种路由库都有大型项目在用：React Router 见于 LibreChat（v7）与 AnythingLLM（v6）；
   TanStack Router 见于 Chatbox 与 Jan（均 1.x）。样例包含代码分割与参数化会话 URL；
   两种库的文件式路由能力需按其接入模式与官方文档比较。
3. **Tauri 2 + Vite + TanStack Router** 已有已发布组合（Jan），这与 Hepi App 侧的形态最接近。
4. 桌面壳 + 浏览器共用一份 React UI 时，路由历史可能需按宿主切换（Chatbox 的 hash history 分支），
   这是宿主差异，不是路由库选型差异。

不能从本文推出的：

- 不能推出任何性能结论。上述仓库没有针对 Hepi 场景（SSE 会话流、长会话渲染、Tauri WebView）的对比数据，
  样本也未做基准测试；须由 Hepi 测量路由、渲染、流处理与数据量各项影响，不能由采用案例判断其大小。
- 不能推出“多数项目已从 Next 迁到 Vite”：本文是 5 个项目的定点抽样，且 lobehub 反例显示 Next 仍在大规模使用。
- 不能推出生态成熟度排序；安装量区间数据由父任务单独核验，本文未使用。
- 不能推出 Hepi 应立即迁移：是否迁移取决于第 4 节所列的登录/代理职责落地与部署成本。

## 4. 与当前建议的关系

[客户端架构适配研究](hepi-client-architecture-adaptation.md) 第 4 节把 **Vite + React Router** 作为
当前导航需求下的暂定建议，并保留 Next。本文的抽样与该建议不冲突：LibreChat、AnythingLLM
说明“Vite SPA + 独立 API”是可运行的产品形态，两个样例（Jan、Chatbox）说明
TanStack Router 在桌面/多目标打包下同样可用。

若 Hepi 的 URL 类型化、搜索参数状态或 loader 数据依赖成为实际需求，TanStack Router 与 React Router
应重新对比；在需求未出现前，不为换路由库单独重写。本文不改变第 4 节的暂定结论。
