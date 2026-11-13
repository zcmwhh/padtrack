# 灵动岛卡片（Island Cards）

> **给重置上下文后的我：**
> 用户说「以后新功能都加到灵动岛上」。所以**任何新的灵动岛功能，都走这套接口**，
> 不要再去改 `islandPaint()` 里的公式，也不要自己写卡片的尺寸和玻璃样式。
>
> 引擎位置：`web/app.js` 里的 `ISLAND CARDS` 大注释块。
> 外壳样式：`web/app.css` 里的 `.island-card` 和 `:root` 的 `--card-*` 变量。
> 当前已注册：`music`（播放器）、`tasks`（任务栏）。

---

## 一、加一张新卡 = 5 步

### 1. 备份

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
New-Item -ItemType Directory -Force -Path "backup\$stamp\web" | Out-Null
Copy-Item web\app.js,web\app.css,web\index.html "backup\$stamp\web\" -Force
```

### 2. 在 `web/index.html` 加卡片 DOM

紧挨着 `<div id="taskIsland" ...>` 后面加，**必须带 `island-card` 类**：

```html
<!-- 灵动岛卡片：新卡加这里，不要自己写尺寸/玻璃，见 docs/island-cards.md -->
<div id="clockIsland" class="island-card" data-card="clock" aria-label="时钟">
  <div class="ci-l1">
    <!-- 一级内容：高度 48，左右内边距 10 -->
  </div>
</div>
```

### 3. CSS 只写「内容」，不写「外壳」

```css
/* 外壳（尺寸/玻璃/圆角/阴影/过渡）由 .island-card 提供，这里只管里面怎么排 */
.ci-l1 { display: flex; align-items: center; gap: 8px; width: 100%; justify-content: center; }
.ci-time { font-size: 15px; font-variant-numeric: tabular-nums; color: var(--glass-text); }
```

需要二级形态就加：

```css
#clockIsland.l2 { height: var(--card-h2); width: min(94vw, 470px); padding: 0 14px; }
```

### 4. 在 `web/app.js` 的 `ISLAND CARDS` 区块末尾注册

```js
registerIslandCard({
  id: 'clock',                  // 唯一，重复会抛错
  order: 30,                    // 小的排前面（音乐 10，任务栏 20）
  title: '时钟',
  el: document.getElementById('clockIsland'),
  expandable: false,            // 有二级菜单就 true
  available: () => true,        // 返回 false 时这张卡自动退出堆叠
  onActivate: () => { /* 成为前台：开始刷新数据 */ },
  onDeactivate: () => { /* 离开前台：停掉定时器，别偷电 */ },
  onLevel: (n) => { /* 可选：一级↔二级 */ },
  dragGuard: (e) => false,      // 可选：返回 true 表示这次手势归卡片自己（比如横向滚动区）
});
```

**注册完就自动进堆叠、自动有拖动和吸附动画、自动只有前排能点。**

### 5. 验证（别靠肉眼，用 CDP 探针）

```powershell
node .probe\test_regress.py.mjs      # 7 条回归
```

要看到的：
- `[...document.querySelectorAll('.island-card')].map(e => e.dataset.card)` 里有新卡的 id
- 所有卡片 `offsetWidth × offsetHeight` 一级都是 `284×48`
- 只有一张卡 `pointer-events: auto`
- 上下滑能翻到新卡，`document.getElementById('xxx').classList.contains('front')` 为 true

---

## 二、接口字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一标识，同时写到 `data-card` |
| `el` | ✅ | 卡片根元素，注册时自动加 `island-card` 类 |
| `order` | | 排序，数字小的更靠前（默认 100） |
| `title` | | 调试用 |
| `expandable` | | 有二级形态就 `true`（不参与引擎逻辑，供卡片自己判断） |
| `available()` | | 返回 false 时这张卡暂时退出堆叠（如没歌时的音乐卡） |
| `mount()` | | 预留：首次挂载 |
| `onActivate()` / `onDeactivate()` | | 进入 / 离开前台，用来开关数据轮询 |
| `onLevel(n)` | | 一级↔二级切换 |
| `dragGuard(e)` | | 返回 true = 这次 pointerdown 不归卡片切换管 |

## 三、引擎内部约定（别乱改）

- `islandPos` 是**浮点索引**：`0` = 第一张在前，`1.0` = 第二张在前
- 每张卡的位移由 `k = i - islandPos` 推导：
  - `k >= 0`：在下面排队，露出 12px
  - `k < 0`：已经划走，向上 -70px 并淡出
- 只有 `|k| < 0.5` 的卡接收指针事件
- 拖动结束按方向 `Round(±0.35)` 吸附，不会停在两张之间

## 四、常见坑

1. **别给卡片设 `width`**：一级宽度有 `--card-w`，二级有 `--card-h2` 那套规则，自己设会跟外壳打架。
2. **别用 `setPointerCapture`**：会把 `click` 重定向到卡片本身，卡里的按钮就点不动了。
3. **数据轮询要在 `onDeactivate` 里停**，否则后台卡还在拉数据。
4. **卡片内部横向滚动区**要 `dragGuard` 放行，否则手势会被卡片切换吃掉。
5. 新卡如果高度不是 48，同步改 `--card-h`（会同时影响所有卡），或单独写 `.l2` 那种特例。