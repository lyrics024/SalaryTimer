'use strict';

/* ============ 基础工具 ============ */
const $ = (id) => document.getElementById(id);
const LS_KEY = 'salary-board-state-v1';
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad2 = (n) => String(n).padStart(2, '0');
const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);

const keyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseKey = (k) => { const p = String(k).split('-').map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonthsClamped = (d, n) => {
  const day = d.getDate();
  const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(day, lastDay));
  return x;
};
const defaultCycleEnd = (openingKey) => keyOf(addMonthsClamped(parseKey(openingKey), 1));
const periodLabel = (a, b) => {
  const f = (k) => { const p = String(k).split('-'); return `${Number(p[1])}.${p[2]}`; };
  return `${f(a)} – ${f(b)}`;
};
const monthStartKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
const hmToMin = (s) => { const [h, m] = String(s || '09:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const money = (v, digits = 2) => num(v, 0).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const NATIVE = !!(window.__NATIVE__ && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge);
const post = (msg) => {
  if (NATIVE) { window.webkit.messageHandlers.bridge.postMessage(msg); return true; }
  return false;
};

/* ============ 状态 ============ */
function defaultState() {
  const now = new Date();
  const start = monthStartKey(now);
  const prevMonthDay = keyOf(addDays(parseKey(start), -1));
  return {
    version: 1,
    settings: {
      dailySalary: 833.33,
      workStart: '09:00',
      workEnd: '18:00',
      openingAmount: 0,
      openingDate: prevMonthDay,
      cycleEnd: keyOf(addMonthsClamped(parseKey(prevMonthDay), 1)),
      startDate: start,
    },
    salaryHistory: [{ from: start, amount: 833.33 }],
    overrides: {},
  };
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const state = { version: 1 };
  state.settings = Object.assign({}, base.settings, raw.settings || {});
  state.settings.dailySalary = num(state.settings.dailySalary, base.settings.dailySalary);
  state.settings.openingAmount = num(state.settings.openingAmount, 0);
  state.settings.workStart = state.settings.workStart || '09:00';
  state.settings.workEnd = state.settings.workEnd || '18:00';
  state.settings.openingDate = state.settings.openingDate || null;
  if (!state.settings.cycleEnd && state.settings.openingDate) {
    state.settings.cycleEnd = defaultCycleEnd(state.settings.openingDate);
  }
  state.settings.startDate = state.settings.startDate || base.settings.startDate;
  state.overrides = raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {};

  let hist = Array.isArray(raw.salaryHistory) ? raw.salaryHistory.filter((p) => p && p.from) : [];
  if (!hist.length) hist = [{ from: state.settings.startDate, amount: state.settings.dailySalary }];
  state.salaryHistory = hist
    .map((p) => ({ from: String(p.from), amount: num(p.amount, state.settings.dailySalary) }))
    .sort((a, b) => a.from.localeCompare(b.from));
  return state;
}

function loadState() {
  if (window.__INITIAL_STATE__ && typeof window.__INITIAL_STATE__ === 'object') {
    return normalizeState(window.__INITIAL_STATE__);
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return normalizeState(JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return defaultState();
}

let state = loadState();

function persist() {
  if (post({ type: 'save', state: state })) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

/* ============ 排班与薪资 ============ */
const isDefaultWorkday = (k) => { const dow = parseKey(k).getDay(); return dow >= 1 && dow <= 5; };

function isWorkday(k) {
  const o = state.overrides[k];
  return o === undefined ? isDefaultWorkday(k) : !!o;
}

function dailySalaryFor(k) {
  const hist = state.salaryHistory || [];
  if (!hist.length) return num(state.settings.dailySalary, 0);
  let value = hist[0].amount;
  for (const p of hist) { if (p.from <= k) value = p.amount; }
  return value;
}

function currentDailySalary() {
  const hist = state.salaryHistory || [];
  return hist.length ? hist[hist.length - 1].amount : num(state.settings.dailySalary, 0);
}

// 从 effKey 起一直生效：清掉更晚的记录，否则旧值会在后面的日期把新值顶掉
function setSalaryFrom(effKey, amount) {
  state.salaryHistory = (state.salaryHistory || []).filter((p) => p.from < effKey);
  state.salaryHistory.push({ from: effKey, amount });
  state.salaryHistory.sort((a, b) => a.from.localeCompare(b.from));
  state.settings.dailySalary = amount;
}

function dayMinutes() {
  return Math.max(1, hmToMin(state.settings.workEnd) - hmToMin(state.settings.workStart));
}

/* ============ 计算 ============ */
function computeToday(now) {
  const key = keyOf(now);
  const { workStart, workEnd, startDate } = state.settings;
  const start = parseKey(key); start.setHours(0, hmToMin(workStart), 0, 0);
  const end = parseKey(key); end.setHours(0, hmToMin(workEnd), 0, 0);
  const span = Math.max(1, end - start);
  const workday = isWorkday(key);
  const salary = dailySalaryFor(key);

  let status = 'working';
  if (startDate && key < startDate) status = 'idle';
  else if (!workday) status = 'rest';
  else if (now < start) status = 'before';
  else if (now >= end) status = 'done';
  else status = 'working';

  const elapsedMs = Math.min(Math.max(now - start, 0), span);
  const progress = status === 'idle' || status === 'rest' ? 0 : elapsedMs / span;
  const earned = workday && status !== 'idle' ? salary * progress : 0;

  return {
    key, start, end, span, workday, salary, status, progress, earned,
    remainMs: Math.max(0, end - now),
    toStartMs: Math.max(0, start - now),
    salaryPerSec: salary / (span / 1000),
  };
}

function computeCycle(now) {
  const s = state.settings;
  const todayKey = keyOf(now);
  const anchor = s.openingDate;

  // 本期开始 = 上期期末的次日；期末优先用设置值，否则按上期期末 +1 个月推
  let startKey = anchor ? keyOf(addDays(parseKey(anchor), 1)) : (s.startDate || todayKey);
  let endKey = s.cycleEnd || (anchor ? defaultCycleEnd(anchor) : keyOf(addMonthsClamped(addDays(parseKey(startKey), -1), 1)));
  let base = num(s.openingAmount, 0);
  let rolled = 0;

  // 今天已过本期期末：自动滚到下一期，期初金额只在首期计入
  while (todayKey > endKey && rolled < 400) {
    startKey = keyOf(addDays(parseKey(endKey), 1));
    endKey = keyOf(addMonthsClamped(parseKey(endKey), 1));
    base = 0;
    rolled++;
  }

  return { startKey, endKey, base, rolled };
}

function computeCycleTotal(now, todayStats) {
  const todayKey = keyOf(now);
  const s = state.settings;
  const cyc = computeCycle(now);
  const fromKey = s.startDate && s.startDate > cyc.startKey ? s.startDate : cyc.startKey;

  let total = cyc.base;
  let cursor = parseKey(fromKey);
  let guard = 0;
  while (keyOf(cursor) <= todayKey && guard++ < 4000) {
    const k = keyOf(cursor);
    if (k > cyc.endKey) break;
    if (k === todayKey) {
      if (todayStats.workday) total += todayStats.earned;
    } else if (isWorkday(k)) {
      total += dailySalaryFor(k);
    }
    cursor = addDays(cursor, 1);
  }
  return { total, startKey: cyc.startKey, endKey: cyc.endKey, base: cyc.base, rolled: cyc.rolled };
}

/* ============ 渲染 ============ */
const STATUS_TEXT = {
  working: '上班中',
  before: '还没上班',
  done: '已下班',
  rest: '今天休息',
  idle: '尚未开始记录',
};

function dur(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function updateFx(hourly) {
  const box = $('fxOut');
  if (!box) return;
  const price = Number($('fxPrice').value);
  if (!(price > 0) || !(hourly > 0)) {
    box.textContent = '填个价格，看看要干多久';
    return;
  }
  const hours = price / hourly;
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const days = hours / (dayMinutes() / 60);
  let text = h > 0 ? `≈ 工作 ${h} 小时${m ? ` ${m} 分钟` : ''}` : `≈ 工作 ${m} 分钟`;
  if (days >= 1) text += ` · ${days.toFixed(1)} 个工作日`;
  box.textContent = text;
}

function render() {
  const now = new Date();
  const st = computeToday(now);

  $('nowDate').textContent = `${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())} ${WEEK[now.getDay()]}`;
  $('nowTime').textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

  // 状态
  $('statusText').textContent = STATUS_TEXT[st.status] || '—';
  const dot = $('statusDot');
  dot.className = 'dot' + (st.status === 'rest' || st.status === 'idle' ? ' rest' : st.status === 'done' ? ' done' : '');
  const hm = `${state.settings.workStart}–${state.settings.workEnd}`;
  $('statusSub').textContent = st.workday ? `工作日 · ${hm}` : `休息日 · 不计算收入`;

  // 倒计时
  const cap = $('countdownCap');
  const cd = $('countdown');
  cd.classList.remove('flat');
  if (st.status === 'working') { cap.textContent = '距离下班'; cd.textContent = dur(st.remainMs); }
  else if (st.status === 'before') { cap.textContent = '距离上班'; cd.textContent = dur(st.toStartMs); }
  else if (st.status === 'done') { cap.textContent = '距离下班'; cd.textContent = '已下班'; cd.classList.add('flat'); }
  else if (st.status === 'rest') { cap.textContent = '距离下班'; cd.textContent = '休息日'; cd.classList.add('flat'); }
  else { cap.textContent = '距离下班'; cd.textContent = '—'; cd.classList.add('flat'); }

  // 今日收入
  const fixed = st.earned.toFixed(2).split('.');
  $('todayInt').textContent = Number(fixed[0]).toLocaleString('zh-CN');
  $('todayDec').textContent = '.' + fixed[1];
  $('speed').textContent = '¥' + st.salaryPerSec.toFixed(4);

  // 进度
  if (st.status === 'rest' || st.status === 'idle') {
    $('progressText').textContent = '今日不排班';
    $('progressPct').textContent = '0.0%';
    $('barFill').style.width = '0%';
  } else {
    const hours = dayMinutes() / 60;
    const done = (st.progress * hours);
    $('progressText').textContent = `工时进度 ${done.toFixed(2)} / ${hours.toFixed(2)} 小时`;
    $('progressPct').textContent = (st.progress * 100).toFixed(1) + '%';
    $('barFill').style.width = (st.progress * 100).toFixed(2) + '%';
  }

  // 计薪周期累计
  const cyc = computeCycleTotal(now, st);
  $('monthTotal').textContent = '¥' + money(cyc.total, 2);
  $('cycleRange').textContent = periodLabel(cyc.startKey, cyc.endKey) + (cyc.rolled ? ' · 新一期' : '');

  // 时薪 / 满勤
  const hourly = st.salary / (dayMinutes() / 60);
  $('hourly').textContent = '¥' + money(hourly, 2);
  $('fullDay').textContent = '¥' + money(st.salary, 2);

  updateFx(hourly);

  return st;
}

function tick() {
  render();
  const now = Date.now();
  setTimeout(tick, 1000 - (now % 1000) + 8);
}

/* ============ 日历 ============ */
const now0 = new Date();
let calYear = now0.getFullYear();
let calMonth = now0.getMonth();

function renderCalendar() {
  const first = new Date(calYear, calMonth, 1);
  const gridStart = addDays(first, -first.getDay());
  const todayKey = keyOf(new Date());
  const grid = $('calGrid');
  grid.innerHTML = '';
  $('calLabel').textContent = `${calYear}年 ${calMonth + 1}月`;

  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const k = keyOf(d);
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (d.getMonth() !== calMonth) cell.classList.add('other');
    if (k === todayKey) cell.classList.add('today');
    if (isWorkday(k)) cell.classList.add('work');
    cell.textContent = pad2(d.getDate());
    const dot = document.createElement('span');
    dot.className = 'cal-dot';
    cell.appendChild(dot);
    cell.addEventListener('click', () => toggleDay(k));
    grid.appendChild(cell);
  }
}

function toggleDay(k) {
  const next = !isWorkday(k);
  if (next === isDefaultWorkday(k)) delete state.overrides[k];
  else state.overrides[k] = next;
  persist();
  renderCalendar();
  render();
}

function resetMonthOverrides() {
  const prefix = `${calYear}-${pad2(calMonth + 1)}-`;
  let removed = 0;
  Object.keys(state.overrides).forEach((k) => {
    if (k.startsWith(prefix)) { delete state.overrides[k]; removed++; }
  });
  persist();
  renderCalendar();
  render();
  toast(removed ? '本月已恢复默认（周一至周五）' : '本月本来就没有自定义');
}

/* ============ 设置面板 ============ */
function fillSettings() {
  const s = state.settings;
  const todayKey = keyOf(new Date());
  const eff = dailySalaryFor(todayKey);
  $('dailySalary').value = Number(eff.toFixed(2));
  $('salaryFrom').value = todayKey;
  $('workStart').value = s.workStart;
  $('workEnd').value = s.workEnd;
  $('openingAmount').value = s.openingAmount;
  $('openingDate').value = s.openingDate || '';
  $('cycleEnd').value = s.cycleEnd || (s.openingDate ? defaultCycleEnd(s.openingDate) : '');
  $('startDate').value = s.startDate || '';
  $('salaryHint').textContent = '日薪从上面的日期起一直生效，更早的排班日按原日薪保留。';
  fillSalaryHistory();
}

// 设置页里把已生效的日薪变更列出来，避免"改过但看不出改没改"
function fillSalaryHistory() {
  const box = $('salaryHistoryList');
  if (!box) return;
  const hist = (state.salaryHistory || []).slice(-5).reverse();
  const todayKey = keyOf(new Date());
  box.innerHTML = hist.map((p, i) => {
    const state_ = i === 0 ? '当前' : '';
    return `<div class="hist-row"><span class="hist-date">${p.from}</span><span class="hist-amt">¥${money(p.amount, 2)}</span><span class="hist-tag">${state_}</span></div>`;
  }).join('') || '<div class="hist-empty">还没有日薪记录</div>';
}

function saveSalaryForm() {
  const daily = Number($('dailySalary').value);
  if (!(daily > 0)) { toast('请填写有效日薪'); return; }
  const ws = $('workStart').value;
  const we = $('workEnd').value;
  if (!ws || !we) { toast('请填写上下班时间'); return; }
  if (hmToMin(we) <= hmToMin(ws)) { toast('下班时间需要晚于上班时间'); return; }

  const todayKey = keyOf(new Date());
  const effKey = $('salaryFrom').value || todayKey;
  const before = dailySalaryFor(effKey);

  const s = state.settings;
  const startDate = $('startDate').value || s.startDate;
  const openingDate = $('openingDate').value || null;
  const cycleEnd = $('cycleEnd').value || null;

  // 先校验，通过后再改 state，避免校验失败时留在半改状态
  if (cycleEnd && startDate && cycleEnd < startDate) {
    toast('本期期末不能早于开始记录日期');
    return;
  }
  if (openingDate && cycleEnd && cycleEnd <= openingDate) {
    toast('本期期末应晚于上期期末');
    return;
  }

  s.workStart = ws;
  s.workEnd = we;
  s.openingAmount = num($('openingAmount').value, 0);
  s.openingDate = openingDate;
  s.cycleEnd = cycleEnd;
  s.startDate = startDate;

  let hint = '';
  if (Math.abs(daily - before) > 0.0049) {
    setSalaryFrom(effKey, daily);
    hint = `日薪已从 ${effKey} 起生效为 ¥${money(daily, 2)}，此后排班日都按新值计算。`;
  } else {
    s.dailySalary = currentDailySalary();
  }

  persist();
  fillSettings();
  // fillSettings 会重置提示文案，所以生效说明放在它之后写
  const notes = [];
  if (hint) notes.push(hint);
  const cycStart = openingDate ? keyOf(addDays(parseKey(openingDate), 1)) : startDate;
  if (startDate && cycStart && startDate > cycStart) {
    notes.push(`注意：开始记录日期是 ${startDate}，${cycStart} 至昨日的排班日不会计入本期。`);
  }
  if (notes.length) $('salaryHint').textContent = notes.join(' ');
  render();
  toast('设置已保存');
}

/* ============ 导出 ============ */
function buildCSV() {
  const now = new Date();
  const st = computeToday(now);
  const todayKey = keyOf(now);
  const s = state.settings;
  const startKey = s.startDate || todayKey;
  const hours = (dayMinutes() / 60).toFixed(2);

  const cyc = computeCycleTotal(now, st);
  const out = [];
  out.push('说明：工时与收入按排班日历估算，非打卡工时');
  out.push(`当前计薪周期：${cyc.startKey} 至 ${cyc.endKey}，期初金额 ${money(cyc.base, 2)}，本期累计 ${money(cyc.total, 2)}`);
  out.push('日期,星期,是否排班,上班时间,下班时间,排班工时(小时),日薪(元),估算收入(元),计薪周期,备注');

  let cursor = parseKey(startKey);
  let guard = 0;
  while (keyOf(cursor) <= todayKey && guard++ < 5000) {
    const k = keyOf(cursor);
    if (isWorkday(k)) {
      const salary = dailySalaryFor(k);
      let income = salary;
      let note = '';
      if (k === todayKey) {
        income = st.earned;
        if (st.status === 'working') note = '进行中';
      }
      const inCycle = (k >= cyc.startKey && k <= cyc.endKey) ? '是' : '';
      out.push([k, WEEK[cursor.getDay()], '是', s.workStart, s.workEnd, hours, salary.toFixed(2), income.toFixed(2), inCycle, note].join(','));
    }
    cursor = addDays(cursor, 1);
  }
  return out.join('\r\n');
}

function exportCSV() {
  const csv = buildCSV();
  if (post({ type: 'export', filename: 'SalaryTimer-记录', content: csv })) {
    toast('正在导出…');
    return;
  }
  // 浏览器兜底：直接下载
  try {
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `SalaryTimer-记录-${keyOf(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 CSV');
  } catch (e) {
    toast('导出失败');
  }
}

window.onExportResult = (path) => {
  if (path) toast('已导出：' + String(path).split('/').pop());
  else toast('导出失败，请重试');
};
window.onSaveResult = (ok) => { if (!ok) toast('数据保存失败'); };

/* ============ 视图切换 ============ */
function showSettings() {
  $('viewMain').classList.add('hidden');
  $('viewSettings').classList.remove('hidden');
  fillSettings();
  const t = new Date();
  calYear = t.getFullYear();
  calMonth = t.getMonth();
  renderCalendar();
}
function showMain() {
  $('viewSettings').classList.add('hidden');
  $('viewMain').classList.remove('hidden');
  render();
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ============ 事件绑定 ============ */
$('btnSettings').addEventListener('click', showSettings);
$('btnBack').addEventListener('click', showMain);
$('btnSaveSalary').addEventListener('click', saveSalaryForm);
$('calPrev').addEventListener('click', () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); });
$('calNext').addEventListener('click', () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); });
$('btnResetMonth').addEventListener('click', resetMonthOverrides);
$('btnExport').addEventListener('click', exportCSV);
$('btnExportQuick').addEventListener('click', exportCSV);
$('btnQuit').addEventListener('click', () => post({ type: 'quit' }));
$('btnQuitTop').addEventListener('click', () => post({ type: 'quit' }));

// 拖动窗口：网页区域内由 JS 通知原生层移动窗口
document.querySelectorAll('[data-drag]').forEach((el) => {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, a')) return;
    post({ type: 'dragStart' });
    const stop = () => { post({ type: 'dragEnd' }); window.removeEventListener('mouseup', stop); };
    window.addEventListener('mouseup', stop);
  });
});

$('fxPrice').addEventListener('input', () => {
  const now = new Date();
  const st = computeToday(now);
  updateFx(st.salary / (dayMinutes() / 60));
});
$('openingDate').addEventListener('change', () => {
  const anchor = $('openingDate').value;
  if (anchor) $('cycleEnd').value = defaultCycleEnd(anchor);
});

// 回车保存
$('viewSettings').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveSalaryForm();
  if (e.key === 'Escape') showMain();
});

/* ============ 启动 ============ */
render();
tick();

// 首次启动：把默认值落盘，之后每次启动都以文件为准
if (!window.__INITIAL_STATE__) persist();

// 调试用：直接打开设置页（?settings）
if (location.search.indexOf('settings') !== -1) showSettings();
