export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).end();
  if (req.user.role !== 'ADMIN') return res.status(403).end();
  return next();
}
