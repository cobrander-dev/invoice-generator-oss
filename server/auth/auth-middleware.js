'use strict';
function requireAuth(auth, { page = false, allowPasswordChange = false } = {}) {
  return (req, res, next) => {
    const user = req.session.userId ? auth.getUser(req.session.userId) : null;
    const valid =
      user &&
      user.status === 'ACTIVE' &&
      Number(req.session.authVersion) === Number(user.authVersion);
    if (!valid)
      return req.session.destroy(() =>
        page ? res.redirect(302, '/login') : res.status(401).json({ error: '请先登录' }),
      );
    req.user = user;
    if (page && user.mustChangePassword && !allowPasswordChange)
      return res.redirect(302, '/change-password');
    if (
      user.mustChangePassword &&
      !page &&
      !['/auth/me', '/auth/csrf', '/auth/change-password', '/auth/logout'].includes(req.path)
    ) {
      return res.status(403).json({ error: '必须先修改临时密码' });
    }
    next();
  };
}
module.exports = { requireAuth };
