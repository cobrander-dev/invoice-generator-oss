'use strict';
document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const error = document.querySelector('#login-error');
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content,
      },
      body: JSON.stringify({
        username: form.elements.username.value,
        password: form.elements.password.value,
      }),
    });
    if (response.ok) {
      const data = await response.json();
      form.elements.password.value = '';
      window.location.replace(data.user?.mustChangePassword ? '/change-password' : '/');
      return;
    }
    const data = await response.json();
    error.textContent = data.error || '登录失败';
    if (response.status === 403) error.textContent += '。请刷新登录页面。';
  } catch {
    error.textContent = '无法连接服务器，请稍后重试';
  } finally {
    form.elements.password.value = '';
    button.disabled = false;
  }
});
