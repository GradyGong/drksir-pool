/* erRemoteJs —— 主站→分站 文章远程同步渲染器（自托管版）
 * 部署：本文件与 er_list.js / er_pool.js 一同放到用户静态托管（ER_HOST）。
 *       分站壳 content_header 仅注入一行：<script src="ER_HOST/erRemoteJs.js"></script>
 *       本脚本自动从自身 src 目录加载 er_list.js / er_pool.js，故 ER_HOST 只需写一次。
 * 行为：
 *   1) 仅在分站「行业动态」页（存在 .nd-list）生效；其它页直接返回，v80 完全不变。
 *   2) 启动即给 <body> 加 .er-remote（先隐藏分站 v80 自有列表/静态文章块，避免双显）。
 *   3) 从 ER_HOST 动态加载 er_list.js + er_pool.js；
 *       成功 → 用 ER_LIST 渲染行业动态列表（每页 8 条，自带分页），用 ER_POOL 在 #art<id> 落地时注入正文。
 *       失败（托管不可达/数据缺失）→ 移除 .er-remote、删掉远程容器，分站回退到原有 v80 行为。
 *   4) 远程文章容器 #erArtRoot 与列表 #erRemoteList 挂在 .pm-sec--list 的同级（其外），
 *      使 v80 的 .nd-art:target ~ .pm-sec--list 规则不会影响远程容器。
 */
(function () {
  /* 自身基准目录（用于相对加载 er_list.js / er_pool.js） */
  var me = document.currentScript;
  var ER_BASE = me ? me.src.replace(/\/[^/]*$/, '') : '';

  /* 分类 → 颜色 chip key（与 v80 nd-row-cat--* 对齐） */
  var CATKEY = {
    '技术文章': 'tech', '选型指南': 'guide', '数据报告': 'data', '工程案例': 'case',
    '方案对比': 'cmp', '安装实操': 'howto', '产品推荐': 'prod', '行业动态': 'tech'
  };
  function catKey(c) { return CATKEY[c] || 'tech'; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var CSS = '' +
    'body.er-remote .nd-list{display:none!important}' +
    'body.er-remote .nd-art{display:none!important}' +
    'body.er-remote section.column-article-list{display:none!important}' +
    'body.er-remote #erArtRoot{display:none!important}' +
    'body.er-remote #erArtRoot.is-shown{display:block!important}' +
    'body.er-remote #erArtRoot.is-shown .nd-art{display:block!important}' +
    'body.er-remote #erRemoteList.is-hidden{display:none!important}' +
    '.erp-pager{display:flex;justify-content:center;align-items:center;gap:8px;margin:26px 0 8px;flex-wrap:wrap}' +
    '.erp-pager button{font:inherit;border:1px solid #dbe3ec;background:#fff;color:#33506a;min-width:38px;height:38px;padding:0 12px;border-radius:10px;cursor:pointer;transition:.15s}' +
    '.erp-pager button:hover{border-color:#c97f12;color:#c97f12}' +
    '.erp-pager .erp-num.is-on{background:linear-gradient(135deg,#1c6fb5,#0a5c8c);color:#fff;border-color:transparent}' +
    '.erp-pager button:disabled{opacity:.45;cursor:not-allowed}' +
    '.er-remote-list{display:flex;flex-direction:column;gap:14px}';

  function injectStyle() {
    if (document.getElementById('erRemoteCss')) return;
    var s = document.createElement('style');
    s.id = 'erRemoteCss'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function loadScript(src, ok, fail) {
    var sc = document.createElement('script');
    sc.src = src;
    sc.onload = ok;
    sc.onerror = function () { fail(src); };
    document.head.appendChild(sc);
  }

  function boot() {
    var listBox = document.querySelector('.nd-list');
    if (!listBox) {
      /* 轮询等待 v80 的 erPoolArtJs 异步渲染出 .nd-list（最多 ~5s）；
         文档加载完仍无 → 非行业动态页或残壳，保持 v80 不变，安全退出。 */
      if (document.readyState === 'complete') return;
      if ((boot._tries = (boot._tries || 0) + 1) < 50) { setTimeout(boot, 100); return; }
      return;
    }
    boot._tries = 0;
    document.body.classList.add('er-remote');   // 先隐藏 v80，避免双显
    injectStyle();

    /* 挂载容器（挂在 .pm-sec--list 同级、其前） */
    var pmSec = document.querySelector('.pm-sec--list');
    var parent = pmSec ? pmSec.parentNode
                       : (document.querySelector('.column-content') || document.body);
    var listWrap = document.createElement('div');
    listWrap.id = 'erRemoteList'; listWrap.className = 'er-remote-list';
    var artRoot = document.createElement('div');
    artRoot.id = 'erArtRoot'; artRoot.style.display = 'none';
    if (pmSec) {
      parent.insertBefore(listWrap, pmSec);
      parent.insertBefore(artRoot, pmSec);
    } else {
      parent.appendChild(listWrap); parent.appendChild(artRoot);
    }

    var failed = false, loaded = 0, rendered = false;
    function fail(reason) {
      if (failed) return; failed = true;
      document.body.classList.remove('er-remote');
      if (listWrap.parentNode) listWrap.parentNode.removeChild(listWrap);
      if (artRoot.parentNode) artRoot.parentNode.removeChild(artRoot);
      if (reason) console.warn('[erRemote] 远程数据不可用，回退 v80：', reason);
    }
    function good() {
      if (failed) return;
      loaded++;
      if (loaded < 2) return;                       // 必须两个数据脚本都到位
      if (!window.ER_LIST || !window.ER_POOL || !window.ER_LIST.length) {
        fail('数据为空'); return;
      }
      if (rendered) return; rendered = true;         // 只渲染一次
      try { render(listWrap, artRoot); }
      catch (e) { fail('渲染异常:' + e.message); }
    }
    loadScript(ER_BASE + '/er_list.js', good, fail);
    loadScript(ER_BASE + '/er_pool.js', good, fail);
  }

  function render(listWrap, artRoot) {
    var LIST = window.ER_LIST, POOL = window.ER_POOL;
    var PER = 8;
    var pages = Math.ceil(LIST.length / PER);

    /* ---- 列表 ---- */
    for (var p = 0; p < pages; p++) {
      var pg = document.createElement('div');
      pg.className = 'erp-page';
      pg.setAttribute('data-page', p + 1);
      if (p !== 0) pg.style.display = 'none';
      for (var i = p * PER; i < Math.min((p + 1) * PER, LIST.length); i++) {
        var a = LIST[i];
        var card = document.createElement('a');
        card.className = 'nd-row';
        card.setAttribute('href', '#art' + a.id);
        card.innerHTML =
          '<span class="nd-row-cat nd-row-cat--' + catKey(a.cat) + '">' + esc(a.cat || '技术文章') + '</span>' +
          '<span class="nd-row-body"><h3>' + esc(a.title) + '</h3>' +
          '<span class="nd-row-meta"><span>' + esc(a.date) + '</span><i>·</i>' +
          '<span>' + esc(a.cat || '技术文章') + '</span><b>阅读全文</b></span></span>';
        pg.appendChild(card);
      }
      listWrap.appendChild(pg);
    }
    /* 分页条 */
    var pager = document.createElement('div');
    pager.className = 'erp-pager';
    pager.innerHTML = '<button type="button" class="erp-prev" aria-label="上一页">‹</button>' +
      '<span class="erp-nums"></span>' +
      '<button type="button" class="erp-next" aria-label="下一页">›</button>';
    listWrap.appendChild(pager);
    var nums = pager.querySelector('.erp-nums');
    for (var n = 1; n <= pages; n++) {
      (function (nn) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'erp-num' + (nn === 1 ? ' is-on' : '');
        b.textContent = nn;
        b.addEventListener('click', function () { goPage(nn); });
        nums.appendChild(b);
      })(n);
    }
    function goPage(nn) {
      var ps = listWrap.querySelectorAll('.erp-page');
      for (var k = 0; k < ps.length; k++)
        ps[k].style.display = (k + 1 === nn) ? '' : 'none';
      var bs = nums.querySelectorAll('.erp-num');
      for (var m = 0; m < bs.length; m++)
        bs[m].classList.toggle('is-on', (m + 1) === nn);
      if (listWrap.scrollIntoView) listWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    pager.querySelector('.erp-prev').addEventListener('click', function () {
      var cur = +pager.querySelector('.erp-num.is-on').textContent;
      if (cur > 1) goPage(cur - 1);
    });
    pager.querySelector('.erp-next').addEventListener('click', function () {
      var cur = +pager.querySelector('.erp-num.is-on').textContent;
      if (cur < pages) goPage(cur + 1);
    });

    /* ---- 落地 / 返回 ---- */
    function showArt(id) {
      var blk = POOL[String(id)];
      if (!blk) return false;
      artRoot.innerHTML = blk;
      /* 拦截远程块内的返回 / 上下篇链接，避免污染 v80 的 #art/#ndpN :target */
      artRoot.querySelectorAll('.nd-art-back').forEach(function (b) {
        b.addEventListener('click', function (e) { e.preventDefault(); showList(); });
      });
      artRoot.querySelectorAll('.nd-art-nav a[href^="#art"]').forEach(function (a2) {
        a2.addEventListener('click', function (e) {
          e.preventDefault();
          var mm = a2.getAttribute('href').match(/#art(\d+)/);
          if (mm) showArt(mm[1]);
        });
      });
      artRoot.classList.add('is-shown');
      listWrap.classList.add('is-hidden');
      if (location.hash !== '#art' + id) {
        try { history.replaceState(null, '', '#art' + id); } catch (e) {}
      }
      if (artRoot.scrollIntoView) artRoot.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
    function showList() {
      artRoot.classList.remove('is-shown');
      listWrap.classList.remove('is-hidden');
      try { history.replaceState(null, '', '#erlist'); } catch (e) {}
    }
    function onHash() {
      var h = location.hash || '';
      var m = h.match(/^#art(\d+)$/);
      if (m && showArt(m[1])) return;
      showList();
    }
    window.addEventListener('hashchange', onHash);
    onHash();
  }

  boot();
})();
