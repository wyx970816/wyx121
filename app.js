/* ---------------------------------------------------------------
   沪深300 方向预测 · 前端数据层
   两种数据源：
     静态：同目录 data/*.json（GitHub Pages 永久可用）
     实时：运行中的 FastAPI（本机或 Cloudflare Tunnel）
   后端地址来源优先级：
     1. URL 参数 ?api=https://xxx.trycloudflare.com
     2. localStorage 里保存的值（页面「设置后端」写入）
     3. 同源（本机直接跑 uvicorn 时 /api 就在同一地址）
---------------------------------------------------------------- */
const state = {
  dates: [],
  current: null,
  model: 'M2_cnn_full',
  meta: null,
  health: null,
  hits: null,
  mode: 'static',
  range: 'recent',
  staticCache: {},
  offlineUntil: null,
  apiBase: '',
};

const $ = (sel) => document.querySelector(sel);
const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
const dirText = (d) => (d === 1 ? '上涨' : '下跌');
const dirClass = (d) => (d === 1 ? 'up' : 'down');

const DATA_ROOT = 'data';     // relative: works on Pages and locally

async function resolveApiBase() {
  // Candidate order: ?api= > runtime.json (server-side, freshest) >
  // localStorage (may hold a dead URL from an earlier session) > same origin.
  const params = new URLSearchParams(location.search);
  const q = params.get('api');
  if (q) {
    const v = q.replace(/\/$/, '');
    localStorage.setItem('hs300_api_base', v);
    return v;
  }
  const out = [];
  try {
    const rt = await jget(DATA_ROOT + '/runtime.json?t=' + Date.now(), 2500);
    if (rt && rt.api) out.push(String(rt.api).replace(/\/$/, ''));
  } catch (e) { /* no runtime hint */ }
  const saved = localStorage.getItem('hs300_api_base');
  if (saved && !out.includes(saved.replace(/\/$/, ''))) out.push(saved.replace(/\/$/, ''));
  out.push('');
  return out;   // array of candidates; boot() probes them in order
}

function apiUrl(path) {
  if (/^https?:/.test(path)) return path;
  return state.apiBase + path;
}

async function jget(path, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const url = path.startsWith('data/') ? path : apiUrl(path);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function setStatus(text, live) {
  $('#statusText').textContent = text;
  $('.pulse').style.background = live ? '#22c55e' : '#f59e0b';
  $('#footTime').textContent = '页面时间 ' + new Date().toLocaleTimeString('zh-CN');
}

/* ---------------- static reads ---------------- */
async function staticPred(year, date) {
  if (!state.staticCache[year]) {
    state.staticCache[year] = await jget(DATA_ROOT + '/pred_' + year + '.json');
  }
  return state.staticCache[year][date] || null;
}

// static files always live next to the page, never on the backend
function assetUrl(path) {
  return DATA_ROOT + path;
}

async function getDates() {
  if (state.mode === 'api') {
    const d = await jget('/api/dates?limit=2000');
    return d.dates;
  }
  const out = [];
  for (const y of ['2021', '2022', '2023', '2024', '2025', '2026']) {
    try {
      const m = await jget(assetUrl(`/pred_${y}.json`));
      out.push(...Object.keys(m).sort());
    } catch (e) { /* year file may be absent */ }
  }
  return out.sort();
}

async function getCompare(date) {
  if (state.mode === 'api') return jget(`/api/compare?date=${encodeURIComponent(date)}`);
  const row = await staticPred(date.slice(0, 4), date);
  if (!row) throw new Error(`静态包中没有 ${date} 的数据`);
  return row;
}

async function getHistory(model, limit) {
  if (state.mode === 'api') {
    return jget(`/api/history?limit=${limit}&model=${model}&window=${state.range}`);
  }
  const h = await jget(assetUrl('/history.json'));
  const m = h[model];
  const set = m && m.sets && m.sets[state.range || 'recent'];
  if (!set) return { model, n: 0, accuracy: null, rows: [] };
  return { ...set, model, threshold: m.threshold };
}

/* ---------------- boot ---------------- */
async function boot() {
  const bases = await resolveApiBase();
  state.apiCandidates = Array.isArray(bases) ? bases : [bases];
  state.apiBase = state.apiCandidates[0] || '';
  const param = new URLSearchParams(location.search).get('source');

  // 1) always paint the static snapshot first: it is local, so the page is
  //    usable even when the tunnel is dead or the network is slow
  try {
    await initStatic();
  } catch (e) {
    setStatus('静态数据加载失败：' + e.message, false);
    return;
  }
  renderShell();
  await run();
  loadHistory();
  renderModeNote();
  renderBackendBtn();

  // 2) then try to upgrade to the live backend in the background
  if (param === 'static') return;
  const ok = await probeBackend(param === 'api');
  if (!ok) {
    if (param === 'api') setStatus('后端不可达，已回退到静态快照', false);
    return;
  }
  try {
    state.mode = 'api';
    state.health = await jget('/api/health');
    state.meta = await jget('/api/meta');
    state.dates = await getDates();
    renderShell();
    renderMetrics();
    await run();
    loadHistory();
    renderModeNote();
    renderBackendBtn();
  } catch (e) {
    state.mode = 'static';
  }
}

async function initStatic() {
  state.mode = 'static';
  const mf = await jget(assetUrl('/manifest.json'));
  state.meta = await jget(assetUrl('/meta.json'));
  state.dates = await getDates();
  state.health = { latest_data: mf.built_with_data_until };
  state.offlineUntil = mf.built_with_data_until;
  setStatus(`静态快照 · 构建于 ${mf.built_at.slice(0, 16)}（截至 ${mf.built_with_data_until}）`, false);
}

async function probeBackend(force) {
  const cands = Array.isArray(state.apiCandidates) && state.apiCandidates.length
    ? state.apiCandidates : [''];
  const tried = [];
  for (const base of cands) {
    const label = base || '(同源)';
    for (const t of [4000, 6000]) {
      try {
        const url = (base || '') + '/api/health';
        const r = await fetch(url, { signal: AbortSignal.timeout(t), cache: 'no-store' });
        const j = await r.json();
        if (j && j.status === 'ok') {
          state.apiBase = base;
          state.health = j;
          state.probeLog = `已连接 ${label}`;
          return true;
        }
      } catch (e) { /* next attempt */ }
    }
    tried.push(label);
  }
  state.probeLog = '全部不可达：' + tried.join(' / ');
  return false;
}

function renderShell() {
  const last = state.dates[state.dates.length - 1];
  $('#dataHint').textContent =
    `${state.dates[0]} → ${last}（共 ${state.dates.length} 个交易日）`;
  $('#dateInput').min = state.dates[0];
  $('#dateInput').max = last;
  if (!$('#dateInput').value || !state.dates.includes($('#dateInput').value)) {
    $('#dateInput').value = state.dates[state.dates.length - 2] || last;
  }
  renderQuick();
  renderMetrics();
  state.range = 'recent';
}

function renderBackendBtn() {
  const btn = document.getElementById('backendBtn');
  if (btn) btn.textContent = state.apiBase ? '后端：已指向外网' : '设置后端';
}

function renderModeNote() {
  const box = document.getElementById('modeNote');
  if (!box) return;
  const target = state.apiBase || '同源（本机）';
  if (state.mode === 'api') {
    box.innerHTML = `<b>当前模式：实时后端</b> 接口地址 <code>${target}</code>。
      每次打开页面都会从东方财富拉最新交易日，缺失则自动入库并重算特征。
      <br><b>部署说明</b>：前端在 GitHub Pages，实时预测由本机 FastAPI 经
      Cloudflare Tunnel 暴露；后端不可达时页面自动回落到预计算快照，并标注截止日期。`;
  } else {
    const why = state.probeLog
      ? `<br><span style="color:#f59e0b">探测结果：${state.probeLog}</span>` : '';
    box.innerHTML = `<b>当前模式：静态快照</b> 预测已预先计算并写入 <code>data/*.json</code>，
      因此无需后端即可长期在线。<b>局限</b>：数据只到 ${state.offlineUntil}。
      需要最新数据时，点右上角「设置后端」，填入运行中的 FastAPI 地址
      （本机 <code>http://127.0.0.1:8000</code> 或 Cloudflare Tunnel 的 https 地址）。${why}`;
  }
}

/* ---------------- rendering ---------------- */
async function loadHits() {
  state.hits = {};
  const h = await getHistory('M2_cnn_full', 30);
  for (const r of h.rows) {
    for (const [k, d] of Object.entries(r.all_models || {})) {
      state.hits[k] = state.hits[k] || { hit: 0, n: 0 };
      state.hits[k].n += 1;
      state.hits[k].hit += d === r.actual_direction ? 1 : 0;
    }
  }
  for (const k of Object.keys(state.hits)) {
    const v = state.hits[k];
    state.hits[k] = v.n ? v.hit / v.n : null;
  }
}

function renderQuick() {
  const picks = [];
  const n = state.dates.length;
  for (const back of [1, 2, 5, 10]) {
    if (n - back >= 0) picks.push({ label: `−${back} 日`, d: state.dates[n - back] });
  }
  picks.push({ label: '最新交易日', d: state.dates[n - 1] });
  const box = $('#quickDates');
  box.innerHTML = '';
  for (const p of picks) {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.onclick = () => { $('#dateInput').value = p.d; run(); };
    box.appendChild(b);
  }
}

function renderMetrics() {
  const m = state.meta;
  if (!m) return;
  const rows = [
    ['CNN_Stock', 'M2_cnn_full'],
    ['MACD 策略', 'M4_macd_logit'],
    ['CNN 去情绪', 'M3_cnn_no_sentiment'],
    ['全涨基线', null],
  ];
  const box = $('#metricTable');
  box.innerHTML = '';
  for (const [label, key] of rows) {
    const t = key ? m.test_metrics?.[key] : null;
    const acc = key ? t?.accuracy : m.baselines?.always_up_accuracy;
    const mcc = key ? t?.mcc : null;
    const edge = key ? t?.edge_pp : null;
    const div = document.createElement('div');
    div.className = 'metric-row';
    div.innerHTML = `<span>${label}</span>
      <span><b>${pct(acc)}</b>${mcc != null ? ` · MCC ${mcc.toFixed(3)}` : ''}${
        edge != null ? ` · 超额 ${edge > 0 ? '+' : ''}${edge.toFixed(1)}pp` : ''}</span>`;
    box.appendChild(div);
  }
  const extra = document.createElement('div');
  extra.className = 'metric-row';
  extra.innerHTML = `<span>随机基线 90% 区间</span><span>${pct(m.baselines?.random_accuracy_p05)} – ${pct(m.baselines?.random_accuracy_p95)}</span>`;
  box.appendChild(extra);
}

function modelCard(key, name, tag, prob, threshold, dim, hit) {
  const d = prob >= threshold ? 1 : 0;
  const cls = dirClass(d);
  const pctUp = (prob * 100).toFixed(1);
  const dimmed = dim ? ' style="opacity:.42"' : '';
  const hitText = hit == null ? '' : `<span class="hit-badge">近30日命中 ${(hit * 100).toFixed(0)}%</span>`;
  const lean = (prob >= threshold ? 1 : -1) *
    (prob >= threshold ? (prob - threshold) : (threshold - prob)) /
    Math.max(threshold, 1 - threshold) * 100;
  const hint = key === 'M4_macd_logit' ? 'MACD 族 19 信号 · balanced 逻辑回归'
    : (key === 'M2_cnn_full' ? '10 模型均值 · 图像输入' : '消融对照 · 情绪通道清零');
  return `<div class="model-card"${dimmed}>
    <div class="name"><span>${name}</span><span class="tag">${tag}</span></div>
    <div class="dir ${cls}">${dirText(d)}</div>
    <div class="prob">上涨概率 ${pctUp}% · 倾向分 ${lean.toFixed(0)}</div>
    <div class="bar ${cls}"><i style="width:${(prob * 100).toFixed(1)}%"></i></div>
    <div class="prob" style="margin-top:8px;font-size:11px">${hint} · 阈值 ${threshold.toFixed(2)} · p≥阈值判涨${hitText}</div>
  </div>`;
}

function renderResult(data) {
  $('#resultDate').textContent = data.date + ' 收盘后';
  $('#resultMeta').textContent =
    `沪深300 收于 ${data.close}（${data.pct_change > 0 ? '+' : ''}${data.pct_change}%）· 预测下一交易日方向`;
  state.current = data;

  const order = ['M2_cnn_full', 'M4_macd_logit', 'M3_cnn_no_sentiment'];
  const hits = state.hits || {};
  $('#modelCards').innerHTML = order
    .filter((k) => data.models[k])
    .map((k) => {
      const m = data.models[k];
      return modelCard(k, m.name, m.tag, m.prob_up, m.threshold,
        k === 'M3_cnn_no_sentiment', hits[k]);
    })
    .join('');

  const v = $('#verdict');
  if (data.pending) {
    v.className = 'verdict pending';
    v.textContent = '待验证 · 下一交易日尚未产生';
  } else {
    const c = data.compare || {};
    const keys = Object.keys(c);
    const ok = keys.filter((k) => c[k].correct).length;
    v.className = 'verdict ' + (ok > 0 ? 'ok' : 'bad');
    v.textContent = `${ok}/${keys.length} 个模型判断正确`;
  }

  const box = $('#actualBox');
  if (data.pending) {
    box.innerHTML = `<div><div class="k">实际结果</div><div class="v">待回填</div></div>
      <div><div class="k">数据更新</div><div class="v" style="font-size:13px">收盘后自动拉取</div></div>
      <div><div class="k">当前状态</div><div class="v" style="font-size:13px">预测已公示，等待验证</div></div>`;
  } else {
    const a = data.actual;
    const cls = dirClass(a.direction);
    const c = data.compare || {};
    const cells = Object.keys(c).map((k) => {
      const ok = c[k].correct;
      const nm = data.models[k]?.name || k;
      return `<div><div class="k">${nm} 判定</div>
        <div class="v" style="font-size:14px"><span class="chip ${ok ? 'ok' : 'bad'}">${ok ? '正确' : '错误'}</span></div></div>`;
    });
    box.innerHTML = `
      <div><div class="k">实际涨跌（${a.next_date}）</div>
        <div class="v ${cls}">${a.pct_change > 0 ? '+' : ''}${a.pct_change}% · ${dirText(a.direction)}</div></div>
      <div><div class="k">收盘点位</div><div class="v">${a.close}</div></div>
      ${cells.join('')}`;
  }
}

async function run() {
  const date = $('#dateInput').value;
  if (!date) return;
  document.body.classList.add('loading');
  setStatus('预测中…', state.mode === 'api');
  try {
    const data = await getCompare(date);
    renderResult(data);
    const latest = state.health?.latest_data || date;
    setStatus(state.mode === 'api'
      ? `实时后端 · 最新交易日 ${latest} · 正在查看 ${data.date}`
      : `静态快照（截至 ${state.offlineUntil}）· 正在查看 ${data.date}`,
      state.mode === 'api');
    loadHistory();
  } catch (e) {
    $('#modelCards').innerHTML = `<div class="empty">${e.message}</div>`;
    setStatus('预测失败：' + e.message, false);
  } finally {
    document.body.classList.remove('loading');
  }
}

let _histBusy = false;
async function loadHistory() {
  if (_histBusy) return;
  _histBusy = true;
  $('#historySummary').textContent = '历史记录加载中…';
  try {
    const h = await getHistory(state.model, 30);
    const tb = $('#historyTable tbody');
    tb.innerHTML = (h.rows || []).map((r) => {
      const ok = r.correct;
      return `<tr>
        <td>${r.date}</td><td>${r.next_date}</td>
        <td><span class="chip ${dirClass(r.pred_direction)}">${dirText(r.pred_direction)}</span></td>
        <td>${(r.prob_up * 100).toFixed(2)}%</td>
        <td style="color:${r.actual_pct > 0 ? '#ff8f8f' : '#7ee2a8'}">${r.actual_pct > 0 ? '+' : ''}${r.actual_pct}%</td>
        <td><span class="chip ${dirClass(r.actual_direction)}">${dirText(r.actual_direction)}</span></td>
        <td><span class="chip ${ok ? 'ok' : 'bad'}">${ok ? '正确' : '错误'}</span></td>
      </tr>`;
    }).join('');
    const label = state.model === 'M2_cnn_full' ? 'CNN_Stock' : 'MACD 策略模型';
    const rl = { recent: '近 30 个交易日', test: '测试集 2026-01→10', all: '全部可得样本' };
    const hit = (h.rows || []).filter((r) => r.correct).length;
    $('#historySummary').textContent =
      `${label} · ${rl[state.range] || ''}：共 ${h.n} 条，命中 ${hit} 次，准确率 ${pct(h.accuracy)}。` +
      `该表为严格样本外滚动结果，不是训练集表现。`;
  } catch (e) {
    $('#historySummary').textContent = '历史记录加载失败：' + e.message;
  } finally {
    _histBusy = false;
  }
}

/* ---------------- backend switcher ---------------- */
function openBackendDialog() {
  const cur = state.apiBase || '';
  const v = window.prompt(
    '填写运行中的 FastAPI 地址（留空则用同源；清空后保存即回到静态模式）：\n'
    + '本机示例：http://127.0.0.1:8000\n'
    + '穿透示例：https://xxxx.trycloudflare.com',
    cur);
  if (v === null) return;
  const val = v.trim().replace(/\/$/, '');
  if (val) localStorage.setItem('hs300_api_base', val);
  else localStorage.removeItem('hs300_api_base');
  const q = new URLSearchParams(location.search);
  q.delete('api');
  q.delete('source');
  location.search = q.toString();
}

document.addEventListener('DOMContentLoaded', () => {
  $('#runBtn').onclick = run;
  $('#dateInput').onchange = run;
  $('#prevBtn').onclick = () => stepDate(-1);
  $('#nextBtn').onclick = () => stepDate(1);
  const bb = document.getElementById('backendBtn');
  if (bb) bb.onclick = openBackendDialog;
  $('#rangeTabs').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.range = b.dataset.range;
    document.querySelectorAll('#rangeTabs .tab').forEach((t) => t.classList.toggle('active', t === b));
    loadHistory();
  };
  $('#modelTabs').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.model = b.dataset.model;
    document.querySelectorAll('#modelTabs .tab').forEach((t) => t.classList.toggle('active', t === b));
    loadHistory();
  };
  boot();
});

function stepDate(delta) {
  const cur = $('#dateInput').value;
  const idx = state.dates.indexOf(cur);
  if (idx === -1) return;
  const ni = Math.min(Math.max(idx + delta, 0), state.dates.length - 1);
  $('#dateInput').value = state.dates[ni];
  run();
}
