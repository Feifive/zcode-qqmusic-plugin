# QQ 音乐"魔法色"取色算法与调色板规则 — 完整技术规格

## 目录

1. [总体流水线](#1-总体流水线)
2. [阶段一：封面取色 `QMAlbumColorPicker`](#2-阶段一封面取色)
3. [阶段二：魔法色 → 调色板映射 `QMPlayerAlbumStyleColorPicker`](#3-阶段二魔法色--调色板映射)
4. [阶段三：播放页 5 色套组 `multiColorsArray`](#4-阶段三播放页-5-色套组)
5. [完整调色板规则表](#5-完整调色板规则表)
6. [与 zcode-music-plugin 实现的对照](#6-与-zcode-music-plugin-实现的对照)
7. [附录：符号与地址索引](#7-附录符号与地址索引)

---

## 1. 总体流水线

切歌时播放页颜色的完整生成链路，全部在客户端本地完成，没有服务端参与：

```
切歌
 └─ QMSongPageView updateAlbum                     (0x100363688)
     └─ updateAlbuMagicColor                       (0x100363c90)
         └─ [QMAlbumColorPicker pickColorsOfImage:封面 count:3]
             │  ① 封面缩略为 10×10 位图（100 像素）
             │  ② 像素按 HSB 分类：无彩色 → 明/暗桶；彩色 → 8 个色相桶
             │  ③ 色相桶按像素数降序，取前 3 个
             │  ④ 桶内选离 (S=0.6, B=0.6) 最近的像素（"鲜活色"）
             │  ⑤ 柔和化：S' = S×0.2+0.5, B' = B×0.2+0.5
             └─ setMagicColors:                    → 魔法色数组（最多 3 色）
                 │
     ┌───────────┴────────────┐
     ▼                        ▼
 魔法色映射规则表            播放页 5 色套组
 QMPlayPageConfigManager     QMPlayPageConfigManager
 .magicColorMapping          .multiColorsArray
 (26 条规则 × 明/暗两套)     (26 组 × 4~5 色)
     │                        │  色相边界查表 dbl_101D93F98
     ▼                        ▼
 QMPlayerAlbumStyleColorPicker   playerColorsWithMagicColor:
 pickColorFromMagicBgColor:      (0x1003c2808)
 (0x10053b168)                   → [NSColor × 5] 播放页主题套色
     │
     ▼
 QMSongPageColor（页面配色模型）
 normalBgColor / themeColor / textNormalColor / textHoverColor
 buttonNormalColor / playBarColor / playerMagicColor
 playerGaussianColor（高斯背景）/ playerHaloColor（光晕）
```

黑胶唱片风格另有一条固定目标值路径：`QMPlayingRecordPlayerAlbumStyle magicColorS/magicColorB`（0x1003c9028/0x1003c9050）按风格类型返回固定的目标饱和度/亮度——`type == 1` 时 **S=0.3、B=0.7**，其余 **S=0.2、B=0.8**（常量在 `dbl_101D94090 = [0.2, 0.3]`、`dbl_101D940A0 = [0.8, 0.7]`）。

---

## 2. 阶段一：封面取色

对应类 `QMAlbumColorPicker`（配辅助类 `QMAlbumBitmapInfo`）。入口 `QMSongPageView.updateAlbuMagicColor` 调用 `pickColorsOfImage:count:`，**count 固定为 3**。

### 2.1 输入与缩略

- `initWithImage:` 默认 `dimension = 10`（0x1004316a4），即先把封面缩略成 **10×10 = 100 像素**再分析，成本几乎为零。
- 缩略图转换为 `QMAlbumBitmapInfo`：像素数组 + 宽高，支持 `subBitmapInRect:` 局部取色（`pickColorInRect:` 系列）。

### 2.2 像素分类（`__pickColorsInBitmap:count:pureColor:adjusted:` @ 0x100431c90）

每个像素转 HSB（hue 0–360°、saturation/brightness 0–1）后二选一：

**无彩色判定**（先于色相判断）：

```
亮度 B×100 < 12   或   饱和度 S×100 ≤ 11
```

命中者不参与色相分桶，改为按 **WCAG 相对亮度** 二分（`+[NSColor relativeLuminanceOfColor:]` @ 0x1002f6fdc）：

- `L ≥ 0.5` → 计入"明桶"（bright）
- `L < 0.5` → 计入"暗桶"（dark）

**色相分桶**（其余像素，按 `trunc(hue × 360)` 的整数度数）：

| 桶 | 色相区间（度） | 色族 |
|---|---|---|
| 0 | `h < 21` 或 `h ≥ 330` | 红（跨 0° 回绕） |
| 1 | `21 ≤ h < 41` | 橙 |
| 2 | `41 ≤ h < 76` | 黄 |
| 3 | `76 ≤ h < 156` | 绿 |
| 4 | `156 ≤ h < 191` | 青 |
| 5 | `191 ≤ h < 257` | 蓝 |
| 6 | `257 ≤ h < 296` | 紫 |
| 7 | `296 ≤ h < 330` | 品红 |

分支源码（比较的是 `trunc(h*360)` 的无符号比较）：

```c
if (hue >= 21 && hue < 330) {          // 非红
  if (hue < 41)  → 橙
  else if (hue < 76)  → 黄
  else if (hue < 156) → 绿
  else if (hue < 191) → 青
  else if (hue < 257) → 蓝
  else if (hue < 296) → 紫
  else                → 品红
} else → 红
```

### 2.3 桶排序与"鲜活色"选择

1. 8 个色相桶按**像素数量降序**排序（`sortUsingComparator:`），取前 `count`（=3）个——天然保证输出的 3 个颜色**色相族互不重复**。
2. 每个桶内，遍历桶中全部像素，选使下式最小的那个像素（欧氏距离，比较平方即可）：

```
distance = (S − 0.6)² + (B − 0.6)²
```

即"鲜活度"最优：既不太灰、也不荧光。这正是 Android Palette 里 Vibrant 色的思想，但实现只是一个二维最近邻。

3. 空桶跳过（结果可能少于 count 个）。

### 2.4 柔和化（`__adjustedColor:` @ 0x1004323f8）

对每个入选颜色做最终归一（色相不变）：

```
S' = S × 0.2 + 0.5      （值域被压缩进 [0.5, 0.7]）
B' = B × 0.2 + 0.5      （值域被压缩进 [0.5, 0.7]）
```

无论封面是死黑还是荧光粉，输出一律是中等饱和度、中高亮度的**马卡龙色**。这是 QQ 音乐主题色观感柔和的直接原因，也是整个算法里最重要的一行。

### 2.5 pureColor 输出（无彩色的兜底）

函数额外输出一个 `pureColor`（通过指针参数），语义是"如果这张图本质是黑白的，用什么单色代表"：

```
设 maxBucket = 8 个色相桶中的最大像素数, light/dark = 明桶/暗桶计数

若 dark ≤ maxBucket 且 maxBucket > 0 且 light ≤ maxBucket:
    pureColor = 提取出的第 1 个颜色          （彩色图）
否则若 dark ≤ light:
    pureColor = 白色
否则:
    pureColor = 黑色
```

即彩色像素占主导时返回首个鲜颜色；黑白封面返回白或黑（多数亮灰像素 → 白，多数暗像素 → 黑）。

---

## 3. 阶段二：魔法色 → 调色板映射

提取出的颜色并不直接上屏，而是作为 **magicBgColor** 进入 `QMPlayerAlbumStyleColorPicker`，在 `QMPlayPageConfigManager.magicColorMapping`（0x1003c2fcc）这张**客户端硬编码的规则表**里查表，得到设计师手工调校的成品色。

### 3.1 规则 DSL 结构

每条规则是一个字典：

```json
{
  "h":     [下界, 上界],      // 可选：色相区间（整数度）
  "s":     [下界, 上界],      // 可选：饱和度区间（整数百分比）
  "b":     [下界, 上界],      // 可选：亮度区间（整数百分比）
  "op":    "or" | "and",      // 可选：三个区间判断的组合方式，缺省 or
  "value": ["#RRGGBB", ...]   // 命中后输出的成品色数组
}
```

内置表中：灰度规则带 `s`+`b`（不带 `h`），色相规则只带 `h`（不带 `s`/`b`），都不带 `op`（用默认）。

### 3.2 匹配算法（`pickColorFromMagicBgColor:` @ 0x10053b168）

1. 魔法底色转 HSB 并**整数化**：`h = trunc(hue×360)`、`s = trunc(S×100)`、`b = trunc(B×100)`。
2. `treatZeroHueAs360` 默认 **YES**（`initWithColorMapping:` @ 0x10053b0f0 显式置 1）：`h == 0` 时按 **360** 参与匹配——所以纯红落在最后一条 `348–360` 规则里，第一条色相规则从 1 开始。
3. 对每个区间字段（`h`/`s`/`b`）判断"该分量是否落在区间内"。区间判断是**闭区间包含且边界无序**（`colorComponents:capturedByRange:` @ 0x10053b67c）：
   ```c
   lo = min(v[0], v[1]); hi = max(v[0], v[1]);
   return lo ≤ 分量值 ≤ hi;          // 数组长度 ≠ 2 时直接判 false
   ```
   规则里**缺失的字段判 false**（`arrayNotNilForKey:` 对缺失键返回空数组 → count≠2 → false）。
4. 三个布尔结果按 `op` 链式结合（`opFuncTypeFromStr:` @ 0x10053b828：`"or"→0`、`"and"→1`；`defaultOpFuncType` 未显式设置时为 0 即 **or**）：
   ```
   match = op( op(hIn, sIn), bIn )
   ```
   因此只带 `h` 的色相规则（hIn=true, sIn=bIn=false）用 **or** 才能命中；灰度规则（hIn=false）在 or 下等价于 `s ∈ [0,11] 或 b ∈ [0,11]`——**饱和度或亮度过低即视为无彩色**，与取色阶段的无彩色阈值（12/11）呼应但独立取值。
5. 规则按数组顺序枚举，**第一条命中即停止**（`enumerateObjectsUsingBlock:` 的 stop 标志）。灰度规则排在第 0 位，所以无彩色永远优先命中灰度规则。
6. 命中规则的 `value` 数组逐个解析为 NSColor（`#RRGGBB` 十六进制）返回。

### 3.3 取用（`getColorWithMagicColor:businessIndex:` @ 0x10053b758）

- 魔法色为 nil 时回退纯黑 `(0,0,0)` 再查表；
- `businessIndex` 直接取 `value[index]`（越界返回 nil）。按 value 结构与播放页视觉推断：**index 0 = 页面淡底色，1 = 强调色（歌词/按钮/进度），2 = 前景底**（亮色表恒为 `#FFFFFF`、暗色表恒为 `#1E1E1F`）；带 `businessKey:` 的变体按业务键换算 index（键名映射未完整还原，此句为结构推断）。
- 表本身按 `isLightSkin` 二选一：亮色/暗色两张表，结构完全相同（26 条），只有 value 色值不同。

---

## 4. 阶段三：播放页 5 色套组

`playerColorsWithMagicColor:`（0x1003c2808）是另一条**并行**的取色路径，输出播放页整体主题的 5 个颜色（供 `QMSongPageColor` 等使用）：

1. 若用户在设置里选了自定义颜色（`QMPlayPageConfig.colorHex` 非空且 ≠ `"000000"`），优先按该 hex 在 `multiColorsArray` 各组内查找索引（block `sub_1003C2C30`）。
2. 否则用魔法色：**要求 `S ≥ 13%` 且 `B ≥ 13%`**（无彩色直接放弃），然后在线性查找表 `dbl_101D93F98`（25 个 double 上界）里定位色相桶：
   ```
   i = 0; while (bounds[i] < trunc(hue×360)) i++;   // bounds 见下表
   ```
3. 取 `multiColorsArray[i]`（该桶的 hex 字符串组），逐个经 `+[ComHelper colorWithHexString:]` 转 NSColor 返回（4 色；灰度组 5 色）。
4. 全部失败时回退默认 **QQ 绿 `RGB(0, 0.945, 0.408)` ≈ `#00F168`** 五份。

`dbl_101D93F98` 的 25 个上界（与映射规则的色相区间**不完全相同**，注意 `121→137` 一带略有错位）：

```
10, 20, 30, 40, 52, 63, 75, 88, 100, 121, 137, 152, 165, 180, 200,
220, 256, 265, 278, 290, 305, 321, 334, 347, 360
```

**交叉验证**：`multiColorsArray` 每个彩色组的第 4 色 === `magicColorMapping` 亮色表同色相规则的 `value[1]`（25 组逐一吻合，见第 5 节两表）。两张表共享同一套设计色系：第 4 色是"该色相族的标准强调色"，前三色是同族渐变的浅→深变体。

---

## 5. 完整调色板规则表

以下全部色值/区间逐条摘自二进制常量（非推测）。"暗色表"与"亮色表"的规则结构、区间完全一致，仅 value 不同。

### 5.1 `magicColorMapping` — 亮色皮肤（26 条）

| # | 匹配条件 | value[0] 底色 | value[1] 强调色 | value[2] 前景底 |
|---|---|---|---|---|
| 0 | `s∈[0,11]` ∥ `b∈[0,11]`（灰度兜底） | `#C0C0C7` | `#8F8F94` | `#FFFFFF` |
| 1 | `h 1–10` | `#FFC3BF` | `#F56A62` | `#FFFFFF` |
| 2 | `h 11–20` | `#FFD0BD` | `#F38C63` | `#FFFFFF` |
| 3 | `h 21–30` | `#FFD8BA` | `#F09C5B` | `#FFFFFF` |
| 4 | `h 31–40` | `#FFE1B8` | `#F2B561` | `#FFFFFF` |
| 5 | `h 41–52` | `#FFEDB1` | `#EBCC6A` | `#FFFFFF` |
| 6 | `h 53–63` | `#FFFFB0` | `#DBD760` | `#FFFFFF` |
| 7 | `h 64–75` | `#F0FFA7` | `#C2D466` | `#FFFFFF` |
| 8 | `h 76–88` | `#E2FFB1` | `#B5E06C` | `#FFFFFF` |
| 9 | `h 89–100` | `#D4FFB5` | `#9AD96C` | `#FFFFFF` |
| 10 | `h 101–121` | `#C9FFBE` | `#83D173` | `#FFFFFF` |
| 11 | `h 122–136` | `#BCFFC8` | `#74D486` | `#FFFFFF` |
| 12 | `h 137–152` | `#B9FFD6` | `#6ECC95` | `#FFFFFF` |
| 13 | `h 153–165` | `#AFFFE3` | `#52CCA1` | `#FFFFFF` |
| 14 | `h 166–180` | `#A7FFF5` | `#45C8B8` | `#FFFFFF` |
| 15 | `h 181–200` | `#A3ECFF` | `#2DBADE` | `#FFFFFF` |
| 16 | `h 201–220` | `#ABCEFF` | `#5792E6` | `#FFFFFF` |
| 17 | `h 221–256` | `#B0B6FF` | `#7680F5` | `#FFFFFF` |
| 18 | `h 257–265` | `#D2B9FF` | `#9567EB` | `#FFFFFF` |
| 19 | `h 266–278` | `#DDB7FF` | `#B571F0` | `#FFFFFF` |
| 20 | `h 279–290` | `#EEBAFF` | `#C76EEB` | `#FFFFFF` |
| 21 | `h 291–305` | `#FDBDFF` | `#D769DB` | `#FFFFFF` |
| 22 | `h 306–321` | `#FFBBF0` | `#E06CC7` | `#FFFFFF` |
| 23 | `h 322–334` | `#FFC0E3` | `#F56EBA` | `#FFFFFF` |
| 24 | `h 335–347` | `#FFBED4` | `#F26B99` | `#FFFFFF` |
| 25 | `h 348–360`（含 hue 0） | `#FFC0C6` | `#F3616F` | `#FFFFFF` |

### 5.2 `magicColorMapping` — 暗色皮肤（26 条）

| # | 匹配条件 | value[0] 底色 | value[1] 强调色 | value[2] 前景底 |
|---|---|---|---|---|
| 0 | `s∈[0,11]` ∥ `b∈[0,11]`（灰度兜底） | `#4A4A4A` | `#666666` | `#1E1E1F` |
| 1 | `h 1–10` | `#701914` | `#A62821` | `#1E1E1F` |
| 2 | `h 11–20` | `#752B12` | `#B3461B` | `#1E1E1F` |
| 3 | `h 21–30` | `#8F4914` | `#CD6718` | `#1E1E1F` |
| 4 | `h 31–40` | `#B37115` | `#EB9723` | `#1E1E1F` |
| 5 | `h 41–52` | `#A68929` | `#E6C045` | `#1E1E1F` |
| 6 | `h 53–63` | `#999517` | `#D1CB15` | `#1E1E1F` |
| 7 | `h 64–75` | `#6B7D12` | `#97AD25` | `#1E1E1F` |
| 8 | `h 76–88` | `#567D13` | `#75AD15` | `#1E1E1F` |
| 9 | `h 89–100` | `#36720B` | `#50A116` | `#1E1E1F` |
| 10 | `h 101–121` | `#1A690A` | `#25940F` | `#1E1E1F` |
| 11 | `h 122–136` | `#0B6B1C` | `#139E2C` | `#1E1E1F` |
| 12 | `h 137–152` | `#0E7338` | `#19A553` | `#1E1E1F` |
| 13 | `h 153–165` | `#106E4D` | `#0F9969` | `#1E1E1F` |
| 14 | `h 166–180` | `#1B7069` | `#129989` | `#1E1E1F` |
| 15 | `h 181–200` | `#025D74` | `#08809E` | `#1E1E1F` |
| 16 | `h 201–220` | `#0F4694` | `#145EC7` | `#1E1E1F` |
| 17 | `h 221–256` | `#242D87` | `#313DC4` | `#1E1E1F` |
| 18 | `h 257–265` | `#4819A1` | `#561BC2` | `#1E1E1F` |
| 19 | `h 266–278` | `#562085` | `#6214A6` | `#1E1E1F` |
| 20 | `h 279–290` | `#66237D` | `#8635A6` | `#1E1E1F` |
| 21 | `h 291–305` | `#721775` | `#99279D` | `#1E1E1F` |
| 22 | `h 306–321` | `#731B60` | `#9E2884` | `#1E1E1F` |
| 23 | `h 322–334` | `#73174B` | `#9E276A` | `#1E1E1F` |
| 24 | `h 335–347` | `#751535` | `#991E48` | `#1E1E1F` |
| 25 | `h 348–360`（含 hue 0） | `#6B181F` | `#9A232E` | `#1E1E1F` |

### 5.3 `multiColorsArray` — 播放页 5 色套组（26 组）

每组 4 色 = 同色相族的 浅→深 渐变变体 + 标准强调色；**第 4 色 = 5.1 表同色相的 value[1]**。第 26 组为灰度组（5 色）。色相列是 `dbl_101D93F98` 边界对应的落桶区间（`(上界(i−1), 上界(i)]`，首桶 `≤ 10`）。

| # | 色相区间 | 色 1（最浅） | 色 2 | 色 3 | 色 4（标准强调） |
|---|---|---|---|---|---|
| 0 | ≤10 | `#FF8780` | `#F46259` | `#E05851` | `#F56A62` |
| 1 | 10–20 | `#FFA480` | `#F67A48` | `#E67649` | `#F38C63` |
| 2 | 20–30 | `#FFB780` | `#F58C3D` | `#DB823D` | `#F09C5B` |
| 3 | 30–40 | `#FFE4BF` | `#EBA038` | `#EB9F34` | `#F2B561` |
| 4 | 40–52 | `#FFE180` | `#E6B517` | `#D9B645` | `#EBCC6A` |
| 5 | 52–63 | `#FFFB80` | `#CCC733` | `#C7C450` | `#DBD760` |
| 6 | 63–75 | `#EAFF80` | `#ABC427` | `#A9BA4E` | `#C2D466` |
| 7 | 75–88 | `#D0FF80` | `#8CC628` | `#97C744` | `#B5E06C` |
| 8 | 88–100 | `#B5FF80` | `#68C724` | `#77C540` | `#9AD96C` |
| 9 | 100–121 | `#95FF80` | `#42C728` | `#5EB64D` | `#83D173` |
| 10 | 121–137 | `#80FF97` | `#3CC755` | `#4EBA62` | `#74D486` |
| 11 | 137–152 | `#80FFB5` | `#1CC260` | `#3FB370` | `#6ECC95` |
| 12 | 152–165 | `#80FFD2` | `#2FBF8D` | `#2EB786` | `#52CCA1` |
| 13 | 165–180 | `#80FFF0` | `#28C7B4` | `#34AD9F` | `#45C8B8` |
| 14 | 180–200 | `#80E5FF` | `#38B3D1` | `#3AA6C2` | `#2DBADE` |
| 15 | 200–220 | `#80B5FF` | `#478CED` | `#4780D1` | `#5792E6` |
| 16 | 220–256 | `#808AFF` | `#636EED` | `#656FE6` | `#7680F5` |
| 17 | 256–265 | `#AC80FF` | `#925DF2` | `#8050D9` | `#9567EB` |
| 18 | 265–278 | `#C380FF` | `#A55BE7` | `#A05CDB` | `#B571F0` |
| 19 | 278–290 | `#DF80FF` | `#C85DF2` | `#B85EDB` | `#C76EEB` |
| 20 | 290–305 | `#FB80FF` | `#E15CE6` | `#C158C4` | `#D769DB` |
| 21 | 305–321 | `#FF80E3` | `#E767CB` | `#C757AE` | `#E06CC7` |
| 22 | 321–334 | `#FF80C7` | `#F64AAB` | `#D9529E` | `#F56EBA` |
| 23 | 334–347 | `#FF80AB` | `#F74582` | `#DB5885` | `#F26B99` |
| 24 | 347–360 | `#FF808B` | `#F05A66` | `#D95762` | `#F3616F` |
| 25 | 灰度（不按色相取用） | `#1CC260` | `#A0A0A6` | `#1E1E1F` | `#6E6E73`、`#8F8F94`（5 色） |

### 5.4 机器可读 JSON

```json
{
  "extract": {
    "thumbnail": 10,
    "achromatic": { "brightnessBelowPct": 12, "saturationAtMostPct": 11, "luminanceSplit": 0.5 },
    "hueBucketsDeg": [
      [330, 21], [21, 41], [41, 76], [76, 156],
      [156, 191], [191, 257], [257, 296], [296, 330]
    ],
    "vividTarget": { "s": 0.6, "b": 0.6 },
    "soften": { "s": "s*0.2+0.5", "b": "b*0.2+0.5" },
    "pickCount": 3
  },
  "mapping": {
    "quantize": { "h": "trunc(h*360)", "s": "trunc(s*100)", "b": "trunc(b*100)" },
    "treatZeroHueAs360": true,
    "defaultOp": "or",
    "rangeMatch": "closed, order-insensitive",
    "firstMatchWins": true,
    "light": [
      { "s": [0, 11], "b": [0, 11], "value": ["#C0C0C7", "#8F8F94", "#FFFFFF"] },
      { "h": [1, 10],    "value": ["#FFC3BF", "#F56A62", "#FFFFFF"] },
      { "h": [11, 20],   "value": ["#FFD0BD", "#F38C63", "#FFFFFF"] },
      { "h": [21, 30],   "value": ["#FFD8BA", "#F09C5B", "#FFFFFF"] },
      { "h": [31, 40],   "value": ["#FFE1B8", "#F2B561", "#FFFFFF"] },
      { "h": [41, 52],   "value": ["#FFEDB1", "#EBCC6A", "#FFFFFF"] },
      { "h": [53, 63],   "value": ["#FFFFB0", "#DBD760", "#FFFFFF"] },
      { "h": [64, 75],   "value": ["#F0FFA7", "#C2D466", "#FFFFFF"] },
      { "h": [76, 88],   "value": ["#E2FFB1", "#B5E06C", "#FFFFFF"] },
      { "h": [89, 100],  "value": ["#D4FFB5", "#9AD96C", "#FFFFFF"] },
      { "h": [101, 121], "value": ["#C9FFBE", "#83D173", "#FFFFFF"] },
      { "h": [122, 136], "value": ["#BCFFC8", "#74D486", "#FFFFFF"] },
      { "h": [137, 152], "value": ["#B9FFD6", "#6ECC95", "#FFFFFF"] },
      { "h": [153, 165], "value": ["#AFFFE3", "#52CCA1", "#FFFFFF"] },
      { "h": [166, 180], "value": ["#A7FFF5", "#45C8B8", "#FFFFFF"] },
      { "h": [181, 200], "value": ["#A3ECFF", "#2DBADE", "#FFFFFF"] },
      { "h": [201, 220], "value": ["#ABCEFF", "#5792E6", "#FFFFFF"] },
      { "h": [221, 256], "value": ["#B0B6FF", "#7680F5", "#FFFFFF"] },
      { "h": [257, 265], "value": ["#D2B9FF", "#9567EB", "#FFFFFF"] },
      { "h": [266, 278], "value": ["#DDB7FF", "#B571F0", "#FFFFFF"] },
      { "h": [279, 290], "value": ["#EEBAFF", "#C76EEB", "#FFFFFF"] },
      { "h": [291, 305], "value": ["#FDBDFF", "#D769DB", "#FFFFFF"] },
      { "h": [306, 321], "value": ["#FFBBF0", "#E06CC7", "#FFFFFF"] },
      { "h": [322, 334], "value": ["#FFC0E3", "#F56EBA", "#FFFFFF"] },
      { "h": [335, 347], "value": ["#FFBED4", "#F26B99", "#FFFFFF"] },
      { "h": [348, 360], "value": ["#FFC0C6", "#F3616F", "#FFFFFF"] }
    ],
    "dark": [
      { "s": [0, 11], "b": [0, 11], "value": ["#4A4A4A", "#666666", "#1E1E1F"] },
      { "h": [1, 10],    "value": ["#701914", "#A62821", "#1E1E1F"] },
      { "h": [11, 20],   "value": ["#752B12", "#B3461B", "#1E1E1F"] },
      { "h": [21, 30],   "value": ["#8F4914", "#CD6718", "#1E1E1F"] },
      { "h": [31, 40],   "value": ["#B37115", "#EB9723", "#1E1E1F"] },
      { "h": [41, 52],   "value": ["#A68929", "#E6C045", "#1E1E1F"] },
      { "h": [53, 63],   "value": ["#999517", "#D1CB15", "#1E1E1F"] },
      { "h": [64, 75],   "value": ["#6B7D12", "#97AD25", "#1E1E1F"] },
      { "h": [76, 88],   "value": ["#567D13", "#75AD15", "#1E1E1F"] },
      { "h": [89, 100],  "value": ["#36720B", "#50A116", "#1E1E1F"] },
      { "h": [101, 121], "value": ["#1A690A", "#25940F", "#1E1E1F"] },
      { "h": [122, 136], "value": ["#0B6B1C", "#139E2C", "#1E1E1F"] },
      { "h": [137, 152], "value": ["#0E7338", "#19A553", "#1E1E1F"] },
      { "h": [153, 165], "value": ["#106E4D", "#0F9969", "#1E1E1F"] },
      { "h": [166, 180], "value": ["#1B7069", "#129989", "#1E1E1F"] },
      { "h": [181, 200], "value": ["#025D74", "#08809E", "#1E1E1F"] },
      { "h": [201, 220], "value": ["#0F4694", "#145EC7", "#1E1E1F"] },
      { "h": [221, 256], "value": ["#242D87", "#313DC4", "#1E1E1F"] },
      { "h": [257, 265], "value": ["#4819A1", "#561BC2", "#1E1E1F"] },
      { "h": [266, 278], "value": ["#562085", "#6214A6", "#1E1E1F"] },
      { "h": [279, 290], "value": ["#66237D", "#8635A6", "#1E1E1F"] },
      { "h": [291, 305], "value": ["#721775", "#99279D", "#1E1E1F"] },
      { "h": [306, 321], "value": ["#731B60", "#9E2884", "#1E1E1F"] },
      { "h": [322, 334], "value": ["#73174B", "#9E276A", "#1E1E1F"] },
      { "h": [335, 347], "value": ["#751535", "#991E48", "#1E1E1F"] },
      { "h": [348, 360], "value": ["#6B181F", "#9A232E", "#1E1E1F"] }
    ]
  },
  "multiColors": {
    "hueBounds": [10,20,30,40,52,63,75,88,100,121,137,152,165,180,200,220,256,265,278,290,305,321,334,347,360],
    "requiresSatPct": 13, "requiresBriPct": 13,
    "fallback": "#00F168",
    "groups": [
      ["FF8780","F46259","E05851","F56A62"], ["FFA480","F67A48","E67649","F38C63"],
      ["FFB780","F58C3D","DB823D","F09C5B"], ["FFE4BF","EBA038","EB9F34","F2B561"],
      ["FFE180","E6B517","D9B645","EBCC6A"], ["FFFB80","CCC733","C7C450","DBD760"],
      ["EAFF80","ABC427","A9BA4E","C2D466"], ["D0FF80","8CC628","97C744","B5E06C"],
      ["B5FF80","68C724","77C540","9AD96C"], ["95FF80","42C728","5EB64D","83D173"],
      ["80FF97","3CC755","4EBA62","74D486"], ["80FFB5","1CC260","3FB370","6ECC95"],
      ["80FFD2","2FBF8D","2EB786","52CCA1"], ["80FFF0","28C7B4","34AD9F","45C8B8"],
      ["80E5FF","38B3D1","3AA6C2","2DBADE"], ["80B5FF","478CED","4780D1","5792E6"],
      ["808AFF","636EED","656FE6","7680F5"], ["AC80FF","925DF2","8050D9","9567EB"],
      ["C380FF","A55BE7","A05CDB","B571F0"], ["DF80FF","C85DF2","B85EDB","C76EEB"],
      ["FB80FF","E15CE6","C158C4","D769DB"], ["FF80E3","E767CB","C757AE","E06CC7"],
      ["FF80C7","F64AAB","D9529E","F56EBA"], ["FF80AB","F74582","DB5885","F26B99"],
      ["FF808B","F05A66","D95762","F3616F"],
      ["1CC260","A0A0A6","1E1E1F","6E6E73","8F8F94"]
    ]
  }
}
```

---

## 6. 与 zcode-music-plugin 实现的对照

本插件（`plugin/lib/colors.js`）是**阶段一**的忠实移植（缩略、无彩色阈值、8 桶边界、鲜活色目标、柔和化公式、pureColor 语义全部一致），验证方式：单测 `test/colors.test.mjs` + 真实封面端到端提取。

未移植的部分及原因：

| 未移植 | 说明 |
|---|---|
| `magicColorMapping` 26 条×2 表 | 插件改用柔和化后的提取色 + CSS `color-mix` 自适应明暗，观感接近。如需完全复刻观感，可直接采用 5.4 的 JSON。 |
| `multiColorsArray` 5 色套组 | 播放页整页主题用，歌词条场景用不上。 |
| hue 0→360、`or/and` DSL | 属于查表阶段的匹配语义；提取阶段不需要。注意：提取阶段的 8 桶边界（21/41/76/156/191/257/296/330）与映射表的 25 段边界是**两套不同的刻度**，不要混用。 |

一个容易踩的坑：**提取阶段**判断"红"用 `h < 21 ∥ h ≥ 330`（12.5° 宽的品红区归入"品红"），而**映射阶段**品红区是 `322–334`、红区从 348 起（含 0）。同一个颜色在两个阶段可能落在名字相同的桶但边界不同。

---

## 7. 附录：符号与地址索引

arm64 切片（`lipo -thin arm64` 提取），镜像基址 `0x100000000`。

| 符号 | 地址 | 作用 |
|---|---|---|
| `-[QMSongPageView updateAlbum]` | `0x100363688` | 切歌入口 |
| `-[QMSongPageView updateAlbuMagicColor]` | `0x100363c90` | 触发取色（count=3） |
| `+[QMAlbumColorPicker pickColorsOfImage:count:]` | `0x100431550` | 便捷入口 → pureColor: 变体 |
| `-[QMAlbumColorPicker initWithImage:]` | `0x1004316a4` | 默认 dimension=10 |
| `-[QMAlbumColorPicker __pickColorsInBitmap:count:pureColor:adjusted:]` | `0x100431c90` | 分类/分桶/鲜活色核心 |
| `-[QMAlbumColorPicker __adjustedColor:]` | `0x1004323f8` | S/B 柔和化 |
| `+[NSColor relativeLuminanceOfColor:]` | `0x1002f6fdc` | 明/暗桶二分依据 |
| `-[QMPlayPageConfigManager multiColorsArray]` | `0x1003c1e34` | 5 色套组表（26 组） |
| `-[QMPlayPageConfigManager playerColorsWithMagicColor:]` | `0x1003c2808` | 色相查表 → 5 色 |
| `-[QMPlayPageConfigManager magicColorMapping]` | `0x1003c2fcc` | 26 条规则表（按 isLightSkin 二选一） |
| `-[QMPlayerAlbumStyleColorPicker initWithColorMapping:]` | `0x10053b0f0` | treatZeroHueAs360=YES |
| `-[QMPlayerAlbumStyleColorPicker pickColorFromMagicBgColor:]` | `0x10053b168` | 规则枚举匹配 |
| `-[QMPlayerAlbumStyleColorPicker colorComponents:capturedByRange:]` | `0x10053b67c` | 闭区间判断 |
| `-[QMPlayerAlbumStyleColorPicker getColorWithMagicColor:businessIndex:]` | `0x10053b758` | 按业务位取色 |
| `-[QMPlayerAlbumStyleColorPicker opFuncTypeFromStr:]` | `0x10053b828` | "or"→0 / "and"→1 |
| `-[QMPlayingRecordPlayerAlbumStyle magicColorS]` / `magicColorB` | `0x1003c9028` / `0x1003c9050` | 黑胶固定 S/B |
| 常量 `dbl_101D94090` / `dbl_101D940A0` | — | `[0.2, 0.3]` / `[0.8, 0.7]` |
| 常量 `dbl_101D93F98` | — | multiColors 25 个色相上界 |
| 类 `QMSongPageColor` 字段 | — | normalBgColor/themeColor/textNormal(/Hover)Color/buttonNormal( Hover)Color/playBarColor/playerMagicColor/playerGaussianColor/playerHaloColor |

相关文件：上一轮只读检查记录见 `research/qqmusic-colors.md`；可运行移植见 `plugin/lib/colors.js` 与 `test/colors.test.mjs`。
