# k8sops

k8sops 是一个面向 Kubernetes 运维场景的 Web Agent 工具。用户在页面中粘贴 kubeconfig 后，可以用自然语言提问或下达排障指令，后端会为每个会话创建独立工作区，并通过 Codex SDK 调用大模型执行受 Kubernetes 场景约束的诊断流程。

项目适合用于集群巡检、Pod/Deployment/Service 状态排查、日志分析、事件查看、基础运维问答等场景。

## Features / 功能特性

- Web UI 创建和管理多个 Kubernetes 运维会话。
- 每个会话独立保存 kubeconfig，不读取宿主机 `~/.kube/config`。
- 内置 Kubernetes 运维 Agent 提示词，默认要求优先使用 `kubectl` 查询集群。
- 支持连续追问，同一会话会保留线程上下文和会话文件。
- 支持上传图片作为上下文，例如截图、监控图、报错页面。
- 通过 SSE 实时同步 Agent 执行事件和回复状态。
- 自动清理旧会话，可通过 `SESSION_MAX_COUNT` 控制保留数量。
- 支持 Docker / Docker Compose 部署。

## Tech Stack / 技术栈

- Runtime: [Bun](https://bun.sh/)
- Language: TypeScript
- LLM Agent: `@openai/codex-sdk`
- Kubernetes CLI: `kubectl`

## Requirements / 环境要求

- Bun 1.x
- 可访问的 LLM API 网关
- `kubectl`
- 可用的 Kubernetes kubeconfig

使用 Docker 镜像部署时，镜像内会安装 `kubectl`。

## Quick Start / 快速开始

复制环境变量模板：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
PORT=3210
KUBECTL_PATH=kubectl
SESSION_MAX_COUNT=30

LLM_BASE_URL=https://your-llm-gateway.example.com
LLM_MODEL=gpt-5
LLM_API_KEY=your_api_key_here
```

安装依赖并启动：

```bash
bun install
bun run dev
```

访问：

```text
http://localhost:3210
```

生产模式启动：

```bash
bun run start
```

类型检查：

```bash
bun run check
```

## Docker Deploy / Docker 部署

使用 Compose：

```bash
docker compose up -d
```

默认服务端口为 `3210`，会将本地 `./data` 挂载到容器 `/app/data`，用于保存会话数据、默认 Agent 提示词和相关运行文件。

如需自行构建镜像：

```bash
docker build -t k8sops .
docker run -d \
  --name k8sops \
  -p 3210:3210 \
  --env-file .env \
  -v "$(pwd)/data:/app/data" \
  k8sops
```

## Configuration / 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3210` | Web 服务监听端口 |
| `KUBECTL_PATH` | `kubectl` | `kubectl` 可执行文件路径 |
| `SESSION_MAX_COUNT` | `30` | 最多保留的会话数量 |
| `LLM_BASE_URL` | 无 | LLM API 网关地址 |
| `LLM_MODEL` | 无 | 使用的模型名称 |
| `LLM_API_KEY` | 无 | LLM API Key |

也兼容以下备用变量名：

- `CODEX_BASE_URL`
- `CODEX_MODEL`
- `CODEX_API_KEY`

## Usage / 使用方式

1. 打开 Web 页面。
2. 粘贴 kubeconfig，前端会做基础格式校验。
3. 创建会话后输入问题，例如：
   - `帮我检查 default 命名空间里 nginx 服务是否正常`
   - `查看最近失败的 Pod，并分析原因`
   - `这个 Deployment 为什么一直没有 Ready？`
4. Agent 会在当前会话目录中使用独立 kubeconfig 执行 `kubectl`，并把结果实时返回到页面。

## Data Layout / 数据目录

运行数据默认保存在 `data/`：

```text
data/
  AGENTS.md            # 默认 Kubernetes 运维 Agent 提示词
  session/             # 会话数据目录
```

每个会话会拥有独立目录，包含：

- `.kube/config`：当前会话 kubeconfig
- `.home/`：当前会话隔离 HOME
- `desc.txt`：首次提交的问题
- `conversation.md`：对话记录
- `events.jsonl`：Codex 执行事件
- `turns.json`：每轮请求与响应
- `session.json`：会话元数据

## Security Notes / 安全说明

- kubeconfig 属于敏感凭据，请只在可信网络和可信部署环境中使用。
- 建议通过反向代理增加登录鉴权、HTTPS 和访问控制。
- 不建议把 `.env`、`data/session/` 或真实 kubeconfig 提交到代码仓库。
- 当前 Agent 运行策略允许访问网络并执行命令，部署前请确认运行环境隔离边界。
- 建议为提供给 k8sops 的 kubeconfig 配置最小权限 RBAC。

## Development / 开发

常用命令：

```bash
bun run dev      # 开发模式，监听文件变更
bun run start    # 启动服务
bun run check    # TypeScript 类型检查
```

主要入口：

- `src/index.ts`：服务启动入口
- `src/server.ts`：HTTP API、静态资源、SSE
- `src/codex-runner.ts`：Codex 调用与会话执行逻辑
- `src/session-store.ts`：会话存储
- `public/`：前端页面资源
- `data/AGENTS.md`：默认 Agent 行为约束

## License / 许可证

本项目基于 [Apache License 2.0](./LICENSE) 开源。

## Acknowledgements / 鸣谢

- 本项目参与了 [LINUX DO](https://linux.do/) 开源推广计划。
