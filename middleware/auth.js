const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'Access token required' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data: user, error } = await supabase.from('users').select('*, roles(name)').eq('id', decoded.userId).single();
    if (error || !user) return res.status(401).json({ success: false, message: 'Invalid token' });
    if (!user.is_active || user.is_banned) return res.status(403).json({ success: false, message: 'Account suspended' });
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const requirePremium = async (req, res, next) => {
  try {
    const { data: subscription } = await supabase.from('subscriptions').select('*').eq('user_id', req.user.id).eq('status', 'active').gt('end_date', new Date().toISOString()).single();
    if (!subscription) return res.status(403).json({ success: false, message: 'Premium subscription required', upgrade_url: '/premium' });
    req.subscription = subscription;
    next();
  } catch (error) {
    return res.status(403).json({ success: false, message: 'Premium subscription required' });
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.roles.name))
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    next();
  };
};

const checkDailyLimit = (type) => {
  return async (req, res, next) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data: subscription } = await supabase.from('subscriptions').select('*').eq('user_id', req.user.id).eq('status', 'active').gt('end_date', new Date().toISOString()).single();
      if (subscription) return next();
      let { data: limits } = await supabase.from('daily_limits').select('*').eq('user_id', req.user.id).eq('date', today).single();
      if (!limits) {
        const { data: newLimits } = await supabase.from('daily_limits').insert({ user_id: req.user.id, date: today }).select().single();
        limits = newLimits;
      }
      if (type === 'mcq' && limits.mcq_count >= 50)
        return res.status(429).json({ success: false, message: 'Daily free limit reached (50 MCQs/day)', upgrade_url: '/premium' });
      if (type === 'mock' && limits.mock_count >= 2)
        return res.status(429).json({ success: false, message: 'Daily free limit reached (2 mocks/day)', upgrade_url: '/premium' });
      req.dailyLimits = limits;
      next();
    } catch (error) { next(); }
  };
};

module.exports = { verifyToken, requirePremium, requireRole, checkDailyLimit };
