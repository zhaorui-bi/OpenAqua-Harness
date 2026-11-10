# About the OpenAqua science

OpenAqua Harness is an execution and interaction layer around
**OpenAqua**, a research framework for early-stage water-treatment train
design. This page summarizes what OpenAqua is, what evidence supports it, and
how to cite it. It is derived from the OpenAqua paper and its Supplementary
Information (SI).

## What OpenAqua does

OpenAqua is an automated multi-agent framework that supports early-stage
water-treatment train design with retrieval augmentation and critic-based
refinement. It decomposes a design request into five stages:

1. **Requirement analysis** — parse the source water, targets, intended use,
   and operational constraints; identify missing case data.
2. **Hierarchical knowledge retrieval** — retrieve unit-level technical
   evidence and template-level structural priors.
3. **Treatment train generation** — assemble candidate treatment trains from
   retrieved units and templates.
4. **Critic-based verification** — check candidate trains against constraints
   and evidence; flag weaknesses and risks.
5. **Result interpretation** — explain recommendations with explicit evidence,
   constraint checks, and uncertainty.

## What the knowledge base contains

The hierarchical knowledge base has two layers (SI Section S1):

- **Unit-level database** — pollutant removal effectiveness, applicable
  conditions, and technical boundaries of treatment units, built primarily
  from the **EPA Drinking Water Treatability Database**. It covers pollutant
  metadata, treatment effectiveness evidence, physicochemical properties, and
  source references.
- **Template-level database** — typical treatment-train configurations and
  their applicable scenarios, built primarily from the **WHO Compendium of
  Drinking Water Systems and Technologies**. It provides structural priors for
  candidate generation, not a replacement for unit-level evidence.

## WContBench

**WContBench** is the benchmark constructed to evaluate OpenAqua (SI Section
S2). Its cases were extracted from **EPA water-reuse case studies** and
**EPA CWSRF case studies**, recording raw-water background, target pollutants,
treatment trains, intended use, implementation constraints, and case sources.
The dataset is available at
[huggingface.co/datasets/zhaorui-bi/OpenAqua](https://huggingface.co/datasets/zhaorui-bi/OpenAqua).

## Evidence highlights

Relative to stand-alone LLMs, the paper reports that OpenAqua improves design
quality, structural similarity to reference treatment trains, constraint
satisfaction, and evidence support. Ablations attribute part of these gains to
the hierarchical knowledge base and retrieval augmentation. The SI adds blind
expert evaluation of generated trains (S5), reliability analysis of LLM
judges (S6), real-case replay evaluation (S7), and validation on an
emerging-contaminant scenario (S8).

## Relationship to this Harness

OpenAqua Harness does not vendor the OpenAqua source, processed knowledge
base, or WContBench — see the [FAQ](./FAQ.md) for how to connect a local
OpenAqua checkout. The Harness provides the CLI, desktop, and web workbench,
session management, and research-task discipline around the OpenAqua
workflow. Outputs are early-stage decision support, not field-ready designs.

## How to cite

If you use the OpenAqua scientific workflow, cite the OpenAqua paper and
report the exact software, dataset, index, and model versions used:

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

For the workbench software itself, see [CITATION.cff](../CITATION.cff).

中文版见 [docs/zh-CN/OPENAQUA.md](./zh-CN/OPENAQUA.md)。
