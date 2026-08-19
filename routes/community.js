const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('../middleware/auth');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

router.get('/posts', async (req, res) => {
  try {
    const { category, subject_id, search, sort = 'latest', page = 1, limit = 20 } = req.query;
    let query = supabase.from('community_posts').select('*, profiles(full_name, username, avatar_url), subjects(name)').eq('is_published', true);
    if (category) query = query.eq('category', category);
    if (subject_id) query = query.eq('subject_id', subject_id);
    if (search) query = query.ilike('title', `%${search}%`);
    if (sort === 'popular') query = query.order('like_count', { ascending: false });
    else if (sort === 'unanswered') query = query.eq('is_answered', false);
    else query = query.order('created_at', { ascending: false });
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);
    const { data: posts, error } = await query;
    if (error) throw error;
    res.json({ success: true, posts });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get posts' }); }
});

router.get('/posts/:id', async (req, res) => {
  try {
    const { data: post, error } = await supabase.from('community_posts').select('*, profiles(full_name, username, avatar_url), subjects(name)').eq('id', req.params.id).single();
    if (error || !post) return res.status(404).json({ success: false, message: 'Post not found' });
    await supabase.from('community_posts').update({ view_count: post.view_count + 1 }).eq('id', post.id);
    const { data: comments } = await supabase.from('comments').select('*, profiles(full_name, username, avatar_url)').eq('post_id', post.id).eq('is_visible', true).is('parent_id', null).order('created_at', { ascending: true });
    res.json({ success: true, post, comments });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get post' }); }
});

router.post('/posts', verifyToken, async (req, res) => {
  try {
    const { title, content, post_type, category, subject_id, tags } = req.body;
    if (!content) return res.status(400).json({ success: false, message: 'Content required' });
    const { data: post, error } = await supabase.from('community_posts').insert({ user_id: req.user.id, title, content, post_type: post_type || 'discussion', category, subject_id: subject_id || null, tags: tags || [] }).select().single();
    if (error) throw error;
    await supabase.from('xp_transactions').insert({ user_id: req.user.id, amount: 5, type: 'community_post', description: 'Created community post' });
    res.status(201).json({ success: true, message: 'Post created!', post });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to create post' }); }
});

router.post('/posts/:id/comment', verifyToken, async (req, res) => {
  try {
    const { content, parent_id } = req.body;
    if (!content) return res.status(400).json({ success: false, message: 'Content required' });
    const { data: comment, error } = await supabase.from('comments').insert({ post_id: req.params.id, user_id: req.user.id, content, parent_id: parent_id || null }).select('*, profiles(full_name, username, avatar_url)').single();
    if (error) throw error;
    const { data: post } = await supabase.from('community_posts').select('comment_count').eq('id', req.params.id).single();
    await supabase.from('community_posts').update({ comment_count: (post?.comment_count || 0) + 1 }).eq('id', req.params.id);
    await supabase.from('xp_transactions').insert({ user_id: req.user.id, amount: 2, type: 'community_comment', description: 'Added comment' });
    res.status(201).json({ success: true, comment });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to add comment' }); }
});

router.post('/like', verifyToken, async (req, res) => {
  try {
    const { target_type, target_id } = req.body;
    const { data: existing } = await supabase.from('likes').select('id').eq('user_id', req.user.id).eq('target_type', target_type).eq('target_id', target_id).single();
    if (existing) {
      await supabase.from('likes').delete().eq('id', existing.id);
      if (target_type === 'post') { const { data: post } = await supabase.from('community_posts').select('like_count').eq('id', target_id).single(); await supabase.from('community_posts').update({ like_count: Math.max(0, (post?.like_count || 1) - 1) }).eq('id', target_id); }
      return res.json({ success: true, liked: false });
    }
    await supabase.from('likes').insert({ user_id: req.user.id, target_type, target_id });
    if (target_type === 'post') { const { data: post } = await supabase.from('community_posts').select('like_count').eq('id', target_id).single(); await supabase.from('community_posts').update({ like_count: (post?.like_count || 0) + 1 }).eq('id', target_id); }
    res.json({ success: true, liked: true });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to like' }); }
});

router.post('/save', verifyToken, async (req, res) => {
  try {
    const { item_type, item_id } = req.body;
    const { data: existing } = await supabase.from('saved_items').select('id').eq('user_id', req.user.id).eq('item_type', item_type).eq('item_id', item_id).single();
    if (existing) { await supabase.from('saved_items').delete().eq('id', existing.id); return res.json({ success: true, saved: false }); }
    await supabase.from('saved_items').insert({ user_id: req.user.id, item_type, item_id });
    res.json({ success: true, saved: true });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to save' }); }
});

router.post('/report', verifyToken, async (req, res) => {
  try {
    const { target_type, target_id, reason, description } = req.body;
    await supabase.from('reports').insert({ reporter_id: req.user.id, target_type, target_id, reason, description });
    res.json({ success: true, message: 'Report submitted. Thank you!' });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to submit report' }); }
});

router.put('/comments/:id/accept', verifyToken, async (req, res) => {
  try {
    const { data: comment } = await supabase.from('comments').select('*, community_posts(user_id)').eq('id', req.params.id).single();
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found' });
    if (comment.community_posts.user_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
    await supabase.from('comments').update({ is_accepted_answer: true }).eq('id', req.params.id);
    await supabase.from('community_posts').update({ is_answered: true }).eq('id', comment.post_id);
    await supabase.from('xp_transactions').insert({ user_id: comment.user_id, amount: 15, type: 'accepted_answer', description: 'Answer accepted' });
    res.json({ success: true, message: 'Answer accepted!' });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to accept answer' }); }
});

module.exports = router;
