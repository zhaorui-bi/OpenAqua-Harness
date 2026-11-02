# 面向水处理研究的 Harness 工作流

OpenAqua Harness 以水处理案例为工作单元，围绕 OpenAqua 五智能体流水线，
组织案例补全、证据适用性检查、候选工艺比较和可追溯交付。
原 [OpenAqua 论文](https://doi.org/10.1016/j.watres.2026.126761) 已覆盖需求解析、
分层检索、规划、约束审查与解释。Harness 的领域价值需要通过研究过程的完整性与
可审查性来验证；仅增加界面或工具数量不足以证明新的科学贡献。

## 案例到报告

```text
原水与采样背景 → 测量/单位/计量基准 → 出水目标与现场约束
                       ↓
               案例评估与信息补全
                       ↓
               证据检索与适用性审查
                       ↓
               候选工艺与规则审查
                       ↓
               报告审计与研究交付
```

| 阶段 | 已有入口 | 进入下一阶段的条件 |
| --- | --- | --- |
| 运行准备 | `openaqua_status`、`openaqua_catalog` | 后端、数据、索引和分类名称可用。 |
| 案例评估 | `openaqua_assess_case` | 核心阻断已解决；仍存在的信息缺口被明确展示。 |
| 证据检索 | `openaqua_retrieve_evidence` | 明确来源、片段与适用条件，区分检索结果与研究者判断。 |
| 方案比较 | `openaqua_recommend`、`openaqua_check_constraints` | 保留有序工艺链、规则结果、修订和未解决约束。 |
| 报告审计 | `openaqua_audit_report` | 查看报告中的 `status` 和问题清单；任务执行成功不等于审计通过。 |
| 交付 | `openaqua_job_manifest`、`openaqua_job_artifacts` | 案例、报告、证据、任务与版本/指纹可对应。 |

这些步骤通过工具和智能体操作指引组织。`recommend` 保持可直接调用；
它不是一个能阻止所有越级操作的强制状态机。CLI 的 `run`/`chat` 显式激活
OpenAqua 操作技能；Web/桌面使用领域指引；TUI 可用 `/openaqua` 激活同一技能。

`blocked` 表示存在关键问题，应先澄清，或明确限定为探索性检索。
`needs_information` 表示仍缺重要信息；应优先补全，条件性技术清单不能被表述为
已经满足出水目标。`ready_for_screening` 仅允许早期技术筛选，仍应阅读所有
中优先级提示，不能据此进行设备选型、剂量设计或现场性能保证。

## 保留水处理语义

| 信息 | JSON 查询文件字段 | 处理方式 |
| --- | --- | --- |
| 硝酸盐计量基准 | `water_quality.extra.nitrate_basis`、`treatment_targets.extra.nitrate_basis` | 分别声明 `as NO3` 或 `as N`；缺失、未知或不一致时要求澄清，不自动换算。 |
| 硬度计量基准 | `water_quality.extra.hardness_basis` | 例如 `as CaCO3`，不把 mg/L 自动解释为某种当量。 |
| 砷价态 | `water_quality.extra.arsenic_speciation` | 保留实测 As(III)/As(V) 信息；总砷不能代替价态。 |
| 铅出水目标 | `treatment_targets.extra.lead_ug_L` | 保留 µg/L 单位，不用标准名称代替具体终点。 |
| 设计流量 | `constraints.extra.design_flow_m3_day` | 记录已知的正数 m³/day；未知时限制为技术筛选。流量本身也不足以支持尺寸设计。 |

MCP 内联参数使用 `waterQuality`、`treatmentTargets` 和 `sourceWater`；
查询 JSON 文件使用上表的上游 snake_case 字段。
负浓度、非有限值等作为关键问题；普通水体系中超常 pH 要求核实，
不把 0–14 当作所有溶液的绝对物理边界。

所使用的上游解析器会丢弃部分显式 `extra`。Harness 在适配层保留这些上下文，
并通过 `context_preservation` 说明范围。保留字段不代表上游规划器已经使用它，
也不代表约束审查器已经实现对应规则。报告必须继续展示这部分未验证条件。

计量基准与工艺适用性依据可参见
[WHO 硝酸盐/亚硝酸盐资料](https://www.who.int/publications/m/item/chemical-fact-sheets--nitrate-nitrite)、
[WHO 硬度资料](https://www.who.int/publications/m/item/chemical-fact-sheets--hardness) 和
[EPA 砷处理技术评估手册](https://nepis.epa.gov/Exe/ZyPURL.cgi?Dockey=200026IH.TXT)。
这里借此定义信息需求，不内置法规限值或跨工况性能推断。

## 可直接检查的合成案例

以下数值全部是合成示例；出水目标是研究者设定的示意终点，不是适用法规的判定。

| 案例 | 应观察的行为 |
| --- | --- |
| [含砷地下水](../../examples/cases/arsenic-groundwater.json) | 可以进入技术筛选，但提示砷价态等信息不足；不声称完成设计。 |
| [硝酸盐基准不明](../../examples/cases/nitrate-basis-unknown.json) | 要求分别补充进、出水的 NO3/N 基准，不把两个 mg/L 数字直接比较。 |
| [铅采样背景不明](../../examples/cases/lead-source-unknown.json) | 将原水/采样背景列为阻断项，不能直接跳到源水处理工艺推荐。 |

在仓库根目录，可向 CLI、Web 或桌面智能体输入：

```text
读取 examples/cases/nitrate-basis-unknown.json，使用 queryFile 调用
openaqua_assess_case。展示关键阻断和最高优先级的信息需求。
不要替我猜测计量基准；在澄清前仅整理证据需求。
```

补全并确认案例后，再要求检索、推荐和审计；返回 `jobId`、结果路径、审计状态与
清单指纹。完整结果应说明证据对应的原水基质、价态、规模、运行条件及残余物处置，
并清楚区分“检索到了”“规则未拒绝”和“现场适用性已经验证”。

## 后续研究如何验证

可比较原 OpenAqua 与使用这些工作流的 Harness，在相同案例、知识快照、模型、
预算和评价条件下，测量：单位/计量基准错误检出、关键缺失信息识别、
不适用证据被接受的比例、无效审计通过率，以及完整交付与恢复成功率。
需要人工标注的工程适用性应由领域专家评审，并报告一致性与分歧。

这些是待实施的研究方案，当前回归测试只证明软件行为，不证明科学有效性提升。
WContBench 指标仍表示与基准参考的一致性；现场性能、成本、合规性与可运行性
需要另外的证据。实验版本、失败案例和完整分母要求见
[工程工作流规范](../SCIENTIFIC_WORKFLOWS.md)。
