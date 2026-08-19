const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('../middleware/auth');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

router.get('/products', async (req, res) => {
  try {
    const { category, subject_id, search, sort = 'created_at', page = 1, limit = 20 } = req.query;
    let query = supabase.from('marketplace_products').select('*, seller_profiles(display_name, avatar_url, is_verified), subjects(name)').eq('status', 'approved');
    if (category) query = query.eq('category', category);
    if (subject_id) query = query.eq('subject_id', subject_id);
    if (search) query = query.ilike('title', `%${search}%`);
    if (sort === 'popular') query = query.order('total_sales', { ascending: false });
    else if (sort === 'rating') query = query.order('rating', { ascending: false });
    else if (sort === 'price_low') query = query.order('price', { ascending: true });
    else if (sort === 'price_high') query = query.order('price', { ascending: false });
    else query = query.order('created_at', { ascending: false });
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);
    const { data: products, error } = await query;
    if (error) throw error;
    res.json({ success: true, products });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get products' }); }
});

router.get('/products/:id', async (req, res) => {
  try {
    const { data: product, error } = await supabase.from('marketplace_products').select('*, seller_profiles(display_name, avatar_url, is_verified, total_sales, rating), subjects(name)').eq('id', req.params.id).eq('status', 'approved').single();
    if (error || !product) return res.status(404).json({ success: false, message: 'Product not found' });
    await supabase.from('marketplace_products').update({ total_views: product.total_views + 1 }).eq('id', product.id);
    const { data: reviews } = await supabase.from('reviews').select('*, profiles(full_name, avatar_url)').eq('product_id', product.id).eq('is_visible', true).order('created_at', { ascending: false }).limit(10);
    res.json({ success: true, product, reviews });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get product' }); }
});

router.post('/seller/register', verifyToken, async (req, res) => {
  try {
    const { display_name, description, pan_number } = req.body;
    const { data: existing } = await supabase.from('seller_profiles').select('id').eq('user_id', req.user.id).single();
    if (existing) return res.status(409).json({ success: false, message: 'Already registered as seller' });
    const { data: seller, error } = await supabase.from('seller_profiles').insert({ user_id: req.user.id, display_name, description, pan_number }).select().single();
    if (error) throw error;
    await supabase.from('users').update({ role_id: 3 }).eq('id', req.user.id);
    res.json({ success: true, message: 'Seller account created!', seller });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to register as seller' }); }
});

router.post('/products', verifyToken, async (req, res) => {
  try {
    const { title, description, category, subject_id, price, discount_price, thumbnail_url, file_url, file_type, total_pages, language, tags } = req.body;
    const { data: seller } = await supabase.from('seller_profiles').select('id').eq('user_id', req.user.id).single();
    if (!seller) return res.status(403).json({ success: false, message: 'Register as seller first' });
    const { data: product, error } = await supabase.from('marketplace_products').insert({ seller_id: seller.id, title, description, category, subject_id: subject_id || null, price, discount_price: discount_price || null, thumbnail_url, file_url, file_type, total_pages, language: language || 'Hindi', tags: tags || [], status: 'pending' }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, message: 'Product submitted for review', product });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to create product' }); }
});

router.get('/seller/dashboard', verifyToken, async (req, res) => {
  try {
    const { data: seller } = await supabase.from('seller_profiles').select('*').eq('user_id', req.user.id).single();
    if (!seller) return res.status(404).json({ success: false, message: 'Seller not found' });
    const { data: products } = await supabase.from('marketplace_products').select('id, title, status, total_sales, total_views, price, rating').eq('seller_id', seller.id).order('created_at', { ascending: false });
    const { data: orderItems } = await supabase.from('order_items').select('seller_earnings, created_at').eq('seller_id', seller.id).order('created_at', { ascending: false }).limit(30);
    const totalEarnings = orderItems?.reduce((sum, o) => sum + o.seller_earnings, 0) || 0;
    const { data: payouts } = await supabase.from('seller_payouts').select('*').eq('seller_id', seller.id).order('requested_at', { ascending: false }).limit(10);
    res.json({ success: true, seller, products: products || [], earnings: { total: totalEarnings, recent_orders: orderItems || [] }, payouts: payouts || [] });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get seller dashboard' }); }
});

router.get('/my-purchases', verifyToken, async (req, res) => {
  try {
    const { data: orders } = await supabase.from('orders').select('*, order_items(*, marketplace_products(title, thumbnail_url, file_type))').eq('buyer_id', req.user.id).eq('status', 'completed').order('created_at', { ascending: false });
    res.json({ success: true, orders });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get purchases' }); }
});

router.post('/products/:id/review', verifyToken, async (req, res) => {
  try {
    const { rating, review_text } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating 1-5 required' });
    const { data: review, error } = await supabase.from('reviews').insert({ user_id: req.user.id, product_id: req.params.id, rating, review_text, is_verified_purchase: true }).select().single();
    if (error) throw error;
    const { data: allReviews } = await supabase.from('reviews').select('rating').eq('product_id', req.params.id).eq('is_visible', true);
    const avgRating = allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;
    await supabase.from('marketplace_products').update({ rating: avgRating.toFixed(2), rating_count: allReviews.length }).eq('id', req.params.id);
    res.json({ success: true, message: 'Review added!', review });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to add review' }); }
});

module.exports = router;
