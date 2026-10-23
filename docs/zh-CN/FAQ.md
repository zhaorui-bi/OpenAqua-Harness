# 常见问题

[English](../FAQ.md) | 简体中文

### OpenAqua Harness 是什么？

它是围绕开源 OpenAqua 水处理研究框架构建的独立本地工作台，增加了智能体交互、MCP 工具、持久化任务、运行溯源、CLI/TUI/Web/桌面端、安装向导与诊断。

### 本仓库是否包含 OpenAqua 和数据集？

不包含。Harness 仅包含适配器，不包含 OpenAqua 源码、Python 依赖、处理后知识库或 WContBench。需要单独克隆 OpenAqua，并从 Hugging Face 下载 `zhaorui-bi/OpenAqua`。

### 为什么有两套模型配置？

基于 Kimi Code 的 Harness 需要对话模型来规划并调用工具；OpenAqua 可选使用 OpenRouter 完成自然语言解析、规划和解释。两者凭据相互独立。未设置 `OPENROUTER_API_KEY` 时，OpenAqua 会使用规则/模板回退，但自然语言质量会下降。

### 如何避免把水质数据发给远程 OpenRouter 模型？

使用结构化字段并不设置 `OPENROUTER_API_KEY`。但 Harness 的对话模型仍可能接收提示词和工具输出；敏感数据应使用经批准的本地或私有模型，并遵守所在机构的数据政策。

### 后端如何定位？

可运行 `openaqua onboard --openaqua-repo /path/to/OpenAqua`，设置 `OPENAQUA_REPO`，或提供兼容适配器协议的 `OPENAQUA_COMMAND`。Harness 能识别仓库根目录以及 `water_treatment_agent/` 下的虚拟环境；`OPENAQUA_PYTHON` 可显式指定解释器。

### 为什么状态显示后端可运行，但数据缺失？

后端健康只表示适配器和 Python 能启动。OpenAqua 的处理后知识库位于 Hugging Face，而不在 Git 仓库中。请下载并解压 `data.zip`，再构建索引。

### `openaqua_ingest_knowledge` 会让检索立即使用新记录吗？

不会保证。它遵循 OpenAqua v1 行为，将 JSON 写入 `data/ingest`。原版 `IndexBuilder` 读取规范 TDB 和案例文件，不会自动合并暂存记录。暂存文件应作为后续人工整理输入。

### 推荐结果可以直接实施吗？

不可以。分类体系和规则检查不能证明去除性能、水力条件、残余物处置、化学兼容性、成本、可靠性、法规合规或现场可施工性。必须经过专业审核和场地化试验/设计。

### WContBench 衡量什么？

它比较预测处理单元或检索证据与基准参考的一致性，不衡量真实出水性能，也不构成法规合规证明。

### 任务与输出保存在哪里？

任务默认在 `<workdir>/openaqua-jobs/`，结果默认在 `<workdir>/openaqua-output/`。可用 `openaqua_job_list`、`openaqua_job_manifest` 和 `openaqua_job_artifacts` 恢复。

### Harness 智能体需要 OAuth 吗？

不需要。模型提供方使用 API key。推荐通过环境变量引用密钥；直接使用 `--api-key` 会把明文写入配置，并可能残留在 shell 历史中。

### OpenAqua Harness 与 Kimi Code 是什么关系？

本项目 vendored 了 MIT 许可的 Kimi Code 引擎，但属于独立产品。OpenAqua 专属层位于 `engine/apps/openaqua-harness`；直接运行上游 Kimi Code 时仍保持其原生身份和行为。

### 如何报告问题？

请在 <https://github.com/zhaorui-bi/OpenAqua-Harness/issues> 提交，并附脱敏后的 `openaqua doctor --json`、操作系统、Node/Python 版本、OpenAqua commit 和最小复现。安全漏洞请使用 [SECURITY.md](../../SECURITY.md) 中的私密渠道。
