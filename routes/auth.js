const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('../middleware/auth');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const generateToken = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });

router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name, phone } = req.body;
    if (!email || !password || !full_name) return res.status(400).json({ success: false, message: 'Email, password and name required' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    const { data: existingUser } = await supabase.from('users').select('id').eq('email', email).single();
    if (existingUser) return res.status(409).json({ success: false, message: 'Email already registered' });
    const password_hash = await bcrypt.hash(password, 12);
    const { data: newUser, error: userError } = await supabase.from('users').insert({ email, phone: phone || null, password_hash, role_id: 1 }).select().single();
    if (userError) throw userError;
    await supabase.from('profiles').insert({ user_id: newUser.id, full_name, username: email.split('@')[0] + '_' + Math.random().toString(36).substr(2, 5) });
    await supabase.from('streaks').insert({ user_id: newUser.id });
    await supabase.from('notification_preferences').insert({ user_id: newUser.id });
    const token = generateToken(newUser.id);
    res.status(201).json({ success: true, message: 'Account created successfully', token, user: { id: newUser.id, email: newUser.email, full_name } });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
    const { data: user, error } = await supabase.from('users').select('*, roles(name)').eq('email', email).single();
    if (error || !user) return res.status(401).json({ success: false, message: 'Invalid email or password' });
    if (user.is_banned) return res.status(403).json({ success: false, message: 'Account suspended: ' + user.ban_reason });
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) return res.status(401).json({ success: false, message: 'Invalid email or password' });
    const { data: profile } = await supabase.from('profiles').select('*').eq('user_id', user.id).single();
    await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);
    const { data: subscription } = await supabase.from('subscriptions').select('*').eq('user_id', user.id).eq('status', 'active').gt('end_date', new Date().toISOString()).single();
    const token = generateToken(user.id);
    res.json({ success: true, message: 'Login successful', token, user: { id: user.id, email: user.email, role: user.roles.name, is_premium: !!subscription, profile: { full_name: profile?.full_name, username: profile?.username, avatar_url: profile?.avatar_url } } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

router.get('/me', verifyToken, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles').select('*').eq('user_id', req.user.id).single();
    const { data: subscription } = await supabase.from('subscriptions').select('*, subscription_plans(*)').eq('user_id', req.user.id).eq('status', 'active').gt('end_date', new Date().toISOString()).single();
    const { data: streak } = await supabase.from('streaks').select('*').eq('user_id', req.user.id).single();
    res.json({ success: true, user: { id: req.user.id, email: req.user.email, role: req.user.roles.name, is_premium: !!subscription, subscription: subscription || null, profile, streak } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get user data' });
  }
});

router.post('/change-password', verifyToken, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ success: false, message: 'Current and new password required' });
    if (new_password.length < 6) return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
    const { data: user } = await supabase.from('users').select('password_hash').eq('id', req.user.id).single();
    const isValid = await bcrypt.compare(current_password, user.password_hash);
    if (!isValid) return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    const password_hash = await bcrypt.hash(new_password, 12);
    await supabase.from('users').update({ password_hash }).eq('id', req.user.id);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to change password' });
  }
});

module.exports = router;
