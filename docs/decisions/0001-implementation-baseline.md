# 0001 · MVP 施工基线

日期：2026-10-05。

采用开工文档方案 A：Node.js 24、严格 TypeScript、React、Vite、系统 Git。浏览器和 CLI 共用一个本地查询进程。初版保持本地只读，不引入任务快照、Git 写用例、云服务或第二宿主。

代码按 contracts / core / git-cli / graph-layout / local / cli / web 分开。规模尚小时采用一个根依赖清单和 pnpm workspace，TypeScript paths 指向包源码；esbuild 把 Node 入口打成不依赖开发服务器的独立产物，Vite 生成静态界面。没有为每个只转发函数建立额外抽象。

跨进程字段以 Zod schema 为单一来源，类型由 schema 推导。HTTP 校验请求，界面校验结果。解释规则只消费一次观测，Git 读取器通过窄接口注入核心。请求结果必须匹配会话、刷新代数、查询和请求身份。

Git 写操作只用于新建临时测试夹具。应用读取使用参数数组，限制子进程时间和输出，过滤器无法安全排除时降级并保留提示。

依赖版本以 package.json 和 pnpm-lock.yaml 为准。构建、语义验证、浏览器验收与性能测量分别记录在 docs/verification 中；未测量的门槛不标记通过。
