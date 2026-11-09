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
    };
    ws.onclose = () => {
      connected = false;
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
  const DBL_SLOP = 8;                  // 两次点击允许的位置偏差
  const DBL_MS = 300;                  // 两次点击的最大间隔（人手双击一般在 250ms 内）
  const DBL_MOVE = 14;                 // 第二下按下后要真的移动这么远才开拖
  const DBL_STILL = 80;                // 第二下必须先停稳这么久，才允许进入拖拽候选
  const DBL_WOBBLE = 6;                // 停稳期间允许的手抖幅度，超过就当普通移动
  const HOLD_MS = 420;                 // 按住多久算拖动

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
      send({ t: 'k', vk: parseInt(b.dataset.media, 10) });   // 系统媒体键
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
    const a = document.createElement('img');
    const b = document.createElement('img');
    a.alt = '';
    b.alt = '';
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
        x.removeAttribute('src'); y.removeAttribute('src');
        return;
      }
      const back = st.imgs[1 - st.front];
      const swap = () => {
        back.classList.add('on');
        st.imgs[st.front].classList.remove('on');
        st.front = 1 - st.front;
      };
      back.src = want;
      if (back.complete && back.naturalWidth) swap();
      else back.onload = () => { back.onload = null; swap(); };
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
    if (front.getAttribute('src') === bgUrl) { applyBgCover(); return; }

    const swap = () => {
      back.classList.add('on');
      front.classList.remove('on');
      bgFront = 1 - bgFront;
      applyBgCover();
    };
    back.src = bgUrl;
    if (back.complete && back.naturalWidth) swap();
    else back.onload = () => { back.onload = null; swap(); };
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
        musicCover.removeAttribute('src');
        musicCoverBig.removeAttribute('src');
        setBgCover('');
        return;
      }

      island.classList.add('on');
      musicTitle.textContent = d.title;
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
        if (musicCover.getAttribute('src') !== coverUrl) {
          musicCover.src = coverUrl;
          musicCoverBig.src = coverUrl;
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
          mode = 'drag';
          lastCX = sx; lastCY = sy;      // 拖动的起点就是按下点
          pressLeft();
          flash('拖动');
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
      if (mode === 'pending' && Math.hypot(e.clientX - sx, e.clientY - sy) > 7) {
        mode = 'move';
        clearTimeout(lpTimer);
        // 用当前点做基准：阈值内那几像素直接丢掉，
        // 否则第一帧会把整段距离一次性发出去，表现为"起步瞬移"
        lastCX = e.clientX; lastCY = e.clientY;
      }
      if (mode === 'dblwait' && Math.hypot(e.clientX - dblX, e.clientY - dblY) > DBL_WOBBLE) {
        // 第二下还没停稳就滑走了：不是双击拖，按普通移动处理（光标继续跟手）
        clearTimeout(dblTimer);
        mode = 'move';
        lastCX = e.clientX; lastCY = e.clientY;
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
        b.dataset.vk = key.vk;
        if (bindClick) b.addEventListener('click', () => pressKey(key.vk, b));
        r.appendChild(b);
      });
      container.appendChild(r);
    });
  }

  function renderAll() {
    renderKeys(kbPad, true);
    // 全屏/分屏键盘不绑 click：由手势层判定「轻点 = 按键」，否则滑动手势会误触
    renderKeys(kfPadEl, false);
    renderKeys(spKeysEl, true);
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

  const kfCentX = () => { let s = 0; for (const p of kfPts.values()) s += p.x; return kfPts.size ? s / kfPts.size : 0; };
  const kfCentY = () => { let s = 0; for (const p of kfPts.values()) s += p.y; return kfPts.size ? s / kfPts.size : 0; };

  kbfull.addEventListener('pointerdown', (e) => {
    // 顶部的模式切换按钮 / 退出按钮交给原生点击，不要被手势层接管
    if (e.target && e.target.closest && e.target.closest('.kfbar')) return;
    try { kbfull.setPointerCapture(e.pointerId); } catch (_) {}
    kfPts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (kfPts.size === 1) {
      kfMode = 'tap';
      kfStartT = performance.now();
      kfMoved = 0;
      kfSX = e.clientX; kfSY = e.clientY;
      kfLastX = kfSX; kfLastY = kfSY;
      kfTapEl = e.target && e.target.closest ? e.target.closest('.kbkey') : null;
    } else if (kfPts.size === 2) {
      kfMode = 'scroll';
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
    }
    e.preventDefault();
  }, { passive: false });

  function kfMove(e) {
    const p = kfPts.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;

    if (kfPts.size === 1) {
      if (kfMode === 'tap') {
        kfMoved = Math.hypot(e.clientX - kfSX, e.clientY - kfSY);
        if (kfMoved > 12) {          // 划开了 → 当触控板用，不触发按键
          kfMode = 'move';
          kfTapEl = null;
          kfLastX = e.clientX; kfLastY = e.clientY;
        }
      }
      if (kfMode === 'move') {
        kfAccX += e.clientX - kfLastX;
        kfAccY += e.clientY - kfLastY;
        kfLastX = e.clientX; kfLastY = e.clientY;
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
    kfPts.delete(e.pointerId);

    if (kfPts.size === 0) {
      if (kfMode === 'three') {
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
      } else if (kfMode === 'tap' && kfTapEl && performance.now() - kfStartT < 600) {
        pressKey(parseInt(kfTapEl.dataset.vk, 0), kfTapEl);
      }
      kfMode = 'idle';
      kfTapEl = null;
    } else if (kfPts.size === 1 && kfMode === 'scroll') {
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

    const cx = () => { let s = 0; for (const q of p.values()) s += q.x; return p.size ? s / p.size : 0; };
    const cy = () => { let s = 0; for (const q of p.values()) s += q.y; return p.size ? s / p.size : 0; };

    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();          // 不要让事件冒泡到外层键盘手势层，否则光标会动两次
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      p.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (p.size === 1) {
        mode = 'pending';
        sx = e.clientX; sy = e.clientY;
        lx = sx; ly = sy; st = performance.now();
        twoPend = false; k3Pend = false;
      } else if (p.size === 2) {
        mode = 'scroll';
        lx = cx(); ly = cy(); sc = 0; scRem = 0;
        // 双指轻点 = 右键（和主触控板一致）
        twoPend = true; twoT = performance.now(); twoMoved = 0;
        k3Pend = false;
      } else {
        mode = 'swipe3';                    // 三指：轻点=开始菜单，滑动=切窗口/任务视图
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
        if (mode === 'pending' && Math.hypot(e.clientX - sx, e.clientY - sy) > 7) {
          mode = 'move';
          lx = e.clientX; ly = e.clientY;
        }
        if (mode === 'move') {
          accX += e.clientX - lx;
          accY += e.clientY - ly;
          lx = e.clientX; ly = e.clientY;
        }
      } else if (mode === 'scroll') {
        const ny = cy();
        sc += ((ny - ly) / PX_PER_NOTCH) * S.speed;
        lx = cx(); ly = ny;
        twoMoved += 1;
        if (twoMoved > 12) twoPend = false;
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
      p.delete(e.pointerId);
      if (p.size === 0) {
        const twoTap = twoPend && performance.now() - twoT < 380;
        const three = k3Pend;
        const threeDur = performance.now() - k3T;
        twoPend = false;
        k3Pend = false;

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
        } else if (mode === 'pending' && performance.now() - st < 320) {
          click('l');
        }
        mode = 'idle';
      } else if (p.size === 1) {
        if (!k3Pend) {
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
  trmode.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('.kbkey') : null;
    if (!b || b.dataset.vk === undefined) return;
    const vk = parseInt(b.dataset.vk, 10);
    if (Number.isFinite(vk)) pressKey(vk, b);
  });

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
