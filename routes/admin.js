const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { verifyToken, requireRole } = require('../middleware/auth');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const isAdmin = [verifyToken, requireRole('admin', 'super_admin')];

router.get('/dashboard', isAdmin, async (req, res) => {
  try {
    const { data: totalUsers } = await supabase.from('users').select('id', { count: 'exact' });
    const { data: premiumUsers } = await supabase.from('subscriptions').select('id', { count: 'exact' }).eq('status', 'active').gt('end_date', new Date().toISOString());
    const { data: totalQuestions } = await supabase.from('questions').select('id', { count: 'exact' });
    const { data: pendingQuestions } = await supabase.from('questions').select('id', { count: 'exact' }).eq('is_verified', false).eq('is_published', false);
    const { data: pendingProducts } = await supabase.from('marketplace_products').select('id', { count: 'exact' }).eq('status', 'pending');
    const { data: totalRevenue } = await supabase.from('payments').select('amount').eq('status', 'completed');
    const revenue = totalRevenue?.reduce((sum, p) => sum + p.amount, 0) || 0;
    const { data: recentUsers } = await supabase.from('users').select('id, email, created_at, roles(name)').order('created_at', { ascending: false }).limit(10);
    const { data: pendingReports } = await supabase.from('reports').select('id', { count: 'exact' }).eq('status', 'pending');
    res.json({ success: true, stats: { total_users: totalUsers?.length || 0, premium_users: premiumUsers?.length || 0, total_questions: totalQuestions?.length || 0, pending_questions: pendingQuestions?.length || 0, pending_products: pendingProducts?.length || 0, total_revenue: revenue, pending_reports: pendingReports?.length || 0 }, recent_users: recentUsers || [] });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get dashboard' }); }
});

router.get('/users', isAdmin, async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    let query = supabase.from('users').select('*, roles(name), profiles(full_name)').order('created_at', { ascending: false });
    if (search) query = query.ilike('email', `%${search}%`);
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);
    const { data: users, error } = await query;
    if (error) throw error;
    res.json({ success: true, users });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get users' }); }
});

router.put('/users/:id/ban', isAdmin, async (req, res) => {
  try {
    const { ban, reason } = req.body;
    await supabase.from('users').update({ is_banned: ban, ban_reason: ban ? reason : null }).eq('id', req.params.id);
    await supabase.from('admin_logs').insert({ admin_id: req.user.id, action: ban ? 'ban_user' : 'unban_user', target_type: 'user', target_id: req.params.id, details: { reason } });
    res.json({ success: true, message: ban ? 'User banned' : 'User unbanned' });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to update user' }); }
});

router.get('/questions/pending', isAdmin, async (req, res) => {
  try {
    const { data: questions } = await supabase.from('questions').select('*, subjects(name), topics(name), question_options(*)').eq('is_verified', false).eq('is_published', false).order('created_at', { ascending: false }).limit(50);
    res.json({ success: true, questions });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get questions' }); }
});

router.put('/questions/:id/review', isAdmin, async (req, res) => {
  try {
    const { action, reason } = req.body;
    if (action === 'approve') await supabase.from('questions').update({ is_verified: true, is_published: true }).eq('id', req.params.id);
    else await supabase.from('questions').update({ is_flagged: true, flag_reason: reason }).eq('id', req.params.id);
    await supabase.from('admin_logs').insert({ admin_id: req.user.id, action: `question_${action}`, target_type: 'question', target_id: req.params.id, details: { reason } });
    res.json({ success: true, message: `Question ${action}d` });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to review question' }); }
});

router.put('/questions/bulk-approve', isAdmin, async (req, res) => {
  try {
    const { question_ids } = req.body;
    await supabase.from('questions').update({ is_verified: true, is_published: true }).in('id', question_ids);
    res.json({ success: true, message: `${question_ids.length} questions approved` });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to bulk approve' }); }
});

router.get('/products/pending', isAdmin, async (req, res) => {
  try {
    const { data: products } = await supabase.from('marketplace_products').select('*, seller_profiles(display_name, user_id)').eq('status', 'pending').order('created_at', { ascending: false });
    res.json({ success: true, products });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get products' }); }
});

router.put('/products/:id/review', isAdmin, async (req, res) => {
  try {
    const { action, reason } = req.body;
    const status = action === 'approve' ? 'approved' : 'rejected';
    await supabase.from('marketplace_products').update({ status }).eq('id', req.params.id);
    const { data: product } = await supabase.from('marketplace_products').select('title, seller_profiles(user_id)').eq('id', req.params.id).single();
    if (product?.seller_profiles?.user_id) {
      await supabase.from('notifications').insert({ user_id: product.seller_profiles.user_id, title: action === 'approve' ? '✅ Product Approved!' : '❌ Product Rejected', message: action === 'approve' ? `Your product "${product.title}" is now live!` : `Your product "${product.title}" was rejected. Reason: ${reason}`, type: `product_${action}` });
    }
    res.json({ success: true, message: `Product ${action}d` });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to review product' }); }
});

router.get('/reports', isAdmin, async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const { data: reports } = await supabase.from('reports').select('*').eq('status', status).order('created_at', { ascending: false }).limit(50);
    res.json({ success: true, reports });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get reports' }); }
});

router.put('/reports/:id/resolve', isAdmin, async (req, res) => {
  try {
    const { action_taken } = req.body;
    await supabase.from('reports').update({ status: 'resolved', reviewed_by: req.user.id, reviewed_at: new Date().toISOString(), action_taken }).eq('id', req.params.id);
    res.json({ success: true, message: 'Report resolved' });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to resolve report' }); }
});

router.get('/feature-flags', isAdmin, async (req, res) => {
  try {
    const { data: flags } = await supabase.from('feature_flags').select('*').order('flag_key');
    res.json({ success: true, flags });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get flags' }); }
});

router.put('/feature-flags/:key', isAdmin, async (req, res) => {
  try {
    const { is_enabled } = req.body;
    await supabase.from('feature_flags').update({ is_enabled, updated_by: req.user.id, updated_at: new Date().toISOString() }).eq('flag_key', req.params.key);
    res.json({ success: true, message: `Feature ${req.params.key} ${is_enabled ? 'enabled' : 'disabled'}` });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to update flag' }); }
});

router.post('/notifications/broadcast', isAdmin, async (req, res) => {
  try {
    const { title, message, type, target } = req.body;
    let userIds = [];
    if (target === 'all') { const { data: users } = await supabase.from('users').select('id').eq('is_active', true).eq('is_banned', false); userIds = users?.map(u => u.id) || []; }
    else if (target === 'premium') { const { data: subs } = await supabase.from('subscriptions').select('user_id').eq('status', 'active').gt('end_date', new Date().toISOString()); userIds = subs?.map(s => s.user_id) || []; }
    else if (target === 'free') { const { data: users } = await supabase.from('users').select('id').eq('role_id', 1).eq('is_active', true); userIds = users?.map(u => u.id) || []; }
    const batchSize = 100;
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize).map(userId => ({ user_id: userId, title, message, type: type || 'broadcast' }));
      await supabase.from('notifications').insert(batch);
    }
    res.json({ success: true, message: `Notification sent to ${userIds.length} users` });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to send notification' }); }
});

module.exports = router;
                               
