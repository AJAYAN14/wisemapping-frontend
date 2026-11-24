# WiseMapping 个人轻量化改造实现记录（Implementation Notes）

## 1. 架构调整决议
- **运行模式**：放弃 Java 后端（wise-api），转向 **Netlify 静态托管 + Supabase BaaS（云数据库+认证）** 纯前端架构。
- **目标设备**：支持桌面浏览器与移动设备端云同步查看与编辑。
- **账号控制**：启用 Supabase Auth 邮箱密码登录，注册限制个人信任邮箱白名单。

## 2. 裁剪清单与改动记录

### 2.1 彻底废弃（不需要在 Netlify 上部署）
- **整个 Java 后端工程（wisemapping-open-source）**：
  - Spring Boot / Maven / Tomcat / HikariCP
  - 垃圾思维导图检测（SpamDetectionService）
  - 定时用户封禁（SpamUserSuspensionScheduler）
  - 7年不活跃账号与脑图迁移清理（InactiveUserService）
  - 历史记录物理清理（HistoryPurgeService）
  - 自建 SMTP 邮件服务、Google reCAPTCHA 与一次性邮箱黑名单
  - 企业级 LDAP / OIDC / OAuth2 复杂集成
  - OpenTelemetry / Prometheus 监控指标

### 2.2 前端代码（wisemapping-frontend）裁剪项
- **商业监控与广告**：
  - 移除 `adsbygoogle`（Google AdSense 商业代码注入）
- **SaaS 运维与管理后台**：
  - 移除 `/c/admin/*` 路由与所有 Admin 视图组件
- **多租户协作与公开分享 UI**：
  - 移除导图右键操作菜单中的 `share`（协作邀请）与 `publish`（公开发布到网页）
  - 移除左侧抽屉导航中的 `Shared with me`（与我共享）和 `Public`（公开导图）筛选项
- **多设备并发编辑锁**：
  - 移除心跳续租互斥锁（改为随开随编无锁模式）
- **邮件激活与找回流程**：
  - 移除旧版复杂的邮件激活码（activation）与 Token 找回页面

## 3. 偏差记录（Deviations）
- 暂无，严格按照与用户沟通的设计决议执行。

## 4. 发现的边界情况（Discovered Edge Cases）
- 导图的 XML 格式需保持与 WiseMapping 原始 XSD 规范一致，以确保导图导入/导出（XMind、FreeMind、SVG）不受影响。
- PostgREST 连接嵌套查询语法：`mindmaps` 关联 `r_label_mindmap` 与 `mindmap_labels` 时，采用 `r_label_mindmap(label_id, mindmap_labels(id, title, color))`，需在代码中安全过滤并展平到 `MapInfo.labels`。
- `exactOptionalPropertyTypes` 与 `noPropertyAccessFromIndexSignature`：TypeScript 开启了严格类型校验，在构造 `ErrorInfo` 及读取 `user_metadata` 时均采用安全属性访问与赋值。

## 5. 待复核问题（Questions for Review）
- 已成功配置 `config.dev.json` 与 `config.prod.json` 指向真实 Supabase 项目（URL: `https://fzzkxymwcambugbxfsvj.supabase.co`），已实测直连通信与表结构校验通过。

## 6. Milestone 1 (M1) 实施总结
- 安装依赖：通过 Yarn 4 Berry 安装 `@supabase/supabase-js@^2.119.2`。
- 配置文件更新：`config.dev.json` 与 `config.prod.json` 转换为 `type: "static"`，`clientType: "supabase"`，填入 Supabase URL 与 Anon Key。
- AppConfig 扩展：`Config` 类型允许 `'supabase'` 客户端，添加 `isSupabaseClient()` 方法，在 `getClient()` 中初始化并返回 `SupabaseClient` 实例。
- SupabaseClient 实现：完整实现 `Client` 接口的全部 33 个方法，涵盖 Supabase Auth（登录、登出、注册、用户信息读取、会话过期监听）、导图 CRUD（列表、元数据、新建、重命名、删除、复制、导入、加星）、标签管理（列表、创建、删除、导图标签关联与解除）、历史版本查询与恢复，所有非必要企业级功能提供安全 Stubs。
- 类型与构建验证：`tsc --noEmit` 0 错误完全通过；Vite 生产打包 4.90 秒成功构建。

## 7. Milestone 2 (M2) 实施总结
- SupabasePersistenceManager 实现（`packages/webapp/src/classes/persistence/supabase-persistence-manager.ts`）：
  - 继承 `@wisemapping/mindplot` 的 `PersistenceManager` 抽象基类。
  - 获取 SupabaseClient 实例（共享全局登录 Session）。
  - `loadMapDom(mapId)`：支持当前导图（`public.mindmaps`）与历史版本查看（`this.hid` 时从 `public.mindmap_history` 查询），内置 `DOMParser` 解析与 XML 语法错误拦截校验。
  - `saveMapXml`：具备并发保存合并队列（In-Flight Coalescing Queue），防止快速键入与自动保存时的乱序覆盖。
  - 自动更新 `public.mindmaps` 的 `xml` 与 `updated_at`。在手动保存（`saveHistory === true`）时向 `public.mindmap_history` 记录历史快照。
  - 会话过期拦截（`_isAuthError`）：捕获 401/403/PGRST301/42501，自动触发 `SessionExpired` 回调与 fatal 错误通知。
  - 无锁化个人模式：`unlockMap` 与 `discardChanges` 干净 resolve，消除 Java 端租期心跳锁。
- 编辑器接入（`packages/webapp/src/components/editor-page/index.tsx`）：
  - 在 `buildPersistenceManagerForEditor` 中检查 `AppConfig.isSupabaseClient()`，自动挂载 `SupabasePersistenceManager` 并绑定会话过期监听。
- 自动化测试与质量保障：
  - 新增 `supabase-persistence-manager.test.ts` 涵盖 10 个测试用例（包括构造函数、当前版本加载、历史版本加载、非数字 ID 错误处理、XML 语法异常、自动保存无历史版本更新、手动保存历史快照插入、Session 过期触发、无锁退出与释放），10/10 全部通过。
  - 全量静态类型校验：`yarn workspace @wisemapping/webapp tsc --noEmit` 0 错误通过。
  - ESLint 检查：0 错误 0 告警通过。
  - 生产构建验证：`yarn workspace @wisemapping/webapp build` 3.21 秒构建成功。

## 8. Milestone 3 (M3) 实施总结
- Netlify 部署配置（`netlify.toml`）：
  - 位于项目根目录 `e:\Web\wisemapping-frontend\netlify.toml`。
  - 构建指令配置：`command = "yarn workspace @wisemapping/webapp build"`，发布目录 `publish = "packages/webapp/dist"`。
  - 构建环境变量：`APP_CONFIG_TYPE = "file:prod"`，`NODE_VERSION = "24.0.0"`，自动将静态 Supabase 配置（`config.prod.json`）在构建期注入 `VITE_BOOTSTRAP_CONFIG`。
  - SPA 路由重写：`[[redirects]] from = "/*" to = "/index.html" status = 200`，确保前端客户端路由及深度链接在 Netlify 正常回退。
- TypeScript 全量静态类型检查：
  - 执行 `yarn workspace @wisemapping/webapp tsc --noEmit`，完全通过，退出码 0，0 错误 0 告警。
- 生产构建产物验证：
  - 执行 `yarn workspace @wisemapping/webapp build`，成功在 `packages/webapp/dist` 生成 `index.html` 以及 142 个 JS/CSS/SVG 静态资源文件，耗时 ~3.3 秒。
- 真实 Supabase 实例 Live E2E 全链路集成验证：
  - 针对线上 Supabase 实例（`https://fzzkxymwcambugbxfsvj.supabase.co`）执行完整的自动化端到端闭环测试。
  - 覆盖以下核心场景：
    1. 用户认证与会话管理：注册测试用户、获取 JWT Session、校验用户元数据（`firstname`, `lastname`）。
    2. 导图 CRUD 与 RLS 权限隔离：新建导图、自动绑定 `auth.uid()`、写入初始 Tango XML、同步记录初始历史版本至 `public.mindmap_history`。
    3. 控制台与元数据查询：按修改时间降序查询用户导图列表并完成 `r_label_mindmap` 标签关系联表查询、单个导图元数据与 XML 查询。
    4. 导图修改与标星：更新导图标题与描述、标记为星标（starred），验证 `on_mindmap_updated` 自动更新 `updated_at` 触发器生效。
    5. 标签全生命周期管理：新建标签（`mindmap_labels`）、获取标签列表、将标签关联至导图（`r_label_mindmap`）、联表验证标签已挂载、解绑标签关系、删除标签。
    6. 编辑器持久化与版本回退：通过 `DOMParser` 解析 XML DOM 并校验语法无误、动态在 Central Topic 下追加新节点、通过 `XMLSerializer` 序列化为 XML 字符串、更新至 `public.mindmaps` 并插入历史快照到 `public.mindmap_history`、获取多版本历史列表、基于指定历史版本回退导图并验证 XML 恢复初始状态。
    7. 资源清理与退出登录：级联删除测试导图、测试用户登出注销。
    8. 全部 E2E 检查断言通过率 100%。


### 2.3 硬编码规范化与商业残留清理项（最新）
- **动态浏览器域名适配**：
  - 改造 `AppConfig.getUiBaseUrl()`：在浏览器环境下，若配置未显式指定非 localhost 域名，则自动回退为当前实际访问的 `window.location.origin`，彻底解决 Netlify / 自定义域名下节点深链地址错误的问题。
- **动态环境变量支持**：
  - 改造 `AppConfig.getSupabaseUrl()` 与 `getSupabaseAnonKey()`：优先读取 Vite 环境变量 `import.meta.env.VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY`，支持在 Netlify 控制台直接配置或覆盖，未配置时自动回退至 JSON 预置参数。
- **清除商业广告与多余预解析**：
  - 彻底从 `index.html` 中移除 Google AdSense 与 Funding Choices 广告脚本块（含官方 publisher ID `pub-6240866993689964`）。
  - 从 `index.html` 移除已废弃的 `<link rel="preconnect" href="https://api.wisemapping.com" />`。
- **导航抽屉精简（业务冗余优化）**：
  - 在纯个人自用架构下，所有云端导图均属于当前用户，原有「全部脑图（All）」与「我的思维导图（Owned）」过滤结果 100% 相同。
  - 从 `packages/webapp/src/components/maps-page/index.tsx` 中移除了冗余的 `owned`（我的思维导图）菜单项及对应的 `PersonOutlineTwoTone` 图标。
  - 侧边栏保留：📁 **全部** (`all`) -> ⭐ **已加星标** (`starred`) -> 🏷️ **自定义标签** (`labels`)。
- **清除右下角悬浮商业外链菜单**：
  - 从 `packages/webapp/src/components/maps-page/index.tsx` 及 `styled.ts` 中彻底移除了右下角浮动帮助按钮（`HelpButtonBox` / `HelpMenu`）。
  - 移除了包含官方条款（Terms of Use）、隐私政策（Privacy Policy）、PayPal 捐款（Donate）、官方团队邮箱等外部链接的浮动组件。
