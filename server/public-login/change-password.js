'use strict';
(async () => {
  const form = document.querySelector('#change-password-form'), error = document.querySelector('#login-error');
  let minimum = 8;
  try {
    const me = await fetch('/api/auth/me', { cache: 'no-store' });
    if (me.status === 401) return window.location.replace('/login');
    minimum = Number((await me.json()).passwordMinLength) || 8;
    form.elements.newPassword.minLength = minimum; form.elements.confirmPassword.minLength = minimum;
  } catch { error.textContent = '无法读取密码规则，请稍后重试'; }
  form.addEventListener('submit', async event => {
    event.preventDefault(); error.textContent = '';
    const button = form.querySelector('button'), values = Object.fromEntries(new FormData(form));
    if (values.newPassword.length < minimum) { error.textContent = `新密码至少需要 ${minimum} 个字符`; return; }
    if (values.newPassword !== values.confirmPassword) { error.textContent = '两次输入的新密码不一致'; return; }
    button.disabled = true;
    try {
      const tokenResponse = await fetch('/api/auth/csrf', { cache: 'no-store' });
      if (!tokenResponse.ok) throw new Error('登录已过期');
      const { csrfToken } = await tokenResponse.json();
      const response = await fetch('/api/auth/change-password', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(values) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '密码修改失败');
      form.reset(); window.location.replace('/');
    } catch (err) { error.textContent = err.message; }
    finally { button.disabled = false; }
  });
})();
