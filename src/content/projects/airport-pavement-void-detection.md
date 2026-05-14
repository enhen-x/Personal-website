---
title: 机场道面板底脱空监测与评估
date: 2024-06-20
description: 本科毕业设计。基于有限元仿真与振动响应分析，提出一种利用功率谱密度指标定量评估机场水泥混凝土道面板底脱空程度的方法，并延伸为发表于 Measurement 期刊的预测模型研究。
---
<div style="height:3rem;"></div>
研究背景
<div style="height:1.5rem;"></div>

机场跑道采用水泥混凝土刚性道面结构，长期承受飞机动荷载与自然环境的共同作用。板底脱空是其中一类隐蔽性较强的结构病害——道面板与基层之间出现空隙后，板块失去均匀支承，荷载集中于局部区域，进而引发断板、错台等严重损伤，对飞机起降安全构成威胁。

现有主流检测手段以落锤式弯沉仪（FWD）为代表，通过测量道面弯沉盆推算脱空状态，技术成熟但无法实现实时监测，且对脱空尺寸的定量评估精度有限。振动响应法作为新兴方向，具备检测效率高、成本低的潜力，但如何从振动信号中提取能够准确反映脱空程度的定量指标，仍是该领域的核心难题。

---

<div style="height:3rem;"></div>
研究内容
<div style="height:1.5rem;"></div>

**有限元建模**

依据机场道面规范参数，使用 ABAQUS 建立了机场水泥混凝土道面板的三维有限元模型。通过在板底设置不同面积的接触脱离区域模拟脱空状态，施加落锤式弯沉仪冲击荷载，获取各测点的加速度时程响应。

<figure style="margin:1.25rem 0; text-align:center;">
  <img src="/photos/project/No.1/%E5%9B%BE%E7%89%871.png" alt="有限元应力云图（冲击荷载作用下的板体局部响应）" style="display:block; margin:0 auto;" />
  <figcaption style="margin-top:0.5rem; font-size:0.9em; color:#666;">图1. 冲击荷载作用后的局部应力集中区，用于说明脱空邻域在动力作用下的高敏感响应位置。</figcaption>
</figure>

**振动信号分析**

对冲击荷载作用下的加速度时域信号进行频域变换与小波变换分析，观察脱空状态下道面板振动特征的变化规律。研究发现，板底脱空导致自由振动阶段高频区域幅度显著降低，这一现象为后续指标提取提供了依据。

<figure style="margin:1.25rem 0; text-align:center;">
  <img src="/photos/project/No.1/%E5%9B%BE%E7%89%872.png" alt="多测点加速度时程响应（传感器阵列）" style="display:block; margin:0 auto;" />
  <figcaption style="margin-top:0.5rem; font-size:0.9em; color:#666;">图2. 多测点加速度时程曲线，体现冲击后自由振动阶段不同测点的响应差异。</figcaption>
</figure>

<figure style="margin:1.25rem 0; text-align:center;">
  <img src="/photos/project/No.1/%E5%9B%BE%E7%89%873.png" alt="无脱空与不同脱空程度的时域/频域对比" style="display:block; margin:0 auto;" />
  <figcaption style="margin-top:0.5rem; font-size:0.9em; color:#666;">图3. 无脱空、轻度脱空、重度脱空工况的时域与频域对比，可见脱空工况下高频分量衰减更明显。</figcaption>
</figure>

在此基础上，提出基于多测点功率谱密度（PSD）积分值的归一化指标，用于量化脱空引起的局部刚度退化与能量耗散。该指标通过传感器阵列采集，可在有限测点条件下实现对脱空状态的定量表征。

<figure style="margin:1.25rem 0; text-align:center;">
  <img src="/photos/project/No.1/%E5%9B%BE%E7%89%874.png" alt="时域、频域与PSD曲线综合对比（无脱空/0.8m/1.6m）" style="display:block; margin:0 auto;" />
  <figcaption style="margin-top:0.5rem; font-size:0.9em; color:#666;">图4. PSD维度对比显示，随着脱空尺度增大，功率谱密度整体下降且高频段衰减增强，与归一化PSD积分指标的表征思路一致。</figcaption>
</figure>

**正交试验验证**

设计正交试验，系统考察面层模量、脱空面积、传力杆刚度、阻尼系数等参数对所提指标的影响显著性，通过方差分析验证了脱空面积与功率指标之间的强相关性，为后续预测模型的建立提供了统计依据。

---

<div style="height:3rem;"></div>
延伸研究
<div style="height:1.5rem;"></div>

本科毕设完成后，导师课题组在此工作基础上进行了延伸研究，引入实验室缩尺模型试验对振动响应方法的可行性进行了实验验证，并构建了包含 225 个多工况场景的数据集，采用 Histogram-based Gradient Boosting 算法建立了脱空尺寸预测模型。

预测模型以归一化 PSD 积分指标及道面结构参数（面层厚度、基层厚度、面层弹性模量、基层弹性模量、地基反应模量）为输入，以脱空面积为输出，最终在测试集上取得 R² = 0.825、MAE = 0.178 m 的预测精度。

该研究以论文形式投稿至 *Measurement* 期刊（Elsevier），本人作为第三作者参与其中。

> Qiao Dong, Yirui Cao, Xiang Wang, **Songlin Xie**, Ziliang Ma. *Prediction model for Void Sizes beneath Airport Concrete Pavement Slab based on Vibration Monitoring*. Measurement, 2026. https://doi.org/10.1016/j.measurement.2026.120475

---

<div style="height:3rem;"></div>
主要结论
<div style="height:1.5rem;"></div>

- 板底脱空在冲击荷载作用下会导致道面板高频振动能量的显著衰减，这一特征可作为脱空识别的物理依据。
- 基于归一化功率谱密度积分值构建的评价指标，能够有效反映不同脱空面积下的结构刚度退化程度。
- 正交试验表明，脱空面积是影响所提指标的最显著因素，验证了该指标用于脱空定量评估的可靠性。
- 基于机器学习的预测模型具备在多种道面结构参数组合下预测脱空尺寸的能力，为机场道面实时监测提供了可行的技术路径。
