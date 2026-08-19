const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('../middleware/auth');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

router.get('/', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, unread_only = false } = req.query;
    let query = supabase.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (unread_only === 'true') query = query.eq('is_read', false);
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);
    const { data: notifications, error } = await query;
    if (error) throw error;
    const { data: unreadCount } = await supabase.from('notifications').select('id', { count: 'exact' }).eq('user_id', req.user.id).eq('is_read', false);
    res.json({ success: true, notifications, unread_count: unreadCount?.length || 0 });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get notifications' }); }
});

router.put('/read-all', verifyToken, async (req, res) => {
  try {
    await supabase.from('notifications').update({ is_read: true, read_at: new Date().toISOString() }).eq('user_id', req.user.id).eq('is_read', false);
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to mark all as read' }); }
});

router.put('/:id/read', verifyToken, async (req, res) => {
  try {
    await supabase.from('notifications').update({ is_read: true, read_at: new Date().toISOString() }).eq('id', req.params.id).eq('user_id', req.user.id);
    res.json({ success: true, message: 'Marked as read' });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to mark as read' }); }
});

router.get('/preferences', verifyToken, async (req, res) => {
  try {
    const { data: prefs } = await supabase.from('notification_preferences').select('*').eq('user_id', req.user.id).single();
    res.json({ success: true, preferences: prefs });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get preferences' }); }
});

router.put('/preferences', verifyToken, async (req, res) => {
  try {
    const { email_enabled, push_enabled, daily_reminder, streak_reminder, mock_reminder, marketplace_updates, community_replies, premium_updates } = req.body;
    const { data: prefs, error } = await supabase.from('notification_preferences').upsert({ user_id: req.user.id, email_enabled, push_enabled, daily_reminder, streak_reminder, mock_reminder, marketplace_updates, community_replies, premium_updates, updated_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    res.json({ success: true, message: 'Preferences updated!', preferences: prefs });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to update preferences' }); }
});

router.delete('/:id', verifyToken, async (req, res) => {
  try {
    await supabase.from('notifications').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to delete notification' }); }
});

module.exports = router;
