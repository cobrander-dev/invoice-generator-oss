'use strict';
(() => {
  const notice = document.createElement('section');
  notice.className = 'server-auth-notice';
  const text = document.createElement('span');
  text.textContent = '服务器模式已启用，业务数据由受保护的 SQLite 服务提供。';
  const logout = document.createElement('button');
  logout.type = 'button';
  logout.textContent = '退出登录';
  notice.append(text, logout);
  document.querySelector('.main').prepend(notice);
  const serverBadge = document.querySelector('.local-badge');
  function setConnectionState(available) {
    if (!serverBadge) return;
    serverBadge.classList.toggle('server-unavailable', !available);
    const strong = serverBadge.querySelector('strong');
    const small = serverBadge.querySelector('small');
    if (strong) strong.textContent = available ? '服务器模式' : '服务器不可用';
    if (small) small.textContent = available ? 'SQLite 安全存储' : '保存已停止';
  }
  window.addEventListener('ft-server-status', (event) =>
    setConnectionState(event.detail?.available !== false),
  );
  let leaving = false;
  async function checkSession() {
    try {
      const response = await fetch('/api/auth/me', { cache: 'no-store' });
      if (response.status === 401) {
        // Hide stale loaded UI; never clear or modify browser business data.
        document.querySelector('#app').hidden = true;
        window.location.replace('/login');
        return;
      }
      setConnectionState(response.ok);
      if (!response.ok) text.textContent = '服务器连接暂不可用；系统不会回退到浏览器本地数据。';
    } catch {
      setConnectionState(false);
      text.textContent = '服务器连接暂不可用；系统不会回退到浏览器本地数据。';
    }
  }
  logout.addEventListener('click', async () => {
    if (leaving || !window.confirm('退出将离开当前页面；请先保存未保存的修改。是否继续？')) return;
    leaving = true;
    logout.disabled = true;
    try {
      const tokenResponse = await fetch('/api/auth/csrf', { cache: 'no-store' });
      if (tokenResponse.status === 401) {
        window.location.replace('/login');
        return;
      }
      if (!tokenResponse.ok) throw new Error('Unavailable');
      const { csrfToken } = await tokenResponse.json();
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!response.ok && response.status !== 401) throw new Error('Unavailable');
      window.location.replace('/login');
    } catch {
      text.textContent = '退出失败，请检查服务器连接后重试。';
    } finally {
      leaving = false;
      logout.disabled = false;
    }
  });
  // No background polling: it would unintentionally extend idle expiration.
  window.addEventListener('pageshow', checkSession);
  window.addEventListener('focus', checkSession);
})();
