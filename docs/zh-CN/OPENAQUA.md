# OpenAqua 科学背景

OpenAqua Harness 是围绕 **OpenAqua** 构建的执行与交互层。OpenAqua 是一个
面向早期水处理工艺路线设计的研究框架。本文说明 OpenAqua 是什么、有何
证据支撑、以及应当如何引用。内容整理自 OpenAqua 论文及其补充信息
（Supplementary Information, SI）。

## OpenAqua 做什么

OpenAqua 是一个检索增强、带批评式精炼（critic-based refinement）的
自动化多智能体框架，支撑早期水处理工艺路线设计。它将设计请求分解为
五个阶段：

1. **需求解析** —— 解析原水水质、处理目标、用途与运行约束，识别缺失
   的案例数据。
2. **层级知识检索** —— 检索单元级技术证据与模板级结构先验。
3. **工艺路线生成** —— 由检索到的单元与模板组装候选处理工艺路线。
4. **批评式校验** —— 对照约束与证据检查候选路线，标记薄弱环节与风险。
5. **结果解释** —— 给出带明确证据、约束检查与不确定性说明的推荐结论。

## 知识库内容

层级知识库包含两层（SI 第 S1 节）：

- **单元级数据库** —— 处理单元对污染物的去除效果、适用条件与技术
  边界，主要构建自 **EPA 饮用水处理性数据库（Drinking Water Treatability
  Database）**，涵盖污染物元数据、处理效果证据、理化性质与参考文献。
- **模板级数据库** —— 典型工艺路线构型及其适用场景，主要构建自
  **WHO 饮用水系统与技术纲要（Compendium of Drinking Water Systems and
  Technologies）**，为候选路线生成提供结构先验，而非替代单元级证据。

## WContBench

**WContBench** 是为评估 OpenAqua 构建的基准（SI 第 S2 节），案例提取自
**EPA 水回用案例库**与 **EPA CWSRF 案例库**，记录原水背景、目标污染物、
处理路线、处理后用途、实施约束与案例来源。数据集见
[huggingface.co/datasets/zhaorui-bi/OpenAqua](https://huggingface.co/datasets/zhaorui-bi/OpenAqua)。

## 证据要点

论文报告：相比独立使用大语言模型，OpenAqua 在设计质量、与参考工艺
路线的结构相似度、约束满足度和证据支撑方面均有提升；消融实验表明
层级知识库与检索增强是提升设计质量的重要因素。SI 进一步给出生成
路线的盲评（S5）、LLM 评审的可靠性分析（S6）、真实案例回放评估（S7）
以及新兴污染物情景验证（S8）。

## 与本 Harness 的关系

OpenAqua Harness 不包含 OpenAqua 源码、处理后的知识库或 WContBench
——接入方式见 [FAQ](../FAQ.md)。Harness 提供围绕 OpenAqua 工作流的
CLI、桌面端与 Web 工作台、会话管理与研究任务规范。其输出属于早期
决策支持，不构成可直接施工的设计。

## 如何引用

使用 OpenAqua 科学流程时，请引用 OpenAqua 论文，并注明实际使用的
软件、数据集、索引与模型版本：

> Liu H., Jiang Z., Zhong H., Li J., Pang W., Yuan Y. (2027). OpenAqua: An
> automated multi-agent framework for early-stage water treatment train design
> with retrieval augmentation and critic-based refinement. *Water Research*
> 308, 126761. <https://doi.org/10.1016/j.watres.2026.126761>

```bibtex
@article{liu2027openaqua,
  title = {OpenAqua: An automated multi-agent framework for early-stage water treatment train design with retrieval augmentation and critic-based refinement},
  author = {Liu, Hanzhang and Jiang, Zhaorui and Zhong, Huiling and Li, Jinshuo and Pang, Wei and Yuan, Yingfang},
  journal = {Water Research},
  volume = {308},
  pages = {126761},
  year = {2027},
  doi = {10.1016/j.watres.2026.126761},
  url = {https://doi.org/10.1016/j.watres.2026.126761}
}
```

工作台软件本身的引用信息见 [CITATION.cff](../../CITATION.cff)。

英文版见 [docs/OPENAQUA.md](../OPENAQUA.md)。
