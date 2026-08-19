const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('../middleware/auth');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

router.get('/profile', verifyToken, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles').select('*').eq('user_id', req.user.id).single();
    const { data: streak } = await supabase.from('streaks').select('*').eq('user_id', req.user.id).single();
    const { data: xpData } = await supabase.from('xp_transactions').select('amount').eq('user_id', req.user.id);
    const totalXP = xpData?.reduce((sum, x) => sum + x.amount, 0) || 0;
    const { data: badges } = await supabase.from('user_badges').select('*, badges(*)').eq('user_id', req.user.id);
    const { data: stats } = await supabase.from('question_attempts').select('is_correct').eq('user_id', req.user.id);
    const totalAttempted = stats?.length || 0;
    const totalCorrect = stats?.filter(s => s.is_correct).length || 0;
    const accuracy = totalAttempted > 0 ? ((totalCorrect / totalAttempted) * 100).toFixed(2) : 0;
    const { data: mockCount } = await supabase.from('mock_test_results').select('id', { count: 'exact' }).eq('user_id', req.user.id);
    const { data: bestMock } = await supabase.from('mock_test_results').select('percentage').eq('user_id', req.user.id).order('percentage', { ascending: false }).limit(1).single();
    res.json({ success: true, profile, stats: { total_xp: totalXP, current_streak: streak?.current_streak || 0, longest_streak: streak?.longest_streak || 0, questions_solved: totalAttempted, accuracy, mock_tests: mockCount?.length || 0, best_score: bestMock?.percentage || 0 }, badges: badges || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get profile' });
  }
});

router.put('/profile', verifyToken, async (req, res) => {
  try {
    const { full_name, bio, date_of_birth, country, state, city, education_level, course, university, graduation_year, target_exam, exam_date, goals, subjects, language_preference } = req.body;
    const { data: profile, error } = await supabase.from('profiles').update({ full_name, bio, date_of_birth, country, state, city, education_level, course, university, graduation_year, target_exam, exam_date, goals, subjects, language_preference, updated_at: new Date().toISOString() }).eq('user_id', req.user.id).select().single();
    if (error) throw error;
    res.json({ success: true, message: 'Profile updated successfully', profile });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

router.get('/dashboard', verifyToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: profile } = await supabase.from('profiles').select('full_name, avatar_url, target_exam').eq('user_id', req.user.id).single();
    const { data: limits } = await supabase.from('daily_limits').select('*').eq('user_id', req.user.id).eq('date', today).single();
    const { data: streak } = await supabase.from('streaks').select('*').eq('user_id', req.user.id).single();
    const { data: subscription } = await supabase.from('subscriptions').select('*, subscription_plans(name)').eq('user_id', req.user.id).eq('status', 'active').gt('end_date', new Date().toISOString()).single();
    const { data: recentResults } = await supabase.from('mock_test_results').select('percentage, created_at, mock_tests(title)').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(5);
    const { data: weakSubjects } = await supabase.from('user_subject_performance').select('*, subjects(name)').eq('user_id', req.user.id).order('accuracy', { ascending: true }).limit(3);
    const { data: certificates } = await supabase.from('certificates').select('*').eq('user_id', req.user.id).order('issued_at', { ascending: false }).limit(3);
    const { data: notifications } = await supabase.from('notifications').select('*').eq('user_id', req.user.id).eq('is_read', false).order('created_at', { ascending: false }).limit(5);
    const isPremium = !!subscription;
    res.json({ success: true, dashboard: { profile, is_premium: isPremium, subscription: subscription || null, today: { mcq_used: limits?.mcq_count || 0, mcq_limit: isPremium ? -1 : 50, mock_used: limits?.mock_count || 0, mock_limit: isPremium ? -1 : 2 }, streak: { current: streak?.current_streak || 0, longest: streak?.longest_streak || 0 }, recent_results: recentResults || [], weak_subjects: weakSubjects || [], certificates: certificates || [], unread_notifications: notifications?.length || 0 } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get dashboard' });
  }
});

router.get('/performance', verifyToken, async (req, res) => {
  try {
    const { data: performance } = await supabase.from('user_subject_performance').select('*, subjects(name, slug)').eq('user_id', req.user.id).order('accuracy', { ascending: false });
    const { data: xpData } = await supabase.from('xp_transactions').select('amount').eq('user_id', req.user.id);
    const totalXP = xpData?.reduce((sum, x) => sum + x.amount, 0) || 0;
    res.json({ success: true, performance: performance || [], total_xp: totalXP });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get performance' });
  }
});

router.get('/leaderboard', async (req, res) => {
  try {
    const { period = 'weekly' } = req.query;
    const now = new Date();
    let periodKey;
    if (period === 'daily') periodKey = now.toISOString().split('T')[0];
    else if (period === 'weekly') { const weekStart = new Date(now.setDate(now.getDate() - now.getDay())); periodKey = weekStart.toISOString().split('T')[0]; }
    else periodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const { data: leaderboard } = await supabase.from('leaderboard').select('*, profiles(full_name, username, avatar_url)').eq('period_type', period).eq('period_key', periodKey).order('score', { ascending: false }).limit(50);
    res.json({ success: true, period, leaderboard: leaderboard?.map((entry, index) => ({ rank: index + 1, score: entry.score, name: entry.show_real_name ? entry.profiles?.full_name : entry.profiles?.username, avatar: entry.profiles?.avatar_url })) || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get leaderboard' });
  }
});

router.get('/certificates', verifyToken, async (req, res) => {
  try {
    const { data: certificates } = await supabase.from('certificates').select('*').eq('user_id', req.user.id).order('issued_at', { ascending: false });
    res.json({ success: true, certificates });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get certificates' });
  }
});

router.get('/verify/:certificateNumber', async (req, res) => {
  try {
    const { data: cert } = await supabase.from('certificates').select('*, profiles(full_name)').eq('certificate_number', req.params.certificateNumber).single();
    if (!cert) return res.status(404).json({ success: false, message: 'Certificate not found' });
    res.json({ success: true, valid: cert.is_valid, certificate: { number: cert.certificate_number, name: cert.profiles?.full_name, exam: cert.exam_name, score: cert.percentage, issued_at: cert.issued_at } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

module.exports = router;
      
