window.__ModuleLoader__.load({
  id: 'dsh-lambda-dashboard',
  factory(require) {
    const React = require('react');
    const element = React.createElement;
    const title = 'Lambda额度管理';
    const dashboardUrl = 'http://47.115.165.231:30179/';

    const passwordKey = 'dsh-lambda-dashboard.password.v1';

    function loginScript(password, url) {
      return `(${async function (password, origin) {
        if (location.origin !== origin) return 'wrong-origin';
        if (!document.getElementById('loginForm')) return 'ready';
        try {
          const response = await fetch('/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ password }),
            signal: AbortSignal.timeout(12000),
          });
          if (response.ok) return 'signed-in';
          return response.status === 401 ? 'invalid-password' : 'login-failed';
        } catch { return 'login-failed'; }
      }.toString()})(${JSON.stringify(password)},${JSON.stringify(new URL(url).origin)})`;
    }

    function mountDesktopPage(container, bridge, url, onError, options = {}) {
      let disposed = false;
      let guest, lease, unsubscribe, timer;
      let booted = false;
      let authenticating = false;
      const events = new AbortController();
      const fail = () => { clearTimeout(timer); if (!disposed) onError(); };
      const navigate = (target) => {
        if (disposed || new URL(target).origin !== new URL(url).origin) return;
        Promise.resolve(guest.loadURL(target)).catch(fail);
      };
      Promise.resolve().then(() => bridge.acquire('plugin:dsh-lambda-dashboard')).then((reservation) => {
        if (disposed) return bridge.release(reservation.lease);
        lease = reservation.lease;
        guest = container.ownerDocument.createElement('webview');
        for (const [name, value] of Object.entries({ name: lease, partition: reservation.partition, allowpopups: '', src: `about:blank#${lease}` })) guest.setAttribute(name, value);
        guest.style.cssText = 'display:flex;flex:1;width:100%;height:100%;border:0';
        guest.addEventListener('dom-ready', async () => {
          if (!booted) {
            booted = true;
            timer = setTimeout(fail, 20000);
            navigate(url);
            return;
          }
          const password = options.readPassword?.();
          if (!password || authenticating || disposed) return;
          authenticating = true;
          try {
            const status = await guest.executeJavaScript(loginScript(password, url));
            if (disposed) return;
            options.onAuth?.(status);
            if (status === 'signed-in') guest.reload();
          } catch {
            if (!disposed) options.onAuth?.('login-failed');
          } finally { authenticating = false; }
        }, { signal: events.signal });
        guest.addEventListener('did-navigate', (event) => { if (event.url !== `about:blank#${lease}`) clearTimeout(timer); }, { signal: events.signal });
        guest.addEventListener('did-fail-load', (event) => { if (event.isMainFrame && event.errorCode !== -3) fail(); }, { signal: events.signal });
        unsubscribe = bridge.onOpenRequested(lease, navigate);
        container.append(guest);
      }).catch(fail);
      return () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        events.abort();
        unsubscribe?.();
        guest?.remove();
        if (lease) Promise.resolve(bridge.release(lease)).catch(() => {});
      };
    }

    const actionButtonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      height: 32,
      minHeight: 32,
      maxHeight: 32,
      boxSizing: 'border-box',
      padding: '6px 10px',
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      borderRadius: 7,
      background: 'color-mix(in srgb, currentColor 6%, transparent)',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      lineHeight: 1.2,
      cursor: 'pointer',
      transition: 'background 120ms ease, border-color 120ms ease, transform 120ms ease',
    };
    const actionIconStyle = { display: 'inline-flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', fontSize: 15, lineHeight: 1 };
    const actionGroupStyle = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' };
    const actionLabelStyle = { fontSize: 12, opacity: 0.62, whiteSpace: 'nowrap' };
    const actionButton = (icon, label, props = {}) => element('button', {
      type: 'button',
      ...props,
      className: `lambda-action ${props.className || ''}`.trim(),
      style: { ...actionButtonStyle, ...(props.style || {}) },
    }, element('span', { 'aria-hidden': true, style: actionIconStyle }, icon), element('span', null, label));

    function Dashboard() {
      const url = dashboardUrl;
      const [failed, setFailed] = React.useState(false);
      const [saved, setSaved] = React.useState(() => {
        try { return Boolean(globalThis.localStorage?.getItem(passwordKey)); } catch { return false; }
      });
      const [editing, setEditing] = React.useState(false);
      const [authMessage, setAuthMessage] = React.useState('');
      const [revision, setRevision] = React.useState(0);
      const container = React.useRef(null);
      const passwordInput = React.useRef(null);
      const bridge = globalThis.dshDesktop?.browser;
      React.useEffect(() => {
        setFailed(false);
        if (!bridge) return;
        return mountDesktopPage(container.current, bridge, url, () => setFailed(true), {
          readPassword() {
            try { return globalThis.localStorage?.getItem(passwordKey); } catch { return null; }
          },
          onAuth(status) {
            setAuthMessage(status === 'invalid-password' ? '已保存的密码不正确，请修改密码。' : status === 'login-failed' ? '自动登录失败，可重试或在原页面手动登录。' : '');
          },
        });
      }, [bridge, url, revision]);
      const savePassword = (event) => {
        event.preventDefault();
        const password = passwordInput.current?.value;
        if (!password) return;
        try {
          globalThis.localStorage.setItem(passwordKey, password);
          passwordInput.current.value = '';
          setSaved(true);
          setEditing(false);
          setAuthMessage('');
          setRevision((value) => value + 1);
        } catch { setAuthMessage('无法保存本机设置，请在原页面手动登录。'); }
      };
      const forgetPassword = () => {
        try {
          globalThis.localStorage.removeItem(passwordKey);
          setSaved(false);
          setEditing(false);
          setAuthMessage('已清除保存的密码；当前网页会话仍保持，需退出登录时请使用原页面。');
          setRevision((value) => value + 1);
        } catch { setAuthMessage('无法清除本机设置。'); }
      };
      return element('section', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        element('style', null, '.lambda-action:hover { background: color-mix(in srgb, currentColor 12%, transparent) !important; border-color: color-mix(in srgb, currentColor 32%, transparent) !important; } .lambda-action:active { transform: translateY(1px); } .lambda-action:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }'),
        element('header', { style: { display: 'flex', gap: 12, alignItems: 'center', padding: '10px 12px', flexWrap: 'wrap', borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)' } },
          element('strong', { style: { marginRight: 'auto', fontSize: 14, letterSpacing: 0 } }, title),
          element('nav', { 'aria-label': '看板操作', style: { display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' } },
            element('div', { style: actionGroupStyle },
              element('span', { style: actionLabelStyle }, '访问'),
              element('a', { href: url, target: '_blank', rel: 'noopener noreferrer', className: 'lambda-action', title: '在独立窗口打开看板', 'aria-label': '在独立窗口打开看板', style: { ...actionButtonStyle, textDecoration: 'none', color: 'inherit' } },
                element('span', { 'aria-hidden': true, style: actionIconStyle }, '↗'), element('span', null, '独立打开'))),
            bridge ? element('div', { style: actionGroupStyle },
              element('span', { style: actionLabelStyle }, '本机设置'),
              actionButton('⌕', saved ? '修改自动登录密码' : '设置自动登录', { onClick: () => setEditing((value) => !value), title: saved ? '修改自动登录密码' : '设置自动登录' }),
              bridge && saved ? actionButton('×', '忘记密码', { onClick: forgetPassword, title: '清除本机保存的密码' }) : null,
              actionButton('↻', '重新加载', { onClick: () => setRevision((value) => value + 1), title: '重新加载看板页面' })) : null),
        ),
        bridge && (!saved || editing) ? element('form', { onSubmit: savePassword, style: { display: 'flex', gap: 8, padding: '10px 12px 12px', alignItems: 'center', flexWrap: 'wrap', background: 'color-mix(in srgb, currentColor 4%, transparent)' } },
          element('input', { ref: passwordInput, type: 'password', required: true, autoComplete: 'off', placeholder: '输入看板密码，仅需设置一次', 'aria-label': '自动登录密码', style: { flex: '1 1 240px', minWidth: 0, minHeight: 32, padding: '6px 9px', borderRadius: 6, border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', background: 'transparent', color: 'inherit', font: 'inherit' } }),
          element('button', { type: 'submit', style: { ...actionButtonStyle, fontWeight: 600, background: 'color-mix(in srgb, currentColor 12%, transparent)' } }, element('span', { 'aria-hidden': true, style: actionIconStyle }, '✓'), element('span', null, '记住并登录'))) : null,
        authMessage ? element('p', { role: 'status', style: { margin: '8px 12px', fontSize: 12, lineHeight: 1.5 } }, authMessage) : null,
        (!bridge || failed) ? element('p', { role: 'alert', style: { margin: '8px 12px', fontSize: 12, lineHeight: 1.5 } }, failed ? '网页加载失败，请检查网络或独立打开。' : '浏览器模式请独立打开；桌面程序支持内嵌。') : null,
        element('div', { ref: container, style: { display: 'flex', flex: 1, minHeight: 0 } }));
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'lambda-dashboard' }, Dashboard)), 'Lambda额度管理: page');
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'lambda-dashboard', order: 12, label: () => title }, () => element('span', { 'aria-hidden': true, style: { display: 'inline-flex', width: 16, height: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1, fontSize: 18 } }, 'λ'))), 'Lambda额度管理: navigation');
    }
    return { inject: ['slots'], apply, mountDesktopPage, loginScript };
  },
});
