(() => {
  'use strict';

  const KEY = new URLSearchParams(location.search).get('k') || '';
  const pad = document.getElementById('pad');
  const hint = document.getElementById('hint');
  const dot = document.getElementById('dot');
  const latEl = document.getElementById('lat');
  const panel = document.getElementById('panel');
  const kb = document.getElementById('kb');
  const ta = document.getElementById('ta');

  /* ---------------- 连接 ---------------- */
  const S = Object.assign(
    { sens: 1.5, accel: false, natural: true, abs: false, speed: 1.0, lyrOn: true, coverBg: false, glassDark: true, holdDrag: true },
    JSON.parse(localStorage.getItem('padtrack') || '{}')
  );
  const saveS = () => localStorage.setItem('padtrack', JSON.stringify(S));

  let ws = null, connected = false, tries = 0;
  const rtts = [];

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?k=${encodeURIComponent(KEY)}`);
    ws.onopen = () => {
      connected = true; tries = 0;
      dot.classList.add('on');
      latEl.textContent = '-- ms';
      ping();
      send({ t: 'cfg', abs: S.abs });
      tiSetConnected(true);
    };
    ws.onclose = () => {
      connected = false;
      tiSetConnected(false);
      dot.classList.remove('on');
      latEl.textContent = '已断开，重连中…';
      setTimeout(connect, Math.min(800 * Math.pow(1.7, tries++), 8000));
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (d.t === 'vol') {
        applyVolume(d);
        return;
      }
      if (d.t === 'pong') {
        const rtt = Math.round(performance.now() - d.ts);
        rtts.push(rtt);
        if (rtts.length > 12) rtts.shift();
        const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
        const peak = Math.max.apply(null, rtts);
        // 峰值明显高于平均 = 网络在抖，不是滚轮粒度的问题
        latEl.textContent = peak > avg + 18 ? `${avg} ms · 峰值 ${peak}` : `${avg} ms`;
      }
    };
  }

  function send(o) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
  }

  function ping() { send({ t: 'ping', ts: performance.now() }); }
  setInterval(() => { if (connected) ping(); }, 2000);
  connect();

  /* ---------------- 手势状态 ---------------- */
  const pts = new Map();
  let mode = 'idle';          // idle | pending | move | drag | scroll2 | swipe3
  let sx = 0, sy = 0, st = 0;
  let lastCX = 0, lastCY = 0;
  let dblX = 0, dblY = 0, dblTimer = 0;   // 第二下的落点和「停稳」计时器
  let lpTimer = 0;
  let accX = 0, accY = 0, remX = 0, remY = 0;
  let wheelX = 0, wheelY = 0, remWX = 0, remWY = 0;
  let twoStartT = 0, twoMoved = 0;
  // 双指轻点要看"两根手指都抬起"才算数，但手指不可能同时离开，
  // 所以用这个标记跨过"2 指 → 1 指"的中间状态。
  let twoTapPending = false, twoTapT = 0;
  let threeStart = null, sw3dx = 0, sw3dy = 0;
  // 三指同理：手指是一根根抬起的，用标记跨过"3 指 → 2 指 → 1 指"的中间状态，
  // 等到最后一根手指抬起时再判定手势方向。
  let swipe3Pending = false;
  let pinch = false, d0 = 0, lastDist = 0, zoomAcc = 0, remZoom = 0;
  let pinchRef = null;
  let velY = 0, inertia = 0, lastTapEnd = 0;
  let lastTapX = 0, lastTapY = 0;      // 上一次点击落点，用来判断是不是真的双击
  const DBL_SLOP = 14;                 // 两次点击允许的位置偏差（约 3.5mm，再大就吃掉两次独立点击）
  const DBL_MS = 320;                  // 两次点击的最大间隔
  const DBL_MOVE = 12;                 // 第二下按住后移动这么远就开拖
  const DBL_STILL = 80;                // 停稳多久后进入拖拽候选
  const DBL_WOBBLE = 14;               // 按住后的自然抖动幅度，超过才算滑走
  const HOLD_MS = 550;                 // 按住多久进入「准备拖动」（此时还不会按下）
  const HOLD_MOVE = 12;                // 进入准备态后，还要再移动这么远才真正开拖

  // 全屏键盘上的手势状态（和触控板各自独立，互不干扰）
  const kfPts = new Map();
  let kfMode = 'idle', kfTapEl = null, kfStartT = 0, kfMoved = 0;
  let kf3T = 0, kf3dx = 0, kf3dy = 0, kf3x0 = 0, kf3y0 = 0;   // 三指手势
  let kfSX = 0, kfSY = 0, kfLastX = 0, kfLastY = 0;
  let kfAccX = 0, kfAccY = 0, kfRemX = 0, kfRemY = 0;
  let kfScroll = 0, kfScrollRem = 0;

  const centX = () => { let s = 0; for (const p of pts.values()) s += p.x; return pts.size ? s / pts.size : 0; };
  const centY = () => { let s = 0; for (const p of pts.values()) s += p.y; return pts.size ? s / pts.size : 0; };
  const PX_PER_NOTCH = 60;      // 手指移动 60px 算一格滚轮
  const WHEEL_NOTCH = 120;      // Windows 的一格
  const STEPS_PER_NOTCH = 8;    // 一格再切成 8 份，滚起来才连续
  const WHEEL_STEP = WHEEL_NOTCH / STEPS_PER_NOTCH;
  const click = (b) => send({ t: 'c', b });
  const down = (b) => send({ t: 'd', b });
  const up = (b) => send({ t: 'u', b });
  // 拖动锁定期间不要重复按下/松开左键，否则会把锁定状态冲掉
  const pressLeft = () => down('l');
  const releaseLeft = () => up('l');

  const tipEl = document.getElementById('tip');
  let tipTimer = 0;
  function flash(text) {
    tipEl.textContent = text;
    tipEl.classList.add('on');
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => tipEl.classList.remove('on'), 900);
  }

  /* ---------------- 顶部媒体控制（所有模式可见） ---------------- */
  document.querySelectorAll('#island button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.media === '179') {           // 播放/暂停：先翻图标，别等轮询
        uiPaused = !uiPaused;
        iconLockUntil = performance.now() + 2500;
        // 歌词进度立刻跟着停/走。如果等轮询（1 秒一次 + 服务端判定延迟），
        // 暂停之后歌词还会往上滚一两行。
        if (uiPaused) {
          lyricBase = lyricTime();
          lyricPlaying = false;
          lyricClock = performance.now();
          anchorAt(lyricClock);
        } else {
          lyricClock = performance.now();
          lyricPlaying = true;
          anchorAt(lyricClock);
        }
        paintPlayIcon();
        paintLyric(true);
        paintProgress();
        musicWave.classList.toggle('playing', !uiPaused);
        // 600ms 先问一次（服务端识别大约 1 秒），2.6 秒再确认一次
        setTimeout(() => { lastMedia = ''; pollMedia(true); }, 600);
        setTimeout(() => { lastMedia = ''; pollMedia(true); }, 2600);
      }
      // 播放控制优先走系统媒体控制（更准，焦点在别的窗口也有效）；
      // 服务端如果拿不到会话会自动退回媒体键
      const mkVk = parseInt(b.dataset.media, 10);
      const mkAct = mkVk === 179 ? 'playpause' : mkVk === 176 ? 'next' : mkVk === 177 ? 'prev' : '';
      if (mkAct) send({ t: 'mctl', a: mkAct });
      else send({ t: 'k', vk: mkVk });
      b.classList.add('on');
      setTimeout(() => b.classList.remove('on'), 160);
    });
  });

  /* ---------------- 九宫格数字键盘（触摸板模式右侧） ---------------- */
  const numpad = document.getElementById('numpad');
  const NUM_KEYS = [
    ['Esc', 0x1B, 1, 1, 1, 1, 'fn'],
    ['Tab', 0x09, 2, 1, 1, 1, 'fn'],
    ['← Back', 0x08, 3, 1, 2, 1, 'fn'],
    ['Num', 0x90, 1, 2, 1, 1, 'fn'],
    ['/', 0x6F, 2, 2, 1, 1],
    ['*', 0x6A, 3, 2, 1, 1],
    ['-', 0x6D, 4, 2, 1, 1],
    ['7', 0x67, 1, 3, 1, 1], ['8', 0x68, 2, 3, 1, 1], ['9', 0x69, 3, 3, 1, 1],
    ['+', 0x6B, 4, 3, 1, 2],
    ['4', 0x64, 1, 4, 1, 1], ['5', 0x65, 2, 4, 1, 1], ['6', 0x66, 3, 4, 1, 1],
    ['1', 0x61, 1, 5, 1, 1], ['2', 0x62, 2, 5, 1, 1], ['3', 0x63, 3, 5, 1, 1],
    ['Enter', 0x0D, 4, 5, 1, 2],
    ['0 / Ins', 0x60, 1, 6, 2, 1],
    ['. / Del', 0x6E, 3, 6, 1, 1],
  ];
  NUM_KEYS.forEach(([label, vk, col, row, cs, rs, cls]) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.style.gridArea = row + ' / ' + col + ' / span ' + rs + ' / span ' + cs;
    b.addEventListener('click', () => send({ t: 'k', vk }));
    numpad.appendChild(b);
  });
  document.getElementById('numBtn').addEventListener('click', () => {
    collapsePlayer();
    const on = numpad.classList.toggle('active');
    document.getElementById('numBtn').classList.toggle('on', on);
  });
  if (new URLSearchParams(location.search).get('numpad') === '1') {
    numpad.classList.add('active');
    document.getElementById('numBtn').classList.add('on');
  }

  /* ---------------- 随机 / 循环 ---------------- */
  const modeShuffle = document.getElementById('modeShuffle');
  const modeRepeat = document.getElementById('modeRepeat');
  let mShuffle = null, mRepeat = null;     // null = 当前播放器不支持

  function paintModes() {
    modeShuffle.classList.toggle('on', mShuffle === true);
    modeShuffle.classList.toggle('unsupported', mShuffle === null);
    modeRepeat.classList.toggle('on', mRepeat === 1 || mRepeat === 2);
    modeRepeat.classList.toggle('unsupported', mRepeat === null);
    modeRepeat.innerHTML = mRepeat === 1 ? REPEAT_ONE_SVG : REPEAT_ALL_SVG;
  }

  async function setMode(what, value) {
    try {
      const r = await fetch(`/mode?k=${encodeURIComponent(KEY)}&what=${what}&value=${value}`,
        { cache: 'no-store' });
      const d = await r.json();
      if (d && d.ok) {
        lastMedia = '';
        pollMedia(true);
        flash(what === 'shuffle'
          ? (value ? '随机播放：开' : '随机播放：关')
          : (value === 0 ? '循环：关' : value === 1 ? '单曲循环' : '列表循环'));
        return true;
      }
      flash(d && d.reason === 'no-session' ? '这个播放器不支持切换播放方式' : '切换失败');
    } catch (_) {}
    return false;
  }

  modeShuffle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (mShuffle === null) { flash('网易云不支持，需要在它自己的界面里切'); return; }
    mShuffle = !mShuffle;
    paintModes();
    if (!setMode('shuffle', mShuffle ? 1 : 0)) { mShuffle = !mShuffle; paintModes(); }
  });

  modeRepeat.addEventListener('click', (e) => {
    e.stopPropagation();
    if (mRepeat === null) { flash('网易云不支持，需要在它自己的界面里切'); return; }
    const next = mRepeat === 0 ? 2 : mRepeat === 2 ? 1 : 0;
    const prev = mRepeat;
    mRepeat = next;
    paintModes();
    if (!setMode('repeat', next)) { mRepeat = prev; paintModes(); }
  });


  /* ---------------- 媒体信息 + 滚动歌词 ---------------- */
  const island = document.getElementById('island');
  const musicTitle = document.getElementById('musicTitle');
  // 歌名跑马灯：量一下放不放得下，放不下才滚（放得下就别乱动）
  function mqApply(el) {
    if (!el) return;
    el.classList.remove('mq');
    el.style.removeProperty('--mq-dist');
    const box = el.parentElement;
    if (!box) return;
    const avail = box.clientWidth;
    const need = el.scrollWidth;
    if (need <= avail + 2) return;
    el.style.setProperty('--mq-dist', (need - avail + 6) + 'px');
    el.style.setProperty('--mq-dur', Math.max(6, Math.min(16, need / 14)) + 's');
    el.classList.add('mq');
  }

  const musicArtist = document.getElementById('musicArtist');
  const musicCover = document.getElementById('musicCover');
  const musicCoverBig = document.getElementById('musicCoverBig');
  const musicWave = document.getElementById('musicWave');
  const musicProg = document.getElementById('musicProg');
  const musicTime = document.getElementById('musicTime');
  const REPEAT_ALL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 8.5h11a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z"/><path d="M8.5 6.2 6.3 8.5l2.2 2.3"/><path d="M15.5 15.8l2.2-2.2-2.2-2.3"/></svg>';
  const REPEAT_ONE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 8.5h11a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z"/><path d="M8.5 6.2 6.3 8.5l2.2 2.3"/><path d="M15.5 15.8l2.2-2.2-2.2-2.3"/><text x="12" y="15" font-size="7.5" fill="currentColor" stroke="none" text-anchor="middle">1</text></svg>';
  let islandTimer = 0, songDur = 0, songAnchor = 0;

  // 展开的二级菜单：只要开始干别的就收回去
  function collapsePlayer() {
    const el = document.getElementById('island');
    if (el) el.classList.remove('exp');
    clearTimeout(islandTimer);
  }
  const SVG_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.4 19 12 8 18.6z" fill="currentColor"/></svg>';
  const SVG_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7.4" y="5.4" width="3.6" height="13.2" rx="1.4" fill="currentColor"/><rect x="13" y="5.4" width="3.6" height="13.2" rx="1.4" fill="currentColor"/></svg>';

  // 点胶囊展开成详情，6 秒无操作自动收回（和灵动岛一个思路）
  function expandIsland(on) {
    island.classList.toggle('exp', on);
    clearTimeout(islandTimer);
    if (on) islandTimer = setTimeout(() => island.classList.remove('exp'), 6000);
  }
  island.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    expandIsland(!island.classList.contains('exp'));
  });
  /* ==================================================================
   ISLAND CARDS —— 灵动岛卡片引擎
   ------------------------------------------------------------------
   新增灵动岛功能从这里开始，步骤见 docs/island-cards.md
   规则：
     1. 不要改 islandPaint / islandDrag 里的公式，用 registerIslandCard 注册
     2. 卡片 DOM 必须是 <div class="island-card">，尺寸玻璃圆角由外壳保证
     3. 数据拉取放 mount()/onActivate()，离开前台在 onDeactivate() 里停掉
   ================================================================== */
  const ISLAND_CARDS = [];
  const ISLAND_DIST = 90;      // 拖多远等于走完一整张卡（手感）
  const ISLAND_SWITCH = 16;    // 松手时位移超过这个就翻页
  const ISLAND_SLOP = 6;       // 超过这个算滑动，不再当点击
  let islandPos = 0;           // 浮点索引：0 = 第一张在前
  let islandHidden = false;    // 摊牌面板打开时把真岛藏起来（否则两层文字会透）
  let islandActive = -1;
  let islandDrag = null;
  let islandSwallowClick = 0;

  const islandEase = (t) => t * t * (3 - 2 * t);
  const islandClamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function registerIslandCard(def) {
    if (!def || !def.id || !def.el) throw new Error('[island] 卡片缺少 id 或 el');
    if (ISLAND_CARDS.some((c) => c.id === def.id)) throw new Error('[island] 卡片 id 重复: ' + def.id);
    def.order = def.order == null ? 100 : def.order;
    def.el.classList.add('island-card');
    def.el.dataset.card = def.id;
    def.el.__islandCard = def;
    def.available = def.available || (() => true);
    ISLAND_CARDS.push(def);
    ISLAND_CARDS.sort((a, b) => a.order - b.order);
    return def;
  }

  // 当前参与堆叠的卡（available() 为 false 的自动退出，比如没歌时的音乐卡）
  function islandLive() {
    return ISLAND_CARDS.filter((c) => {
      try { return c.available(); } catch (_) { return true; }
    });
  }

  function islandPaint(anim) {
    const cards = islandLive();
    if (!cards.length) return;
    islandPos = islandClamp(islandPos, 0, cards.length - 1);
    const tr = anim ? 'var(--card-ease)' : 'none';

    cards.forEach((c, i) => {
      const k = i - islandPos;             // >0 在下面排队，<0 已经划走
      let y, sc, op;
      if (k >= 0) {
        const e = islandClamp(k, 0, 1);
        y = 12 * e;                        // 排队的卡露出 12px
        sc = 1 - 0.08 * e;
        // 只让紧挨着的下一张露出来；再往后的全部隐藏，
        // 否则多张卡会叠在同一位置，看起来一团糊
        op = k > 1.5 ? 0 : (1 - 0.45 * e);
      } else {
        const e = islandClamp(-k, 0, 1);
        y = -70 * e;                       // 划走的卡向上滑出
        sc = 1 - 0.08 * e;
        op = 1 - e;
      }
      const front = Math.abs(k) < 0.5;
      // 不是前排就收回一级：否则二级的大卡片会留在后面，和前排叠在一起
      if (!front) c.el.classList.remove('l2');
      c.el.style.transition = tr;
      c.el.style.transform =
        `translateX(-50%) translateY(${y.toFixed(2)}px) scale(${sc.toFixed(3)})`;
      c.el.style.opacity = (c.el === island && islandHidden) ? '0' : String(op);
      c.el.style.zIndex = front ? '71' : '69';
      c.el.style.pointerEvents = (front && op > 0.8) ? 'auto' : 'none';
      c.el.classList.toggle('front', front);
      c.el.classList.toggle('is-front', front);
    });

    // 激活回调：只通知变化
    const nowActive = Math.round(islandPos);
    if (nowActive !== islandActive) {
      const prev = ISLAND_CARDS[islandActive];
      const next = cards[nowActive];
      islandActive = nowActive;
      if (prev && prev.onDeactivate) { try { prev.onDeactivate(); } catch (_) {} }
      if (next && next.onActivate) { try { next.onActivate(); } catch (_) {} }
    }
  }

  // 外部状态变化（音乐出现/消失、连上服务器）后重排
  function islandRefresh() { islandPaint(true); }

  // ---- 拖动 ----
  function islandOnMove(e) {
    if (!islandDrag || e.pointerId !== islandDrag.id) return;
    islandDrag.dy = e.clientY - islandDrag.y0;
    const n = islandLive().length;
    // 上滑 = 下一张，下滑 = 上一张
    islandPos = islandClamp(islandDrag.base - islandDrag.dy / ISLAND_DIST, 0, Math.max(0, n - 1));
    islandPaint(false);
  }

  function islandOnUp(e) {
    if (!islandDrag || e.pointerId !== islandDrag.id) return;
    window.removeEventListener('pointermove', islandOnMove, true);
    window.removeEventListener('pointerup', islandOnUp, true);
    window.removeEventListener('pointercancel', islandOnUp, true);

    const dy = islandDrag.dy;
    const base = islandDrag.base;
    const dt = Math.max(1, performance.now() - islandDrag.t0);
    islandDrag = null;

    let target = base;
    if (Math.abs(dy) > ISLAND_SLOP) islandSwallowClick = performance.now() + 360;
    if (Math.abs(dy) > ISLAND_SWITCH || Math.abs(dy) / dt > 0.22) {
      target = islandPos + (dy < 0 ? 0.35 : -0.35);     // 按方向吸附到相邻卡
      target = Math.round(target);
      islandSwallowClick = performance.now() + 460;
    } else {
      target = Math.round(base);
    }
    islandPos = target;
    islandPaint(true);
  }

  function islandAttachDrag(el) {
    el.addEventListener('pointerdown', (e) => {
      if (el.classList.contains('exp')) return;
      const card = el.__islandCard;
      if (card && card.dragGuard && card.dragGuard(e)) return;   // 卡片自己说不拖（比如二级横向滚动区）
      islandDrag = { y0: e.clientY, x0: e.clientX, id: e.pointerId,
                     base: islandPos, dy: 0, t0: performance.now() };
      // 不用 setPointerCapture：它会把 click 重定向到卡片本身，卡片里按钮就收不到
      window.addEventListener('pointermove', islandOnMove, true);
      window.addEventListener('pointerup', islandOnUp, true);
      window.addEventListener('pointercancel', islandOnUp, true);
      islandPaint(false);
    }, { passive: true });

    // 拖动后吃掉紧随其后的 click
    el.addEventListener('click', (e) => {
      if (performance.now() < islandSwallowClick) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }

  /* ---------------- 卡片 1：音乐（播放器本身） ---------------- */
  if (island) {
    registerIslandCard({
      id: 'music',
      order: 10,
      title: '音乐',
      el: island,
      expandable: true,
      available: () => island.classList.contains('on'),
      onActivate: () => { if (typeof mqApply === 'function') mqApply(musicTitle); },
    });
  }

  /* ---------------- 卡片 2：任务栏 ---------------- */
  const taskIsland = document.getElementById('taskIsland');
  const tiRecent = document.getElementById('tiRecent');
  const tiGrid = document.getElementById('tiGrid');
  const tiMoreBtn = document.getElementById('tiMore');
  const tiBackBtn = document.getElementById('tiBack');
  const tiStartBtn = document.getElementById('tiStart');

  let tiTasks = [];
  let tiLevel = 1;
  // 两个容器各自一套节点缓存：同一个 button 不能同时挂在两处
  const tiNodesL1 = new Map();
  const tiNodesL2 = new Map();
  let tiSig = '';

  function tiIconFor(item, cache) {
    const key = item.h ? ('w' + item.h) : ('p' + (item.icon || ''));
    let b = cache.get(key);
    if (!b) {
      b = document.createElement('button');
      b.className = 'ti-app';
      // 用 div + background-image 而不是 <img>：安卓长按 <img> 会弹系统菜单「保存图片」
      const img = document.createElement('i');
      img.className = 'ti-icon';
      b.appendChild(img);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const it = b.__item || {};
        if (it.running && it.h) send({ t: 'act', h: it.h });
        else if (it.lnk || (it.icon || '').toLowerCase().endsWith('.lnk')) {
          send({ t: 'run', p: it.icon });
        }
        setTimeout(refreshTasks, 320);
      });
      cache.set(key, b);
    }
    const img = b.firstChild;
    const wantIcon = item.icon || '';
    const src = `/icon?k=${encodeURIComponent(KEY)}&h=${encodeURIComponent(wantIcon)}`;
    if (img && img.__src !== src && wantIcon) {
      img.__src = src;
      img.style.backgroundImage = `url("${src}")`;
    }
    b.__item = item;
    b.dataset.h = item.h || 0;
    b.title = item.name || item.icon || '';
    b.classList.toggle('active', !!item.active);
    b.classList.toggle('min', !!item.min);
    b.classList.toggle('pinned', !item.running);
    return b;
  }

  function tiPlace(container, list, cache) {
    const want = list.map((it) => (it.h ? 'w' + it.h : 'p' + (it.icon || '')));
    const have = [...container.children].map((c) => (c.__item ? (c.__item.h ? 'w' + c.__item.h : 'p' + (c.__item.icon || '')) : ''));
    const same = want.length === have.length && want.every((x, i) => x === have[i]);
    if (!same) {
      container.innerHTML = '';
      list.forEach((it) => container.appendChild(tiIconFor(it, cache)));
    } else {
      list.forEach((it) => tiIconFor(it, cache));
    }
  }

  function tiRender() {
    tiPlace(tiRecent, tiTasks.slice(0, 4), tiNodesL1);
    tiPlace(tiGrid, tiTasks, tiNodesL2);
  }

  async function refreshTasks() {
    let d;
    try {
      const r = await fetch(`/tasks?k=${encodeURIComponent(KEY)}`, { cache: 'no-store' });
      d = await r.json();
    } catch (_) {
      return;
    }
    const list = Array.isArray(d.list) ? d.list : [];
    const sig = list.map((x) => (x.h ? 'w' + x.h : 'p' + (x.icon || '')) + ':' + (x.running ? 1 : 0)).join(',');
    tiTasks = list;
    tiSig = sig;
    tiRender();
  }

  function tiSetLevel(n) {
    tiLevel = n;
    taskIsland.classList.toggle('l2', n === 2);
    if (n === 2) refreshTasks();
    islandPaint(true);
  }

  function tiSetConnected(on) {
    taskIsland.classList.toggle('on', !!on);
    if (on) { refreshTasks(); }
    islandPaint(true);
  }

  tiMoreBtn.addEventListener('click', (e) => { e.stopPropagation(); tiSetLevel(2); });
  tiBackBtn.addEventListener('click', (e) => { e.stopPropagation(); tiSetLevel(1); });
  tiStartBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    send({ t: 'k', vk: 0x5B });
    setTimeout(refreshTasks, 700);
  });

  setInterval(() => {
    if (!connected || document.hidden) return;
    const tasksFront = ISLAND_CARDS[Math.round(islandPos)] &&
                       ISLAND_CARDS[Math.round(islandPos)].id === 'tasks';
    if (tasksFront || tiLevel === 2) refreshTasks();
  }, 2500);

  registerIslandCard({
    id: 'tasks',
    order: 20,
    title: '任务栏',
    el: taskIsland,
    expandable: true,
    available: () => taskIsland.classList.contains('on'),
    onActivate: () => { refreshTasks(); },
    // 二级菜单的图标区要横向滑动，别被卡片切换手势抢走
    dragGuard: (e) => tiLevel === 2 && !!e.target.closest('.ti-grid'),
  });

  /* ==================================================================
     卡片 3/4/5：系统状态 / 剪贴板 / 宏键（都走 registerIslandCard）
     ================================================================== */

  // ---------- 通用：把文字复制到平板剪贴板 ----------
  function copyToTablet(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    flash(ok ? '已复制到平板' : '复制失败');
    return ok;
  }

  // ---------- 通用：二级卡的开合 ----------
  function levelBind(cardEl, moreBtn, backBtn, onOpen) {
    if (!cardEl) return;
    const open = (e) => {
      e.stopPropagation();
      cardEl.classList.add('l2');
      islandPaint(true);
      if (onOpen) onOpen();
    };
    const close = (e) => {
      e.stopPropagation();
      cardEl.classList.remove('l2');
      islandPaint(true);
    };
    if (moreBtn) moreBtn.addEventListener('click', open);
    if (backBtn) backBtn.addEventListener('click', close);
    cardEl.__collapse = () => cardEl.classList.remove('l2');
  }

  // ================= 卡片 3：系统状态 =================
  const sysIsland = document.getElementById('sysIsland');
  const sysCpuEl = document.getElementById('sysCpu');
  const sysMemEl = document.getElementById('sysMem');
  const sysNetEl = document.getElementById('sysNet');
  const sysCpuTxt = document.getElementById('sysCpuTxt');
  const sysMemTxt = document.getElementById('sysMemTxt');
  const sysNetTxt = document.getElementById('sysNetTxt');
  const sysCpuBar = document.getElementById('sysCpuBar');
  const sysMemBar = document.getElementById('sysMemBar');
  const sysGpuTxt = document.getElementById('sysGpuTxt');
  const sysGpuBar = document.getElementById('sysGpuBar');
  const sysVramTxt = document.getElementById('sysVramTxt');
  const sysTempTxt = document.getElementById('sysTempTxt');
  let sysTimer = 0;
  let sysData = null;

  function fmtBps(v) {
    v = Number(v) || 0;
    if (v > 1024 * 1024) return (v / 1048576).toFixed(1) + 'M';
    if (v > 1024) return (v / 1024).toFixed(0) + 'K';
    return v + 'B';
  }

  function sysPaint() {
    const d = sysData;
    if (!d) return;
    const cpu = Math.round(d.cpu || 0);
    const mem = Math.round(d.mem || 0);
    if (sysCpuEl) sysCpuEl.textContent = cpu + '%';
    if (sysMemEl) sysMemEl.textContent = mem + '%';
    if (sysNetEl) sysNetEl.textContent = '↓' + fmtBps(d.rx);
    if (sysCpuTxt) sysCpuTxt.textContent = cpu + '%';
    if (sysMemTxt) {
      const usedG = d.memUsed ? (d.memUsed / 1073741824).toFixed(1) : '—';
      const totalG = d.memTotal ? (d.memTotal / 1073741824).toFixed(0) : '—';
      sysMemTxt.textContent = '内存 ' + usedG + '/' + totalG + 'G';
    }
    const gpu = Number(d.gpu);
    if (sysGpuTxt) sysGpuTxt.textContent = (gpu >= 0) ? Math.round(gpu) + '%' : '—';
    if (sysGpuBar) sysGpuBar.style.width = (gpu >= 0 ? Math.min(100, gpu) : 0) + '%';
    if (sysVramTxt) {
      sysVramTxt.textContent = (d.gpuMemTotal > 0)
        ? '显存 ' + (d.gpuMem / 1024).toFixed(1) + '/' + (d.gpuMemTotal / 1024).toFixed(0) + 'G'
        : '显存 —';
    }
    if (sysTempTxt) {
      const ct = Number(d.cpuTemp), gt = Number(d.gpuTemp);
      const bits = [];
      if (gt > 0) bits.push('GPU ' + Math.round(gt) + '°');
      if (ct > 0) bits.push('CPU ' + Math.round(ct) + '°');
      sysTempTxt.textContent = bits.length ? bits.join(' / ') : '温度 —';
    }
    if (sysNetTxt) sysNetTxt.textContent = '↓' + fmtBps(d.rx) + '/s';
    if (sysCpuBar) sysCpuBar.style.width = Math.min(100, cpu) + '%';
    if (sysMemBar) sysMemBar.style.width = Math.min(100, mem) + '%';
  }

  async function sysFetch() {
    try {
      const r = await fetch(`/sys?k=${encodeURIComponent(KEY)}`, { cache: 'no-store' });
      sysData = await r.json();
      sysPaint();
    } catch (_) {}
  }

  function sysStart() {
    sysFetch();
    if (sysTimer) return;
    sysTimer = setInterval(sysFetch, 2000);
  }

  function sysStop() {
    clearInterval(sysTimer);
    sysTimer = 0;
  }

  if (sysIsland) {
    levelBind(sysIsland, document.getElementById('sysMore'),
              document.getElementById('sysBack'), sysStart);
    registerIslandCard({
      id: 'sys', order: 30, title: '系统状态', el: sysIsland,
      onActivate: sysStart,
      onDeactivate: () => { sysStop(); if (sysIsland.__collapse) sysIsland.__collapse(); },
    });
  }

  // ================= 卡片 4：剪贴板 =================
  const clipIsland = document.getElementById('clipIsland');
  const clipChips = document.getElementById('clipChips');
  const clipChips2 = document.getElementById('clipChips2');
  const clipInput = document.getElementById('clipInput');
  let clipTimer = 0;
  let clipItems = [];

  function clipPaint() {
    const list = clipItems || [];
    // 一级：最多 2 条
    if (clipChips) {
      clipChips.innerHTML = '';
      if (!list.length) {
        const d = document.createElement('span');
        d.className = 'ci-chip';
        d.textContent = '剪贴板是空的';
        d.style.opacity = '.45';
        clipChips.appendChild(d);
      }
      list.slice(0, 2).forEach((it) => {
        const b = document.createElement('button');
        b.className = 'ci-chip';
        b.textContent = (it.text || '').replace(/\s+/g, ' ').slice(0, 16) || '(空)';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          copyToTablet(it.text || '');
          b.classList.add('on');
          setTimeout(() => b.classList.remove('on'), 700);
        });
        clipChips.appendChild(b);
      });
    }
    // 二级：最多 6 条，横向滚动
    if (clipChips2) {
      clipChips2.innerHTML = '';
      if (!list.length) {
        const d = document.createElement('span');
        d.className = 'ci-chip wide';
        d.textContent = '电脑剪贴板是空的';
        d.style.opacity = '.45';
        clipChips2.appendChild(d);
      }
      list.slice(0, 6).forEach((it) => {
        const b = document.createElement('button');
        b.className = 'ci-chip wide';
        b.textContent = (it.text || '').replace(/\s+/g, ' ').slice(0, 40) || '(空)';
        b.title = it.text || '';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          copyToTablet(it.text || '');
          b.classList.add('on');
          setTimeout(() => b.classList.remove('on'), 700);
        });
        clipChips2.appendChild(b);
      });
    }
  }

  async function clipFetch() {
    try {
      const r = await fetch(`/clip?k=${encodeURIComponent(KEY)}`, { cache: 'no-store' });
      const d = await r.json();
      clipItems = Array.isArray(d.items) ? d.items : [];
      clipPaint();
    } catch (_) {}
  }

  function clipStart() {
    clipFetch();
    if (clipTimer) return;
    clipTimer = setInterval(clipFetch, 3000);
  }

  function clipStop() {
    clearInterval(clipTimer);
    clipTimer = 0;
  }

  function clipSendText() {
    const v = (clipInput && clipInput.value || '').trim();
    if (!v) { flash('先输入内容'); return; }
    send({ t: 'clip.set', text: v });
    flash('已发到电脑剪贴板');
    if (clipInput) clipInput.value = '';
    setTimeout(clipFetch, 400);
  }

  if (clipIsland) {
    levelBind(clipIsland, document.getElementById('clipMore'),
              document.getElementById('clipBack'), clipStart);
    const sendBtn = document.getElementById('clipSend');
    if (sendBtn) sendBtn.addEventListener('click', (e) => { e.stopPropagation(); clipSendText(); });
    if (clipInput) {
      clipInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); clipSendText(); }
      });
      // 平板上粘贴后自动发一次
      clipInput.addEventListener('paste', () => setTimeout(clipSendText, 60));
      clipInput.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    registerIslandCard({
      id: 'clip', order: 40, title: '剪贴板', el: clipIsland,
      onActivate: clipStart,
      onDeactivate: () => { clipStop(); if (clipIsland.__collapse) clipIsland.__collapse(); },
    });
  }

  // ================= 卡片 5：宏键 =================
  const MACROS = [
    { k: '复制', mods: [0x11], vk: 0x56 },
    { k: '粘贴', mods: [0x11], vk: 0x58 },
    { k: '撤销', mods: [0x11], vk: 0x5A },
    { k: '保存', mods: [0x11], vk: 0x53 },
    { k: '全选', mods: [0x11], vk: 0x41 },
    { k: 'Tab', mods: [], vk: 0x09 },
    { k: '回车', mods: [], vk: 0x0D },
    { k: 'Esc', mods: [], vk: 0x1B },
    { k: '删除', mods: [], vk: 0x2E },
    { k: '关窗', mods: [0x12], vk: 0x73 },   // Alt+F4
  ];

  const macroIsland = document.getElementById('macroIsland');
  const macroRow = document.getElementById('macroRow');
  const macroRow2 = document.getElementById('macroRow2');

  function macroBtn(m, wide) {
    const b = document.createElement('button');
    b.className = 'ci-macro';
    b.textContent = m.k;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (m.mods && m.mods.length) send({ t: 'ks', mods: m.mods, vk: m.vk });
      else send({ t: 'k', vk: m.vk });
      b.style.background = 'var(--glass-hover)';
      setTimeout(() => { b.style.background = ''; }, 180);
    });
    return b;
  }

  if (macroIsland && macroRow) {
    MACROS.slice(0, 5).forEach((m) => macroRow.appendChild(macroBtn(m)));
    if (macroRow2) MACROS.forEach((m) => macroRow2.appendChild(macroBtn(m, true)));
    levelBind(macroIsland, document.getElementById('macroMore'),
              document.getElementById('macroBack'), null);
    registerIslandCard({
      id: 'macro', order: 50, title: '快捷按键', el: macroIsland,
      onDeactivate: () => { if (macroIsland.__collapse) macroIsland.__collapse(); },
    });
  }

  // ================= 截图查看 =================
  const shotView = document.getElementById('shotView');
  const shotImg = document.getElementById('shotImg');
  const shotClose = document.getElementById('shotClose');
  const shotBtn = document.getElementById('shotBtn');

  async function takeShot() {
    flash('正在截图…');
    try {
      const r = await fetch(`/shot?k=${encodeURIComponent(KEY)}&r=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      shotImg.src = URL.createObjectURL(blob);
      shotView.classList.add('on');
      shotView.setAttribute('aria-hidden', 'false');
      flash('截图已就绪');
    } catch (e) {
      flash('截图失败');
    }
  }

  if (shotBtn) {
    shotBtn.addEventListener('click', (e) => { e.stopPropagation(); takeShot(); });
  }
  if (shotClose) {
    shotClose.addEventListener('click', () => {
      shotView.classList.remove('on');
      shotView.setAttribute('aria-hidden', 'true');
      setTimeout(() => { if (shotImg.src) URL.revokeObjectURL(shotImg.src); }, 300);
    });
  }

  // ================= 窗口管理菜单（长按任务栏图标） =================
  const winMenu = document.getElementById('winMenu');
  let winMenuFor = 0;

  const WIN_ACTIONS = [
    { a: 'left', label: '左半屏' },
    { a: 'right', label: '右半屏' },
    { a: 'max', label: '最大化' },
    { a: 'center', label: '居中' },
    { a: 'close', label: '关闭窗口', danger: true },
  ];

  function hideWinMenu() {
    if (!winMenu) return;
    winMenu.classList.remove('on');
    winMenu.setAttribute('aria-hidden', 'true');
    winMenuFor = 0;
  }

  function showWinMenu(x, y, item) {
    if (!winMenu) return;
    winMenuFor = item.h;
    winMenu.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'wm-title';
    title.textContent = item.name || item.icon || '';
    winMenu.appendChild(title);

    if (!item.h) {
      const b = document.createElement('button');
      b.textContent = '启动这个程序';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        send({ t: 'run', p: item.icon });
        hideWinMenu();
      });
      winMenu.appendChild(b);
    } else {
      // 已经最大化的窗口：把「最大化」换成「还原窗口」
      const acts = WIN_ACTIONS.map((a) => (
        (a.a === 'max' && item.max) ? { a: 'restore', label: '向下还原' } : a
      ));
      acts.forEach((act) => {
        const b = document.createElement('button');
        b.textContent = act.label;
        if (act.danger) b.className = 'danger';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          send({ t: 'win', h: item.h, a: act.a });
          hideWinMenu();
          if (act.a === 'close') setTimeout(refreshTasks, 400);
        });
        winMenu.appendChild(b);
      });
    }

    const w = 168;
    const left = Math.min(window.innerWidth - w - 10, Math.max(10, x - w / 2));
    const top = Math.min(window.innerHeight - 40, Math.max(10, y + 12));
    winMenu.style.left = left + 'px';
    winMenu.style.top = top + 'px';
    winMenu.style.width = w + 'px';
    winMenu.classList.add('on');
    winMenu.setAttribute('aria-hidden', 'false');
  }

  // 全局：点别处收起菜单
  document.addEventListener('pointerdown', (e) => {
    if (!winMenu || !winMenu.classList.contains('on')) return;
    if (e.target.closest('#winMenu')) return;
    hideWinMenu();
  }, true);

  // 给任务栏图标挂长按
  function attachIconLongPress(btn) {
    let timer = 0;
    let moved = false;
    const start = (e) => {
      moved = false;
      clearTimeout(timer);
      const x = e.clientX, y = e.clientY;
      timer = setTimeout(() => {
        if (moved) return;
        const it = btn.__item || {};
        showWinMenu(x, y, it);
        if (navigator.vibrate) navigator.vibrate(12);
      }, 480);
    };
    const cancel = () => clearTimeout(timer);
    btn.addEventListener('pointerdown', start, { passive: true });
    btn.addEventListener('pointermove', (e) => {
      if (Math.abs(e.clientX - (btn.__x || 0)) > 8) moved = true;
      cancel();
    }, { passive: true });
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('pointerleave', cancel);
  }
  // 记录坐标，供滑动判定
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('.ti-app');
    if (b) { b.__x = e.clientX; }
  }, true);


  // 长按任务栏图标 → 窗口管理菜单。
  // 用事件委托挂在任务栏卡上，不依赖图标节点创建时机。
  let iconPressTimer = 0;
  let iconPressMoved = false;
  let iconPressX = 0, iconPressY = 0;

  taskIsland.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest && e.target.closest('.ti-app');
    if (!btn) return;
    iconPressMoved = false;
    iconPressX = e.clientX;
    iconPressY = e.clientY;
    clearTimeout(iconPressTimer);
    iconPressTimer = setTimeout(() => {
      iconPressTimer = 0;
      if (iconPressMoved) return;
      islandSwallowClick = performance.now() + 600;
      if (navigator.vibrate) navigator.vibrate(12);
      showWinMenu(iconPressX, iconPressY, btn.__item || {});
    }, 460);
  }, true);

  window.addEventListener('pointermove', (e) => {
    if (!iconPressTimer) return;
    if (Math.abs(e.clientX - iconPressX) > 8 || Math.abs(e.clientY - iconPressY) > 8) {
      iconPressMoved = true;
      clearTimeout(iconPressTimer);
      iconPressTimer = 0;
    }
  }, true);

  window.addEventListener('pointerup', () => {
    clearTimeout(iconPressTimer);
    iconPressTimer = 0;
  }, true);


  /* ==================================================================
     灵动岛卡片管理（仿华为卡片堆叠设置）
     入口：长按任意非任务栏卡片的一级菜单 → 展开「所有卡片」
     可：上移/下移（滑动顺序）、显示/隐藏（存 localStorage）
     ================================================================== */
  const CFG_KEY = 'padtrack.island.prefs';
  const CFG_NAMES = { music: '音乐播放器', tasks: '任务栏', sys: '系统状态', clip: '剪贴板', macro: '快捷按键' };
  const cfgPanel = document.getElementById('islandCfg');
  const cfgDoneBtn = document.getElementById('cfgClose');

  let cfgPrefs = { order: [], hidden: [] };
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) {
      const o = JSON.parse(raw) || {};
      if (Array.isArray(o.order)) cfgPrefs.order = o.order.filter((x) => typeof x === 'string');
      if (Array.isArray(o.hidden)) cfgPrefs.hidden = o.hidden.filter((x) => typeof x === 'string');
    }
  } catch (_) {}

  function cfgSave() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfgPrefs)); } catch (_) {}
  }

  function cfgOrdered() {
    const order = cfgPrefs.order;
    return ISLAND_CARDS.slice().sort((a, b) => {
      const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      if (ia < 0 && ib < 0) return a.order - b.order;
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
  }

  function cfgApply() {
    const hidden = new Set(cfgPrefs.hidden);
    ISLAND_CARDS.forEach((c) => {
      if (!c._avail) c._avail = c.available;
      c.available = () => !hidden.has(c.id) && c._avail();
    });
    const ordered = cfgOrdered();
    ISLAND_CARDS.length = 0;
    ordered.forEach((c) => ISLAND_CARDS.push(c));
    if (islandPos > ISLAND_CARDS.length - 1) islandPos = Math.max(0, ISLAND_CARDS.length - 1);
    islandPaint(true);
  }

  // ===== 扑克摊牌：摊开的牌就是灵动岛同款卡片 =====
  const fanStage = document.getElementById('fanStage');
  const fanPop = document.getElementById('fanPop');
  const FAN_STEP = 46;              // 每张卡错开的高度（卡高 48，所以略重叠）
  const fanMap = new Map();         // id → 卡片元素
  let fanBuilt = false;
  let fanPopFor = '';
  let cfgOpenedAt = 0;         // 刚打开的一小段时间内，忽略“长按结束”带出来的 click

  function cfgSubtitle(id) {
    if (id === 'music') {
      const t = document.getElementById('musicTitle');
      return (t && t.textContent && t.textContent !== '—') ? t.textContent : '未在播放';
    }
    if (id === 'tasks') return '切窗口 · 贴边 · 启动';
    if (id === 'sys') {
      const c = document.getElementById('sysCpu');
      const m = document.getElementById('sysMem');
      return c ? ('CPU ' + c.textContent + ' 内存 ' + m.textContent) : 'CPU / GPU';
    }
    if (id === 'clip') return '电脑剪贴板';
    if (id === 'macro') return '复制 粘贴 撤销';
    return '';
  }

  function fanBuild() {
    if (fanBuilt || !fanStage) return;
    fanBuilt = true;
    ISLAND_CARDS.forEach((card) => {
      const el = document.createElement('div');
      el.className = 'island-card';
      el.dataset.card = card.id;

      const t = document.createElement('div');
      t.className = 'fan-title';
      t.textContent = CFG_NAMES[card.id] || card.id;

      const sub = document.createElement('div');
      sub.className = 'fan-sub';

      el.appendChild(t);
      el.appendChild(sub);

      // 右侧控制：上移 / 下移 / 显示隐藏
      const ctrls = document.createElement('div');
      ctrls.className = 'fan-ctrls';
      const up = document.createElement('button');
      up.className = 'fan-btn';
      up.dataset.act = 'up';
      up.textContent = '↑';
      const down = document.createElement('button');
      down.className = 'fan-btn';
      down.dataset.act = 'down';
      down.textContent = '↓';
      const tg = document.createElement('button');
      tg.className = 'fan-btn fan-toggle';
      tg.dataset.act = 'toggle';
      ctrls.appendChild(up);
      ctrls.appendChild(down);
      ctrls.appendChild(tg);
      el.appendChild(ctrls);

      up.addEventListener('click', (e) => { e.stopPropagation(); fanMove(card.id, -1); });
      down.addEventListener('click', (e) => { e.stopPropagation(); fanMove(card.id, 1); });
      tg.addEventListener('click', (e) => { e.stopPropagation(); fanToggle(card.id); });

      // 点卡身 = 选中这张卡（点右侧按钮不算，否则会顺手把面板关掉）
      el.addEventListener('click', (e) => {
        if (performance.now() - cfgOpenedAt < 600) return;   // 长按松手带出来的 click
        if (e.target.closest('.fan-ctrls')) return;
        e.stopPropagation();
        const live = islandLive();
        const idx = live.findIndex((c) => c.id === card.id);
        if (idx >= 0) { islandPos = idx; }
        cfgClosePanel();
      });

      fanStage.appendChild(el);
      fanMap.set(card.id, el);
    });

  }

  // 第一张牌就压在灵动岛上（y=0），后面的依次往下排
  function fanTargetY(i, n) {
    return i * FAN_STEP;
  }

  // 把每张牌摆到灵动岛的位置和尺寸上
  function fanAlignToIsland() {
    if (!island) return;
    const r = island.getBoundingClientRect();
    fanMap.forEach((el) => {
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.width = r.width + 'px';
      el.style.height = r.height + 'px';
    });
  }

  function fanLayout(animate, delayBase) {
    const ids = cfgOrdered().map((c) => c.id);
    const n = ids.length;
    ids.forEach((id, i) => {
      const el = fanMap.get(id);
      if (!el) return;
      const hid = cfgPrefs.hidden.includes(id);
      el.classList.toggle('off', hid);
      el.style.zIndex = String(20 + i);
      const sub = el.querySelector('.fan-sub');
      if (sub) sub.textContent = cfgSubtitle(id);
      // 从「叠在中间 + 透明」的初始态恢复可见，否则摊开也看不见
      el.style.opacity = '1';
      // 控制按钮状态
      const upB = el.querySelector('[data-act="up"]');
      const downB = el.querySelector('[data-act="down"]');
      const tgB = el.querySelector('[data-act="toggle"]');
      if (upB) upB.disabled = i === 0;
      if (downB) downB.disabled = i === n - 1;
      if (tgB) {
        tgB.textContent = hid ? '已隐藏' : '显示中';
        tgB.classList.toggle('on', !hid);
      }

      if (animate) {
        const d = (delayBase || 0) + i * 85;
        el.style.transitionDelay = d + 'ms';
        requestAnimationFrame(() => {
          el.style.transform = `translate3d(0, ${fanTargetY(i, n)}px, 0)`;
        });
        setTimeout(() => { el.style.transitionDelay = '0ms'; }, d + 700);
      } else {
        el.style.transitionDelay = '0ms';
        el.style.transform = `translate3d(0, ${fanTargetY(i, n)}px, 0)`;
      }
    });
  }

  // ---------- 顺序与显隐 ----------
  function fanMove(id, delta) {
    const ids = cfgOrdered().map((c) => c.id);
    const at = ids.indexOf(id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(at, 1)[0]);
    cfgPrefs.order = ids;
    cfgSave();
    cfgApply();
    fanLayout(true);          // 只改 transform，卡片自己滑过去
  }

  function fanToggle(id) {
    cfgToggle(id);
    fanLayout(false);
  }

  // ---------- 右侧显隐菜单 ----------
  function fanShowPop(id) {
    if (!fanPop) return;
    const el = fanMap.get(id);
    if (!el) return;
    const hid = cfgPrefs.hidden.includes(id);
    fanPopFor = id;
    fanPop.innerHTML = '';

    const b = document.createElement('button');
    b.textContent = hid ? '恢复显示这张卡' : '不再显示这张卡';
    b.className = hid ? '' : 'danger';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      cfgToggle(id);
      fanLayout(false);
      fanHidePop();
    });
    fanPop.appendChild(b);

    const r = el.getBoundingClientRect();
    fanPop.classList.add('on');
    const pw = fanPop.offsetWidth || 120;
    const left = Math.min(window.innerWidth - pw - 10, r.right + 10);
    fanPop.style.left = left + 'px';
    fanPop.style.top = Math.max(10, r.top - 4) + 'px';
  }

  function fanHidePop() {
    fanPopFor = '';
    if (fanPop) fanPop.classList.remove('on');
  }

  function cfgToggle(id) {
    const hidden = new Set(cfgPrefs.hidden);
    if (hidden.has(id)) {
      hidden.delete(id);
    } else {
      const visible = ISLAND_CARDS.filter((c) => !hidden.has(c.id));
      if (visible.length <= 1 && visible.some((c) => c.id === id)) {
        flash('至少保留一张卡片');
        return;
      }
      hidden.add(id);
    }
    cfgPrefs.hidden = [...hidden];
    cfgSave();
    cfgApply();
  }

  // ---------- 打开 / 关闭 ----------
  function cfgOpen() {
    if (!cfgPanel) return;
    fanBuild();
    fanHidePop();
    // 灵动岛先自动翻到第一张卡
    islandPos = 0;
    islandPaint(true);
    // 真岛先藏起来：第一张牌就在它原位，玻璃是半透明的，不藏会透出两层文字
    islandHidden = true;
    island.style.opacity = '0';
    island.style.pointerEvents = 'none';

    // 对齐到灵动岛当前的位置：第一张就盖在岛上，看起来是「从岛上长出来」
    fanAlignToIsland();

    // 所有牌先叠在一起（都在灵动岛原位），再一张张向下摊开
    const ids = cfgOrdered().map((c) => c.id);
    const n = ids.length;
    ids.forEach((id) => {
      const el = fanMap.get(id);
      if (!el) return;
      el.style.transition = 'none';
      el.style.transitionDelay = '0ms';
      el.style.transform = `translate3d(0, ${fanTargetY(0, n)}px, 0) scale(.96)`;
      el.style.opacity = '0';
      const sub = el.querySelector('.fan-sub');
      if (sub) sub.textContent = cfgSubtitle(id);
      el.classList.toggle('off', cfgPrefs.hidden.includes(id));
    });

    cfgOpenedAt = performance.now();
    cfgPanel.classList.add('on');
    cfgPanel.setAttribute('aria-hidden', 'false');
    void cfgPanel.offsetWidth;
    ids.forEach((id) => {
      const el = fanMap.get(id);
      if (el) el.style.transition = '';
    });
    fanLayout(true, 120);
  }

  function cfgClosePanel() {
    if (!cfgPanel) return;
    fanHidePop();
    const n = cfgOrdered().length;
    fanMap.forEach((el) => {
      el.style.transition = 'transform .34s cubic-bezier(.4,0,.6,1), opacity .28s ease';
      el.style.transitionDelay = '0ms';
      el.style.transform = `translate3d(0, ${fanTargetY(0, n)}px, 0) scale(.94)`;
      el.style.opacity = '0';
    });
    setTimeout(() => {
      cfgPanel.classList.remove('on');
      cfgPanel.setAttribute('aria-hidden', 'true');
      islandHidden = false;
      islandPaint(true);          // 真岛恢复显示
    }, 300);
  }

  window.addEventListener('resize', () => {
    if (cfgPanel && cfgPanel.classList.contains('on')) fanAlignToIsland();
  });

  if (cfgDoneBtn) cfgDoneBtn.addEventListener('click', (e) => { e.stopPropagation(); cfgClosePanel(); });
  if (cfgPanel) {
    cfgPanel.addEventListener('pointerdown', (e) => {
      if (performance.now() - cfgOpenedAt < 600) return;
      if (e.target === cfgPanel || e.target === fanStage) {
        if (fanPopFor) { fanHidePop(); return; }
        cfgClosePanel();
      }
    });
  }

  // 长按卡片（任务栏卡除外，它长按是窗口菜单）
  function attachCfgLongPress(el, id) {
    if (!el || id === 'tasks') return;
    let timer = 0, moved = false, sx = 0, sy = 0;
    el.addEventListener('pointerdown', (e) => {
      moved = false;
      sx = e.clientX; sy = e.clientY;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (moved) return;
        islandSwallowClick = performance.now() + 500;
        if (navigator.vibrate) navigator.vibrate(14);
        cfgOpen();
      }, 560);
    }, { passive: true });
    el.addEventListener('pointermove', (e) => {
      if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) {
        moved = true;
        clearTimeout(timer);
      }
    }, { passive: true });
    el.addEventListener('pointerup', () => clearTimeout(timer));
    el.addEventListener('pointercancel', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => clearTimeout(timer));
  }

  // islandNoMenu：长按时系统别弹菜单（安卓上会抢走手势）
  ['island', 'taskIsland', 'sysIsland', 'clipIsland', 'macroIsland', 'islandCfg'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  // 应用保存过的显隐/顺序，挂拖动与长按
  cfgApply();
  ISLAND_CARDS.forEach((c) => { islandAttachDrag(c.el); attachCfgLongPress(c.el, c.id); });
  islandPaint(false);
  console.info('[island] 已注册卡片:', ISLAND_CARDS.map((c) => c.id).join(', '));

  const lyricsEl = document.getElementById('lyrics');
  const lyricInner = document.getElementById('lyricInner');

  let lastMedia = '';
  let uiPaused = false;          // 界面认为当前是否暂停
  let iconLockUntil = 0;         // 刚点过按钮的一小段时间内不被轮询覆盖

  let paintedPaused = null;

  function paintPlayIcon() {
    paintedPaused = uiPaused;
    const ico = uiPaused ? SVG_PLAY : SVG_PAUSE;
    document.querySelectorAll('#island [data-media="179"]').forEach((b) => { b.innerHTML = ico; });
  }
  let changeAt = 0;      // 发现切歌的时刻，用来补上抓取封面歌词那段时间
  let lyricOffset = parseFloat(localStorage.getItem('padtrackLyricOffset') || '0') || 0;
  let lyricLines = [], lyricBase = 0, lyricClock = 0;
  let lyricPlaying = false, lyricActive = -1, lyricSongKey = '';

  // 维护不变式：songAnchor = 播放位置等于 lyricBase 的那一刻（performance.now 时间轴）
  function anchorAt(nowMs) {
    songAnchor = nowMs - lyricBase * 1000;
  }

  function lyricTime() {
    return lyricBase + (lyricPlaying ? (performance.now() - lyricClock) / 1000 : 0);
  }

  const bgCoverEl = document.getElementById('bgCover');
  const bgLayers = [
    document.getElementById('bgCoverA'),
    document.getElementById('bgCoverB'),
  ];
  let bgFront = 0;             // 当前显示的是哪一层
  let bgUrl = '';              // 当前背景对应的封面地址

  // 左侧栏和背景层各自独立开关；两个都关就完全不画
  function lyricsVisible() {
    return S.lyrOn !== false;
  }

  function applyLyricToggles() {
    const has = lyricLines.length > 0 && lyricsVisible();
    lyricsEl.classList.toggle('on', has && S.lyrOn !== false);
    document.body.classList.toggle('has-lyrics', has);
    hint.style.display = has ? 'none' : '';
    applyBgCover();
  }

  // 键盘（全屏/分屏/环绕）的背景层：每个 .artbg 里放两层图片交叉淡入
  const artHosts = [...document.querySelectorAll('.artbg')].map((host) => {
    const a = document.createElement('i');
    const b = document.createElement('i');
    host.prepend(a, b);             // 放在压暗层下面
    return { imgs: [a, b], front: 0, url: '' };
  });

  function paintArt(url) {
    artHosts.forEach((st) => {
      const want = url || '';
      if (st.url === want) return;
      st.url = want;
      const [x, y] = st.imgs;
      if (!want) {
        x.classList.remove('on'); y.classList.remove('on');
        x.style.backgroundImage = ''; y.style.backgroundImage = '';
        return;
      }
      const back = st.imgs[1 - st.front];
      const swap = () => {
        back.classList.add('on');
        st.imgs[st.front].classList.remove('on');
        st.front = 1 - st.front;
      };
      // 用背景图，先预加载再切换，避免闪白
      const probe = new Image();
      probe.onload = () => {
        back.style.backgroundImage = `url("${want}")`;
        swap();
      };
      probe.onerror = () => {
        back.style.backgroundImage = `url("${want}")`;
        swap();
      };
      probe.src = want;
    });
  }

  // 封面背景：有封面且开关打开才显示
  function applyBgCover() {
    const on = S.coverBg === true && !!bgUrl;
    bgCoverEl.classList.toggle('on', on);
    document.documentElement.classList.toggle('art-on', on);
    document.documentElement.style.setProperty(
      '--art-url', bgUrl ? `url("${bgUrl}")` : 'none');
    paintArt(bgUrl);
  }

  // 换背景：新图在背面层加载好再淡入，旧图同时淡出
  function setBgCover(url) {
    if (url === bgUrl) return;
    bgUrl = url || '';
    if (!bgUrl) {
      bgLayers.forEach((img) => { img.classList.remove('on'); img.removeAttribute('src'); });
      applyBgCover();
      return;
    }
    const front = bgLayers[bgFront];
    const back = bgLayers[1 - bgFront];
    if (front.dataset.url === bgUrl) { applyBgCover(); return; }

    const swap = () => {
      back.classList.add('on');
      front.classList.remove('on');
      bgFront = 1 - bgFront;
      applyBgCover();
    };
    back.dataset.url = bgUrl;
    const probe = new Image();
    probe.onload = () => {
      back.style.backgroundImage = `url("${bgUrl}")`;
      swap();
    };
    probe.onerror = () => swap();
    probe.src = bgUrl;
  }

  function paintLyric(force) {
    if (!lyricLines.length) return;
    const t = lyricTime();
    let idx = -1;
    for (let i = 0; i < lyricLines.length; i++) {
      if (lyricLines[i][0] <= t) idx = i;
      else break;
    }
    if (idx === lyricActive && !force && lyricInner.style.transform) return;
    lyricActive = idx;

    // 左侧滚动栏
    const items = lyricInner.children;
    for (let i = 0; i < items.length; i++) items[i].classList.toggle('active', i === idx);
    // 还没到第一句（歌刚开始 / 暂停着）时，先把第一句居中，
    // 否则列表会贴在容器顶部，看起来像"没对齐"，而且要等到第一句才动。
    //
    // 位置要用目标行**真实的** offsetTop：歌词有长句折行时每行高度不一样，
    // 按「行号 × 首行高度」算会越算越偏（开头看不出来，唱到后面就漂走了）。
    const target = idx >= 0 ? items[idx] : items[0];
    if (target) {
      const h = lyricsEl.clientHeight;
      const y = target.offsetTop + target.offsetHeight / 2;
      lyricInner.style.transform = `translateY(${Math.round(h / 2 - y)}px)`;
    }
  }

  function setCredits(list) {
    const box = document.getElementById('lyricCredits');
    if (!box) return;
    const rows = Array.isArray(list) ? list.slice(0, 3) : [];   // 作词/作曲/编曲，再多就截断了
    if (!rows.length) { box.textContent = ''; box.classList.remove('on'); return; }
    box.textContent = rows.join('  ·  ');
    box.title = rows.join('\n');
    box.classList.add('on');
  }

  function setLyrics(lines, pos) {
    lyricLines = Array.isArray(lines) ? lines : [];
    lyricInner.innerHTML = '';
    lyricInner.style.transform = '';
    lyricActive = -1;
    lyricBase = (pos || 0) + lyricOffset;
    lyricClock = performance.now();
    lyricLines.forEach((row) => {
      const a = document.createElement('div');
      a.className = 'lyric-line';
      a.textContent = row[1];
      lyricInner.appendChild(a);

    });
    applyLyricToggles();
    if (!lyricLines.length) return;
    paintLyric(true);
  }

  async function pollMedia(force) {
    try {
      const r = await fetch(`/media?k=${encodeURIComponent(KEY)}` + (force ? '&bust=1' : ''),
        { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      // 歌词/时长晚到也要触发重绘，否则会因为标题没变而被提前 return 掉
      const key = (d.title || '') + '|' + (d.artist || '') + '|' + (d.status || '') + '|' +
                  (d.cover || '') + '|' + (d.lyric ? d.lyric.length : 0) + '|' + (d.dur || 0);
      if (key === lastMedia) return;
      lastMedia = key;

      if (!d.title) {
        // 没在播放：胶囊和歌词一起收起来
        island.classList.remove('on');
      islandRefresh();
        expandIsland(false);
        musicWave.classList.remove('playing');
        musicProg.style.width = '0%';
        lyricsEl.classList.remove('on');
        document.body.classList.remove('has-lyrics');
        hint.style.display = '';
        lyricLines = [];
        lyricSongKey = '';
        lyricPlaying = false;
        applyLyricToggles();
        musicCover.classList.remove('on');
        musicCover.dataset.url = '';
        musicCoverBig.dataset.url = '';
        musicCover.style.backgroundImage = '';
        musicCoverBig.style.backgroundImage = '';
        setBgCover('');
        return;
      }

      island.classList.add('on');
      islandRefresh();
      musicTitle.textContent = d.title;
      requestAnimationFrame(() => mqApply(musicTitle));
      if (!window.__mqBound) {
        window.__mqBound = true;
        window.addEventListener('resize', () => mqApply(musicTitle));
      }
      musicTitle.title = d.title;
      const titleFull = document.getElementById('musicTitleFull');
      if (titleFull) { titleFull.textContent = d.title; titleFull.title = d.title; }
      musicArtist.textContent = d.artist || '';

      // 先把上一首的时长/基准存下来，再更新 songDur，
      // 否则下面推算「上一首放完了多久」用的会变成新歌的时长
      const nowMs = performance.now();
      const prevDur = songDur;
      const prevAnchor = songAnchor;
      songDur = typeof d.dur === 'number' ? d.dur : 0;

      const coverUrl = d.cover
        ? `/cover?k=${encodeURIComponent(KEY)}&h=${encodeURIComponent(d.cover)}`
        : '';
      if (coverUrl) {
        if (musicCover.dataset.url !== coverUrl) {
          const bg = `url("${coverUrl}")`;
          musicCover.dataset.url = coverUrl;
          musicCoverBig.dataset.url = coverUrl;
          musicCover.style.backgroundImage = bg;
          musicCoverBig.style.backgroundImage = bg;
          setBgCover(coverUrl);
        }
      } else {
        musicCover.removeAttribute('src');
        musicCoverBig.removeAttribute('src');
      }
      applyBgCover();

      const songKey = `${d.title}|${d.artist}`;
      const paused = d.status === 'Paused';

      if (songKey !== lyricSongKey) {
        // 起始点：播放器给了真实进度就用它；否则用「上一首的结束时间」推算。
        // 顺序播放时上一首放完正好接下一首，这样切歌瞬间就能对上。
        let base = typeof d.pos === 'number' ? d.pos : 0;
        if (typeof d.pos !== 'number' && prevDur > 0 && prevAnchor > 0) {
          const predictedEnd = prevAnchor + prevDur * 1000;
          const late = nowMs - predictedEnd;
          // 正常两首之间只差 0~1.5 秒；算出好几秒的「迟到」一定是基准错了，宁可不用
          if (late > -3000 && late < 4000) base = Math.max(0, late / 1000);
        }
        // 没有上一首可推算时（手动点播/跳过），至少把「从发现到拿到歌词」这段补上
        if (typeof d.pos !== 'number' && changeAt) {
          base = Math.max(base, (nowMs - changeAt) / 1000 + 0.5);   // +0.5 是轮询的平均发现延迟
        }
        lyricSongKey = songKey;
        lyricPlaying = !paused;
        setCredits(d.credits);
        setLyrics(d.lyric, base);
        anchorAt(nowMs);
      } else {
        if (typeof d.pos === 'number') {
          // 播放器支持进度回传时以它为准；偏差小的时候不动，免得被采样误差拽着跳
          const want = posBase(d.pos);
          if (Math.abs(want - lyricTime()) > 3) {
            lyricBase = want;
            lyricClock = nowMs;
            anchorAt(nowMs);
          }
        }
        // 歌词晚到（先拿到歌名、后拿到歌词）时补一次
        if (!lyricLines.length && d.lyric && d.lyric.length) {
          setCredits(d.credits);
          setLyrics(d.lyric, typeof d.pos === 'number' ? d.pos : 0);
          anchorAt(nowMs);
        }
        // 有真实播放位置时，暂停/恢复也以它为准
        if (typeof d.pos === 'number' && lyricLines.length) {
          lyricBase = posBase(d.pos);
          lyricClock = nowMs;
          anchorAt(nowMs);
        }
      }

      mShuffle = typeof d.shuffle === 'boolean' ? d.shuffle : null;
      mRepeat = typeof d.repeat === 'number' ? d.repeat : null;
      paintModes();

      // 刚点过按钮的那 2.5 秒内，以用户的操作意图为准：
      // 否则服务端还没跟上（电平要静音 0.45 秒才判定）时会把状态覆盖回去，图标就会来回弹。
      if (performance.now() > iconLockUntil) {
        if (paused && lyricPlaying) {
          lyricBase = lyricTime();
          lyricPlaying = false;
          lyricClock = nowMs;
          anchorAt(nowMs);
        } else if (!paused && !lyricPlaying) {
          lyricClock = nowMs;
          lyricPlaying = true;
          anchorAt(nowMs);          // 恢复时也要重锚，否则暂停的时长会被算进基准
        }
        uiPaused = paused;
        paintPlayIcon();
      }
      musicWave.classList.toggle('playing', !uiPaused);
    } catch (err) { console.error('pollMedia 出错:', err && err.message); }
  }
  pollMedia();
  setInterval(pollMedia, 3000);
  fetchVolume();
  setInterval(fetchVolume, 5000);   // 用键盘或系统面板调了音量，这边也能跟上
  // 切到后台时定时器会被节流，回来立刻补一次，别让界面停在旧状态
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    lastMedia = '';
    pollMedia(true);
    pollNow();
  });


  /* ---------------- 进度条拖动跳转 ---------------- */
  const seekBar = document.getElementById('seekBar');
  let seekDrag = false;

  function barRatio(e) {
    const r = seekBar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
  }

  function paintSeek(ratio) {
    musicProg.style.width = (ratio * 100).toFixed(1) + '%';
    seekBar.style.setProperty('--p', (ratio * 100).toFixed(1));
  }

  // 拖进度条时别让点击冒泡到胶囊（否则会顺手把展开态收起来）
  seekBar.addEventListener('click', (e) => e.stopPropagation());

  seekBar.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (!songDur) { flash('还没拿到歌曲时长'); return; }
    e.stopPropagation();
    seekDrag = true;
    seekBar.classList.add('dragging');
    try { seekBar.setPointerCapture(e.pointerId); } catch (_) {}
    paintSeek(barRatio(e));
  });

  seekBar.addEventListener('pointermove', (e) => {
    if (!seekDrag) return;
    e.stopPropagation();
    paintSeek(barRatio(e));
  });

  seekBar.addEventListener('pointercancel', (e) => {
    if (!seekDrag) return;
    seekDrag = false;
    seekBar.classList.remove('dragging');
    paintProgress();
  });

  seekBar.addEventListener('pointerup', async (e) => {
    if (!seekDrag) return;
    e.stopPropagation();
    seekDrag = false;
    seekBar.classList.remove('dragging');
    const target = barRatio(e) * songDur;
    try {
      const r = await fetch(`/seek?k=${encodeURIComponent(KEY)}&pos=${target.toFixed(1)}`,
        { cache: 'no-store' });
      const d = await r.json();
      if (d && d.ok) {
        lyricBase = target;
        lyricClock = performance.now();
        anchorAt(lyricClock);
        paintLyric(true);
        flash('跳到 ' + fmtTime(target));
      } else {
        flash(d && d.reason === 'no-session' ? '这个播放器不支持跳转' : '跳转失败');
        paintProgress();
      }
    } catch (_) {
      paintProgress();
    }
  });

  function fmtTime(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  /* ---------------- 歌单抽屉 ---------------- */
  const plSheet = document.getElementById('plSheet');
  const sheetMask = document.getElementById('sheetMask');
  const plChips = document.getElementById('plChips');
  const plList = document.getElementById('plList');
  let plLoaded = false, plCurrent = '';

  // 胶囊条滚动到两端时，被切一半的那个歌单名用淡出盖住，而不是硬切
  function paintChipFade() {
    const max = plChips.scrollWidth - plChips.clientWidth;
    plChips.classList.toggle('fade-l', plChips.scrollLeft > 4);
    plChips.classList.toggle('fade-r', max > 4 && plChips.scrollLeft < max - 4);
  }
  plChips.addEventListener('scroll', paintChipFade, { passive: true });
  window.addEventListener('resize', paintChipFade);

  function openSheet() {
    plSheet.classList.add('on');
    sheetMask.classList.add('on');
    collapsePlayer();
    if (!plLoaded) { plLoaded = true; loadPlaylists(); }
  }
  function closeSheet() {
    plSheet.classList.remove('on');
    sheetMask.classList.remove('on');
  }

  async function loadPlaylists() {
    try {
      const r = await fetch(`/playlists?k=${encodeURIComponent(KEY)}`, { cache: 'no-store' });
      const list = await r.json();
      plChips.innerHTML = '';
      if (!Array.isArray(list) || !list.length) {
        plList.innerHTML = '<div id="plEmpty">没读到网易云的歌单目录</div>';
        return;
      }
      list.forEach((p, i) => {
        const b = document.createElement('button');
        b.textContent = p.name;
        b.dataset.id = p.id;
        b.addEventListener('click', () => selectPlaylist(p.id, b));
        plChips.appendChild(b);
        if (i === 0) setTimeout(() => selectPlaylist(p.id, b), 80);
      });
      paintChipFade();   // 铺完先算一次，右侧该淡就淡
    } catch (_) {
      plList.innerHTML = '<div id="plEmpty">读取失败</div>';
    }
  }

  async function selectPlaylist(pid, btn) {
    plCurrent = pid;
    [...plChips.children].forEach((b) => b.classList.toggle('on', b === btn));
    plList.innerHTML = '<div id="plEmpty">读取中…</div>';
    try {
      const r = await fetch(`/playlist?k=${encodeURIComponent(KEY)}&id=${encodeURIComponent(pid)}`,
        { cache: 'no-store' });
      const tracks = await r.json();
      plList.innerHTML = '';
      if (!Array.isArray(tracks) || !tracks.length) {
        plList.innerHTML = '<div id="plEmpty">这个歌单是空的</div>';
        return;
      }
      tracks.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'trk' + (t.name === musicTitle.textContent ? ' now' : '');
        row.style.animationDelay = Math.min(i * 18, 260) + 'ms';
        const idx = document.createElement('div');
        idx.className = 'idx';
        idx.textContent = String(i + 1);
        const meta = document.createElement('div');
        meta.className = 'meta2';
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = t.name || '(未知)';
        const ar = document.createElement('div');
        ar.className = 'ar';
        ar.textContent = t.artist || '';
        meta.appendChild(nm);
        meta.appendChild(ar);
        const du = document.createElement('div');
        du.className = 'du';
        du.textContent = t.dur ? fmtTime(t.dur) : '';
        row.appendChild(idx);
        row.appendChild(meta);
        row.appendChild(du);
        row.addEventListener('click', () => {
          flash('《' + (t.name || '') + '》无法从 PadTrack 点播');
        });
        plList.appendChild(row);
      });
    } catch (_) {
      plList.innerHTML = '<div id="plEmpty">读取失败</div>';
    }
  }

  document.getElementById('plBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openSheet();
  });
  document.getElementById('plClose').addEventListener('click', closeSheet);
  sheetMask.addEventListener('click', closeSheet);

  // 快速探测：每秒问一次「现在放的是哪首」，切歌能立刻发现
  let nowKey = '';
  async function pollNow() {
    try {
      const r = await fetch(`/now?k=${encodeURIComponent(KEY)}`, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const k = (d.title || '') + '|' + (d.status || '');
      if (k !== nowKey) { nowKey = k; lastMedia = ''; changeAt = performance.now(); pollMedia(true); }
      // 每秒用服务端的真实播放位置重锚，墙钟推算的误差就不会累积
      if (typeof d.pos === 'number' && lyricLines.length && !uiPaused
          && performance.now() > iconLockUntil) {
        const want = posBase(d.pos);
        // 死区：偏差超过 3 秒才重锚。暂停/恢复时 pos 会多算 1~2 秒，
        // 不设死区的话歌词会在暂停后往前跳一下。
        if (Math.abs(want - lyricTime()) > 3) {
          lyricBase = want;
          lyricClock = performance.now();
          anchorAt(lyricClock);
          paintLyric(false);
        }
      }
    } catch (_) {}
  }
  setInterval(pollNow, 1000);
  function paintProgress() {
    if (!songDur) { musicProg.style.width = '0%'; return; }
    const t = lyricTime();
    // 单曲循环时标题不变，靠时长判断是不是又从头开始了
    if (t > songDur + 2) {
      lyricBase = t - songDur;
      lyricClock = performance.now();
      anchorAt(lyricClock);
      paintLyric(true);
    }
    const p = Math.max(0, Math.min(1, lyricTime() / songDur));
    musicProg.style.width = (p * 100).toFixed(1) + '%';
    seekBar.style.setProperty('--p', (p * 100).toFixed(1));
    musicTime.textContent = fmtTime(lyricTime()) + ' / ' + fmtTime(songDur);
  }
  setInterval(() => {
    paintLyric(false);
    paintProgress();
    if (performance.now() > iconLockUntil && uiPaused !== paintedPaused) paintPlayIcon();
  }, 220);

  // ?debug=1 时显示同步诊断：paused 时 t 应该停住
  // 帧间隔统计：能区分「渲染卡」和「网络卡」
  let frameGapMax = 0, frameLast = performance.now(), frameGapBad = 0;
  (function watchFrames() {
    const now = performance.now();
    const gap = now - frameLast;
    frameLast = now;
    if (gap > 60) { frameGapBad++; frameGapMax = Math.max(frameGapMax, Math.round(gap)); }
    requestAnimationFrame(watchFrames);
  })();

  const syncbox = document.getElementById('syncbox');
  const DEBUG_SYNC = new URLSearchParams(location.search).get('debug') === '1';
  if (DEBUG_SYNC) syncbox.style.display = 'block';
  setInterval(() => {
    if (!DEBUG_SYNC) return;
    const t = lyricTime();
    const cur = lyricActive >= 0 && lyricLines[lyricActive] ? lyricLines[lyricActive] : null;
    syncbox.textContent =
      't=' + t.toFixed(1) + 's  line#' + lyricActive +
      (cur ? ' @' + cur[0].toFixed(1) : '') +
      '\noffset=' + lyricOffset + '  dur=' + (songDur ? songDur.toFixed(1) : '-') +
      '\nstatus=' + (lyricPlaying ? 'playing' : 'paused') +
      '  lines=' + lyricLines.length +
      '\n卡帧=' + frameGapBad + ' 次  最长=' + frameGapMax + 'ms' +
      '\n采样=' + evtRate + '/s  发送=' + msgRate + '/s' +
      '\n' + (lyricSongKey || '-');
  }, 250);

  // 服务端给的 pos 是「这首歌播到哪」，单曲循环时会一直涨，
  // 超过歌曲长度就绕回来；顺便把用户设置的偏移算进去
  function posBase(posSec) {
    let p = posSec;
    if (songDur > 0 && p > songDur + 1) p = p % songDur;
    return p + lyricOffset;
  }

  // 输入自检：真的挪一下光标，看它动没动。
  // SendInput 返回成功却不生效的情况很多（权限、安全桌面、被程序限制），
  // 只看返回值没用，必须看光标实际位置。
  const diagVal = document.getElementById('diagVal');
  async function runDiag() {
    if (diagVal) { diagVal.textContent = '检测中…'; diagVal.classList.remove('on'); }
    try {
      const r = await fetch(`/inject?k=${encodeURIComponent(KEY)}`, { cache: 'no-store' });
      const d = await r.json();
      let msg, short;
      if (!d.ok) {
        short = '失败';
        msg = '失败：' + (d.reason || '未知');
      } else if (d.verdict === 'ok') {
        short = '正常';
        msg = '正常' + (d.admin ? '（管理员）' : '（普通权限）');
      } else if (d.verdict === 'blocked-by-uipi') {
        short = '被权限拦';
        msg = '注入被权限拦：前台程序是管理员身份（WattToolkit 这类），'
            + '请用管理员身份启动 PadTrack';
      } else {
        short = '光标被锁';
        msg = '光标被锁住：可能处在安全桌面（锁屏/UAC），或前台程序限制了光标范围';
      }
      if (diagVal) {
        diagVal.textContent = short;
        diagVal.classList.toggle('on', d.verdict !== 'ok');
      }
      flash(msg);
    } catch (err) {
      if (diagVal) diagVal.textContent = '失败';
      flash('自检失败：' + (err && err.message));
    }
  }
  const diagBtn = document.getElementById('diagBtn');
  if (diagBtn) diagBtn.addEventListener('click', (e) => { e.stopPropagation(); runDiag(); });

  // 显示当前权限 + 前台程序是不是管理员（点不动时能直接看出来）
  const fgVal = document.getElementById('fgVal');
  async function refreshDiagInfo() {
    try {
      const r = await fetch(`/diag?k=${encodeURIComponent(KEY)}`, { cache: 'no-store' });
      const d = await r.json();
      if (diagVal) diagVal.textContent = d.admin ? '管理员' : '普通';
      if (fgVal) {
        const fg = d.foreground;
        if (!fg) { fgVal.textContent = '—'; fgVal.classList.remove('on'); }
        else {
          fgVal.textContent = (fg.elevated ? '⚠ ' : '') +
            (fg.title ? fg.title.slice(0, 12) : '(无标题)') +
            (fg.elevated ? '（管理员）' : '');
          fgVal.classList.toggle('on', !!fg.elevated && !d.admin);
        }
      }
    } catch (_) {}
  }
  refreshDiagInfo();
  setInterval(refreshDiagInfo, 4000);

  // 以管理员重启：前台是管理员程序、我们又没权限时，一键提权
  const elevBtn = document.getElementById('elevBtn');
  if (elevBtn) {
    elevBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      elevBtn.disabled = true;
      try {
        const r = await fetch(`/elevate?k=${encodeURIComponent(KEY)}`, { cache: 'no-store' });
        const d = await r.json();
        if (d.already) flash('已经是管理员权限了');
        else if (d.ok) flash('正在提权：请到电脑上点「是」，然后重新连接');
        else flash('提权失败：' + (d.reason || '未知'));
      } catch (err) {
        flash('提权请求失败：' + (err && err.message));
      }
      setTimeout(() => { elevBtn.disabled = false; }, 3000);
    });
  }

  // 把当前偏移显示出来（设置面板 + 左上角角标）
  const lyrOffVal = document.getElementById('lyrOffVal');
  const offBadge = document.getElementById('offBadge');
  function paintOffset() {
    const v = Math.round(lyricOffset * 10) / 10;
    const txt = v === 0 ? '0 秒' : (v > 0 ? '+' : '') + v + ' 秒';
    if (lyrOffVal) {
      lyrOffVal.textContent = txt;
      lyrOffVal.classList.toggle('on', v !== 0);
    }
    if (offBadge) {
      offBadge.textContent = v === 0 ? '' : '歌词偏移 ' + txt;
      offBadge.classList.toggle('on', v !== 0);
    }
  }

  // ---------------- 系统音量 ----------------
  const volRow = document.getElementById('volRow');
  const volBar = document.getElementById('volBar');
  const volFill = document.getElementById('volFill');
  const volKnob = document.getElementById('volKnob');
  const volPct = document.getElementById('volPct');
  const volMute = document.getElementById('volMute');
  let volLevel = 0.5, volMuted = false, volKnown = false;

  function applyVolume(d) {
    if (!d) return;
    if (d.ok === false) {           // 没装 pycaw：整行藏起来
      volKnown = false;
      if (volRow) volRow.classList.add('hide');
      return;
    }
    volKnown = true;
    if (typeof d.level === 'number') volLevel = Math.max(0, Math.min(1, d.level));
    if (typeof d.muted === 'boolean') volMuted = d.muted;
    paintVolume();
  }

  function paintVolume() {
    if (!volRow) return;
    volRow.classList.toggle('hide', !volKnown);
    if (!volKnown) return;
    const pct = Math.round((volMuted ? 0 : volLevel) * 100);
    const w = (volLevel * 100) + '%';
    volFill.style.width = w;
    volKnob.style.left = w;
    volPct.textContent = volMuted ? '静音' : pct + '%';
    volMute.classList.toggle('muted', volMuted);
    document.getElementById('volX').style.display = volMuted ? '' : 'none';
    document.getElementById('volWave1').style.display = volMuted ? 'none' : '';
    document.getElementById('volWave2').style.display = volMuted ? 'none' : '';
  }

  async function fetchVolume() {
    try {
      const r = await fetch(`/volume?k=${encodeURIComponent(KEY)}`, { cache: 'no-store' });
      applyVolume(await r.json());
    } catch (_) { /* 网络抖动就算了，下次轮询再来 */ }
  }

  // 拖动：本地先跟手，再按 60ms 节流发 WS
  let volDragging = false, volLastSend = 0, volPending = -1;
  function volRatio(e) {
    const r = volBar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }
  function volApplyLocal(v) {
    volLevel = v;
    volMuted = false;
    paintVolume();
  }
  function volSend(force) {
    const now = performance.now();
    if (!force && now - volLastSend < 60) return;
    if (volPending < 0) return;
    volLastSend = now;
    send({ t: 'vol', v: volPending, mute: false });
    volPending = -1;
  }
  if (volBar) {
    volBar.addEventListener('pointerdown', (e) => {
      if (!volKnown) return;
      volDragging = true;
      volBar.classList.add('dragging');
      try { volBar.setPointerCapture(e.pointerId); } catch (_) {}
      const v = volRatio(e);
      volApplyLocal(v);
      volPending = v;
      volSend(true);
      e.preventDefault();
    });
    volBar.addEventListener('pointermove', (e) => {
      if (!volDragging) return;
      const v = volRatio(e);
      volApplyLocal(v);
      volPending = v;
      volSend(false);
    });
    const endDrag = (e) => {
      if (!volDragging) return;
      volDragging = false;
      volBar.classList.remove('dragging');
      if (volPending >= 0) volSend(true);
      setTimeout(fetchVolume, 120);       // 以服务端实际值为准
      e.preventDefault();
    };
    volBar.addEventListener('pointerup', endDrag);
    volBar.addEventListener('pointercancel', endDrag);
  }
  if (volMute) {
    volMute.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!volKnown) return;
      volMuted = !volMuted;
      paintVolume();
      send({ t: 'vol', mute: volMuted });
      setTimeout(fetchVolume, 150);
    });
  }

  // 手动微调歌词进度：打开页面时歌已经在播一半，就靠这个对齐
  function nudgeLyric(sec) {
    lyricOffset = Math.round((lyricOffset + sec) * 10) / 10;
    localStorage.setItem('padtrackLyricOffset', String(lyricOffset));
    if (!lyricLines.length) { flash('当前没有歌词'); return; }
    lyricBase = Math.max(0, lyricTime() + sec);
    lyricClock = performance.now();
    paintLyric(true);
    paintOffset();
    const dir = sec > 0 ? '快进' : '后退';
    flash('歌词' + dir + ' ' + Math.abs(sec) + ' 秒（累计 ' + lyricOffset + '）');
  }
  paintOffset();

  const buildLine = document.getElementById('buildLine');
  if (buildLine) {
    const t = new Date(performance.timeOrigin || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    buildLine.textContent = '页面加载于 ' + p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds()) +
      '（浏览器显示旧界面时刷新一下）';
  }
  // 黑色毛玻璃：默认开，关掉就切回白色玻璃
  const glassDarkBox = document.getElementById('glassDark');
  function applyGlass() {
    const dark = S.glassDark !== false;      // 默认黑色
    document.documentElement.classList.toggle('glass-light', !dark);
    if (glassDarkBox) glassDarkBox.checked = dark;
  }
  applyGlass();
  if (glassDarkBox) {
    glassDarkBox.addEventListener('change', () => {
      S.glassDark = glassDarkBox.checked;
      saveS();
      applyGlass();
      flash(S.glassDark ? '毛玻璃：黑色' : '毛玻璃：白色');
    });
  }

  // 长按拖动开关：默认开，关掉之后就只剩双击拖和单击
  const holdDragBox = document.getElementById('holdDrag');
  if (holdDragBox) {
    holdDragBox.checked = S.holdDrag !== false;
    holdDragBox.addEventListener('change', () => {
      S.holdDrag = holdDragBox.checked;
      saveS();
      flash(S.holdDrag ? '长按拖动：开' : '长按拖动：关');
    });
  }

  // 连接方式：页面地址 + 服务端看到的来源 IP，一眼看出走的是 USB 还是 WiFi
  const connVal = document.getElementById('connVal');
  async function paintConn() {
    if (!connVal) return;
    const here = location.host;
    const local = /^(127\.0\.0\.1|localhost)(:|$)/.test(here);
    let peer = '';
    try {
      const r = await fetch(`/diag?k=${encodeURIComponent(KEY)}`, { cache: 'no-store' });
      const d = await r.json();
      if (d.client) peer = d.client;
    } catch (_) {}
    const how = local || peer === '127.0.0.1' ? 'USB 直连' : 'WiFi';
    connVal.textContent = how + '（' + here + '）';
    connVal.title = '页面地址: ' + here + '\n服务端看到的来源: ' + (peer || '未知');
    connVal.classList.toggle('on', how === 'USB 直连');
  }
  paintConn();
  setInterval(paintConn, 5000);

  const lyrOnBox = document.getElementById('lyrOn');
  const lyrBgBox = document.getElementById('lyrBg');
  lyrOnBox.checked = S.lyrOn !== false;
  lyrBgBox.checked = S.coverBg === true;
  lyrOnBox.addEventListener('change', () => {
    S.lyrOn = lyrOnBox.checked; saveS(); applyLyricToggles();
    flash(S.lyrOn ? '滚动歌词：开' : '滚动歌词：关');
  });
  lyrBgBox.addEventListener('change', () => {
    S.coverBg = lyrBgBox.checked; saveS(); applyBgCover();
    flash(S.coverBg ? '封面背景：开' : '封面背景：关');
  });
  document.getElementById('lyrBack').addEventListener('click', () => nudgeLyric(-1));
  document.getElementById('lyrFwd').addEventListener('click', () => nudgeLyric(1));
  document.getElementById('lyrReset').addEventListener('click', () => {
    const before = lyricOffset;
    lyricOffset = 0;
    localStorage.setItem('padtrackLyricOffset', '0');
    paintOffset();
    // 之前只改了变量，当前这首歌要等到下一首才正确，这里立刻拉回来
    if (before && lyricLines.length) {
      lyricBase = Math.max(0, lyricBase - before);
      lyricClock = performance.now();
      paintLyric(true);
    }
    flash('歌词偏移已清零');
  });

  pad.addEventListener('pointerdown', (e) => {
    if (!connected) return;
    collapsePlayer();
    try { pad.setPointerCapture(e.pointerId); } catch (_) {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    hint.style.display = 'none';

    inertia = 0; velY = 0;

    if (pts.size === 1) {
      twoTapPending = false;
      swipe3Pending = false;
      lastCX = e.clientX; lastCY = e.clientY;
      // 只有「时间短 + 位置几乎没变」才算双击的第二下。
      // 以前只看时间，导致点完图标随手一划就被当成拖动。
      const nearLastTap = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) <= DBL_SLOP;
      if (performance.now() - lastTapEnd < DBL_MS && nearLastTap) {
        // 双击的第二下：先不按左键，等手指一动才发 dblstart。
        // dblstart 会先挪 8px 再按下，破坏双击的位置容差，
        // 所以拖的时候标题栏不会被判成双击最大化；
        // 而不移动直接松开，仍然是正常的第二次单击（双击最大化照常）。
        // 先等手指停稳（DBL_STILL），期间抖了就退回普通移动
        mode = 'dblwait';
        dblX = e.clientX; dblY = e.clientY;
        lastCX = e.clientX; lastCY = e.clientY;   // 基准点跟手，别用第一下的旧坐标
        clearTimeout(dblTimer);
        dblTimer = setTimeout(() => {
          if (mode === 'dblwait') mode = 'armed';
        }, DBL_STILL);
        lastTapEnd = 0;
      } else {
        mode = 'pending';
        sx = e.clientX; sy = e.clientY; st = performance.now();
        clearTimeout(lpTimer);
        lpTimer = setTimeout(() => {
          // 只有「手指几乎没动」才算按住拖：再验一次位移，
          // 否则慢慢挪的微操会被误判成拖动（手指下的东西直接被拖走）
          if (mode !== 'pending') return;
          if (Math.hypot(lastCX - sx, lastCY - sy) > 4) return;
          if (S.holdDrag === false) return;
          // 先不按左键：慢点的人本来只想单击，一到 550ms 就按下去了，
          // 之后手稍一偏窗口就飞。改成等真的再移动才按。
          mode = 'holdwait';
          lastCX = sx; lastCY = sy;
        }, HOLD_MS);
      }
    } else if (pts.size === 2) {
      clearTimeout(lpTimer);
      if (mode === 'drag') releaseLeft();
      mode = 'scroll2';
      twoStartT = performance.now(); twoMoved = 0;
      twoTapPending = true; twoTapT = twoStartT;
      swipe3Pending = false;
      lastCX = centX(); lastCY = centY();
      wheelX = wheelY = remWX = remWY = 0;
      pinch = false; zoomAcc = 0; remZoom = 0; pinchRef = null;
      const arr = [...pts.values()];
      d0 = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
      lastDist = d0;
    } else {
      clearTimeout(lpTimer);
      if (mode === 'drag') releaseLeft();
      mode = 'swipe3';
      threeStart = { x: centX(), y: centY(), t: performance.now() };
      sw3dx = sw3dy = 0;
      swipe3Pending = true;
      twoTapPending = false;      // 第三根手指落下，取消双指轻点
    }
    e.preventDefault();
  }, { passive: false });

  function onPointerMove(e) {
    const p = pts.get(e.pointerId);
    if (!p) return;
    evtCount++;
    p.x = e.clientX; p.y = e.clientY;

    if (pts.size === 1) {
      // 3px 就取消长按：给微操留余地，7px 才真正切换到移动
      if (mode === 'pending' && Math.hypot(e.clientX - sx, e.clientY - sy) > 3) {
        clearTimeout(lpTimer);
      }
      if (mode === 'pending' && Math.hypot(e.clientX - sx, e.clientY - sy) > 11) {
        mode = 'move';
        clearTimeout(lpTimer);
        // 用当前点做基准：阈值内那几像素直接丢掉，
        // 否则第一帧会把整段距离一次性发出去，表现为"起步瞬移"
        lastCX = e.clientX; lastCY = e.clientY;
      }
      if (mode === 'dblwait') {
        const dd = Math.hypot(e.clientX - dblX, e.clientY - dblY);
        if (dd > DBL_MOVE) {
          // 第二下按住后一动就开拖：不再要求先停稳 80ms 再判定，
          // 这正是「双击完动一点就拖不动」的根源
          clearTimeout(dblTimer);
          mode = 'drag';
          send({ t: 'dblstart' });
          flash('拖动');
          lastCX = e.clientX; lastCY = e.clientY;
        }
      }
      if (mode === 'holdwait') {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) > HOLD_MOVE) {
          mode = 'drag';
          lastCX = e.clientX; lastCY = e.clientY;
          pressLeft();
          flash('拖动');
        }
      }
      if (mode === 'armed' && Math.hypot(e.clientX - lastCX, e.clientY - lastCY) > DBL_MOVE) {
        mode = 'drag';
        send({ t: 'dblstart' });
        flash('拖动');
      }
      if (mode === 'move' || mode === 'drag') {
        if (twoTapPending && Math.hypot(e.clientX - lastCX, e.clientY - lastCY) > 6) {
          twoTapPending = false;          // 抬掉一根手指后还继续划，就不算轻点了
        }
        accX += e.clientX - lastCX;
        accY += e.clientY - lastCY;
        lastCX = e.clientX; lastCY = e.clientY;
        flushMove(false);                  // 不等下一帧，立刻发
      }
    } else if (pts.size === 2 && mode === 'scroll2') {
      const arr = [...pts.values()];
      const dist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
      const nx = centX(), ny = centY();
      const dx = nx - lastCX, dy = ny - lastCY;
      lastCX = nx; lastCY = ny;
      twoMoved += Math.hypot(dx, dy);
      if (twoMoved > 20) twoTapPending = false;   // 明显在滑，不是轻点

      // 真·捏合的特征：两指间距在短时间内明显变化，而整体重心几乎没动。
      // 滚动时重心会大幅移动、间距基本不变，用这个区分，避免边滚边缩放。
      if (!pinch) {
        const now = performance.now();
        if (!pinchRef || now - pinchRef.t > 140) {
          pinchRef = { t: now, d: dist, x: nx, y: ny };
        } else {
          const dd = Math.abs(dist - pinchRef.d);
          const dc = Math.hypot(nx - pinchRef.x, ny - pinchRef.y);
          if (dd > 22 && dc < dd * 0.85) {
            pinch = true;
            lastDist = dist;
            wheelX = wheelY = 0;
            pinchRef = null;
            flash('缩放');
          }
        }
      }
      if (pinch) {
        zoomAcc += dist - lastDist;
        lastDist = dist;
      } else {
        // 换算成「格」：一指行程 PX_PER_NOTCH 像素算一格滚轮
        wheelX += (dx / PX_PER_NOTCH) * S.speed;
        wheelY += (dy / PX_PER_NOTCH) * S.speed;
      }
    } else if (mode === 'swipe3' && pts.size === 3) {
      const dx = centX() - threeStart.x;
      const dy = centY() - threeStart.y;
      if (Math.abs(dx) > Math.abs(sw3dx)) sw3dx = dx;
      if (Math.abs(dy) > Math.abs(sw3dy)) sw3dy = dy;
    }
  }

  pad.addEventListener('pointermove', (e) => {
    // 两帧之间的所有采样点都拿到（120Hz 触屏在 60Hz 屏幕上会丢样本），
    // 移动和滚动都因此更顺、更跟手。
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (list && list.length > 1) {
      for (const ce of list) onPointerMove(ce);
    } else {
      onPointerMove(e);
    }
    e.preventDefault();
  }, { passive: false });

  function endPointer(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    flushMove(true);                       // 抬手前把剩下的位移发完，别丢尾巴
    const now = performance.now();

    if (pts.size === 0) {
      clearTimeout(lpTimer);
      // 双指轻点：先抬一根手指时 mode 已经变成 move，所以靠标记判断
      const twoTap = twoTapPending && !pinch && now - twoTapT < 380;
      twoTapPending = false;

      if (mode === 'pending') {
        if (now - st < 330 && Math.hypot(e.clientX - sx, e.clientY - sy) < 12) {
          click('l'); lastTapEnd = now; lastTapX = e.clientX; lastTapY = e.clientY;
        }
      } else if (mode === 'holdwait') {
        // 按住了但没移动 → 就是一次普通单击
        clearTimeout(dblTimer);
        click('l');
      } else if (mode === 'armed' || mode === 'dblwait') {
        // 第二下没有移动就松开 = 普通的第二次单击，双击（如标题栏最大化）照常
        clearTimeout(dblTimer);
        click('l');
      } else if (mode === 'drag') {
        releaseLeft();
      } else if (swipe3Pending && threeStart) {
        // 三指必须排在双指前面：第三根手指落下时，双指的标记可能还留着
        const dur = now - threeStart.t;
        const moved = Math.hypot(sw3dx, sw3dy);
        swipe3Pending = false;
        if (moved < 26 && dur < 380) {
          send({ t: 'k', vk: 0x5B });                                  // 三指轻点 = 开始菜单
          flash('开始菜单');
        } else if (Math.abs(sw3dy) > Math.abs(sw3dx) && Math.abs(sw3dy) > 70) {
          if (sw3dy < 0) { send({ t: 'ks', mods: ['win'], vk: 0x09 }); flash('任务视图'); }
          else { send({ t: 'ks', mods: ['win'], vk: 0x44 }); flash('显示桌面'); }
        } else if (Math.abs(sw3dx) > 70) {
          if (sw3dx < 0) { send({ t: 'ks', mods: ['alt'], vk: 0x09 }); flash('下一个窗口'); }
          else { send({ t: 'ks', mods: ['alt', 'shift'], vk: 0x09 }); flash('上一个窗口'); }
        } else {
          flash('三指手势幅度太小');
        }
      } else if (twoTap) {
        click('r');                      // 双指轻点 = 右键
      } else if (mode === 'scroll2') {
        if (!pinch) inertia = velY * 0.55;   // 松手后按原生触控板那样继续滑一段（单位：格）
      }
      mode = Math.abs(inertia) >= 0.2 ? 'inertia' : 'idle';
    } else if (pts.size === 1) {
      // 三指手势还没判定完时不要切到"移动光标"，否则最后一根手指会把光标带跑
      if (!swipe3Pending && (mode === 'scroll2' || mode === 'swipe3')) {
        mode = 'move';
        const p = pts.values().next().value;
        lastCX = p.x; lastCY = p.y;
      }
    }
    e.preventDefault();
  }

  pad.addEventListener('pointerup', endPointer);
  pad.addEventListener('pointercancel', endPointer);

  /* 拦掉安卓原生手势：长按选词、放大镜、右键菜单、拖拽图片。
     光靠 CSS 的 user-select 不够，必须在 touchstart 上 preventDefault。 */
  const killSelection = () => {
    try {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    } catch (_) {}
  };
  ['touchstart', 'touchmove', 'touchend', 'selectstart', 'contextmenu', 'dragstart']
    .forEach((type) => {
      pad.addEventListener(type, (e) => {
        if (e.cancelable) e.preventDefault();
        killSelection();
      }, { passive: false, capture: true });
    });

  /* ---------------- 发送位移 ---------------- */

  // 上次发送位移的时间：限流用（4ms 门限 ≈ 250Hz 上限）
  let lastMoveAt = 0;
  // 诊断：每秒收到多少采样、发出多少移动指令
  let evtCount = 0, msgCount = 0, evtRate = 0, msgRate = 0;
  setInterval(() => { evtRate = evtCount; msgRate = msgCount; evtCount = 0; msgCount = 0; }, 1000);

  /**
   * 把攒下的位移发出去。
   * @param {boolean} force true 时不受 8ms 限流约束（抬手、切模式时用）
   */
  function flushMove(force) {
    if (mode !== 'move' && mode !== 'drag') { accX = 0; accY = 0; return; }
    if (!accX && !accY) return;
    const now = performance.now();
    // 4ms 门限（≈250Hz）：触屏采样率高的时候别让它成为瓶颈
    if (!force && now - lastMoveAt < 4) return;
    lastMoveAt = now;

    let dx = accX, dy = accY;
    accX = 0; accY = 0;
    let f = S.sens;
    const sp0 = Math.hypot(dx, dy);
    if (S.accel) {
      // 单帧位移封顶：WiFi 抖动或掉帧时 delta 会异常大，
      // 不封顶的话加速度会把它再放大一次，看起来就是"突然冲出去"
      const sp = Math.min(sp0, 40);
      f *= 0.62 + Math.min(sp / 26, 1) * 0.9;
    }
    // 拖动时慢速精调：手指慢慢挪（调滑块、选文字）时再压一档，
    // 快拖的时候不动它，保证拉窗口还是利索的
    if (mode === 'drag' && sp0 < 8) f *= 0.8;
    remX += dx * f; remY += dy * f;
    const ix = Math.trunc(remX), iy = Math.trunc(remY);
    if (ix || iy) { remX -= ix; remY -= iy; msgCount++; send({ t: 'm', dx: ix, dy: iy }); }
  }

  /* ---------------- 每帧发送 ---------------- */
  function tick() {
    // 全屏键盘上的滑动：移动光标
    if (kfAccX || kfAccY) {
      kfRemX += kfAccX * S.sens;
      kfRemY += kfAccY * S.sens;
      kfAccX = 0; kfAccY = 0;
      const ix = Math.trunc(kfRemX), iy = Math.trunc(kfRemY);
      if (ix || iy) { kfRemX -= ix; kfRemY -= iy; send({ t: 'm', dx: ix, dy: iy }); }
    }
    // 全屏键盘上的双指：滚动
    if (kfScroll) {
      kfScrollRem += kfScroll;
      kfScroll = 0;
      const ny = Math.trunc(kfScrollRem * STEPS_PER_NOTCH);
      if (ny) {
        kfScrollRem -= ny / STEPS_PER_NOTCH;
        send({ t: 's', dy: WHEEL_STEP * (S.natural ? ny : -ny) });
      }
    }

    flushMove(false);

    if (mode === 'scroll2') {
      if (pinch) {
        remZoom += zoomAcc / PX_PER_NOTCH;
        zoomAcc = 0;
        const nz = Math.trunc(remZoom);
        if (nz) { remZoom -= nz; send({ t: 'zoom', d: WHEEL_NOTCH * nz }); }
        velY = 0;
      } else {
        const ux = wheelX, uy = wheelY;
        wheelX = 0; wheelY = 0;
        // 按 1/8 格的细粒度发送：比整格连续，又比零碎小数在各程序间一致
        if (Math.abs(ux) > Math.abs(uy) * 1.5) {
          remWX += ux;
          const nx = Math.trunc(remWX * STEPS_PER_NOTCH);
          if (nx) {
            remWX -= nx / STEPS_PER_NOTCH;
            send({ t: 's', dx: WHEEL_STEP * (S.natural ? -nx : nx) });
          }
        } else {
          remWY += uy;
          const ny = Math.trunc(remWY * STEPS_PER_NOTCH);
          if (ny) {
            remWY -= ny / STEPS_PER_NOTCH;
            send({ t: 's', dy: WHEEL_STEP * (S.natural ? ny : -ny) });
            velY = ny / STEPS_PER_NOTCH;
          }
        }
      }
    } else if (mode === 'inertia') {
      inertia *= 0.90;
      if (Math.abs(inertia) < 0.02) {
        inertia = 0; mode = 'idle';
      } else {
        remWY += inertia;
        const ny = Math.trunc(remWY * STEPS_PER_NOTCH);
        if (ny) {
          remWY -= ny / STEPS_PER_NOTCH;
          send({ t: 's', dy: WHEEL_STEP * (S.natural ? ny : -ny) });
        }
      }
      wheelX = 0; wheelY = 0;
    } else {
      wheelX = 0; wheelY = 0;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  /* ---------------- 设置 ---------------- */
  const sens = document.getElementById('sens');
  const sensVal = document.getElementById('sensVal');
  const speed = document.getElementById('speed');
  const speedVal = document.getElementById('speedVal');
  const accel = document.getElementById('accel');
  const natural = document.getElementById('natural');
  const absmode = document.getElementById('absmode');

  sens.value = S.sens; sensVal.textContent = S.sens.toFixed(1);
  speed.value = S.speed; speedVal.textContent = S.speed.toFixed(1);
  accel.checked = S.accel; natural.checked = S.natural; absmode.checked = S.abs;

  sens.addEventListener('input', () => {
    S.sens = parseFloat(sens.value);
    sensVal.textContent = S.sens.toFixed(1);
    saveS();
  });
  speed.addEventListener('input', () => {
    S.speed = parseFloat(speed.value);
    speedVal.textContent = S.speed.toFixed(1);
    saveS();
  });
  accel.addEventListener('change', () => { S.accel = accel.checked; saveS(); });
  natural.addEventListener('change', () => { S.natural = natural.checked; saveS(); });
  absmode.addEventListener('change', () => {
    S.abs = absmode.checked; saveS();
    send({ t: 'cfg', abs: S.abs });
  });

  document.getElementById('gear').addEventListener('click', () => {
    collapsePlayer();
    panel.classList.toggle('open');
  });

  document.getElementById('full').addEventListener('click', () => {
    // 让 body 全屏而不是 <html>：全屏元素之外的区域由 ::backdrop 接管，
    // 可以刷成主题色，避免设备在左侧留出黑色安全边
    if (!document.fullscreenElement) document.body.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
    setTimeout(() => { if (document.fullscreenElement) document.body.style.background = '#0d1117'; }, 60);
  });
  // 点触控板空白处关闭设置面板。
  // 这里必须把这一下吃掉：否则 pointerdown 关面板后，
  // 同一个手势还会走完 pad 的点击判定，把一次单击发给电脑。
  pad.addEventListener('pointerdown', (e) => {
    if (!panel.classList.contains('open')) return;
    if (panel.contains(e.target)) return;      // 面板内部的操作不算
    panel.classList.remove('open');
    e.preventDefault();
    e.stopPropagation();
  }, true);

  /* ---------------- 键盘（走电脑输入法） ---------------- */
  const kbPad = document.getElementById('kbPad');
  const kbRawBox = document.getElementById('kbRawBox');
  const kfPadEl = document.getElementById('kfPad');
  const spKeysEl = document.getElementById('spKeys');
  let stickyMods = [];

  // 每个键：{ label, vk, w(宽度权重), cls }
  const K = (label, vk, w, cls) => ({ label, vk, w, cls });
  const TXT = (label, vk, w) => ({ label, vk, w });

  // 退格 / 回车 / 空格用图标，不用中文也不用 ⌫⏎ 这类字符
  // （那些字符在安卓上可能被渲染成彩色 emoji，和界面风格冲突）
  const KEY_ICONS = {
    backspace:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M10 5.5h8.6a1.9 1.9 0 0 1 1.9 1.9v9.2a1.9 1.9 0 0 1-1.9 1.9H10L4.1 12z"/>' +
      '<path d="M13.1 9.6l4.8 4.8M17.9 9.6l-4.8 4.8"/></svg>',
    enter:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M19 4.6v8.1a3 3 0 0 1-3 3H5.4"/>' +
      '<path d="M9.4 11.9 5.4 15.7l4 3.8"/></svg>',
    space:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M5.2 9.6v4.8h13.6V9.6"/></svg>',
  };
  const KI = (icon, vk, w, cls) => ({ icon, vk, w, cls });

  // 完整 104 键布局：和电脑键盘一一对应，哪根手指按哪个键不用重新记
  const LAYER_MAIN = [
    { h: 0.78, keys: [
      K('Esc',0x1B,1.2,'fn'),
      K('F1',0x70,1,'fn gap'),K('F2',0x71,1,'fn'),K('F3',0x72,1,'fn'),K('F4',0x73,1,'fn'),
      K('F5',0x74,1,'fn gap'),K('F6',0x75,1,'fn'),K('F7',0x76,1,'fn'),K('F8',0x77,1,'fn'),
      K('F9',0x78,1,'fn gap'),K('F10',0x79,1,'fn'),K('F11',0x7A,1,'fn'),K('F12',0x7B,1,'fn'),
      K('',0,1.6,'ghost'),
    ] },
    { keys: [
      K('`~',0xC0),K('1!',0x31),K('2@',0x32),K('3#',0x33),K('4$',0x34),
      K('5%',0x35),K('6^',0x36),K('7&',0x37),K('8*',0x38),K('9(',0x39),
      K('0)',0x30),K('-_',0xBD),K('=+',0xBB),KI('backspace',0x08,2.2,'fn'),
    ] },
    { keys: [
      K('Tab',0x09,1.6,'fn'),
      K('Q',0x51),K('W',0x57),K('E',0x45),K('R',0x52),K('T',0x54),
      K('Y',0x59),K('U',0x55),K('I',0x49),K('O',0x4F),K('P',0x50),
      K('[{',0xDB),K(']}',0xDD),K('\\|',0xDC,1.45),
    ] },
    { keys: [
      K('Caps',0x14,1.85,'fn capskey'),
      K('A',0x41),K('S',0x53),K('D',0x44),K('F',0x46,1,'home'),K('G',0x47),
      K('H',0x48),K('J',0x4A,1,'home'),K('K',0x4B),K('L',0x4C),
      K(';:',0xBA),K('"\'',0xDE),KI('enter',0x0D,2.3,'fn'),
    ] },
    { keys: [
      K('Shift',0x10,2.35,'mod shiftl'),
      K('Z',0x5A),K('X',0x58),K('C',0x43),K('V',0x56),K('B',0x42),
      K('N',0x4E),K('M',0x4D),K(',<',0xBC),K('.>',0xBE),K('/?',0xBF),
      K('Shift',0x10,2.35,'mod'),K('↑',0x26,1,'fn'),
    ] },
    { keys: [
      K('Ctrl',0x11,1.35,'mod'),K('Win',0x5B,1.05,'mod'),K('Alt',0x12,1.05,'mod'),
      KI('space',0x20,6.6,'space'),
      K('Alt',0x12,1.05,'mod'),K('Fn',0,1.05,'fn'),K('菜单',0x5D,1.05,'fn'),
      K('Ctrl',0x11,1.35,'mod'),
      K('←',0x25,1,'fn'),K('↓',0x28,1,'fn'),K('→',0x27,1,'fn'),
    ] },
  ];

  const MOD_NAME = { 0x10: 'shift', 0x11: 'ctrl', 0x12: 'alt', 0x5B: 'win' };

  // ---- 左 Shift 双击锁定 ----
  let shiftLock = false;
  let lastShiftTap = 0;

  function paintShiftLock() {
    document.querySelectorAll('.kbkey.shiftl').forEach((b) => {
      b.classList.toggle('locked', shiftLock);
    });
  }

  // ---- Caps 指示灯（由服务端 /keylock 同步）----
  let capsOn = false;
  let capsStamp = 0;          // 最近一次本地切换的时间，用来挡住过期的服务端结果

  function toggleCaps() {
    capsOn = !capsOn;
    capsStamp = performance.now();
    paintCaps();
    if (navigator.vibrate) navigator.vibrate(10);
  }

  function paintCaps() {
    document.querySelectorAll('.kbkey.capskey').forEach((b) => {
      b.classList.toggle('capson', capsOn);
    });
  }

  async function syncKeyLock() {
    try {
      const r = await fetch(`/keylock?k=${encodeURIComponent(KEY)}`, { cache: 'no-store' });
      const d = await r.json();
      // 刚点过的 1.5 秒内不采纳，避免服务端还没反应过来就把灯改回去
      if (typeof d.caps === 'boolean' && d.caps !== capsOn &&
          performance.now() - capsStamp > 1500) {
        capsOn = d.caps;
        paintCaps();
      }
    } catch (_) {}
  }

  function clearSticky() {
    stickyMods = [];
    document.querySelectorAll('.kbkey.on').forEach((el) => el.classList.remove('on'));
  }

  function pressKey(vk, btn) {
    if (!Number.isFinite(vk)) return;      // 别把 NaN 发出去，服务端会当 null 处理
    if (vk === 0) {                        // Fn 在真实键盘上是硬件层，发出去没有意义
      flash('Fn 键无对应功能');
      return;
    }
    // Caps：按下立刻切换指示灯（不等服务端），同时照常发键给电脑
    if (vk === 0x14) toggleCaps();

    // 左 Shift：双击锁定 / 再点解锁
    if (vk === 0x10 && btn && btn.classList.contains('shiftl')) {
      const now = performance.now();
      if (shiftLock) {
        shiftLock = false;
        paintShiftLock();
        flash('Shift 已解锁');
        return;
      }
      if (now - lastShiftTap < 320) {      // 双击 → 锁定
        shiftLock = true;
        lastShiftTap = 0;
        stickyMods = stickyMods.filter((m) => m !== 'shift');
        btn.classList.remove('on');
        paintShiftLock();
        flash('Shift 已锁定：再点一下解锁');
        if (navigator.vibrate) navigator.vibrate(14);
        return;
      }
      lastShiftTap = now;
    }

    // 右 Shift：点一下 = 输入法中英文切换（不进粘滞修饰键列表）
    if (vk === 0x10 && btn && btn.classList.contains('shiftr')) {
      send({ t: 'ime' });
      flash('中 / 英');
      btn.classList.add('hit');
      setTimeout(() => btn.classList.remove('hit'), 110);
      if (navigator.vibrate) navigator.vibrate(10);
      return;
    }

    const modName = MOD_NAME[vk];
    if (modName) {                         // 修饰键：点一下点亮，再点取消
      const idx = stickyMods.indexOf(modName);
      if (idx >= 0) { stickyMods.splice(idx, 1); if (btn) btn.classList.remove('on'); }
      else { stickyMods.push(modName); if (btn) btn.classList.add('on'); }
      return;
    }
    const mods = stickyMods.slice();
    if (shiftLock && !mods.includes('shift')) mods.push('shift');   // 锁定期间每个键都带 Shift
    if (mods.length) {
      send({ t: 'ks', mods, vk });
      clearSticky();
    } else {
      send({ t: 'k', vk });
    }
    if (btn) {
      btn.classList.add('hit');
      setTimeout(() => btn.classList.remove('hit'), 110);
    }
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function renderKeys(container, bindClick) {
    container.innerHTML = '';
    LAYER_MAIN.forEach((row) => {
      const r = document.createElement('div');
      r.className = 'kbrow';
      if (row.h) r.style.flexGrow = String(row.h);
      row.keys.forEach((key) => {
        const b = document.createElement('button');
        b.className = 'kbkey' + (key.cls ? ' ' + key.cls : '');
        if (key.w) b.style.flexGrow = String(key.w);
        if (key.icon) {
          b.className += ' icon';
          b.innerHTML = KEY_ICONS[key.icon] || '';
        } else {
          b.textContent = key.label;
        }
        if (b.classList.contains('capskey')) {
          const led = document.createElement('span');
          led.className = 'capsled';
          b.appendChild(led);
          b.classList.toggle('capson', capsOn);
        }
        // 右 Shift 单独标记：点一下切换输入法中英文
        if (key.vk === 0x10 && b.classList.contains('mod')
            && !b.classList.contains('shiftl')) b.classList.add('shiftr');
        b.dataset.vk = key.vk;
        if (bindClick) b.addEventListener('click', () => pressKey(key.vk, b));
        r.appendChild(b);
      });
      container.appendChild(r);
    });
  }

  // 键区按指针逐个处理：这样两根手指同时按两个键都能触发。
  // 用 click 不行——多点触控时浏览器只会给第一个手指发 click，第二个被丢掉。
  function attachKeyPad(container) {
    const hits = new Map();       // pointerId → { el, x0, y0, moved }
    container.addEventListener('pointerdown', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('.kbkey') : null;
      if (!el || el.dataset.vk === undefined) return;
      try { container.setPointerCapture(e.pointerId); } catch (_) {}
      hits.set(e.pointerId, { el, x0: e.clientX, y0: e.clientY, moved: 0 });
      e.preventDefault();          // 拦掉合成 click，避免一次按键发两条
    }, { passive: false });

    container.addEventListener('pointermove', (e) => {
      const h = hits.get(e.pointerId);
      if (!h) return;
      h.moved = Math.hypot(e.clientX - h.x0, e.clientY - h.y0);
    }, { passive: false });

    const finish = (e) => {
      const h = hits.get(e.pointerId);
      if (!h) return;
      hits.delete(e.pointerId);
      // 手指没怎么动才算按下这个键（划动是触控板手势，不是打字）
      if (h.moved < 14) {
        const vk = parseInt(h.el.dataset.vk, 10);
        if (Number.isFinite(vk)) pressKey(vk, h.el);
      }
    };
    container.addEventListener('pointerup', finish);
    container.addEventListener('pointercancel', (e) => { hits.delete(e.pointerId); });
  }

  function renderAll() {
    renderKeys(kbPad, false);
    // 全屏/分屏键盘不绑 click：由手势层判定「轻点 = 按键」，否则滑动手势会误触
    renderKeys(kfPadEl, false);
    renderKeys(spKeysEl, false);
    attachKeyPad(kbPad);
    attachKeyPad(spKeysEl);
  }

  renderAll();
  paintShiftLock();
  paintCaps();
  syncKeyLock();
  setInterval(syncKeyLock, 3000);

  // ---------------- 记住上次用的键盘形态 ----------------
  const KB_STORE = 'padtrack.kbMode';
  const KB_MODES = ['drawer', 'full', 'split', 'surround'];

  function savedKbMode() {
    let m = null;
    try { m = localStorage.getItem(KB_STORE); } catch (_) {}
    return KB_MODES.includes(m) ? m : 'drawer';
  }

  // 当前开着哪种键盘（没开返回 'pad'）
  function currentKbMode() {
    if (kbfull.classList.contains('open')) return 'full';
    if (splitmode.classList.contains('open')) return 'split';
    if (trmode.classList.contains('open')) return 'surround';
    if (kb.classList.contains('open')) return 'drawer';
    return 'pad';
  }

  document.getElementById('kbBtn').addEventListener('click', () => {
    collapsePlayer();
    if (currentKbMode() !== 'pad') {     // 已经开着 → 收起
      showMode('pad');
      return;
    }
    showMode(savedKbMode());             // 没开 → 打开上次用的键盘
    if (document.activeElement) {
      document.activeElement.blur();     // 不要唤起平板自己的输入法
    }
  });

  document.getElementById('kbCloseBtn').addEventListener('click', () => kb.classList.remove('open'));

  document.getElementById('kbRawBtn').addEventListener('click', (e) => {
    kbRawBox.classList.toggle('open');
    e.target.textContent = kbRawBox.classList.contains('open') ? '收起' : '直接输入';
  });

  /* ---------------- 全屏键盘：轻点按键，滑动当触控板 ---------------- */
  const kbfull = document.getElementById('kbfull');

  const kfCentX = () => { let s = 0; for (const p of kfPts.values()) s += p.x; return kfPts.size ? s / kfPts.size : 0; }
  const kfCentY = () => { let s = 0; for (const p of kfPts.values()) s += p.y; return kfPts.size ? s / kfPts.size : 0; }

  // 每个指头单独的状态：按在哪个键、位移多少、要不要作废
  const kfHit = new Map();
  const kfTapMs = 650;          // 超过这个时长就不算轻点
  const kfMovePx = 12;          // 超过这个位移就当滑动手势
  const kfScrollPx = 16;        // 双指各自纵向移动超过这个才算滚动

  const kfCancelTaps = () => { for (const h of kfHit.values()) h.cancelled = true; };

  kbfull.addEventListener('pointerdown', (e) => {
    // 顶部的模式切换按钮 / 退出按钮交给原生点击，不要被手势层接管
    if (e.target && e.target.closest && e.target.closest('.kfbar')) return;
    try { kbfull.setPointerCapture(e.pointerId); } catch (_) {}
    kfPts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const el = e.target && e.target.closest ? e.target.closest('.kbkey') : null;
    kfHit.set(e.pointerId, {
      el, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY,
      dx: 0, dy: 0, t0: performance.now(), cancelled: false,
      moved: 0,
    });

    if (kfPts.size === 1) {
      kfMode = 'tap';
      kfStartT = performance.now();
      kfMoved = 0;
      kfSX = e.clientX; kfSY = e.clientY;
      kfLastX = kfSX; kfLastY = kfSY;
      kfTapEl = el;
    } else if (kfPts.size === 2) {
      kfMode = 'two';            // 待定：都划是滚动，都不动就是同时按两个键
      kfTapEl = null;
      kfLastX = kfCentX(); kfLastY = kfCentY();
      kfScroll = 0; kfScrollRem = 0;
    } else {
      // 三指：不滚动，改成手势（开始菜单 / 任务视图 / 切窗口）
      kfMode = 'three';
      kfTapEl = null;
      kf3T = performance.now();
      kf3x0 = kfCentX(); kf3y0 = kfCentY();
      kf3dx = 0; kf3dy = 0;
      kfCancelTaps();
    }
    e.preventDefault();
  }, { passive: false });

  function kfMove(e) {
    const p = kfPts.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;

    const h = kfHit.get(e.pointerId);
    if (h) {
      h.dx += e.clientX - h.lx;
      h.dy += e.clientY - h.ly;
      h.lx = e.clientX; h.ly = e.clientY;
      h.moved = Math.hypot(e.clientX - h.x0, e.clientY - h.y0);
    }

    if (kfPts.size === 1) {
      if (kfMode === 'tap' && h && h.moved > kfMovePx) {
        kfMode = 'move';               // 划开了 → 当触控板用，不触发按键
        h.cancelled = true;
        kfTapEl = null;
        kfLastX = e.clientX; kfLastY = e.clientY;
      }
      if (kfMode === 'move') {
        kfAccX += e.clientX - kfLastX;
        kfAccY += e.clientY - kfLastY;
        kfLastX = e.clientX; kfLastY = e.clientY;
      }
    } else if (kfPts.size === 2 && kfMode === 'two') {
      const hits = [...kfHit.values()];
      const vertical = hits.length === 2
        && hits.every((x) => Math.abs(x.dy) > kfScrollPx && Math.abs(x.dy) > Math.abs(x.dx))
        && (hits[0].dy > 0) === (hits[1].dy > 0);
      if (vertical) {
        kfMode = 'scroll';
        kfCancelTaps();
        kfLastX = kfCentX(); kfLastY = kfCentY();
        kfScroll = 0; kfScrollRem = 0;
      }
    } else if (kfPts.size === 2 && kfMode === 'scroll') {
      const cx = kfCentX(), cy = kfCentY();
      kfScroll += ((cy - kfLastY) / PX_PER_NOTCH) * S.speed;
      kfLastX = cx; kfLastY = cy;
    } else if (kfPts.size >= 3 && kfMode === 'three') {
      const dx = kfCentX() - kf3x0;
      const dy = kfCentY() - kf3y0;
      if (Math.abs(dx) > Math.abs(kf3dx)) kf3dx = dx;
      if (Math.abs(dy) > Math.abs(kf3dy)) kf3dy = dy;
    }
  }

  kbfull.addEventListener('pointermove', (e) => {
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (list && list.length > 1) { for (const ce of list) kfMove(ce); }
    else kfMove(e);
    e.preventDefault();
  }, { passive: false });

  function kfUp(e) {
    if (!kfPts.has(e.pointerId)) return;
    const rec = kfHit.get(e.pointerId);
    const wasMode = kfMode;
    kfPts.delete(e.pointerId);
    kfHit.delete(e.pointerId);

    // 轻点：单指、或者两指同时按下各自的键
    if (rec && !rec.cancelled && rec.el && rec.moved < kfMovePx
        && performance.now() - rec.t0 < kfTapMs
        && (wasMode === 'tap' || wasMode === 'two')) {
      const vk = parseInt(rec.el.dataset.vk, 0);
      if (Number.isFinite(vk)) pressKey(vk, rec.el);
    }

    if (kfPts.size === 0) {
      if (wasMode === 'three') {
        const dur = performance.now() - kf3T;
        const moved = Math.hypot(kf3dx, kf3dy);
        if (moved < 26 && dur < 420) {
          send({ t: 'k', vk: 0x5B });                       // 开始菜单
          flash('开始菜单');
        } else if (Math.abs(kf3dy) > Math.abs(kf3dx) && Math.abs(kf3dy) > 60) {
          if (kf3dy < 0) {
            send({ t: 'ks', mods: ['win'], vk: 0x09 });     // 任务视图
            flash('任务视图');
          } else {
            send({ t: 'ks', mods: ['win'], vk: 0x44 });     // 显示桌面
            flash('显示桌面');
          }
        } else if (Math.abs(kf3dx) > 60) {
          if (kf3dx < 0) {
            send({ t: 'ks', mods: ['alt'], vk: 0x09 });     // 下一个窗口
            flash('下一个窗口');
          } else {
            send({ t: 'ks', mods: ['alt', 'shift'], vk: 0x09 });
            flash('上一个窗口');
          }
        }
      }
      kfMode = 'idle';
      kfTapEl = null;
    } else if (kfPts.size === 1 && wasMode === 'two') {
      // 抬起一根，另一根还能正常点自己的键
      kfMode = 'tap';
      const rest = [...kfHit.values()][0];
      kfTapEl = rest ? rest.el : null;
    } else if (kfPts.size === 1 && wasMode === 'scroll') {
      kfMode = 'move';
      const p = kfPts.values().next().value;
      kfLastX = p.x; kfLastY = p.y;
    }
    e.preventDefault();
  }

  kbfull.addEventListener('pointerup', kfUp);
  kbfull.addEventListener('pointercancel', kfUp);

  document.getElementById('kfClose').addEventListener('click', () => showMode('pad'));

  /* 分屏模式 */
  const splitmode = document.getElementById('splitmode');
  document.getElementById('spClose').addEventListener('click', () => showMode('pad'));

  /* 给小触控板用的简化手势（移动 / 轻点左键 / 双指滚动） */
  function attachPadArea(el) {
    const p = new Map();
    let mode = 'idle';
    let sx = 0, sy = 0, st = 0, lx = 0, ly = 0;
    let accX = 0, accY = 0, remX = 0, remY = 0, sc = 0, scRem = 0;
    let twoPend = false, twoT = 0, twoMoved = 0;
    let k3Pend = false, k3T = 0, k3dx = 0, k3dy = 0, k3x0 = 0, k3y0 = 0;
    // 拖动相关（和主触控板同一套参数）
    let lpTimer = 0, dblTimer = 0;
    let dblX = 0, dblY = 0;
    let lastTapEnd = 0, lastTapX = 0, lastTapY = 0;

    const cx = () => { let s = 0; for (const q of p.values()) s += q.x; return p.size ? s / p.size : 0; };
    const cy = () => { let s = 0; for (const q of p.values()) s += q.y; return p.size ? s / p.size : 0; };
    const clearTimers = () => { clearTimeout(lpTimer); clearTimeout(dblTimer); };

    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();          // 不要让事件冒泡到外层键盘手势层，否则光标会动两次
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      p.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (p.size === 1) {
        sx = e.clientX; sy = e.clientY;
        lx = sx; ly = sy; st = performance.now();
        twoPend = false; k3Pend = false;
        accX = 0; accY = 0;

        const nearTap = Math.hypot(sx - lastTapX, sy - lastTapY) <= DBL_SLOP;
        if (performance.now() - lastTapEnd < DBL_MS && nearTap) {
          // 双击的第二下：先不按，等手指一动才开拖
          mode = 'dblwait';
          dblX = sx; dblY = sy;
          clearTimers();
          dblTimer = setTimeout(() => { if (mode === 'dblwait') mode = 'armed'; }, DBL_STILL);
          lastTapEnd = 0;
        } else {
          mode = 'pending';
          clearTimers();
          lpTimer = setTimeout(() => {
            if (mode !== 'pending') return;
            if (Math.hypot(lx - sx, ly - sy) > 4) return;   // 动了就不算长按
            if (S.holdDrag === false) return;
            mode = 'holdwait';
          }, HOLD_MS);
        }
      } else if (p.size === 2) {
        mode = 'scroll';
        clearTimers();
        lx = cx(); ly = cy(); sc = 0; scRem = 0;
        // 双指轻点 = 右键（和主触控板一致）
        twoPend = true; twoT = performance.now(); twoMoved = 0;
        k3Pend = false;
      } else {
        mode = 'swipe3';                    // 三指：轻点=开始菜单，滑动=切窗口/任务视图
        clearTimers();
        k3Pend = true; k3T = performance.now();
        k3x0 = cx(); k3y0 = cy(); k3dx = 0; k3dy = 0;
        twoPend = false;
      }
      e.preventDefault();
    }, { passive: false });

    function onMove(e) {
      const q = p.get(e.pointerId);
      if (!q) return;
      q.x = e.clientX; q.y = e.clientY;

      if (p.size === 1) {
        if (mode === 'pending') {
          if (Math.hypot(e.clientX - sx, e.clientY - sy) > 11) {
            mode = 'move';
            clearTimeout(lpTimer);
            lx = e.clientX; ly = e.clientY;
          }
        } else if (mode === 'holdwait') {
          // 按住够了，再动一点才开始真的拖
          if (Math.hypot(e.clientX - sx, e.clientY - sy) > HOLD_MOVE) {
            mode = 'drag';
            lx = e.clientX; ly = e.clientY;
            pressLeft();
            flash('拖动');
          }
        } else if (mode === 'dblwait') {
          if (Math.hypot(e.clientX - dblX, e.clientY - dblY) > DBL_MOVE) {
            clearTimeout(dblTimer);
            mode = 'drag';
            lx = e.clientX; ly = e.clientY;
            send({ t: 'dblstart' });
            flash('拖动');
          }
        } else if (mode === 'armed') {
          if (Math.hypot(e.clientX - lx, e.clientY - ly) > DBL_MOVE) {
            mode = 'drag';
            lx = e.clientX; ly = e.clientY;
            send({ t: 'dblstart' });
            flash('拖动');
          }
        }

        if (mode === 'move' || mode === 'drag') {
          accX += e.clientX - lx;
          accY += e.clientY - ly;
          lx = e.clientX; ly = e.clientY;
        }
      } else if (mode === 'scroll') {
        const nx = cx(), ny = cy();
        const mdx = nx - lx, mdy = ny - ly;
        sc += (mdy / PX_PER_NOTCH) * S.speed;
        lx = nx; ly = ny;
        // 按「重心移动距离」判断是不是在滑，不能用事件个数：
        // 事件会被合并，滚一大段可能只来几个事件，结果被当成双指轻点 → 松手误弹右键
        twoMoved += Math.hypot(mdx, mdy);
        if (twoMoved > 20) twoPend = false;
      } else if (p.size === 3 && mode === 'swipe3') {
        const dx = cx() - k3x0;
        const dy = cy() - k3y0;
        if (Math.abs(dx) > Math.abs(k3dx)) k3dx = dx;
        if (Math.abs(dy) > Math.abs(k3dy)) k3dy = dy;
      }
    }

    el.addEventListener('pointermove', (e) => {
      e.stopPropagation();
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (list && list.length > 1) { for (const ce of list) onMove(ce); }
      else onMove(e);
      e.preventDefault();
    }, { passive: false });

    function up(e) {
      if (!p.has(e.pointerId)) return;
      e.stopPropagation();
      const wasMode = mode;
      p.delete(e.pointerId);

      if (p.size === 0) {
        const twoTap = twoPend && performance.now() - twoT < 380;
        const three = k3Pend;
        const threeDur = performance.now() - k3T;
        twoPend = false;
        k3Pend = false;
        clearTimers();

        if (three) {
          const moved = Math.hypot(k3dx, k3dy);
          if (moved < 26 && threeDur < 380) {
            send({ t: 'k', vk: 0x5B });
          } else if (Math.abs(k3dy) > Math.abs(k3dx) && Math.abs(k3dy) > 60) {
            if (k3dy < 0) send({ t: 'ks', mods: ['win'], vk: 0x09 });
            else send({ t: 'ks', mods: ['win'], vk: 0x44 });
          } else if (Math.abs(k3dx) > 60) {
            if (k3dx < 0) send({ t: 'ks', mods: ['alt'], vk: 0x09 });
            else send({ t: 'ks', mods: ['alt', 'shift'], vk: 0x09 });
          }
        } else if (twoTap) {
          click('r');
        } else if (wasMode === 'drag') {
          releaseLeft();                      // 拖动结束
        } else if (wasMode === 'pending' || wasMode === 'holdwait'
                   || wasMode === 'armed' || wasMode === 'dblwait') {
          click('l');
          lastTapEnd = performance.now();
          lastTapX = e.clientX; lastTapY = e.clientY;
        }
        mode = 'idle';
      } else if (p.size === 1) {
        if (!k3Pend && wasMode !== 'drag') {
          mode = 'move';
          const q = p.values().next().value;
          lx = q.x; ly = q.y;
        }
      }
      e.preventDefault();
    }

    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    function frame() {
      if (accX || accY) {
        remX += accX * S.sens;
        remY += accY * S.sens;
        accX = 0; accY = 0;
        const ix = Math.trunc(remX), iy = Math.trunc(remY);
        if (ix || iy) { remX -= ix; remY -= iy; send({ t: 'm', dx: ix, dy: iy }); }
      }
      if (sc) {
        scRem += sc;
        sc = 0;
        const ny = Math.trunc(scRem * STEPS_PER_NOTCH);
        if (ny) {
          scRem -= ny / STEPS_PER_NOTCH;
          send({ t: 's', dy: WHEEL_STEP * (S.natural ? ny : -ny) });
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  attachPadArea(document.getElementById('spPad'));

  /* ---------------- 环绕模式：上打字区 / 下触控板 / 两侧功能区 ---------------- */
  const trmode = document.getElementById('trmode');

  const TRIP_TOP = [
    // 第 1 行：`~ 1…0 - = ⌫
    { keys: [
      K('`~',0xC0,1,'fn'),TXT('1!',0x31),TXT('2@',0x32),TXT('3#',0x33),TXT('4$',0x34),
      TXT('5%',0x35),TXT('6^',0x36),TXT('7&',0x37),TXT('8*',0x38),TXT('9(',0x39),
      TXT('0)',0x30),K('- _',0xBD,1,'fn'),K('= +',0xBB,1,'fn'),KI('backspace',0x08,1.7,'fn'),
    ] },
    // 第 2 行：Tab + Q…P + [ ] \
    { keys: [
      K('Tab',0x09,1.45,'fn'),TXT('Q',0x51),TXT('W',0x57),TXT('E',0x45),TXT('R',0x52),
      TXT('T',0x54),TXT('Y',0x59),TXT('U',0x55),TXT('I',0x49),TXT('O',0x4F),
      TXT('P',0x50),K('[{',0xDB,1,'fn'),K(']}',0xDD,1,'fn'),K('\\|',0xDC,1.35,'fn'),
    ] },
    // 第 3 行：Caps + A…L + ; ' + 回车
    { keys: [
      K('Caps',0x14,1.75,'fn capskey'),TXT('A',0x41),TXT('S',0x53),TXT('D',0x44),
      K('F',0x46,1,'home'),TXT('G',0x47),TXT('H',0x48),K('J',0x4A,1,'home'),
      TXT('K',0x4B),TXT('L',0x4C),K(';:',0xBA,1,'fn'),K("'\"",0xDE,1,'fn'),
      KI('enter',0x0D,2,'fn'),
    ] },
    // 第 4 行：Shift + Z…M + , . / + Shift
    { keys: [
      K('Shift',0x10,2.15,'mod shiftl'),TXT('Z',0x5A),TXT('X',0x58),TXT('C',0x43),TXT('V',0x56),
      TXT('B',0x42),TXT('N',0x4E),TXT('M',0x4D),K(',<',0xBC,1,'fn'),K('.>',0xBE,1,'fn'),
      K('/?',0xBF,1,'fn'),K('Shift',0x10,2.15,'mod'),
    ] },
    // 第 5 行：Ctrl Win Alt 空格 Alt Fn 菜单 Ctrl
    { keys: [
      K('Ctrl',0x11,1.35,'mod'),K('Win',0x5B,1.2,'mod'),K('Alt',0x12,1.2,'mod'),
      KI('space',0x20,6.4,'space'),K('Alt',0x12,1.2,'mod'),K('Fn',0xFF,1,'fn'),
      K('菜单',0x5D,1.15,'fn'),K('Ctrl',0x11,1.35,'mod'),
    ] },
  ];

  const TRIP_LEFT = [['Esc',0x1B],['Del',0x2E],['Insert',0x2D]];
  const TRIP_RIGHT = [['←',0x25],['↑',0x26],['↓',0x28],['→',0x27],
                      ['Home',0x24],['End',0x23],['PgUp',0x21],['PgDn',0x22]];

  function buildTri() {
    const top = document.getElementById('trTop');
    top.innerHTML = '';
    TRIP_TOP.forEach((row) => {
      const r = document.createElement('div');
      r.className = 'kbrow' + (row.cls ? ' ' + row.cls : '');
      if (row.h) r.style.flexGrow = String(row.h);
      row.keys.forEach((key) => {
        const b = document.createElement('button');
        b.className = 'kbkey' + (key.cls ? ' ' + key.cls : '');
        if (key.w) b.style.flexGrow = String(key.w);
        if (key.icon) {
          b.className += ' icon';
          b.innerHTML = KEY_ICONS[key.icon] || '';
        } else {
          b.textContent = key.label;
        }
        if (b.classList.contains('capskey')) {
          const led = document.createElement('span');
          led.className = 'capsled';
          b.appendChild(led);
          b.classList.toggle('capson', capsOn);
        }
        b.dataset.vk = key.vk;
        r.appendChild(b);
      });
      top.appendChild(r);
    });

    const mkFunc = (el, list) => {
      el.innerHTML = '';
      list.forEach(([label, vk]) => {
        const b = document.createElement('button');
        b.className = 'kbkey fn';
        b.textContent = label;
        b.dataset.vk = vk;
        el.appendChild(b);
      });
    };
    mkFunc(document.getElementById('trLeft'), TRIP_LEFT);
    mkFunc(document.getElementById('trRight'), TRIP_RIGHT);
  }

  buildTri();

  // 顶部与两侧都走点击；触控板由 attachPadArea 处理
  // 环绕模式：键区走指针逐个处理（trPad 自己的手势层会 stopPropagation，不会打架）
  attachKeyPad(trmode);

  document.getElementById('trClose').addEventListener('click', () => showMode('pad'));

  attachPadArea(document.getElementById('trPad'));

  /* ---------------- 键盘形态切换：每种键盘里都能直接跳转 ---------------- */
  const MODE_LABEL = { pad: '触控板', drawer: '抽屉', full: '全屏', split: '分屏', surround: '环绕' };

  function showMode(name) {
    collapsePlayer();
    kb.classList.remove('open');
    kbfull.classList.remove('open');
    splitmode.classList.remove('open');
    trmode.classList.remove('open');
    if (name === 'drawer') kb.classList.add('open');
    else if (name === 'full') kbfull.classList.add('open');
    else if (name === 'split') splitmode.classList.add('open');
    else if (name === 'surround') trmode.classList.add('open');
    if (KB_MODES.includes(name)) {
      try { localStorage.setItem(KB_STORE, name); } catch (_) {}
    }
    if (name === 'full') setTimeout(() => { try { applySavedNub(); } catch (_) {} }, 60);
    clearSticky();
    document.querySelectorAll('.modebar').forEach((bar) => {
      bar.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b.dataset.mode === name);
      });
    });
    if (document.activeElement) document.activeElement.blur();
  }

  document.querySelectorAll('.modebar').forEach((bar) => {
    Object.keys(MODE_LABEL).forEach((m) => {
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = MODE_LABEL[m];
      b.dataset.mode = m;
      b.addEventListener('click', (e) => { e.stopPropagation(); showMode(m); });
      bar.appendChild(b);
    });
  });

  /* 全屏键盘顶部的触控条：轻点左键 / 双指轻点右键 / 滑动移光标 / 双指滚动 */
  // ---------------- 键盘中间的迷你触控点 ----------------
  const kfNub = document.getElementById('kfNub');

  // 量真实布局：放在 QWERTY 行与 ASDF 行之间的空隙里，横向对准 G 键
  function placeNub() {
    if (!kfNub) return;
    const g = [...document.querySelectorAll('#kfPad .kbkey')]
      .find((k) => k.textContent.trim() === 'G');
    if (!g) return;
    const row = g.parentElement;
    const prev = row.previousElementSibling;
    const gr = g.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const pr = prev ? prev.getBoundingClientRect() : rr;
    const host = kbfull.getBoundingClientRect();
    // 空隙中线 = 上一行底部与本行顶部的中点
    const cy = (pr.bottom + rr.top) / 2;
    // 用固定尺寸算，别量还没渲染完的元素（量到 0 会偏）
    const NW = 38, NH = 38;
    kfNub.style.left = Math.round(gr.left + gr.width / 2 - NW / 2 - host.left) + 'px';
    kfNub.style.top = Math.round(cy - NH / 2 - host.top) + 'px';
  }

  // 位置记忆：拖动过就记住，没拖过就每次按布局算
  const NUB_STORE = 'padtrack.kfNubPos';
  const NUB_SIZE = 46;
  let nubSaved = null;
  try { nubSaved = JSON.parse(localStorage.getItem(NUB_STORE) || 'null'); } catch (_) {}

  // 播放器（灵动岛）在球的上层，球一旦钻进去就点不到了 —— 直接挡在外面
  function islandZone() {
    const isle = document.getElementById('island');
    if (!isle) return null;
    const cs = getComputedStyle(isle);
    if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return null;
    const hr = kbfull.getBoundingClientRect();
    const ir = isle.getBoundingClientRect();
    if (ir.width < 8 || ir.height < 8) return null;
    const pad = 10;
    return {
      x0: ir.left - hr.left - pad, y0: ir.top - hr.top - pad,
      x1: ir.right - hr.left + pad, y1: ir.bottom - hr.top + pad,
    };
  }

  function pushOutOfIsland(left, top) {
    const z = islandZone();
    if (!z) return [left, top];
    const bx1 = left + NUB_SIZE, by1 = top + NUB_SIZE;
    if (bx1 <= z.x0 || left >= z.x1 || by1 <= z.y0 || top >= z.y1) return [left, top];
    // 四个方向里选位移最小的，把球推出禁区
    const cands = [
      [z.x0 - NUB_SIZE, top],
      [z.x1, top],
      [left, z.y0 - NUB_SIZE],
      [left, z.y1],
    ];
    let best = cands[0], bestD = Infinity;
    for (const c of cands) {
      const d = Math.hypot(c[0] - left, c[1] - top);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  function clampNub(left, top) {
    const host = kbfull.getBoundingClientRect();
    const l = Math.max(4, Math.min(host.width - NUB_SIZE - 4, left));
    const t = Math.max(4, Math.min(host.height - NUB_SIZE - 4, top));
    return pushOutOfIsland(l, t);
  }

  function applySavedNub() {
    if (!nubSaved) { placeNub(); return; }
    const [l, t] = clampNub(nubSaved.left, nubSaved.top);
    kfNub.style.left = l + 'px';
    kfNub.style.top = t + 'px';
  }

  // 只有轻点算点击；按住拖动 = 挪球，不触发点击
  let nubDownT = 0, nubStart = null, nubDragging = false;
  kfNub.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    try { kfNub.setPointerCapture(e.pointerId); } catch (_) {}
    nubDownT = performance.now();
    nubDragging = false;
    const host = kbfull.getBoundingClientRect();
    const r = kfNub.getBoundingClientRect();
    nubStart = { x: e.clientX, y: e.clientY, left: r.left - host.left, top: r.top - host.top };
    kfNub.classList.add('down');
  });
  kfNub.addEventListener('pointermove', (e) => {
    if (!nubStart) return;
    e.stopPropagation();
    const dx = e.clientX - nubStart.x;
    const dy = e.clientY - nubStart.y;
    if (!nubDragging && Math.hypot(dx, dy) > 10) {
      nubDragging = true;
      kfNub.classList.add('drag');
    }
    if (nubDragging) {
      const [l, t] = clampNub(nubStart.left + dx, nubStart.top + dy);
      kfNub.style.left = l + 'px';
      kfNub.style.top = t + 'px';
    }
  });
  const nubEnd = (e) => {
    if (!nubStart) return;
    e.stopPropagation();
    const held = performance.now() - nubDownT;
    kfNub.classList.remove('down', 'drag');
    if (nubDragging) {
      // 记住新位置，下次打开还在原处
      nubSaved = { left: parseInt(kfNub.style.left, 10) || 0,
                   top: parseInt(kfNub.style.top, 10) || 0 };
      try { localStorage.setItem(NUB_STORE, JSON.stringify(nubSaved)); } catch (_) {}
    } else if (held < 600) {
      click('l');                      // 轻点 = 左键
      if (navigator.vibrate) navigator.vibrate(8);
    }
    nubStart = null;
    nubDragging = false;
  };
  kfNub.addEventListener('pointerup', nubEnd);
  kfNub.addEventListener('pointercancel', nubEnd);

  applySavedNub();
  window.addEventListener('resize', () => { if (!nubSaved) placeNub(); else applySavedNub(); });
  setTimeout(applySavedNub, 300);

  // 播放器展开 / 收起后重新校验，别让球卡在后面
  const islandEl = document.getElementById('island');
  if (islandEl && window.MutationObserver) {
    let nubT = 0;
    new MutationObserver(() => {
      clearTimeout(nubT);
      nubT = setTimeout(() => {
        if (!kbfull.classList.contains('open')) return;
        const l = parseInt(kfNub.style.left, 10) || 0;
        const t = parseInt(kfNub.style.top, 10) || 0;
        const [nl, nt] = clampNub(l, t);
        if (nl !== l || nt !== t) {
          kfNub.style.left = nl + 'px';
          kfNub.style.top = nt + 'px';
          nubSaved = { left: nl, top: nt };
          try { localStorage.setItem(NUB_STORE, JSON.stringify(nubSaved)); } catch (_) {}
        }
      }, 140);
    }).observe(islandEl, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  attachPadArea(document.getElementById('kfStrip'));
  document.getElementById('kfStrip').textContent = '';
  const stripHint = document.createElement('span');
  stripHint.textContent =
    '触控条 · 单指滑=移光标 · 轻点=左键 · 双指=滚动/右键 · 三指=开始菜单/任务视图/切窗口';
  stripHint.style.cssText = 'pointer-events:none;opacity:.75';
  document.getElementById('kfStrip').appendChild(stripHint);

  // 支持 ?mode=drawer/full/split/surround 直接进入某个形态（可以收藏）
  const initialMode = new URLSearchParams(location.search).get('mode');
  if (initialMode && MODE_LABEL[initialMode]) showMode(initialMode);

  let lastText = '';
  ta.addEventListener('input', (e) => {
    if (e.isComposing) return;              // 输入法还在拼，先别发
    const v = ta.value;
    let i = 0;
    while (i < v.length && i < lastText.length && v[i] === lastText[i]) i++;
    let j = 0;
    while (j < v.length - i && j < lastText.length - i && v[v.length - 1 - j] === lastText[lastText.length - 1 - j]) j++;
    const removed = lastText.length - i - j;
    const inserted = v.slice(i, v.length - j);
    if (removed > 0) send({ t: 'bs', n: removed });
    if (inserted) send({ t: 'txt', s: inserted });
    lastText = v;
  });

  document.getElementById('clearTa').addEventListener('click', () => {
    ta.value = ''; lastText = '';
  });

  // 注意：不要再遍历 [data-vk] 绑 click —— 键盘按键是动态生成的，
  // 那样会和 buildKeys 里的处理叠加，导致一次点击发出两次按键。

  // 兜底：除了手动输入框，任何地方出现选区都立刻清掉。
  // 安卓上只要选区存在，长按就会弹「复制 / 分享 / 全选」那条浮动工具条。
  const clearStraySelection = () => {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const ta = document.getElementById('ta');
    const anchorNode = sel.anchorNode;
    if (ta && anchorNode && (ta === anchorNode || ta.contains(anchorNode))) return;
    try { sel.removeAllRanges(); } catch (_) {}
  };
  document.addEventListener('selectionchange', clearStraySelection);

  // 长按不应弹任何浏览器菜单（安卓 Chrome 对 <img> 会弹「保存图片」）
  // 用捕获阶段，确保在元素自己的处理之前就拦下来
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, { capture: true });
  document.addEventListener('dragstart', (e) => e.preventDefault(), { capture: true });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('selectstart', (e) => {
    // 输入框里要能正常选中文字，其它地方一律不允许
    if (e.target !== ta && !ta.contains(e.target)) e.preventDefault();
  });
})();
