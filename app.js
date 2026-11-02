// app.js —— LEOBOG Hi8 / Hi8SE 网页配置界面（仅 Hi8 / Hi8SE）
// 每个写操作在协议层写后读回逐字节校验（协议规范 §3/§7.3c）。
'use strict';

const SUPPORTED = {
  '03:00:00:00:00:ca': 'Hi8',
  '03:00:00:00:01:3f': 'Hi8SE',
};

const $ = id => document.getElementById(id);
// 调试开关：URL 加 ?debug=1（或 localStorage.leobogDebug='1'）才打印设置块/色帧全文等诊断噪音
const DEBUG = (() => {
  try {
    if (/[?&]debug=1/.test(location.search)) return true;
    return localStorage.getItem('leobogDebug') === '1';
  } catch (e) { return false; }
})();

// ── HID usage 名（键盘页，精简表）────────────────────────────
const USAGE = (() => {
  const u = {};
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, i) => u[4 + i] = c.toUpperCase());
  const digits = '1234567890';
  '1234567890'.split('').forEach((c, i) => u[0x1e + i] = c);
  Object.assign(u, {
    0x28: 'Enter', 0x29: 'Esc', 0x2a: 'Backspace', 0x2b: 'Tab', 0x2c: '空格',
    0x2d: '-', 0x2e: '=', 0x2f: '[', 0x30: ']', 0x31: '\\',
    0x33: ';', 0x34: "'", 0x35: '`', 0x36: ',', 0x37: '.', 0x38: '/', 0x39: 'CapsLock',
    0x46: 'PrtSc', 0x47: 'ScrLk', 0x48: 'Pause', 0x49: 'Ins', 0x4a: 'Home',
    0x4b: 'PgUp', 0x4c: 'Del', 0x4d: 'End', 0x4e: 'PgDn', 0x4f: '→',
    0x50: '←', 0x51: '↓', 0x52: '↑',
    // 小键盘 / 菜单（调色板用）
    0x53: 'NumLk', 0x54: 'Num/', 0x55: 'Num*', 0x56: 'Num-', 0x57: 'Num+',
    0x58: 'NumEnter', 0x59: 'Num1', 0x5a: 'Num2', 0x5b: 'Num3',
    0x5c: 'Num4', 0x5d: 'Num5', 0x5e: 'Num6', 0x5f: 'Num7',
    0x60: 'Num8', 0x61: 'Num9', 0x62: 'Num0', 0x63: 'Num.',
    0x65: 'App',
    // 修饰键作为独立 usage（Modify 调色板绑定用，与组合键修饰位无关）
    0xe0: 'LCtrl', 0xe1: 'LShift', 0xe2: 'LAlt', 0xe3: 'LWin',
    0xe4: 'RCtrl', 0xe5: 'RShift', 0xe6: 'RAlt', 0xe7: 'RWin',
  });
  for (let i = 0; i < 12; i++) u[0x3a + i] = 'F' + (i + 1);
  return u;
})();

// 键位调色板分组（参考官方驱动「按键指派」布局：Comm / Adv / Keypad / Modify）
const PALETTE = {
  Comm: (() => {
    // 注意数字：HID 里 0x1E='1' … 0x26='9'、0x27='0'（曾经写成 0x1e+数字，整体错一位）
    const a = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('').map(c =>
      c >= 'a' && c <= 'z' ? [4 + c.charCodeAt(0) - 97, c.toUpperCase()]
        : [c === '0' ? 0x27 : 0x1e + Number(c) - 1, c]);
    return a.concat([[0x2d, '-'], [0x2e, '='], [0x2f, '['], [0x30, ']'],
                     [0x31, '\\'], [0x33, ';'], [0x34, "'"], [0x35, '`'],
                     [0x36, ','], [0x37, '.'], [0x38, '/']]);
  })(),
  Adv: [
    ...Array.from({ length: 12 }, (_, i) => [0x3a + i, 'F' + (i + 1)]),
    [0x29, 'Esc'], [0x2b, 'Tab'], [0x65, 'App'], [0x49, 'Ins'], [0x4d, 'End'], [0x4c, 'Del'],
    [0x4e, 'PgDn'], [0x4b, 'PgUp'], [0x2a, 'Backspace'], [0x4a, 'Home'], [0x39, 'CapsLock'],
    [0x48, 'Pause'], [0x28, 'Enter'], [0x2c, '空格'], [0x46, 'PrtSc'], [0x47, 'ScrLk'],
    [0x50, '←'], [0x4f, '→'], [0x52, '↑'], [0x51, '↓'],
  ],
  Keypad: [
    [0x62, 'Num0'], [0x59, 'Num1'], [0x5a, 'Num2'], [0x5b, 'Num3'],
    [0x5c, 'Num4'], [0x5d, 'Num5'], [0x5e, 'Num6'],
    [0x5f, 'Num7'], [0x60, 'Num8'], [0x61, 'Num9'],
    [0x57, 'Num+'], [0x56, 'Num-'], [0x55, 'Num*'], [0x54, 'Num/'], [0x63, 'Num.'],
    [0x58, 'NumEnter'], [0x53, 'NumLk'],
  ],
  Modify: [
    [0xe0, 'LCtrl'], [0xe1, 'LShift'], [0xe2, 'LAlt'], [0xe3, 'LWin'],
    [0xe4, 'RCtrl'], [0xe5, 'RShift'], [0xe6, 'RAlt'], [0xe7, 'RWin'],
  ],
};

// ── 特殊键（编码全部实测：官方驱动写 → 网页读回，2026-11-01）──
// type 07+mod0 = 厂商功能码 · 0d = 层切换 · 01 = 鼠标按键 · 02 = 16 位 Consumer usage
const SPECIAL_GROUPS = [
  { name: '系统', items: [
    ['锁Win', [0x07, 0, 0, 0x01], 'Fn+LWin：锁定或解锁左 Win，Mac 模式下不生效'],
    ['电量', [0x07, 0, 0, 0x11], '按住显示电量：1~0 逐格，低于 30% 亮红灯'],
    ['蓝牙1', [0x07, 0, 0, 0x05], 'Fn+1'],
    ['蓝牙2', [0x07, 0, 0, 0x06], 'Fn+2'],
    ['蓝牙3', [0x07, 0, 0, 0x07], 'Fn+3'],
    ['2.4G对码', [0x07, 0, 0, 0x08], '长按 3 秒，开关需拨到 2.4G', true],
    ['恢复默认', [0x07, 0, 0, 0x04], '长按 3 秒：清空全部配置', true],
    ['Windows', [0x07, 0, 0, 0x18], 'Fn+W'],
    ['Android', [0x07, 0, 0, 0x19], 'Fn+Q'],
    ['Mac', [0x07, 0, 0, 0x1a], 'Fn+E：左 Win 与左 Alt 互换'],
    ['锁键盘', [0x07, 0, 0, 0x02], '锁定全部按键，再按一次解锁', true],
  ] },
  { name: '系统命令', items: [
    ['保存', [0x00, 0x01, 0x16, 0], 'Ctrl+S'],
    ['撤销', [0x00, 0x01, 0x1d, 0], 'Ctrl+Z'],
    ['关闭窗口', [0x00, 0x04, 0x3d, 0], 'Alt+F4'],
    ['显示桌面', [0x00, 0x08, 0x07, 0], 'Win+D'],
    ['锁定计算机', [0x00, 0x08, 0x0f, 0], 'Win+L'],
    ['运行命令', [0x00, 0x08, 0x15, 0], 'Win+R'],
    ['任务管理器', [0x00, 0x05, 0x4c, 0], 'Ctrl+Alt+Del'],
    ['放大', [0x00, 0x01, 0x2e, 0], 'Ctrl+='],
    ['缩小', [0x00, 0x01, 0x2d, 0], 'Ctrl+-'],
  ] },
  { name: '层', items: [
    ['Fn', [0x0d, 0, 0, 0], '按住进 FN1 层'],
    ['Fn2', [0x0d, 1, 0, 0], '按住进 FN2 层'],
  ] },
  { name: '鼠标', items: [
    ['左键', [0x01, 1, 0x01, 0], '鼠标左键单击'],
    ['右键', [0x01, 2, 0x01, 0], '鼠标右键单击'],
    ['中键', [0x01, 3, 0x01, 0], '鼠标中键单击'],
    ['后退', [0x01, 4, 0x01, 0], '鼠标侧键：后退'],
    ['前进', [0x01, 5, 0x01, 0], '鼠标侧键：前进'],
  ] },
  { name: '媒体/浏览器', items: [
    ['主页', [0x02, 0, 0x02, 0x23], '打开浏览器主页，Consumer 0x0223，同 Fn+F1'],
    ['邮件', [0x02, 0, 0x01, 0x8a], 'Consumer 0x018A'],
    ['播放/暂停', [0x02, 0, 0, 0xcd], ''],
    ['上一曲', [0x02, 0, 0, 0xb6], ''],
    ['下一曲', [0x02, 0, 0, 0xb5], ''],
    ['停止', [0x02, 0, 0, 0xb7], ''],
    ['静音', [0x02, 0, 0, 0xe2], ''],
    ['音量+', [0x02, 0, 0, 0xe9], ''],
    ['音量-', [0x02, 0, 0, 0xea], ''],
    ['播放', [0x02, 0, 0, 0xb0], ''],
    ['暂停', [0x02, 0, 0, 0xb1], ''],
    ['亮度+', [0x02, 0, 0, 0x6f], '系统级，台式机通常无效'],
    ['亮度-', [0x02, 0, 0, 0x70], '系统级，台式机通常无效'],
  ] },
];
const SPECIAL_ITEMS = [];
for (const g of SPECIAL_GROUPS) for (const it of g.items)
  SPECIAL_ITEMS.push({ group: g.name, label: it[0], rec: it[1], tip: it[2] || it[0], warn: !!it[3] });

// KeyboardEvent.code → HID usage（物理键捕获用；标准 HID 键盘页）
const EV2USAGE = (() => {
  const m = {};
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, i) => { m['Key' + c.toUpperCase()] = 4 + i; });
  const dig = '1234567890';
  dig.split('').forEach((c, i) => { m['Digit' + c] = 0x1e + i; });
  Object.assign(m, {
    Enter: 0x28, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, Minus: 0x2d, Equal: 0x2e,
    BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33,
    Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
    PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49, Home: 0x4a,
    PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e, ArrowRight: 0x4f,
    ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
  });
  for (let i = 0; i < 12; i++) m['F' + (i + 1)] = 0x3a + i;
  Object.assign(m, {
    ShiftLeft: 0xe1, ShiftRight: 0xe5, ControlLeft: 0xe0, ControlRight: 0xe4,
    AltLeft: 0xe2, AltRight: 0xe6, MetaLeft: 0xe3, MetaRight: 0xe7, ContextMenu: 0x65,
    NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56,
    NumpadAdd: 0x57, NumpadEnter: 0x58, NumpadDecimal: 0x63,
  });
  '123456789'.split('').forEach((c, i) => { m['Numpad' + c] = 0x59 + i; });
  m.Numpad0 = 0x62;
  return m;
})();

// 键名归一：布局里的键名 ≠ usage 名（Space/空格、Delete/Del、Up/↑、Fn/FN…）时算同一个键，
// 否则"没改过的键"也会多出一条别称（Space 底下挂"空格"、Up 底下挂"↑"）。
const KEY_ALIAS = {
  '空格': 'space', space: 'space',
  del: 'delete', delete: 'delete',
  '↑': 'up', up: 'up', arrowup: 'up',
  '↓': 'down', down: 'down', arrowdown: 'down',
  '←': 'left', left: 'left', arrowleft: 'left',
  '→': 'right', right: 'right', arrowright: 'right',
  fn: 'fn',
  prtsc: 'printscreen', print: 'printscreen', printscreen: 'printscreen',
  scrlk: 'scrolllock', scrolllock: 'scrolllock',
  ins: 'insert', insert: 'insert',
  back: 'backspace', backspace: 'backspace',
  caps: 'capslock', capslock: 'capslock',
  pgup: 'pageup', pageup: 'pageup',
  pgdn: 'pagedown', pagedown: 'pagedown',
  menu: 'app', app: 'app',
};
function sameKey(a, b) {
  const n = s => String(s == null ? '' : s).trim().toLowerCase();
  const x = n(a), y = n(b);
  if (x === y) return true;
  return KEY_ALIAS[x] !== undefined && KEY_ALIAS[x] === KEY_ALIAS[y];
}

// ── 记录解码 [type][mod][x][usage] ──────────────────────────
function decodeRecord(b, off = 0) {
  const type = b[off], mod = b[off + 1], usage = b[off + 3];
  // 键表 type 02 = 媒体键：Consumer page usage 在 [3]（出厂键表实证：cd 播放暂停、e9/ea 音量、b5/b6 上下曲）
  // Consumer page（0x0C）常用 usage：type 02 的 16 位 usage = [2]<<8 | [3]
  const CONSUMER = {
    0x6f: '亮度+', 0x70: '亮度-',
    0xb0: '播放', 0xb1: '暂停', 0xb3: '快进', 0xb4: '快退', 0xb5: '下一曲', 0xb6: '上一曲',
    0xb7: '停止', 0xcd: '播放/暂停', 0xe2: '静音', 0xe9: '音量+', 0xea: '音量-',
    0x18a: '邮件', 0x192: '计算器', 0x194: '资源管理器', 0x196: '浏览器',
    0x221: '搜索', 0x223: '主页', 0x224: '后退', 0x225: '前进', 0x227: '刷新', 0x22a: '书签',
  };
  // 键表 type 07 且 mod=0：不是组合键，而是**厂商功能码**（放在 [3]）。
  // 来源：官方说明书 FN 组合表 + 实机确认（2026-11-01）；未收录的显示 功能0xNN。
  const KB_FUNC = {
    0x01: '锁Win',       // Fn+LWin：锁定/解锁左 Win（Mac 模式下不生效）
    0x02: '锁键盘',       // 驱动里的"锁键盘"
    0x04: '恢复默认',     // Fn+Esc 长按 3 秒
    0x05: '蓝牙1',       // Fn+1
    0x06: '蓝牙2',       // Fn+2
    0x07: '蓝牙3',       // Fn+3
    0x08: '2.4G对码',    // Fn+` 长按 3 秒（需开关拨到 2.4G）
    0x11: '电量',        // Fn+B：1~0 逐格显示电量
    0x18: 'Windows',     // Fn+W
    0x19: 'Android',     // Fn+Q
    0x1a: 'Mac',         // Fn+E（Win/Alt 位置互换）
    0x1d: '模式键',       // 旋钮键：灯效模式=短按循环 17 灯效、旋转调亮度；音量模式=短按静音、旋转调音量；长按切两种模式
  };
  // 键表 type 08 = 功能键：[1]=功能组、[2]=参数（01 增 / 02 减）
  // 实机确认（2026-11-01）：00=灯效切换\=、02=颜色切换 Tab、03=亮度↑↓、04=速度→←（01 增 / 02 减）
  const FN_FUNC = {
    '0:0': '灯效切换', '2:0': '颜色切换',
    '3:1': '亮度+', '3:2': '亮度-',
    '4:1': '速度+', '4:2': '速度-',
  };
  const modName = mod ? 'Ctrl+Shift+Alt+Win'.split('+').filter((_, i) => mod & (1 << i)).join('+') : '';
  // 纯修饰键记录是"修饰位掩码"（出厂：LShift=00 02 00 00、RShift=00 20 00 00），左右各 4 位
  const MOD8 = [[0x01, 'LCtrl'], [0x02, 'LShift'], [0x04, 'LAlt'], [0x08, 'LWin'],
                [0x10, 'RCtrl'], [0x20, 'RShift'], [0x40, 'RAlt'], [0x80, 'RWin']];
  const modName8 = m => MOD8.filter(([b]) => m & b).map(([, n]) => n).join('+');
  let core;
  if (type === 0x00) {
    // 普通键：出厂与我们写 [3]=键码；官方驱动的"PC 命令"(保存/撤销/关闭窗口…)把键码写在 [2]、[3]=00
    const kc = (usage !== 0 || b[off + 2] === 0) ? usage : b[off + 2];
    if (kc === 0) {
      if (mod) return { type, label: modName8(mod), empty: false, plainMod: true };   // 纯修饰键（掩码型）
      return { type, label: '0x0', empty: true };
    }
    const kn = USAGE[kc] || ('0x' + kc.toString(16));
    return { type, label: (modName ? modName + '+' : '') + kn, empty: false };
  }
  if (type === 0x01) {                                 // 鼠标键：[1]=按键号（实测编码）
    const MB = { 1: '左键', 2: '右键', 3: '中键', 4: '后退', 5: '前进' };
    core = '鼠标:' + (MB[b[off + 1]] || ('键' + b[off + 1]));
  }
  else if (type === 0x02) {                                 // 媒体/浏览器键：16 位 Consumer usage
    const u16 = ((b[off + 2] & 0xff) << 8) | (b[off + 3] & 0xff);   // [2]=高位 [3]=低位
    core = CONSUMER[u16] || ('媒体 0x' + u16.toString(16).padStart(4, '0'));
  }
  else if (type === 0x03) {                                 // 宏触发 [03][模式][次数][槽]
    const MODES = { 2: '循环到任意键', 4: '循环到松开' };
    const slot = b[off + 3], mode = b[off + 1], cnt = b[off + 2];
    core = `宏${slot + 1}` + (mode === 1 ? ` ×${cnt}` : (' ' + (MODES[mode] || `模式${mode}`)));
  }
  else if (type === 0x07) {                                 // 有修饰=组合键；无修饰=厂商功能码
    core = mod
      ? ('组合:' + (USAGE[usage] || '0x' + usage.toString(16)))
      : (KB_FUNC[usage] || ('功能0x' + usage.toString(16).padStart(2, '0')));
  }
  else if (type === 0x08) {                                 // 功能键：[1]=功能组 [2]=参数（01 增 / 02 减）
    core = '功能:' + (FN_FUNC[b[off + 1] + ':' + b[off + 2]] || (b[off + 1] + '/' + b[off + 2]));
  }
  else if (type === 0x0d) {                                 // 层切换键（按住进 FN 层）：[1]=目标层
    const lv = b[off + 1];
    core = lv === 0 ? 'Fn' : (lv === 1 ? 'Fn2' : ('层' + lv));
  }
  else if (type === 0x09) core = 'fn:' + hexs(b.slice(off, off + 4));
  else core = '#' + type.toString(16) + ':' + hexs(b.slice(off, off + 4));
  // 只有 00(纯修饰键) 和 07(组合键) 的 [1] 是修饰位；02/03/08 的 [1] 是功能码，绝不能加修饰前缀
  let prefix = '';
  if (type === 0x07 && modName) prefix = modName + '+';
  return { type, label: prefix + core, empty: type === 0 && mod === 0 && usage === 0 };
}

function decodeRecord32(hexStr) {
  const v = parseInt(hexStr, 16);
  const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  return decodeRecord(b, 0);
}

// ── 状态 ────────────────────────────────────────────────────
const S = {
  model: null,          // profiles.models 项
  modelName: '',
  settings: null,       // Uint8Array 128
  keymap: [null, null, null, null],   // 实时数据；null = 该页读取失败（不可编辑）
  color: null,          // Uint8Array 378 色帧工作副本
  channel: null,
  psd: null,
  curLayer: 0,
  sel: null,            // 编辑器当前槽位
  kmDirty: [false, false, false, false],
  setDirty: false,
  setOps: [],           // 设置表单来源：[{key, row, fn(freshBlock)}]
  lightOps: [],         // 灯效页来源（模式/亮度/速度/随机色），与 setOps 合并执行
  lightSel: null,       // 灯效页选中模式
  lightColor: '#66ccff', // 调色盘默认色（页面暂存；自定义单色时写入色帧）
  lightHsv: [0, 1, 1],   // 调色盘 HSV 源状态（拖拽用；避免 hex 往返量化导致点位漂移）
  lightPresetIdx: null,  // 快捷色高亮（纯 UI；不写设置块）
  colorDirty: false,
  macroRaw: null,       // 宏区 512B
  macroSlots: null,
  macroDraft: null,     // 解析后 8 槽
  macroEditSlot: null,
  ledPush: false,       // 恢复出厂时置位：applyAll 推灯效参数块（官方同款）
  ledColorRgb: null,    // 单色 RGB [r,g,b]：应用时注入参数块并推送
  ledColorSlot: null,   // 待写颜色的模式号 → 参数块颜色槽 = 21+(mode-1)*21
  colorBase: null,      // 自定义模式：已提交的逐键色帧（应用成功/读回时更新）
  eraser: false,        // 自定义模式：橡皮开关（点击/划选=擦除）
  customInit: false,    // 自定义模式的选中集是否已从设备色帧初始化
  section: 'keys',      // 当前导航页（keys/light/music/macro/settings）
};

// Array.from：Uint8Array 走 .map 会把回调返回的字符串强转回数字（"66 0 0" 的由来）
const hexs = a => Array.from(a, b => (b & 0xff).toString(16).padStart(2, '0')).join(' ');
const toHex = a => Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
const fromHex = s => Uint8Array.from(s.match(/../g).map(h => parseInt(h, 16)));
const countNonzeroSlots = c => { let n = 0; for (let i = 0; i + 2 < c.length; i += 3) if (c[i] || c[i+1] || c[i+2]) n++; return n; };

// ── 出厂数据（web/data/factory.js：从 fw/hi8/hi8_fw_backup.hex 提取；两型号配置区一致）──
// 恢复出厂 = 固件真·出厂镜像：设置块 @0xC400 + 键表 Win 四页 @0xCC00/D000/D400/D600（含尾 5A A5）。
// 官方驱动“恢复出厂”写入值与固件块差 21 字节（休眠/速度档/[26]），本页取固件镜像。
// [14]=无线链路标志：整块覆盖时一律保留新鲜值（固件镜像里是 00=有线）。

Leobog.log = (m, c) => {
  const el = document.createElement('div');
  if (c) el.className = c;
  el.textContent = `[${new Date().toTimeString().slice(0, 8)}] ${m}`;
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
  // 收起时在「日志」旁预览最新一条（展开后隐藏预览，由 logToggle 控制也可，这里始终刷新）
  const last = $('logLast');
  if (last) last.textContent = el.textContent;
};
Leobog.onDisconnect = () => {
  S.channel = null;
  stopMusic();
  $('status').innerHTML = '<span class="bad">● 设备断开</span>';
  $('connectBtn').textContent = '连接键盘';
  updateDirtyUI();
  // 接收器拔出 = HID 句柄丢失，插回是新设备——不自动回连，重新插入后手动点卡片（用户拍板）
  recover = false;
  showLanding('设备已断开——重新插入后请在设备列表中点击进入');
};

// ── 连接页 / 工作区 切换 ──
function showWorkspace() {
  $('landing').style.display = 'none';
  $('app').style.display = '';
  fitKeyboard();
}
function showLanding(msg) {
  $('app').style.display = 'none';
  $('landing').style.display = '';
  if (msg) $('landStatus').innerHTML = `<span class="warn">${msg}</span>`;
  scheduleSelectSoon();                            // 立即跑一轮发现/恢复，不等下个节拍
}

// ── 状态机 ──
// 进入配置页的两条路径：① 用户点击设备卡片（唯一手动入口）
//                      ② 配置中休眠/拔插断连后的自动恢复（唯一自动入口）
// 其余时刻一律停在选择界面（识别到的设备以型号卡片列表展示）。
let recover = false;           // 断连恢复标记（true=恢复后自动回配置页）
let recoverKey = null;         // 断连设备 vendor:productId
let lastDevKey = null;         // 当前会话设备 key
let connecting = false;        // 连接/识别进行中
let applying = false;          // 写入进行中（applyAll/宏写；探测心跳需跳过）
let wakeTimer = null;          // 选择页发现循环
let cards = [];                // 设备列表快照 [{dev,key,productName,kind,model,state}]
let probeIdx = 0;
let selectTick = null;         // 当前循环的单步函数（供推送即时触发）
let pendingUnsol = null;       // 忙时挂起的推送 status（'sleep'|'wake'|null）；空闲当场补跑

const setConnStatus = html => { $('status').innerHTML = html; };
const connStatusLine = info =>
  `<span class="ok">● 已连接</span> ${info.productName ? info.productName + ' · ' : ''}` +
  `<code>${info.channel === 'wired' ? '有线' : '无线 2.4G'}</code>`;
// 设备身份改用 Leobog.devKey（按对象编号：两台同 VID/PID 的键盘也不会撞 key）
function scheduleSelectSoon() {
  if (!selectTick) return;
  if (selectBusy) { selectPending = true; return; }
  clearTimeout(wakeTimer);
  selectTick();                                    // 立即执行：后台 setTimeout 会被节流，不能依赖定时器
}

// 设备识别（PSD → 型号）；retries 次内全失败视为休眠/无响应
async function identifyModel(retries) {
  $('psdLine').textContent = '识别设备中…';
  let psd = null;
  for (let i = 0; i <= retries; i++) {
    if (i) await new Promise(r => setTimeout(r, 500));
    psd = await Promise.resolve(Leobog.readPSD()).catch(() => null);
    if (psd) break;
  }
  if (!psd) return { ok: false, reason: 'asleep' };
  const key = psd.map(b => b.toString(16).padStart(2, '0')).join(':');
  if (!SUPPORTED[key]) return { ok: false, reason: 'unsupported', psd };
  S.psd = psd;
  S.modelName = SUPPORTED[key];
  await window.LEOBOG_loadModel(S.modelName);
  S.model = window.LEOBOG_MODELS[S.modelName].profile;
  $('psdLine').innerHTML = `型号：<b>${S.modelName}</b> · ${S.model.shortName}`;
  Leobog.log(`型号识别：${S.modelName}`, 'ok');
  return { ok: true };
}

// 附着 → 识别 → 读配置 → 进配置页。休眠=停选择页并置 recover（唤醒自动恢复）。
async function enterFromDevice(retries = 3) {
  connecting = true;
  try {
    $('landStatus').innerHTML = '<span class="muted">已连接，正在识别设备…</span>';
    const id = await identifyModel(retries);
    if (!id.ok) {
      if (id.reason === 'unsupported') {
        const msg = '此设备暂不受支持，目前支持 Hi8 / Hi8SE';
        Leobog.log('设备识别失败：' + msg + `（PSD ${hexs(id.psd || [])}）`, 'warn');
        await Leobog.disconnect();
        S.channel = null;
        recover = false;
        updateDirtyUI();
        setConnStatus('未连接');
        $('connectBtn').textContent = '连接键盘';
        showLanding(msg);
        return false;
      }
      Leobog.log('设备无响应，可能在休眠——停在选择界面，唤醒后自动恢复', 'warn');
      recover = true;
      recoverKey = lastDevKey;
      setConnStatus('<span class="warn">● 键盘休眠中</span>');
      showLanding('键盘处于休眠状态——请按任意键唤醒，唤醒后自动恢复配置界面');
      return false;
    }
    $('landStatus').innerHTML = '<span class="muted">正在读取配置…</span>';
    await afterModel();
    $('landStatus').innerHTML = '点击下方按钮，在弹出的设备列表中选择并连接';
    recover = false;
    // 顶栏状态刷新（恢复路径若句柄未重开会跳过 setConnStatus，这里兜底消除"键盘休眠中"残留）
    {
      const d = Leobog.state.dev;
      setConnStatus(connStatusLine({
        channel: S.channel,
        productName: d ? d.productName : '',
      }));
    }
    showWorkspace();
    $('connectBtn').textContent = '退出配置';
    return true;
  } finally {
    connecting = false;
  }
}

// ── 选择界面：设备列表渲染 ──
function renderDeviceList() {
  const list = $('landList'), art = $('guideArt');
  if (!list || !art) return;
  if (!cards.length) { list.style.display = 'none'; art.style.display = ''; return; }
  art.style.display = 'none';
  list.style.display = '';
  const STATE = {
    ready: ['已就绪', 'ok'],
    sleep: ['键盘休眠——请唤醒', 'warn'],
    unknown: ['识别中…', ''],
    unsupported: ['不受支持', 'bad'],
  };
  const esc = s => String(s || '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  list.innerHTML = cards.map((c, i) => {
    const kind = c.kind === 'wired' ? 'USB' : c.kind === 'wireless' ? '2.4G' : '—';
    const st = STATE[c.state] || STATE.unknown;
    const name = c.model ? `${c.model} · ${esc(c.productName)}` : esc(c.productName);
    return `<button class="dev-row${c.state === 'sleep' ? ' sleep' : ''}" data-i="${i}">
      <span class="dev-chip">${kind}</span>
      <span class="dev-info"><span class="dev-name">${name}</span>
        <span class="dev-sub ${st[1]}">${st[0]}</span></span>
      <span class="dev-go">进入 ›</span></button>`;
  }).join('');
}

// 卡片探测：探活 + 补型号（每轮只探一张，轮流刷新；休眠=1.5s 上限）
async function probeCard(c) {
  if (connecting) return;                           // 连接/进入流程进行中——不并发探测
  if (c.state === 'ready' && c.model) return;       // 已识别：不附着、不查询（否则每 1.5s 切换两台设备刷日志）
  try {
    const cur = Leobog.state.dev;
    const same = cur === c.dev;                     // 按对象判"同一台"（VID/PID 在多设备下会撞）
    if (!same) {
      const info = await Leobog.selectDevice(c.dev, { quiet: true });   // 探测用附着不打"已连接"
      S.channel = info.channel;
    }
    lastDevKey = c.key;
    if (c.kind === 'wired') {
      if (!c.model) {
        const psd = await Promise.resolve(Leobog.readPSD()).catch(() => null);
        const key = psd ? psd.map(b => b.toString(16).padStart(2, '0')).join(':') : null;
        c.model = key && SUPPORTED[key] ? SUPPORTED[key] : null;
        c.state = !psd ? 'unknown' : (SUPPORTED[key] ? 'ready' : 'unsupported');
      } else c.state = 'ready';
      return;
    }
    // （"已识别就跳过"已在函数开头判过）
    if (!(await probeKeyboard())) { c.state = 'sleep'; return; }
    if (!c.model) {
      const psd = await Promise.resolve(Leobog.readPSD()).catch(() => null);
      const key = psd ? psd.map(b => b.toString(16).padStart(2, '0')).join(':') : null;
      if (key && SUPPORTED[key]) { c.model = SUPPORTED[key]; c.state = 'ready'; }
      else if (psd) c.state = 'unsupported';
      else c.state = 'unknown';
    } else c.state = 'ready';
  } catch (e) { c.state = 'unknown'; }
}

// ── 选择页发现循环（永续；仅在选择界面执行实际工作）──
// 重入守卫：scheduleSelectSoon 与自然节拍可能撞车，并发 tick 会造成重复附着（日志"已连接"×N）
let selectBusy = false;
let selectPending = false;
function selectLoopStart() {
  clearTimeout(wakeTimer);
  selectTick = async () => {
    if (selectBusy) { wakeTimer = setTimeout(() => selectTick(), 600); return; }
    if ($('landing').style.display === 'none') {   // 配置页中空转（配置页零轮询，仅等推送）
      wakeTimer = setTimeout(() => selectTick(), 2000);
      return;
    }
    if (connecting) { wakeTimer = setTimeout(() => selectTick(), 800); return; }
    selectBusy = true;
    try {
      const known = await Leobog.knownDevices();
      const prevByKey = {};
      for (const c of cards) prevByKey[c.key] = c;
      cards = known.map(d => {
        const k = Leobog.devKey(d);
        const prev = prevByKey[k];
        return { dev: d, key: k, productName: d.productName, kind: Leobog.classify(d),
                 model: prev ? prev.model : null, state: prev ? prev.state : 'unknown' };
      });
      renderDeviceList();
      if (cards.length && recover) {
        // 恢复路径（休眠唤醒 / 拔插重现）：附着 → 探活 → 自动回配置页
        const target = (recoverKey && cards.find(c => c.key === recoverKey)) || cards[0];
        const cur = Leobog.state.dev;
        if (!(cur && cur.opened && cur === target.dev)) {
          const info = await Leobog.selectDevice(target.dev);
          S.channel = info.channel;
          setConnStatus(connStatusLine(info));
        }
        lastDevKey = target.key;
        const alive = target.kind === 'wired' ? true : await probeKeyboard();
        if (alive) {
          Leobog.log('设备已恢复——自动回到配置界面', 'ok');
          await enterFromDevice(2);
          // 不可提前 return：必须落入 finally 清 selectBusy，否则恢复守卫永久卡死（后台唤醒卡死根因）
        } else {
          target.state = 'sleep';
          renderDeviceList();
        }
      } else if (cards.length) {
        // 常规：轮流刷新一张卡片（型号/休眠状态）
        const c = cards[probeIdx % cards.length];
        probeIdx++;
        await probeCard(c);
        renderDeviceList();
      }
    } catch (e) { /* 下轮再试 */ }
    finally {
      selectBusy = false;                          // 所有路径（含恢复成功/异常）都必须释放守卫
    }
    if (selectPending) { selectPending = false; selectTick(); return; }
    wakeTimer = setTimeout(() => selectTick(), 1500);
  };
  wakeTimer = setTimeout(() => selectTick(), 500);
}

// ── 设备卡片点击：手动进入（唯一常规入口）──
$('landList').onclick = async e => {
  const row = e.target.closest('.dev-row');
  if (!row || connecting || selectBusy) return;     // 探测轮进行中不响应点击（稍后可再点）
  const c = cards[Number(row.dataset.i)];
  if (!c) return;
  const land = $('landBtn');
  row.classList.add('busy');
  land.disabled = true;
  connecting = true;
  recover = false;
  try {
    const info = await Leobog.selectDevice(c.dev);
    S.channel = info.channel;
    lastDevKey = c.key;
    setConnStatus(connStatusLine(info));
    await enterFromDevice(3);
  } catch (err) {
    $('landStatus').innerHTML = `<span class="bad">连接失败：${err.message || err}</span>`;
  } finally {
    connecting = false;
    land.disabled = false;
    row.classList.remove('busy');
  }
};

// 手动连接（系统选择器：仅用于首次授权/接入新设备；完成后回选择页，不自动进入）
async function manualConnect() {
  const btn = $('connectBtn'), land = $('landBtn');
  btn.disabled = true;
  if (land) { land.disabled = true; land.textContent = '正在连接…'; }
  try {
    await Leobog.connect();                        // 授权 + 附着
    recover = false;
    await Leobog.disconnect();                     // 仅完成授权，回选择页等点击
    setConnStatus('未连接');
    $('landStatus').innerHTML = '已授权——请在设备列表中点击进入';
    cards = [];
    scheduleSelectSoon();
  } catch (e) {
    Leobog.log('连接失败：' + (e.message || e), 'bad');
    if ($('landing').style.display !== 'none')
      $('landStatus').innerHTML = `<span class="bad">连接失败：${e.message || e}</span>`;
  } finally {
    btn.disabled = false;
    if (land) { land.disabled = false; land.textContent = '连接设备'; }
  }
}
$('connectBtn').onclick = async () => {
  if (Leobog.state.dev) {
    // 配置页主动退出 → 回选择界面（recover=false：不自动恢复，等手动点击）
    recover = false;
    stopMusic();
    S.channel = null;
    updateDirtyUI();
    await Leobog.disconnect();
    $('status').innerHTML = '未连接';
    $('connectBtn').textContent = '连接键盘';
    showLanding('已退出配置——点击设备卡片可再次进入');
    return;
  }
  await manualConnect();
};
$('landBtn').onclick = () => manualConnect();

// ── 存活探针：0x44 设置块读取——键盘侧应答（休眠必无回流=实证；在线必成功=全部会话实证）。
// 遥测0x4a 可能被 dongle 缓存应答（不可靠）；PSD 0x05 在线也会偶发 flake——都不用作判据。
async function probeKeyboard() {
  try {
    const r = await Leobog.wlRead(0x44, 0x0001, 1000, { expect: 10, quiet: true });
    return !!(r && r.length);
  } catch (e) { return false; }
}

// ── 休眠核验（仅由 dongle 推送触发，零轮询）──
// 判定失败即回选择页；若误判，选择页恢复轮探活成功会几秒内自动回配置页（自愈）
async function deviceProbe(strict) {
  const inWs = $('landing').style.display === 'none';
  if (!inWs) return;
  const busy = connecting || recover || MUS.on || applying ||
    $('refreshBtn').disabled;
  if (busy) return;
  if (!S.channel || S.channel !== 'wireless' || !Leobog.state.dev) return;
  if (strict) Leobog.log('[核验] 收到状态推送，查询键盘状态…', 'warn');
  const alive = await probeKeyboard();
  if (!alive) {
    Leobog.log('键盘无响应——判定已休眠，回到选择界面等待唤醒', 'warn');
    recover = true;
    recoverKey = lastDevKey;
    setConnStatus('<span class="warn">● 键盘休眠中</span>');
    showLanding('键盘已休眠——请按任意键唤醒，唤醒后自动恢复当前页面');
  } else if (strict) {
    Leobog.log('核验通过：键盘在线', 'ok');
  }
}

// 零轮询（与官方完全一致）：休眠/唤醒检测只由 dongle 推送触发，无任何周期性探测——
// 任何周期查询都会重置键盘空闲计时。推送形态与核验见 standingInput / probeKeyboard。
// dongle 主动推送（status: 'sleep'|'wake'|null；standingInput 已解码并打帧日志）。
// 官方语义：推送即状态，不主动核验——
//   sleep → 立即回选择页（recover=true，等唤醒）
//   wake + 在选择页(recover) → 立即跑恢复轮（探活通过才回配置页）
//   wake + 在配置页 → 忽略（竞争/误报）；未知状态 → 探测核验
// 忙时（音乐/写入/刷新）不丢弃、也不 setTimeout（后台会被节流到分钟级）——
// 挂 pendingUnsol，由空闲点（stopMusic/applyAll结束/刷新解除禁用）当场补跑。
function unsolAct(status) {
  if (status === 'sleep') {
    Leobog.log('休眠推送 → 回到选择界面等待唤醒', 'warn');
    recover = true;
    recoverKey = lastDevKey;
    setConnStatus('<span class="warn">● 键盘休眠中</span>');
    showLanding('键盘已休眠——请按任意键唤醒，唤醒后自动恢复当前页面');
  } else {
    // 未知形态推送（0a 01 00 04 07 …）会频繁来，30s 内不重复探活——每次探活都是一次 0x44 读，
    // 既刷屏又可能把键盘空闲计时一直重置掉（费电）。真休眠走 status==='sleep' 那条路，不受影响。
    if (Date.now() - (unsolAct._lastProbe || 0) < 30000) return;
    unsolAct._lastProbe = Date.now();
    deviceProbe(true).catch(() => {});             // 未知形态推送 → 探测核验兜底
  }
}
function flushPendingUnsol() {
  if (pendingUnsol === null) return;
  const st = pendingUnsol;
  pendingUnsol = null;
  // 仍在忙（音乐/写入/刷新）→ 继续挂起，等下一个空闲点再补
  if (MUS.on || applying || $('refreshBtn').disabled) return;
  // 已回到选择页：推送只影响恢复轮，无需再核验
  if ($('landing').style.display !== 'none') return;
  unsolAct(st);
}
Leobog.onUnsolicited = (status) => {
  const landing = $('landing').style.display !== 'none';
  if (landing) {
    // 选择页：立即跑一轮发现/恢复（selectBusy 内建重入守卫 + selectPending 补跑）
    if (selectBusy) selectPending = true; else selectTick();
    return;
  }
  if (status === 'wake') return;                   // 配置页中的唤醒推送无需动作
  if (MUS.on || applying || $('refreshBtn').disabled) {
    // 忙：挂起（后到的覆盖先到的——sleep 优先于未知；wake 在配置页已提前返回）
    if (pendingUnsol === null || status === 'sleep') pendingUnsol = status;
    return;
  }
  unsolAct(status);                                // 常态：零延迟当场处理（无定时器）
};
selectLoopStart();

// ── 切回前台对账（后台期间推送/定时器可能被 Chrome 冻结——前台第一时间纠偏）──
// 复用 deviceProbe / scheduleSelectSoon，重入守卫（selectBusy/connecting/applying）现成，无并发冲突。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (connecting || applying) return;              // 不打断进行中的连接/写入
  if ($('landing').style.display === 'none') {
    // 配置页：立刻核验一次（deviceProbe 内部跳过音乐中/无线以外）
    deviceProbe(true).catch(() => {});
  } else if (recover) {
    // 选择页 + 等待恢复：立刻跑一轮发现/恢复，不等 1.5s 节拍
    scheduleSelectSoon();
  }
});

// 打开页面：只发现展示、不自动进入（进入 = 点击卡片；自动仅限断连恢复）
(async () => {
  recover = false;
  let known = [];
  try { known = await Leobog.knownDevices(); } catch (e) {}
  if (!known.length)
    $('landStatus').innerHTML = '<span class="muted">首次连接请点击「连接设备」选择设备</span>';
  scheduleSelectSoon();
})();

async function afterModel() {
  stopMusic();                                 // 重读期间停流，避免和读命令抢通道
  // 重置编辑态（每次连接/换型后）
  S.kmDirty = [false, false, false, false];
  S.setOps = []; S.lightOps = []; S.lightSel = null; S.setDirty = false;
  S.colorDirty = false; S.sel = null; S.curLayer = 0;
  S.customInit = false;                              // 自定义画布随重读重建
  lastLayerOnTabs = 0;
  S.macroRaw = null; S.macroSlots = null; S.macroEditSlot = null;
  S.ledPush = false;
  closeMacroEditor();
  document.querySelectorAll('#layerTabs button').forEach((x, i) => x.classList.toggle('on', i === 0));
  closeEditor();
  // 设置块
  try {
    Leobog.log('读取设置块…');
    S.settings = await Leobog.readSettings();
    // 灯效关键字段（对照官方驱动写入用）：[10]=模式 [19]=颜色索引 [9]=自定义标志
    {
      const p = S.settings || [];
      const m = p[10];
      const bi = 58 + 2 * (Math.min(Math.max(m || 1, 1), 28) - 1);
      Leobog.log(`[设置] mode=${m} 自定义[9]=${p[9]} 颜色索引[19]=${p[19]} ` +
        `亮度[${bi}]=${p[bi] ?? '?'} 速度/多彩[${bi + 1}]=0x${((p[bi + 1] ?? 0) & 0xff).toString(16).padStart(2, '0')} ` +
        `[18..23]=${hexs(p.slice(18, 24))}`);
      if (DEBUG) Leobog.log('[设置HEX] ' + hexs(p), 'warn');
    }
    renderSettings();
    S.lightSel = S.settings[10];
    renderLight();
  } catch (e) {
    Leobog.log('设置读取失败：' + (e.message || e), 'bad');
    if ($('setKeys')) $('setKeys').innerHTML =
      `<span class="bad">设置读取失败：设备无响应。</span><br>` +
      `<span class="muted">请按任意键唤醒键盘，然后点「重新读取」。</span>`;
  }
  // 色帧（编辑灯色用；失败不影响其它功能）
  try {
    Leobog.log('读取色帧…');
    S.color = await Leobog.readColor();
    S.colorBase = S.color ? S.color.slice() : null;      // 底稿=设备当前逐键色
    if (S.color) {
      Leobog.log(`色帧 ${S.color.length}B ✅（非零槽 ${countNonzeroSlots(S.color)}）`);
      // 对照官方驱动：是否把整帧刷成同一颜色（首槽/尾槽 + 是否全同）
      let same = true;
      const r0 = S.color[0], g0 = S.color[1], b0 = S.color[2];
      for (let i = 3; i + 2 < S.color.length; i += 3) {
        if (S.color[i] !== r0 || S.color[i + 1] !== g0 || S.color[i + 2] !== b0) { same = false; break; }
      }
      const seen = new Map();
      for (let i = 0; i + 2 < S.color.length; i += 3) {
        const k = (S.color[i] << 16) | (S.color[i + 1] << 8) | S.color[i + 2];
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      const top = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, n]) => '#' + k.toString(16).padStart(6, '0') + '×' + n).join(' ');
      if (DEBUG) Leobog.log(`[色帧] 首槽=${hexs(S.color.slice(0, 3))} 尾槽=${hexs(S.color.slice(-3))} 全帧同色=${same ? '是' : '否'} 不同色=${seen.size} 主要=${top}`);
      // 列出所有点亮的像素（平面 RGB：像素=键表槽），对照"键盘实际哪些键亮"
      {
        const P = 126;
        const nz = [];
        for (let s = 0; s < P && s < S.color.length; s++) {
          const r = S.color[s] || 0, g = S.color[P + s] || 0, b = S.color[P * 2 + s] || 0;
          if (!r && !g && !b) continue;
          nz.push(`${s}:(${r},${g},${b})`);
        }
        Leobog.log(`[色帧] 点亮像素 ${nz.length}：${nz.slice(0, 24).join(' ')}${nz.length > 24 ? ' …' : ''}`);
      }
    }
  } catch (e) {
    S.color = null; S.colorBase = null;
    Leobog.log('色帧读取失败：' + (e.message || e) + '灯色编辑暂不可用', 'warn');
  }
  // 灯效参数块（0x8a/0x49）：只做体检，不参与写路径
  // 0x8a 读回时好时坏（实测连接瞬间偶尔返回全零/无 5A A5 的影子块）→ 不可信就重试一次，仍不可信只提示
  try {
    const sane = b => !!b && b.length >= 512 && b[506] === 0x5a && b[507] === 0xa5 && b.some(v => v !== 0);
    let led = await Leobog.readLed();
    if (!sane(led)) { await new Promise(r => setTimeout(r, 250)); led = await Leobog.readLed().catch(() => null); }
    if (!sane(led)) {
      Leobog.log('[LED] 参数块读回不可信（全零/无 5A A5），本次体检跳过（写色时会重新校验）', 'warn');
    } else {
      const nz = led.reduce((s, v) => s + (v ? 1 : 0), 0);
      if (DEBUG) Leobog.log(`[LED] 设备当前 [21..23]=${hexs(led.slice(21, 24))} · 模式色槽[42..44]=${hexs(led.slice(42, 45))} ` +
        `非零=${nz}/512 尾[504..511]=${hexs(led.slice(504, 512))}`, 'ok');
      else Leobog.log(`[LED] 参数块 OK（常亮槽 ${hexs(led.slice(21, 24))}）`, 'ok');
    }
  } catch (e) {
    Leobog.log('灯效参数块读取失败：' + (e.message || e), 'warn');
  }
  // 宏区（有线 0x85 / 无线 0x43；失败不影响其它功能）
  try {
    Leobog.log('读取宏区…');
    S.macroRaw = await Leobog.readMacro();
    renderMacro();
    // 原始字节日志（循环模式编码定位用）：目录 + 每槽记录 hex
    if (S.macroRaw) {
      Leobog.log(`[宏区] 目录: ${hexs(S.macroRaw.subarray(0, 32))}`);
      const slots = parseMacroArea(S.macroRaw);
      slots.forEach((m, i) => {
        if (!m) return;
        const o = S.macroRaw[i * 4] | (S.macroRaw[i * 4 + 1] << 8);
        const l = S.macroRaw[i * 4 + 2] | (S.macroRaw[i * 4 + 3] << 8);
        Leobog.log(`[宏区] 槽${i}「${m.name}」off=${o} len=${l} 记录: ${hexs(S.macroRaw.subarray(o, Math.min(o + l, o + 48)))}${l > 48 ? '…' : ''}`);
      });
    }
  } catch (e) {
    S.macroRaw = null;
    Leobog.log('宏区读取失败：' + (e.message || e), 'warn');
  }
  // 键表：有线 0x83 / 无线 0x41（协议层内部按通道选择；失败返回 null → 厂布局）
  for (let p = 0; p < 4; p++) S.keymap[p] = await Leobog.readKeymap(p);
  // 四页比对：全同 → block 页选择可能未生效
  {
    const got = S.keymap.filter(Boolean);
    if (got.length === 4) {
      let allSame = true;
      for (let i = 1; i < 4; i++) {
        for (let j = 0; j < 504; j++) {
          if (got[0][j] !== got[i][j]) { allSame = false; break; }
        }
        if (!allSame) break;
      }
      if (allSame) Leobog.log('⚠️ 四页键表前 504B 完全相同——请求 block 的页选择可能未生效（需换页寻址字节）', 'warn');
      else Leobog.log('四页键表内容互不相同 ✅（页选择生效）', 'ok');
    }
    // 扫描宏绑定记录 type03（循环模式编码定位用）
    S.keymap.forEach((p, pi) => {
      if (!p) return;
      for (let s = 0; s < 128; s++) {
        if (p[s * 4] === 0x03)
          Leobog.log(`[键表] 页${pi} 槽${s} 宏绑定: ${hexs(p.subarray(s * 4, s * 4 + 4))}`);
      }
    });
  }
  // 无线遥测
  $('telemetry').innerHTML = '';
  if (S.channel === 'wireless') {
    const t = await Leobog.readTelemetry();
    if (t && t.length >= 1) {
      $('telemetry').innerHTML = `电量：<b>${t[0]}%</b>`;
    }
  }
  renderKeymap(0);
  updateDirtyUI();
  $('refreshBtn').disabled = false;
  flushPendingUnsol();                             // 读取完成=空闲点：补跑忙时挂起的推送
  Leobog.log('已就绪：点键位可编辑，完成后点「应用修改」，写入后会读回校验', 'ok');
}

// ── 重新读取（复用已授权设备，免弹窗）────────────────────────
$('refreshBtn').onclick = async () => {
  const btn = $('refreshBtn');
  const dirty = S.kmDirty.some(Boolean) || S.setDirty || S.colorDirty;
  if (dirty && !confirm('有未应用的修改，重新读取会丢弃这些改动。继续？')) return;
  btn.disabled = true;
  try {
    if (!Leobog.state.dev) {
      Leobog.log('设备未连接，尝试复用已授权设备…');
      const info = await Leobog.connectExisting();
      S.channel = info.channel;
      $('status').innerHTML =
        `<span class="ok">● 已连接</span> ${info.productName} · ` +
        `<code>${info.channel === 'wired' ? '有线' : '无线 2.4G'}</code>`;
    }
    await afterModel();
    Leobog.log('已重新读取设备当前配置。若刚用过官方驱动，这里就是最新状态', 'ok');
  } catch (e) {
    Leobog.log('重新读取失败：' + (e.message || e), 'bad');
  } finally {
    btn.disabled = false;
    flushPendingUnsol();                           // 刷新结束=空闲点：补跑忙时挂起的推送
  }
};

// ── 设置渲染（可编辑表单；diff 在 collectSetOps 里相对 S.settings 计算）──
function renderSettings() {
  const p = S.settings;
  const host = $('setKeys');
  if (!host) return;
  if (!p || p.length < 128) { host.innerHTML = '<span class="bad">设置块不完整</span>'; return; }
  const magic = p[126] === 0x5a && p[127] === 0xa5;
  const tap = p[22], sleep = p[24];
  const seg = (name, vals, cur) => `<div class="seg" data-seg="${name}">` +
    vals.map(([v, t]) => `<button type="button" data-seg-val="${v}"${v === cur ? ' class="on"' : ''}>${t}</button>`).join('') +
    '</div>';
  const row = (op, k, v, note, wrap) => `<div class="set-row"${op ? ` data-op="${op}"` : ''}>
      <div class="set-k">${k}</div>
      <div class="set-v">${v}</div>
      <div class="set-n${wrap ? ' wrap' : ''}" title="${note}">${note}</div>
    </div>`;
  const hidden = (id, val) => `<input type="number" id="${id}" class="set-hidden" value="${val}">`;

  // 左栏：按键与手感
  $('setKeys').innerHTML = [
    row('debounce', '按键去抖',
      seg('debounce', [[0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4']], p[3]) + hidden('setDebounce', p[3]),
      '0~4 档，出厂 2 档。调太低可能出现按键双击。'),
    row('tap', 'Tap 开关',
      seg('tapon', [[0, '关'], [1, '开']], tap ? 1 : 0) +
      `<input type="checkbox" id="setTapOn" class="set-hidden"${tap ? ' checked' : ''}>` +
      `<input type="range" id="setTapVal" class="rng" min="10" max="127" step="1" value="${tap || 60}"${tap ? '' : ' disabled'}>` +
      '<span class="set-out" id="tapOut">—</span>',
      '设置 Tap 层触发延迟：开启后短按触发 Tap 层，长按超过设定时间触发默认层按键。', true),
  ].join('');

  // 中栏：设备行为
  $('setDev').innerHTML = [
    row('mode', '灯效 / 音量模式',
      seg('mode', [[1, '灯效模式'], [0, '音量模式']], p[26]) + hidden('setMode', p[26]),
      '决定旋钮用途：灯效模式调亮度，音量模式调音量。'),
    row('osmode', '系统模式',
      seg('osmode', [[0, 'Windows'], [1, 'Android'], [2, 'macOS']], p[27]) + hidden('setOsMode', p[27]),
      '决定 F 区与快捷键的映射，macOS 下左 Win 与左 Alt 互换。', true),
    row('sleep', '休眠档位',
      seg('sleepon', [[0, '关'], [1, '开']], sleep ? 1 : 0) +
      `<input type="checkbox" id="setSleepOn" class="set-hidden"${sleep ? ' checked' : ''}>` +
      `<input type="range" id="setSleep" class="rng" min="1" max="40" step="1" value="${sleep || 8}"${sleep ? '' : ' disabled'}>` +
      '<span class="set-out" id="sleepOut">—</span>',
      '在无线模式下，设备空闲指定的时间后会自动进入休眠状态。', true),
  ].join('');

  const magicEl = $('setMagic');
  if (magicEl) {
    magicEl.innerHTML = magic ? '<b class="ok">5A A5 ✅</b>' : `<span class="warn">${hexs(p.slice(126, 128))} ⚠️</span>`;
    magicEl.title = '原始 [0..31]：' + hexs(p.slice(0, 32));
  }
  updateSetReadouts();
  markDirtyRows();
}

// 滑杆/分段按钮 → 人话读数：Tap 阈值换算成时间，休眠档位换算成分秒
function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : Math.round(ms) + ' ms'; }
function fmtSec(s) {
  if (!s) return '关闭';
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60), r = s % 60;
  return m + ' 分' + (r ? ' ' + r + ' 秒' : '');
}
function updateSetReadouts() {
  const tapOn = $('setTapOn') ? $('setTapOn').checked : true;
  const tv = $('setTapVal') ? Number($('setTapVal').value) : 60;
  const tapRange = $('setTapVal');
  if (tapRange) tapRange.disabled = !tapOn;           // 关闭时滑杆置灰
  const tOut = $('tapOut');
  if (tOut) tOut.textContent = tapOn ? '约 ' + fmtMs(tv * 21) : '关闭';

  const sleepOn = $('setSleepOn') ? $('setSleepOn').checked : false;
  const sv = $('setSleep') ? Number($('setSleep').value) : 0;
  const sleepRange = $('setSleep');
  if (sleepRange) sleepRange.disabled = !sleepOn;
  const sOut = $('sleepOut');
  if (sOut) sOut.textContent = sleepOn ? fmtSec(sv * 30) : '关闭';

  document.querySelectorAll('#settings .seg').forEach(g => {
    const n = g.dataset.seg;
    const cur = n === 'debounce' ? Number($('setDebounce').value)
      : n === 'mode' ? Number($('setMode').value)
      : n === 'osmode' ? Number($('setOsMode').value)
      : n === 'tapon' ? (($('setTapOn') && $('setTapOn').checked) ? 1 : 0)
      : (($('setSleepOn') && $('setSleepOn').checked) ? 1 : 0);
    g.querySelectorAll('button').forEach(x => x.classList.toggle('on', Number(x.dataset.segVal) === cur));
  });
}

// 从设置表单全量重算待写操作（只管去抖/Tap/休眠；灯效类在 S.lightOps）
function collectSetOps() {
  const p = S.settings;
  if (!p || p.length < 128) return;
  const ops = [];
  const v = id => {                       // number input → valueAsNumber；<select> → Number(value)
    const el = $(id);
    if (!el) return NaN;
    return el.tagName === 'SELECT' ? Number(el.value) : el.valueAsNumber;
  };
  const debounce = v('setDebounce');
  if (Number.isInteger(debounce) && debounce !== p[3])
    ops.push({ key: '去抖', row: 'debounce', fn: b => { b[3] = debounce; } });
  const tapOn = $('setTapOn') ? $('setTapOn').checked : (p[22] !== 0);
  const raw = v('setTapVal');
  const tapVal = Number.isInteger(raw) ? Math.max(10, Math.min(127, raw)) : (p[22] || 60);
  const tapEff = tapOn ? tapVal : 0;
  if (Number.isInteger(tapEff) && tapEff !== p[22])
    ops.push({ key: 'Tap', row: 'tap', fn: b => { b[22] = tapEff; } });
  const modeEl = $('setMode');
  if (modeEl) {
    const mode = Number(modeEl.value);
    if (Number.isInteger(mode) && mode !== p[26])
      ops.push({ key: '灯效/音量模式', row: 'mode', fn: b => { b[26] = mode; } });
  }
  const osEl = $('setOsMode');
  if (osEl) {
    const os = Number(osEl.value);
    if (Number.isInteger(os) && os !== p[27])
      ops.push({ key: '系统模式', row: 'osmode', fn: b => { b[27] = os; } });
  }
  // 休眠：开关关 = 写 0；开 = 用滑杆档位（有线也能改，写入的是设置块本身）
  const sleepOn = $('setSleepOn') ? $('setSleepOn').checked : (p[24] !== 0);
  const sleepRaw = v('setSleep');
  const sleepVal = Number.isInteger(sleepRaw) && sleepRaw > 0 ? sleepRaw : (p[24] || 8);
  const sleepEff = sleepOn ? sleepVal : 0;
  if (Number.isInteger(sleepEff) && sleepEff !== p[24])
    ops.push({ key: '休眠', row: 'sleep', fn: b => { b[24] = sleepEff; } });
  S.setOps = ops;
  S.setDirty = ops.length > 0 || S.lightOps.length > 0;
  markDirtyRows();
  updateDirtyUI();
}

function markDirtyRows() {
  const rows = new Set(S.setOps.map(o => o.row));
  document.querySelectorAll('#settings .set-row[data-op]').forEach(tr => {
    if (!tr.dataset.op) return;
    tr.classList.toggle('dirty', rows.has(tr.dataset.op));
  });
}

// ── 灯效页（官方功能：左=模式表格点选即暂存｜右=亮度/速度/多彩 + PS 调色盘）──
// 设置块： [10]=模式（KB.ini LedOpt 第 1 列 = 模型 hwId）、[58+2*(k-1)]=(速度<<4)|多彩、
//          [19]=7 色索引（Fn 快捷键预设起点：红绿蓝黄紫青白 / 7=多彩，exe 0x493378 映射）
// 参数块： 19 组×7 色，模式 k 的自定义色槽 = [21+(k-1)*21 .. +2]（常亮 [21..23]、呼吸 [42..44]、模式11 [231..233]）
// KB.ini LedOpt 七字段 = [hw, effect, 速度, 亮度, direct, 多彩, 颜色]；color=0 的模式官方 UI
// 直接隐藏调色盘 = 固定彩虹（3 梦幻彩虹 / 15 旋转风车 / 16 七彩瀑布 / 17 花开富贵），单色/多彩均不生效
const LIGHT_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
// 固件未实现：KB.ini 里仍列着，但 Hi8 固件写入 [10]=9/14/18 后设备不接受（实测仍停在原模式），
// 官方驱动也不列出这三项 → 网格隐藏。有效 17 项 = 15 动效 + 自定义 + 关闭，与旋钮短按循环 17 种一致。
const LIGHT_FW_UNSUPPORTED = new Set([9, 14, 18]);   // 踏雪无痕 / 左右扫描 / 旋转风暴
// 预设色表：设置块 [19] 用它（exe 0x493378 的 COLORREF→索引 0..6，7=多彩；固件色表 @0x3122 同序）。
// [19] 只负责 Fn 快捷键循环的起点；真正的模式颜色在参数块各模式色槽里（见 stageLightColor）。
const LED_PRESETS = [
  { idx: 0, rgb: [255, 0, 0], name: '红' },
  { idx: 1, rgb: [0, 255, 0], name: '绿' },
  { idx: 2, rgb: [0, 0, 255], name: '蓝' },
  { idx: 3, rgb: [255, 255, 0], name: '黄' },
  { idx: 4, rgb: [255, 0, 255], name: '紫' },
  { idx: 5, rgb: [0, 255, 255], name: '青' },
  { idx: 6, rgb: [255, 255, 255], name: '白' },
];
function nearestLedPreset(rgb) {
  let best = 0, bd = Infinity;
  for (const p of LED_PRESETS) {
    const d = (p.rgb[0] - rgb[0]) ** 2 + (p.rgb[1] - rgb[1]) ** 2 + (p.rgb[2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = p.idx; }
  }
  return best;
}
// 快捷色（面板色块）：hex + 对应设备索引
const CP_PRESETS = [
  { hex: '#ff0000', name: '红' },
  { hex: '#00ff00', name: '绿' },
  { hex: '#0000ff', name: '蓝' },
  { hex: '#00ffff', name: '青' },
  { hex: '#ff00ff', name: '紫' },
  { hex: '#ffff00', name: '黄' },
  { hex: '#ffffff', name: '白' },
];

function lightParamIdx(hw) {
  const m = Math.min(Math.max(hw || 1, 1), 28);
  return { bIdx: 58 + 2 * (m - 1), sIdx: 58 + 2 * (m - 1) + 1 };
}

// 模式能力位（KB.ini LedOpt：speed/light/direct/random/color）。
// color=0 的模式官方 UI 直接隐藏调色盘 = 固定彩虹，单色/多彩均不生效。
// sel = 设置块[10] 的模式值 = LedOpt 第 1 列（模型 hwId）；index 仅作旧数据兜底。
function lightCap(sel) {
  const opts = (S.model ? S.model.ledOptions : []);
  const o = opts.find(x => x.hwId === sel) || opts.find(x => x.index === sel);
  const f = o && o.fields;
  return {
    speed: f ? f[2] === 1 : true,
    light: f ? f[3] === 1 : true,
    random: f ? f[5] === 1 : true,
    color: f ? f[6] === 1 : true,
  };
}

// ── 颜色工具：hex ↔ rgb ↔ hsv ──
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx];
}
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// 调色盘状态：S.lightColor='#rrggbb'；S.lightHsv=[h,s,v] 为拖拽源状态（防 hex 往返量化漂移）
function lightColor() {
  return S.lightColor || '#66ccff';
}
// 调色盘下方的提示文案（随模式/多彩状态变化；取色自动转单色时也要跟着刷新）
function lightHintText() {
  const sel = S.lightSel;
  const p = S.settings;
  if (!p || p.length < 128) return '';
  const disp = p.slice();
  for (const op of S.lightOps) { try { op.fn(disp); } catch (e) {} }
  const { sIdx } = lightParamIdx(sel);
  const cap = lightCap(sel);
  const pickOff = sel !== 21 && !cap.color;
  const noParam = sel === 0 || sel === 21;
  const rd = !noParam && (disp[sIdx] & 0x0f) !== 0;
  let hint;
  if (sel === 0) hint = '灯效已关闭。启用任一灯效模式后，可在此调节颜色。';
  else if (pickOff) hint = '该灯效由键盘固件生成固定彩虹效果，不支持单色与多彩调节。';
  else if (sel === 21) hint = '逐键上色：点击或拖选按键上色；同色再点可擦除；「橡皮」开启后为擦除。';
  else if (rd) hint = '已启用多彩：灯光颜色将随机变化；选取具体颜色会自动切换回单色。';
  else hint = `所选颜色将应用于「${lightModeName(sel)}」模式的单色效果。`;
  // 4/7 是按键触发类：预览里不点击就不会亮，明确提示一下（模式 13 自动扩散）
  if (sel === 4) hint += ' 预览中点击键盘按键，从该键所在行向左右扩散。';
  else if (sel === 7) hint += ' 预览中点击键盘按键，从该键向外扩散涟漪。';
  else if (sel === 13) hint += ' 预览为固件正弦波自动扩散。';
  else if (sel === 5) hint += ' 预览为固件雨滴：每帧随机一列起雨，自上而下。';
  else if (sel === 6) hint += ' 预览为固件彩虹轮盘：逐键相位差旋转。';
  else if (sel === 8) hint += ' 预览为固件繁星：随机点亮并呼吸明灭。';
  else if (sel === 10) hint += ' 预览为固件流动光点：对角折返并拖尾。';
  else if (sel === 12) hint += ' 预览按住键盘按键亮起，松开后淡出。';
  else if (sel === 15) hint += ' 预览为固件风车色环。';
  return hint;
}

// 用户取色前：多彩开着就先关掉（单色路径 = 设置块 flags 低 3 位写 0；官方实测 0x47→0x40）。
function ensureSingleColor() {
  const rdEl = $('ltMulti');
  if (!rdEl || !rdEl.classList.contains('on')) return;
  rdEl.classList.remove('on');
  stageLightOps();                                  // 暂存 flags = 0
  // 只刷新提示/预览，不整块重绘（拖拽取色时重绘会丢 pointer）
  const h = $('cpHint');
  if (h) h.textContent = lightHintText();
  const pv = $('ltPreview');
  if (pv) { pv.classList.remove('lt-multi'); pv.style.background = lightColor(); pv.title = '单色：使用调色盘当前颜色'; }
  Leobog.log('取色会自动关闭「多彩」，按单色写入，设置块 flags=0', 'ok');
}
function setLightColor(hex, opts = {}) {
  ensureSingleColor();
  S.lightColor = hex;
  S.lightHsv = rgbToHsv(...hexToRgb(hex));
  if (!opts.fromPreset) S.lightPresetIdx = null;   // 手动取色 → 快捷色高亮失效
  if (opts.regen !== false) updateColorPicker();
  if (!opts.noStage) stageLightColor();
}
function setLightColorHsv(h, s, v) {
  ensureSingleColor();
  S.lightHsv = [h, s, v];
  const [r, g, b] = hsvToRgb(h, s, v);
  S.lightColor = rgbToHex(r, g, b);
  S.lightPresetIdx = null;
  updateColorPicker();
  stageLightColor();
}
// 原位刷新调色盘（拖拽时不整块重绘，避免 pointer 丢失）
function updateColorPicker() {
  const hex = lightColor();
  const [r, g, b] = hexToRgb(hex);
  const [hh, ss, vv] = S.lightHsv || rgbToHsv(r, g, b);
  const sw = $('cpSwatch');
  if (sw) sw.style.background = hex;
  const pv = $('ltPreview');
  if (pv) pv.style.background = hex;
  const hx = $('cpHex');
  if (hx && document.activeElement !== hx) hx.value = hex;
  const sv = $('cpSV');
  if (sv) sv.style.background = `hsl(${hh},100%,50%)`;
  const dot = $('cpSVDot');
  if (dot) { dot.style.left = (ss * 100) + '%'; dot.style.top = ((1 - vv) * 100) + '%'; }
  const hd = $('cpHueDot');
  if (hd) hd.style.top = ((hh / 360) * 100) + '%';
  const pairs = [['cpR', 'cpRn', r], ['cpG', 'cpGn', g], ['cpB', 'cpBn', b]];
  for (const [rid, nid, v] of pairs) {
    const ri = $(rid), ni = $(nid);
    if (ri && document.activeElement !== ri) ri.value = v;
    if (ni && document.activeElement !== ni) ni.value = v;
  }
}

// 单色（多彩关）：暂存 RGB。官方抓包实证（hid_color_wired.log 常亮 + hid_color_fx.log 呼吸）：
// 参数块 = 19 组×7 色，模式 k 的自定义色槽 = [21+(k-1)*21 .. +2]（常亮 k=1 → [21..23]，
// 呼吸 k=2 → [42..44]，随波逐流 k=11 → [231..233]）。自定义模式走 378B 色帧整帧刷色。
function stageLightColor() {
  const rdEl = $('ltMulti');
  if (rdEl && rdEl.classList.contains('on')) {
    S.ledColorRgb = null; S.ledColorSlot = null;
    return;
  }
  if (S.lightSel == null) return;
  if (S.lightSel !== 21 && !lightCap(S.lightSel).color) {
    S.ledColorRgb = null; S.ledColorSlot = null;                 // 固定彩虹模式无单色：撤销待写色
    S.lightPresetIdx = null;
    updateDirtyUI();
    return;
  }
  const hex = lightColor();
  const rgb = hexToRgb(hex);
  // [19] 预设索引（Fn 快捷键起点；官方写设置块时保留该值）——只有效果/常亮模式写
  S.lightOps = S.lightOps.filter(o => o.row !== 'ltColorIdx');
  if (S.lightSel !== 21) {
    const idx = nearestLedPreset(rgb);
    S.lightOps.push({ key: `灯色索引 ${LED_PRESETS[idx].name}`, row: 'ltColorIdx',
      fn: b => { b[19] = idx; } });
  }
  if (S.lightSel === 21) {
    // 自定义：画笔式——改调色盘颜色不会回头改已涂的键，只有点击/划选才上色
    S.ledColorRgb = null; S.ledColorSlot = null;
    paintCustomKeys();
  } else {
    S.ledColorRgb = rgb;
    S.ledColorSlot = S.lightSel;                                 // 颜色槽按模式：21+(mode-1)*21
    paintCustomKeys();                                           // 离开自定义模式时摘掉上色画布样式
  }
  updateDirtyUI();
}

// ── 自定义模式（hw=21）：键盘点选/划选上色，未选中=熄灭 ──
// 色帧 378B = **三平面 planar RGB**（exe 抓包 hid_row1.log 差分实证）：
//   R 平面 = [0..125]，G 平面 = [126..251]，B 平面 = [252..377]；**像素下标 = 键表槽**。
//   例：Space(键表槽35) 设红 → 只有字节 35 = 255；数字行 "1"(槽7) → 字节 7/133/259。
const FRAME_PLANE = 126;
function inCustomColorMode() {
  return S.section === 'light' && S.lightSel === 21 && !!S.model;
}
// 画笔式：所有上色只改本地工作帧 S.color，最后统一「应用修改」一次写入
function paintCustomKeys() {
  const host = $('keyboard');
  if (!host) return;
  const kb = host.querySelector('.kb') || host;      // 样式类要挂在 .kb 上（CSS: .kb.color-mode .key）
  const on = inCustomColorMode();
  kb.classList.toggle('color-mode', on);
  if (!on) return;
  document.querySelectorAll('#keyboard .key').forEach(el => {
    el.style.setProperty('--cs', frameColorAt(Number(el.dataset.slot)));
  });
  updatePaintCount();
}
// 当前工作帧里某键的颜色（#rrggbb；全 0 = 熄灭）
function frameColorAt(slot) {
  const f = S.color || S.colorBase;
  if (!f || slot < 0 || slot >= FRAME_PLANE) return '#000';
  const r = f[slot] || 0, g = f[FRAME_PLANE + slot] || 0, b = f[FRAME_PLANE * 2 + slot] || 0;
  return (r || g || b) ? rgbToHex(r, g, b) : '#000';
}
// 涂 / 擦一个键（只改本地帧；hex=null 表示擦除）
function setKeyColor(slot, hex) {
  if (!S.color || !(slot >= 0 && slot < FRAME_PLANE)) return;
  const [r, g, b] = hex ? hexToRgb(hex) : [0, 0, 0];
  S.color[slot] = r;
  S.color[FRAME_PLANE + slot] = g;
  S.color[FRAME_PLANE * 2 + slot] = b;
  S.colorDirty = true;
  const el = document.querySelector(`#keyboard .key[data-slot="${slot}"]`);
  if (el) el.style.setProperty('--cs', hex || '#000');
  updatePaintCount();
  updateDirtyUI();
}
// 已涂（非黑）键数：只统计模型里的键
function paintedCount() {
  if (!S.color || !S.model) return 0;
  let n = 0;
  for (const k of S.model.keys) if (frameColorAt(k.slot) !== '#000') n++;
  return n;
}
function updatePaintCount() {
  const n = $('csCount');
  if (n) n.textContent = String(paintedCount());
}
// 进入自定义模式：工作帧=设备当前逐键色；调色盘默认取出现最多的颜色
function initCustomCanvas() {
  if (!S.colorBase && S.color) S.colorBase = S.color.slice();
  S.color = S.colorBase ? S.colorBase.slice() : new Uint8Array(FRAME_PLANE * 3);
  S.colorDirty = false;
  const counts = new Map();
  for (const k of (S.model ? S.model.keys : [])) {
    const hex = frameColorAt(k.slot);
    if (hex === '#000') continue;
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  if (counts.size) {
    const [hex] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    setLightColor(hex, { noStage: true });
  }
  paintCustomKeys();
  updateDirtyUI();
}

// 快捷色：与手动取色等价（只改当前模式色槽 + [19] 预设索引）。
function stageLightPreset(p) {
  if (!p || S.lightSel == null || S.lightSel === 0) return;
  if (S.lightSel !== 21 && !lightCap(S.lightSel).color) {
    Leobog.log('该模式为固定彩虹效果，官方 UI 不提供选色，单色不生效', 'warn');
    return;
  }
  const pi = CP_PRESETS.indexOf(p);
  S.lightPresetIdx = pi >= 0 ? pi : null;
  setLightColor(p.hex, { fromPreset: true });
  if (S.lightSel === 21) {
    Leobog.log(`快捷色「${p.name}」→ 自定义模式选中键（RGB ${p.hex}），点「应用修改」写入`, 'ok');
  } else {
    const off = 21 + (Math.min(Math.max(S.lightSel, 1), 19) - 1) * 21;
    Leobog.log(`快捷色「${p.name}」已暂存（RGB ${p.hex} → 模式${S.lightSel}色槽[${off}..${off + 2}]），点「应用修改」写入`, 'ok');
  }
  renderLightParams();
}

function renderLight() {
  const modesHost = $('lightModes');
  if (!modesHost) return;
  const p = S.settings;
  if (!p || p.length < 128) {
    modesHost.innerHTML = '<span class="bad">设置块不可用</span>';
    if ($('lightParams')) $('lightParams').innerHTML = '';
    return;
  }
  const disp = p.slice();
  for (const op of S.lightOps) { try { op.fn(disp); } catch (e) {} }
  const cur = p[10];
  const curBad = LIGHT_FW_UNSUPPORTED.has(cur);      // 设备当前停在固件不支持的模式
  if (S.lightSel == null || LIGHT_FW_UNSUPPORTED.has(S.lightSel)) S.lightSel = curBad ? 1 : cur;
  const sel = S.lightSel;
  const opts = (S.model ? S.model.ledOptions : []);
  // 左：模式表格铺满；点击即暂存
  const items = [];
  for (const i of LIGHT_ORDER) {
    const o = opts.find(x => x.index === i);
    if (!o || LIGHT_FW_UNSUPPORTED.has(o.hwId)) continue;   // 固件不支持 → 不渲染
    const hw = o.hwId;
    items.push(`<button type="button" class="lt-mode${sel === hw ? ' on' : ''}${cur === hw ? ' cur' : ''}"` +
      ` data-mode="${hw}" title="hwId=${hw}${cur === hw ? ' · 设备当前' : ''}">${o.name}</button>`);
  }
  modesHost.innerHTML = `<div class="lt-grid">${items.join('')}</div>`;
  renderLightNotes();
  // 设备本来就在自定义模式时，首次进入灯效页也要恢复选中集（非黑槽=已上色）
  if (sel === 21 && !S.customInit) { initCustomCanvas(); S.customInit = true; }
  if (sel !== 21) S.customInit = false;
  renderLightParams();
  paintCustomKeys();
  updatePreview();
}

// 模式编号 → 选项名称（界面一律显示名称，不显示 11 这类编号）
function lightModeName(hw) {
  if (hw == null) return '—';
  if (hw === 21) return '自定义';
  if (hw === 0) return '关闭';
  const o = (S.model && S.model.ledOptions || []).find(x => x.hwId === hw);
  return o ? o.name.replace(/模式$/, '') : `模式 ${hw}`;
}

// 左栏说明：设备/本地模式、能力、保存方式与脏标记（跟着参数变化实时刷新）
function renderLightNotes() {
  const host = $('ltNotes');
  if (!host || !S.model) return;
  const sel = S.lightSel;
  const cur = S.settings ? S.settings[10] : null;
  const cap = lightCap(sel);
  const capNames = [['speed', '速度'], ['light', '亮度'], ['random', '多彩'], ['color', '单色']]
    .filter(([k]) => cap[k]).map(([, n]) => n);
  const capText = sel === 0 ? '灯效已关闭' : sel === 21 ? '逐键自定义颜色'
    : (capNames.length ? capNames.join('、') : '无');
  const pickOff = sel !== 21 && !cap.color;
  const noParam = sel === 0 || sel === 21;
  const curBad = cur != null && LIGHT_FW_UNSUPPORTED.has(cur);
  const dirty = S.lightOps.length > 0 || S.colorDirty || !!S.ledColorRgb;
  host.innerHTML = `
    <div class="lt-note">设备当前模式：<b>${lightModeName(cur)}</b>${curBad
      ? ' <span class="warn">固件不支持，请切换</span>' : ''} · 本地待写入：<b>${lightModeName(sel)}</b>。修改即时暂存。${dirty
      ? '<span class="badge">存在未应用的灯效修改</span>' : ''}</div>
    <div class="lt-note">当前模式支持：<b>${capText}</b>${pickOff ? '，固定彩虹效果，不提供选色与多彩' : ''}；亮度、速度与多彩按模式独立保存${noParam ? '；当前模式没有可调参数' : ''}。</div>`;
}

function renderLightParams() {
  const lp = $('lightParams');
  if (!lp) return;
  const p = S.settings;
  if (!p || p.length < 128) { lp.innerHTML = ''; return; }
  const disp = p.slice();
  for (const op of S.lightOps) { try { op.fn(disp); } catch (e) {} }
  const sel = S.lightSel;
  const { bIdx, sIdx } = lightParamIdx(sel);
  const br = disp[bIdx], sp = disp[sIdx] >> 4;
  const noParam = sel === 0 || sel === 21;
  const cap = lightCap(sel);
  const pickOff = sel !== 21 && !cap.color;          // 固定彩虹模式：无选色/多彩
  const rd = !noParam && (disp[sIdx] & 0x0f) !== 0;  // 低 3 位：7=多彩 / 0=单色（官方实写值）
  const dirtyMode = S.lightOps.some(o => o.row === 'ltMode');
  const dirtyParam = S.lightOps.some(o => o.row === 'ltBright' || o.row === 'ltSpeed');
  const hex = lightColor();
  const [r, g, b] = hexToRgb(hex);
  if (!S.lightHsv) S.lightHsv = rgbToHsv(r, g, b);
  const [hh, ss, vv] = S.lightHsv;
  // SV 面板：背景=当前色相；白/黑渐变叠加；点选圆点位置
  const svX = ss * 100, svY = (1 - vv) * 100;
  const stPr = S.lightPresetIdx;                      // 快捷色高亮（数组下标，纯 UI）
  const presets = CP_PRESETS.map((p, i) =>
    `<button type="button" class="cp-preset${stPr === i ? ' on' : ''}"` +
    ` data-i="${i}" style="background:${p.hex}" title="${p.name}"></button>`).join('');
  // 能力位提示：本模式官方允许哪些参数（缺省项控件已置灰）
  const capNames = [['speed', '速度'], ['light', '亮度'], ['random', '多彩'], ['color', '单色']]
    .filter(([k]) => cap[k]).map(([, n]) => n);
  const capText = capNames.length ? capNames.join('、') : '无';
  const hintText = lightHintText();
  lp.innerHTML = `
    <div class="cp" id="ltPicker"${pickOff || sel === 0 ? ' style="opacity:.45;pointer-events:none"' : ''}>
      <div>
        <div class="cp-sv" id="cpSV" style="background:hsl(${hh},100%,50%)">
          <div class="cp-sv-white"></div><div class="cp-sv-black"></div>
          <div class="cp-sv-dot" id="cpSVDot" style="left:${svX}%;top:${svY}%"></div>
        </div>
      </div>
      <div class="cp-hue" id="cpHue">
        <div class="cp-hue-dot" id="cpHueDot" style="top:${(hh / 360) * 100}%"></div>
      </div>
      <div class="cp-side">
        <div class="cp-preview">
          <div class="cp-swatch" id="cpSwatch" style="background:${hex}"></div>
          <input class="cp-hex" id="cpHex" value="${hex}" spellcheck="false" title="十六进制颜色值">
        </div>
        <div class="cp-rgb">
          <span>R</span><input type="range" id="cpR" min="0" max="255" value="${r}">
          <input type="number" id="cpRn" min="0" max="255" value="${r}">
          <span>G</span><input type="range" id="cpG" min="0" max="255" value="${g}">
          <input type="number" id="cpGn" min="0" max="255" value="${g}">
          <span>B</span><input type="range" id="cpB" min="0" max="255" value="${b}">
          <input type="number" id="cpBn" min="0" max="255" value="${b}">
        </div>
        <div class="cp-presets"${(sel === 0 || pickOff) ? ' style="opacity:.45;pointer-events:none"' : ''}>${presets}</div>
        <div class="muted cp-hint" id="cpHint">${hintText}</div>
      </div>
      <div class="cp-tools">
        <div class="cp-tools-h">渲染方式</div>
        <div class="cp-multi-row">
          <button type="button" id="ltMulti" class="${rd ? 'on' : ''}"${(noParam || !cap.random) ? ' disabled' : ''}>多彩</button>
          ${rd
            ? `<span class="lt-preview lt-multi" id="ltPreview" title="多彩：颜色随机变化"></span>`
            : `<span class="lt-preview" id="ltPreview" title="单色：使用调色盘当前颜色" style="background:${hex}"></span>`}
        </div>
        ${sel === 21 ? `<div class="cp-tools-h" style="margin-top:4px">逐键画笔</div>
        <div class="cs-bar col">
          <span class="muted">已上色 <b id="csCount">${paintedCount()}</b> 键</span>
          <button type="button" data-cs="fill">填充全部</button>
          <button type="button" data-cs="clear">全部熄灭</button>
          <button type="button" data-cs="eraser" class="${S.eraser ? 'on' : ''}" title="启用后，点击或拖选按键执行擦除">橡皮</button>
        </div>` : ''}
      </div>
    </div>
    ${(cap.light || cap.speed) ? `<div class="lt-sliders">
      ${cap.light ? `<label class="lt-slider">亮度
        <input type="range" id="ltBright" min="0" max="4" step="1" value="${br}">
        <span class="lt-val" id="ltBrightVal">${br}</span></label>` : ''}
      ${cap.speed ? `<label class="lt-slider">速度
        <input type="range" id="ltSpeed" min="0" max="4" step="1" value="${sp}">
        <span class="lt-val" id="ltSpeedVal">${sp}</span></label>` : ''}
    </div>` : ''}`;
  bindColorPicker();
  renderLightNotes();          // 能力/脏标记在左栏，随参数变化刷新
}

// PS 调色盘交互：SV 面板 / 色相条拖拽用 HSV 源状态；RGB/Hex/预设走 hex
function bindColorPicker() {
  const sv = $('cpSV'), hue = $('cpHue');
  if (!sv || !hue) return;
  if (!S.lightHsv) S.lightHsv = rgbToHsv(...hexToRgb(lightColor()));
  const svPos = e => {
    const r = sv.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    setLightColorHsv(S.lightHsv[0], x, 1 - y);      // 色相固定，只改 S/V——点跟手不漂
  };
  const huePos = e => {
    const r = hue.getBoundingClientRect();
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    setLightColorHsv(y * 360, S.lightHsv[1] || 1, S.lightHsv[2] || 1);
  };
  const drag = (el, fn) => {
    let on = false;
    el.addEventListener('pointerdown', e => {
      on = true; el.setPointerCapture(e.pointerId); fn(e); e.preventDefault();
    });
    el.addEventListener('pointermove', e => { if (on) fn(e); });
    el.addEventListener('pointerup', () => { on = false; });
    el.addEventListener('pointercancel', () => { on = false; });
  };
  drag(sv, svPos);
  drag(hue, huePos);
  const syncRgb = (r, g, b) => setLightColor(rgbToHex(r, g, b));
  ['cpR', 'cpG', 'cpB'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      syncRgb(Number($('cpR').value), Number($('cpG').value), Number($('cpB').value));
    });
  });
  ['cpRn', 'cpGn', 'cpBn'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      const clamp = x => Math.max(0, Math.min(255, Number(x) | 0));
      syncRgb(clamp($('cpRn').value), clamp($('cpGn').value), clamp($('cpBn').value));
    });
  });
  const hx = $('cpHex');
  if (hx) hx.addEventListener('change', () => {
    let v = hx.value.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(v)) v = v.split('').map(c => c + c).join('');
    if (/^[0-9a-fA-F]{6}$/.test(v)) setLightColor('#' + v.toLowerCase());
    else renderLightParams();
  });
  const host = $('ltPicker');
  if (host) host.addEventListener('click', e => {
    const pr = e.target.closest('.cp-preset');
    if (pr) stageLightPreset(CP_PRESETS[Number(pr.dataset.i)]);
  });
}

// 暂存 亮度/速度/多彩
function stageLightOps() {
  const p = S.settings;
  if (!p || p.length < 128) return;
  const m = S.lightSel;
  if (m === 0 || m === 21) return;
  const { bIdx, sIdx } = lightParamIdx(m);
  // 亮度/速度在不支持的模式下是隐藏的（不是置灰）：缺控件就以设备当前值为准
  const brEl = $('ltBright'), spEl = $('ltSpeed'), rdEl = $('ltMulti');
  const br = brEl ? Number(brEl.value) : p[bIdx];
  const sp = spEl ? Number(spEl.value) : (p[sIdx] >> 4);
  const rd = rdEl ? rdEl.classList.contains('on') : ((p[sIdx] & 0x0f) !== 0);
  // 按模式各存一份（切模式回来仍保留该模式未应用的改动）
  S.lightOps = S.lightOps.filter(o => !((o.row === 'ltBright' || o.row === 'ltSpeed') && o.m === m));
  if (Number.isInteger(br) && br !== p[bIdx])
    S.lightOps.push({ key: `亮度 ${m}`, row: 'ltBright', m, fn: b => { b[bIdx] = br; } });
  // 低 3 位 = 多彩标志：官方「多彩」开关整字节写 7（开）/ 0（关），不是只翻 bit0
  // （hid_p4.log 17:02 随机开关 0x47↔0x40；hid_color_wired.log w1 同为 0x47→0x40）。
  const curRd = (p[sIdx] & 0x0f) !== 0;
  if ((Number.isInteger(sp) && sp !== (p[sIdx] >> 4)) || rd !== curRd)
    S.lightOps.push({ key: `速度/多彩 ${m}`, row: 'ltSpeed', m,
      fn: b => { b[sIdx] = (sp << 4) | (rd ? 0x07 : 0x00); } });
  S.setDirty = S.setOps.length > 0 || S.lightOps.length > 0;
  updateDirtyUI();
}

function stageLightMode(hw) {
  if (LIGHT_FW_UNSUPPORTED.has(hw)) { Leobog.log(`模式 ${hw} 固件不支持（实测写入无效），已跳过`, 'bad'); return; }
  S.lightSel = hw;
  S.lightOps = S.lightOps.filter(o => o.row !== 'ltMode');
  // 选回设备当前模式 = 没有改动，不再挂"待写入"（避免什么都没改也提示未应用）
  const curMode = S.settings ? S.settings[10] : null;
  if (hw !== curMode) {
    S.lightOps.push({ key: '灯效模式', row: 'ltMode', fn: b => {
      b[10] = hw;
      if (hw === 21) b[9] = 1;
      else if (b[9] === 1) b[9] = 0;
    } });
  }
  // 切模式不连带写颜色：每个模式在参数块里有自己的颜色槽，切模式时写"当前调色盘颜色"
  // 会把该模式原有颜色冲掉（实测：模式2 的 00 23 ff 被切成 ff 00 00）。只有用户主动取色才写。
  S.ledColorRgb = null; S.ledColorSlot = null;
  S.lightOps = S.lightOps.filter(o => o.row !== 'ltColorIdx');
  if (hw === 21) {
    S.lightPresetIdx = null;
    if (!S.customInit) { initCustomCanvas(); S.customInit = true; }   // 工作帧=设备当前色
  } else {
    S.customInit = false;
  }
  S.setDirty = S.setOps.length > 0 || S.lightOps.length > 0;
  updateDirtyUI();
  Leobog.log(`灯效：暂存切换到模式 ${hw}${hw === 21 ? '自定义色' : hw === 0 ? '已关闭' : ''}，点「应用修改」写入`, 'ok');
  renderLight();
}

$('lightModes').onclick = e => {
  const b = e.target.closest('.lt-mode');
  if (!b) return;
  stageLightMode(Number(b.dataset.mode));
};
$('lightParams').addEventListener('input', e => {
  if (e.target.id === 'ltBright') {
    const v = $('ltBrightVal');
    if (v) v.textContent = e.target.value;
    stageLightOps();
  } else if (e.target.id === 'ltSpeed') {
    const v = $('ltSpeedVal');
    if (v) v.textContent = e.target.value;
    stageLightOps();
  }
});
// 自定义模式：全选/清空/反选
function handleCsAction(a) {
  const m = S.model;
  if (!m) return;
  if (a === 'eraser') {
    S.eraser = !S.eraser;
    const b = document.querySelector('[data-cs="eraser"]');
    if (b) b.classList.toggle('on', S.eraser);
    Leobog.log(S.eraser ? '橡皮：开，点击或划选即擦除' : '橡皮：关，点击或划选即上色', 'ok');
    return;
  }
  const all = m.keys.map(k => k.slot);
  if (a === 'fill') {
    if (!S.color) return;
    for (const s of all) setKeyColor(s, lightColor());
  } else if (a === 'clear') {
    if (!S.color) return;
    for (const s of all) setKeyColor(s, null);
  }
  paintCustomKeys();
  updateDirtyUI();
}

$('lightParams').addEventListener('click', e => {
  const cs = e.target.closest('[data-cs]');
  if (cs) { handleCsAction(cs.dataset.cs); return; }
  if (e.target.id === 'ltMulti') {
    e.target.classList.toggle('on');
    stageLightOps();
    if (e.target.classList.contains('on')) {
      // 开多彩：清单色暂存。色带本就是出厂彩虹（官方从不填色带），无需重推参数块
      S.ledColorRgb = null;
      updateDirtyUI();
    } else {
      stageLightColor();
    }
    renderLightParams();
  }
});

// ── 宏 UI（格式解析/构建在 protocol.js：Leobog.parseMacroArea / buildMacroArea）──
// 事件 = [flags, delayBE16, keycode]；flags bit7=抬起 bit4=修饰键(0xE0-0xE7)
const MACRO_DELAY_DEFAULT = 50;   // 新事件的默认延时（一次按键 = 按住 50ms，节奏接近真人打字）
const parseMacroArea = buf => Leobog.parseMacroArea(buf);
const buildMacroArea = slots => Leobog.buildMacroArea(slots);

// 事件显示名：鼠标事件(flags bit5) → 按键号；修饰键 → L/R 名；其余按 HID usage
const MACRO_MOUSE = { 1: '鼠标左键', 2: '鼠标右键', 3: '鼠标中键', 4: '鼠标后退', 5: '鼠标前进' };
const MACRO_MODS = ['LCtrl', 'LShift', 'LAlt', 'LWin', 'RCtrl', 'RShift', 'RAlt', 'RWin'];
function macroKeyName(key, flags) {
  if (flags & 0x20) return MACRO_MOUSE[key] || ('鼠标键' + key);
  if (key >= 0xe0 && key <= 0xe7) return MACRO_MODS[key - 0xe0];
  return USAGE[key] || ('0x' + key.toString(16).padStart(2, '0'));
}

function describeEvents(events) {
  // 每个事件带自己的延时（设备里逐事件存 ms），例如「↓A 200ms · ↑A 300ms」
  const seq = events.map(e => (e.flags & 0x80 ? '↑' : '↓') + macroKeyName(e.key, e.flags) + (e.delay ? ' ' + e.delay + 'ms' : ''));
  return seq.slice(0, 12).join(' · ') + (events.length > 12 ? ' …' : '');
}

function renderMacro() {
  const raw = S.macroRaw;
  if (!raw) { $('macro').innerHTML = '<span class="bad">宏区不可用</span>'; return; }
  S.macroSlots = parseMacroArea(raw);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 左 4 右 4 的双栏卡片：点卡片=编辑，悬停浮出「编辑 / 删除」，空位显示「新建」
  const card = i => {
    const no = `<span class="mc-no">${String(i + 1).padStart(2, '0')}</span>`;
    const m = S.macroSlots[i];
    if (!m) {
      return `<div class="mc empty" data-new="${i}" title="点击新建宏">
        ${no}<span class="mc-txt"><span class="mc-name">未使用</span></span>
        <span class="mc-plus">＋</span>
      </div>`;
    }
    const name = m.name ? esc(m.name) : '<span class="muted">未命名</span>';
    return `<div class="mc${S.macroEditSlot === i ? ' cur' : ''}" data-edit="${i}"
        title="${esc(m.name || '未命名')} · ${m.events.length} 个动作，点击即可编辑">
      ${no}
      <span class="mc-txt"><span class="mc-name"><b>${name}</b></span>
        <span class="mc-meta">${m.events.length} 个动作</span></span>
      <span class="mc-acts"><button type="button" class="danger" data-del="${i}"
        title="删除这个宏，会重写整片宏区">删除</button></span>
    </div>`;
  };
  $('macro').innerHTML = `
    <div class="muted" style="margin-bottom:10px">宏会<b>明文</b>写进键盘。保存时整片重写并读回校验。</div>
    <div class="mc-grid">${Array.from({ length: 8 }, (_, i) => card(i)).join('')}</div>`;
}

// ── 宏编辑器（事件序列式；仿大牌驱动：录制 / 逐事件添加 / 逐事件延时）──
// 设备只支持"按键事件"和"鼠标按键事件"，没有文本宏 —— 所以不再有文本框。
let macroRec = null;            // 录制 / 单键捕获状态

function macroDraftGet() { return S.macroDraft; }

function pushMacroEvent(ev) {
  const d = macroDraftGet();
  if (!d) return;
  d.events.push(ev);
  renderMacroDraft();
}

// 鼠标事件在键帽上要短写（"鼠标左键"塞不进 46px 的帽子）
const MK_SHORT = { 1: '左键', 2: '右键', 3: '中键', 4: '后退', 5: '前进' };
const mkEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 事件 = 键帽；两个键帽之间的连接线 = 前一个事件"执行后等待"的延时
function renderMacroDraft() {
  const d = macroDraftGet();
  const list = $('meList');
  if (!d) { list.innerHTML = ''; return; }
  let acc = 0;
  const caps = d.events.map((e, i) => {
    const at = acc;                                  // 本事件开始的时刻 = 前面所有延时之和
    acc += e.delay || 0;
    const isUp = !!(e.flags & 0x80), isMouse = !!(e.flags & 0x20), isMod = !!(e.flags & 0x10);
    const label = isMouse ? (MK_SHORT[e.key] || ('鼠' + e.key)) : macroKeyName(e.key, e.flags);
    const cls = ['mkc', isUp ? 'up' : 'down', isMouse ? 'mouse' : '', isMod ? 'mod' : '']
      .filter(Boolean).join(' ');
    return `<span class="mku">
      <span class="${cls}" title="第 ${i + 1} 个动作 · ${isUp ? '抬起' : '按下'} ${mkEsc(label)} · 约第 ${(at / 1000).toFixed(2)} 秒">
        <span class="mkc-a">${isUp ? '↑' : '↓'}</span><span class="mkc-k">${mkEsc(label)}</span>
        <button type="button" class="mkc-x" data-rm="${i}" title="删除这个动作">×</button>
      </span>
      <span class="mkl${e.delay >= 1000 ? ' long' : ''}">
        <input class="mkd" type="number" min="0" max="65535" value="${e.delay}" data-delay="${i}"
               title="第 ${i + 1} 个动作执行后等待 ${e.delay}ms，可直接修改">
        <span>ms</span>
      </span>
    </span>`;
  }).join('');
  list.innerHTML = (d.events.length ? '' :
      '<div class="me-empty">还没有动作 —— 点「● 录制」直接敲键盘，或点右边的「＋」从键盘图里挑键</div>') + caps +
    `<span class="mku"><span class="mkc plus" id="mkcAdd" title="添加按键，可选 104 键盘键或鼠标键">＋</span></span>`;
  const add = list.querySelector('#mkcAdd');
  if (add) add.onclick = () => mpShow(!mpOpen);
  const total = d.events.reduce((n, e) => n + (e.delay || 0), 0);
  $('meInfo').textContent = `${d.events.length} 个动作 · 约 ${(total / 1000).toFixed(1)} 秒`;
}

function openMacroEditor(slot, existing) {
  macroRecStop();
  if (mpOpen) mpShow(false);
  $('meUni').checked = false;                 // 统一延时是"一次性动作"，每次开编辑器都复位
  S.macroEditSlot = slot;
  S.macroDraft = {
    name: existing ? existing.name : ('宏' + (slot + 1)),
    events: existing ? existing.events.map(e => ({ flags: e.flags, delay: e.delay, key: e.key })) : [],
  };
  $('meSlot').textContent = slot + 1;
  $('meName').value = S.macroDraft.name;
  $('macroEditor').style.display = 'flex';
  renderMacro();
  renderMacroDraft();
}

function closeMacroEditor() {
  macroRecStop();
  if (mpOpen) mpShow(false);
  $('macroEditor').style.display = 'none';
  S.macroEditSlot = null;
  S.macroDraft = null;
  renderMacro();
}

// 录制：捕获页面上的键盘按下/抬起。
// 设备语义（2026-11-02 回放实测确认）：delay = **执行完这个事件之后再等**多少 ms，
// 所以"两条事件之间的间隔"必须记到**上一条**事件上，不能记到当前这条。
function macroRecStart(on) {
  if (!on) { macroRecStop(); return; }
  if ($('meUni')) $('meUni').checked = false;  // 录制要保留真实间隔，退出统一延时
  macroRec = { t: performance.now(), idx: -1 };
  $('meRec').classList.add('on');
  $('meRec').textContent = '■ 停止';
  window.addEventListener('keydown', macroRecKey, true);
  window.addEventListener('keyup', macroRecKey, true);
}
function macroRecStop() {
  if (!macroRec) return;
  window.removeEventListener('keydown', macroRecKey, true);
  window.removeEventListener('keyup', macroRecKey, true);
  macroRec = null;
  const b = $('meRec');
  if (b) { b.classList.remove('on'); b.textContent = '● 录制'; }
  const k = $('meAddKey');
  if (k) k.classList.remove('on');
}
// 取"事件真实发生时刻"：ev.timeStamp 由浏览器在输入到达时打点，
// 不受主线程忙（HID 轮询/重绘）导致的处理延迟影响；performance.now() 会把这段延迟算进间隔。
function evStamp(ev) {
  const t = ev.timeStamp;
  if (typeof t === 'number' && t > 0 && Math.abs(t - performance.now()) < 60000) return t;
  return performance.now();
}
function macroRecKey(ev) {
  if (!macroRec) return;
  const usage = EV2USAGE[ev.code];
  if (usage === undefined) return;
  ev.preventDefault(); ev.stopPropagation();
  if (ev.repeat) return;
  const d = macroDraftGet();
  if (!d) return;
  const now = evStamp(ev);
  const gap = Math.max(0, Math.min(65535, Math.round(now - macroRec.t)));
  // 上一条事件执行后到现在的这段等待，写回上一条的延时
  const prev = macroRec.idx >= 0 ? d.events[macroRec.idx] : null;
  if (prev) prev.delay = gap;
  macroRec.t = now;
  const isMod = usage >= 0xe0 && usage <= 0xe7;
  pushMacroEvent({
    flags: (ev.type === 'keyup' ? 0x80 : 0) | (isMod ? 0x10 : 0),
    delay: MACRO_DELAY_DEFAULT,     // 占位：下一条事件到来时会被真实间隔覆盖
    key: usage,
  });
  macroRec.idx = d.events.length - 1;
}

// 鼠标：加一组按下+抬起（按键号 1左 2右 3中 4后退 5前进）
function macroAddMouse(btn) {
  if (!S.macroDraft || !btn) return;
  const mode = mpModeGet();
  const mk = f => ({ flags: 0x20 | f, delay: MACRO_DELAY_DEFAULT, key: btn });
  if (mode !== 'up') pushMacroEvent(mk(0));
  if (mode !== 'down') pushMacroEvent(mk(0x80));
}

async function saveMacroToKeyboard() {
  const slot = S.macroEditSlot;
  const d = macroDraftGet();
  if (slot == null || !d) return;
  if (!d.events.length) { Leobog.log('这个宏还没有动作 —— 先「录制」或「添加按键」', 'warn'); return; }
  const name = ($('meName').value || ('宏' + (slot + 1))).slice(0, 16);
  const events = d.events.map(e => ({ flags: e.flags, delay: e.delay, key: e.key }));
  const slots = (S.macroSlots || parseMacroArea(S.macroRaw)).slice();
  slots[slot] = { name, events };
  const payload = buildMacroArea(slots);
  if (payload.length > 504) { Leobog.log(`宏区总长 ${payload.length}B 超过 504B 上限，请删减旧宏`, 'bad'); return; }
  const total = events.reduce((n, e) => n + (e.delay || 0), 0);
  if (!confirm(`保存到键盘？\n宏${slot + 1}「${name}」· ${events.length} 个动作 · 约 ${(total / 1000).toFixed(1)} 秒\n` +
      `会整片重写宏区，共 ${payload.length} 字节，写后读回校验。`)) return;
  applying = true;
  try {
    Leobog.log(`写入宏区… ${S.channel === 'wireless' ? '无线 0x03' : '有线 0x05'} · 载荷 ${payload.length} 字节`);
    const r = await Leobog.writeMacro(payload);
    if (r.verified === true) {
      S.macroRaw = r.readback;
      renderMacro();
      closeMacroEditor();
      Leobog.log(`已保存 ✅ 宏${slot + 1}「${name}」写入并读回一致`, 'ok');
    } else if (r.readback) {
      Leobog.log(`宏区 ❌ 读回有 ${r.diffCount} 处不一致，位于 ${r.idxs.slice(0, 8).join(',')}，未清空编辑器，可重试`, 'bad');
    } else {
      Leobog.log(`宏区 ⚠️ 已写入但读回失败：${r.error || '未知'}`, 'warn');
    }
  } catch (e) {
    Leobog.log('宏写入失败：' + (e.message || e), 'bad');
  } finally {
    applying = false;
  }
}

// ── 104 键选择器（宏编辑器用；覆盖在键位预览区，真实 104 布局）──────
// 每行：数组=按键 [名称, HID usage, 宽度u]；数字=横向间隔（u）
const K104 = [
  [['Esc', 0x29], 1, ['F1', 0x3a], ['F2', 0x3b], ['F3', 0x3c], ['F4', 0x3d], 0.5,
   ['F5', 0x3e], ['F6', 0x3f], ['F7', 0x40], ['F8', 0x41], 0.5,
   ['F9', 0x42], ['F10', 0x43], ['F11', 0x44], ['F12', 0x45], 0.25,
   ['PrtSc', 0x46], ['ScrLk', 0x47], ['Pause', 0x48]],
  [['`', 0x35], ['1', 0x1e], ['2', 0x1f], ['3', 0x20], ['4', 0x21], ['5', 0x22], ['6', 0x23],
   ['7', 0x24], ['8', 0x25], ['9', 0x26], ['0', 0x27], ['-', 0x2d], ['=', 0x2e], ['Backspace', 0x2a, 2],
   0.25, ['Ins', 0x49], ['Home', 0x4a], ['PgUp', 0x4b], 0.25,
   ['NumLk', 0x53], ['Num/', 0x54], ['Num*', 0x55], ['Num-', 0x56]],
  [['Tab', 0x2b, 1.5], ['Q', 0x14], ['W', 0x1a], ['E', 0x08], ['R', 0x15], ['T', 0x17], ['Y', 0x1c],
   ['U', 0x18], ['I', 0x0c], ['O', 0x12], ['P', 0x13], ['[', 0x2f], [']', 0x30], ['\\', 0x31, 1.5],
   0.25, ['Del', 0x4c], ['End', 0x4d], ['PgDn', 0x4e], 0.25,
   ['Num7', 0x5f], ['Num8', 0x60], ['Num9', 0x61], ['Num+', 0x57, 1, 2]],
  [['CapsLock', 0x39, 1.75], ['A', 0x04], ['S', 0x16], ['D', 0x07], ['F', 0x09], ['G', 0x0a],
   ['H', 0x0b], ['J', 0x0d], ['K', 0x0e], ['L', 0x0f], [';', 0x33], ["'", 0x34], ['Enter', 0x28, 2.25],
   0.25, ['左键', 'm1'], ['中键', 'm3'], ['右键', 'm2'], 0.25, ['Num4', 0x5c], ['Num5', 0x5d], ['Num6', 0x5e]],
  [['LShift', 0xe1, 2.25], ['Z', 0x1d], ['X', 0x1b], ['C', 0x06], ['V', 0x19], ['B', 0x05], ['N', 0x11],
   ['M', 0x10], [',', 0x36], ['.', 0x37], ['/', 0x38], ['RShift', 0xe5, 2.75],
   0.25, ['前进', 'm5'], ['↑', 0x52], ['后退', 'm4'], 0.25, ['Num1', 0x59], ['Num2', 0x5a], ['Num3', 0x5b], ['NumEnter', 0x58, 1, 2]],
  [['LCtrl', 0xe0, 1.25], ['LWin', 0xe3, 1.25], ['LAlt', 0xe2, 1.25], ['空格', 0x2c, 6.25],
   ['RAlt', 0xe6, 1.25], ['RWin', 0xe7, 1.25], ['App', 0x65, 1.25], ['RCtrl', 0xe4, 1.25],
   0.25, ['←', 0x50], ['↓', 0x51], ['→', 0x4f], 0.25, ['Num0', 0x62, 2], ['Num.', 0x63]],
];
let mpOpen = false;

// 「按下+抬起 / 仅按下 / 仅抬起」单选（键盘键与鼠标键共用）
function mpModeGet() {
  const el = document.querySelector('input[name="mpMode"]:checked');
  return el ? el.value : 'pair';
}
function mpAddKey(code, name) {
  if (!S.macroDraft) return;
  const mode = mpModeGet();
  const isMod = code >= 0xe0 && code <= 0xe7;
  const mk = f => ({ flags: f | (isMod ? 0x10 : 0), delay: MACRO_DELAY_DEFAULT, key: code });
  if (mode !== 'up') pushMacroEvent(mk(0));
  if (mode !== 'down') pushMacroEvent(mk(0x80));
}

function mpRender() {
  const zone = $('mpKeys'), host = $('mpKb');
  if (!zone || !host) return;
  const COLS = 22.5, ROWS = 6;
  const zW = Math.max(240, zone.clientWidth - 4);
  const zH = Math.max(120, zone.clientHeight - 4);
  const cell = Math.min(zW / COLS, zH / ROWS);
  const gap = Math.max(2, cell * 0.09);
  const px = v => v * cell;
  host.style.width = px(COLS) + 'px';
  host.style.height = px(ROWS) + 'px';
  host.style.left = Math.max(0, (zone.clientWidth - px(COLS)) / 2) + 'px';
  host.style.top = Math.max(0, (zone.clientHeight - px(ROWS)) / 2) + 'px';
  let html = '';
  K104.forEach((row, r) => {
    let x = 0;
    for (const it of row) {
      if (typeof it === 'number') { x += it; continue; }
      const name = it[0], code = it[1], w = it[2] || 1, h = it[3] || 1;
      const mouse = typeof code === 'string' && code[0] === 'm';
      html += `<div class="key${mouse ? ' mk' : ''}" data-code="${code}"` +
        (mouse ? ` data-mouse="${code.slice(1)}"` : '') +
        ` data-name="${String(name).replace(/"/g, '&quot;')}"` +
        ` style="left:${px(x) + gap / 2}px;top:${px(r) + gap / 2}px;width:${px(w) - gap}px;height:${px(h) - gap}px">` +
        `<span class="kn">${String(name).replace(/</g, '&lt;')}</span></div>`;
      x += w;
    }
  });
  host.innerHTML = html;
}

function mpShow(on) {
  const ov = $('mpOverlay');
  if (!ov) return;
  mpOpen = !!on;
  ov.style.display = on ? '' : 'none';
  const btn = $('meAddKey');
  if (btn) btn.classList.toggle('on', !!on);
  if (on) {
    macroRecStop();
    mpRender();
  }
}

$('mpKb').addEventListener('click', e => {
  const k = e.target.closest('.key');
  if (!k) return;
  if (k.dataset.mouse) { macroAddMouse(Number(k.dataset.mouse)); return; }
  mpAddKey(Number(k.dataset.code), k.dataset.name);
});
window.addEventListener('resize', () => { if (mpOpen) mpRender(); });
document.addEventListener('keydown', e => { if (mpOpen && e.key === 'Escape') mpShow(false); });

async function deleteMacroSlot(i) {
  const slots = (S.macroSlots || parseMacroArea(S.macroRaw)).slice();
  if (!slots[i]) return;
  if (!confirm(`删除宏${i + 1}「${slots[i].name}」？其余宏会保留，但整片宏区要重写一次。`)) return;
  slots[i] = null;
  const payload = buildMacroArea(slots);
  applying = true;
  try {
    const r = await Leobog.writeMacro(payload);
    if (r.verified === true) {
      S.macroRaw = r.readback;
      renderMacro();
      Leobog.log(`宏${i + 1} 已删除 ✅`, 'ok');
    } else Leobog.log('删除后校验未通过——可重试或点「重新读取」核对', 'warn');
  } catch (e) { Leobog.log('删除失败：' + e.message, 'bad'); }
  finally { applying = false; }
}

$('macro').addEventListener('click', e => {
  // 卡片整块可点（点名称/事件数也能进编辑），删除按钮优先
  const t = e.target.closest('[data-new],[data-edit],[data-del]');
  if (!t) return;
  if (t.dataset.del !== undefined) { deleteMacroSlot(Number(t.dataset.del)); return; }
  if (t.dataset.new !== undefined) { openMacroEditor(Number(t.dataset.new), null); return; }
  if (t.dataset.edit !== undefined) openMacroEditor(Number(t.dataset.edit), S.macroSlots[Number(t.dataset.edit)]);
});
$('meSave').onclick = saveMacroToKeyboard;
$('meCancel').onclick = closeMacroEditor;
$('meRec').onclick = () => { if (macroRec) macroRecStop(); else macroRecStart(true); };
$('meAddKey').onclick = () => mpShow(!mpOpen);
$('meClear').onclick = () => { if (S.macroDraft) { S.macroDraft.events = []; renderMacroDraft(); } };

// 统一延时：勾上（或勾着时改数字）→ 把当前所有事件的延时刷成同一个值
const uniMs = () => Math.max(0, Math.min(65535, Math.round(Number($('meUniMs').value) || 0)));
function applyUniformDelay() {
  const d = S.macroDraft;
  if (!d || !d.events.length) return;
  const ms = uniMs();
  d.events.forEach(e => { e.delay = ms; });
  renderMacroDraft();
  Leobog.log(`已把 ${d.events.length} 个动作的等待时间统一为 ${ms}ms`, 'ok');
}
$('meUni').onchange = () => { if ($('meUni').checked) applyUniformDelay(); };
$('meUniMs').oninput = () => { if ($('meUni').checked && S.macroDraft && S.macroDraft.events.length) applyUniformDelay(); };
$('meName').oninput = () => { if (S.macroDraft) S.macroDraft.name = $('meName').value; };
$('meList').addEventListener('click', e => {
  const i = e.target.dataset.rm;
  if (i === undefined || !S.macroDraft) return;
  S.macroDraft.events.splice(Number(i), 1);
  renderMacroDraft();
});
$('meList').addEventListener('input', e => {
  const i = e.target.dataset.delay;
  if (i === undefined || !S.macroDraft) return;
  const v = Math.max(0, Math.min(65535, Number(e.target.value) || 0));
  S.macroDraft.events[Number(i)].delay = v;
  if ($('meUni').checked) $('meUni').checked = false;   // 手改单条 → 退出统一模式
  const box = e.target.closest('.mkl');
  if (box) box.classList.toggle('long', v >= 1000);
  const total = S.macroDraft.events.reduce((n, x) => n + (x.delay || 0), 0);
  $('meInfo').textContent = `${S.macroDraft.events.length} 个动作 · 约 ${(total / 1000).toFixed(1)} 秒`;
});

// ── 音乐律动（有线 0x08 整帧 / 无线 0x88 TLV全量快照；系统音频 → 21列频谱）──
// 帧时钟 = AudioWorklet 音频渲染线程（后台不节流）；发送节拍 = performance.now()，零 setTimeout。
const MUS = { on: false, ctx: null, analyser: null, stream: null, freq: null, buf: null,
              proc: null, last: 0, inflight: false, lastSend: 0, lastKeep: 0, lastChunk: 0,
              wlFrames: null, wlIdx: 0, armed: false };

function hsl2rgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))); };
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

// 频谱 → 126 槽：21 竖列柱状（V2 用户验收样式；门限+gamma）
function renderMusicBands(freq, buf, gain) {
  const COLS = 21, ROWS = 6;
  buf.fill(0);
  const lo = 2, hi = Math.min(freq.length - 1, 120);
  for (let c = 0; c < COLS; c++) {
    const f0 = lo + Math.floor((hi - lo) * c / COLS);
    const f1 = Math.max(f0 + 1, lo + Math.floor((hi - lo) * (c + 1) / COLS));
    let m = 0;
    for (let i = f0; i < f1; i++) if (freq[i] > m) m = freq[i];
    let amp = (m / 255) * gain;
    amp = Math.pow(Math.min(1, amp), 1.35);
    if (amp < 0.10) continue;
    const level = Math.max(1, Math.min(ROWS, Math.round(amp * ROWS)));
    const [r, g, b] = hsl2rgb(Math.round(c / (COLS - 1) * 300), 1, 0.55);
    for (let i = 0; i < level; i++) {
      const s = c * ROWS + (ROWS - 1 - i);
      buf[s * 3] = r; buf[s * 3 + 1] = g; buf[s * 3 + 2] = b;
    }
  }
}

function musicGain() {
  const el = $('musGain');
  return el ? Number(el.value) || 1 : 1;
}

async function startMusic() {
  if (MUS.on) return;
  if (!S.channel) { Leobog.log('请先连接设备', 'warn'); return; }
  Leobog.log('音乐律动：请求系统音频…请选择「整个屏幕」并勾选「共享系统音频」，不要选单个标签页');
  try {
    // 只认系统音频回环：共享整个屏幕+系统音频后，切窗口/切页不断流
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: true,
    });
    stream.getVideoTracks().forEach(t => t.stop());
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error('没有拿到音频——请在共享弹窗里勾选「共享/Shares system audio」，并共享整个屏幕');
    }
    const ctx = new AudioContext();
    const srcNode = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.6;
    srcNode.connect(an);
    // 帧时钟：AudioWorklet（音频渲染线程，后台不节流）。
    // 单一 data: URL 加载——file:// 下 blob/相对文件都会被 Chrome 按跨源拒绝（实测），
    // data: 是唯一在 file:// 与 http:// 下都能用的形态（headless 实测 file:// 三选一仅 data OK）。
    const WL_SRC = 'class C extends AudioWorkletProcessor{process(){this.port.postMessage(1);return true}}registerProcessor("clock",C);';
    await ctx.audioWorklet.addModule('data:text/javascript;base64,' + btoa(WL_SRC));
    const node = new AudioWorkletNode(ctx, 'clock', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ctx.createGain(); mute.gain.value = 0;
    node.connect(mute); mute.connect(ctx.destination);   // 保持图存活
    node.port.onmessage = () => { if (MUS.on) musicTick(); };
    MUS.proc = node;
    MUS.on = true; MUS.ctx = ctx; MUS.analyser = an; MUS.stream = stream;
    MUS.freq = new Uint8Array(an.frequencyBinCount);
    MUS.buf = new Uint8Array(378);
    MUS.last = 0; MUS.inflight = false; MUS.lastSend = 0; MUS.lastKeep = 0; MUS.lastChunk = 0;
    MUS.wlFrames = null; MUS.wlIdx = 0;
    MUS.armed = S.channel !== 'wireless';              // 无线：预热 4 条心跳后才开数据流
    $('musStart').disabled = true;
    $('musStop').disabled = false;
    // 无线预热：进入音乐页前打 4 条心跳（官方抓包：进入时 4 条 @31-45ms，活跃期几乎无心跳）
    if (S.channel === 'wireless') {
      for (let i = 0; i < 4 && MUS.on; i++) {
        await Leobog.sendMusicPoll().catch(() => {});
        await new Promise(r => setTimeout(r, 33));
      }
      MUS.armed = MUS.on;
    }
    Leobog.log(S.channel === 'wireless'
      ? `音乐律动已开始 · 无线 0x88 全量快照 · 音频时钟驱动，后台不断流`
      : `音乐律动已开始 · 有线 0x08 整帧约 21ms · 音频时钟驱动，后台不断流`, 'ok');
  } catch (e) {
    stopMusic();
    Leobog.log('音乐律动启动失败：' + (e.message || e), 'bad');
  }
}

// 全量快照 → 单一数据报字节流（官方语义：每周期发全部点亮槽，未列出的槽=熄灭）
// 官方每周期=单一数据报连续分片，block=片数（固件收齐才整屏应用）。
// V2 渐变 21 列逐列异色 ≈210B 超出官方 7 片包络 → 剔短列=黑块来源。
// 对策：无线编码色相量化到 45° 桶（8 色）让邻列合并成大段；预算 168B（12 片）满屏不裁剪。
const MUS_CYCLE_MAX = 168;                          // 12 片 × 14B（>官方7片包络；用户实测满屏不裁剪、无异常）

function musicSnapshotData(buf) {
  const COLS = 21, ROWS = 6;
  const cols = [];
  for (let c = 0; c < COLS; c++) {
    const slots = [];
    let r = 0, g = 0, b = 0;
    for (let row = 0; row < ROWS; row++) {
      const sl = c * ROWS + row;
      if (buf[sl * 3] || buf[sl * 3 + 1] || buf[sl * 3 + 2]) {
        slots.push(sl);
        if (slots.length === 1) { r = buf[sl * 3]; g = buf[sl * 3 + 1]; b = buf[sl * 3 + 2]; }
      }
    }
    if (!slots.length) continue;
    // 色相量化（仅无线编码；有线整帧原样发送不受影响）
    let h = 0;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx !== mn) {
      if (mx === r) h = ((g - b) / (mx - mn) + 6) % 6;
      else if (mx === g) h = (b - r) / (mx - mn) + 2;
      else h = (r - g) / (mx - mn) + 4;
      h *= 60;
    }
    [r, g, b] = hsl2rgb(Math.round(h / 45) * 45 % 360, 1, 0.55);
    cols.push({ r, g, b, slots });
  }
  const encode = list => {
    const segs = [];
    for (const col of list) {
      const last = segs[segs.length - 1];
      if (last && last.r === col.r && last.g === col.g && last.b === col.b) last.slots.push(...col.slots);
      else segs.push({ r: col.r, g: col.g, b: col.b, slots: col.slots.slice() });
    }
    return encodeTlv(segs);
  };
  let data = encode(cols);
  if (data.length > MUS_CYCLE_MAX) {
    // 极端爆音仍超预算：从最短列开始剔除（正常音量不应触发）
    const byLen = cols.slice().sort((a, b) => a.slots.length - b.slots.length);
    for (const col of byLen) {
      const idx = cols.indexOf(col);
      if (idx < 0) continue;
      cols.splice(idx, 1);
      data = encode(cols);
      if (data.length <= MUS_CYCLE_MAX) break;
    }
  }
  return data;
}

function encodeTlv(segs) {
  const out = [];
  for (const s of segs) {
    out.push(s.r, s.g, s.b, s.slots.length & 0xff);
    for (const sl of s.slots) out.push(sl & 0xff);
  }
  return Uint8Array.from(out);
}

// 音频时钟驱动的发送节拍：worklet 消息只负责"叫醒"，所有时序用 performance.now()
// （不受页面可见性节流）——发送路径零 setTimeout，后台与前台同速
function musicTick() {
  MUS.analyser.getByteFrequencyData(MUS.freq);
  renderMusicBands(MUS.freq, MUS.buf, musicGain());
  const now = performance.now();
  if (S.channel === 'wired') {
    if (now - MUS.last < 21) return;                   // 整帧 ~47fps（官方20fps 上限内）
    MUS.last = now;
    if (MUS.inflight) return;
    MUS.inflight = true;
    Leobog.sendMusicFrame(MUS.buf).catch(e => {
      Leobog.log('音乐流中断：' + (e.message || e), 'bad');
      stopMusic();
    }).finally(() => { MUS.inflight = false; });
    return;
  }
  // 无线：整屏快照周期 50ms + 周期内分片 9ms（官方 9-12ms），逐片吐给 dongle
  if (!MUS.armed || MUS.inflight) return;
  if (MUS.wlFrames) {
    if (now - MUS.lastChunk < 9) return;               // 官方片间隔
    MUS.lastChunk = now;
    wlSendNext();
    return;
  }
  if (now - MUS.lastSend < 50) return;
  let data = musicSnapshotData(MUS.buf);
  if (!data.length) {
    // 静音保持包：col0 刷新 @150ms——防固件无数据超时回默认灯效
    if (now - MUS.lastKeep < 150) return;
    MUS.lastKeep = now;
    data = encodeTlv([{ r: MUS.buf[0], g: MUS.buf[1], b: MUS.buf[2], slots: [0, 1, 2, 3, 4, 5] }]);
  }
  MUS.wlFrames = Leobog.wlChunks(0x88, Math.ceil(data.length / 14), data, 1);
  MUS.wlIdx = 0;
  MUS.lastSend = now;
  MUS.lastChunk = now;
  wlSendNext();
}

function wlSendNext() {
  const fr = MUS.wlFrames[MUS.wlIdx++];
  if (MUS.wlIdx >= MUS.wlFrames.length) MUS.wlFrames = null;
  MUS.inflight = true;
  Leobog.sendMusicChunk(fr).catch(e => {
    Leobog.log('无线律动中断：' + (e.message || e), 'bad');
    stopMusic();
  }).finally(() => { MUS.inflight = false; });
}

function stopMusic() {
  if (MUS.proc) { try { MUS.proc.disconnect(); } catch (e) {} }
  if (MUS.stream) MUS.stream.getTracks().forEach(t => t.stop());
  if (MUS.ctx) { MUS.ctx.close().catch(() => {}); }
  MUS.on = false; MUS.ctx = null; MUS.analyser = null; MUS.stream = null; MUS.proc = null;
  MUS.wlFrames = null; MUS.wlIdx = 0; MUS.inflight = false; MUS.armed = false;
  const a = $('musStart'), b = $('musStop');
  if (a) a.disabled = !S.channel;
  if (b) b.disabled = true;
  flushPendingUnsol();                             // 音乐结束=空闲点：补跑忙时挂起的推送
}

$('musStart').onclick = startMusic;
$('musStop').onclick = () => { stopMusic(); Leobog.log('音乐律动已停止', 'ok'); };
$('musGain').oninput = () => { $('musGainVal').textContent = Number($('musGain').value).toFixed(1); };

// 网页侧帧录制（B端对照；停止时自动下载日志）
$('capStart').onclick = () => {
  try {
    Leobog.startCapture();
    $('capStart').style.display = 'none';
    $('capStop').style.display = '';
  } catch (e) { Leobog.log('录制启动失败：' + e.message, 'bad'); }
};
$('capStop').onclick = () => {
  const txt = Leobog.stopCapture();
  $('capStart').style.display = '';
  $('capStop').style.display = 'none';
  if (!txt) return;
  const blob = new Blob([txt], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'webcap-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.log';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  Leobog.log('帧日志已下载：' + a.download + '发到会话里即可分析', 'ok');
};

// ── 键位图渲染（M HUB 风格：单位栅格观感 + SVG 底壳 + 旋钮装饰）──
function renderKeymap(layer) {
  const m = S.model;
  if (!m) return;
  S.curLayer = layer;
  const live = S.keymap[layer];                    // null = 该层读取失败（键位只读）

  // ── 单位栅格布局（75% 标准）：键缝全等、1u 等大、异形键按标准 u 数 ──
  // profile rect 是轴体占位（间隙9~16不等）→ 弃用，改为 [键名,行,列,宽度u] 表驱动。
  // Hi8/Hi8SE 键集一致（md5 相同），共用此表；缺键的型号跳过对应项。
  const U = 40;                                   // 1u = 40 单位
  const GRID_GAP = 5;                             // 所有相邻键缝统一
  const LAYOUT75 = [
    ['Esc',0,0,1],['F1',0,1.75,1],['F2',0,2.75,1],['F3',0,3.75,1],['F4',0,4.75,1],
    ['F5',0,6.25,1],['F6',0,7.25,1],['F7',0,8.25,1],['F8',0,9.25,1],
    ['F9',0,10.75,1],['F10',0,11.75,1],['F11',0,12.75,1],['F12',0,13.75,1],
    ['`',1,0,1],['1',1,1,1],['2',1,2,1],['3',1,3,1],['4',1,4,1],['5',1,5,1],['6',1,6,1],
    ['7',1,7,1],['8',1,8,1],['9',1,9,1],['0',1,10,1],['-',1,11,1],['=',1,12,1],
    ['Backspace',1,13,2],['Delete',1,15,1],
    ['Tab',2,0,1.5],['Q',2,1.5,1],['W',2,2.5,1],['E',2,3.5,1],['R',2,4.5,1],['T',2,5.5,1],
    ['Y',2,6.5,1],['U',2,7.5,1],['I',2,8.5,1],['O',2,9.5,1],['P',2,10.5,1],['[',2,11.5,1],
    [']',2,12.5,1],['\\',2,13.5,1.5],['PgUp',2,15,1],
    ['CapsLock',3,0,1.75],['A',3,1.75,1],['S',3,2.75,1],['D',3,3.75,1],['F',3,4.75,1],
    ['G',3,5.75,1],['H',3,6.75,1],['J',3,7.75,1],['K',3,8.75,1],['L',3,9.75,1],
    [';',3,10.75,1],["'",3,11.75,1],['Enter',3,12.75,2.25],['PgDn',3,15,1],
    ['LShift',4,0,2.25],['Z',4,2.25,1],['X',4,3.25,1],['C',4,4.25,1],['V',4,5.25,1],
    ['B',4,6.25,1],['N',4,7.25,1],['M',4,8.25,1],[',',4,9.25,1],['.',4,10.25,1],
    ['/',4,11.25,1],['RShift',4,12.25,1.75],['Up',4,14,1],['End',4,15,1],
    ['LCtrl',5,0,1.25],['LWin',5,1.25,1.25],['LAlt',5,2.5,1.25],['Space',5,3.75,6.25],
    ['FN',5,10,1.25],['RCtrl',5,11.25,1.25],['Left',5,13,1],['Down',5,14,1],['Right',5,15,1],
  ];
  const ROW_Y = [0, 1.25, 2.25, 3.25, 4.25, 5.25];   // F 行下方留 0.25u 隔断
  const slotByName = {};
  for (const k of m.keys) slotByName[k.name] = k.slot;
  const vis = [];
  for (const ent of LAYOUT75) {
    const name = ent[0], row = ent[1], col = ent[2], wU = ent[3];
    if (slotByName[name] === undefined) continue;
    const x1 = col * U + GRID_GAP / 2;
    const y1 = ROW_Y[row] * U + GRID_GAP / 2;
    vis.push({ name: name, slot: slotByName[name],
      rect: [x1, y1, (col + wU) * U - GRID_GAP / 2, y1 + U - GRID_GAP] });
  }
  const minX = 0, minY = 0;
  const cw = 16 * U, ch = 6.25 * U;               // 75% = 16u 宽
  const PAD = 10;
  const scale = 1.75;
  const W = cw * scale + PAD * 2;
  const H = ch * scale + PAD * 2;
  const X = x => x * scale + PAD;
  const Y = y => y * scale + PAD;

  // 旋钮 = del 列顶端的"圆形1u键帽"：圆心对齐 del 列（15u起）中心 × F 行垂直中心，
  // 直径 = 1u 键帽（U - GRID_GAP）
  const KNOB_R = (U - GRID_GAP) / 2 * scale;
  const knobX = X((15 + 16) / 2 * U);              // del 列中心 15.5u
  const knobY = Y(0.5 * U);                         // F 行中心
  const caseSvg =
    `<svg class="case" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="position:absolute;inset:0">` +
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="18" fill="var(--kb-case)" stroke="var(--kb-case-border)" stroke-width="2"/>` +
    `<circle cx="${knobX}" cy="${knobY}" r="${KNOB_R}" fill="var(--knob)" stroke="var(--knob-ring)" stroke-width="2"/>` +
    `</svg>`;

  let html = `<div class="kb" style="width:${W}px;height:${H}px">${caseSvg}`;
  for (const k of vis) {
    const [x1, y1, x2, y2] = k.rect;
    let label = k.name, bind = '', cls = '';
    if (live) {
      const rec = decodeRecord(live, k.slot * 4);
      // 默认层：与出厂记录逐字节相同 = 没改过 → 不显示别称、不加高亮
      // （否则 Space/↑/Del/FN 这类"键名与 usage 名不一致"的键会一直挂着别称）
      const cur4 = Array.from(live.subarray(k.slot * 4, k.slot * 4 + 4));
      const fac = layer === 0 ? factoryRecord(k.slot) : null;
      const untouched = !!fac && fac.length === 4 && fac.every((v, i) => v === cur4[i]);
      if (rec.empty) { bind = '未绑定'; cls = 'empty'; }
      else if (untouched) { bind = ''; }
      else if (rec.plainMod || sameKey(rec.label, label)) { bind = ''; if (rec.type !== 0x00) cls = 'special'; }
      else { bind = rec.label; if (rec.type !== 0x00) cls = 'special'; }
    } else {
      if (layer === 0) bind = '';
      else if (layer === 1) {
        const f = m.fn1[String(k.n)];
        if (f) { const r = decodeRecord32(f.record32); bind = r.empty ? '' : r.label; cls = 'special'; }
      } else { bind = ''; cls = 'empty'; }
      if (layer > 0 && !(m.fn1[String(k.n)])) cls = 'empty';
    }
    const w = (x2 - x1) * scale, h = (y2 - y1) * scale;
    const tip = live
      ? `${label} · 槽${k.slot} · ${hexs(Array.from(live.subarray(k.slot * 4, k.slot * 4 + 4)))}` +
        (bind ? ` → ${bind}` : '')
      : `${label} · 槽${k.slot}`;
    html += `<div class="key ${cls}" data-slot="${k.slot}" data-name="${String(label).replace(/"/g, '&quot;')}"
      title="${String(tip).replace(/"/g, '&quot;')}"
      style="left:${X(x1)}px;top:${Y(y1)}px;width:${w}px;height:${h}px">
      <span class="kn">${label}</span>${bind ? `<span class="kb2">${bind}</span>` : ''}</div>`;
  }
  html += '</div>';
  $('keyboard').innerHTML = html;
  paintCustomKeys();                               // 若处于自定义上色模式，重绘后保留键色
  fitKeyboard();
}

// 层切换（记录选中层，切页往返不丢）
let lastLayerOnTabs = 0;
$('layerTabs').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  lastLayerOnTabs = Number(b.dataset.layer);
  document.querySelectorAll('#layerTabs button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  closeEditor();
  renderKeymap(lastLayerOnTabs);
};

// ── 侧边栏分区切换（布局：上键盘 / 下参数面板）──
// 层切换竖排紧贴键盘右侧；按键指派/宏编辑/设置显示。
// 其余页隐藏层切换并临时预览默认层；切回时恢复 lastLayerOnTabs。
$('nav').onclick = e => {
  const b = e.target.closest('button[data-sec]');
  if (!b) return;
  document.querySelectorAll('#nav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + b.dataset.sec));
  const sec = b.dataset.sec;
  // 离开宏编辑时收起 104 选择器、停止录制，免得遮住其他页面 / 继续吞按键
  if (sec !== 'macro') { if (mpOpen) mpShow(false); macroRecStop(); }
  S.section = sec;
  const layerSec = sec === 'keys' || sec === 'macro' || sec === 'settings';
  $('layerTabs').style.display = layerSec ? '' : 'none';
  if (S.model) {
    const target = layerSec ? lastLayerOnTabs : 0;
    if (S.curLayer !== target) renderKeymap(target);
    document.querySelectorAll('#layerTabs button')
      .forEach((x, i) => x.classList.toggle('on', i === target));
  }
  paintCustomKeys();                               // 灯效页 + 自定义模式 → 键盘变上色画布
  updatePreview();                                 // 灯效页 → 预览动画（自定义模式除外）
  fitKeyboard();
};

// 键盘自适应缩放：渲染为固定 px，按容器做 transform 缩放（适配任意 16:9 全屏分辨率）
// 层切换列宽在缩放时预留（TAB_RESERVE），键盘缩到不会压到按钮；按钮再贴键盘右缘摆放。
function fitKeyboard() {
  const zone = $('keyboard');
  const kbZone = $('kbzone');
  const kb = zone && zone.querySelector('.kb');
  const tabs = $('layerTabs');
  if (!kb) return;
  const tabsVisible = tabs && tabs.style.display !== 'none';
  const tabW = tabsVisible ? (tabs.offsetWidth || 64) : 0;
  const TAB_GAP = 10;
  // 缩放可用宽 = 键盘容器宽 - 预留层切换列（不可见时为 0）
  const reserve = tabsVisible ? tabW + TAB_GAP : 0;
  const zw = zone.clientWidth - 8 - reserve;
  const zh = zone.clientHeight - 8;
  const w = kb.offsetWidth, h = kb.offsetHeight;
  if (zw <= 0 || zh <= 0 || w <= 0 || h <= 0) return;
  const s = Math.max(0.25, Math.min(zw / w, zh / h, 2.5));
  kb.style.transform = 'scale(' + s + ')';
  if (!tabs || !kbZone) return;
  // 按钮定位参照 kbzone（tabs 的 offsetParent），键盘视觉右缘相对 kbzone + 间距
  const bzr = kbZone.getBoundingClientRect();
  const kr = kb.getBoundingClientRect();
  const left = (kr.right - bzr.left) + TAB_GAP;
  const tabH = tabs.offsetHeight || 140;
  tabs.style.left = Math.max(4, left) + 'px';
  tabs.style.top = Math.max(4, (bzr.height - tabH) / 2) + 'px';
}
window.addEventListener('resize', () => {
  clearTimeout(window.__fitT);
  window.__fitT = setTimeout(fitKeyboard, 120);
});

// 日志折叠：点击整个标题栏（含最新预览）展开/收起；展开时显示「复制」并隐藏预览
$('logHead').onclick = e => {
  if (e.target.closest('#logCopy')) return;          // 复制按钮不触发折叠
  const collapsed = $('log').classList.toggle('collapsed');
  $('logCopy').style.display = collapsed ? 'none' : '';
  $('logLast').style.display = collapsed ? '' : 'none';
};
$('logCopy').onclick = async () => {
  const text = Array.from($('log').children).map(el => el.textContent).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('logCopy').textContent = '已复制';
    setTimeout(() => { $('logCopy').textContent = '复制'; }, 1500);
  } catch (e) {
    // file:// 下 clipboard API 可能不可用 → 退回选中复制
    const range = document.createRange();
    range.selectNodeContents($('log'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    $('logCopy').textContent = '已选中，Ctrl+C';
    setTimeout(() => { $('logCopy').textContent = '复制'; }, 2500);
  }
};

// ── 明暗主题（始终跟随浏览器 / 系统）──
{
  const media = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
  try {
    localStorage.removeItem('leobog-theme');
    localStorage.removeItem('leobog-theme-choice');
  } catch (e) {}
  const apply = isDark => {
    if (isDark) document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
  };
  apply(Boolean(media && media.matches));
  const syncSystemTheme = event => apply(event.matches);
  if (media) {
    if (media.addEventListener) media.addEventListener('change', syncSystemTheme);
    else if (media.addListener) media.addListener(syncSystemTheme);
  }
}

// ── 键位编辑器（常驻；点键盘选槽位，右侧点选即暂存，应用修改统一写入）──
// usage 下拉兜底（未收录 usage 的占位；调色板为主交互）
{
  const s = $('edUsage');
  s.innerHTML = Object.entries(USAGE)
    .map(([k, v]) => [Number(k), v])
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `<option value="${k}">${v} · 0x${k.toString(16)}</option>`)
    .join('');
}

function ensureUsageOption(usage) {
  const s = $('edUsage');
  if (!s.querySelector(`option[value="${usage}"]`)) {
    const o = document.createElement('option');
    o.value = usage;
    o.textContent = `0x${usage.toString(16)} · 未收录`;
    s.appendChild(o);
  }
}

// 出厂默认记录（factory.keymapWin[页] hex → 4B；层=页）
// factory 挂在 LEOBOG_MODELS[name] 根上，不在 profile 里
const _facPageCache = {};                          // 渲染时逐键调用 → 按 型号:层 缓存解析结果
function factoryRecord(slot) {
  const mod = window.LEOBOG_MODELS && window.LEOBOG_MODELS[S.modelName];
  const page = mod && mod.factory && mod.factory.keymapWin && mod.factory.keymapWin[S.curLayer];
  if (!page || typeof page !== 'string') return null;
  const key = S.modelName + ':' + S.curLayer;
  let bytes = _facPageCache[key];
  if (!bytes) { bytes = page.match(/../g).map(h => parseInt(h, 16)); _facPageCache[key] = bytes; }
  const o = slot * 4;
  if (o + 4 > bytes.length) return null;
  return bytes.slice(o, o + 4);
}

// 立即暂存绑定：写键表缓冲 + dirty + 重绘键盘（不写设备；顶栏「应用修改」统一提交）
function stageRecord(rec, label) {
  const buf = S.keymap[S.curLayer];
  if (!buf || S.sel === null) return;
  buf.set(rec, S.sel * 4);
  S.kmDirty[S.curLayer] = true;
  $('edCur').textContent = hexs(rec);
  Leobog.log(`页${S.curLayer} 槽${S.sel}（${$('edKey').textContent}）→ ${hexs(rec)}${label ? '（' + label + '）' : ''}（未应用）`, 'ok');
  renderKeymap(S.curLayer);
  updateDirtyUI();
  // 重绘后选中态丢失，恢复
  document.querySelectorAll(`#keyboard .key[data-slot="${S.sel}"]`).forEach(x => x.classList.add('sel'));
}

function modBits() {
  let m = 0;
  document.querySelectorAll('#edModBtns button.on').forEach(b => { m |= Number(b.dataset.modbit); });
  return m;
}
function setModBits(m) {
  document.querySelectorAll('#edModBtns button').forEach(b =>
    b.classList.toggle('on', !!(m & Number(b.dataset.modbit))));
}

// 键位调色板（Comm/Adv/Keypad/Modify）
function renderPalette() {
  const host = $('edPalette');
  if (!host) return;
  const t = $('edType').value;
  // 宏触发：右侧 2×4 宏网格（名称来自宏区）
  if (t === 'macro') {
    $('edPalTitle').textContent = '宏';
    const slots = S.macroSlots || [];
    const cur = Number($('edMacroSlot').value);
    host.innerHTML = `<div class="pal-group"><div class="pal-slots">` +
      Array.from({ length: 8 }, (_, i) => {
        const has = slots[i] && slots[i].name;
        const label = has ? slots[i].name.replace(/</g, '&lt;') : '未使用';
        const cls = 'pal-key' + (i === cur ? ' on' : '') + (has ? '' : ' empty');
        return `<button type="button" class="${cls}" data-macro="${i}"${has ? '' : ' disabled'}` +
               ` title="宏${i + 1}：${label}">${label}</button>`;
      }).join('') + `</div></div>`;
    return;
  }
  // 特殊键：功能码 / 层 / 鼠标 / 媒体，全部按"记录 4 字节"高亮与写入
  if (t === 'special') {
    $('edPalTitle').textContent = '特殊键';
    const rec = (S.sel !== null && S.keymap[S.curLayer])
      ? S.keymap[S.curLayer].subarray(S.sel * 4, S.sel * 4 + 4) : null;
    let idx = 0;
    host.innerHTML = SPECIAL_GROUPS.map(g => {
      const chips = g.items.map(() => {
        const it = SPECIAL_ITEMS[idx];
        const on = rec && it.rec.every((v, i) => v === rec[i]) ? ' on' : '';
        const w = it.warn ? ' warn' : '';
        const b = `<button type="button" class="pal-key${on}${w}" data-spec="${idx}" title="${it.tip}">${it.label}</button>`;
        idx++;
        return b;
      }).join('');
      return `<div class="pal-group"><div class="pal-group-h">${g.name}</div><div class="pal-keys">${chips}</div></div>`;
    }).join('');
    return;
  }
  $('edPalTitle').textContent = '键位';
  // 纯修饰键记录（00 xx 00 00，出厂就是这么存的）→ 映射到 Modify 组对应的 usage 才高亮
  const selRec = (S.sel !== null && S.keymap[S.curLayer])
    ? S.keymap[S.curLayer].subarray(S.sel * 4, S.sel * 4 + 4) : null;
  let cur = Number($('edUsage').value) || -1;
  if (selRec && selRec[0] === 0x00 && selRec[2] === 0 && selRec[3] === 0 && selRec[1]) {
    const i = Math.log2(selRec[1] & 0xff);
    if (Number.isInteger(i)) cur = 0xe0 + i;
  }
  const parts = [];
  for (const [group, keys] of Object.entries(PALETTE)) {
    // 组合键模式隐藏 Modify 组：组合修饰只走左侧按钮，杜绝「Ctrl+组合:LWin」冗余
    if (t === 'combo' && group === 'Modify') continue;
    const chips = keys.map(([code, label]) => {
      const isMod = group === 'Modify';
      const on = code === cur ? ' on' : '';
      return `<button type="button" class="pal-key${isMod ? ' mod' : ''}${on}"` +
             ` data-code="${code}" data-mod="${isMod ? 1 : 0}" title="0x${code.toString(16)} · 独立键，非组合修饰">${label}</button>`;
    }).join('');
    parts.push(`<div class="pal-group"><div class="pal-group-h">${group}</div>` +
               `<div class="pal-keys">${chips}</div></div>`);
  }
  host.innerHTML = parts.join('');
}

function syncEditorRows() {
  const t = $('edType').value;
  document.querySelectorAll('#edTypeRow button').forEach(b =>
    b.classList.toggle('on', b.dataset.type === t));
  // 普通键：无修饰；组合键：修饰+键位；宏：模式/次数；默认键/空：仅状态
  $('edModRow').style.display = t === 'combo' ? '' : 'none';
  $('edPalette').style.display = (t === 'default' || t === 'empty') ? 'none' : '';
  $('edMacroRow').style.display = t === 'macro' ? '' : 'none';
  if (t === 'macro') {
    const mv = $('edMacroMode').value;
    document.querySelectorAll('#edMacroModeRow button').forEach(b =>
      b.classList.toggle('on', b.dataset.mode === mv));
    $('edMacroCountRow').style.display = mv === '1' ? '' : 'none';
  }
  $('edHint').textContent =
    t === 'default' ? '已恢复该键的出厂默认绑定，暂存中；点顶栏「应用修改」写入。'
    : t === 'empty' ? '已清空该键的绑定，暂存中；点顶栏「应用修改」写入。'
    : t === 'macro' ? '右侧点选宏即暂存；模式/次数改后需再点一次宏生效。'
    : t === 'special' ? '右侧点选特殊功能即暂存；红框项如「恢复默认」「2.4G对码」需连点两次确认。'
    : t === 'combo' ? '点修饰按钮再点右侧键位，即暂存组合键。'
    : '点右侧键位即暂存普通键绑定，不带修饰。';
}

// 未选键位时把"绑定类型 + 键位调色板"置灰，避免对着空选择操作
function setEditorEnabled(on) {
  ['kmEditor', 'edPalette'].forEach(id => {
    const el = $(id);
    if (el) el.classList.toggle('disabled', !on);
  });
  document.querySelectorAll('#edTypeRow button').forEach(b => { b.disabled = !on; });
}

function openEditor(slot, name) {
  const buf = S.keymap[S.curLayer];
  if (!buf) { Leobog.log('该层无实时键表数据，无法编辑；读取失败时会回退到出厂布局', 'warn'); return; }
  S.sel = slot;
  document.querySelectorAll('#keyboard .key.sel').forEach(x => x.classList.remove('sel'));
  document.querySelectorAll(`#keyboard .key[data-slot="${slot}"]`).forEach(x => x.classList.add('sel'));
  const rec = Array.from(buf.subarray(slot * 4, slot * 4 + 4));
  $('edKey').textContent = name;
  $('edSlot').textContent = slot;
  $('edCur').textContent = hexs(rec);
  let type = 'normal';
  // 空记录与「0x07 但无修饰位」都按普通键展示（调色板常驻可用）
  if (rec[0] === 0x03) type = 'macro';
  else if (rec[0] === 0x07 && rec[1]) type = 'combo';
  // 特殊键：厂商功能码(07+mod0) / 层切换(0d) / 鼠标(01) / 媒体(02)
  else if (rec[0] === 0x01 || rec[0] === 0x02 || rec[0] === 0x0d || (rec[0] === 0x07 && !rec[1]) ||
           (rec[0] === 0x00 && rec[2] !== 0 && rec[3] === 0))   // 驱动的 PC 命令（键码在 [2]）也算特殊键
    type = 'special';

  $('edType').value = type;
  if (type === 'macro') {
    const mode = rec[1];
    $('edMacroMode').value = String([1, 2, 4].includes(mode) ? mode : 1);
    $('edMacroCount').value = String(Math.max(1, Math.min(99, rec[2] || 1)));
    $('edMacroSlot').value = String(rec[3]);
  } else if (type === 'normal' && rec[1] && rec[2] === 0 && rec[3] === 0) {
    // 纯修饰键（掩码型）：把位映射回 Modify 组的 usage，右侧才会高亮
    const i = Math.log2(rec[1] & 0xff);
    if (Number.isInteger(i)) { ensureUsageOption(0xe0 + i); $('edUsage').value = String(0xe0 + i); }
  } else if (type !== 'special' && (rec[3] !== 0 || type !== 'empty')) {
    ensureUsageOption(rec[3]);
    $('edUsage').value = String(rec[3]);
  }
  // 只有 00(普通) 和 07(组合) 的 [1] 是修饰位；01/02/0d 的 [1] 是按键号/层号，别当修饰
  setModBits((rec[0] === 0x00 || rec[0] === 0x07) ? rec[1] : 0);
  setEditorEnabled(true);
  {
    const sel = $('edMacroSlot');
    const slots = S.macroSlots || [];
    sel.innerHTML = Array.from({ length: 8 }, (_, i) =>
      `<option value="${i}">宏${i + 1}${slots[i] ? '「' + slots[i].name.replace(/</g, '&lt;') + '」' : ' · 未使用'}</option>`).join('');
    if (type === 'macro') sel.value = String(rec[3]);
  }
  syncEditorRows();
  renderPalette();
}

function closeEditor() {
  document.querySelectorAll('#keyboard .key.sel').forEach(x => x.classList.remove('sel'));
  S.sel = null;
  $('edKey').textContent = '—';
  $('edSlot').textContent = '—';
  $('edCur').textContent = '—';
  $('edType').value = 'normal';
  $('edUsage').value = '4';
  setModBits(0);
  setEditorEnabled(false);
  syncEditorRows();
  renderPalette();
}

// 键盘区兜底：阻止原生文本选择（CSS 已禁用选中，这里再挡掉从边缘起手/双击选词等路径）
(function guardKeyboardSelection() {
  const zone = $('kbzone');
  if (!zone) return;
  zone.addEventListener('pointerdown', e => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  zone.addEventListener('selectstart', e => e.preventDefault());
})();


// ── 灯效预览引擎（网页端复刻；126 像素 = 21 列 × 6 行）────
// 常亮/呼吸/梦幻彩虹/随波逐流/七彩瀑布/花开富贵 + 一触即发/涟漪/正弦光波按固件逐像素；
// 其余（雨中漫步/彩虹轮盘/繁星/川流不息/如影随形/旋转风车）仍用解析式近似。
// 模式 4/7 预览中点击按键会作为位平面种子；模式 13 自动循环补种。固件不支持的模式不预览。
const PREVIEW = { raf: 0, last: 0, t0: 0 };
const PV_FIXED_RAINBOW = new Set([3, 15, 16, 17]);   // 固定彩虹：不吃调色盘颜色
function previewActive() {
  return S.section === 'light' && !!S.model && S.lightSel != null &&
    S.lightSel !== 21 && S.lightSel !== 0 && !LIGHT_FW_UNSUPPORTED.has(S.lightSel);
}
function previewParams() {
  const p = S.settings ? S.settings.slice() : null;
  if (!p) return null;
  for (const op of S.lightOps) { try { op.fn(p); } catch (e) {} }
  const sel = S.lightSel;
  const { bIdx, sIdx } = lightParamIdx(sel);
  return {
    sel,
    bright: 0.22 + (p[bIdx] / 4) * 0.78,
    speed: 0.35 + (p[sIdx] >> 4) * 0.35,
    color: hexToRgb(lightColor()),
    multi: (p[sIdx] & 0x0f) !== 0,
    spd: (p[sIdx] >> 4) & 7,                     // 固件速度档 0..4（0x37DE/0x37E8/0x3801 索引）
    level: p[bIdx],                              // 固件亮度档 0..4（0x311D）
  };
}
function pvHue(h) { const [r, g, b] = hsvToRgb(((h % 360) + 360) % 360, 1, 1); return [r, g, b]; }
function pvScale(rgb, k) { return [rgb[0] * k, rgb[1] * k, rgb[2] * k]; }
function pvHash(a, b) { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); }

// 物理坐标：按键 rect 归一化到 0..1（x 左→右，y 上→下），用于横向/纵向/径向效果
const PV_GEO = { key: '', map: null };
function pvGeo() {
  if (!S.model) return null;
  if (PV_GEO.key === S.modelName && PV_GEO.map) return PV_GEO.map;
  const ks = S.model.keys || [];
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const k of ks) {
    const r = k.rect || [0, 0, 0, 0];
    x0 = Math.min(x0, r[0]); x1 = Math.max(x1, r[2]);
    y0 = Math.min(y0, r[1]); y1 = Math.max(y1, r[3]);
  }
  const sx = Math.max(1, x1 - x0), sy = Math.max(1, y1 - y0);
  const map = new Map();
  for (const k of ks) {
    const r = k.rect || [0, 0, 0, 0];
    map.set(k.slot, [((r[0] + r[2]) / 2 - x0) / sx, ((r[1] + r[3]) / 2 - y0) / sy]);
  }
  PV_GEO.key = S.modelName; PV_GEO.map = map;
  return map;
}


// ── 固件灯效渲染（0x7471 = 常亮 / 花开富贵，已按固件逐像素还原）──────────
// 0x313A 前 9 行 = 9 个径向环：desc 低 3 位 = 行、高 5 位 = 列，
// 经 0x36CE/0x374C 换算成 (col,row) → 槽 col*6+row（= 0x0152 的 col*18+row*3）。
// 0x7471 每环把相位 +0x0D(13) 后重算颜色：0x330B[相位]（192 项色环），
// 基相 [EE3] 在模式 1 恒为 0（0x747B 跳过 0xA317）→ 常亮是静态径向彩虹；
// 花开富贵每帧由 0xA317 反向 -2 步进 [08BF] → 彩虹环缓慢旋转。
let FW_RING = null;
function fwRingMap() {
  const T = window.FW_TABLES;
  if (!T) return null;
  if (FW_RING) return FW_RING;
  const ring = new Int8Array(126).fill(-1);
  for (let r = 0; r < 9; r++) {
    for (let i = 0; i < 13; i++) {
      const d = T.descriptor_313A[r][i];
      if (d === 0xFF) continue;
      const c = d & 7, p = (d >> 3) & 0x1F;
      const col = (T.ramp_36CE[c] || [])[p];
      const row = (T.ramp_374C[c] || [])[p];
      if (col == null || row == null || col > 20 || row > 5) continue;
      ring[col * 6 + row] = r;
    }
  }
  FW_RING = ring;
  return ring;
}
function fwGrad(phase) {
  const T = window.FW_TABLES;
  return T.gradient_330B[((phase % 192) + 192) % 192];
}
// base = 基相 [EE3]（0..191）
function fwFrame(sel, base, p) {
  const T = window.FW_TABLES;
  const frame = new Array(126).fill(null);
  const ring = fwRingMap();
  if (!T || !ring) return frame;
  const multi = sel === 17 ? true : !!p.multi;   // 花开富贵固定彩虹（官方 UI 不吃调色盘）
  const lvl = Math.max(0, Math.min(4, (p.level == null ? 4 : p.level) | 0));
  const gain = T.bright_311D[lvl] / 80;         // 0x311D 五档 0/20/40/60/80，÷0x50
  for (let slot = 0; slot < 126; slot++) {
    const r = ring[slot];
    if (r < 0) continue;
    const src = multi ? fwGrad(base + 13 * r) : p.color;  // 多彩 0x330B / 单色调色盘
    frame[slot] = [src[0] * gain, src[1] * gain, src[2] * gain];
  }
  return frame;
}

// ── 模式 2 呼吸：15 列固定色相（0x330B[11*col]，固件 idx==7 路径把 R/B 对调）
//    + 0xC480[0..0x7F] 三角波整体呼吸（A317 反向 1/帧，limit 0x80）──
function fwBreathFrame(breathPhase, p) {
  const T = window.FW_TABLES;
  const frame = new Array(126).fill(null);
  if (!T) return frame;
  const lvl = Math.max(0, Math.min(4, (p.level == null ? 4 : p.level) | 0));
  const gain = T.bright_311D[lvl] / 80;
  const k = gain * (T.breath_C480[((breathPhase % 128) + 128) % 128] / 255);
  for (let c = 0; c < 15; c++) {
    const g = T.gradient_330B[(11 * c) % 192];
    const rgb = p.multi ? [g[2], g[1], g[0]] : p.color;   // 0x330B 的 R/B 对调
    for (let r = 0; r < 6; r++) {
      if (T.mask_C500[c * 6 + r] === 0xFF) continue;      // 0xC500：0xFF = 无灯位
      const col = T.ramp_36CE[r][c];                      // 行 5 有列置换
      const row = T.ramp_374C[r][c];
      if (col > 20 || row > 5) continue;
      frame[col * 6 + row] = [rgb[0] * k, rgb[1] * k, rgb[2] * k];
    }
  }
  return frame;
}

// ── 模式 3 梦幻彩虹：全键同色，0x330B[[08BF]] 每帧 -1 循环（A317 limit 0xC0）
//    像素集来自 0xC500（值 = col<<3 | row，行 4 有错位映射）──
function fwHueCycleFrame(phase, p) {
  const T = window.FW_TABLES;
  const frame = new Array(126).fill(null);
  if (!T) return frame;
  const lvl = Math.max(0, Math.min(4, (p.level == null ? 4 : p.level) | 0));
  const gain = T.bright_311D[lvl] / 80;
  const g = T.gradient_330B[((phase % 192) + 192) % 192];
  const rgb = p.multi ? g : p.color;        // 固件 idx!=7 → 调色盘静态单色
  for (let i = 0; i < 90; i++) {
    const d = T.mask_C500[i];
    if (d === 0xFF) continue;
    const col = (d >> 3) & 0x1F, row = d & 7;
    if (col > 20 || row > 5) continue;
    frame[col * 6 + row] = [rgb[0] * gain, rgb[1] * gain, rgb[2] * gain];
  }
  return frame;
}

// ── 模式 16 七彩瀑布：6 行各一色（0x330B[[EE1]]，每行 +0x19），整帧滚动 ──
//    像素集来自 0xC500（col<<3|row，行 4 错位），每行独立色相
function fwWaterfallFrame(base, p) {
  const T = window.FW_TABLES;
  const frame = new Array(126).fill(null);
  if (!T) return frame;
  const lvl = Math.max(0, Math.min(4, (p.level == null ? 4 : p.level) | 0));
  const gain = T.bright_311D[lvl] / 80;
  for (let r = 0; r < 6; r++) {
    const g = T.gradient_330B[((base + 25 * r) % 192 + 192) % 192];
    for (let c = 0; c < 15; c++) {
      const d = T.mask_C500[c * 6 + r];
      if (d === 0xFF) continue;
      const col = (d >> 3) & 0x1F, row = d & 7;
      if (col > 20 || row > 5) continue;
      frame[col * 6 + row] = [g[0] * gain, g[1] * gain, g[2] * gain];
    }
  }
  return frame;
}

// ── 模式 11 随波逐流：15 列各一色（0x330B，每列 +7）；单色走 0x31AF 列亮度波（每列 +10，wrap 0x60）──
function fwWaveFrame(base, p) {
  const T = window.FW_TABLES;
  const frame = new Array(126).fill(null);
  if (!T) return frame;
  const lvl = Math.max(0, Math.min(4, (p.level == null ? 4 : p.level) | 0));
  const gain = T.bright_311D[lvl] / 80;
  for (let c = 0; c < 15; c++) {
    let rgb, k = gain;
    if (p.multi) {
      rgb = T.gradient_330B[(((base + 7 * c) % 192) + 192) % 192];
    } else {
      rgb = p.color;
      k *= T.curve_31AF[(((base + 10 * c) % 96) + 96) % 96] / 255;   // A098 呼吸曲线（96 项）
    }
    for (let r = 0; r < 6; r++) {
      const col = T.ramp_36CE[r][c], row = T.ramp_374C[r][c];
      if (col > 20 || row > 5) continue;
      frame[col * 6 + row] = [rgb[0] * k, rgb[1] * k, rgb[2] * k];
    }
  }
  return frame;
}

// ── 模式 4/7/13：共用 0x5968 位平面引擎 ─────────────────────────────────
// 四组 15 字节列掩码：A=0x0001 / B=0x013B / C=0x02E8 / D=0x08C2，bit=行(0..5)。
// 0x5968 每帧把四组按列 OR：列 c 行 r 命中 → 经 0x36CE/0x374C 换成物理 (col,row)
// → 0x5114(R3=1) 写第二帧缓冲 0x0424、拖尾因子 0x0017=0x20、立即显示 0x0152。
// 0x5A6C 帧末演化掩码：A 右移一列(补 0)、B 左移一列(补 0)、C<<=1、D>>=1，
// 再把 C|D 并进 A/B —— 一套无回绕的对角波扩散。
// 0x64A9 按 [0979] 阈值衰减：用 0x0424 原色×因子/32 重算显示；因子 -1（模式 13 为 -2）。
// 时间基准：4/5/7/8/10/12 = 5ms/tick，6/15 = 10ms，13 = 3ms（网页观感标定）。
// 种子：模式 4 = 键位 A+B（只横向扩散）；模式 7 = A+B+C+D（二维涟漪）；
// 模式 13 = 进入时种 (6,0)，之后每 5 次 CA 在 (6,0)/(6,5) 交替补种（0x5B83），形成连续正弦波；
// 3ms/tick 下 64A9 每 6ms 减 1，因子 32→0 约 192ms 拖影（覆盖 55 tick 帧间隔）。
// 速度 → 帧间隔来自 0x37DE/0x37E8/0x3801（[08B7]:[08B8]，单位 tick）。
const FW_TRIG_F0 = 0x20;            // 0x0017 初值 32 = 满亮度
// 逐模式 tick（网页观感标定）：4/5/7/8/10/12 = 5ms；6/15 = 10ms；13 = 3ms。
// 旧模式 2/3/11/16/17 走 previewTick 里的 n = t*30*p.speed 时钟，不经过这里。
// 需要单独调某个模式时可在这里加覆盖，例如 { 6: 21 }。
const FW_TICK_MS = { 6: 10, 15: 10, 13: 3 };   // 轮盘/风车 10ms；正弦光波 3ms，拖影约 96ms
const FW_TICK_DEFAULT = 5;
function fwTickMs(sel) { return FW_TICK_MS[sel] || FW_TICK_DEFAULT; }
let FW_TRIG = null;
function fwTrigNew(sel) {
  return {
    sel,
    A: new Uint8Array(15), B: new Uint8Array(15),
    C: new Uint8Array(15), D: new Uint8Array(15),
    rgb: new Float32Array(126 * 3),   // 0x0424 第二帧缓冲（原始色）
    fac: new Uint8Array(126),         // 0x0017 拖尾因子
    disp: new Float32Array(126 * 3),  // 当前显示值
    peak: new Float32Array(126 * 3),  // 本渲染窗口内的峰值（避免 21ms 渲染错过 1ms 快闪）
    tick: 0, acc: 0, lastFrame: 0, lastDecay: 0,
    caCount: 0, seedPhase: 0,        // 模式 13：0x08BA / RAM24.7
  };
}
function fwTrigSeed(st, c, r, all) {
  if (c < 0 || c > 14 || r < 0 || r > 5) return;
  const bit = 1 << r;
  st.A[c] |= bit; st.B[c] |= bit;      // 0x18E8 → 0x013B / 0x0001
  if (all) { st.C[c] |= bit; st.D[c] |= bit; }   // 0x186C 额外种 0x02E8 / 0x08C2
}
function fwTrigReset(sel) {
  FW_TRIG = fwTrigNew(sel);
  if (sel === 13) fwTrigSeed(FW_TRIG, 6, 0, true);  // 0xA7D1：清空后种中列顶行
  return FW_TRIG;
}
// 按键 → C500[槽] 给出逻辑 (c,r)（行 4 含列置换），模式 4/7 的 0x1806/0x186C
function fwTrigKey(sel, slot) {
  const T = window.FW_TABLES;
  if (!T || (sel !== 4 && sel !== 7)) return;
  if (!FW_TRIG || FW_TRIG.sel !== sel) fwTrigReset(sel);
  const d = T.mask_C500[slot];
  if (d == null || d === 0xFF) return;
  const r = d & 7, c = (d >> 3) & 0x1f;
  if (c > 14 || r > 5) return;
  fwTrigSeed(FW_TRIG, c, r, sel === 7);
}
// 通用拖尾层：0x0424 原色 × 0x0017/32（不回写），held 位=1 的像素跳过（0x0CFC）
function fwTrailDecay(st, p, step, held) {
  const T = window.FW_TABLES;
  const gain = T.bright_311D[Math.max(0, Math.min(4, p.level | 0))] / 80;
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 15; c++) {
      const col = T.ramp_36CE[r][c], row = T.ramp_374C[r][c];
      if (col > 20 || row > 5) continue;
      const slot = col * 6 + row, o = slot * 3, k = st.fac[slot];
      if (held && held[slot]) continue;            // 0x64A9 的 0x0CFC 跳过
      if (!k) {
        st.disp[o] = st.disp[o + 1] = st.disp[o + 2] = 0;
        continue;
      }
      const f = (k / FW_TRIG_F0) * gain;
      for (let ch = 0; ch < 3; ch++) st.disp[o + ch] = st.rgb[o + ch] * f;
      st.fac[slot] = k > step ? k - step : 0;
    }
  }
}
// 0x5114 R3=1：写一帧特效色 + 0x0017=0x20 + 立即显示
function fwBufPut(st, slot, p, fac) {
  const T = window.FW_TABLES;
  const gain = T.bright_311D[Math.max(0, Math.min(4, p.level | 0))] / 80;
  const src = p.multi ? T.gradient_330B[(Math.random() * 192) | 0] : p.color;
  const o = slot * 3;
  for (let ch = 0; ch < 3; ch++) {
    st.rgb[o + ch] = src[ch];
    st.disp[o + ch] = src[ch] * gain;
  }
  st.fac[slot] = fac;
}
// 模式 13 固件步进是 2（16 次就黑），但帧间隔有 55 tick；网页用步进 1（32 次）
// 让余晖覆盖到下一帧，避免“一亮一灭”。其余模式仍按固件步进。
function fwTrigDecay(st, p) { fwTrailDecay(st, p, 1, null); }
// 0x5968：本帧所有命中像素写 0x0424 + 0x0017=32 + 显示
function fwTrigEngine(st, p) {
  const T = window.FW_TABLES;
  for (let c = 0; c < 15; c++) {
    const m = (st.A[c] | st.B[c] | st.C[c] | st.D[c]) & 0x3f;
    if (!m) continue;
    for (let r = 0; r < 6; r++) {
      if (!((m >> r) & 1)) continue;
      const col = T.ramp_36CE[r][c], row = T.ramp_374C[r][c];
      if (col > 20 || row > 5) continue;
      fwBufPut(st, col * 6 + row, p, FW_TRIG_F0);
    }
  }
}
// 0x5A6C：A 右移一列（A[0] 清 0）、B 左移一列（B[14] 清 0）、C<<=1、D>>=1，再并入 C|D
function fwTrigStep(st) {
  const A = st.A, B = st.B, C = st.C, D = st.D;
  const A2 = new Uint8Array(15), B2 = new Uint8Array(15);
  const C2 = new Uint8Array(15), D2 = new Uint8Array(15);
  for (let c = 0; c < 15; c++) {
    C2[c] = (C[c] << 1) & 0xff;
    D2[c] = D[c] >> 1;
  }
  for (let c = 1; c < 15; c++) A2[c] = A[c - 1];   // 0x0001：A 右移
  for (let c = 0; c < 14; c++) B2[c] = B[c + 1];   // 0x013B：B 左移
  for (let c = 0; c < 15; c++) {
    const m = C2[c] | D2[c];
    A2[c] |= m; B2[c] |= m;
  }
  st.A = A2; st.B = B2; st.C = C2; st.D = D2;
}
function fwTrigFrame(p, dtMs) {
  const T = window.FW_TABLES;
  if (!T) return null;
  if (!FW_TRIG || FW_TRIG.sel !== p.sel) fwTrigReset(p.sel);
  const st = FW_TRIG;
  st.acc += Math.max(0, Math.min(120, dtMs || 0));
  const tickMs = fwTickMs(st.sel);
  let ticks = Math.floor(st.acc / tickMs);
  st.acc -= ticks * tickMs;
  const spd = Math.max(0, Math.min(4, p.spd | 0));
  const fi = (T.trig_interval[String(p.sel)] || [40])[spd] || 40;
  const dec = (T.trig_decay[String(p.sel)] || 15);
  for (let i = 0; i < ticks; i++) {
    st.tick++;
    if (st.tick - st.lastDecay >= dec) { st.lastDecay = st.tick; fwTrigDecay(st, p); }
    if (st.tick - st.lastFrame >= fi) {
      st.lastFrame = st.tick;
      fwTrigEngine(st, p);
      fwTrigStep(st);
      if (p.sel === 13) {
        st.caCount++;
        if (st.caCount >= 5) {                 // 0x5B83：每 5 次 CA
          st.caCount = 0;
          fwTrigSeed(st, 6, st.seedPhase ? 5 : 0, true);  // 0/5 行交替补种
          st.seedPhase = st.seedPhase ? 0 : 1;
        }
      }
    }
    for (let o = 0; o < 378; o++) if (st.disp[o] > st.peak[o]) st.peak[o] = st.disp[o];
  }
  const out = new Array(126).fill(null);
  for (let slot = 0; slot < 126; slot++) {
    const o = slot * 3;
    const r = st.peak[o], g = st.peak[o + 1], b = st.peak[o + 2];
    if (r > 0.5 || g > 0.5 || b > 0.5) out[slot] = [r, g, b];
    st.peak[o] = st.peak[o + 1] = st.peak[o + 2] = 0;
  }
  return out;
}


// ── 模式 5/6/8/10/12/15：0x0424 拖尾层或逐像素相位 ─────────────────────
// 5 雨中漫步：0x0E23 每列雨滴行号，每帧随机一列起雨、逐行下落（0x9A4C）
// 6 彩虹轮盘：0x0017 逐像素相位（初相 0x320F/0x328D），每帧 -1（0x6081）
// 8 繁星点点：0x5E48 随机造星，0x629E 每 15 tick 按 age/32 明灭（0xAB9B）
// 10 川流不息：单光点在 15×6 网格对角折返，64A9 拖尾（0x8A06）
// 12 如影随形：按键写色，0x0CFC 按住位跳过衰减，松开后淡出（0x64A9）
// 15 旋转风车：0x0017 相位（初相 0x9F0D），每帧 -1，0x354E 128 色环（0x7E94）
let FW_EXTRA = null;
const FW_EXTRA_HELD = new Set();
function fwGain(p) {
  const T = window.FW_TABLES;
  return T.bright_311D[Math.max(0, Math.min(4, p.level | 0))] / 80;
}
function fwSlot(c, r) {
  const T = window.FW_TABLES;
  if (c < 0 || c > 14 || r < 0 || r > 5) return -1;
  const col = T.ramp_36CE[r][c], row = T.ramp_374C[r][c];
  return (col > 20 || row > 5) ? -1 : col * 6 + row;
}
function fwExtraNew(sel) {
  const st = {
    sel, tick: 0, acc: 0, lastFrame: 0, lastDecay: 0, lastAge: 0, out: null,
    rgb: new Float32Array(126 * 3), fac: new Uint8Array(126), disp: new Float32Array(126 * 3),
  };
  if (sel === 5) st.cols = new Uint8Array(15).fill(0xFF);
  if (sel === 6 || sel === 15) { st.ph = new Uint8Array(126); st.phaseKey = ""; }
  if (sel === 8) { st.held = new Uint8Array(126); st.age = new Uint8Array(126); }
  if (sel === 10) { st.row = 0; st.col = 0; st.dir = 0; st.hdir = 0; }
  if (sel === 12) st.held = new Uint8Array(126);
  return st;
}
function fwExtraInitPhase(st, p) {
  const T = window.FW_TABLES;
  if (p.sel === 6) {
    const src = p.multi ? T.phase6_320F : T.phase6_328D;
    for (let i = 0; i < 126; i++) st.ph[i] = src[i] || 0;
    st.phaseKey = p.multi ? "m" : "s";
  } else if (p.sel === 15) {
    for (let i = 0; i < 126; i++) st.ph[i] = T.phase15_9F0D[i] || 0;
    st.phaseKey = "15";
  }
}
function fwExtraReset(sel, p) {
  FW_EXTRA = fwExtraNew(sel);
  if (sel === 6 || sel === 15) fwExtraInitPhase(FW_EXTRA, p);
  return FW_EXTRA;
}
function fwExtraEnsure(p) {
  if (!FW_EXTRA || FW_EXTRA.sel !== p.sel) return fwExtraReset(p.sel, p);
  if (p.sel === 6) {
    const key = p.multi ? "m" : "s";
    if (FW_EXTRA.phaseKey !== key) fwExtraInitPhase(FW_EXTRA, p);
  }
  return FW_EXTRA;
}
// 0x9A4C：随机一列起雨（状态 0xFF → 0），逐列下落；状态 ≥6 置 0xFF
function fwRainEngine(st, p) {
  const c0 = (Math.random() * 15) | 0;
  if (st.cols[c0] === 0xFF) st.cols[c0] = 0;
  for (let c = 0; c < 15; c++) {
    const s = st.cols[c];
    if (s >= 6) { st.cols[c] = 0xFF; continue; }
    const slot = fwSlot(c, s);
    if (slot >= 0) fwBufPut(st, slot, p, FW_TRIG_F0);
    st.cols[c] = s + 1;
  }
}
// 0x8A06：画当前点，再按 0x0E/0xFF 边界折返
function fwFlowEngine(st, p) {
  const slot = fwSlot(st.col, st.row);
  if (slot >= 0) fwBufPut(st, slot, p, FW_TRIG_F0);
  if (st.dir !== 0) {
    st.col = (st.col + 1) & 0xff;
    if (st.col >= 14) { st.dir = 0; st.col = 14; st.row = (st.row + (st.hdir ? 1 : -1)) & 0xff; }
  } else {
    st.col = (st.col - 1) & 0xff;
    if (st.col >= 14) { st.dir = 0xff; st.col = 0; st.row = (st.row + (st.hdir ? 1 : -1)) & 0xff; }
  }
  if (st.row < 5) { /* 0..4 保持 */ }
  else if (st.row !== 0xff) { st.hdir ^= 0xff; st.row = 4; }
  else { st.hdir ^= 0xff; st.row = 1; }
}
// 0x5E48：每次最多造 5 颗星（0x36CE/0x374C 平坦索引 0..125）
function fwStarSpawn(st, p) {
  const T = window.FW_TABLES;
  for (let i = 0; i < 5; i++) {
    const idx = (Math.random() * 126) | 0;
    const rr = (idx / 21) | 0, cc = idx % 21;
    const col = T.ramp_36CE[rr][cc], row = T.ramp_374C[rr][cc];
    if (col >= 15 || row > 5) continue;
    const slot = col * 6 + row;
    if (st.held[slot] || st.age[slot]) continue;
    const src = p.multi ? T.gradient_330B[(Math.random() * 192) | 0] : p.color;
    const o = slot * 3;
    for (let ch = 0; ch < 3; ch++) st.rgb[o + ch] = src[ch];
    st.age[slot] = 0;
    st.held[slot] = 1;
  }
}
// 0x629E：age/32 显示；按住时 age++（到 32 清 0x0CFC），松开后 age--
function fwStarAge(st, p) {
  const gain = fwGain(p);
  for (let c = 0; c < 15; c++) {
    for (let r = 0; r < 6; r++) {
      const slot = fwSlot(c, r);
      if (slot < 0) continue;
      const o = slot * 3, a = st.age[slot], f = (a / 32) * gain;
      for (let ch = 0; ch < 3; ch++) st.disp[o + ch] = st.rgb[o + ch] * f;
      if (st.held[slot]) {
        let n = a + 1;
        if (n >= 32) { n = 32; st.held[slot] = 0; }
        st.age[slot] = n;
      } else if (a > 0) st.age[slot] = a - 1;
    }
  }
}
// 0x6081：逐像素相位 -1，wrap 0xC0（多彩）/0x60（单色）
function fwWheelEngine(st, p) {
  const T = window.FW_TABLES, gain = fwGain(p);
  const lim = p.multi ? 0xC0 : 0x60;
  const out = new Array(126).fill(null);
  for (let c = 0; c < 15; c++) {
    for (let r = 0; r < 6; r++) {
      const i = c * 6 + r;
      let k = st.ph[i];
      k = (k === 0) ? lim - 1 : k - 1;
      st.ph[i] = k;
      const slot = fwSlot(c, r);
      if (slot < 0) continue;
      let src, kk = gain;
      if (p.multi) src = T.gradient_330B[k];
      else { src = p.color; kk *= (T.curve_31AF[k] || 0) / 255; }
      out[slot] = [src[0] * kk, src[1] * kk, src[2] * kk];
    }
  }
  return out;
}
// 0x7E94：逐像素相位 -1，wrap 0x80，查 0x354E 色环
function fwWindmillEngine(st, p) {
  const T = window.FW_TABLES, gain = fwGain(p);
  const out = new Array(126).fill(null);
  for (let c = 0; c < 15; c++) {
    for (let r = 0; r < 6; r++) {
      const i = c * 6 + r;
      let k = st.ph[i];
      k = (k === 0) ? 0x7F : k - 1;
      st.ph[i] = k;
      const slot = fwSlot(c, r);
      if (slot < 0) continue;
      const src = T.wheel_354E[k];
      out[slot] = [src[0] * gain, src[1] * gain, src[2] * gain];
    }
  }
  return out;
}
function fwDispOut(st) {
  const out = new Array(126).fill(null);
  for (let slot = 0; slot < 126; slot++) {
    const o = slot * 3;
    const r = st.disp[o], g = st.disp[o + 1], b = st.disp[o + 2];
    if (r > 0.5 || g > 0.5 || b > 0.5) out[slot] = [r, g, b];
  }
  return out;
}
function fwExtraFrame(p, dtMs) {
  const T = window.FW_TABLES;
  if (!T) return null;
  const st = fwExtraEnsure(p);
  st.acc += Math.max(0, Math.min(120, dtMs || 0));
  const tickMs = fwTickMs(st.sel);
  let ticks = Math.floor(st.acc / tickMs);
  st.acc -= ticks * tickMs;
  const spd = Math.max(0, Math.min(4, p.spd | 0));
  const fi = (T.trig_interval[String(p.sel)] || [40])[spd] || 40;
  const dec = (T.trig_decay[String(p.sel)] || 15);
  for (let i = 0; i < ticks; i++) {
    st.tick++;
    if (p.sel === 5 || p.sel === 10) {
      if (st.tick - st.lastDecay >= dec) { st.lastDecay = st.tick; fwTrailDecay(st, p, 1, null); }
      if (st.tick - st.lastFrame >= fi) {
        st.lastFrame = st.tick;
        if (p.sel === 5) fwRainEngine(st, p); else fwFlowEngine(st, p);
      }
    } else if (p.sel === 12) {
      if (st.tick - st.lastFrame >= fi) { st.lastFrame = st.tick; fwTrailDecay(st, p, 1, st.held); }
    } else if (p.sel === 8) {
      if (st.tick - st.lastAge >= 15) { st.lastAge = st.tick; fwStarAge(st, p); }
      if (st.tick - st.lastFrame >= fi) { st.lastFrame = st.tick; fwStarSpawn(st, p); }
    } else if (p.sel === 6 || p.sel === 15) {
      if (st.tick - st.lastFrame >= fi) {
        st.lastFrame = st.tick;
        st.out = (p.sel === 6) ? fwWheelEngine(st, p) : fwWindmillEngine(st, p);
      }
    }
  }
  if (p.sel === 6 || p.sel === 15) return st.out || new Array(126).fill(null);
  return fwDispOut(st);
}
function fwExtraPress(sel, slot) {
  if (sel !== 12) return;
  const p = previewParams();
  if (!p) return;
  const st = fwExtraEnsure(p);
  st.held[slot] = 1;
  fwBufPut(st, slot, p, FW_TRIG_F0);
  FW_EXTRA_HELD.add(slot);
}
function fwExtraRelease(sel, slot) {
  if (sel !== 12) return;
  const st = FW_EXTRA;
  if (st && st.sel === 12) st.held[slot] = 0;
  FW_EXTRA_HELD.delete(slot);
}
// 按键触发类效果的事件（点击键盘记录：位置/时间/随机色相）
const PV_EVT = [];
function pvOnKeyClick(slot, nx, ny) {
  PV_EVT.push({ slot, nx, ny, t0: (performance.now() - PREVIEW.t0) / 1000, hue: Math.random() * 360 });
  while (PV_EVT.length > 16) PV_EVT.shift();
}
function pvLastEvt(t, maxAge) {
  let best = null;
  for (const e of PV_EVT) {
    const age = t - e.t0;
    if (age >= 0 && age < maxAge && (!best || age < best.age)) best = { e, age };
  }
  return best;
}
function pvColor(sel, slot, nx, ny, t, p) {
  const sp = p.speed, br = p.bright;
  const mix = (shape, huePhase) => pvScale(p.multi ? pvHue(huePhase) : p.color, br * shape);
  const fixed = (huePhase) => pvScale(pvHue(huePhase), br);
  const cx = 0.5, cy = 0.55;                       // 键盘几何中心（约在 G/H 之间）
  const dist = Math.hypot(nx - cx, ny - cy);
  if (sel === 1) {                                 // 常亮：中心红→橙黄绿青蓝向外扩（静态径向彩虹）
    return mix(1, Math.min(1, dist / 0.62) * 235);
  }
  if (sel === 2) {                                 // 呼吸：左蓝→右紫 + 整体呼吸
    const k = 0.28 + 0.72 * (0.5 + 0.5 * Math.sin(t * 1.2 * sp));
    return mix(k, 238 + nx * 52);
  }
  if (sel === 3) return fixed(nx * 300 + t * 45 * sp);            // 梦幻彩虹：彩虹轮换（会动）
  if (sel === 4) {                                 // 一触即发：从按下的那一列向两侧扩散随机色
    const ev = pvLastEvt(t, 2.4);
    if (!ev) return [0, 0, 0];
    const r = ev.age * 0.85 * sp;
    const band = Math.max(0, 1 - Math.abs(Math.abs(nx - ev.e.nx) - r) / 0.18);
    if (!band) return [0, 0, 0];
    return pvScale(p.multi ? pvHue(pvHash(nx * 9, ny * 7) * 360) : p.color, br * band);
  }
  if (sel === 5) {                                 // 雨中漫步：一列列彩色雨条自上而下，每键不同色
    const col = Math.round(nx * 22);
    const ph = pvHash(col, 3) * 1.4;
    const y = (t * 0.55 * sp + ph) % 1.35;
    const k = Math.max(0, 1 - Math.abs(ny - y) / 0.16);
    if (!k) return [0, 0, 0];
    return pvScale(pvHue(pvHash(col, Math.floor(t * 0.55 * sp + ph) * 17) * 360), br * k);
  }
  if (sel === 6) {                                 // 彩虹轮盘：整体逆时针转，接缝在 Q/A 左侧
    let u = nx - 0.22; if (u < 0) u += 1;
    const hue = 300 - u * 300 - t * 55 * sp;
    const seam = (u > 0.995 || u < 0.005) ? 0.25 : 1;
    return mix(seam, hue);
  }
  if (sel === 7) {                                 // 涟漪扩散：点击某键从该键向外扩散随机色
    const ev = pvLastEvt(t, 2.6);
    if (!ev) return [0, 0, 0];
    const d = Math.hypot(nx - ev.e.nx, ny - ev.e.ny);
    const r = ev.age * 0.75 * sp;
    const band = Math.max(0, 1 - Math.abs(d - r) / 0.22);
    if (!band) return [0, 0, 0];
    return pvScale(p.multi ? pvHue(pvHash(nx * 13, ny * 11) * 360) : p.color, br * band);
  }
  if (sel === 8) {                                 // 繁星点点：慢速闪烁、平滑淡入淡出
    const ph = pvHash(nx * 13, ny * 17) * 6.28;
    const s = Math.sin(ph + t * 0.9 * sp);
    const k = s > 0 ? s ** 4 : 0;
    return mix(0.04 + k * 0.96, pvHash(nx, ny) * 360);
  }
  if (sel === 10) {                                // 川流不息：像贪吃蛇一样一段在跑，其余熄灭
    const head = ((t * 0.22 * sp + 0.35) % 1.35) - 0.15;
    const d = head - nx;
    if (d < 0 || d > 0.42) return [0, 0, 0];
    const k = Math.max(0, 1 - d / 0.42);
    return mix(0.15 + 0.85 * k, nx * 300 + t * 60);
  }
  if (sel === 11) return mix(1, nx * 300 - t * 70 * sp);           // 随波逐流：从左到右
  if (sel === 12) {                                // 如影随形：按下哪个键就亮哪个键（随机色，缓慢淡出）
    let k = 0, hue = 0;
    for (const e of PV_EVT) {
      if (e.slot !== slot) continue;
      const age = t - e.t0;
      if (age < 0 || age > 5) continue;
      const v = 1 - age / 5;
      if (v > k) { k = v; hue = e.hue; }
    }
    if (!k) return [0, 0, 0];
    return pvScale(pvHue(hue), br * k);
  }
  if (sel === 13) {                                // 正弦光波：一条波带上下扫
    const y0 = 0.5 + 0.5 * Math.sin(t * 1.1 * sp);
    const k = Math.max(0, 1 - Math.abs(ny - y0) / 0.3);
    if (!k) return [0, 0, 0];
    return mix(k, nx * 300 + t * 50);
  }
  if (sel === 15) {                                // 旋转风车：顺时针
    const a = Math.atan2(ny - cy, nx - cx);
    return fixed(-a * 57.3 + t * 70 * sp);
  }
  if (sel === 16) return fixed(ny * 300 + t * 80 * sp);            // 七彩瀑布：从上到下
  if (sel === 17) return fixed(dist * 320 - t * 75 * sp);          // 花开富贵：中心向外
  return mix(1, 0);
}
function previewTick(ts) {
  if (!previewActive()) { stopPreview(); return; }
  PREVIEW.raf = requestAnimationFrame(previewTick);
  // 21ms 渲染 tick（≈48fps）；动画 tick 5ms（每个渲染 tick 约 4 个固件 tick）
  if (ts - PREVIEW.last < 21) return;
  const dtMs = PREVIEW.last ? Math.min(120, ts - PREVIEW.last) : 21;   // 固件 tick 用真实耗时推进
  PREVIEW.last = ts;
  const p = previewParams();
  if (!p) return;
  const t = (ts - PREVIEW.t0) / 1000;
  const kb = document.querySelector('#keyboard .kb');
  // 固件帧：常亮(1) 静态径向彩虹；花开富贵(17) 反向旋转；呼吸(2) 列渐变+整体呼吸；
  // 梦幻彩虹(3) 全键同色每帧 -1 循环
  let fwPix = null;
  if (window.FW_TABLES && [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17].includes(p.sel)) {
    const n = Math.floor(t * 30 * p.speed);            // 帧号（速度=帧间隔的近似）
    if (p.sel === 4 || p.sel === 7 || p.sel === 13) {
      fwPix = fwTrigFrame(p, dtMs);                    // 0x5968 位平面引擎（按固件 tick 推进）
    } else if ([5, 6, 8, 10, 12, 15].includes(p.sel)) {
      fwPix = fwExtraFrame(p, dtMs);                   // 0x9A4C/0x6081/0xAB9B/0x8A06/0x64A9/0x7E94
    } else if (p.sel === 2) {
      fwPix = fwBreathFrame(((0x7F - n) % 128 + 128) % 128, p);   // A317 反向 1/帧
    } else if (p.sel === 3) {
      fwPix = fwHueCycleFrame((0xBF - n) % 192, { ...p, multi: true });  // 固定彩虹
    } else if (p.sel === 11) {
      const lim = p.multi ? 192 : 96;                   // A317 limit 0xC0 / 0x60
      fwPix = fwWaveFrame((lim - 1 - n) % lim, p);
    } else if (p.sel === 16) {
      fwPix = fwWaterfallFrame((0xBF - n) % 192, { ...p, multi: true });  // 固定彩虹
    } else {
      const base = p.sel === 17 ? (((0xBF - 2 * n) % 192 + 192) % 192) : 0;
      fwPix = fwFrame(p.sel, base, p);
    }
  }
  if (kb) kb.classList.add('color-mode');
  // 固件坐标：col = slot/6（0..20 列）、row = slot%6（0..5 行）；归一化到 0..1
  document.querySelectorAll('#keyboard .key').forEach(el => {
    const slot = Number(el.dataset.slot);
    const col = Math.floor(slot / 6), row = slot % 6;
    const nx = col / 14, ny = row / 5;
    const rgb = (fwPix ? (fwPix[slot] || [0, 0, 0]) : pvColor(p.sel, slot, nx, ny, t, p))
      .map(v => Math.max(0, Math.min(255, Math.round(v))));
    el.style.setProperty('--cs', rgbToHex(rgb[0], rgb[1], rgb[2]));
  });
}
function stopPreview() {
  if (PREVIEW.raf) cancelAnimationFrame(PREVIEW.raf);
  PREVIEW.raf = 0;
  FW_TRIG = null;                                  // 退出预览：清掉位平面/拖尾状态
  FW_EXTRA = null;
  FW_EXTRA_HELD.clear();
  if (S.lightSel === 21) return;
  const kb = document.querySelector('#keyboard .kb');
  if (kb) kb.classList.remove('color-mode');
  document.querySelectorAll('#keyboard .key').forEach(el => el.style.removeProperty('--cs'));
}
function updatePreview() {
  if (previewActive()) {
    if (!PREVIEW.raf) {
      PREVIEW.t0 = performance.now(); PREVIEW.last = 0;
      PREVIEW.raf = requestAnimationFrame(previewTick);
    }
  } else stopPreview();
}

// ── 自定义模式画笔：点/划 = 用当前色涂；同色再点 = 擦除；橡皮开关 = 直接擦 ──
let csDrag = null;
function csPaintSlot(slot) {
  if (!csDrag || csDrag.seen.has(slot)) return;
  csDrag.seen.add(slot);
  setKeyColor(slot, csDrag.action === 'erase' ? null : lightColor());
}
$('keyboard').addEventListener('pointerdown', e => {
  if (!inCustomColorMode()) {
    if (previewActive() && S.lightSel === 12) {       // 如影随形：按住亮、松开淡出
      const pel = e.target.closest('.key');
      if (pel) { e.preventDefault(); fwExtraPress(12, Number(pel.dataset.slot)); }
    }
    return;
  }
  const el = e.target.closest('.key');
  if (!el) return;
  e.preventDefault();                               // 阻止文本选择，划选更顺
  const slot = Number(el.dataset.slot);
  const brush = S.eraser ? '#000000' : lightColor();
  const same = frameColorAt(slot).toLowerCase() === brush.toLowerCase();
  csDrag = { action: (S.eraser || same) ? 'erase' : 'paint', seen: new Set() };
  csPaintSlot(slot);
});
document.addEventListener('pointermove', e => {
  if (!csDrag) return;
  const t = document.elementFromPoint(e.clientX, e.clientY);
  const el = t && t.closest ? t.closest('.key') : null;
  if (!el || !$('keyboard').contains(el)) return;
  csPaintSlot(Number(el.dataset.slot));
});
function fwExtraReleaseAll() {
  for (const slot of [...FW_EXTRA_HELD]) fwExtraRelease(12, slot);
}
document.addEventListener('pointerup', () => { csDrag = null; fwExtraReleaseAll(); });
document.addEventListener('pointercancel', fwExtraReleaseAll);

$('keyboard').onclick = e => {
  if (inCustomColorMode()) return;                  // 上色模式下点击=选色，不进键位编辑器
  const el = e.target.closest('.key');
  if (!el) return;
  if (previewActive()) {                            // 预览中：点击触发按键类效果，不进键位编辑器
    const pslot = Number(el.dataset.slot);
    fwTrigKey(S.lightSel, pslot);                   // 模式 4/7：按键 = 位平面种子（0x1806/0x186C）
    const geo = pvGeo();
    const g = geo && geo.get(pslot);
    if (g) pvOnKeyClick(pslot, g[0], g[1]);
    return;
  }
  const slot = Number(el.dataset.slot);
  if (!Number.isInteger(slot)) return;
  // 再次点击已选中键 = 取消选中
  if (S.sel === slot) { closeEditor(); return; }
  openEditor(slot, el.dataset.name || '');
};

// 类型按钮：默认键/空=立即暂存；普通/组合/宏=切换模式等右侧点选
$('edTypeRow').onclick = e => {
  const b = e.target.closest('button[data-type]');
  if (!b || S.sel === null) return;
  const t = b.dataset.type;
  if (t === 'default') {
    const fac = factoryRecord(S.sel);
    if (!fac) { Leobog.log('无出厂键表数据，无法恢复默认', 'bad'); return; }
    $('edType').value = 'normal';                   // 恢复后按实际类型展示
    stageRecord(fac, '出厂默认');
    openEditor(S.sel, $('edKey').textContent);      // 刷新状态/类型
    return;
  }
  if (t === 'empty') {
    // 与「默认键」同为一次性动作：暂存清空后按实际记录刷新编辑器
    stageRecord([0, 0, 0, 0], '空');
    openEditor(S.sel, $('edKey').textContent);
    return;
  }
  // 切到组合键：usage 若是修饰键（0xE0–E7，从普通键带过来的残留）→ 清空，须在组合模式重选主键
  if (t === 'combo') {
    const u = Number($('edUsage').value);
    if (u >= 0xe0 && u <= 0xe7) {
      $('edUsage').value = '4';                     // 回占位 A；不高亮任何键
      // 不自动暂存——等用户勾修饰+点主键
    }
  }
  $('edType').value = t;
  syncEditorRows();
  renderPalette();
};
$('edType').onchange = syncEditorRows;


// 宏模式/次数变更 → 立即按当前宏重新暂存（不必再点一次宏）
function restageMacroIfOpen() {
  if ($('edType').value !== 'macro' || S.sel === null) return;
  const slot = Number($('edMacroSlot').value);
  const mode = Number($('edMacroMode').value) & 0xff;
  const count = mode === 1 ? Math.max(1, Math.min(99, Number($('edMacroCount').value) || 1)) : 1;
  stageRecord([0x03, mode, count, slot], `宏${slot + 1}`);
  renderPalette();
}
$('edMacroModeRow').onclick = e => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  $('edMacroMode').value = b.dataset.mode;
  syncEditorRows();
  restageMacroIfOpen();
};
$('edMacroCount').onchange = () => { syncEditorRows(); restageMacroIfOpen(); };

// 修饰按钮（组合键）：切换后按当前 usage 重暂存；修饰全清 → 降级普通键
// usage 仍是修饰键（0xE0–E7）时不组组合，避免「Ctrl+组合:LWin」
$('edModBtns').onclick = e => {
  const b = e.target.closest('button[data-modbit]');
  if (!b) return;
  b.classList.toggle('on');
  if (S.sel === null) return;
  const usage = Number($('edUsage').value) & 0xff;
  const isModUsage = usage >= 0xe0 && usage <= 0xe7;
  const mb = modBits();
  if (mb && !isModUsage) {
    stageRecord([0x07, mb, 0, usage], '组合键');
  } else {
    // 无修饰，或主键本身是修饰键 → 普通键（修饰位不叠加）
    stageRecord([0x00, 0, 0, usage], '普通键');
    if ($('edType').value === 'combo' && (!mb || isModUsage)) $('edType').value = 'normal';
  }
  syncEditorRows();
  renderPalette();
};

// 右侧点选：宏=槽位；Modify=独立 usage（LCtrl/RCtrl… 互不相干）；其余=usage
$('edPalette').onclick = e => {
  if (S.sel === null) return;
  const k = e.target.closest('.pal-key');
  if (!k) return;
  if (k.dataset.macro !== undefined) {
    const slot = Number(k.dataset.macro);
    const mode = Number($('edMacroMode').value) & 0xff;
    const count = mode === 1 ? Math.max(1, Math.min(99, Number($('edMacroCount').value) || 1)) : 1;
    $('edMacroSlot').value = String(slot);
    $('edType').value = 'macro';
    stageRecord([0x03, mode, count, slot], `宏${slot + 1}`);
    syncEditorRows();
    renderPalette();
    return;
  }
  if (k.dataset.spec !== undefined) {                // 特殊键：按预置记录整条替换
    const it = SPECIAL_ITEMS[Number(k.dataset.spec)];
    if (!it) return;
    if (it.warn && k.dataset.confirm !== '1') {      // 危险项（恢复默认 / 对码）二次确认
      k.dataset.confirm = '1';
      k.classList.add('confirm');
      const old = k.textContent;
      k.textContent = '再点一次';
      setTimeout(() => {
        k.dataset.confirm = '';
        k.classList.remove('confirm');
        k.textContent = old;
      }, 2500);
      return;
    }
    $('edType').value = 'special';
    setModBits(0);
    stageRecord(it.rec.slice(), it.label);
    syncEditorRows();
    renderPalette();
    return;
  }
  const code = Number(k.dataset.code);
  // Modify 组：纯修饰键写"修饰位掩码"（出厂 LShift=00 02 00 00 / RShift=00 20 00 00），
  // 0xE0..0xE7 → 位 0..7，不要写成 usage 形式
  const asModKey = k.dataset.mod === '1';
  ensureUsageOption(code);
  $('edUsage').value = String(code);
  if (asModKey) {
    $('edType').value = 'normal';
    setModBits(0);
    stageRecord([0x00, 1 << (code - 0xe0), 0, 0], USAGE[code] || '修饰键');
    syncEditorRows();
    renderPalette();
    return;
  }
  const t = ($('edType').value === 'combo' && modBits()) ? 'combo' : 'normal';
  const rec = t === 'combo' ? [0x07, modBits(), 0, code] : [0x00, 0, 0, code];
  $('edType').value = t;
  stageRecord(rec, t === 'combo' ? '组合键' : '普通键');
  syncEditorRows();
  renderPalette();
};

// 页面加载即渲染（编辑器常驻；未选键位先置灰）
setEditorEnabled(false);
renderPalette();
syncEditorRows();

// ── 脏状态 / 应用按钮 ────────────────────────────────────────
function updateDirtyUI() {
  const parts = [];
  const n = S.kmDirty.filter(Boolean).length;
  if (n) parts.push(`键表页×${n}`);
  if (S.setOps.length) parts.push('设置：' + S.setOps.map(o => o.key).join('、'));
  if (S.lightOps.length) parts.push('灯效：' + S.lightOps.map(o => o.key).join('、'));
  if (S.colorDirty) parts.push('灯色');
  if (S.ledColorRgb) parts.push('单色LED');
  const any = parts.length > 0 && !!S.channel;
  $('applyBtn').disabled = !any;
  $('applyBtn').textContent = '应用修改';           // 按钮文案固定，待写入内容交给右侧提示
  const hint = $('applyHint');
  if (hint) {
    const txt = any ? '待写入：' + parts.join(' · ') : '';
    hint.hidden = !any;
    hint.textContent = txt;
    hint.title = txt;
  }
  $('backupBtn').disabled = !S.channel;
  $('restoreBtn').disabled = !S.channel;
  $('factoryBtn').disabled = !S.channel;
  if ($('capStop').style.display === 'none') $('capStart').disabled = !S.channel;   // 录制中不碰开始按钮
  const mus = $('musStart');
  if (mus) mus.disabled = !S.channel || MUS.on;
  if ($('ltNotes')) renderLightNotes();
}

// ── 备份 / 恢复（JSON，手动导出 / 写回）──────────────────
function backupData() {
  return {
    format: 'leobog-hi8-backup', version: 1,
    date: new Date().toISOString(),
    model: S.modelName, psd: S.psd, channel: S.channel,
    settings: S.settings ? toHex(S.settings) : null,
    keymap: S.keymap.map(k => k ? toHex(k) : null),
    color: S.color ? toHex(S.color) : null,
  };
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify(backupData(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `hi8-backup-${S.modelName || 'dev'}-${ts}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  Leobog.log(`已导出备份：${a.download}`, 'ok');
}

$('backupBtn').onclick = () => downloadBackup();
$('restoreBtn').onclick = () => $('restoreFile').click();
$('restoreFile').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let o;
  try { o = JSON.parse(await f.text()); }
  catch (err) { Leobog.log('备份文件解析失败：' + err.message, 'bad'); return; }
  if (o.format !== 'leobog-hi8-backup') { Leobog.log('不是本页导出的备份文件', 'bad'); return; }
  const parse = (h, n, what) => {
    if (!h) return null;
    const a = fromHex(h);
    if (a.length !== n) throw new Error(`${what} 长度 ${a.length} ≠ ${n}`);
    return a;
  };
  let km = [null, null, null, null], st = null, col = null;
  try {
    st = parse(o.settings, 128, '设置块');
    col = parse(o.color, 378, '色帧');
    for (let i = 0; i < 4; i++) km[i] = o.keymap && o.keymap[i] ? parse(o.keymap[i], 512, `键表页${i}`) : null;
  } catch (err) { Leobog.log('备份内容校验失败：' + err.message, 'bad'); return; }
  const items = [st ? '设置' : null, ...km.map((k, i) => k ? `键表页${i}` : null), col ? '色帧' : null].filter(Boolean);
  if (!items.length) { Leobog.log('备份里没有可恢复的数据', 'warn'); return; }
  if (!confirm(`恢复 ${o.date} 的备份？型号 ${o.model || '未知'}。\n将写入：${items.join('、')}。\n恢复后立即应用，并读回校验。`)) return;
  for (let i = 0; i < 4; i++) if (km[i]) { S.keymap[i] = km[i]; S.kmDirty[i] = true; }
  if (st) {
    S.settings = st;
    // 恢复 = 整块覆盖，但保留新鲜读取的字节14（无线标志，设备自管）
    S.setOps = [{ key: '恢复备份', row: '', fn: b => { const v = b[14]; b.set(st); b[14] = v; } }];
    S.lightOps = []; S.lightSel = st[10];
    S.setDirty = true;
  }
  if (col) { S.color = col; S.colorBase = col.slice(); S.colorDirty = true; }
  if (st) { renderSettings(); renderLight(); }
  renderKeymap(S.curLayer);
  updateDirtyUI();
  await applyAll();
};

// ── 恢复出厂（固件镜像：设置块 @C400 + Win 键表四页，data/factory.js）────
$('factoryBtn').onclick = async () => {
  const mod = window.LEOBOG_MODELS && window.LEOBOG_MODELS[S.modelName];
  const fac = mod && mod.factory;
  if (!fac) { Leobog.log('无出厂数据（型号未加载或该型号无 factory）', 'bad'); return; }
  if (!confirm('恢复出厂设置？会用固件出厂镜像，按官方恢复流程写入。\n· 键表页0-3 → 固件 Win 模式四页：FN=0d、旋钮=07 1d、页尾 5A A5\n' +
      '· 色帧清零并重推灯效参数块，官方同款，灯光即刻恢复\n· 设置块 → 固件 @0xC400\n\n' +
      '个人键位/灯色修改将丢失。建议先「导出备份」。继续？')) return;
  try {
    S.keymap = fac.keymapWin.map(h => fromHex(h));
    S.kmDirty = [true, true, true, true];
    S.settings = fromHex(fac.settings);
    S.setOps = [{ key: '恢复出厂', row: '', fn: b => { const v = b[14]; b.set(fromHex(fac.settings)); b[14] = v; } }];
    S.lightOps = []; S.lightSel = S.settings[10];
    S.setDirty = true;
    S.color = new Uint8Array(378);
    S.colorBase = new Uint8Array(378);
    S.colorDirty = true;
    S.ledPush = true;                               // 官方恢复出厂必推灯效参数块（灯光恢复关键）
    renderSettings(); renderLight(); renderKeymap(S.curLayer);
    updateDirtyUI();
    Leobog.log('固件出厂值已暂存（键表×4 + 色帧清零 + 灯效参数块 + 设置块），点「应用修改」写入', 'ok');
    await applyAll();
  } catch (e) {
    Leobog.log('恢复出厂构建失败：' + (e.message || e), 'bad');
  }
};

// ── 应用管线：备份 → 键表页 → 设置（新鲜读-改-写）→ 色帧，逐项读回校验 ──
async function applyAll() {
  const kmPages = [0, 1, 2, 3].filter(p => S.kmDirty[p]);
  const setOps = [...S.setOps, ...S.lightOps];
  const doCol = S.colorDirty && S.color;
  const doLedRgb = !!(S.ledColorRgb && S.channel);     // 单色：注入参数块并推送
  const ledRgb = doLedRgb ? S.ledColorRgb.slice() : null;   // 快照（写后 S.ledColorRgb 会被清空）
  const ledMode = S.ledColorSlot || S.lightSel || 1;       // 颜色槽按模式定位：21+(mode-1)*21
  const ledOff = 21 + (Math.min(Math.max(ledMode, 1), 19) - 1) * 21;
  // 官方 ApplySetting 每次改色都连写设置块 → 这里同样补一次（固件按设置块事件重载灯效）
  const forceSet = !!doLedRgb;
  const doSet = (setOps.length > 0 || forceSet) && S.settings;
  if (!kmPages.length && !doSet && !doCol && !S.ledPush && !doLedRgb) {
    Leobog.log('没有待应用的修改'); return;
  }
  const parts = [];
  if (kmPages.length) parts.push('键表页 ' + kmPages.join('/'));
  if (doCol) parts.push('色帧');
  if (doLedRgb) parts.push(`灯效参数块 · 模式${ledMode}色槽 ${ledOff}–${ledOff + 2}`);
  else if (S.ledPush) parts.push('灯效参数块');
  if (doSet) parts.push('设置：' + (setOps.length ? setOps.map(o => o.key).join('、') : '同值写回'));
  const wlNote = S.channel === 'wireless' ? '\n无线通道写入和读回校验较慢，每页要几秒，请勿断开设备。' : '';
  if (!confirm(`将写入：${parts.join('、')}。写后自动读回逐字节校验。${wlNote}\n继续？`)) return;
  const btn = $('applyBtn');
  btn.disabled = true;
  applying = true;
  const pace = ms => new Promise(r => setTimeout(r, ms));   // 块间喘息：固件 flash 提交期不被打断
  try {
    for (const p of kmPages) {
      Leobog.log(`写入键表页${p}（${S.channel === 'wireless' ? '无线 0x01/0x25' : '有线 0x03'}）…`);
      let r;
      try { r = await Leobog.writeKeymap(p, S.keymap[p]); }
      catch (err) { Leobog.log(`键表页${p} 写入失败：${err.message}`, 'bad'); break; }
      if (r.verified === true) {
        S.keymap[p] = r.readback;
        S.kmDirty[p] = false;
        Leobog.log(`键表页${p} ✅ 写入并读回一致`, 'ok');
      } else if (r.readback) {
        Leobog.log(`键表页${p} ❌ 读回有 ${r.diffCount} 处不一致（@${r.idxs.slice(0, 8).join(',')}），保留未应用状态`, 'bad');
      } else {
        Leobog.log(`键表页${p} ⚠️ 已发送写入但读回失败（${r.error || '未知'}），校验未完成，保留未应用`, 'warn');
      }
      renderKeymap(S.curLayer);
      await pace(120);
    }
    // 官方无线恢复出厂顺序（hid_wl_factory.log 实测）：键表×N → 色帧 → 灯效参数块 → 设置
    if (doCol) {
      await pace(120);
      const fd = S.lightSel === 21 ? ' · 自定义逐键色' : '';
      Leobog.log(`写入色帧（${S.channel === 'wireless' ? '无线 0x02/0x1b' : '有线 0x06'}）${fd}…`);
      // 亮槽清单：对照"实际哪些键亮了"用（自定义模式排查键位映射）
      if (S.lightSel === 21) {
        const nameOf = {};
        for (const k of (S.model ? S.model.keys : [])) nameOf[k.slot] = k.name;
        const lit = [];
        for (const k of (S.model ? S.model.keys : []))
          if (frameColorAt(k.slot) !== '#000') lit.push(k.slot);
        lit.sort((a, b) => a - b);
        const desc = lit.slice(0, 16).map(s => nameOf[s] ? `${s}:${nameOf[s]}` : String(s)).join(' ');
        Leobog.log(`[色帧] 点亮 ${lit.length} 键：${desc}${lit.length > 16 ? ' …' : ''}（平面写入）`);
      }
      try {
        const r = await Leobog.writeColor(S.color);
        if (r.verified === true) {
          S.color = r.readback;
          S.colorBase = r.readback.slice();        // 应用成功 → 成为新底稿
          if (S.lightSel === 21) paintCustomKeys();
          S.colorDirty = false;
          Leobog.log('色帧 ✅ 写入并读回一致', 'ok');
        } else if (r.readback) {
          Leobog.log(`色帧 ❌ 读回有 ${r.diffCount} 处不一致`, 'bad');
        } else {
          Leobog.log(`色帧 ⚠️ 已发送写入但读回失败（${r.error || '未知'}）`, 'warn');
        }
      } catch (err) {
        Leobog.log('色帧写入失败：' + err.message, 'bad');
      }
    }
    if (S.ledPush || doLedRgb) {
      // 恢复出厂=纯常量；单色=注入 RGB 到 payload[21..23]（有线/无线抓包一致实证）
      await pace(120);
      const rgbNote = doLedRgb ? `，单色 RGB(${S.ledColorRgb.join(',')})` : '，官方恢复出厂同款常量';
      Leobog.log(`写入灯效参数块（${S.channel === 'wireless' ? '无线 0x09/0x25' : '有线 0x0a'}${rgbNote}）…`);
      try {
        const r = await Leobog.writeLed(doLedRgb ? { rgb: ledRgb, mode: ledMode } : {});
        S.ledPush = false;
        if (doLedRgb) { S.ledColorRgb = null; S.ledColorSlot = null; }
        if (r.verified === false && r.readback) {
          const got = Array.from(r.readback.slice(21, 24));
          Leobog.log(`灯效参数块 ⚠️ 读回RGB(${got.join(',')}) ≠ 写入RGB(${ledRgb.join(',')})——设备没存下颜色`, 'bad');
        } else if (r.verified === false) {
          Leobog.log('灯效参数块 ⚠️ 已推送，但读回失败（' + (r.error || '未知') + '）', 'warn');
        } else {
          Leobog.log('灯效参数块 ✅ 已推送并读回一致', 'ok');
        }
      } catch (err) {
        Leobog.log('灯效参数块写入失败：' + err.message, 'bad');
      }
    }
    if (doSet) {
      await pace(120);
      Leobog.log('设置块修改：' + (setOps.length ? setOps.map(o => o.key).join(' + ') : '同值写回（效果模式色帧刷新）'));
      Leobog.log('读-改-写设置块（新鲜读取 → 套用修改 → 整块写回）…');
      try {
        const fresh = await Leobog.readSettings();
        for (const op of setOps) op.fn(fresh);
        const r = await Leobog.writeSettings(fresh);
        if (r.verified === true) {
          S.settings = r.readback;
          S.setOps = []; S.lightOps = []; S.setDirty = false;
          S.lightSel = r.readback[10];                 // 跟随设备实际模式
          Leobog.log(r.volatile
            ? '设置块 ✅ 写入成功 · 字节14 由设备自管，已忽略该差异'
            : '设置块 ✅ 写入并读回一致', 'ok');
        } else if (r.readback) {
          Leobog.log(`设置块 ❌ 读回有 ${r.diffCount} 处不一致（@${r.idxs.slice(0, 8).join(',')}）`, 'bad');
        } else {
          Leobog.log(`设置块 ⚠️ 已发送写入但读回失败（${r.error || '未知'}）`, 'warn');
        }
        renderSettings();
        renderLight();
        // 设置块写后复查：看参数块对应槽位是否还是我们写的颜色，不一致就补推一次
        if (doLedRgb && ledRgb) {
          try {
            const lo = ledOff;
            const back = await Leobog.readLed();
            const cur = Array.from(back.slice(lo, lo + 3));
            if (cur[0] !== ledRgb[0] || cur[1] !== ledRgb[1] || cur[2] !== ledRgb[2]) {
              Leobog.log(`[LED] 设置块写入后参数块被回滚为 RGB(${cur.join(',')})，补推单色…`, 'warn');
              await Leobog.writeLed({ rgb: ledRgb, mode: ledMode });
            }
          } catch (e) { /* 读回失败不阻断 */ }
        }
      } catch (err) {
        Leobog.log('设置块写入失败：' + err.message, 'bad');
      }
    }
  } finally {
    btn.disabled = false;
    applying = false;
    updateDirtyUI();
    flushPendingUnsol();                           // 写入结束=空闲点：补跑忙时挂起的推送
  }
}

$('applyBtn').onclick = () => { applyAll().catch(e => Leobog.log('应用失败：' + (e.message || e), 'bad')); };
$('settings').addEventListener('change', collectSetOps);
// 分段按钮：点了就写进隐藏输入，再重算待写项
$('settings').addEventListener('click', e => {
  const b = e.target.closest('[data-seg-val]');
  if (!b) return;
  const name = b.closest('.seg').dataset.seg;
  const val = Number(b.dataset.segVal);
  if (name === 'debounce') $('setDebounce').value = val;
  else if (name === 'mode') $('setMode').value = val;
  else if (name === 'osmode') $('setOsMode').value = val;
  else if (name === 'tapon') $('setTapOn').checked = !!val;
  else if (name === 'sleepon') $('setSleepOn').checked = !!val;
  updateSetReadouts();
  collectSetOps();
});
// 滑杆：拖动时实时更新读数
$('settings').addEventListener('input', e => {
  if (e.target.type !== 'range') return;
  updateSetReadouts();
  collectSetOps();
});
