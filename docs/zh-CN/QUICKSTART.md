[English](../QUICKSTART.md) | 简体中文

# 快速上手

本指南完成 Harness 安装、OpenAqua 后端连接、知识库下载和第一次查询。

## 1. 环境要求

- Node.js 24.15.0+
- npm 12
- Python 3.10+
- macOS、Linux 或 Windows

## 2. 安装 Harness

```bash
git clone https://github.com/zhaorui-bi/OpenAqua-Harness.git
cd OpenAqua-Harness
npm ci
npm run setup
```

## 3. 安装 OpenAqua 与数据

```bash
git clone https://github.com/zhaorui-bi/OpenAqua.git
cd OpenAqua
git checkout 0e3990817946f1786828fabbfa9ba4bc06af96e8
cd water_treatment_agent
python3 -m venv .venv
source .venv/bin/activate                 # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
python -m pip install -U huggingface_hub

hf download zhaorui-bi/OpenAqua data.zip WContBench/ \
  --repo-type dataset \
  --revision cc2d3c620e8ada7c62fa922cf3a827d8b42889e3 \
  --local-dir ../hf_openaqua
unzip ../hf_openaqua/data.zip -d .
```

压缩包已包含顶层 `data/`，请解压到 `water_treatment_agent`；解压到已有的 `data/` 会产生错误的 `data/data/` 目录。上述 Git 与数据集修订版是本 Harness 版本的验证基线；如需升级，请记录新修订版并重新运行验证。

WContBench 位于 `../hf_openaqua/WContBench/`。

## 4. 配置 Harness 与后端

Harness 对话智能体需要一个模型提供方；OpenAqua 内部智能体可选使用 OpenRouter。

```bash
export DEEPSEEK_API_KEY="YOUR_KEY"
export OPENROUTER_API_KEY="YOUR_OPTIONAL_OPENROUTER_KEY"

cd /path/to/OpenAqua-Harness
./bin/openaqua onboard \
  --provider deepseek \
  --api-key-env DEEPSEEK_API_KEY \
  --openaqua-repo /path/to/OpenAqua
```

不带参数运行 `./bin/openaqua onboard` 可进入交互式向导。

## 5. 检查并构建索引

```bash
./bin/openaqua doctor --probe
./bin/openaqua run "检查 OpenAqua 状态；若知识库已下载但索引缺失，则构建索引。"
```

健康状态应显示 Python 依赖可用、`taxonomy.json`/TDB/案例数据存在，并且索引非空。

## 6. 第一次查询

```bash
./bin/openaqua run '
使用 OpenAqua 评估砷浓度为 150 µg/L 的地下水。
目标 ≤10 µg/L，预算低、运维技能低、无法处置浓水，且用于饮用。
请归一化查询、检索证据、推荐三条工艺链，并解释约束、风险、假设和不确定性。'
```

也可启动交互界面：

```bash
./bin/openaqua       # 完整 TUI
./bin/openaqua chat  # 轻量 REPL
./bin/openaqua web   # 浏览器界面
npm start            # Electron 桌面端
```

Windows 用户请将 `./bin/openaqua` 替换为 `npm run cli --`。

## 下一步

- [中文 README](../../README.zh-CN.md)
- [常见问题](./FAQ.md)
- [故障排查](./TROUBLESHOOTING.md)
- [工程工作流规范（英文）](../SCIENTIFIC_WORKFLOWS.md)
