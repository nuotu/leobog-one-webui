// protocol.js —— LEOBOG Hi8/Hi8SE 传输层与协议（Phase 2：读 + 写 + 读回校验）
// 有线：Feature rid6 帧（协议规范 §1–3）；无线：dongle rid19 邮箱（§7）。
// 写操作走白名单（仅实测过的命令字）；每个写 API 默认写后读回逐字节比对。
'use strict';

window.Leobog = (function () {
  const RID = 6;            // 有线 Feature ReportID
  const WL_RID = 0x13;      // 无线 output/input ReportID（19 字节）
  const FILTERS = [
    { vendorId: 0x258a, productId: 0x010c },   // 有线
    { vendorId: 0x3554, productId: 0xfa09 },   // 2.4G dongle
  ];

  const state = { dev: null, channel: null, log: () => {}, onUnsolicited: null };
  let _wlKmP0 = null;

  // 设备身份：按**对象**而不是 VID/PID（LEOBOG 全系有线都是 258a:010c、2.4G 都是 3554:fa09，
  // 两台不同型号的键盘在 VID/PID 上完全一样）。WeakMap 给每个句柄发一次号；拔插换新对象=新号。
  const _devIds = new WeakMap();
  let _devSeq = 0;
  function devKey(d) {
    if (!d) return '';
    if (!_devIds.has(d)) _devIds.set(d, ++_devSeq);
    return `${d.vendorId}:${d.productId}#${_devIds.get(d)}`;
  }

  // ── 小工具 ────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hex = (a, sep = ' ') =>
    Array.from(a, b => (b & 0xff).toString(16).padStart(2, '0')).join(sep);
  const hex16 = n => '0x' + (n & 0xffff).toString(16).padStart(4, '0');
  const log = (m, c) => state.log(m, c);
  function wlChecksumValid(b) {
    if (!b || b.length < 19) return false;
    let sum = WL_RID;
    for (let i = 0; i < 18; i++) sum += b[i];
    return (sum & 0xff) === b[18];
  }

  // 配置事务必须串行：写入 + 读回校验是一个不可交错的整体。
  // 内部函数互相调用原始实现，只有导出的 API 入队，避免嵌套死锁。
  let ioTail = Promise.resolve();
  let ioPending = 0;
  function enqueueIo(fn) {
    ioPending++;
    const run = ioTail.then(fn, fn);
    ioTail = run.catch(() => {}).finally(() => { ioPending--; });
    return run;
  }
  const queued = fn => (...args) => enqueueIo(() => fn(...args));

  function* walk(cols, path = '') {
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const p = path ? path + '.' + i : String(i);
      yield [p, c];
      if (c.collections) yield* walk(c.collections, p);
    }
  }

  const reportBits = r =>
    (r.items || []).reduce((s, it) => s + (it.reportCount || 0) * (it.reportSize || 0), 0);

  // ── 写白名单：只放行抓包实测过的写命令（协议规范 §4/§7.3c）──────
  // 0x08 = 音乐律动流（只推不存，官方实测 112帧/场 @~21Hz）；灯效参数块(0a/09)=Phase3后续。
  const WRITABLE = {
    wired:    new Set([0x03, 0x04, 0x05, 0x06, 0x08, 0x0a]),   // 键表/设置/宏/色帧/音乐流/灯效参数块
    wireless: new Set([0x01, 0x02, 0x03, 0x04, 0x09]),         // 键表/色帧/宏/设置/灯效参数块
  };

  // 灯效参数块出厂常量（官方恢复出厂必推；源=hid_p4.log 有线0x0a写入，3次逐字节相同；
  // 512B，色带数据+尾部5A A5@506 —— §5.6 纯常量块）
  const LED_PARAM = Uint8Array.from((
    '000000000000000000000000000000000000000000ffffff00ff000000ffffff00ff00ff' +
    '00ffffffffffff000000ff000000ffffff00ff00ff00ffffffffffff000000ff000000ff' +
    'ffff00ff00ff00ffffffffffff000000ff000000ffffff00ff00ff00ffffffffffff0000' +
    '00ff000000ffffff00ff00ff00ffffffffffff000000ff000000ffffff00ff00ff00ffff' +
    'ffffffff000000ff000000ffffff00ff00ff00ffffffffffff000000ff000000ffffff00' +
    'ff00ff00ffffffffffff000000ff000000ffffff00ff00ff00ffffffffffff000000ff00' +
    '0000ffffff00ff00ff00ffffffffffff000000ff000000ffffff00ff00ff00ffffffffff' +
    'ff000000ff000000ffffff00ff00ff00ffffffffffff000000ff000000ffffff00ff00ff' +
    '00ffffffffffff000000ff000000ffffff00ff00ff00ffffffffffff000000ff000000ff' +
    'ffff00ff00ff00ffffffffffff000000ff000000ffffff00ff00ff00ffffffffffff0000' +
    '00ff000000ffffff00ff00ff00ffffffffffff000000ff000000ffffff00ff00ff00ffff' +
    'ffffffff000000ff000000ffffff00ff00ff00ffffffffff000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000' +
    '00005aa500000000').match(/../g).map(h => parseInt(h, 16)));
  function assertWritable(cmd) {
    const set = WRITABLE[state.channel];
    if (!set || !set.has(cmd))
      throw new Error(`写命令 ${hex16(cmd)} 不在 ${state.channel || '未连接'} 白名单，拒绝发送`);
  }

  // 返回前16个差异下标 + 总差异数 + 前8对(写入值→读回值)（读回校验用）
  function diffStats(a, b, n) {
    const idxs = []; const pairs = []; let count = 0;
    const lim = Math.min(n, a.length, b.length);
    for (let i = 0; i < lim; i++) if (a[i] !== b[i]) {
      count++;
      if (idxs.length < 16) idxs.push(i);
      if (pairs.length < 8) pairs.push(`@${i}:${(a[i] & 0xff).toString(16)}→${(b[i] & 0xff).toString(16)}`);
    }
    const expected = Math.min(n, a.length);
    for (let i = lim; i < expected; i++) {
      count++;
      if (idxs.length < 16) idxs.push(i);
      if (pairs.length < 8) pairs.push(`@${i}:${(a[i] & 0xff).toString(16)}→缺`);
    }
    return { count, idxs, pairs };
  }

  // ── 连接 ──────────────────────────────────────────────────
  function classify(dev) {
    let wired = false, wireless = false;
    for (const [, c] of walk(dev.collections)) {
      for (const r of c.featureReports || []) {
        if (r.reportId === 6 && reportBits(r) / 8 >= 128) wired = true;   // 519B 才是配置通道
      }
      const out = (c.outputReports || []).some(r => r.reportId === WL_RID);
      const inp = (c.inputReports  || []).some(r => r.reportId === WL_RID);
      if (out && inp) wireless = true;
    }
    return wired ? 'wired' : wireless ? 'wireless' : null;
  }

  // 从候选里选一台可用设备（有线优先；要求 classify 出通道）
  function pickDevice(devs) {
    const list = devs.slice().sort(
      (a, b) => (classify(a) === 'wired' ? -1 : 0) - (classify(b) === 'wired' ? -1 : 0));
    for (const d of list) {
      const ch = classify(d);
      if (ch) return { dev: d, ch };
    }
    return null;
  }

  async function attach(dev, ch, opts = {}) {
    if (state.dev === dev && dev.opened) {           // 已附着同一设备 → 幂等，不再重挂/重打日志
      return { channel: ch, vendorId: dev.vendorId, productId: dev.productId, productName: dev.productName };
    }
    if (state.dev && state.dev !== dev) {
      try { state.dev.removeEventListener('inputreport', standingInput); } catch (e) {}
      if (state.dev.opened) { try { await state.dev.close(); } catch (e) {} }
      state.dev = null;                              // 切换窗口置空，防旧句柄误用
    }
    state.dev = dev;
    state.channel = ch;
    if (!dev.opened) await dev.open();
    dev.addEventListener('inputreport', standingInput);   // 常驻监听：dongle 主动上报（休眠/唤醒事件）
    if (!opts.quiet)                                  // 选择页轮换探测用 quiet：别每 1.5s 刷一条"已连接"
      log(`已连接：${dev.productName} · 通道=${ch === 'wired' ? '有线 Feature' : '无线 rid19 邮箱'}`, 'ok');
    return {
      channel: ch,
      vendorId: dev.vendorId, productId: dev.productId,
      productName: dev.productName,
    };
  }

  // 常驻监听：dongle 主动上报 = 官方同款事件源（实测休眠瞬间必推 13 00…全零帧）
  // 300ms 防抖聚簇；操作期回显也会触发，由应用层按忙闲状态决定是否核验
  // 常驻监听：只认 dongle 的休眠/状态推送（cmd=0x00，全零帧——官方抓包实证）。
  // 自己查询的回包（cmd=0x4a 等）绝不能当推送，否则"探测→回包→再探测"死循环刷屏。
  // 已知的"自己查询/写入的回包"命令集——这些绝不算主动推送
  const KNOWN_OPS = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x07, 0x09,
                             0x41, 0x42, 0x43, 0x44, 0x49, 0x4a, 0x88]);   // 0x49 = 灯效块读回包（2026-11-01）
  // 实测推送形态：cmd=0x0a len=19（休眠/唤醒/连接时均推，日志 2026-10-25 19:53/19:54/19:56）；
  // 早期抓包另有 cmd=0x00 全零形态——两者都当推送。0x0a 若是刚发出的 0x07/0x05 查询应答则忽略。
  function standingInput(e) {
    if (!e || e.reportId !== WL_RID) return;
    const b = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const cmd = b.length ? b[0] : -1;
    if (cmd !== 0x00 && cmd !== 0x0a) {
      if (cmd >= 0 && !KNOWN_OPS.has(cmd)) {          // 未知命令限速打日志（诊断用）
        const now0 = Date.now();
        if (now0 - (standingInput._unkLog || 0) > 2000) {
          standingInput._unkLog = now0;
          log(`[dongle] 收到未知输入帧 cmd=0x${cmd.toString(16).padStart(2, '0')} len=${b.length}`, 'warn');
        }
      }
      return;                                        // 自己查询/写入的回包不算推送
    }
    let status = null;                               // 'sleep' | 'wake' | null(未知)
    if (cmd === 0x0a) {
      if (Date.now() - (state.lastPsdQ || 0) < 1500) return;   // PSD 查询应答
      if (b.length >= 19) {                          // 校验和验证 + 状态位解码
        let sum = WL_RID;
        for (let i = 0; i < 18; i++) sum += b[i];
        if ((sum & 0xff) !== b[18]) {
          const nowX = Date.now();
          if (nowX - (standingInput._unkLog || 0) > 2000) {
            standingInput._unkLog = nowX;
            log(`[dongle] 状态推送校验和不符，忽略: ${hex(b)}`, 'warn');
          }
          return;
        }
        // 实测：byte5=0 休眠 / 1 唤醒。但 2026-11-01 无线日志里"写设置块后 1s"推的是
        // 0a 01 00 04 07 00…（byte4=0x07，文档恒量应为 0x02），设备随即仍在线可读——
        // 那是写入/状态通知，不是休眠。byte4≠0x02 → 只当未知状态，交 probeKeyboard 核验。
        status = b[4] === 0x02
          ? (b[5] === 0x00 ? 'sleep' : (b[5] === 0x01 ? 'wake' : null))
          : null;
      }
    }
    // 3 秒节流只挡"未知/回显形态"防误触发变轮询；
    // sleep/wake 明确状态必须绕过——否则 3 秒内 sleep→wake 第二帧被丢，后台恢复链就断了（实证隐患）。
    if (status !== 'sleep' && status !== 'wake') {
      const now = Date.now();
      if (now - (standingInput._last || 0) < 3000) return;
      standingInput._last = now;
    }
    log(`[dongle] 状态推送${status ? `（${status === 'sleep' ? '休眠' : '唤醒'}）` : ''}: ${hex(b)}`, 'warn');
    if (state.onUnsolicited) { try { state.onUnsolicited(status); } catch (e2) {} }
  }

  // 将指定设备设为当前会话（选择页卡片点击 / 发现探测 / 断连恢复附着）
  async function selectDevice(dev, opts = {}) {
    const ch = classify(dev);
    if (!ch) throw new Error('此设备不受支持');
    if (state.dev && state.dev !== dev) {
      try { state.dev.removeEventListener('inputreport', standingInput); } catch (e) {}
      if (state.dev.opened) { try { await state.dev.close(); } catch (e) {} }
      state.dev = null; state.channel = null;
    }
    return attach(dev, ch, opts);
  }

  async function connect() {
    if (!('hid' in navigator)) throw new Error('浏览器不支持 WebHID');
    const devs = await navigator.hid.requestDevice({ filters: FILTERS });
    if (!devs || !devs.length) throw new Error('未选择设备');
    const picked = pickDevice(devs);
    if (!picked) throw new Error('所选设备无可用配置通道');
    return attach(picked.dev, picked.ch);
  }

  // 复用已授权设备（getDevices，不弹选择框）——「重新读取」/断连恢复用
  // 已授权设备列表（不弹选择器；用于打开页面自动查找）
  async function knownDevices() {
    if (!('hid' in navigator)) return [];
    const all = await navigator.hid.getDevices();
    return all.filter(d => FILTERS.some(f =>
      (!f.vendorId || d.vendorId === f.vendorId) && (!f.productId || d.productId === f.productId)));
  }

  async function connectExisting() {
    if (!('hid' in navigator)) throw new Error('浏览器不支持 WebHID');
    const all = await navigator.hid.getDevices();
    const devs = all.filter(d => FILTERS.some(f =>
      (!f.vendorId || d.vendorId === f.vendorId) && (!f.productId || d.productId === f.productId)));
    const picked = pickDevice(devs);
    if (!picked) throw new Error('无已授权设备——请先点「连接键盘」授权一次');
    return attach(picked.dev, picked.ch);
  }

  async function disconnect() {
    if (state.dev) { try { state.dev.removeEventListener('inputreport', standingInput); } catch (e) {} }
    if (state.dev && state.dev.opened) { try { await state.dev.close(); } catch (e) {} }
    state.dev = null; state.channel = null;
  }

  // ── 有线：Feature rid6 帧读（回显校验 + 尾零补齐）───────────
  function frameW(cmd, addr, len, data) {
    const b = new Uint8Array(519);
    b[0] = cmd; b[1] = addr & 0xff; b[2] = (addr >> 8) & 0xff;
    b[3] = 0x01; b[4] = 0x00;
    b[5] = len & 0xff; b[6] = (len >> 8) & 0xff;
    if (data) b.set(data, 7);
    return b;
  }

  async function wiredRead(cmd, addr, len, retries = 12) {
    const dev = state.dev;
    if (!dev.opened) await dev.open();
    const req = frameW(cmd, addr, len);
    let raw = null, ho = 0, echoCmd, echoAddr, echoLen, matched = false;
    const cmdLo = cmd & 0x7f;                     // 部分读命令回显会清 bit7（实测 0x83 疑似）
    for (let a = 1; a <= retries; a++) {
      if (a > 1) await sleep(a > 1 ? 250 : 100);  // 超时类失败给固件更长喘息
      try {
        await dev.sendFeatureReport(RID, req);
        const dv = await dev.receiveFeatureReport(RID);
        raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      } catch (e) {
        // 固件 flash 提交/瞬时停摆 → 单次失败不致命，重试
        if (a === retries) throw new Error(`读回超时×${retries}：${e.message}（可点「重新读取」或重插设备）`);
        log(`[有线] 读 cmd=${hex16(cmd)} 第${a}次失败（${e.message}），重试`, 'warn');
        continue;
      }
      ho = raw[0] === RID ? 1 : 0;
      if (raw.length < ho + 7) {
        if (a === retries) throw new Error(`有线读回包过短：${raw.length}B（至少需要 ${ho + 7}B 头部）`);
        log(`[有线] 读 cmd=${hex16(cmd)} 第${a}次回包过短 ${raw.length}B，重试`, 'warn');
        continue;
      }
      echoCmd = raw[ho];
      echoAddr = raw[ho + 1] | (raw[ho + 2] << 8);
      echoLen = raw[ho + 5] | (raw[ho + 6] << 8);
      if ((echoCmd === cmd || echoCmd === cmdLo) && echoAddr === addr && echoLen === len) { matched = true; break; }
      if (a === retries) {
        throw new Error(`有线读回显不匹配 cmd=${hex16(echoCmd)} addr=${echoAddr} len=${echoLen}` +
          ` 头部=${hex(raw.slice(0, 14))}`);
      }
    }
    if (!matched) throw new Error(`有线读未获得匹配回包 cmd=${hex16(cmd)} addr=${addr} len=${len}`);
    let payload = raw.slice(ho + 7);
    if (payload.length < echoLen) {                 // 浏览器裁尾零 → 按回显 len 补
      const p = new Uint8Array(echoLen);
      p.set(payload); payload = p;
    }
    log(`[有线] 读 cmd=${hex16(cmd)} addr=${addr} len=${len} → ${payload.length}B`);
    return payload;
  }

  // ── 无线：rid19 邮箱（§7.2 帧 + 分片读）────────────────────
  function wlFrame(cmd, block, chunk, payload, lenField) {
    const b = new Uint8Array(19);
    b[0] = cmd; b[1] = block; b[2] = chunk;
    const p = payload || new Uint8Array(0);
    b[3] = (lenField !== undefined && lenField !== null) ? lenField : Math.min(p.length, 14);
    b.set(p.subarray(0, 14), 4);
    let sum = WL_RID;
    for (let i = 0; i < 18; i++) sum += b[i];
    b[18] = sum & 0xff;
    return b;
  }

  async function wlRead(cmd, block, timeoutMs = 2500, opts = {}) {
    const dev = state.dev;
    if (!dev) throw new Error('设备已断开');
    if (!dev.opened) await dev.open();
    let chunks = {}, lastAt = 0, frames = 0, mergeMode = false;
    let thisFrames = 0;                               // 本轮（attempt）收到的帧数
    const onRep = e => {
      if (e.reportId !== WL_RID) return;
      const b = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      if (b.length < 19 || b[0] !== cmd || !wlChecksumValid(b)) {
        if (b.length >= 4 && b[0] === cmd && opts.stats)
          opts.stats.badChecksum = (opts.stats.badChecksum || 0) + 1;
        return;
      }
      if (mergeMode && (b[2] in chunks)) return;      // 补拉模式：只收缺失片
      const slice = b.slice(4, 4 + Math.min(b[3] & 0x0f, 14));
      chunks[b[2]] = slice;
      lastAt = Date.now(); frames++; thisFrames++;
    };
    // 完整判定：收到 expect 时——无空洞且最大片 ≥ 阈值；键表尾片(tailOptional)结构性常丢，阈值退到 expect-2
    const complete = () => {
      const ix = Object.keys(chunks).map(Number);
      if (!ix.length) return false;
      if (!opts.expect) return false;                 // 无 expect → 短尾 terminator / timeout 兜底
      const upTo = (opts.tailOptional ? opts.expect - 2 : opts.expect - 1);
      const mx = Math.max(...ix);
      if (mx < upTo) return false;
      for (let i = 0; i <= mx; i++) if (!(i in chunks)) return false;
      return true;
    };
    const attempt = async (merge, tmo = timeoutMs) => {
      mergeMode = !!merge;
      if (!merge) { chunks = {}; lastAt = 0; frames = 0; }
      thisFrames = 0;                                    // 本轮自己的计数（补拉轮的旧帧不能当终止依据）
      dev.addEventListener('inputreport', onRep);
      try {
        const req = opts.frame || wlFrame(cmd, block,
          opts.chunk !== undefined ? opts.chunk : 0,
          opts.payload !== undefined ? new Uint8Array([opts.payload & 0xff]) : null,
          opts.lenField);
        if (opts.firstAttempt !== false && !opts.quiet) {
          log(`[无线] 读 cmd=${hex16(cmd)}` +
              (opts.frame ? ` 自定义帧 ${hex(req.slice(0, 8))}` :
                ` block=${hex16(block)}` +
                (opts.chunk ? ` chunk=${opts.chunk}` : '') +
                (opts.lenField ? ` lenField=${opts.lenField}` : '')));
        }
        await dev.sendReport(WL_RID, req);
        const t0 = Date.now();
        while (Date.now() - t0 < tmo) {
          await sleep(80);
          if (complete()) break;                      // 无空洞且到阈值（键表 35 片即齐）
          // dongle 按整块突发回流；本轮收到过帧且静默 300ms 即视为本批结束，
          // 立即进入缺片补拉，不再为已知空洞等满 1.8~3s。只看本轮 lastAt，避免旧尾片骗停。
          if (thisFrames && Date.now() - lastAt > 300) break;
        }
      } finally {
        dev.removeEventListener('inputreport', onRep);
      }
    };
    // 空洞检测：中间丢片也算不完整（只补一轮，只收缺失片）
    const gapsNow = () => {
      const ix = Object.keys(chunks).map(Number);
      if (!ix.length) return [];
      const mx = Math.max(...ix); const g = [];
      for (let i = 0; i <= mx; i++) if (!(i in chunks)) g.push(i);
      return g;
    };
    const maxTries = opts.noRetry ? 1 : Math.max(2, opts.retries || 2);   // 总尝试次数（含首轮）
    await attempt(false);
    for (let t = 2; t <= maxTries; t++) {
      if (complete() && !gapsNow().length) break;
      const ix = Object.keys(chunks).map(Number);
      let merge = true;
      if (!ix.length) {
        if (!opts.quiet) log(`[无线] 读 cmd=${hex16(cmd)} 首次无回流，重试一次`, 'warn');
        await sleep(300);
        merge = false;
      } else {
        const missing = gapsNow();
        if (!opts.quiet) log(`[无线] 读片不完整（缺 ${missing.join(',') || '尾片/阈值不足'}）→ 250ms 后补拉合并` +
          (t > 2 ? `（第 ${t - 1} 次补拉）` : ''), 'warn');
        await sleep(250);
      }
      opts.firstAttempt = false;
      await attempt(merge, Math.min(timeoutMs, 1500));  // 补拉轮用短窗口：设备整块重发通常 <1s
    }
    const idxs = Object.keys(chunks).map(Number).sort((a, b) => a - b);
    if (!idxs.length) throw new Error(`无线读无回流 cmd=${hex16(cmd)}`);
    const maxIdx = idxs[idxs.length - 1];
    const gaps = [];
    for (let i = 0; i <= maxIdx; i++) if (!(i in chunks)) gaps.push(i);
    if (gaps.length && !opts.quiet) log(`[无线] 缺片：${gaps.join(',')}（RF 丢帧）`, 'warn');
    const data = new Uint8Array((maxIdx + 1) * 14);
    let got = 0;
    for (const i of idxs) { data.set(chunks[i], i * 14); got += chunks[i].length; }
    if (!opts.quiet) log(`[无线] 读 → ${frames} 帧 / ${got}B`);
    // strict：固定长度的块（设置/色帧/宏）宁可报错也不把带洞的截断数据交给上层
    if (opts.strict && (gaps.length || (opts.minBytes && got < opts.minBytes)))
      throw new Error(`无线读不完整 cmd=${hex16(cmd)}：${got}B` +
        (gaps.length ? ` 缺片 ${gaps.join(',')}` : `（应 ≥${opts.minBytes}B）`));
    if (opts.stats) {                                // 诊断用：片号/空洞/耗时交给调用方
      opts.stats.frames = frames; opts.stats.maxIdx = maxIdx;
      opts.stats.gaps = gaps; opts.stats.bytes = got;
    }
    const end = maxIdx * 14 + chunks[maxIdx].length;
    return data.subarray(0, end);
  }

  // ── 写：有线一步 SetFeature（协议规范 §3 写时序）─────────────
  async function wiredWrite(cmd, addr, data) {
    assertWritable(cmd);
    const dev = state.dev;
    if (!dev.opened) await dev.open();
    await dev.sendFeatureReport(RID, frameW(cmd, addr, data.length, data));
    // 100ms 喘息：固件 flash 提交期间 HID 应答停摆，立刻读回会超时/断连（用户实测50不够）
    await sleep(100);
    log(`[有线] 写 cmd=${hex16(cmd)} addr=${addr} len=${data.length} 已发送`);
  }

  // ── 写：无线分片下推（§7.2 帧；block=总片数，页在 X 高4位）─────
  // 帧 [cmd][block][chunk][X=(页<<4)|片长][payload14][sum]，sum=(0x13+Σdata[0..17])&0xFF
  function wlChunks(cmd, block, data, page = 0) {
    const frames = [];
    const total = Math.ceil(data.length / 14);
    for (let i = 0; i < total; i++) {
      const p = data.subarray(i * 14, Math.min((i + 1) * 14, data.length));
      frames.push(wlFrame(cmd, block, i, p, ((page & 0xf) << 4) | p.length));
    }
    return frames;
  }

  async function wlWrite(cmd, block, data, page = 0) {
    assertWritable(cmd);
    const dev = state.dev;
    if (!dev.opened) await dev.open();
    const frames = wlChunks(cmd, block, data, page);
    if (frames.length !== block)
      throw new Error(`block=${hex16(block)} 与分片数 ${frames.length} 不一致（拒绝发送）`);
    let zeroAcks = 0;
    const echoed = new Set();                       // dongle 逐片回显（cmd 相同、chunk 号递增）
    const seen = [];
    const onRep = e => {
      if (e.reportId !== WL_RID) return;
      const b = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      if (seen.length < 3) seen.push(`len=${b.length}:${hex(b.subarray(0, 8))}`);
      if (b.length >= 19 && b[0] === cmd && wlChecksumValid(b)) {
        const idx = b[2] & 0xff;
        const sent = frames[idx];
        if (sent && sent.every((v, i) => b[i] === v)) echoed.add(idx);
        return;
      }
      if (b.length < 19) return;
      for (let i = 0; i < 18; i++) if (b[i] !== 0) return;   // 全零帧 = 官方抓包里的老式 ACK
      zeroAcks++;
    };
    dev.addEventListener('inputreport', onRep);
    try {
      // 第 1 轮整包；之后**只补发没回显的片**（幂等，跨轮累计：每片至少被设备收到一次即可）。
      // 老式"全零 ACK"对应不到片号 → 一旦出现就退回整包重发。最多 5 轮。
      for (let round = 1; round <= 5; round++) {
        let todo = frames;
        if (round > 1) {
          const missing = frames.filter((fr, i) => !echoed.has(i));
          todo = (zeroAcks > 0 || !missing.length) ? frames : missing;
          log(`[无线] 回显不全（累计 ${echoed.size}/${frames.length}）→ 50ms 后` +
              (todo === frames ? '整包重发' : `只补发缺片 ${todo.map(f => f[2]).join(',')}`), 'warn');
          await sleep(50);
        }
        for (const fr of todo) {
          const t0 = Date.now();
          await dev.sendReport(WL_RID, fr);
          const wait = 50 - (Date.now() - t0);          // 用户定档50ms：充分余量，杜绝主控邮箱溢出
          if (wait > 0) await sleep(wait);
        }
        await sleep(200);                               // 收尾回显尾巴
        log(`[无线] 写 cmd=${hex16(cmd)} block=${hex16(block)} 页=${page} 第${round}轮 → ` +
            `回显 累计 ${echoed.size}/${frames.length}${zeroAcks ? ` · 全零ACK ${zeroAcks}` : ''}` +
            `${round > 1 ? `（本轮发 ${todo.length} 片）` : ''}`);
        if (echoed.size === frames.length || zeroAcks > 0) break;
      }
    } finally {
      dev.removeEventListener('inputreport', onRep);
    }
    const complete = echoed.size === frames.length;
    if (!complete && zeroAcks === 0)
      throw new Error(`无线写 ACK 不完整 cmd=${hex16(cmd)}：回显 ${echoed.size}/${frames.length}，全零ACK ${zeroAcks}`);
    // 全零 ACK 无片号，不能按数量冒充逐片确认；交给高层读回校验判定是否真正落库。
    return { sent: frames.length, acks: echoed.size, ambiguousAck: !complete, zeroAcks };
  }

  // ── 网页侧抓包器（B 端对照用：记录 sendReport/inputreport 全帧）──
  state.cap = null;                                  // [] 或 null
  state.capCleanup = null;

  function capTs() {
    const d = new Date();
    const p = (n, w) => ('00' + n).slice(-(w || 2));
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }

  function startCapture() {
    if (state.cap) return;
    if (!state.dev) throw new Error('未连接设备');
    state.cap = [];
    const dev = state.dev;
    const orig = dev.sendReport.bind(dev);
    dev.sendReport = async (rid, data) => {
      const b = new Uint8Array(data);
      state.cap.push(capTs() + ' >WRITE rid=' + rid + ' len=' + b.length + ' ' + hex(b));
      return orig(rid, b);
    };
    const onIn = e => {
      const b = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      state.cap.push(capTs() + ' <READ rid=' + e.reportId + ' len=' + b.length + ' ' + hex(b));
    };
    dev.addEventListener('inputreport', onIn);
    state.capCleanup = () => {
      try { dev.sendReport = orig; } catch (e) {}
      dev.removeEventListener('inputreport', onIn);
    };
    log('[抓包] 开始记录网页侧全部 rid19 帧', 'ok');
  }

  function stopCapture() {
    if (!state.cap) return null;
    const lines = state.cap.slice();
    if (state.capCleanup) state.capCleanup();
    state.cap = null; state.capCleanup = null;
    log(`[抓包] 停止，共 ${lines.length} 帧`, 'ok');
    return lines.join('\n') + '\n';
  }

  // ── 读 PSD（型号识别）─────────────────────────────────────
  // A3（2026-10-31）：唤醒后 RF 链路刚建立，首查 600ms 等待窗常不够 → 自适应退避。
  // 首轮 600ms；无回流时 1200ms 重试一次（不拖慢正常路径）。
  // 从 rid19 帧里定位 PSD（6B：`03 00 00 00 SS XX`）。数据从帧 [4] 起（帧头 [cmd][blk][chunk][X]）。
  function psdInFrame(fr) {
    const at = i => i + 6 <= fr.length &&
      fr[i] === 0x03 && fr[i + 1] === 0x00 && fr[i + 3] === 0x00 &&
      (fr[i + 4] === 0x00 || fr[i + 4] === 0x01);
    if (at(4)) return Array.from(fr.slice(4, 10));    // 标准形态：载荷起点就是 PSD
    for (let i = 5; i + 6 <= fr.length; i++) if (at(i)) return Array.from(fr.slice(i, i + 6));  // 兜底
    return null;
  }

  // 无线单次查询：发一帧 → 收窗口内全部 rid19 回包（不过滤 cmd，便于诊断）
  async function wlQuery(cmd, waitMs) {
    const dev = state.dev;
    if (!dev) throw new Error('设备已断开');
    if (!dev.opened) await dev.open();
    const frames = [];
    const onRep = e => {
      if (e.reportId !== WL_RID) return;
      const b = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      if (wlChecksumValid(b)) frames.push(b.slice());
    };
    dev.addEventListener('inputreport', onRep);
    try {
      state.lastPsdQ = Date.now();                    // 顺带让 standingInput 别把回包当休眠推送
      await dev.sendReport(WL_RID, wlFrame(cmd, 0x01, 0));
      await sleep(waitMs);
    } finally { dev.removeEventListener('inputreport', onRep); }
    return frames;
  }

  async function readPSD() {
    if (state.channel === 'wired') {
      const p = await wiredRead(0x82, 1, 6, 8);
      return Array.from(p.slice(0, 6));
    }
    // 无线（2026-11-01 实测定案）：
    //   0x07 = 启动握手，只发不解析——每次只回 1 帧，且不含 PSD（旧代码就是在这里白等 2×600ms 再报"未解析出"）
    //   0x05 = PSD 查询，应答载荷起点即 03 00 00 00 SS XX（Hi8 = …00 ca）
    try { await wlQuery(0x07, 250); } catch (e) { /* 握手失败不阻断后续查询 */ }
    for (let attempt = 0; attempt < 2; attempt++) {
      let frames;
      try { frames = await wlQuery(0x05, attempt === 0 ? 600 : 1200); }
      catch (e) { log(`[无线] 查询 0x0005 失败：${e.message}`, 'warn'); return null; }
      for (const fr of frames) {
        const psd = psdInFrame(fr);
        if (psd) { log(`[无线] 查询 0x0005 解析出 PSD: ${hex(psd)}`, 'ok'); return psd; }
      }
      if (frames.length) {                            // 有回流但没 PSD（可能是别的推送帧）→ 再给一次机会
        log(`[无线] 查询 0x0005 有回流但没 PSD（${frames.length} 帧）：` +
            frames.slice(0, 2).map(f => hex(f)).join(' | '), 'warn');
        if (attempt === 1) return null;
        await sleep(200);
      } else if (attempt === 0) {
        log('[无线] 查询 0x0005 无回流，1200ms 退避重试…', 'warn');
      }
    }
    return null;   // 由 UI 回退：手动选型（Hi8/Hi8SE 键位同构）
  }

  // 诊断（控制台）：Leobog.psdProbe() —— 打印 0x07/0x05 收到的全部 rid19 原始帧
  async function psdProbe(waitMs = 1200) {
    if (state.channel !== 'wireless') throw new Error('仅无线可用');
    const out = [];
    for (const cmd of [0x07, 0x05]) {
      let frames = [];
      try { frames = await wlQuery(cmd, waitMs); } catch (e) { /* 忽略 */ }
      log(`[PSD探针] 0x${cmd.toString(16).padStart(2, '0')} → ${frames.length} 帧` +
          (frames.length ? '：' + frames.map(f => hex(f)).join(' | ') : '（无回流）'), 'warn');
      out.push({ cmd: '0x' + cmd.toString(16).padStart(2, '0'), frames: frames.map(f => hex(f)) });
    }
    return out;
  }

  // ── 读设置块 ──────────────────────────────────────────────
  async function readSettings() {
    let p;
    if (state.channel === 'wired') p = await wiredRead(0x84, 0, 128);
    else p = await wlRead(0x44, 0x01, 1800, { expect: 10, strict: true, minBytes: 128 });
    // byte14 = 无线链路标志（00=有线/01=无线，已结案）——只报异常值，正常值静默
    if (p && p.length > 14) {
      const exp = state.channel === 'wireless' ? 0x01 : 0x00;
      if (p[14] !== exp)
        log(`[设置] byte14=0x${(p[14] & 0xff).toString(16).padStart(2, '0')}（期望 ${hex16(exp)}，偏离——链路标志异常）`, 'warn');
    }
    return p;
  }

  // ── 读逐键色帧（378B = 126 槽 × RGB；有线0x86 / 无线0x42）────
  async function readColor() {
    if (state.channel === 'wired') return await wiredRead(0x86, 0, 378, 8);
    return await wlRead(0x42, 0x1b, 1800, { expect: 27, strict: true, minBytes: 378, retries: 3 });
  }

  // ── 宏区格式（逆向指南 §8.4）────────────────────────────────
  // 目录 = (offset_LE16, length_LE16)；offset 相对载荷起点；
  // 写载荷 = 紧凑目录（已用槽×4B）+ 记录（官方实测：单宏载荷 dir=4B、双宏 dir=8B）；
  // 读回可能是满 8 槽目录（offset[0]=32，固件 flash 形态）——解析时以 offset[0] 为目录长。
  // 记录 = [nameLen:1B][name UTF-16LE][事件 4B×N]；事件 = [flags, delayBE16, keycode]
  // flags bit7=抬起，bit4=修饰键(0xE0-0xE7)
  function utf16Bytes(str) {
    const out = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c > 0xffff) { out.push(0x3f, 0x00); continue; }
      out.push(c & 0xff, (c >> 8) & 0xff);
    }
    return out;
  }
  function utf16Str(bytes) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    return s;
  }

  function parseMacroArea(buf) {
    const slots = [];
    const o0 = buf[0] | (buf[1] << 8);
    const n = (o0 >= 4 && o0 <= 32 && o0 % 4 === 0) ? o0 / 4 : (o0 === 0 ? 0 : 8);
    for (let i = 0; i < 8; i++) {
      if (i >= n) { slots.push(null); continue; }
      const o = buf[i * 4] | (buf[i * 4 + 1] << 8);
      const l = buf[i * 4 + 2] | (buf[i * 4 + 3] << 8);
      if (l === 0 || o + l > 512 || o < o0) { slots.push(null); continue; }
      const rec = buf.subarray(o, o + l);
      const nl = rec[0];
      if (1 + nl > l) { slots.push(null); continue; }
      const name = utf16Str(rec.subarray(1, 1 + nl));
      const evb = rec.subarray(1 + nl);
      const events = [];
      for (let j = 0; j + 3 < evb.length; j += 4)
        events.push({ flags: evb[j], delay: (evb[j + 1] << 8) | evb[j + 2], key: evb[j + 3] });
      slots.push({ name, events });
    }
    return slots;
  }

  // 构建写载荷（紧凑目录 + 记录）；空槽被跳过 → 保存后槽位会重排为紧密顺序
  // 全空时返回 4B 全零（单条空目录项，与固件空态一致，允许"清空宏区"写入）
  function buildMacroArea(slots) {
    const used = [];
    for (let i = 0; i < 8; i++) {
      const m = slots[i];
      if (m && (m.name || (m.events && m.events.length))) used.push(m);
    }
    if (!used.length) return new Uint8Array(4);
    const dirSize = used.length * 4;
    const recs = [];
    let cur = dirSize;
    for (const m of used) {
      const nameB = utf16Bytes(m.name || '');
      const ev = new Uint8Array((m.events || []).length * 4);
      (m.events || []).forEach((e, j) => {
        ev[j * 4] = e.flags & 0xff;
        ev[j * 4 + 1] = (e.delay >> 8) & 0xff;
        ev[j * 4 + 2] = e.delay & 0xff;
        ev[j * 4 + 3] = e.key & 0xff;
      });
      const rec = new Uint8Array(1 + nameB.length + ev.length);
      rec[0] = nameB.length;
      rec.set(nameB, 1);
      rec.set(ev, 1 + nameB.length);
      recs.push({ at: cur, rec });
      cur += rec.length;
    }
    const out = new Uint8Array(cur);
    used.forEach((m, i) => {
      const { at, rec } = recs[i];
      out[i * 4] = at & 0xff; out[i * 4 + 1] = (at >> 8) & 0xff;
      out[i * 4 + 2] = rec.length & 0xff; out[i * 4 + 3] = (rec.length >> 8) & 0xff;
    });
    for (const { at, rec } of recs) out.set(rec, at);
    return out;
  }

  function macroSlotsEqual(a, b) {
    for (let i = 0; i < 8; i++) {
      const x = a[i], y = b[i];
      if (!x && !y) continue;
      if (!x || !y || x.name !== y.name || x.events.length !== y.events.length) return false;
      for (let j = 0; j < x.events.length; j++) {
        const e1 = x.events[j], e2 = y.events[j];
        if (e1.flags !== e2.flags || e1.delay !== e2.delay || e1.key !== e2.key) return false;
      }
    }
    return true;
  }

  // ── 读宏区（512B；有线0x85 / 无线0x43）──────────────────────
  async function readMacro() {
    if (state.channel === 'wired') return await wiredRead(0x85, 0, 512, 8);
    // 宏区实际只用前 504B（目录 32B + 记录），尾 8B 是 flash 页尾标记——和键表一样会结构性丢尾片，
    // 所以只要求 504B，补齐到 512B（全零）即可，不能因为少 8 字节就把整个宏面板判失败。
    const p = await wlRead(0x43, 0, 1800, { expect: 37, tailOptional: true, strict: true, minBytes: 504, retries: 3 });
    if (p.length >= 512) return p;
    const d = new Uint8Array(512);
    d.set(p);
    return d;
  }

  // ── 写宏区（整区重写：紧凑目录+记录；有线0x05 / 无线0x03）─────
  async function writeMacro(payload, opts = {}) {
    if (!state.channel) throw new Error('设备已断开，请重新连接');
    assertWriteTarget(opts);
    if (payload.length < 4 || payload.length > 504)
      throw new Error(`宏区载荷需 4~504B，收到 ${payload.length}B`);
    if (state.channel === 'wired') await wiredWrite(0x05, 0, payload);
    else await wlWrite(0x03, Math.ceil(payload.length / 14), payload, 0);
    if (opts.verify === false) return { written: true, verified: null };
    let got = null, err = null;
    try { got = await readMacro(); } catch (e) { err = e.message; }
    if (!got) return { written: true, verified: false, error: err || '读回为空' };
    // 裸字节比对会因目录形态（紧凑 vs 满8槽）误报 —— 按解析后的槽内容比对
    const ok = macroSlotsEqual(parseMacroArea(payload), parseMacroArea(got));
    log(`[校验] 宏区 ${ok ? '✅ 一致（按槽内容）' : '❌ 解析后槽内容不一致'}`);
    return { written: true, verified: ok, readback: got };
  }

  // ── 读键表页：有线 0x83 / 无线 0x41（= 写 0x01 | 0x40 配对）──
  async function readKeymap(page) {
    if (state.channel === 'wired') {
      try {
        const p = await wiredRead(0x83, page, 512, 8);
        if (p.length >= 512) {
          log(`[有线] 键表页${page} 读取成功 ✅ 512B（实时）`, 'ok');
          return p.subarray(0, 512);
        }
        return null;
      } catch (e) {
        log(`[有线] 键表页${page} 读取失败（${e.message}）→ 回退出厂布局`, 'warn');
        return null;
      }
    }
    // 无线：0x41 = 键表读。页号编码在 X 字节（帧 [41][blk][chunk][X]）：
    //   X = (页 << 4) | 片内长度   —— 由官方 FN1/FN2/Tap 写帧确证（0x1e/0x2e/0x3e，尾片 0x18/28/38）
    const finish = (p, how) => {
      const n = p.length;
      if (n >= 512 && p[510] === 0x5a && p[511] === 0xa5) {
        log(`[无线] 键表页${page} ✅ 512B（${how}）`, 'ok');
        return p.subarray(0, 512);
      }
      if (n >= 504) {
        const d = new Uint8Array(512);
        d.set(p.subarray(0, 504));
        d[510] = 0x5a; d[511] = 0xa5;
        log(`[无线] 键表页${page} ⚠️ ${n}B 尾片未达（${how}，已合成 5A A5）`, 'ok');
        return d;
      }
      return null;
    };
    const same504 = (a, b) => {
      if (!a || !b) return false;
      for (let i = 0; i < 504; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    try {
      if (page === 0 || !_wlKmP0) {
        const p0 = await wlRead(0x41, 0, 1800, { expect: 37, tailOptional: true });
        log(`[无线] 页0 基准 头8B: ${hex(p0.slice(0, 8))}`);
        _wlKmP0 = finish(p0, '默认帧');
        if (page === 0) return _wlKmP0;
      }
      // X 高4位=页；低4位试 0x0e（写侧满片值）与 0x00（读侧缺省值）
      for (const X of [(page << 4) | 0x0e, (page << 4) | 0x00]) {
        let p;
        try { p = await wlRead(0x41, 0, 1800, { lenField: X, expect: 37, tailOptional: true }); }
        catch (e) { log(`[无线] X=${hex16(X)} 无回流`, 'warn'); continue; }
        log(`[无线] X=${hex16(X)} 头8B: ${hex(p.slice(0, 8))}`);
        const d = finish(p, `X=${hex16(X)}`);
        if (d && !same504(d, _wlKmP0)) return d;
      }
      log(`[无线] 键表页${page}：X 编码读取未选出其它页 → 回退缓存`, 'warn');
      return null;
    } catch (e) {
      log(`[无线] 键表页${page} 读取异常：${e.message} → 回退 KB.ini 缓存`, 'warn');
      return null;
    }
  }

  // ── 无线遥测（0x4a → 2B；首字节推定电量%）─────────────────
  async function readTelemetry() {
    if (state.channel !== 'wireless') return null;
    try {
      return await wlRead(0x4a, 0x01, 1500, { expect: 1 });
    } catch (e) { return null; }
  }

  // ── 写 + 读回校验（Phase 2 核心：写完必须读回逐字节比对）───────
  function assertWriteTarget(opts) {
    // 入队时的自检目标必须在事务真正执行时仍匹配，不能把旧快照写到新设备。
    if (opts.expectedDeviceKey && opts.expectedDeviceKey !== devKey(state.dev))
      throw new Error('设备已切换，拒绝向其他设备写入自检数据');
  }
  async function writeKeymap(page, data, opts = {}) {
    if (!state.channel) throw new Error('设备已断开，请重新连接');
    assertWriteTarget(opts);
    if (!Number.isInteger(page) || page < 0 || page > 3) throw new Error('键表页号越界：' + page);
    if (data.length < 512) throw new Error(`键表页需 512B，收到 ${data.length}B`);
    const buf = data.subarray(0, 512);
    if (state.channel === 'wired') await wiredWrite(0x03, page, buf);
    else await wlWrite(0x01, 0x25, buf, page);
    // 只有写页0 才让无线页0 基准缓存失效（写其它页不影响页0 内容）
    if (state.channel === 'wireless' && page === 0) _wlKmP0 = null;
    if (opts.verify === false) return { written: true, verified: null };
    let got = null, err = null;
    try { got = await readKeymap(page); } catch (e) { err = e.message; }
    if (!got) return { written: true, verified: false, error: err || '读回为空' };
    const st = diffStats(buf, got, 504);                        // 比前504B=126 真实槽（尾2B为5A A5魔数）
    log(`[校验] 键表页${page} ${st.count === 0 ? '✅ 一致' : `❌ ${st.count} 字节不一致 ${st.pairs.join(' ')}`}`);
    return { written: true, verified: st.count === 0, diffCount: st.count, idxs: st.idxs, readback: got };
  }

  async function writeSettings(data, opts = {}) {
    if (!state.channel) throw new Error('设备已断开，请重新连接');
    assertWriteTarget(opts);
    if (data.length < 128) throw new Error(`设置块需 128B，收到 ${data.length}B`);
    const buf = data.subarray(0, 128);
    if (state.channel === 'wired') await wiredWrite(0x04, 0, buf);
    else await wlWrite(0x04, 0x0a, buf);
    if (opts.verify === false) return { written: true, verified: null };
    const maxChecks = state.channel === 'wireless' ? 3 : 1;
    let got = null, err = null, st = null;
    for (let attempt = 1; attempt <= maxChecks; attempt++) {
      try {
        const cur = await readSettings();
        if (cur) {
          got = cur; st = diffStats(buf, cur, 128);
          if (st.count === 0) {
            log(`[校验] 设置块 ✅ 一致${attempt > 1 ? `（第${attempt}次读回）` : ''}`);
            return { written: true, verified: true, diffCount: 0, idxs: [], readback: cur, verifyAttempts: attempt };
          }
          if (st.idxs.every(i => i === 14)) {
            log(`[校验] 设置块 ⚠️ 仅字节14 不一致 ${st.pairs.join(' ')} —— 设备自管，视为通过（其余一致）`, 'warn');
            return { written: true, verified: true, diffCount: st.count, idxs: st.idxs,
              volatile: [14], readback: cur, verifyAttempts: attempt };
          }
        }
      } catch (e) { err = e.message; }
      if (attempt < maxChecks) {
        log(`[校验] 设置块读回尚未稳定${st ? `（差异 ${st.count}B）` : ''}，${attempt * 300}ms 后复查`, 'warn');
        await sleep(attempt * 300);
      }
    }
    if (!got) return { written: true, verified: false, error: err || '读回为空' };
    log(`[校验] 设置块 ❌ ${st.count} 字节不一致 ${st.pairs.join(' ')}`);
    return { written: true, verified: false, diffCount: st.count, idxs: st.idxs,
      readback: got, verifyAttempts: maxChecks };
  }

  async function writeColor(data, opts = {}) {
    if (!state.channel) throw new Error('设备已断开，请重新连接');
    assertWriteTarget(opts);
    if (data.length < 378) throw new Error(`色帧需 378B，收到 ${data.length}B`);
    const buf = data.subarray(0, 378);
    if (state.channel === 'wired') await wiredWrite(0x06, 0, buf);
    else await wlWrite(0x02, 0x1b, buf);
    if (opts.verify === false) return { written: true, verified: null };
    const maxChecks = state.channel === 'wireless' ? 3 : 1;
    let got = null, err = null, st = null;
    for (let attempt = 1; attempt <= maxChecks; attempt++) {
      try {
        const cur = await readColor();
        if (cur) {
          got = cur; st = diffStats(buf, cur, 378);
          if (st.count === 0) {
            log(`[校验] 色帧 ✅ 一致${attempt > 1 ? `（第${attempt}次读回）` : ''}`);
            return { written: true, verified: true, diffCount: 0, idxs: [], readback: cur, verifyAttempts: attempt };
          }
        }
      } catch (e) { err = e.message; }
      if (attempt < maxChecks) {
        log(`[校验] 色帧首次读回尚未稳定${st ? `（差异 ${st.count}B）` : ''}，${attempt * 300}ms 后复查`, 'warn');
        await sleep(attempt * 300);
      }
    }
    if (!got) return { written: true, verified: false, error: err || '读回为空' };
    log(`[校验] 色帧 ❌ ${st.count} 字节不一致 ${st.pairs.join(' ')}`);
    return { written: true, verified: false, diffCount: st.count, idxs: st.idxs, readback: got, verifyAttempts: maxChecks };
  }

  // ── 音乐律动流（有线 0x08 整帧378B；无线 0x88 TLV 全量快照逐片）──
  // 无线数据报语法（官方抓包逐字节复刻）：[R,G,B,count,slot×count] 密排重复；
  // 帧=[88][block=片数][chunk][X=(zone1<<4)|len][payload14][sum]；心跳=[88][01][00][23][zeros][sum]
  async function sendMusicFrame(data) {
    if (!state.channel) throw new Error('设备已断开，请重新连接');
    if (state.channel !== 'wired') throw new Error('整帧模式仅支持有线；无线请走 sendMusicChunk');
    if (!data || data.length !== 378) throw new Error('音乐帧需 378B');
    assertWritable(0x08);
    const dev = state.dev;
    if (!dev.opened) await dev.open();
    await dev.sendFeatureReport(RID, frameW(0x08, 0, 378, data));
  }

  // 发送单条无线音乐分片（节拍由 app 层 audio-clock tick 控制；本函数零 sleep）
  // ⚠️ block 字段 = 本周期分片总数（官方 515 周期 100% 验证）；由调用方经 wlChunks 生成。
  async function sendMusicChunk(fr) {
    if (!state.channel) throw new Error('设备已断开，请重新连接');
    if (state.channel !== 'wireless') throw new Error('无线律动仅支持 2.4G');
    if (!fr || !fr.length) return;
    const dev = state.dev;
    if (!dev.opened) await dev.open();
    await dev.sendReport(WL_RID, fr);
  }

  // 无线律动心跳（官方 block1 轮询，X=0x23 常量，全零载荷）
  async function sendMusicPoll() {
    if (state.channel !== 'wireless') return;
    const dev = state.dev;
    if (!dev || !dev.opened) return;
    try {
      await dev.sendReport(WL_RID, wlFrame(0x88, 0x01, 0, null, 0x23));
    } catch (e) { /* 心跳失败静默 */ }
  }

  // 音乐会话的单次协议事务：0x44 严格收齐设置块（不保存内容），0x88 只确认原生发送。
  // 预算从调用开始，包含排队/发送/收片；音频时钟只调用交出的 checkDeadline，signal 只表示取消。
  // diagnostics 仅元数据：command 为命令数值，phase=queued/sending/receiving/complete；
  // sendMs 为原生发送耗时（未 settle 时 null），收片时间从调用起算，missingChunks 为缺失片号。
  async function musicSessionCommand(command, { device, signal, timeoutMs = 300, onDeadlineCheck } = {}) {
    const expectReply = command === 0x44;
    const label = expectReply ? '音乐防休眠探测' : '音乐心跳';
    const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
    const startedAt = now();
    let settled = false, listening = false, timer = null, deadlinePublished = false;
    let attempted = false, sent = false, transportPending = false, waitForSlot = false;
    let phase = 'queued', sendStartedAt = null, sendMs = null;
    let chunks = 0, receivedChunks = 0, firstReplyMs = null, lastReplyMs = null, badChecksumCount = 0;
    let resolveResult, rejectResult, queueSlot;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const diagnostics = () => ({ command, phase, sendMs, receivedChunks,
      missingChunks: expectReply ? Array.from({ length: 10 }, (_, i) => i).filter(i => !(chunks & (1 << i))) : [],
      firstReplyMs, lastReplyMs, badChecksumCount });
    const namedError = (name, message) => Object.assign(new Error(message), { name });
    const timeoutError = () => Object.assign(namedError('TimeoutError', label + '超时'), { transportPending });
    const abortReason = () => signal.reason === undefined
      ? namedError('AbortError', label + '已取消') : signal.reason;
    const cleanup = () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (listening) { device.removeEventListener('inputreport', onRep); listening = false; }
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      if (deadlinePublished) {
        deadlinePublished = false;
        // 通知接收方不能用异常改写已经确定的协议结果，也不能阻止队列释放。
        try { onDeadlineCheck(null); } catch (e) {}
      }
    };
    const fail = (error, cancelled = false) => {
      if (settled) return;
      settled = true;
      // 取失败时的快照：排队/原生挂起时不能等槽；明确取消无条件立即返回。
      waitForSlot = !cancelled && attempted && !transportPending;
      if (!cancelled) {
        // 保留原生错误身份；冻结错误/原始值无法附加诊断。signal.reason 从不修改。
        try { error.diagnostics = diagnostics(); } catch (e) {}
      }
      cleanup(); rejectResult(error);
    };
    // timer 与 app 音频时钟使用同一个入口；旧回调在 cleanup 后调用也是无副作用的 false。
    const checkDeadline = () => {
      if (settled) return false;
      if (signal && signal.aborted) { fail(abortReason(), true); return false; }
      if (now() - startedAt >= timeoutMs) { fail(timeoutError()); return false; }
      return true;
    };
    const stillLive = () => {
      if (settled) return false;
      if (signal && signal.aborted) { fail(abortReason(), true); return false; }
      if (!device) { fail(new TypeError(label + '必须传入本次会话的 device')); return false; }
      if (state.channel !== 'wireless' || state.dev !== device || !device.opened) {
        fail(namedError('InvalidStateError', label + '仅允许当前已打开的 2.4G 会话设备')); return false;
      }
      return checkDeadline();
    };
    const sendFailed = error => { if (stillLive()) fail(error); };
    const complete = () => {
      if (settled || !sent || (expectReply && chunks !== 0x3ff) || !stillLive()) return;
      settled = true; waitForSlot = true; phase = 'complete';
      const value = { elapsedMs: now() - startedAt, diagnostics: diagnostics() };
      if (expectReply) value.bytes = 128; else value.sent = true; // 0x88 成功绝不表示键盘清醒
      cleanup(); resolveResult(value);
    };
    const onAbort = () => fail(abortReason(), true);
    const onRep = e => {
      if (settled || !stillLive()) return;
      if (!attempted || !e || e.reportId !== WL_RID || (e.device && e.device !== device) ||
          !ArrayBuffer.isView(e.data) || e.data.byteLength !== 19) return;
      const b = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      if (b[0] !== 0x44) return;
      if (!wlChecksumValid(b)) { badChecksumCount++; return; }
      const chunk = b[2], len = b[3];                 // 设置页=0，不接受 X 的高位页号
      if (chunk > 9 || len > 14 || (chunk < 9 ? len !== 14 : len < 2)) return;
      // 0..8 各需 14B，尾片需 >=2B；重复片不能补洞，且不改变收片进度的时间戳。
      if (!(chunks & (1 << chunk))) {
        chunks |= 1 << chunk; receivedChunks++;
        lastReplyMs = now() - startedAt;
        if (firstReplyMs === null) firstReplyMs = lastReplyMs;
      }
      complete();
    };
    try {
      if (signal != null && (typeof signal.aborted !== 'boolean' ||
          typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))
        throw new TypeError('signal 必须是 AbortSignal');
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 0x7fffffff)
        throw new RangeError('timeoutMs 必须是 0..2147483647 内的有限毫秒数');
      if (onDeadlineCheck != null && typeof onDeadlineCheck !== 'function')
        throw new TypeError('onDeadlineCheck 必须是函数或 null');
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (onDeadlineCheck) { deadlinePublished = true; onDeadlineCheck(checkDeadline); }
      if (stillLive()) {
        // 单个兜底 timer，无轮询；事件/发送/出队路径也检查同一 deadline。
        timer = setTimeout(checkDeadline, Math.max(0, Math.ceil(timeoutMs - (now() - startedAt))));
        const queuedTask = enqueueIo(() => {
          if (settled) return;                       // 排队中取消/超时，本槽永久 no-op
          if (!stillLive()) return result;
          try {
            if (expectReply) {                       // 心跳不挂 inputreport 监听，也不等待 RX
              device.addEventListener('inputreport', onRep);
              listening = true;
            }
            if (!stillLive()) return result;
            attempted = true; transportPending = true; phase = 'sending'; sendStartedAt = now();
            const sendSettled = Promise.resolve(device.sendReport(WL_RID,
              wlFrame(command, 0x01, 0, null, expectReply ? undefined : 0x23))).then(() => {
              transportPending = false; sendMs = now() - sendStartedAt; sent = true;
              if (settled) return;
              if (expectReply) phase = 'receiving';
              if (stillLive()) complete();
            }, error => {
              transportPending = false; sendMs = now() - sendStartedAt; sendFailed(error);
            });
            // 对外取消/超时立即可见，但 WebHID 无法撤回，原生发送 settle 前仍持有互斥。
            return Promise.all([result.catch(() => {}), sendSettled]);
          } catch (error) {                           // 同步 throw 没有仍在等待的原生 Promise
            transportPending = false;
            if (attempted) sendMs = now() - sendStartedAt;
            sendFailed(error);
          }
          return result;
        });
        queueSlot = ioTail;                           // 只捕获本槽 finally，绝不等待后来的 ioTail
        queuedTask.catch(error => fail(error));       // 消费底层晚 reject，不重发
      }
    } catch (error) { fail(error); }
    try {
      return await result;
    } finally {
      // 成功和 native 已 settle 的发送后失败，必须先完成本槽 ioPending-- 再对外 settle。
      // 此标志在结果确定时捕获；取消、排队超时、挂起发送超时绝不会被后来状态改成等待。
      if (waitForSlot) await queueSlot;
    }
  }

  // 只读验证：严格 10 片/128B，仅返回元数据，不覆盖设置块。
  function probeMusicAwake(options) { return musicSessionCommand(0x44, options); }

  // 一次 RID19 0x88 心跳：只表示已发送，不推断键盘清醒。与 probe 共用单次入队生命周期。
  function sendMusicHeartbeat(options) { return musicSessionCommand(0x88, options); }

  // ── 读灯效参数块（512B；有线 0x8a / 无线 0x49）──
  // 0x0a 写没有官方读回样本，先按命令表试；失败只告警不打断（写路径已发）。
  //
  // ⚠️ 无线 0x49 实测只回 490B（35/37 片，第 35、36 片永不回流，4 次一致、无空洞：
  //    2026-11-01 日志 13:38:52 / 13:39:01 / 13:40:17 / 13:40:43）。
  //    512B = 36×14 + 8，缺的 [490..511] 恰好含 5A A5（[506..507]）→ 原判据必死。
  //    而官方 4 次 0x09/0x25 写（capture/hid_color.log）的尾两片字节恒定：
  //      chunk 0x23 = 14×00（[490..503]）· chunk 0x24 = 00 00 5A A5 00 00 00 00（[504..511]）
  //    → 短块按此补齐，补出来的块与官方写出的块逐字节等价（不是猜）。
  let _ledTailNoted = false;
  function padLedTail(p) {
    if (!p || p.length >= 512) return p;
    if (p.length < 490) return p;                    // 缺得比"两片"多 → 不猜，交上层判死
    if (!p.some(v => v !== 0)) return p;             // 全零块 = 影子/无效，不补
    const d = new Uint8Array(512);
    d.set(p.subarray(0, p.length));                  // 已到的部分原样保留（可能到 504）
    if (p.length < 508) { d[506] = 0x5a; d[507] = 0xa5; }   // 尾部未到才补魔数；到了但值不对就不伪造
    d.syntheticTail = true;
    d.verifiedBytes = p.length;
    if (!_ledTailNoted) {
      _ledTailNoted = true;
      log('[LED] 0x49 只回 490B（35/37 片，尾片 35/36 不回流）→ 尾 22B 按官方写帧常量补齐', 'warn');
    }
    return d;
  }

  async function readLed() {
    if (state.channel === 'wired') return await wiredRead(0x8a, 0, 512, 3);
    // expect 降到 35（=收到第 34 片即收工）：一次改色原要 2×4s 空转，现在正常 <1s。
    return padLedTail(await wlRead(0x49, 0x25, 1800,
      { expect: 35, strict: true, minBytes: 490, retries: 3 }));
  }

  // 诊断探针（控制台）：Leobog.ledProbe() —— 判定"设备只发 35 片"还是"窗口不够长"
  let _probeBusy = false;
  async function ledProbe(timeoutMs = 12000) {
    if (state.channel !== 'wireless') throw new Error('仅无线可用');
    if (_probeBusy) throw new Error('上一次探针还没跑完（12s 窗口会把邮箱占满），等它结束再跑');
    _probeBusy = true;
    try { return await ledProbeInner(timeoutMs); } finally { _probeBusy = false; }
  }
  async function ledProbeInner(timeoutMs) {
    const stats = {};
    const t0 = Date.now();
    const p = await wlRead(0x49, 0x25, timeoutMs,
      { expect: 37, tailOptional: true, noRetry: true, stats });
    const ms = Date.now() - t0;
    const magic = p.length >= 508 && p[506] === 0x5a && p[507] === 0xa5;
    // 关键色槽快照：模式1/2/5/10 的 entry0（21+(k-1)*21）
    const slots = {};
    // 槽位只有当其所在片到齐时才可信：空洞处是全零填充（否则会误读成 00 00 00）
    for (const k of [1, 2, 5, 10]) {
      const o = 21 + (k - 1) * 21;
      slots[k] = (stats.gaps || []).includes(Math.floor(o / 14)) ? null : Array.from(p.slice(o, o + 3));
    }
    log(`[LED探针] ${timeoutMs}ms 窗口：${p.length}B · 最大片=${stats.maxIdx} · ` +
        `缺片=[${(stats.gaps || []).join(',')}] · 尾部 5A A5 ${magic ? '在' : '未到'} · 耗时 ${ms}ms`, 'warn');
    log('[LED探针] 模式1/2/5/10 色槽：' +
        [1, 2, 5, 10].map(k => `k${k}=${slots[k] ? slots[k].map(v => v.toString(16).padStart(2, '0')).join('') : '缺片'}`).join(' ') +
        ` · 首16B=${hex(p.slice(0, 16))}`, 'warn');
    return { bytes: p.length, maxIdx: stats.maxIdx, gaps: stats.gaps || [], magic, ms, slots };
  }

  // ── 写灯效参数块（512B）──
  // 官方布局（hid_color_wired.log 常亮 + hid_color_fx.log 呼吸，两次抓包合并实证）：
  //   参数块 = 19 组 × 7 色调色板，第 k 组对应模式 k：偏移 = 21 + (k-1)*21
  //   组内：entry0 = 该模式的"自定义色"（改精细色写这里）；entry1..6 = 绿/蓝/黄/紫/青/白
  //   例：常亮 k=1 → [21..23]；呼吸 k=2 → [42..44]；随波逐流 k=11 → [231..233]
  //   尾部 [420..505] 零 + [506..507] 5A A5
  // 改色 = 读设备块 → 只改该模式组的 entry0 → 整块回写（其余槽位保持不动）。
  // 设备块可信判据：512B、尾 5A A5 在 [506..507]、非全零（读回可能是"主机写入影子"或全零）
  // 无线读回只有 490B → 由 padLedTail 按官方常量补尾后进这里（见上）
  const ledBlockSane = b => !!b && b.length >= 512 && b[506] === 0x5a && b[507] === 0xa5 &&
    b.some(v => v !== 0);
  // 模式 k 的自定义色槽偏移（19 组 × 7 色；k 收敛在 1..19）
  const ledColorOffset = mode => {
    const k = Math.min(Math.max(mode || 1, 1), 19);
    return 21 + (k - 1) * 21;
  };

  async function writeLed(opts = {}) {
    if (!state.channel) throw new Error('设备已断开，请重新连接');
    assertWriteTarget(opts);
    const slot = ledColorOffset(opts.mode);              // 模式 k → 21+(k-1)*21
    // 读-改-写：改色必须基于设备当前块。读不到可信基底就中止，
    // 绝不退回出厂常量——那会把其它模式的颜色槽和色带一起冲掉（2026-11-01 实测风险）。
    let base = null;
    if (opts.block) {
      const raw = opts.block instanceof Uint8Array ? opts.block : Uint8Array.from(opts.block);
      if (!ledBlockSane(raw)) throw new Error('备份 LED 参数块不可信（需 512B、尾 5A A5、非全零）');
      base = raw.slice(0, 512);
    } else if (opts.rgb) {
      for (let attempt = 1; attempt <= 2 && !base; attempt++) {
        try {
          const cur = await readLed();
          if (ledBlockSane(cur)) {
            base = cur.slice(0, 512);
            log(`[LED] 基底=设备当前块 [21..23]=${hex(cur.slice(21, 24))} ` +
                `模式${opts.mode || 1}槽[${slot}..${slot + 2}]=${hex(cur.slice(slot, slot + 3))}`, 'ok');
          } else {
            log(`[LED] 基底读回不可信（无 5A A5 或全零），第 ${attempt}/2 次`, 'warn');
          }
        } catch (e) { log(`[LED] 写前读回失败：${e.message}（第 ${attempt}/2 次）`, 'warn'); }
        if (!base && attempt < 2) await sleep(150);
      }
      if (!base) throw new Error('灯效参数块读回不可信（无线 0x49 短读 <490B 或全零）——' +
        '已中止，避免冲掉各模式颜色；请重试（控制台 Leobog.ledProbe() 可看片号/缺片）');
    } else {
      base = LED_PARAM;
      if (opts.verify !== false) {
        try {
          const b = await readLed();
          if (ledBlockSane(b)) log(`[LED] 设备当前 [21..23]=${hex(b.slice(21, 24))} · [42..44]=${hex(b.slice(42, 45))}`, 'ok');
        } catch (e) { log(`[LED] 写前读回失败：${e.message}`, 'warn'); }
      }
    }
    let block = base;
    if (opts.rgb && opts.rgb.length === 3) {
      const [r, g, b] = opts.rgb;
      block = base.slice();
      block[slot] = r; block[slot + 1] = g; block[slot + 2] = b;
      log(`[LED] 注入 RGB(${opts.rgb.join(',')}) @${slot}..${slot + 2}（模式${opts.mode || 1}自定义色槽）`, 'ok');
    }
    if (block.length !== 512) throw new Error(`LED 块长度异常：${block.length}B`);
    if (state.channel === 'wired') await wiredWrite(0x0a, 0, block);
    else await wlWrite(0x09, 0x25, block, 0);
    if (opts.verify === false) return { written: true, verified: null };
    let got = null;
    try { got = await readLed(); } catch (e) { log(`[LED] 读回失败：${e.message}`, 'warn'); }
    if (!got || got.length < 512) return { written: true, verified: false, error: '读回失败' };
    if (got.every(v => v === 0)) return { written: true, verified: null, error: '读回全零（0x8a 可能不支持）' };
    const verifiedBytes = got.syntheticTail ? Math.min(got.verifiedBytes || 490, 512) : 512;
    const idxs = [];
    for (let i = 0; i < verifiedBytes; i++) if (block[i] !== got[i]) idxs.push(i);
    log(`[LED] 读回 [${slot}..${slot + 2}]=${hex(got.slice(slot, slot + 3))}（写入 ${hex(block.slice(slot, slot + 3))}）` +
        ` · 差异 ${idxs.length} 字节` + (idxs.length ? ` @${idxs.slice(0, 12).join(',')}` : ''),
        idxs.length ? 'warn' : 'ok');
    return { written: true, verified: idxs.length === 0, partial: verifiedBytes < 512, verifiedBytes,
             diffCount: idxs.length, idxs: idxs.slice(0, 16), readback: got };
  }

  // ── 断开事件 ──────────────────────────────────────────────
  if ('hid' in navigator) {
    navigator.hid.addEventListener('disconnect', e => {
      if (state.dev && e.device === state.dev) {
        log('设备断开（休眠/拔出）', 'bad');
        state.dev = null; state.channel = null;
        if (state.onDisconnect) state.onDisconnect();
      }
    });
  }

  return {
    connect: queued(connect), connectExisting: queued(connectExisting), knownDevices,
    selectDevice: queued(selectDevice), disconnect: queued(disconnect), classify, walk, reportBits, devKey,
    wiredRead: queued(wiredRead), wlRead: queued(wlRead), wlFrame, frameW, wlChunks,
    wiredWrite: queued(wiredWrite), wlWrite: queued(wlWrite),
    readPSD: queued(readPSD), psdProbe: queued(psdProbe),
    readSettings: queued(readSettings), readColor: queued(readColor), readLed: queued(readLed),
    ledProbe: queued(ledProbe), readKeymap: queued(readKeymap), readMacro: queued(readMacro),
    readTelemetry: queued(readTelemetry),
    writeKeymap: queued(writeKeymap), writeSettings: queued(writeSettings),
    writeColor: queued(writeColor), writeMacro: queued(writeMacro), writeLed: queued(writeLed),
    sendMusicFrame, sendMusicChunk, sendMusicPoll, probeMusicAwake, sendMusicHeartbeat,
    startCapture, stopCapture,
    parseMacroArea, buildMacroArea, utf16Bytes, utf16Str,
    hex, hex16,
    get ioPending() { return ioPending; },
    get state() { return state; },
    get log() { return state.log; },
    set log(fn) { state.log = fn; },
    get onDisconnect() { return state.onDisconnect; },
    set onDisconnect(fn) { state.onDisconnect = fn; },
    get onUnsolicited() { return state.onUnsolicited; },
    set onUnsolicited(fn) { state.onUnsolicited = fn; },
  };
})();
